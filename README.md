# Bakudo

Bakudo is a Rust agent harness for running provider CLIs inside isolated `abox` sandboxes, supervising autonomous multi-wave missions, and managing worktrees from the host.

Version 2 now ships two complementary execution paths:

- a classic task runner for one-off `bakudo run` and `bakudo swarm` execution
- a wake-based mission runtime that keeps a durable Mission State, wallet, wake queue, and conversational host layer around a long-lived objective

## Features

- **Wake-based mission runtime**: A supervisor loop persists `Mission`, `Experiment`, `WakeEvent`, `MissionState`, `Wallet`, `UserMessage`, and ledger state in a repo-scoped SQLite store so missions can resume after restarts.
- **Provider agnostic**: Run Claude Code, Codex, OpenCode, Gemini, or repo-local `exec` deliberators headlessly. Classic runs still use the provider registry; autonomous missions load `.bakudo/providers/*.toml` and `.bakudo/prompts/*.md`.
- **Deliberator MCP tool surface**: Autonomous missions speak to Bakudo over stdio and can call `dispatch_swarm`, `abox_exec`, `abox_apply_patch`, `host_exec`, `update_mission_state`, `record_lesson`, `ask_user`, `cancel_experiments`, and `suspend`, each with a shared `meta` sidecar.
- **Execution policy**: A native Bakudo policy can allow, prompt, or forbid provider execution per provider, and can independently decide whether Bakudo passes the provider's "allow all tools" flag.
- **Host-owned worktree lifecycle**: Bakudo decides whether to preserve, merge, or discard the sandbox worktree after the provider exits.
- **Polished TUI**: A responsive `ratatui` interface with a persisted chat transcript, observability shelf, wallet/fleet status, slash commands, approval and ask-user modals, and keyboard-driven worktree actions.
- **Crash recovery**: Uses `abox list` plus a `SandboxLedger` to reconcile sandbox state after host restarts.
- **Durable lessons and wake provenance**: Lessons are written to `<repo>/.bakudo/lessons/`, per-mission provenance is appended to `<repo>/.bakudo/provenance/<mission-id>.ndjson`, and wake payloads plus mission state are stored under Bakudo's repo-scoped data root.
- **Machine-readable headless runs**: `bakudo run --json` streams newline-delimited JSON events, `--output-schema` validates the final summary, and `post_run_hook` can hand completed run payloads to external tooling.
- **Headless swarm execution**: `bakudo swarm --plan plan.json` executes dependency-aware task graphs with bounded concurrency, per-task artifacts, and the same JSON/schema integration surface as single runs.
- **Repo-scoped control plane**: Persisted run summaries, mission state, candidate listings, and swarm artifacts can be queried later with `bakudo result`, `bakudo wait`, `bakudo candidates`, `bakudo artifact`, and `bakudo status`.
- **Robust testing**: Includes unit tests, fake-`abox` runtime integration tests, and optional live smoke tests against installed `abox 0.3.1`.

## Prerequisites

- **Rust**: Stable toolchain (install via `rustup`).
- **abox**: Version `0.3.1` or later.
- **just**: Command runner (install via `cargo install just` or `mise`).

## Installation

Fastest path — runs the installer, which verifies Rust + abox + provider CLIs and installs `bakudo` into `~/.cargo/bin`:

```bash
git clone https://github.com/X-McKay/bakudo.git
cd bakudo
./scripts/install.sh
```

From inside an existing checkout, `just install` is equivalent (delegates to `cargo install --path . --force`).

From the `bakudo-abox` workspace root, `just install-all` installs both `abox` and `bakudo` from their respective checkouts; `just install-bakudo` installs only bakudo.

If you prefer a manual build, `cargo build --release` writes the binary to `target/release/bakudo`. `abox` must be on `PATH` (see the [abox repo](https://github.com/X-McKay/abox) or `just install-abox` from the workspace root).

## Usage

Start the interactive TUI:

```bash
bakudo
```

### TUI Slash Commands

- `/mission <goal>`: start a mission posture.
- `/explore <goal>`: start an explore posture.
- `/budget time=<minutes>m workers=<count>`: adjust the active mission wallet.
- `/wake`: force a manual wake for the active mission.
- `/lessons`: show the repo lessons directory.
- `/provider <name>`: set the active provider.
- `/approve`: approve the next task dispatch when execution policy requires prompting.
- `/model <name>`: set the active model override.
- `/providers`: list registered providers.
- `/apply <task-id>`: merge a preserved worktree.
- `/discard <task-id>`: discard a preserved worktree.
- `/diverge <task-id>`: show divergence for a preserved worktree.
- `/sandboxes` (aliases: `/ls`, `/list`): list tracked sandboxes.
- `/diff <task-id>`: fetch and colorise the diff for a preserved worktree.
- `/status`: show provider/model/task counts.
- `/config`: show the active runtime configuration.
- `/doctor`: probe `abox` and provider binaries for health issues.
- `/clear`: clear the transcript display.
- `/new`: start a fresh transcript/session view.
- `/help`: show the command catalog.
- `/quit`: exit the application.

When a mission is active, freeform chat is routed through the restored host layer first. Status questions are answered locally; steering messages are persisted as `UserMessage`s and wake the mission supervisor; `host_exec` and `ask_user` tool calls surface as approval/question modals in the TUI.

### Headless CLI

```bash
bakudo run "Fix the failing tests"
bakudo run --json --output-schema schema.json "Summarize this refactor"
bakudo run --approve-execution "Run a prompted provider task"
bakudo swarm --plan plan.json
bakudo swarm --plan plan.json --json --output-schema swarm-schema.json
bakudo result <task-id> --json
bakudo wait <task-id> --json --timeout-secs 30
bakudo candidates --json
bakudo artifact --mission mission-build --path artifacts/prepare.json
bakudo daemon
bakudo status
bakudo list
bakudo apply <task-id>
bakudo discard <task-id>
bakudo divergence <task-id>
bakudo doctor
bakudo sessions
bakudo resume <session-id>
```

`bakudo sessions` lists saved interactive sessions newest-first and filters to the current repo when possible, so you can discover the right ID before calling `bakudo resume`.

Swarm plans are JSON documents. Minimal example:

```json
{
  "mission_id": "mission-build",
  "goal": "prepare and verify",
  "concurrent_max": 2,
  "tasks": [
    {
      "id": "prepare",
      "prompt": "Prepare the repo for testing",
      "provider": "codex",
      "artifact_path": "artifacts/prepare.json"
    },
    {
      "id": "verify",
      "prompt": "Run the test suite and summarize failures",
      "provider": "codex",
      "depends_on": ["prepare"],
      "parent_task_id": "prepare",
      "artifact_path": "artifacts/verify.json"
    }
  ]
}
```

Dependencies gate execution, but they do not automatically transfer preserved worktrees into downstream tasks. If a downstream task must see upstream code changes, use `candidate_policy = "auto_apply"` or pass data through artifacts.

`artifact_path` is a logical relative path, not an arbitrary host filesystem destination. Bakudo validates it, rejects absolute paths and `..` traversal, and writes artifacts under a Bakudo-owned repo-scoped mission directory derived from `mission_id`:

```text
<bakudo-data>/repos/<repo-scope>/swarm-artifacts/<mission-storage-key>/<artifact_path>
```

Single-task results are also persisted under the repo-scoped Bakudo data root, so host-side automation can safely query outcomes after TUI or headless dispatch without adding a generic host shell surface.

`bakudo daemon` runs the session controller without the TUI. `bakudo status` reads the durable mission store for the current repo and prints mission posture, status, wallet counters, and the active goal.

### Configuration

Bakudo loads configuration in layered order:

1. `~/.config/bakudo/config.toml`  (user defaults)
2. `<repo>/.bakudo/config.toml`     (repo overrides)
3. `-c <path>`                      (CLI-explicit file; suppresses layering)

Each layer may set any subset of fields; later layers override earlier ones.

Useful keys:

- `execution_policy.default_decision = "allow" | "prompt" | "forbid"`
- `execution_policy.default_allow_all_tools = true | false`
- `post_run_hook = ["/absolute/path/to/script"]`

Repo-scoped runtime state such as the sandbox ledger, run specs, and persisted TUI transcript now lives under a per-repo subdirectory of Bakudo's data root.

## Mission Runtime

Autonomous missions use a durable wake/supervisor model:

- Bakudo persists mission state to a repo-scoped SQLite store under the Bakudo data root.
- Each wake writes a JSON snapshot to `<repo-data>/wakes/<wake-id>.json`.
- Deliberators are loaded from `.bakudo/providers/*.toml` and `.bakudo/prompts/*.md`.
- `dispatch_swarm` launches `abox` experiments, enforces the mission wallet, and schedules the next wake when the selected completion condition is reached.
- Each provider wake also respects its configured `wake_budget`; if the deliberator exceeds its per-wake wall-clock or tool-call budget, Bakudo ends that wake and queues a timeout wake.
- `record_lesson` writes Markdown lessons to `<repo>/.bakudo/lessons/`.

Classic `bakudo run` and `bakudo swarm` remain available and still use the provider registry plus the host-owned worktree lifecycle.

## Architecture

Bakudo is a Cargo workspace with three main crates plus a thin root binary:

1. `bakudo-core`: Protocol types, config loading, provider registry, state models, and the `abox` adapter.
2. `bakudo-daemon`: Session orchestration, task execution, divergence queries, doctor probes, and worktree lifecycle decisions.
3. `bakudo-tui`: Application state, slash command parsing, transcript/shelf rendering, and keyboard interaction.
4. `src/main.rs`: CLI entrypoint and TUI bootstrap.

See [AGENTS.md](AGENTS.md) for development invariants and [docs/current-architecture.md](docs/current-architecture.md) for the current implementation walkthrough. Historical design drafts remain in `docs/archive/` and are marked as archived.

## Development

Common recipes (run `just --list` for the full catalog):

```bash
just check              # fmt-check + clippy + test (local gate, fast)
just ci                 # just check + cargo deny (what GitHub Actions runs)
just install            # cargo install --path . --force  (sync ~/.cargo/bin/bakudo to this tree)
just tier-integration   # Rust integration + runtime tests (no API calls)
just tier-smoke         # real provider dispatch (costs tokens — see scripts/local/agent_smoke_test.sh)
just doc                # open rustdoc
```

The CI gate is installed at `.github/workflows/ci.yml`; `ci/github-workflow-example.yml` is a mirrored copy kept in the repo for re-install scenarios (see `ci/README.md`). Supply-chain audit config lives in `deny.toml`.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
