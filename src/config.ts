export type CandidateCount = 1 | 2 | 3 | 4 | 5;

export interface RuntimeConfig {
  readonly candidateProfile: string;
  readonly credentialRef: string;
  readonly verifierModel: string;
  readonly nEvaluations: number;
  readonly maxVerifierWorkers: number;
  readonly verifierEffort: "low" | "high" | "max";
  readonly verifierMaxTokens: number;
  readonly candidateTimeoutMs: number;
  readonly validationTimeoutMs: number;
  readonly runTimeoutMs: number;
  readonly maxVerifierTraceBytes: number;
  readonly stateDirectory: string;
  readonly dshExecutable: string;
  readonly dshHomeDirectory?: string;
}

export function normalizeCandidateCount(
  requestedCandidateCount: number | undefined,
  defaultCandidateCount: number,
): CandidateCount {
  const candidateCount = requestedCandidateCount ?? defaultCandidateCount;
  if (!Number.isInteger(candidateCount) || candidateCount < 1 || candidateCount > 5) {
    throw new Error(
      `invalid candidateCount: expected an integer between 1 and 5, got ${JSON.stringify(candidateCount)}`,
    );
  }
  return candidateCount as CandidateCount;
}
