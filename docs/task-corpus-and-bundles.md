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

## Public-source calibration provenance

An imported public task must carry `metadata.provenance.publicSource` with the
source dataset URI/revision and instance ID, repository URI/license/base commit,
OCI image digest, acquisition time, transform digest, and an approved rights
review. The runtime validates this structured metadata, and makes a public
source task **development-only** and `eligibleForPromotion: false`; it cannot
be reclassified as validation or holdout evidence by editing corpus YAML.

The source record contains digests, never a reference patch or privileged test
patch. Keep those inputs in the restricted artifact store while validating the
adapter. A public import may become a useful calibration task only after its
image can be reproduced and the normal pristine/reference/negative-control
checks pass. A public task never becomes a sealed holdout merely because its
bundle was kept private.

## Restricted-partition exposure provenance

Validation and holdout task identities are not public calibration material.
Before a restricted benchmark evaluation starts, the control plane records an
append-only `EvaluationExposureRecord` in the exposure ledger. It identifies
the experiment, corpus URI/revision, exact frozen task pins (including their
restricted partition), baseline and candidate refs, requesting principal, and
authorization reference—but never
task content, verifier output, rewards, or a `TrialRecord`.

The contract accepts only two stages:

- `validation-selection` for the restricted validation partition, where more
  than one candidate may be compared;
- `holdout-confirmation` for the holdout partition, where exactly one
  pre-registered candidate may be compared with its baseline.

This is an access/provenance audit, not execution or promotion evidence. A
`TrialRecord` and its independent verifier still establish episode outcomes;
the promotion policy evaluates those outcomes separately. The exposure ledger
exists to make tuning, confirmation, and holdout access reviewable without
leaking restricted benchmark material into public calibration datasets.

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
