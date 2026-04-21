# Bakudo Cognitive Meta-Orchestrator: Execution Overview

## Vision
The goal of this plan set is to evolve `bakudo` from a linear, single-agent task dispatcher into a **Cognitive Meta-Orchestrator**. 

A Meta-Orchestrator does not just run tasks; it manages *environments* and *roles*. It breaks down long-running Objectives into Campaigns, dispatches parallel experiments (CandidateSets) using diverse LLM backends (Provider Registry), automatically adversarial-tests the results (Chaos Monkey), reflects on failures to generate Post-Mortems (Critic), and consolidates those lessons into a durable Knowledge Graph (Curator). 

Crucially, it achieves this while strictly adhering to `abox`'s hardware-isolated, TLS-proxy security model.

## The Wave Map

This integration is broken down into four sequential waves. Each wave is designed to be implemented, tested, and merged independently without breaking the existing interactive `bakudo` CLI experience.

1. **Wave 1: Provider Registry**
   - **Focus:** Decouple `bakudo` from hardcoded CLI runners. Introduce `ProviderSpec` to map different backends (Claude, Codex, OpenDevin) to `abox` proxy rules and execution commands.
   - **Value:** Unlocks the ability to use any LLM backend securely.

2. **Wave 2: Chaos Monkey Evaluator**
   - **Focus:** Introduce the adversarial testing loop. Modify `executeAttempt` so that a successful Worker run immediately spawns a Chaos Monkey in the same sandbox to try and break the code.
   - **Value:** Guarantees code robustness through sandboxed adversarial testing.

3. **Wave 3: Daemon Gateway & Control Plane**
   - **Focus:** Build the background Node.js daemon and the `ObjectiveController`. Implement the `Objective` -> `Campaign` -> `CandidateSet` state model.
   - **Value:** Unlocks "very long running" autonomy and parallel Candidate dispatch.

4. **Wave 4: Cognitive Layer (Reflection & Memory)**
   - **Focus:** Introduce the Critic (reflection) and Curator (memory consolidation) sub-agents. Implement the three-tiered memory system (Episodic, Semantic, Procedural) in `.bakudo/memory/`.
   - **Value:** The system learns from its mistakes automatically over time.

5. **Wave 5: Extended Autonomy Loop**
   - **Focus:** Introduce the Explorer (proactive discovery), Synthesizer (parallel merge), and Janitor (background hygiene) sub-agents.
   - **Value:** Unlocks true autonomy by fixing hallucination (Explorer), extracting value from parallel runs (Synthesizer), and maintaining codebase health (Janitor).

## Shared Conventions & Rules

0. **Resource Limits & Concurrency:** A "very long running" system that spawns VMs must be strictly bounded. Wave 3 introduces the `ResourceBudget` configuration, which caps total active `abox` instances, sets per-role CPU/memory limits, and controls CandidateSet fan-out. All subsequent waves must respect these limits.

1. **Do Not Touch `SessionController`:** The existing interactive CLI path (`src/host/sessionController.ts`) must remain intact. The new Meta-Harness logic will live in `src/host/orchestration/` and call `executeAttempt` directly.
2. **abox Security Invariants:** Never inject raw credentials via environment variables. Always use `abox`'s `policies/default.toml` and stub injection.
3. **Functional State Updates:** All state mutations in the host runtime must use functional updaters (e.g., `reduceHost`).
4. **Local LLM Testing:** Before merging any wave that introduces new agent prompts (e.g., Chaos Monkey, Critic), it MUST be tested end-to-end using a local LLM (like Ollama or Llama.cpp) to ensure the prompt engineering is robust.
5. **Clean Up Dead Code:** Each wave includes a "Cleanup" section. If old monolithic code is bypassed, delete it immediately. Do not leave dead code in the tree.
6. **Headless Execution Boundary:** The Daemon never calls the interactive `executeAttempt` directly. It goes through `headlessExecute` (introduced in Wave 3), which wraps the Worker → Chaos Monkey loop, bypasses the interactive `SessionStore`/approval surface, and returns a simple `{ success, transcript, diff, artifacts }` result. This is the only way the Daemon touches sandbox execution.
7. **Daemon-Level Git Mutex:** Any background agent that holds the `git-write` policy (Curator, Janitor, Synthesizer) MUST acquire the Daemon's `gitWriteMutex` before running. Only one git-writing agent may be active at a time across the entire Daemon.
8. **No Auto-Merge, No Destructive Actions:** Background agents may open PRs, commit to feature branches, or stage diffs for review, but they MUST NEVER merge PRs, push to protected branches, run `git reset --hard`, `git push --force`, force-apply migrations, or take any other action a human would want to approve. The user-review queue (Wave 5) is the only path to merge.
9. **Immutable `DispatchPlan` Rebuilds:** Retry loops (Chaos Monkey in Wave 2, Explorer-stuck fallback in Wave 5) MUST construct a fresh `DispatchPlan` with appended instructions rather than mutating the prior one in place. This matches the functional-state-update rule and keeps per-attempt provenance clean.
