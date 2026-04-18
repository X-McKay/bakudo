# bakudo config

bakudo reads configuration from a 5-source cascade. Later sources win per key.

## Cascade (lowest to highest priority)

1. Compiled defaults — shipped in the binary.
2. User config — `~/.config/bakudo/config.json` (XDG).
3. Repo config — `./.bakudo/config.json` (repo-local).
4. `$BAKUDO_CONFIG` — explicit override file from the environment.
5. CLI flags — `--mode`, `--yes`, etc.

Each layer is validated independently; invalid layers are dropped with a
single-line stderr warning and do not fail bakudo. Arrays concatenate
between layers except `retryDelays`, which replaces.

## Recognized keys

- `mode` — `"standard" | "plan" | "autopilot"`. Default `"standard"`.
- `autoApprove` — boolean. Force `--yes` semantics.
- `logLevel` — `"none" | "error" | "warning" | "info" | "debug" | "all" | "default"`.
- `experimental` — boolean OR `Record<string, boolean>` keyed by flag name.
  `true` enables the whole cluster; a record toggles features individually.
  See `/experimental show` for the current registry.
- `flushIntervalMs` — number. Event-log flush cadence.
- `flushSizeThreshold` — number. Event-log flush size trigger.
- `retryDelays` — number[]. Host-side retry backoff tuple.
- `agents` — record of agent profiles: `{ description, permissions, hidden, subagent }`.

## Environment-variable equivalents

- `BAKUDO_CONFIG` — path to an explicit override JSON file (layer 4).
- `BAKUDO_STORAGE_ROOT` — override the session storage directory.
- `NO_COLOR` — disable ANSI colors (affects renderer selection).
- `XDG_CONFIG_HOME` — overrides `~/.config` for the user-config path.
- `BAKUDO_EXPERIMENTAL=all` — enables every experimental feature for the
  current session (cluster gate; overridden by per-feature vars).
- `BAKUDO_EXPERIMENTAL_<FLAG>` — enables or disables a single flag
  (`1`/`true`/`on`/`yes` vs. `0`/`false`/`off`/`no`). Beats the cluster.

## Inspect the merged cascade

```
bakudo
/config show
```

`/config show` prints every key, its resolved value, and the layer that
provided it. Use it whenever config behavior surprises you.

## Companion paths

- `~/.config/bakudo/keybindings.json` — user keybindings (see
  `bakudo help monitoring` for doctor diagnostics).
- `~/.local/share/bakudo/sessions/` — per-repo session history.
- `./.bakudo/` — repo-local state (approvals, provenance, session files).
