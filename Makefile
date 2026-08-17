PYTHON ?= python3

.PHONY: install doctor lint type test check demo wheel wheel-smoke

install:
	$(PYTHON) -m pip install -e ".[all,dev]"

doctor:
	BAKUDO_OFFLINE=1 $(PYTHON) -m bakudo.cli doctor

lint:
	$(PYTHON) -m ruff check src tests skills

# python -m keeps every tool on the same interpreter/environment.
type:
	$(PYTHON) -m mypy src/bakudo

test:
	$(PYTHON) -m pytest

# The full local gate, mirrored by CI (see .github/workflows/ci.yml).
check: lint type test

demo:
	bakudo demo

# Build without modifying tracked files. Use pip --force-reinstall when
# replacing another local build with the same development version.
wheel:
	$(PYTHON) -m pip wheel . -w dist --no-deps -q

# API-12 regression guard: build the wheel, install it into a throwaway venv,
# and run `bakudo demo` (offline) + `optimize --help` from an empty cwd.
wheel-smoke:
	BAKUDO_WHEEL_TESTS=1 $(PYTHON) -m pytest tests/test_wheel_install.py -v
