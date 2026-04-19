set shell := ["bash", "-c"]

# Install dependencies
install:
    pnpm install

# Build the project
build:
    pnpm build

release-bundle:
    pnpm build:release-bundle

# Run tests
test:
    pnpm test

# Lint the codebase
lint:
    pnpm exec eslint .

# Format the codebase
format:
    pnpm exec prettier --write .

# Clean build artifacts
clean:
    rm -rf dist

# Full CI-like check
check: lint test build
