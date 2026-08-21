# Product-agent process protocol v1

`bakudo product-agent run` is Bakudo's smallest stable black-box execution
boundary. It accepts one instruction and one staged source checkout, runs one
packaged implementation agent in abox, and publishes a candidate patch plus
process metadata. It does **not** select a benchmark, run a Bakudo evaluator,
score the candidate, compare it with a baseline, or decide whether to promote
it.

That separation is deliberate: a benchmark harness can invoke this command as
the product under test, then apply and evaluate `candidate.patch` in a fresh,
harness-owned environment. Product changes cannot receive hidden tests or
expected answers through this interface.

## Command

```bash
bakudo product-agent run \
  --protocol v1 \
  --workspace /absolute/path/to/staged-bakudo \
  --instruction-file /absolute/path/to/instruction.md \
  --output-dir /absolute/path/to/new-output-directory
```

All three paths must be absolute and pairwise non-overlapping. The output path
must not exist, and its parent must already exist. On a successful protocol
invocation, Bakudo atomically renames a complete temporary directory into the
requested output path; consumers never observe one final artifact without the
other.

The instruction must be a regular, non-symlink UTF-8 file of at most 2 MiB and
must not contain NUL. The workspace must be the root of a clean Git checkout at
an exact SHA-1 commit. V1 accepts at most 20,000 tracked regular files and 512
MiB of tracked content. Paths must be safe UTF-8 of at most 4,096 bytes. Links,
submodules, ignored/untracked files, untracked directories, and special files
outside `.git` are rejected before execution.

## Deliberately narrow v1 compatibility

V1 supports only a self-hosted Bakudo source checkout:

- `pyproject.toml` must declare project name `bakudo`;
- `src/bakudo/__init__.py` must exist;
- the only tracked `.abox` files may be `project.toml` and executable
  `prepare.sh`; and
- those two files must byte-match the compatibility templates packaged by the
  Bakudo candidate executing the command.

This is a **self-host compatibility check, not independent trust or release
attestation**. A candidate can change both its runtime code and its packaged
templates. The check only prevents the v1 implementation from silently
executing a generic task-owned abox policy that it was not designed to accept.
Generic target repositories are unsupported in v1. A later protocol should
stage a harness-owned execution policy or a separately pinned, independently
verified workspace rather than weakening this check.

The command resolves `abox` to an absolute executable, requires its reported
version to be exactly `0.7.2` (prereleases do not match), fixes the sandbox base
to the validated commit, and uses the packaged `add-feature@1` AgentSpec. The
run remains on the spec's scoped network policy. Model endpoint variables
required by the packaged runtime may be forwarded, but behavior-changing
`ABOX_*` variables and these Bakudo overrides are rejected:

```text
BAKUDO_ABOX_SKIP_VERSION_CHECK
BAKUDO_ALLOW_NETWORK_OPEN
BAKUDO_BASE_REF
BAKUDO_ENV
BAKUDO_OFFLINE
BAKUDO_REPO_ROOT
BAKUDO_SANDBOX
```

## Output contract

The final directory contains exactly:

```text
output/
├── candidate.patch
└── result.json
```

`candidate.patch` is an applyable `git diff --binary --full-index` artifact.
Tracked and untracked regular-file changes are collected host-side relative to
the staged base. Collection fails closed on Git errors, unsafe/non-UTF-8 paths,
links that enter the patch, the AgentSpec changed-file limit, or the 16 MiB
hard patch limit. Changes to `.abox` or `.agent` are output-policy violations.

`result.json` validates against
`schemas/product-agent-v1.schema.json`. Its complete top-level shape is:

```json
{
  "schema": "bakudo.product-agent/v1",
  "run_id": "run_...",
  "status": "completed",
  "reason_code": null,
  "patch": {
    "path": "candidate.patch",
    "format": "git-diff-binary-v1",
    "digest": "sha256:...",
    "size_bytes": 123,
    "changed_files": ["src/example.py"]
  },
  "usage": {
    "wall_time_ms": 1000,
    "tokens": 100,
    "model_calls": 1,
    "tool_calls": 4,
    "denied_commands": 0
  },
  "runtime": {
    "bakudo_version": "3.0.0",
    "agent_ref": "add-feature@1",
    "agent_spec_digest": "sha256:...",
    "skills_digest": "sha256:...",
    "abox_version": "0.7.2",
    "attested": false
  }
}
```

Allowed statuses are `completed`, `blocked`, `failed`, `timed_out`, and
`cancelled`. A completed result has a null reason. Other results use one of the
closed reason codes in the schema and always publish an empty patch with no
changed files, so a consumer cannot accidentally apply a partial candidate.

The public envelope intentionally contains no agent prose, test claims, score,
reward, verdict, pass flag, scorecard, or evaluation evidence. `runtime` and
`usage` are runner-observed diagnostics, not attestations. In a self-hosted
benchmark the candidate contains the host-side code that validates inputs,
launches abox, and writes both artifacts. The candidate process itself can
therefore establish neither containment nor attestation. A trusted outer
harness must run the **entire candidate CLI** in an evaluator-owned sandbox
that exposes only the public staged workspace and instruction plus a dedicated
output mount. It must withhold the hidden corpus, evaluator credentials,
control sockets, host filesystem, and unrestricted network; independently pin
the candidate, meter time/resources, and validate both artifact digests.

Treat `candidate.patch` as untrusted input. Apply it only to a disposable task
checkout, inject hidden tests afterward from a read-only evaluator-owned
source, and run a fixed evaluator command without secrets. Do not invoke
candidate-owned CI workflows or apply the patch to the evaluator/control
checkout. These outer controls—not `attested: false` metadata produced by the
candidate—grant benchmark trust.

## Process behavior

No output is published when input or runtime preflight fails. After preflight,
a sandbox launch failure is represented by a valid failed result when enough
runtime identity is known. A successful protocol publication returns process
exit code 0 even when `result.json.status` is non-completed; the status is part
of the versioned data contract rather than an overloaded shell exit code.
Input/configuration errors return 2 and unexpected launch/protocol errors
return 1, with diagnostics on stderr.

SIGTERM and SIGINT set the same cancellation event used by `AboxRunner`. An
event set before launch prevents the abox sandbox run from starting. After a
running process exits due to cancellation, the runner skips result and patch
collection, reports `cancelled`, and still executes bounded
`abox stop --clean` cleanup for its VM, worktree, and branch.
