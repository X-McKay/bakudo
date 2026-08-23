# Proposal: the friction ledger — operator interventions become curriculum

Status: proposal (2026-08-19). Not a contract.

## Principle

Every manual operator intervention is a missing mechanism. When an operator
has to hand-edit a pin, retry a command with corrected arguments, clean up a
leftover sandbox, or shell around the CLI, that moment is the highest-signal
input bakudo can collect about its own deficiencies — and today it evaporates
in the operator's terminal history.

(The 2026-08-19 kubani-gpu-broker field test would have seeded five entries:
a fabricated revision SHA accepted late, a hand-authored environment pin,
manual guest probes for onboarding facts, a metric-name typo class caught
only by review, and an invalid host A/B caused by uncommitted state.)

## Design

**Capture** — two channels, both append-only records:

1. *Automatic*: every CLI invocation that exits non-zero after argument
   parsing records `{command, argument shape (no values), error class,
   timestamp}`. No repository content, no secrets, no free text.
2. *Deliberate*: `bakudo friction add "TEXT"` — the operator (or an agent
   acting for one) records an intervention in a sentence. This is the washu
   intervention-ledger move, made first-class.

**Aggregate** — a curriculum collector folds friction records into
observations: repeated error classes and repeated free-text stems become
`maintenance` objectives on the bakudo repository itself, prioritized by
recurrence. The meta-agent's backlog then literally grows out of operator
pain, and the optimization loop already knows how to consume objectives.

**Close the loop** — an objective created from friction carries the record
IDs; when its change merges, the records are marked addressed. `bakudo
friction list` shows open pain ranked by recurrence — the operator-facing
view of "what is bakudo currently worst at".

## Boundaries

- Friction records are operational telemetry, not evidence: they never touch
  trial or performance ledgers and carry no promotion weight.
- Argument *values* are never recorded automatically (paths and refs may be
  sensitive); only shapes and error classes. Free text is deliberate speech.
- Local-first: records live in the durable ledger when configured, else in a
  local append file; nothing leaves the machine.

## Phasing

1. Convention only (now): a `friction` heading in operator notes; zero code.
2. `bakudo friction add/list` + the non-zero-exit hook.
3. The curriculum collector + objective linkage.
