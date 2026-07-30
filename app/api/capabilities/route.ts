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
      siliconflow: {
        publicTrial: trial.siliconflowEnabled,
        dailyTranscribeLimit: trial.dailyTranscribeLimit,
        maxFileBytes: 25 * 1024 * 1024,
        model: process.env.SILICONFLOW_ASR_MODEL || "FunAudioLLM/SenseVoiceSmall",
        groqFallback: trial.groqEnabled,
      },
      downloader: {
        cloudAvailable: Boolean(process.env.COBALT_API_URL?.trim()),
      },
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
