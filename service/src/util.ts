import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { cfg } from './config.js';

export const token = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const hmac = (key: string, s: string) => createHmac('sha256', key).update(s).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const unsubscribeSig = (userId: string) => hmac(cfg.secret, `unsub:${userId}`).slice(0, 32);

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string, public extra?: Record<string, unknown>) {
    super(message ?? code);
  }
}

export type Locale = 'fr' | 'en' | 'es';
export const LOCALES = ['fr', 'en', 'es'] as const;
export function pickLocale(v: unknown, fallback: Locale): Locale {
  return v === 'fr' || v === 'en' || v === 'es' ? v : fallback;
}

// Very small in-memory limiter for unauthenticated endpoints (magic links,
// identify). Per-user daily limits live in the database instead.
const buckets = new Map<string, { n: number; reset: number }>();
export function limit(key: string, max: number, windowMs: number): void {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) { buckets.set(key, { n: 1, reset: now + windowMs }); return; }
  if (++b.n > max) throw new HttpError(429, 'rate_limited', 'too many requests, try again later');
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60_000).unref();
