import { NextResponse } from "next/server";
import { getPublicTrialConfig } from "../../lib/public-ai-access";

export const runtime = "edge";
export const dynamic = "force-dynamic";

export async function GET() {
  const trial = getPublicTrialConfig();
  return NextResponse.json(
    {
      deepseek: {
        publicTrial: trial.enabled,
        dailyAnalyzeLimit: trial.dailyAnalyzeLimit,
        dailyRewriteLimit: trial.dailyRewriteLimit,
      },
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
