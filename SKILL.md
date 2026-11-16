---
name: tribune
description: Install, configure and run Tribune, a self-hosted customer feedback and feature-voting module for any website (Canny or Fider style, one instance for many sites). Customers post ideas, vote once each, see similar ideas while typing, follow a public roadmap and changelog, and are notified on status changes; the team merges duplicates, votes on behalf of customers from support tickets, and reads a backlog ranked by weighted votes, revenue once per account, impact, confidence and effort. Use when a site needs a feedback widget, feature requests, votes on upcoming features, a public roadmap or changelog, to add a site to the instance, to sign users in without a second account, or to triage the backlog. French triggers (retours clients, recueillir les feedbacks, faire voter les clients sur les prochaines fonctionnalites, backlog pilote par les votes, boite a idees, feuille de route publique, widget de feedback, ajouter un site a Tribune, quelles idees prioriser).
argument-hint: "[install | add-site <slug> | integrate <site> | triage <site> | verify]"
---

# Tribune: feedback, votes, roadmap, backlog

**Request:** $ARGUMENTS

Tribune is a small service (Node 22, PostgreSQL, about 3 000 lines) shipped inside this skill in `service/`. One running instance serves any number of sites: every row carries a `site_id`, each site has its own boards, statuses, signing secret and API key. Customers use it through a one-line widget on the site (an iframe panel) or a full portal page; the team uses the same portal with a **Manage** tab.

It was designed after dissecting Fider, Quackback, Astuto, LogChimp, openheard, Chorala and Feedbackland, and reading the documentation of Canny, Featurebase, Frill, Nolt, UserVoice and Productboard. What was taken from whom, and why, is in [references/research.md](references/research.md). No code was copied: those projects are AGPL, Tribune is MIT.

## Pick the procedure

| The person wants to | Do |
|---|---|
| a feedback board on a site that has none | **Install** (once per server) then **Add a site** then **Integrate** |
| the same thing on another site of the same owner | **Add a site** on the existing instance, then **Integrate** |
| to know what to build next | **Triage and read the backlog** |
| to check an instance still works | **Verify** |

Default deployment: **one instance per owner**, on a server that is already public (a sub-domain like `idees.example.com`, or a sub-path). A client who must keep its data on its own server (contract, Law 25 assessment) gets its own instance instead. Each instance is independent; nothing is shared between them.

## Install (once per server)

1. Copy `service/` to the server (or clone this repository) and create `.env` from `.env.example`: `TRIBUNE_PUBLIC_URL` (public address, with the sub-path if any), `TRIBUNE_SECRET` and `POSTGRES_PASSWORD` (`openssl rand -hex 32`), mail settings.
2. `docker compose up -d --build`. It starts the service on `127.0.0.1:8790` (change with `TRIBUNE_PORT`) and its own PostgreSQL. To use an existing PostgreSQL or Supabase database instead, delete the `db` service and set `DATABASE_URL`: everything lives in a `tribune` schema, `pg_trgm` and `unaccent` are created if missing.
3. Put the reverse proxy in front (nginx block in [references/operations.md](references/operations.md)). Under a sub-path, set `TRIBUNE_PUBLIC_URL` with that path and `TRIBUNE_BASE_PATH` to the same path for the health check.
4. Mail: `MAIL_MODE=log` prints instead of sending, and is the right setting until a real sender exists. Then `smtp` with `SMTP_URL`, or `resend` with `RESEND_API_KEY`. A site can send from its own address with `config.mail_from`.
5. `curl -fsS <public url>/healthz` must answer `"ok":true`. It also reports the mail mode and the job runs, and turns red (503) when an email or a webhook has waited more than 15 minutes: point the server monitoring at it.

The schema migrates itself at every start (idempotent SQL, under an advisory lock). Background work (emails, webhooks, trending refresh, cleanup) is stored in tables, so a restart loses nothing.

## Add a site

```bash
docker compose exec tribune node dist/server/cli.js create-site <slug> "<Name>" --locale fr --domains https://www.site.com,https://app.site.com
docker compose exec tribune node dist/server/cli.js admin-link <slug> owner@site.com "Owner name"
```

`create-site` prints a **JWT secret** and an **API key** once. Store them where the host site keeps its secrets (its `.env`, its secret manager); write their location in notes, never their value. `--domains` lists the pages allowed to frame the widget (Content-Security-Policy `frame-ancestors`). The site starts with two boards (`idees`, `bugs`) and seven statuses: open, under review, planned, in progress, complete, declined, closed. `admin-link` prints a one-time sign-in link that lands on the Manage tab.

Branding and rules go in the site config (`PATCH /api/v1/sites/<slug>/settings` with the API key, or the Settings tab shows the current values): `primary_color`, `logo_url`, `home_url`, `mail_from`, `segment_weights` (default `{"paying":3,"free":1,"internal":0.5}`), `show_voters`, `max_posts_per_day`, `max_votes_per_day`, `magic_link`, `allow_role_claim`.

## Integrate a site

Read [references/integration.md](references/integration.md) for the code in Node/Next.js, Supabase Edge Functions, Python and PHP. The shape is always the same:

1. **Widget**, one line before `</body>`:
   `<script src="https://<instance>/widget.js" data-site="<slug>" async></script>`
   Options: `data-position` (`bottom-right`, `bottom-left`, `none` to use your own button), `data-label`, `data-lang`. JS API: `Tribune.open('roadmap')`, `Tribune.open('p/12')`, `Tribune.close()`.
2. **Signed-in users, no second account**: the host **server** signs a short HS256 token with the site's JWT secret and passes it as `data-token` or `Tribune.identify(token)`. Claims: `sub` (your user id) and/or `email`, `name`, `avatar`, `locale`, `segment`, `weight`, `role` (`moderator` or `admin` for your staff), `company {id, name, mrr, plan}`. `iat` is required and the token is refused after one day: sign a fresh one per page view, 10 minutes of validity is plenty. **Never sign in the browser**: the secret would be public.
3. **Visitors without an account** can sign in on the portal with an emailed one-time link (turn off with `magic_link: false`).
4. **Optional server hooks** with the API key (`X-Tribune-Key`): keep `company.mrr` current from billing (`PUT /companies/<id>`), add a customer's vote from a support ticket with their words and the ticket link (`POST /posts/<n>/votes`), receive signed webhooks (`post.created`, `post.status_changed`, `post.merged`, `vote.created`, `changelog.published`).

Then prove it in a browser: open a page of the site signed in, open the widget, check the name shown is the user's, post a test idea, vote, delete the idea from Manage (hide).

## Triage and read the backlog

What makes a board useful is the weekly pass, not the tool ([references/operations.md](references/operations.md) has the routine):

- **Moderation** tab: approve or reject posts on boards with `require_approval`.
- On each new idea: merge it into an existing one if it states the same need (votes move, nobody is counted twice, *Undo merge* puts them back), set a category, answer as the team.
- **Status changes are the promise kept**: every change can carry a message, and the author, voters and followers are notified (in the app, and by email collapsed into one message when several arrive together).
- Score what you consider building: **impact** 1 to 3, **confidence** 50, 80 or 100 %, **effort** in days. **Priorities** tab: priority = weighted votes × impact × confidence ÷ effort, with people, accounts and monthly revenue shown separately so one large account or a loud minority stays visible as such.
- When it ships: status *complete*, then a **What's new** entry linked to the ideas, which notifies everyone who asked.

To answer "what should we build next" for the owner, read `GET /api/v1/sites/<slug>/backlog` with the API key and report the top items with their signals, not only the priority number.

## Verify

From `service/` with Docker available: `bash ../scripts/test-api.sh` (API rules, 14 tests), `bash ../scripts/test-e2e.sh` (browser journey through a demo host page, screenshots in `.proof/shots/`), `bash ../scripts/test-docker.sh` (image and compose). On a live instance: `/healthz`, then the browser check above.

## Rules

- Secrets: the JWT secret and API key are per site and shown once; rotate from Settings (`POST /settings/rotate`) if one leaks, then update the host.
- Privacy (Quebec Law 25, GDPR): voters' emails are never public; each user can export (`GET /me/export`) and erase (`DELETE /me`) their data; email links are signed and unsubscribe needs a confirmation click so mail scanners cannot trigger it. Before hosting a Quebec site's users outside Quebec, the owner must assess it.
- `TRIBUNE_DEMO=1` exposes a fake host page that signs tokens for demo people: sandbox only, never in production.
- Do not enable AI features that send customer text to a paid model on a client's instance with the owner's keys.

## Not built yet

File attachments, reactions on comments, import from a Canny CSV export, semantic (embedding) duplicate detection and AI extraction of requests from support tickets. Design notes for each are at the end of [references/research.md](references/research.md).
