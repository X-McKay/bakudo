# bakudo monitoring

## Log levels

bakudo recognizes the levels: `none`, `error`, `warning`, `info`,
`debug`, `all`, `default`. Configure via the cascade (`logLevel` key)
or the `BAKUDO_LOG_LEVEL` environment variable.

- `none` — suppress all diagnostic logs.
- `error` / `warning` — failure paths only.
- `info` (default under `default`) — lifecycle events.
- `debug` / `all` — verbose tracing. Use sparingly; may reveal prompt
  content.

## Startup profiler

The startup profiler (`src/host/startupProfiler.ts`) records elapsed
times per bootstrap phase. Enable with `BAKUDO_PROFILE_STARTUP=1`;
the report is printed to stderr at the end of bootstrap.

## `bakudo doctor`

Run `bakudo doctor` to emit a status report of the host environment.
The command checks:

- Node version vs `.mise.toml` / `package.json#engines.node`.
- abox availability + capabilities (via spawn probe).
- Repo writeability (`<repo>/.bakudo/`).
- Terminal capability (TTY, ANSI, `NO_COLOR`, `COLORFGBG`).
- Active renderer backend (`tty` / `plain` / `json`).
- Active agent profile.
- Config cascade paths actually read.
- User keybindings file path and reserved-shortcut conflicts.
- Telemetry status (stubbed until Phase 6).

Use `bakudo doctor --output-format=json` for automation-friendly output.

## Event log

bakudo persists a structured event log at
`<repo>/.bakudo/events/<session>.ndjson` — one JSONL envelope per line.
The envelope schema is versioned (`schemaVersion`) so new kinds can
appear without breaking older consumers.

## Sessions store

`~/.local/share/bakudo/sessions/` (XDG) holds the per-repo session
history. Each session lives in its own subdirectory; `.bakudo/`
inside the repo holds anything repo-local (approvals, provenance, turn
records).

## Phase 6 roadmap

Real OpenTelemetry instrumentation, heap snapshots, and repro tooling
are scheduled for Phase 6. Today's stub in `bakudo doctor` keeps the
envelope shape stable so downstream dashboards can key on it without
churning when the real wiring lands.
