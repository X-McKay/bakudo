---
name: workload-authoring
description: >-
  Authors a correct, versioned WorkloadSpec for trusted latency measurement.
  Use when creating or changing a performance workload for a target
  repository: the measured loop, the stub boundary, guest resources, metric
  policy, and the immutability rules.
---

# Workload Authoring

A workload turns "is this code faster?" into trusted, repeatable evidence.
Every rule below exists because breaking it silently corrupts that evidence.

## What the harness actually measures

`latency_seconds` is the wall clock of the **entire** `command.argv` process:
interpreter startup and imports included. Size the measured loop so it
dominates — if imports cost ~1s, a 200ms loop is 17% signal and 83% noise.
Target a loop that is at least half of total wall time, verified by timing an
import-only run against the full run before publishing. `cpu_seconds` and
`peak_rss_bytes` come from the harness's process accounting; a workload
script cannot report custom metrics, so design the phenomenon into wall time.

## The stub boundary

Only the repository worktree (`/workspace`, the command's cwd) is under
measurement. Everything else the scenario needs — a fake upstream, fixture
data, driver code — is **workload-owned** and must be identical across every
revision measured, or the comparison is meaningless. Import measured code
from the worktree (`sys.path.insert(0, str(Path.cwd() / "src"))`); keep the
stub inside the workload script. In-process transports (for example httpx's
ASGITransport for web services) remove socket noise while still exercising
the real code path.

## Mechanics the guest imposes

- The guest ships `python3` (never bare `python`); Debian-based, glibc.
- Workload members are reconstructed under a private directory before the
  command runs. Locate sibling members via `Path(__file__).parent` or
  `$BAKUDO_WORKLOAD_DIR` — never via the working directory, which is the
  repository under measurement.
- `environment.cpuCount`/`memoryMb` in the spec become the guest's actual
  resources and **must equal** the environment pin's values, or admission
  fails.
- Target-repository dependencies come from the repo's own `.abox/prepare.sh`
  (hermetic vendored wheels under `network: none`) — see the
  `repo-onboarding` skill.

## Fail loudly, deterministically

The script must verify its own scenario (response codes, passthrough
fidelity, cycle counts) and raise on any deviation — a silently degenerate
loop produces confident nonsense. Fix `PYTHONHASHSEED` in `command.env` and
avoid wall-clock-dependent control flow.

## Publishing and immutability

Any content change to a published workload requires a **version bump**: the
durable ledger and the corpus digest locks both reject a changed manifest
under an existing `name@version`. After authoring:

1. `bakudo workload validate DIR --json`
2. Host-run the script once from the target repo to prove it passes.
3. Register the bundle digest in the corpus lock and run the corpus verifier.
4. Sanity-check sensitivity: `bakudo performance prescreen` against two
   known-different refs should move; an A/A `bakudo performance calibrate`
   must come back equivalent.
