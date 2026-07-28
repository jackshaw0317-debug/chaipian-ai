import { NextResponse } from "next/server";
import {
  consumePublicAllowance,
  isSameOriginRequest,
} from "../../lib/public-ai-access";

export const runtime = "edge";

type Provider = "deepseek" | "openai";
type RewriteFormat = "short-video" | "xiaohongshu" | "private-domain" | "advertising";

type SourceAnalysis = {
  title: string;
  oneLine: string;
  summary: string;
  audience: string;
  contentType: string;
  structure: Array<{ label: string; detail: string; time: string }>;
  highlights: Array<{ quote: string; why: string }>;
  reusableLines: string[];
  improvements: string[];
};

const formatInstructions: Record<RewriteFormat, string> = {
  "short-video": "生成适合直接口播的短视频文案，句子短，节奏清楚，正文使用自然分段。",
  xiaohongshu: "生成适合小红书发布的图文文案，有可读性强的标题、自然分段和明确的信息层级。",
  "private-domain": "生成适合朋友圈或私域发布的文案，语气真实、克制，避免硬广腔。",
  advertising: "生成有明确利益点和行动引导的推广文案，但不得虚构效果、承诺或数据。",
};

const outputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    hook: { type: "string" },
    body: { type: "string" },
    cta: { type: "string" },
    strategy: {
      type: "array",
      minItems: 2,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          source: { type: "string" },
          adaptation: { type: "string" },
        },
        required: ["source", "adaptation"],
      },
    },
  },
  required: ["title", "hook", "body", "cta", "strategy"],
} as const;

function safeString(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeAnalysis(value: unknown): SourceAnalysis | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const structure = Array.isArray(input.structure) ? input.structure.slice(0, 8) : [];
  const highlights = Array.isArray(input.highlights) ? input.highlights.slice(0, 5) : [];
  const reusableLines = Array.isArray(input.reusableLines)
    ? input.reusableLines.slice(0, 6).map((item) => safeString(item, 500)).filter(Boolean)
    : [];
  const improvements = Array.isArray(input.improvements)
    ? input.improvements.slice(0, 5).map((item) => safeString(item, 500)).filter(Boolean)
    : [];

  const normalized: SourceAnalysis = {
    title: safeString(input.title, 300),
    oneLine: safeString(input.oneLine, 500),
    summary: safeString(input.summary, 2_000),
    audience: safeString(input.audience, 500),
    contentType: safeString(input.contentType, 300),
    structure: structure
      .map((item) => {
        const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
        return {
          label: safeString(row.label, 200),
          detail: safeString(row.detail, 600),
          time: safeString(row.time, 60),
        };
      })
      .filter((item) => item.label && item.detail),
    highlights: highlights
      .map((item) => {
        const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
        return {
          quote: safeString(row.quote, 600),
          why: safeString(row.why, 600),
        };
      })
      .filter((item) => item.quote && item.why),
    reusableLines,
    improvements,
  };

  if (
    !normalized.title ||
    !normalized.summary ||
    normalized.structure.length === 0 ||
    normalized.highlights.length === 0
  ) {
    return null;
  }
  return normalized;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 150_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractOpenAIText(payload: Record<string, unknown>) {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray((item as { content?: unknown }).content)
      ? (item as { content: unknown[] }).content
      : [];
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
    }
  }
  return "";
}

function extractDeepSeekText(payload: Record<string, unknown>) {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  return typeof first?.message?.content === "string" ? first.message.content : "";
}

function parseRewrite(text: string) {
  const normalized = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const value = JSON.parse(normalized) as Record<string, unknown>;
  const strings = ["title", "hook", "body", "cta"];
  const strategy = Array.isArray(value.strategy) ? value.strategy : [];
  const valid =
    strings.every((key) => typeof value[key] === "string" && Boolean(String(value[key]).trim())) &&
    strategy.length >= 2 &&
    strategy.every(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof (item as { source?: unknown }).source === "string" &&
        typeof (item as { adaptation?: unknown }).adaptation === "string",
    );
  if (!valid) throw new Error("仿写结果字段不完整");
  return value;
}

function buildPrompts(
  analysis: SourceAnalysis,
  projectInfo: string,
  format: RewriteFormat,
  direction: string,
) {
  const systemPrompt = [
    "你是一位资深中文内容策略师和文案创作者。",
    "你的任务是迁移参考内容的结构方法、叙事节奏和表达策略，而不是改写或拼接原文。",
    "只能使用用户提供的项目信息作为事实来源；不得虚构数据、价格、资质、效果、稀缺性或用户评价。",
    "如果项目信息不足，使用克制表达，不要补造事实。",
    "不要复刻参考内容中的专有表达，避免与原句高度相似。",
  ].join("");

  const userPrompt = `请基于下面的“参考拆解”，为“我的项目”创作一篇全新文案。

输出形式：${formatInstructions[format]}
补充要求：${direction || "无，优先保证真实、自然、可直接使用。"}

参考拆解（只学习策略，不复制事实与原句）：
${JSON.stringify(analysis)}

我的项目信息（唯一事实来源）：
${projectInfo}

只返回合法 JSON，不要使用 Markdown 代码块或添加解释。必须包含：
- title：可直接使用的标题
- hook：开场钩子
- body：完整正文，可用换行分段
- cta：行动引导
- strategy：2-5 项，每项包含 source（借鉴的结构或表达策略）与 adaptation（如何用于本项目）`;

  return { systemPrompt, userPrompt };
}

function friendlyError(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes("abort") || lower.includes("timeout")) {
    return "生成等待时间过长，请稍后重试。";
  }
  if (lower.includes("401") || lower.includes("authentication") || lower.includes("api key")) {
    return "API Key 无效或额度不足，请检查“服务配置”后重试。";
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return "模型服务当前较忙或额度受限，请稍后重试。";
  }
  if (lower.includes("字段不完整") || lower.includes("json")) {
    return "模型返回的文案格式不完整，请重新生成。";
  }
  return "生成类似文案失败，请稍后重试。";
}

export async function POST(request: Request) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: "请求来源无效。" }, { status: 403 });
    }
    const contentLength = Number(request.headers.get("content-length") || "0");
    if (contentLength > 180_000) {
      return NextResponse.json({ error: "提交内容过长，请精简后重试。" }, { status: 413 });
    }
    const body = (await request.json()) as Record<string, unknown>;
    const provider: Provider = body.analysisProvider === "openai" ? "openai" : "deepseek";
    const format = (
      ["short-video", "xiaohongshu", "private-domain", "advertising"].includes(
        String(body.format),
      )
        ? body.format
        : "short-video"
    ) as RewriteFormat;
    const projectInfo = safeString(body.projectInfo, 8_000);
    const direction = safeString(body.direction, 1_000);
    const analysis = normalizeAnalysis(body.analysis);

    if (projectInfo.length < 10) {
      return NextResponse.json(
        { error: "请至少填写 10 个字的项目信息。" },
        { status: 400 },
      );
    }
    if (!analysis) {
      return NextResponse.json(
        { error: "参考拆解内容不完整，请先重新拆解视频。" },
        { status: 400 },
      );
    }

    const openaiApiKey =
      safeString(body.openaiApiKey, 300) || process.env.OPENAI_API_KEY?.trim();
    const userDeepseekApiKey = safeString(body.deepseekApiKey, 300);
    const hostedDeepseekApiKey = process.env.DEEPSEEK_API_KEY?.trim();
    const deepseekApiKey = userDeepseekApiKey || hostedDeepseekApiKey;
    const apiKey = provider === "deepseek" ? deepseekApiKey : openaiApiKey;
    if (!apiKey || apiKey.length < 20) {
      return NextResponse.json(
        { error: `请先在“服务配置”中填写有效的 ${provider === "deepseek" ? "DeepSeek" : "OpenAI"} API Key。` },
        { status: 400 },
      );
    }
    if (provider === "deepseek" && !userDeepseekApiKey && hostedDeepseekApiKey) {
      const allowance = await consumePublicAllowance(request, "rewrite");
      if (!allowance.allowed) {
        return NextResponse.json(
          { error: allowance.message },
          {
            status: 429,
            headers: { "Retry-After": String(allowance.retryAfterSeconds) },
          },
        );
      }
    }

    const { systemPrompt, userPrompt } = buildPrompts(
      analysis,
      projectInfo,
      format,
      direction,
    );

    let response: Response;
    let text = "";
    if (provider === "deepseek") {
      const baseUrl = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
      response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
          thinking: { type: "disabled" },
          temperature: 0.55,
          max_tokens: 3_500,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        const apiError = payload.error as { message?: string } | undefined;
        throw new Error(`DeepSeek ${response.status}: ${apiError?.message || "request failed"}`);
      }
      text = extractDeepSeekText(payload);
    } else {
      response = await fetchWithTimeout("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.ANALYSIS_MODEL || "gpt-5.6-terra",
          reasoning: { effort: "low" },
          text: {
            verbosity: "medium",
            format: {
              type: "json_schema",
              name: "project_copy_rewrite",
              strict: true,
              schema: outputSchema,
            },
          },
          input: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });
      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        const apiError = payload.error as { message?: string } | undefined;
        throw new Error(`OpenAI ${response.status}: ${apiError?.message || "request failed"}`);
      }
      text = extractOpenAIText(payload);
    }

    if (!text) throw new Error("模型返回空结果");
    return NextResponse.json(parseRewrite(text));
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "unknown error";
    console.error("Copy rewrite failed:", message);
    return NextResponse.json({ error: friendlyError(message) }, { status: 500 });
  }
}
