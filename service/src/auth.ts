import { jwtVerify, errors as joseErrors } from 'jose';
import { z } from 'zod';
import { sql } from './db.js';
import { cfg } from './config.js';
import { HttpError, sha256, token } from './util.js';

export type Site = {
  id: string; slug: string; name: string; domains: string[]; default_locale: 'fr' | 'en';
  jwt_secret: string; api_key_hash: string; config: SiteConfig;
};
export type SiteConfig = {
  segment_weights?: Record<string, number>;
  show_voters?: boolean;          // list of voters on a post (default true)
  votes_on_closed?: boolean;      // allow votes when status closes votes (default false)
  max_posts_per_day?: number;     // default 10
  max_votes_per_day?: number;     // default 100
  max_comments_per_day?: number;  // default 50
  allow_role_claim?: boolean;     // host JWT may grant moderator/admin (default true)
  magic_link?: boolean;           // email sign-in on the portal (default true)
  primary_color?: string;
  logo_url?: string;
  home_url?: string;
  mail_from?: string;             // sender for this site's emails, e.g. "Acme <ideas@example.com>"
};
export type User = {
  id: string; site_id: string; external_id: string | null; email: string | null; name: string;
  avatar_url: string | null; segment: string | null; weight: string | null;
  role: 'user' | 'moderator' | 'admin'; company_id: string | null; locale: 'fr' | 'en' | null;
  banned: boolean; email_verified: boolean; email_opt_out: boolean;
};
export const isTeam = (u: User | null | undefined) => !!u && (u.role === 'moderator' || u.role === 'admin');

const siteCache = new Map<string, { site: Site; at: number }>();
export async function loadSite(slug: string): Promise<Site> {
  const hit = siteCache.get(slug);
  if (hit && Date.now() - hit.at < 15_000) return hit.site;
  const [site] = await sql<Site[]>`select id, slug, name, domains, default_locale, jwt_secret, api_key_hash, config
                                   from tribune.site where slug = ${slug}`;
  if (!site) throw new HttpError(404, 'site_not_found');
  siteCache.set(slug, { site, at: Date.now() });
  return site;
}
export const forgetSite = (slug: string) => siteCache.delete(slug);

export async function createSession(user: User, site: Site): Promise<string> {
  const t = token();
  await sql`insert into tribune.session (token_hash, user_id, site_id, expires_at)
            values (${sha256(t)}, ${user.id}, ${site.id}, now() + make_interval(days => ${cfg.sessionDays}))`;
  return t;
}

export async function userFromBearer(header: string | undefined, site: Site): Promise<User | null> {
  const m = header?.match(/^Bearer\s+([A-Za-z0-9_-]{20,})$/);
  if (!m) return null;
  const [u] = await sql<User[]>`
    update tribune.app_user u set last_seen_at = now()
    from tribune.session s
    where s.token_hash = ${sha256(m[1])} and s.user_id = u.id and s.site_id = ${site.id}
      and s.expires_at > now() and not u.banned
    returning u.*`;
  return u ?? null;
}

// The host site signs this on its server with the site's secret (HS256).
// Short-lived on purpose: it only opens a session, it is not the session.
const claimsSchema = z.object({
  sub: z.string().min(1).max(200).optional(),
  id: z.union([z.string(), z.number()]).optional(),
  email: z.string().email().max(320).optional(),
  name: z.string().max(120).optional(),
  avatar: z.string().url().max(1000).optional(),
  segment: z.string().max(60).optional(),
  weight: z.number().min(0).max(1000).optional(),
  role: z.enum(['user', 'moderator', 'admin']).optional(),
  locale: z.enum(['fr', 'en']).optional(),
  company: z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    name: z.string().max(200),
    mrr: z.number().min(0).optional(),
    plan: z.string().max(60).optional(),
  }).optional(),
});

export async function identify(site: Site, jwt: string): Promise<{ token: string; user: User }> {
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(jwt, new TextEncoder().encode(site.jwt_secret), {
      algorithms: ['HS256'], maxTokenAge: '1d', requiredClaims: ['iat'],
    }));
  } catch (e) {
    const expired = e instanceof joseErrors.JWTExpired;
    throw new HttpError(401, expired ? 'token_expired' : 'token_invalid');
  }
  const c = claimsSchema.parse(payload);
  const externalId = c.sub ?? (c.id !== undefined ? String(c.id) : undefined);
  if (!externalId && !c.email) throw new HttpError(400, 'token_needs_sub_or_email');

  const user = await sql.begin(async (tx) => {
    let companyId: string | null = null;
    if (c.company) {
      const [co] = await tx<{ id: string }[]>`
        insert into tribune.company (site_id, external_id, name, mrr, plan)
        values (${site.id}, ${c.company.id}, ${c.company.name}, ${c.company.mrr ?? 0}, ${c.company.plan ?? null})
        on conflict (site_id, external_id) do update set name = excluded.name,
          mrr = coalesce(${c.company.mrr ?? null}, tribune.company.mrr),
          plan = coalesce(excluded.plan, tribune.company.plan), updated_at = now()
        returning id`;
      companyId = co.id;
    }
    const role = site.config.allow_role_claim === false ? undefined : c.role;
    const [existing] = await tx<User[]>`
      select * from tribune.app_user where site_id = ${site.id}
        and ((${externalId ?? null}::text is not null and external_id = ${externalId ?? null})
          or (${c.email ?? null}::text is not null and lower(email) = lower(${c.email ?? null})))
      order by (external_id = ${externalId ?? ''}) desc limit 1`;
    if (existing) {
      const [u] = await tx<User[]>`
        update tribune.app_user set
          external_id = coalesce(${externalId ?? null}, external_id),
          email = coalesce(${c.email ?? null}, email),
          email_verified = email_verified or ${!!c.email},
          name = coalesce(${c.name ?? null}, name),
          avatar_url = coalesce(${c.avatar ?? null}, avatar_url),
          segment = coalesce(${c.segment ?? null}, segment),
          weight = coalesce(${c.weight ?? null}, weight),
          role = coalesce(${role ?? null}, role),
          locale = coalesce(${c.locale ?? null}, locale),
          company_id = coalesce(${companyId}, company_id),
          last_seen_at = now()
        where id = ${existing.id} returning *`;
      return u;
    }
    const [u] = await tx<User[]>`
      insert into tribune.app_user (site_id, external_id, email, email_verified, name, avatar_url, segment, weight, role, locale, company_id)
      values (${site.id}, ${externalId ?? null}, ${c.email ?? null}, ${!!c.email}, ${c.name ?? (c.email ?? '').split('@')[0]},
              ${c.avatar ?? null}, ${c.segment ?? null}, ${c.weight ?? null}, ${role ?? 'user'}, ${c.locale ?? null}, ${companyId})
      returning *`;
    return u;
  });
  if (user.banned) throw new HttpError(403, 'banned');
  return { token: await createSession(user, site), user };
}

export async function createMagicLink(site: Site, email: string, name: string | undefined, returnTo: string | undefined) {
  const t = token();
  await sql`insert into tribune.magic_link (token_hash, site_id, email, name, return_to, expires_at)
            values (${sha256(t)}, ${site.id}, ${email.toLowerCase()}, ${name ?? null}, ${returnTo ?? null}, now() + interval '20 minutes')`;
  return t;
}

export async function consumeMagicLink(site: Site, t: string): Promise<{ token: string; user: User; return_to: string | null }> {
  const res = await sql.begin(async (tx) => {
    const [ml] = await tx<{ email: string; name: string | null; return_to: string | null }[]>`
      update tribune.magic_link set used_at = now()
      where token_hash = ${sha256(t)} and site_id = ${site.id} and used_at is null and expires_at > now()
      returning email, name, return_to`;
    if (!ml) throw new HttpError(400, 'link_invalid_or_used');
    const [u] = await tx<User[]>`
      insert into tribune.app_user (site_id, email, email_verified, name)
      values (${site.id}, ${ml.email}, true, ${ml.name ?? ml.email.split('@')[0]})
      on conflict (site_id, lower(email)) where email is not null
      do update set email_verified = true, last_seen_at = now()
      returning *`;
    return { user: u, return_to: ml.return_to };
  });
  if (res.user.banned) throw new HttpError(403, 'banned');
  return { ...res, token: await createSession(res.user, site) };
}

// Server-to-server calls (support desk, billing sync) act as a per-site system member.
export async function systemUser(site: Site): Promise<User> {
  const [u] = await sql<User[]>`
    insert into tribune.app_user (site_id, external_id, name, role)
    values (${site.id}, '__system__', 'Tribune', 'admin')
    on conflict (site_id, external_id) where external_id is not null do update set role = 'admin'
    returning *`;
  return u;
}
