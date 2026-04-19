# Phase 0 — Fix integration basics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the 12-item Phase 0 scope end-to-end: `abox --capabilities` as a top-level flag (F-00), ten bakudo bug-fix items (eight verified + two provisional), and a minimal host-preflight slice (F-P), with regression + integration + E2E coverage so the bakudo↔abox dogfood path works on a virtiofsd-capable host without workarounds.

**Architecture:** Two repos, one shipping unit. F-00 lands first in the Rust CLI (abox) because it unblocks the observable-acceptance path in bakudo. The remaining 10 items + F-P land in TypeScript (bakudo) across five logical waves ordered by coupling, then integration tests + E2E + docs close the phase. Every fix references the approved spec and Appendix A (envelope shape, exit codes, `approval_required` string) — the contract note is load-bearing and MUST NOT be re-designed during implementation.

**Tech Stack:**
- bakudo — TypeScript (Node 22), pnpm, mise tasks. Tests: `node --test` against compiled `dist/` output. Assertions: `node:assert` (regression) and `node:assert/strict` (integration).
- abox — Rust, cargo + just, clap v4 derive. Tests: `cargo test` (unit + integration-style under `tests/`); `just check` for fmt + clippy + test.
- Pre-commit: bakudo uses `mise run check` via a managed hook; abox uses `just check` manually.

**Source of truth:**
- `/home/al/git/bakudo-abox/plans/integration/2026-04-18-phase-0-spec.md` — approved spec, revision 2.
- `/home/al/git/bakudo-abox/plans/integration/2026-04-18-integration-roadmap.md` — four-phase frame (Phase 0 only in scope).

**Out of scope (enforce):** Anything from Phase 1/2/3. Worker extraction. Typed attribution buckets. Full deep-doctor. Schema-validating `doctorAboxProbe`. Rootfs presence checks. Adding ghost fields to the `--capabilities` envelope. If something feels essential that is not in the 12-item list, stop and flag it — do not add it unilaterally.

---

## Branch & commit strategy

One Phase 0 branch per repo. Commits are per-wave (or per-fix where a wave contains independent items) so review is linear and bisect stays useful.

- `abox`: branch `phase-0/integration-basics` — one wave worth of commits (Wave 1). Ships independently and must be tagged/released or invoked from a repo build before bakudo's F-00 integration test can pass against a real binary.
- `bakudo`: branch `phase-0/integration-basics` — six waves (2–7) of commits in order.

Conventional commits on both sides. Representative messages (adapt wording per fix; the shape matters more than the exact words):

- `feat(cli): add --capabilities top-level flag with config bypass` (abox F-00)
- `fix(host): route --version and -V through shouldUseHostCli` (bakudo F-01)
- `fix(host): preserve PATH when aboxBin is unqualified` (bakudo F-04)
- `fix(host): emit approval_required on --output-format=json` (bakudo F-05)
- etc.

Each wave ends with the repo's own check command passing (see "Gate before merging a wave" below).

**DO NOT COMMIT until the user has reviewed the plan.** The plan, spec, and roadmap live at the parent level outside version control by design. When the user gives the go-ahead, implementation commits land inside each sub-repo on the branches above.

---

## Gate before merging a wave

Run inside the sub-repo being touched:

- **bakudo** — `mise run check` (lint + build + node --test across unit, integration, regression, golden). Must exit 0.
- **abox** — `just check` (fmt-check + clippy with `-D warnings` + test). Must exit 0.

**No mandatory cross-repo gate between Waves 2–6.** The parent `just integration-test` recipe boots a real sandbox (`justfile:72`), which requires virtiofsd caps on the host. Per the `project_abox_binary_available.md` memory, the current host lacks those caps. Cross-repo E2E runs only in Wave 7, on a host that has been manually provisioned.

Do not proceed to the next wave until the current wave's gate passes.

---

## File structure summary

Every file touched, listed once with a pointer to the wave that modifies it. Responsibilities stay narrow; no unilateral restructuring.

### abox (Wave 1 only)

| File | Responsibility |
|------|----------------|
| `abox/crates/abox-cli/src/main.rs` | Flip `command: Commands` → `command: Option<Commands>`; add `#[arg(long)] capabilities: bool`; add the bypass branch before config load. |
| `abox/crates/abox-cli/src/commands/capabilities.rs` (new) | Printing the JSON envelope. Pure function; no config/orchestrator access. |
| `abox/crates/abox-cli/src/commands/mod.rs` | Add `pub mod capabilities;`. |
| `abox/crates/abox-cli/tests/capabilities_test.rs` (new) | Integration-style test that invokes the compiled binary via `env!("CARGO_BIN_EXE_abox")`, captures stdout, asserts the envelope shape. |

### bakudo (Waves 2–7)

| File | Waves | Responsibility |
|------|-------|----------------|
| `bakudo/src/host/parsing.ts` | 2 | `shouldUseHostCli` accepts `--version`/`-V`. |
| `bakudo/src/cli.ts` | 2 | Top-level flag routing for `--version`/`-V` to `printVersion()`; misrouted-flag error copy. |
| `bakudo/src/host/envPolicy.ts` | 2 | Module header doc noting host-side PATH preservation. |
| `bakudo/src/aboxAdapter.ts` | 2 | Inject `PATH` into spawn env when `aboxBin` has no path separator. |
| `bakudo/src/host/sessionLifecycle.ts` | 3 | Resume reads `attempt.attemptSpec ?? attempt.request`; converts via `attemptSpecToWorkerSpec`. |
| `bakudo/src/host/errors.ts` | 4 | Add `"approval_required"` to `BakudoErrorCode`. |
| `bakudo/src/host/oneShotRun.ts` | 4 | In JSON output mode, emit typed `approval_required` JSONL error and exit `BLOCKED` instead of prompting. |
| `bakudo/src/host/sessionController.ts` | 4 | Ensure `resolveAutoApprove` is NOT influenced by `outputFormat === "json"`. |
| `bakudo/src/host/explainConfig.ts` | 4 | Add known-key set; reject unknown keys with `harness_error: unknown config key: …`, exit 1. |
| `bakudo/src/host/inspectFormatter.ts` | 4 | `formatInspectSandbox` truncates `ABox` field to invocation vector + line/byte count + dispatch path hint. |
| `bakudo/src/host/commands/cleanup.ts` | 4 | Emit a "Would keep:" section in `--dry-run`. |
| `bakudo/src/host/hostPreflight.ts` (new) | 5 | `virtiofsd getcap` + `/dev/kvm` stat checks. |
| `bakudo/src/host/doctorAboxProbe.ts` | 5 | Call the preflight checks and fold their results into the doctor envelope. |
| `bakudo/src/host/commands/doctor.ts` | 5 | Wire preflight into `runDoctorChecks` as an early slice (surface before the abox probe). |
| `bakudo/src/host/inspectFormatter.ts` | 6 | If F-08 still broken: `formatInspectLogs` reads turnId/attemptId via `?? "-"` fallback. |
| `bakudo/src/host/dispatchProgress.ts` (new, provisional) | 6 | If F-13 still broken: emit a 10s progress line pre-first-event; suppressed when `outputFormat === "json"`. |
| `bakudo/tests/regression/F-*.test.ts` (~10 new) | 2–6 | One regression test per kept fix ID. |
| `bakudo/tests/integration/abox-capabilities.test.ts` (new) | 7 | Invokes `probeWorkerCapabilities` against the live abox binary. |
| `bakudo/tests/integration/spawn-abox-path.test.ts` (new) | 7 | F-04 PATH-preservation integration test. |
| `bakudo/tests/integration/oneshot-json-no-prompt.test.ts` (new) | 7 | F-05 `-p --output-format=json` never-prompts test. |

### parent (Wave 7)

| File | Responsibility |
|------|----------------|
| `/home/al/git/bakudo-abox/justfile` | Extend `integration-test` recipe to run the `--capabilities` probe check and the scratch-repo dispatch (E2E). |

---

## CI implications

- **abox Wave 1** — lands via `just check` (`tier-ci` every PR).
- **bakudo Waves 2–6** — each lands via `mise run check`. Regression + integration tests stay within the default build — no KVM, no virtiofsd.
- **Wave 7 E2E** — the `just integration-test` scratch-repo dispatch requires a virtiofsd-capable host and is KVM-gated. Stays in `tier-vm` (nightly), not `tier-ci` (every PR). The acceptance condition in the spec (§Testing strategy) explicitly permits running this locally pre-merge when CI cannot provision virtiofsd.

---

## Risk checkpoints between waves

- **After Wave 1 (abox F-00).** Verify the new `--capabilities` handler: `abox --capabilities` prints the JSON envelope; no config load happens (delete `~/.abox/config.toml` temporarily and the flag still works).
- **After Wave 2.** Verify `bakudo --version` and `bakudo -V` work without the `--goal` error (no VM needed). The `bakudo build` spawn-resolution smoke is VM-gated — defer it to Wave 7 on a virtiofsd-capable host. If you want a quick local signal that PATH injection works without booting a VM, run the F-04 unit/integration tests from Wave 2 / Wave 7; they exercise the adapter's spawn env without needing a real dispatch to succeed.
- **After Wave 3.** Verify resume works on a freshly-dispatched retryable failure AND on a v1 session (one persisted from pre-attemptSpec bakudo; see Wave 3 Task 3 for how to construct one).
- **After Wave 4.** Verify all four fixes manually: `-p --output-format=json` emits JSONL only; `doctor --explain-config nonsense.bogus` exits 1; `bakudo sandbox` (now via `inspect ... sandbox`) under ~20 lines; `cleanup --dry-run` shows both sections.
- **After Wave 5.** Verify F-P on both a virtiofsd-capable host and one with virtiofsd caps stripped (temporarily: `sudo setcap -r /path/to/virtiofsd` → `bakudo doctor` reports host-virtiofsd-caps → `sudo setcap 'cap_sys_admin+ep' /path/to/virtiofsd` to restore).
- **After Wave 6.** Confirm F-08/F-13 re-verification decisions are documented in the commit messages AND that the spec's baseline table has been updated inside a session note (not in the repo — the spec lives at the parent level).
- **After Wave 7.** Run the full acceptance checklist from spec §Acceptance criteria, items 1–15.

---

# Wave 1 — abox: `--capabilities` top-level flag (F-00)

**Scope:** F-00 only. Repo: abox.

Wave 1 unblocks Wave 7's F-00 integration-test acceptance but does NOT block Waves 2–6. Consider building Wave 1 first and in parallel with the early bakudo waves; just make sure Wave 1 has merged and `cargo install --path crates/abox-cli --locked` is available on `$PATH` before running Wave 7.

## Task 1.1 — Add `CARGO_BIN_EXE_abox`-based integration test scaffold (TDD first)

**Files:**
- Create: `abox/crates/abox-cli/tests/capabilities_test.rs`

Rust integration tests in `crates/<name>/tests/*.rs` are compiled as separate binaries and get the `CARGO_BIN_EXE_abox` env var automatically pointing to the compiled `abox` binary. No `assert_cmd` crate needed — use `std::process::Command`.

- [ ] **Step 1: Create the test file with a failing assertion.**

Write `abox/crates/abox-cli/tests/capabilities_test.rs`:

```rust
use serde_json::Value;
use std::process::Command;

#[test]
fn capabilities_flag_prints_envelope() {
    let output = Command::new(env!("CARGO_BIN_EXE_abox"))
        .arg("--capabilities")
        .output()
        .expect("failed to spawn abox --capabilities");

    assert!(
        output.status.success(),
        "abox --capabilities exited non-zero: stderr={}",
        String::from_utf8_lossy(&output.stderr),
    );

    let stdout = String::from_utf8(output.stdout).expect("stdout is UTF-8");
    let json: Value = serde_json::from_str(stdout.trim())
        .unwrap_or_else(|e| panic!("stdout is not JSON: {e}; stdout={stdout}"));

    let obj = json.as_object().expect("top-level JSON is an object");

    let versions = obj
        .get("protocolVersions")
        .and_then(Value::as_array)
        .expect("protocolVersions is an array");
    assert!(!versions.is_empty(), "protocolVersions is empty");
    assert!(versions.iter().all(Value::is_number), "protocolVersions entries must be numbers");
    let version_numbers: Vec<i64> = versions.iter().filter_map(Value::as_i64).collect();
    assert_eq!(version_numbers, vec![1, 3], "protocolVersions must equal [1, 3] per Appendix A.1");

    let kinds = obj
        .get("taskKinds")
        .and_then(Value::as_array)
        .expect("taskKinds is an array");
    let kind_strs: Vec<&str> = kinds.iter().filter_map(Value::as_str).collect();
    assert_eq!(
        kind_strs,
        vec!["assistant_job", "explicit_command", "verification_check"],
        "taskKinds must match Appendix A.1 exactly",
    );

    let engines = obj
        .get("executionEngines")
        .and_then(Value::as_array)
        .expect("executionEngines is an array");
    let engine_strs: Vec<&str> = engines.iter().filter_map(Value::as_str).collect();
    assert_eq!(
        engine_strs,
        vec!["agent_cli", "shell"],
        "executionEngines must match Appendix A.1 exactly",
    );

    // No ghost fields in Phase 0 — spec Appendix A.1 is explicit.
    let allowed_keys: std::collections::HashSet<&str> =
        ["protocolVersions", "taskKinds", "executionEngines"].into_iter().collect();
    for key in obj.keys() {
        assert!(
            allowed_keys.contains(key.as_str()),
            "unexpected key in --capabilities envelope: {key}",
        );
    }
}

#[test]
fn capabilities_flag_bypasses_config_load() {
    // Appendix A.1.1: the handler must bypass config/orchestrator load,
    // exactly as `init` and `doctor` do. Give abox a guaranteed-bad config
    // path and confirm --capabilities still succeeds.
    let output = Command::new(env!("CARGO_BIN_EXE_abox"))
        .arg("--config")
        .arg("/nonexistent/path/that/does/not/exist/abox.toml")
        .arg("--capabilities")
        .output()
        .expect("failed to spawn abox --capabilities with bad config");

    assert!(
        output.status.success(),
        "abox --capabilities must bypass config load; exited non-zero with stderr={}",
        String::from_utf8_lossy(&output.stderr),
    );
}
```

- [ ] **Step 2: Add `serde_json` as a dev-dependency if not already present.**

Check `abox/crates/abox-cli/Cargo.toml` `[dev-dependencies]`. If `serde_json` is missing, add it:

```toml
[dev-dependencies]
tempfile = "3"
serde_json = { workspace = true }
```

- [ ] **Step 3: Run the tests to confirm they fail.**

```bash
cd abox && cargo test -p abox-cli --test capabilities_test
```

Expected: both tests FAIL — compilation succeeds but invoking `abox --capabilities` errors with clap's "unexpected argument" or "no subcommand" message. Record the exact error in your notes for Step 5 verification.

- [ ] **Step 4: Commit the failing test.**

```bash
cd abox && git add crates/abox-cli/tests/capabilities_test.rs crates/abox-cli/Cargo.toml
git commit -m "test(cli): add failing capabilities_test scaffold (F-00)"
```

## Task 1.2 — Implement the `capabilities` command handler

**Files:**
- Create: `abox/crates/abox-cli/src/commands/capabilities.rs`
- Modify: `abox/crates/abox-cli/src/commands/mod.rs`

- [ ] **Step 1: Create the handler module.**

Write `abox/crates/abox-cli/src/commands/capabilities.rs`:

```rust
//! `abox --capabilities` — print the Phase 0 capability envelope.
//!
//! This handler MUST NOT load config, policy, or runtime dirs. The whole
//! point of the flag (spec Appendix A.1.1) is that it runs on a machine
//! where the rest of abox cannot.

use anyhow::Result;

/// Phase 0 envelope shape — frozen by spec Appendix A.1. Any change here
/// is a contract change and must be reflected in bakudo's
/// `validateCapabilitiesJson` + `BAKUDO_HOST_*` constants.
pub fn execute() -> Result<()> {
    // Hand-serialize to guarantee stable field order and avoid pulling
    // serde::Serialize into the CLI crate for a three-field payload.
    let json = concat!(
        "{",
        "\"protocolVersions\":[1,3],",
        "\"taskKinds\":[\"assistant_job\",\"explicit_command\",\"verification_check\"],",
        "\"executionEngines\":[\"agent_cli\",\"shell\"]",
        "}",
    );
    println!("{json}");
    Ok(())
}
```

- [ ] **Step 2: Wire the module into `commands/mod.rs`.**

Open `abox/crates/abox-cli/src/commands/mod.rs`. Add `pub mod capabilities;` alongside the other `pub mod <name>;` lines (alphabetical if the file is sorted; otherwise group-appropriate).

## Task 1.3 — Flip `command` to `Option`, add the root flag, wire the bypass

**Files:**
- Modify: `abox/crates/abox-cli/src/main.rs`

- [ ] **Step 1: Make `command` optional and add the capabilities flag on the `Cli` struct.**

In `abox/crates/abox-cli/src/main.rs` around line 24-33, change:

```rust
struct Cli {
    /// Path to the git repository.
    #[arg(long, global = true, default_value = ".")]
    repo: PathBuf,

    /// Path to the config file.
    #[arg(long, global = true)]
    config: Option<PathBuf>,

    #[command(subcommand)]
    command: Commands,
}
```

to:

```rust
struct Cli {
    /// Path to the git repository.
    #[arg(long, global = true, default_value = ".")]
    repo: PathBuf,

    /// Path to the config file.
    #[arg(long, global = true)]
    config: Option<PathBuf>,

    /// Print the capability envelope bakudo probes on dispatch and exit.
    /// Bypasses config and orchestrator load (spec Appendix A.1.1).
    #[arg(long)]
    capabilities: bool,

    #[command(subcommand)]
    command: Option<Commands>,
}
```

- [ ] **Step 2: Add the bypass branch before config load.**

Still in `main.rs`, locate the `init` bypass block (around lines 83–88 at HEAD):

```rust
    if let Commands::Init(ref args) = cli.command {
        return commands::init::execute(args);
    }
```

Insert BEFORE it (so `--capabilities` runs even earlier — before `init`'s config writes):

```rust
    // `--capabilities` must run before any config or orchestrator load so a
    // host with no abox config can still be probed by bakudo. See spec
    // Appendix A.1.1.
    if cli.capabilities {
        return commands::capabilities::execute();
    }
```

- [ ] **Step 3: Update every `if let Commands::…` early-return branch to handle the now-`Option` command.**

Because `command` is now `Option<Commands>`, every existing `if let Commands::Foo(…) = cli.command` pattern stops compiling. At HEAD (`abox/crates/abox-cli/src/main.rs:85-121`) there are **five** such branches: `Init`, `Doctor`, `Template`, `Ca`, `Tui`. Rewrite all of them, preserving their current order and bodies:

```rust
    if let Some(Commands::Init(ref args)) = cli.command {
        return commands::init::execute(args);
    }

    let config_path = cli.config.unwrap_or_else(|| AboxConfig::default_path().unwrap_or_default());
    let config = AboxConfig::load(&config_path)?;
    config.ensure_dirs()?;

    if let Some(Commands::Doctor) = cli.command {
        let ok = commands::doctor::execute(&config)?;
        return if ok { Ok(()) } else { std::process::exit(1) };
    }

    if let Some(Commands::Template(ref args)) = cli.command {
        if commands::template::execute_without_orchestrator(args, &config)? {
            return Ok(());
        }
    }

    if let Some(Commands::Ca(ref cmd)) = cli.command {
        return commands::ca::execute(cmd);
    }

    if let Some(Commands::Tui) = cli.command {
        let mut state = tui::dashboard::DashboardState::new();
        return tui::dashboard::run_dashboard(&mut state);
    }
```

Open `main.rs` and confirm the full list of early-return branches at HEAD before editing — if new ones appeared, adapt them in the same shape. Missing one will stop that command from routing.

- [ ] **Step 4: Update the main subcommand dispatch `match` to handle `None`.**

Further down in `main()` (HEAD: `abox/crates/abox-cli/src/main.rs:155`), the existing `match cli.command { … }` needs to account for the `Option`. Early-return with a user-facing error when no subcommand is given:

```rust
    let command = cli.command.ok_or_else(|| {
        anyhow::anyhow!("no subcommand provided (try `abox --help` for options)")
    })?;
    match command {
        Commands::Init(_) => unreachable!("handled above"),
        Commands::Doctor => unreachable!("handled above"),
        Commands::Template(args) => match &args.action {
            commands::template::TemplateAction::Create { name, from } => {
                commands::template::execute_create(name, from, &orchestrator, &config).await
            }
            _ => unreachable!("non-Create Template actions are handled above"),
        },
        Commands::Ca(_) => unreachable!("handled above"),
        Commands::Tui => unreachable!("handled above"),
        Commands::Run(args) => { /* existing body unchanged */ }
        Commands::List => { /* existing body unchanged */ }
        Commands::Attach(args) => { /* existing body unchanged */ }
        Commands::Stop(args) => { /* existing body unchanged */ }
        Commands::Divergence(args) => { /* existing body unchanged */ }
        Commands::Merge(args) => { /* existing body unchanged */ }
    }
```

Notes:
- `Commands::Template` can fall through the early branch (when `execute_without_orchestrator` returns `false`, indicating Create) — its `unreachable!()` is wrong. Instead, leave the `Template` arm in the match and re-call the full orchestrator path there, mirroring whatever HEAD does for Create. Double-check by reading the HEAD match arm for Template before editing.
- The `unreachable!()` arms for `Init` / `Doctor` / `Ca` / `Tui` are required because `Commands` is `#[non_exhaustive]`-style exhaustive — clippy will fail without full coverage.
- If clippy flags `unreachable!` as match-on-enum overkill, switch to `_ => unreachable!(...)`, but prefer named arms so the dispatch table stays grep-able.

- [ ] **Step 5: Build and re-run the tests.**

```bash
cd abox && cargo build -p abox-cli
cd abox && cargo test -p abox-cli --test capabilities_test
```

Expected: both tests PASS. If `capabilities_flag_bypasses_config_load` fails, the `--capabilities` branch is landing AFTER config load — re-check Step 2 placement.

- [ ] **Step 6: Run the full check.**

```bash
cd abox && just check
```

Expected: `fmt-check`, `clippy` (with `-D warnings`), and `cargo test` all pass.

- [ ] **Step 7: Commit.**

```bash
cd abox && git add crates/abox-cli/src/main.rs crates/abox-cli/src/commands/capabilities.rs crates/abox-cli/src/commands/mod.rs
git commit -m "feat(cli): add --capabilities top-level flag with config bypass

Implements F-00 from the 2026-04-18 Phase 0 spec. The flag prints the
three-array envelope (protocolVersions, taskKinds, executionEngines)
defined in Appendix A.1 and bypasses config/orchestrator load exactly
like 'init' and 'doctor'. No ghost fields in Phase 0; workerInRootfsVersion
arrives in Phase 2.

Refs: plans/integration/2026-04-18-phase-0-spec.md#F-00"
```

## Task 1.4 — Wave 1 gate

- [ ] **Step 1: Run `just check`.**

```bash
cd abox && just check
```

Expected: PASS.

- [ ] **Step 2: Manual smoke.**

```bash
cd abox && cargo build --release -p abox-cli
./target/release/abox --capabilities
./target/release/abox --config /does/not/exist --capabilities
```

Expected output (both invocations, single line):

```
{"protocolVersions":[1,3],"taskKinds":["assistant_job","explicit_command","verification_check"],"executionEngines":["agent_cli","shell"]}
```

If the user already has `~/.cargo/bin/abox` from a previous install (see memory: abox 0.2.0 is installed), re-install the freshly-built binary so subsequent bakudo tests pick it up:

```bash
cd abox && cargo install --path crates/abox-cli --locked --force
which abox && abox --capabilities
```

**End of Wave 1.**

---

# Wave 2 — bakudo: routing + spawn (F-01, F-04, F-14)

**Scope:** F-01 (`--version` / `-V` at top level), F-14 (misrouted-flag error copy), F-04 (PATH preservation). Repo: bakudo.

F-01 and F-14 touch the same files (`cli.ts`, `parsing.ts`). F-04 touches `envPolicy.ts` + `aboxAdapter.ts`. All three are small-diff and low-coupling; landing them as one wave keeps the branch log coherent and avoids a three-PR churn.

## Task 2.1 — F-01 regression test (failing first)

**Files:**
- Create: `bakudo/tests/regression/F-01-version-routing.test.ts`

- [ ] **Step 1: Write the failing test.**

Write `bakudo/tests/regression/F-01-version-routing.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { shouldUseHostCli } from "../../src/host/parsing.js";

test("F-01: shouldUseHostCli routes --version to host CLI", () => {
  assert.equal(shouldUseHostCli(["--version"]), true);
});

test("F-01: shouldUseHostCli routes -V to host CLI", () => {
  assert.equal(shouldUseHostCli(["-V"]), true);
});

test("F-01: shouldUseHostCli still routes --help to host CLI (regression guard)", () => {
  assert.equal(shouldUseHostCli(["--help"]), true);
  assert.equal(shouldUseHostCli(["-h"]), true);
});

test("F-01: shouldUseHostCli still sends unknown --flag to legacy parser", () => {
  // This is the F-14 sibling: unknown flags still route to legacy, where
  // the improved error copy takes over.
  assert.equal(shouldUseHostCli(["--foobar"]), false);
});
```

- [ ] **Step 2: Build + run, confirm it fails.**

```bash
cd bakudo && pnpm build && node --test dist/tests/regression/F-01-version-routing.test.js
```

Expected: first two tests FAIL (`shouldUseHostCli(["--version"])` returns `false` today, per the baseline table in the spec); the `--help` / `-h` test and `--foobar` test PASS.

## Task 2.2 — F-01 fix: accept `--version` / `-V` in `shouldUseHostCli`

**Files:**
- Modify: `bakudo/src/host/parsing.ts:546-563`

- [ ] **Step 1: Add the two tokens to the accepted first-arg set.**

Open `bakudo/src/host/parsing.ts`. Locate `shouldUseHostCli` (starts at line 546). Modify:

```typescript
export const shouldUseHostCli = (argv: string[]): boolean => {
  if (argv.length === 0) {
    return true;
  }

  const first = argv[0];
  return (
    first === undefined ||
    first === "--help" ||
    first === "-h" ||
    first === "--version" ||
    first === "-V" ||
    HOST_COMMANDS.has(first as HostCommand) ||
    (!first.startsWith("--") && !first.includes("=")) ||
    argv.includes("--session-id") ||
    argv.includes("--task-id") ||
    argv.includes("-p") ||
    argv.includes("--prompt") ||
    argv.some((arg) => arg.startsWith("--prompt="))
  );
};
```

- [ ] **Step 2: Re-run the F-01 test.**

```bash
cd bakudo && pnpm build && node --test dist/tests/regression/F-01-version-routing.test.js
```

Expected: all four assertions PASS.

## Task 2.3 — F-01 fix: top-level flag handler in `cli.ts`

**Files:**
- Modify: `bakudo/src/cli.ts`

When `shouldUseHostCli` routes `--version`/`-V` to the host CLI, the host CLI itself must recognize these flags and print the version. The existing `version` subcommand uses `printVersion({ useJson })` from `bakudo/src/host/commands/version.ts:16`. The cleanest wiring is to inject the flag recognition at the top-level router and delegate.

- [ ] **Step 1: Read the existing top-level routing.**

Open `bakudo/src/cli.ts` and read lines 1–100 to locate `runCli` / whatever calls `shouldUseHostCli`. Identify where the host CLI dispatch happens (inside `runHostCli` in `hostCli.ts`) vs where a top-level `--version`/`-V` should short-circuit.

- [ ] **Step 2: Short-circuit `--version` / `-V` before `runHostCli` dispatch.**

In `bakudo/src/cli.ts`, inside `runCli` (or equivalent — reader: confirm the function name when you open the file), add a short-circuit before the `runHostCli(argv)` call:

```typescript
import { printVersion } from "./host/commands/version.js";

// inside runCli, before the existing shouldUseHostCli dispatch:
if (argv[0] === "--version" || argv[0] === "-V") {
  const useJson =
    argv.includes("--output-format=json") ||
    argv.includes("--json");
  printVersion({ useJson });
  return 0;
}
```

Placement: put it **after** `shouldUseHostCli(argv)` returns `true`, but **before** `runHostCli(argv)` is called. That keeps the orchestrator path completely unaffected. If the existing structure is flat (check when you read), adjust accordingly but keep orchestrator logic untouched.

- [ ] **Step 3: Add an integration-style end-to-end assertion.**

Append to `bakudo/tests/regression/F-01-version-routing.test.ts`:

```typescript
import { runCli } from "../../src/cli.js";
import { withCapturedStdout } from "../../src/host/io.js";

// Local capture helper matching the pattern in tests/integration/doctor-command.test.ts.
// `withCapturedStdout(writer, fn)` takes a TextWriter and runs fn with stdout redirected
// into it; it returns fn's result directly.
const capture = (): { writer: { write: (chunk: string) => boolean }; chunks: string[] } => {
  const chunks: string[] = [];
  return {
    chunks,
    writer: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    },
  };
};

test("F-01: bakudo --version prints the version and exits 0", async () => {
  const { writer, chunks } = capture();
  const exit = await withCapturedStdout(writer, () => runCli(["--version"]));
  assert.equal(exit, 0);
  assert.match(chunks.join(""), /^bakudo \S+\n$/);
});

test("F-01: bakudo -V prints the version and exits 0", async () => {
  const { writer, chunks } = capture();
  const exit = await withCapturedStdout(writer, () => runCli(["-V"]));
  assert.equal(exit, 0);
  assert.match(chunks.join(""), /^bakudo \S+\n$/);
});

test("F-01: --version with --output-format=json prints an envelope", async () => {
  const { writer, chunks } = capture();
  const exit = await withCapturedStdout(writer, () =>
    runCli(["--version", "--output-format=json"]),
  );
  assert.equal(exit, 0);
  const parsed = JSON.parse(chunks.join(""));
  assert.equal(typeof parsed.version, "string");
});
```

`withCapturedStdout` signature at HEAD (`bakudo/src/host/io.ts:30`):
`withCapturedStdout<T>(writer: TextWriter, fn: () => Promise<T>): Promise<T>`.
It returns `fn`'s resolved value directly; captured output lives in the writer the caller supplies. The `capture()` helper above mirrors the one already in `tests/integration/doctor-command.test.ts` — reuse that pattern in every test that needs captured stdout in this plan.

- [ ] **Step 4: Run, commit.**

```bash
cd bakudo && mise run check
git add src/cli.ts src/host/parsing.ts tests/regression/F-01-version-routing.test.ts
git commit -m "fix(host): route --version and -V through shouldUseHostCli (F-01)"
```

## Task 2.4 — F-14 fix: misrouted-flag error copy

**Files:**
- Modify: `bakudo/src/cli.ts` (or wherever the misrouted-flag error is produced when `shouldUseHostCli` returns `false` and the legacy parser rejects an unknown flag)

- [ ] **Step 1: Write the failing regression test.**

Write `bakudo/tests/regression/F-14-misrouted-flag-error.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../../src/cli.js";
import { withCapturedStdout } from "../../src/host/io.js";

// The F-14 fix writes to stderr (per the Step 4 fix in Task 2.4 — `stderrWrite`).
// Capture both stdout and stderr by swapping process.stderr.write temporarily.
const captureStdoutAndStderr = async <T>(fn: () => Promise<T>): Promise<{ result: T | string; stdout: string; stderr: string }> => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const stdoutWriter = { write: (c: string) => { stdoutChunks.push(c); return true; } };
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: string | Uint8Array) => {
    stderrChunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    let result: T | string;
    try {
      result = await withCapturedStdout(stdoutWriter, fn);
    } catch (err) {
      result = err instanceof Error ? err.message : String(err);
    }
    return { result, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
  } finally {
    process.stderr.write = origStderrWrite;
  }
};

test("F-14: bakudo --foobar produces an error naming --foobar", async () => {
  const { stdout, stderr, result } = await captureStdoutAndStderr(() => runCli(["--foobar"]));
  const combined = `${stdout}\n${stderr}\n${typeof result === "string" ? result : ""}`;
  assert.match(combined, /--foobar/);
  assert.doesNotMatch(combined, /missing required argument --goal/);
});
```

Reasoning: F-14's fix emits `harness_error: unrecognized top-level flag: …` to **stderr** (via `stderrWrite` — Task 2.4 Step 4), which `withCapturedStdout` does NOT capture. The local `captureStdoutAndStderr` helper monkey-patches `process.stderr.write` so the test sees the error regardless of which stream the fix chose. If Task 2.4's fix lands on stdout instead (acceptable — the spec doesn't pin the stream), the test still passes via the stdout chunks.

- [ ] **Step 2: Build and confirm the test fails against HEAD.**

```bash
cd bakudo && pnpm build && node --test dist/tests/regression/F-14-misrouted-flag-error.test.js
```

Expected: `assert.doesNotMatch(combined, /missing required argument --goal/)` fails (the current error is `harness_error: missing required argument --goal`).

- [ ] **Step 3: Identify the error source.**

Trace `runCli` for the `shouldUseHostCli(argv) === false` path. The legacy parser (orchestrator path) produces the `missing required argument --goal` message. Find that code path (grep for "missing required argument"):

```bash
# run as a search, not a check:
```

Use the Grep tool with `missing required argument` across `bakudo/src/` to find the file. Typical location is a legacy parser module.

- [ ] **Step 4: Wrap the legacy parser entry with a "recognize unknown top-level flag" short-circuit.**

At the entry point to the legacy parser — ideally in `cli.ts` **before** the parser is called, after `shouldUseHostCli(argv) === false` — check: does `argv[0]` start with `--` AND is it not a known top-level flag? If so, emit:

```typescript
import { EXIT_CODES } from "./host/errors.js";
import { stderrWrite } from "./host/io.js";

// inside runCli, after shouldUseHostCli returned false:
const firstArg = argv[0];
if (firstArg !== undefined && firstArg.startsWith("--") && !KNOWN_ORCHESTRATOR_FLAGS.has(firstArg)) {
  stderrWrite(
    `harness_error: unrecognized top-level flag: ${firstArg} (run 'bakudo --help' for options)\n`,
  );
  return EXIT_CODES.FAILURE;
}
```

Define `KNOWN_ORCHESTRATOR_FLAGS` as a `Set<string>` populated from the legacy parser's own flag names (`--goal`, `--repo`, `--abox-bin`, etc.). If extracting that set is messy, an alternative is to catch the legacy parser's thrown error, inspect it, and if the error is `missing required argument --goal` when the user's input has an unrecognized `--foobar`-shape token, rewrite to the new message. The set-based approach is less fragile.

Confirm `stderrWrite` exists in `bakudo/src/host/io.ts` (it does — it's the sibling of `stdoutWrite` per the io patterns already in the codebase). If it does not exist under that exact name when you read the file, use the nearest equivalent.

- [ ] **Step 5: Re-run test, confirm it passes, and re-run F-01 tests to confirm no regression.**

```bash
cd bakudo && pnpm build && node --test dist/tests/regression/F-14-misrouted-flag-error.test.js dist/tests/regression/F-01-version-routing.test.js
```

Expected: both PASS. (`bakudo --version` still works because F-01's short-circuit runs before this new check.)

- [ ] **Step 6: Commit.**

```bash
cd bakudo && mise run check
git add src/cli.ts tests/regression/F-14-misrouted-flag-error.test.ts
git commit -m "fix(host): rewrite misrouted top-level flag error copy (F-14)"
```

## Task 2.5 — F-04 regression test (failing first)

**Files:**
- Create: `bakudo/tests/regression/F-04-path-preservation.test.ts`

- [ ] **Step 1: Write the failing test.**

Write `bakudo/tests/regression/F-04-path-preservation.test.ts`:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ABoxAdapter } from "../../src/aboxAdapter.js";

// F-04: when aboxBin is an unqualified name (no path separator), the host
// spawn must inject PATH from process.env so Node can resolve the binary.
// The guest VM gets its own env from rootfs init; this injection is
// host-side only.

test("F-04: runInStreamLive injects PATH when aboxBin is 'abox'", async () => {
  const calls: Array<{ bin: string; args: readonly string[]; opts: unknown }> = [];
  const fakeSpawn = ((bin: string, args: readonly string[], opts: unknown) => {
    calls.push({ bin, args: [...args], opts });
    // Return a minimal mock child so the adapter can wire event handlers.
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter();
    Object.assign(child, { stdout, stderr, kill: () => true });
    queueMicrotask(() => (child as any).emit("close", 0));
    return child;
  }) as unknown as ConstructorParameters<typeof ABoxAdapter>[3];

  const adapter = new ABoxAdapter(
    "abox",          // unqualified — this is the F-04 case
    undefined,
    undefined,
    fakeSpawn,
  );
  // Give the adapter an empty-allowlist env (the Phase 6 W5 default the
  // spec calls out). Expect PATH to be injected anyway.
  await adapter.runInStreamLive("stream-1", "echo hello", 5, {}, {});

  assert.equal(calls.length, 1, "spawn called exactly once");
  const spawnEnv = (calls[0]?.opts as { env?: Record<string, string> } | undefined)?.env;
  assert.ok(spawnEnv, "spawn was called with an env object");
  assert.equal(spawnEnv?.PATH, process.env.PATH, "PATH must be preserved for binary resolution");
});

test("F-04: runInStreamLive does NOT inject PATH when aboxBin is a full path", async () => {
  const calls: Array<{ opts: unknown }> = [];
  const fakeSpawn = ((_bin: string, _args: readonly string[], opts: unknown) => {
    calls.push({ opts });
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter();
    Object.assign(child, { stdout, stderr, kill: () => true });
    queueMicrotask(() => (child as any).emit("close", 0));
    return child;
  }) as unknown as ConstructorParameters<typeof ABoxAdapter>[3];

  const adapter = new ABoxAdapter(
    "/absolute/path/to/abox",
    undefined,
    undefined,
    fakeSpawn,
  );
  await adapter.runInStreamLive("stream-2", "echo hi", 5, {}, {});

  const spawnEnv = (calls[0]?.opts as { env?: Record<string, string> } | undefined)?.env;
  // With an absolute path, the env the user supplied stands unchanged.
  assert.equal(spawnEnv?.PATH, undefined, "PATH is not auto-injected when aboxBin is absolute");
});
```

- [ ] **Step 2: Build + run, confirm failure.**

```bash
cd bakudo && pnpm build && node --test dist/tests/regression/F-04-path-preservation.test.js
```

Expected: first test FAILS (no PATH in spawn env); second test PASSES (because `env: {}` is passed through unchanged today).

## Task 2.6 — F-04 fix: inject PATH when `aboxBin` is unqualified

**Files:**
- Modify: `bakudo/src/aboxAdapter.ts` (method `runInStreamLive`)
- Modify: `bakudo/src/host/envPolicy.ts` (module header comment)

- [ ] **Step 1: Add the PATH injection in `runInStreamLive`.**

Open `bakudo/src/aboxAdapter.ts`. In `runInStreamLive` (around line 87+ at HEAD), modify the `spawnOptions` build to inject PATH when `this.aboxBin` is an unqualified name:

```typescript
    const aboxBinIsUnqualified =
      !this.aboxBin.includes("/") && !this.aboxBin.includes("\\");
    const envWithPath =
      env === undefined
        ? undefined
        : aboxBinIsUnqualified
          ? { ...env, PATH: process.env.PATH ?? "" }
          : env;

    const spawnOptions: Parameters<SpawnFn>[2] = {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(envWithPath === undefined ? {} : { env: envWithPath }),
    };
    const child = this.spawnFn(this.aboxBin, cmd, spawnOptions);
```

Rationale:
- When `env === undefined`, the adapter preserves the legacy behavior (inherit parent env; PATH already there).
- When `env` is supplied (always the case via `ABoxTaskRunner`), and `aboxBin` has no path separator, PATH is merged in. The merge is a **superset** of the user's allowlist; the allowlist still wholly controls every other variable.
- When `aboxBin` is absolute (`/usr/local/bin/abox`) or project-relative (`../abox/target/release/abox`), no injection happens; the allowlist stands untouched.

- [ ] **Step 2: Document in `envPolicy.ts` module header.**

Open `bakudo/src/host/envPolicy.ts`. Prepend (or extend) the top-of-file comment block:

```typescript
// Env allowlist policy for worker dispatch (Phase 6 W5).
//
// HOST-SIDE PATH EXCEPTION (F-04 / Phase 0):
//   When the configured `aboxBin` is an unqualified name (e.g. "abox"),
//   `ABoxAdapter.runInStreamLive` injects `process.env.PATH` into the
//   spawn env UNCONDITIONALLY, regardless of this allowlist. The injection
//   is host-side only — it is required for Node's `child_process.spawn` to
//   resolve the binary. The guest VM receives its environment from abox's
//   rootfs init, not from this map; no host PATH reaches the guest.
//
//   Tests MUST assert PATH is NOT present in the `WorkerTaskSpec.env`
//   field emitted downstream (see F-04 regression).
```

- [ ] **Step 3: Add the "PATH not in WorkerTaskSpec env" guard test.**

Per spec risk §F-04: document that PATH should NOT be present in the `WorkerTaskSpec` env field. Add to `F-04-path-preservation.test.ts`:

```typescript
test("F-04: PATH injected into spawn env is NOT present in the WorkerTaskSpec env the adapter builds", async () => {
  // Boundary invariant: host-side spawn env (for Node's binary resolution)
  // and worker-side task env (packed for the guest) are separate fields.
  // The F-04 fix touches ONLY spawnOptions.env.
  //
  // Concrete assertion: the `env` arg passed to runInStreamLive is what
  // the ABoxTaskRunner feeds in as the filtered worker env. We passed
  // an empty object in the previous test; assert the adapter did NOT
  // mutate that input object to add PATH.
  const inputEnv: Record<string, string> = {};
  const fakeSpawn = ((_bin: string, _args: readonly string[], _opts: unknown) => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter();
    Object.assign(child, { stdout, stderr, kill: () => true });
    queueMicrotask(() => (child as any).emit("close", 0));
    return child;
  }) as unknown as ConstructorParameters<typeof ABoxAdapter>[3];

  const adapter = new ABoxAdapter("abox", undefined, undefined, fakeSpawn);
  await adapter.runInStreamLive("stream-boundary", "echo hi", 5, {}, inputEnv);

  // PATH must not have leaked back into the caller's map. The fix is
  // required to build a NEW object (`{ ...env, PATH: … }`), not mutate
  // the input in place.
  assert.equal(inputEnv.PATH, undefined, "adapter must not mutate caller's env to add PATH");
});
```

- [ ] **Step 4: Re-run tests, commit.**

```bash
cd bakudo && mise run check
git add src/aboxAdapter.ts src/host/envPolicy.ts tests/regression/F-04-path-preservation.test.ts
git commit -m "fix(host): preserve PATH for host spawn when aboxBin is unqualified (F-04)"
```

## Task 2.7 — Wave 2 gate

- [ ] **Step 1: `mise run check` passes.**

```bash
cd bakudo && mise run check
```

- [ ] **Step 2: Manual smoke.**

```bash
cd bakudo && pnpm build
node dist/src/cli.js --version            # → bakudo <version>
node dist/src/cli.js -V                   # → bakudo <version>
node dist/src/cli.js --foobar             # → harness_error: unrecognized top-level flag: --foobar (run 'bakudo --help' for options)
```

**End of Wave 2.**

---

# Wave 3 — bakudo: resume reads attemptSpec (F-03)

**Scope:** F-03 only. Repo: bakudo.

Bigger diff than Wave 2 and intersects Wave 2's routing only via the `resume` command entry (which doesn't change as part of F-03 — only what resume does internally changes). Keep this isolated.

## Task 3.1 — F-03 regression test (dispatch → fail → persist → resume → second attempt)

**Files:**
- Create: `bakudo/tests/regression/F-03-resume-attempt-spec.test.ts`

- [ ] **Step 1: Re-read `sessionLifecycle.ts:140-189` and `executeAttempt.ts:133-138` to confirm the schema mismatch is still present at HEAD.**

```bash
# Use Grep on `sessionStore.upsertAttempt` and `attempt.request` in bakudo/src/host/sessionLifecycle.ts
```

If `attempt.attemptSpec ?? attempt.request` is already present at HEAD, the fix is already in. Stop and update the spec's baseline table. Otherwise proceed.

- [ ] **Step 2: Write the failing regression test.**

Write `bakudo/tests/regression/F-03-resume-attempt-spec.test.ts`. The test constructs the minimum session state, injects a narrow `executeTaskFn` seam so no sandbox boots during the test, and asserts resume dispatches the retry with the correct ids:

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/sessionStore.js";
import { resumeSession } from "../../src/host/sessionLifecycle.js";
import type { HostCliArgs } from "../../src/host/parsing.js";
import type { WorkerTaskSpec } from "../../src/workerRuntime.js";
import type { AttemptSpec } from "../../src/attemptProtocol.js";

const buildAttemptSpec = (overrides: Partial<AttemptSpec> = {}): AttemptSpec => ({
  schemaVersion: 3,
  sessionId: "sess-1",
  turnId: "turn-1",
  attemptId: "attempt-1",
  taskId: "task-1",
  intentId: "intent-1",
  mode: "build",
  taskKind: "assistant_job",
  prompt: "echo hi",
  instructions: [],
  cwd: "/tmp/scratch",
  execution: { engine: "agent_cli" },
  permissions: { rules: [], allowAllTools: false, noAskUser: false },
  budget: { timeoutSeconds: 60, maxOutputBytes: 1024, heartbeatIntervalMs: 5000 },
  acceptanceChecks: [],
  artifactRequests: [],
  ...overrides,
});

const buildTurn = (turnId: string, prompt: string) => ({
  turnId,
  prompt,
  mode: "build",
  status: "failed" as const,
  attempts: [],
  createdAt: "2026-04-18T00:00:00.000Z",
  updatedAt: "2026-04-18T00:00:00.000Z",
});

const baseArgs = (storageRoot: string, sessionId: string, taskId: string): HostCliArgs =>
  ({
    command: "resume",
    config: "config/default.json",
    aboxBin: "abox",
    repo: process.cwd(),
    sessionId,
    taskId,
    mode: "build",
    yes: true, // avoid the interactive resume prompt during the regression test
    shell: "bash",
    timeoutSeconds: 60,
    maxOutputBytes: 1024,
    heartbeatIntervalMs: 5000,
    killGraceMs: 2000,
    storageRoot,
    copilot: {},
  }) as HostCliArgs;

test("F-03: resumeSession reads attemptSpec when request is undefined", async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "bakudo-f-03-"));
  try {
    const store = new SessionStore(tmpRoot);
    const spec = buildAttemptSpec();
    await store.createSession({
      sessionId: spec.sessionId,
      goal: spec.prompt,
      repoRoot: tmpRoot,
      status: "failed",
      turns: [buildTurn(spec.turnId, spec.prompt)],
    });
    await store.upsertAttempt(spec.sessionId, spec.turnId, {
      attemptId: spec.attemptId,
      status: "failed",
      lastMessage: "retryable failure",
      attemptSpec: spec,
      result: {
        schemaVersion: 3,
        taskId: spec.taskId,
        sessionId: spec.sessionId,
        status: "failed",
        summary: "boot timeout",
        finishedAt: "2026-04-18T00:00:01.000Z",
        exitCode: 1,
        command: "echo hi",
        cwd: spec.cwd,
        shell: "bash",
        timeoutSeconds: 60,
        durationMs: 1000,
        exitSignal: null,
        stdout: "",
        stderr: "boot timeout",
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        assumeDangerousSkipPermissions: false,
      },
    });

    const captured: Array<{ request: WorkerTaskSpec; turnId: string }> = [];
    const exit = await resumeSession(baseArgs(tmpRoot, spec.sessionId, spec.taskId), {
      executeTaskFn: async (ctx) => {
        captured.push({ request: ctx.request, turnId: ctx.turnId });
        return {
          outcome: "success",
          action: "accept",
          reason: "ok",
          retryable: false,
          needsUser: false,
          confidence: "high",
        } as any;
      },
    });

    assert.equal(exit, 0);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.turnId, "turn-1");
    assert.notEqual(captured[0]?.request.taskId, spec.taskId, "taskId must be incremented");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("F-03: resumeSession still works for v1 sessions (attempt.request present, attemptSpec absent)", async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "bakudo-f-03-v1-"));
  try {
    const store = new SessionStore(tmpRoot);
    const legacyRequest: WorkerTaskSpec = {
      schemaVersion: 3,
      taskId: "task-1",
      sessionId: "sess-2",
      goal: "echo hi",
      mode: "build",
      cwd: "/tmp/scratch",
      assumeDangerousSkipPermissions: false,
      timeoutSeconds: 60,
      maxOutputBytes: 1024,
      heartbeatIntervalMs: 5000,
    } as WorkerTaskSpec;

    await store.createSession({
      sessionId: "sess-2",
      goal: "echo hi",
      repoRoot: tmpRoot,
      status: "failed",
      turns: [buildTurn("turn-1", "echo hi")],
    });
    await store.upsertAttempt("sess-2", "turn-1", {
      attemptId: "attempt-1",
      status: "failed",
      request: legacyRequest,
      result: {
        schemaVersion: 3,
        taskId: legacyRequest.taskId,
        sessionId: legacyRequest.sessionId,
        status: "failed",
        summary: "boot timeout",
        finishedAt: "2026-04-18T00:00:01.000Z",
        exitCode: 1,
        command: "echo hi",
        cwd: legacyRequest.cwd,
        shell: "bash",
        timeoutSeconds: 60,
        durationMs: 1000,
        exitSignal: null,
        stdout: "",
        stderr: "boot timeout",
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        assumeDangerousSkipPermissions: false,
      },
    });

    const captured: Array<{ request: WorkerTaskSpec }> = [];
    const exit = await resumeSession(baseArgs(tmpRoot, "sess-2", "task-1"), {
      executeTaskFn: async (ctx) => {
        captured.push({ request: ctx.request });
        return {
          outcome: "success",
          action: "accept",
          reason: "ok",
          retryable: false,
          needsUser: false,
          confidence: "high",
        } as any;
      },
    });

    assert.equal(exit, 0);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.request.goal, "echo hi");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});
```

Reality check before you run it:
- This file is written against the exact HEAD APIs: `SessionStore` lives in `src/sessionStore.ts` and uses `createSession` / `upsertAttempt`; `resumeSession` does **not** yet accept the `executeTaskFn` seam, so the file will compile only after Task 3.2 Step 1 lands that narrow signature widening.
- The spec's acceptance requires `turnId === "turn-1"` and an incremented retry id. The test pins those directly on the captured `executeTask` context.

- [ ] **Step 3: Build + run; confirm the tests are registered and currently fail.**

```bash
cd bakudo && pnpm build && node --test dist/tests/regression/F-03-resume-attempt-spec.test.js
```

Expected sequence:
- Before Task 3.2 Step 1, the file fails to compile because `resumeSession` lacks the narrow `executeTaskFn` dependency seam.
- After Task 3.2 Step 1 but before the request-selection fix, the first test fails with `no resumable attempt found for session …` because HEAD still checks `attempt.request`; the v1 branch remains green or becomes green once the seam exists.

## Task 3.2 — F-03 fix: resume reads `attempt.attemptSpec ?? attempt.request`

**Files:**
- Modify: `bakudo/src/host/sessionLifecycle.ts:140-189`

- [ ] **Step 1: Add a narrow `executeTask` injection seam to `resumeSession` so Task 3.1 can run without booting abox.**

At the top of `sessionLifecycle.ts`, define:

```typescript
export type ResumeSessionDeps = {
  executeTaskFn?: typeof executeTask;
};
```

Then widen the signature:

```typescript
export const resumeSession = async (
  args: HostCliArgs,
  deps: ResumeSessionDeps = {},
): Promise<number> => {
  const executeTaskFn = deps.executeTaskFn ?? executeTask;
  // ... existing body ...
}
```

Later in the function, replace the direct `executeTask({...})` call with `executeTaskFn({...})`. Nothing else in the call-site shape changes.

- [ ] **Step 2: Update the guard and retry construction.**

Locate `resumeSession` (starts near line 140). Change the guard:

```typescript
  const attempt = latestAttempt(turn, args.taskId);
  if (attempt === undefined) {
    throw new Error(`no resumable attempt found for session ${session.sessionId}`);
  }
  const hasAttemptSpec = attempt.attemptSpec !== undefined;
  const hasRequest = attempt.request !== undefined;
  if (!hasAttemptSpec && !hasRequest) {
    throw new Error(
      `no resumable attempt found for session ${session.sessionId} (neither attemptSpec nor request is set)`,
    );
  }
```

Then, where the retry spec is built (around line 183), branch on which field is set:

```typescript
import { attemptSpecToWorkerSpec } from "../aboxTaskRunner.js";
// ... inside resumeSession:

const baseRequest: WorkerTaskSpec = hasAttemptSpec
  ? attemptSpecToWorkerSpec(attempt.attemptSpec!)
  : attempt.request!;

const request: WorkerTaskSpec = {
  ...baseRequest,
  taskId: retryId,
  timeoutSeconds: args.timeoutSeconds,
  maxOutputBytes: args.maxOutputBytes,
  heartbeatIntervalMs: args.heartbeatIntervalMs,
};
```

Notes:
- `attemptSpecToWorkerSpec` already exists at `bakudo/src/aboxTaskRunner.ts:220` — use it unchanged. No new helper required.
- The v1 branch (`attempt.request` set, `attempt.attemptSpec` unset) preserves legacy compatibility per spec §F-03 "Legacy session compatibility."
- The preserved success / blocked / policy_denied short-circuits (lines 150–157) are untouched.

- [ ] **Step 3: Verify the Task 3.1 fixtures compile against the real signatures.**

Task 3.1's fixtures reference `SessionStore`, `resumeSession`, and the injected `executeTaskFn` seam. Confirm:

- The concrete fixture names now match HEAD: `SessionStore.createSession`, `SessionStore.upsertAttempt`, and `resumeSession(args, { executeTaskFn })`.
- The `result` payload in the test is a real `TaskResult`-shaped failure record, so `reviewTaskResult` still classifies it as retryable rather than short-circuiting to success.

- [ ] **Step 4: Run, fix any missing imports or signature drift, commit.**

```bash
cd bakudo && mise run check
git add src/host/sessionLifecycle.ts tests/regression/F-03-resume-attempt-spec.test.ts
git commit -m "fix(host): resume reads attemptSpec then falls back to request (F-03)"
```

## Task 3.3 — Wave 3 gate

- [ ] **Step 1: `mise run check` passes.**
- [ ] **Step 2: Manual smoke on a freshly dispatched retryable failure.**

This requires a host with a booting abox sandbox. Construct a build that will retry (e.g., goal that produces a retryable error — see existing fixtures or use a policy that denies writes). Then:

```bash
bakudo build "<known-retryable goal>"   # fails
bakudo sessions                          # capture the session id
bakudo resume <session-id>              # MUST dispatch a second attempt; no "no resumable attempt" error
```

If no retryable-failure fixture exists, skip this smoke and rely on the regression test alone.

**End of Wave 3.**

---

# Wave 4 — bakudo: commands (F-05, F-06, F-07, F-15)

**Scope:** F-05, F-06, F-07, F-15. Repo: bakudo.

Four independent command-level fixes. Order them as F-05 (largest, touches errors.ts + oneShotRun + approvalProducer + executeAttempt + a tiny `sessionController` export), then F-06 (explainConfig), then F-07 (inspectFormatter), then F-15 (cleanup). Each is its own commit.

## Task 4.1 — F-05: add `approval_required` to `BakudoErrorCode`

**Files:**
- Modify: `bakudo/src/host/errors.ts:41-50`

- [ ] **Step 1: Add the string.**

Open `bakudo/src/host/errors.ts`. Modify the `BakudoErrorCode` union:

```typescript
export type BakudoErrorCode =
  | "user_input"
  | "policy_denied"
  | "approval_denied"
  | "approval_required"
  | "worker_protocol_mismatch"
  | "worker_execution"
  | "session_corruption"
  | "session_lock"
  | "artifact_persistence"
  | "recovery_required";
```

- [ ] **Step 2: If a registry, helper, or recovery-hint map keys off this union, add the entry there.**

Grep for `BakudoErrorCode` across `bakudo/src/` — any switch, record literal, or object keyed by the union must now include `approval_required`. Add a recovery-hint entry such as:

```typescript
approval_required: "re-run with --allow-all-tools or --yes to grant authority non-interactively",
```

(The exact map and placement depends on what HEAD has. If there is no registry, skip this step — the addition to the union is enough.)

## Task 4.2 — F-05 regression test (failing first)

**Files:**
- Create: `bakudo/tests/regression/F-05-json-approval.test.ts`

- [ ] **Step 1: Write the failing test.**

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostCliArgs } from "../../src/host/parsing.js";
import { resolveAutoApprove } from "../../src/host/sessionController.js";
import { runNonInteractiveOneShot } from "../../src/host/oneShotRun.js";
import { withCapturedStdout } from "../../src/host/io.js";
import { EXIT_CODES } from "../../src/host/errors.js";

const capture = (): { writer: { write: (chunk: string) => boolean }; chunks: string[] } => {
  const chunks: string[] = [];
  return {
    chunks,
    writer: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    },
  };
};

const baseArgs = (storageRoot: string): HostCliArgs =>
  ({
    command: "run",
    config: "config/default.json",
    aboxBin: "abox",
    repo: process.cwd(),
    mode: "build",
    yes: false,
    shell: "bash",
    timeoutSeconds: 120,
    maxOutputBytes: 256 * 1024,
    heartbeatIntervalMs: 5000,
    killGraceMs: 2000,
    storageRoot,
    copilot: {
      prompt: "hello",
      outputFormat: "json",
      allowAllTools: false,
    },
  }) as HostCliArgs;

test("F-05: --output-format=json alone does not imply autoApprove", async () => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-f-05-aa-"));
  try {
    assert.equal(resolveAutoApprove(baseArgs(root)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("F-05: -p --output-format=json emits one approval_required JSONL and exits BLOCKED", async () => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-f-05-json-"));
  try {
    const { writer, chunks } = capture();
    const exit = await withCapturedStdout(writer, () => runNonInteractiveOneShot(baseArgs(root)));
    assert.equal(exit, EXIT_CODES.BLOCKED);
    const lines = chunks.join("").split("\n").filter(Boolean);
    assert.ok(lines.length >= 1, "expected at least one JSONL line");
    for (const line of lines) {
      assert.ok(line.startsWith("{"), `non-JSONL line: ${line}`);
    }
    const approvals = lines
      .map((line) => JSON.parse(line))
      .filter((entry) => entry?.error?.code === "approval_required");
    assert.equal(approvals.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

These are the final test bodies, not scaffolds. The only pre-fix compile blocker is that `resolveAutoApprove` is not exported at HEAD yet; Task 4.3 Step 3 adds that named export.

- [ ] **Step 2: Build + run; confirm both tests fail.**

```bash
cd bakudo && pnpm build && node --test dist/tests/regression/F-05-json-approval.test.js
```

Expected sequence:
- Before Task 4.3 Step 3, the file fails to compile because `resolveAutoApprove` is not exported yet.
- After Task 4.3 Step 3 but before the JSON guard lands, the first test passes and the second fails (no `approval_required` emitted, or the prompt writes plaintext to stdout).

## Task 4.3 — F-05 fix: never prompt in JSON output mode

**Files:**
- Modify: `bakudo/src/host/oneShotRun.ts:60-68`
- Modify: `bakudo/src/host/approvalProducer.ts` — function `resolveApprovalBeforeDispatch` (line ~95) is the real dispatch-time approval seam.
- Modify: `bakudo/src/host/executeAttempt.ts` — line ~146 calls `runApprovalIfNeeded({ ctx, writer, composerMode })`. The JSON-mode guard lives wherever `composerMode` / `ctx` carries the output format.

**Correction vs earlier draft:** the earlier draft pointed at `sessionController.ts:218-232`, but at HEAD that file only exports `resolveAutoApprove` / `taskModeToComposerMode`. The interactive prompt path actually lives in `approvalProducer.ts:resolveApprovalBeforeDispatch`, invoked from `executeAttempt.ts` via `runApprovalIfNeeded`. Confirm when you open the files — the seam you patch must be on the code path that a `bakudo -p "…" --output-format=json` invocation actually traverses.

- [ ] **Step 1: Guard the top-level approval prompt in `oneShotRun.ts`.**

Open `bakudo/src/host/oneShotRun.ts`. The current prompt lives at lines 60–68. Modify:

```typescript
export const runNonInteractiveOneShot = async (args: HostCliArgs): Promise<number> => {
  const useJson = args.copilot.outputFormat === "json";

  if (requiresSandboxApproval(args) && !args.yes && args.copilot.allowAllTools !== true) {
    if (useJson) {
      const taskId = args.taskId ?? "pending";
      const event = {
        ok: false,
        kind: "error",
        error: {
          code: "approval_required",
          message: "Approval is required but stdin is --output-format=json",
          details: { taskId, mode: args.mode },
        },
      };
      stdoutWrite(`${JSON.stringify(event)}\n`);
      return EXIT_CODES.BLOCKED;
    }
    const approved = await promptForApproval(
      `Dispatch a ${args.mode} task into an ephemeral abox sandbox with dangerous-skip-permissions?`,
    );
    if (!approved) {
      stdoutWrite("Dispatch cancelled.\n");
      return EXIT_CODES.BLOCKED;
    }
  }

  // ... unchanged
};
```

The exact path for `outputFormat` on the args type is `args.copilot.outputFormat` at HEAD (per `copilotFlagParser.ts:74-82`). Confirm when you open the file.

- [ ] **Step 2: Guard the dispatch-time approval path in `approvalProducer.ts` + `executeAttempt.ts`.**

`oneShotRun.ts`'s top-level prompt only fires when `requiresSandboxApproval(args)` is true (see HEAD: `oneShotRun.ts:61`). For dispatches that flow through `executeAttempt.ts`, the real prompt happens inside `runApprovalIfNeeded` → `resolveApprovalBeforeDispatch` (`approvalProducer.ts:95`). That function writes to stdout and reads from stdin when a non-autopilot composer mode would ask the user.

Plumb the `outputFormat` into that function (either via `ctx` or as an explicit argument) so it can short-circuit:

```typescript
// approvalProducer.ts — at the top of resolveApprovalBeforeDispatch:
if (ctx.outputFormat === "json") {
  const taskId = ctx.spec.taskId;
  const event = {
    ok: false,
    kind: "error",
    error: {
      code: "approval_required",
      message: "Approval is required but stdin is --output-format=json",
      details: { taskId, mode: ctx.spec.mode },
    },
  };
  stdoutWrite(`${JSON.stringify(event)}\n`);
  return { status: "blocked", rationale: "approval_required" };
}
```

Do NOT double-emit the event. If `oneShotRun.ts`'s Step 1 guard already emitted for this invocation (one-shot path), the executeAttempt flow won't be reached — one-shot returns before dispatch. If a future refactor makes both paths reachable in the same invocation, gate with a single boolean on `ctx` (`approvalEmitted: boolean`).

`ctx.outputFormat` must be threaded from `HostCliArgs.copilot.outputFormat` through whatever context object `executeAttempt` builds for its approval call. If the ctx shape doesn't currently carry output format, widen the type — narrowly — rather than reading from module-global state.

- [ ] **Step 3: Export `resolveAutoApprove` and keep its logic unchanged.**

Re-read `sessionController.ts:230`:

```typescript
const resolveAutoApprove = (args: HostCliArgs): boolean =>
  (args.yes ?? false) || args.copilot.allowAllTools === true;
```

This already correctly excludes `outputFormat`. Change only the declaration to a named export:

```typescript
export const resolveAutoApprove = (args: HostCliArgs): boolean =>
  (args.yes ?? false) || args.copilot.allowAllTools === true;
```

Do NOT change the boolean expression — the F-05 fix lives in `oneShotRun.ts` + `approvalProducer.ts`, not here. The Task 4.2 Step-1 test pins this invariant.

- [ ] **Step 4: Re-run the Task 4.2 tests after the export + JSON guard land.**

No more scaffolds here. The only update after Step 3 is the import becoming valid once `resolveAutoApprove` is exported. Re-run the file and confirm:

```typescript
cd bakudo && pnpm build && node --test dist/tests/regression/F-05-json-approval.test.js
```

Expected: the `resolveAutoApprove` test stays green before and after the fix; the JSONL test flips from FAIL to PASS once Step 1 and Step 2 land.

- [ ] **Step 5: Run; commit.**

```bash
cd bakudo && mise run check
git add src/host/oneShotRun.ts src/host/approvalProducer.ts src/host/executeAttempt.ts src/host/sessionController.ts src/host/errors.ts tests/regression/F-05-json-approval.test.ts
git commit -m "fix(host): emit approval_required on --output-format=json without autoApprove (F-05)"
```

## Task 4.4 — F-06: explain-config rejects unknown keys

**Files:**
- Modify: `bakudo/src/host/explainConfig.ts`
- Create: `bakudo/tests/regression/F-06-unknown-config-key.test.ts`

- [ ] **Step 1: Write the failing regression test.**

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { runExplainConfig } from "../../src/host/explainConfig.js";
import { withCapturedStdout } from "../../src/host/io.js";
import { EXIT_CODES } from "../../src/host/errors.js";

const capture = (): { writer: { write: (chunk: string) => boolean }; chunks: string[] } => {
  const chunks: string[] = [];
  return {
    chunks,
    writer: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    },
  };
};

test("F-06: explain-config with an unknown key exits 1 with harness_error", async () => {
  const { writer, chunks } = capture();
  const exit = await withCapturedStdout(writer, async () => {
    try {
      await runExplainConfig({ repoRoot: process.cwd(), key: "nonsense.bogus", useJson: false });
      return 0;
    } catch (err) {
      if (err && typeof err === "object" && "exitCode" in err) {
        return (err as { exitCode: number }).exitCode;
      }
      throw err;
    }
  });
  assert.equal(exit, EXIT_CODES.FAILURE);
  assert.match(chunks.join(""), /harness_error: unknown config key: nonsense\.bogus/);
});

test("F-06: explain-config with a valid-but-unset key still works", async () => {
  const { writer, chunks } = capture();
  const exit = await withCapturedStdout(writer, async () => {
    await runExplainConfig({ repoRoot: process.cwd(), key: "mode", useJson: false });
    return 0;
  });
  assert.equal(exit, 0);
  // Matches existing "effective value: \"standard\"" — adjust if the actual
  // default has shifted.
  assert.match(chunks.join(""), /mode/);
});
```

- [ ] **Step 2: Locate the config schema / known-key source.**

Grep bakudo for a config schema definition (likely `configSchema.ts` or similar under `src/host/`). The known-keys set needs to come from the same schema the config loader validates against, not a hand-maintained list that will drift.

- [ ] **Step 3: Derive the known-key set from the existing zod schema in `config.ts:45`.**

bakudo has `BakudoConfigSchema` (zod) at `bakudo/src/host/config.ts:45`. Walk the schema shape to produce a flat dotted-key set:

```typescript
// In explainConfig.ts (or a small helper next to it):
import { BakudoConfigSchema } from "./config.js";
import type { ZodTypeAny } from "zod";

const flattenZodKeys = (schema: ZodTypeAny, prefix = ""): string[] => {
  const out: string[] = [];
  // zod schemas with .shape are ZodObject. Narrow and walk.
  const shape = (schema as any)?.shape ?? (schema as any)?._def?.schema?.shape;
  if (shape && typeof shape === "object") {
    for (const [k, v] of Object.entries(shape)) {
      const dotted = prefix === "" ? k : `${prefix}.${k}`;
      out.push(dotted);
      out.push(...flattenZodKeys(v as ZodTypeAny, dotted));
    }
  }
  return out;
};

const KNOWN_CONFIG_KEYS = new Set(flattenZodKeys(BakudoConfigSchema));
```

Caveats:
- `BakudoConfigSchema` is wrapped in `z.preprocess(...)` at HEAD (`config.ts:45`). The `.shape` access may need to dig through the preprocess wrapper — hence the `_def.schema?.shape` fallback. Read the HEAD definition and adjust if the wrapping changes.
- Some keys are valid nested paths (e.g., `output.format` — a leaf inside a nested object). The walk emits both the parent (`output`) and the leaf (`output.format`). That matches the user's intuition that `bakudo doctor --explain-config output` is valid and returns "unset".
- If walking zod at runtime feels brittle, a minimal hand-maintained allow-list works too — but then it WILL drift. Prefer the walk.

Then in `runExplainConfig`:

```typescript
export const runExplainConfig = async (input: {
  repoRoot: string;
  key: string;
  useJson: boolean;
}): Promise<ExplainConfigReport> => {
  if (!KNOWN_CONFIG_KEYS.has(input.key)) {
    stdoutWrite(`harness_error: unknown config key: ${input.key}\n`);
    throw Object.assign(new Error(`unknown config key: ${input.key}`), {
      exitCode: EXIT_CODES.FAILURE,
    });
  }
  // ... existing lookup logic unchanged
};
```

- [ ] **Step 4: Ensure the caller maps the thrown error to exit code 1.**

The `runDoctorCommand` caller (at `doctor.ts:290`) already returns a number. If it does not currently catch the thrown error, wrap the `runExplainConfig` call:

```typescript
try {
  await runExplainConfig({ repoRoot, key: explainKey, useJson });
  return 0;
} catch (err) {
  if (err && typeof err === "object" && "exitCode" in err) {
    return (err as { exitCode: number }).exitCode;
  }
  throw err;
}
```

- [ ] **Step 5: Run, commit.**

```bash
cd bakudo && mise run check
git add src/host/explainConfig.ts src/host/commands/doctor.ts tests/regression/F-06-unknown-config-key.test.ts
git commit -m "fix(host): explain-config rejects unknown keys (F-06)"
```

## Task 4.5 — F-07: sandbox dump truncation

**Files:**
- Modify: `bakudo/src/host/inspectFormatter.ts` (function `formatInspectSandbox` at line 278+)
- Create: `bakudo/tests/regression/F-07-sandbox-truncation.test.ts`

Note: the spec says F-07 lives in `src/host/printers.ts`, but grep confirms the actual function is `formatInspectSandbox` in `inspectFormatter.ts`. The `sandbox` command is the legacy alias for `inspect … sandbox`; the shared formatter handles both.

- [ ] **Step 1: Write the failing test.**

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import {
  formatInspectSandbox,
  type InspectSandboxInput,
} from "../../src/host/inspectFormatter.js";

test("F-07: formatInspectSandbox truncates massive dispatch bodies", () => {
  const bigCommand = ["bash", "-lc", "echo $(printf 'line\\n%.0s' {1..591})"];
  const input: InspectSandboxInput = {
    session: {
      sessionId: "sess-1",
      // fill minimum required fields — check SessionRecord type for actual shape
    } as InspectSandboxInput["session"],
    attempt: {
      attemptId: "attempt-1",
      status: "failed",
      request: { assumeDangerousSkipPermissions: true } as InspectSandboxInput["attempt"]["request"],
      metadata: {
        sandboxTaskId: "bakudo-1-sess-abc",
        dispatchCommand: bigCommand,
      },
    } as InspectSandboxInput["attempt"],
    artifacts: [
      { kind: "dispatch", path: "/var/bakudo/sessions/sess-1/artifacts/dispatch.json", bytes: 12345 } as any,
    ],
  };
  const lines = formatInspectSandbox(input);
  assert.ok(lines.length <= 20, `expected <=20 lines, got ${lines.length}`);
  const joined = lines.join("\n");
  assert.doesNotMatch(joined, /line\nline\nline/, "dispatch body must not be dumped verbatim");
  assert.match(joined, /dispatch\.json/, "dispatch artifact path must still be surfaced");
});
```

- [ ] **Step 2: Build, confirm failure.**

Expected: the current `aboxCommand` build at line 284-285 joins the whole command; for a multi-line bash heredoc this balloons to hundreds of lines.

- [ ] **Step 3: Apply the fix.**

In `inspectFormatter.ts` around lines 278–300, replace the `aboxCommand` + `ABox` line construction:

```typescript
export const formatInspectSandbox = (input: InspectSandboxInput): string[] => {
  const { session, attempt, artifacts } = input;
  const dispatchCommand = dispatchCommandOf(attempt);

  // F-07: the abox invocation line stays verbatim (small); the bash -lc
  // payload is truncated to its size. The full dispatch is already
  // accessible via the dispatch artifact path printed in the Artifacts
  // section below.
  const aboxLines: string[] = [];
  if (dispatchCommand === undefined) {
    aboxLines.push(renderKv("ABox", "n/a"));
  } else {
    const bashLcIdx = dispatchCommand.findIndex((arg) => arg === "-lc" || arg === "-c");
    const payloadIdx = bashLcIdx >= 0 ? bashLcIdx + 1 : -1;
    if (payloadIdx > 0 && payloadIdx < dispatchCommand.length) {
      const payload = dispatchCommand[payloadIdx] ?? "";
      const lineCount = payload === "" ? 0 : payload.split("\n").length;
      const byteCount = Buffer.byteLength(payload, "utf8");
      const prefix = dispatchCommand
        .slice(0, payloadIdx)
        .map((arg) => safe(arg))
        .join(" ");
      const dispatchArtifact = artifacts.find((a) => a.kind === "dispatch");
      const hint = dispatchArtifact ? ` — see ${safe(dispatchArtifact.path)}` : "";
      aboxLines.push(renderKv("ABox", prefix));
      aboxLines.push(`       <${lineCount} lines, ${byteCount} bytes${hint}>`);
    } else {
      const joined = dispatchCommand.map((arg) => safe(arg)).join(" ");
      aboxLines.push(renderKv("ABox", joined));
    }
  }

  const lines = [
    "Sandbox",
    renderKv("Session", session.sessionId),
    renderKv("Task", attempt.attemptId),
    renderKv("Mode", modeOf(attempt)),
    renderKv("Status", attempt.status),
    renderKv("Sandbox", sandboxOf(attempt)),
    ...aboxLines,
    renderKv(
      "Safety",
      attempt.request?.assumeDangerousSkipPermissions
        ? "dangerous-skip-permissions enabled in sandbox worker"
        : "host requested safer planning mode",
    ),
  ];
  // ... rest unchanged
};
```

- [ ] **Step 4: Run, commit.**

```bash
cd bakudo && mise run check
git add src/host/inspectFormatter.ts tests/regression/F-07-sandbox-truncation.test.ts
git commit -m "fix(host): truncate ABox dispatch dump in sandbox view (F-07)"
```

## Task 4.6 — F-15: cleanup dry-run shows kept artifacts

**Files:**
- Modify: `bakudo/src/host/commands/cleanup.ts`
- Modify: `bakudo/src/host/commands/cleanupSupport.ts` (HEAD split: report shape + formatter live here)
- Create: `bakudo/tests/regression/F-15-cleanup-kept-artifacts.test.ts`

- [ ] **Step 1: Read the existing cleanup structure.**

Open `bakudo/src/host/commands/cleanup.ts` in full. Locate the `--dry-run` branch and the per-artifact iteration. Identify the "skip" reasons: protected-kind, session-root, under-retention, etc. These feed the "Would keep" output.

- [ ] **Step 2: Write the failing test.**

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatCleanupReport,
  runCleanup,
} from "../../src/host/commands/cleanup.js";

// Reuse the exact fixture shape from tests/unit/cleanup.test.ts:
// copy `createTempRoot()` and `buildFixture()` from that file into this
// regression test unchanged. That helper already produces:
//   - one removable superseded log
//   - one kept protected result.json
// and writes the on-disk artifacts + artifacts.ndjson records.
const createTempRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-f-15-"));

test("F-15: cleanup --dry-run emits both removed and kept sections", async () => {
  const root = await createTempRoot();
  try {
    await buildFixture(root);
    const report = await runCleanup(root, { dryRun: true });
    const lines = formatCleanupReport(report);

    assert.ok(lines.includes("Would remove:"));
    assert.ok(lines.includes("Would keep:"));
    assert.ok(lines.some((line) => /\[protected_kind\].*result\.json/.test(line)));
    assert.equal(report.totalArtifacts, report.eligible.length + report.kept.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Fix the dry-run path.**

HEAD split matters here: `cleanup.ts` produces the report, `cleanupSupport.ts` renders it. Implement both halves.

1. In `cleanup.ts`, collect a `kept: CleanupReportEntry[]` list alongside `eligible` / `removed`.
2. When you skip an item because it is protected or under retention, push a kept entry with a concrete reason tag (`protected_kind`, `session_root`, `under_retention`) and the measured byte size.
3. Add `kept` and `totalArtifacts` to `CleanupReport` in `cleanupSupport.ts`, and set `totalArtifacts = eligible.length + kept.length`.
4. Update `formatCleanupReport(report)` to render both sections in dry-run mode:

```typescript
lines.push("Would remove:");
for (const entry of report.eligible) {
  lines.push(`  [${entry.reason}] ${entry.path} (${formatBytes(entry.bytes)})`);
}
if (report.kept.length > 0) {
  lines.push("Would keep:");
  for (const entry of report.kept) {
    lines.push(`  [${entry.reason}] ${entry.path} (${formatBytes(entry.bytes)})`);
  }
}
```

Use the existing `tests/unit/cleanup.test.ts` fixture as the oracle: the protected `result.json` should show up in the kept section, while the superseded log remains in the remove section.

- [ ] **Step 4: Run, commit.**

```bash
cd bakudo && mise run check
git add src/host/commands/cleanup.ts src/host/commands/cleanupSupport.ts tests/regression/F-15-cleanup-kept-artifacts.test.ts
git commit -m "fix(host): cleanup --dry-run surfaces kept artifacts with reason (F-15)"
```

## Task 4.7 — Wave 4 gate

- [ ] **Step 1: `mise run check` passes.**

```bash
cd bakudo && mise run check
```

- [ ] **Step 2: Manual smokes.**

```bash
# F-05
echo "hello" | node dist/src/cli.js -p "hi" --output-format=json   # → single JSONL error line, exit 2
# F-06
node dist/src/cli.js doctor --explain-config nonsense.bogus        # → harness_error: unknown config key: …, exit 1
node dist/src/cli.js doctor --explain-config mode                  # → still works, exit 0
# F-07
node dist/src/cli.js sandbox <some-session-id>                      # → under ~20 lines
# F-15
node dist/src/cli.js cleanup --dry-run                              # → both "Would remove" and "Would keep" sections
```

**End of Wave 4.**

---

# Wave 5 — bakudo: host preflight slice (F-P)

**Scope:** F-P only (virtiofsd getcap + /dev/kvm). Repo: bakudo.

The spec is explicit: **exactly two checks**. Do not add a third. Rootfs presence is deferred to Phase 3.

## Task 5.1 — New `hostPreflight.ts` module with both checks

**Files:**
- Create: `bakudo/src/host/hostPreflight.ts`
- Create: `bakudo/tests/regression/F-P-host-preflight.test.ts`

- [ ] **Step 1: Write the failing test.**

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import {
  checkVirtiofsdCaps,
  checkKvmAccess,
  type PreflightCheckResult,
} from "../../src/host/hostPreflight.js";

test("F-P: checkVirtiofsdCaps reports missing path as error", async () => {
  const result: PreflightCheckResult = await checkVirtiofsdCaps({
    virtiofsdPath: "/does/not/exist/virtiofsd",
    execFn: async () => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    },
  });
  assert.equal(result.status, "error");
  assert.equal(result.name, "host-virtiofsd-caps");
  assert.match(result.message, /virtiofsd/);
});

test("F-P: checkVirtiofsdCaps reports missing cap_sys_admin as error", async () => {
  const result: PreflightCheckResult = await checkVirtiofsdCaps({
    virtiofsdPath: "/usr/libexec/virtiofsd",
    execFn: async () => ({ stdout: "\n", stderr: "" }),
  });
  assert.equal(result.status, "error");
  assert.match(result.message, /cap_sys_admin\+ep/);
  assert.match(result.fix ?? "", /setcap 'cap_sys_admin\+ep'/);
});

test("F-P: checkVirtiofsdCaps passes when cap is present", async () => {
  const result: PreflightCheckResult = await checkVirtiofsdCaps({
    virtiofsdPath: "/usr/libexec/virtiofsd",
    execFn: async () => ({
      stdout: "/usr/libexec/virtiofsd cap_sys_admin=ep\n",
      stderr: "",
    }),
  });
  assert.equal(result.status, "pass");
});

test("F-P: checkKvmAccess reports missing /dev/kvm as error", async () => {
  const result: PreflightCheckResult = await checkKvmAccess({
    statFn: async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    accessFn: async () => {
      throw new Error("unreachable when stat fails");
    },
  });
  assert.equal(result.status, "error");
  assert.equal(result.name, "host-kvm-access");
  assert.match(result.message, /\/dev\/kvm/);
});

test("F-P: checkKvmAccess reports non-rw as error", async () => {
  const result: PreflightCheckResult = await checkKvmAccess({
    statFn: async () => ({ isCharacterDevice: () => true }),
    accessFn: async () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    },
  });
  assert.equal(result.status, "error");
  assert.match(result.fix ?? "", /usermod -aG kvm/);
});

test("F-P: checkKvmAccess passes when rw", async () => {
  const result: PreflightCheckResult = await checkKvmAccess({
    statFn: async () => ({ isCharacterDevice: () => true }),
    accessFn: async () => undefined,
  });
  assert.equal(result.status, "pass");
});
```

- [ ] **Step 2: Build, confirm failure.**

```bash
cd bakudo && pnpm build && node --test dist/tests/regression/F-P-host-preflight.test.js
```

Expected: all tests fail with module-not-found (file doesn't exist yet).

- [ ] **Step 3: Implement `hostPreflight.ts`.**

```typescript
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { access, stat, constants as fsConstants } from "node:fs/promises";
import type { Stats } from "node:fs";

const execFileAsync = promisify(execFile);

export type PreflightCheckResult = {
  name: "host-virtiofsd-caps" | "host-kvm-access";
  status: "pass" | "error";
  message: string;
  fix?: string;
};

export type CheckVirtiofsdCapsInput = {
  virtiofsdPath: string;
  execFn?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
};

export const checkVirtiofsdCaps = async (
  input: CheckVirtiofsdCapsInput,
): Promise<PreflightCheckResult> => {
  const execFn = input.execFn ?? ((cmd, args) => execFileAsync(cmd, args, { encoding: "utf8" }));
  try {
    const { stdout } = await execFn("getcap", [input.virtiofsdPath]);
    if (!/cap_sys_admin[^\s]*=ep/.test(stdout)) {
      return {
        name: "host-virtiofsd-caps",
        status: "error",
        message: `virtiofsd at ${input.virtiofsdPath} lacks required capabilities.`,
        fix: `sudo setcap 'cap_sys_admin+ep' ${input.virtiofsdPath}`,
      };
    }
    return {
      name: "host-virtiofsd-caps",
      status: "pass",
      message: `virtiofsd at ${input.virtiofsdPath} has cap_sys_admin+ep`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: "host-virtiofsd-caps",
      status: "error",
      message: `unable to probe virtiofsd at ${input.virtiofsdPath}: ${msg}`,
      fix: `sudo setcap 'cap_sys_admin+ep' ${input.virtiofsdPath}`,
    };
  }
};

export type CheckKvmAccessInput = {
  kvmPath?: string;
  statFn?: (p: string) => Promise<Pick<Stats, "isCharacterDevice">>;
  accessFn?: (p: string, mode: number) => Promise<void>;
};

export const checkKvmAccess = async (
  input: CheckKvmAccessInput = {},
): Promise<PreflightCheckResult> => {
  const path = input.kvmPath ?? "/dev/kvm";
  const statFn = input.statFn ?? (stat as unknown as NonNullable<CheckKvmAccessInput["statFn"]>);
  const accessFn = input.accessFn ?? access;
  try {
    const s = await statFn(path);
    if (!s.isCharacterDevice()) {
      return {
        name: "host-kvm-access",
        status: "error",
        message: `${path} exists but is not a character device`,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: "host-kvm-access",
      status: "error",
      message: `${path} not accessible: ${msg}`,
      fix: "sudo usermod -aG kvm $USER (log out and back in)",
    };
  }
  try {
    await accessFn(path, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    return {
      name: "host-kvm-access",
      status: "error",
      message: `${path} not accessible for uid=${process.getuid?.() ?? "unknown"}`,
      fix: "sudo usermod -aG kvm $USER (log out and back in)",
    };
  }
  return {
    name: "host-kvm-access",
    status: "pass",
    message: `${path} readable/writable`,
  };
};
```

- [ ] **Step 4: Run the tests, confirm PASS.**

```bash
cd bakudo && pnpm build && node --test dist/tests/regression/F-P-host-preflight.test.js
```

## Task 5.2 — Wire preflight into `doctorAboxProbe.ts` + `doctor.ts`

**Files:**
- Modify: `bakudo/src/host/doctorAboxProbe.ts:50-130`
- Modify: `bakudo/src/host/commands/doctor.ts:112-186`

Two plausible wirings. Pick (A):

**(A) Add preflight as its own checks, surfaced BEFORE the abox probe.** The doctor envelope's ordered checks list gains `host-virtiofsd-caps` and `host-kvm-access` between the node check and the abox probe.

**(B) Fold preflight results into `aboxProbeToChecks`.** Tighter coupling, but mixes the probe result (a single data-point) with preflight results (two separate data-points).

- [ ] **Step 1: Decide the `virtiofsdPath` source before wiring — then lock it.**

The spec says "configured virtiofsd-path" but bakudo has no such config today (`doctor.ts:runDoctorChecks` takes `ctx: DoctorContext` — confirm by reading the context type; there is no `virtiofsdPath` field at HEAD). Three choices:

1. **Env var only** (`BAKUDO_VIRTIOFSD_PATH`, falling back to `/usr/libexec/virtiofsd`). Minimal, stays in F-P scope, but adds a new public env-var surface that will need to be mentioned in the next brainstorm.
2. **Read abox's config** (`~/.config/abox/config.toml` → `runtime.virtiofsd`). Reflects how abox actually resolves the path, but couples bakudo to abox's file layout.
3. **Fixed default only** (`/usr/libexec/virtiofsd`, no override). Strictest minimum; fails on hosts where the distribution installs virtiofsd elsewhere.

**Pick (1) for Phase 0.** It is the smallest delta, is easy to document in the `bakudo doctor` output ("set BAKUDO_VIRTIOFSD_PATH if virtiofsd lives elsewhere"), and avoids Phase 0 picking a parse-target in abox's config that Phase 1's shared-contract work will need to revisit. Flag the new env var in the commit body so future-you sees it in git log.

If the user reviewing this plan prefers (2) or (3), annotate the choice here before implementation begins — do NOT silently pick a different option during coding.

- [ ] **Step 2: Add the two preflight checks to `runDoctorChecks` before the abox probe.**

In `doctor.ts`, after the Node version check and before the abox-availability check:

```typescript
import { checkVirtiofsdCaps, checkKvmAccess } from "../hostPreflight.js";

// inside runDoctorChecks, after the node check:
const virtiofsdPath = process.env.BAKUDO_VIRTIOFSD_PATH ?? "/usr/libexec/virtiofsd";
const virtiofsdResult = await checkVirtiofsdCaps({ virtiofsdPath });
checks.push(preflightToDoctorCheck(virtiofsdResult));

const kvmResult = await checkKvmAccess();
checks.push(preflightToDoctorCheck(kvmResult));
```

`preflightToDoctorCheck()` is a small local helper mapping `PreflightCheckResult` → `DoctorCheckResult`. Keep it next to the producer in `hostPreflight.ts` so the shape-mapping lives with the shape.

- [ ] **Step 3: Ensure exit-code escalation.**

Check what `runDoctorCommand` returns when any mapped doctor check has `status === "fail"`. If it already escalates to non-zero, F-P is wired correctly. If not, add the escalation: `return checks.some(c => c.status === "fail") ? EXIT_CODES.FAILURE : 0`.

- [ ] **Step 4: Add an integration test for the wired doctor command.**

Extend `tests/integration/doctor-command.test.ts` (do not create a new file; there's already a doctor test harness there):

```typescript
test("F-P: doctor surfaces host-virtiofsd-caps error before the abox probe", async () => {
  await withTempRepo(async (repoRoot) => {
    const prior = process.env.BAKUDO_VIRTIOFSD_PATH;
    process.env.BAKUDO_VIRTIOFSD_PATH = join(repoRoot, "missing-virtiofsd");
    try {
      const env = await runDoctorChecks({
        repoRoot,
        aboxBin: "missing-abox-bin",
        env: process.env as Record<string, string | undefined>,
        nodeRuntime: "v22.0.0",
        stdout: { isTTY: false, write: () => true },
      });

      const names = env.checks.map((check) => check.name);
      const virtio = env.checks.find((check) => check.name === "host-virtiofsd-caps");
      const abox = env.checks.find((check) => check.name === "abox-availability");

      assert.ok(virtio, "missing host-virtiofsd-caps check");
      assert.ok(abox, "missing abox-availability check");
      assert.equal(virtio?.status, "fail");
      assert.ok(
        names.indexOf("host-virtiofsd-caps") < names.indexOf("abox-availability"),
        "preflight must be emitted before the abox probe",
      );
      assert.match(
        `${virtio?.summary ?? ""} ${virtio?.remediation ?? ""}`,
        /setcap|cap_sys_admin/,
      );
    } finally {
      if (prior === undefined) delete process.env.BAKUDO_VIRTIOFSD_PATH;
      else process.env.BAKUDO_VIRTIOFSD_PATH = prior;
    }
  });
});
```

- [ ] **Step 5: Run, commit.**

```bash
cd bakudo && mise run check
git add src/host/hostPreflight.ts src/host/doctorAboxProbe.ts src/host/commands/doctor.ts tests/regression/F-P-host-preflight.test.ts tests/integration/doctor-command.test.ts
git commit -m "feat(host): add minimal host-preflight slice (F-P)

Adds two checks: getcap on the configured virtiofsd path and /dev/kvm
stat + access. Results are surfaced in the doctor envelope BEFORE the
abox probe so operators distinguish host-setup failure from task
failure within Phase 0. Rootfs presence is deferred to Phase 3.

Refs: plans/integration/2026-04-18-phase-0-spec.md#F-P"
```

## Task 5.3 — Wave 5 gate

- [ ] **Step 1: `mise run check` passes.**
- [ ] **Step 2: Manual smoke — capable host.**

```bash
node dist/src/cli.js doctor
# → host-virtiofsd-caps: PASS, host-kvm-access: PASS, abox-*: PASS
```

- [ ] **Step 3: Manual smoke — caps stripped.**

On a machine where `sudo` is available:

```bash
sudo setcap -r /usr/libexec/virtiofsd
node dist/src/cli.js doctor; echo "exit=$?"
# → host-virtiofsd-caps: ERROR, exit non-zero
sudo setcap 'cap_sys_admin+ep' /usr/libexec/virtiofsd
```

If `sudo` isn't available, skip this smoke; the regression test covers the shape.

**End of Wave 5.**

---

# Wave 6 — bakudo: provisional fixes (F-08, F-13)

**Scope:** F-08 and F-13 — both marked provisional in the spec. Repo: bakudo.

Spec §F-08 and §F-13 explicitly require re-verification against HEAD before writing fix code. Skip the fix (and the task) for any item already fixed at HEAD.

## Task 6.1 — Re-verify F-08 against HEAD

- [ ] **Step 1: Run `bakudo logs` against a real session.**

```bash
# Find any existing session id:
node dist/src/cli.js sessions | head -5
# Run logs on one:
node dist/src/cli.js logs <sid>
```

- [ ] **Step 2: Inspect the output.**

Does any rendered field contain the literal string `undefined`? Specifically for `turnId` or `attemptId` positions?

- [ ] **Step 3: Decide.**

- If `undefined` appears: proceed to Task 6.2.
- If not: drop F-08. Record the decision in your working notes (NOT in the spec file — the spec is frozen). Skip Task 6.2.

## Task 6.2 — F-08 fix (only if Task 6.1 confirmed broken)

**Files:**
- Modify: `bakudo/src/host/printers.ts` — function `printLogs` (starts at line 368). **This is the user-visible `bakudo logs` surface**, distinct from `formatInspectLogs` in `inspectFormatter.ts` which renders `inspect … logs`.
- Create: `bakudo/tests/regression/F-08-logs-fields.test.ts`

Important retarget: the F-08 test-report repro was `bakudo logs <id>`, not `bakudo inspect <id> logs`. `printLogs` lives in `printers.ts`; `formatInspectLogs` (inspectFormatter.ts:345) is a sibling path for the tab-based view. If both paths emit `undefined`, fix both — but if Task 6.1 reproduced only via `bakudo logs`, only `printers.ts:printLogs` is in scope.

- [ ] **Step 1: Write the failing test.**

`printLogs` reads events from `sessionStore.readTaskEvents` and formats them (see HEAD `printers.ts:368-400`). The test needs a real session fixture because the function loads from disk. Simplest approach: write a session with a hand-constructed event record whose `turnId` / `attemptId` are absent, then call `printLogs` with the repo root.

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCapturedStdout } from "../../src/host/io.js";
import { printLogs } from "../../src/host/printers.js";

test("F-08: printLogs never renders literal 'undefined' for missing turnId/attemptId", async () => {
  const repo = await mkdtemp(join(tmpdir(), "bakudo-f-08-"));
  try {
    // Construct a session directory with one event record whose turnId
    // and attemptId are absent. Per SessionStore at HEAD, the file lives at
    // `{repo}/.bakudo/sessions/{sid}/events.ndjson`.
    const sid = "sess-f08";
    const sessDir = join(repo, ".bakudo", "sessions", sid);
    await mkdir(sessDir, { recursive: true });
    await writeFile(
      join(sessDir, "events.ndjson"),
      JSON.stringify({
        timestamp: "2026-04-18T00:00:00Z",
        status: "ok",
        taskId: "t-1",
        kind: "event",
        // turnId + attemptId deliberately omitted
      }) + "\n",
    );
    await writeFile(
      join(sessDir, "session.json"),
      JSON.stringify({ sessionId: sid, turns: [] }),
    );

    const chunks: string[] = [];
    const writer = { write: (c: string) => { chunks.push(c); return true; } };
    const exit = await withCapturedStdout(writer, () =>
      printLogs({
        repo,
        sessionId: sid,
        taskId: undefined,
        copilot: { outputFormat: "text" },
      } as any),
    );

    assert.equal(exit, 0);
    assert.doesNotMatch(chunks.join(""), /\bundefined\b/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
```

Signature and on-disk layout notes: `printLogs`'s args shape is `HostCliArgs` at HEAD — the minimal object above covers the fields read in `printers.ts:368-400`. Adjust session storage layout when you open `SessionStore`; the point is to exercise the formatter on a record with missing fields.

- [ ] **Step 2: Fix the renderer.**

The event format line at `printers.ts:390-393` is:

```typescript
`${event.timestamp} ${statusBadge(event.status)} ${event.taskId} ${event.kind} ${event.status}${event.message ? ` ${event.message}` : ""}`
```

This line doesn't directly render `turnId` or `attemptId` today — the "undefined" leaks reported in the test-report likely come from an upstream event-mapping step, or from a different branch. If Task 6.1's re-verification shows `undefined` literals in `bakudo logs` output, trace where they originate (grep the repo for `turnId ?? ` / `attemptId ?? ` / template strings containing `${event.turnId}`). Apply `event.turnId ?? event.payload?.turnId ?? "-"` (and same for `attemptId`) at the rendering site.

If the re-verification shows the issue is actually in `formatInspectLogs` (via `bakudo inspect … logs`) and not `printLogs`, fix that function instead — the spec's acceptance ("No literal `undefined` in any rendered field") is command-agnostic.

- [ ] **Step 3: Run, commit.**

```bash
cd bakudo && mise run check
git add src/host/printers.ts tests/regression/F-08-logs-fields.test.ts
git commit -m "fix(host): logs field rendering uses fallback dashes (F-08)"
```

## Task 6.3 — Re-verify F-13 against HEAD

- [ ] **Step 1: Set up a non-booting abox.**

Temporarily configure `BAKUDO_VIRTIOFSD_PATH` to point at something that is absent, or set `aboxBin` to a binary that will refuse to boot. Run:

```bash
time node dist/src/cli.js build "echo hi" --repo /tmp/scratch --yes
```

- [ ] **Step 2: Observe.**

Does bakudo print any progress line during the pre-first-worker-event window (typically 60s on virtiofsd-unprivileged host)?

- [ ] **Step 3: Decide.**

- Progress lines present: drop F-13. Skip Task 6.4.
- Silent until timeout: proceed to Task 6.4.

## Task 6.4 — F-13 fix (only if Task 6.3 confirmed silent)

**Files:**
- Create: `bakudo/src/host/dispatchProgress.ts`
- Modify: whichever module emits dispatch events (trace from `ABoxTaskRunner` + `executeAttempt.ts`)

- [ ] **Step 1: Design.**

A simple `setInterval` ticker started at dispatch and cleared on first worker event or completion. Suppressed when `args.copilot.outputFormat === "json"` per spec §F-13.

```typescript
// bakudo/src/host/dispatchProgress.ts
export type DispatchProgressTicker = {
  start: () => void;
  stop: () => void;
};

export const startDispatchProgress = (input: {
  taskId: string;
  useJson: boolean;
  write: (line: string) => void;
  intervalMs?: number;
  now?: () => number;
}): DispatchProgressTicker => {
  if (input.useJson) {
    return { start: () => {}, stop: () => {} };
  }
  const interval = input.intervalMs ?? 10_000;
  const now = input.now ?? Date.now;
  let startedAt = now();
  let handle: ReturnType<typeof setInterval> | undefined;
  return {
    start: () => {
      startedAt = now();
      handle = setInterval(() => {
        const elapsed = Math.floor((now() - startedAt) / 1000);
        input.write(`… dispatching ${input.taskId} (${elapsed}s elapsed, awaiting first worker event)\n`);
      }, interval);
    },
    stop: () => {
      if (handle !== undefined) {
        clearInterval(handle);
        handle = undefined;
      }
    },
  };
};
```

- [ ] **Step 2: Wire it into the dispatch path.**

Before the call that awaits the first worker event (likely in `executeAttempt.ts` or `aboxTaskRunner.ts`), call `startDispatchProgress(...).start()`. In the worker-event handler, call `.stop()` on the first event received. In the error/timeout path, `.stop()` in a `finally`.

- [ ] **Step 3: Write a minimal regression test.**

Exercises `startDispatchProgress` with `useJson: false`, advances fake time past the interval, asserts a line was written. Also with `useJson: true`, asserts no line was written.

- [ ] **Step 4: Run, commit.**

```bash
cd bakudo && mise run check
git add src/host/dispatchProgress.ts src/host/executeAttempt.ts src/host/aboxTaskRunner.ts tests/regression/F-13-dispatch-progress.test.ts
git commit -m "feat(host): emit dispatch progress lines pre-first-event (F-13)"
```

## Task 6.5 — Wave 6 gate

- [ ] **Step 1: `mise run check` passes.**
- [ ] **Step 2: Document the F-08/F-13 decisions.**

In the commit log for whichever fixes actually landed, make the re-verification result explicit (e.g. `F-08 re-verified as broken at HEAD` or `F-13 re-verified: progress now emitted at HEAD; item dropped`).

**End of Wave 6.**

---

# Wave 7 — Integration tests, E2E, docs

**Scope:** Three integration tests (one per F-00, F-04, F-05) + the `just integration-test` E2E extension. Repos: bakudo + parent.

Wave 7 depends on Wave 1 having merged AND on an `abox` binary with F-00 installed on `$PATH` or reachable by path.

## Task 7.1 — Integration test: live `abox --capabilities` probe (F-00 acceptance)

**Files:**
- Create: `bakudo/tests/integration/abox-capabilities.test.ts`

- [ ] **Step 1: Write the test.**

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { probeWorkerCapabilities } from "../../src/host/workerCapabilities.js";

const ABOX_BIN = process.env.BAKUDO_INTEGRATION_ABOX_BIN ?? "abox";

test("F-00 acceptance: probeWorkerCapabilities returns source === 'probe' against live abox", async () => {
  const outcome = await probeWorkerCapabilities({ bin: ABOX_BIN });
  assert.equal(
    outcome.capabilities.source,
    "probe",
    `expected source to be 'probe' (probe succeeded); got '${outcome.capabilities.source}' with fallbackReason='${outcome.fallbackReason ?? "n/a"}'`,
  );
  assert.deepEqual(outcome.capabilities.protocolVersions, [1, 3]);
  assert.deepEqual(outcome.capabilities.taskKinds, [
    "assistant_job",
    "explicit_command",
    "verification_check",
  ]);
  assert.deepEqual(outcome.capabilities.executionEngines, ["agent_cli", "shell"]);
});
```

The env-var override lets CI point at a non-default binary (e.g., `target/release/abox`). If `$PATH` doesn't have `abox`, the test will fail with `fallback_host_default` — this is the correct signal.

- [ ] **Step 2: Run.**

```bash
cd bakudo && pnpm build
BAKUDO_INTEGRATION_ABOX_BIN=../abox/target/release/abox \
  node --test dist/tests/integration/abox-capabilities.test.js
```

Expected: PASS.

## Task 7.2 — Integration test: spawn with empty allowlist still works (F-04 acceptance)

**Files:**
- Create: `bakudo/tests/integration/spawn-abox-path.test.ts`

- [ ] **Step 1: Write the test.**

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { ABoxAdapter } from "../../src/aboxAdapter.js";
import { DEFAULT_ENV_POLICY, filterEnv } from "../../src/host/envPolicy.js";

test("F-04 acceptance: adapter spawn with empty allowlist resolves unqualified abox via PATH", async () => {
  // Build an env through the real filterEnv with the default (empty)
  // allowlist — this is the exact shape ABoxTaskRunner produces.
  const filtered = filterEnv(process.env as Record<string, string>, DEFAULT_ENV_POLICY);
  // filterEnv omits PATH; the adapter must re-add it.
  assert.equal(filtered.PATH, undefined, "precondition: filterEnv strips PATH");

  // Use a simple echo instead of a real dispatch — we only care about
  // reaching the binary. If PATH preservation is broken, spawn throws
  // ENOENT before the binary runs.
  // (Adapt the invocation to whatever the minimal no-op path is; may
  // require stubbing buildInvocation.)
  const adapter = new ABoxAdapter("abox"); // unqualified
  let failed: unknown;
  try {
    await adapter.runInStreamLive("stream-f04", "--version", 5, {}, filtered);
  } catch (err) {
    failed = err;
  }
  if (failed && String(failed).includes("ENOENT")) {
    assert.fail(`spawn ENOENT — F-04 PATH injection broken: ${failed}`);
  }
  // Any other exit (e.g. abox rejecting `--version` as a goal) is fine;
  // the assertion is specifically on ENOENT absence.
});
```

- [ ] **Step 2: Run.**

```bash
cd bakudo && pnpm build && node --test dist/tests/integration/spawn-abox-path.test.js
```

Expected: PASS.

## Task 7.3 — Integration test: oneshot JSON never prompts (F-05 acceptance)

**Files:**
- Create: `bakudo/tests/integration/oneshot-json-no-prompt.test.ts`

- [ ] **Step 1: Write the test.**

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostCliArgs } from "../../src/host/parsing.js";
import { runNonInteractiveOneShot } from "../../src/host/oneShotRun.js";
import { withCapturedStdout } from "../../src/host/io.js";
import { EXIT_CODES } from "../../src/host/errors.js";

const capture = (): { writer: { write: (chunk: string) => boolean }; chunks: string[] } => {
  const chunks: string[] = [];
  return {
    chunks,
    writer: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    },
  };
};

const baseArgs = (storageRoot: string): HostCliArgs =>
  ({
    command: "run",
    config: "config/default.json",
    aboxBin: "abox",
    repo: process.cwd(),
    mode: "build",
    yes: false,
    shell: "bash",
    timeoutSeconds: 120,
    maxOutputBytes: 256 * 1024,
    heartbeatIntervalMs: 5000,
    killGraceMs: 2000,
    storageRoot,
    copilot: { prompt: "hello", outputFormat: "json", allowAllTools: false },
  }) as HostCliArgs;

test("F-05 acceptance: -p --output-format=json with denying policy emits one approval_required JSONL", async () => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-f-05-integ-"));
  try {
    const { writer, chunks } = capture();
    const exit = await withCapturedStdout(writer, () => runNonInteractiveOneShot(baseArgs(root)));
    assert.equal(exit, EXIT_CODES.BLOCKED);
    const lines = chunks.join("").split("\n").filter(Boolean);
    for (const line of lines) {
      assert.ok(line.startsWith("{"), `non-JSONL line: ${line}`);
    }
    const approvals = lines
      .map((line) => JSON.parse(line))
      .filter((entry) => entry?.error?.code === "approval_required");
    assert.equal(approvals.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run.**

```bash
cd bakudo && pnpm build && node --test dist/tests/integration/oneshot-json-no-prompt.test.js
```

Expected: PASS.

## Task 7.4 — Extend parent `just integration-test` for E2E

**Files:**
- Modify: `/home/al/git/bakudo-abox/justfile` — recipe `integration-test`

- [ ] **Step 1: Read the existing recipe.**

```
integration-test: build-all
    ... current body ...
```

- [ ] **Step 2: Add three checks.**

Replace the recipe with (preserving the repo-discovery logic):

```justfile
integration-test: build-all
    #!/usr/bin/env bash
    set -euo pipefail

    ABOX_BIN="$(pwd)/abox/target/release/abox"

    # --- Phase 0 F-00 acceptance: live capabilities probe ---
    # Use Node to validate (no jq dependency) so the recipe runs on any host
    # that can already run bakudo. The bakudo integration test below does the
    # deeper validation — this quick check just ensures the binary responds
    # with parseable JSON before we invest time booting a VM.
    echo "==> Checking abox --capabilities envelope shape"
    CAPS="$($ABOX_BIN --capabilities)"
    echo "$CAPS" | node -e '
      const s = require("fs").readFileSync(0, "utf8").trim();
      const j = JSON.parse(s);
      if (!Array.isArray(j.protocolVersions) || !Array.isArray(j.taskKinds) || !Array.isArray(j.executionEngines)) {
        console.error("bad envelope shape");
        process.exit(1);
      }
    '
    echo "    ok"

    # --- bakudo integration tests that invoke the live abox ---
    echo "==> Running bakudo integration tests (BAKUDO_INTEGRATION_ABOX_BIN=$ABOX_BIN)"
    cd bakudo && \
      BAKUDO_INTEGRATION_ABOX_BIN="$ABOX_BIN" pnpm test:integration
    cd -

    # --- End-to-end scratch-repo dispatch (KVM-gated) ---
    if [ -z "${BAKUDO_INTEGRATION_E2E:-}" ]; then
      echo "==> Skipping E2E scratch-repo dispatch (set BAKUDO_INTEGRATION_E2E=1 to run)"
      exit 0
    fi

    SCRATCH="$(mktemp -d)"
    trap 'rm -rf "$SCRATCH"' EXIT
    cd "$SCRATCH"
    git init -q
    echo "hello" > README.md
    git add README.md && git -c user.email=ci@example.com -c user.name=ci commit -q -m init

    echo "==> Running scratch-repo build"
    cd - > /dev/null
    cd bakudo && mise exec -- node dist/src/cli.js \
      build "add a top-of-file comment to README.md" \
      --repo "$SCRATCH" --yes \
      --abox-bin "$ABOX_BIN"

    cd "$SCRATCH"
    echo "==> Asserting README diff present"
    git status --porcelain || true
    ! git diff --quiet README.md || (echo "README unchanged" && exit 1)

    echo "==> Asserting bakudo status reports mode=build"
    cd - > /dev/null
    cd bakudo && mise exec -- node dist/src/cli.js status --repo "$SCRATCH" | grep -q 'mode=build'

    echo "==> Phase 0 integration test PASSED"
```

- [ ] **Step 3: Run.**

On a virtiofsd-capable host:

```bash
cd /home/al/git/bakudo-abox && BAKUDO_INTEGRATION_E2E=1 just integration-test
```

Without `BAKUDO_INTEGRATION_E2E=1`, only the F-00 probe + bakudo integration tests run. On CI without virtiofsd, the E2E step self-skips. This matches spec §Testing strategy where E2E is `tier-vm` nightly, not `tier-ci`.

- [ ] **Step 4: Commit the justfile change.**

The parent `justfile` is under version control inside `/home/al/git/bakudo-abox/` — but per the user's instructions, DO NOT COMMIT yet. When the user greenlights, the commit happens at the parent level if it's a git repo; otherwise this is a working-tree edit only.

Check first:

```bash
cd /home/al/git/bakudo-abox && git status 2>&1 | head -3
```

If the parent is not a git repo (the spec's note says the plan docs are "intentionally NOT under version control"), the justfile might still live in one of the sub-repos. Verify before attempting any commit.

## Task 7.5 — Wave 7 gate

- [ ] **Step 1: All integration tests green.**

```bash
cd bakudo && BAKUDO_INTEGRATION_ABOX_BIN=../abox/target/release/abox pnpm test:integration
```

- [ ] **Step 2: Full acceptance pass (spec §Acceptance criteria items 1–15).**

Walk the 15 items one-by-one. Record pass/fail in your working notes. Every item must PASS before Phase 0 is done.

**End of Wave 7.**

---

## Summary — estimates and blockers

| Wave | Repo | Scope | Estimate |
|------|------|-------|----------|
| 1 | abox | F-00 top-level `--capabilities` flag + test | 0.5 day |
| 2 | bakudo | F-01 + F-14 + F-04 | 1 day |
| 3 | bakudo | F-03 resume migration | 1 day |
| 4 | bakudo | F-05 + F-06 + F-07 + F-15 | 1.5 days |
| 5 | bakudo | F-P preflight | 1 day |
| 6 | bakudo | F-08 + F-13 (re-verify first) | 0.5 day |
| 7 | bakudo + parent | Integration tests + E2E + docs | 1 day |
| **Total** | | | **~6.5 days, 1 week pad** |

**Known blockers / risks:**
- **Wave 7 depends on Wave 1 being installable.** Without F-00 on the probed binary, the live integration test falls back and fails — which is a valid-but-useless signal. Build + install Wave 1 before running Wave 7.
- **F-P needs a virtiofsd path source.** The minimal wiring uses `BAKUDO_VIRTIOFSD_PATH` env var with a sensible default. If an abox config reader is trivially reachable from bakudo, prefer that; otherwise stay with the env var.
- **E2E acceptance needs virtiofsd caps on the machine running the tests.** Per memory: the current host has virtiofsd perm issues AND an abox 0.2.0 binary that predates F-00. Wave 7's E2E likely requires fixing virtiofsd caps (`sudo setcap 'cap_sys_admin+ep' /usr/libexec/virtiofsd`) AND rebuilding + reinstalling abox from the Wave 1 branch before it can pass end-to-end.
- **F-08 and F-13 are provisional.** Do not commit to either fix without re-verifying first. The spec explicitly allows dropping them if HEAD has moved.

---

## Self-review notes

- **Spec coverage.** Every item in the spec's 12-item table maps to a wave and at least one task. F-00 → Wave 1; F-01 + F-14 → Wave 2; F-04 → Wave 2; F-03 → Wave 3; F-05 + F-06 + F-07 + F-15 → Wave 4; F-P → Wave 5; F-08 + F-13 → Wave 6; integration tests + E2E → Wave 7.
- **Appendix A coverage.** A.1 envelope shape is frozen in Wave 1 Task 1.2; A.1.1 root-flag parse + bypass is Wave 1 Task 1.3; A.2 exit-code taxonomy is referenced via `EXIT_CODES` imports in Waves 4/5/6 (no redefinition); A.3 new `"approval_required"` string is Wave 4 Task 4.1.
- **Non-goals.** No worker extraction, no deep-doctor, no rootfs check, no schema-validated doctor probe — all deferred per §Non-goals. Anything touching those surfaces in this plan is limited to acknowledging the non-goal.
- **Type consistency.** `PreflightCheckResult`, `attemptSpecToWorkerSpec`, `EXIT_CODES`, `BakudoErrorCode` all named consistently across tasks. The `checkVirtiofsdCaps` / `checkKvmAccess` function names stay stable from Task 5.1 through Task 5.2's wiring.
- **Execution seams are now pinned to HEAD.** F-03 uses `SessionStore.createSession` / `upsertAttempt` plus a narrow `resumeSession(args, { executeTaskFn })` seam; F-05 imports a named `resolveAutoApprove` export and uses the real `withCapturedStdout(writer, fn)` helper shape. There are no remaining intentional `assert.fail(...)` scaffolds in the plan.
- **New env-var surface.** Wave 5 introduces `BAKUDO_VIRTIOFSD_PATH`. This is a new public env var, narrower than adding a config key. Record it in the F-P commit body so the next brainstorm sees it.

---

## Execution handoff

Plan complete and saved to `/home/al/git/bakudo-abox/plans/integration/2026-04-18-phase-0-implementation-plan.md`.

**DO NOT start implementation yet.** Per the user's instructions, the user will review this plan before any code changes land. When the user approves, two execution options are available:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task with two-stage review between tasks. Best for Phase 0's mixed-repo structure because each wave can run in isolation with a focused subagent. Uses `superpowers:subagent-driven-development`.

2. **Inline Execution** — Execute tasks in the current session with per-wave checkpoints. Faster for an operator who wants to read every diff. Uses `superpowers:executing-plans`.

Ask the user which approach before proceeding.
