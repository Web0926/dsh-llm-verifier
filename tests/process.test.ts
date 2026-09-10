import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runProcess, sanitizedEnvironment } from "../src/process.ts";

const IS_WINDOWS = process.platform === "win32";
const scratchDirectory = tmpdir();

describe("process isolation", () => {
  it("passes only explicitly allowed host environment values", () => {
    const environment = sanitizedEnvironment({
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      DATABASE_URL: "postgres://private.example/database",
      SSH_AUTH_SOCK: "/private/ssh-agent.sock",
      CI_JOB_JWT: "private-job-token",
    }, {
      DSH_PERMISSION_MODE: "workspace-write",
    });

    assert.deepEqual(environment, {
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      DSH_PERMISSION_MODE: "workspace-write",
    });
  });

  it("kills the complete process group when a command times out", { skip: IS_WINDOWS && "POSIX process groups" }, async () => {
    const abortController = new AbortController();
    const startedAt = Date.now();
    const result = await runProcess({
      executable: "/bin/sh",
      arguments: ["-lc", "sleep 60 & child_pid=$!; printf '%s\\n' \"$child_pid\"; wait \"$child_pid\""],
      cwd: scratchDirectory,
      env: sanitizedEnvironment(process.env),
      timeoutMs: 100,
      signal: abortController.signal,
    });

    assert.equal(result.timedOut, true);
    assert.equal(result.residualProcessGroupRemaining, false);
    assert.ok(Date.now() - startedAt < 3_000);
    const childProcessId = Number.parseInt(result.stdout.trim(), 10);
    assert.ok(Number.isInteger(childProcessId));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.throws(
      () => process.kill(childProcessId, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
  });

  it("force-kills the spawned process tree when a command times out on Windows", { skip: !IS_WINDOWS && "Windows tree kill" }, async () => {
    const abortController = new AbortController();
    const startedAt = Date.now();
    const result = await runProcess({
      executable: "cmd.exe",
      arguments: ["/d", "/s", "/c", "ping -n 60 127.0.0.1 > NUL"],
      cwd: scratchDirectory,
      env: sanitizedEnvironment(process.env),
      timeoutMs: 100,
      signal: abortController.signal,
    });

    assert.equal(result.timedOut, true);
    assert.equal(result.residualProcessGroupRemaining, false);
    assert.ok(Date.now() - startedAt < 10_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it("detects and terminates a background process left after a successful exit", { skip: IS_WINDOWS && "POSIX process groups" }, async () => {
    const result = await runProcess({
      executable: "/bin/sh",
      arguments: [
        "-lc",
        "sleep 60 </dev/null >/dev/null 2>&1 & child_pid=$!; printf '%s\\n' \"$child_pid\"",
      ],
      cwd: scratchDirectory,
      env: sanitizedEnvironment(process.env),
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.residualProcessGroupDetected, true);
    assert.equal(result.residualProcessGroupRemaining, false);
    const childProcessId = Number.parseInt(result.stdout.trim(), 10);
    assert.ok(Number.isInteger(childProcessId));
    assert.throws(
      () => process.kill(childProcessId, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
  });
});
