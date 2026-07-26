import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const host = "127.0.0.1";
const port = Number(process.env.LOCAL_DOWNLOADER_PORT || 4317);
const projectRoot = resolve(import.meta.dirname, "..");
const downloadsRoot = join(tmpdir(), "chaipian-local-downloader");
const toolRoot = join(projectRoot, ".local-tools", "yt-dlp");
const pythonExecutable = process.env.PYTHON_EXECUTABLE || "python";
const edgeExecutable =
  process.env.EDGE_EXECUTABLE ||
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const maxBytes = 24 * 1024 * 1024;

const contentTypes = {
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".mp4": "audio/mp4",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};

function writeJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function blockedHostname(hostname) {
  const value = hostname.toLowerCase();
  return (
    value === "localhost" ||
    value === "0.0.0.0" ||
    value === "::1" ||
    value.endsWith(".local") ||
    value.startsWith("127.") ||
    value.startsWith("10.") ||
    value.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(value) ||
    /^169\.254\./.test(value)
  );
}

function isDouyinHostname(hostname) {
  const value = hostname.toLowerCase();
  return value === "douyin.com" || value.endsWith(".douyin.com");
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function getFreePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const probe = createNetServer();
    probe.unref();
    probe.on("error", rejectPromise);
    probe.listen(0, host, () => {
      const address = probe.address();
      const freePort = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => {
        if (error) rejectPromise(error);
        else resolvePromise(freePort);
      });
    });
  });
}

async function waitForDebuggerPage(debugPort) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${host}:${debugPort}/json/list`);
      if (response.ok) {
        const pages = await response.json();
        const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch {
      // Edge may still be starting.
    }
    await wait(250);
  }
  throw new Error("临时 Edge 启动超时");
}

function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let requestId = 0;

  const ready = new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(new Error("无法连接临时 Edge")), 15_000);
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
        rejectPromise(new Error("无法连接临时 Edge"));
      },
      { once: true },
    );
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const pendingRequest = pending.get(message.id);
    clearTimeout(pendingRequest.timeout);
    pending.delete(message.id);
    if (message.error) {
      pendingRequest.reject(new Error(message.error.message || "Edge 调用失败"));
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
        rejectPromise(new Error(`Edge 调用超时：${method}`));
      }, 20_000);
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timeout });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  return { send, close: () => socket.close() };
}

function toNetscapeCookies(cookies) {
  const lines = [
    "# Netscape HTTP Cookie File",
    "# Generated for one local download and deleted immediately afterwards.",
  ];
  for (const cookie of cookies) {
    const domain = String(cookie.domain || "").replace(/[\t\r\n]/g, "");
    const cookiePath = String(cookie.path || "/").replace(/[\t\r\n]/g, "");
    const name = String(cookie.name || "").replace(/[\t\r\n]/g, "");
    const value = String(cookie.value || "").replace(/[\t\r\n]/g, "");
    if (!domain || !name) continue;
    const includeSubdomains = domain.startsWith(".") ? "TRUE" : "FALSE";
    const secure = cookie.secure ? "TRUE" : "FALSE";
    const expires =
      Number.isFinite(cookie.expires) && cookie.expires > 0 ? Math.floor(cookie.expires) : 0;
    lines.push(
      [domain, includeSubdomains, cookiePath, secure, expires, name, value].join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}

async function createTemporaryCookieFile(url, outputDirectory) {
  const debugPort = await getFreePort();
  const profileDirectory = join(outputDirectory, "edge-profile");
  const cookieFile = join(outputDirectory, "temporary-cookies.txt");
  await mkdir(profileDirectory, { recursive: true });

  const edge = spawn(
    edgeExecutable,
    [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=CalculateNativeWinOcclusion",
      "--window-position=-32000,-32000",
      "--window-size=1280,900",
      "--remote-allow-origins=*",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDirectory}`,
      "about:blank",
    ],
    { windowsHide: true, stdio: "ignore" },
  );

  try {
    const webSocketUrl = await waitForDebuggerPage(debugPort);
    const cdp = createCdpClient(webSocketUrl);
    try {
      await cdp.send("Network.enable");
      await cdp.send("Network.setUserAgentOverride", {
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 Edg/137.0.0.0",
      });
      await cdp.send("Page.enable");
      await cdp.send("Page.navigate", { url });
      await wait(12_000);
      const result = await cdp.send("Network.getAllCookies");
      const cookies = Array.isArray(result.cookies) ? result.cookies : [];
      if (!cookies.length) throw new Error("临时 Edge 没有获得可用 Cookie");
      if (!cookies.some((cookie) => cookie.name === "s_v_web_id")) {
        throw new Error("临时 Edge 没有生成抖音校验 Cookie（s_v_web_id）");
      }
      await writeFile(cookieFile, toNetscapeCookies(cookies), {
        encoding: "utf8",
        mode: 0o600,
      });
      return cookieFile;
    } finally {
      cdp.close();
    }
  } finally {
    edge.kill();
  }
}

async function downloadDouyinWithTemporaryEdge(url, outputDirectory) {
  const debugPort = await getFreePort();
  const profileDirectory = join(outputDirectory, "edge-profile");
  const downloadedPath = join(outputDirectory, "audio.mp4");
  await mkdir(profileDirectory, { recursive: true });

  const edge = spawn(
    edgeExecutable,
    [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=CalculateNativeWinOcclusion",
      "--window-position=-32000,-32000",
      "--window-size=1280,900",
      "--remote-allow-origins=*",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDirectory}`,
      "about:blank",
    ],
    { windowsHide: true, stdio: "ignore" },
  );

  try {
    const webSocketUrl = await waitForDebuggerPage(debugPort);
    const cdp = createCdpClient(webSocketUrl);
    try {
      await cdp.send("Network.enable");
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Page.navigate", { url });

      let mediaUrl = "";
      let pageUrl = "";
      let userAgent = "";
      const deadline = Date.now() + 35_000;
      while (Date.now() < deadline) {
        const evaluation = await cdp.send("Runtime.evaluate", {
          expression: `(() => ({
            pageUrl: location.href,
            userAgent: navigator.userAgent,
            mediaUrl: Array.from(document.querySelectorAll("video"))
              .map((video) => video.currentSrc || video.src)
              .find((source) => /^https:\\/\\//i.test(source) && /douyinvod\\.com/i.test(source)) || ""
          }))()`,
          returnByValue: true,
        });
        const value = evaluation.result?.value || {};
        pageUrl = String(value.pageUrl || "");
        userAgent = String(value.userAgent || "");
        mediaUrl = String(value.mediaUrl || "");
        if (mediaUrl) break;
        await wait(750);
      }

      if (!mediaUrl) {
        throw new Error("临时 Edge 已打开抖音页面，但没有找到可下载的视频流");
      }

      const mediaSource = new URL(mediaUrl);
      if (
        mediaSource.protocol !== "https:" ||
        !mediaSource.hostname.toLowerCase().endsWith(".douyinvod.com")
      ) {
        throw new Error("抖音返回了不受信任的媒体地址");
      }

      const mediaResponse = await fetch(mediaSource, {
        headers: {
          "User-Agent": userAgent,
          Referer: pageUrl || "https://www.douyin.com/",
          Origin: "https://www.douyin.com",
          Range: "bytes=0-",
        },
        redirect: "follow",
      });
      if (!mediaResponse.ok || !mediaResponse.body) {
        throw new Error(`抖音视频流下载失败（HTTP ${mediaResponse.status}）`);
      }

      const declaredSize = Number(mediaResponse.headers.get("content-length") || 0);
      if (declaredSize > maxBytes) {
        throw new Error("视频超过 24 MB，请改用更短的视频");
      }

      const chunks = [];
      let receivedBytes = 0;
      const reader = mediaResponse.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += value.byteLength;
        if (receivedBytes > maxBytes) {
          await reader.cancel();
          throw new Error("视频超过 24 MB，请改用更短的视频");
        }
        chunks.push(Buffer.from(value));
      }
      if (!receivedBytes) throw new Error("抖音视频流为空");
      await writeFile(downloadedPath, Buffer.concat(chunks, receivedBytes), {
        mode: 0o600,
      });
      return downloadedPath;
    } finally {
      cdp.close();
    }
  } finally {
    edge.kill();
  }
}

function runYtDlp(url, outputDirectory, cookieBrowser = "", cookieFile = "") {
  return new Promise((resolvePromise, rejectPromise) => {
    const outputTemplate = join(outputDirectory, "audio.%(ext)s");
    const args = [
      "-m",
      "yt_dlp",
      "--no-playlist",
      "--no-warnings",
      "--no-progress",
      "--socket-timeout",
      "30",
      "--retries",
      "2",
      "--fragment-retries",
      "2",
      "--max-filesize",
      "24M",
      "--format",
      "bestaudio[filesize<23M]/bestaudio[filesize_approx<23M]/worstaudio",
      "--output",
      outputTemplate,
      "--print",
      "after_move:filepath",
    ];
    if (cookieFile) {
      args.push("--cookies", cookieFile);
    } else if (cookieBrowser) {
      args.push("--cookies-from-browser", cookieBrowser);
    }
    args.push(url);

    const child = spawn(pythonExecutable, args, {
      cwd: projectRoot,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONPATH: [toolRoot, process.env.PYTHONPATH].filter(Boolean).join(";"),
        PYTHONIOENCODING: "utf-8",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      rejectPromise(new Error("视频下载超时，请改用更短的视频"));
    }, 180_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolvePromise(stdout.trim().split(/\r?\n/).filter(Boolean).pop() || "");
      } else {
        const stderrLines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const hint =
          stderrLines
            .filter((line) => line.includes("ERROR:"))
            .pop()
            ?.replace(/^.*ERROR:\s*/u, "") ||
          stderrLines.slice(-3).join(" ");
        rejectPromise(new Error(hint || "下载失败，平台可能需要登录或限制了访问"));
      }
    });
  });
}

async function locateDownloadedFile(outputDirectory, printedPath) {
  if (printedPath) {
    const candidate = resolve(printedPath);
    if (candidate.startsWith(resolve(outputDirectory))) {
      return candidate;
    }
  }
  const files = await readdir(outputDirectory);
  const first = files.find((name) => name.startsWith("audio."));
  if (!first) throw new Error("下载完成但没有找到音频文件");
  return join(outputDirectory, first);
}

const server = createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "http://localhost:3000");
  response.setHeader("Cache-Control", "no-store");

  if (request.method === "GET" && request.url === "/health") {
    writeJson(response, 200, { ok: true, service: "chaipian-local-downloader" });
    return;
  }

  if (request.method !== "POST" || request.url !== "/download") {
    writeJson(response, 404, { error: "接口不存在" });
    return;
  }

  let jobDirectory = "";
  try {
    const body = await readJsonBody(request);
    const source = new URL(String(body.url || ""));
    const cookieBrowser = ["edge", "chrome", "fresh-edge"].includes(
      String(body.cookieBrowser || ""),
    )
      ? String(body.cookieBrowser)
      : "";
    if (!["http:", "https:"].includes(source.protocol) || blockedHostname(source.hostname)) {
      throw new Error("链接无效或不允许访问");
    }

    jobDirectory = join(downloadsRoot, randomUUID());
    await mkdir(jobDirectory, { recursive: true });
    const useDirectDouyin =
      cookieBrowser === "fresh-edge" && isDouyinHostname(source.hostname);
    const directPath = useDirectDouyin
      ? await downloadDouyinWithTemporaryEdge(source.href, jobDirectory)
      : "";
    const cookieFile =
      cookieBrowser === "fresh-edge" && !useDirectDouyin
        ? await createTemporaryCookieFile(source.href, jobDirectory)
        : "";
    const printedPath =
      directPath ||
      (await runYtDlp(
        source.href,
        jobDirectory,
        cookieBrowser === "fresh-edge" ? "" : cookieBrowser,
        cookieFile,
      ));
    const filePath = await locateDownloadedFile(jobDirectory, printedPath);
    const fileStat = await stat(filePath);
    if (fileStat.size <= 0 || fileStat.size > maxBytes) {
      throw new Error("音频超过 24 MB，请改用更短的视频");
    }

    const data = await readFile(filePath);
    const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
    response.writeHead(200, {
      "Content-Type": contentTypes[extension] || "application/octet-stream",
      "Content-Length": String(data.byteLength),
      "X-Media-Filename": encodeURIComponent(basename(filePath)),
    });
    response.end(data);
  } catch (error) {
    writeJson(response, 422, {
      error: error instanceof Error ? error.message : "本地下载失败",
    });
  } finally {
    if (jobDirectory) {
      await rm(jobDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
});

await mkdir(downloadsRoot, { recursive: true });
server.listen(port, host, () => {
  console.log(`Local downloader ready at http://${host}:${port}`);
});

process.on("SIGINT", () => server.close());
process.on("SIGTERM", () => server.close());
