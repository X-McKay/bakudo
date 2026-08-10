.PHONY: install lint type test check demo wheel kubeconfig

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

# Bootstrap a repo-scoped kubeconfig at .kube/config (gitignored): a flattened
# copy of one host context, renamed to "bakudo". With KUBECONFIG pointed here
# (sourcing .env does it), kubectl reads/writes ONLY this file — local testing
# can never switch contexts on, or otherwise mutate, ~/.kube/config.
# Override the source context with KUBE_SRC_CONTEXT=<name>.
kubeconfig:
	@src=$${KUBE_SRC_CONTEXT:-default}; \
	mkdir -p .kube; \
	kubectl config view --minify --flatten --context="$$src" > .kube/config; \
	chmod 600 .kube/config; \
	KUBECONFIG=$(CURDIR)/.kube/config kubectl config rename-context "$$src" bakudo >/dev/null; \
	KUBECONFIG=$(CURDIR)/.kube/config kubectl config use-context bakudo >/dev/null; \
	echo "wrote .kube/config (context 'bakudo' from host context '$$src')"; \
	echo "activate with: export KUBECONFIG=$(CURDIR)/.kube/config  (or source .env)"

# Build a vendorable wheel stamped with the git SHA (3.0.0.dev0+<sha>) so pip
# treats every build as a distinct version — a refreshed vendor wheel in a
# target repo then actually reinstalls instead of "already satisfied".
wheel:
	@sha=$$(git rev-parse --short HEAD); \
	sed -i "s/^version = \"3\.0\.0.*\"/version = \"3.0.0.dev0+$$sha\"/" pyproject.toml; \
	pip wheel . -w dist --no-deps -q; \
	git checkout -- pyproject.toml; \
	ls -t dist/bakudo-*.whl | head -1
