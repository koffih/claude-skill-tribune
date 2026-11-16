# Running Tribune

## Reverse proxy (nginx)

Own sub-domain (`TRIBUNE_PUBLIC_URL=https://idees.example.com`):

```nginx
server {
  server_name idees.example.com;
  location / {
    proxy_pass http://127.0.0.1:8790;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;   # overwrite, never append a client-supplied value
    proxy_set_header X-Forwarded-Proto $scheme;
  }
  # listen 443 ssl; certificates by certbot
}
```

Sub-path (`TRIBUNE_PUBLIC_URL=https://www.example.com/idees`, `TRIBUNE_BASE_PATH=/idees`): `location /idees/ { proxy_pass http://127.0.0.1:8790; ... }` with no trailing path on `proxy_pass`, so the prefix reaches the service.

`TRUST_PROXY=1` (default) reads the client address from `X-Forwarded-For` for the sign-in rate limits; set it to `0` if the service is reached without a proxy.

## Environment

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | compose: bundled db | any PostgreSQL 14+ |
| `TRIBUNE_PUBLIC_URL` | `http://localhost:8790` | public address, sub-path included |
| `TRIBUNE_BASE_PATH` | empty | same sub-path, for the container health check |
| `TRIBUNE_SECRET` | required | signs unsubscribe links |
| `MAIL_MODE` | `log` | `log`, `file` (`MAIL_DIR`), `smtp` (`SMTP_URL`), `resend` (`RESEND_API_KEY`) |
| `MAIL_FROM` | | default sender; per site `config.mail_from` |
| `PORT` / `TRIBUNE_PORT` | 8790 | inside / outside the container |
| `TRIBUNE_JOBS` | 1 | 0 on extra replicas if several run (jobs are safe in parallel anyway) |
| `SESSION_DAYS` | 30 | session length |
| `WEBHOOK_ALLOW_PRIVATE` | 0 | 1 only for tests: lets webhooks reach private addresses |
| `TRIBUNE_DEMO` | 0 | 1 exposes `/demo/<site>`, a fake host page: sandbox only |

## Backups

The bundled database is the `tribune-db` volume. Daily dump:
`docker compose exec -T db pg_dump -U tribune -Fc tribune > /backup/tribune-$(date +%F).dump`
When `DATABASE_URL` points at the site's Supabase, the site's own backups already include the `tribune` schema.

## The weekly pass (30 minutes per site)

A board nobody answers turns into a complaint wall. Same day each week:

1. **Moderation** tab, then the newest ideas (sort *Récentes*): merge duplicates into the clearer one, set the category, answer as the team when the idea is unclear.
2. Ideas without status after two weeks: *under review* (with a sentence on what you need to know) or *declined* (with the reason). A decline with a reason keeps trust; silence does not.
3. **Priorities**: score impact, confidence and effort on the ideas you would consider; read people, accounts and revenue next to the priority before deciding. Move the chosen ones to *planned* with an honest horizon ("this quarter", not a date).
4. Shipped: *complete*, then a **What's new** entry linked to the ideas.
5. Anything planned for more than 30 days without movement: say so in a status message.

## API, quick reference

Base `/api/v1/sites/{site}`. Auth: `Authorization: Bearer <session>` (from `/auth/identify`, `/auth/verify`) or `X-Tribune-Key` (admin of that site).

| Who | Method and route |
|---|---|
| anyone | `GET /config`, `GET /boards/{board}/posts?sort=trending\|top\|new&status=&category=&q=&mine=votes\|posts&page=`, `GET /posts/similar?q=`, `GET /posts/{n}`, `GET /roadmap`, `GET /changelog` |
| auth | `POST /auth/identify {token}`, `POST /auth/magic {email,name?,locale?,return_to?}`, `POST /auth/verify {token}`, `POST /auth/logout` |
| user | `POST /boards/{board}/posts`, `POST\|DELETE /posts/{n}/vote`, `POST /posts/{n}/comments {body,parent_id?}`, `POST\|DELETE /posts/{n}/subscribe`, `GET /me/notifications`, `POST /me/notifications/read`, `PATCH /me`, `GET /me/export`, `DELETE /me`; authors may `PATCH /posts/{n}` title and body |
| team | `PATCH /posts/{n}` (status + message, category, board, impact, confidence, effort, eta, hidden, approved), `POST /posts/{n}/merge {into}`, `POST /posts/{n}/unmerge`, `POST /posts/{n}/votes`, internal comments, `GET /backlog`, `GET /moderation`, `POST\|PUT\|DELETE /changelog`, `GET /users` |
| admin | `PATCH /users/{id}`, `DELETE /users/{id}`, `PUT /companies/{id}`, `GET\|PATCH /settings`, `POST /settings/rotate {what: jwt_secret\|api_key}`, `PUT /boards/{slug}`, `PUT /statuses/{key}`, `POST /boards/{board}/categories`, `POST\|DELETE /webhooks` |

Errors are JSON `{error, message}`: `sign_in_required` 401, `team_only` 403, `post_merged` 409 (with `merged_into`), `votes_closed` 409, `daily_limit` 429.

## Data model

`site` (secrets, config), `company` (MRR), `app_user` (per site), `session`, `magic_link`, `board`, `category`, `status`, `post` (counters and trending kept by the database), `vote` (one per person and post; `source`, `note`, `source_url`, `origin_post_id` for unmerge), `comment` (`internal`, `official`), `subscription`, `activity` (public timeline and quota journal), `notification` (in-app and email queue), `changelog` + `changelog_post`, `webhook` + `webhook_delivery`. View `backlog_v` computes people, companies, MRR once per company, weighted votes and priority. Schema: `service/sql/001_init.sql`.
