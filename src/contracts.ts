import type { CandidateCount } from "./config.ts";

export type JsonValue =
  | boolean
  | null
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ExecutionStatus = "cancelled" | "completed" | "failed" | "timed_out";
export type ValidationStatus = "failed" | "not_run" | "passed" | "timed_out";

export interface BinaryFileSummary {
  readonly path: string;
  readonly sizeBytes: number;
  readonly gitObjectHash: string;
  readonly state: "deleted" | "present";
}

export interface CandidateResult {
  readonly candidateId: string;
  readonly executionStatus: ExecutionStatus;
  readonly validationStatus: ValidationStatus;
  readonly durationMs: number;
  readonly processExitCode: number | null;
  readonly response: string;
  readonly changedFiles: string[];
  readonly binaryFiles: BinaryFileSummary[];
  readonly diffStat: string;
  readonly verifierTrace: string;
  readonly verifierTraceTruncated: boolean;
  readonly patchPath: string | null;
  readonly patchSha256: string | null;
  readonly logPaths: string[];
  readonly failure: string | null;
  score: number | null;
  rankingPosition: number | null;
}

export interface PublicCandidateResult {
  readonly candidateId: string;
  readonly executionStatus: ExecutionStatus;
  readonly validationStatus: ValidationStatus;
  readonly score: number | null;
  readonly changedFiles: string[];
  readonly diffStat: string;
  readonly durationMs: number;
  readonly failure: string | null;
}

export interface ReviewReceipt {
  [key: string]: JsonValue;
  readonly method: "dsh_model";
  readonly provider: string;
  readonly model: string;
  readonly selectedId: string;
  readonly scores: Record<string, number>;
  readonly evidence: Record<string, string>;
  readonly risks: string;
  readonly rawResponseLength: number;
  readonly durationMs: number;
}

export interface VerifiedBestOfResult {
  readonly schemaVersion: 1 | 2;
  readonly runId: string;
  readonly baseCommit: string;
  readonly requestedCandidateCount: CandidateCount;
  readonly completedCandidateCount: number;
  readonly eligibleCandidateCount: number;
  readonly status: "failed" | "no_winner" | "winner_selected" | "review_pending";
  readonly selectionMethod:
    | "llm_verifier"
    | "validation_only"
    | "parent_agent_review"
    | "dsh_model"
    | null;
  readonly winnerId: string | null;
  readonly ranking: PublicCandidateResult[];
  readonly tokenUsage: JsonValue | null;
  readonly verifierRequestCount: number;
  readonly reportPath: string;
  readonly winnerPatchPath: string | null;
  readonly failure: string | null;
  readonly review: ReviewReceipt | null;
  readonly resolvedConfig: Record<string, JsonValue> | null;
  readonly settingsRevision: number | null;
}

export interface VerifierCandidate {
  readonly candidateId: string;
  readonly trajectory: string;
}

export interface VerifierRequest {
  readonly task: string;
  readonly candidates: VerifierCandidate[];
  readonly pivots: number;
  readonly model: string;
  readonly nEvaluations: number;
  readonly maxWorkers: number;
  readonly cachePath: string;
  readonly signal: AbortSignal;
}

export interface VerifierResponse {
  readonly winnerIndex: number;
  readonly scores: number[];
  readonly ranking: number[];
  readonly requestCount: number;
  readonly tokenUsage: JsonValue | null;
  readonly diagnostics?: string;
}

export interface RuntimeDependencies {
  readonly requestApproval: (reason: string, signal: AbortSignal) => Promise<void>;
  readonly resolveCredential: () => Promise<string>;
  readonly runVerifier: (request: VerifierRequest) => Promise<VerifierResponse>;
  /** Present when the host provides ctx.llm; reviewMode 'dsh_model' fails per policy without it. */
  readonly reviewCandidates?: (request: ReviewWithModelRequest) => Promise<ReviewReceipt>;
}

export interface ReviewWithModelRequest {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly maxTokens: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly task: string;
  readonly candidates: Array<{
    readonly candidateId: string;
    readonly validationStatus: ValidationStatus;
    readonly diffStat: string;
    readonly changedFiles: string[];
    readonly diffText: string;
  }>;
}

export interface SelectVerifiedCandidateResult {
  readonly schemaVersion: 2;
  readonly runId: string;
  readonly candidateId: string;
  readonly reason: string;
  readonly status: "selected";
  readonly selectedAt: string;
  readonly sessionId: string | null;
}

export interface ApplyRuntimeDependencies {
  readonly requestApproval: (reason: string, signal: AbortSignal) => Promise<void>;
  readonly resolveCredential: () => Promise<string>;
}

export interface ApplyVerifiedWinnerResult {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly status: "applied" | "applied_validation_failed";
  readonly patchSha256: string;
  readonly changedFiles: string[];
  readonly validationStatus: "failed" | "passed" | "timed_out";
  readonly validationLogPaths: string[];
  readonly failure: string | null;
}

export interface RollbackResult {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly status: "rolled_back";
  readonly changedFiles: string[];
  readonly failure: string | null;
}
