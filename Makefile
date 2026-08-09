.PHONY: install lint type test check demo

install:
	pip install -e ".[dev]"

lint:
	ruff check src tests

# python -m avoids picking up a stale mypy/pytest that shadows the venv's on
# PATH (observed with a ~/.local/bin mypy from another toolchain).
type:
	python3 -m mypy src/bakudo

test:
	python3 -m pytest

# The full local gate, mirrored by CI (see .github/workflows/ci.yml).
check: lint type test

demo:
	bakudo demo
