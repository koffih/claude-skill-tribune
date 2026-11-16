// Every setting comes from the environment, so one image serves every deployment.
function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`missing environment variable ${name}`);
  return v;
}

const publicUrl = env('TRIBUNE_PUBLIC_URL', 'http://localhost:8790').replace(/\/$/, '');
const MAIL_MODES = ['log', 'file', 'smtp', 'resend'] as const;
type MailMode = (typeof MAIL_MODES)[number];

export const cfg = {
  databaseUrl: env('DATABASE_URL'),
  port: Number(env('PORT', '8790')),
  publicUrl,
  // Path prefix when served under a sub-path (e.g. /tribune behind a proxy).
  basePath: new URL(publicUrl).pathname.replace(/\/$/, ''),
  secret: env('TRIBUNE_SECRET'),                     // signs unsubscribe links
  mailMode: env('MAIL_MODE', 'log') as MailMode,
  mailFrom: env('MAIL_FROM', 'Tribune <no-reply@localhost>'),
  mailDir: process.env.MAIL_DIR ?? './mail-out',
  smtpUrl: process.env.SMTP_URL ?? '',
  resendKey: process.env.RESEND_API_KEY ?? '',
  trustProxy: (process.env.TRUST_PROXY ?? '1') === '1',
  jobs: (process.env.TRIBUNE_JOBS ?? '1') === '1',
  sessionDays: Number(process.env.SESSION_DAYS ?? '30'),
};

// A broken mail setting must stop the start, not fail quietly on every send.
if (!MAIL_MODES.includes(cfg.mailMode)) throw new Error(`MAIL_MODE must be one of ${MAIL_MODES.join(', ')}, got "${cfg.mailMode}"`);
if (cfg.mailMode === 'smtp' && !/^smtps?:\/\//.test(cfg.smtpUrl)) throw new Error('MAIL_MODE=smtp needs SMTP_URL (smtp:// or smtps://)');
if (cfg.mailMode === 'resend' && !cfg.resendKey) throw new Error('MAIL_MODE=resend needs RESEND_API_KEY');
if (cfg.mailMode === 'log' || cfg.mailMode === 'file') {
  console.warn(`[tribune] MAIL_MODE=${cfg.mailMode}: no email leaves this server (sign-in links are printed in the log). Set smtp or resend before real users arrive.`);
}
