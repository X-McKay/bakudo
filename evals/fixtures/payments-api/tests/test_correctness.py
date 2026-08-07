"""Behaviour every optimization must preserve, one block per module."""

from src.admin.csv_download import render_csv
from src.archive.paths import archive_path, with_suffix
from src.billing.invoices import LineStore, list_invoices
from src.checkout.flow import checkout
from src.compliance.screening import screen_names
from src.config.loader import load_config
from src.events.normalize import normalize_batch
from src.export.writer import export_records
from src.fees.schedule import fee_bps_for
from src.fx.convert import convert_cents
from src.handlers.payments import handle_payment
from src.handlers.refunds import handle_refund
from src.handlers.topups import handle_topup
from src.handlers.transfers import handle_transfer
from src.imports.reader import count_records, read_import_file
from src.ingest.refparse import is_legacy_reference, parse_reference
from src.interest.accrual import accrue
from src.ledger.dedup import dedup_transactions
from src.notify.channels import EmailNotifier, SmsNotifier
from src.ratelimit.counter import allow
from src.reconciliation.loop import reconcile
from src.refunds.eligibility import is_refund_eligible
from src.reports.rows import build_rows
from src.retry.policy import record_attempt, schedule_retries
from src.settlement.calculator import settle
from src.settlement.ingest import parse_settlement_file, parse_settlement_line
from src.statements.render import render_statement
from src.webhooks.dispatch import Transport, fan_out


def test_invoice_listing():
    store = LineStore({1: {"amount_cents": 100}, 2: {"amount_cents": 250}})
    out = list_invoices(store, [{"id": "inv-1", "line_ids": [1, 2]}])
    assert out == [
        {
            "id": "inv-1",
            "lines": [{"amount_cents": 100}, {"amount_cents": 250}],
            "total_cents": 350,
        }
    ]


def test_dedup_keeps_first_occurrence():
    txns = [
        {"account": "a", "amount_cents": 5, "reference": "r1", "seq": 1},
        {"account": "a", "amount_cents": 5, "reference": "r1", "seq": 2},
        {"account": "b", "amount_cents": 5, "reference": "r1", "seq": 3},
    ]
    out = dedup_transactions(txns)
    assert [t["seq"] for t in out] == [1, 3]


def test_reference_parsing():
    assert parse_reference("PAY-2024-000123") == ("PAY", 2024, 123)
    assert parse_reference("nope") is None
    assert is_legacy_reference("P123456") and not is_legacy_reference("PP123456")


def test_statement_render_shape():
    text = render_statement(
        "acct-1",
        [{"date": "2026-01-01", "description": "coffee", "amount_cents": 450}],
    )
    assert "Statement for acct-1" in text
    assert "coffee" in text and "4.50" in text
    assert text.strip().endswith("4.50")


def test_screening_hits_in_order():
    names = ["alice", "blocked-party-0007", "bob", "blocked-party-0001"]
    assert screen_names(names) == ["blocked-party-0007", "blocked-party-0001"]


def test_webhook_fanout_delivers_all():
    transport = Transport()
    events = [{"id": i, "endpoint": f"https://e{i % 2}"} for i in range(6)]
    assert fan_out(transport, events) == 6
    assert [event_id for _, event_id in transport.sent] == list(range(6))


def test_fee_tiers():
    assert fee_bps_for(0) == 45
    assert fee_bps_for(150_000) == 25
    assert fee_bps_for(9_999_999) == 8


def test_normalize_defaults_and_isolation():
    events = [{"type": "charge", "meta": None, "payload": {"n": 1}}]
    out = normalize_batch(events)
    assert out[0]["type"] == "CHARGE"
    assert out[0]["source"] == "unknown"
    assert out[0]["meta"]["schema_version"] == 2
    assert events[0]["type"] == "charge", "input must not be mutated"


def test_export_writes_all_lines(tmp_path):
    path = tmp_path / "out.psv"
    records = [
        {"id": f"r{i}", "account": "a", "amount_cents": i} for i in range(5)
    ]
    assert export_records(str(path), records) == 5
    assert len(path.read_text().splitlines()) == 5


def test_fx_conversion_rounds():
    assert convert_cents(0, "EUR") == 0
    # The wire table repeats currencies; the last EUR entry (index 290) wins.
    assert convert_cents(10_000, "EUR") == int(round(10_000 * float(f"{1.0 + 290 / 97:.6f}")))


def test_notifiers():
    email = EmailNotifier().notify({"email": "a@b"}, "hello")
    assert email == ("email", "a@b", "[payments] hello")
    sms = SmsNotifier().notify({"phone": "555"}, "x" * 200)
    assert sms[0] == "sms" and len(sms[2]) == 160


def test_handlers_error_codes_are_stable():
    bad = {"amount_cents": -1, "currency": "USD"}
    assert handle_payment(bad)["error"] == "PAY_002"
    assert handle_refund(bad)["error"] == "REF_002"
    assert handle_topup(bad)["error"] == "TOP_002"
    assert handle_transfer(bad)["error"] == "TRF_002"
    ok = {"amount_cents": 100, "currency": "EUR"}
    assert handle_payment(ok)["ok"] and handle_transfer(ok)["ok"]


def test_refund_eligibility_decision_table():
    policy = {"window_days": 90, "allow_partial": False, "currencies": ["USD"]}
    good = {"status": "settled", "age_days": 10, "amount_cents": 100, "currency": "USD"}
    assert is_refund_eligible(good, policy) is True
    assert is_refund_eligible(None, policy) is False
    assert is_refund_eligible({**good, "disputed": True}, policy) is False
    assert is_refund_eligible({**good, "age_days": 91}, policy) is False
    assert is_refund_eligible({**good, "partially_refunded": True}, policy) is False


def test_checkout_steps():
    assert checkout({"items": []}) == ["collect-payment-method", "authorize", "capture"]


def test_report_rows():
    rows = build_rows(
        [
            {
                "id": "p1", "account": "a", "amount_cents": 1000,
                "currency": "USD", "status": "settled", "fee_cents": 25,
            }
        ]
    )
    assert rows[0]["net_cents"] == 975 and rows[0]["settled"] is True


def test_settlement_csv_parser_grammar():
    assert parse_settlement_line('a,"b,c",d') == ["a", "b,c", "d"]
    assert parse_settlement_line('x,"say ""hi""",y') == ["x", 'say "hi"', "y"]
    assert parse_settlement_file("a,b\n\nc,d\n") == [["a", "b"], ["c", "d"]]


def test_retry_policy_schedule():
    assert schedule_retries(delays=[1, 2]) == [1, 2]
    assert record_attempt(1, log=[])[0]["attempt"] == 1


def test_reconcile_counts():
    ledger = {"r1": {"amount_cents": 10}}
    out = reconcile(
        [
            {"reference": "r1", "amount_cents": 10},
            {"reference": "r2", "amount_cents": 5},
        ],
        lambda ref: ledger[ref],
    )
    assert out == {"matched": 1, "missed": ["r2"]}


def test_archive_paths():
    assert archive_path("/data", "acct", 2026, 3, "jan.pdf") == "/data/acct/2026/03/jan.pdf"
    assert with_suffix("/a/b/report.pdf", ".zip") == "/a/b/report.zip"


def test_import_reader(tmp_path):
    path = tmp_path / "bank.txt"
    path.write_text("one\n\ntwo\n")
    assert read_import_file(str(path)) == ["one", "two"]
    assert count_records([str(path), str(path)]) == 4


def test_settlement_calculator():
    out = settle([{"amount_cents": 10_000}, {"amount_cents": 5_000}], fee_bps=25)
    assert out == {"count": 2, "gross_cents": 15_000, "fee_cents": 38, "net_cents": 14_962}


def test_config_loader():
    config = load_config("fee_bps = 30  # tuned\n\ncurrency = EUR\n")
    assert config["fee_bps"] == 30 and config["currency"] == "EUR"
    assert config["max_retries"] == 3


def test_rate_limit_counter():
    counts: dict = {}
    assert allow("c1", 0, counts, limit=2)
    assert allow("c1", 0, counts, limit=2)
    assert not allow("c1", 0, counts, limit=2)


def test_interest_accrual():
    assert accrue([100_000, 0], annual_bps=365, days=10) == [100, 0]


def test_admin_csv():
    text = render_csv([{"a": 1, "b": 2}], columns=["a", "b"])
    assert text.splitlines() == ["a,b", "1,2"]
