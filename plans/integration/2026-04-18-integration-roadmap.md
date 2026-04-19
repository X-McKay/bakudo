# bakudo ↔ abox integration roadmap

**Status:** proposed — revision 2, post external critique (2026-04-18)
**Date:** 2026-04-18
**Scope:** cross-repo integration between `bakudo` (TypeScript host harness) and `abox` (Rust microVM sandbox runtime)

**Changes from revision 1:** reframed problem statement (optimistic fallback + false-positive diagnostics, not "silent drift"); Phase 0 scope re-baselined against HEAD, dropping five items already fixed; F-00/F-03/F-05 redesigned; minimal host-preflight slice pulled forward into Phase 0.

---

## Context

`bakudo` plans and reviews agent work on the host. `abox` provides the isolated microVM + git-worktree sandbox where that work actually runs. Today the contract between them is **CLI-only and undocumented**:

```
abox [--repo <path>] run --task <id> --ephemeral -- <command...>
```

`bakudo` packages ~28 KB of worker JavaScript (`protocol.js + workerRuntime.js + workerCli.js`) as bash heredocs on every dispatch and parses worker output lines prefixed with `WORKER_EVENT:`, `WORKER_RESULT:`, `WORKER_ERROR:` out of abox's stdout. `abox` treats the payload as an opaque command — it has no structured knowledge of bakudo.

Nothing codifies this handshake:
- `abox-protocol` is the shim↔proxyd wire protocol, internal to abox.
- `attemptProtocol` is a bakudo internal.
- No shared crate, package, or schema spans the two repos.

---

## Why this matters — optimistic fallback + false-positive diagnostics

An earlier draft of this roadmap framed the problem as "silent drift in an undocumented contract." An external critique on 2026-04-18 pointed out that framing misses the more dangerous failure mode: the current plumbing is **optimistic by design** and the health surface **reports those optimistic assumptions as verified facts**.

Concrete mechanics observed in the 2026-04-18 live test and verified in code:

- **The capability probe has an optimistic fallback.** When `abox --capabilities` fails (unknown flag on abox 0.2.0, missing binary, parse error), `bakudo/src/host/workerCapabilities.ts:155-161` returns `hostDefaultFallbackCapabilities()` — which **asserts the host's own declared capability set**, regardless of what the worker can actually accept (`bakudo/src/protocol.ts:57-69`). The dispatch proceeds as if negotiation had succeeded. If the worker in rootfs has drifted from the host, the mismatch only manifests as a runtime parse failure mid-dispatch.

- **Doctor reports the false positive as a pass.** `bakudo doctor` calls the same probe and renders its result in the `abox-capabilities` check. But `bakudo/src/host/doctorAboxProbe.ts:58-68,115-126` treats *any non-empty stdout* as success — it does not parse-validate the JSON or distinguish a successful probe from a fallback. On the 2026-04-18 test host, doctor reports `[OK] abox-capabilities: v1 (assumed)` while the probe has actually failed and fallen back. The operator sees a green check for a check that isn't being performed.

- **Host-infrastructure failures get misattributed to tasks.** When virtiofsd lacked `CAP_SYS_ADMIN` on the test host, VM boot timed out after 60s. bakudo surfaced this as `Status=failed / Outcome=retryable_failure / Summary="worker finished without a structured result envelope"` — the same shape a failing task produces. An operator cannot distinguish host-setup failure from task failure.

- **PATH/env edge case is invisible.** bakudo's Phase 6 W5 env-allowlist filter (`bakudo/src/host/envPolicy.ts:40-43,64-77`) defaults to an empty allowlist and strips PATH from the spawn env. When `aboxBin` is a bare name, the spawn fails with `spawn abox ENOENT` while doctor continues to pass.

- **Heredoc fragility is latent.** Shipping ~700 lines of bash on every dispatch is a silent escape-bug risk. An untested worker-source change introduces failures that look identical to runtime task errors.

The pattern: **things work until they don't, and when they don't, bakudo confidently reports health while misattributing the failure across repo boundaries.**

---

## The four phases

The integration work decomposes into four phases with strict dependency ordering. Phase 2 and Phase 3 can run in parallel once Phase 1 lands.

### Phase 0 — Fix integration basics (with minimal host preflight)

**Goal.** Make the dogfood path work end-to-end on a virtiofsd-capable host, AND give the operator enough diagnostic signal to distinguish host-setup failure from task failure even within Phase 0. Clear the still-valid subset of the 2026-04-18 test report and make the `abox --capabilities` probe succeed against an unmodified abox binary with an observable, parse-validated acceptance.

**Duration.** ~1 week.

**Key deliverables.**

- **Implement `abox --capabilities` as a top-level flag** in abox-cli. Bypasses config/orchestrator load like `init` and `doctor` already do (`abox/crates/abox-cli/src/main.rs:83-102`). Envelope matches `validateCapabilitiesJson` exactly — three arrays (`protocolVersions`, `taskKinds`, `executionEngines`), no ghost fields. Phase 2 will add `workerInRootfsVersion` after worker extraction.

- **Fix ten bakudo items — eight HEAD-verified, two provisional.** Eight verified against HEAD with file-level reproduction: `--version`/`-V` routing (including `shouldUseHostCli` in `parsing.ts:546-563`); attemptSpec-vs-`request` resume schema mismatch (`executeAttempt.ts:133-138` vs `sessionLifecycle.ts:144-189`); PATH preservation on host-side adapter spawn (`envPolicy.ts:40-77`, `aboxAdapter.ts`); `-p --output-format=json` non-interactive semantics — **without coupling to authority** (no implicit `autoApprove`); `--explain-config` unknown-key validation; `sandbox <id>` dump truncation; error copy on misrouted flags; `cleanup --dry-run` kept-artifacts. Two provisional — implementer re-verifies before starting: `logs` field rendering (F-08), dispatch progress indicator (F-13).

- **Add a minimal host-preflight slice (F-P).** `getcap` on configured virtiofsd and `/dev/kvm` access probe — two checks only. Rootfs presence was considered and deferred to Phase 3 because there is no stable non-brittle way to locate the rootfs from bakudo today (no `abox run --check-only` exists; scraping `abox doctor` text is fragile). Enough to say "this host cannot run abox" *before* a task is misclassified as worker failure. Scoped narrowly — not the Phase 3 deep doctor.

**Exit criterion.** On a virtiofsd-capable host, `bakudo build "add a comment to README.md" --repo <scratch> --yes` returns exit 0, README is modified, `bakudo status` reports `mode=build`, and the integration test invokes public `probeWorkerCapabilities` against the live abox and asserts the probe did not fall back (`outcome.capabilities.source === "probe"`). On a virtiofsd-uncapable host, `bakudo doctor` surfaces a single actionable error naming virtiofsd caps before any dispatch is attempted. `bakudo -p "hello" --output-format=json` produces only JSONL or a single machine-readable error envelope — never a plaintext prompt.

**Dependencies.** None.

**Details.** See `2026-04-18-phase-0-spec.md`.

### Phase 1 — Shared contract package

**Goal.** Turn the bakudo↔abox handshake into a versioned, enforceable contract. Changes to either side must update the shared spec; CI fails otherwise.

**Duration.** ~1 week.

**Key deliverables.**

- A JSON Schema repository at `plans/integration/contract/` (or similar) defining:
  - CLI invocation shape: positional + optional args, task-ID format, `--ephemeral` / `--repo` semantics.
  - `--capabilities` JSON envelope (canonized from Phase 0 — **exactly the three-array shape that lands**).
  - Worker output-line protocol: prefix tokens, line format, field semantics.
  - Exit-code taxonomy **derived from the existing `EXIT_CODES` table in `bakudo/src/host/errors.ts:24-32`** (no collision with Phase 0; Phase 1 canonizes what already exists).
  - Error-attribution buckets: `host_infrastructure_error`, `worker_protocol_error`, `task_failure`, `policy_denial`, `user_cancelled`.
- Generated TypeScript types for bakudo (`bakudo/src/protocol.ts`, `bakudo/src/host/workerCapabilities.ts`).
- Generated Rust crate `bakudo-contract` consumed by abox-cli's `--capabilities` flag, so its output literally cannot drift from the schema.
- A CI job in both repos that regenerates types and fails if the diff is nonempty.
- `just integration-test` extended to parse a live `abox --capabilities` against the schema.

**Exit criterion.** Changing the contract in one repo without updating the schema fails CI in the other. "Works by accident" becomes inaccurate.

**Dependencies.** Phase 0 (its `--capabilities` shape and the existing exit-code taxonomy become schema-canonical).

### Phase 2 — Extract `bakudo-worker` as a package

**Goal.** Eliminate the 28 KB heredoc. Make bakudo-host and bakudo-worker independently versioned, with mismatch detected pre-dispatch — not as a bash-escape error at runtime.

**Duration.** ~2 weeks.

**Key deliverables.**

- Extract `workerCli.js + workerRuntime.js + protocol.js` from the bakudo monolith into a standalone `bakudo-worker` npm package with its own version.
- Add an installation step to abox's guest rootfs build (`abox/guest/install.sh` appends `npm install -g bakudo-worker@<pinned>`).
- Bakudo dispatch becomes `abox run ... -- bakudo-worker --task-spec-b64 <b64>` — payload under 2 KB.
- `abox --capabilities` grows a `workerInRootfsVersion` field (deferred in Phase 0) reporting the actually-installed worker version. Phase 1's schema is updated concurrently.
- Bakudo asserts `workerInRootfsVersion` compatibility pre-dispatch using Phase 1's contract. Mismatch → typed `worker_version_mismatch` error with a recovery hint (`just rebuild-rootfs` or `bakudo upgrade-worker`).

**Exit criterion.** Dispatch payload under 2 KB. A deliberate worker/host version mismatch produces a clean pre-dispatch error with actionable copy — never a runtime parse failure.

**Dependencies.** Phase 0 + Phase 1.

### Phase 3 — Cross-boundary diagnostics (deep doctor)

**Goal.** When the integration breaks, a single command tells the operator exactly which side is broken and what to do about it. This extends Phase 0's preflight slice into a comprehensive check suite; it does **not** bootstrap from nothing.

**Duration.** ~2 weeks.

**Key deliverables.**

- `bakudo doctor --deep` boots a sentinel abox VM and asserts the round-trip end-to-end.
- Deep checks (superset of Phase 0's F-P):
  - virtiofsd file capabilities (already in F-P — extended to report expected vs actual).
  - Host kernel KVM availability and permissions (already in F-P).
  - Rootfs freshness relative to bakudo's pinned worker version (uses Phase 2's `workerInRootfsVersion`).
  - `abox --capabilities` JSON shape matches the Phase 1 schema (not just "is non-empty" — tightens the existing `doctorAboxProbe.ts:58-68` check that currently passes on any non-empty stdout).
  - Host↔guest clock skew bounds.
- Bakudo's review surface grows typed error classes keyed to Phase 1's attribution buckets, each with a persistent recovery-hint string.
- `bakudo chronicle --attribution host_infrastructure_error` becomes a queryable surface.

**Exit criterion.** On each of {virtiofsd-unprivileged, stale-rootfs, worker-version-mismatch, no-KVM, missing-capabilities-probe, empty-but-valid-stdout-from-probe}, `bakudo doctor --deep` produces one actionable line naming exactly which side is broken and what command fixes it.

**Dependencies.** Phase 0 + Phase 1. **Parallel with Phase 2.**

---

## Ordering and parallelism

```
Phase 0  (week 1)              — unblocks dogfood, minimal preflight
   │
   ▼
Phase 1  (week 2)              — formalizes the contract
   │
   ├──► Phase 2  (weeks 3-4)   — worker extraction
   │                            (shrinks dispatch, enables version-pin)
   │
   └──► Phase 3  (weeks 3-4)   — deep doctor + typed errors
                                (extends Phase 0's preflight slice)
```

Total: ~5 weeks if Phase 2 and Phase 3 run concurrently, ~6 weeks serialized.

---

## Why (ii) — detailed Phase 0 spec, roadmap for the rest — over (iii) — spec-everything-now

This document presents the roadmap plus a full spec for Phase 0. It does **not** attempt to fully spec Phases 1–3. The earlier revision's rationale for this choice stands, with one important correction pointed out by the external critique:

1. **Phase 1's schema is informed by Phase 0.** The error-attribution buckets cannot be cleanly specified without knowing which attribution gaps actually matter in the field. Phase 0's host-preflight slice (F-P) and the renewed `--capabilities` probe will both surface specific cases.

2. **Phase 2's version-pin strategy depends on Phase 1's schema shape.** Specifying Phase 2 now means pre-committing to a schema or writing requirements we will need to rewrite.

3. **Phase 3's deep-doctor check list depends on Phase 2's worker-installation pathway.** The concrete check for "worker version in rootfs matches host" depends on where Phase 2 installs the worker — a decision we haven't made.

**Correction from the earlier revision:** Phase 0 DOES need a minimal, written-down contract note for F-00 and the existing exit-code taxonomy before implementation — not a full Phase 1 spec, but a short appendix in the Phase 0 spec capturing the `--capabilities` envelope shape and the exit-code map *as they stand*. The earlier revision punted this to "Phase 1 will canonize" without recognizing that Phase 0's `--capabilities` shape is load-bearing for a week of implementation work, and the exit-code taxonomy already exists at `bakudo/src/host/errors.ts:24-32` and must be referenced (not re-invented) by Phase 0 fixes. See the Phase 0 spec's "Appendix: minimal contract note" section.

What (ii) gives us:
- A roadmap with clear dependencies, durations, and exit criteria.
- One spec — Phase 0 — implementable right now, including an explicit minimal contract note for its load-bearing surfaces.
- A known handoff: once Phase 0 ships, we brainstorm Phase 1 using the evidence Phase 0 generates.

What (iii) would have given us:
- Four documents, the later three of which would be lower-fidelity by construction, and which we'd likely rewrite.

---

## Next brainstorm

When Phase 0 ships:
1. Collect the concrete error-attribution cases that came up during Phase 0 implementation.
2. Enumerate the fields in `abox --capabilities` after Phase 0 stabilization.
3. Brainstorm Phase 1 with that evidence.

Repeat for Phase 2 (after Phase 1 merges) and Phase 3 (after Phase 1 merges; can start in parallel with the Phase 2 brainstorm).

---

## Open questions for future-me

- **Shared contract location?** Phase 1 will decide. Current inclination: `/home/al/git/bakudo-abox/contract/` at the parent level, vendored by both sides.
- **`bakudo-worker` registry?** Phase 2 will decide. Only matters once non-local rootfs builds exist.
- **Does `bakudo doctor --deep` boot a real VM or a mock?** Phase 3 will decide. Likely real VM in `tier-vm`, mocked in `tier-ci`.
- **Is any change to `abox run` CLI surface required?** Currently no. The contract is the `--capabilities` flag + the worker invocation shape; `run --task --ephemeral -- <cmd>` stays stable.
- **Host provisioning for virtiofsd file capabilities and KVM.** Phase 0's F-P detects the problem; it does not solve it. Who owns the "how do I fix this" doc? Open for Phase 0 sub-question.
