import { spawn } from "node:child_process";

const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;
const FORCE_KILL_DELAY_MS = 1_000;
const IS_WINDOWS = process.platform === "win32";

export interface ProcessRequest {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly input?: string | Buffer;
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly outputLimitExceeded: boolean;
  readonly residualProcessGroupDetected: boolean;
  readonly residualProcessGroupRemaining: boolean;
}

function killProcessGroup(processId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

function processGroupExists(processId: number): boolean {
  try {
    process.kill(-processId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function windowsProcessExists(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ESRCH") {
      return false;
    }
    if (errorCode === "EPERM") {
      return true;
    }
    throw error;
  }
}

function spawnTaskKillTree(processId: number): void {
  spawn("taskkill", ["/pid", String(processId), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}

function taskKillTree(processId: number): Promise<void> {
  return new Promise((resolve) => {
    const childProcess = spawn("taskkill", ["/pid", String(processId), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    childProcess.once("close", () => resolve());
    childProcess.once("error", () => resolve());
  });
}

async function terminateResidualProcessGroup(processId: number): Promise<{
  readonly detected: boolean;
  readonly remaining: boolean;
}> {
  if (IS_WINDOWS) {
    // Windows cannot enumerate a background tree after the root exited; only a
    // still-live root is detected and force-killed through its child tree.
    if (!windowsProcessExists(processId)) {
      return { detected: false, remaining: false };
    }
    await taskKillTree(processId);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    return { detected: true, remaining: windowsProcessExists(processId) };
  }
  if (!processGroupExists(processId)) {
    return { detected: false, remaining: false };
  }
  killProcessGroup(processId, "SIGKILL");
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  return { detected: true, remaining: processGroupExists(processId) };
}

function resolveSpawnTarget(executable: string, forceCommandResolution: boolean): {
  readonly executable: string;
  readonly commandArguments: readonly string[];
} {
  if (IS_WINDOWS && (forceCommandResolution || /\.(cmd|bat)$/iu.test(executable))) {
    // Windows spawn only appends .exe; cmd.exe applies PATHEXT and resolves
    // npm shims such as dsh.cmd.
    return {
      executable: process.env.ComSpec ?? "cmd.exe",
      commandArguments: ["/d", "/s", "/c", executable],
    };
  }
  return { executable, commandArguments: [] };
}

export async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  if (request.signal.aborted) {
    throw new Error(`process aborted before launch: ${request.executable}`);
  }

  try {
    return await launchProcess(request, false);
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code
      ?? ((error as { cause?: NodeJS.ErrnoException }).cause?.code);
    if (errorCode === "ENOENT" && IS_WINDOWS) {
      return launchProcess(request, true);
    }
    throw error;
  }
}

function launchProcess(request: ProcessRequest, forceCommandResolution: boolean): Promise<ProcessResult> {
  const spawnTarget = resolveSpawnTarget(request.executable, forceCommandResolution);
  return new Promise<ProcessResult>((resolve, reject) => {
    const childProcess = spawn(spawnTarget.executable, [...spawnTarget.commandArguments, ...request.arguments], {
      cwd: request.cwd,
      env: request.env,
      // POSIX needs detached to address the child as a process group; on
      // Windows detached hangs cmd.exe children, and taskkill /T walks the
      // parent-child tree without it.
      detached: !IS_WINDOWS,
      windowsHide: IS_WINDOWS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedOutputBytes = 0;
    let timedOut = false;
    let aborted = false;
    let outputLimitExceeded = false;
    let terminationStarted = false;
    let standardInputError: Error | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let launchFailed = false;

    const terminate = (): void => {
      if (terminationStarted || childProcess.pid === undefined) {
        return;
      }
      terminationStarted = true;
      if (IS_WINDOWS) {
        // taskkill /T /F is already forceful; a single awaited pass in
        // terminateResidualProcessGroup covers any race with process exit.
        spawnTaskKillTree(childProcess.pid);
        return;
      }
      try {
        killProcessGroup(childProcess.pid, "SIGTERM");
      } catch (error) {
        stderrChunks.push(Buffer.from(`[process-group termination failed: ${(error as Error).message}]\n`));
        childProcess.kill("SIGTERM");
      }
      forceKillTimer = setTimeout(() => {
        if (childProcess.pid !== undefined) {
          try {
            killProcessGroup(childProcess.pid, "SIGKILL");
          } catch (error) {
            stderrChunks.push(Buffer.from(`[process-group force kill failed: ${(error as Error).message}]\n`));
            childProcess.kill("SIGKILL");
          }
        }
      }, FORCE_KILL_DELAY_MS);
      forceKillTimer.unref();
    };

    const captureChunk = (target: Buffer[], chunk: Buffer): void => {
      if (outputLimitExceeded) {
        return;
      }
      capturedOutputBytes += chunk.length;
      if (capturedOutputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        outputLimitExceeded = true;
        terminate();
        return;
      }
      target.push(chunk);
    };
    childProcess.stdout.on("data", (chunk: Buffer) => captureChunk(stdoutChunks, chunk));
    childProcess.stderr.on("data", (chunk: Buffer) => captureChunk(stderrChunks, chunk));
    childProcess.stdin.on("error", (error) => {
      standardInputError = error;
    });
    childProcess.stdin.end(request.input ?? "");

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, request.timeoutMs);
    timeout.unref();

    const handleAbort = (): void => {
      aborted = true;
      terminate();
    };
    request.signal.addEventListener("abort", handleAbort, { once: true });

    childProcess.once("error", (error) => {
      launchFailed = true;
      clearTimeout(timeout);
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
      }
      request.signal.removeEventListener("abort", handleAbort);
      reject(new Error(`failed to launch ${request.executable}: ${error.message}`, { cause: error }));
    });
    childProcess.once("close", (exitCode, exitSignal) => {
      if (launchFailed) {
        return;
      }
      clearTimeout(timeout);
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
      }
      request.signal.removeEventListener("abort", handleAbort);
      if (childProcess.pid === undefined) {
        reject(new Error(`process closed without a PID: ${request.executable}`));
        return;
      }
      void terminateResidualProcessGroup(childProcess.pid).then((residualProcessGroup) => {
        if (standardInputError !== undefined && exitCode === 0) {
          reject(new Error(
            `failed to write stdin for ${request.executable}: ${standardInputError.message}`,
            { cause: standardInputError },
          ));
          return;
        }
        resolve({
          exitCode,
          signal: exitSignal,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          timedOut,
          aborted,
          outputLimitExceeded,
          residualProcessGroupDetected: residualProcessGroup.detected,
          residualProcessGroupRemaining: residualProcessGroup.remaining,
        });
      }, reject);
    });
  });
}

const ALLOWED_ENVIRONMENT_NAMES = new Set([
  "COLORTERM",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
]);

// Minimum Windows set: without SystemRoot/COMSPEC/PATHEXT, spawned console
// programs, git, and Node itself fail in undocumented ways.
const ALLOWED_WINDOWS_ENVIRONMENT_NAMES = new Set([
  ...ALLOWED_ENVIRONMENT_NAMES,
  "ALLUSERSPROFILE",
  "APPDATA",
  "COMMONPROGRAMFILES",
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "PATHEXT",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "SYSTEMROOT",
  "USERPROFILE",
  "WINDIR",
]);

export function sanitizedEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv,
  explicitValues: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const allowedEnvironmentNames = IS_WINDOWS
    ? ALLOWED_WINDOWS_ENVIRONMENT_NAMES
    : ALLOWED_ENVIRONMENT_NAMES;
  const environment: NodeJS.ProcessEnv = {};
  for (const [environmentName, environmentValue] of Object.entries(sourceEnvironment)) {
    if (environmentValue !== undefined && allowedEnvironmentNames.has(environmentName)) {
      environment[environmentName] = environmentValue;
    }
  }
  return { ...environment, ...explicitValues };
}

export function redactSecret(text: string, secret: string): string {
  if (secret.length === 0) {
    // No credential is in scope (validation-only runs resolve none), so there
    // is nothing to redact.
    return text;
  }
  return text.replaceAll(secret, "[REDACTED]");
}
