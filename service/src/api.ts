import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { sql, type Tx } from './db.js';
import { cfg } from './config.js';
import {
  consumeMagicLink, createMagicLink, forgetSite, identify, isTeam, loadSite, systemUser, userFromBearer,
  type Site, type User,
} from './auth.js';
import { activity, assertPublicUrl, audienceOf, emitWebhook, moderatorsOf, notify, sendMagicLink } from './events.js';
import { HttpError, limit, pickLocale, safeEqual, sha256, token, unsubscribeSig } from './util.js';

type Env = { Variables: { site: Site; user: User | null; viaKey: boolean } };
type C = Context<Env>;

const api = new Hono<Env>();

const ip = (c: C) => (cfg.trustProxy ? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() : undefined) ?? 'local';
async function body<T extends z.ZodTypeAny>(c: C, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new HttpError(400, 'invalid_json'); }
  const r = schema.safeParse(raw);
  if (!r.success) throw new HttpError(400, 'invalid_input', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}
function needUser(c: C): User {
  const u = c.get('user');
  if (!u) throw new HttpError(401, 'sign_in_required');
  return u;
}
function needTeam(c: C): User {
  const u = needUser(c);
  if (!isTeam(u)) throw new HttpError(403, 'team_only');
  return u;
}
function needAdmin(c: C): User {
  const u = needUser(c);
  if (u.role !== 'admin') throw new HttpError(403, 'admin_only');
  return u;
}
const num = (v: string) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new HttpError(404, 'post_not_found'); return n; };

// Daily quotas per user, read from the activity journal. Team members are exempt.
async function quota(site: Site, user: User, type: string, max: number) {
  if (isTeam(user)) return;
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from tribune.activity
    where actor_id = ${user.id} and type = ${type} and created_at > now() - interval '1 day'`;
  if (n >= max) throw new HttpError(429, 'daily_limit', `daily limit reached (${max})`);
  void site;
}

// ---------- site resolution and identity ----------

api.use('/sites/:site/*', async (c, next) => {
  const site = await loadSite(c.req.param('site'));
  c.set('site', site);
  c.set('viaKey', false);
  const key = c.req.header('x-tribune-key');
  if (key) {
    if (!safeEqual(sha256(key), site.api_key_hash)) throw new HttpError(401, 'bad_api_key');
    c.set('user', await systemUser(site));
    c.set('viaKey', true);
  } else {
    c.set('user', await userFromBearer(c.req.header('authorization'), site));
  }
  await next();
});

// Boards a viewer may read. Private boards are team-only; segment boards need a matching segment.
function boardVisible(user: User | null) {
  if (isTeam(user)) return sql`true`;
  return sql`(b.visibility = 'public' or (b.visibility = 'segment' and ${user?.segment ?? null}::text = any(b.segments)))`;
}

async function getBoard(site: Site, user: User | null, slug: string) {
  const [b] = await sql<any[]>`select b.* from tribune.board b where b.site_id = ${site.id} and b.slug = ${slug} and ${boardVisible(user)}`;
  if (!b) throw new HttpError(404, 'board_not_found');
  return b;
}

async function getPost(site: Site, user: User | null, n: number, tx: Tx | typeof sql = sql) {
  const [p] = await tx<any[]>`
    select p.*, s.key as status_key, s.closes_votes, b.slug as board_slug
    from tribune.post p join tribune.board b on b.id = p.board_id join tribune.status s on s.id = p.status_id
    where p.site_id = ${site.id} and p.number = ${n} and ${boardVisible(user)}`;
  if (!p) throw new HttpError(404, 'post_not_found');
  if (!isTeam(user) && (p.hidden || (!p.approved && p.author_id !== user?.id))) throw new HttpError(404, 'post_not_found');
  return p;
}

api.post('/sites/:site/auth/identify', async (c) => {
  const site = c.get('site');
  limit(`identify:${ip(c)}`, 60, 60_000);
  const { token: jwt } = await body(c, z.object({ token: z.string().min(20).max(8000) }));
  const r = await identify(site, jwt);
  return c.json({ token: r.token, user: publicMe(r.user) });
});

api.post('/sites/:site/auth/magic', async (c) => {
  const site = c.get('site');
  if (site.config.magic_link === false) throw new HttpError(403, 'magic_link_disabled');
  const b = await body(c, z.object({ email: z.string().email().max(320), name: z.string().max(120).optional(),
    return_to: z.string().max(500).optional(), locale: z.enum(['fr', 'en']).optional() }));
  limit(`magic-ip:${ip(c)}`, 10, 15 * 60_000);
  limit(`magic-mail:${site.id}:${b.email.toLowerCase()}`, 3, 15 * 60_000);
  const t = await createMagicLink(site, b.email, b.name, b.return_to);
  await sendMagicLink(site, b.email, t, pickLocale(b.locale, site.default_locale));
  return c.json({ sent: true });
});

api.post('/sites/:site/auth/verify', async (c) => {
  const site = c.get('site');
  limit(`verify:${ip(c)}`, 30, 15 * 60_000);
  const { token: t } = await body(c, z.object({ token: z.string().min(20).max(200) }));
  const r = await consumeMagicLink(site, t);
  return c.json({ token: r.token, user: publicMe(r.user), return_to: r.return_to });
});

api.post('/sites/:site/auth/logout', async (c) => {
  const h = c.req.header('authorization')?.replace(/^Bearer\s+/, '');
  if (h) await sql`delete from tribune.session where token_hash = ${sha256(h)}`;
  return c.json({ ok: true });
});

const publicMe = (u: User | null) => u && ({
  id: u.id, name: u.name, email: u.email, avatar_url: u.avatar_url, role: u.role, locale: u.locale, segment: u.segment,
});

// ---------- public reads ----------

api.get('/sites/:site/config', async (c) => {
  const site = c.get('site'), user = c.get('user');
  const boards = await sql`select b.id, b.slug, b.name, b.description, b.visibility, b.require_approval,
      (select count(*)::int from tribune.post p where p.board_id = b.id and p.merged_into_id is null and not p.hidden and p.approved) as post_count
    from tribune.board b where b.site_id = ${site.id} and ${boardVisible(user)} order by b.position, b.created_at`;
  const statuses = await sql`select id, key, label, color, position, on_roadmap, closes_votes, is_default, in_backlog
    from tribune.status where site_id = ${site.id} order by position`;
  const categories = await sql`select c.id, c.board_id, c.name, c.color from tribune.category c
    join tribune.board b on b.id = c.board_id where b.site_id = ${site.id} order by c.position`;
  const unread = user ? (await sql<{ n: number }[]>`select count(*)::int as n from tribune.notification where user_id = ${user.id} and read_at is null`)[0].n : 0;
  return c.json({
    site: { slug: site.slug, name: site.name, default_locale: site.default_locale,
      primary_color: site.config.primary_color ?? null, logo_url: site.config.logo_url ?? null, home_url: site.config.home_url ?? null,
      magic_link: site.config.magic_link !== false, show_voters: site.config.show_voters !== false, trending_half_life_days: 14 },
    boards, statuses, categories, me: publicMe(user), unread,
  });
});

const listQuery = z.object({
  sort: z.enum(['trending', 'top', 'new']).default('trending'),
  status: z.string().max(40).optional(),
  category: z.string().uuid().optional(),
  q: z.string().max(200).optional(),
  mine: z.enum(['votes', 'posts']).optional(),
  page: z.coerce.number().int().min(1).max(500).default(1),
});

api.get('/sites/:site/boards/:board/posts', async (c) => {
  const site = c.get('site'), user = c.get('user');
  const board = await getBoard(site, user, c.req.param('board'));
  const q = listQuery.parse(c.req.query());
  const per = 30, off = (q.page - 1) * per;
  const order = q.q ? sql`rank desc, p.vote_count desc`
    : q.sort === 'top' ? sql`p.vote_count desc, p.created_at desc`
    : q.sort === 'new' ? sql`p.created_at desc` : sql`p.score_trending desc, p.vote_count desc`;
  const search = q.q ? sql`websearch_to_tsquery('simple', tribune.norm(${q.q}))` : null;
  const rows = await sql<any[]>`
    select p.number, p.title, left(p.body, 280) as excerpt, p.vote_count, p.comment_count, p.created_at, p.approved,
      s.key as status, c.id as category_id, u.name as author_name,
      ${user ? sql`exists(select 1 from tribune.vote v where v.post_id = p.id and v.user_id = ${user.id})` : sql`false`} as voted,
      ${search ? sql`ts_rank(p.search, ${search}) + similarity(p.title_norm, tribune.norm(${q.q!}))` : sql`0`} as rank
    from tribune.post p
    join tribune.status s on s.id = p.status_id
    left join tribune.category c on c.id = p.category_id
    left join tribune.app_user u on u.id = p.author_id
    where p.board_id = ${board.id} and p.merged_into_id is null and not p.hidden
      and (p.approved or ${isTeam(user)} or p.author_id = ${user?.id ?? null})
      ${q.status ? sql`and s.key = ${q.status}` : sql``}
      ${q.category ? sql`and p.category_id = ${q.category}` : sql``}
      ${search ? sql`and (p.search @@ ${search} or similarity(p.title_norm, tribune.norm(${q.q!})) > 0.25)` : sql``}
      ${q.mine === 'votes' && user ? sql`and exists(select 1 from tribune.vote v where v.post_id = p.id and v.user_id = ${user.id})` : sql``}
      ${q.mine === 'posts' && user ? sql`and p.author_id = ${user.id}` : sql``}
    order by ${order}
    limit ${per + 1} offset ${off}`;
  return c.json({ posts: rows.slice(0, per).map(({ rank, ...r }) => r), has_more: rows.length > per });
});

// Shown while someone types a title: vote on an existing idea instead of filing a duplicate.
api.get('/sites/:site/posts/similar', async (c) => {
  const site = c.get('site'), user = c.get('user');
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < 3) return c.json({ posts: [] });
  const rows = await sql`
    select p.number, p.title, p.vote_count, s.key as status, b.slug as board,
      greatest(similarity(p.title_norm, tribune.norm(${q})), word_similarity(tribune.norm(${q}), p.title_norm),
               ts_rank(p.search, plainto_tsquery('simple', tribune.norm(${q}))) ) as score
    from tribune.post p join tribune.board b on b.id = p.board_id join tribune.status s on s.id = p.status_id
    where p.site_id = ${site.id} and p.merged_into_id is null and not p.hidden and p.approved and ${boardVisible(user)}
      and (p.title_norm % tribune.norm(${q}) or tribune.norm(${q}) <% p.title_norm
           or p.search @@ plainto_tsquery('simple', tribune.norm(${q})))
    order by score desc, p.vote_count desc limit 5`;
  return c.json({ posts: rows });
});

api.get('/sites/:site/posts/:number', async (c) => {
  const site = c.get('site'), user = c.get('user'), team = isTeam(user);
  const p = await getPost(site, user, num(c.req.param('number')));
  const [extra] = await sql<any[]>`
    select u.name as author_name, u.avatar_url as author_avatar, m.number as merged_into_number, m.title as merged_into_title,
      cat.name as category_name, cat.color as category_color
    from tribune.post p left join tribune.app_user u on u.id = p.author_id left join tribune.post m on m.id = p.merged_into_id
    left join tribune.category cat on cat.id = p.category_id where p.id = ${p.id}`;
  const comments = await sql`
    select c.id, c.parent_id, c.body, c.internal, c.official, c.created_at, c.edited_at, u.name as author_name, u.avatar_url as author_avatar,
      u.role in ('moderator','admin') as author_is_team
    from tribune.comment c left join tribune.app_user u on u.id = c.author_id
    where c.post_id = ${p.id} and c.deleted_at is null ${team ? sql`` : sql`and not c.internal`} order by c.created_at`;
  const events = await sql`
    select a.type, a.payload, a.created_at, u.name as actor_name from tribune.activity a left join tribune.app_user u on u.id = a.actor_id
    where a.post_id = ${p.id} and a.type in ('status_changed','merged_in','merged_into','unmerged') ${team ? sql`` : sql`and a.public`}
    order by a.created_at`;
  const showVoters = team || site.config.show_voters !== false;
  const voters = showVoters ? await sql`select u.name, u.avatar_url ${team ? sql`, u.email, v.source, v.note, v.source_url, co.name as company, co.mrr` : sql``}
    from tribune.vote v join tribune.app_user u on u.id = v.user_id left join tribune.company co on co.id = u.company_id
    where v.post_id = ${p.id} order by v.created_at desc limit ${team ? 200 : 10}` : [];
  const me = user ? (await sql<any[]>`select
      exists(select 1 from tribune.vote where post_id = ${p.id} and user_id = ${user.id}) as voted,
      exists(select 1 from tribune.subscription where post_id = ${p.id} and user_id = ${user.id}) as subscribed`)[0] : { voted: false, subscribed: false };
  return c.json({
    post: {
      number: p.number, title: p.title, body: p.body, board: p.board_slug, status: p.status_key, vote_count: p.vote_count,
      comment_count: p.comment_count, created_at: p.created_at, approved: p.approved, hidden: p.hidden,
      category_id: p.category_id, eta: p.eta, closes_votes: p.closes_votes, is_author: !!user && p.author_id === user.id,
      ...(team ? { impact: p.impact, confidence: p.confidence, effort: p.effort } : {}),
      ...extra,
    },
    comments, events, voters, me,
  });
});

// ---------- participation ----------

const newPost = z.object({ title: z.string().trim().min(3).max(120), body: z.string().max(10000).default(''),
  category_id: z.string().uuid().nullable().optional() });

api.post('/sites/:site/boards/:board/posts', async (c) => {
  const site = c.get('site'), user = needUser(c);
  const board = await getBoard(site, user, c.req.param('board'));
  const b = await body(c, newPost);
  await quota(site, user, 'post_created', site.config.max_posts_per_day ?? 10);
  const post = await sql.begin(async (tx) => {
    const [{ n }] = await tx<{ n: number }[]>`update tribune.site set next_post_number = next_post_number + 1 where id = ${site.id} returning next_post_number - 1 as n`;
    const [st] = await tx<{ id: string }[]>`select id from tribune.status where site_id = ${site.id} order by is_default desc, position limit 1`;
    if (!st) throw new HttpError(500, 'no_status_configured');
    if (b.category_id) {
      const [ok] = await tx`select 1 from tribune.category where id = ${b.category_id} and board_id = ${board.id}`;
      if (!ok) throw new HttpError(400, 'invalid_category');
    }
    const approved = !board.require_approval || isTeam(user);
    const [p] = await tx<any[]>`insert into tribune.post (site_id, board_id, number, title, body, author_id, category_id, status_id, approved)
      values (${site.id}, ${board.id}, ${n}, ${b.title}, ${b.body}, ${user.id}, ${b.category_id ?? null}, ${st.id}, ${approved}) returning *`;
    await tx`insert into tribune.vote (post_id, user_id, source) values (${p.id}, ${user.id}, 'author')`;
    await tx`insert into tribune.subscription (user_id, post_id) values (${user.id}, ${p.id}) on conflict do nothing`;
    await activity(site.id, p.id, user.id, 'post_created', {}, false, tx);
    await notify(site.id, (await moderatorsOf(site.id)).filter((m) => m !== user.id), p.id, 'new_post',
      { title: p.title, number: p.number, needs_approval: !p.approved }, tx);
    await emitWebhook(site, 'post.created', { number: p.number, title: p.title, body: p.body, board: board.slug, approved: p.approved }, tx);
    return p;
  });
  await sql`select tribune.refresh_trending(${post.id})`;
  return c.json({ post: { number: post.number, title: post.title, approved: post.approved } }, 201);
});

api.post('/sites/:site/posts/:number/vote', async (c) => {
  const site = c.get('site'), user = needUser(c);
  const p = await getPost(site, user, num(c.req.param('number')));
  if (p.merged_into_id) {
    const [m] = await sql<{ number: number }[]>`select number from tribune.post where id = ${p.merged_into_id}`;
    throw new HttpError(409, 'post_merged', 'this idea was merged, vote on the main one', { merged_into: m?.number });
  }
  if (p.closes_votes && !site.config.votes_on_closed) throw new HttpError(409, 'votes_closed');
  if (!p.approved) throw new HttpError(409, 'awaiting_approval');
  await quota(site, user, 'vote', site.config.max_votes_per_day ?? 100);
  const ins = await sql`insert into tribune.vote (post_id, user_id) values (${p.id}, ${user.id}) on conflict (post_id, user_id) do nothing returning id`;
  if (ins.length) {
    await sql`insert into tribune.subscription (user_id, post_id) values (${user.id}, ${p.id}) on conflict do nothing`;
    await activity(site.id, p.id, user.id, 'vote', {}, false);
    await sql`select tribune.refresh_trending(${p.id})`;
    await emitWebhook(site, 'vote.created', { number: p.number, title: p.title });
  }
  const [r] = await sql<{ vote_count: number }[]>`select vote_count from tribune.post where id = ${p.id}`;
  if (!r) throw new HttpError(404, 'post_not_found');
  return c.json({ voted: true, vote_count: r.vote_count });
});

api.delete('/sites/:site/posts/:number/vote', async (c) => {
  const site = c.get('site'), user = needUser(c);
  const p = await getPost(site, user, num(c.req.param('number')));
  if (p.merged_into_id) throw new HttpError(409, 'post_merged');
  await sql`delete from tribune.vote where post_id = ${p.id} and user_id = ${user.id}`;
  await sql`select tribune.refresh_trending(${p.id})`;
  const [r] = await sql<{ vote_count: number }[]>`select vote_count from tribune.post where id = ${p.id}`;
  if (!r) throw new HttpError(404, 'post_not_found');
  return c.json({ voted: false, vote_count: r.vote_count });
});

api.post('/sites/:site/posts/:number/comments', async (c) => {
  const site = c.get('site'), user = needUser(c), team = isTeam(user);
  const p = await getPost(site, user, num(c.req.param('number')));
  const b = await body(c, z.object({ body: z.string().trim().min(1).max(5000), parent_id: z.string().uuid().nullable().optional(),
    internal: z.boolean().default(false) }));
  if (b.internal && !team) throw new HttpError(403, 'team_only');
  if (p.merged_into_id) throw new HttpError(409, 'post_merged');
  await quota(site, user, 'comment', site.config.max_comments_per_day ?? 50);
  if (b.parent_id) {
    const [par] = await sql`select 1 from tribune.comment where id = ${b.parent_id} and post_id = ${p.id}`;
    if (!par) throw new HttpError(400, 'invalid_parent');
  }
  const official = team && !b.internal;
  const [cm] = await sql<any[]>`insert into tribune.comment (post_id, author_id, parent_id, body, internal, official)
    values (${p.id}, ${user.id}, ${b.parent_id ?? null}, ${b.body}, ${b.internal}, ${official}) returning id, created_at`;
  await activity(site.id, p.id, user.id, 'comment', { internal: b.internal }, false);
  if (!b.internal) {
    await sql`insert into tribune.subscription (user_id, post_id) values (${user.id}, ${p.id}) on conflict do nothing`;
    await sql`select tribune.refresh_trending(${p.id})`;
  }
  if (official) {
    await notify(site.id, await audienceOf(p.id, user.id), p.id, 'team_reply', { title: p.title, number: p.number, message: b.body.slice(0, 500) });
  }
  return c.json({ comment: cm }, 201);
});

api.post('/sites/:site/posts/:number/subscribe', async (c) => {
  const site = c.get('site'), user = needUser(c);
  const p = await getPost(site, user, num(c.req.param('number')));
  await sql`insert into tribune.subscription (user_id, post_id) values (${user.id}, ${p.id}) on conflict do nothing`;
  return c.json({ subscribed: true });
});
api.delete('/sites/:site/posts/:number/subscribe', async (c) => {
  const site = c.get('site'), user = needUser(c);
  const p = await getPost(site, user, num(c.req.param('number')));
  await sql`delete from tribune.subscription where user_id = ${user.id} and post_id = ${p.id}`;
  return c.json({ subscribed: false });
});

api.get('/sites/:site/roadmap', async (c) => {
  const site = c.get('site'), user = c.get('user');
  const statuses = await sql<any[]>`select id, key, label, color from tribune.status where site_id = ${site.id} and on_roadmap order by position`;
  const posts = await sql<any[]>`
    select p.number, p.title, p.vote_count, p.eta, s.key as status, b.slug as board, b.name as board_name
    from tribune.post p join tribune.status s on s.id = p.status_id join tribune.board b on b.id = p.board_id
    where p.site_id = ${site.id} and s.on_roadmap and p.merged_into_id is null and not p.hidden and p.approved and ${boardVisible(user)}
    order by p.vote_count desc limit 600`;
  return c.json({ columns: statuses.map((s) => ({ ...s, posts: posts.filter((p) => p.status === s.key) })) });
});

api.get('/sites/:site/changelog', async (c) => {
  const site = c.get('site'), team = isTeam(c.get('user'));
  const entries = await sql`
    select ch.id, ch.title, ch.body, ch.published_at, ch.created_at,
      coalesce((select json_agg(json_build_object('number', p.number, 'title', p.title, 'vote_count', p.vote_count))
        from tribune.changelog_post cp join tribune.post p on p.id = cp.post_id where cp.changelog_id = ch.id), '[]') as posts
    from tribune.changelog ch where ch.site_id = ${site.id} ${team ? sql`` : sql`and ch.published_at is not null`}
    order by coalesce(ch.published_at, ch.created_at) desc limit 100`;
  return c.json({ entries });
});

// ---------- me: notifications, export, erasure (Law 25 / GDPR) ----------

api.get('/sites/:site/me/notifications', async (c) => {
  const user = needUser(c);
  const rows = await sql`select id, type, payload, read_at, created_at from tribune.notification
    where user_id = ${user.id} order by created_at desc limit 50`;
  return c.json({ notifications: rows });
});
api.post('/sites/:site/me/notifications/read', async (c) => {
  const user = needUser(c);
  await sql`update tribune.notification set read_at = now() where user_id = ${user.id} and read_at is null`;
  return c.json({ ok: true });
});
api.patch('/sites/:site/me', async (c) => {
  const user = needUser(c);
  const b = await body(c, z.object({ email_opt_out: z.boolean().optional(), locale: z.enum(['fr', 'en']).optional(), name: z.string().trim().min(1).max(120).optional() }));
  await sql`update tribune.app_user set email_opt_out = coalesce(${b.email_opt_out ?? null}, email_opt_out),
    locale = coalesce(${b.locale ?? null}, locale), name = coalesce(${b.name ?? null}, name) where id = ${user.id}`;
  return c.json({ ok: true });
});
api.get('/sites/:site/me/export', async (c) => {
  const user = needUser(c);
  const [posts, votes, comments, notifications] = await Promise.all([
    sql`select number, title, body, created_at from tribune.post where author_id = ${user.id}`,
    sql`select p.number, p.title, v.created_at, v.source, v.note from tribune.vote v join tribune.post p on p.id = v.post_id where v.user_id = ${user.id}`,
    sql`select p.number, c.body, c.created_at from tribune.comment c join tribune.post p on p.id = c.post_id where c.author_id = ${user.id} and not c.internal`,
    sql`select type, payload, created_at from tribune.notification where user_id = ${user.id}`,
  ]);
  return c.json({ user: publicMe(user), posts, votes, comments, notifications });
});
api.delete('/sites/:site/me', async (c) => {
  const user = needUser(c);
  await eraseUser(user.id);
  return c.json({ erased: true });
});

// Posts stay (others voted on them) but lose their author; votes, comments
// text, sessions and notifications of the person disappear.
async function eraseUser(id: string) {
  await sql.begin(async (tx) => {
    await tx`update tribune.comment set body = '[supprimé / deleted]', deleted_at = now() where author_id = ${id}`;
    await tx`delete from tribune.app_user where id = ${id}`;
  });
}

// ---------- team: triage, statuses, merge, vote on behalf, backlog ----------

const patchPost = z.object({
  title: z.string().trim().min(3).max(120).optional(), body: z.string().max(10000).optional(),
  category_id: z.string().uuid().nullable().optional(), board: z.string().optional(),
  status: z.string().max(40).optional(), message: z.string().max(2000).optional(), notify: z.boolean().default(true),
  impact: z.number().int().min(1).max(3).nullable().optional(), confidence: z.number().min(0.1).max(1).nullable().optional(),
  effort: z.number().positive().max(9999).nullable().optional(), eta: z.string().max(40).nullable().optional(),
  hidden: z.boolean().optional(), approved: z.boolean().optional(),
});

api.patch('/sites/:site/posts/:number', async (c) => {
  const site = c.get('site'), user = needUser(c);
  const p = await getPost(site, user, num(c.req.param('number')));
  const b = await body(c, patchPost);
  const team = isTeam(user);
  // Authors may fix the wording of their own idea; everything else is team work.
  const authorOnly = !team && p.author_id === user.id && Object.keys(b).every((k) => ['title', 'body', 'notify'].includes(k));
  if (!team && !authorOnly) throw new HttpError(403, 'team_only');
  let status: any = null, boardId: string | null = null;
  if (b.status && b.status !== p.status_key) {
    [status] = await sql<any[]>`select * from tribune.status where site_id = ${site.id} and key = ${b.status}`;
    if (!status) throw new HttpError(400, 'unknown_status');
  }
  if (b.board && b.board !== p.board_slug) {
    const [nb] = await sql<{ id: string }[]>`select id from tribune.board where site_id = ${site.id} and slug = ${b.board}`;
    if (!nb) throw new HttpError(400, 'unknown_board');
    boardId = nb.id;
  }
  if (b.category_id) {
    const [ok] = await sql`select 1 from tribune.category where id = ${b.category_id} and board_id = ${boardId ?? p.board_id}`;
    if (!ok) throw new HttpError(400, 'invalid_category');
  }
  const has = (k: keyof typeof b) => Object.prototype.hasOwnProperty.call(b, k);
  await sql.begin(async (tx) => {
  await tx`update tribune.post set
      title = ${b.title ?? p.title}, body = ${b.body ?? p.body},
      category_id = ${has('category_id') ? b.category_id ?? null : p.category_id},
      board_id = ${boardId ?? p.board_id}, status_id = ${status?.id ?? p.status_id},
      impact = ${has('impact') ? b.impact ?? null : p.impact}, confidence = ${has('confidence') ? b.confidence ?? null : p.confidence},
      effort = ${has('effort') ? b.effort ?? null : p.effort}, eta = ${has('eta') ? b.eta ?? null : p.eta},
      hidden = ${b.hidden ?? p.hidden}, approved = ${b.approved ?? p.approved}, updated_at = now()
    where id = ${p.id}`;
  if (b.approved === true && !p.approved) await activity(site.id, p.id, user.id, 'approved', {}, false, tx);
  if (status) {
    const [old] = await tx<any[]>`select label from tribune.status where id = ${p.status_id}`;
    await activity(site.id, p.id, user.id, 'status_changed', { from: p.status_key, to: status.key, from_label: old?.label, to_label: status.label, message: b.message ?? null }, true, tx);
    if (b.notify) {
      const audience = await audienceOf(p.id, user.id, tx);
      const byLocale = await tx<{ id: string; locale: string | null }[]>`select id, locale from tribune.app_user where id in ${sql(audience.length ? audience : ['00000000-0000-0000-0000-000000000000'])}`;
      for (const loc of ['fr', 'en'] as const) {
        const ids = byLocale.filter((u) => (u.locale ?? site.default_locale) === loc).map((u) => u.id);
        await notify(site.id, ids, p.id, 'status_changed', { title: b.title ?? p.title, number: p.number, status: status.label[loc] ?? status.key, status_key: status.key, message: b.message ?? null }, tx);
      }
    }
    await emitWebhook(site, 'post.status_changed', { number: p.number, title: p.title, from: p.status_key, to: status.key, message: b.message ?? null }, tx);
  }
  });
  return c.json({ ok: true });
});

api.post('/sites/:site/posts/:number/merge', async (c) => {
  const site = c.get('site'), user = needTeam(c);
  const { into } = await body(c, z.object({ into: z.number().int().positive() }));
  const res = await sql.begin(async (tx) => {
    const dup = await getPost(site, user, num(c.req.param('number')), tx);
    const master = await getPost(site, user, into, tx);
    if (dup.id === master.id) throw new HttpError(400, 'same_post');
    if (dup.merged_into_id) throw new HttpError(409, 'already_merged');
    if (master.merged_into_id) throw new HttpError(409, 'target_is_merged');
    await tx`select id from tribune.post where id in (${dup.id}, ${master.id}) for update`;
    // Votes move unless the person already voted on the main idea; origin_post_id lets unmerge put them back.
    const moved = await tx`update tribune.vote v set post_id = ${master.id}, origin_post_id = ${dup.id}
      where v.post_id = ${dup.id} and not exists (select 1 from tribune.vote w where w.post_id = ${master.id} and w.user_id = v.user_id)
      returning v.user_id`;
    await tx`update tribune.comment set post_id = ${master.id}, origin_post_id = ${dup.id} where post_id = ${dup.id}`;
    await tx`insert into tribune.subscription (user_id, post_id) select user_id, ${master.id} from tribune.subscription where post_id = ${dup.id} on conflict do nothing`;
    await tx`update tribune.post set merged_into_id = ${master.id}, updated_at = now() where id = ${dup.id}`;
    await activity(site.id, master.id, user.id, 'merged_in', { number: dup.number, title: dup.title, moved_votes: moved.length }, true, tx);
    await activity(site.id, dup.id, user.id, 'merged_into', { number: master.number, title: master.title }, true, tx);
    const audience = await audienceOf(dup.id, user.id, tx);
    const fromMoved = await tx<{ user_id: string }[]>`select user_id from tribune.vote where origin_post_id = ${dup.id}`;
    await notify(site.id, [...new Set([...audience, ...fromMoved.map((r) => r.user_id)])].filter((u) => u !== user.id), master.id, 'merged',
      { title: dup.title, number: master.number, into_title: master.title, into_number: master.number }, tx);
    await emitWebhook(site, 'post.merged', { number: dup.number, into: master.number, moved_votes: moved.length }, tx);
    return { dup, master, moved: moved.length };
  });
  await sql`select tribune.refresh_trending(${res.master.id})`;
  return c.json({ merged: true, into: res.master.number, moved_votes: res.moved });
});

api.post('/sites/:site/posts/:number/unmerge', async (c) => {
  const site = c.get('site'), user = needTeam(c);
  const res = await sql.begin(async (tx) => {
    const dup = await getPost(site, user, num(c.req.param('number')), tx);
    if (!dup.merged_into_id) throw new HttpError(409, 'not_merged');
    const back = await tx`update tribune.vote set post_id = ${dup.id}, origin_post_id = null where origin_post_id = ${dup.id} returning id`;
    await tx`update tribune.comment set post_id = ${dup.id}, origin_post_id = null where origin_post_id = ${dup.id}`;
    await tx`update tribune.post set merged_into_id = null, updated_at = now() where id = ${dup.id}`;
    await activity(site.id, dup.id, user.id, 'unmerged', { restored_votes: back.length }, true, tx);
    return { dup, master: dup.merged_into_id as string, back: back.length };
  });
  await sql`select tribune.refresh_trending(${res.dup.id})`;
  await sql`select tribune.refresh_trending(${res.master})`;
  return c.json({ unmerged: true, restored_votes: res.back });
});

// Support, sales or a billing hook attach a real customer to an idea, with their words and the ticket link.
api.post('/sites/:site/posts/:number/votes', async (c) => {
  const site = c.get('site'), team = needTeam(c);
  const p = await getPost(site, team, num(c.req.param('number')));
  if (p.merged_into_id) throw new HttpError(409, 'post_merged');
  const b = await body(c, z.object({
    email: z.string().email().max(320).optional(), external_id: z.string().max(200).optional(), name: z.string().max(120).optional(),
    company: z.object({ id: z.union([z.string(), z.number()]).transform(String), name: z.string().max(200), mrr: z.number().min(0).optional(), plan: z.string().max(60).optional() }).optional(),
    note: z.string().max(2000).optional(), source_url: z.string().url().max(1000).optional(),
  }).refine((x) => x.email || x.external_id, 'email or external_id required'));
  const voter = await upsertCustomer(site, b);
  await sql`insert into tribune.vote (post_id, user_id, created_by, source, note, source_url)
    values (${p.id}, ${voter.id}, ${team.id}, 'on_behalf', ${b.note ?? null}, ${b.source_url ?? null})
    on conflict (post_id, user_id) do update set note = coalesce(excluded.note, tribune.vote.note),
      source_url = coalesce(excluded.source_url, tribune.vote.source_url)`;
  await sql`insert into tribune.subscription (user_id, post_id) values (${voter.id}, ${p.id}) on conflict do nothing`;
  await activity(site.id, p.id, team.id, 'vote_on_behalf', { voter: voter.id }, false);
  await sql`select tribune.refresh_trending(${p.id})`;
  const [r] = await sql<{ vote_count: number }[]>`select vote_count from tribune.post where id = ${p.id}`;
  return c.json({ voted: true, vote_count: r.vote_count, user_id: voter.id }, 201);
});

async function upsertCustomer(site: Site, b: { email?: string; external_id?: string; name?: string;
  company?: { id: string; name: string; mrr?: number; plan?: string } }) {
  return sql.begin(async (tx) => {
    let companyId: string | null = null;
    if (b.company) {
      const [co] = await tx<{ id: string }[]>`insert into tribune.company (site_id, external_id, name, mrr, plan)
        values (${site.id}, ${b.company.id}, ${b.company.name}, ${b.company.mrr ?? 0}, ${b.company.plan ?? null})
        on conflict (site_id, external_id) do update set name = excluded.name, mrr = coalesce(${b.company.mrr ?? null}, tribune.company.mrr),
          plan = coalesce(excluded.plan, tribune.company.plan), updated_at = now() returning id`;
      companyId = co.id;
    }
    const [found] = await tx<User[]>`select * from tribune.app_user where site_id = ${site.id} and
      ((${b.external_id ?? null}::text is not null and external_id = ${b.external_id ?? null}) or
       (${b.email ?? null}::text is not null and lower(email) = lower(${b.email ?? null}))) limit 1`;
    if (found) {
      const [u] = await tx<User[]>`update tribune.app_user set company_id = coalesce(${companyId}, company_id),
        name = case when name = '' then coalesce(${b.name ?? null}, name) else name end where id = ${found.id} returning *`;
      return u;
    }
    const [u] = await tx<User[]>`insert into tribune.app_user (site_id, external_id, email, name, company_id)
      values (${site.id}, ${b.external_id ?? null}, ${b.email ?? null}, ${b.name ?? b.email?.split('@')[0] ?? 'client'}, ${companyId}) returning *`;
    return u;
  });
}

api.get('/sites/:site/backlog', async (c) => {
  const site = c.get('site');
  needTeam(c);
  const board = c.req.query('board');
  const allStatuses = c.req.query('all') === '1';
  const rows = await sql`
    select bl.number, bl.title, s.key as status, b.slug as board, bl.vote_count, bl.people::int as people, bl.companies::int as companies, bl.mrr::float as mrr,
      bl.weighted_votes::float as weighted_votes, bl.impact, bl.confidence::float as confidence, bl.effort::float as effort,
      bl.priority::float as priority, bl.created_at
    from tribune.backlog_v bl join tribune.status s on s.id = bl.status_id join tribune.board b on b.id = bl.board_id
    where bl.site_id = ${site.id} ${allStatuses ? sql`` : sql`and s.in_backlog`} ${board ? sql`and b.slug = ${board}` : sql``}
    order by bl.priority desc nulls last, bl.weighted_votes desc, bl.mrr desc, bl.created_at
    limit 500`;
  return c.json({ posts: rows });
});

api.get('/sites/:site/moderation', async (c) => {
  const site = c.get('site');
  needTeam(c);
  const rows = await sql`select p.number, p.title, p.body, p.created_at, b.slug as board, u.name as author_name, u.email as author_email
    from tribune.post p join tribune.board b on b.id = p.board_id left join tribune.app_user u on u.id = p.author_id
    where p.site_id = ${site.id} and not p.approved and not p.hidden and p.merged_into_id is null order by p.created_at`;
  return c.json({ posts: rows });
});

// ---------- changelog ----------

const changelogBody = z.object({ title: z.string().trim().min(3).max(160), body: z.string().max(20000).default(''),
  posts: z.array(z.number().int().positive()).max(50).default([]), publish: z.boolean().default(false) });

async function saveChangelog(site: Site, user: User, id: string | null, b: z.infer<typeof changelogBody>) {
  return sql.begin(async (tx) => {
    const [e] = id
      ? await tx<any[]>`update tribune.changelog set title = ${b.title}, body = ${b.body} where id = ${id} and site_id = ${site.id} returning *`
      : await tx<any[]>`insert into tribune.changelog (site_id, title, body, created_by) values (${site.id}, ${b.title}, ${b.body}, ${user.id}) returning *`;
    if (!e) throw new HttpError(404, 'changelog_not_found');
    await tx`delete from tribune.changelog_post where changelog_id = ${e.id}`;
    if (b.posts.length) {
      await tx`insert into tribune.changelog_post (changelog_id, post_id)
        select ${e.id}, id from tribune.post where site_id = ${site.id} and number in ${tx(b.posts)} on conflict do nothing`;
    }
    if (b.publish) {
      // Only the request that flips published_at notifies: a retry or a double click cannot send twice.
      const flipped = await tx`update tribune.changelog set published_at = now() where id = ${e.id} and published_at is null returning id`;
      if (flipped.length) {
        const linked = await tx<{ id: string; number: number; title: string }[]>`select p.id, p.number, p.title from tribune.changelog_post cp
          join tribune.post p on p.id = cp.post_id where cp.changelog_id = ${e.id}`;
        for (const p of linked) await notify(site.id, await audienceOf(p.id, user.id, tx), p.id, 'shipped', { title: p.title, number: p.number, changelog: b.title }, tx);
        await emitWebhook(site, 'changelog.published', { title: b.title, posts: linked.map((p) => p.number) }, tx);
      }
    }
    return e.id as string;
  });
}
api.post('/sites/:site/changelog', async (c) => {
  const site = c.get('site'), user = needTeam(c);
  return c.json({ id: await saveChangelog(site, user, null, await body(c, changelogBody)) }, 201);
});
api.put('/sites/:site/changelog/:id', async (c) => {
  const site = c.get('site'), user = needTeam(c);
  return c.json({ id: await saveChangelog(site, user, z.string().uuid().parse(c.req.param('id')), await body(c, changelogBody)) });
});
api.delete('/sites/:site/changelog/:id', async (c) => {
  const site = c.get('site');
  needTeam(c);
  await sql`delete from tribune.changelog where id = ${z.string().uuid().parse(c.req.param('id'))} and site_id = ${site.id}`;
  return c.json({ ok: true });
});

// ---------- people and companies (team, or the host server with its API key) ----------

api.get('/sites/:site/users', async (c) => {
  const site = c.get('site');
  needTeam(c);
  const q = c.req.query('q')?.trim();
  const rows = await sql`select u.id, u.name, u.email, u.role, u.segment, u.weight, u.banned, u.created_at, u.last_seen_at, co.name as company, co.mrr,
      (select count(*)::int from tribune.vote v where v.user_id = u.id) as votes
    from tribune.app_user u left join tribune.company co on co.id = u.company_id
    where u.site_id = ${site.id} and u.external_id is distinct from '__system__'
      ${q ? sql`and (u.name ilike ${'%' + q + '%'} or u.email ilike ${'%' + q + '%'})` : sql``}
    order by (u.role <> 'user') desc, u.last_seen_at desc limit 200`;
  return c.json({ users: rows });
});
api.patch('/sites/:site/users/:id', async (c) => {
  const site = c.get('site');
  needAdmin(c);
  const b = await body(c, z.object({ role: z.enum(['user', 'moderator', 'admin']).optional(), banned: z.boolean().optional(),
    segment: z.string().max(60).nullable().optional(), weight: z.number().min(0).max(1000).nullable().optional() }));
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
  const r = await sql`update tribune.app_user set role = coalesce(${b.role ?? null}, role), banned = coalesce(${b.banned ?? null}, banned),
    segment = case when ${has('segment')} then ${b.segment ?? null} else segment end,
    weight = case when ${has('weight')} then ${b.weight ?? null}::numeric else weight end
    where id = ${z.string().uuid().parse(c.req.param('id'))} and site_id = ${site.id} returning id`;
  if (!r.length) throw new HttpError(404, 'user_not_found');
  if (b.banned) await sql`delete from tribune.session where user_id = ${r[0].id}`;
  return c.json({ ok: true });
});
api.delete('/sites/:site/users/:id', async (c) => {
  const site = c.get('site');
  needAdmin(c);
  const [u] = await sql<{ id: string }[]>`select id from tribune.app_user where id = ${z.string().uuid().parse(c.req.param('id'))} and site_id = ${site.id}`;
  if (!u) throw new HttpError(404, 'user_not_found');
  await eraseUser(u.id);
  return c.json({ erased: true });
});
// Billing sync: keeps MRR and plan current so the backlog weighs demand by revenue.
api.put('/sites/:site/companies/:external_id', async (c) => {
  const site = c.get('site');
  needAdmin(c);
  const b = await body(c, z.object({ name: z.string().max(200), mrr: z.number().min(0).default(0), plan: z.string().max(60).nullable().optional() }));
  await sql`insert into tribune.company (site_id, external_id, name, mrr, plan) values (${site.id}, ${c.req.param('external_id')}, ${b.name}, ${b.mrr}, ${b.plan ?? null})
    on conflict (site_id, external_id) do update set name = excluded.name, mrr = excluded.mrr, plan = excluded.plan, updated_at = now()`;
  return c.json({ ok: true });
});

// ---------- settings (admin) ----------

const label = z.object({ fr: z.string().min(1).max(80), en: z.string().min(1).max(80) });

api.get('/sites/:site/settings', async (c) => {
  const site = c.get('site');
  needAdmin(c);
  const webhooks = await sql`select id, url, events, active, created_at,
    (select count(*)::int from tribune.webhook_delivery d where d.webhook_id = w.id and d.status = 'failed') as failed
    from tribune.webhook w where site_id = ${site.id}`;
  return c.json({ site: { slug: site.slug, name: site.name, domains: site.domains, default_locale: site.default_locale, config: site.config }, webhooks,
    embed: { script: `<script src="${cfg.publicUrl}/widget.js" data-site="${site.slug}" async></script>`, portal: `${cfg.publicUrl}/s/${site.slug}` } });
});
api.patch('/sites/:site/settings', async (c) => {
  const site = c.get('site');
  needAdmin(c);
  const b = await body(c, z.object({ name: z.string().min(1).max(120).optional(), domains: z.array(z.string().max(200)).max(20).optional(),
    default_locale: z.enum(['fr', 'en']).optional(), config: z.record(z.unknown()).optional() }));
  await sql`update tribune.site set name = coalesce(${b.name ?? null}, name), domains = coalesce(${b.domains ?? null}, domains),
    default_locale = coalesce(${b.default_locale ?? null}, default_locale),
    config = config || ${sql.json((b.config ?? {}) as never)} where id = ${site.id}`;
  forgetSite(site.slug);
  return c.json({ ok: true });
});
api.post('/sites/:site/settings/rotate', async (c) => {
  const site = c.get('site');
  needAdmin(c);
  const { what } = await body(c, z.object({ what: z.enum(['jwt_secret', 'api_key']) }));
  const fresh = token(32);
  if (what === 'jwt_secret') await sql`update tribune.site set jwt_secret = ${fresh} where id = ${site.id}`;
  else await sql`update tribune.site set api_key_hash = ${sha256(fresh)} where id = ${site.id}`;
  forgetSite(site.slug);
  return c.json({ [what]: fresh, note: 'shown once, store it in the host site secrets' });
});
api.put('/sites/:site/boards/:board', async (c) => {
  const site = c.get('site');
  needAdmin(c);
  const b = await body(c, z.object({ name: label, description: z.object({ fr: z.string().max(500), en: z.string().max(500) }).partial().default({}),
    visibility: z.enum(['public', 'private', 'segment']).default('public'), segments: z.array(z.string().max(60)).default([]),
    require_approval: z.boolean().default(false), position: z.number().int().default(0) }));
  const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/).parse(c.req.param('board'));
  await sql`insert into tribune.board (site_id, slug, name, description, visibility, segments, require_approval, position)
    values (${site.id}, ${slug}, ${sql.json(b.name)}, ${sql.json(b.description as never)}, ${b.visibility}, ${b.segments}, ${b.require_approval}, ${b.position})
    on conflict (site_id, slug) do update set name = excluded.name, description = excluded.description, visibility = excluded.visibility,
      segments = excluded.segments, require_approval = excluded.require_approval, position = excluded.position`;
  return c.json({ ok: true });
});
api.put('/sites/:site/statuses/:key', async (c) => {
  const site = c.get('site');
  needAdmin(c);
  const b = await body(c, z.object({ label, color: z.string().regex(/^#[0-9a-fA-F]{6}$/), position: z.number().int(),
    on_roadmap: z.boolean().default(false), closes_votes: z.boolean().default(false), is_default: z.boolean().default(false), in_backlog: z.boolean().default(false) }));
  const key = z.string().regex(/^[a-z][a-z0-9_]{1,30}$/).parse(c.req.param('key'));
  await sql.begin(async (tx) => {
    if (b.is_default) await tx`update tribune.status set is_default = false where site_id = ${site.id}`;
    await tx`insert into tribune.status (site_id, key, label, color, position, on_roadmap, closes_votes, is_default, in_backlog)
      values (${site.id}, ${key}, ${sql.json(b.label)}, ${b.color}, ${b.position}, ${b.on_roadmap}, ${b.closes_votes}, ${b.is_default}, ${b.in_backlog})
      on conflict (site_id, key) do update set label = excluded.label, color = excluded.color, position = excluded.position,
        on_roadmap = excluded.on_roadmap, closes_votes = excluded.closes_votes, is_default = excluded.is_default, in_backlog = excluded.in_backlog`;
  });
  return c.json({ ok: true });
});
api.post('/sites/:site/boards/:board/categories', async (c) => {
  const site = c.get('site'), user = needAdmin(c);
  const board = await getBoard(site, user, c.req.param('board'));
  const b = await body(c, z.object({ name: label, color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#64748b') }));
  const [r] = await sql`insert into tribune.category (board_id, name, color) values (${board.id}, ${sql.json(b.name)}, ${b.color}) returning id`;
  return c.json(r, 201);
});
api.post('/sites/:site/webhooks', async (c) => {
  const site = c.get('site');
  needAdmin(c);
  const b = await body(c, z.object({ url: z.string().url().max(1000), events: z.array(z.enum(['post.created', 'post.status_changed', 'post.merged', 'vote.created', 'changelog.published'])).min(1) }));
  await assertPublicUrl(b.url);
  const secret = token(24);
  const [r] = await sql`insert into tribune.webhook (site_id, url, secret, events) values (${site.id}, ${b.url}, ${secret}, ${b.events}) returning id`;
  return c.json({ id: r.id, secret, note: 'secret shown once: verify X-Tribune-Signature = sha256=HMAC(secret, timestamp + "." + body)' }, 201);
});
api.delete('/sites/:site/webhooks/:id', async (c) => {
  const site = c.get('site');
  needAdmin(c);
  await sql`delete from tribune.webhook where id = ${z.string().uuid().parse(c.req.param('id'))} and site_id = ${site.id}`;
  return c.json({ ok: true });
});

// ---------- one-click unsubscribe (link in every email) ----------

// GET only shows a confirmation: mail security scanners open every link, and a
// GET that acted would unsubscribe people who never clicked. POST acts, which
// is also what the one-click List-Unsubscribe-Post header sends.
function checkUnsub(c: C) {
  const u = c.req.query('u') ?? '', sig = c.req.query('sig') ?? '';
  if (!/^[0-9a-f-]{36}$/.test(u) || !safeEqual(sig, unsubscribeSig(u))) throw new HttpError(400, 'bad_link');
  return { u, sig };
}
api.get('/unsubscribe', (c) => {
  const { u, sig } = checkUnsub(c);
  return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<body style="font-family:system-ui;padding:40px;max-width:480px;margin:auto">
<form method="post" action="?u=${u}&sig=${sig}"><p>Ne plus recevoir de courriels sur les idées ? / Stop emails about ideas?</p>
<button style="padding:10px 18px;font-size:16px">Confirmer / Confirm</button></form></body>`);
});
api.post('/unsubscribe', async (c) => {
  const { u } = checkUnsub(c);
  const r = await sql`update tribune.app_user set email_opt_out = true where id = ${u}`;
  if (!r.count) throw new HttpError(404, 'user_not_found');
  return c.html('<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px">Désabonnement fait. / You are unsubscribed.</body>');
});

export default api;
