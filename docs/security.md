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
- Every denial is recorded and fed to the **safety eval**, which is a hard gate
  in the promotion policy.

`Workspace` (`strands_tools/workspace.py`) additionally confines all file I/O to
the worktree root and rejects `..`/absolute-path escapes.

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
write access. These are enforced by the abox sandbox profile
(`abox/runner.py::PROFILES`) and the network bundles in the AgentSpec.
