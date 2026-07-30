import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("服务端渲染拆片 AI 产品页", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html[^>]+lang="zh-CN"/i);
  assert.match(html, /<title>拆片 AI｜视频转字幕与内容拆解<\/title>/i);
  assert.match(html, /把一条视频/);
  assert.match(html, /开始拆解/);
  assert.match(html, /本机 Whisper/);
  assert.match(html, /DeepSeek/);
  assert.match(html, /上传音视频/);
  assert.match(html, /Groq Whisper/);
  assert.match(html, /硅基流动 ASR/);
  assert.match(html, /粘贴字幕/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site|codex-preview/i);
});

test("项目不再包含启动占位页，并保留本地隐私约束", async () => {
  const [
    page,
    layout,
    packageJson,
    healthRoute,
    analyzeRoute,
    transcribeRoute,
    rewriteRoute,
    capabilitiesRoute,
    captionsRoute,
    captionResolver,
    downloader,
    transcriber,
    startScript,
  ] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/api/health/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/analyze/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/transcribe/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/rewrite/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/capabilities/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/captions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/caption-resolver.ts", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-downloader.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/local-transcriber.py", import.meta.url), "utf8"),
    readFile(new URL("../scripts/start-local.ps1", import.meta.url), "utf8"),
  ]);

  assert.match(page, /密钥不落盘/);
  assert.match(page, /自动使用临时 Edge/);
  assert.match(page, /重新处理/);
  assert.match(page, /改用上传音视频/);
  assert.match(page, /isPlatformSharePage/);
  assert.match(page, /停止本次处理/);
  assert.match(page, /复制全部字幕/);
  assert.match(page, /把拆解结果，变成你的项目文案/);
  assert.match(page, /短视频口播/);
  assert.match(page, /transcriptText/);
  assert.match(page, /targetAddressSpace: "loopback"/);
  assert.match(page, /连接本机助手/);
  assert.match(page, /role="switch"/);
  assert.match(page, /使用本机处理/);
  assert.match(page, /uploadFile\.arrayBuffer/);
  assert.match(page, /transcribeMediaLocally/);
  assert.match(layout, /拆片 AI｜视频转字幕与内容拆解/);
  assert.match(healthRoute, /127\.0\.0\.1:4317\/health/);
  assert.match(healthRoute, /127\.0\.0\.1:4318\/health/);
  assert.match(analyzeRoute, /transcriptSegments/);
  assert.match(analyzeRoute, /api\.groq\.com\/openai\/v1\/audio\/transcriptions/);
  assert.match(analyzeRoute, /api\.siliconflow\.cn\/v1\/audio\/transcriptions/);
  assert.match(analyzeRoute, /resolveExistingCaptions/);
  assert.match(analyzeRoute, /platform-captions/);
  assert.match(capabilitiesRoute, /cloudAvailable/);
  assert.match(capabilitiesRoute, /captionResolverAvailable: true/);
  assert.match(captionsRoute, /resolveExistingCaptions/);
  assert.match(captionResolver, /"captionTracks":/);
  assert.match(captionResolver, /api\.bilibili\.com\/x\/player\/v2/);
  assert.match(captionResolver, /<track\\b/);
  assert.match(transcribeRoute, /MAX_FILE_BYTES = 25 \* 1024 \* 1024/);
  assert.match(transcribeRoute, /consumePublicAllowance\(request, "transcribe"\)/);
  assert.match(transcribeRoute, /fallbackFrom = "siliconflow"/);
  assert.match(rewriteRoute, /唯一事实来源/);
  assert.match(rewriteRoute, /不得虚构/);
  assert.match(downloader, /https:\/\/jackshaw\.top/);
  assert.match(downloader, /Access-Control-Allow-Private-Network/);
  assert.match(transcriber, /https:\/\/jackshaw\.top/);
  assert.match(transcriber, /Access-Control-Allow-Private-Network/);
  assert.match(startScript, /npm\.cmd run build/);
  assert.match(startScript, /npm\.cmd run start/);
  assert.doesNotMatch(startScript, /npm\.cmd run dev/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await assert.rejects(
    access(new URL("app/_sites-preview/", templateRoot)),
  );
});
