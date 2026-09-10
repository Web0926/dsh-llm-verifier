import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, readFile, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { CandidateCount } from "./config.ts";
import { normalizeCandidateCount } from "./config.ts";
import type {
  CandidateResult,
  RollbackResult,
  ApplyVerifiedWinnerResult,
  ApplyRuntimeDependencies,
  PublicCandidateResult,
  ReviewReceipt,
  RuntimeDependencies,
  SelectVerifiedCandidateResult,
  VerifiedBestOfResult,
  VerifierResponse,
} from "./contracts.ts";
import {
  captureCandidateChanges,
  createDetachedWorktree,
  inspectRepository,
  removeWorktree,
  runGit,
  type RepositorySnapshot,
} from "./git.ts";
import { redactSecret, runProcess, sanitizedEnvironment } from "./process.ts";
import type { RunSettings } from "./settings.ts";
import { resolveValidationCommands } from "./validation.ts";

function progress(message: string): void {
  process.stderr.write(`[llm-verifier] ${new Date().toISOString()} ${message}
`);
}

const MINIMUM_FREE_BYTES_PER_CANDIDATE = 512 * 1024 * 1024;
const CREDENTIAL_REFERENCE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MAX_TASK_CHARACTERS = 100_000;
const PLUGIN_VERSION = "0.2.0";

export interface RunVerifiedBestOfInput {
  readonly task: string;
  readonly candidateCount?: number;
  readonly validationCommands?: readonly string[];
  readonly repositoryPath: string;
  /** Settings-document revision at snapshot time, recorded in the run manifest. */
  readonly settingsRevision?: number | null;
  readonly signal?: AbortSignal;
}

export interface ApplyVerifiedWinnerInput {
  readonly runId: string;
  readonly repositoryPath: string;
  readonly candidateId?: string;
  readonly signal?: AbortSignal;
}

interface StoredRunManifest {
  readonly repositoryPath: string;
  readonly baseCommit: string;
  readonly validationCommands: string[];
  readonly winnerPatchSha256: string;
  readonly winnerPatchPath: string;
  readonly winnerId: string;
  readonly changedFiles: string[];
}

interface CandidateExecutionRequest {
  readonly candidateId: string;
  readonly worktreePath: string;
  readonly candidateArtifactsDirectory: string;
  readonly task: string;
  readonly validationCommands: readonly string[];
  readonly repository: RepositorySnapshot;
  readonly config: RunSettings;
  readonly credentialValue: string;
  readonly signal: AbortSignal;
}

function validateTask(task: string): string {
  const normalizedTask = task.trim();
  if (normalizedTask.length === 0 || normalizedTask.length > MAX_TASK_CHARACTERS) {
    throw new Error(
      `invalid task: expected 1-${MAX_TASK_CHARACTERS} characters, got ${task.length}`,
    );
  }
  return normalizedTask;
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const relativePath = relative(parentPath, childPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function canonicalStateDirectory(
  configuredStateDirectory: string,
  repositoryPath: string,
): Promise<string> {
  if (!isAbsolute(configuredStateDirectory)) {
    throw new Error(
      `invalid stateDirectory: expected an absolute path, got ${JSON.stringify(configuredStateDirectory)}`,
    );
  }
  const resolvedStateDirectory = resolve(configuredStateDirectory);
  let stateDirectory: string;
  try {
    stateDirectory = await realpath(resolvedStateDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    const stateDirectoryParent = await realpath(dirname(resolvedStateDirectory));
    stateDirectory = join(stateDirectoryParent, basename(resolvedStateDirectory));
  }
  if (isPathInside(repositoryPath, stateDirectory)) {
    throw new Error(
      `invalid stateDirectory: ${stateDirectory} must be outside repository ${repositoryPath}`,
    );
  }
  return stateDirectory;
}

async function assertEnoughDiskSpace(
  stateDirectory: string,
  candidateCount: CandidateCount,
): Promise<void> {
  const fileSystemStats = await statfs(dirname(stateDirectory), { bigint: true });
  const availableBytes = fileSystemStats.bavail * fileSystemStats.bsize;
  const requiredBytes = BigInt(candidateCount * MINIMUM_FREE_BYTES_PER_CANDIDATE);
  if (availableBytes < requiredBytes) {
    throw new Error(
      `insufficient disk space for ${candidateCount} candidates: required ${requiredBytes} bytes, available ${availableBytes} bytes at ${stateDirectory}`,
    );
  }
}

function createApprovalReason(
  repository: RepositorySnapshot,
  candidateCount: CandidateCount,
  validationCommands: readonly string[],
  config: RunSettings,
): string {
  const estimatedVerifierRequests = (candidateCount === 3 ? 18 : 36) * config.nEvaluations;
  return [
    `Run ${candidateCount} isolated DeepSeek Harness candidates in ${repository.repositoryPath}.`,
    `Base commit: ${repository.baseCommit}.`,
    `Validation commands: ${validationCommands.join("; ")}.`,
    "The task, text diffs, and validation evidence may be sent to DeepSeek.",
    `Maximum run time: ${config.runTimeoutMs} ms.`,
    `Candidate generation budget: ${candidateCount} headless Harness tasks using profile ${config.candidateProfile}.`,
    `Verifier budget: approximately ${estimatedVerifierRequests} requests to ${config.verifierModel} if every candidate passes (${config.nEvaluations} evaluations per comparison).`,
    "These are estimates; the report records the actual completed tasks and verifier requests.",
  ].join("\n");
}

function truncateVerifierTrace(
  trace: string,
  maximumBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  const traceBuffer = Buffer.from(trace, "utf8");
  if (traceBuffer.length <= maximumBytes) {
    return { text: trace, truncated: false };
  }
  const retainedTrace = traceBuffer.subarray(0, maximumBytes).toString("utf8");
  return {
    text: `${retainedTrace}\n[truncated: original ${traceBuffer.length} bytes, retained ${maximumBytes} bytes; complete input retained locally]`,
    truncated: true,
  };
}

async function writePrivateTextFile(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function runGitApplyWithVerifiedPatch(
  repositoryPath: string,
  patch: Buffer,
  checkOnly: boolean,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const gitArguments = ["apply", "--binary", ...(checkOnly ? ["--check"] : []), "-"];
  const result = await runProcess({
    executable: "git",
    arguments: gitArguments,
    cwd: repositoryPath,
    env: sanitizedEnvironment(process.env),
    timeoutMs,
    signal,
    input: patch,
  });
  if (
    result.exitCode !== 0
    || result.timedOut
    || result.aborted
    || result.outputLimitExceeded
    || result.residualProcessGroupDetected
  ) {
    const diagnostic = result.stderr.trim() || result.stdout.trim() || "no diagnostic output";
    throw new Error(`git ${gitArguments.slice(0, -1).join(" ")} failed in ${repositoryPath}: ${diagnostic}`);
  }
}

function failureMessage(error: unknown, credentialValue: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecret(message, credentialValue);
}

/**
 * Headless stderr contract (DeepSeek Harness 0.1.2): reasoning deltas are
 * streamed as `dsh: reasoning: ...` and failures are reported as
 * `dsh: <code>: <message>`. Reasoning on a failed run is diagnostic noise, not
 * the failure itself, so prefer the structured failure lines when present.
 */
function extractHeadlessFailureDiagnostic(standardError: string): string | null {
  const failureLines = standardError
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^dsh:/.test(line) && !line.startsWith("dsh: reasoning:"));
  return failureLines.length === 0 ? null : failureLines.join("\n");
}

/**
 * Validation commands run through the platform shell: POSIX gets /bin/sh, and
 * Windows gets cmd.exe with the documented /d /s /c argument shape.
 */
function validationShellInvocation(validationCommand: string): {
  readonly executable: string;
  readonly arguments: readonly string[];
} {
  if (process.platform === "win32") {
    return { executable: process.env.ComSpec ?? "cmd.exe", arguments: ["/d", "/s", "/c", validationCommand] };
  }
  return { executable: "/bin/sh", arguments: ["-lc", validationCommand] };
}

function assertRequestDoesNotContainCredential(
  task: string,
  validationCommands: readonly string[],
  credentialValue: string,
): void {
  if (task.includes(credentialValue)) {
    throw new Error("task contains the resolved credential and was rejected");
  }
  const credentialCommandIndex = validationCommands.findIndex((command) => command.includes(credentialValue));
  if (credentialCommandIndex >= 0) {
    throw new Error(
      `validationCommands[${credentialCommandIndex}] contains the resolved credential and was rejected`,
    );
  }
}

async function executeCandidate(request: CandidateExecutionRequest): Promise<CandidateResult> {
  const startedAt = Date.now();
  const candidateLogPath = join(request.candidateArtifactsDirectory, "candidate.log");
  const logPaths: string[] = [];
  let processExitCode: number | null = null;
  let candidateResponse = "";
  await mkdir(request.candidateArtifactsDirectory, { recursive: true });
  try {
    const dshHomeDirectory = request.config.dshHomeDirectory
      ?? process.env.DSH_HOME
      ?? join(homedir(), ".dsh");
    const candidateEnvironment = sanitizedEnvironment(process.env, {
      DSH_HOME: dshHomeDirectory,
      DSH_PERMISSION_MODE: "workspace-write",
      ...(request.credentialValue.length > 0
        ? { [request.config.credentialRef]: request.credentialValue }
        : {}),
    });
    const taskPrompt = [
      request.task,
      "",
      "ISOLATION CONTRACT (mandatory, overrides any conflicting instruction above):",
      "- Your current working directory IS the isolated Git worktree for this task.",
      "- Touch only files under your current working directory. Never cd elsewhere and never write outside it.",
      "- Absolute paths in the task above that point outside the current working directory refer to the matching file inside this worktree; use the relative path instead.",
      "- Do not commit or push. Finish with a concise summary.",
    ].join("\n");
    const processResult = await runProcess({
      executable: request.config.dshExecutable,
      arguments: ["--profile", request.config.candidateProfile, taskPrompt],
      cwd: request.worktreePath,
      env: candidateEnvironment,
      timeoutMs: request.config.candidateTimeoutMs,
      signal: request.signal,
    });
    processExitCode = processResult.exitCode;
    const redactedStandardOutput = redactSecret(processResult.stdout, request.credentialValue);
    const redactedStandardError = redactSecret(processResult.stderr, request.credentialValue);
    candidateResponse = redactedStandardOutput;
    const processDiagnostics = [
      redactedStandardOutput,
      redactedStandardError.length === 0 ? "" : `[stderr]\n${redactedStandardError}`,
      `[exit code: ${processResult.exitCode}]`,
      processResult.timedOut ? "[candidate timed out]" : "",
      processResult.aborted ? "[candidate cancelled]" : "",
      processResult.outputLimitExceeded ? "[output exceeded the 16 MiB safety limit]" : "",
      processResult.residualProcessGroupDetected
        ? "[candidate left a residual process group; it was force-terminated]"
        : "",
      processResult.residualProcessGroupRemaining
        ? "[candidate residual process group remains after SIGKILL]"
        : "",
    ].filter((part) => part.length > 0).join("\n");
    await writePrivateTextFile(
      candidateLogPath,
      processDiagnostics,
    );
    logPaths.push(candidateLogPath);

    const executionStatus = processResult.aborted
      ? "cancelled"
      : processResult.timedOut
        ? "timed_out"
        : processResult.exitCode === 0
          && !processResult.outputLimitExceeded
          && !processResult.residualProcessGroupDetected
          ? "completed"
          : "failed";
    if (executionStatus !== "completed") {
      let failure: string;
      if (processResult.timedOut) {
        failure = `candidate timed out after ${request.config.candidateTimeoutMs} ms`;
      } else if (processResult.aborted) {
        failure = "candidate was cancelled";
      } else if (processResult.outputLimitExceeded) {
        failure = "candidate output exceeded the 16 MiB safety limit";
      } else if (processResult.residualProcessGroupRemaining) {
        failure = "candidate left a process group that remains after SIGKILL";
      } else if (processResult.residualProcessGroupDetected) {
        failure = "candidate left a residual process group; the plugin force-terminated it";
      } else {
        const headlessFailure = extractHeadlessFailureDiagnostic(redactedStandardError);
        failure = headlessFailure
          ?? (redactedStandardError.trim().length === 0
            ? `candidate exited with code ${processResult.exitCode}`
            : redactedStandardError.trim());
      }
      return {
        candidateId: request.candidateId,
        executionStatus,
        validationStatus: "not_run",
        durationMs: Date.now() - startedAt,
        processExitCode,
        response: redactedStandardOutput,
        changedFiles: [],
        binaryFiles: [],
        diffStat: "",
        verifierTrace: "",
        verifierTraceTruncated: false,
        patchPath: null,
        patchSha256: null,
        logPaths,
        failure,
        score: null,
        rankingPosition: null,
      };
    }

    const changes = await captureCandidateChanges(
      request.worktreePath,
      request.repository.baseCommit,
      request.candidateArtifactsDirectory,
      request.credentialValue,
    );
    const validationEvidence: string[] = [];
    let validationStatus: CandidateResult["validationStatus"] = "passed";
    let validationFailure: string | null = null;
    const validationEnvironment = sanitizedEnvironment(process.env);
    for (const [commandIndex, validationCommand] of request.validationCommands.entries()) {
      const validationShell = validationShellInvocation(validationCommand);
      const validationResult = await runProcess({
        executable: validationShell.executable,
        arguments: validationShell.arguments,
        cwd: request.worktreePath,
        env: validationEnvironment,
        timeoutMs: request.config.validationTimeoutMs,
        signal: request.signal,
      });
      const validationOutput = redactSecret([
        `$ ${validationCommand}`,
        validationResult.stdout,
        validationResult.stderr.length === 0 ? "" : `[stderr]\n${validationResult.stderr}`,
        `[exit code: ${validationResult.exitCode}]`,
        validationResult.outputLimitExceeded ? "[output exceeded the 16 MiB safety limit]" : "",
        validationResult.residualProcessGroupDetected
          ? "[validation left a residual process group; it was force-terminated]"
          : "",
        validationResult.residualProcessGroupRemaining
          ? "[validation residual process group remains after SIGKILL]"
          : "",
      ].filter((part) => part.length > 0).join("\n"), request.credentialValue);
      validationEvidence.push(validationOutput);
      const validationLogPath = join(
        request.candidateArtifactsDirectory,
        `validation-${commandIndex + 1}.log`,
      );
      await writePrivateTextFile(
        validationLogPath,
        validationOutput,
      );
      logPaths.push(validationLogPath);
      if (validationResult.timedOut || validationResult.aborted) {
        validationStatus = "timed_out";
        validationFailure = `validation command timed out or was cancelled: ${validationCommand}`;
        break;
      }
      if (
        validationResult.exitCode !== 0
        || validationResult.outputLimitExceeded
        || validationResult.residualProcessGroupDetected
      ) {
        validationStatus = "failed";
        validationFailure = validationResult.residualProcessGroupDetected
          ? `validation command left a residual process group: ${validationCommand}`
          : `validation command failed with exit code ${validationResult.exitCode}: ${validationCommand}`;
        break;
      }
    }

    const binaryFileEvidence = changes.binaryFiles.length === 0
      ? "None."
      : changes.binaryFiles.map((binaryFile) => [
        `path=${JSON.stringify(binaryFile.path)}`,
        `sizeBytes=${binaryFile.sizeBytes}`,
        `gitObjectHash=${binaryFile.gitObjectHash}`,
        `state=${binaryFile.state}`,
      ].join("; ")).join("\n");
    const completeVerifierTrace = [
      `Candidate: ${request.candidateId}`,
      `Final response:\n${redactedStandardOutput}`,
      `Changed files:\n${changes.changedFiles.join("\n")}`,
      `Binary files (metadata only; no binary content):\n${binaryFileEvidence}`,
      `Diff stat:\n${changes.diffStat}`,
      `Text diff:\n${redactSecret(changes.verifierDiff, request.credentialValue)}`,
      `Validation evidence:\n${validationEvidence.join("\n\n")}`,
    ].join("\n\n");
    const completeVerifierTracePath = join(
      request.candidateArtifactsDirectory,
      "verifier-input.full.txt",
    );
    await writePrivateTextFile(completeVerifierTracePath, completeVerifierTrace);
    logPaths.push(completeVerifierTracePath);
    const verifierTrace = truncateVerifierTrace(
      completeVerifierTrace,
      request.config.maxVerifierTraceBytes,
    );
    return {
      candidateId: request.candidateId,
      executionStatus: "completed",
      validationStatus,
      durationMs: Date.now() - startedAt,
      processExitCode,
      response: redactedStandardOutput,
      changedFiles: changes.changedFiles,
      binaryFiles: changes.binaryFiles,
      diffStat: changes.diffStat,
      verifierTrace: verifierTrace.text,
      verifierTraceTruncated: verifierTrace.truncated,
      patchPath: changes.patchPath,
      patchSha256: changes.patchSha256,
      logPaths,
      failure: validationFailure,
      score: null,
      rankingPosition: null,
    };
  } catch (error) {
    let candidateFailure = failureMessage(error, request.credentialValue);
    if (!logPaths.includes(candidateLogPath)) {
      try {
        await writePrivateTextFile(candidateLogPath, `[candidate failure]\n${candidateFailure}\n`);
        logPaths.push(candidateLogPath);
      } catch (logError) {
        candidateFailure = `${candidateFailure}; failed to write ${candidateLogPath}: ${failureMessage(logError, request.credentialValue)}`;
      }
    }
    return {
      candidateId: request.candidateId,
      executionStatus: request.signal.aborted ? "cancelled" : "failed",
      validationStatus: "not_run",
      durationMs: Date.now() - startedAt,
      processExitCode,
      response: candidateResponse,
      changedFiles: [],
      binaryFiles: [],
      diffStat: "",
      verifierTrace: "",
      verifierTraceTruncated: false,
      patchPath: null,
      patchSha256: null,
      logPaths,
      failure: candidateFailure,
      score: null,
      rankingPosition: null,
    };
  }
}

function validateVerifierResponse(
  verifierResponse: VerifierResponse,
  eligibleCandidateCount: number,
): void {
  if (
    !Number.isInteger(verifierResponse.winnerIndex)
    || verifierResponse.winnerIndex < 0
    || verifierResponse.winnerIndex >= eligibleCandidateCount
  ) {
    throw new Error(
      `invalid verifier winnerIndex: expected 0-${eligibleCandidateCount - 1}, got ${JSON.stringify(verifierResponse.winnerIndex)}`,
    );
  }
  if (
    verifierResponse.scores.length !== eligibleCandidateCount
    || verifierResponse.scores.some((score) => !Number.isFinite(score))
  ) {
    throw new Error(
      `invalid verifier scores: expected ${eligibleCandidateCount} finite scores, got ${JSON.stringify(verifierResponse.scores)}`,
    );
  }
  const rankingSet = new Set(verifierResponse.ranking);
  if (
    verifierResponse.ranking.length !== eligibleCandidateCount
    || rankingSet.size !== eligibleCandidateCount
    || verifierResponse.ranking.some((candidateIndex) => !Number.isInteger(candidateIndex) || candidateIndex < 0 || candidateIndex >= eligibleCandidateCount)
  ) {
    throw new Error(`invalid verifier ranking: ${JSON.stringify(verifierResponse.ranking)}`);
  }
  if (verifierResponse.ranking[0] !== verifierResponse.winnerIndex) {
    throw new Error(
      `invalid verifier winner: winnerIndex ${verifierResponse.winnerIndex} does not match ranking[0] ${JSON.stringify(verifierResponse.ranking[0])}`,
    );
  }
}

function publicCandidate(candidate: CandidateResult): PublicCandidateResult {
  return {
    candidateId: candidate.candidateId,
    executionStatus: candidate.executionStatus,
    validationStatus: candidate.validationStatus,
    score: candidate.score,
    changedFiles: candidate.changedFiles,
    diffStat: candidate.diffStat,
    durationMs: candidate.durationMs,
    failure: candidate.failure,
  };
}

function reportMarkdown(
  result: VerifiedBestOfResult,
  candidateResults: readonly CandidateResult[],
  cleanupWarnings: readonly string[],
  config: RunSettings,
  verifierLogPath: string | null,
): string {
  const tableCell = (value: string): string => value
    .replaceAll("|", "\\|")
    .replaceAll("\r\n", "<br>")
    .replaceAll("\n", "<br>");
  const candidateRows = candidateResults.map((candidate) => [
    candidate.rankingPosition === null ? "—" : String(candidate.rankingPosition),
    candidate.candidateId,
    candidate.executionStatus,
    candidate.processExitCode === null ? "—" : String(candidate.processExitCode),
    candidate.validationStatus,
    candidate.score === null ? "—" : String(candidate.score),
    String(candidate.durationMs),
    candidate.changedFiles.join(", ") || "—",
    candidate.diffStat || "—",
    candidate.patchPath ?? "—",
    candidate.patchSha256 ?? "—",
    candidate.logPaths.join("<br>") || "—",
    candidate.failure ?? "—",
  ].map(tableCell).join(" | "));
  const winnerCandidate = candidateResults.find((candidate) => candidate.candidateId === result.winnerId);
  const reportWarnings = [
    ...cleanupWarnings,
    ...candidateResults
      .filter((candidate) => candidate.verifierTraceTruncated)
      .map((candidate) => `${candidate.candidateId} verifier input was truncated; complete input: ${candidate.logPaths.find((path) => path.endsWith("verifier-input.full.txt")) ?? "path unavailable"}`),
  ];
  const binaryFileRows = candidateResults.flatMap((candidate) => candidate.binaryFiles.map(
    (binaryFile) => `- ${candidate.candidateId}: path=${JSON.stringify(binaryFile.path)}, size=${binaryFile.sizeBytes} bytes, hash=${binaryFile.gitObjectHash}, state=${binaryFile.state}`,
  ));
  return [
    "# DeepSeek Harness verified Best-of report",
    "",
    `- Run: \`${result.runId}\``,
    `- Base commit: \`${result.baseCommit}\``,
    `- Plugin version: \`${PLUGIN_VERSION}\``,
    `- Requested candidates: ${result.requestedCandidateCount}`,
    `- Candidate Harness tasks launched: ${candidateResults.length}`,
    `- Completed candidates: ${result.completedCandidateCount}`,
    `- Eligible candidates: ${result.eligibleCandidateCount}`,
    `- Candidates entered into ranking: ${result.eligibleCandidateCount}`,
    `- Status: \`${result.status}\``,
    `- Selection: \`${result.selectionMethod ?? "none"}\``,
    `- Winner: \`${result.winnerId ?? "none"}\``,
    `- DeepSeek verifier requests: ${result.verifierRequestCount}`,
    "- Candidate generation token usage: unavailable (the headless Harness response does not expose structured usage)",
    ...(result.review !== null
      ? [
        `- Reviewer provider: \`${result.review.provider}\``,
        `- Reviewer model: \`${result.review.model}\``,
        `- Configured reviewer reasoning effort: \`${config.reviewerReasoningEffort || "default"}\``,
        `- Reviewer duration ms: ${result.review.durationMs}`,
      ]
      : result.verifierRequestCount > 0
        ? [
          `- Verifier model: \`${config.verifierModel}\``,
          `- Verifier repetitions: ${config.nEvaluations}`,
        ]
        : ["- Model review: no completed model review"]),
    `- Token usage: \`${JSON.stringify(result.tokenUsage)}\``,
    `- Verifier log: \`${verifierLogPath ?? "not run"}\``,
    `- Winner patch: \`${result.winnerPatchPath ?? "none"}\``,
    `- Winner patch SHA-256: \`${winnerCandidate?.patchSha256 ?? "none"}\``,
    `- Report path: \`${result.reportPath}\``,
    `- Failure: ${result.failure ?? "none"}`,
    "",
    "| Rank | Candidate | Execution | Exit | Validation | Score | Duration ms | Changed files | Diff stat | Patch path | Patch SHA-256 | Complete logs | Failure |",
    "|---:|---|---|---:|---|---:|---:|---|---|---|---|---|---|",
    ...candidateRows.map((row) => `| ${row} |`),
    "",
    "## Binary file metadata",
    "",
    ...(binaryFileRows.length === 0 ? ["None."] : binaryFileRows),
    "",
    "## Warnings",
    "",
    ...(reportWarnings.length === 0 ? ["None."] : reportWarnings.map((warning) => `- ${warning}`)),
    "",
  ].join("\n");
}

/**
 * Run every worktree through `worker` with at most `limit` concurrent
 * executions, preserving one result per worktree in input order. Queued
 * candidates are skipped (marked cancelled) once `signal` aborts.
 */
async function runCandidatePool(
  worktreePaths: string[],
  limit: number,
  worker: (worktreePath: string, candidateIndex: number) => Promise<CandidateResult>,
): Promise<CandidateResult[]> {
  const concurrency = Math.max(1, Math.min(limit, worktreePaths.length));
  const results: CandidateResult[] = new Array(worktreePaths.length);
  let nextIndex = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (nextIndex < worktreePaths.length) {
      const candidateIndex = nextIndex;
      nextIndex += 1;
      const worktreePath = worktreePaths[candidateIndex];
      if (worktreePath === undefined) continue;
      results[candidateIndex] = await worker(worktreePath, candidateIndex);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function runVerifiedBestOf(
  input: RunVerifiedBestOfInput,
  config: RunSettings,
  dependencies: RuntimeDependencies,
): Promise<VerifiedBestOfResult> {
  const task = validateTask(input.task);
  const candidateCount: CandidateCount = normalizeCandidateCount(input.candidateCount, config.defaultCandidateCount);
  if (!CREDENTIAL_REFERENCE.test(config.credentialRef)) {
    throw new Error(
      `invalid credentialRef: expected a POSIX environment name, got ${JSON.stringify(config.credentialRef)}`,
    );
  }
  const repository = await inspectRepository(input.repositoryPath);
  const validationCommands = await resolveValidationCommands(
    repository.repositoryPath,
    input.validationCommands,
  );
  const stateDirectory = await canonicalStateDirectory(config.stateDirectory, repository.repositoryPath);
  await assertEnoughDiskSpace(stateDirectory, candidateCount);
  const approvalSignal = input.signal ?? new AbortController().signal;
  await dependencies.requestApproval(
    createApprovalReason(repository, candidateCount, validationCommands, config),
    approvalSignal,
  );
  // Optional until LLM ranking needs it: validation-only selection completes
  // without any verifier credential.
  const credentialValue = await dependencies.resolveCredential();
  if (credentialValue.length > 0) {
    assertRequestDoesNotContainCredential(task, validationCommands, credentialValue);
  }

  const runAbortController = new AbortController();
  const relayAbort = (): void => runAbortController.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", relayAbort, { once: true });
  const runTimeout = setTimeout(
    () => runAbortController.abort(new Error(`run timed out after ${config.runTimeoutMs} ms`)),
    config.runTimeoutMs,
  );
  runTimeout.unref();

  try {
  const runId = randomUUID();
  progress(`run ${runId} starting: ${candidateCount} candidates, validation: ${validationCommands.join("; ")}`);
  const runDirectory = join(stateDirectory, "runs", runId);
  const worktreesDirectory = join(runDirectory, "worktrees");
  const artifactsDirectory = join(runDirectory, "artifacts");
  await mkdir(worktreesDirectory, { recursive: true, mode: 0o700 });
  await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });

  const worktreePaths: string[] = [];
  const cleanupWarnings: string[] = [];
  let candidateResults: CandidateResult[];
  try {
    for (let candidateNumber = 1; candidateNumber <= candidateCount; candidateNumber += 1) {
      const candidateId = `candidate-${candidateNumber}`;
      const worktreePath = join(worktreesDirectory, candidateId);
      progress(`creating worktree ${candidateNumber}/${candidateCount}`);
      await createDetachedWorktree(repository, worktreePath, runAbortController.signal);
      worktreePaths.push(worktreePath);
    }
    progress(`launching ${candidateCount} candidates (max ${config.maxConcurrentCandidates} concurrent)`);
    candidateResults = await runCandidatePool(worktreePaths, config.maxConcurrentCandidates, (worktreePath, candidateIndex) => {
      const candidateId = `candidate-${candidateIndex + 1}`;
      progress(`candidate ${candidateId} started`);
      return executeCandidate({
        candidateId,
        worktreePath,
        candidateArtifactsDirectory: join(artifactsDirectory, candidateId),
        task,
        validationCommands,
        repository,
        config,
        credentialValue,
        signal: runAbortController.signal,
      });
    });
  } finally {
    for (const worktreePath of [...worktreePaths].reverse()) {
      try {
        await removeWorktree(repository.repositoryPath, worktreePath);
      } catch (error) {
        const cleanupFailure = error instanceof Error ? error.message : String(error);
        cleanupWarnings.push(
          `worktree cleanup failed; residual directory may remain at ${worktreePath}: ${cleanupFailure}`,
        );
      }
    }
    try {
      await runGit(repository.repositoryPath, ["worktree", "prune"]);
    } catch (error) {
      cleanupWarnings.push(error instanceof Error ? error.message : String(error));
    }
  }

  for (const candidate of candidateResults) {
    progress(`candidate ${candidate.candidateId}: ${candidate.executionStatus}/${candidate.validationStatus} (${candidate.durationMs}ms)`);
  }
  const eligibleCandidates = candidateResults.filter(
    (candidate) => candidate.executionStatus === "completed" && candidate.validationStatus === "passed",
  );
  progress(`${eligibleCandidates.length}/${candidateResults.length} candidates eligible`);
  let status: VerifiedBestOfResult["status"] = "no_winner";
  let selectionMethod: VerifiedBestOfResult["selectionMethod"] = null;
  let winner: CandidateResult | undefined;
  let tokenUsage: VerifiedBestOfResult["tokenUsage"] = null;
  let verifierRequestCount = 0;
  let verifierLogPath: string | null = null;
  let reviewReceipt: ReviewReceipt | null = null;
  let selectionFailure: string | null = runAbortController.signal.aborted
    ? "run was cancelled or exceeded its total timeout"
    : null;

  const enterReviewPending = (reason: string): void => {
    status = "review_pending";
    selectionMethod = null;
    winner = undefined;
    progress(`run ${runId}: review_pending — ${reason}`);
  };

  if (selectionFailure === null && eligibleCandidates.length === 1 && !config.reviewSingleEligible) {
    status = "winner_selected";
    selectionMethod = "validation_only";
    winner = eligibleCandidates[0];
    if (winner !== undefined) {
      winner.score = 1;
      winner.rankingPosition = 1;
    }
  } else if (selectionFailure === null && eligibleCandidates.length >= 1) {
    if (config.reviewMode === "parent_agent") {
      // Parent-agent mode never auto-selects: the run stays review_pending
      // until an explicit select_verified_candidate call records the choice.
      enterReviewPending("parent agent must pick a winner via select_verified_candidate");
      for (const [index, candidate] of eligibleCandidates.entries()) {
        candidate.rankingPosition = index + 1;
      }
    } else if (config.reviewMode === "dsh_model") {
      if (dependencies.reviewCandidates === undefined) {
        if (config.reviewFailurePolicy === "parent_agent") {
          enterReviewPending("no host LLM runtime is available for reviewMode 'dsh_model'");
        } else {
          status = "failed";
          selectionFailure = "reviewMode 'dsh_model' requires the host LLM runtime (ctx.llm), which is unavailable";
        }
      } else {
        try {
          const diffTexts: string[] = [];
          for (const candidate of eligibleCandidates) {
            if (candidate.patchPath === null) {
              diffTexts.push("");
              continue;
            }
            try {
              diffTexts.push(await readFile(candidate.patchPath, "utf8"));
            } catch {
              diffTexts.push("");
            }
          }
          const receipt = await dependencies.reviewCandidates({
            provider: config.reviewerProvider,
            model: config.reviewerModel,
            ...(config.reviewerReasoningEffort !== "" ? { reasoningEffort: config.reviewerReasoningEffort } : {}),
            maxTokens: config.reviewerMaxTokens,
            timeoutMs: config.reviewerTimeoutMs,
            signal: runAbortController.signal,
            task,
            candidates: eligibleCandidates.map((candidate, index) => ({
              candidateId: candidate.candidateId,
              validationStatus: candidate.validationStatus,
              diffStat: candidate.diffStat,
              changedFiles: candidate.changedFiles,
              diffText: diffTexts[index] ?? "",
            })),
          });
          reviewReceipt = receipt;
          status = "winner_selected";
          selectionMethod = "dsh_model";
          winner = eligibleCandidates.find((candidate) => candidate.candidateId === receipt.selectedId);
          for (const candidate of eligibleCandidates) {
            candidate.score = receipt.scores[candidate.candidateId] ?? null;
          }
          const ranked = [...eligibleCandidates].sort((left, right) => {
            const byScore = (right.score ?? 0) - (left.score ?? 0);
            return byScore !== 0 ? byScore : left.candidateId.localeCompare(right.candidateId);
          });
          for (const [index, candidate] of ranked.entries()) {
            candidate.rankingPosition = index + 1;
          }
          progress(`dsh_model review selected ${receipt.selectedId} in ${receipt.durationMs}ms`);
        } catch (error) {
          const failure = failureMessage(error, credentialValue);
          if (config.reviewFailurePolicy === "parent_agent") {
            enterReviewPending(`dsh_model review failed (${failure}); policy hands off to the parent agent`);
          } else {
            status = "failed";
            selectionFailure = failure;
          }
        }
      }
    } else if (config.reviewMode === "deepseek_verifier") {
      if (eligibleCandidates.length === 1) {
        // The comparison bridge accepts 2-5 inputs; a single candidate cannot
        // be compared without fabricating inputs, so it goes to review unless
        // the operator accepted validation-only for single candidates.
        if (config.reviewSingleEligible) {
          enterReviewPending("single eligible candidate cannot enter the comparison bridge; parent review required");
        } else {
          status = "winner_selected";
          selectionMethod = "validation_only";
          winner = eligibleCandidates[0];
          if (winner !== undefined) {
            winner.score = 1;
            winner.rankingPosition = 1;
          }
        }
      } else if (credentialValue.length === 0) {
        if (config.reviewFailurePolicy === "parent_agent") {
          enterReviewPending(`credential ${config.credentialRef} is not configured; policy hands off to the parent agent`);
        } else {
          status = "failed";
          selectionFailure = `reviewMode 'deepseek_verifier' requires credential ${config.credentialRef}, which is not configured`;
        }
      } else {
        verifierLogPath = join(runDirectory, "verifier.log");
        let verifierResponseForLog: VerifierResponse | undefined;
        try {
          const verifierResponse = await dependencies.runVerifier({
            task,
            candidates: eligibleCandidates.map((candidate) => ({
              candidateId: candidate.candidateId,
              trajectory: candidate.verifierTrace,
            })),
            pivots: Math.min(2, eligibleCandidates.length - 1),
            model: config.verifierModel,
            nEvaluations: config.nEvaluations,
            maxWorkers: config.maxVerifierWorkers,
            cachePath: join(runDirectory, "verifier-cache.json"),
            signal: runAbortController.signal,
          });
          verifierResponseForLog = verifierResponse;
          await writePrivateTextFile(
            verifierLogPath,
            redactSecret(`${JSON.stringify({
              candidateIds: eligibleCandidates.map((candidate) => candidate.candidateId),
              pivots: Math.min(2, eligibleCandidates.length - 1),
              model: config.verifierModel,
              nEvaluations: config.nEvaluations,
              maxWorkers: config.maxVerifierWorkers,
              response: verifierResponse,
            }, null, 2)}\n`, credentialValue),
          );
          validateVerifierResponse(verifierResponse, eligibleCandidates.length);
          for (const [candidateIndex, candidate] of eligibleCandidates.entries()) {
            candidate.score = verifierResponse.scores[candidateIndex] ?? null;
          }
          for (const [rankingIndex, candidateIndex] of verifierResponse.ranking.entries()) {
            const rankedCandidate = eligibleCandidates[candidateIndex];
            if (rankedCandidate !== undefined) {
              rankedCandidate.rankingPosition = rankingIndex + 1;
            }
          }
          winner = eligibleCandidates[verifierResponse.winnerIndex];
          status = "winner_selected";
          selectionMethod = "llm_verifier";
          tokenUsage = verifierResponse.tokenUsage;
          verifierRequestCount = verifierResponse.requestCount;
        } catch (error) {
          if (config.reviewFailurePolicy === "parent_agent") {
            enterReviewPending("deepseek_verifier review failed; policy hands off to the parent agent");
            await writePrivateTextFile(
              verifierLogPath,
              redactSecret(`${JSON.stringify({
                candidateIds: eligibleCandidates.map((candidate) => candidate.candidateId),
                failure: failureMessage(error, credentialValue),
                response: verifierResponseForLog,
              }, null, 2)}\n`, credentialValue),
            ).catch(() => {});
          } else {
            status = "failed";
            selectionFailure = failureMessage(error, credentialValue);
            await writePrivateTextFile(
              verifierLogPath,
              redactSecret(`${JSON.stringify({
                candidateIds: eligibleCandidates.map((candidate) => candidate.candidateId),
                pivots: Math.min(2, eligibleCandidates.length - 1),
                model: config.verifierModel,
                nEvaluations: config.nEvaluations,
                maxWorkers: config.maxVerifierWorkers,
                failure: selectionFailure,
                response: verifierResponseForLog,
              }, null, 2)}\n`, credentialValue),
            );
          }
        }
      }
    }
  } else if (selectionFailure !== null) {
    status = "failed";
  }

  if (runAbortController.signal.aborted) {
    status = "failed";
    selectionMethod = null;
    winner = undefined;
    selectionFailure = "run was cancelled or exceeded its total timeout";
  }

  let winnerPatchPath: string | null = null;
  let winnerPatchSha256: string | null = null;
  if (winner?.patchPath !== null && winner?.patchPath !== undefined) {
    winnerPatchPath = join(runDirectory, "winner.patch");
    // Re-apply after rollback: winner.patch already exists from the previous
    // apply; overwrite only when its bytes still match the recorded hash.
    try {
      const existingSha = createHash("sha256").update(await readFile(winnerPatchPath)).digest("hex");
      if (existingSha !== winner.patchSha256) {
        throw new Error(
          `winner.patch already exists with different content (sha ${existingSha.slice(0, 12)}…); refusing to overwrite`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await copyFile(winner.patchPath, winnerPatchPath);
    winnerPatchSha256 = winner.patchSha256;
  }

  progress(`run ${runId} complete: status=${status}, winner=${winner?.candidateId ?? "none"}`);
  const reportPath = join(runDirectory, "report.md");
  const resolvedConfig: Record<string, string | number | boolean | string[]> = {
    enabled: config.enabled,
    defaultCandidateCount: config.defaultCandidateCount,
    maxConcurrentCandidates: config.maxConcurrentCandidates,
    candidateProfile: config.candidateProfile,
    reviewMode: config.reviewMode,
    reviewerProvider: config.reviewerProvider,
    reviewerModel: config.reviewerModel,
    reviewerReasoningEffort: config.reviewerReasoningEffort,
    reviewerMaxTokens: config.reviewerMaxTokens,
    reviewerTimeoutMs: config.reviewerTimeoutMs,
    reviewSingleEligible: config.reviewSingleEligible,
    reviewFailurePolicy: config.reviewFailurePolicy,
    validationMode: config.validationMode,
    validationCommands: [...validationCommands],
    credentialRef: config.credentialRef,
    verifierModel: config.verifierModel,
    nEvaluations: config.nEvaluations,
    maxVerifierWorkers: config.maxVerifierWorkers,
    verifierEffort: config.verifierEffort,
    verifierMaxTokens: config.verifierMaxTokens,
    candidateTimeoutMs: config.candidateTimeoutMs,
    validationTimeoutMs: config.validationTimeoutMs,
    runTimeoutMs: config.runTimeoutMs,
    maxVerifierTraceBytes: config.maxVerifierTraceBytes,
    stateDirectory: config.stateDirectory,
  };
  const result: VerifiedBestOfResult = {
    schemaVersion: 2,
    runId,
    baseCommit: repository.baseCommit,
    requestedCandidateCount: candidateCount,
    completedCandidateCount: candidateResults.filter(
      (candidate) => candidate.executionStatus === "completed",
    ).length,
    eligibleCandidateCount: eligibleCandidates.length,
    status,
    selectionMethod,
    winnerId: winner?.candidateId ?? null,
    ranking: [...candidateResults]
      .sort((left, right) => {
        const rankDifference = (left.rankingPosition ?? Number.POSITIVE_INFINITY)
          - (right.rankingPosition ?? Number.POSITIVE_INFINITY);
        return rankDifference === 0
          ? left.candidateId.localeCompare(right.candidateId)
          : rankDifference;
      })
      .map(publicCandidate),
    tokenUsage,
    verifierRequestCount,
    reportPath,
    winnerPatchPath,
    failure: selectionFailure,
    review: reviewReceipt,
    resolvedConfig,
    settingsRevision: input.settingsRevision ?? null,
  };
  const manifestPath = join(runDirectory, "manifest.json");
  await writePrivateTextFile(
    manifestPath,
    `${JSON.stringify({
      schemaVersion: 2,
      pluginVersion: PLUGIN_VERSION,
      createdAt: new Date().toISOString(),
      repositoryPath: repository.repositoryPath,
      baseCommit: repository.baseCommit,
      validationCommands,
      winnerPatchSha256,
      verifierLogPath,
      resolvedConfig,
      settingsRevision: input.settingsRevision ?? null,
      candidateRuns: candidateResults.map((candidate) => ({
        candidateId: candidate.candidateId,
        executionStatus: candidate.executionStatus,
        processExitCode: candidate.processExitCode,
        validationStatus: candidate.validationStatus,
        durationMs: candidate.durationMs,
        rankingPosition: candidate.rankingPosition,
        score: candidate.score,
        changedFiles: candidate.changedFiles,
        binaryFiles: candidate.binaryFiles,
        diffStat: candidate.diffStat,
        patchPath: candidate.patchPath,
        patchSha256: candidate.patchSha256,
        logPaths: candidate.logPaths,
        verifierTraceTruncated: candidate.verifierTraceTruncated,
        failure: candidate.failure,
      })),
      warnings: [
        ...cleanupWarnings,
        ...candidateResults
          .filter((candidate) => candidate.verifierTraceTruncated)
          .map((candidate) => `${candidate.candidateId} verifier input was truncated`),
      ],
      result,
    }, null, 2)}\n`,
  );
  await writePrivateTextFile(
    reportPath,
    reportMarkdown(result, candidateResults, cleanupWarnings, config, verifierLogPath),
  );

  return result;
  } finally {
    clearTimeout(runTimeout);
    input.signal?.removeEventListener("abort", relayAbort);
  }
}

function requiredManifestString(
  manifestObject: Record<string, unknown>,
  fieldName: string,
): string {
  const value = manifestObject[fieldName];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid run manifest ${fieldName}: ${JSON.stringify(value)}`);
  }
  return value;
}

function parseStoredRunManifest(manifestText: string, selectionText?: string): StoredRunManifest {
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestText);
  } catch (error) {
    throw new Error("run manifest contains invalid JSON", { cause: error });
  }
  if (manifestValue === null || typeof manifestValue !== "object" || Array.isArray(manifestValue)) {
    throw new Error(`invalid run manifest root: ${JSON.stringify(manifestValue)}`);
  }
  const manifest = manifestValue as Record<string, unknown>;
  if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) {
    throw new Error(`unsupported run manifest schemaVersion: ${JSON.stringify(manifest.schemaVersion)}`);
  }
  const resultValue = manifest.result;
  if (resultValue === null || typeof resultValue !== "object" || Array.isArray(resultValue)) {
    throw new Error(`invalid run manifest result: ${JSON.stringify(resultValue)}`);
  }
  const result = resultValue as Record<string, unknown>;
  const status = result.status;
  if (status !== "winner_selected" && status !== "review_pending") {
    throw new Error(`run ${JSON.stringify(result.runId)} has no applicable winner; status is ${JSON.stringify(status)}`);
  }
  const validationCommands = manifest.validationCommands;
  if (
    !Array.isArray(validationCommands)
    || validationCommands.length === 0
    || validationCommands.some((command) => typeof command !== "string" || command.length === 0)
  ) {
    throw new Error(`invalid run manifest validationCommands: ${JSON.stringify(validationCommands)}`);
  }
  const rankingValue = result.ranking;
  if (!Array.isArray(rankingValue)) {
    throw new Error(`invalid run manifest ranking: ${JSON.stringify(rankingValue)}`);
  }
  const candidateRuns = Array.isArray(manifest.candidateRuns) ? (manifest.candidateRuns as Array<Record<string, unknown>>) : [];
  let winnerId: string;
  let winnerPatchSha256: string;
  let winnerPatchPath: string | null;
  let changedFiles: string[];
  if (status === "winner_selected") {
    winnerId = requiredManifestString(result, "winnerId");
    winnerPatchSha256 = requiredManifestString(manifest, "winnerPatchSha256");
    if (!/^[0-9a-f]{64}$/u.test(winnerPatchSha256)) {
      throw new Error(`invalid run manifest winnerPatchSha256: ${JSON.stringify(winnerPatchSha256)}`);
    }
    winnerPatchPath = requiredManifestString(result, "winnerPatchPath");
    const winnerEntry = rankingValue.find((entry) => {
      return entry !== null
        && typeof entry === "object"
        && !Array.isArray(entry)
        && (entry as Record<string, unknown>).candidateId === winnerId;
    });
    if (winnerEntry === undefined) {
      throw new Error(`run manifest winner ${JSON.stringify(winnerId)} is absent from ranking`);
    }
    const changedFilesValue = (winnerEntry as Record<string, unknown>).changedFiles;
    if (!Array.isArray(changedFilesValue) || changedFilesValue.some((path) => typeof path !== "string")) {
      throw new Error(`invalid winner changedFiles: ${JSON.stringify(changedFilesValue)}`);
    }
    changedFiles = changedFilesValue as string[];
  } else {
    if (selectionText === undefined) {
      throw new Error(
        `run ${JSON.stringify(result.runId)} is awaiting an explicit reviewer choice; call select_verified_candidate first`,
      );
    }
    let selectionValue: unknown;
    try {
      selectionValue = JSON.parse(selectionText);
    } catch (error) {
      throw new Error("selection record contains invalid JSON", { cause: error });
    }
    if (selectionValue === null || typeof selectionValue !== "object" || Array.isArray(selectionValue)) {
      throw new Error("invalid selection record root");
    }
    const record = selectionValue as Record<string, unknown>;
    if (record.status !== "selected") {
      throw new Error(`invalid selection record status: ${JSON.stringify(record.status)}`);
    }
    if (typeof record.candidateId !== "string" || record.candidateId.length === 0) {
      throw new Error("selection record is missing candidateId");
    }
    if (typeof record.reason !== "string" || record.reason.trim().length === 0) {
      throw new Error("selection record is missing the reviewer reason");
    }
    winnerId = record.candidateId;
    const candidate = candidateRuns.find((entry) => entry.candidateId === winnerId);
    if (candidate === undefined) {
      throw new Error(`selected candidate ${JSON.stringify(winnerId)} is absent from the run manifest`);
    }
    if (candidate.executionStatus !== "completed" || candidate.validationStatus !== "passed") {
      throw new Error(
        `selected candidate ${JSON.stringify(winnerId)} is not eligible (execution ${JSON.stringify(candidate.executionStatus)}, validation ${JSON.stringify(candidate.validationStatus)})`,
      );
    }
    if (typeof candidate.patchPath !== "string" || candidate.patchPath.length === 0) {
      throw new Error(`selected candidate ${JSON.stringify(winnerId)} has no patch in the manifest`);
    }
    if (typeof candidate.patchSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(candidate.patchSha256)) {
      throw new Error(`selected candidate ${JSON.stringify(winnerId)} has an invalid patch hash`);
    }
    const changedFilesValue = candidate.changedFiles;
    if (!Array.isArray(changedFilesValue) || changedFilesValue.some((path) => typeof path !== "string")) {
      throw new Error(`invalid selected candidate changedFiles: ${JSON.stringify(changedFilesValue)}`);
    }
    winnerPatchSha256 = candidate.patchSha256;
    winnerPatchPath = candidate.patchPath;
    changedFiles = changedFilesValue as string[];
  }
  return {
    repositoryPath: requiredManifestString(manifest, "repositoryPath"),
    baseCommit: requiredManifestString(manifest, "baseCommit"),
    validationCommands: validationCommands as string[],
    winnerPatchSha256,
    winnerPatchPath,
    winnerId,
    changedFiles,
  };
}

export async function applyVerifiedWinner(
  input: ApplyVerifiedWinnerInput,
  config: RunSettings,
  dependencies: ApplyRuntimeDependencies,
): Promise<ApplyVerifiedWinnerResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.runId)) {
    throw new Error(`invalid runId: expected a UUID v4, got ${JSON.stringify(input.runId)}`);
  }
  const repository = await inspectRepository(input.repositoryPath);
  const stateDirectory = await canonicalStateDirectory(config.stateDirectory, repository.repositoryPath);
  const requestedRunDirectory = join(stateDirectory, "runs", input.runId);
  const runDirectory = await realpath(requestedRunDirectory);
  if (!isPathInside(stateDirectory, runDirectory)) {
    throw new Error(
      `run directory escaped stateDirectory: ${requestedRunDirectory} resolved to ${runDirectory}`,
    );
  }
  const manifestPath = join(runDirectory, "manifest.json");
  const manifestMetadata = await lstat(manifestPath);
  if (!manifestMetadata.isFile()) {
    throw new Error(`run manifest must be a regular file, got ${manifestPath}`);
  }
  const manifestText = await readFile(manifestPath, "utf8");
  const selectionPath = join(runDirectory, "selection.json");
  let selectionText: string | undefined;
  try {
    selectionText = await readFile(selectionPath, "utf8");
  } catch {
    selectionText = undefined;
  }
  const manifest = parseStoredRunManifest(manifestText, selectionText);
  const manifestRaw = JSON.parse(manifestText) as Record<string, unknown>;
  const resultStatus = (manifestRaw.result as Record<string, unknown>).status;
  let effectiveChangedFiles = manifest.changedFiles;
  let effectiveWinnerPatchSha256 = manifest.winnerPatchSha256;
  let effectiveWinnerId = manifest.winnerId;
  let overrideCandidateId = input.candidateId;
  if (
    overrideCandidateId !== undefined
    && selectionText !== undefined
  ) {
    const selection = JSON.parse(selectionText) as { candidateId?: unknown };
    if (selection.candidateId !== overrideCandidateId) {
      throw new Error(
        `candidateId ${JSON.stringify(overrideCandidateId)} conflicts with the recorded selection ${JSON.stringify(selection.candidateId)}; call select_verified_candidate again to change the choice`,
      );
    }
  }
  if (
    overrideCandidateId !== undefined
    && manifestRaw.schemaVersion === 2
    && resultStatus === "winner_selected"
    && overrideCandidateId !== manifest.winnerId
  ) {
    throw new Error(
      `run ${input.runId} recorded ${manifest.winnerId} as the verified winner; candidateId overrides are only supported on legacy v1 runs`,
    );
  }
  if (resultStatus === "review_pending" && overrideCandidateId === undefined) {
    overrideCandidateId = manifest.winnerId;
  }
  if (overrideCandidateId) {
    const candidateRuns = (manifestRaw.candidateRuns ?? []) as Array<Record<string, unknown>>;
    const target = candidateRuns.find((cr) => cr.candidateId === overrideCandidateId);
    if (!target) throw new Error(`candidate ${overrideCandidateId} not found in run ${input.runId}`);
    const patchPath = target.patchPath as string;
    if (!patchPath) throw new Error(`candidate ${overrideCandidateId} has no patch in manifest`);
    const patchContent = await readFile(patchPath);
    const sha256 = createHash("sha256").update(patchContent).digest("hex");
    await writeFile(join(runDirectory, "winner.patch"), patchContent);
    effectiveWinnerPatchSha256 = sha256;
    effectiveWinnerId = overrideCandidateId;
    effectiveChangedFiles = target.changedFiles as string[];
  }
  if (await realpath(manifest.repositoryPath) !== repository.repositoryPath) {
    throw new Error(
      `run ${input.runId} belongs to ${manifest.repositoryPath}, not ${repository.repositoryPath}`,
    );
  }
  if (repository.baseCommit !== manifest.baseCommit) {
    throw new Error(
      `repository HEAD changed since run ${input.runId}: expected ${manifest.baseCommit}, got ${repository.baseCommit}`,
    );
  }
  const expectedPatchPath = join(runDirectory, "winner.patch");
  // review_pending runs resolve the winner patch from the selected candidate's
  // artifacts; the override block above has already materialized winner.patch.
  const effectiveWinnerPatchPath = resultStatus === "review_pending"
    ? expectedPatchPath
    : manifest.winnerPatchPath;
  if (resolve(effectiveWinnerPatchPath) !== expectedPatchPath) {
    throw new Error(
      `run manifest winnerPatchPath escaped its run directory: ${effectiveWinnerPatchPath}`,
    );
  }
  const patchMetadata = await lstat(expectedPatchPath);
  if (!patchMetadata.isFile()) {
    throw new Error(`winner patch must be a regular file, got ${expectedPatchPath}`);
  }
  const canonicalPatchPath = await realpath(expectedPatchPath);
  const patch = await readFile(canonicalPatchPath);
  const actualPatchSha256 = createHash("sha256").update(patch).digest("hex");
  if (!input.candidateId && actualPatchSha256 !== manifest.winnerPatchSha256) {
    throw new Error(
      `winner patch hash changed for run ${input.runId}: expected ${manifest.winnerPatchSha256}, got ${actualPatchSha256}`,
    );
  }
  const approvalSignal = input.signal ?? new AbortController().signal;
  await runGitApplyWithVerifiedPatch(
    repository.repositoryPath,
    patch,
    true,
    config.validationTimeoutMs,
    approvalSignal,
  );
  await dependencies.requestApproval(
    [
      `Apply verified winner ${manifest.winnerId} from run ${input.runId}.`,
      `Repository: ${repository.repositoryPath}.`,
      `Patch SHA-256: ${actualPatchSha256}.`,
      `Changed files: ${manifest.changedFiles.join(", ")}.`,
      `Validation commands after apply: ${manifest.validationCommands.join("; ")}.`,
      "The patch will not be staged, committed, pushed, stashed, or reset.",
    ].join("\n"),
    approvalSignal,
  );
  const credentialValue = await dependencies.resolveCredential();

  const repositoryAfterApproval = await inspectRepository(repository.repositoryPath);
  if (repositoryAfterApproval.baseCommit !== manifest.baseCommit) {
    throw new Error(
      `repository HEAD changed while applying run ${input.runId}: expected ${manifest.baseCommit}, got ${repositoryAfterApproval.baseCommit}`,
    );
  }
  await runGitApplyWithVerifiedPatch(
    repository.repositoryPath,
    patch,
    true,
    config.validationTimeoutMs,
    approvalSignal,
  );
  await runGitApplyWithVerifiedPatch(
    repository.repositoryPath,
    patch,
    false,
    config.validationTimeoutMs,
    approvalSignal,
  );

  const validationLogPaths: string[] = [];
  let validationStatus: ApplyVerifiedWinnerResult["validationStatus"] = "passed";
  let validationFailure: string | null = null;
  const validationEnvironment = sanitizedEnvironment(process.env);
  for (const [commandIndex, validationCommand] of manifest.validationCommands.entries()) {
    const validationShell = validationShellInvocation(validationCommand);
    const validationResult = await runProcess({
      executable: validationShell.executable,
      arguments: validationShell.arguments,
      cwd: repository.repositoryPath,
      env: validationEnvironment,
      timeoutMs: config.validationTimeoutMs,
      signal: approvalSignal,
    });
    const validationLog = redactSecret([
      `$ ${validationCommand}`,
      validationResult.stdout,
      validationResult.stderr.length === 0 ? "" : `[stderr]\n${validationResult.stderr}`,
      `[exit code: ${validationResult.exitCode}]`,
      validationResult.outputLimitExceeded ? "[output exceeded the 16 MiB safety limit]" : "",
      validationResult.residualProcessGroupDetected
        ? "[validation left a residual process group; it was force-terminated]"
        : "",
      validationResult.residualProcessGroupRemaining
        ? "[validation residual process group remains after SIGKILL]"
        : "",
    ].filter((part) => part.length > 0).join("\n"), credentialValue);
    const validationLogPath = join(runDirectory, `apply-validation-${commandIndex + 1}.log`);
    await writeFile(validationLogPath, validationLog, { encoding: "utf8", mode: 0o600 });
    validationLogPaths.push(validationLogPath);
    if (validationResult.timedOut || validationResult.aborted) {
      validationStatus = "timed_out";
      validationFailure = `post-apply validation timed out or was cancelled: ${validationCommand}`;
      break;
    }
    if (
      validationResult.exitCode !== 0
      || validationResult.outputLimitExceeded
      || validationResult.residualProcessGroupDetected
    ) {
      validationStatus = "failed";
      validationFailure = validationResult.residualProcessGroupDetected
        ? `post-apply validation left a residual process group: ${validationCommand}`
        : `post-apply validation failed with exit code ${validationResult.exitCode}: ${validationCommand}`;
      break;
    }
  }

  const applyResult: ApplyVerifiedWinnerResult = {
    schemaVersion: 1,
    runId: input.runId,
    status: validationStatus === "passed" ? "applied" : "applied_validation_failed",
    patchSha256: actualPatchSha256,
    changedFiles: effectiveChangedFiles,
    validationStatus,
    validationLogPaths,
    failure: validationFailure,
  };
  await writePrivateTextFile(
    join(runDirectory, "apply-result.json"),
    `${JSON.stringify(applyResult, null, 2)}\n`,
  );
  return applyResult;
}

export async function rollbackVerifiedWinner(
  input: ApplyVerifiedWinnerInput,
  config: RunSettings,
): Promise<RollbackResult> {
  const runId = input.runId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(runId)) {
    throw new Error(`invalid runId: expected a UUID v4, got ${JSON.stringify(runId)}`);
  }
  const applyResultPath = join(config.stateDirectory, "runs", runId, "apply-result.json");
  let applyResult: ApplyVerifiedWinnerResult;
  try {
    applyResult = JSON.parse(await readFile(applyResultPath, "utf8"));
  } catch {
    throw new Error(`no apply-result.json found for run ${runId}: nothing to rollback`);
  }
  if (applyResult.status !== "applied" && applyResult.status !== "applied_validation_failed") {
    throw new Error(`run ${runId} was not applied (status: ${applyResult.status}); nothing to rollback`);
  }
  const changedFiles = applyResult.changedFiles;
  // Guard the same way apply does: the caller's cwd must still be the run's
  // repository, or the checkout below would restore files in an unrelated tree.
  const repository = await inspectRepository(input.repositoryPath);
  const stateDirectory = await canonicalStateDirectory(config.stateDirectory, repository.repositoryPath);
  const expectedRunDirectory = join(stateDirectory, "runs", runId);
  const resolvedRunDirectory = await realpath(expectedRunDirectory);
  if (!isPathInside(stateDirectory, resolvedRunDirectory)) {
    throw new Error(
      `run directory escaped stateDirectory: ${expectedRunDirectory} resolved to ${resolvedRunDirectory}`,
    );
  }
  const storedManifest = JSON.parse(await readFile(join(resolvedRunDirectory, "manifest.json"), "utf8")) as {
    repositoryPath?: string;
  };
  if (storedManifest.repositoryPath !== undefined && (await realpath(storedManifest.repositoryPath)) !== repository.repositoryPath) {
    throw new Error(
      `run ${runId} belongs to ${storedManifest.repositoryPath}, not ${repository.repositoryPath}`,
    );
  }
  // Refuse to clobber post-apply user modifications to the applied files
  // (design §7.3): rollback only proceeds when every applied file is either
  // exactly at its applied state or untouched by the user.
  const dirtyStatus = await runGit(input.repositoryPath, [
    "status", "--porcelain", "--", ...changedFiles,
  ]);
  const dirtyEntries = dirtyStatus.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const userModified = dirtyEntries.filter((line) => !line.startsWith("??") && !/^M{0,2}\s/.test(line) || line.startsWith("MM") || line.startsWith("AM"));
  if (userModified.length > 0) {
    throw new Error(
      `rollback refused: post-apply user modifications detected for ${userModified.join(", ")}; commit or stash them first`,
    );
  }
  await runGit(input.repositoryPath, ["checkout", "HEAD", "--", ...changedFiles]);
  for (const file of changedFiles) {
    const filePath = join(input.repositoryPath, file);
    try {
      await access(filePath, constants.F_OK);
    } catch {
      continue;
    }
    const statusOutput = await runGit(input.repositoryPath, ["status", "--porcelain", "--", file]);
    if (statusOutput.trim().startsWith("??")) {
      await rm(filePath);
    }
  }
  const rollbackResult: RollbackResult = {
    schemaVersion: 1,
    runId,
    status: "rolled_back",
    changedFiles,
    failure: null,
  };
  await writeFile(
    join(resolvedRunDirectory, "rollback-result.json"),
    JSON.stringify(rollbackResult, null, 2),
  );
  return rollbackResult;
}

export interface SelectVerifiedCandidateInput {
  readonly runId: string;
  readonly repositoryPath: string;
  readonly candidateId: string;
  readonly reason: string;
  /** Filled by the host from the calling agent, never trusted from model output. */
  readonly sessionId?: string;
}

/**
 * Record an explicit parent-agent selection for a run in review_pending.
 * Writing selection.json is the only way a review_pending run becomes
 * applicable; the record keeps the reason and the host-filled session id as
 * the audit trail. Re-selecting overwrites the record until apply.
 */
export async function selectVerifiedCandidate(
  input: SelectVerifiedCandidateInput,
  config: RunSettings,
): Promise<SelectVerifiedCandidateResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.runId)) {
    throw new Error(`invalid runId: expected a UUID v4, got ${JSON.stringify(input.runId)}`);
  }
  if (input.candidateId.trim().length === 0) {
    throw new Error("candidateId is required");
  }
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new Error("a non-empty reason is required for an explicit selection");
  }
  const repository = await inspectRepository(input.repositoryPath);
  const stateDirectory = await canonicalStateDirectory(config.stateDirectory, repository.repositoryPath);
  const requestedRunDirectory = join(stateDirectory, "runs", input.runId);
  const runDirectory = await realpath(requestedRunDirectory);
  if (!isPathInside(stateDirectory, runDirectory)) {
    throw new Error(
      `run directory escaped stateDirectory: ${requestedRunDirectory} resolved to ${runDirectory}`,
    );
  }
  const manifestPath = join(runDirectory, "manifest.json");
  const manifestRaw = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  if (manifestRaw.schemaVersion !== 2) {
    throw new Error("select_verified_candidate requires a schemaVersion 2 run manifest");
  }
  const result = manifestRaw.result as Record<string, unknown> | undefined;
  if (result === undefined || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`run ${input.runId} manifest has no result record`);
  }
  if (result.status !== "review_pending") {
    throw new Error(
      `run ${input.runId} is not awaiting a selection; status is ${JSON.stringify(result.status)}`,
    );
  }
  const candidateRuns = (manifestRaw.candidateRuns ?? []) as Array<Record<string, unknown>>;
  const target = candidateRuns.find((entry) => entry.candidateId === input.candidateId);
  if (target === undefined) {
    throw new Error(`candidate ${JSON.stringify(input.candidateId)} is not part of run ${input.runId}`);
  }
  if (target.executionStatus !== "completed" || target.validationStatus !== "passed") {
    throw new Error(
      `candidate ${JSON.stringify(input.candidateId)} is not eligible (execution ${JSON.stringify(target.executionStatus)}, validation ${JSON.stringify(target.validationStatus)})`,
    );
  }
  const selectedAt = new Date().toISOString();
  const record = {
    schemaVersion: 2,
    runId: input.runId,
    candidateId: input.candidateId,
    reason,
    status: "selected",
    selectedAt,
    sessionId: input.sessionId ?? null,
  };
  await writeFile(join(runDirectory, "selection.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return {
    schemaVersion: 2,
    runId: input.runId,
    candidateId: input.candidateId,
    reason,
    status: "selected",
    selectedAt,
    sessionId: input.sessionId ?? null,
  };
}
