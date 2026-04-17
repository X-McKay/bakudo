import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createHookRegistry,
  registerHook,
  dispatchHook,
  type HookHandler,
} from "../../src/host/hooks.js";
import type { SessionEventEnvelope } from "../../src/protocol.js";

const stubEnvelope = (): SessionEventEnvelope =>
  ({
    schemaVersion: 2,
    kind: "host.turn_queued",
    sessionId: "s1",
    actor: "host",
    timestamp: new Date().toISOString(),
    payload: {},
  }) as SessionEventEnvelope;

describe("hook dispatch pipeline", () => {
  it("empty registry returns empty results", async () => {
    const registry = createHookRegistry();
    const results = await dispatchHook(registry, "preDispatch", stubEnvelope());
    assert.deepStrictEqual(results, []);
  });

  it("single handler returning allow", async () => {
    const registry = createHookRegistry();
    const handler: HookHandler = async () => ({ decision: "allow" });
    registerHook(registry, "preDispatch", handler);
    const results = await dispatchHook(registry, "preDispatch", stubEnvelope());
    assert.equal(results.length, 1);
    assert.equal(results[0]!.decision, "allow");
  });

  it("multiple handlers; deny short-circuits", async () => {
    const registry = createHookRegistry();
    const callOrder: string[] = [];
    const handler1: HookHandler = async () => {
      callOrder.push("h1");
      return { decision: "deny", reason: "blocked" };
    };
    const handler2: HookHandler = async () => {
      callOrder.push("h2");
      return { decision: "allow" };
    };
    registerHook(registry, "preDispatch", handler1);
    registerHook(registry, "preDispatch", handler2);
    const results = await dispatchHook(registry, "preDispatch", stubEnvelope());
    assert.equal(results.length, 1);
    assert.equal(results[0]!.decision, "deny");
    assert.deepStrictEqual(callOrder, ["h1"]);
  });

  it("multiple handlers; all allow → all results returned", async () => {
    const registry = createHookRegistry();
    registerHook(registry, "preDispatch", async () => ({ decision: "allow" }));
    registerHook(registry, "preDispatch", async () => ({ decision: "allow" }));
    registerHook(registry, "preDispatch", async () => ({ decision: "skip" }));
    const results = await dispatchHook(registry, "preDispatch", stubEnvelope());
    assert.equal(results.length, 3);
  });

  it("notification kind returns immediately (async mode)", async () => {
    const registry = createHookRegistry();
    let handlerCalled = false;
    const handler: HookHandler = async () => {
      handlerCalled = true;
      return { decision: "allow" };
    };
    registerHook(registry, "notification", handler);
    const results = await dispatchHook(registry, "notification", stubEnvelope());
    // Returns empty immediately; handler fires in background.
    assert.deepStrictEqual(results, []);
    // Give the background handler time to run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(handlerCalled, true);
  });

  it("permissionRequest is sync by default", async () => {
    const registry = createHookRegistry();
    registerHook(registry, "permissionRequest", async () => ({ decision: "allow" }));
    const results = await dispatchHook(registry, "permissionRequest", stubEnvelope());
    assert.equal(results.length, 1);
    assert.equal(results[0]!.decision, "allow");
  });

  it("timeout on slow handler returns deny for sync", async () => {
    const registry = createHookRegistry();
    const slowHandler: HookHandler = async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { decision: "allow" };
    };
    registerHook(registry, "preDispatch", slowHandler);
    const results = await dispatchHook(registry, "preDispatch", stubEnvelope(), {
      timeout: 50,
    });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.decision, "deny");
    assert.ok(results[0]!.reason?.includes("timed out"));
  });

  it("handler throwing is treated as deny with error reason", async () => {
    const registry = createHookRegistry();
    const throwingHandler: HookHandler = async () => {
      throw new Error("hook crashed");
    };
    registerHook(registry, "preDispatch", throwingHandler);
    const results = await dispatchHook(registry, "preDispatch", stubEnvelope());
    assert.equal(results.length, 1);
    assert.equal(results[0]!.decision, "deny");
    assert.ok(results[0]!.reason?.includes("hook crashed"));
  });

  it("explicit sync override forces sync for notification kind", async () => {
    const registry = createHookRegistry();
    registerHook(registry, "notification", async () => ({ decision: "allow" }));
    const results = await dispatchHook(registry, "notification", stubEnvelope(), {
      sync: true,
    });
    // When forced sync, we get actual results back.
    assert.equal(results.length, 1);
    assert.equal(results[0]!.decision, "allow");
  });

  it("explicit async override forces async for sync kind", async () => {
    const registry = createHookRegistry();
    let called = false;
    registerHook(registry, "permissionRequest", async () => {
      called = true;
      return { decision: "allow" };
    });
    const results = await dispatchHook(registry, "permissionRequest", stubEnvelope(), {
      sync: false,
    });
    // Async → empty results immediately.
    assert.deepStrictEqual(results, []);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(called, true);
  });

  it("unregistered kind returns empty results", async () => {
    const registry = createHookRegistry();
    registerHook(registry, "preDispatch", async () => ({ decision: "allow" }));
    const results = await dispatchHook(registry, "sessionStart", stubEnvelope());
    assert.deepStrictEqual(results, []);
  });

  it("hookEnvelope carries correct hookKind", async () => {
    const registry = createHookRegistry();
    let receivedKind: string | undefined;
    registerHook(registry, "postToolUse", async (envelope) => {
      receivedKind = envelope.hookKind;
      return { decision: "allow" };
    });
    await dispatchHook(registry, "postToolUse", stubEnvelope());
    assert.equal(receivedKind, "postToolUse");
  });

  it("deny after allow in sequence still short-circuits", async () => {
    const registry = createHookRegistry();
    const callOrder: string[] = [];
    registerHook(registry, "preToolUse", async () => {
      callOrder.push("h1");
      return { decision: "allow" };
    });
    registerHook(registry, "preToolUse", async () => {
      callOrder.push("h2");
      return { decision: "deny", reason: "nope" };
    });
    registerHook(registry, "preToolUse", async () => {
      callOrder.push("h3");
      return { decision: "allow" };
    });
    const results = await dispatchHook(registry, "preToolUse", stubEnvelope());
    assert.equal(results.length, 2);
    assert.equal(results[0]!.decision, "allow");
    assert.equal(results[1]!.decision, "deny");
    assert.deepStrictEqual(callOrder, ["h1", "h2"]);
  });
});
