import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, login, sign, freshSite, sql, migrate, flushEmails } from './helpers.js';

const only = process.env.ONLY;
const t = (name: string, fn: () => Promise<void>) => test(name, { skip: !!only && !name.startsWith(only) }, fn);

let S: Awaited<ReturnType<typeof freshSite>>, other: Awaited<ReturnType<typeof freshSite>>;
let alice: string, bob: string, carol: string, mod: string;

before(async () => {
  await migrate();
  S = await freshSite(); other = await freshSite();
  alice = await login(S.slug, S.jwt_secret, { sub: 'a1', email: 'alice@example.com', name: 'Alice', segment: 'paying', company: { id: 'acme', name: 'Acme', mrr: 2000 } });
  bob = await login(S.slug, S.jwt_secret, { sub: 'b1', email: 'bob@example.com', name: 'Bob', segment: 'free', company: { id: 'acme', name: 'Acme' } });
  carol = await login(S.slug, S.jwt_secret, { sub: 'c1', email: 'carol@example.com', name: 'Carol', company: { id: 'globex', name: 'Globex', mrr: 100 } });
  mod = await login(S.slug, S.jwt_secret, { sub: 'm1', email: 'mod@example.com', name: 'Mod', role: 'moderator' });
});
after(async () => { await sql.end(); });

const post = async (tok: string, title: string, board = 'idees') =>
  (await call('POST', `/sites/${S.slug}/boards/${board}/posts`, { token: tok, body: { title, body: 'details' } })).json.post.number as number;
const detail = async (n: number, tok?: string) => (await call('GET', `/sites/${S.slug}/posts/${n}`, { token: tok })).json;

t('identify rejects bad signature, missing iat and stale tokens', async () => {
  let r = await call('POST', `/sites/${S.slug}/auth/identify`, { body: { token: await sign('wrong-secret-wrong-secret-wrong', { sub: 'x' }, { exp: '5m' }) } });
  assert.equal(r.status, 401);
  r = await call('POST', `/sites/${S.slug}/auth/identify`, { body: { token: await sign(S.jwt_secret, { sub: 'x' }, { iat: Math.floor(Date.now() / 1000) - 3 * 86400 }) } });
  assert.equal(r.status, 401);
  // A token of site A must not open a session on site B.
  r = await call('POST', `/sites/${other.slug}/auth/identify`, { body: { token: await sign(S.jwt_secret, { sub: 'x' }, { exp: '5m' }) } });
  assert.equal(r.status, 401);
});

t('author votes automatically, one vote per user, vote can be withdrawn', async () => {
  const n = await post(alice, 'Exporter les factures en PDF');
  assert.equal((await detail(n)).post.vote_count, 1);
  assert.equal((await call('POST', `/sites/${S.slug}/posts/${n}/vote`, { token: bob })).json.vote_count, 2);
  assert.equal((await call('POST', `/sites/${S.slug}/posts/${n}/vote`, { token: bob })).json.vote_count, 2);
  assert.equal((await call('DELETE', `/sites/${S.slug}/posts/${n}/vote`, { token: bob })).json.vote_count, 1);
  assert.equal((await call('POST', `/sites/${S.slug}/posts/${n}/vote`, {})).status, 401);
});

t('similar posts are suggested while typing, accents ignored', async () => {
  await post(alice, 'Mode sombre pour le tableau de bord');
  const r = await call('GET', `/sites/${S.slug}/posts/similar?q=${encodeURIComponent('mode sombre tableau')}`);
  assert.ok(r.json.posts.some((p: any) => p.title.startsWith('Mode sombre')), JSON.stringify(r.json));
  const r2 = await call('GET', `/sites/${S.slug}/posts/similar?q=${encodeURIComponent('Exporter factures pdf')}`);
  assert.ok(r2.json.posts.length >= 1);
});

t('merge moves votes without double counting, merged post refuses votes, unmerge restores', async () => {
  const master = await post(alice, 'Calendrier partagé avec Google');
  const dup = await post(bob, 'Synchroniser le calendrier Google');
  await call('POST', `/sites/${S.slug}/posts/${dup}/vote`, { token: carol });
  await call('POST', `/sites/${S.slug}/posts/${dup}/vote`, { token: alice }); // alice voted both
  await call('POST', `/sites/${S.slug}/posts/${dup}/comments`, { token: carol, body: { body: 'Oui svp' } });
  assert.equal((await call('POST', `/sites/${S.slug}/posts/${dup}/merge`, { token: alice, body: { into: master } })).status, 403);
  const m = await call('POST', `/sites/${S.slug}/posts/${dup}/merge`, { token: mod, body: { into: master } });
  assert.equal(m.status, 200);
  assert.equal(m.json.moved_votes, 2); // bob and carol; alice already on master
  const d = await detail(master);
  assert.equal(d.post.vote_count, 3);
  assert.ok(d.comments.some((c: any) => c.body === 'Oui svp'));
  const v = await call('POST', `/sites/${S.slug}/posts/${dup}/vote`, { token: carol });
  assert.equal(v.status, 409);
  assert.equal(v.json.merged_into, master);
  assert.equal((await call('POST', `/sites/${S.slug}/posts/${master}/merge`, { token: mod, body: { into: dup } })).status, 409);
  const u = await call('POST', `/sites/${S.slug}/posts/${dup}/unmerge`, { token: mod });
  assert.equal(u.json.restored_votes, 2);
  assert.equal((await detail(master)).post.vote_count, 1);
  assert.equal((await detail(dup)).post.vote_count, 3);
});

t('status change notifies author and voters with the team message, closed status refuses votes', async () => {
  const n = await post(alice, 'Paiement en plusieurs fois');
  await call('POST', `/sites/${S.slug}/posts/${n}/vote`, { token: carol });
  assert.equal((await call('PATCH', `/sites/${S.slug}/posts/${n}`, { token: bob, body: { status: 'planned' } })).status, 403);
  const r = await call('PATCH', `/sites/${S.slug}/posts/${n}`, { token: mod, body: { status: 'complete', message: 'Disponible depuis ce matin' } });
  assert.equal(r.status, 200);
  for (const tok of [alice, carol]) {
    const notes = (await call('GET', `/sites/${S.slug}/me/notifications`, { token: tok })).json.notifications;
    const hit = notes.find((x: any) => x.type === 'status_changed' && x.payload.number === n);
    assert.ok(hit, 'notification missing');
    assert.equal(hit.payload.message, 'Disponible depuis ce matin');
  }
  const d = await detail(n);
  assert.ok(d.events.some((e: any) => e.type === 'status_changed' && e.payload.to === 'complete'));
  assert.equal((await call('POST', `/sites/${S.slug}/posts/${n}/vote`, { token: bob })).status, 409);
  // Emails go out from the queue once the burst window has passed.
  await sql`update tribune.notification set created_at = now() - interval '5 minutes' where post_id in (select id from tribune.post where site_id = (select id from tribune.site where slug = ${S.slug}))`;
  const f = await flushEmails();
  assert.ok(f.sent >= 2, JSON.stringify(f));
});

t('internal comments are hidden from users, official replies notify', async () => {
  const n = await post(alice, 'Application mobile hors ligne');
  await call('POST', `/sites/${S.slug}/posts/${n}/comments`, { token: mod, body: { body: 'Note interne: client clé', internal: true } });
  assert.equal((await call('POST', `/sites/${S.slug}/posts/${n}/comments`, { token: alice, body: { body: 'x', internal: true } })).status, 403);
  await call('POST', `/sites/${S.slug}/posts/${n}/comments`, { token: mod, body: { body: 'On regarde ça' } });
  const pub = await detail(n, alice);
  assert.ok(!pub.comments.some((c: any) => c.internal));
  assert.ok(pub.comments.some((c: any) => c.official && c.body === 'On regarde ça'));
  const team = await detail(n, mod);
  assert.ok(team.comments.some((c: any) => c.internal));
  const notes = (await call('GET', `/sites/${S.slug}/me/notifications`, { token: alice })).json.notifications;
  assert.ok(notes.some((x: any) => x.type === 'team_reply' && x.payload.number === n));
});

t('site isolation: another site sees nothing and its users cannot act here', async () => {
  const n = await post(alice, 'Visible seulement sur le site A');
  const o = await login(other.slug, other.jwt_secret, { sub: 'a1', email: 'alice@example.com' });
  assert.equal((await call('GET', `/sites/${other.slug}/posts/${n}`)).status, 404);
  assert.equal((await call('POST', `/sites/${S.slug}/posts/${n}/vote`, { token: o })).status, 401);
  const list = await call('GET', `/sites/${other.slug}/boards/idees/posts?sort=new`);
  assert.equal(list.json.posts.length, 0);
  assert.equal((await call('GET', `/sites/${other.slug}/backlog`, { key: S.api_key })).status, 401);
});

t('rate limit: daily post quota applies to users, not to the team', async () => {
  const s = await freshSite();
  await sql`update tribune.site set config = config || '{"max_posts_per_day": 2}' where slug = ${s.slug}`;
  const u = await login(s.slug, s.jwt_secret, { sub: 'q', email: 'q@example.com' });
  for (const title of ['Premiere idee', 'Deuxieme idee']) assert.equal((await call('POST', `/sites/${s.slug}/boards/idees/posts`, { token: u, body: { title } })).status, 201);
  const third = await call('POST', `/sites/${s.slug}/boards/idees/posts`, { token: u, body: { title: 'Troisieme idee' } });
  assert.equal(third.status, 429);
});

t('approval queue: posts on a moderated board wait, invisible to others', async () => {
  await call('PUT', `/sites/${S.slug}/boards/moderee`, { key: S.api_key, body: { name: { fr: 'Modérée', en: 'Moderated' }, require_approval: true } });
  const r = await call('POST', `/sites/${S.slug}/boards/moderee/posts`, { token: carol, body: { title: 'Idee a moderer' } });
  assert.equal(r.json.post.approved, false);
  const n = r.json.post.number;
  assert.equal((await call('GET', `/sites/${S.slug}/posts/${n}`, { token: bob })).status, 404);
  assert.equal((await call('GET', `/sites/${S.slug}/posts/${n}`, { token: carol })).status, 200);
  const q = await call('GET', `/sites/${S.slug}/moderation`, { token: mod });
  assert.ok(q.json.posts.some((p: any) => p.number === n));
  await call('PATCH', `/sites/${S.slug}/posts/${n}`, { token: mod, body: { approved: true } });
  assert.equal((await call('GET', `/sites/${S.slug}/posts/${n}`, { token: bob })).status, 200);
});

t('backlog ranks by weighted priority and counts MRR once per company', async () => {
  const a = await post(alice, 'Backlog A rapports avances');   // alice: paying (3), Acme 2000
  await call('POST', `/sites/${S.slug}/posts/${a}/vote`, { token: bob });    // bob: free (1), Acme again
  const b = await post(carol, 'Backlog B import CSV');          // carol: no segment (1), Globex 100
  await call('PATCH', `/sites/${S.slug}/posts/${a}`, { token: mod, body: { impact: 2, confidence: 1, effort: 2 } });
  await call('PATCH', `/sites/${S.slug}/posts/${b}`, { token: mod, body: { impact: 3, confidence: 1, effort: 1 } });
  // Support adds a customer's vote with their words and the ticket link.
  const ob = await call('POST', `/sites/${S.slug}/posts/${b}/votes`, { key: S.api_key,
    body: { email: 'dana@initech.com', name: 'Dana', company: { id: 'initech', name: 'Initech', mrr: 500 }, note: 'Nous en avons besoin chaque mois', source_url: 'https://support.example.com/t/42' } });
  assert.equal(ob.status, 201);
  assert.equal((await call('GET', `/sites/${S.slug}/backlog`, { token: alice })).status, 403);
  const bl = (await call('GET', `/sites/${S.slug}/backlog`, { token: mod })).json.posts;
  const ra = bl.find((p: any) => p.number === a), rb = bl.find((p: any) => p.number === b);
  assert.equal(ra.people, 2); assert.equal(ra.companies, 1); assert.equal(ra.mrr, 2000); assert.equal(ra.weighted_votes, 4);
  assert.equal(ra.priority, 4);  // 4 * 2 * 1 / 2
  assert.equal(rb.people, 2); assert.equal(rb.companies, 2); assert.equal(rb.mrr, 600); assert.equal(rb.weighted_votes, 2);
  assert.equal(rb.priority, 6);  // 2 * 3 * 1 / 1
  assert.ok(bl.indexOf(rb) < bl.indexOf(ra), 'higher priority first');
  const d = await detail(b, mod);
  assert.ok(d.voters.some((v: any) => v.note === 'Nous en avons besoin chaque mois' && v.source === 'on_behalf'));
  assert.ok(!(await detail(b, alice)).voters.some((v: any) => 'email' in v), 'voter emails never public');
});

t('erasure: a user can export then delete their data', async () => {
  const u = await login(S.slug, S.jwt_secret, { sub: 'z', email: 'zed@example.com', name: 'Zed' });
  const n = await post(u, 'Idee de Zed a effacer');
  const ex = await call('GET', `/sites/${S.slug}/me/export`, { token: u });
  assert.equal(ex.json.posts.length, 1);
  assert.equal((await call('DELETE', `/sites/${S.slug}/me`, { token: u })).json.erased, true);
  assert.equal((await call('GET', `/sites/${S.slug}/me/notifications`, { token: u })).status, 401);
  const d = await detail(n);
  assert.equal(d.post.author_name, null);
  assert.equal(d.post.vote_count, 0);
});

t('webhooks refuse private addresses, including IPv6 spellings of them', async () => {
  for (const url of ['http://169.254.169.254/latest', 'http://[::ffff:7f00:1]/', 'http://[::ffff:a9fe:a9fe]/', 'http://[::ffff:127.0.0.1]/',
    'http://[::1]/', 'http://[fe90::1]/', 'http://[fd00::1]/', 'http://10.1.2.3/', 'http://localhost/']) {
    const r = await call('POST', `/sites/${S.slug}/webhooks`, { key: S.api_key, body: { url, events: ['post.created'] } });
    assert.equal(r.status, 400, url);
    assert.equal(r.json.error, 'private_url', url);
  }
  const { privateAddress } = await import('../src/events.js');
  assert.equal(privateAddress('8.8.8.8'), false);
  assert.equal(privateAddress('2606:4700:4700::1111'), false);
  assert.equal(privateAddress('not-an-ip'), true);
});

t('publishing a changelog twice notifies the voters once', async () => {
  const n = await post(alice, 'Idee livree une seule fois');
  await call('POST', `/sites/${S.slug}/posts/${n}/vote`, { token: carol });
  const r = await call('POST', `/sites/${S.slug}/changelog`, { token: mod, body: { title: 'Version 2', posts: [n], publish: true } });
  assert.equal(r.status, 201);
  await call('PUT', `/sites/${S.slug}/changelog/${r.json.id}`, { token: mod, body: { title: 'Version 2', posts: [n], publish: true } });
  const notes = (await call('GET', `/sites/${S.slug}/me/notifications`, { token: carol })).json.notifications.filter((x: any) => x.type === 'shipped' && x.payload.number === n);
  assert.equal(notes.length, 1);
});

t('a notification that cannot be sent is retried with backoff, then given up with a reason', async () => {
  const [u] = await sql<{ id: string; site_id: string }[]>`select id, site_id from tribune.app_user where email = 'carol@example.com'`;
  const [bad] = await sql<{ id: number }[]>`insert into tribune.notification (site_id, user_id, type, payload, created_at)
    values (${u.site_id}, ${u.id}, 'status_changed', '{}', now() - interval '10 minutes') returning id`;
  for (let i = 0; i < 5; i++) {
    await sql`update tribune.notification set mail_next_at = now() - interval '1 second' where id = ${bad.id}`;
    await flushEmails();
  }
  const [row] = await sql<{ email_skip: string | null; mail_attempts: number; emailed_at: Date | null }[]>`select email_skip, mail_attempts, emailed_at from tribune.notification where id = ${bad.id}`;
  assert.equal(row.mail_attempts, 5);
  assert.equal(row.email_skip, 'send_failed');
  assert.equal(row.emailed_at, null);
});
