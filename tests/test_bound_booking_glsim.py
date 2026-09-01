"""Strict binding e2e: itinerary+passenger+offer+ref+escrow sealed at book;
settlement verifies booking-specific evidence, 6h dispute window, no owner
bypass or ref reuse. Runs on real GenVM Direct Mode."""

import json
import pytest

CONTRACT = "contracts/travel_agent.py"
FEED = "https://feed.test"
PRICE = 500_000

PAST_DEPART, PAST_RET = 20250101, 20250102
OFFER_ID = "off_test_offer_12345"
ORDER_ID = "ord_test_order_12345678"
PAS_ID = "pas_test_passenger_01"
ITIN_JSON = json.dumps({"slices": [{"origin": "JFK", "destination": "LHR", "departure_date": "2025-01-01"}], "cabin_class": "economy"})


@pytest.fixture
def agent(direct_vm, direct_deploy, direct_owner):
    direct_vm.mock_web(rf"{FEED}/quote.*", {"status": 200, "body": json.dumps({"route": "JFK-LHR", "price_wei": PRICE})})
    direct_vm.mock_llm(r".*", str(PRICE))
    c = direct_deploy(CONTRACT, direct_owner)
    c.set_feed_url(FEED)
    return c


def _quote(direct_vm, agent):
    direct_vm.mock_web(rf"{FEED}/quote.*", {"status": 200, "body": json.dumps({"route": "JFK-LHR", "price_wei": PRICE})})
    direct_vm.mock_llm(r".*", str(PRICE))
    agent.refresh_quote("JFK", "LHR", PAST_DEPART, PAST_RET)


def _book(direct_vm, agent, sender, ref="PNRABC123", offer=OFFER_ID, order=ORDER_ID, pas=PAS_ID, itin=ITIN_JSON):
    _quote(direct_vm, agent)
    with direct_vm.prank(sender):
        direct_vm.value = PRICE
        bid = agent.book("JFK", "LHR", PAST_DEPART, PAST_RET, ref, offer, order, pas, itin)
    direct_vm.value = 0
    return bid


def _completion_body(status="completed"):
    return json.dumps({"ref": "PNRABC123", "duffel_order_id": ORDER_ID, "passenger_id": PAS_ID, "itinerary_json": ITIN_JSON, "route": "JFK-LHR", "status": status, "offerId": OFFER_ID})


def test_ref_and_order_reuse_blocked(direct_vm, agent, direct_alice, direct_bob):
    _ = _book(direct_vm, agent, direct_alice)
    # same ref/order with different sender (or same sender different dates) must revert
    with pytest.raises(Exception, match="already used"):
        _book(direct_vm, agent, direct_bob)
    # same sender duplicate booking also blocked (duplicate booking first)
    with direct_vm.prank(direct_alice):
        direct_vm.value = PRICE
        with pytest.raises(Exception, match="duplicate booking|already used"):
            agent.book("JFK", "LHR", PAST_DEPART, PAST_RET, "PNRABC123", OFFER_ID, ORDER_ID, PAS_ID, ITIN_JSON)
        direct_vm.value = 0


def test_settle_requires_completion_evidence(direct_vm, agent, direct_alice, direct_bob, direct_owner):
    agent.set_provider(direct_bob)
    # use distinct senders to avoid duplicate booking_id (key+sender) and distinct refs/orders
    # no evidence -> revert
    bid1 = _book(direct_vm, agent, direct_alice, ref="PNRNOEV1", order="ord_noev1_12345678")
    direct_vm.mock_web(rf"{FEED}/provider-status\?ref=PNRNOEV1.*", {"status": 404, "body": json.dumps({"error": "unknown"})})
    direct_vm.mock_llm(r".*", "")
    with pytest.raises(Exception, match="completion evidence"):
        agent.settle_booking(bid1)
    # mismatched passenger -> revert
    bid2 = _book(direct_vm, agent, direct_bob, ref="PNRBADP2", order="ord_badp2_12345678")
    bad = json.dumps({"ref": "PNRBADP2", "duffel_order_id": "ord_badp2_12345678", "passenger_id": "pas_WRONG", "itinerary_json": ITIN_JSON, "offerId": OFFER_ID, "route": "JFK-LHR", "status": "completed"})
    direct_vm.mock_web(rf"{FEED}/provider-status\?ref=PNRBADP2.*", {"status": 200, "body": bad})
    direct_vm.mock_llm(r".*", bad)
    with pytest.raises(Exception, match="completion evidence"):
        agent.settle_booking(bid2)
    # mismatched order -> revert
    bid2b = _book(direct_vm, agent, direct_owner, ref="PNRBADO3", order="ord_bado3_12345678")
    bad_ord = json.dumps({"ref": "PNRBADO3", "duffel_order_id": "ord_WRONG", "passenger_id": PAS_ID, "itinerary_json": ITIN_JSON, "offerId": OFFER_ID, "route": "JFK-LHR", "status": "completed"})
    direct_vm.mock_web(rf"{FEED}/provider-status\?ref=PNRBADO3.*", {"status": 200, "body": bad_ord})
    direct_vm.mock_llm(r".*", bad_ord)
    with pytest.raises(Exception, match="completion evidence"):
        agent.settle_booking(bid2b)
    # mismatched itinerary -> revert
    with direct_vm.prank("0x4444444444444444444444444444444444444444"):
        direct_vm.value = PRICE
        # need quote for past dates already exists; reuse
        bid2c2 = agent.book("JFK", "LHR", PAST_DEPART, PAST_RET, "PNRBADI4b", OFFER_ID, "ord_badi4b_12345678", PAS_ID, ITIN_JSON)
    direct_vm.value = 0
    bad_itin = json.dumps({"ref": "PNRBADI4b", "duffel_order_id": "ord_badi4b_12345678", "passenger_id": PAS_ID, "itinerary_json": json.dumps({"wrong": True}), "offerId": OFFER_ID, "route": "JFK-LHR", "status": "completed"})
    direct_vm.mock_web(rf"{FEED}/provider-status\?ref=PNRBADI4b.*", {"status": 200, "body": bad_itin})
    direct_vm.mock_llm(r".*", bad_itin)
    with pytest.raises(Exception, match="completion evidence"):
        agent.settle_booking(bid2c2)
    # correct evidence -> succeeds (fresh sender to avoid duplicate booking_id)
    with direct_vm.prank("0x5555555555555555555555555555555555555555"):
        direct_vm.value = PRICE
        # need quote again for this sender's booking? _book already does quote
        _quote(direct_vm, agent)
        bid3 = agent.book("JFK", "LHR", PAST_DEPART, PAST_RET, "PNRABC123", OFFER_ID, ORDER_ID, PAS_ID, ITIN_JSON)
    direct_vm.value = 0
    direct_vm.mock_web(rf"{FEED}/provider-status\?ref=PNRABC123.*", {"status": 200, "body": _completion_body("completed")})
    direct_vm.mock_llm(r".*", _completion_body("completed"))
    # prank not needed for settle (permissionless), but use any sender
    agent.settle_booking(bid3)
    raw = agent.view_booking(bid3)
    rec = json.loads(raw) if isinstance(raw, str) else raw
    assert rec["status"] == "completed"
    assert rec["passenger_id"] == PAS_ID
    assert rec["itinerary_json"] == ITIN_JSON


FUTURE_DEPART, FUTURE_RET = 20991230, 20991231

def _book_future(direct_vm, agent, sender):
    # future booking to keep 6h window open
    direct_vm.mock_web(rf"{FEED}/quote.*", {"status": 200, "body": json.dumps({"route": "JFK-LHR", "price_wei": PRICE})})
    direct_vm.mock_llm(r".*", str(PRICE))
    agent.refresh_quote("JFK", "LHR", FUTURE_DEPART, FUTURE_RET)
    with direct_vm.prank(sender):
        direct_vm.value = PRICE
        bid = agent.book("JFK", "LHR", FUTURE_DEPART, FUTURE_RET, "PNRABC123", OFFER_ID, ORDER_ID, PAS_ID, ITIN_JSON)
    direct_vm.value = 0
    return bid


def test_dispute_window_blocks_owner_override(direct_vm, agent, direct_owner, direct_alice):
    agent.set_provider(direct_owner)
    bid = _book_future(direct_vm, agent, direct_alice)
    # force_complete inside 6h window must revert even for owner, despite valid evidence
    direct_vm.mock_web(rf"{FEED}/provider-status.*", {"status": 200, "body": _completion_body("completed")})
    direct_vm.mock_llm(r".*", _completion_body("completed"))
    with direct_vm.prank(direct_owner):
        with pytest.raises(Exception, match="dispute window|completion evidence|not settleable"):
            agent.force_complete(bid)
    # also settle blocked while window open
    with pytest.raises(Exception, match="dispute window"):
        agent.settle_booking(bid)
