# Proposal: coarse origin tags on normalized hotspots

Status: proposal (2026-08-19). Not a contract.

## Problem

Normalized `PerformanceSnapshot` hotspots carry only a bare symbol label, a
source line, and a hashed stable key. In the kubani-gpu-broker field test the
top hotspots read `post`, `send`, `__call__ 1160`, `<module>` — the operator
had to re-profile on the host with full paths to learn that the actionable
cost was framework routing, not repository code. The diagnostic capture could
not guide the optimization loop it exists to serve.

## Constraint that must survive

Sanitization exists because raw profile paths disclose code structure.
Whatever is added must not reintroduce path disclosure: snapshots remain
presentable at the same visibility level as today.

## Design

Add one enum field to the normalized hotspot:

```
origin: "repository" | "dependency" | "runtime" | "unknown"
```

plus, for `dependency` only, the top-level distribution name (`httpx`,
`fastapi`) — a name already public in the pinned dependency lock, so it
discloses nothing new. Classification happens **before** path stripping in
the normalizer, from information the profiler already has:

- path under the worktree → `repository`
- path under site/dist-packages → `dependency` (+ first package segment)
- stdlib/frozen importlib → `runtime`
- anything else → `unknown`

`profile-diff` groups its report by origin, so the first line an operator
reads is "N% of the regression is in repository code" — the question every
investigation starts with.

## Touched contracts (move together)

Hotspot pydantic model, `performance-record` JSON Schema, the normalizer,
`profile_comparison` grouping, `performance profile-diff` output, and the
docs. New field is optional-with-default so persisted snapshots stay valid;
version the normalizer's `analysisVersion` marker.

## Non-goals

Full module paths, source file names, or configurable redaction tiers.
