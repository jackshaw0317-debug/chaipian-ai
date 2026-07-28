import { NextResponse } from "next/server";
import {
  consumePublicAllowance,
  isSameOriginRequest,
} from "../../lib/public-ai-access";

export const runtime = "edge";

const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 120_000;
type AnalysisProvider = "openai" | "deepseek";
type TranscriptionProvider = "local" | "openai";

type DownloaderResponse = {
  status?: "tunnel" | "redirect" | "local-processing" | "picker" | "error";
  url?: string;
  filename?: string;
  error?: { code?: string };
  text?: string;
};

type WhisperResponse = {
  text?: string;
  segments?: Array<{
    start?: number;
    end?: number;
    text?: string;
  }>;
  error?: { message?: string };
};

function isBlockedHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "0.0.0.0" ||
    normalized === "::1" ||
    normalized.endsWith(".local") ||
    normalized.startsWith("127.") ||
    normalized.startsWith("10.") ||
    normalized.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(normalized) ||
    /^169\.254\./.test(normalized)
  );
}

function safeUrl(input: string) {
  const parsed = new URL(input);
  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new Error("只支持 http 或 https 链接。");
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new Error("不支持本机或内网地址。");
  }
  return parsed;
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Request timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function friendlyError(message: string) {
  const lower = message.toLowerCase();
  if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("aborted")
  ) {
    return "处理超时。请确认本机服务仍在运行，或换一个更短的视频后重试。";
  }
  if (lower.includes("api key") || lower.includes("unauthorized") || lower.includes("401")) {
    if (lower.includes("deepseek")) {
      return "DeepSeek API Key 无效或额度不足，请检查“服务配置”中的 DeepSeek 密钥。";
    }
    return "OpenAI API Key 无效或额度不足，请检查“服务配置”中的 OpenAI 密钥。";
  }
  if (lower.includes("local whisper") || lower.includes("本地 whisper")) {
    return "本地 Whisper 没有成功转写。请确认已通过“启动拆片AI”启动服务；首次使用还需要等待模型下载完成。";
  }
  if (lower.includes("fresh cookies") || lower.includes("cookies-from-browser")) {
    return "抖音拒绝了常规下载接口。请在“服务配置”中选择“自动使用临时 Edge（推荐）”后重试。";
  }
  if (
    lower.includes("failed to decrypt with dpapi") ||
    lower.includes("could not copy chrome cookie database") ||
    lower.includes("cookie database is locked")
  ) {
    return "Windows 无法解密现有浏览器 Cookie。请在“平台下载凭证”中选择“自动使用临时 Edge（推荐）”后重试。";
  }
  if (lower.includes("too large") || lower.includes("maximum") || lower.includes("24 mb")) {
    return "音频超过 24 MB。请改用更短的视频，或在下载服务中降低音频码率。";
  }
  if (lower.includes("downloader") || lower.includes("cobalt")) {
    const detail = message.replace(/^Local downloader failed:\s*/i, "").trim();
    return detail && detail !== message
      ? `本地视频下载失败：${detail}`
      : "本地视频下载服务没有成功处理这个链接。请确认服务正在运行、链接可公开访问，或改用更短的视频。";
  }
  return message || "处理失败，请稍后重试。";
}

async function resolveMedia(sourceUrl: URL, cookieBrowser = "") {
  const directResponse = await fetchWithTimeout(sourceUrl, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent": "ChaipianAI/1.0",
      Range: `bytes=0-${MAX_AUDIO_BYTES}`,
    },
  }, 30_000);

  const contentType = directResponse.headers.get("content-type") || "";
  const looksLikeMedia =
    contentType.startsWith("audio/") ||
    contentType.startsWith("video/") ||
    contentType.includes("octet-stream");

  if (directResponse.ok && looksLikeMedia) {
    const finalUrl = safeUrl(directResponse.url || sourceUrl.href);
    const declaredSize = Number(directResponse.headers.get("content-length") || "0");
    const contentRange = directResponse.headers.get("content-range") || "";
    const totalFromRange = Number(contentRange.split("/").pop() || "0");
    if (declaredSize > MAX_AUDIO_BYTES || totalFromRange > MAX_AUDIO_BYTES) {
      throw new Error("Audio is too large (24 MB maximum).");
    }
    const data = await directResponse.arrayBuffer();
    if (data.byteLength > MAX_AUDIO_BYTES) {
      throw new Error("Audio is too large (24 MB maximum).");
    }
    return {
      data,
      contentType: contentType.split(";")[0] || "audio/mpeg",
      filename: finalUrl.pathname.split("/").pop() || "audio.mp3",
    };
  }

  const localDownloaderUrl = process.env.LOCAL_DOWNLOADER_URL?.trim();
  if (localDownloaderUrl) {
    const endpoint = new URL(localDownloaderUrl);
    if (
      endpoint.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(endpoint.hostname)
    ) {
      throw new Error("Local downloader must use localhost.");
    }
    const localResponse = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/octet-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: sourceUrl.href, cookieBrowser }),
    }, 210_000);
    if (!localResponse.ok) {
      const payload = (await localResponse.json().catch(() => null)) as { error?: string } | null;
      throw new Error(`Local downloader failed: ${payload?.error || localResponse.status}`);
    }
    const declaredSize = Number(localResponse.headers.get("content-length") || "0");
    if (declaredSize > MAX_AUDIO_BYTES) {
      throw new Error("Audio is too large (24 MB maximum).");
    }
    const data = await localResponse.arrayBuffer();
    if (data.byteLength > MAX_AUDIO_BYTES) {
      throw new Error("Audio is too large (24 MB maximum).");
    }
    return {
      data,
      contentType: (localResponse.headers.get("content-type") || "audio/webm").split(";")[0],
      filename: decodeURIComponent(
        localResponse.headers.get("x-media-filename") || "downloaded-audio.webm",
      ),
    };
  }

  const downloaderUrl = process.env.COBALT_API_URL?.trim();
  if (!downloaderUrl) {
    throw new Error("Downloader service is not configured.");
  }

  const endpoint = safeUrl(downloaderUrl);
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const token = process.env.COBALT_API_KEY?.trim();
  if (token) {
    headers.Authorization = `${process.env.COBALT_AUTH_SCHEME || "Api-Key"} ${token}`;
  }

  const downloadResponse = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      url: sourceUrl.href,
      downloadMode: "audio",
      audioFormat: "mp3",
      audioBitrate: "64",
      filenameStyle: "basic",
      localProcessing: "disabled",
      alwaysProxy: true,
    }),
  }, 60_000);
  const downloadPayload = (await downloadResponse.json()) as DownloaderResponse;
  if (!downloadResponse.ok || !["tunnel", "redirect"].includes(downloadPayload.status || "") || !downloadPayload.url) {
    throw new Error(
      `Downloader failed: ${downloadPayload.error?.code || downloadPayload.text || downloadResponse.status}`,
    );
  }

  const mediaUrl = safeUrl(downloadPayload.url);
  const mediaResponse = await fetchWithTimeout(
    mediaUrl,
    { redirect: "follow" },
    90_000,
  );
  if (!mediaResponse.ok) {
    throw new Error(`Downloader media fetch failed: ${mediaResponse.status}`);
  }
  safeUrl(mediaResponse.url || mediaUrl.href);
  const declaredSize = Number(mediaResponse.headers.get("content-length") || "0");
  if (declaredSize > MAX_AUDIO_BYTES) {
    throw new Error("Audio is too large (24 MB maximum).");
  }
  const data = await mediaResponse.arrayBuffer();
  if (data.byteLength > MAX_AUDIO_BYTES) {
    throw new Error("Audio is too large (24 MB maximum).");
  }
  return {
    data,
    contentType: (mediaResponse.headers.get("content-type") || "audio/mpeg").split(";")[0],
    filename: downloadPayload.filename || "audio.mp3",
  };
}

async function transcribeAudio(
  media: Awaited<ReturnType<typeof resolveMedia>>,
  language: string,
  apiKey: string,
) {
  const form = new FormData();
  form.append("file", new File([media.data], media.filename, { type: media.contentType }));
  form.append("model", process.env.TRANSCRIBE_MODEL || "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  if (language && language !== "auto") {
    form.append("language", language);
  }

  const response = await fetchWithTimeout("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  }, 300_000);
  const payload = (await response.json()) as WhisperResponse;
  if (!response.ok || !payload.text) {
    throw new Error(payload.error?.message || `Transcription failed: ${response.status}`);
  }

  return {
    text: payload.text,
    segments: (payload.segments || [])
      .filter((item) => item.text?.trim())
      .map((item) => ({
        start: Number(item.start || 0),
        end: Number(item.end || item.start || 0),
        text: item.text!.trim(),
      })),
  };
}

async function transcribeAudioLocally(
  media: Awaited<ReturnType<typeof resolveMedia>>,
  language: string,
) {
  const localTranscriberUrl =
    process.env.LOCAL_TRANSCRIBER_URL?.trim() || "http://127.0.0.1:4318/transcribe";
  const endpoint = new URL(localTranscriberUrl);
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(endpoint.hostname)
  ) {
    throw new Error("Local Whisper service must use localhost.");
  }
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": media.contentType,
      "Content-Length": String(media.data.byteLength),
      "X-Media-Filename": encodeURIComponent(media.filename),
      "X-Whisper-Language": language || "auto",
    },
    body: media.data,
  }, 300_000);
  const payload = (await response.json()) as WhisperResponse;
  if (!response.ok || !payload.text) {
    throw new Error(
      `Local Whisper failed: ${payload.error?.message || (payload as { error?: string }).error || response.status}`,
    );
  }
  return {
    text: payload.text,
    segments: (payload.segments || [])
      .filter((item) => item.text?.trim())
      .map((item) => ({
        start: Number(item.start || 0),
        end: Number(item.end || item.start || 0),
        text: item.text!.trim(),
      })),
  };
}

function extractResponseText(payload: Record<string, unknown>) {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray((item as { content?: unknown[] }).content)
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

function extractChatCompletionText(payload: Record<string, unknown>) {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  return typeof first?.message?.content === "string" ? first.message.content : "";
}

function parseJsonResult(text: string) {
  const normalized = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const value = JSON.parse(normalized) as Record<string, unknown>;
  const scores = value.scores as Record<string, unknown> | undefined;
  const requiredStrings = ["title", "oneLine", "summary", "audience", "contentType"];
  const requiredArrays = ["structure", "highlights", "reusableLines", "improvements", "tags"];
  const scoreKeys = ["hook", "clarity", "emotion", "conversion"];
  const valid =
    requiredStrings.every(
      (key) => typeof value[key] === "string" && Boolean(String(value[key]).trim()),
    ) &&
    requiredArrays.every((key) => Array.isArray(value[key]) && value[key].length > 0) &&
    scores &&
    scoreKeys.every((key) => Number.isFinite(Number(scores[key])));

  if (!valid) {
    throw new Error("内容拆解结果字段不完整，请重试。");
  }
  return value;
}

function analysisPrompts(transcript: string, focus: string) {
  const focusMap: Record<string, string> = {
    growth: "重点评估开场留人、节奏、完播与互动转化。",
    sales: "重点评估痛点、价值证明、信任建立与行动号召。",
    knowledge: "重点评估知识密度、解释清晰度、案例与记忆点。",
    general: "均衡评估主题、结构、表达、情绪与行动建议。",
  };

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      oneLine: { type: "string" },
      summary: { type: "string" },
      audience: { type: "string" },
      contentType: { type: "string" },
      scores: {
        type: "object",
        additionalProperties: false,
        properties: {
          hook: { type: "integer", minimum: 0, maximum: 100 },
          clarity: { type: "integer", minimum: 0, maximum: 100 },
          emotion: { type: "integer", minimum: 0, maximum: 100 },
          conversion: { type: "integer", minimum: 0, maximum: 100 },
        },
        required: ["hook", "clarity", "emotion", "conversion"],
      },
      structure: {
        type: "array",
        minItems: 3,
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string" },
            detail: { type: "string" },
            time: { type: "string" },
          },
          required: ["label", "detail", "time"],
        },
      },
      highlights: {
        type: "array",
        minItems: 2,
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            quote: { type: "string" },
            why: { type: "string" },
          },
          required: ["quote", "why"],
        },
      },
      reusableLines: {
        type: "array",
        minItems: 3,
        maxItems: 6,
        items: { type: "string" },
      },
      improvements: {
        type: "array",
        minItems: 3,
        maxItems: 5,
        items: { type: "string" },
      },
      tags: {
        type: "array",
        minItems: 3,
        maxItems: 6,
        items: { type: "string" },
      },
    },
    required: [
      "title",
      "oneLine",
      "summary",
      "audience",
      "contentType",
      "scores",
      "structure",
      "highlights",
      "reusableLines",
      "improvements",
      "tags",
    ],
  };

  const systemPrompt =
    "你是一位资深中文内容策略师。只基于字幕判断，不虚构视频画面、数据或作者身份。输出必须具体、克制、可执行。引用高光表达时尽量保留字幕原话；结构时间点若无法确定，使用“开场/前段/中段/结尾”。";
  const userPrompt = `请拆解下面的视频字幕。${focusMap[focus] || focusMap.general}

请只返回一个合法 JSON 对象，不要使用 Markdown 代码块，也不要添加解释。JSON 必须包含：
- title、oneLine、summary、audience、contentType：字符串
- scores：包含 hook、clarity、emotion、conversion 四个 0-100 的整数
- structure：3-8 项，每项包含 label、detail、time
- highlights：2-5 项，每项包含 quote、why
- reusableLines：3-6 个字符串
- improvements：3-5 个字符串
- tags：3-6 个字符串

字幕：
${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}`;

  return { schema, systemPrompt, userPrompt };
}

async function analyzeTranscriptWithOpenAI(transcript: string, focus: string, apiKey: string) {
  const { schema, systemPrompt, userPrompt } = analysisPrompts(transcript, focus);
  const response = await fetchWithTimeout("https://api.openai.com/v1/responses", {
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
          name: "video_content_analysis",
          strict: true,
          schema,
        },
      },
      input: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
    }),
  }, 150_000);
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const apiError = payload.error as { message?: string } | undefined;
    throw new Error(apiError?.message || `Analysis failed: ${response.status}`);
  }
  const text = extractResponseText(payload);
  if (!text) throw new Error("Analysis returned an empty result.");
  return parseJsonResult(text);
}

async function analyzeTranscriptWithDeepSeek(transcript: string, focus: string, apiKey: string) {
  const { systemPrompt, userPrompt } = analysisPrompts(transcript, focus);
  const baseUrl = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
  const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
      thinking: { type: "disabled" },
      temperature: 0.2,
      max_tokens: 3_000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  }, 150_000);
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const apiError = payload.error as { message?: string } | undefined;
    throw new Error(`DeepSeek analysis failed: ${apiError?.message || response.status}`);
  }
  const text = extractChatCompletionText(payload);
  if (!text) throw new Error("DeepSeek analysis returned an empty result.");
  return parseJsonResult(text);
}

export async function POST(request: Request) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: "请求来源无效。" }, { status: 403 });
    }
    const contentLength = Number(request.headers.get("content-length") || "0");
    if (contentLength > 300_000) {
      return NextResponse.json({ error: "提交内容过长，请精简后重试。" }, { status: 413 });
    }
    const body = (await request.json()) as {
      url?: string;
      transcriptText?: string;
      transcriptSegments?: Array<{
        start?: number;
        end?: number;
        text?: string;
      }>;
      language?: string;
      focus?: string;
      apiKey?: string;
      openaiApiKey?: string;
      deepseekApiKey?: string;
      analysisProvider?: AnalysisProvider;
      transcriptionProvider?: TranscriptionProvider;
      cookieBrowser?: string;
    };
    const analysisProvider: AnalysisProvider =
      body.analysisProvider === "openai" ? "openai" : "deepseek";
    const transcriptionProvider: TranscriptionProvider =
      body.transcriptionProvider === "openai" ? "openai" : "local";
    const openaiApiKey =
      body.openaiApiKey?.trim() || body.apiKey?.trim() || process.env.OPENAI_API_KEY?.trim();
    const userDeepseekApiKey = body.deepseekApiKey?.trim();
    const hostedDeepseekApiKey = process.env.DEEPSEEK_API_KEY?.trim();
    const deepseekApiKey = userDeepseekApiKey || hostedDeepseekApiKey;
    const usingHostedDeepseek =
      analysisProvider === "deepseek" && !userDeepseekApiKey && Boolean(hostedDeepseekApiKey);
    const providedTranscript = body.transcriptText?.trim().slice(0, MAX_TRANSCRIPT_CHARS) || "";
    const providedSegments = Array.isArray(body.transcriptSegments)
      ? body.transcriptSegments
          .slice(0, 4_000)
          .filter(
            (item) =>
              Number.isFinite(item?.start) &&
              Number.isFinite(item?.end) &&
              typeof item?.text === "string" &&
              Boolean(item.text.trim()),
          )
          .map((item) => ({
            start: Math.max(0, Number(item.start)),
            end: Math.max(Number(item.start), Number(item.end)),
            text: item.text!.trim().slice(0, 2_000),
          }))
      : [];

    const needsOpenAIKey =
      analysisProvider === "openai" ||
      (!providedTranscript && transcriptionProvider === "openai");
    if (needsOpenAIKey && !openaiApiKey) {
      return NextResponse.json(
        { error: "当前选择需要 OpenAI API Key。请展开“服务配置”填写，或改用“粘贴字幕 + DeepSeek”。" },
        { status: 503 },
      );
    }
    if (needsOpenAIKey && openaiApiKey!.length < 20) {
      return NextResponse.json({ error: "OpenAI API Key 格式不正确，请检查后重试。" }, { status: 400 });
    }
    if (analysisProvider === "deepseek" && !deepseekApiKey) {
      return NextResponse.json(
        { error: "已选择 DeepSeek 拆解，请在“服务配置”中填写 DeepSeek API Key。" },
        { status: 503 },
      );
    }
    if (analysisProvider === "deepseek" && deepseekApiKey!.length < 20) {
      return NextResponse.json({ error: "DeepSeek API Key 格式不正确，请检查后重试。" }, { status: 400 });
    }
    if (usingHostedDeepseek) {
      const allowance = await consumePublicAllowance(request, "analyze");
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
    if (!providedTranscript && (!body.url || body.url.length > 2048)) {
      return NextResponse.json({ error: "请提供有效的视频链接。" }, { status: 400 });
    }
    if (body.transcriptText !== undefined && providedTranscript.length < 20) {
      return NextResponse.json({ error: "请至少提供 20 个字的字幕内容。" }, { status: 400 });
    }

    const cookieBrowser = ["edge", "chrome", "fresh-edge"].includes(body.cookieBrowser || "")
      ? body.cookieBrowser!
      : "";
    const media = providedTranscript
      ? null
      : await resolveMedia(safeUrl(body.url!), cookieBrowser);
    const transcription = providedTranscript
      ? { text: providedTranscript, segments: providedSegments }
      : transcriptionProvider === "local"
        ? await transcribeAudioLocally(media!, body.language || "auto")
        : await transcribeAudio(media!, body.language || "auto", openaiApiKey!);
    const analysis =
      analysisProvider === "deepseek"
        ? await analyzeTranscriptWithDeepSeek(
            usingHostedDeepseek
              ? transcription.text.slice(0, 40_000)
              : transcription.text,
            body.focus || "growth",
            deepseekApiKey!,
          )
        : await analyzeTranscriptWithOpenAI(
            transcription.text,
            body.focus || "growth",
            openaiApiKey!,
          );

    return NextResponse.json({
      source: { filename: media?.filename || "粘贴的字幕" },
      transcript: transcription.text,
      segments: transcription.segments,
      analysis,
      processing: {
        transcriptionProvider,
        transcription:
          providedTranscript
            ? "provided-transcript"
            : transcriptionProvider === "local"
            ? process.env.LOCAL_WHISPER_MODEL || "base"
            : process.env.TRANSCRIBE_MODEL || "whisper-1",
        analysisProvider,
        analysisModel:
          analysisProvider === "deepseek"
            ? process.env.DEEPSEEK_MODEL || "deepseek-v4-flash"
            : process.env.ANALYSIS_MODEL || "gpt-5.6-terra",
      },
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Unknown error";
    console.error("Video analysis failed:", message);
    return NextResponse.json({ error: friendlyError(message) }, { status: 500 });
  }
}
