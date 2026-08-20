PYTHON ?= python3
UV ?= uv
TEMPORAL_NAMESPACE ?= default

.PHONY: install doctor lock schemas format lint type test test-unit test-integration test-live test-performance test-performance-temporal-live test-performance-live check smoke ci demo wheel wheel-smoke

install:
	$(PYTHON) -m pip install -e ".[all,dev]"

doctor:
	BAKUDO_OFFLINE=1 $(PYTHON) -m bakudo.cli doctor

# The repository carries a uv lockfile.  `uv lock --check` is deliberately
# separate from installation so developers using another environment manager
# can still run the hermetic gate, while CI can require the pinned graph.
lock:
	$(UV) lock --check

schemas:
	$(PYTHON) scripts/generate_performance_schemas.py --check

format:
	$(PYTHON) -m ruff format --check src tests skills scripts

lint:
	$(PYTHON) -m ruff check src tests skills scripts

# python -m keeps every tool on the same interpreter/environment.
type:
	$(PYTHON) -m mypy src/bakudo

test:
	$(MAKE) test-unit

# The current suite intentionally combines pure unit tests with hermetic
# component/in-memory-adapter tests.  Both are safe on every developer and CI
# machine: external-service and abox tests are excluded by their markers.
test-unit:
	BAKUDO_OFFLINE=1 $(PYTHON) -m pytest -m "not live and not live_abox"

# A focused, infrastructure-free composition tier for the workload,
# measurement, profiler, and observability boundaries.  It is safe to run in
# ordinary CI; it does not start Temporal, Postgres, FalkorDB, or abox.
test-integration: test-performance

# Opt-in service integration tier.  Individual tests remain capability-gated
# by their documented environment variables, so an unavailable service is
# skipped rather than made a requirement of the default gate.
test-live:
	$(PYTHON) -m pytest -m live

# Fast, infrastructure-free gate for the performance/workload substrate.
test-performance:
	$(PYTHON) -m pytest \
		tests/test_performance_*.py \
		tests/test_workload_*.py \
		tests/test_measurement_*.py \
		tests/test_profile_*.py \
		tests/test_profiler_*.py \
		tests/test_abox_measurement.py \
		tests/test_abox_profile_capture.py \
		tests/test_artifact_experiment.py \
		tests/test_observability_*.py

# Hosted Temporal smoke with synthetic workload execution (no KVM required).
test-performance-temporal-live:
	@test -n "$(TEMPORAL_ADDRESS)" || (echo "TEMPORAL_ADDRESS is required" >&2; exit 2)
	$(PYTHON) scripts/temporal_performance_smoke.py \
		--address "$(TEMPORAL_ADDRESS)" \
		--namespace "$(TEMPORAL_NAMESPACE)"

# Complete opt-in infrastructure gate: hosted Temporal plus real abox/KVM.
test-performance-live: test-performance-temporal-live
	ABOX_LIVE=1 $(PYTHON) -m pytest \
		tests/test_abox_live.py \
		tests/test_experiment_live.py

# The hermetic local gate.  `ci` adds the lock, operator smoke, and wheel
# isolation checks used by GitHub Actions (see .github/workflows/ci.yml).
check: schemas format lint type test

smoke:
	BAKUDO_OFFLINE=1 $(PYTHON) -m bakudo.cli doctor --json
	BAKUDO_OFFLINE=1 $(PYTHON) -m bakudo.cli agent validate agents/add-feature.yaml
	BAKUDO_OFFLINE=1 $(PYTHON) -m bakudo.cli agent validate agents/optimize-scout.yaml
	BAKUDO_OFFLINE=1 $(PYTHON) -m bakudo.cli agent validate agents/optimize-attempt.yaml
	BAKUDO_OFFLINE=1 $(PYTHON) -m bakudo.cli skill list --json
	BAKUDO_OFFLINE=1 $(PYTHON) -m bakudo.cli demo --json
	BAKUDO_OFFLINE=1 $(PYTHON) -m bakudo.cli workload list --json
	$(PYTHON) -m bakudo.cli optimize --help

# Keep this target byte-for-byte aligned with the GitHub Actions quality job.
ci: lock check smoke wheel-smoke

demo:
	bakudo demo

# Build without modifying tracked files. Use pip --force-reinstall when
# replacing another local build with the same development version.
wheel:
	$(PYTHON) -m pip wheel . -w dist --no-deps -q

# API-12 regression guard: build the wheel, install it into a throwaway venv,
# and exercise the demo, workload, performance, and optimize surfaces from an
# empty cwd.
wheel-smoke:
	BAKUDO_WHEEL_TESTS=1 $(PYTHON) -m pytest tests/test_wheel_install.py -v
