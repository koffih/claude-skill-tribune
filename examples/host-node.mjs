// Minimal host site: signs the Tribune token ON THE SERVER for the signed-in
// user, then embeds the widget. No dependency: HS256 is three lines of crypto.
//   TRIBUNE_URL=http://127.0.0.1:8790 TRIBUNE_SITE=demo TRIBUNE_JWT_SECRET=... node examples/host-node.mjs
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';

const { TRIBUNE_URL, TRIBUNE_SITE, TRIBUNE_JWT_SECRET, PORT = '8799' } = process.env;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

export function tribuneToken(user, secret) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ ...user, iat: now, exp: now + 600 });       // 10 minutes is plenty: it only opens a session
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

// Stand-in for your session: in a real app this is the signed-in customer.
const currentUser = (req) => {
  const as = new URL(req.url, 'http://x').searchParams.get('as') || 'lea';
  return {
    lea: { sub: 'u-42', email: 'lea@example.com', name: 'Léa Martin', segment: 'paying', locale: 'fr',
      company: { id: 'acme', name: 'Acme Inc.', mrr: 1200, plan: 'pro' } },
    sam: { sub: 'u-43', email: 'sam@example.com', name: 'Sam Lee', segment: 'free', locale: 'en' },
    anon: null,
  }[as];
};

createServer((req, res) => {
  const u = currentUser(req);
  const token = u ? tribuneToken(u, TRIBUNE_JWT_SECRET) : '';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="${u?.locale || 'fr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Site hôte de démonstration</title></head>
<body style="font-family:system-ui;margin:0;padding:40px;background:#fafaf9">
<h1>Mon application</h1><p>Connecté : ${u ? u.name : 'personne'}.</p>
<button id="roadmap" type="button">Voir la feuille de route</button>
<script src="${TRIBUNE_URL}/widget.js" data-site="${TRIBUNE_SITE}" ${token ? `data-token="${token}"` : ''} async></script>
<script>document.getElementById('roadmap').onclick = () => window.Tribune && Tribune.open('roadmap');</script>
</body></html>`);
}).listen(Number(PORT), '127.0.0.1', () => console.log(`host demo on http://127.0.0.1:${PORT}`));
