import type { Context } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ApprovalOutcome, ApprovalPolicy } from "@deepseek-ai/dsh-user-approval";
import z from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CandidateCount, RuntimeConfig } from "./config.ts";
import {
  applyVerifiedWinner,
  rollbackVerifiedWinner,
  runVerifiedBestOf,
  selectVerifiedCandidate,
} from "./core.ts";
import { registerVerifierSettings, resolveRunSettings, settingsBaseFrom } from "./settings.ts";
import { reviewCandidatesWithDshModel, type LlmRuntimeLike } from "./reviewer.ts";
import type { ReviewWithModelRequest } from "./contracts.ts";
import { runPythonVerifier } from "./verifier.ts";

export const name = "llm-verifier";
export const inject = ["tools", "approval", "credentials"];
const DEEPSEEK_MODEL_NAME = /^deepseek-[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export interface Config {
  readonly defaultCandidateCount?: CandidateCount;
  readonly candidateProfile?: string;
  readonly credentialRef?: string;
  readonly verifierModel?: string;
  readonly nEvaluations?: number;
  readonly maxVerifierWorkers?: number;
  readonly verifierEffort?: "low" | "high" | "max";
  readonly verifierMaxTokens?: number;
  readonly candidateTimeoutMs?: number;
  readonly validationTimeoutMs?: number;
  readonly runTimeoutMs?: number;
  readonly maxVerifierTraceBytes?: number;
  readonly stateDirectory?: string;
}

export const Config = z.object({
  defaultCandidateCount: z.union([z.const(3), z.const(5)]).default(3),
  candidateProfile: z.string().default("headless"),
  credentialRef: z.string().default("DEEPSEEK_API_KEY"),
  verifierModel: z.string().default("deepseek-v4-flash"),
  nEvaluations: z.natural().min(1).max(4).default(2),
  maxVerifierWorkers: z.natural().min(1).max(16).default(8),
  verifierEffort: z.union([
    z.const("low"),
    z.const("high"),
    z.const("max"),
  ]).default("high"),
  verifierMaxTokens: z.natural().min(1).default(32_768),
  candidateTimeoutMs: z.natural().min(1).default(20 * 60 * 1_000),
  validationTimeoutMs: z.natural().min(1).default(10 * 60 * 1_000),
  runTimeoutMs: z.natural().min(1).default(45 * 60 * 1_000),
  maxVerifierTraceBytes: z.natural().min(1).default(512 * 1_024),
  stateDirectory: z.string().default("$DSH_HOME/llm-verifier"),
});

function expandStateDirectory(configuredStateDirectory: string, dshHomeDirectory: string): string {
  if (configuredStateDirectory === "$DSH_HOME") {
    return dshHomeDirectory;
  }
  if (configuredStateDirectory.startsWith("$DSH_HOME/")) {
    return join(dshHomeDirectory, configuredStateDirectory.slice("$DSH_HOME/".length));
  }
  return configuredStateDirectory;
}

function resolvePluginConfig(config: Config): {
  readonly defaultCandidateCount: CandidateCount;
  readonly runtimeConfig: RuntimeConfig;
} {
  const dshHomeDirectory = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const candidateProfile = (config.candidateProfile ?? "headless").trim();
  const configuredCredentialRef = (config.credentialRef ?? "DEEPSEEK_API_KEY").trim();
  const verifierModel = (config.verifierModel ?? "deepseek-v4-flash").trim();
  if (candidateProfile.length === 0) {
    throw new Error(`invalid candidateProfile: got ${JSON.stringify(config.candidateProfile)}`);
  }
  if (configuredCredentialRef.length === 0) {
    throw new Error(`invalid credentialRef: got ${JSON.stringify(config.credentialRef)}`);
  }
  if (!DEEPSEEK_MODEL_NAME.test(verifierModel)) {
    throw new Error(
      `invalid verifierModel: expected a DeepSeek model name beginning with "deepseek-", got ${JSON.stringify(config.verifierModel)}`,
    );
  }
  return {
    defaultCandidateCount: config.defaultCandidateCount ?? 3,
    runtimeConfig: {
      candidateProfile,
      credentialRef: configuredCredentialRef,
      verifierModel,
      nEvaluations: config.nEvaluations ?? 2,
      maxVerifierWorkers: config.maxVerifierWorkers ?? 8,
      verifierEffort: config.verifierEffort ?? "high",
      verifierMaxTokens: config.verifierMaxTokens ?? 32_768,
      candidateTimeoutMs: config.candidateTimeoutMs ?? 20 * 60 * 1_000,
      validationTimeoutMs: config.validationTimeoutMs ?? 10 * 60 * 1_000,
      runTimeoutMs: config.runTimeoutMs ?? 45 * 60 * 1_000,
      maxVerifierTraceBytes: config.maxVerifierTraceBytes ?? 512 * 1_024,
      stateDirectory: expandStateDirectory(
        config.stateDirectory ?? "$DSH_HOME/llm-verifier",
        dshHomeDirectory,
      ),
      dshExecutable: "dsh",
      dshHomeDirectory,
    },
  };
}

const candidateOutputProperties = {
  candidateId: { type: "string", required: true },
  executionStatus: {
    type: "string",
    enum: ["cancelled", "completed", "failed", "timed_out"],
    required: true,
  },
  validationStatus: {
    type: "string",
    enum: ["failed", "not_run", "passed", "timed_out"],
    required: true,
  },
  score: {
    oneOf: [{ type: "number" }, { type: "null" }],
    required: true,
  },
  changedFiles: {
    type: "array",
    items: { type: "string" },
    required: true,
  },
  failure: {
    oneOf: [{ type: "string" }, { type: "null" }],
    required: true,
  },
} as const;

const verifiedBestOfOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "integer", enum: [1, 2], required: true },
    runId: { type: "string", required: true },
    baseCommit: { type: "string", required: true },
    requestedCandidateCount: { type: "integer", enum: [1, 2, 3, 4, 5], required: true },
    completedCandidateCount: { type: "integer", required: true },
    eligibleCandidateCount: { type: "integer", required: true },
    status: {
      type: "string",
      enum: ["failed", "no_winner", "winner_selected", "review_pending"],
      required: true,
    },
    selectionMethod: {
      oneOf: [
        { type: "string", enum: ["llm_verifier", "validation_only", "parent_agent_review", "dsh_model"] },
        { type: "null" },
      ],
      required: true,
    },
    winnerId: {
      oneOf: [{ type: "string" }, { type: "null" }],
      required: true,
    },
    ranking: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { ...candidateOutputProperties, diffStat: { type: "string" }, durationMs: { type: "integer" } },
      },
      required: true,
    },
    tokenUsage: { type: "json", required: true },
    verifierRequestCount: { type: "integer", required: true },
    reportPath: { type: "string", required: true },
    winnerPatchPath: {
      oneOf: [{ type: "string" }, { type: "null" }],
      required: true,
    },
    failure: {
      oneOf: [{ type: "string" }, { type: "null" }],
      required: true,
    },
    review: { type: "json" },
    resolvedConfig: { type: "json" },
    settingsRevision: {
      oneOf: [{ type: "integer" }, { type: "null" }],
    },
  },
} as const;

const selectVerifiedCandidateOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "integer", const: 2, required: true },
    runId: { type: "string", required: true },
    candidateId: { type: "string", required: true },
    reason: { type: "string", required: true },
    status: { type: "string", enum: ["selected"], required: true },
    selectedAt: { type: "string", required: true },
    sessionId: {
      oneOf: [{ type: "string" }, { type: "null" }],
      required: true,
    },
  },
} as const;

const applyWinnerOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "integer", const: 1, required: true },
    runId: { type: "string", required: true },
    status: {
      type: "string",
      enum: ["applied", "applied_validation_failed"],
      required: true,
    },
    patchSha256: { type: "string", required: true },
    changedFiles: { type: "array", items: { type: "string" }, required: true },
    validationStatus: {
      type: "string",
      enum: ["failed", "passed", "timed_out"],
      required: true,
    },
    validationLogPaths: { type: "array", items: { type: "string" }, required: true },
    failure: {
      oneOf: [{ type: "string" }, { type: "null" }],
      required: true,
    },
  },
} as const;

function requireAllowedApproval(outcome: ApprovalOutcome, toolName: string): void {
  if (outcome !== "allowed-once") {
    throw new Error(`${toolName} approval was not granted: ${outcome}`);
  }
}

/**
 * Whether the session's approval policy already removes the interactive ask.
 * 'never' is DSH's deterministic unattended stance: every ask would resolve
 * 'rejected' without reaching a human, so asking would only disable the tool.
 * The tool then proceeds under the session's own permission presets.
 */
export function skipsInteractiveApproval(
  sessionOverride: ApprovalPolicy | undefined,
  configuredDefault: ApprovalPolicy | undefined,
): boolean {
  return (sessionOverride ?? configuredDefault ?? "ask") === "never";
}

export function apply(ctx: Context, config: Config = {}): void {
  const { defaultCandidateCount, runtimeConfig } = resolvePluginConfig(config);
  const fallbackRunSettings = settingsBaseFrom(defaultCandidateCount, runtimeConfig);
  registerVerifierSettings(ctx, fallbackRunSettings);
  // The host LLM runtime is optional (headless profiles): reviewMode
  // 'dsh_model' degrades per reviewFailurePolicy when it is absent.
  let llmRuntime: unknown = null;
  {
    const owner = ctx as Context & {
      inject?: (services: string[], callback: (scoped: { llm?: unknown }) => void) => void;
    };
    if (typeof owner.inject === "function") {
      owner.inject(["llm"], (scoped) => {
        llmRuntime = scoped.llm ?? null;
      });
    }
  }

  ctx.tools.register(defineTool({
    name: "verified_best_of",
    description: "Run 1-5 isolated coding candidates in git worktrees, validate them, and route the eligible set through the configured reviewer (settings page: parent agent, a DSH model, or the DeepSeek verifier) without changing the current repository. Parent-agent review returns review_pending; record the choice with select_verified_candidate. Sessions with approval policy 'never' (unattended) proceed without the interactive ask.",
    parameters: {
      task: {
        type: "string",
        required: true,
        description: "The coding task every isolated candidate must implement.",
      },
      candidateCount: {
        type: "integer",
        enum: [1, 2, 3, 4, 5],
        description: "Override the configured candidate count for this run (1-5). Omit to use the settings-page default.",
      },
      validationCommands: {
        type: "array",
        items: { type: "string" },
        description: "Optional validation commands. When omitted, one supported root project type is detected.",
      },
    },
    output: {
      schema: verifiedBestOfOutputSchema,
      render: (_args, value) => [{
        type: "text",
        text: [
          `Verified Best-of-${value.requestedCandidateCount}: ${value.status}.`,
          `Winner: ${value.winnerId ?? "none"}.`,
          `Eligible candidates: ${value.eligibleCandidateCount}.`,
          ...value.ranking.map((r) => {
            const parts = [`  ${r.candidateId}: ${r.executionStatus}/${r.validationStatus}`];
            if (r.changedFiles.length > 0) parts.push(`files: ${r.changedFiles.join(", ")}`);
            if (r.diffStat) parts.push(r.diffStat);
            if (r.failure) parts.push(`FAIL: ${r.failure.slice(0, 100)}`);
            return parts.join(" | ");
          }),
          `Report: ${value.reportPath}.`,
          value.winnerPatchPath === null ? "No patch is available." : `Patch: ${value.winnerPatchPath}. Apply only with apply_verified_winner.`,
          ...(value.status === "review_pending" ? [
            "SELECTION REQUIRED: this run is review_pending. You (the parent agent) must review the candidate diffs and call select_verified_candidate with runId, candidateId, and a reason.",
            `Available candidates: ${value.ranking.map((r) => r.candidateId).join(", ")}.`,
            "After the selection is recorded, apply it with apply_verified_winner.",
          ] : []),
          ...(value.status === "winner_selected" && value.selectionMethod === "dsh_model" ? [
            `REVIEWER: ${String((value.review as { provider: string; model: string; selectedId: string } | null)?.provider ?? "?")}/${String((value.review as { provider: string; model: string; selectedId: string } | null)?.model ?? "?")} selected ${String((value.review as { provider: string; model: string; selectedId: string } | null)?.selectedId ?? "?")}.`,
          ] : []),
          value.failure === null ? "" : `Failure: ${value.failure}`,
        ].filter((line) => line.length > 0).join("\n"),
      }],
    },
    timeoutMs: 100 * 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const repositoryPath = exec.agent?.session.header.cwd;
      if (repositoryPath === undefined) {
        throw new Error("verified_best_of requires a calling agent with a session cwd");
      }
      const { section: runSettings, settingsRevision } = resolveRunSettings(fallbackRunSettings);
      if (!runSettings.enabled) {
        throw new Error("verified_best_of is disabled by the llm-verifier settings (enabled: false)");
      }
      let operationCredential: string | undefined;
      return runVerifiedBestOf(
        {
          task: args.task,
          ...(args.candidateCount === undefined ? {} : { candidateCount: args.candidateCount }),
          ...(args.validationCommands === undefined ? {} : { validationCommands: args.validationCommands }),
          repositoryPath,
          settingsRevision,
          signal: exec.signal,
        },
        runSettings,
        {
          requestApproval: async (reason, signal) => {
            const agent = exec.agent;
            if (agent === undefined) {
              throw new Error("verified_best_of approval requires a calling agent");
            }
            if (skipsInteractiveApproval(ctx.approval.overrideOf(agent.session), ctx.approval.config.policy)) {
              return;
            }
            requireAllowedApproval(await ctx.approval.request({
              agent,
              toolName: "verified_best_of",
              callId: exec.callId,
              reason,
              signal,
            }), "verified_best_of");
          },
          resolveCredential: async () => {
            const resolvedCredential = await ctx.credentials.resolve(credentialRef(runSettings.credentialRef));
            // Absence is not fatal here: validation-only runs complete without
            // a verifier credential. runVerifiedBestOf enforces the requirement
            // only when LLM ranking is actually needed.
            const value = resolvedCredential?.value ?? "";
            if (value.length > 0) {
              operationCredential = value;
            }
            return value;
          },
          runVerifier: async (request) => {
            if (operationCredential === undefined || operationCredential.length === 0) {
              throw new Error(`credential ${runSettings.credentialRef} is not configured`);
            }
            return runPythonVerifier(request, {
              config: runSettings,
              credentialValue: operationCredential,
            });
          },
          ...(llmRuntime === null ? {} : {
            reviewCandidates: (request: ReviewWithModelRequest) =>
              reviewCandidatesWithDshModel(llmRuntime as LlmRuntimeLike, request),
          }),
        },
      );
    },
  }));



  ctx.tools.register(defineTool({
    name: "rollback_verified_winner",
    description: "Revert the changes applied by a previous apply_verified_winner call. Only works after an apply has been executed.",
    parameters: {
      runId: {
        type: "string",
        required: true,
        description: "The runId of the previously applied verified_best_of run.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          schemaVersion: { type: "integer", const: 1, required: true },
          runId: { type: "string", required: true },
          status: { type: "string", const: "rolled_back", required: true },
          changedFiles: { type: "array", items: { type: "string" }, required: true },
          failure: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: [
          `Rollback result: ${value.status}.`,
          `Reverted files: ${value.changedFiles.join(", ")}.`,
          value.failure === null ? "" : `Failure: ${value.failure}`,
        ].filter((line) => line.length > 0).join(String.fromCharCode(10)),
      }],
    },
    timeoutMs: 30 * 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const repositoryPath = exec.agent?.session.header.cwd;
      if (repositoryPath === undefined) {
        throw new Error("rollback_verified_winner requires a calling agent with a session cwd");
      }
      return rollbackVerifiedWinner(
        { runId: args.runId, repositoryPath, signal: exec.signal },
        resolveRunSettings(fallbackRunSettings).section,
      );
    },
  }));
  ctx.tools.register(defineTool({
    name: "select_verified_candidate",
    description: "Record an explicit winner selection for a verified_best_of run that is review_pending (parent-agent review mode). Provide the chosen candidateId and a non-empty reason; then apply with apply_verified_winner.",
    parameters: {
      runId: {
        type: "string",
        required: true,
        description: "The runId of the review_pending verified_best_of run.",
      },
      candidateId: {
        type: "string",
        required: true,
        description: "The eligible candidate you choose as the winner after reviewing the diffs.",
      },
      reason: {
        type: "string",
        required: true,
        description: "Why this candidate wins, citing concrete diff evidence. Recorded verbatim in the audit trail.",
      },
    },
    output: {
      schema: selectVerifiedCandidateOutputSchema,
      render: (_args, value) => [{
        type: "text",
        text: [
          `Selection recorded: ${value.candidateId} for run ${value.runId}.`,
          `Reason: ${value.reason}`,
          "Now apply it with apply_verified_winner.",
        ].join("\n"),
      }],
    },
    timeoutMs: 5 * 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const repositoryPath = exec.agent?.session.header.cwd;
      if (repositoryPath === undefined) {
        throw new Error("select_verified_candidate requires a calling agent with a session cwd");
      }
      return selectVerifiedCandidate(
        {
          runId: args.runId,
          repositoryPath,
          candidateId: args.candidateId,
          reason: args.reason,
          ...(exec.agent?.session.id === undefined ? {} : { sessionId: exec.agent.session.id }),
        },
        resolveRunSettings(fallbackRunSettings).section,
      );
    },
  }));
  ctx.tools.register(defineTool({
    name: "apply_verified_winner",
    description: "After a separate approval, apply one previously verified winner patch and rerun its validation commands. Sessions with approval policy 'never' (unattended) proceed without the interactive ask.",
    parameters: {
      runId: {
        type: "string",
        required: true,
        description: "The runId returned by verified_best_of.",
      },
      candidateId: {
        type: "string",
        description: "Optional on legacy v1 runs only. On v2 review_pending runs the recorded select_verified_candidate choice is applied; passing a different candidateId is rejected.",
      },
    },
    output: {
      schema: applyWinnerOutputSchema,
      render: (_args, value) => [{
        type: "text",
        text: [
          `Apply result: ${value.status}.`,
          `Changed files: ${value.changedFiles.join(", ")}.`,
          `Validation: ${value.validationStatus}.`,
          value.failure === null ? "" : `Failure: ${value.failure}`,
        ].filter((line) => line.length > 0).join("\n"),
      }],
    },
    timeoutMs: 100 * 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const repositoryPath = exec.agent?.session.header.cwd;
      if (repositoryPath === undefined) {
        throw new Error("apply_verified_winner requires a calling agent with a session cwd");
      }
      return applyVerifiedWinner(
        { runId: args.runId, repositoryPath, signal: exec.signal, ...(args.candidateId !== undefined ? { candidateId: args.candidateId } : {}) },
        resolveRunSettings(fallbackRunSettings).section,
        {
          requestApproval: async (reason, signal) => {
            const agent = exec.agent;
            if (agent === undefined) {
              throw new Error("apply_verified_winner approval requires a calling agent");
            }
            if (skipsInteractiveApproval(ctx.approval.overrideOf(agent.session), ctx.approval.config.policy)) {
              return;
            }
            requireAllowedApproval(await ctx.approval.request({
              agent,
              toolName: "apply_verified_winner",
              callId: exec.callId,
              reason,
              signal,
            }), "apply_verified_winner");
          },
          resolveCredential: async () => {
            const resolvedCredential = await ctx.credentials.resolve(
              credentialRef(resolveRunSettings(fallbackRunSettings).section.credentialRef),
            );
            // Only used for log redaction; an unconfigured credential means
            // there is nothing to redact.
            return resolvedCredential?.value ?? "";
          },
        },
      );
    },
  }));
}

export default apply;
