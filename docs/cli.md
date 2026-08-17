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
runtime skill discovery, the configured task source, optional dependency
imports, execution posture, and persistence configuration. It never connects
to Postgres, Temporal, FalkorDB, a model endpoint, or abox.

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
make check
make wheel-smoke
```

`make install` installs `.[all,dev]`. Override `PYTHON` when necessary, for
example `make PYTHON=.venv/bin/python check`. `make wheel` builds without
editing `pyproject.toml` or any other tracked file.
