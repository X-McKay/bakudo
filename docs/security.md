# Security model

bakudo's safety rests on a hard separation between a trusted control plane and
untrusted worker agents, plus defence-in-depth around every capability. This
maps spec §19 and §27 onto the implementation.

## Principles (spec §19.1)

- The meta-agent can schedule and evaluate, but **cannot execute arbitrary repo
  code**. Its tool surface (`control/tools.py`) has no shell, filesystem, or
  arbitrary network tool.
- Worker agents execute code **only inside abox** microVMs.
- Secrets stay host-side or behind scoped egress injection. AgentSpecs carry a
  `baseUrlRef` / secret *reference*, never an inline secret (`agent_spec`,
  `runner/agent.py::_resolve_base_url`).
- Every tool, MCP server, and skill is allowlisted per agent (the AgentSpec is
  the allowlist; `SkillRegistry` enforces the skill allowlist).
- Every network destination is policy-scoped (`sandbox.networkBundles`).
- Every run has a budget, timeout, and kill path (`Budget`, the `cancel`
  signal, abox timeout enforcement).
- Every self-modification is candidate-only until eval promotion.

## Defence in depth on commands

abox is the real isolation boundary. On top of it, the `run-command`/`run-tests`
tools enforce an in-process `CommandPolicy` (`strands_tools/policy.py`):

- `repo-safe` allowlists the common read/build/test toolchain and blocks
  destructive, privilege-escalating, and exfiltration-prone patterns.
- `read-only` is used by the `explore`/`critic`/`optimize-scout` roles.
- Both additionally reject the interpreter inline-exec bypasses of the argv[0]
  allowlist (`python -c`, `bash -c`, `node -e`, `find -exec`, …) parsed from the
  argv, so tabs/quoting can't smuggle arbitrary code past an allowlisted
  program.
- Every denial is recorded and fed to the **safety eval**, which is a hard gate
  in the promotion policy.

This in-process policy is **defence-in-depth, not a jail**: it stops the naive,
cheap bypasses, but the hard boundary is abox. Programs like `make`/`npm`/`git`
can still run project-defined code by design; only the microVM and its network
policy contain that.

`Workspace` (`strands_tools/workspace.py`) additionally confines all file I/O to
the worktree root, rejects `..`/absolute-path escapes, and refuses to write
through a final symlink. This is the only filesystem guard in the
in-process `local` dev sandbox; production runs rely on abox's filesystem
isolation.

## abox binary identity

The production sandbox is only a microVM because `argv[0]` resolves to a real
abox binary. Before its first run, `AboxRunner` probes `abox --version` and
fails closed (`AboxError`) unless the output identifies abox — turning a
mis-pathed or wrong binary from a silent host-subprocess downgrade into a loud
boot-time error. Set `BAKUDO_ABOX_SKIP_VERSION_CHECK=1` only if a specific abox
build's `--version` output is unrecognised.

## Sandbox policy sources

The AgentSpec's `sandbox.profile` is an opaque configuration and provenance
label; Bakudo does not maintain a second in-process profile registry. Enforced
controls come from the microVM boundary and allowed commands/filesystem in the
repo's `.abox/project.toml`, the run-level `networkMode` and timeout, and the
task and AgentSpec constraints evaluated by the trusted control plane.
`AboxRunner` refuses `networkMode: open` unless the operator sets
`BAKUDO_ALLOW_NETWORK_OPEN=1`; scoped bundles and domains remain repo-owned.

## Human-gated actions (spec §19.2, §27.2)

The promotion engine routes a candidate to `needs_human` (never auto-promotes)
for: broader network access, new credential access, production-write tools, and
self-modifying the meta-agent. See `evals/promotion.py::HUMAN_GATED_MUTATIONS`.

Other human-gated actions enforced operationally: deleting/rewriting durable
memories, changing the promotion policy, and merging high-risk code.

## Memory safety (spec §14.5)

Unverified memories never become facts. `memory/policy.py` rejects candidates
that lack evidence, are too broad/short, are low-confidence, duplicate stronger
memories, or contain secrets (the secret detectors block common key formats).

## Sandbox restrictions (spec §19.3)

Worker agents must not have: unrestricted LAN access, raw host filesystem
access, raw secret access, unrestricted package installation, unrestricted
outbound HTTP, direct access to production systems, or control-plane database
write access. These are enforced by **abox** — its microVM boundary and the
repo-owned `.abox/project.toml` (allowed commands, filesystem, package
registries) — plus the run-level `--network` mode from the AgentSpec (which
replaces the project's default mode per run; `open` is refused by `AboxRunner`
without the explicit `BAKUDO_ALLOW_NETWORK_OPEN=1` opt-in, and even then still
denies host/private/metadata ranges). Note that spec `networkMode: none` maps
to abox `safe`, which is *host-mediated egress*, not a loopback-only guest: a
cooperating client inside the guest can still reach host-managed domains
through the audited abox proxy, so `none` means "no repo-approved egress",
not "zero egress".

## Workload measurement and diagnostic capture

Target-repository performance evidence is a separate trust domain from agent
evaluation:

- A `WorkloadSpec` uses a shell-free argv and a verified immutable
  `WorkloadPin`; traversal, symlink, undeclared-file, digest, and size checks
  fail before execution.
- Every warmup, measured invocation, and diagnostic capture starts in a fresh
  abox guest at an exact `RevisionPin` and `EnvironmentPin`. Target code never
  runs in the trusted control plane.
- Timed `MeasurementRecord` invocations never enable a profiler. Instrumented
  captures create a distinct `PerformanceSnapshot`; capture duration and raw
  profiler output cannot satisfy a comparison or promotion gate.
- Raw diagnostic artifacts are bounded, content-addressed, digest-verified,
  and stored below the explicitly configured restricted artifact root.
  Normalizers bound hostile output and expose only typed hotspots/warnings.
- `PerformanceComparison` recomputes summaries from raw samples, rejects
  profiled or incompatible environments, and treats missing/non-finite/failed
  evidence and integrity violations as contagious.
- Temporal requests carry the retrievable workload source separately from the
  immutable pin and verify the loaded bytes again in the worker. Retry-stable
  IDs make persistence idempotent and collision checks reject changed inputs.

Software-artifact experiments preserve these boundaries: observations carry
only persisted `MeasurementRecord` IDs, not target-controlled summaries.
