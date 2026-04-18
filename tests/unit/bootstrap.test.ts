import assert from "node:assert/strict";
import test from "node:test";

import { memoize } from "../../src/host/bootstrap.js";

test("memoize: concurrent callers share the same promise", async () => {
  let calls = 0;
  let resolve: (value: number) => void = () => {};
  const deferred = new Promise<number>((res) => {
    resolve = res;
  });
  const wrapped = memoize(async () => {
    calls += 1;
    return deferred;
  });

  const a = wrapped();
  const b = wrapped();
  const c = wrapped();
  assert.equal(a, b);
  assert.equal(a, c);

  resolve(42);
  const [va, vb, vc] = await Promise.all([a, b, c]);
  assert.equal(va, 42);
  assert.equal(vb, 42);
  assert.equal(vc, 42);
  assert.equal(calls, 1);
});

test("memoize: resolved promise is reused forever", async () => {
  let calls = 0;
  const wrapped = memoize(async () => {
    calls += 1;
    return "one-shot";
  });
  assert.equal(await wrapped(), "one-shot");
  assert.equal(await wrapped(), "one-shot");
  assert.equal(await wrapped(), "one-shot");
  assert.equal(calls, 1);
});

test("memoize: rejections clear the cached promise (retry semantics)", async () => {
  let calls = 0;
  const wrapped = memoize(async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error("transient");
    }
    return "ok";
  });

  await assert.rejects(() => wrapped(), /transient/);
  const second = await wrapped();
  assert.equal(second, "ok");
  assert.equal(calls, 2);
});

test("memoize: disposal callback invoked once under try-finally", async () => {
  let disposed = 0;
  const bootLike = memoize(async () => ({
    dispose: async () => {
      disposed += 1;
    },
  }));

  const run = async (): Promise<void> => {
    const boot = await bootLike();
    try {
      throw new Error("boom");
    } finally {
      await boot.dispose();
    }
  };
  await assert.rejects(run, /boom/);
  // second call with a different try-finally should reuse the same bootstrap
  // and call dispose a second time (the bootstrap's own disposed flag guards
  // against double cleanup per-invocation in production code).
  const boot = await bootLike();
  await boot.dispose();
  assert.equal(disposed, 2);
});
