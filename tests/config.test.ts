import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeCandidateCount } from "../src/config.ts";

describe("verified_best_of candidate count", () => {
  it("defaults to the configured count and accepts any integer 1-5", () => {
    assert.equal(normalizeCandidateCount(undefined, 3), 3);
    assert.equal(normalizeCandidateCount(undefined, 4), 4);
    assert.equal(normalizeCandidateCount(3, 5), 3);
    assert.equal(normalizeCandidateCount(5, 3), 5);
    assert.equal(normalizeCandidateCount(1, 3), 1);
    assert.equal(normalizeCandidateCount(2, 3), 2);
    assert.equal(normalizeCandidateCount(4, 3), 4);
    assert.throws(() => normalizeCandidateCount(0, 3), /between 1 and 5/);
    assert.throws(() => normalizeCandidateCount(6, 3), /between 1 and 5/);
    assert.throws(() => normalizeCandidateCount(2.5, 3), /between 1 and 5/);
  });
});
