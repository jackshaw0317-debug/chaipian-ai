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

type GroqResponse = {
  text?: string;
  segments?: Array<{
    start?: number;
    end?: number;
    text?: string;
  }>;
  error?: { message?: string };
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

function friendlyError(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes("401") || lower.includes("api key") || lower.includes("authentication")) {
    return "Groq API Key 无效，请检查后重试。";
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return "Groq 免费额度当前已达到限制，请稍后再试。";
  }
  if (lower.includes("timeout") || lower.includes("abort")) {
    return "云端转写等待时间过长，请稍后重试或上传更短的文件。";
  }
  return "Groq 云端转写失败，请稍后重试。";
}

export async function POST(request: Request) {
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
    const userGroqApiKey = String(form.get("groqApiKey") || "").trim();
    const hostedGroqApiKey = process.env.GROQ_API_KEY?.trim();
    const groqApiKey = userGroqApiKey || hostedGroqApiKey;
    const usingHostedGroq = !userGroqApiKey && Boolean(hostedGroqApiKey);
    const language = String(form.get("language") || "auto").slice(0, 10);

    if (!(file instanceof File) || !file.size) {
      return NextResponse.json({ error: "请选择需要转写的音视频文件。" }, { status: 400 });
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
    if (!groqApiKey || groqApiKey.length < 20) {
      return NextResponse.json(
        { error: "Groq 免费转写尚未启用，请填写有效的 Groq API Key。" },
        { status: 503 },
      );
    }
    if (usingHostedGroq) {
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

    const groqForm = new FormData();
    groqForm.append("file", file, file.name || "uploaded-media.webm");
    groqForm.append(
      "model",
      process.env.GROQ_TRANSCRIBE_MODEL || "whisper-large-v3-turbo",
    );
    groqForm.append("response_format", "verbose_json");
    groqForm.append("timestamp_granularities[]", "segment");
    if (language && language !== "auto") {
      groqForm.append("language", language);
    }

    const response = await fetchWithTimeout(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${groqApiKey}` },
        body: groqForm,
      },
      180_000,
    );
    const payload = (await response.json()) as GroqResponse;
    if (!response.ok || !payload.text?.trim()) {
      throw new Error(payload.error?.message || `Groq transcription failed: ${response.status}`);
    }

    return NextResponse.json({
      text: payload.text.trim(),
      segments: (payload.segments || [])
        .filter((item) => item.text?.trim())
        .map((item) => ({
          start: Number(item.start || 0),
          end: Number(item.end || item.start || 0),
          text: item.text!.trim(),
        })),
      filename: file.name || "上传的音视频",
      model: process.env.GROQ_TRANSCRIBE_MODEL || "whisper-large-v3-turbo",
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "unknown error";
    console.error("Groq transcription failed:", message);
    return NextResponse.json({ error: friendlyError(message) }, { status: 500 });
  }
}
