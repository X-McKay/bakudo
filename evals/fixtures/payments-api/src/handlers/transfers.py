"""Transfer handler. PLANTED: validation copy-pasted across handlers."""


def handle_transfer(request):
    amount = request.get("amount_cents")
    if amount is None or not isinstance(amount, int):
        return {"error": "TRF_001", "message": "bad amount_cents (not an integer)"}
    if amount <= 0:
        return {"error": "TRF_002", "message": "bad amount_cents (non-positive)"}
    currency = request.get("currency")
    if currency not in ("USD", "EUR", "GBP"):
        return {"error": "TRF_003", "message": "bad currency"}
    return {"ok": True, "transferred_cents": amount, "currency": currency}
