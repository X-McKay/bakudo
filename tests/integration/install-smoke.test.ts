import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

/**
 * Resolve the install script at `<repoRoot>/scripts/install.sh`. The test
 * walks up from the compiled module until it finds the directory.
 */
const resolveInstallScript = async (): Promise<string | null> => {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(dir, "scripts", "install.sh");
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
};

const hasBinary = async (bin: string): Promise<boolean> => {
  try {
    await execFileAsync("sh", ["-c", `command -v ${bin}`]);
    return true;
  } catch {
    return false;
  }
};

test("install.sh is present at bakudo/scripts/install.sh", async () => {
  const path = await resolveInstallScript();
  assert.ok(path, "install script not found");
});

test("install.sh is shellcheck-parseable when shellcheck is available", async (t) => {
  const path = await resolveInstallScript();
  assert.ok(path);
  if (!(await hasBinary("shellcheck"))) {
    t.skip("shellcheck not installed");
    return;
  }
  const result = await execFileAsync("shellcheck", ["--shell=bash", "--severity=error", path]);
  // shellcheck exits 0 when there are no errors at the selected severity.
  assert.equal(result.stdout.trim(), "");
});

test("install.sh dry-run (latest) succeeds without side effects", async (t) => {
  const path = await resolveInstallScript();
  assert.ok(path);
  if (!(await hasBinary("bash"))) {
    t.skip("bash not installed");
    return;
  }
  const env = {
    ...process.env,
    BAKUDO_INSTALL_DRY: "1",
    BAKUDO_SKIP_PROFILE: "1",
  };
  const result = await execFileAsync("bash", [path, "latest"], {
    env,
    timeout: 5000,
  });
  const out = `${result.stdout}\n${result.stderr}`;
  assert.match(out, /install mode: latest/u);
  assert.match(out, /dry-run: pnpm install -g @bakudo\/cli/u);
});

test("install.sh dry-run with explicit version strips leading v", async (t) => {
  const path = await resolveInstallScript();
  assert.ok(path);
  if (!(await hasBinary("bash"))) {
    t.skip("bash not installed");
    return;
  }
  const env = {
    ...process.env,
    BAKUDO_INSTALL_DRY: "1",
    BAKUDO_SKIP_PROFILE: "1",
  };
  const result = await execFileAsync("bash", [path, "v1.2.3"], {
    env,
    timeout: 5000,
  });
  const out = `${result.stdout}\n${result.stderr}`;
  assert.match(out, /install mode: explicit \(1\.2\.3\)/u);
  assert.match(out, /dry-run: pnpm install -g @bakudo\/cli@1\.2\.3/u);
});

test("install.sh refuses BAKUDO_TARBALL without matching SHA256", async (t) => {
  const path = await resolveInstallScript();
  assert.ok(path);
  if (!(await hasBinary("bash"))) {
    t.skip("bash not installed");
    return;
  }
  const env = {
    ...process.env,
    BAKUDO_INSTALL_DRY: "1",
    BAKUDO_SKIP_PROFILE: "1",
    BAKUDO_TARBALL: "https://example.com/bakudo.tgz",
    BAKUDO_TARBALL_SHA256: "",
  };
  try {
    await execFileAsync("bash", [path, "latest"], { env, timeout: 5000 });
    assert.fail("install script should exit non-zero when SHA256 is missing");
  } catch (err) {
    const e = err as { stderr?: string; code?: number };
    assert.ok((e.stderr ?? "").includes("BAKUDO_TARBALL_SHA256"));
  }
});

test("install.sh respects BAKUDO_VERSION env var over the CLI positional", async (t) => {
  const path = await resolveInstallScript();
  assert.ok(path);
  if (!(await hasBinary("bash"))) {
    t.skip("bash not installed");
    return;
  }
  const env = {
    ...process.env,
    BAKUDO_INSTALL_DRY: "1",
    BAKUDO_SKIP_PROFILE: "1",
    BAKUDO_VERSION: "v0.9.0",
  };
  // Positional argument should lose to BAKUDO_VERSION.
  const result = await execFileAsync("bash", [path, "latest"], {
    env,
    timeout: 5000,
  });
  const out = `${result.stdout}\n${result.stderr}`;
  assert.match(out, /install mode: explicit \(0\.9\.0\)/u);
});

test("install.sh prints a PATH fallback hint when BAKUDO_SKIP_PROFILE=1", async (t) => {
  const path = await resolveInstallScript();
  assert.ok(path);
  if (!(await hasBinary("bash"))) {
    t.skip("bash not installed");
    return;
  }
  // Drop PWD so the script falls back to HOME-based paths.
  const env = {
    ...process.env,
    BAKUDO_INSTALL_DRY: "1",
    BAKUDO_SKIP_PROFILE: "1",
  };
  const result = await execFileAsync("bash", [path, "latest"], {
    env,
    timeout: 5000,
  });
  const out = `${result.stdout}\n${result.stderr}`;
  assert.match(out, /add this to/u);
  assert.match(out, /export PATH/u);
});
