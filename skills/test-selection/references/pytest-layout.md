# pytest layout conventions

- Test files are named `test_*.py` and live under `tests/` or beside the module.
- A test for `src/pkg/foo.py` is conventionally `tests/test_foo.py`.
- `pytest -q` runs the whole suite; `pytest tests/test_foo.py::test_case` runs one.
- Markers (`@pytest.mark.slow`) can gate expensive suites; prefer fast tests first.
- Shared fixtures live in `conftest.py` at the nearest common ancestor directory.
