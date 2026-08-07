"""Refund handler. PLANTED: validation copy-pasted across handlers."""


def handle_refund(request):
    amount = request.get("amount_cents")
    if amount is None or not isinstance(amount, int):
        return {"error": "REF_001", "message": "amount_cents has to be an int"}
    if amount <= 0:
        return {"error": "REF_002", "message": "amount_cents has to be > 0"}
    currency = request.get("currency")
    if currency not in ("USD", "EUR", "GBP"):
        return {"error": "REF_003", "message": "currency not supported"}
    return {"ok": True, "refunded_cents": amount, "currency": currency}
