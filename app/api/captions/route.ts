import { NextResponse } from "next/server";
import { resolveExistingCaptions } from "../../lib/caption-resolver";
import { isSameOriginRequest } from "../../lib/public-ai-access";

export const runtime = "edge";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: "请求来源无效。" }, { status: 403 });
    }
    const contentLength = Number(request.headers.get("content-length") || "0");
    if (contentLength > 20_000) {
      return NextResponse.json({ error: "提交内容过长。" }, { status: 413 });
    }
    const body = (await request.json()) as {
      url?: string;
      language?: string;
    };
    const url = body.url?.trim() || "";
    if (!url || url.length > 2_048) {
      return NextResponse.json({ error: "请提供有效的视频链接。" }, { status: 400 });
    }
    const captions = await resolveExistingCaptions(
      url,
      body.language?.trim().slice(0, 20) || "auto",
    );
    return NextResponse.json(
      captions
        ? { found: true, ...captions }
        : { found: false },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch {
    return NextResponse.json(
      { found: false },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }
}
