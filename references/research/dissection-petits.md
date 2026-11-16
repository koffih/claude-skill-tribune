# Dissection of four small feedback tools: openheard, chorala, feedbackland, logchimp

Scope: engineering read of the code in `repos/` (read-only clones, 2026-11-16). Only what the code shows.
Licences: openheard AGPL-3.0, chorala AGPL-3.0 (except `packages/widget`, `packages/mcp`, `packages/sdk-react-native`, `packages/tsconfig`, which are MIT),
feedbackland MIT, logchimp AGPL-3.0 core plus a proprietary EE licence on `packages/server/src/ee`. Design ideas only, no code reuse
except, legally, feedbackland (MIT).

Paths below are relative to each repo root.

---

## 1. openheard (Cloudflare Workers + D1/SQLite, TanStack Start, Drizzle)

Layout: `apps/web` (one Worker: SSR app, server functions, `/api/v1`, `/api/mcp`, widget loader), `packages/db` (Drizzle schema and
SQL migrations), `packages/auth` (better-auth, KV secondary storage, Cloudflare Access), `skills/openheard` (an agent skill shipped
with the product). All writes from dashboard, REST API and MCP go through one layer, `apps/web/src/lib/ops/*` ("every write goes
through lib/ops, the same code the dashboard runs", `lib/mcp/server.ts:22`).

### 1.1 Data model (`packages/db/src/schema/feedback.ts`)
- `workspace` (id = subdomain slug, `"default"` when self-hosted) carries all per-board policy as columns: `requireApproval`,
  `whoCanPost` (`anyone|members`), `anonymousVoting`, `showRoadmap`, `showChangelog`, `widgetOrigins` (space-separated allow-list
  for framing, null = any), `widgetSettings` (JSON), `statusEmails`.
- `status` is per workspace, keyed `(workspace_id, key)`, but each has a fixed **kind** among
  `open|review|planned|progress|done|closed` plus `onRoadmap`. App logic only ever reasons on kinds, so admins can rename/recolour
  freely. Good pattern.
- `post`: integer autoincrement id, `voteCount` and `commentCount` denormalised, `mergedIntoId`, `eta` (free text),
  `statusChangedAt` (drives "stale planned" insight).
- `vote (post_id, user_id)` PK; `anonymous_vote (post_id, anon_token)` PK, separate table (migration `0008_anonymous_vote.sql`).
- `activity` (type `status|merge|pin`, from/to status, note) rendered inline in the comment timeline.
- `comment.internal` (team-only notes), `comment_reaction (comment, user, emoji)`.
- `changelog_entry` (`publishedAt`, `emailedAt` so editing a published entry never re-sends), `changelog_post` link table
  (entry closes posts), `changelog_subscriber` (`confirmedAt` null = awaiting double opt-in), `email_optout (workspace, email, kind)`
  keyed by address so it covers people without accounts.
- `api_key` stores only `hash` + `prefix`; scope `workspace|account` (account keys act in every workspace their creator administers).
- `widget_token`: id is SHA-256 of the token, never the token.
- `attachment`: R2 object `key`, unclaimed rows (no post/comment) swept nightly; uploads fail closed on rate limiter absence.

### 1.2 Anonymous voting (the distinctive part)
- Client: `apps/web/src/lib/anon-vote.ts`. A random `crypto.randomUUID()` (dashes stripped) stored in `localStorage["oh_anon_id"]`;
  the set of voted post ids is mirrored in `localStorage["oh_anon_votes"]` for UI state. No fingerprinting, no cookie.
- Server: `toggleAnonVote` in `apps/web/src/functions/posts.ts:263-283`. Gate: `workspace.anonymousVoting`. Validation: token is a
  string of 16 to 64 chars, nothing else. Toggle = select row, delete or insert into `anonymous_vote`, then
  `voteCount = max(voteCount-1,0)` or `+1`. Dedup is only the `(post_id, anon_token)` PK.
- No rate limit on this server function (the `rateLimit(` callers are help search/vote, changelog subscribe, brand match, demo,
  widget.json, MCP, REST API; grep in `apps/web/src`). Clearing localStorage or scripting fresh tokens mints unlimited votes.
- Contrast: the **help-center article** vote (`functions/help.ts:27-33`) does the opposite and explains why: voter id =
  `HMAC-SHA256(BETTER_AUTH_SECRET, "help-vote:" + networkOf(ip))` truncated to 16 bytes, where `networkOf` (`lib/help.ts:60`) keeps
  IPv4 whole and IPv6 at /64. Comment in code: "A browser token or cookie would be free to throw away and mint again for every
  request; an address is not." Plus `rateLimit("help-vote:"+network, 20/min, failClosed)`. So the better design exists in the repo,
  just not on posts.
- Anonymous voters never receive email (`lib/notify.ts:20`): no address.
- Anonymous votes are invisible to merge: `mergePosts` only moves rows of `vote`, not `anonymous_vote` (see 1.4), and imported
  vote counts have no rows at all (1.5).

### 1.3 Approval queue
- No separate table or flag: approval is a **status of kind `review`**. `createPost` (`functions/posts.ts:224-227`): if
  `workspace.requireApproval` and author is not admin, initial status = the workspace status of kind `review`.
- Visibility: list/roadmap/detail queries exclude review-kind statuses for non-admins (`functions/posts.ts:69-75, 153-160, 368, 394`);
  the author can still see their own pending post. Response returns `pending: true` so the UI can say "awaiting approval".
- Approve = ordinary status change (with activity row and status emails). Simple, but one status kind does double duty: "Under
  review" on a public roadmap (`onRoadmap: true` by default) and "pending moderation" when approval is on.

### 1.4 Merge (`apps/web/src/lib/ops/posts.ts:104-136`)
- Refuses self-merge and merging into a post that is itself merged (no chains, caller told which target to use).
- Votes: `INSERT ... SELECT` from source votes where user not already voting on target, `ON CONFLICT DO NOTHING` (one statement to
  avoid D1 bound-parameter limits). Target `voteCount += moved`, comments re-parented, `commentCount` recomputed (public only).
- Source gets `mergedIntoId` and the workspace's `closed`-kind status; two `activity` rows ("+N votes" on target).
- Old URL keeps resolving through `mergedIntoId`. Deleting a target un-merges children (`ops/posts.ts:192`).
- Duplicate candidates: `similarPosts` (`ops/posts.ts:271-291`), no AI: up to 6 distinct `[a-z0-9]{5,}` words from the text,
  LIKE on titles, rank by number of shared words then votes. Same function powers the post page "merge candidates" and the MCP
  `find_duplicates` tool. ASCII-only regex: accented words never match.

### 1.5 CSV import (Canny-style export)
- Parser: `apps/web/src/lib/csv.ts` (RFC 4180, BOM strip, quoted newlines). Column mapping is a first-match alias table (`COLS`):
  title `title|name|post title|post`; body `content|details|description|body|text`; votes `upvote count|votes|vote count|score|upvotes`;
  date `date|created|created at|createdat|created_at`; author `author|author name|user|name`; email `author email|email|user email`;
  tags `tags|labels|categories` split on `,;|`; board `board name|board|category`; status `status|state`; eta `eta|estimated`.
  "Upvote Count" and "Board Name" are Canny's export headers.
- Parsed client-side, previewed, then `importPosts` (`functions/settings.ts:228-298`, admin only, 1 to 2000 rows): boards and tags
  created by name, authors upserted by email as unverified `member` users ("accounts they can claim later"), status matched by exact
  label else by regex `STATUS_WORDS` (`settings.ts:216`) to a kind, `createdAt` preserved.
- Votes are imported as a bare `voteCount` with **no vote rows** and no voter identities.
- Export: JSON and CSV (`routes/dashboard/settings/export.tsx`).

### 1.6 Changelog, RSS, voter emails
- RSS 2.0 at `/changelog.rss` (`routes/changelog[.]rss.ts`): last 50 published entries, `version · title`, cache 300 s.
- Status emails (`lib/notify.ts`): recipients = authors + voters + commenters of the post(s) with **verified** email, minus actor,
  minus `email_optout` for kind `status`, deduped by normalised address. Changelog emails = followers of linked posts + confirmed
  subscribers. Cap `MAX_RECIPIENTS_PER_EVENT = 300` per event (Worker `waitUntil` budget), 4 concurrent senders, 2 backoffs on rate
  limit, stop on daily cap, log `sent/failed/skipped`.
- Links in mails are stateless signed tokens (`lib/email-token.ts`): `{k: status|changelog|confirm, w: workspace, e: email, x?: exp}`
  base64url + HMAC-SHA256, constant-time compare; confirm links expire after 7 days, unsubscribe links never.
- Changelog subscribe is rate limited per IP (5/10 min) and per workspace+email (2/h), fail closed (`functions/notifications.ts:34`).

### 1.7 MCP (`apps/web/src/lib/mcp/server.ts`, `routes/api/mcp.ts`, `docs/mcp.md`)
- Streamable MCP on the same Worker, auth by API key, `rateLimit("mcp:"+key, 60/min)`.
- 58 tools: workspaces (`list_workspaces`, `create_workspace`, `get/update_workspace`, `match_website`, `apply_branding`), posts
  (`list_posts`, `get_post`, `create_post`, `update_post`, `set_status`, `bulk_set_status`, `merge_posts`, `delete_post`, `vote`,
  `add_comment`, `add_internal_note`, `list_comments`), boards/statuses/tags CRUD + `reorder_statuses`, widget
  (`get_widget_settings`, `configure_widget`, `get_widget_snippet`), help center (11 tools), changelog (`list/draft/update/publish/
  delete_changelog`), integrations (`connect_slack|discord|webhook`, `send_test`, `disconnect`), members, and two analysis tools:
  `summarize_feedback`, `find_duplicates`.
- Conventions worth copying: every tool gets an optional `workspace` arg and every result echoes the workspace it acted on
  (`named()`); destructive tools get a `confirm` arg and are refused until `confirm: true` with an instruction to ask the user;
  MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) set centrally; ids or names accepted for boards/statuses/tags;
  `create_post` description tells the agent to call `find_duplicates` first.
- `summarize_feedback` (`lib/ops/insights.ts`): deterministic weekly review: counts by status/board, top voted (excluding done and
  closed kinds), rising this week (votes in last 7 days), stale planned/in-progress (> 30 days in status), open posts with no admin
  comment ("needs reply"). No LLM.

### 1.8 Widget
- Script loader `lib/widget-loader.js` builds launcher + panel and an **iframe** to `/widget`; talks to it via `postMessage` with an
  explicit target origin. Framing restricted by `workspace.widgetOrigins`.
- Auth inside the iframe: third-party cookies are not sent, so after a first-party popup sign-in the iframe holds a short-lived
  `widget_token` in `sessionStorage` (partitioned per embedding site) sent as header `x-openheard-widget` (`lib/widget-auth.ts`).

---

## 2. chorala (Hono API + Next.js dashboard + BullMQ worker, Postgres + pgvector, Redis)

Layout: `apps/api` (Hono, public `/v1/public/*` with project key), `apps/dashboard` (Next.js admin + hosted portal),
`apps/worker` (BullMQ workers: ai, webhooks, email, integrations, notifications, weekly digest cron `0 8 * * 1`),
`packages/core/src/services/*` (business logic), `packages/ai` (provider abstraction + tasks), `packages/widget` (embeddable),
`packages/mcp`, `packages/sdk`. Design docs in-repo: `SPEC.md`, `DECISIONS.md`, `BUILD_PLAN.md` (phases are cited in comments).

### 2.1 Identify: exact JWT payload
`packages/types/src/common.ts:106-123` (zod):
```
{ id: string (required, host's user id),
  email?: email, name?: string, avatar?: url,
  segment?: Record<string, unknown>,
  company?: { id: string (required, host's company id), name?, domain?, mrr?: int >= 0 (whole currency units), plan?: string } }
```
- Signing: host signs **HS256** with the per-project `end_user_jwt_secret` (`packages/db/src/schema.ts:133`, generated in
  `core/services/projects.ts:60`, stored in clear in the row because HMAC needs it). Verification `apps/api/src/lib/jwt.ts`:
  `jose.jwtVerify(token, secret, {algorithms:['HS256']})` then zod parse. No `iss`/`aud` check; `exp` is enforced only if present
  (jose behaviour), the schema does not require it, so a non-expiring token is accepted.
- Transport: header `x-chorala-user` on every public call (widget `packages/widget/src/api.ts:26`), alongside the public
  `x-chorala-key`. Widget API: `chorala('identify', { jwt })` re-mounts with the new header (`packages/widget/src/index.tsx:68`).
- Resolution order (`apps/api/src/lib/identity.ts`): JWT first (invalid JWT = 401, no silent fallback), else signed cookie
  `chorala_uid` (`SameSite=None; Secure; HttpOnly`, 1 year). Write endpoints call `requireEndUser`, which **creates an anonymous
  `end_users` row** and sets the cookie. So anonymous voting is cookie-backed, one DB row per cookie.
- Upsert (`core/services/endUsers.ts`): user keyed `(project_id, external_id)`; company upserted first keyed
  `(project_id, external_id)`; only fields present overwrite (`mrr: identity.mrr ?? undefined`), so a later token without `mrr`
  does not wipe an admin-edited MRR (`core/services/companies.ts:16-52`). A second path feeds the same tables: a Segment-compatible
  inbound webhook (`apps/api/src/routes/inbound.ts`, `core/services/integrations.ts:298-327`): `identify` (traits to segment) and
  `group` (name/plan/mrr/domain, links user to company), bearer = per-project signing secret.

### 2.2 Prioritisation: two separate mechanisms
1. **Revenue impact** (`core/services/posts.ts:85-100`), computed in SQL per post:
   `revenueImpact = SUM(mrr) over DISTINCT companies whose end-users voted on the post`
   (`select distinct c.id, c.mrr from votes v join end_users eu join companies c`). This is the per-account dedup: three voters from
   one company count its MRR once. Sort `revenue` = `revenueImpact desc, voteCount desc`. Filters: by company, plan, `minMrr`
   (applied to the **author's** company, not voters', `byAuthorCompany`).
2. **Weighted score** (`core/services/scoreFields.ts`): per-project `score_fields (key, label, weight double, position)`; each
   post holds admin-entered `fields jsonb {key: number}`; `score = round(Σ fields[key] × weight, 2)`; negative weights model costs
   (RICE/ICE style per schema comment `schema.ts:207`). Computed in app code after the query, sorted in memory when `sort=score`.
- The two are **not combined**: MRR never enters `score` unless an admin types it into a field. `votes.weight` (int, default 1,
  `schema.ts:387`) exists, is copied on merge, but is never read by any scoring code.
- `insights` table (`schema.ts:620-648`, `core/services/insights.ts`): Productboard-style evidence (quote, source
  manual|intercom|zendesk|email|sales|call, customer email, company) linked to a post; listed with company MRR, not summed into
  revenue impact.
- Segments (`core/services/segments.ts`): rule list compiled to SQL over `end_users`/`companies` (fields plan, locale, mrr, ...),
  used for targeting surveys/announcements and `renderVars` templating, not for scoring.

### 2.3 AI pipeline (`packages/ai/src/tasks.ts`, `packages/config/src/env.ts:48-53`)
- Providers: `ollama` (default, `llama3.1:8b` chat, `nomic-embed-text` embeddings, 768-dim `VECTOR_DIM`), `openai`, `anthropic`,
  `none`. "AI only makes it smarter, never required": every task has a no-AI fallback.
- On post create/edit, queued job `processPost`: embed (`title\n\nbody`) to `posts.embedding` (HNSW cosine index) then dedup then
  translate then LLM sentiment.
- **Dedup**: pgvector top-5 by cosine within project, excluding merged; keep `similarity >= CHORALA_AI_DEDUP_THRESHOLD` (default
  **0.86**); stored as an `ai_jobs` row (`kind=dedup`, `result.suggestions`). Admin sees them via `getDedupSuggestions` (filters
  out targets since merged). "NEVER auto-merges": merge is admin-confirmed (`core/services/posts.ts:455`); merge copies votes with
  `ON CONFLICT DO NOTHING` then recounts.
- **Autopilot extraction** (`extractFeatureRequests`): system prompt "extract product feature requests and bug reports from a
  customer support conversation... ONLY a JSON array of {title, body}, one per DISTINCT request, title <=100 chars, body in the
  customer's words, [] if none". Input truncated to 8000 chars, max 10 items, title cut at 280, body at 4000. Parse failure returns
  `[]` silently. AI disabled: first line becomes the title, whole text the body. Entry points: dashboard action and
  `POST /ai/ingest` (`apps/api/src/routes/ai.ts:47`).
- **Human review**: extracted posts are created with `reviewStatus='pending'` and `source` jsonb (`{type, url?, author?}`), hidden
  from the public board, then embedded+deduped so the reviewer sees duplicates; `approve` sets `none` (fires normal created hooks),
  `dismiss` sets `dismissed` (`core/services/posts.ts:337-390`).
- Clustering (`clusterThemes`): greedy, first cluster with cosine to its seed >= **0.7**, keep clusters of >= 2, LLM names each in
  2-4 words, table wiped and rebuilt each run (no identity across runs).
- Other tasks: thread summary, ask-your-feedback Q&A, changelog draft from posts, tag suggestion, reply draft, weekly digest.
- Spam: deterministic `detectSpam` (`core/services/moderation.ts:7-45`): >= 4 URLs, keyword list, all caps on >= 20 letters, one
  word > 50% of >= 8 words. Only flags (`flaggedReason`) for a moderation queue; `hiddenAt` hides while keeping the row.

### 2.4 Widget and i18n
- `packages/widget`: script with a command-queue API (`init {projectKey, locale, settings}`, `identify {jwt}`, `open`, `close`,
  `render(selector)`), rendered by React into a **Shadow DOM** (`mount.tsx:32`, all CSS scoped in `styles.ts`), not an iframe.
  When run inside an iframe it emits engagement events to the parent with `postMessage({source:'chorala', type}, '*')`
  (`engage.ts:19`). Includes screenshot capture with redact/highlight annotation (`Screenshot.tsx`).
- UI strings: `packages/widget/src/i18n.ts`, one dictionary per language (`en`, `es`, `fr`), `locale: 'auto'` resolves to
  `navigator.language`, fallback exact, then base language, then English, then the key itself.
- Content i18n is server-side: posts store `original_locale`; worker translates each post into every org locale via LLM (JSON
  `{title, body}`) into `post_translations (post, locale, is_auto)`; public feed overlays the translation and returns
  `displayLocale` (`core/services/publicFeed.ts:68-120`). Anonymous users get locale from `Accept-Language` at creation.
- Public API guard (`apps/api/src/middleware/public.ts`): project resolved from `X-Chorala-Key`, CORS against
  `project.allowedOrigins` (plus own portal and custom domain), Redis fixed-window rate limit per project+IP, fail open on Redis error.
  Client IP is read from the first `X-Forwarded-For` value without a trusted-proxy check.

---

## 3. feedbackland (Next.js + tRPC + Kysely, Supabase Postgres + halfvec, Firebase auth, OpenRouter) MIT

### 3.1 Data model (`db/schema.sql`, `db/migrations/2026-07-25-insights.sql`)
- `org` (subdomain, `isClaimed`, title, description, logo). Boards can exist **before** an account: created unclaimed, claimed later
  (`app/[orgSubdomain]/claim`, `queries/claim-org.ts`).
- `feedback` (title, description HTML, `category` enum `idea|issue|general feedback`, `status` enum `under consideration|planned|
  in progress|done|declined`, `upvotes numeric`, `embedding halfvec(3072)`), `comment` (threaded via `parentCommentId`, own
  `upvotes`, own embedding).
- `user_upvote (userId, contentId)` one table for both posts and comments; `user` id is Firebase uid; `user_org (role admin|user)`.
- `insights` (title, description, `ids text[]` of feedback ids, `priority`, `reach`, `momentum`, `effort s|m|l`, `signals jsonb`,
  `firstSeenAt`, `lastSeenAt`, `isArchived`, `status`), `insight_reports` (one row per run: posts total/analysed/clustered, new and
  archived counts, model). `rate_limit (key, count, windowStart)` in Postgres. `activity_seen` for admin unread state.
- Statuses are a fixed enum, no custom statuses, no boards, no tags.

### 3.2 Widget embedding (`feedbackland-react/`)
- Shipped as a **React component library**, two components:
  - `OverlayWidget` (drawer): an **iframe** of the hosted board at `https://<platformId>.feedbackland.com` (or a self-host `url`)
    with `?embed=drawer` and `?mode=` theme params. Portal and iframe are always mounted so the board preloads; a `<link
    rel=preconnect>` is acquired on hover. Readiness handshake: board posts `{type:"feedbackland:loading"}` then
    `{type:"feedbackland:ready"}`; the parent checks `event.source === iframe.contentWindow` rather than origin, because the board may
    redirect from `<uuid>.feedbackland.com` to the org subdomain (`OverlayWidget.tsx:180-200`). Shimmer until ready, timeout fallback
    with a retry key.
  - Board side: `providers/iframe.tsx` opens a **penpal** connection to `window.parent` (`allowedOrigins: ["*"]`) exposing parent API
    `{ close() }`. The proxy turns `?embed=drawer` into header `x-feedbackland-embed` so the server renders the drawer layout on first
    paint (`lib/embed-surface.ts`), overwriting any client-sent value.
  - `PopoverWidget`: no iframe; a textarea that `fetch`es `POST /api/feedback/create` with `{orgId, description}` only.
- `/api/feedback/create` (`app/api/feedback/create/route.ts`): unauthenticated, CORS `*`, rate limited per IP (20/min) then per org
  (120/min) via an atomic upsert on `rate_limit` (`queries/check-rate-limit.ts`, fails open). Each post costs 3 LLM calls
  (`queries/create-feedback-post.ts`): moderation `isInappropriateCheck` (text + image URLs) in parallel with a title+category
  generator (the user writes only a description), then embedding (`google/gemini-embedding-001`). Chat model
  `google/gemini-3.8-flash` via OpenRouter (`lib/utils-server.ts:6`).
- Upvotes require a signed-in user (`trpc/upvote-feedback-post.ts`, `userProcedure`), no anonymous voting.

### 3.3 AI insights ranking (`trpc/generate-insights.ts`, constants in `lib/insights.ts`)
Pipeline, admin-triggered:
1. Load open feedback + upvoter rows (`queries/get-insights-inputs.ts`). If > 1000 posts (`CHUNK_SIZE 200 x MAX_CHUNKS 5`), keep
   the top 1000 by `upvotes + 2*comments + 12*decay(ageDays)` so new posts are not crowded out by old ones.
2. Cluster each 200-post chunk with one LLM call (`CLUSTER_PROMPT`): output `{ids, title (imperative <70 chars), description,
   evidence, effort s|m|l, severity 0-100 with an explicit rubric, confidence 0-1}`; prompt says severity must ignore demand
   ("counting it twice would distort the ranking"). Zod-validated, 2 attempts, 90 s timeout, failed chunks dropped and reported.
3. If several chunks, a merge call returns only **index groups**; merging is done in code (lead = most severe member, ids unioned,
   effort = largest, severity = max, confidence = min), so the model cannot invent content. Failure here is tolerated.
4. Measure from data, not from the model: a post belongs to the first insight that claims it.
   - `reach = max(distinct people (authors + upvoters), postCount)`.
   - `momentumRaw = Σ_posts 2·decay(postAge) + Σ_upvotes decay(upvoteAge) + recentCommentCount`, with
     `decay(d) = 2^(-d/21)` (half-life 21 days); "recent" window 30 days.
5. Normalise per run: `reachScore = 100·reach/maxReach`, `momentumScore = 100·momentumRaw/maxMomentum`,
   `severityScore = clamp(severity,0,100)`.
6. **`priority = round(clamp((0.40·reach + 0.35·momentum + 0.25·severity) × effortMult, 0, 100))`**, effortMult s 1.06, m 1.00,
   l 0.94. Keep top 60.
7. Continuity: match new insights to stored ones by post-id overlap (`jaccard >= 0.3` or `intersection >= 2 and containment >= 0.6`),
   greedy strongest-first one-to-one, so an insight keeps id, status decision and history; `signals.previous` stores last
   priority/reach/postCount to show deltas (priority delta shown only if |Δ| >= 3). Unmatched old insights are archived. Run logged in
   `insight_reports`.
- "Top signal" badge compares the three raw component scores, not weighted contributions (`lib/insights.ts:91`).
- Also: "Ask AI" RAG over the feedback corpus (`app/api/chat/route.ts`, `queries/get-feedback-corpus.ts`) and an "improve my draft"
  rewrite with its own rate limit.

---

## 4. logchimp (Express + Knex, PostgreSQL, Vue theme) open core

### 4.1 Data model (Knex migrations, `packages/server/src/database/migrations/`)
- `users (userId uuid, name, email unique, password 72 (nullable since 2026-08), username unique, avatar, isVerified, isOwner,
  isBlocked, notes)`, `auth_identities (provider, subject unique, email, email_verified)` for OIDC.
- `posts (postId, title 100, slug unique, slugId, contentMarkdown, userId, boardId, roadmap_id)`.
- `votes (voteId, userId, postId cascade)`: no unique `(userId, postId)` index in migrations; duplicate protection is a
  check-then-insert inside a transaction in `VoteService.castVote` (`ConflictError VOTE_EXISTS`).
- `boards (boardId, name, url unique, color hex6, display, view_voters)`.
- `roadmaps (id, name, url unique, index int, color, display)`: **the roadmap is the status**. A post points at at most one roadmap
  column via `posts.roadmap_id`; there is no separate status entity. Reorder = swap `index` of two rows in two non-transactional
  UPDATEs (`ee/controllers/v1/roadmaps/sort.ts`).
- `posts_activity (type, post_id, author_id, posts_comments_id)` + `posts_comments (parent_id, body 1000, is_edited, is_spam,
  is_internal)`: comments hang off activity rows (timeline-first model).
- `settings` (site settings + labs flags + developer mode), email verification and reset-password token tables.

### 4.2 Roles and permissions
- RBAC tables: `permissions (type, action, scope?)`, `roles (name, description, is_system)`, `roles_users`, `permissions_roles`.
- Permission strings `type:action[:scope]` aggregated in SQL (`middlewares/auth/helpers.ts:94-105`, `ARRAY_AGG(CONCAT(...))`).
  Seeded: `post|board|vote|roadmap|role : read|create|update|destroy|assign|unassign`, `dashboard:read`, `settings:read|update`,
  `comment:create|create_internal|view_internal|update:own|update:any|delete:own|delete:any`.
- `isOwner` short-circuits to all permissions (`helpers.ts:65`). Every user gets the system role `@everyone` at signup
  (`repository/roles.ts`), which carries the default member permissions. Checks are inline in controllers
  (`permissions.includes("board:update")`), `authorize` middleware only checks "has any permission" and `isBlocked`.

### 4.3 Open vs enterprise
- EE code lives in `packages/server/src/ee` (proprietary licence, "may only be used in production" with a subscription), plus
  `tests/ee` and `packages/theme/src/ee`. The actual licence checker is a private git **submodule**
  `src/ee/do-not-remove` -> `logchimp/logchimp-ee` (`.gitmodules`), absent from the clone.
- Route loading (`src/routes/v1/index.ts`): with a `licenseKey` in config, EE routers are imported; otherwise only core
  `me, votes, users, settings, auth, posts` routes. Gating per route via `withLicenseGuard(handler, {requiredPlan, skipHandlerOnFailure})`.
- Plans in code: `free`, `pro`, `business`, `enterprise`.
  - pro+: boards CRUD/search, roadmaps CRUD/sort, post filter/update, comments CRUD, post activity, domain blacklist on signup/login
    (with `skipHandlerOnFailure: true`, so it silently does nothing on free).
  - business+: vote on behalf of a user (`POST/DELETE /posts/:post_id/votes/:user_id`).
  - enterprise: roles CRUD and assignment.
  - Fallback guard when the private module is missing (`middlewares/licenseGuardWrapper.ts`): only `free` routes run, others 403
    `PREMIUM_FEATURE_REQUIRED`.
- Net effect: boards, roadmap and comments, the core of a feedback tool, are behind the EE directory; the AGPL part is posts,
  votes, auth, settings, users.

---

## 5. Ideas worth taking (ranked)

1. **Status kinds under custom labels** (openheard `status.kind`): admins rename freely, code reasons on 6 fixed kinds (open,
   review, planned, progress, done, closed). Add a separate `moderation_state` instead of reusing a kind for approval.
2. **Revenue impact = Σ MRR of distinct voting accounts** (chorala `posts.ts:93`), with companies upserted from a signed identify
   and "only overwrite fields sent". Then actually fold it into the score (chorala does not).
3. **Insight score built from data, severity from the model** (feedbackland): `0.40 reach + 0.35 momentum + 0.25 severity`,
   reach = distinct people, momentum with 21-day half-life, per-run normalisation, prompt that forbids the model from counting demand.
4. **Insight identity across runs by post-id overlap** (feedbackland jaccard 0.3 / containment 0.6) so decisions, history and
   deltas survive re-clustering; archive the unmatched. chorala wipes clusters each run, avoid that.
5. **Model returns indexes, code does the merge** (feedbackland `mergeAcrossChunks`): the LLM never writes content in
   consolidation steps; chunk failures are dropped and counted, not fatal.
6. **AI-extracted feedback lands as `pending` with `source` provenance and dedup suggestions precomputed** (chorala Autopilot);
   approve/dismiss; never auto-merge; deterministic fallback when AI is off.
7. **Signed identify JWT** with `{id, email, name, avatar, segment, company{id,name,domain,mrr,plan}}` (chorala), but require
   `exp`, `iat`, an `aud` = project, and rotateable secrets.
8. **Anonymous vote identity from a keyed hash of the network** (openheard help votes: HMAC(secret, IPv4 or IPv6/64)) plus a
   fail-closed rate limit, combined with a client token; never store the IP.
9. **MCP as a first-class admin surface** sharing one ops layer with UI and REST (openheard): workspace echoed in every result,
   `confirm: true` on destructive tools, MCP hint annotations, ids-or-names arguments, `find_duplicates` before `create_post`.
10. **Close-the-loop email rules** (openheard): followers = author + voters + commenters with verified email, dedup by address,
    exclude actor, opt-out table keyed by email and kind, stateless HMAC unsubscribe tokens, `emailedAt` to never re-send, per-event
    cap with sent/failed/skipped logged, double opt-in for changelog subscribers.
11. **Merge semantics** (openheard + chorala): no chains, votes moved with `ON CONFLICT DO NOTHING` then recount from rows, comments
    re-parented, source closed with a pointer so old URLs resolve, activity entries on both sides, unmerge on target delete.
12. **Competitor CSV import with alias column map + preview** (openheard), authors become claimable unverified users. Improve:
    create real vote rows or a separate `imported_votes` counter.
13. **Embedded widget patterns**: Shadow DOM script for the light path (chorala) and iframe with a ready-handshake checked on
    `event.source`, preloading and preconnect for the full board (feedbackland); server-rendered embed layout from a proxy-set header.
14. **Description-only quick feedback** with LLM-generated title and category (feedbackland PopoverWidget), behind per-IP and
    per-org limits sized on LLM cost.
15. **Content translation stored per locale** (`post_translations`, `is_auto`, `original_locale`, `displayLocale`) rather than
    translating at read time (chorala).
16. **Deterministic weekly summary** (openheard `summarize_feedback`): rising this week, stale planned > 30 days, open posts without
    a team reply. Cheap, no LLM, very actionable.
17. **Claimable boards** (feedbackland `org.isClaimed`): let a board exist before sign-up, claim on account creation.
18. **Fine-grained permission strings with `own|any` scope** (logchimp `comment:update:own`), aggregated once per request.

## 6. Pitfalls to avoid

1. **Unthrottled anonymous tokens** (openheard posts): client-minted localStorage token, no rate limit, no server binding; trivially
   stuffed. Bind anonymous identity server-side and rate limit it.
2. **Vote counts without vote rows** (openheard import, anonymous votes outside `vote`): merges, "rising" analytics and email
   followers silently ignore them; `voteCount` drifts from reality. Keep one `vote` table with a nullable user and an identity kind.
3. **Approval and public status sharing one kind** (openheard `review`): imported posts whose status reads "open", "new" or
   "pending" are mapped to `review` by `STATUS_WORDS` (`settings.ts:217`) and become hidden when approval is on.
4. **Unused weight columns** (chorala `votes.weight`): a schema promise no code keeps. MRR and score are two disconnected
   rankings; filters by MRR use the author's company, not voters'.
5. **JWT without required `exp`/`aud`** (chorala) and HMAC secret stored in clear; trust of the first `X-Forwarded-For` hop for rate
   limiting (chorala) makes the limit spoofable. Rate limiters that fail open everywhere (chorala, feedbackland) let an outage turn
   into an LLM bill.
6. **Silent parse failures in extraction** (chorala `extractFeatureRequests` returns `[]` on bad JSON, translation `continue`s):
   ingest looks successful with nothing produced. Record the failure on the job.
7. **Clusters rebuilt from scratch each run** (chorala `feedback_clusters` delete-then-insert) lose identity and admin decisions.
8. **Fixed enums for status and category** (feedbackland) block per-team workflows; one `user_upvote` table for posts and comments
   without a type column couples two entities by uuid luck.
9. **Global table scans in tenant code** (openheard import loads every user of every workspace into a Map).
10. **Uniqueness enforced only in application code** (logchimp votes: check-then-insert, no unique index) and multi-row reorders
    without a transaction (logchimp roadmap `sort.ts`).
11. **Core features behind the proprietary directory** (logchimp: boards, roadmaps, comments are EE; the private licence module is a
    submodule) makes the "open" part unusable alone. Decide the open/paid line on features that are not table stakes.
12. **ASCII-only word matching for duplicates** (openheard `similarPosts` `[a-z0-9]{5,}`): French or accented titles never match.
    Use Unicode classes or embeddings.
13. **`postMessage(..., '*')` and penpal `allowedOrigins: ["*"]`** (chorala engage events, feedbackland board): fine for
    non-sensitive pings, never for anything carrying identity or tokens.
14. **Unauthenticated endpoints that spend LLM calls** (feedbackland create: 3 calls per post keyed only by a public org uuid):
    cap by cost, add a per-org daily budget, fail closed on limiter errors.
