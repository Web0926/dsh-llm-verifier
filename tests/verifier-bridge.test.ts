import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const pythonExecutable = process.platform === "win32" ? "python" : "python3";
const scratchCachePath = join(tmpdir(), "verifier-test-cache.json");

async function runBridge(request: unknown): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const bridgePath = join(testDirectory, "..", "python", "verifier_bridge.py");
  const fixtureModulePath = join(testDirectory, "fixtures", "python");
  const childProcess = spawn(pythonExecutable, [bridgePath], {
    env: { ...process.env, PYTHONPATH: fixtureModulePath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  childProcess.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  childProcess.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  childProcess.stdin.end(JSON.stringify(request));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    childProcess.once("error", reject);
    childProcess.once("close", resolve);
  });
  return {
    exitCode,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
}

async function runRealBridge(request: unknown): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const pythonProjectPath = join(testDirectory, "..", "python");
  const bridgePath = join(pythonProjectPath, "verifier_bridge.py");
  const bridgeEnvironment = { ...process.env };
  for (const environmentName of Object.keys(bridgeEnvironment)) {
    if (
      environmentName === "DEEPSEEK_API_KEY"
      || environmentName === "OPENAI_BASE_URL"
      || environmentName.startsWith("VERTEX_")
      || environmentName.startsWith("GOOGLE_CLOUD_")
    ) {
      delete bridgeEnvironment[environmentName];
    }
  }
  const childProcess = spawn(
    "uv",
    ["run", "--frozen", "--project", pythonProjectPath, "python", bridgePath],
    { cwd: pythonProjectPath, env: bridgeEnvironment, stdio: ["pipe", "pipe", "pipe"] },
  );
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  childProcess.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  childProcess.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  childProcess.stdin.end(JSON.stringify(request));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    childProcess.once("error", reject);
    childProcess.once("close", resolve);
  });
  return {
    exitCode,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
}

describe("Python verifier bridge", () => {
  it("returns one validated JSON result on stdout", async () => {
    const bridgeResult = await runBridge({
      task: "Fix the fixture",
      candidates: [
        { candidateId: "candidate-1", trajectory: "candidate A" },
        { candidateId: "candidate-2", trajectory: "candidate B" },
      ],
      pivots: 1,
      model: "deepseek-v4-flash",
      nEvaluations: 2,
      maxWorkers: 8,
      cachePath: scratchCachePath,
    });

    assert.equal(bridgeResult.exitCode, 0, bridgeResult.stderr);
    assert.deepEqual(JSON.parse(bridgeResult.stdout), {
      winnerIndex: 1,
      scores: [0.2, 0.9],
      ranking: [1, 0],
      requestCount: 18,
      tokenUsage: { calls: 18, input_tokens: 12, output_tokens: 3 },
    });
    assert.equal(bridgeResult.stderr, "");
  });

  it("rejects a verifier model from another provider", async () => {
    const bridgeResult = await runBridge({
      task: "Fix the fixture",
      candidates: [
        { candidateId: "candidate-1", trajectory: "candidate A" },
        { candidateId: "candidate-2", trajectory: "candidate B" },
      ],
      pivots: 1,
      model: "gpt-5",
      nEvaluations: 2,
      maxWorkers: 8,
      cachePath: scratchCachePath,
    });

    assert.equal(bridgeResult.exitCode, 1);
    assert.equal(bridgeResult.stdout, "");
    assert.match(bridgeResult.stderr, /model must begin with 'deepseek-'.*gpt-5/);
  });

  it("matches the real llm-verifier 0.2.0 API using a complete offline cache", async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), "dsh-real-verifier-cache-"));
    const cachePath = join(fixtureDirectory, "scores.json");
    const criteriaIds = [
      "specification_adherence",
      "output_match",
      "error_signal_detection",
    ];
    const cache: Record<string, { score_A: number; score_B: number }> = {};
    for (const criterionId of criteriaIds) {
      for (const [candidateA, candidateB] of [[0, 1], [1, 0]] as const) {
        for (const repetition of [0, 1]) {
          const candidateScores = [0.2, 0.9];
          cache[`${criterionId}|task|${candidateA},${candidateB}|${repetition}`] = {
            score_A: candidateScores[candidateA] ?? 0,
            score_B: candidateScores[candidateB] ?? 0,
          };
        }
      }
    }
    await writeFile(cachePath, JSON.stringify(cache));

    try {
      const bridgeResult = await runRealBridge({
        task: "Fix the fixture",
        candidates: [
          { candidateId: "candidate-1", trajectory: "candidate A" },
          { candidateId: "candidate-2", trajectory: "candidate B" },
        ],
        pivots: 1,
        model: "deepseek-v4-flash",
        nEvaluations: 2,
        maxWorkers: 8,
        cachePath,
      });

      assert.equal(bridgeResult.exitCode, 0, bridgeResult.stderr);
      const response = JSON.parse(bridgeResult.stdout) as Record<string, unknown>;
      assert.equal(response.winnerIndex, 1);
      assert.deepEqual(response.ranking, [1, 0]);
      assert.equal(response.requestCount, 0);
      assert.equal((response.tokenUsage as Record<string, unknown>).calls, 0);
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });
});
