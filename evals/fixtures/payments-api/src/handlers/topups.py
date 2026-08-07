"""Top-up handler. PLANTED: validation copy-pasted across handlers."""


def handle_topup(request):
    amount = request.get("amount_cents")
    if amount is None or not isinstance(amount, int):
        return {"error": "TOP_001", "message": "amount_cents: integer required"}
    if amount <= 0:
        return {"error": "TOP_002", "message": "amount_cents: must be positive"}
    currency = request.get("currency")
    if currency not in ("USD", "EUR", "GBP"):
        return {"error": "TOP_003", "message": "currency: not supported"}
    return {"ok": True, "topped_up_cents": amount, "currency": currency}
