import { Pool, type PoolConfig } from "pg";

let pool: Pool | null = null;

function getConnectionString(): string {
  const url =
    process.env.DATABASE_URL?.trim() ||
    process.env.SUPABASE_DB_URL?.trim();
  if (!url) {
    throw new Error(
      "Database URL is not configured. Set DATABASE_URL or SUPABASE_DB_URL (Supabase: Project Settings → Database → URI).",
    );
  }
  return url;
}

/** Remote Supabase / cloud Postgres needs TLS; local sockets typically do not. */
function shouldUseSsl(connectionString: string): boolean {
  if (process.env.DATABASE_SSL === "false" || process.env.DATABASE_SSL === "0") {
    return false;
  }
  if (process.env.DATABASE_SSL === "true" || process.env.DATABASE_SSL === "require") {
    return true;
  }
  if (/sslmode=require/i.test(connectionString)) {
    return true;
  }
  return (
    /\.supabase\.(co|com)/i.test(connectionString) ||
    /pooler\.supabase\.com/i.test(connectionString)
  );
}

function isLocalPostgres(connectionString: string): boolean {
  return /(^|@)(localhost|127\.0\.0\.1)(:|\/|$)/i.test(connectionString);
}

function buildPoolConfig(): PoolConfig {
  const connectionString = getConnectionString();
  const config: PoolConfig = { connectionString };

  const useSsl = shouldUseSsl(connectionString) && !isLocalPostgres(connectionString);
  if (useSsl) {
    // Supabase uses publicly trusted certs; this matches their Node/pg examples.
    config.ssl = { rejectUnauthorized: false };
  }

  // pg's defaults wait forever for a connection and for a query — one stalled database call then hangs the
  // whole chat request until the host kills it ("Something went wrong"). Fail fast instead.
  config.connectionTimeoutMillis = 8_000;
  config.query_timeout = 20_000; // client-side only, so it also works through Supabase's pooler
  config.idleTimeoutMillis = 10_000; // serverless: give idle connections back quickly

  // Every serverless instance has its own pool. The default of 10 × many concurrent instances exhausts the
  // database pooler ("max clients reached"), so keep it small on Vercel; override with DATABASE_POOL_MAX.
  const max = Number(process.env.DATABASE_POOL_MAX);
  if (Number.isFinite(max) && max > 0) {
    config.max = max;
  } else if (process.env.VERCEL) {
    config.max = 3;
  }

  return config;
}

export function getDbPool(): Pool {
  if (pool) {
    return pool;
  }

  pool = new Pool(buildPoolConfig());
  return pool;
}
