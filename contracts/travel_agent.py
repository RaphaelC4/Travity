# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *
import json
import typing
from datetime import datetime, timezone

RANGE_PRICE_MAX = u256(10 ** 24)          # wei ceiling: allows real fares (~1e20-1e22 wei)
DISPUTE_INTERVAL_SECONDS = 600            # 10 min; GenVM exposes tx time, not block height
LOYALTY_PER_BOOKING = u256(10) * u256(10**18)  # 10 GEN in wei (1 GEN = 10^18 wei)
ADMIN_ZERO = Address("0x0000000000000000000000000000000000000000")


@gl.evm.contract_interface
class _Payee:
    """Proxy used only to send GEN to an EOA via an external message."""
    class View:
        pass
    class Write:
        pass


class TravelAgent(gl.Contract):
    """Travity: AI-native travel agent on GenLayer.

    - quote   -> live travel prices read from the web, agreed by AI validators
    - book    -> escrows GEN, records the booking (payable)
    - loyalty -> minted per completed booking, credited overpayment held as credit
    - dispute -> AI adjudicated refund with appeal path, refund actually paid out

    Security model:
    - All web/LLM reads run inside non-deterministic consensus blocks via
      gl.eq_principle.prompt_comparative/prompt_non_comparative, so every
      validator independently re-fetches and re-derives the value; a caller
      cannot inject a self-serving quote or ruling.
    - Checks-effects-interactions: state only mutates after consensus.
    - Complex records are stored as JSON strings in TreeMap[str, str] rather
      than raw dicts, since GenVM storage does not support nested dict
      values directly.
    - Input validation on every argument; the GenVM reverts on raised errors.
    - Dispute filing is rate-limited per address (actually enforced).
    - Owner-only pause/unpause/kill escape hatches; kill is irreversible.
    """

    owner: Address
    paused: bool
    killed: bool
    quotes: TreeMap[str, u256]
    bookings: TreeMap[str, str]        # booking_id -> JSON string
    loyalty: TreeMap[Address, u256]
    disputes: TreeMap[str, str]        # dispute_id -> JSON string
    last_dispute_time: TreeMap[Address, u256]
    feed_base: str                     # provider feed root; owner-adjustable
    provider_address: Address          # carrier/agency settlement payout address
    provider_auth_token: str           # bearer token for authenticated provider reads

    def __init__(self, owner: Address):
        # GenVM decodes constructor address args from the raw 20-byte calldata
        # as an int (confirmed by the deploy tx: "'int' object has no attribute
        # 'as_bytes'" in the storage setter). Normalize any int/bytes form so the
        # Address descriptor never receives a bare int.
        self.owner = self._normalize_address(owner)
        self.paused = False
        self.killed = False
        # NOTE: quotes/bookings/loyalty/disputes/last_dispute_time are
        # TreeMap[...] storage fields. GenVM zero-initializes storage fields
        # automatically (TreeMap -> {}), so they must NOT be re-assigned here.
        # Assigning a bare, unparameterized TreeMap() fails GenVM's storage
        # type-descriptor check (`val.__type_desc__ == self`), since a fresh
        # TreeMap() doesn't carry the same specialized type as the declared
        # TreeMap[K, V] field. Leaving them untouched keeps them at {}.
        self.feed_base = "https://api.example-travel-provider.com"
        self.provider_address = ADMIN_ZERO
        self.provider_auth_token = ""

    # -- Admin ---------------------------------------------------------------

    def _normalize_address(self, addr) -> Address:
        """GenVM decodes calldata address args (constructor, write-methods)
        as a raw int, or bytes with the leading zero byte stripped. Normalize
        every form so the Address storage setter never receives a bare int
        (see the deploy-tx traceback: 'int' object has no attribute 'as_bytes')."""
        if isinstance(addr, bytes):
            hexbytes = addr.hex() if len(addr) == 20 else addr.rjust(20, b"\x00").hex()
            return Address("0x" + hexbytes)
        if isinstance(addr, int):
            return Address("0x" + format(addr, "040x"))
        if isinstance(addr, str) and addr.startswith("0x"):
            return Address(addr)
        raise gl.vm.UserError("invalid address")

    def _only_owner(self):
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError("only owner")

    def _unpaused(self):
        if self.paused or self.killed:
            raise gl.vm.UserError("contract paused")

    @gl.public.write
    def pause(self) -> None:
        self._only_owner()
        self.paused = True

    @gl.public.write
    def unpause(self) -> None:
        self._only_owner()
        self.paused = False

    @gl.public.write
    def kill(self) -> None:
        """Permanent halt. No unkill exists."""
        self._only_owner()
        self.killed = True

    @gl.public.write
    def set_feed_url(self, url: str) -> None:
        """Owner-only: repoint the provider feed without redeploying.

        Guards: https-only, non-empty. The feed root is joined with the
        endpoint paths inside the consensus blocks (quote / status).
        """
        self._only_owner()
        if not isinstance(url, str) or not url.startswith("https://"):
            raise gl.vm.UserError("feed url must be an https URL")
        self.feed_base = url.rstrip("/")

    @gl.public.write
    def set_provider(self, address: Address) -> None:
        """Owner-only: the carrier/agency settlement payout address.

        Receives the escrowed fare once a completion is verified, or the
        non-refunded remainder once a dispute is ruled. This is what makes
        settlement a defined path instead of funds sitting in the contract
        indefinitely.
        """
        self._only_owner()
        self.provider_address = self._normalize_address(address)

    @gl.public.write
    def set_provider_auth(self, token: str) -> None:
        """Owner-only: bearer token attached to provider status reads.

        Without this, `confirm_completion`/`escalate` would treat an
        unauthenticated, spoofable page fetch as evidence. The token ties
        the read to a real, authenticated carrier/agency session.
        """
        self._only_owner()
        if not isinstance(token, str) or len(token.strip()) < 8:
            raise gl.vm.UserError("provider auth token too short")
        self.provider_auth_token = token.strip()

    # -- Helpers -------------------------------------------------------------

    def _valid_route(self, origin: str, destination: str) -> bool:
        if not isinstance(origin, str) or not isinstance(destination, str):
            return False
        o, d = origin.upper(), destination.upper()
        if len(o) != 3 or not o.isalpha() or len(d) != 3 or not d.isalpha():
            return False
        return o != d

    def _valid_dates(self, depart: int, ret: int) -> bool:
        if depart is None or ret is None:
            return False
        if depart >= ret:
            return False
        return True

    def _valid_ref(self, ref: str) -> bool:
        """A reservation_ref ties the on-chain escrow to a real, off-chain
        reservation (e.g. the PNR/confirmation code the provider issued when
        the reservation was created). Format-check only; the reference is
        actually verified against provider evidence at completion/dispute
        time, not trusted at face value here."""
        if not isinstance(ref, str):
            return False
        r = ref.strip()
        return 4 <= len(r) <= 128

    def _current_time(self) -> u256:
        # GenVM exposes no block number/height — confirmed by docs
        # (Transaction Context: "No block number, no block hash"). Time is
        # deterministic and pinned to the tx timestamp, so use that instead.
        return u256(int(datetime.now(timezone.utc).timestamp()))

    def _quote_key(self, origin: str, destination: str, depart: int = 0, ret: int = 0) -> str:
        """Cache key for an agreed quote. Route-only when no dates are given,
        otherwise route + departure + return so the agreed price matches the
        exact trip requested (date parity between the UI and the escrow)."""
        key = origin.upper() + "-" + destination.upper()
        if depart and ret:
            key += "-" + str(depart) + "-" + str(ret)
        return key

    @gl.public.view
    def view_quote(self, origin: str, destination: str, depart: int = 0, ret: int = 0) -> dict:
        """Read a cached quote (deterministic). Empty dict if none cached."""
        key = self._quote_key(origin, destination, depart, ret)
        price = self.quotes.get(key)
        if price is None:
            return {}
        return {"route": key, "price_wei": int(price)}

    @gl.public.view
    def view_booking(self, booking_id: str) -> dict:
        raw = self.bookings.get(booking_id)
        if raw is None:
            return {}
        return json.loads(raw)

    # -- Quote ---------------------------------------------------------------

    @gl.public.write
    def refresh_quote(self, origin: str, destination: str, depart: int = 0, ret: int = 0) -> u256:
        """Fetch a live price from the web and agree on it via consensus.

        Runs inside a non-deterministic block settled with comparative
        consensus (gl.eq_principle.prompt_comparative), so every validator
        re-fetches the provider independently. Returns the agreed price in wei.
        When both depart/ret are given, the feed is queried for those dates so
        the agreed price matches the requested trip.
        """
        self._unpaused()
        if not self._valid_route(origin, destination):
            raise gl.vm.UserError("invalid route")
        if depart or ret:
            if not self._valid_dates(depart, ret):
                raise gl.vm.UserError("invalid dates")
        o, d = origin.upper(), destination.upper()
        key = self._quote_key(o, d, depart, ret)

        # Storage reads (self.feed_base) must happen OUTSIDE the consensus
        # closure: GenVM warns "Reading storage in nondet mode is not
        # supported" (storage.py:21). Capture the feed root as a local before
        # the closure so all validators pickle/use the same plain string. Also
        # turn an unconfigured placeholder feed into a clear error instead of a
        # DNS NondetException deep inside the consensus block.
        feed = self.feed_base
        if not feed.startswith("https://") or "example-travel-provider" in feed:
            raise gl.vm.UserError("quote feed not configured: owner must call set_feed_url")

        def get_price() -> str:
            q = "/quote?from=" + o + "&to=" + d
            if depart and ret:
                q += "&depart=" + str(depart) + "&ret=" + str(ret)
            res = gl.nondet.web.get(feed + q)
            page = res.body.decode("utf-8")
            return gl.nondet.exec_prompt(
                "Extract the total ticket price in integer wei from this "
                "page and reply with only the number: " + page[:4000]
            )

        # strict_eq must never be used on LLM output (it's non-deterministic
        # and exact-match will spuriously fail); use comparative consensus
        # with an explicit tolerance principle instead.
        agreed = gl.eq_principle.prompt_comparative(
            get_price,
            "The two values are the same ticket price in wei, allowing up "
            "to 5% difference due to live price fluctuation.",
        )
        try:
            price = u256(int(str(agreed).strip()))
        except Exception:
            raise gl.vm.UserError("unreadable price")
        if price <= u256(0) or price > RANGE_PRICE_MAX:
            raise gl.vm.UserError("price out of range")

        self.quotes[key] = price  # state mutation happens AFTER consensus
        return price

    # -- Booking -------------------------------------------------------------

    @gl.public.write.payable
    def book(self, origin: str, destination: str, depart: int, ret: int, reservation_ref: str) -> str:
        """Escrow GEN for a booking.

        The caller must send at least the last agreed quote price in wei.
        Overpayment is credited to loyalty; underpayment reverts;
        amounts far above the quote (grief/dust attempts) revert.

        `reservation_ref` is the PNR/confirmation code the carrier or agency
        issued when the reservation was actually created off-chain (the
        server creates the reservation via the provider's booking API before
        the customer escrows funds, and passes the resulting reference
        through here). It's only format-checked at booking time — it's the
        anchor that `confirm_completion`/`escalate` later verify against
        authenticated provider evidence, so a caller can't just make one up
        and have it accepted as proof of anything.
        """
        self._unpaused()
        if not self._valid_route(origin, destination):
            raise gl.vm.UserError("invalid route")
        if not self._valid_dates(depart, ret):
            raise gl.vm.UserError("invalid dates")
        if not self._valid_ref(reservation_ref):
            raise gl.vm.UserError("invalid reservation reference")
        ref = reservation_ref.strip()

        key = self._quote_key(origin, destination, depart, ret)
        price = self.quotes.get(key)
        if price is None or price <= u256(0):
            raise gl.vm.UserError("no agreed quote; call refresh_quote first")

        sent = gl.message.value
        if sent < price:
            raise gl.vm.UserError("insufficient payment")
        if sent > price * u256(2):
            raise gl.vm.UserError("payment far exceeds quote")

        sender = gl.message.sender_address
        booking_id = key + "-" + str(sender)
        if self.bookings.get(booking_id) is not None:
            raise gl.vm.UserError("duplicate booking")

        over = sent - price
        record = {
            "route": key,
            "customer": str(sender),
            "depart": depart,
            "ret": ret,
            "reservation_ref": ref,
            "price_wei": int(price),
            "paid_wei": int(sent),
            "status": "confirmed",
            "completion_verified": False,
            "settled": False,
            "settled_wei": 0,
        }
        self.bookings[booking_id] = json.dumps(record)
        if over > u256(0):
            self.loyalty[sender] = self.loyalty.get(sender, u256(0)) + over
        return booking_id

    @gl.public.write
    def confirm_completion(self, booking_id: str) -> None:
        """Verify a trip completed using AUTHENTICATED carrier/agency
        evidence tied to this booking's own reservation, settle the
        escrowed fare to the provider, then mint loyalty to the CUSTOMER
        who made the booking (not the caller).

        Verification runs inside a prompt_non_comparative consensus block,
        so validators independently query the provider (with the owner-set
        bearer token) and independently confirm the response references this
        booking's reservation_ref — a generic page or an unauthenticated
        "yes" is not accepted as evidence. Owner-gated since it issues
        value-bearing loyalty and moves escrowed funds.
        """
        self._only_owner()
        raw = self.bookings.get(booking_id)
        if raw is None:
            raise gl.vm.UserError("unknown booking")
        booking = json.loads(raw)
        if booking["status"] != "confirmed" or booking["completion_verified"]:
            raise gl.vm.UserError("booking not verifiable")
        ref = booking.get("reservation_ref", "")
        if not ref:
            raise gl.vm.UserError("booking has no reservation reference on file")
        if not self.provider_auth_token:
            raise gl.vm.UserError("provider authentication not configured: owner must call set_provider_auth")
        if self.provider_address == ADMIN_ZERO:
            raise gl.vm.UserError("provider payout address not configured: owner must call set_provider")

        feed = self.feed_base
        token = self.provider_auth_token

        def get_status() -> str:
            res = gl.nondet.web.get(
                feed + "/status?ref=" + ref,
                headers={"Authorization": "Bearer " + token},
            )
            if res.status_code != 200:
                # auth failure or provider error is not evidence of anything
                return "no"
            page = res.body.decode("utf-8")
            ok = gl.nondet.exec_prompt(
                "This is an authenticated carrier/agency status read for "
                "reservation " + ref + ". Reply only 'yes' or 'no': does this "
                "evidence confirm reservation " + ref + " exists and "
                "completed without full cancellation? Reply 'no' if the "
                "reservation reference is not present in the evidence. "
                + page[:4000]
            )
            return ok.strip().lower()

        # prompt_non_comparative takes (fn, task=, criteria=) — not (fn, principle) —
        # confirmed against docs.genlayer.com/.../examples/llm-hello-world-non-comparative.
        # Validators evaluate the leader's answer against these criteria rather than
        # re-deriving and comparing values, which fits a yes/no judgment call better
        # than prompt_comparative.
        verdict = gl.eq_principle.prompt_non_comparative(
            get_status,
            task="Answer only 'yes' or 'no': does the authenticated evidence "
                 "confirm reservation " + ref + " completed without full cancellation?",
            criteria="Response must be a clear yes/no-style answer, and must be "
                      "'no' unless the reservation reference is present in the evidence.",
        )
        if str(verdict).lower() not in ("yes", "true", "1", "done", "completed"):
            raise gl.vm.UserError("trip completion not verified")

        booking["status"] = "completed"
        booking["completion_verified"] = True

        # Settlement path: the escrowed fare goes to the carrier/agency now
        # that verified, authenticated completion evidence exists. Guarded
        # so a booking is never settled twice.
        if not booking.get("settled"):
            price = u256(booking["price_wei"])
            _Payee(self.provider_address).emit_transfer(value=price)
            booking["settled"] = True
            booking["settled_wei"] = int(price)

        self.bookings[booking_id] = json.dumps(booking)

        customer = Address(booking["customer"])
        self.loyalty[customer] = self.loyalty.get(customer, u256(0)) + LOYALTY_PER_BOOKING

    # -- Disputes ------------------------------------------------------------

    @gl.public.write
    def file_dispute(self, booking_id: str, reason: str) -> str:
        """File an AI-adjudicated dispute. Rate-limited per address."""
        self._unpaused()
        sender = gl.message.sender_address
        now = self._current_time()
        last = self.last_dispute_time.get(sender, u256(0))
        if last > u256(0) and (now - last) < u256(DISPUTE_INTERVAL_SECONDS):
            raise gl.vm.UserError("dispute rate limit: try again later")

        raw = self.bookings.get(booking_id)
        if raw is None:
            raise gl.vm.UserError("unknown booking")
        booking = json.loads(raw)
        if str(sender) != booking["customer"]:
            raise gl.vm.UserError("only the booking customer may file a dispute")
        if booking["status"] != "confirmed":
            # Once a booking is "completed" it has already been settled in
            # full to the provider (confirm_completion), and "disputed" /
            # "resolved" bookings have already gone through escalate()'s
            # settlement. There is no escrow left to split once either
            # settlement path has run, so a dispute can only be opened
            # against a still-escrowed, unsettled booking.
            raise gl.vm.UserError("booking is not open to dispute (already completed, disputed, or resolved)")
        if not isinstance(reason, str) or len(reason) < 10 or len(reason) > 500:
            raise gl.vm.UserError("invalid dispute reason")

        booking["status"] = "disputed"
        self.bookings[booking_id] = json.dumps(booking)

        self.last_dispute_time[sender] = now

        dispute_id = booking_id + "-" + str(sender)
        dispute_record = {
            "booking_id": booking_id,
            "claimant": str(sender),
            "reason": reason,
            "status": "pending",
            "rounds": 0,
            "refund_wei": 0,
            "paid_out": False,
        }
        self.disputes[dispute_id] = json.dumps(dispute_record)
        return dispute_id

    @gl.public.write
    def escalate(self, dispute_id: str, refund_floor_hint: u256) -> u256:
        """Produce the AI adjudication for a dispute and settle BOTH legs:
        the refund to the customer and the non-refunded remainder to the
        carrier/agency.

        Validators weigh the dispute reason against AUTHENTICATED provider
        evidence tied to the booking's own reservation_ref via a
        prompt_comparative consensus block, settle on a refund in wei capped
        at the booking price. The dispute["status"] == "ruled" guard below
        is unconditional (not paid_out-dependent), so this cannot be replayed
        even when the ruling is a zero refund. refund_floor_hint is only a
        hint; consensus decides the number.
        """
        raw_dispute = self.disputes.get(dispute_id)
        if raw_dispute is None:
            raise gl.vm.UserError("unknown dispute")
        dispute = json.loads(raw_dispute)
        if dispute["status"] == "ruled":
            raise gl.vm.UserError("dispute already settled")

        raw_booking = self.bookings.get(dispute["booking_id"])
        if raw_booking is None:
            raise gl.vm.UserError("booking not found")
        booking = json.loads(raw_booking)

        ref = booking.get("reservation_ref", "")
        if not ref:
            raise gl.vm.UserError("booking has no reservation reference on file")
        if not self.provider_auth_token:
            raise gl.vm.UserError("provider authentication not configured: owner must call set_provider_auth")
        if self.provider_address == ADMIN_ZERO:
            raise gl.vm.UserError("provider payout address not configured: owner must call set_provider")

        dispute["rounds"] = dispute["rounds"] + 1
        price_max = u256(booking["price_wei"])
        reason = str(dispute["reason"])

        # Same nondet-storage rule as refresh_quote/confirm_completion: capture
        # the feed root before the closure instead of reading storage inside it.
        feed = self.feed_base
        token = self.provider_auth_token

        def get_ruling() -> str:
            try:
                res = gl.nondet.web.get(
                    feed + "/status?ref=" + ref,
                    headers={"Authorization": "Bearer " + token},
                )
                if res.status_code != 200:
                    evidence = "provider evidence unavailable (auth/status error)"
                else:
                    evidence = res.body.decode("utf-8")[:2000]
            except Exception:
                evidence = "provider status unavailable"
            return gl.nondet.exec_prompt(
                "Travity travel dispute for reservation " + ref + ". Reason: " + reason +
                ". Booking price (wei): " + str(price_max) +
                ". Authenticated provider evidence: " + evidence +
                ". If the evidence does not reference reservation " + ref +
                " or is unavailable, award the full booking price as refund. "
                "Otherwise decide a fair refund in integer wei from 0 to " +
                str(price_max) + ". Reply only with the number."
            )

        agreed = gl.eq_principle.prompt_comparative(
            get_ruling,
            "The two values are the same refund amount in wei, allowing "
            "up to 10% difference given the judgment call involved.",
        )
        try:
            refund = u256(int(str(agreed).strip()))
        except Exception:
            refund = u256(0)
        if refund > price_max:
            refund = price_max

        dispute["status"] = "ruled"
        dispute["refund_wei"] = int(refund)

        # -- Settlement: the customer's refund leg and the provider's
        # remainder leg both happen here, once, guarded by the unconditional
        # "already ruled" check above.
        if refund > u256(0):
            claimant = Address(dispute["claimant"])
            # Confirmed against docs.genlayer.com/.../features/value-transfers:
            # sending GEN to an EOA is an external message, done through an
            # @gl.evm.contract_interface proxy's emit_transfer(value=...).
            # There is no bare gl.emit_transfer() — that was an unverified guess.
            _Payee(claimant).emit_transfer(value=refund)
            dispute["paid_out"] = True

        remainder = price_max - refund
        if remainder > u256(0):
            _Payee(self.provider_address).emit_transfer(value=remainder)

        booking["settled"] = True
        booking["settled_wei"] = int(remainder)
        booking["status"] = "resolved"
        self.bookings[dispute["booking_id"]] = json.dumps(booking)
        self.disputes[dispute_id] = json.dumps(dispute)

        return refund

    @gl.public.view
    def view_dispute(self, dispute_id: str) -> dict:
        raw = self.disputes.get(dispute_id)
        if raw is None:
            return {}
        d = json.loads(raw)
        return {
            "booking_id": d["booking_id"],
            "status": d["status"],
            "rounds": int(d["rounds"]),
            "refund_wei": int(d.get("refund_wei", 0)),
            "paid_out": bool(d.get("paid_out", False)),
        }

    @gl.public.view
    def balance_of(self, who: Address) -> u256:
        return self.loyalty.get(who, u256(0))
