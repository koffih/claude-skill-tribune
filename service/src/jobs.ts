import { sql } from './db.js';
import { deliverWebhooks, flushEmails } from './events.js';

// Background work lives in the database (notification and webhook_delivery
// rows), so a restart loses nothing. Every tick is recorded in job_run, zero
// counts included, so /healthz can tell a quiet loop from a dead one.
let started = false;
export function startJobs() {
  if (started) return;
  started = true;
  const every = (ms: number, name: string, fn: () => Promise<Record<string, number>>) => {
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;                      // a slow run never overlaps the next tick
      inFlight = true;
      try {
        const r = await fn();
        if (Object.values(r).some((v) => v > 0)) console.log(`[job:${name}]`, JSON.stringify(r));
        await sql`insert into tribune.job_run (name, last_run, last_ok, last_error, last_result) values (${name}, now(), now(), null, ${sql.json(r)})
          on conflict (name) do update set last_run = now(), last_ok = now(), last_error = null, last_result = excluded.last_result`;
      } catch (e) {
        const msg = (e as Error).message.slice(0, 300);
        console.error(`[job:${name}] ${msg}`);
        await sql`insert into tribune.job_run (name, last_run, last_error) values (${name}, now(), ${msg})
          on conflict (name) do update set last_run = now(), last_error = excluded.last_error`.catch(() => {});
      } finally { inFlight = false; }
    };
    setInterval(tick, ms).unref();
    setTimeout(tick, 5_000).unref();
  };
  every(60_000, 'mail', flushEmails);
  every(30_000, 'webhooks', deliverWebhooks);
  every(3600_000, 'trending', async () => ({ refreshed: (await sql<{ n: number }[]>`select tribune.refresh_trending(null) as n`)[0].n }));
  every(3600_000, 'cleanup', async () => {
    const s = await sql`delete from tribune.session where expires_at < now()`;
    const m = await sql`delete from tribune.magic_link where expires_at < now() - interval '1 day'`;
    const w = await sql`delete from tribune.webhook_delivery where status = 'sent' and created_at < now() - interval '30 days'`;
    return { sessions: s.count, links: m.count, deliveries: w.count };
  });
}
