# Bakudo Agent Harness

`Bakudo` is a lightweight, robust custom agent harness designed for high-autonomy operation within `abox` sandboxing environments. Built with TypeScript and a focus on functional programming, it provides a secure and scalable foundation for building autonomous agents.

## Core Features

- **Planner → Executor Contract**: Explicit step contracts with dependencies and acceptance metadata to ensure predictable execution.
- **Mode-Aware Policy Engine**: Deterministic policy evaluation for `plan`, `build`, and `review` modes with configurable tool allowlists and autonomy budgets.
- **Parallel Workstreams**: Efficient management of concurrent workstreams over ephemeral `abox run --task` sandboxes.
- **Durable Traces**: Detailed step-by-step traces and periodic checkpoint summaries for auditability and debugging.
- **TypeScript First**: Aligns with modern agent ecosystems (MCP-first integrations, server/CLI UX) while maintaining a lightweight core with zero runtime dependencies.

## Project Structure

- `src/models.ts`: Shared domain types, including `Mode`, `RiskLevel`, `PlanStep`, and autonomy budgets.
- `src/policy.ts`: The deterministic policy engine for evaluating tool risks and permits.
- `src/tools.ts`: Tool registry and normalized error handling for harness operations.
- `src/aboxAdapter.ts`: Adapter for stream-scoped command execution via the `abox` binary.
- `src/orchestrator.ts`: The central planner, coordinator, and executor loop.
- `src/memory.ts`: Session memory management and trace logging.
- `config/`: JSON configuration profiles for different runtime environments.
- `tests/`: Comprehensive test suite including unit, integration, and regression tests.
- `.claude/skills/`: Specialized AI skills for development, testing, and release management.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v22 or later)
- [pnpm](https://pnpm.io/)
- [mise](https://mise.jdx.dev/) (optional, for environment management)
- [just](https://github.com/casey/just) (optional, for task automation)

### Installation

```bash
pnpm install
```

### Usage

Run the harness with a specific goal and configuration:

```bash
pnpm start -- --goal "your goal here" --streams stream1,stream2 --repo /path/to/repo
```

Or run directly via Node:

```bash
node dist/src/cli.js --goal "your goal here" --config config/default.json --streams s1,s2 --repo /path/to/repo
```

## Development and Testing

`Bakudo` maintains a high bar for code quality through automated linting, formatting, and a multi-layered testing strategy.

### Available Scripts

- `pnpm test`: Build the project and run all tests.
- `pnpm lint`: Run ESLint to check for code quality issues.
- `pnpm format`: Format the codebase using Prettier.
- `pnpm build`: Compile the TypeScript source code to the `dist/` directory.

### Task Automation (via `just`)

If you have `just` installed, you can use the following shortcuts:

- `just check`: Run linting, tests, and build in sequence.
- `just clean`: Remove build artifacts.

## AI-Driven Workflow

This repository includes structured **Claude Skills** in the `.claude/skills/` directory. These skills guide AI agents through common tasks such as:

- **Feature Development**: Implementing new functionality following the established architecture.
- **Bug Fixing**: A rigorous process of reproduction and verification.
- **Testing**: Guidelines for maintaining the multi-layered test suite.
- **Release Management**: Standardized versioning and branch management conventions.

## License

This project is private and intended for internal use.
