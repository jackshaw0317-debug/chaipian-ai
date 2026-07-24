"use client";

import { useMemo, useState } from "react";

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

const stages = [
  { key: "download", label: "读取视频", detail: "提取可转写的音频内容" },
  { key: "transcribe", label: "Whisper 转写", detail: "识别语音并生成时间轴" },
  { key: "analyze", label: "GPT 拆解", detail: "提炼结构、亮点与改进方向" },
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

export default function Home() {
  const [url, setUrl] = useState("");
  const [language, setLanguage] = useState("auto");
  const [focus, setFocus] = useState("growth");
  const [stage, setStage] = useState<Stage>("idle");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [activeTab, setActiveTab] = useState<"analysis" | "transcript">("analysis");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const isWorking = ["download", "transcribe", "analyze"].includes(stage);
  const currentStage = stageIndex[stage];

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

  async function runAnalysis(event: React.FormEvent) {
    event.preventDefault();
    if (!url.trim()) {
      setError("请先粘贴一个视频链接，或点击“体验示例”。");
      return;
    }

    setError("");
    setResult(null);
    setStage("download");
    setActiveTab("analysis");

    const progressTimer = window.setTimeout(() => setStage("transcribe"), 1300);
    const analyzeTimer = window.setTimeout(() => setStage("analyze"), 5200);

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), language, focus }),
      });
      const payload = (await response.json()) as AnalysisResult & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "处理失败，请稍后重试。");
      }
      window.clearTimeout(progressTimer);
      window.clearTimeout(analyzeTimer);
      setStage("analyze");
      await new Promise((resolve) => window.setTimeout(resolve, 420));
      setResult(payload as AnalysisResult);
      setStage("done");
    } catch (caught) {
      window.clearTimeout(progressTimer);
      window.clearTimeout(analyzeTimer);
      setStage("error");
      setError(caught instanceof Error ? caught.message : "处理失败，请稍后重试。");
    }
  }

  async function loadDemo() {
    setError("");
    setResult(null);
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
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
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
        <div className="topbar-note">
          <span className="status-dot" aria-hidden="true" />
          本地优先 · 密钥仅存服务端
        </div>
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
            粘贴链接，自动提取音频、生成字幕，再从开场、结构、金句和转化动作四个维度给出可执行的内容报告。
          </p>

          <form className="input-panel" onSubmit={runAnalysis}>
            <label htmlFor="video-url">视频链接</label>
            <div className="url-row">
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
              <button className="primary-button" type="submit" disabled={isWorking}>
                {isWorking ? "正在拆解" : "开始拆解"}
                <span aria-hidden="true">{isWorking ? "···" : "→"}</span>
              </button>
            </div>
            <div className="options-row">
              <label>
                <span>字幕语言</span>
                <select value={language} onChange={(event) => setLanguage(event.target.value)} disabled={isWorking}>
                  <option value="auto">自动识别</option>
                  <option value="zh">中文</option>
                  <option value="en">英文</option>
                  <option value="ja">日文</option>
                  <option value="ko">韩文</option>
                </select>
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
            <p className="input-help" id="url-help">
              使用前请确认你拥有下载与处理该内容的权利。单个音频建议不超过 24 MB。
            </p>
          </form>

          {error && (
            <div className="error-message" role="alert">
              <span>!</span>
              <div>
                <strong>这次没有处理成功</strong>
                <p>{error}</p>
              </div>
            </div>
          )}
        </div>

        <aside className="workflow-card" aria-label="处理流程">
          <div className="card-index">PROCESS / 03</div>
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
                  {result.analysis.reusableLines.map((line) => (
                    <button
                      type="button"
                      key={line}
                      onClick={() => navigator.clipboard.writeText(line)}
                      title="点击复制"
                    >
                      <span>{line}</span><i>＋</i>
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
          ) : (
            <div className="transcript-view">
              <div className="transcript-toolbar">
                <div>
                  <span className="live-dot" />
                  {result.source?.title || result.source?.filename || "视频字幕"}
                </div>
                <span>{result.transcript.length} 字</span>
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
        <span>Whisper × GPT</span>
      </footer>
    </main>
  );
}
