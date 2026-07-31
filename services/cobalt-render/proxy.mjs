import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  rm,
  stat,
} from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";

const host = "0.0.0.0";
const port = Number(process.env.PROXY_PORT || process.env.PORT || 9000);
const cobaltUrl = new URL(
  process.env.COBALT_INTERNAL_URL || "http://127.0.0.1:9001",
);
const publicUrl = new URL(
  process.env.API_URL || `http://127.0.0.1:${port}/`,
);
const chromiumExecutable =
  process.env.CHROMIUM_EXECUTABLE || "/usr/bin/chromium-browser";
const jobsRoot = join(tmpdir(), "chaipian-cloud-downloader");
const maxRequestBytes = 16 * 1024;
const maxAudioBytes = 24 * 1024 * 1024;
const maxDurationSeconds = Math.min(
  Number(process.env.DURATION_LIMIT || 900),
  900,
);
const mediaJobs = new Map();

function writeJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

function isDouyinHostname(hostname) {
  const value = hostname.toLowerCase();
  return value === "douyin.com" || value.endsWith(".douyin.com");
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxRequestBytes) {
      throw new Error("请求内容过大");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function copyRequestHeaders(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value == null || name.toLowerCase() === "host") continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

function copyResponseHeaders(upstream) {
  const headers = {};
  for (const [name, value] of upstream.headers.entries()) {
    if (
      !["content-length", "content-encoding", "transfer-encoding"].includes(
        name.toLowerCase(),
      )
    ) {
      headers[name] = value;
    }
  }
  return headers;
}

async function proxyToCobalt(request, response, body) {
  const upstreamUrl = new URL(request.url || "/", cobaltUrl);
  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers: copyRequestHeaders(request),
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : body,
    redirect: "manual",
  });
  const payload = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(upstream.status, {
    ...copyResponseHeaders(upstream),
    "Content-Length": String(payload.byteLength),
  });
  response.end(payload);
  return { upstream, payload };
}

async function authorizeWithCobalt(request, body) {
  const configuredKey = process.env.COBALT_API_KEY?.trim();
  if (configuredKey) {
    const authorization = String(request.headers.authorization || "").trim();
    const separatorIndex = authorization.indexOf(" ");
    const scheme =
      separatorIndex >= 0
        ? authorization.slice(0, separatorIndex).toLowerCase()
        : "";
    const providedKey =
      separatorIndex >= 0
        ? authorization.slice(separatorIndex + 1).trim()
        : "";
    const expectedBuffer = Buffer.from(configuredKey);
    const providedBuffer = Buffer.from(providedKey);
    const matches =
      scheme === "api-key" &&
      expectedBuffer.length === providedBuffer.length &&
      timingSafeEqual(expectedBuffer, providedBuffer);
    if (!matches) {
      return {
        allowed: false,
        status: 401,
        text: JSON.stringify({
          status: "error",
          error: { code: "error.api.auth.invalid" },
        }),
        headers: {},
      };
    }
    return { allowed: true };
  }

  const upstream = await fetch(cobaltUrl, {
    method: "POST",
    headers: copyRequestHeaders(request),
    body,
  });
  const text = await upstream.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    // A malformed response is handled as a temporary service error.
  }
  const code = String(payload?.error?.code || "");
  if (
    upstream.status === 429 ||
    code.startsWith("error.api.auth.") ||
    (!upstream.ok && !code.includes("link.unsupported"))
  ) {
    return {
      allowed: false,
      status: upstream.status,
      text,
      headers: copyResponseHeaders(upstream),
    };
  }
  return { allowed: true };
}

function getFreePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const probe = createNetServer();
    probe.unref();
    probe.on("error", rejectPromise);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const freePort =
        typeof address === "object" && address ? address.port : 0;
      probe.close((error) => {
        if (error) rejectPromise(error);
        else resolvePromise(freePort);
      });
    });
  });
}

function wait(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

async function waitForDebuggerPage(debugPort) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${debugPort}/json/list`,
      );
      if (response.ok) {
        const pages = await response.json();
        const page = pages.find(
          (item) => item.type === "page" && item.webSocketDebuggerUrl,
        );
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch {
      // Chromium may still be starting.
    }
    await wait(250);
  }
  throw new Error("chaipian.douyin.browser_start_timeout");
}

function createCdpClient(webSocketUrl, onEvent) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let requestId = 0;

  const ready = new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(
      () => rejectPromise(new Error("chaipian.douyin.browser_connect_failed")),
      15_000,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolvePromise();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        rejectPromise(
          new Error("chaipian.douyin.browser_connect_failed"),
        );
      },
      { once: true },
    );
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) {
      onEvent?.(message);
      return;
    }
    if (!pending.has(message.id)) return;
    const pendingRequest = pending.get(message.id);
    clearTimeout(pendingRequest.timeout);
    pending.delete(message.id);
    if (message.error) {
      pendingRequest.reject(
        new Error(message.error.message || "Chromium 调用失败"),
      );
    } else {
      pendingRequest.resolve(message.result || {});
    }
  });

  async function send(method, params = {}) {
    await ready;
    const id = ++requestId;
    return new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`Chromium 调用超时：${method}`));
      }, 25_000);
      pending.set(id, {
        resolve: resolvePromise,
        reject: rejectPromise,
        timeout,
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  return { send, close: () => socket.close() };
}

function isTrustedDouyinMedia(candidate) {
  try {
    const url = new URL(candidate);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      (hostname.endsWith(".douyinvod.com") ||
        hostname.endsWith(".douyinpic.com") ||
        hostname.endsWith(".douyin.com"))
    );
  } catch {
    return false;
  }
}

function runFfmpeg(mediaUrl, outputPath, userAgent, referer) {
  return new Promise((resolvePromise, rejectPromise) => {
    const headerLines = [
      `User-Agent: ${userAgent}`,
      `Referer: ${referer || "https://www.douyin.com/"}`,
      "Origin: https://www.douyin.com",
    ].join("\r\n");
    const child = spawn(
      "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-headers",
        `${headerLines}\r\n`,
        "-i",
        mediaUrl,
        "-t",
        String(maxDurationSeconds),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "64k",
        "-f",
        "mp3",
        "-y",
        outputPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error("chaipian.douyin.audio_timeout"));
    }, 105_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error("chaipian.douyin.audio_extract_failed"));
    });
  });
}

async function extractDouyinAudio(sourceUrl) {
  const jobDirectory = await mkdtemp(join(jobsRoot, "job-"));
  const outputPath = join(jobDirectory, "douyin-audio.mp3");
  const debugPort = await getFreePort();
  const profileDirectory = join(jobDirectory, "chromium-profile");
  await mkdir(profileDirectory, { recursive: true });

  const chromium = spawn(
    chromiumExecutable,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--metrics-recording-only",
      "--mute-audio",
      "--no-first-run",
      "--remote-allow-origins=*",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDirectory}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let mediaUrl = "";
  try {
    const webSocketUrl = await waitForDebuggerPage(debugPort);
    const cdp = createCdpClient(webSocketUrl, (message) => {
      if (message.method !== "Network.responseReceived") return;
      const candidate = String(message.params?.response?.url || "");
      const mimeType = String(message.params?.response?.mimeType || "");
      if (
        !mediaUrl &&
        isTrustedDouyinMedia(candidate) &&
        (mimeType.startsWith("video/") || candidate.includes("video"))
      ) {
        mediaUrl = candidate;
      }
    });
    let pageUrl = sourceUrl.href;
    let userAgent =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
    try {
      await cdp.send("Network.enable");
      await cdp.send("Network.setUserAgentOverride", { userAgent });
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Page.navigate", { url: sourceUrl.href });

      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline && !mediaUrl) {
        const evaluation = await cdp.send("Runtime.evaluate", {
          expression: `(() => ({
            pageUrl: location.href,
            userAgent: navigator.userAgent,
            mediaUrl: Array.from(document.querySelectorAll("video"))
              .map((video) => video.currentSrc || video.src)
              .find((source) => /^https:\\/\\//i.test(source)) || ""
          }))()`,
          returnByValue: true,
        });
        const value = evaluation.result?.value || {};
        pageUrl = String(value.pageUrl || pageUrl);
        userAgent = String(value.userAgent || userAgent);
        const domMediaUrl = String(value.mediaUrl || "");
        if (isTrustedDouyinMedia(domMediaUrl)) mediaUrl = domMediaUrl;
        if (!mediaUrl) await wait(750);
      }
    } finally {
      cdp.close();
    }

    if (!mediaUrl) {
      throw new Error("chaipian.douyin.media_not_found");
    }
    await runFfmpeg(mediaUrl, outputPath, userAgent, pageUrl);
    const outputStat = await stat(outputPath);
    if (outputStat.size <= 0 || outputStat.size > maxAudioBytes) {
      throw new Error("chaipian.douyin.audio_too_large");
    }
    return { directory: jobDirectory, path: outputPath };
  } catch (error) {
    await rm(jobDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    throw error;
  } finally {
    chromium.kill("SIGKILL");
  }
}

function scheduleJobCleanup(token, delay = 90_000) {
  const timeout = setTimeout(async () => {
    const job = mediaJobs.get(token);
    mediaJobs.delete(token);
    if (job) {
      await rm(job.directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }, delay);
  timeout.unref();
}

async function serveMedia(response, token) {
  const job = mediaJobs.get(token);
  if (!job) {
    writeJson(response, 404, {
      status: "error",
      error: { code: "error.api.tunnel.not_found" },
    });
    return;
  }
  mediaJobs.delete(token);
  const fileStat = await stat(job.path);
  response.writeHead(200, {
    "Content-Type": "audio/mpeg",
    "Content-Length": String(fileStat.size),
    "Content-Disposition": 'attachment; filename="douyin-audio.mp3"',
    "Cache-Control": "no-store",
  });
  const stream = createReadStream(job.path);
  stream.pipe(response);
  const cleanup = async () => {
    await rm(job.directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  };
  response.on("close", cleanup);
  response.on("finish", cleanup);
}

async function waitForCobalt() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(cobaltUrl);
      if (response.ok) return;
    } catch {
      // Cobalt may still be starting.
    }
    await wait(300);
  }
  throw new Error("Cobalt internal service did not start.");
}

await mkdir(jobsRoot, { recursive: true });
await waitForCobalt();

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(
      request.url || "/",
      `http://${request.headers.host || "localhost"}`,
    );
    if (
      request.method === "GET" &&
      requestUrl.pathname.startsWith("/media/")
    ) {
      const token = basename(requestUrl.pathname);
      if (!/^[a-f0-9-]{36}$/i.test(token)) {
        writeJson(response, 404, {
          status: "error",
          error: { code: "error.api.tunnel.not_found" },
        });
        return;
      }
      await serveMedia(response, token);
      return;
    }

    const body =
      request.method === "GET" || request.method === "HEAD"
        ? Buffer.alloc(0)
        : await readRequestBody(request);

    if (request.method !== "POST" || requestUrl.pathname !== "/") {
      await proxyToCobalt(request, response, body);
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      await proxyToCobalt(request, response, body);
      return;
    }

    let sourceUrl;
    try {
      sourceUrl = new URL(String(payload.url || ""));
    } catch {
      await proxyToCobalt(request, response, body);
      return;
    }

    if (!isDouyinHostname(sourceUrl.hostname)) {
      await proxyToCobalt(request, response, body);
      return;
    }

    const authorization = await authorizeWithCobalt(request, body);
    if (!authorization.allowed) {
      response.writeHead(authorization.status, {
        ...authorization.headers,
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(authorization.text);
      return;
    }

    const job = await extractDouyinAudio(sourceUrl);
    const token = randomUUID();
    mediaJobs.set(token, job);
    scheduleJobCleanup(token);
    const mediaUrl = new URL(`/media/${token}`, publicUrl).href;
    writeJson(response, 200, {
      status: "tunnel",
      url: mediaUrl,
      filename: "douyin-audio.mp3",
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "chaipian.downloader.failed";
    console.error("Downloader proxy failed:", message);
    writeJson(response, 422, {
      status: "error",
      error: { code: message },
    });
  }
});

server.listen(port, host, () => {
  console.log(`Chaipian downloader proxy listening on ${host}:${port}`);
});

process.on("SIGINT", () => server.close());
process.on("SIGTERM", () => server.close());
