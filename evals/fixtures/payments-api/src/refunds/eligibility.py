"""Refund eligibility. PLANTED: a boolean labyrinth — deeply nested
conditionals that guard clauses would flatten. The decision table must not
change."""


def is_refund_eligible(payment, policy):
    if payment is not None:
        if payment.get("status") == "settled":
            if not payment.get("disputed", False):
                if payment.get("age_days", 0) <= policy.get("window_days", 90):
                    if payment.get("amount_cents", 0) > 0:
                        if policy.get("allow_partial", True) or not payment.get(
                            "partially_refunded", False
                        ):
                            if payment.get("currency") in policy.get(
                                "currencies", ["USD"]
                            ):
                                return True
                            else:
                                return False
                        else:
                            return False
                    else:
                        return False
                else:
                    return False
            else:
                return False
        else:
            return False
    else:
        return False
