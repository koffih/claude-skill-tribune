import { SignJWT } from 'jose';

export const app = (await import('../src/main.js')).buildApp();
export const { sql, migrate } = await import('../src/db.js');
export const { createSite } = await import('../src/sites.js');
export const { flushEmails } = await import('../src/events.js');

export async function call(method: string, path: string, opts: { token?: string; key?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.key) headers['x-tribune-key'] = opts.key;
  const r = await app.request(`/api/v1${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}

export async function sign(secret: string, claims: Record<string, unknown>, opts: { iat?: number; exp?: string } = {}) {
  let j = new SignJWT(claims).setProtectedHeader({ alg: 'HS256' });
  j = opts.iat ? j.setIssuedAt(opts.iat) : j.setIssuedAt();
  if (opts.exp) j = j.setExpirationTime(opts.exp);
  return j.sign(new TextEncoder().encode(secret));
}

export async function login(slug: string, secret: string, claims: Record<string, unknown>) {
  const r = await call('POST', `/sites/${slug}/auth/identify`, { body: { token: await sign(secret, claims, { exp: '10m' }) } });
  if (r.status !== 200) throw new Error(`identify failed ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.token as string;
}

let n = 0;
export async function freshSite() {
  const slug = `t${Date.now().toString(36)}${n++}`;
  return createSite(slug, `Test ${slug}`);
}
