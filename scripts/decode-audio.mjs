import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const edgeExecutable =
  process.env.EDGE_EXECUTABLE ||
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const inputPath = resolve(process.argv[2] || "");
const outputPath = resolve(process.argv[3] || "");
const maxResultBytes = 256 * 1024 * 1024;

if (!process.argv[2] || !process.argv[3]) {
  throw new Error("用法：node decode-audio.mjs <输入媒体> <输出 WAV>");
}

await stat(inputPath);
await mkdir(dirname(outputPath), { recursive: true });

let settleResult;
let settleError;
const finished = new Promise((resolvePromise, rejectPromise) => {
  settleResult = resolvePromise;
  settleError = rejectPromise;
});

const page = `<!doctype html>
<meta charset="utf-8">
<title>本地音频解码</title>
<body>正在解码…</body>
<script>
const writeAscii = (view, offset, text) => {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
};

const toWav = (samples, sampleRate) => {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true);
    offset += 2;
  }
  return buffer;
};

(async () => {
  try {
    const response = await fetch("/media", { cache: "no-store" });
    if (!response.ok) throw new Error("读取媒体失败：" + response.status);
    const source = await response.arrayBuffer();
    const context = new AudioContext();
    const decoded = await context.decodeAudioData(source.slice(0));
    const sampleRate = 16000;
    const frameCount = Math.ceil(decoded.duration * sampleRate);
    if (!Number.isFinite(frameCount) || frameCount <= 0) {
      throw new Error("媒体中没有可解码的音频");
    }
    const offline = new OfflineAudioContext(1, frameCount, sampleRate);
    const sourceNode = offline.createBufferSource();
    sourceNode.buffer = decoded;
    sourceNode.connect(offline.destination);
    sourceNode.start(0);
    const rendered = await offline.startRendering();
    const wav = toWav(rendered.getChannelData(0), sampleRate);
    const upload = await fetch("/result", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wav,
    });
    if (!upload.ok) throw new Error("保存解码结果失败：" + upload.status);
    document.body.textContent = "完成";
    await context.close();
  } catch (error) {
    document.body.textContent = "失败";
    await fetch("/error", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
  }
})();
</script>`;

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(page);
      return;
    }

    if (request.method === "GET" && request.url === "/media") {
      const mediaStat = await stat(inputPath);
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(mediaStat.size),
        "Cache-Control": "no-store",
      });
      createReadStream(inputPath).pipe(response);
      return;
    }

    if (request.method === "POST" && request.url === "/result") {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > maxResultBytes) throw new Error("解码后的音频超过 256 MB");
        chunks.push(chunk);
      }
      await writeFile(outputPath, Buffer.concat(chunks, size), { mode: 0o600 });
      response.writeHead(204);
      response.end();
      settleResult();
      return;
    }

    if (request.method === "POST" && request.url === "/error") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const message = Buffer.concat(chunks).toString("utf8").slice(0, 1_000);
      response.writeHead(204);
      response.end();
      settleError(new Error(message || "Edge 音频解码失败"));
      return;
    }

    response.writeHead(404);
    response.end();
  } catch (error) {
    response.writeHead(500);
    response.end();
    settleError(error);
  }
});

await new Promise((resolvePromise, rejectPromise) => {
  server.once("error", rejectPromise);
  server.listen(0, "127.0.0.1", resolvePromise);
});

const address = server.address();
if (!address || typeof address === "string") throw new Error("无法启动本地解码页面");

const profileDirectory = join(tmpdir(), `chaipian-audio-${randomUUID()}`);
await mkdir(profileDirectory, { recursive: true });
const edge = spawn(
  edgeExecutable,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    `--user-data-dir=${profileDirectory}`,
    `http://127.0.0.1:${address.port}/`,
  ],
  { windowsHide: true, stdio: "ignore" },
);

const timeout = setTimeout(() => settleError(new Error("Edge 音频解码超时")), 150_000);

try {
  await finished;
  process.stdout.write(JSON.stringify({ ok: true, outputPath }));
} finally {
  clearTimeout(timeout);
  edge.kill();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  await rm(profileDirectory, { recursive: true, force: true }).catch(() => undefined);
}
