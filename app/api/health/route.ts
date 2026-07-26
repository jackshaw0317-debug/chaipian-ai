import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function checkService(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_800);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET() {
  const downloaderUrl =
    process.env.LOCAL_DOWNLOADER_HEALTH_URL || "http://127.0.0.1:4317/health";
  const whisperUrl =
    process.env.LOCAL_TRANSCRIBER_HEALTH_URL || "http://127.0.0.1:4318/health";

  const [downloader, whisper] = await Promise.all([
    checkService(downloaderUrl),
    checkService(whisperUrl),
  ]);

  return NextResponse.json(
    {
      ok: downloader && whisper,
      services: { downloader, whisper },
      checkedAt: new Date().toISOString(),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
