set shell := ["bash", "-c"]

# Build the project (debug)
build:
    cargo build

# Build the project (release)
release:
    cargo build --release

# Run all tests across the workspace
test:
    cargo test --workspace

# Run clippy linter with warnings as errors
lint:
    cargo clippy --workspace -- -D warnings

# Check formatting without modifying files
fmt-check:
    cargo fmt --all -- --check

# Format all source files
fmt:
    cargo fmt --all

# Full CI-like check: format, lint, test
check: fmt-check lint test

# Remove build artifacts
clean:
    cargo clean

# Install the git pre-commit hook (runs `just check` before every commit)
hooks-install:
    mise run hooks:install

# Show the current workspace version
version:
    cargo metadata --no-deps --format-version 1 | python3 -c \
        "import json,sys; pkgs=json.load(sys.stdin)['packages']; \
         root=[p for p in pkgs if p['name']=='bakudo'][0]; \
         print(root['version'])"
