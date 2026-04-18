# bakudo permissions

Permission rules gate sandbox operations. Bakudo enforces a strict
deny-precedence invariant: a `deny` rule always wins over an `allow`
rule, no matter where it came from or how it merged in.

## Rule grammar

Each rule has:

- `effect` — `"allow" | "ask" | "deny"`.
- `tool` — canonical tool name (`"shell"`, `"network"`, `"fs"`, `"*"`).
- `pattern` — glob against the tool argument. `**` spans path separators.
- `scope` — `"once" | "session" | "always"`.
- `source` — origin label (`"repo_config"`, `"user_interactive"`, ...).
- `ruleId` — deterministic FNV-1a hash; synthesized on read when missing.

Example JSON:

```
{
  "effect": "deny",
  "tool": "network",
  "pattern": "https://internal.example.com/**",
  "scope": "always",
  "source": "repo_config"
}
```

## Deny-precedence invariant (load-bearing)

The invariant is tested in `tests/unit/denyPrecedence.test.ts` with 9
deny-wins cases plus 4 merge-preserves-deny cases. Any change to rule
evaluation or rule-set merging MUST preserve it.

- A single `deny` rule beats any number of `allow` rules regardless of
  order.
- `/allow-all on` does NOT bypass deny. It writes a broad-allow rule;
  deny rules still fire first.
- Cascading configs preserve deny across layers.

## Merge semantics

Rules from multiple config layers are merged additively. Duplicate
`ruleId`s dedup; `deny` rules are preserved first during merge to
guarantee the invariant at the API boundary (`mergePermissionRules`).

## `/allow-all on|off|show`

- `/allow-all on` — write a session-scoped universal allow rule.
  Prints the mandatory deny-precedence warning every time.
- `/allow-all off` — remove broad-allow rules from the durable allowlist.
- `/allow-all show` — dump the current durable allowlist.

## Durable allowlist

Persisted at `<repo>/.bakudo/approvals.jsonl` (NDJSON). Rules with
`scope: "always"` end up here; session-scoped rules live in the
per-session approval store and are removed when the session closes.

## Related

- `bakudo help hooks` — auto-approve hooks.
- `bakudo help sandbox` — how the sandbox enforces rules at dispatch.
