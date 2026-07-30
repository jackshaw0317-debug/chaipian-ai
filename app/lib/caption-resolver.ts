const MAX_PAGE_BYTES = 6 * 1024 * 1024;
const MAX_CAPTION_BYTES = 4 * 1024 * 1024;

export type CaptionSegment = {
  start: number;
  end: number;
  text: string;
};

export type ResolvedCaptions = {
  text: string;
  segments: CaptionSegment[];
  platform: "youtube" | "bilibili" | "web";
  language?: string;
  title?: string;
};

type YouTubeCaptionTrack = {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  isTranslatable?: boolean;
  name?: {
    simpleText?: string;
    runs?: Array<{ text?: string }>;
  };
};

type BilibiliSubtitle = {
  lan?: string;
  lan_doc?: string;
  subtitle_url?: string;
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

function checkedUrl(input: string | URL, base?: string | URL) {
  const parsed = new URL(input, base);
  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new Error("Unsupported caption URL protocol.");
  }
  if (parsed.username || parsed.password || isBlockedHostname(parsed.hostname)) {
    throw new Error("Blocked caption URL.");
  }
  return parsed;
}

async function fetchWithTimeout(
  input: string | URL,
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

async function fetchBoundedText(
  url: URL,
  maxBytes: number,
  accept: string,
) {
  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      redirect: "follow",
      headers: {
        Accept: accept,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
      },
    },
    15_000,
  );
  if (!response.ok) throw new Error(`Caption fetch failed: ${response.status}`);
  checkedUrl(response.url || url.href);
  const declaredSize = Number(response.headers.get("content-length") || "0");
  if (declaredSize > maxBytes) throw new Error("Caption response is too large.");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new Error("Caption response is too large.");
  }
  return {
    text,
    finalUrl: checkedUrl(response.url || url.href),
    contentType: response.headers.get("content-type") || "",
  };
}

function extractBalancedJson(
  source: string,
  marker: string,
  opening: "{" | "[",
) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = source.indexOf(opening, markerIndex + marker.length);
  if (start < 0) return null;
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === opening) {
      depth += 1;
    } else if (character === closing) {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function decodeEntities(input: string) {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return input
    .replace(/&#(\d+);/g, (_, value: string) =>
      String.fromCodePoint(Number(value)),
    )
    .replace(/&#x([\da-f]+);/gi, (_, value: string) =>
      String.fromCodePoint(Number.parseInt(value, 16)),
    )
    .replace(/&([a-z]+);/gi, (entity, name: string) => named[name] ?? entity);
}

function cleanCaptionText(input: string) {
  return decodeEntities(
    input
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\u200b/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeSegments(segments: CaptionSegment[]) {
  const normalized: CaptionSegment[] = [];
  for (const item of segments) {
    const text = cleanCaptionText(item.text);
    if (!text) continue;
    const previous = normalized.at(-1);
    if (
      previous &&
      previous.text === text &&
      Math.abs(previous.end - item.start) < 0.35
    ) {
      previous.end = Math.max(previous.end, item.end);
      continue;
    }
    normalized.push({
      start: Math.max(0, item.start),
      end: Math.max(item.start, item.end),
      text,
    });
  }
  return normalized.slice(0, 4_000);
}

function resultFromSegments(
  segments: CaptionSegment[],
  metadata: Omit<ResolvedCaptions, "text" | "segments">,
) {
  const normalized = normalizeSegments(segments);
  const text = normalized.map((item) => item.text).join("\n").trim();
  if (text.length < 20) return null;
  return {
    ...metadata,
    text: text.slice(0, 120_000),
    segments: normalized,
  } satisfies ResolvedCaptions;
}

function parseTimestamp(value: string) {
  const parts = value.trim().replace(",", ".").split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return Number.NaN;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

function parseTextCaptions(text: string) {
  const lines = text.replace(/\r/g, "").split("\n");
  const segments: CaptionSegment[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const timing = lines[index].match(
      /(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})/,
    );
    if (!timing) continue;
    const start = parseTimestamp(timing[1]);
    const end = parseTimestamp(timing[2]);
    const cueLines: string[] = [];
    index += 1;
    while (index < lines.length && lines[index].trim()) {
      cueLines.push(lines[index]);
      index += 1;
    }
    if (Number.isFinite(start) && Number.isFinite(end)) {
      segments.push({ start, end, text: cueLines.join("\n") });
    }
  }
  return normalizeSegments(segments);
}

function titleFromHtml(html: string) {
  const openGraphTitle = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
  )?.[1];
  const reversedOpenGraphTitle = html.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
  )?.[1];
  const pageTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const title = openGraphTitle || reversedOpenGraphTitle || pageTitle || "";
  return cleanCaptionText(title).replace(/\s*-\s*YouTube\s*$/i, "").slice(0, 200);
}

function languageScore(language: string, preferredLanguage: string) {
  const normalized = language.toLowerCase();
  const preferred = preferredLanguage.toLowerCase();
  if (preferred && preferred !== "auto") {
    if (normalized === preferred) return 100;
    if (normalized.startsWith(preferred.split("-")[0])) return 80;
  }
  if (normalized.startsWith("zh")) return 60;
  if (normalized.startsWith("en")) return 30;
  return 10;
}

async function resolveYouTube(
  html: string,
  preferredLanguage: string,
  title: string,
) {
  const rawTracks = extractBalancedJson(html, '"captionTracks":', "[");
  if (!rawTracks) return null;
  const tracks = JSON.parse(rawTracks) as YouTubeCaptionTrack[];
  const selected = tracks
    .filter((track) => Boolean(track.baseUrl))
    .sort((left, right) => {
      const leftScore =
        languageScore(left.languageCode || "", preferredLanguage) +
        (left.kind === "asr" ? 0 : 12);
      const rightScore =
        languageScore(right.languageCode || "", preferredLanguage) +
        (right.kind === "asr" ? 0 : 12);
      return rightScore - leftScore;
    })[0];
  if (!selected?.baseUrl) return null;

  const captionUrl = checkedUrl(selected.baseUrl);
  captionUrl.searchParams.set("fmt", "json3");
  const response = await fetchBoundedText(
    captionUrl,
    MAX_CAPTION_BYTES,
    "application/json,text/plain;q=0.9",
  );
  const payload = JSON.parse(response.text) as {
    events?: Array<{
      tStartMs?: number;
      dDurationMs?: number;
      segs?: Array<{ utf8?: string }>;
    }>;
  };
  const segments = (payload.events || []).map((event) => {
    const start = Number(event.tStartMs || 0) / 1000;
    const duration = Number(event.dDurationMs || 0) / 1000;
    return {
      start,
      end: start + Math.max(0.1, duration),
      text: (event.segs || []).map((segment) => segment.utf8 || "").join(""),
    };
  });
  return resultFromSegments(segments, {
    platform: "youtube",
    language: selected.languageCode,
    title,
  });
}

function getBilibiliSubtitles(payload: unknown): BilibiliSubtitle[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object") return [];
  const subtitle = (data as { subtitle?: unknown }).subtitle;
  if (!subtitle || typeof subtitle !== "object") return [];
  const list =
    (subtitle as { subtitles?: unknown }).subtitles ||
    (subtitle as { list?: unknown }).list;
  return Array.isArray(list) ? (list as BilibiliSubtitle[]) : [];
}

async function fetchBilibiliSubtitle(
  subtitles: BilibiliSubtitle[],
  preferredLanguage: string,
  title: string,
) {
  const selected = subtitles
    .filter((item) => Boolean(item.subtitle_url))
    .sort(
      (left, right) =>
        languageScore(right.lan || "", preferredLanguage) -
        languageScore(left.lan || "", preferredLanguage),
    )[0];
  if (!selected?.subtitle_url) return null;
  const subtitleUrl = checkedUrl(
    selected.subtitle_url.startsWith("//")
      ? `https:${selected.subtitle_url}`
      : selected.subtitle_url,
  );
  const response = await fetchBoundedText(
    subtitleUrl,
    MAX_CAPTION_BYTES,
    "application/json,text/plain;q=0.9",
  );
  const payload = JSON.parse(response.text) as {
    body?: Array<{ from?: number; to?: number; content?: string }>;
  };
  const segments = (payload.body || []).map((item) => ({
    start: Number(item.from || 0),
    end: Number(item.to || item.from || 0),
    text: item.content || "",
  }));
  return resultFromSegments(segments, {
    platform: "bilibili",
    language: selected.lan,
    title,
  });
}

async function resolveBilibili(
  html: string,
  preferredLanguage: string,
  title: string,
) {
  const rawPlayInfo =
    extractBalancedJson(html, "window.__playinfo__=", "{") ||
    extractBalancedJson(html, "window.__playinfo__ =", "{");
  if (rawPlayInfo) {
    const playInfo = JSON.parse(rawPlayInfo) as unknown;
    const direct = await fetchBilibiliSubtitle(
      getBilibiliSubtitles(playInfo),
      preferredLanguage,
      title,
    );
    if (direct) return direct;
  }

  const rawInitialState =
    extractBalancedJson(html, "window.__INITIAL_STATE__=", "{") ||
    extractBalancedJson(html, "window.__INITIAL_STATE__ =", "{");
  if (!rawInitialState) return null;
  const initialState = JSON.parse(rawInitialState) as {
    bvid?: string;
    videoData?: { bvid?: string; cid?: number; title?: string };
    cidMap?: Record<string, { cid?: number }>;
  };
  const bvid = initialState.videoData?.bvid || initialState.bvid;
  const cid =
    initialState.videoData?.cid ||
    Object.values(initialState.cidMap || {})[0]?.cid;
  if (!bvid || !cid) return null;
  const playerUrl = checkedUrl(
    `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(String(cid))}`,
  );
  const response = await fetchBoundedText(
    playerUrl,
    MAX_CAPTION_BYTES,
    "application/json",
  );
  const playerPayload = JSON.parse(response.text) as unknown;
  return fetchBilibiliSubtitle(
    getBilibiliSubtitles(playerPayload),
    preferredLanguage,
    initialState.videoData?.title || title,
  );
}

async function resolveTrackElement(
  html: string,
  pageUrl: URL,
  preferredLanguage: string,
  title: string,
) {
  const tracks = [...html.matchAll(/<track\b[^>]*>/gi)]
    .map((match) => match[0])
    .map((tag) => ({
      src: tag.match(/\bsrc=["']([^"']+)["']/i)?.[1] || "",
      kind: tag.match(/\bkind=["']([^"']+)["']/i)?.[1] || "",
      language:
        tag.match(/\bsrclang=["']([^"']+)["']/i)?.[1] ||
        tag.match(/\blang=["']([^"']+)["']/i)?.[1] ||
        "",
    }))
    .filter(
      (track) =>
        track.src &&
        (!track.kind || ["captions", "subtitles"].includes(track.kind.toLowerCase())),
    )
    .sort(
      (left, right) =>
        languageScore(right.language, preferredLanguage) -
        languageScore(left.language, preferredLanguage),
    );
  const selected = tracks[0];
  if (!selected) return null;
  const response = await fetchBoundedText(
    checkedUrl(decodeEntities(selected.src), pageUrl),
    MAX_CAPTION_BYTES,
    "text/vtt,text/plain,application/x-subrip",
  );
  const segments = parseTextCaptions(response.text);
  return resultFromSegments(segments, {
    platform: "web",
    language: selected.language,
    title,
  });
}

export async function resolveExistingCaptions(
  input: string | URL,
  preferredLanguage = "auto",
): Promise<ResolvedCaptions | null> {
  try {
    const sourceUrl = checkedUrl(input);
    if (/\.(?:vtt|srt)(?:$|\?)/i.test(sourceUrl.href)) {
      const response = await fetchBoundedText(
        sourceUrl,
        MAX_CAPTION_BYTES,
        "text/vtt,text/plain,application/x-subrip",
      );
      return resultFromSegments(parseTextCaptions(response.text), {
        platform: "web",
        language: preferredLanguage === "auto" ? undefined : preferredLanguage,
        title: response.finalUrl.pathname.split("/").pop(),
      });
    }

    const response = await fetchBoundedText(
      sourceUrl,
      MAX_PAGE_BYTES,
      "text/html,application/xhtml+xml",
    );
    if (!response.contentType.toLowerCase().includes("html")) return null;
    const html = response.text;
    const hostname = response.finalUrl.hostname.toLowerCase();
    const title = titleFromHtml(html);

    if (
      hostname === "youtu.be" ||
      hostname.endsWith(".youtube.com") ||
      hostname === "youtube.com"
    ) {
      return await resolveYouTube(html, preferredLanguage, title);
    }
    if (
      hostname === "b23.tv" ||
      hostname === "bilibili.com" ||
      hostname.endsWith(".bilibili.com")
    ) {
      return await resolveBilibili(html, preferredLanguage, title);
    }
    return await resolveTrackElement(
      html,
      response.finalUrl,
      preferredLanguage,
      title,
    );
  } catch (error) {
    console.info(
      "Platform captions unavailable:",
      error instanceof Error ? error.message : "unknown error",
    );
    return null;
  }
}
