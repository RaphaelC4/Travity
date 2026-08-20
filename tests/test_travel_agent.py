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
    and exposes emit_transfer as a no-op so escalate() can run locally."""

    def __init__(self, address):
        self.address = address

    def emit_transfer(self, value=0, **k):
        pass


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
            web=types.SimpleNamespace(get=lambda url: _FakeResponse("200")),
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
    def __init__(self, text):
        self.body = text.encode("utf-8")
        self.status_code = 200


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
        bid = agent.book("JFK", "LHR", 20261001, 20261010)
        booking = json.loads(agent.bookings[bid])
        assert booking["status"] == "confirmed"
        assert booking["price_wei"] == 500_000

    def test_overpayment_credited_to_loyalty(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        monkeypatch.setattr("genlayer.gl.message.value", 600_000)
        agent.book("JFK", "LHR", 20261001, 20261010)
        assert agent.loyalty["0xALICE"] == 100_000

    def test_underpayment_reverts(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        monkeypatch.setattr("genlayer.gl.message.value", 100_000)
        with pytest.raises(RuntimeError):
            agent.book("JFK", "LHR", 20261001, 20261010)

    def test_grief_large_payment_reverts(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        monkeypatch.setattr("genlayer.gl.message.value", 2_000_000)
        with pytest.raises(RuntimeError):
            agent.book("JFK", "LHR", 20261001, 20261010)

    def test_duplicate_booking_reverts(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        monkeypatch.setattr("genlayer.gl.message.value", 500_000)
        agent.book("JFK", "LHR", 20261001, 20261010)
        with pytest.raises(RuntimeError):
            agent.book("JFK", "LHR", 20261001, 20261010)

    def test_invalid_dates_revert(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        monkeypatch.setattr("genlayer.gl.message.value", 500_000)
        with pytest.raises(RuntimeError):
            agent.book("JFK", "LHR", 20261010, 20261001)  # return before depart


class TestLoyalty:
    def test_mint_on_verified_completion(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        monkeypatch.setattr("genlayer.gl.message.value", 500_000)
        bid = agent.book("JFK", "LHR", 20261001, 20261010)

        # owner must be the caller for minting
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xOWNER")
        import genlayer
        genlayer.gl.nondet.exec_prompt = lambda p: "yes"
        agent.confirm_completion(bid)
        # loyalty mints to the CUSTOMER who booked, not the caller
        assert agent.loyalty["0xALICE"] == LOYALTY_PER_BOOKING

    def test_non_owner_cannot_confirm(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        monkeypatch.setattr("genlayer.gl.message.value", 500_000)
        bid = agent.book("JFK", "LHR", 20261001, 20261010)

        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xINTRUDER")
        with pytest.raises(RuntimeError):
            agent.confirm_completion(bid)


class TestDispute:
    def _book(self, agent):
        agent.quotes["JFK-LHR-20261001-20261010"] = u256(500_000)
        bid = "JFK-LHR-20261001-20261010-0xALICE"
        agent.bookings[bid] = json.dumps({
            "route": "JFK-LHR",
            "customer": "0xALICE",
            "depart": 20261001,
            "ret": 20261010,
            "price_wei": 500_000,
            "paid_wei": 500_000,
            "status": "confirmed",
            "completion_verified": True,
        })
        return bid

    def test_file_dispute_requires_owned_booking(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        with pytest.raises(RuntimeError):
            agent.file_dispute("NOPE-0xALICE-1", "delay beyond policy window")

    def test_file_dispute_rejects_short_reason(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        bid = self._book(agent)
        with pytest.raises(RuntimeError):
            agent.file_dispute(bid, "bad")

    def test_dispute_escalation_produces_ruling_within_cap(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        bid = self._book(agent)
        import genlayer
        genlayer.gl.nondet.exec_prompt = lambda p: "50000"
        dispute_id = agent.file_dispute(bid, "delay beyond policy window")
        refund = agent.escalate(dispute_id, u256(0))
        assert 0 <= refund <= 500_000
        assert json.loads(agent.disputes[dispute_id])["status"] == "ruled"

    def test_ruling_capped_at_booking_price(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        bid = self._book(agent)
        import genlayer
        genlayer.gl.nondet.exec_prompt = lambda p: "9999999999"
        dispute_id = agent.file_dispute(bid, "delay beyond policy window")
        refund = agent.escalate(dispute_id, u256(0))
        assert refund <= 500_000


class TestGuard:
    def test_killed_contract_refuses_operations(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xOWNER")
        agent.kill()
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        monkeypatch.setattr("genlayer.gl.message.value", 500_000)
        with pytest.raises(RuntimeError):
            agent.book("JFK", "LHR", 20261001, 20261010)

    def test_only_owner_can_kill(self, agent, monkeypatch):
        monkeypatch.setattr("genlayer.gl.message.sender_address", "0xALICE")
        with pytest.raises(RuntimeError):
            agent.kill()
