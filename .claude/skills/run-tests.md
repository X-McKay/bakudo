# Skill: Run tests and checks in bakudo

## Trigger

When verifying correctness of the `bakudo` repository, after making changes, or
before committing.

## Steps

bakudo is a Python project (`src/` layout, package `bakudo`). The control-plane
domain logic runs with only the light core deps — no Temporal/Postgres/Neo4j/
abox/vLLM are needed for the suite.

```bash
pip install -e ".[dev]"     # first time only
ruff check src tests        # lint
python3 -m pytest           # full suite (fast, in-process)
```

Smoke-check the operator surface and the offline run pipeline:

```bash
bakudo validate-spec agents/add-feature.yaml
bakudo skills
bakudo demo                 # bundle -> local sandbox -> result.json -> eval -> scorecard
```

## Notes

- The local sandbox (`abox/local.py`) and the offline driver (`runner/agent.py`)
  let the whole run lifecycle run without a model or microVM. Set
  `BAKUDO_OFFLINE=1` to bypass the model.
- Temporal workflow code (`src/bakudo/temporal/workflows.py`) requires the
  `temporal` extra; it is intentionally not imported by the core package or the
  test suite.
- Keep `result.json`, `Objective`, `AgentSpec`, and `EvalResult` changes in sync
  with `schemas/*.schema.json` — those JSON Schemas are the cross-language
  source of truth and are validated at the trust boundaries.
