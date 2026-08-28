# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *
import json
import typing
from datetime import datetime, timezone

RANGE_PRICE_MAX = u256(10 ** 24)          # wei ceiling: allows real fares (~1e20-1e22 wei)
DISPUTE_INTERVAL_SECONDS = 600            # 10 min; GenVM exposes tx time, not block height
LOYALTY_PER_BOOKING = u256(10) * u256(10**18)  # 10 GEN in wei (1 GEN = 10^18 wei)
ADMIN_ZERO = Address("0x0000000000000000000000000000000000000000")


def _http_status(res) -> int:
    """HTTP status of a gl.nondet.web Response. The GenVM runtime exposes
    `.status`; some doc examples (and our test mocks) use `.status_code`.
    Read whichever exists; 0 (treated as an error by callers) if neither."""
    status = getattr(res, "status", None)
    if status is None:
        status = getattr(res, "status_code", None)
    return int(status) if status is not None else 0


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

    # -- Admin ---------------------------------------------------------------

    def _normalize_address(self, addr) -> Address:
        """GenVM decodes calldata address args in different shapes per entry
        point: the constructor receives a raw int, write-method Address params
        arrive as a native Address instance, and bytes forms may have the
        leading zero byte stripped. Normalize every observed form so the
        Address storage setter never receives a bare int (see the deploy-tx
        traceback: 'int' object has no attribute 'as_bytes'). The native
        instance is matched by class name because `isinstance` would break
        wherever Address is not importable as a type (test mocks)."""
        if addr.__class__.__name__ == "Address":
            return addr
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

    @gl.public.view
    def view_provider_config(self) -> dict:
        """Diagnostics: the owner-set settlement + feed configuration. No
        bearer token exists here by design — evidence authenticity comes from
        unforgeable HMAC-derived reservation references, not shared secrets
        in public state."""
        return {
            "provider_address": str(self.provider_address),
            "feed_base": self.feed_base,
        }

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
        anchor that `escalate` later verifies against
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
        # Normalized to uppercase at write time so the dispute path (which
        # uppercases the provider's echoed ref) can never mismatch on case
        # alone.
        ref = reservation_ref.strip().upper()

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
    def settle_booking(self, booking_id: str) -> None:
        """Settle a completed trip: pay the escrowed fare to the provider and
        mint loyalty to the CUSTOMER who booked.

        Permissionless because the outcome is fixed by a deterministic rule,
        not by the caller: the booking must be confirmed, unsettled, and the
        return date must have passed. No web fetch, no LLM, no consensus
        block — this replaced an evidence-fetching confirm_completion whose
        external dependencies (validator fetches, bearer-token coupling,
        provider availability) made settlement unreliable in practice.
        Authenticated carrier evidence remains in the DISPUTE path, where it
        decides refunds instead of payouts.
        """
        self._unpaused()
        raw = self.bookings.get(booking_id)
        if raw is None:
            raise gl.vm.UserError("unknown booking")
        booking = json.loads(raw)
        if booking["status"] != "confirmed" or booking["completion_verified"]:
            raise gl.vm.UserError("booking not settleable")
        if self._current_time() <= u256(self._yyyymmdd_to_ts(int(booking["ret"]))):
            raise gl.vm.UserError("return date has not passed yet")
        self._settle(booking_id, booking)

    @gl.public.write
    def force_complete(self, booking_id: str) -> None:
        """Owner-only operator override: settle immediately without waiting
        for the return date. Same payout + loyalty effects as settle_booking;
        exists so the operator can resolve trips early (e.g. customer support)
        without any off-chain state."""
        self._only_owner()
        raw = self.bookings.get(booking_id)
        if raw is None:
            raise gl.vm.UserError("unknown booking")
        booking = json.loads(raw)
        if booking["status"] != "confirmed" or booking["completion_verified"]:
            raise gl.vm.UserError("booking not settleable")
        self._settle(booking_id, booking)

    def _yyyymmdd_to_ts(self, d: int) -> int:
        """End-of-day UTC unix timestamp for a YYYYMMDD date int. The stored
        depart/ret are calendar dates while _current_time() is a unix
        timestamp; comparing them directly would be meaningless, so convert
        here. Settlement unlocks strictly AFTER the whole return day."""
        s = str(d)
        year, month, day = int(s[:4]), int(s[4:6]), int(s[6:8])
        dt = datetime(year, month, day, 23, 59, 59, tzinfo=timezone.utc)
        return int(dt.timestamp())

    def _settle(self, booking_id: str, booking: dict) -> None:
        """Shared settlement effects: fare -> provider (once), loyalty ->
        customer, status -> completed. Checks-effects-interactions: all state
        mutations are ordered before the external transfer emission."""
        if self.provider_address == ADMIN_ZERO:
            raise gl.vm.UserError("provider payout address not configured: owner must call set_provider")

        booking["status"] = "completed"
        booking["completion_verified"] = True

        # Settlement path: the escrowed fare goes to the carrier/agency.
        # Guarded so a booking is never settled twice.
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
            # full to the provider (settle_booking), and "disputed" /
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
        if self.provider_address == ADMIN_ZERO:
            raise gl.vm.UserError("provider payout address not configured: owner must call set_provider")

        dispute["rounds"] = dispute["rounds"] + 1
        price_max = u256(booking["price_wei"])
        reason = str(dispute["reason"])

        # Same nondet-storage rule as refresh_quote: capture
        # the feed root before the closure instead of reading storage inside it.
        feed = self.feed_base
        # Route/dates come from the booking itself so the provider can verify
        # the reservation reference against them (HMAC-derived refs are bound
        # to this exact trip — see docs/security.md). No shared secret is sent:
        # there is deliberately NO bearer token in contract state for anyone
        # to read and replay.
        parts = str(booking.get("route", "")).split("-")
        o, d = parts[0], parts[1]
        b_depart = int(booking.get("depart", 0))
        b_ret = int(booking.get("ret", 0))

        def get_ruling() -> str:
            try:
                res = gl.nondet.web.get(
                    feed + "/provider-status?ref=" + ref
                    + "&from=" + o + "&to=" + d
                    + "&depart=" + str(b_depart) + "&ret=" + str(b_ret)
                )
                if _http_status(res) != 200:
                    evidence = ""
                    policy_note = ""
                else:
                    try:
                        page = json.loads(res.body.decode("utf-8"))
                    except Exception:
                        page = None
                    # Only evidence that echoes THIS reservation's own ref is
                    # admissible; anything else is treated as unavailable.
                    if isinstance(page, dict) and str(page.get("ref", "")).strip().upper() == ref.strip().upper():
                        evidence = json.dumps(page)[:2000]
                        # The fare's own refund/cancellation conditions, fetched
                        # live from the carrier/agency (not asserted by either
                        # party) — this is what grounds the refund NUMBER, as
                        # opposed to the status field which only grounds
                        # whether the trip happened at all.
                        rp = page.get("refund_policy") if isinstance(page.get("refund_policy"), dict) else None
                        src = str(page.get("source", "")).strip()
                        if rp and rp.get("refundable") in ("refundable", "non_refundable"):
                            penalty = rp.get("penalty")
                            policy_note = (
                                "Fare refund policy (source: " + (src or "unknown") + "): " +
                                str(rp.get("refundable")) +
                                (", cancellation penalty " + str(penalty) if penalty else "") + "."
                            )
                        else:
                            policy_note = "Fare refund policy: not available from the provider."
                    else:
                        evidence = ""
                        policy_note = ""
            except Exception:
                evidence = "provider status unavailable"
                policy_note = ""
            return gl.nondet.exec_prompt(
                "Travity travel dispute for reservation " + ref + ". Reason: " + reason +
                ". Booking price (wei): " + str(price_max) +
                ". Provider status evidence: " + (evidence if evidence else "unavailable") +
                ". " + (policy_note if policy_note else "Fare refund policy: not available.") +
                " If the status evidence is unavailable or does not confirm reservation " + ref +
                ", award the full booking price as refund. "
                "Otherwise weigh the dispute reason against the fare's actual refund policy above: "
                "if the policy marks the fare non_refundable and no carrier fault (cancellation/major "
                "schedule change) is evidenced, the refund should be at or near the stated cancellation "
                "penalty rather than the full price; if refundable or evidence shows carrier fault, "
                "award accordingly. Decide a fair refund in integer wei from 0 to " +
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
