# CLI and developer workflows

The `bakudo` command is a thin developer and operator surface over Bakudo's
independently testable control-plane components. Commands are grouped under
singular resource names and default to readable text. Read-only and reporting
commands accept `--json` so scripts do not need to parse presentation text.

Run `bakudo --help` for the command map and `bakudo <command> --help` at any
level for arguments and defaults.

## Bootstrap and diagnostics

Install the full development surface and check it without contacting external
services:

```bash
python -m pip install -e ".[all,dev]"
BAKUDO_OFFLINE=1 bakudo doctor
```

`bakudo doctor` checks the Python and Bakudo versions, bundled AgentSpecs,
runtime skill discovery, configured task and workload sources, the performance
artifact root, abox measurement availability, the default `EnvironmentPin`,
profiler capabilities, optional dependency imports, execution posture, and
persistence configuration. It never connects to Postgres, Temporal, FalkorDB,
a model endpoint, or abox.

- `--json` emits a structured report.
- `--strict` returns non-zero for warnings as well as errors.
- An absent `BAKUDO_POSTGRES_DSN` is a warning because each CLI process then
  uses a fresh in-memory ledger.

## Command map

| Command | Purpose | JSON |
|---|---|---|
| `bakudo doctor` | Diagnose local readiness and configuration | `--json` |
| `bakudo agent list` | List packaged AgentSpecs | `--json` |
| `bakudo agent validate PATH` | Validate one AgentSpec | `--json` |
| `bakudo skill list` | List progressive-disclosure skill metadata | `--json` |
| `bakudo product-agent run` | Run the versioned no-eval self-host product boundary | artifact directory |
| `bakudo workload list` | List workloads from `BAKUDO_WORKLOAD_SOURCE` or packaged smoke fallback | `--json` |
| `bakudo workload validate PATH` | Validate and pin one workload directory | `--json` |
| `bakudo workload inspect REF` | Show a manifest, immutable pin, and provenance | `--json` |
| `bakudo performance preflight` | Verify fail-closed trusted-runner readiness before latency evidence | `--json` |
| `bakudo performance measure` | Collect an uninstrumented `MeasurementRecord` (`--sync` required locally) | `--json` |
| `bakudo performance capture` | Collect a diagnostic `PerformanceSnapshot` and restricted artifacts | `--json` |
| `bakudo performance compare` | Interleave baseline/candidate measurements and create a `PerformanceComparison` | `--json` |
| `bakudo performance profile-diff` | Align two diagnostic snapshots to explain changed hotspots; never evidence | `--json` |
| `bakudo performance show ID` | Read a persisted measurement, snapshot, or comparison | `--json` |
| `bakudo performance regressions` | List approved regression signals, optionally by repository | `--json` |
| `bakudo task list` | List tasks from `BAKUDO_TASK_SOURCE` | `--json` |
| `bakudo task verify REF` | Run the task authoring verification protocol | `--json` |
| `bakudo task scaffold NAME` | Create an authoring skeleton in an explicit corpus root | — |
| `bakudo task publish REF` | Publish an immutable content-addressed task bundle | — |
| `bakudo task inspect-bundle PATH` | Validate a bundle and print its immutable pin | always |
| `bakudo repo add/list/remove` | Manage registered repository checkouts | add/list |
| `bakudo trial run REF` | Evaluate one agent version on one task | `--json` |
| `bakudo experiment run/compare/profile/result` | Orchestrate and inspect experiments | `--json` |
| `bakudo demo` | Exercise the offline objective pipeline | `--json` |
| `bakudo optimize` | Run the bounded scout/attempt/selection loop | `--json` |
| `bakudo serve` | Start the control API | — |

There are intentionally no compatibility aliases for retired command names;
this active-development codebase favors one predictable spelling per action.

## Black-box product-agent command

`bakudo product-agent run --protocol v1` is the candidate-generation side of
Bakudo's external evaluation boundary. It accepts an absolute staged Bakudo
workspace, an absolute UTF-8 instruction file, and a new absolute output
directory. It runs the packaged implementation agent directly through
`AboxRunner`; it never enters the objective pipeline, Temporal workflow,
evaluation, experiment, comparison, or promotion code.

The output directory is published atomically and contains only
`candidate.patch` plus the strict `result.json` status/patch/usage/runtime
envelope. It never contains a score, verdict, pass flag, or agent summary.
Version 1 deliberately rejects generic repositories and task-owned abox
configuration. See [Product-agent process protocol v1](product-agent-protocol.md)
for staging limits, status semantics, exact abox compatibility, cancellation,
and the non-attestation boundary.

## Task and experiment workflow

Core includes two smoke tasks. Point the source at the private corpus checkout
for benchmark work:

```bash
export BAKUDO_TASK_SOURCE="$HOME/git/bakudo-benchmarks"
bakudo task list --partition dev --json
BAKUDO_ENV=dev bakudo task verify rate-limiter-fix
BAKUDO_ENV=dev bakudo trial run rate-limiter-fix --agent add-feature@1 --json
```

`BAKUDO_ENV=dev` opts into the host-executing verifier and is only appropriate
for trusted local authoring. Outside that posture, verifier-backed commands
require `BAKUDO_SANDBOX=abox` and use the abox guest runner. They fail closed if
neither trusted runner is configured.

Use `bakudo task scaffold --help` before authoring. Scaffolding writes only
under the explicit `--root`; publication writes only under `--output`; and
`repo remove` deregisters a checkout without deleting its files.

`ExperimentSpec.subject` is explicit. `agent-spec` subjects contain agent arms
and a `taskSelector`; `software-artifact` subjects contain a repository,
immutable baseline/candidate `RevisionPin` values, and a `WorkloadRef`.
`bakudo experiment run SPEC.yaml` dispatches either binding. Artifact
experiments use `BAKUDO_WORKLOAD_SOURCE`, `BAKUDO_PERFORMANCE_ENVIRONMENT`,
abox, and persisted `MeasurementRecord` evidence; they do not use the agent
verifier posture. `experiment profile` remains exclusively a candidate-free
behavioral agent experiment and is unrelated to `performance capture`.

## Workloads and trusted performance evidence

Tasks and workloads are different resources. A task evaluates an agent policy
and produces a `TrialRecord`; a workload exercises pinned target code and
produces uninstrumented `MeasurementRecord` samples. Configure their sources
independently:

```bash
export BAKUDO_WORKLOAD_SOURCE=/path/to/workload-corpus-or-bundle
export BAKUDO_PERFORMANCE_ENVIRONMENT=/path/to/environment-pin.json
export BAKUDO_PERFORMANCE_RUNNER=trusted
export BAKUDO_SANDBOX=abox
export BAKUDO_POSTGRES_DSN='postgresql://...'

bakudo workload list --json
bakudo workload validate /path/to/workload-directory --json
bakudo workload inspect api-throughput@1.2.0 --json
bakudo workload validate-suite /path/to/performance-suite.yaml --json
bakudo performance preflight --json
```

The manifest declares the shell-free command, environment requirements,
warmups/repetitions/schedule, typed metrics, practical thresholds, and optional
profilers. Inspection prints the immutable `WorkloadPin`: source and collection
revision plus manifest, dataset, executor, and bundle digests.

A `PerformanceSuiteSpec` is a declarative group of workload references and
pre-registered primary/protected metric policies. `workload validate-suite`
resolves every reference, checks the scenario's minimum paired evidence against
the workload repetitions, and ensures requested regression profilers are
declared. It executes no target code and creates no measurement evidence.

Local measurement is intentionally explicit and requires abox, a clean git
revision, an environment pin, and a passing trusted-runner preflight:

```bash
bakudo repo add /path/to/checkout --name payments-api

bakudo performance measure --sync --repo payments-api \
  --workload api-throughput@1.2.0 --ref HEAD --json

bakudo performance compare --sync --repo payments-api \
  --workload api-throughput@1.2.0 \
  --baseline-ref main --candidate-ref candidate \
  --primary-metric latency_seconds \
  --protected-metric peak_rss_bytes --seed 17 --json

BAKUDO_ARTIFACT_ROOT=/srv/bakudo/performance-artifacts \
bakudo performance capture --sync --repo payments-api \
  --workload api-throughput@1.2.0 --ref HEAD \
  --profiler python-cpu --json
```

Without `--sync`, `measure`, `capture`, and `compare` fail before doing work and direct the
operator to the durable API. Timed comparisons never enable a profiler.
`performance show` reads durable records from the configured Postgres ledger;
without `BAKUDO_POSTGRES_DSN`, a new CLI process has an empty in-memory ledger
and prints a warning.

Use `profile-diff` only after compatible captures with the same workload,
environment, and profiler descriptor. It ranks normalized hotspot cost deltas
for diagnosis; it neither reads measurement records nor creates a promotion
eligible comparison:

```bash
bakudo performance profile-diff \
  --baseline-snapshot-id snapshot_BASELINE \
  --candidate-snapshot-id snapshot_CANDIDATE --json
```

The optimization CLI uses the same proof path and accepts neither a benchmark
command nor self-reported timing:

```bash
bakudo optimize --repo payments-api --title "Reduce request latency" \
  --target src/payments --workload api-throughput@1.2.0 \
  --primary-metric latency_seconds \
  --protected-metric peak_rss_bytes --json
```

The workload's subject repository must match the registered repository.
Selection requires a completed, compatible, integrity-valid comparison whose
candidate patch digest matches the captured attempt diff and whose confidence
interval clears the policy's minimum improvement. Diagnostic captures may
suggest hotspots but cannot satisfy this gate.

`bakudo performance capture --sync` and `PerformanceCaptureWorkflow` use the
same provision-and-capture service. It is available only in abox mode with
`BAKUDO_ARTIFACT_ROOT` set; the service owns fresh-guest lifecycle, bounded
artifact persistence, pin checks, and cleanup. Otherwise durable capture
returns the typed `unsupported` status and the sync command prints an
actionable configuration error.

## Performance API

The HTTP surface mirrors the domain resources:

- `GET /workloads` and `POST /workloads/validate`
- `POST /performance/measurements`
- `POST /performance/captures`
- `POST /performance/comparisons`
- `GET /performance/records/{measurement_|snapshot_|comparison_...}`
- `GET /performance/regressions?repository=NAME`

Create routes return HTTP 202 with an `operation_id`. `bakudo serve` wires the
Temporal dispatcher; an embedded `build_app()` without an injected dispatcher
returns HTTP 409 for create calls rather than executing work on the API host.
Workload validation and record reads remain available. When
`BAKUDO_API_TOKEN` is set, send it as a bearer token on every route.

## Output and exit statuses

Machine-facing success data goes to stdout. Validation, configuration, and
safety errors go to stderr. JSON modes emit one JSON document on stdout.

- `0`: command completed successfully.
- `1`: requested input failed validation, a resource was not found, a
  verification failed, or `doctor` reported a failing check.
- `2`: invalid CLI syntax/arguments or a required safety/runtime posture was
  not configured.

Argparse reports invalid choices and numeric bounds before invoking any
component. `doctor --strict` also uses status 1 when only warnings are present.

## Repository maintenance

Use the same interpreter for every tool:

```bash
make doctor
make test-performance
make check
make wheel-smoke
```

`make install` installs `.[all,dev]`. Override `PYTHON` when necessary, for
example `make PYTHON=.venv/bin/python check`. `make wheel` builds without
editing `pyproject.toml` or any other tracked file. `make
test-performance-temporal-live` requires `TEMPORAL_ADDRESS` and validates the
durable workflow path without KVM. `make test-performance-live` additionally
requires a trusted, warmed abox/KVM environment.
