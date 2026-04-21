/**
 * Wave 3: Daemon Gateway
 *
 * A lightweight HTTP server that accepts Objectives and manages their
 * lifecycle via the ObjectiveController. This is the long-running background
 * process that replaces the foreground CLI for autonomous operation.
 *
 * Endpoints:
 *   POST /objective   — Submit a new Objective
 *   GET  /objective/:id — Get the current state of an Objective
 *   GET  /objectives  — List all active Objectives
 *   DELETE /objective/:id — Pause/cancel an Objective
 *
 * Git Mutex:
 * The `gitWriteMutex` is exported from this module so it can be imported by
 * background agents (Curator, Janitor, Synthesizer in Waves 4–5). All agents
 * that write to the repository MUST acquire this mutex before making changes
 * and MUST NEVER merge PRs or push to protected branches.
 *
 * Security note: This server binds to localhost only. It is not intended to
 * be exposed to the network without an authentication layer.
 */
import express from "express";
import { Mutex } from "async-mutex";
import { ABoxAdapter } from "../aboxAdapter.js";
import { ABoxTaskRunner } from "../aboxTaskRunner.js";
import { ObjectiveController } from "../host/orchestration/objectiveController.js";
import { createObjective, type Objective } from "../host/orchestration/objectiveState.js";

// ---------------------------------------------------------------------------
// Git Write Mutex
// ---------------------------------------------------------------------------

/**
 * Daemon-level Git Write Mutex.
 *
 * Background agents (Curator, Janitor, Synthesizer) MUST acquire this mutex
 * before making any git operations (commit, branch, push). This prevents
 * concurrent agents from corrupting the working tree.
 *
 * Rules (from `00-execution-overview.md`):
 * - Acquire before any `git commit`, `git push`, or `git branch` operation.
 * - Release immediately after the operation completes.
 * - NEVER hold the mutex across an LLM inference call.
 * - NEVER merge PRs or push to protected branches.
 */
export const gitWriteMutex = new Mutex();

// ---------------------------------------------------------------------------
// Daemon state
// ---------------------------------------------------------------------------

const activeControllers = new Map<string, ObjectiveController>();

// ---------------------------------------------------------------------------
// Runner factory
// ---------------------------------------------------------------------------

/**
 * Build the shared ABoxTaskRunner for the Daemon. In production, this uses
 * the default abox binary. In tests, inject a mock runner via the
 * `BAKUDO_DAEMON_RUNNER` environment variable or the `createGateway` factory.
 */
const buildRunner = (): ABoxTaskRunner => {
  const adapter = new ABoxAdapter();
  return new ABoxTaskRunner(adapter);
};

// ---------------------------------------------------------------------------
// Gateway factory
// ---------------------------------------------------------------------------

/**
 * Create and configure the Express application.
 * Exported as a factory so tests can inject a mock runner without starting
 * a real HTTP server.
 */
export const createGateway = (runner: ABoxTaskRunner = buildRunner()) => {
  const app = express();
  app.use(express.json());

  // -------------------------------------------------------------------------
  // POST /objective — Submit a new Objective
  // -------------------------------------------------------------------------
  app.post("/objective", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const goal = typeof body["goal"] === "string" ? body["goal"].trim() : "";

    if (goal.length === 0) {
      res.status(400).json({ error: "goal is required and must be a non-empty string" });
      return;
    }

    const objectiveId = `obj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const objective: Objective = createObjective(objectiveId, goal);

    const controller = new ObjectiveController(objective, runner, gitWriteMutex);
    activeControllers.set(objectiveId, controller);

    // Kick off the background loop asynchronously. The HTTP response returns
    // immediately with the objectiveId so the client can poll for status.
    controller.advance().catch((error: unknown) => {
      console.error(`[Daemon] Objective ${objectiveId} advance() failed:`, error);
    });

    res.status(202).json({ objectiveId, status: "accepted", goal });
  });

  // -------------------------------------------------------------------------
  // GET /objective/:id — Get the current state of an Objective
  // -------------------------------------------------------------------------
  app.get("/objective/:id", (req, res) => {
    const controller = activeControllers.get(req.params["id"] ?? "");
    if (!controller) {
      res.status(404).json({ error: `Objective not found: ${req.params["id"]}` });
      return;
    }
    res.json(controller.state);
  });

  // -------------------------------------------------------------------------
  // GET /objectives — List all active Objectives
  // -------------------------------------------------------------------------
  app.get("/objectives", (_req, res) => {
    const objectives = [...activeControllers.values()].map((c) => ({
      objectiveId: c.state.objectiveId,
      goal: c.state.goal,
      status: c.state.status,
      campaignCount: c.state.campaigns.length,
    }));
    res.json({ objectives });
  });

  // -------------------------------------------------------------------------
  // DELETE /objective/:id — Pause an Objective
  // -------------------------------------------------------------------------
  app.delete("/objective/:id", (req, res) => {
    const controller = activeControllers.get(req.params["id"] ?? "");
    if (!controller) {
      res.status(404).json({ error: `Objective not found: ${req.params["id"]}` });
      return;
    }
    // Pausing is implemented by marking the objective status; the controller
    // checks this at the start of advance() and returns early.
    (controller.state as Objective).status = "paused";
    res.json({ objectiveId: req.params["id"], status: "paused" });
  });

  return app;
};

// ---------------------------------------------------------------------------
// Daemon entry point
// ---------------------------------------------------------------------------

/**
 * Start the Daemon Gateway HTTP server.
 * Called by the CLI when the user runs `bakudo daemon start`.
 */
export const startDaemon = (port = 3000): void => {
  const app = createGateway();
  app.listen(port, "127.0.0.1", () => {
    console.log(`[Daemon] Gateway listening on http://127.0.0.1:${port}`);
    console.log("[Daemon] Git Write Mutex: active");
  });
};
