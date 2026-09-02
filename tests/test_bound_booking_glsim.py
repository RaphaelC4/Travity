"""Strict binding e2e: hold→confirm→settlement with carrier evidence, 6h window, no bypass."""

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


def _quote(direct_vm, agent, depart=PAST_DEPART, ret=PAST_RET):
    direct_vm.mock_web(rf"{FEED}/quote.*", {"status": 200, "body": json.dumps({"route": "JFK-LHR", "price_wei": PRICE})})
    direct_vm.mock_llm(r".*", str(PRICE))
    agent.refresh_quote("JFK", "LHR", depart, ret)


def _hold_confirm(direct_vm, agent, sender, ref="PNRABC123", offer=OFFER_ID, order=ORDER_ID, pas=PAS_ID, itin=ITIN_JSON, depart=PAST_DEPART, ret=PAST_RET):
    _quote(direct_vm, agent, depart, ret)
    with direct_vm.prank(sender):
        direct_vm.value = PRICE
        bid = agent.hold_booking("JFK", "LHR", depart, ret, offer, pas, itin)
    direct_vm.value = 0
    with direct_vm.prank(sender):
        agent.confirm_purchase(bid, order, ref)
    return bid


def _completion_body(status="completed", source="duffel-live", ref="PNRABC123", order=ORDER_ID):
    return json.dumps({"ref": ref, "duffel_order_id": order, "passenger_id": PAS_ID, "itinerary_json": ITIN_JSON, "offerId": OFFER_ID, "route": "JFK-LHR", "status": status, "source": source, "aviation": {"flight_status": "landed"} if source == "aviationstack" else None})


def test_ref_and_order_reuse_blocked(direct_vm, agent, direct_alice, direct_bob):
    _ = _hold_confirm(direct_vm, agent, direct_alice)
    # same ref/order with different sender must revert at confirm
    _quote(direct_vm, agent)
    with direct_vm.prank(direct_bob):
        direct_vm.value = PRICE
        bid2 = agent.hold_booking("JFK", "LHR", PAST_DEPART, PAST_RET, "off_other_offer_99999", PAS_ID, ITIN_JSON)
    direct_vm.value = 0
    with direct_vm.prank(direct_bob):
        with pytest.raises(Exception, match="already used"):
            agent.confirm_purchase(bid2, ORDER_ID, "PNRABC123")
    # same sender duplicate hold also blocked
    with direct_vm.prank(direct_alice):
        direct_vm.value = PRICE
        with pytest.raises(Exception, match="duplicate booking|already used"):
            agent.hold_booking("JFK", "LHR", PAST_DEPART, PAST_RET, OFFER_ID, PAS_ID, ITIN_JSON)
        direct_vm.value = 0


def test_settle_requires_completion_evidence(direct_vm, agent, direct_alice, direct_bob, direct_owner):
    agent.set_provider(direct_bob)
    bid1 = _hold_confirm(direct_vm, agent, direct_alice, ref="PNRNOEV1", offer="off_noev1_12345", order="ord_noev1_12345678")
    direct_vm.mock_web(rf"{FEED}/provider-status\?ref=PNRNOEV1.*", {"status": 404, "body": json.dumps({"error": "unknown"})})
    direct_vm.mock_llm(r".*", "")
    with pytest.raises(Exception, match="completion evidence"):
        agent.settle_booking(bid1)
    bid2 = _hold_confirm(direct_vm, agent, direct_bob, ref="PNRBADP2", offer="off_badp2_12345", order="ord_badp2_12345678")
    bad = json.dumps({"ref": "PNRBADP2", "duffel_order_id": "ord_badp2_12345678", "passenger_id": "pas_WRONG", "itinerary_json": ITIN_JSON, "offerId": "off_badp2_12345", "route": "JFK-LHR", "status": "completed", "source": "duffel-live"})
    direct_vm.mock_web(rf"{FEED}/provider-status\?ref=PNRBADP2.*", {"status": 200, "body": bad})
    direct_vm.mock_llm(r".*", bad)
    with pytest.raises(Exception, match="completion evidence"):
        agent.settle_booking(bid2)
    bid2b = _hold_confirm(direct_vm, agent, direct_owner, ref="PNRBADO3", offer="off_bado3_12345", order="ord_bado3_12345678")
    bad_ord = json.dumps({"ref": "PNRBADO3", "duffel_order_id": "ord_WRONG", "passenger_id": PAS_ID, "itinerary_json": ITIN_JSON, "offerId": "off_bado3_12345", "route": "JFK-LHR", "status": "completed", "source": "duffel-live"})
    direct_vm.mock_web(rf"{FEED}/provider-status\?ref=PNRBADO3.*", {"status": 200, "body": bad_ord})
    direct_vm.mock_llm(r".*", bad_ord)
    with pytest.raises(Exception, match="completion evidence"):
        agent.settle_booking(bid2b)
    with direct_vm.prank("0x4444444444444444444444444444444444444444"):
        direct_vm.value = PRICE
        _quote(direct_vm, agent)
        bid2c2 = agent.hold_booking("JFK", "LHR", PAST_DEPART, PAST_RET, "off_badi4b_12345", PAS_ID, ITIN_JSON)
    direct_vm.value = 0
    with direct_vm.prank("0x4444444444444444444444444444444444444444"):
        agent.confirm_purchase(bid2c2, "ord_badi4b_12345678", "PNRBADI4b")
    bad_itin = json.dumps({"ref": "PNRBADI4b", "duffel_order_id": "ord_badi4b_12345678", "passenger_id": PAS_ID, "itinerary_json": json.dumps({"wrong": True}), "offerId": "off_badi4b_12345", "route": "JFK-LHR", "status": "completed", "source": "duffel-live"})
    direct_vm.mock_web(rf"{FEED}/provider-status\?ref=PNRBADI4b.*", {"status": 200, "body": bad_itin})
    direct_vm.mock_llm(r".*", bad_itin)
    with pytest.raises(Exception, match="completion evidence"):
        agent.settle_booking(bid2c2)
    # correct evidence -> succeeds (fresh sender)
    with direct_vm.prank("0x5555555555555555555555555555555555555555"):
        direct_vm.value = PRICE
        _quote(direct_vm, agent)
        bid3 = agent.hold_booking("JFK", "LHR", PAST_DEPART, PAST_RET, "off_new_offer_99999", PAS_ID, ITIN_JSON)
    direct_vm.value = 0
    with direct_vm.prank("0x5555555555555555555555555555555555555555"):
        agent.confirm_purchase(bid3, "ord_new_order_99999", "PNRNEW99")
    body = json.dumps({"ref": "PNRNEW99", "duffel_order_id": "ord_new_order_99999", "passenger_id": PAS_ID, "itinerary_json": ITIN_JSON, "offerId": "off_new_offer_99999", "route": "JFK-LHR", "status": "completed", "source": "duffel-live"})
    direct_vm.mock_web(rf"{FEED}/provider-status\?ref=PNRNEW99.*", {"status": 200, "body": body})
    direct_vm.mock_llm(r".*", body)
    agent.settle_booking(bid3)
    raw = agent.view_booking(bid3)
    rec = json.loads(raw) if isinstance(raw, str) else raw
    assert rec["status"] == "completed"


FUTURE_DEPART, FUTURE_RET = 20991230, 20991231

def _hold_future(direct_vm, agent, sender):
    direct_vm.mock_web(rf"{FEED}/quote.*", {"status": 200, "body": json.dumps({"route": "JFK-LHR", "price_wei": PRICE})})
    direct_vm.mock_llm(r".*", str(PRICE))
    agent.refresh_quote("JFK", "LHR", FUTURE_DEPART, FUTURE_RET)
    with direct_vm.prank(sender):
        direct_vm.value = PRICE
        bid = agent.hold_booking("JFK", "LHR", FUTURE_DEPART, FUTURE_RET, OFFER_ID, PAS_ID, ITIN_JSON)
    direct_vm.value = 0
    with direct_vm.prank(sender):
        agent.confirm_purchase(bid, ORDER_ID, "PNRABC123")
    return bid


def test_dispute_window_blocks_owner_override(direct_vm, agent, direct_owner, direct_alice):
    agent.set_provider(direct_owner)
    bid = _hold_future(direct_vm, agent, direct_alice)
    body = _completion_body("completed", "duffel-live")
    direct_vm.mock_web(rf"{FEED}/provider-status.*", {"status": 200, "body": body})
    direct_vm.mock_llm(r".*", body)
    with direct_vm.prank(direct_owner):
        with pytest.raises(Exception, match="dispute window|completion evidence|not settleable"):
            agent.force_complete(bid)
    with pytest.raises(Exception, match="dispute window"):
        agent.settle_booking(bid)
