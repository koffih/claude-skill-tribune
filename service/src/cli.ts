// Administration from the shell:  npm run cli -- <command> ...
//   migrate
//   create-site <slug> "<name>" [--locale fr|en] [--domains a.com,b.com]   prints the JWT secret and API key once
//   admin-link <slug> <email> ["<name>"]                                      makes the person admin, prints a sign-in link
//   sign <slug> <json-claims>                                                 prints a test JWT signed with the site secret
import { SignJWT } from 'jose';
import { cfg } from './config.js';
import { migrate, sql } from './db.js';
import { createSite } from './sites.js';
import { createMagicLink, loadSite } from './auth.js';

const [cmd, ...args] = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

try {
  await migrate();
  if (cmd === 'migrate') console.log('schema ok');
  else if (cmd === 'create-site') {
    const [slug, name] = args;
    if (!slug || !name) throw new Error('usage: create-site <slug> "<name>"');
    const r = await createSite(slug, name, { locale: flag('locale') as 'fr' | 'en' | 'es' | undefined, domains: flag('domains')?.split(',').filter(Boolean) });
    console.log(JSON.stringify({ ...r, portal: `${cfg.publicUrl}/s/${slug}/`, widget: `<script src="${cfg.publicUrl}/widget.js" data-site="${slug}" async></script>` }, null, 2));
    console.error('\nStore jwt_secret and api_key in the host site secrets now: they are not shown again.');
  } else if (cmd === 'admin-link') {
    const [slug, email, name] = args;
    const site = await loadSite(slug);
    await sql`insert into tribune.app_user (site_id, email, email_verified, name, role) values (${site.id}, ${email}, true, ${name ?? email.split('@')[0]}, 'admin')
      on conflict (site_id, lower(email)) where email is not null do update set role = 'admin'`;
    const t = await createMagicLink(site, email, name, `/s/${slug}/admin`);
    console.log(`${cfg.publicUrl}/s/${slug}/auth?token=${t}`);
  } else if (cmd === 'sign') {
    const [slug, claims] = args;
    const site = await loadSite(slug);
    console.log(await new SignJWT(JSON.parse(claims)).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('10m')
      .sign(new TextEncoder().encode(site.jwt_secret)));
  } else {
    console.error('commands: migrate | create-site | admin-link | sign');
    process.exitCode = 2;
  }
} finally {
  await sql.end();
}
