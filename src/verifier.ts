import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { JsonValue, VerifierRequest, VerifierResponse } from "./contracts.ts";
import type { RuntimeConfig } from "./config.ts";
import { redactSecret, runProcess, sanitizedEnvironment } from "./process.ts";

interface VerifierRunnerOptions {
  readonly config: RuntimeConfig;
  readonly credentialValue: string;
  readonly uvExecutable?: string;
}

function expectObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function expectInteger(value: unknown, fieldName: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`${fieldName} must be an integer, got ${JSON.stringify(value)}`);
  }
  return value as number;
}

function expectNonNegativeInteger(value: unknown, fieldName: string): number {
  const integerValue = expectInteger(value, fieldName);
  if (integerValue < 0) {
    throw new Error(`${fieldName} must be non-negative, got ${JSON.stringify(value)}`);
  }
  return integerValue;
}

function expectNumberArray(value: unknown, fieldName: string): number[] {
  if (!Array.isArray(value) || value.some((item) => !Number.isFinite(item))) {
    throw new Error(`${fieldName} must contain finite numbers, got ${JSON.stringify(value)}`);
  }
  return value as number[];
}

function expectIntegerArray(value: unknown, fieldName: string): number[] {
  if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item))) {
    throw new Error(`${fieldName} must contain integers, got ${JSON.stringify(value)}`);
  }
  return value as number[];
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

function parseVerifierResponse(rawOutput: string): VerifierResponse {
  let parsedOutput: unknown;
  try {
    parsedOutput = JSON.parse(rawOutput);
  } catch (error) {
    throw new Error(`verifier bridge returned invalid JSON: ${rawOutput.slice(0, 500)}`, { cause: error });
  }
  const response = expectObject(parsedOutput, "verifier response");
  const tokenUsage = response.tokenUsage;
  if (!isJsonValue(tokenUsage)) {
    throw new Error(`tokenUsage must be JSON-safe, got ${JSON.stringify(tokenUsage)}`);
  }
  return {
    winnerIndex: expectInteger(response.winnerIndex, "winnerIndex"),
    scores: expectNumberArray(response.scores, "scores"),
    ranking: expectIntegerArray(response.ranking, "ranking"),
    requestCount: expectNonNegativeInteger(response.requestCount, "requestCount"),
    tokenUsage,
  };
}

export async function runPythonVerifier(
  request: VerifierRequest,
  options: VerifierRunnerOptions,
): Promise<VerifierResponse> {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const pythonProjectPath = join(packageRoot, "python");
  const bridgePath = join(pythonProjectPath, "verifier_bridge.py");
  const verifierEnvironment = sanitizedEnvironment(process.env, {
    DEEPSEEK_API_KEY: options.credentialValue,
    DEEPSEEK_EFFORT: options.config.verifierEffort,
    DEEPSEEK_MAX_TOKENS: String(options.config.verifierMaxTokens),
    PYTHONUTF8: "1",
    PYTHONUNBUFFERED: "1",
  });
  const bridgeResult = await runProcess({
    executable: options.uvExecutable ?? "uv",
    arguments: [
      "run",
      "--frozen",
      "--project",
      pythonProjectPath,
      "python",
      bridgePath,
    ],
    cwd: pythonProjectPath,
    env: verifierEnvironment,
    timeoutMs: options.config.runTimeoutMs,
    signal: request.signal,
    input: JSON.stringify({
      task: request.task,
      candidates: request.candidates,
      pivots: request.pivots,
      model: request.model,
      nEvaluations: request.nEvaluations,
      maxWorkers: request.maxWorkers,
      cachePath: request.cachePath,
    }),
  });
  const standardError = redactSecret(bridgeResult.stderr, options.credentialValue).trim();
  if (
    bridgeResult.exitCode !== 0
    || bridgeResult.timedOut
    || bridgeResult.aborted
    || bridgeResult.outputLimitExceeded
  ) {
    throw new Error(
      `verifier bridge failed with exit code ${bridgeResult.exitCode}: ${standardError || "no diagnostic output"}`,
    );
  }
  return {
    ...parseVerifierResponse(redactSecret(bridgeResult.stdout, options.credentialValue).trim()),
    diagnostics: standardError,
  };
}
