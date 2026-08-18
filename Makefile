PYTHON ?= python3
TEMPORAL_NAMESPACE ?= default

.PHONY: install doctor schemas lint type test test-performance test-performance-temporal-live test-performance-live check demo wheel wheel-smoke

install:
	$(PYTHON) -m pip install -e ".[all,dev]"

doctor:
	BAKUDO_OFFLINE=1 $(PYTHON) -m bakudo.cli doctor

schemas:
	$(PYTHON) scripts/generate_performance_schemas.py --check

lint:
	$(PYTHON) -m ruff check src tests skills scripts

# python -m keeps every tool on the same interpreter/environment.
type:
	$(PYTHON) -m mypy src/bakudo

test:
	$(PYTHON) -m pytest

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

# The full local gate, mirrored by CI (see .github/workflows/ci.yml).
check: schemas lint type test

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
