import { mkdirSync, writeFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { sql, type Tx } from './db.js';

// Helpers take the caller's transaction so a change and its notifications,
// activity and webhooks commit together or not at all.
export type Db = typeof sql | Tx;
import { cfg } from './config.js';
import { hmac, unsubscribeSig } from './util.js';
import type { Site } from './auth.js';

// One place records what happened: the public activity line, the in-app
// notifications for the people concerned, and the outgoing webhooks.

export type NotifyType = 'status_changed' | 'team_reply' | 'merged' | 'shipped' | 'new_post';

export async function activity(siteId: string, postId: string | null, actorId: string | null, type: string,
  payload: Record<string, unknown> = {}, isPublic = true, db: Db = sql) {
  await db`insert into tribune.activity (site_id, post_id, actor_id, type, public, payload)
            values (${siteId}, ${postId}, ${actorId}, ${type}, ${isPublic}, ${sql.json(payload as never)})`;
}

// Author, voters and subscribers of a post, without the person who acted.
export async function audienceOf(postId: string, exclude: string | null, db: Db = sql): Promise<string[]> {
  const rows = await db<{ id: string }[]>`
    select distinct uid as id from (
      select author_id as uid from tribune.post where id = ${postId}
      union select user_id from tribune.vote where post_id = ${postId}
      union select user_id from tribune.subscription where post_id = ${postId}
    ) a where uid is not null and uid is distinct from ${exclude}`;
  return rows.map((r) => r.id);
}

export async function notify(siteId: string, userIds: string[], postId: string | null, type: NotifyType,
  payload: Record<string, unknown>, db: Db = sql) {
  if (!userIds.length) return 0;
  const rows = userIds.map((u) => ({ site_id: siteId, user_id: u, post_id: postId, type, payload }));
  await db`insert into tribune.notification ${sql(rows as never, 'site_id', 'user_id', 'post_id', 'type', 'payload')}`;
  return rows.length;
}

export async function moderatorsOf(siteId: string): Promise<string[]> {
  const r = await sql<{ id: string }[]>`select id from tribune.app_user
    where site_id = ${siteId} and role in ('moderator','admin') and external_id is distinct from '__system__' and not banned`;
  return r.map((x) => x.id);
}

export async function emitWebhook(site: Site, event: string, data: Record<string, unknown>, db: Db = sql) {
  await db`insert into tribune.webhook_delivery (webhook_id, event, payload)
    select id, ${event}, ${sql.json({ event, site: site.slug, at: new Date().toISOString(), data } as never)}
    from tribune.webhook where site_id = ${site.id} and active and ${event} = any(events)`;
}

// ---------- mail ----------

type Mail = { to: string; subject: string; text: string; html: string; from?: string; headers?: Record<string, string> };
let transport: nodemailer.Transporter | null = null;

export async function sendMail(m: Mail): Promise<void> {
  if (cfg.mailMode === 'log') {
    console.log(`[mail] to=${m.to} subject=${JSON.stringify(m.subject)}`);
    return;
  }
  if (cfg.mailMode === 'file') {
    mkdirSync(cfg.mailDir, { recursive: true });
    writeFileSync(join(cfg.mailDir, `${Date.now()}-${Math.random().toString(36).slice(2)}.json`), JSON.stringify(m));
    return;
  }
  if (cfg.mailMode === 'resend') {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: m.from ?? cfg.mailFrom, to: m.to, subject: m.subject, text: m.text, html: m.html, headers: m.headers }),
    });
    if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return;
  }
  if (cfg.mailMode !== 'smtp') throw new Error(`unknown MAIL_MODE ${cfg.mailMode}`);
  transport ??= nodemailer.createTransport(cfg.smtpUrl);
  await transport.sendMail({ ...m, from: m.from ?? cfg.mailFrom });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const T = {
  fr: {
    status_changed: (p: any) => `« ${p.title} » est passée à : ${p.status}`,
    team_reply: (p: any) => `L'équipe a répondu sur « ${p.title} »`,
    merged: (p: any) => `« ${p.title} » a été regroupée avec « ${p.into_title} », votre vote suit`,
    shipped: (p: any) => `C'est en ligne : « ${p.title} »`,
    new_post: (p: any) => `Nouvelle idée : « ${p.title} »`,
    digest: (n: number) => `${n} nouvelles sur les idées que vous suivez`,
    open: 'Voir', unsub: 'Ne plus recevoir ces courriels',
    why: 'Vous recevez ce message parce que vous avez proposé, voté ou suivi cette idée.',
    magicSubject: (s: string) => `Votre lien de connexion à ${s}`,
    magicBody: 'Cliquez pour vous connecter. Le lien est valable 20 minutes et ne sert qu\'une fois.',
    magicButton: 'Me connecter',
  },
  en: {
    status_changed: (p: any) => `"${p.title}" is now: ${p.status}`,
    team_reply: (p: any) => `The team replied on "${p.title}"`,
    merged: (p: any) => `"${p.title}" was merged into "${p.into_title}", your vote moved with it`,
    shipped: (p: any) => `It's live: "${p.title}"`,
    new_post: (p: any) => `New idea: "${p.title}"`,
    digest: (n: number) => `${n} updates on ideas you follow`,
    open: 'Open', unsub: 'Stop these emails',
    why: 'You get this because you posted, voted on or followed this idea.',
    magicSubject: (s: string) => `Your sign-in link for ${s}`,
    magicBody: 'Click to sign in. The link works once and expires in 20 minutes.',
    magicButton: 'Sign in',
  },
};

function layout(site: string, lines: { text: string; url: string; message?: string }[], footer: string, unsub: string, L: typeof T.fr) {
  const items = lines.map((l) => `<tr><td style="padding:12px 0;border-bottom:1px solid #e5e7eb">
    <div style="font-size:15px;color:#111827">${esc(l.text)}</div>
    ${l.message ? `<div style="margin-top:6px;padding:8px 12px;background:#f3f4f6;border-radius:6px;color:#374151;font-size:14px">${esc(l.message)}</div>` : ''}
    <a href="${esc(l.url)}" style="display:inline-block;margin-top:8px;color:#2563eb;font-size:14px">${L.open}</a></td></tr>`).join('');
  return `<!doctype html><html><body style="margin:0;background:#f9fafb;font-family:system-ui,-apple-system,Segoe UI,sans-serif">
  <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#fff;padding:24px">
  <tr><td style="font-size:13px;color:#6b7280;padding-bottom:8px">${esc(site)}</td></tr>${items}
  <tr><td style="padding-top:16px;font-size:12px;color:#6b7280">${esc(footer)}<br><a href="${esc(unsub)}" style="color:#6b7280">${L.unsub}</a></td></tr>
  </table></body></html>`;
}

export const postUrl = (site: string, n: number) => `${cfg.publicUrl}/s/${site}/p/${n}`;

export async function sendMagicLink(site: Site, email: string, t: string, locale: 'fr' | 'en') {
  const L = T[locale];
  const url = `${cfg.publicUrl}/s/${site.slug}/auth?token=${encodeURIComponent(t)}`;
  if (cfg.mailMode === 'log') console.log(`[mail] magic link for ${email}: ${url}`);
  await sendMail({
    to: email, from: site.config.mail_from, subject: L.magicSubject(site.name),
    text: `${L.magicBody}\n\n${url}\n`,
    html: `<!doctype html><html><body style="font-family:system-ui,sans-serif;padding:24px"><p>${esc(L.magicBody)}</p>
      <p><a href="${esc(url)}" style="display:inline-block;padding:10px 18px;background:#111827;color:#fff;border-radius:6px;text-decoration:none">${L.magicButton}</a></p></body></html>`,
  });
}

// Pending notifications wait two minutes so a burst collapses into one digest.
// A run leases a person's rows (mail_claimed_at) and only marks them emailed
// after the send succeeds: a crash mid-send leaves a lease that expires after
// ten minutes and the rows go out on a later run (at least once, never lost).
// A failing address is retried with backoff, then given up with a reason, so
// it can neither loop forever nor starve the people behind it.
const MAX_MAIL_ATTEMPTS = 5;
export async function flushEmails(): Promise<{ sent: number; skipped: number; failed: number; gave_up: number }> {
  const out = { sent: 0, skipped: 0, failed: 0, gave_up: 0 };
  const skipped = await sql`
    update tribune.notification n set email_skip = case
        when u.email is null then 'no_email' when u.email_opt_out then 'opt_out' when u.banned then 'banned' end
    from tribune.app_user u where n.user_id = u.id and n.emailed_at is null and n.email_skip is null
      and (u.email is null or u.email_opt_out or u.banned)`;
  out.skipped = skipped.count;
  const due = sql`emailed_at is null and email_skip is null and created_at < now() - interval '2 minutes'
    and mail_next_at <= now() and (mail_claimed_at is null or mail_claimed_at < now() - interval '10 minutes')`;
  const users = await sql<{ user_id: string }[]>`
    select user_id from tribune.notification where ${due}
    group by user_id order by min(created_at) limit 200`;
  for (const { user_id } of users) {
    let claimed: { id: number; type: NotifyType; payload: any; mail_attempts: number }[] = [];
    try {
      claimed = await sql`update tribune.notification set mail_claimed_at = now()
        where id in (select id from tribune.notification where user_id = ${user_id} and ${due} for update skip locked)
        returning id, type, payload, mail_attempts`;
      if (!claimed.length) continue;
      const [u] = await sql<{ email: string; locale: 'fr' | 'en' | null; slug: string; site_name: string; default_locale: 'fr' | 'en'; mail_from: string | null }[]>`
        select u.email, u.locale, s.slug, s.name as site_name, s.default_locale, s.config->>'mail_from' as mail_from
        from tribune.app_user u join tribune.site s on s.id = u.site_id where u.id = ${user_id}`;
      if (!u) throw new Error('user row missing');
      const L = T[u.locale ?? u.default_locale] ?? T.fr;
      const lines = claimed.map((n) => {
        const make = L[n.type] as ((p: any) => string) | undefined;
        const number = n.payload?.number ?? n.payload?.into_number;
        if (!make || !n.payload?.title || !number) throw new Error(`notification ${n.id} has an unusable payload`);
        return { text: make(n.payload), url: postUrl(u.slug, number), message: n.payload.message as string | undefined };
      });
      const subject = lines.length === 1 ? lines[0].text : L.digest(lines.length);
      const unsub = `${cfg.publicUrl}/api/v1/unsubscribe?u=${user_id}&sig=${unsubscribeSig(user_id)}`;
      await sendMail({
        to: u.email, from: u.mail_from ?? undefined, subject,
        text: lines.map((l) => `${l.text}${l.message ? `\n  ${l.message}` : ''}\n  ${l.url}`).join('\n\n') + `\n\n${L.why}\n${L.unsub}: ${unsub}\n`,
        html: layout(u.site_name, lines, L.why, unsub, L),
        headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      });
      await sql`update tribune.notification set emailed_at = now(), mail_claimed_at = null where id in ${sql(claimed.map((c) => c.id))}`;
      out.sent += 1;
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      console.error(`[mail] failed for user ${user_id}: ${msg}`);
      out.failed += 1;
      if (!claimed.length) continue;
      const attempts = Math.max(...claimed.map((c) => c.mail_attempts)) + 1;
      const giveUp = attempts >= MAX_MAIL_ATTEMPTS;
      if (giveUp) out.gave_up += claimed.length;
      try {
        await sql`update tribune.notification set mail_claimed_at = null, mail_attempts = ${attempts}, mail_error = ${msg},
          mail_next_at = now() + make_interval(mins => ${5 * 2 ** attempts}),
          email_skip = ${giveUp ? 'send_failed' : null}
          where id in ${sql(claimed.map((c) => c.id))}`;
      } catch (e2) {
        // The lease expires on its own; the rows are retried after ten minutes.
        console.error(`[mail] could not record the failure for user ${user_id}: ${(e2 as Error).message}`);
      }
    }
  }
  return out;
}

// Webhooks must not reach the private network (cloud metadata, local admin
// ports). Checked at creation and again at delivery, since DNS can change.
// Anything that does not parse as a plain public address is refused.
function ipv4Private(a: string): boolean {
  const o = a.split('.').map(Number);
  if (o.length !== 4 || o.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [p, q] = o;
  return p === 10 || p === 127 || p === 0 || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31)
    || (p === 192 && q === 168) || (p === 100 && q >= 64 && q <= 127) || (p === 198 && (q === 18 || q === 19)) || p >= 224;
}
export function privateAddress(addr: string): boolean {
  const a = addr.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(a) === 4) return ipv4Private(a);
  if (isIP(a) !== 6) return true;
  // Expand to eight hextets so prefixes compare reliably.
  let [head, tail = ''] = a.split('::');
  let v4 = '';
  const last = (tail || head).split(':').pop() ?? '';
  if (last.includes('.')) { v4 = last; if (tail) tail = tail.slice(0, -last.length).replace(/:$/, ''); else head = head.slice(0, -last.length).replace(/:$/, ''); }
  const hs = head ? head.split(':') : [], ts = tail ? tail.split(':') : [];
  const need = 8 - (v4 ? 2 : 0) - hs.length - ts.length;
  if (need < 0 || (!a.includes('::') && need !== 0)) return true;
  const groups = [...hs, ...Array(need).fill('0'), ...ts].map((h) => parseInt(h || '0', 16));
  if (v4) { const o = v4.split('.').map(Number); groups.push((o[0] << 8) | o[1], (o[2] << 8) | o[3]); }
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return true;
  const zeroPrefix = groups.slice(0, 5).every((g) => g === 0);
  if (zeroPrefix && (groups[5] === 0xffff || groups[5] === 0)) {           // IPv4-mapped or -compatible, ::, ::1
    if (groups[5] === 0 && groups[6] === 0 && groups[7] <= 1) return true;
    return ipv4Private(`${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`);
  }
  const g0 = groups[0];
  return (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xff00) === 0xff00
    || (g0 === 0x64 && groups[1] === 0xff9b) || (g0 === 0x2002);
}
export async function assertPublicUrl(url: string): Promise<void> {
  if (process.env.WEBHOOK_ALLOW_PRIVATE === '1') return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  let addrs: string[];
  try { addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address); } catch { addrs = []; }
  if (!addrs.length || addrs.some(privateAddress)) {
    const { HttpError } = await import('./util.js');
    throw new HttpError(400, 'private_url', 'webhook URL must resolve to a public address');
  }
}

export async function deliverWebhooks(): Promise<{ sent: number; failed: number }> {
  const out = { sent: 0, failed: 0 };
  const due = await sql<{ id: number; url: string; secret: string; payload: unknown; attempts: number }[]>`
    update tribune.webhook_delivery d set attempts = attempts + 1, next_attempt_at = now() + interval '5 minutes'
    from tribune.webhook w
    where d.id in (select id from tribune.webhook_delivery where status = 'pending' and next_attempt_at <= now()
                   order by id limit 50 for update skip locked) and w.id = d.webhook_id
    returning d.id, w.url, w.secret, d.payload, d.attempts`;
  for (const d of due) {
    const body = JSON.stringify(d.payload);
    const ts = Math.floor(Date.now() / 1000).toString();
    let error: string | null = null;
    try {
      await assertPublicUrl(d.url);
      const r = await fetch(d.url, {
        method: 'POST', signal: AbortSignal.timeout(10_000), redirect: 'manual',
        headers: { 'Content-Type': 'application/json', 'X-Tribune-Timestamp': ts, 'X-Tribune-Delivery': String(d.id),
          'X-Tribune-Signature': `sha256=${hmac(d.secret, `${ts}.${body}`)}` },
        body,
      });
      if (!r.ok) error = `HTTP ${r.status}`;
    } catch (e) { error = (e as Error).message.slice(0, 300); }
    // The status write sits outside the send: a database error after a
    // successful POST must not turn it into a retry (receivers dedupe on
    // X-Tribune-Delivery anyway). If this write fails, the 5-minute lease
    // brings the row back and the receiver sees the same delivery id.
    try {
      if (!error) {
        await sql`update tribune.webhook_delivery set status = 'sent', last_error = null where id = ${d.id}`;
        out.sent += 1;
      } else {
        const final = d.attempts >= 8;
        await sql`update tribune.webhook_delivery set last_error = ${error}, status = ${final ? 'failed' : 'pending'},
          next_attempt_at = now() + make_interval(secs => ${Math.min(30 * 2 ** d.attempts, 6 * 3600)}) where id = ${d.id}`;
        if (final) console.error(`[webhook] delivery ${d.id} to ${d.url} failed for good: ${error}`);
        out.failed += 1;
      }
    } catch (e) {
      console.error(`[webhook] could not record delivery ${d.id}: ${(e as Error).message}`);
    }
  }
  return out;
}
