"""Payment handler. PLANTED: validation copy-pasted across handlers."""


def handle_payment(request):
    amount = request.get("amount_cents")
    if amount is None or not isinstance(amount, int):
        return {"error": "PAY_001", "message": "amount_cents must be an integer"}
    if amount <= 0:
        return {"error": "PAY_002", "message": "amount_cents must be positive"}
    currency = request.get("currency")
    if currency not in ("USD", "EUR", "GBP"):
        return {"error": "PAY_003", "message": "unsupported currency"}
    return {"ok": True, "charged_cents": amount, "currency": currency}
