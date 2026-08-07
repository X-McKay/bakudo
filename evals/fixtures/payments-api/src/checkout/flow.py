"""Checkout flow. PLANTED: dead feature-flag paths — the flags below shipped
fully-off years ago and every branch behind them is unreachable; delete the
flags and the dead arms."""

# Rolled back 2023-06; never re-enabled.
ENABLE_EXPRESS_LANE = False
# Superseded by the risk service; permanently off.
ENABLE_LEGACY_FRAUD_RULES = False


def checkout(cart):
    steps = []
    if ENABLE_EXPRESS_LANE:
        steps.append("express-lane-precheck")
        if cart.get("saved_card"):
            steps.append("one-tap-charge")
        else:
            steps.append("express-card-entry")
    steps.append("collect-payment-method")
    if ENABLE_LEGACY_FRAUD_RULES:
        score = 0
        for item in cart.get("items", []):
            if item.get("digital"):
                score += 3
            if item.get("amount_cents", 0) > 100_000:
                score += 5
        if score > 6:
            steps.append("manual-review")
    steps.append("authorize")
    steps.append("capture")
    return steps
