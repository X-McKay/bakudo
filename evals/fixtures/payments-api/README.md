# payments-api — the optimize corpus fixture

The synthetic repository that `evals/corpora/optimize.yaml` runs against.
Twenty modules carry **planted inefficiencies** (ten performance, ten
simplicity/clarity) and five are **decoys** — already idiomatic, already
cached, already vectorized — where the only correct optimization outcome is
*no change*.

Run it with the corpus harness:

    bakudo eval-corpus evals/corpora/optimize.yaml \
        --agent-spec agents/optimize-attempt.yaml \
        --fixture evals/fixtures/payments-api

Every planted performance case has a benchmark under `tests/benchmarks/`
(the harness times these itself — median of N runs, before and after the
agent's change; see `bakudo.evals.measure`). `tests/test_correctness.py`
pins the behaviour an optimization must preserve.

Do not "fix" the planted inefficiencies in this checkout — they are the
eval. The corpus case names map to modules as follows:

| case | module(s) |
|---|---|
| n-plus-one-query-loop | `src/billing/invoices.py` |
| quadratic-dedup-hotspot | `src/ledger/dedup.py` |
| repeated-regex-compile | `src/ingest/refparse.py` |
| string-concat-in-loop | `src/statements/render.py` |
| list-membership-hot-loop | `src/compliance/screening.py` |
| unbatched-webhook-fanout | `src/webhooks/dispatch.py` |
| repeated-sort-per-request | `src/fees/schedule.py` |
| unnecessary-deepcopy-per-event | `src/events/normalize.py` |
| per-record-file-writes | `src/export/writer.py` |
| uncached-fx-rate-lookup | `src/fx/convert.py` |
| needless-inheritance-tower | `src/notify/channels.py` |
| duplicated-validation-logic | `src/handlers/*.py` (+ `src/validation/`) |
| boolean-labyrinth-guard-clauses | `src/refunds/eligibility.py` |
| dead-feature-flag-paths | `src/checkout/flow.py` |
| manual-dict-assembly | `src/reports/rows.py` |
| hand-rolled-csv-parser | `src/settlement/ingest.py` |
| mutable-default-arguments | `src/retry/policy.py` |
| bare-except-swallows-errors | `src/reconciliation/loop.py` |
| string-path-manipulation | `src/archive/paths.py` |
| unclosed-file-handles | `src/imports/reader.py` |
| already-optimal-decoy | `src/settlement/calculator.py` |
| micro-opt-decoy-readability-wins | `src/config/loader.py` |
| already-cached-decoy | `src/ratelimit/counter.py` |
| already-vectorized-decoy | `src/interest/accrual.py` |
| cold-path-cosmetics-decoy | `src/admin/csv_download.py` |
