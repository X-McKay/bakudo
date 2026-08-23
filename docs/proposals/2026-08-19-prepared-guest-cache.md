# Proposal: prepared-guest amortization for measurement sandboxes

Status: proposal (2026-08-19). Not a contract.

## Problem

Every measurement invocation boots a fresh abox guest and runs the target
repository's `.abox/prepare.sh` before the timed command. In the
kubani-gpu-broker field test the prepare step (hermetic wheel install,
~10-20s) dominated wall clock: a 24-repetition compare spent ~50 minutes of
guest time on ~40 seconds of measured workload. Prepare cost is not timed
evidence, but it linearly throttles how many candidates a lab can test.

## Constraint that must survive

Fresh-guest isolation is the trust property: no state from one invocation may
influence another's timing, and nothing outside the pinned inputs may enter
the guest. Any amortization must be provably input-pinned.

## Design sketch

A **prepared-environment layer**, keyed by the content identity of what
prepare consumes:

```
prepare_key = sha256(prepare.sh bytes || sorted(wheel digests) ||
              requirements bytes || guest image digest || abox version)
```

- On first use, a builder guest runs `prepare.sh` and the layer (the
  filesystem delta, e.g. installed site-packages) is captured and stored
  content-addressed under the abox cache root.
- Subsequent guests for the same `prepare_key` mount the layer read-only and
  skip prepare entirely. The timed command never observes a difference: the
  same bytes are present either way.
- The `EnvironmentPin` gains an optional `preparedLayerDigest`; a comparison
  is only pin-compatible when both sides used the same layer (or both used
  none). The digest makes cache poisoning an integrity violation rather than
  a silent hazard.

## Division of labor

- **abox** owns layer capture, storage, and read-only mounting (natural
  extension of `abox env warm`).
- **bakudo** owns the key derivation, the pin field, schema + comparison
  compatibility, and a `doctor` check that the layer store is intact.

## Non-goals

- Reusing a *guest* across invocations (violates isolation).
- Caching anything the workload writes (layers are prepare-output only).

## Open questions

1. Does abox's snapshot mechanism already capture post-prepare deltas
   (0.7.x `env warm`), or is new abox work required?
2. Layer invalidation on abox upgrades: is `aboxVersion` in the key enough?
3. Should a compare refuse mixed cached/uncached sides even when digests
   match? (Proposed: yes — schedule symmetry is cheap to keep absolute.)
