import { NextResponse } from "next/server";

export const runtime = "edge";

const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 120_000;

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

function friendlyError(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes("api key") || lower.includes("unauthorized") || lower.includes("401")) {
    return "OpenAI 密钥无效或尚未配置，请检查服务端环境变量。";
  }
  if (lower.includes("too large") || lower.includes("maximum") || lower.includes("24 mb")) {
    return "音频超过 24 MB。请改用更短的视频，或在下载服务中降低音频码率。";
  }
  if (lower.includes("downloader") || lower.includes("cobalt")) {
    return "这个链接需要配置视频下载服务。请设置 COBALT_API_URL，或改用可直接访问的音视频链接。";
  }
  return message || "处理失败，请稍后重试。";
}

async function resolveMedia(sourceUrl: URL) {
  const directResponse = await fetch(sourceUrl, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent": "ChaipianAI/1.0",
      Range: `bytes=0-${MAX_AUDIO_BYTES}`,
    },
  });

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

  const downloadResponse = await fetch(endpoint, {
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
  });
  const downloadPayload = (await downloadResponse.json()) as DownloaderResponse;
  if (!downloadResponse.ok || !["tunnel", "redirect"].includes(downloadPayload.status || "") || !downloadPayload.url) {
    throw new Error(
      `Downloader failed: ${downloadPayload.error?.code || downloadPayload.text || downloadResponse.status}`,
    );
  }

  const mediaUrl = safeUrl(downloadPayload.url);
  const mediaResponse = await fetch(mediaUrl, { redirect: "follow" });
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

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
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

async function analyzeTranscript(transcript: string, focus: string, apiKey: string) {
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

  const response = await fetch("https://api.openai.com/v1/responses", {
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
          content:
            "你是一位资深中文内容策略师。只基于字幕判断，不虚构视频画面、数据或作者身份。输出必须具体、克制、可执行。引用高光表达时尽量保留字幕原话；结构时间点若无法确定，使用“开场/前段/中段/结尾”。",
        },
        {
          role: "user",
          content: `请拆解下面的视频字幕。${focusMap[focus] || focusMap.general}\n\n字幕：\n${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}`,
        },
      ],
    }),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const apiError = payload.error as { message?: string } | undefined;
    throw new Error(apiError?.message || `Analysis failed: ${response.status}`);
  }
  const text = extractResponseText(payload);
  if (!text) throw new Error("Analysis returned an empty result.");
  return JSON.parse(text) as Record<string, unknown>;
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      return NextResponse.json(
        { error: "尚未配置 OPENAI_API_KEY。你可以先点击“体验示例”查看完整效果。" },
        { status: 503 },
      );
    }

    const body = (await request.json()) as {
      url?: string;
      language?: string;
      focus?: string;
    };
    if (!body.url || body.url.length > 2048) {
      return NextResponse.json({ error: "请提供有效的视频链接。" }, { status: 400 });
    }

    const sourceUrl = safeUrl(body.url);
    const media = await resolveMedia(sourceUrl);
    const transcription = await transcribeAudio(media, body.language || "auto", apiKey);
    const analysis = await analyzeTranscript(transcription.text, body.focus || "growth", apiKey);

    return NextResponse.json({
      source: { filename: media.filename },
      transcript: transcription.text,
      segments: transcription.segments,
      analysis,
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Unknown error";
    console.error("Video analysis failed:", message);
    return NextResponse.json({ error: friendlyError(message) }, { status: 500 });
  }
}
