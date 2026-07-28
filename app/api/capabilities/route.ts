import { NextResponse } from "next/server";
import { getPublicTrialConfig } from "../../lib/public-ai-access";

export const runtime = "edge";
export const dynamic = "force-dynamic";

export async function GET() {
  const trial = getPublicTrialConfig();
  return NextResponse.json(
    {
      deepseek: {
        publicTrial: trial.deepseekEnabled,
        dailyAnalyzeLimit: trial.dailyAnalyzeLimit,
        dailyRewriteLimit: trial.dailyRewriteLimit,
      },
      groq: {
        publicTrial: trial.groqEnabled,
        dailyTranscribeLimit: trial.dailyTranscribeLimit,
        maxFileBytes: 25 * 1024 * 1024,
      },
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
