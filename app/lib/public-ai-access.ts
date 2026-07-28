type PublicAction = "analyze" | "rewrite" | "transcribe";

type UsageDatabase = {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>;
    };
    run(): Promise<{ meta?: { changes?: number } }>;
  };
};

type UsageRule = {
  scope: string;
  bucket: string;
  limit: number;
  retryAfterSeconds: number;
  message: string;
};

export type PublicAllowance =
  | { allowed: true }
  | { allowed: false; message: string; retryAfterSeconds: number };

const FALLBACK_USAGE = new Map<string, number>();
let schemaReady: Promise<void> | null = null;

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getPublicTrialConfig() {
  return {
    deepseekEnabled: Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
    groqEnabled: Boolean(process.env.GROQ_API_KEY?.trim()),
    dailyAnalyzeLimit: positiveInteger(process.env.PUBLIC_ANALYZE_DAILY_LIMIT, 10),
    dailyRewriteLimit: positiveInteger(process.env.PUBLIC_REWRITE_DAILY_LIMIT, 10),
    dailyTranscribeLimit: positiveInteger(process.env.PUBLIC_TRANSCRIBE_DAILY_LIMIT, 10),
  };
}

async function getDatabase(): Promise<UsageDatabase | null> {
  try {
    const workerModule = await import("cloudflare:workers");
    const workerEnv = workerModule.env as unknown as { DB?: UsageDatabase };
    return workerEnv.DB || null;
  } catch {
    return null;
  }
}

async function ensureSchema(database: UsageDatabase) {
  if (!schemaReady) {
    schemaReady = database
      .prepare(
        `CREATE TABLE IF NOT EXISTS public_ai_usage (
          scope TEXT NOT NULL,
          bucket TEXT NOT NULL,
          count INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (scope, bucket)
        )`,
      )
      .run()
      .then(() => undefined);
  }
  await schemaReady;
}

function requestAddress(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

async function hashAddress(request: Request) {
  const salt = process.env.RATE_LIMIT_SALT || "chaipian-public-trial";
  const bytes = new TextEncoder().encode(`${salt}:${requestAddress(request)}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .slice(0, 12)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function dayBucket(now: Date) {
  return now.toISOString().slice(0, 10);
}

function intervalBucket(now: Date, intervalSeconds: number) {
  return String(Math.floor(now.getTime() / 1000 / intervalSeconds));
}

async function incrementWithinLimit(database: UsageDatabase | null, rule: UsageRule) {
  const key = `${rule.scope}:${rule.bucket}`;
  if (!database) {
    const current = FALLBACK_USAGE.get(key) || 0;
    if (current >= rule.limit) return false;
    FALLBACK_USAGE.set(key, current + 1);
    return true;
  }

  await database
    .prepare(
      `INSERT OR IGNORE INTO public_ai_usage (scope, bucket, count, updated_at)
       VALUES (?, ?, 0, ?)`,
    )
    .bind(rule.scope, rule.bucket, Date.now())
    .run();
  const result = await database
    .prepare(
      `UPDATE public_ai_usage
       SET count = count + 1, updated_at = ?
       WHERE scope = ? AND bucket = ? AND count < ?`,
    )
    .bind(Date.now(), rule.scope, rule.bucket, rule.limit)
    .run();
  return Number(result.meta?.changes || 0) === 1;
}

export function isSameOriginRequest(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export async function consumePublicAllowance(
  request: Request,
  action: PublicAction,
): Promise<PublicAllowance> {
  const config = getPublicTrialConfig();
  const providerEnabled =
    action === "transcribe" ? config.groqEnabled : config.deepseekEnabled;
  if (!providerEnabled) {
    return {
      allowed: false,
      message: "站点体验额度尚未启用，请稍后再试。",
      retryAfterSeconds: 60,
    };
  }

  const database = await getDatabase();
  if (database) await ensureSchema(database);

  const now = new Date();
  const addressHash = await hashAddress(request);
  const actionDailyLimit =
    action === "analyze"
      ? config.dailyAnalyzeLimit
      : action === "rewrite"
        ? config.dailyRewriteLimit
        : config.dailyTranscribeLimit;
  const globalDailyLimit = positiveInteger(process.env.PUBLIC_AI_GLOBAL_DAILY_LIMIT, 200);
  const burstLimit = positiveInteger(process.env.PUBLIC_AI_BURST_LIMIT, 2);
  const burstSeconds = positiveInteger(process.env.PUBLIC_AI_BURST_WINDOW_SECONDS, 600);
  const actionLabel =
    action === "analyze" ? "拆解" : action === "rewrite" ? "仿写" : "转写";
  const rules: UsageRule[] = [
    {
      scope: `burst:${addressHash}:${action}`,
      bucket: intervalBucket(now, burstSeconds),
      limit: burstLimit,
      retryAfterSeconds: burstSeconds,
      message: "操作有点频繁，请稍等几分钟后再试。",
    },
    {
      scope: `visitor:${addressHash}:${action}`,
      bucket: dayBucket(now),
      limit: actionDailyLimit,
      retryAfterSeconds: 3600,
      message: `你今天的免费${actionLabel}次数已用完，请明天再来，或使用自己的 API Key。`,
    },
    {
      scope: `global:${action}`,
      bucket: dayBucket(now),
      limit: globalDailyLimit,
      retryAfterSeconds: 3600,
      message: "今天的全站免费体验额度已用完，请明天再来。",
    },
  ];

  for (const rule of rules) {
    if (!(await incrementWithinLimit(database, rule))) {
      return {
        allowed: false,
        message: rule.message,
        retryAfterSeconds: rule.retryAfterSeconds,
      };
    }
  }
  return { allowed: true };
}
