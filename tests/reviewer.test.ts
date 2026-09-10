import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { reviewCandidatesWithDshModel, type LlmRuntimeLike } from "../src/reviewer.ts";

function llmWith(response: string): LlmRuntimeLike {
  return {
    async *stream() {
      yield { type: "text-delta", text: response };
      yield { type: "finish", reason: "stop" };
    },
  };
}

const base = {
  provider: "minimax-cn",
  model: "MiniMax-M3",
  maxTokens: 4096,
  timeoutMs: 30_000,
  signal: new AbortController().signal,
  task: "Fix slugify",
  candidates: [
    { candidateId: "candidate-1", validationStatus: "passed", diffStat: "1 +", changedFiles: ["src/a.js"], diffText: "+a" },
    { candidateId: "candidate-2", validationStatus: "passed", diffStat: "2 +", changedFiles: ["src/a.js"], diffText: "+b" },
  ],
};

describe("dsh_model reviewer", () => {
  it("accepts a well-formed receipt whose top score matches the selection", async () => {
    const receipt = await reviewCandidatesWithDshModel(llmWith(
      '{"scores": {"candidate-1": 70, "candidate-2": 95}, "selected": "candidate-2", "evidence": {"candidate-2": "cleaner"}, "risks": "none"}',
    ), { ...base });
    assert.equal(receipt.selectedId, "candidate-2");
    assert.equal(receipt.scores["candidate-1"], 70);
    assert.equal(receipt.method, "dsh_model");
  });

  it("parses a fenced JSON response", async () => {
    const receipt = await reviewCandidatesWithDshModel(llmWith(
      '```json\n{"scores": {"candidate-1": 90, "candidate-2": 80}, "selected": "candidate-1", "evidence": {}, "risks": ""}\n```',
    ), { ...base });
    assert.equal(receipt.selectedId, "candidate-1");
  });

  it("rejects a selection that contradicts the computed ranking", async () => {
    await assert.rejects(
      () => reviewCandidatesWithDshModel(llmWith(
        '{"scores": {"candidate-1": 70, "candidate-2": 95}, "selected": "candidate-1", "evidence": {}, "risks": ""}',
      ), { ...base }),
      /highest-scored candidate is candidate-2/,
    );
  });

  it("rejects score keys that do not exactly cover the candidates", async () => {
    await assert.rejects(
      () => reviewCandidatesWithDshModel(llmWith(
        '{"scores": {"candidate-1": 70}, "selected": "candidate-1", "evidence": {}, "risks": ""}',
      ), { ...base }),
      /do not exactly cover candidates/,
    );
  });

  it("rejects out-of-range scores", async () => {
    await assert.rejects(
      () => reviewCandidatesWithDshModel(llmWith(
        '{"scores": {"candidate-1": 170, "candidate-2": 95}, "selected": "candidate-1", "evidence": {}, "risks": ""}',
      ), { ...base }),
      /not a finite 0-100 number/,
    );
  });
});
