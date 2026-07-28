"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Stage = "idle" | "download" | "transcribe" | "analyze" | "done" | "error";

type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

type AnalysisResult = {
  source?: {
    title?: string;
    filename?: string;
  };
  transcript: string;
  segments: TranscriptSegment[];
  analysis: {
    title: string;
    oneLine: string;
    summary: string;
    audience: string;
    contentType: string;
    scores: {
      hook: number;
      clarity: number;
      emotion: number;
      conversion: number;
    };
    structure: Array<{
      label: string;
      detail: string;
      time: string;
    }>;
    highlights: Array<{
      quote: string;
      why: string;
    }>;
    reusableLines: string[];
    improvements: string[];
    tags: string[];
  };
};

type LocalHealth = {
  ok: boolean;
  services: {
    downloader: boolean;
    whisper: boolean;
  };
  checkedAt: string;
};

type SiteCapabilities = {
  deepseek: {
    publicTrial: boolean;
    dailyAnalyzeLimit: number;
    dailyRewriteLimit: number;
  };
  groq: {
    publicTrial: boolean;
    dailyTranscribeLimit: number;
    maxFileBytes: number;
  };
};

type LocalMedia = {
  data: ArrayBuffer;
  contentType: string;
  filename: string;
};

type LocalTranscription = {
  text: string;
  segments: TranscriptSegment[];
};

type LoopbackRequestInit = RequestInit & {
  targetAddressSpace?: "loopback";
};

const LOCAL_DOWNLOADER_URL = "http://127.0.0.1:4317";
const LOCAL_TRANSCRIBER_URL = "http://127.0.0.1:4318";

function fetchLoopback(input: string, init: RequestInit = {}) {
  return fetch(input, {
    ...init,
    mode: "cors",
    cache: "no-store",
    targetAddressSpace: "loopback",
    headers: {
      "X-Chaipian-Client": "web",
      ...init.headers,
    },
  } as LoopbackRequestInit);
}

async function checkLocalServices(): Promise<LocalHealth> {
  async function check(url: string) {
    try {
      const response = await fetchLoopback(url);
      return response.ok;
    } catch {
      return false;
    }
  }

  const [downloader, whisper] = await Promise.all([
    check(`${LOCAL_DOWNLOADER_URL}/health`),
    check(`${LOCAL_TRANSCRIBER_URL}/health`),
  ]);
  return {
    ok: downloader && whisper,
    services: { downloader, whisper },
    checkedAt: new Date().toISOString(),
  };
}

async function downloadVideoLocally(
  sourceUrl: string,
  cookieBrowser: string,
  signal: AbortSignal,
): Promise<LocalMedia> {
  const response = await fetchLoopback(`${LOCAL_DOWNLOADER_URL}/download`, {
    method: "POST",
    signal,
    headers: {
      Accept: "application/octet-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: sourceUrl,
      cookieBrowser: cookieBrowser === "none" ? undefined : cookieBrowser,
    }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error || `本机视频下载失败（${response.status}）`);
  }
  const data = await response.arrayBuffer();
  if (!data.byteLength) throw new Error("本机下载服务没有返回音频内容。");
  return {
    data,
    contentType: (response.headers.get("content-type") || "audio/webm").split(";")[0],
    filename: decodeURIComponent(
      response.headers.get("x-media-filename") || "downloaded-audio.webm",
    ),
  };
}

async function transcribeMediaLocally(
  media: LocalMedia,
  language: string,
  signal: AbortSignal,
): Promise<LocalTranscription> {
  const response = await fetchLoopback(`${LOCAL_TRANSCRIBER_URL}/transcribe`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": media.contentType,
      "X-Media-Filename": encodeURIComponent(media.filename),
      "X-Whisper-Language": language || "auto",
    },
    body: media.data,
  });
  const payload = (await response.json().catch(() => null)) as
    | {
        text?: string;
        segments?: Array<{ start?: number; end?: number; text?: string }>;
        error?: string;
      }
    | null;
  if (!response.ok || !payload?.text) {
    throw new Error(payload?.error || `本机 Whisper 转写失败（${response.status}）`);
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

type RewriteFormat = "short-video" | "xiaohongshu" | "private-domain" | "advertising";

type RewriteResult = {
  title: string;
  hook: string;
  body: string;
  cta: string;
  strategy: Array<{
    source: string;
    adaptation: string;
  }>;
};

const rewriteFormatLabels: Record<RewriteFormat, string> = {
  "short-video": "短视频口播",
  xiaohongshu: "小红书图文",
  "private-domain": "朋友圈 / 私域",
  advertising: "广告推广文案",
};

const demoResult: AnalysisResult = {
  source: { title: "为什么你的视频没人看完？3 个留人动作" },
  transcript:
    "很多人以为视频没人看完，是内容不够好。其实真正的问题，往往出在前五秒。观众还没听懂你要讲什么，就已经划走了。第一个动作，先给结果，不要先讲背景。第二个动作，把抽象问题变成一个具体场景。第三个动作，每二十秒给观众一次新的信息增量。你不需要把视频剪得很碎，只需要让观众一直知道：接下来还有东西值得听。",
  segments: [
    { start: 0, end: 5.2, text: "很多人以为视频没人看完，是内容不够好。" },
    { start: 5.2, end: 11.8, text: "其实真正的问题，往往出在前五秒。观众还没听懂你要讲什么，就已经划走了。" },
    { start: 11.8, end: 18.6, text: "第一个动作，先给结果，不要先讲背景。" },
    { start: 18.6, end: 26.4, text: "第二个动作，把抽象问题变成一个具体场景。" },
    { start: 26.4, end: 36.8, text: "第三个动作，每二十秒给观众一次新的信息增量。" },
    { start: 36.8, end: 47.2, text: "你不需要把视频剪得很碎，只需要让观众一直知道：接下来还有东西值得听。" },
  ],
  analysis: {
    title: "用 3 个动作解决短视频掉线",
    oneLine: "以“反常识诊断 + 三步方法”快速解释完播率低的真正原因。",
    summary:
      "内容先推翻“没人看完是因为内容不好”的常见判断，再把问题锁定在前五秒的信息不清晰，随后给出结果前置、场景具体化、持续制造信息增量三个动作。整体结构紧凑，方法可执行，适合知识类短视频。",
    audience: "正在做知识口播、个人 IP 或品牌内容的创作者",
    contentType: "方法论 / 短视频增长",
    scores: { hook: 92, clarity: 88, emotion: 76, conversion: 81 },
    structure: [
      { label: "反常识开场", detail: "否定“内容不够好”的直觉答案，制造认知缺口。", time: "00:00" },
      { label: "锁定问题", detail: "把流失原因聚焦到前五秒没有讲清价值。", time: "00:05" },
      { label: "三步解法", detail: "结果前置、场景化、持续给出信息增量。", time: "00:12" },
      { label: "收束记忆点", detail: "不用碎剪，也能让观众持续期待下一句。", time: "00:37" },
    ],
    highlights: [
      {
        quote: "观众还没听懂你要讲什么，就已经划走了。",
        why: "把“完播率低”转译成一个人人都经历过的具体瞬间。",
      },
      {
        quote: "先给结果，不要先讲背景。",
        why: "短、准、有行动指令，适合单独做字幕重点或封面副标题。",
      },
    ],
    reusableLines: [
      "很多人以为___，其实真正的问题是___。",
      "你不需要___，只需要让用户一直知道___。",
      "第一个动作：先给结果，不要先讲背景。",
    ],
    improvements: [
      "开场可补一个具体流失数据或画面，让问题更有紧迫感。",
      "第二步可以增加一个错误示例与改写示例，降低理解成本。",
      "结尾加入明确的收藏理由或下一条内容预告，提升转化。",
    ],
    tags: ["短视频运营", "完播率", "知识口播", "内容结构"],
  },
};

const baseStages = [
  { key: "download", label: "读取视频", detail: "提取可转写的音频内容" },
  { key: "transcribe", label: "Whisper 转写", detail: "识别语音并生成时间轴" },
] as const;

const stageIndex: Record<Stage, number> = {
  idle: -1,
  download: 0,
  transcribe: 1,
  analyze: 2,
  done: 3,
  error: -1,
};

function formatTime(seconds: number) {
  const safe = Math.max(0, seconds || 0);
  const minutes = Math.floor(safe / 60);
  const rest = Math.floor(safe % 60);
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function toSrtTime(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function scoreTone(score: number) {
  if (score >= 88) return "excellent";
  if (score >= 78) return "good";
  return "steady";
}

async function writeClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

export default function Home() {
  const [sourceMode, setSourceMode] = useState<"url" | "upload" | "transcript">("url");
  const [url, setUrl] = useState("");
  const [transcriptInput, setTranscriptInput] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [deepseekApiKey, setDeepseekApiKey] = useState("");
  const [groqApiKey, setGroqApiKey] = useState("");
  const [analysisProvider, setAnalysisProvider] = useState<"deepseek" | "openai">("deepseek");
  const [transcriptionProvider, setTranscriptionProvider] = useState<"local" | "openai" | "groq">("local");
  const [cookieBrowser, setCookieBrowser] = useState<
    "fresh-edge" | "none" | "edge" | "chrome"
  >("fresh-edge");
  const [language, setLanguage] = useState("auto");
  const [focus, setFocus] = useState("growth");
  const [stage, setStage] = useState<Stage>("idle");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [activeTab, setActiveTab] = useState<"analysis" | "transcript">("analysis");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [transcriptCopied, setTranscriptCopied] = useState(false);
  const [copiedLine, setCopiedLine] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [health, setHealth] = useState<LocalHealth | null>(null);
  const [healthChecking, setHealthChecking] = useState(true);
  const [capabilities, setCapabilities] = useState<SiteCapabilities | null>(null);
  const [pageRuntime, setPageRuntime] = useState<"unknown" | "local" | "hosted">("unknown");
  const [localAccessRequested, setLocalAccessRequested] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [projectInfo, setProjectInfo] = useState("");
  const [rewriteDirection, setRewriteDirection] = useState("");
  const [rewriteFormat, setRewriteFormat] = useState<RewriteFormat>("short-video");
  const [rewriteStatus, setRewriteStatus] = useState<"idle" | "working" | "done" | "error">("idle");
  const [rewriteResult, setRewriteResult] = useState<RewriteResult | null>(null);
  const [rewriteError, setRewriteError] = useState("");
  const [rewriteCopied, setRewriteCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const cancelRequestedRef = useRef(false);

  const isWorking = ["download", "transcribe", "analyze"].includes(stage);
  const currentStage = stageIndex[stage];
  const analysisService = analysisProvider === "deepseek" ? "DeepSeek" : "OpenAI";
  const transcriptionService =
    sourceMode === "transcript"
      ? "直接使用字幕"
      : sourceMode === "upload"
        ? "Groq Whisper"
        : transcriptionProvider === "local"
          ? "本机 Whisper"
          : transcriptionProvider === "groq"
            ? "Groq Whisper"
            : "OpenAI Whisper";
  const needsOpenAIKey =
    analysisProvider === "openai" ||
    (sourceMode === "url" && transcriptionProvider === "openai");
  const publicDeepseekTrial = capabilities?.deepseek.publicTrial === true;
  const publicGroqTrial = capabilities?.groq.publicTrial === true;
  const usesGroq =
    sourceMode === "upload" ||
    (sourceMode === "url" && transcriptionProvider === "groq");
  const stages = [
    sourceMode === "transcript"
      ? { key: "download" as const, label: "读取字幕", detail: "使用你粘贴的字幕全文" }
      : sourceMode === "upload"
        ? { key: "download" as const, label: "读取文件", detail: "检查音视频格式与大小" }
        : baseStages[0],
    {
      key: "transcribe" as const,
      label: sourceMode === "transcript" ? "跳过语音转写" : `${transcriptionService} 转写`,
      detail:
        sourceMode === "transcript"
          ? "无需调用 Whisper"
          : sourceMode === "upload"
            ? "上传至 Groq 并生成时间轴"
            : "识别语音并生成时间轴",
    },
    {
      key: "analyze" as const,
      label: `${analysisService} 拆解`,
      detail: "提炼结构、亮点与改进方向",
    },
  ];
  const activeStageLabel =
    stages[Math.max(0, Math.min(currentStage, stages.length - 1))]?.label || "准备处理";
  const healthyServiceCount = health
    ? Number(health.services.downloader) + Number(health.services.whisper)
    : 0;
  const healthLabel = healthChecking
    ? "正在检查本机服务"
    : health?.ok
      ? "本机服务已就绪"
      : pageRuntime === "hosted" && !localAccessRequested
        ? "本机助手待连接"
      : sourceMode === "transcript" || (sourceMode === "upload" && publicGroqTrial)
        ? "在线字幕模式可用"
        : `本机服务 ${healthyServiceCount}/2`;

  const markdown = useMemo(() => {
    if (!result) return "";
    const a = result.analysis;
    return [
      `# ${a.title}`,
      "",
      `> ${a.oneLine}`,
      "",
      "## 内容摘要",
      a.summary,
      "",
      `- 目标受众：${a.audience}`,
      `- 内容类型：${a.contentType}`,
      "",
      "## 内容结构",
      ...a.structure.map((item) => `- ${item.time}｜${item.label}：${item.detail}`),
      "",
      "## 高光表达",
      ...a.highlights.map((item) => `- “${item.quote}”——${item.why}`),
      "",
      "## 可复用句式",
      ...a.reusableLines.map((line) => `- ${line}`),
      "",
      "## 优化建议",
      ...a.improvements.map((line) => `- ${line}`),
    ].join("\n");
  }, [result]);

  const rewriteMarkdown = useMemo(() => {
    if (!rewriteResult) return "";
    return [
      `# ${rewriteResult.title}`,
      "",
      "## 开场",
      rewriteResult.hook,
      "",
      "## 正文",
      rewriteResult.body,
      "",
      "## 行动引导",
      rewriteResult.cta,
      "",
      "## 借鉴策略",
      ...rewriteResult.strategy.map(
        (item) => `- ${item.source}：${item.adaptation}`,
      ),
    ].join("\n");
  }, [rewriteResult]);

  useEffect(() => {
    let active = true;
    const localPage = ["localhost", "127.0.0.1"].includes(window.location.hostname);
    window.setTimeout(() => {
      if (active) setPageRuntime(localPage ? "local" : "hosted");
    }, 0);

    async function refreshHealth() {
      if (!localPage) {
        if (active) {
          setHealth({
            ok: false,
            services: { downloader: false, whisper: false },
            checkedAt: new Date().toISOString(),
          });
          setHealthChecking(false);
        }
        return;
      }
      setHealthChecking(true);
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        const payload = (await response.json()) as LocalHealth;
        if (active) setHealth(payload);
      } catch {
        if (active) setHealth(null);
      } finally {
        if (active) setHealthChecking(false);
      }
    }

    async function refreshCapabilities() {
      try {
        const response = await fetch("/api/capabilities", { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as SiteCapabilities;
        if (active) {
          setCapabilities(payload);
          if (!localPage && payload.groq?.publicTrial) {
            setTranscriptionProvider("groq");
          }
        }
      } catch {
        if (active) setCapabilities(null);
      }
    }

    void refreshCapabilities();
    void refreshHealth();
    const timer = window.setInterval(refreshHealth, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
      abortRef.current?.abort();
    };
  }, []);

  async function connectLocalServices(showError = false) {
    setLocalAccessRequested(true);
    setHealthChecking(true);
    const nextHealth = await checkLocalServices();
    setHealth(nextHealth);
    setHealthChecking(false);
    if (showError && !nextHealth.ok) {
      setError(
        "没有连接到本机助手。请双击“启动拆片AI”，并在浏览器询问本地网络访问时选择“允许”，然后重试。",
      );
      setSettingsOpen(true);
    } else if (nextHealth.ok && error.includes("本机")) {
      setError("");
    }
    return nextHealth;
  }

  function focusSetting(id: "deepseek-key" | "openai-key" | "groq-key") {
    setSettingsOpen(true);
    window.requestAnimationFrame(() => {
      document.getElementById(id)?.focus();
    });
  }

  async function startAnalysis() {
    if (sourceMode === "url") {
      if (!url.trim()) {
        setError("请先粘贴一个视频链接，或点击“体验示例”。");
        return;
      }

      try {
        const parsed = new URL(url.trim());
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
      } catch {
        setError("请输入完整的 http 或 https 视频链接。");
        return;
      }
    } else if (sourceMode === "upload") {
      if (!uploadFile) {
        setError("请选择一个需要转写的音频或视频文件。");
        return;
      }
      if (uploadFile.size > 25 * 1024 * 1024) {
        setError("文件超过 25 MB，请压缩、截取或改用更短的内容。");
        return;
      }
    } else if (transcriptInput.trim().length < 20) {
      setError("请至少粘贴 20 个字的字幕内容。");
      return;
    }

    if (
      analysisProvider === "deepseek" &&
      !publicDeepseekTrial &&
      deepseekApiKey.trim().length < 20
    ) {
      setError("请先在“服务配置”中填写有效的 DeepSeek API Key。");
      focusSetting("deepseek-key");
      return;
    }

    if (needsOpenAIKey && openaiApiKey.trim().length < 20) {
      setError("当前选择需要 OpenAI API Key，请先在“服务配置”中填写。");
      focusSetting("openai-key");
      return;
    }
    if (usesGroq && !publicGroqTrial && groqApiKey.trim().length < 20) {
      setError("Groq 免费转写尚未启用，请先在“服务配置”中填写 Groq API Key。");
      focusSetting("groq-key");
      return;
    }

    const useLocalPipeline =
      sourceMode === "url" && transcriptionProvider === "local";
    if (useLocalPipeline) {
      const nextHealth = await connectLocalServices(true);
      if (!nextHealth.ok) return;
    }

    setError("");
    setResult(null);
    setRewriteResult(null);
    setRewriteError("");
    setRewriteStatus("idle");
    setStage(sourceMode === "transcript" ? "analyze" : "download");
    setActiveTab("analysis");
    setElapsedSeconds(0);
    cancelRequestedRef.current = false;

    const controller = new AbortController();
    abortRef.current = controller;
    const startedAt = Date.now();
    const elapsedTimer = window.setInterval(() => {
      setElapsedSeconds(Math.max(1, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1_000);

    const progressTimer =
      sourceMode === "url" && !useLocalPipeline
        ? window.setTimeout(() => setStage("transcribe"), 18_000)
        : undefined;
    const analyzeTimer =
      sourceMode === "url" && !useLocalPipeline
        ? window.setTimeout(() => setStage("analyze"), 55_000)
        : undefined;

    try {
      let localFilename = "";
      let localTranscription: LocalTranscription | null = null;
      if (useLocalPipeline) {
        setStage("download");
        const media = await downloadVideoLocally(
          url.trim(),
          cookieBrowser,
          controller.signal,
        );
        localFilename = media.filename;
        setStage("transcribe");
        localTranscription = await transcribeMediaLocally(
          media,
          language,
          controller.signal,
        );
        setStage("analyze");
      } else if (sourceMode === "upload" && uploadFile) {
        setStage("transcribe");
        const uploadForm = new FormData();
        uploadForm.append("file", uploadFile, uploadFile.name);
        uploadForm.append("language", language);
        if (groqApiKey.trim()) uploadForm.append("groqApiKey", groqApiKey.trim());
        const uploadResponse = await fetch("/api/transcribe", {
          method: "POST",
          signal: controller.signal,
          body: uploadForm,
        });
        const uploadPayload = (await uploadResponse.json().catch(() => null)) as
          | (LocalTranscription & { filename?: string; error?: string })
          | null;
        if (!uploadResponse.ok || !uploadPayload?.text) {
          throw new Error(uploadPayload?.error || "云端转写失败，请稍后重试。");
        }
        localFilename = uploadPayload.filename || uploadFile.name;
        localTranscription = {
          text: uploadPayload.text,
          segments: uploadPayload.segments || [],
        };
        setStage("analyze");
      }

      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          url: url.trim(),
          transcriptText:
            sourceMode === "transcript"
              ? transcriptInput.trim()
              : localTranscription?.text,
          transcriptSegments: localTranscription?.segments,
          language,
          focus,
          analysisProvider,
          transcriptionProvider: sourceMode === "upload" ? "groq" : transcriptionProvider,
          cookieBrowser: cookieBrowser === "none" ? undefined : cookieBrowser,
          openaiApiKey: openaiApiKey.trim() || undefined,
          deepseekApiKey: deepseekApiKey.trim() || undefined,
          groqApiKey: groqApiKey.trim() || undefined,
        }),
      });
      const rawPayload = await response.text();
      let payload: AnalysisResult & { error?: string };
      try {
        payload = JSON.parse(rawPayload) as AnalysisResult & { error?: string };
      } catch {
        throw new Error(
          response.ok
            ? "服务返回的数据格式异常，请重试。"
            : "网页服务暂时不可用，请确认本地服务仍在运行后重试。",
        );
      }
      if (!response.ok) {
        throw new Error(payload.error || "处理失败，请稍后重试。");
      }
      if (progressTimer) window.clearTimeout(progressTimer);
      if (analyzeTimer) window.clearTimeout(analyzeTimer);
      setStage("analyze");
      await new Promise((resolve) => window.setTimeout(resolve, 420));
      if (localFilename) {
        payload.source = {
          ...payload.source,
          filename: localFilename,
        };
      }
      setResult(payload as AnalysisResult);
      setStage("done");
    } catch (caught) {
      setStage("error");
      if (caught instanceof DOMException && caught.name === "AbortError") {
        setError(
          cancelRequestedRef.current
            ? "已停止本次处理，你可以调整配置后重新开始。"
            : "处理请求已超时，请确认本地服务正常后重试。",
        );
      } else if (caught instanceof TypeError && useLocalPipeline) {
        setError(
          "浏览器没有连上本机助手。请确认“启动拆片AI”仍在运行，并允许 jackshaw.top 访问本地网络。",
        );
        setSettingsOpen(true);
      } else if (caught instanceof TypeError) {
        setError("网页服务连接中断，请稍后重试。");
      } else {
        setError(caught instanceof Error ? caught.message : "处理失败，请稍后重试。");
      }
    } finally {
      if (progressTimer) window.clearTimeout(progressTimer);
      if (analyzeTimer) window.clearTimeout(analyzeTimer);
      window.clearInterval(elapsedTimer);
      abortRef.current = null;
    }
  }

  function runAnalysis(event: React.FormEvent) {
    event.preventDefault();
    void startAnalysis();
  }

  function cancelAnalysis() {
    cancelRequestedRef.current = true;
    abortRef.current?.abort();
  }

  async function loadDemo() {
    setError("");
    setResult(null);
    setRewriteResult(null);
    setRewriteError("");
    setRewriteStatus("idle");
    setStage("download");
    setActiveTab("analysis");
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    setStage("transcribe");
    await new Promise((resolve) => window.setTimeout(resolve, 900));
    setStage("analyze");
    await new Promise((resolve) => window.setTimeout(resolve, 800));
    setResult(demoResult);
    setStage("done");
  }

  async function copyReport() {
    try {
      await writeClipboard(markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("复制失败，请允许浏览器使用剪贴板后重试。");
    }
  }

  async function copyTranscript() {
    if (!result) return;
    try {
      await writeClipboard(result.transcript);
      setTranscriptCopied(true);
      window.setTimeout(() => setTranscriptCopied(false), 1800);
    } catch {
      setError("字幕复制失败，请允许浏览器使用剪贴板后重试。");
    }
  }

  async function copyReusableLine(line: string, index: number) {
    try {
      await writeClipboard(line);
      setCopiedLine(index);
      window.setTimeout(() => setCopiedLine(null), 1800);
    } catch {
      setError("句式复制失败，请允许浏览器使用剪贴板后重试。");
    }
  }

  async function generateRewrite(event: React.FormEvent) {
    event.preventDefault();
    if (!result) return;
    if (projectInfo.trim().length < 10) {
      setRewriteError("请至少填写 10 个字的项目信息，让生成内容有事实依据。");
      return;
    }
    if (
      analysisProvider === "deepseek" &&
      !publicDeepseekTrial &&
      deepseekApiKey.trim().length < 20
    ) {
      setRewriteError("请先在“服务配置”中填写有效的 DeepSeek API Key。");
      focusSetting("deepseek-key");
      return;
    }
    if (analysisProvider === "openai" && openaiApiKey.trim().length < 20) {
      setRewriteError("请先在“服务配置”中填写有效的 OpenAI API Key。");
      focusSetting("openai-key");
      return;
    }

    setRewriteStatus("working");
    setRewriteError("");
    setRewriteResult(null);

    try {
      const response = await fetch("/api/rewrite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          analysis: result.analysis,
          projectInfo: projectInfo.trim(),
          direction: rewriteDirection.trim() || undefined,
          format: rewriteFormat,
          analysisProvider,
          openaiApiKey: openaiApiKey.trim() || undefined,
          deepseekApiKey: deepseekApiKey.trim() || undefined,
        }),
      });
      const rawPayload = await response.text();
      let payload: RewriteResult & { error?: string };
      try {
        payload = JSON.parse(rawPayload) as RewriteResult & { error?: string };
      } catch {
        throw new Error("仿写服务返回异常，请稍后重试。");
      }
      if (!response.ok) {
        throw new Error(payload.error || "生成失败，请稍后重试。");
      }
      setRewriteResult(payload);
      setRewriteStatus("done");
    } catch (caught) {
      setRewriteStatus("error");
      setRewriteError(
        caught instanceof Error ? caught.message : "生成失败，请稍后重试。",
      );
    }
  }

  async function copyRewrite() {
    if (!rewriteResult) return;
    try {
      await writeClipboard(rewriteMarkdown);
      setRewriteCopied(true);
      window.setTimeout(() => setRewriteCopied(false), 1800);
    } catch {
      setRewriteError("文案复制失败，请允许浏览器使用剪贴板后重试。");
    }
  }

  function downloadSrt() {
    if (!result) return;
    const content = result.segments
      .map(
        (segment, index) =>
          `${index + 1}\n${toSrtTime(segment.start)} --> ${toSrtTime(segment.end)}\n${segment.text.trim()}\n`,
      )
      .join("\n");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "video-transcript.srt";
    anchor.click();
    URL.revokeObjectURL(href);
  }

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="拆片 AI 首页">
          <span className="brand-mark">拆</span>
          <span>拆片</span>
          <em>AI</em>
        </a>
        <button
          className={`topbar-note ${health?.ok ? "ready" : "warning"}`}
          type="button"
          onClick={() => setSettingsOpen(true)}
          title="打开服务配置"
        >
          <span className="status-dot" aria-hidden="true" />
          {healthLabel} · 密钥不落盘
        </button>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow"><span>01</span> VIDEO INTELLIGENCE</p>
          <h1>
            把一条视频
            <br />
            <span>拆到能复用。</span>
          </h1>
          <p className="hero-lead">
            粘贴视频链接、上传音视频或使用现成字幕，从开场、结构、金句和转化动作四个维度获得可执行的内容报告。
          </p>

          <form className="input-panel" onSubmit={runAnalysis}>
            <div className="source-mode" role="tablist" aria-label="内容输入方式">
              <button
                type="button"
                role="tab"
                aria-selected={sourceMode === "url"}
                onClick={() => setSourceMode("url")}
                disabled={isWorking}
              >
                视频链接
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sourceMode === "upload"}
                onClick={() => {
                  setSourceMode("upload");
                  setTranscriptionProvider("groq");
                }}
                disabled={isWorking}
              >
                上传音视频
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sourceMode === "transcript"}
                onClick={() => setSourceMode("transcript")}
                disabled={isWorking}
              >
                粘贴字幕
              </button>
            </div>
            <label
              htmlFor={
                sourceMode === "url"
                  ? "video-url"
                  : sourceMode === "upload"
                    ? "media-upload"
                    : "transcript-input"
              }
            >
              {sourceMode === "url"
                ? "视频链接"
                : sourceMode === "upload"
                  ? "音频或视频文件"
                  : "字幕全文"}
            </label>
            <div className={`url-row ${sourceMode !== "url" ? "transcript-mode" : ""}`}>
              {sourceMode === "url" ? (
                <div className="url-input-wrap">
                  <span className="link-symbol" aria-hidden="true">↗</span>
                  <input
                    id="video-url"
                    type="url"
                    inputMode="url"
                    placeholder="粘贴公开视频或音视频直链…"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    disabled={isWorking}
                    aria-describedby="url-help"
                  />
                </div>
              ) : sourceMode === "upload" ? (
                <div className="upload-input-wrap">
                  <input
                    id="media-upload"
                    type="file"
                    accept="audio/*,video/mp4,video/webm,video/mpeg,.m4a,.mp3,.wav,.ogg,.flac"
                    onChange={(event) => setUploadFile(event.target.files?.[0] || null)}
                    disabled={isWorking}
                    aria-describedby="url-help"
                  />
                  <span>
                    {uploadFile
                      ? `${uploadFile.name} · ${(uploadFile.size / 1024 / 1024).toFixed(1)} MB`
                      : "支持 MP3、M4A、WAV、MP4、WebM，最大 25 MB"}
                  </span>
                </div>
              ) : (
                <textarea
                  className="transcript-input"
                  id="transcript-input"
                  value={transcriptInput}
                  onChange={(event) => setTranscriptInput(event.target.value.slice(0, 50_000))}
                  placeholder="把已有字幕、逐字稿或口播稿粘贴到这里，即可直接使用 DeepSeek 拆解…"
                  rows={6}
                  disabled={isWorking}
                />
              )}
              <button className="primary-button" type="submit" disabled={isWorking}>
                {isWorking ? "正在拆解" : "开始拆解"}
                <span aria-hidden="true">{isWorking ? "···" : "→"}</span>
              </button>
            </div>
            <div className="options-row">
              <label>
                <span>字幕语言</span>
                {sourceMode !== "transcript" ? (
                  <select value={language} onChange={(event) => setLanguage(event.target.value)} disabled={isWorking}>
                    <option value="auto">自动识别</option>
                    <option value="zh">中文</option>
                    <option value="en">英文</option>
                    <option value="ja">日文</option>
                    <option value="ko">韩文</option>
                  </select>
                ) : (
                  <select disabled aria-label="已提供字幕">
                    <option>已提供字幕</option>
                  </select>
                )}
              </label>
              <label>
                <span>拆解重点</span>
                <select value={focus} onChange={(event) => setFocus(event.target.value)} disabled={isWorking}>
                  <option value="growth">内容增长</option>
                  <option value="general">通用分析</option>
                  <option value="sales">营销转化</option>
                  <option value="knowledge">知识表达</option>
                </select>
              </label>
              <button className="demo-button" type="button" onClick={loadDemo} disabled={isWorking}>
                体验示例 <span>↘</span>
              </button>
            </div>
            {analysisProvider === "deepseek" && publicDeepseekTrial && (
              <div className="public-trial-note" role="status">
                <span>FREE</span>
                <p>
                  <strong>本站已提供 DeepSeek 免费体验额度</strong>
                  无需填写密钥；每位访客每天可拆解 {capabilities.deepseek.dailyAnalyzeLimit} 次、
                  生成文案 {capabilities.deepseek.dailyRewriteLimit} 次。
                </p>
              </div>
            )}
            {usesGroq && publicGroqTrial && (
              <div className="public-trial-note groq-trial-note" role="status">
                <span>GROQ</span>
                <p>
                  <strong>本站已提供 Groq Whisper 免费转写</strong>
                  无需安装本机助手；每位访客每天可在线转写{" "}
                  {capabilities.groq.dailyTranscribeLimit} 次，单个文件不超过 25 MB。
                </p>
              </div>
            )}
            <details
              className="local-settings"
              open={settingsOpen}
              onToggle={(event) => setSettingsOpen(event.currentTarget.open)}
            >
              <summary>服务配置 <span>{transcriptionService} + {analysisService} 拆解</span></summary>
              <div className="service-health" aria-live="polite">
                <div className={health?.services.downloader ? "ready" : "offline"}>
                  <span />
                  <strong>视频下载</strong>
                  <small>{health?.services.downloader ? "可用" : "未连接"}</small>
                </div>
                <div className={health?.services.whisper ? "ready" : "offline"}>
                  <span />
                  <strong>本机 Whisper</strong>
                  <small>{health?.services.whisper ? "已加载" : "未连接"}</small>
                </div>
                <div className={publicGroqTrial ? "ready" : "offline"}>
                  <span />
                  <strong>Groq Whisper</strong>
                  <small>{publicGroqTrial ? "云端可用" : "待配置"}</small>
                </div>
              </div>
              {sourceMode === "url" && transcriptionProvider === "local" && (
                <div className="local-service-actions">
                  <button
                    type="button"
                    onClick={() => void connectLocalServices(true)}
                    disabled={isWorking || healthChecking}
                  >
                    {healthChecking
                      ? "正在连接…"
                      : health?.ok
                        ? "重新检查本机助手"
                        : "连接本机助手"}
                  </button>
                  <span>
                    {pageRuntime === "hosted"
                      ? "首次连接时，请在浏览器提示中允许访问本地网络。"
                      : "启动窗口保持打开，本机下载与转写才能持续工作。"}
                  </span>
                </div>
              )}
              <div className="settings-grid">
                <label className="settings-field" htmlFor="transcription-provider">
                  <span>字幕转写服务</span>
                  <select
                    id="transcription-provider"
                    value={transcriptionProvider}
                    onChange={(event) =>
                      setTranscriptionProvider(event.target.value as "local" | "openai" | "groq")
                    }
                    disabled={isWorking}
                  >
                    <option value="groq">Groq Whisper（线上推荐）</option>
                    <option value="local">本机 Whisper</option>
                    <option value="openai">OpenAI Whisper API</option>
                  </select>
                </label>
                <label className="settings-field" htmlFor="analysis-provider">
                  <span>内容拆解服务</span>
                  <select
                    id="analysis-provider"
                    value={analysisProvider}
                    onChange={(event) =>
                      setAnalysisProvider(event.target.value as "deepseek" | "openai")
                    }
                    disabled={isWorking}
                  >
                    <option value="deepseek">DeepSeek（推荐）</option>
                    <option value="openai">OpenAI</option>
                  </select>
                </label>
                <div className="settings-status settings-status-wide" aria-live="polite">
                  <strong>{analysisService}</strong>
                  <span>{analysisProvider === "deepseek" ? "deepseek-v4-flash · 快速模式" : "GPT 拆解模型"}</span>
                </div>
              </div>
              {sourceMode === "url" && transcriptionProvider === "local" && (
                <>
                  <label className="cookie-browser-field" htmlFor="cookie-browser">
                    <span>平台下载凭证</span>
                    <select
                      id="cookie-browser"
                      value={cookieBrowser}
                      onChange={(event) =>
                        setCookieBrowser(
                          event.target.value as "fresh-edge" | "none" | "edge" | "chrome",
                        )
                      }
                      disabled={isWorking}
                    >
                      <option value="fresh-edge">自动使用临时 Edge（推荐）</option>
                      <option value="none">不使用 Cookie</option>
                      <option value="edge">读取现有 Edge Cookie</option>
                      <option value="chrome">读取现有 Chrome Cookie</option>
                    </select>
                  </label>
                  <p>
                    推荐选项会用隔离的临时 Edge 加载视频并读取当前播放流，不读取账号、历史记录或现有浏览器 Cookie；任务完成后立即删除临时数据。
                  </p>
                </>
              )}
              {sourceMode === "url" && transcriptionProvider === "local" && (
                <p className="local-whisper-note">
                  {pageRuntime === "hosted"
                    ? "线上网页只把视频交给你电脑上的本机助手，字幕仍在这台电脑上处理，无需 OpenAI Key。"
                    : "字幕在这台电脑上处理，无需 OpenAI Key。首次使用会下载 Whisper base 模型，之后可离线转写。"}
                </p>
              )}
              {usesGroq && (
                <>
                  <p className="local-whisper-note groq-whisper-note">
                    Groq 在云端完成转写，网友无需安装本机助手。上传文件和可直接访问的音视频直链可用；抖音、小红书等平台分享链接仍需要云端下载器。
                  </p>
                  <label htmlFor="groq-key">
                    {publicGroqTrial ? "自己的 Groq API Key（可选）" : "Groq API Key"}
                  </label>
                  <input
                    id="groq-key"
                    type="password"
                    autoComplete="off"
                    placeholder={
                      publicGroqTrial
                        ? "留空即可使用本站免费转写额度"
                        : "填写 Groq 控制台生成的密钥"
                    }
                    value={groqApiKey}
                    onChange={(event) => setGroqApiKey(event.target.value)}
                    disabled={isWorking}
                  />
                  <p>
                    {publicGroqTrial
                      ? "达到本站免费次数后，可临时填写自己的密钥继续使用。"
                      : "仅用于 Groq Whisper 转写，不参与内容拆解。"}
                  </p>
                </>
              )}
              {needsOpenAIKey && (
                <>
                  <label htmlFor="openai-key">OpenAI API Key</label>
                  <input
                    id="openai-key"
                    type="password"
                    autoComplete="off"
                    placeholder="sk-…"
                    value={openaiApiKey}
                    onChange={(event) => setOpenaiApiKey(event.target.value)}
                    disabled={isWorking}
                  />
                  <p>仅在选择 OpenAI 转写或 OpenAI 拆解时使用。</p>
                </>
              )}
              {analysisProvider === "deepseek" && (
                <>
                  <label htmlFor="deepseek-key">
                    {publicDeepseekTrial ? "自己的 DeepSeek API Key（可选）" : "DeepSeek API Key"}
                  </label>
                  <input
                    id="deepseek-key"
                    type="password"
                    autoComplete="off"
                    placeholder={
                      publicDeepseekTrial
                        ? "留空即可使用本站免费额度"
                        : "填写 DeepSeek 开放平台密钥"
                    }
                    value={deepseekApiKey}
                    onChange={(event) => setDeepseekApiKey(event.target.value)}
                    disabled={isWorking}
                  />
                  <p>
                    {publicDeepseekTrial
                      ? "达到免费次数后，可临时填写自己的密钥继续使用；密钥不会被网站保存。"
                      : "仅用于内容拆解，不参与字幕转写。"}
                  </p>
                </>
              )}
              <p className="settings-privacy">
                {(publicDeepseekTrial && analysisProvider === "deepseek") ||
                (publicGroqTrial && usesGroq)
                  ? "本站提供的 API 密钥只保存在服务器，访客无法查看；自行填写的密钥只停留在当前页面内存。"
                  : `${needsOpenAIKey && analysisProvider === "deepseek" ? "两枚密钥" : "密钥"}只保存在当前页面内存中，不写入项目或浏览器存储。`}
              </p>
            </details>
            <p className="input-help" id="url-help">
              {sourceMode === "url"
                ? pageRuntime === "hosted" && transcriptionProvider === "local"
                  ? "线上页面需要先连接本机助手。使用前请确认你拥有下载与处理该内容的权利。"
                  : transcriptionProvider === "groq"
                    ? "音视频直链可由 Groq 在线转写；平台分享链接如无法读取，请改用“上传音视频”或“粘贴字幕”。"
                    : "使用前请确认你拥有下载与处理该内容的权利。单个音频建议不超过 24 MB。"
                : sourceMode === "upload"
                  ? "文件会发送到 Groq 进行临时转写，不在本站保存；请确认你拥有处理该内容的权利。"
                  : publicDeepseekTrial
                  ? "线上版本可直接拆解已有字幕，不需要调用本机 Whisper，也不需要访客填写 DeepSeek 密钥。"
                  : "线上版本可直接拆解已有字幕，不需要调用本机 Whisper。字幕和密钥均不写入浏览器存储。"}
            </p>
            {isWorking && (
              <div className="inline-progress" role="status" aria-live="polite">
                <span className="progress-spinner" aria-hidden="true" />
                <div>
                  <strong>{activeStageLabel}</strong>
                  <p>已处理 {formatTime(elapsedSeconds)}，当前阶段为预计进度，请不要关闭页面。</p>
                </div>
                <button type="button" onClick={cancelAnalysis}>停止</button>
              </div>
            )}
          </form>

          {error && (
            <div className="error-message" role="alert">
              <span>!</span>
              <div>
                <strong>这次没有处理成功</strong>
                <p>{error}</p>
                <div className="error-actions">
                  <button type="button" onClick={() => void startAnalysis()}>重新处理</button>
                  <button type="button" onClick={() => setSettingsOpen(true)}>检查配置</button>
                </div>
              </div>
            </div>
          )}
        </div>

        <aside className="workflow-card" aria-label="处理流程">
          <div className="card-index">PROCESS / 03 · 阶段为预计</div>
          <div className="wave-visual" aria-hidden="true">
            {[16, 34, 48, 26, 62, 44, 78, 32, 56, 88, 46, 68, 30, 52, 22, 40, 18].map((height, index) => (
              <i
                key={`${height}-${index}`}
                style={{ height: `${height}%`, animationDelay: `${index * 55}ms` }}
                className={isWorking ? "active" : ""}
              />
            ))}
          </div>
          <div className="workflow-list">
            {stages.map((item, index) => {
              const complete = currentStage > index;
              const active = currentStage === index;
              return (
                <div className={`workflow-item ${complete ? "complete" : ""} ${active ? "active" : ""}`} key={item.key}>
                  <div className="step-number">{complete ? "✓" : `0${index + 1}`}</div>
                  <div>
                    <strong>{item.label}</strong>
                    <p>{item.detail}</p>
                  </div>
                  <span className="step-state">{complete ? "完成" : active ? "进行中" : "等待"}</span>
                </div>
              );
            })}
          </div>
          <div className="privacy-strip">
            <span>⌁</span>
            <p><strong>不做内容留存</strong><br />每次请求独立处理</p>
          </div>
        </aside>
      </section>

      {!result && (
        <section className="feature-strip" aria-label="功能亮点">
          <div><b>01</b><span>一条链接</span><p>不再手动下载与搬运文件</p></div>
          <div><b>02</b><span>时间轴字幕</span><p>可直接复制或导出 SRT</p></div>
          <div><b>03</b><span>结构化拆解</span><p>从“看懂”到“拿来就用”</p></div>
        </section>
      )}

      {result && (
        <section className="results" id="results">
          <div className="results-heading">
            <div>
              <p className="eyebrow"><span>02</span> ANALYSIS REPORT</p>
              <h2>{result.analysis.title}</h2>
              <p>{result.analysis.oneLine}</p>
            </div>
            <div className="result-actions">
              <button type="button" onClick={copyReport}>{copied ? "已复制" : "复制报告"}</button>
              <button type="button" onClick={downloadSrt}>下载 SRT</button>
            </div>
          </div>

          <div className="result-tabs" role="tablist" aria-label="结果视图">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "analysis"}
              onClick={() => setActiveTab("analysis")}
            >
              拆解报告
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "transcript"}
              onClick={() => setActiveTab("transcript")}
            >
              字幕全文 <span>{result.segments.length}</span>
            </button>
          </div>

          {activeTab === "analysis" ? (
            <>
              <div className="analysis-grid">
              <article className="report-card summary-card">
                <div className="card-label">内容结论</div>
                <p className="summary-text">{result.analysis.summary}</p>
                <div className="meta-pills">
                  <span>受众 · {result.analysis.audience}</span>
                  <span>类型 · {result.analysis.contentType}</span>
                </div>
              </article>

              <article className="report-card score-card">
                <div className="card-label">表达评分</div>
                <div className="score-grid">
                  {[
                    ["开场抓力", result.analysis.scores.hook],
                    ["表达清晰", result.analysis.scores.clarity],
                    ["情绪张力", result.analysis.scores.emotion],
                    ["转化动作", result.analysis.scores.conversion],
                  ].map(([label, value]) => (
                    <div className={`score-item ${scoreTone(Number(value))}`} key={String(label)}>
                      <div><strong>{value}</strong><small>/100</small></div>
                      <span>{label}</span>
                      <i style={{ "--score": `${value}%` } as React.CSSProperties} />
                    </div>
                  ))}
                </div>
              </article>

              <article className="report-card structure-card">
                <div className="card-label">内容骨架</div>
                <div className="timeline">
                  {result.analysis.structure.map((item, index) => (
                    <div className="timeline-item" key={`${item.time}-${item.label}`}>
                      <span className="timeline-time">{item.time}</span>
                      <i>{index + 1}</i>
                      <div><strong>{item.label}</strong><p>{item.detail}</p></div>
                    </div>
                  ))}
                </div>
              </article>

              <article className="report-card highlights-card">
                <div className="card-label">高光表达</div>
                {result.analysis.highlights.map((item, index) => (
                  <blockquote key={item.quote}>
                    <span>0{index + 1}</span>
                    <p>“{item.quote}”</p>
                    <footer>{item.why}</footer>
                  </blockquote>
                ))}
              </article>

              <article className="report-card reusable-card">
                <div className="card-label">可复用句式</div>
                <div className="reusable-list">
                  {result.analysis.reusableLines.map((line, index) => (
                    <button
                      type="button"
                      key={line}
                      onClick={() => void copyReusableLine(line, index)}
                      title={copiedLine === index ? "已复制" : "点击复制"}
                    >
                      <span>{line}</span>
                      <i aria-hidden="true">{copiedLine === index ? "✓" : "＋"}</i>
                      <small aria-live="polite">
                        {copiedLine === index ? "已复制" : "复制"}
                      </small>
                    </button>
                  ))}
                </div>
              </article>

              <article className="report-card improve-card">
                <div className="card-label">下一版怎么更好</div>
                <ol>
                  {result.analysis.improvements.map((line, index) => (
                    <li key={line}><span>{String(index + 1).padStart(2, "0")}</span><p>{line}</p></li>
                  ))}
                </ol>
                <div className="tag-list">
                  {result.analysis.tags.map((tag) => <span key={tag}>#{tag}</span>)}
                </div>
              </article>
              </div>

              <section className="rewrite-workbench" id="rewrite-workbench">
                <div className="rewrite-intro">
                  <p className="eyebrow"><span>03</span> COPY WORKBENCH</p>
                  <h3>把拆解结果，变成你的项目文案。</h3>
                  <p>
                    沿用这条内容的架构、节奏和高光策略，但不照抄原句；只根据你填写的项目信息生成。
                  </p>
                  <div className="rewrite-source">
                    <span>本次将借鉴</span>
                    <strong>{result.analysis.structure.length} 个结构节点</strong>
                    <strong>{result.analysis.highlights.length} 个高光策略</strong>
                    <strong>{result.analysis.reusableLines.length} 个句式模板</strong>
                  </div>
                </div>

                <form className="rewrite-form" onSubmit={generateRewrite}>
                  <label htmlFor="project-info">
                    项目信息
                    <span>{projectInfo.length}/8000</span>
                  </label>
                  <textarea
                    id="project-info"
                    value={projectInfo}
                    onChange={(event) => setProjectInfo(event.target.value.slice(0, 8000))}
                    placeholder="例如：项目是什么、目标客户、核心卖点、真实数据、价格或活动、希望用户采取什么行动……"
                    rows={7}
                    disabled={rewriteStatus === "working"}
                  />

                  <div className="rewrite-options">
                    <label>
                      输出形式
                      <select
                        value={rewriteFormat}
                        onChange={(event) => setRewriteFormat(event.target.value as RewriteFormat)}
                        disabled={rewriteStatus === "working"}
                      >
                        {Object.entries(rewriteFormatLabels).map(([value, label]) => (
                          <option value={value} key={value}>{label}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      补充要求（选填）
                      <input
                        value={rewriteDirection}
                        onChange={(event) => setRewriteDirection(event.target.value.slice(0, 1000))}
                        placeholder="如：更克制、突出稀缺性、控制在 60 秒"
                        disabled={rewriteStatus === "working"}
                      />
                    </label>
                  </div>

                  <div className="rewrite-submit-row">
                    <p>项目信息和密钥仅用于本次请求，不写入项目或浏览器存储。</p>
                    <button type="submit" disabled={rewriteStatus === "working"}>
                      {rewriteStatus === "working" ? "正在生成…" : `用 ${analysisService} 生成类似文案`}
                    </button>
                  </div>

                  {rewriteError && (
                    <p className="rewrite-error" role="alert">{rewriteError}</p>
                  )}
                </form>

                {rewriteResult && (
                  <article className="rewrite-output" aria-live="polite">
                    <div className="rewrite-output-heading">
                      <div>
                        <span>生成结果 · {rewriteFormatLabels[rewriteFormat]}</span>
                        <h4>{rewriteResult.title}</h4>
                      </div>
                      <button type="button" onClick={copyRewrite}>
                        {rewriteCopied ? "已复制全文" : "复制文案"}
                      </button>
                    </div>
                    <div className="rewrite-section">
                      <b>开场</b>
                      <p>{rewriteResult.hook}</p>
                    </div>
                    <div className="rewrite-section">
                      <b>正文</b>
                      <p>{rewriteResult.body}</p>
                    </div>
                    <div className="rewrite-section">
                      <b>行动引导</b>
                      <p>{rewriteResult.cta}</p>
                    </div>
                    <div className="rewrite-strategy">
                      <b>这版如何借鉴原内容</b>
                      {rewriteResult.strategy.map((item) => (
                        <p key={`${item.source}-${item.adaptation}`}>
                          <span>{item.source}</span>{item.adaptation}
                        </p>
                      ))}
                    </div>
                  </article>
                )}
              </section>
            </>
          ) : (
            <div className="transcript-view">
              <div className="transcript-toolbar">
                <div>
                  <span className="live-dot" />
                  {result.source?.title || result.source?.filename || "视频字幕"}
                </div>
                <div className="transcript-actions">
                  <span>{result.transcript.length} 字</span>
                  <button type="button" onClick={copyTranscript}>
                    {transcriptCopied ? "已复制字幕" : "复制全部字幕"}
                  </button>
                </div>
              </div>
              <div className="transcript-lines">
                {result.segments.length > 0 ? result.segments.map((segment) => (
                  <div key={`${segment.start}-${segment.text}`}>
                    <time>{formatTime(segment.start)}</time>
                    <p>{segment.text}</p>
                  </div>
                )) : <p className="plain-transcript">{result.transcript}</p>}
              </div>
            </div>
          )}
        </section>
      )}

      <footer className="site-footer">
        <div className="brand footer-brand"><span className="brand-mark">拆</span><span>拆片</span><em>AI</em></div>
        <p>让好内容，不止被看见一次。</p>
        <span>
          {publicGroqTrial
            ? "GROQ WHISPER × DEEPSEEK"
            : publicDeepseekTrial
              ? "PUBLIC TRIAL × DEEPSEEK"
              : "LOCAL WHISPER × DEEPSEEK"}
        </span>
      </footer>
    </main>
  );
}
