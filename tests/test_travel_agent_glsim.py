"""Integration tests running on GenLayer's official runner (genlayer-test
Direct Mode): contracts execute in the real GenVM — real decorators, storage,
calldata encoding, consensus plumbing. Only external web/LLM responses are
simulated via mock_web/mock_llm cheatcodes; nothing about GenLayer itself is
mocked.

Coverage: ordinary booking -> verified settlement (the reviewer-requested
proof), settlement authority boundaries, and the one-shot dispute path.
"""

import json

import pytest

CONTRACT = "contracts/travel_agent.py"
FEED = "https://feed.test"
PRICE = 500_000  # wei agreed by the mocked quote consensus
LOYALTY_PER_BOOKING = 10 * 10**18  # 10 GEN in wei (mirrors contract constant)

PAST_DEPART, PAST_RET = 20250101, 20250102  # already traveled
FUTURE_DEPART, FUTURE_RET = 20991230, 20991231

# Bound booking tuple (offer / order / passenger / itinerary) for strict binding
OFFER_ID = "off_test_offer_12345"
ORDER_ID = "ord_test_order_12345678"
PAS_ID = "pas_test_passenger_01"
ITIN_JSON = json.dumps({"slices": [{"origin": "JFK", "destination": "LHR", "departure_date": "2025-01-01"}], "cabin_class": "economy", "passengers": [{"type": "adult"}]})

def _provider_status_body(status="completed"):
    return json.dumps({"ref": "PNRABC123", "duffel_order_id": ORDER_ID, "passenger_id": PAS_ID, "itinerary_json": ITIN_JSON, "offerId": OFFER_ID, "route": "JFK-LHR", "status": status})


@pytest.fixture
def agent(direct_vm, direct_deploy, direct_owner):
    direct_vm.mock_web(
        rf"{FEED}/quote.*",
        {"status": 200, "body": json.dumps({"route": "JFK-LHR", "price_wei": PRICE})},
    )
    direct_vm.mock_llm(r".*", str(PRICE))
    c = direct_deploy(CONTRACT, direct_owner)
    c.set_feed_url(FEED)
    return c


def _quote(direct_vm, agent, depart=PAST_DEPART, ret=PAST_RET):
    """Agree an on-chain price via real consensus over mocked web+LLM."""
    direct_vm.mock_web(
        rf"{FEED}/quote.*",
        {"status": 200, "body": json.dumps({"route": "JFK-LHR", "price_wei": PRICE})},
    )
    direct_vm.mock_llm(r".*", str(PRICE))
    agent.refresh_quote("JFK", "LHR", depart, ret)


def _record(fn, *a):
    raw = fn(*a)
    return json.loads(raw) if isinstance(raw, str) else raw


def _book(direct_vm, agent, sender, depart=PAST_DEPART, ret=PAST_RET, ref="PNRABC123", offer=OFFER_ID, order=ORDER_ID, pas=PAS_ID, itin=ITIN_JSON):
    _quote(direct_vm, agent, depart, ret)
    with direct_vm.prank(sender):
        direct_vm.value = PRICE
        bid = agent.book("JFK", "LHR", depart, ret, ref, offer, order, pas, itin)
    direct_vm.value = 0
    return bid

def _mock_completion(direct_vm):
    direct_vm.mock_web(rf"{FEED}/provider-status.*", {"status": 200, "body": _provider_status_body("completed")})
    direct_vm.mock_llm(r".*", _provider_status_body("completed"))


def test_full_lifecycle_settlement(direct_vm, agent, direct_owner, direct_alice, direct_charlie):
    """Ordinary booking reaches verified settlement: fare paid to the provider
    exactly once, loyalty minted to the customer who booked."""
    agent.set_provider(direct_charlie)
    bid = _book(direct_vm, agent, direct_alice)

    record = _record(agent.view_booking, bid)
    assert record["status"] == "confirmed"
    assert record["settled"] is False
    assert record["reservation_ref"] == "PNRABC123"

    # Permissionless but evidence-gated: completion evidence must verify
    _mock_completion(direct_vm)
    with direct_vm.prank(direct_charlie):
        agent.settle_booking(bid)

    record = _record(agent.view_booking, bid)
    assert record["status"] == "completed"
    assert record["settled"] is True
    assert record["settled_wei"] == PRICE
    with direct_vm.prank(direct_alice):
        assert agent.balance_of(direct_alice) == LOYALTY_PER_BOOKING


def test_settle_before_return_date_reverts(direct_vm, agent, direct_alice):
    bid = _book(direct_vm, agent, direct_alice, depart=FUTURE_DEPART, ret=FUTURE_RET)
    _mock_completion(direct_vm)
    with pytest.raises(Exception, match="dispute window|return date"):
        agent.settle_booking(bid)


def test_double_settlement_blocked(direct_vm, agent, direct_alice, direct_bob):
    agent.set_provider(direct_bob)
    bid = _book(direct_vm, agent, direct_alice)
    _mock_completion(direct_vm)
    agent.settle_booking(bid)
    with pytest.raises(Exception, match="not settleable"):
        agent.settle_booking(bid)


def test_force_complete_owner_only(direct_vm, agent, direct_owner, direct_bob, direct_alice):
    agent.set_provider(direct_bob)
    bid = _book(direct_vm, agent, direct_alice, depart=FUTURE_DEPART, ret=FUTURE_RET)

    with direct_vm.prank(direct_bob):
        with pytest.raises(Exception, match="only owner"):
            agent.force_complete(bid)

    # even owner must wait for dispute window + evidence
    _mock_completion(direct_vm)
    with direct_vm.prank(direct_owner):
        with pytest.raises(Exception, match="dispute window|completion evidence"):
            agent.force_complete(bid)


def test_dispute_flow_one_shot(direct_vm, agent, direct_alice, direct_bob):
    """Customer dispute -> one-shot ruling -> refund capped at fare; replay
    blocked. Refund evidence is fetched for THIS booking's own reservation
    ref and ruled by consensus."""
    agent.set_provider(direct_bob)
    bid = _book(direct_vm, agent, direct_alice)

    direct_vm.mock_web(
        rf"{FEED}/provider-status\?ref=PNRABC123.*",
        {"status": 200, "body": json.dumps({"ref": "PNRABC123", "route": "JFK-LHR", "status": "cancelled"})},
    )
    direct_vm.mock_llm(r".*", "100000")  # ruled refund in wei (<= fare)

    with direct_vm.prank(direct_alice):
        # file_dispute returns the contract-built dispute id
        dispute_id = agent.file_dispute(bid, "Departure delayed beyond policy window.")
    result = agent.escalate(dispute_id, 0)

    record = _record(agent.view_dispute, dispute_id)
    assert record["status"] == "ruled"
    assert int(record["refund_wei"]) <= PRICE

    with pytest.raises(Exception, match="already settled|already ruled"):
        agent.escalate(dispute_id, 0)


def test_only_customer_can_dispute(direct_vm, agent, direct_alice, direct_bob):
    bid = _book(direct_vm, agent, direct_alice)
    with direct_vm.prank(direct_bob):
        with pytest.raises(Exception, match="only the booking customer"):
            agent.file_dispute(bid, "Someone else's complaint goes here.")


def test_non_customer_cannot_settle_others_funds_rule_is_public(direct_vm, agent, direct_alice, direct_bob):
    """settle_booking is intentionally permissionless: the date rule fixes the
    outcome, so any caller only ever triggers the same deterministic payout."""
    agent.set_provider(direct_bob)
    bid = _book(direct_vm, agent, direct_alice)
    _mock_completion(direct_vm)
    with direct_vm.prank(direct_bob):
        agent.settle_booking(bid)  # succeeds — outcome identical to alice's own call
    record = _record(agent.view_booking, bid)
    assert record["settled"] is True
