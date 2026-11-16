# Integrating a site with Tribune

Three pieces: the widget line, a token signed by the site's **server** for the signed-in user, and optional server hooks with the site API key. Replace `https://idees.example.com` with the instance address and `monsite` with the site slug.

## 1. The widget

```html
<script src="https://idees.example.com/widget.js" data-site="monsite" async></script>
```

| Attribute | Default | Meaning |
|---|---|---|
| `data-site` | required | site slug |
| `data-token` | none | signed token for the current user (section 2) |
| `data-position` | `bottom-right` | `bottom-left`, or `none` to open it from your own button |
| `data-label` | "Vos idées" / "Feedback" | launcher text and panel title |
| `data-lang` | page `lang` | `fr` or `en` |

```js
Tribune.identify(token)   // after a sign-in that happens without reload
Tribune.open()            // ideas; also 'roadmap', 'changelog', 'p/12'
Tribune.close()
Tribune.logout()
```

The panel is an iframe on the Tribune origin, so the site's CSS and Tribune's never collide. Allow the site's origins in `domains` (create-site `--domains`, or Settings), which become the `frame-ancestors` policy.

A full-page link also works: `https://idees.example.com/s/monsite/`. To arrive signed in, append `?sso=<token>`; the page trades it for a session and removes it from the address bar.

## 2. The token (HS256, signed on the server)

Claims:

| Claim | Required | Notes |
|---|---|---|
| `sub` | `sub` or `email` | your stable user id |
| `email` | | trusted as verified (your site vouches for it), used for notifications |
| `name`, `avatar` | | display |
| `locale` | | `fr` or `en`, language of the panel and of emails |
| `segment` | | e.g. `paying`, `free`, `internal`: weight comes from the site's `segment_weights` |
| `weight` | | explicit vote weight, overrides the segment |
| `role` | | `moderator` or `admin` for your staff (disable with `allow_role_claim: false`) |
| `company` | | `{ "id": "...", "name": "...", "mrr": 1200, "plan": "pro" }`: revenue counted once per company |
| `iat` | yes | issued-at; tokens older than one day are refused |
| `exp` | recommended | 10 minutes is enough: the token only opens a session (30 days) |

The secret is the site's `jwt_secret` from `create-site`. It must never reach the browser.

### Node, Express or any server (no dependency)

```js
import { createHmac } from 'node:crypto';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

export function tribuneToken(user, secret = process.env.TRIBUNE_JWT_SECRET) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub: String(user.id), email: user.email, name: user.name, locale: user.locale,
    segment: user.plan === 'free' ? 'free' : 'paying', iat: now, exp: now + 600 });
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}
```

`examples/host-node.mjs` is a complete host page using it.

### Next.js (App Router), server component

```tsx
// app/layout.tsx (server)
import Script from 'next/script';
import { tribuneToken } from '@/lib/tribune';   // the function above
import { getCurrentUser } from '@/lib/auth';

export default async function Layout({ children }) {
  const user = await getCurrentUser();
  return (<html lang="fr"><body>{children}
    <Script src="https://idees.example.com/widget.js" data-site="monsite"
      data-token={user ? tribuneToken(user) : undefined} strategy="lazyOnload" />
  </body></html>);
}
```

Pages that are statically cached must not embed a user token: in that case expose a small route (`GET /api/tribune-token`, authenticated) and call `Tribune.identify(await fetch(...).then(r => r.text()))` on the client.

### Vite or React SPA backed by Supabase: Edge Function

```ts
// supabase/functions/tribune-token/index.ts
import { createClient } from 'jsr:@supabase/supabase-js@2';
const enc = new TextEncoder();
const b64 = (s: Uint8Array | string) => btoa(typeof s === 'string' ? s : String.fromCharCode(...s))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

Deno.serve(async (req) => {
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: req.headers.get('Authorization')! } } });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('unauthorized', { status: 401 });
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ sub: user.id, email: user.email, name: user.user_metadata?.full_name, iat: now, exp: now + 600 }));
  const key = await crypto.subtle.importKey('raw', enc.encode(Deno.env.get('TRIBUNE_JWT_SECRET')!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${head}.${body}`)));
  return new Response(`${head}.${body}.${b64(sig)}`, { headers: { 'content-type': 'text/plain', 'Access-Control-Allow-Origin': '*' } });
});
```

Client side, after the Supabase session exists:

```js
const { data } = await supabase.functions.invoke('tribune-token');
window.Tribune ? Tribune.identify(data) : (window.Tribune = { q: [['identify', data]] });
```

(The widget replays calls queued in `window.Tribune.q` when it loads.) Set the secret with `supabase secrets set TRIBUNE_JWT_SECRET=...`.

### Python

```python
import base64, hashlib, hmac, json, time
def _b64(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def tribune_token(user, secret):
    now = int(time.time())
    head = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = _b64(json.dumps({"sub": str(user.id), "email": user.email, "name": user.name, "iat": now, "exp": now + 600}).encode())
    sig = _b64(hmac.new(secret.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest())
    return f"{head}.{body}.{sig}"
```

### PHP (WordPress, Laravel)

```php
function tribune_token(array $u, string $secret): string {
  $b64 = fn($s) => rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
  $now = time();
  $head = $b64(json_encode(['alg' => 'HS256', 'typ' => 'JWT']));
  $body = $b64(json_encode(['sub' => (string)$u['id'], 'email' => $u['email'], 'name' => $u['name'], 'iat' => $now, 'exp' => $now + 600]));
  return "$head.$body." . $b64(hash_hmac('sha256', "$head.$body", $secret, true));
}
// WordPress: in wp_footer, only when is_user_logged_in(); never put the secret in a theme file committed to git.
```

## 3. Server hooks (API key)

Header `X-Tribune-Key: <api_key>`; base `https://idees.example.com/api/v1/sites/monsite`. The key acts as an admin of that site only.

| Need | Call |
|---|---|
| Keep revenue current (billing webhook, nightly job) | `PUT /companies/{your company id}` `{"name":"Acme","mrr":1200,"plan":"pro"}` |
| Support adds a customer's vote | `POST /posts/{n}/votes` `{"email":"c@x.com","name":"Chloé","company":{"id":"acme","name":"Acme"},"note":"their words","source_url":"https://desk/t/42"}` |
| File an idea from your own form | identify the user first, then `POST /boards/{board}/posts` with their bearer token |
| Read the backlog | `GET /backlog` (`?all=1` for every status, `?board=idees`) |
| Change a status from your tracker | `PATCH /posts/{n}` `{"status":"in_progress","message":"..."}` |
| Webhooks | `POST /webhooks` `{"url":"https://...","events":["post.created","post.status_changed"]}` returns the signing secret once |

Verifying a webhook: `X-Tribune-Signature: sha256=<hex>` where hex = HMAC-SHA256(secret, `X-Tribune-Timestamp` + "." + raw body). Reject when the timestamp is more than 5 minutes old.

## 4. Check in a browser

Signed in on the site: open the widget, the header shows the user's name (not "Se connecter"); post an idea, the vote counter shows 1 and is pressed; as staff (token with `role: admin`), the idea page shows *Gestion de l'idée*. Hide the test idea afterwards.
