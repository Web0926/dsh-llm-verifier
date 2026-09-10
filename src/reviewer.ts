import type { JsonValue } from "./contracts.ts";

/**
 * Structural surface of the optional host LLM runtime (@deepseek-ai/dsh-llm).
 * The web host supplies `ctx.llm` at runtime; plain-headless profiles may not
 * provide it, in which case reviewMode 'dsh_model' fails per its policy.
 */
export interface LlmRuntimeLike {
  stream(options: {
    provider: string;
    model: string;
    reasoningEffort?: string;
    messages: Array<{
      id: string;
      role: "user" | "assistant" | "system";
      content: Array<{ type: "text"; text: string }>;
    }>;
    system?: string;
    maxTokens?: number;
    signal?: AbortSignal;
  }): AsyncIterable<{
    type: string;
    text?: string;
    reason?: string;
  }>;
}

export interface DshModelReviewRequest {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly maxTokens: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly task: string;
  readonly candidates: ReadonlyArray<{
    readonly candidateId: string;
    readonly validationStatus: string;
    readonly diffStat: string;
    readonly changedFiles: readonly string[];
    readonly diffText: string;
  }>;
}

export interface DshModelReviewReceipt {
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

const REVIEW_SYSTEM_PROMPT = [
  "你是编码补丁评审员。给你一个编码任务和多个候选补丁（统一 diff），每个候选都通过了相同的验证命令。",
  "你要按给定评审标准给每个候选打 0-100 分并选出唯一优胜者。",
  "只输出一个 JSON 对象，不要输出任何其他文字、Markdown 代码块标记或解释。",
  "JSON 格式：",
  '{"scores": {"<候选ID>": <0-100 整数>}, "selected": "<优胜候选ID>", "evidence": {"<候选ID>": "<评分依据，引用 diff 中的具体证据>"}, "risks": "<优胜方案的已知风险>"}',
  "要求：scores 必须覆盖全部候选且无多余键；selected 必须是得分最高的候选；出现同分时选择候选 ID 数值序更小的一个。",
].join("\n");

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const candidate = fenced !== null ? fenced[1] ?? "" : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("reviewer response contained no JSON object");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

export async function reviewCandidatesWithDshModel(
  llm: LlmRuntimeLike,
  request: DshModelReviewRequest,
): Promise<DshModelReviewReceipt> {
  const candidateSections = request.candidates.map((candidate) => {
    return [
      `### 候选 ${candidate.candidateId}`,
      `验证: ${candidate.validationStatus}`,
      `变更文件: ${candidate.changedFiles.join(", ") || "(none)"}`,
      candidate.diffStat.length > 0 ? `Diff 摘要: ${candidate.diffStat}` : "",
      "```diff",
      candidate.diffText.length > 0 ? candidate.diffText : "(empty diff)",
      "```",
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  });
  const criteriaLines = [
    "1. 要求符合度：补丁是否完整、正确地实现任务要求",
    "2. 结果与证据一致性：验证结果与 diff 内容是否相互印证",
    "3. 错误识别：是否引入新的错误、边界或回归",
  ].join("\n");
  const userText = [
    `# 编码任务`,
    request.task,
    "",
    `# 评审标准（等权）`,
    criteriaLines,
    "",
    `# 候选补丁（共 ${request.candidates.length} 个）`,
    candidateSections.join("\n\n"),
  ].join("\n");

  const timeout = setTimeout(
    () => controller.abort(new Error(`review timed out after ${request.timeoutMs} ms`)),
    request.timeoutMs,
  );
  timeout.unref();
  const controller = new AbortController();
  const relayAbort = (): void => controller.abort(request.signal.reason);
  if (request.signal.aborted) controller.abort(request.signal.reason);
  request.signal.addEventListener("abort", relayAbort, { once: true });

  const startedAt = Date.now();
  let text = "";
  try {
    const stream = llm.stream({
      provider: request.provider,
      model: request.model,
      ...(request.reasoningEffort !== "" ? { reasoningEffort: request.reasoningEffort } : {}),
      messages: [
        { id: `review-${startedAt}`, role: "user", content: [{ type: "text", text: userText }] },
      ],
      system: REVIEW_SYSTEM_PROMPT,
      maxTokens: request.maxTokens,
      signal: controller.signal,
    });
    for await (const chunk of stream) {
      if (chunk.type === "text-delta" && typeof chunk.text === "string") {
        text += chunk.text;
      }
      if (chunk.type === "finish") {
        const kind = (chunk.reason as { kind?: string } | undefined)?.kind;
        if (kind === "error" || kind === "aborted") {
          throw new Error(`review model stream finished with ${kind}`);
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", relayAbort);
  }

  const parsed = extractJson(text) as {
    scores?: unknown;
    selected?: unknown;
    evidence?: unknown;
    risks?: unknown;
  };
  if (parsed.scores === null || typeof parsed.scores !== "object" || Array.isArray(parsed.scores)) {
    throw new Error("reviewer response is missing the scores object");
  }
  const scoresRaw = parsed.scores as Record<string, unknown>;
  const expectedIds = request.candidates.map((candidate) => candidate.candidateId).sort();
  const scoreIds = Object.keys(scoresRaw).sort();
  if (scoreIds.join(",") !== expectedIds.join(",")) {
    throw new Error(
      `reviewer scores keys ${JSON.stringify(scoreIds)} do not exactly cover candidates ${JSON.stringify(expectedIds)}`,
    );
  }
  const scores: Record<string, number> = {};
  for (const [candidateId, value] of Object.entries(scoresRaw)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error(`reviewer score for ${candidateId} is not a finite 0-100 number: ${JSON.stringify(value)}`);
    }
    scores[candidateId] = value;
  }
  const selectedId = parsed.selected;
  if (typeof selectedId !== "string" || !expectedIds.includes(selectedId)) {
    throw new Error(`reviewer selected ${JSON.stringify(selectedId)} is not one of the candidates`);
  }
  const numericTop = [...request.candidates]
    .map((candidate) => candidate.candidateId)
    .sort((left, right) => {
      const byScore = (scores[right] ?? 0) - (scores[left] ?? 0);
      return byScore !== 0 ? byScore : left.localeCompare(right);
    })[0];
  if (numericTop !== selectedId) {
    throw new Error(
      `reviewer selected ${selectedId} but the highest-scored candidate is ${numericTop}`,
    );
  }
  const evidence: Record<string, string> = {};
  if (parsed.evidence !== null && typeof parsed.evidence === "object" && !Array.isArray(parsed.evidence)) {
    for (const [candidateId, value] of Object.entries(parsed.evidence as Record<string, unknown>)) {
      if (typeof value === "string") evidence[candidateId] = value;
    }
  }
  const risks = typeof parsed.risks === "string" ? parsed.risks : "";
  return {
    method: "dsh_model",
    provider: request.provider,
    model: request.model,
    selectedId,
    scores,
    evidence,
    risks,
    rawResponseLength: text.length,
    durationMs: Date.now() - startedAt,
  };
}
