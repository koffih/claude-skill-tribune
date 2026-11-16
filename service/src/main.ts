import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { ZodError } from 'zod';
import { SignJWT } from 'jose';
import { cfg } from './config.js';
import { migrate, sql } from './db.js';
import api from './api.js';
import { loadSite } from './auth.js';
import { startJobs } from './jobs.js';
import { HttpError } from './util.js';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = [join(here, '../web'), join(here, '../../dist/web')].find((d) => existsSync(join(d, 'index.html')));

export function buildApp() {
  const app = new Hono().basePath(cfg.basePath || '/');

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.code, message: err.message, ...err.extra }, err.status as 400);
    if (err instanceof ZodError) return c.json({ error: 'invalid_input', message: err.issues.map((i) => i.message).join('; ') }, 400);
    console.error('[error]', c.req.method, c.req.path, err);
    return c.json({ error: 'server_error' }, 500);
  });

  // Healthy means the database answers AND the queues move: an email or a
  // webhook waiting for more than 15 minutes turns the check red.
  app.get('/healthz', async (c) => {
    const [q] = await sql<{ mail_wait_min: number | null; webhook_wait_min: number | null; webhook_failed: number; mail_gave_up: number }[]>`
      select
        (select extract(epoch from now() - min(created_at)) / 60 from tribune.notification
          where emailed_at is null and email_skip is null and mail_next_at <= now() and created_at < now() - interval '2 minutes')::float as mail_wait_min,
        (select extract(epoch from now() - min(next_attempt_at)) / 60 from tribune.webhook_delivery where status = 'pending' and next_attempt_at <= now())::float as webhook_wait_min,
        (select count(*)::int from tribune.webhook_delivery where status = 'failed' and created_at > now() - interval '7 days') as webhook_failed,
        (select count(*)::int from tribune.notification where email_skip = 'send_failed' and created_at > now() - interval '7 days') as mail_gave_up`;
    const jobs = await sql`select name, last_run, last_ok, last_error from tribune.job_run order by name`;
    const late = (q.mail_wait_min ?? 0) > 15 || (q.webhook_wait_min ?? 0) > 15;
    return c.json({ ok: !late, version: '0.1.0', mail_mode: cfg.mailMode, jobs_enabled: cfg.jobs, queues: q, jobs }, late ? 503 : 200);
  });

  app.route('/api/v1', api);

  // Sandbox only: a fake host page that signs a token for a demo customer, so the
  // widget can be tried without wiring a real site. Never enable in production.
  if (process.env.TRIBUNE_DEMO === '1') {
    app.get('/demo/:site', async (c) => {
      const site = await loadSite(c.req.param('site'));
      const who = c.req.query('as') ?? 'lea';
      const people: Record<string, Record<string, unknown>> = {
        lea: { sub: 'demo-lea', email: 'lea@example.com', name: 'Léa (démo)', segment: 'paying', locale: 'fr', company: { id: 'demo-acme', name: 'Acme', mrr: 1200, plan: 'pro' } },
        sam: { sub: 'demo-sam', email: 'sam@example.com', name: 'Sam (demo)', segment: 'free', locale: 'en' },
        equipe: { sub: 'demo-team', email: 'equipe@example.com', name: 'Équipe (démo)', role: 'admin', locale: 'fr' },
      };
      const u = people[who];
      const jwt = u ? await new SignJWT(u).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('10m')
        .sign(new TextEncoder().encode(site.jwt_secret)) : '';
      const lang = (u?.locale as string) ?? 'fr';
      const esc = (x: string) => x.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
      return c.html(`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Site hôte (démo)</title></head><body style="font-family:system-ui;margin:0;padding:32px;background:#fafaf9;max-width:720px">
<h1>Site hôte de démonstration</h1><p>Cette page joue le rôle d'un de vos sites : son serveur signe un jeton pour la personne connectée, puis le widget l'identifie sans second compte.</p>
<p>Connecté : <strong>${u ? esc(String(u.name)) : 'personne'}</strong>. Changer : <a href="?as=lea">Léa (cliente payante)</a> · <a href="?as=sam">Sam (English, free)</a> · <a href="?as=equipe">Équipe (admin)</a> · <a href="?as=anon">anonyme</a></p>
<p><button type="button" onclick="Tribune.open('roadmap')">Ouvrir la feuille de route</button> <a href="${cfg.basePath}/s/${site.slug}/${u ? `?sso=${jwt}` : ''}">Portail complet</a></p>
<script src="${cfg.basePath}/widget.js" data-site="${site.slug}" ${jwt ? `data-token="${jwt}"` : ''} async></script></body></html>`);
    });
  }

  if (webDir) {
    const strip = (p: string) => (cfg.basePath ? p.slice(cfg.basePath.length) : p);
    app.use('/assets/*', serveStatic({ root: webDir, rewriteRequestPath: strip,
      onFound: (_p, c) => { c.header('Cache-Control', 'public, max-age=31536000, immutable'); } }));
    app.get('/widget.js', serveStatic({ path: join(webDir, 'widget.js'),
      onFound: (_p, c) => { c.header('Cache-Control', 'public, max-age=300'); c.header('Access-Control-Allow-Origin', '*'); } }));
    const html = readFileSync(join(webDir, 'index.html'), 'utf8').replaceAll('/__TRIBUNE_BASE__/', `${cfg.basePath}/`)
      .replace('</head>', `<script>window.TRIBUNE_BASE=${JSON.stringify(cfg.basePath)}</script></head>`);
    // The portal may be framed only by the site's own pages (the widget).
    app.get('/s/:site/*', async (c) => {
      let ancestors = "'self'";
      try {
        const site = await loadSite(c.req.param('site'));
        if (site.domains.length) ancestors += ' ' + site.domains.map((d) => (d.includes('://') ? d : `https://${d}`)).join(' ');
        else ancestors = '*';
      } catch { return c.text('site not found', 404); }
      c.header('Content-Security-Policy', `frame-ancestors ${ancestors}`);
      c.header('Cache-Control', 'no-cache');
      return c.html(html);
    });
    app.get('/s/:site', (c) => c.redirect(`${cfg.basePath}/s/${c.req.param('site')}/`));
  }
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const applied = await migrate();
  console.log(`[tribune] schema ok (${applied.join(', ')})`);
  if (cfg.jobs) startJobs();
  serve({ fetch: buildApp().fetch, port: cfg.port, hostname: process.env.HOST ?? '0.0.0.0' });
  console.log(`[tribune] listening on :${cfg.port}, public URL ${cfg.publicUrl}, mail ${cfg.mailMode}${webDir ? '' : ', no web build'}`);
}
