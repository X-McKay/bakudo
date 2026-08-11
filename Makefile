.PHONY: install lint type test check demo wheel wheel-smoke

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

# Build a vendorable wheel stamped with the git SHA (3.0.0.dev0+<sha>) so pip
# treats every build as a distinct version — a refreshed vendor wheel in a
# target repo then actually reinstalls instead of "already satisfied".
wheel:
	@sha=$$(git rev-parse --short HEAD); \
	sed -i "s/^version = \"3\.0\.0.*\"/version = \"3.0.0.dev0+$$sha\"/" pyproject.toml; \
	pip wheel . -w dist --no-deps -q; \
	git checkout -- pyproject.toml; \
	ls -t dist/bakudo-*.whl | head -1

# API-12 regression guard: build the wheel, install it into a throwaway venv,
# and run `bakudo demo` (offline) + `optimize --help` from an empty cwd.
wheel-smoke:
	BAKUDO_WHEEL_TESTS=1 python3 -m pytest tests/test_wheel_install.py -v
