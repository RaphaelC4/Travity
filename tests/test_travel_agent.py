"""Tests for the Travity TravelAgent contract.

The genlayer SDK and GenVM are not installed locally, so `gl` is mocked.
These tests exercise contract logic: quotes, escrow, loyalty, disputes,
and the security invariants (reentrancy, input validation, rate limits).
"""

import sys
import json
import types
import typing
import pytest


class _TreeMap(typing.MutableMapping):
    def __init__(self):
        self._d = {}

    def __getitem__(self, k):
        return self._d[k]

    def __setitem__(self, k, v):
        self._d[k] = v

    def __delitem__(self, k):
        del self._d[k]

    def __iter__(self):
        return iter(self._d)

    def __len__(self):
        return len(self._d)

    def get(self, k, default=None):
        return self._d.get(k, default)


def u256(x):
    return int(x)


def _Address(s):
    return s


class TreeMap(_TreeMap):
    pass


class _Proxy:
    """Stand-in for an @gl.evm.contract_interface proxy: accepts an address
    and records emit_transfer calls (address, value) so settlement payouts
    can be asserted on instead of just "it didn't crash"."""

    calls = []

    def __init__(self, address):
        self.address = address

    def emit_transfer(self, value=0, **k):
        _Proxy.calls.append((self.address, int(value)))


def _decora(f=None, **k):
    """Callable decorator that also exposes a chainable `.payable`."""
    if f is None:
        return lambda g: g
    return f


_decora.payable = lambda h=None, **kk: (h if h is not None else (lambda j: j))
# attach the attribute to the public namespace too
_decora_all = _decora


def _run_leader(*args, **kwargs):
    """prompt_comparative/prompt_non_comparative mock: run the leader's fn so
    the mocked exec_prompt/web responses actually flow through."""
    return args[0]()


def _install_gl_mock():
    """Inject a fake `genlayer` module so the contract can be imported."""
    mod = types.ModuleType("genlayer")
    mod.u256 = u256
    mod.Address = _Address
    mod.TreeMap = TreeMap
    gl = types.SimpleNamespace(
        Contract=object,
        public=types.SimpleNamespace(
            view=lambda f=None, **k: f if f else (lambda g: g),
            write=_decora,
        ),
        evm=types.SimpleNamespace(contract_interface=lambda c: _Proxy),
        nondet=types.SimpleNamespace(
            web=types.SimpleNamespace(get=_fake_status_page),
            exec_prompt=lambda p: "100",
        ),
        vm=types.SimpleNamespace(
            run_nondet_unsafe=lambda leader, validator: leader(),
            Result=types.SimpleNamespace,
            UserError=RuntimeError,
        ),
        message=types.SimpleNamespace(sender_address="0xSENDER", value=0, chain_id=9),
        eq_principle=types.SimpleNamespace(
            strict_eq=lambda f: f(),
            prompt_comparative=_run_leader,
            prompt_non_comparative=_run_leader,
        ),
    )
    mod.gl = gl
    sys.modules["genlayer"] = mod


class _FakeResponse:
    """Matches the real GenVM nondet web Response shape: `.status` + `.body`.
    (The runtime has no `.status_code` — that's a docs error.)"""

    def __init__(self, text, status=200):
        self.body = text.encode("utf-8")
        self.status = status


def _fake_status_page(url, headers=None):
    """Default /status mock: echoes the requested ref with a completed
    lifecycle state, mirroring the real quote server's evidence body."""
    import urllib.parse as _up

    q = _up.urlparse(url).query
    ref = _up.parse_qs(q).get("ref", [""])[0]
    return _FakeResponse(json.dumps({"ref": ref, "route": "TEST", "status": "completed"}))


_install_gl_mock()

from genlayer import *  # noqa: E402
from contracts.travel_agent import TravelAgent, ADMIN_ZERO, LOYALTY_PER_BOOKING  # noqa: E402


@pytest.fixture
def agent():
    c = TravelAgent(Address("0xOWNER"))
    # GenVM zero-initializes declared storage fields; the mock (plain object)
    # does not, so simulate it.
    c.quotes = TreeMap()
    c.bookings = TreeMap()
    c.loyalty = TreeMap()
    c.disputes = TreeMap()
    c.last_dispute_time = TreeMap()
    # preset an agreed quote so book() has deterministic pricing
    c.quotes["JFK-LHR-20261001-20261010"] = u256(500_000)
    c.owner = "0xOWNER"
    c.paused = False
    c.killed = False
    c.feed_base = "https://example.co"
    # provider settlement + auth must be configured for confirm_completion /
    # escalate to run at all — mirrors the owner setup a real deployment does
    c.provider_address = "0xPROVIDER"
    c.provider_auth_token = "test-provider-token"
    _Proxy.calls = []
    return c


class TestConstructor:
    def test_owner_int_coerced(self):
        c = TravelAgent(int("0xc048310b6ad26d7cf35ef068a83cbe6793864fd1", 16))
        assert c.owner == "0xc048310b6ad26d7cf35ef068a83cbe6793864fd1"

    def test_owner_bytes_coerced(self):
        c = TravelAgent(bytes.fromhex("c048310b6ad26d7cf35ef068a83cbe6793864fd1"))
        assert c.owner == "0xc048310b6ad26d7cf35ef068a83cbe6793864fd1"

    def test_owner_str_passthrough(self):
        c = TravelAgent("0xc048310b6ad26d7cf35ef068a83cbe6793864fd1")
        assert c.owner == "0xc048310b6ad26d7cf35ef068a83cbe6793864fd1"


class TestQuote:
    def test_refresh_quote_validates_route(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xOWNER")
        with pytest.raises(RuntimeError):
            agent.refresh_quote("", "   ")
        with pytest.raises(RuntimeError):
            agent.refresh_quote("JFK", "JFK")  # same origin/destination

    def test_refresh_quote_validates_dates(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xOWNER")
        with pytest.raises(RuntimeError):
            agent.refresh_quote("JFK", "LHR", 20261010, 20261001)  # return before depart

    def test_refresh_quote_stores_post_consensus(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xOWNER")
        price = agent.refresh_quote("JFK", "LHR")
        assert price == 100
        assert agent.quotes["JFK-LHR"] == 100

    def test_refresh_quote_with_dates_stores_date_keyed(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xOWNER")
        price = agent.refresh_quote("JFK", "LHR", 20260915, 20260922)
        assert price == 100
        assert agent.quotes["JFK-LHR-20260915-20260922"] == 100
        assert "JFK-LHR" not in agent.quotes

    def test_view_quote_route_only_and_date_keyed(self, agent):
        agent.quotes["JFK-LHR"] = u256(777)
        agent.quotes["JFK-LHR-20260915-20260922"] = u256(999)
        assert agent.view_quote("JFK", "LHR")["price_wei"] == 777
        assert agent.view_quote("JFK", "LHR", 20260915, 20260922)["price_wei"] == 999
        assert agent.view_quote("JFK", "LHR", 20260701, 20260708) == {}

    def test_refresh_quote_requires_configured_feed(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xOWNER")
        agent.feed_base = "https://api.example-travel-provider.com"
        with pytest.raises(RuntimeError, match="set_feed_url"):
            agent.refresh_quote("JFK", "LHR", 20260915, 20260922)

    def test_refresh_quote_rejects_out_of_range(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xOWNER")
        import genlayer
        genlayer.gl.nondet.exec_prompt = lambda p: "1" + "0" * 25  # 1e25 > RANGE_PRICE_MAX (1e24)
        with pytest.raises(RuntimeError):
            agent.refresh_quote("JFK", "CDG")


class TestBooking:
    def test_escrow_accepts_exact_price(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        monkeypatch.setattr("genlayer.gl.message.value", 500_000)
        bid = agent.book("JFK", "LHR", 20261001, 20261010, "PNR-ABC123")
        booking = json.loads(agent.bookings[bid])
        assert booking["status"] == "confirmed"
        assert booking["price_wei"] == 500_000

    def test_overpayment_credited_to_loyalty(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        monkeypatch.setattr("genlayer.gl.message.value", 600_000)
        agent.book("JFK", "LHR", 20261001, 20261010, "PNR-ABC123")
        assert agent.loyalty["0xALICE"] == 100_000

    def test_underpayment_reverts(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        monkeypatch.setattr("genlayer.gl.message.value", 100_000)
        with pytest.raises(RuntimeError):
            agent.book("JFK", "LHR", 20261001, 20261010, "PNR-ABC123")

    def test_grief_large_payment_reverts(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        monkeypatch.setattr("genlayer.gl.message.value", 2_000_000)
        with pytest.raises(RuntimeError):
            agent.book("JFK", "LHR", 20261001, 20261010, "PNR-ABC123")

    def test_duplicate_booking_reverts(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        monkeypatch.setattr("genlayer.gl.message.value", 500_000)
        agent.book("JFK", "LHR", 20261001, 20261010, "PNR-ABC123")
        with pytest.raises(RuntimeError):
            agent.book("JFK", "LHR", 20261001, 20261010, "PNR-ABC123")

    def test_invalid_reservation_ref_reverts(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        monkeypatch.setattr("genlayer.gl.message.value", 500_000)
        with pytest.raises(RuntimeError):
            agent.book("JFK", "LHR", 20261001, 20261010, "")
        with pytest.raises(RuntimeError):
            agent.book("JFK", "LHR", 20261001, 20261010, "ab")

    def test_reservation_ref_stored_on_booking(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        monkeypatch.setattr("genlayer.gl.message.value", 500_000)
        bid = agent.book("JFK", "LHR", 20261001, 20261010, "PNR-ABC123")
        assert json.loads(agent.bookings[bid])["reservation_ref"] == "PNR-ABC123"

    def test_invalid_dates_revert(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        monkeypatch.setattr("genlayer.gl.message.value", 500_000)
        with pytest.raises(RuntimeError):
            agent.book("JFK", "LHR", 20261010, 20261001, "PNR-ABC123")  # return before depart


class TestLoyalty:
    def test_mint_on_verified_completion(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        monkeypatch.setattr("genlayer.gl.message.value", 500_000)
        bid = agent.book("JFK", "LHR", 20261001, 20261010, "PNR-ABC123")

        # owner must be the caller for minting
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xOWNER")
        agent.confirm_completion(bid)
        # loyalty mints to the CUSTOMER who booked, not the caller
        assert agent.loyalty["0xALICE"] == LOYALTY_PER_BOOKING
        # the escrowed fare settles to the provider, exactly once
        assert _Proxy.calls == [("0xPROVIDER", 500_000)]
        assert json.loads(agent.bookings[bid])["settled"] is True

    def test_confirm_completion_requires_provider_configured(self, agent, monkeypatch):
        agent.provider_address = ADMIN_ZERO
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        monkeypatch.setattr("genlayer.gl.message.value", 500_000)
        bid = agent.book("JFK", "LHR", 20261001, 20261010, "PNR-ABC123")

        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xOWNER")
        with pytest.raises(RuntimeError, match="set_provider"):
            agent.confirm_completion(bid)

    def test_confirm_completion_requires_provider_auth(self, agent, monkeypatch):
        agent.provider_auth_token = ""
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        monkeypatch.setattr("genlayer.gl.message.value", 500_000)
        bid = agent.book("JFK", "LHR", 20261001, 20261010, "PNR-ABC123")

        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xOWNER")
        with pytest.raises(RuntimeError, match="set_provider_auth"):
            agent.confirm_completion(bid)

    def test_confirm_completion_rejects_unauthenticated_evidence(self, agent, monkeypatch):
        """A 401/expired-auth response must never read as 'trip completed'."""
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        monkeypatch.setattr("genlayer.gl.message.value", 500_000)
        bid = agent.book("JFK", "LHR", 20261001, 20261010, "PNR-ABC123")

        monkeypatch.setattr(
            "genlayer.gl.nondet.web.get",
            lambda url, headers=None: _FakeResponse("401", status=401),
        )
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xOWNER")
        with pytest.raises(RuntimeError, match="trip completion not verified"):
            agent.confirm_completion(bid)

    def test_confirm_completion_rejects_uncompleted_evidence(self, agent, monkeypatch):
        """Evidence saying the trip is still 'confirmed' is not completion."""
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        monkeypatch.setattr("genlayer.gl.message.value", 500_000)
        bid = agent.book("JFK", "LHR", 20261001, 20261010, "PNR-ABC123")

        monkeypatch.setattr(
            "genlayer.gl.nondet.web.get",
            lambda url, headers=None: _FakeResponse(
                json.dumps({"ref": "PNR-ABC123", "status": "confirmed"})
            ),
        )
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xOWNER")
        with pytest.raises(RuntimeError, match="trip completion not verified"):
            agent.confirm_completion(bid)

    def test_confirm_completion_rejects_ref_mismatch_evidence(self, agent, monkeypatch):
        """Evidence about a DIFFERENT reservation must not verify this one."""
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        monkeypatch.setattr("genlayer.gl.message.value", 500_000)
        bid = agent.book("JFK", "LHR", 20261001, 20261010, "PNR-ABC123")

        monkeypatch.setattr(
            "genlayer.gl.nondet.web.get",
            lambda url, headers=None: _FakeResponse(
                json.dumps({"ref": "OTHER-REF", "status": "completed"})
            ),
        )
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xOWNER")
        with pytest.raises(RuntimeError, match="trip completion not verified"):
            agent.confirm_completion(bid)

    def test_view_provider_config_reports_settings(self, agent):
        cfg = agent.view_provider_config()
        assert cfg["provider_address"] == "0xPROVIDER"
        assert cfg["auth_configured"] is True
        assert cfg["feed_base"] == "https://example.co"

    def test_non_owner_cannot_confirm(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        monkeypatch.setattr("genlayer.gl.message.value", 500_000)
        bid = agent.book("JFK", "LHR", 20261001, 20261010, "PNR-ABC123")

        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xINTRUDER")
        with pytest.raises(RuntimeError):
            agent.confirm_completion(bid)


class TestDispute:
    def _book(self, agent, customer="0xALICE"):
        agent.quotes["JFK-LHR-20261001-20261010"] = u256(500_000)
        bid = "JFK-LHR-20261001-20261010-" + customer
        agent.bookings[bid] = json.dumps({
            "route": "JFK-LHR",
            "customer": customer,
            "depart": 20261001,
            "ret": 20261010,
            "reservation_ref": "PNR-ABC123",
            "price_wei": 500_000,
            "paid_wei": 500_000,
            "status": "confirmed",
            "completion_verified": False,
            "settled": False,
            "settled_wei": 0,
        })
        return bid

    def test_file_dispute_requires_owned_booking(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        with pytest.raises(RuntimeError):
            agent.file_dispute("NOPE-0xALICE-1", "delay beyond policy window")

    def test_file_dispute_requires_customer(self, agent, monkeypatch):
        """Only the customer who made the booking may dispute it."""
        bid = self._book(agent, customer="0xALICE")
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xNOTALICE")
        with pytest.raises(RuntimeError, match="only the booking customer"):
            agent.file_dispute(bid, "delay beyond policy window")

    def test_file_dispute_rejects_short_reason(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        bid = self._book(agent)
        with pytest.raises(RuntimeError):
            agent.file_dispute(bid, "bad")

    def test_file_dispute_blocked_once_settled(self, agent, monkeypatch):
        """A completed-and-settled booking has no escrow left to split."""
        bid = self._book(agent)
        agent.bookings[bid] = json.dumps({
            **json.loads(agent.bookings[bid]),
            "status": "completed",
            "settled": True,
            "settled_wei": 500_000,
        })
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        with pytest.raises(RuntimeError):
            agent.file_dispute(bid, "delay beyond policy window")

    def test_dispute_escalation_produces_ruling_within_cap(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        bid = self._book(agent)
        monkeypatch.setattr("genlayer.gl.nondet.exec_prompt", lambda p: "50000")
        dispute_id = agent.file_dispute(bid, "delay beyond policy window")
        refund = agent.escalate(dispute_id, u256(0))
        assert 0 <= refund <= 500_000
        assert json.loads(agent.disputes[dispute_id])["status"] == "ruled"
        # refund goes to the claimant, remainder settles to the provider —
        # both legs paid, nothing left unaccounted for
        assert _Proxy.calls == [("0xALICE", 50_000), ("0xPROVIDER", 450_000)]
        assert json.loads(agent.bookings[bid])["settled"] is True

    def test_ruling_capped_at_booking_price(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        bid = self._book(agent)
        monkeypatch.setattr("genlayer.gl.nondet.exec_prompt", lambda p: "9999999999")
        dispute_id = agent.file_dispute(bid, "delay beyond policy window")
        refund = agent.escalate(dispute_id, u256(0))
        assert refund <= 500_000

    def test_escalate_cannot_be_replayed(self, agent, monkeypatch):
        """Even a zero-refund ruling must block a second settlement call."""
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        bid = self._book(agent)
        monkeypatch.setattr("genlayer.gl.nondet.exec_prompt", lambda p: "0")
        dispute_id = agent.file_dispute(bid, "delay beyond policy window")
        agent.escalate(dispute_id, u256(0))
        with pytest.raises(RuntimeError, match="already settled"):
            agent.escalate(dispute_id, u256(0))

    def test_escalate_requires_provider_configured(self, agent, monkeypatch):
        agent.provider_address = ADMIN_ZERO
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        bid = self._book(agent)
        dispute_id = agent.file_dispute(bid, "delay beyond policy window")
        with pytest.raises(RuntimeError, match="set_provider"):
            agent.escalate(dispute_id, u256(0))


class TestAdmin:
    """set_provider / set_provider_auth owner gates and arg normalization."""

    def test_set_provider_accepts_native_address_instance(self, agent, monkeypatch):
        """GenVM hands write-method Address params to the contract as a native
        Address instance (not int/bytes/str). _normalize_address must pass it
        through instead of reverting 'invalid address' (prod regression)."""
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xOWNER")

        class Address:  # same shape as the GenVM-native type: class named Address
            def __init__(self, value):
                self.value = value

            def __eq__(self, other):
                return str(self) == str(other)

            def __str__(self):
                return self.value

        agent.set_provider(Address("0xPAYOUT"))
        assert agent.provider_address == Address("0xPAYOUT")

    def test_set_provider_rejects_non_owner(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        with pytest.raises(RuntimeError, match="only owner"):
            agent.set_provider("0xPAYOUT")

    def test_set_provider_auth_rejects_short_token(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xOWNER")
        with pytest.raises(RuntimeError, match="too short"):
            agent.set_provider_auth("short")


class TestGuard:
    def test_killed_contract_refuses_operations(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xOWNER")
        agent.kill()
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        monkeypatch.setattr("genlayer.gl.message.value", 500_000)
        with pytest.raises(RuntimeError):
            agent.book("JFK", "LHR", 20261001, 20261010, "PNR-ABC123")

    def test_only_owner_can_kill(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        with pytest.raises(RuntimeError):
            agent.kill()
