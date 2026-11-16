import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg } from './config.js';

// extensions: where Supabase installs pg_trgm and unaccent.
export const sql = postgres(cfg.databaseUrl, {
  max: Number(process.env.DB_POOL ?? '10'),
  connection: { search_path: 'tribune,public,extensions', application_name: 'tribune' },
  onnotice: () => {},
});

export type Sql = typeof sql;
export type Tx = postgres.TransactionSql;

function sqlDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, '../sql'), join(here, '../../sql')]) {
    try { readdirSync(c); return c; } catch { /* try next */ }
  }
  throw new Error('sql directory not found');
}

// Files are idempotent; they run in name order under an advisory lock so two
// instances starting together never race.
export async function migrate(): Promise<string[]> {
  const dir = sqlDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(727172)`;
    for (const f of files) {
      await tx.unsafe(readFileSync(join(dir, f), 'utf8'));
      await tx`insert into tribune.migration (name) values (${f}) on conflict (name) do update set applied_at = now()`;
      applied.push(f);
    }
  });
  return applied;
}
