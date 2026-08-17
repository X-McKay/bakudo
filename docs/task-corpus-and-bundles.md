# Task corpora and published bundles

Bakudo core owns the experiment substrate; benchmark data is a separate,
versioned product. This keeps privileged evaluator material out of the runtime
repository and lets the corpus evolve under its own review and access policy.

## Ownership boundaries

| Location | Owns |
|---|---|
| Bakudo core | Schemas, typed contracts, task-source loaders, deterministic provisioning, verifier protocols, bundle publication/loading, trial/experiment orchestration, statistics, persistence, and two smoke tasks |
| Private `bakudo-benchmarks` repository | Versioned task manifests, fixtures, reference solutions, privileged verifier inputs, negative controls, provenance, digest lock, and corpus-level CI |
| Published artifact store | Immutable content-addressed task bundles consumed at runtime |

Core deliberately ships exactly two paired smoke tasks under `smoke/tasks/`.
They test packaging and end-to-end wiring; they are not the benchmark corpus.

## Corpus layout

```text
bakudo-benchmarks/
  corpus.yaml
  digests.lock
  tasks/
    example-task/
      task.yaml
      fixture/
      verifier/
      reference/
        solution.patch
        negative-control-*.patch
```

`corpus.yaml` gives the corpus a name and immutable revision. `digests.lock`
maps every `name@version` to its canonical `sha256:` bundle digest. Changing
any file in an existing task requires a task-version bump; changing the corpus
selection or metadata requires a corpus-revision bump.

## Runtime sources

`TaskSource` is the storage-neutral read port. Core currently implements:

- `DirectoryTaskSource` for a corpus checkout or a flat task directory;
- `ArchiveTaskSource` for one locally cached published bundle.

Set `BAKUDO_TASK_SOURCE` to a local path or `file:` URI. A directory may be a
corpus root containing `tasks/`, or the task directory root itself. A file is
treated as a published archive. Network retrieval is intentionally outside the
domain loader: fetch and verify remote artifacts into a local
content-addressed cache, then give Bakudo the cached path.

With no setting, Bakudo uses the two packaged smoke tasks.

## Publication and consumption

```bash
# Work against a private corpus checkout.
export BAKUDO_TASK_SOURCE="$HOME/git/bakudo-benchmarks"

bakudo task list --json
BAKUDO_ENV=dev bakudo task verify rate-limiter-fix --json

# Create an authoring skeleton in the corpus, never in core.
bakudo task scaffold new-task --family debugging \
  --root "$BAKUDO_TASK_SOURCE/tasks"

# Publish and validate an immutable bundle.
bakudo task publish rate-limiter-fix --output ./artifacts
bakudo task inspect-bundle ./artifacts/<bundle-sha256>.tar
```

Publication writes a deterministic USTAR archive named from the task's bundle
digest. `bundle.json` records the originating corpus URI/revision, task
name/version, bundle digest, and verifier digest. Loading rejects path
traversal, missing members, identity mismatches, and digest mismatches.

## Trial provenance

Every `TrialRecord` embeds a `TaskPin` with:

- `source_uri` — the exact directory or archive source used at runtime;
- `corpus_revision` — the versioned corpus selection;
- `name` and `version` — logical task identity;
- `bundle_digest` — digest of every task file;
- `verifier_digest` — digest of verifier/constraint configuration and all
  privileged verifier inputs.

Runtime/model pins remain in `TrialRecord.runtime_pins`. Keeping them separate
makes it possible to compare a fixed task under different runtime stacks while
still proving exactly which evaluator was used.

## Corpus CI

The benchmark repository's CI consumes Bakudo through public ports only. It:

1. validates every schema and referenced member while loading the source;
2. checks `digests.lock` for in-place mutation;
3. verifies pristine, reference-solution, pass-to-pass, negative-control,
   instruction-leak, and deterministic-provisioning invariants;
4. checks that every `pairedTask` target exists;
5. publishes and reloads every content-addressed bundle.

Core tests exercise the same components in isolation and use only the two
smoke tasks for packaged integration checks.
