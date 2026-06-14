.PHONY: install lint type test check demo

install:
	pip install -e ".[dev]"

lint:
	ruff check src tests

type:
	mypy src/bakudo

test:
	pytest

# The full local gate, mirrored by CI (see ci/python-ci.yml).
check: lint type test

demo:
	bakudo demo
