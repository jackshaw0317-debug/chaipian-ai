import { NextResponse } from "next/server";
import {
  consumePublicAllowance,
  isSameOriginRequest,
} from "../../lib/public-ai-access";

export const runtime = "edge";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "audio/flac",
  "audio/m4a",
  "audio/mp3",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "video/mp4",
  "video/mpeg",
  "video/webm",
  "application/octet-stream",
]);

type CloudProvider = "siliconflow" | "groq";

type TranscriptionResponse = {
  text?: string;
  segments?: Array<{
    start?: number;
    end?: number;
    text?: string;
  }>;
  error?: { message?: string } | string;
  message?: string;
};

type NormalizedTranscription = {
  text: string;
  segments: Array<{ start: number; end: number; text: string }>;
  model: string;
  provider: CloudProvider;
};

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function providerLabel(provider: CloudProvider) {
  return provider === "siliconflow" ? "硅基流动 ASR" : "Groq Whisper";
}

function payloadError(payload: TranscriptionResponse) {
  if (typeof payload.error === "string") return payload.error;
  return payload.error?.message || payload.message || "";
}

function friendlyError(message: string, provider: CloudProvider) {
  const lower = message.toLowerCase();
  const label = providerLabel(provider);
  if (
    lower.includes("401") ||
    lower.includes("api key") ||
    lower.includes("authentication") ||
    lower.includes("unauthorized")
  ) {
    return `${label} API Key 无效，请检查后重试。`;
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return `${label} 当前请求较多或免费额度受限，请稍后再试。`;
  }
  if (lower.includes("timeout") || lower.includes("abort")) {
    return `${label} 等待时间过长，请稍后重试或上传更短的文件。`;
  }
  return `${label} 转写失败，请稍后重试。`;
}

function normalizeSegments(payload: TranscriptionResponse) {
  return (payload.segments || [])
    .filter((item) => item.text?.trim())
    .map((item) => ({
      start: Number(item.start || 0),
      end: Number(item.end || item.start || 0),
      text: item.text!.trim(),
    }));
}

async function transcribeWithSiliconFlow(file: File, apiKey: string) {
  const model =
    process.env.SILICONFLOW_ASR_MODEL || "FunAudioLLM/SenseVoiceSmall";
  const form = new FormData();
  form.append("file", file, file.name || "uploaded-media.webm");
  form.append("model", model);

  const response = await fetchWithTimeout(
    "https://api.siliconflow.cn/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    },
    180_000,
  );
  const payload = (await response.json()) as TranscriptionResponse;
  if (!response.ok || !payload.text?.trim()) {
    throw new Error(
      `SiliconFlow transcription failed: ${payloadError(payload) || response.status}`,
    );
  }
  return {
    text: payload.text.trim(),
    segments: [],
    model,
    provider: "siliconflow",
  } satisfies NormalizedTranscription;
}

async function transcribeWithGroq(
  file: File,
  language: string,
  apiKey: string,
) {
  const model =
    process.env.GROQ_TRANSCRIBE_MODEL || "whisper-large-v3-turbo";
  const form = new FormData();
  form.append("file", file, file.name || "uploaded-media.webm");
  form.append("model", model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  if (language && language !== "auto") {
    form.append("language", language);
  }

  const response = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    },
    180_000,
  );
  const payload = (await response.json()) as TranscriptionResponse;
  if (!response.ok || !payload.text?.trim()) {
    throw new Error(
      `Groq transcription failed: ${payloadError(payload) || response.status}`,
    );
  }
  return {
    text: payload.text.trim(),
    segments: normalizeSegments(payload),
    model,
    provider: "groq",
  } satisfies NormalizedTranscription;
}

export async function POST(request: Request) {
  let selectedProvider: CloudProvider = "siliconflow";
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: "请求来源无效。" }, { status: 403 });
    }
    const contentLength = Number(request.headers.get("content-length") || "0");
    if (contentLength > MAX_FILE_BYTES + 200_000) {
      return NextResponse.json(
        { error: "文件超过 25 MB，请压缩或截取后重试。" },
        { status: 413 },
      );
    }

    const form = await request.formData();
    const file = form.get("file");
    selectedProvider =
      String(form.get("provider") || "") === "groq" ? "groq" : "siliconflow";
    const language = String(form.get("language") || "auto").slice(0, 10);
    const userSiliconFlowApiKey = String(
      form.get("siliconflowApiKey") || "",
    ).trim();
    const hostedSiliconFlowApiKey =
      process.env.SILICONFLOW_API_KEY?.trim() || "";
    const siliconflowApiKey =
      userSiliconFlowApiKey || hostedSiliconFlowApiKey;
    const userGroqApiKey = String(form.get("groqApiKey") || "").trim();
    const hostedGroqApiKey = process.env.GROQ_API_KEY?.trim() || "";
    const groqApiKey = userGroqApiKey || hostedGroqApiKey;
    const usingHostedProvider =
      (selectedProvider === "siliconflow" &&
        !userSiliconFlowApiKey &&
        Boolean(hostedSiliconFlowApiKey)) ||
      (selectedProvider === "groq" &&
        !userGroqApiKey &&
        Boolean(hostedGroqApiKey));

    if (!(file instanceof File) || !file.size) {
      return NextResponse.json(
        { error: "请选择需要转写的音视频文件。" },
        { status: 400 },
      );
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: "文件超过 25 MB，请压缩或截取后重试。" },
        { status: 413 },
      );
    }
    if (
      file.type &&
      !ALLOWED_TYPES.has(file.type) &&
      !file.type.startsWith("audio/") &&
      !file.type.startsWith("video/")
    ) {
      return NextResponse.json(
        { error: "文件格式不受支持，请上传常见音频或 MP4/WebM 视频。" },
        { status: 415 },
      );
    }

    const selectedKey =
      selectedProvider === "siliconflow" ? siliconflowApiKey : groqApiKey;
    if (!selectedKey || selectedKey.length < 20) {
      return NextResponse.json(
        {
          error: `${providerLabel(selectedProvider)} 免费转写尚未启用，请填写有效的 API Key。`,
        },
        { status: 503 },
      );
    }
    if (usingHostedProvider) {
      const allowance = await consumePublicAllowance(request, "transcribe");
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

    let transcription: NormalizedTranscription;
    let fallbackFrom: CloudProvider | undefined;
    if (selectedProvider === "siliconflow") {
      try {
        transcription = await transcribeWithSiliconFlow(
          file,
          siliconflowApiKey,
        );
      } catch (error) {
        const canUseHostedFallback =
          !userSiliconFlowApiKey && Boolean(hostedGroqApiKey);
        if (!canUseHostedFallback) throw error;
        fallbackFrom = "siliconflow";
        transcription = await transcribeWithGroq(
          file,
          language,
          hostedGroqApiKey,
        );
      }
    } else {
      transcription = await transcribeWithGroq(file, language, groqApiKey);
    }

    return NextResponse.json({
      text: transcription.text,
      segments: transcription.segments,
      filename: file.name || "上传的音视频",
      model: transcription.model,
      provider: transcription.provider,
      fallbackFrom,
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "unknown error";
    console.error("Cloud transcription failed:", message);
    return NextResponse.json(
      { error: friendlyError(message, selectedProvider) },
      { status: 500 },
    );
  }
}
