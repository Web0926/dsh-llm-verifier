import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import type { RunSettings } from "../src/settings.ts";
import { applyVerifiedWinner, runVerifiedBestOf } from "../src/core.ts";

const execFileAsync = promisify(execFile);
const testDirectory = dirname(fileURLToPath(import.meta.url));
const IS_WINDOWS = process.platform === "win32";

/**
 * Writes a fake `dsh` executable whose behavior is implemented by the shared
 * Node helper in fixtures/fake-dsh.mjs, wrapped in the platform shell so
 * runProcess can execute it directly on macOS, Linux, and Windows.
 */
async function writeFakeDsh(fixtureRoot: string, spec: Record<string, unknown>): Promise<string> {
  const specPath = join(fixtureRoot, "fake-dsh-spec.json");
  await writeFile(specPath, JSON.stringify(spec));
  const helperPath = join(testDirectory, "fixtures", "fake-dsh.mjs");
  if (IS_WINDOWS) {
    const wrapperPath = join(fixtureRoot, "fake-dsh.cmd");
    await writeFile(wrapperPath, `@echo off\r\nnode "${helperPath}" "${specPath}"\r\n`);
    return wrapperPath;
  }
  const wrapperPath = join(fixtureRoot, "fake-dsh.sh");
  await writeFile(wrapperPath, `#!/bin/sh\nexec node "${helperPath}" "${specPath}"\n`, { mode: 0o755 });
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

function validationFileExists(paths: readonly string[]): string {
  return IS_WINDOWS
    ? paths.map((path) => `if not exist ${path} exit 1`).join(" && ")
    : paths.map((path) => `test -f ${path}`).join(" && ");
}

async function createCleanRepository(repositoryPath: string): Promise<void> {
  await mkdir(repositoryPath, { recursive: true });
  await execFileAsync("git", ["init", "--quiet", repositoryPath]);
  await execFileAsync("git", ["config", "user.email", "tests@example.invalid"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.name", "Verifier Tests"], { cwd: repositoryPath });
  await writeFile(join(repositoryPath, "README.md"), "fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repositoryPath });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repositoryPath });
}

async function assertTreeDoesNotContain(rootPath: string, forbiddenText: string): Promise<void> {
  const directoryEntries = await readdir(rootPath, { withFileTypes: true });
  for (const directoryEntry of directoryEntries) {
    const entryPath = join(rootPath, directoryEntry.name);
    if (directoryEntry.isDirectory()) {
      await assertTreeDoesNotContain(entryPath, forbiddenText);
    } else if (directoryEntry.isFile()) {
      assert.equal(
        (await readFile(entryPath)).includes(Buffer.from(forbiddenText)),
        false,
        `secret found in ${entryPath}`,
      );
    }
  }
}

function createRuntimeConfig(stateDirectory: string, dshExecutable: string): RunSettings {
  return {
    enabled: true,
    defaultCandidateCount: 3,
    maxConcurrentCandidates: 3,
    candidateProfile: "headless",
    reviewMode: "deepseek_verifier",
    reviewerProvider: "",
    reviewerModel: "",
    reviewerReasoningEffort: "",
    reviewerMaxTokens: 4_096,
    reviewerTimeoutMs: 30_000,
    reviewSingleEligible: false,
    reviewFailurePolicy: "stop",
    validationMode: "auto",
    validationCommands: [],
    credentialRef: "DEEPSEEK_API_KEY",
    verifierModel: "deepseek-v4-flash",
    nEvaluations: 2,
    maxVerifierWorkers: 8,
    verifierEffort: "high",
    verifierMaxTokens: 32_768,
    candidateTimeoutMs: 10_000,
    validationTimeoutMs: 10_000,
    runTimeoutMs: 30_000,
    maxVerifierTraceBytes: 512 * 1024,
    stateDirectory,
    dshExecutable,
  };
}

describe("Best-of orchestration", () => {
  it("reports the actual DSH reviewer instead of unused DeepSeek defaults", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-reviewer-report-"));
    try {
      const repositoryPath = join(fixtureRoot, "repository");
      await createCleanRepository(repositoryPath);
      const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "basename-result" });
      const config: RunSettings = {
        ...createRuntimeConfig(join(fixtureRoot, "state"), fakeDshPath),
        reviewMode: "dsh_model",
        reviewerProvider: "configured-provider",
        reviewerModel: "configured-model",
        reviewerReasoningEffort: "high",
      };
      const result = await runVerifiedBestOf({
        task: "Create result.txt",
        candidateCount: 2,
        validationCommands: [validationFileExists(["result.txt"])],
        repositoryPath,
      }, config, {
        requestApproval: async () => undefined,
        resolveCredential: async () => "",
        runVerifier: async () => { throw new Error("DeepSeek must not run"); },
        reviewCandidates: async (request) => {
          assert.equal(request.reasoningEffort, "high");
          return {
            method: "dsh_model", provider: "receipt-provider", model: "receipt-model",
            selectedId: "candidate-1", scores: { "candidate-1": 95, "candidate-2": 90 },
            evidence: { "candidate-1": "best", "candidate-2": "acceptable" },
            risks: "none", rawResponseLength: 100, durationMs: 10,
          };
        },
      });
      assert.equal(result.status, "winner_selected");
      const report = await readFile(result.reportPath, "utf8");
      assert.match(report, /Reviewer provider: `receipt-provider`/);
      assert.match(report, /Reviewer model: `receipt-model`/);
      assert.match(report, /Configured reviewer reasoning effort: `high`/);
      assert.doesNotMatch(report, /deepseek-v4-flash|Verifier repetitions|configured-model/);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("keeps the source unchanged until a second approval applies the validated winner", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-core-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "permission-and-winner" });
    const credentialValue = "test-secret-that-must-not-be-written";
    await createCleanRepository(repositoryPath);
    await writeFile(join(repositoryPath, "README.md"), `${credentialValue}\n`);
    await execFileAsync("git", ["add", "README.md"], { cwd: repositoryPath });
    await execFileAsync("git", ["commit", "--quiet", "--amend", "--no-edit"], { cwd: repositoryPath });

    const approvalReasons: string[] = [];
    try {
      const result = await runVerifiedBestOf(
        {
          task: "Create result.txt",
          candidateCount: 3,
          validationCommands: [
            IS_WINDOWS
              ? "type README.md && if not exist result.txt exit 1"
              : "cat README.md && test -f result.txt",
          ],
          repositoryPath,
        },
        createRuntimeConfig(stateDirectory, fakeDshPath),
        {
          requestApproval: async (reason) => {
            approvalReasons.push(reason);
          },
          resolveCredential: async () => credentialValue,
          runVerifier: async () => {
            throw new Error("verifier must not run with one eligible candidate");
          },
        },
      );

      assert.equal(result.status, "winner_selected");
      assert.equal(result.selectionMethod, "validation_only");
      assert.equal(result.winnerId, "candidate-1");
      assert.equal(result.eligibleCandidateCount, 1);
      assert.match(approvalReasons[0] ?? "", /3 isolated DeepSeek Harness candidates/);
      assert.equal(await readFile(result.winnerPatchPath ?? "", "utf8").then((patch) => patch.includes("result.txt")), true);
      await assert.rejects(access(join(repositoryPath, "result.txt")));

      const { stdout: statusOutput } = await execFileAsync(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { cwd: repositoryPath },
      );
      assert.equal(statusOutput, "");
      const { stdout: worktreeOutput } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
        cwd: repositoryPath,
      });
      assert.doesNotMatch(worktreeOutput, /candidate-[123]/);

      const report = await readFile(result.reportPath, "utf8");
      assert.doesNotMatch(report, /test-secret-that-must-not-be-written/);
      await assertTreeDoesNotContain(stateDirectory, credentialValue);

      const dirtyMarkerPath = join(repositoryPath, "local-uncommitted.txt");
      await writeFile(dirtyMarkerPath, "do not overwrite\n");
      await assert.rejects(
        applyVerifiedWinner(
          { runId: result.runId, repositoryPath },
          createRuntimeConfig(stateDirectory, fakeDshPath),
          {
            requestApproval: async () => undefined,
            resolveCredential: async () => credentialValue,
          },
        ),
        /repository must be clean/,
      );
      await rm(dirtyMarkerPath);

      const winnerPatchPath = result.winnerPatchPath ?? "";
      const originalWinnerPatch = await readFile(winnerPatchPath);
      await writeFile(winnerPatchPath, Buffer.concat([originalWinnerPatch, Buffer.from("tampered\n")]));
      await assert.rejects(
        applyVerifiedWinner(
          { runId: result.runId, repositoryPath },
          createRuntimeConfig(stateDirectory, fakeDshPath),
          {
            requestApproval: async () => undefined,
            resolveCredential: async () => credentialValue,
          },
        ),
        /winner patch hash changed/,
      );
      await writeFile(winnerPatchPath, originalWinnerPatch);

      const winnerPatchBackupPath = `${winnerPatchPath}.backup`;
      await rename(winnerPatchPath, winnerPatchBackupPath);
      if (IS_WINDOWS) {
        // A directory at the patch path exercises the same not-a-regular-file
        // guard without needing symlink privileges.
        await mkdir(winnerPatchPath);
      } else {
        await symlink(winnerPatchBackupPath, winnerPatchPath);
      }
      await assert.rejects(
        applyVerifiedWinner(
          { runId: result.runId, repositoryPath },
          createRuntimeConfig(stateDirectory, fakeDshPath),
          {
            requestApproval: async () => undefined,
            resolveCredential: async () => credentialValue,
          },
        ),
        /winner patch must be a regular file/,
      );
      await rm(winnerPatchPath, { recursive: true });
      await rename(winnerPatchBackupPath, winnerPatchPath);

      const applyResult = await applyVerifiedWinner(
        { runId: result.runId, repositoryPath },
        createRuntimeConfig(stateDirectory, fakeDshPath),
        {
          requestApproval: async (reason) => {
            approvalReasons.push(reason);
            await writeFile(
              winnerPatchPath,
              Buffer.concat([originalWinnerPatch, Buffer.from("changed after approval\\n")]),
            );
          },
          resolveCredential: async () => credentialValue,
        },
      );
      assert.equal(applyResult.status, "applied");
      // Windows git checkouts may materialize CRLF; compare line-normalized.
      assert.equal(
        (await readFile(join(repositoryPath, "result.txt"), "utf8")).replaceAll("\r\n", "\n"),
        "winner\n",
      );
      await assertTreeDoesNotContain(stateDirectory, credentialValue);
      assert.equal(approvalReasons.length, 2);
      const { stdout: stagedChanges } = await execFileAsync("git", ["diff", "--cached", "--name-only"], {
        cwd: repositoryPath,
      });
      assert.equal(stagedChanges, "");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("runs five isolated candidates and uses two verifier pivots", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-best-five-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "basename-result" });
    await createCleanRepository(repositoryPath);

    let receivedCandidateCount = 0;
    let receivedPivots = 0;
    try {
      const result = await runVerifiedBestOf(
        {
          task: "Create result.txt",
          candidateCount: 5,
          validationCommands: [validationFileExists(["result.txt"])],
          repositoryPath,
        },
        createRuntimeConfig(stateDirectory, fakeDshPath),
        {
          requestApproval: async () => undefined,
          resolveCredential: async () => "test-secret",
          runVerifier: async (request) => {
            receivedCandidateCount = request.candidates.length;
            receivedPivots = request.pivots;
            return {
              winnerIndex: 4,
              scores: [0.1, 0.2, 0.3, 0.4, 0.9],
              ranking: [4, 3, 2, 1, 0],
              requestCount: 72,
              tokenUsage: { calls: 72 },
            };
          },
        },
      );

      assert.equal(result.status, "winner_selected");
      assert.equal(result.selectionMethod, "llm_verifier");
      assert.equal(result.winnerId, "candidate-5");
      assert.equal(result.eligibleCandidateCount, 5);
      assert.equal(result.verifierRequestCount, 72);
      assert.equal(receivedCandidateCount, 5);
      assert.equal(receivedPivots, 2);
      const verifierLogPath = join(dirname(result.reportPath), "verifier.log");
      assert.match(await readFile(verifierLogPath, "utf8"), /"calls": 72/);
      assert.match(
        await readFile(result.reportPath, "utf8"),
        new RegExp(verifierLogPath.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")),
      );
      const { stdout: statusOutput } = await execFileAsync(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        { cwd: repositoryPath },
      );
      assert.equal(statusOutput, "");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("handles every Best-of-3 and Best-of-5 eligible-candidate count", async () => {
    const matrix = [
      ...[0, 1, 2, 3].map((eligibleCandidateCount) => ({
        candidateCount: 3 as const,
        eligibleCandidateCount,
      })),
      ...[0, 1, 2, 3, 4, 5].map((eligibleCandidateCount) => ({
        candidateCount: 5 as const,
        eligibleCandidateCount,
      })),
    ];

    for (const matrixCase of matrix) {
      const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-matrix-"));
      const repositoryPath = join(fixtureRoot, "repository");
      const stateDirectory = join(fixtureRoot, "state");
      const fakeDshPath = await writeFakeDsh(fixtureRoot, {
        mode: "matrix",
        eligible: matrixCase.eligibleCandidateCount,
        total: matrixCase.candidateCount,
      });
      await createCleanRepository(repositoryPath);

      let verifierCallCount = 0;
      let receivedPivots: number | null = null;
      try {
        const result = await runVerifiedBestOf(
          {
            task: "Create result.txt",
            candidateCount: matrixCase.candidateCount,
            validationCommands: [validationFileExists(["result.txt"])],
            repositoryPath,
          },
          createRuntimeConfig(stateDirectory, fakeDshPath),
          {
            requestApproval: async () => undefined,
            resolveCredential: async () => "matrix-test-secret",
            runVerifier: async (request) => {
              verifierCallCount += 1;
              receivedPivots = request.pivots;
              const ranking = Array.from(
                { length: matrixCase.eligibleCandidateCount },
                (_, candidateIndex) => matrixCase.eligibleCandidateCount - candidateIndex - 1,
              );
              return {
                winnerIndex: matrixCase.eligibleCandidateCount - 1,
                scores: Array.from(
                  { length: matrixCase.eligibleCandidateCount },
                  (_, candidateIndex) => candidateIndex + 1,
                ),
                ranking,
                requestCount: 1,
                tokenUsage: { calls: 1 },
              };
            },
          },
        );

        assert.equal(result.requestedCandidateCount, matrixCase.candidateCount);
        assert.equal(result.completedCandidateCount, matrixCase.eligibleCandidateCount);
        assert.equal(result.eligibleCandidateCount, matrixCase.eligibleCandidateCount);
        if (matrixCase.eligibleCandidateCount === 0) {
          assert.equal(result.status, "no_winner");
          assert.equal(result.selectionMethod, null);
          assert.equal(result.winnerId, null);
          assert.equal(verifierCallCount, 0);
        } else if (matrixCase.eligibleCandidateCount === 1) {
          assert.equal(result.status, "winner_selected");
          assert.equal(result.selectionMethod, "validation_only");
          assert.equal(result.winnerId, "candidate-1");
          assert.equal(verifierCallCount, 0);
        } else {
          assert.equal(result.status, "winner_selected");
          assert.equal(result.selectionMethod, "llm_verifier");
          assert.equal(
            result.winnerId,
            `candidate-${matrixCase.eligibleCandidateCount}`,
          );
          assert.equal(result.ranking[0]?.candidateId, result.winnerId);
          assert.equal(verifierCallCount, 1);
          assert.equal(receivedPivots, Math.min(2, matrixCase.eligibleCandidateCount - 1));
        }
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    }
  });

  it("reports complete logs, truncation, patch hashes, and binary metadata", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-report-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "large-and-binary" });
    await createCleanRepository(repositoryPath);
    const runtimeConfig = {
      ...createRuntimeConfig(stateDirectory, fakeDshPath),
      maxVerifierTraceBytes: 256,
    };
    const fullVerifierInputPaths: string[] = [];

    try {
      const result = await runVerifiedBestOf(
        {
          task: "Create a large text file and a binary file",
          candidateCount: 3,
          validationCommands: [validationFileExists(["large.txt", "binary.bin"])],
          repositoryPath,
        },
        runtimeConfig,
        {
          requestApproval: async () => undefined,
          resolveCredential: async () => "report-test-secret",
          runVerifier: async (request) => {
            for (const candidate of request.candidates) {
              assert.match(candidate.trajectory, /complete input retained locally/);
              assert.doesNotMatch(candidate.trajectory, /complete local file:/);
            }
            return {
              winnerIndex: 0,
              scores: [0.9, 0.5, 0.1],
              ranking: [0, 1, 2],
              requestCount: 36,
              tokenUsage: { calls: 36 },
            };
          },
        },
      );

      for (const candidateNumber of [1, 2, 3]) {
        const fullVerifierInputPath = join(
          stateDirectory,
          "runs",
          result.runId,
          "artifacts",
          `candidate-${candidateNumber}`,
          "verifier-input.full.txt",
        );
        fullVerifierInputPaths.push(fullVerifierInputPath);
        const fullVerifierInput = await readFile(fullVerifierInputPath, "utf8");
        assert.match(fullVerifierInput, /Binary files \(metadata only; no binary content\)/);
        assert.match(fullVerifierInput, /binary\.bin/);
        assert.match(fullVerifierInput, /gitObjectHash=[0-9a-f]{40,64}/);
      }

      assert.equal(fullVerifierInputPaths.length, 3);
      const report = await readFile(result.reportPath, "utf8");
      assert.match(report, /Plugin version: `0\.2\.0`/);
      assert.match(report, /Completed candidates: 3/);
      assert.match(report, /Candidates entered into ranking: 3/);
      assert.match(report, /Winner patch SHA-256: `[0-9a-f]{64}`/);
      assert.match(report, /Complete logs/);
      assert.match(report, /verifier input was truncated/);
      assert.match(report, /path="binary\.bin", size=3 bytes, hash=[0-9a-f]{40,64}/);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("does not rank a candidate that claims success but fails validation", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-false-success-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "false-success" });
    await createCleanRepository(repositoryPath);

    try {
      const result = await runVerifiedBestOf(
        {
          task: "Create required.txt",
          candidateCount: 3,
          validationCommands: [validationFileExists(["required.txt"])],
          repositoryPath,
        },
        createRuntimeConfig(stateDirectory, fakeDshPath),
        {
          requestApproval: async () => undefined,
          resolveCredential: async () => "false-success-secret",
          runVerifier: async () => {
            throw new Error("verifier must not run for a validation failure");
          },
        },
      );

      assert.equal(result.status, "no_winner");
      assert.equal(result.eligibleCandidateCount, 0);
      const falseSuccessCandidate = result.ranking.find(
        (candidate) => candidate.candidateId === "candidate-1",
      );
      assert.equal(falseSuccessCandidate?.executionStatus, "completed");
      assert.equal(falseSuccessCandidate?.validationStatus, "failed");
      assert.equal(falseSuccessCandidate?.score, null);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("cancels running candidate process groups and removes their worktrees", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-cancel-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const candidateStartedPath = join(fixtureRoot, "candidate-started");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "hang", startedPath: candidateStartedPath });
    await createCleanRepository(repositoryPath);
    const abortController = new AbortController();

    try {
      const resultPromise = runVerifiedBestOf(
        {
          task: "Create result.txt",
          candidateCount: 3,
          validationCommands: [validationFileExists(["result.txt"])],
          repositoryPath,
          signal: abortController.signal,
        },
        createRuntimeConfig(stateDirectory, fakeDshPath),
        {
          requestApproval: async () => undefined,
          resolveCredential: async () => "cancel-test-secret",
          runVerifier: async () => {
            throw new Error("verifier must not run after cancellation");
          },
        },
      );
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
          await access(candidateStartedPath);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt === 199) {
            throw error;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
      }
      abortController.abort(new Error("test cancellation"));
      const result = await resultPromise;

      assert.equal(result.status, "failed");
      assert.match(result.failure ?? "", /cancelled|timeout/);
      assert.equal(
        result.ranking.every((candidate) => candidate.executionStatus === "cancelled"),
        true,
      );
      const { stdout: worktreeOutput } = await execFileAsync(
        "git",
        ["worktree", "list", "--porcelain"],
        { cwd: repositoryPath },
      );
      assert.doesNotMatch(worktreeOutput, /candidate-[123]/);
    } finally {
      abortController.abort();
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects a candidate that writes the resolved credential into a changed file", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-secret-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "leak-key" });
    const credentialValue = "credential-must-never-persist";
    await createCleanRepository(repositoryPath);

    try {
      const result = await runVerifiedBestOf(
        {
          task: "Create a safe file",
          candidateCount: 3,
          validationCommands: [validationFileExists(["leaked.bin"])],
          repositoryPath,
        },
        createRuntimeConfig(stateDirectory, fakeDshPath),
        {
          requestApproval: async () => undefined,
          resolveCredential: async () => credentialValue,
          runVerifier: async () => {
            throw new Error("verifier must not run without eligible candidates");
          },
        },
      );

      assert.equal(result.status, "no_winner");
      assert.equal(result.eligibleCandidateCount, 0);
      assert.match(
        result.ranking.find((candidate) => candidate.candidateId === "candidate-1")?.failure ?? "",
        /contains the resolved credential/,
      );
      await assertTreeDoesNotContain(stateDirectory, credentialValue);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("reports verifier API failure without inventing a winner", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-api-failure-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "basename-result" });
    await createCleanRepository(repositoryPath);

    try {
      const result = await runVerifiedBestOf(
        {
          task: "Create result.txt",
          candidateCount: 3,
          validationCommands: [validationFileExists(["result.txt"])],
          repositoryPath,
        },
        createRuntimeConfig(stateDirectory, fakeDshPath),
        {
          requestApproval: async () => undefined,
          resolveCredential: async () => "test-secret",
          runVerifier: async () => {
            throw new Error("verifier service unavailable");
          },
        },
      );

      assert.equal(result.status, "failed");
      assert.equal(result.winnerId, null);
      assert.equal(result.winnerPatchPath, null);
      assert.match(result.failure ?? "", /verifier service unavailable/);
      assert.match(await readFile(result.reportPath, "utf8"), /verifier service unavailable/);
      assert.match(
        await readFile(join(dirname(result.reportPath), "verifier.log"), "utf8"),
        /verifier service unavailable/,
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("keeps the applied patch when post-apply validation fails", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-llm-verifier-post-apply-"));
    const repositoryPath = join(fixtureRoot, "repository");
    const stateDirectory = join(fixtureRoot, "state");
    const fakeDshPath = await writeFakeDsh(fixtureRoot, { mode: "winner" });
    await createCleanRepository(repositoryPath);
    const runtimeConfig = createRuntimeConfig(stateDirectory, fakeDshPath);
    const winnerOnlyValidationCommand = IS_WINDOWS
      ? `echo %CD% | findstr /C:candidate-1 >NUL && exit /b 0 || exit /b 1`
      : `case "$PWD" in *candidate-1) exit 0 ;; *) exit 1 ;; esac`;

    try {
      const selectionResult = await runVerifiedBestOf(
        {
          task: "Create result.txt",
          candidateCount: 3,
          validationCommands: [winnerOnlyValidationCommand],
          repositoryPath,
        },
        runtimeConfig,
        {
          requestApproval: async () => undefined,
          resolveCredential: async () => "test-secret",
          runVerifier: async () => {
            throw new Error("verifier must not run with one eligible candidate");
          },
        },
      );
      const applyResult = await applyVerifiedWinner(
        { runId: selectionResult.runId, repositoryPath },
        runtimeConfig,
        {
          requestApproval: async () => undefined,
          resolveCredential: async () => "test-secret",
        },
      );

      assert.equal(applyResult.status, "applied_validation_failed");
      assert.equal(applyResult.validationStatus, "failed");
      assert.match(applyResult.failure ?? "", /post-apply validation failed/);
      assert.equal(
        (await readFile(join(repositoryPath, "result.txt"), "utf8")).replaceAll("\r\n", "\n"),
        "winner\n",
      );
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
