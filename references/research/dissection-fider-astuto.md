# Engineering dissection: Fider and Astuto

Scope: design study only. Both projects are AGPL; nothing here is code to copy, only observations of what the code does.
Paths are relative to the root of a shallow clone of each project (November 2026).
Fider = Go + React + PostgreSQL (raw SQL migrations, hand-written SQL). Astuto = Rails 6 + React + PostgreSQL (ActiveRecord, Devise, Pundit, Sidekiq).
"Not found" means a grep of the tree found nothing; it is a statement about this checkout only.

---

## PART A: FIDER

### A1. Data model (fider/migrations/*.sql, 96 files)

Core tables and their final shape after all migrations:

| Table | Key columns | Constraints / indexes | Source |
|---|---|---|---|
| `tenants` | name, subdomain, cname, status, is_private, locale, is_email_auth_allowed, is_moderation_enabled, is_signup_disabled, is_feed_enabled, prevent_indexing, is_pro, custom_css, allowed_schemes, welcome_header, description_template, scheduled_deletion_at, deletion_cancel_key | unique `subdomain`; unique `cname WHERE cname != ''` | 201701261850, 201712061924, 202107031320, 202511041300, 202606101200, 202610131200 |
| `users` | tenant_id, name, email, role (1 visitor, 2 collaborator, 3 admin), status (1 active, 2 deleted, 3 blocked), api_key, avatar_type/bkey, email_supressed_at, is_trusted, security_stamp | unique `(tenant_id, email) WHERE email != ''`; unique `(tenant_id, api_key)`; unique `(tenant_id, id)`; partial index `(tenant_id, is_trusted) WHERE is_trusted` | 201712061924, 201808181931, 202109052023, 202511041300, 202603201300; enums `app/models/enum/user_role.go`, `user_status.go` |
| `user_providers` | user_id, provider, provider_uid, tenant_id | PK `(user_id, provider)` | 201702251213, 201803011831 |
| `posts` (was `ideas`) | tenant_id, number, slug, title(100), description, user_id, status, response, response_user_id, response_date, original_id (self FK), is_approved, language TEXT, search tsvector GENERATED STORED | unique `(tenant_id, number)`; unique `(tenant_id, slug) WHERE status <> 6`; GIN on `search`; index `user_id` | 201704101854, 201801031643, 201901072106, 202510211300, 202601191200 |
| `post_votes` (was `idea_supporters`) | user_id, post_id, tenant_id, created_at | PK `(user_id, post_id)`; index `(tenant_id, post_id)` | 201704181821, 201808291958, 202105161823 |
| `comments` | post_id, user_id, tenant_id, content, edited_at/by, deleted_at/by, is_approved | index `(tenant_id, post_id)`; soft delete | 201703240710, 201803110836, 201810152035 |
| `reactions` | comment_id, user_id, emoji(8) | unique `(comment_id, user_id, emoji)`; no tenant_id column | 202410122105 |
| `tags`, `post_tags` | name, slug, color, is_public; created_by_id | unique `(tenant_id, slug)` | 201711152138, 201711181740 |
| `post_subscribers` | user_id, post_id, status (0 inactive, 1 active) | PK `(user_id, post_id)` | 201802061858, `app/models/enum/subscriber.go` |
| `user_settings` | key/value per user (notification bitmasks) | unique `(user_id, key)` | 201802061858 |
| `notifications` | in-app inbox: title, link, read, post_id, author_id | purged after 365 days | 201802241348, `app/services/sqlstore/postgres/notification.go:25` |
| `mention_notifications` | user_id, comment_id or post_id | CHECK one of them not null | 202503202000, 202507071815 |
| `email_verifications` | key(64), code(6), kind, expires_at, verified_at, attempts, user_id | unique `(tenant_id, key)` | 201709081837, 202602250001, 202605011200 |
| `oauth_providers` | per-tenant custom OAuth: urls, scope, json_user_{id,name,email,roles}_path, allowed_roles, is_trusted, client_secret | unique `(tenant_id, provider)` and a global unique `(provider)` | 201807122132, 202205082055, 202603061000 |
| `tenant_providers` | per-tenant on/off of built-in providers | unique `(tenant_id, provider)` | 202510241300 |
| `webhooks` | name, type, status, url, content (template), http_method, http_headers JSONB | none beyond PK | 202108092243 |
| `blobs` | key, tenant_id, bytea file (images, logos, autocert certs) | partial uniques on key | 201812102208, 201812201644 |
| `events`, `logs`, `system_settings`, `tenants_billing` | analytics, logs, billing (Paddle then Stripe) | | 201810022329, 201806191904, 202511211400 |

Statuses are a fixed enum, not a table: open 0, started 1, completed 2, declined 3, planned 4, duplicate 5, deleted 6 (`app/models/enum/post_status.go`). Boards do not exist: one tenant equals one feedback space; tags act as categories.

**Tenant integrity by composite foreign keys.** Migration 201803011831 adds `tenant_id` to every child table and rewires every FK as `(x_id, tenant_id) REFERENCES parent(id, tenant_id)` backed by unique `(tenant_id, id)` indexes. The database itself refuses a comment whose post belongs to another tenant. Newer tables did not keep the discipline: `reactions` has no tenant_id, `mention_notifications.post_id/comment_id` and `attachments` use plain single-column FKs (202410122105, 202507071815, 201901130830).

**Counters.** There are no stored counters. The `supporters` column was dropped (201805230000). Every list query recomputes votes and comments in CTEs (`agg_votes`, `agg_comments`) scanning the whole tenant (`app/services/sqlstore/postgres/post.go:27-117`). Consistency is free, cost grows with tenant size. Post `number` is `COALESCE(MAX(number),0)+1` inside the INSERT (`post.go:251-253`); the unique `(tenant_id, number)` index turns a race into an insert error rather than a duplicate.

**Soft deletes.** Posts use status 6 and the slug unique index excludes them (201901072106). Comments use `deleted_at`. Users are anonymised/deleted by row deletion across a list of tables (`app/services/sqlstore/postgres/user.go:84-104`).

### A2. Multi-tenancy

- Two modes: `SingleTenant` (first tenant in DB) or `MultiTenant` chosen by env (`app/middlewares/tenant.go:20-45`).
- Resolution: host -> `env.Subdomain(host)` strips the configured multi-tenant domain (`app/pkg/env/env.go:304-319`); SQL matches `subdomain = $1 OR subdomain = $2 OR cname = $3 ORDER BY cname DESC` (`app/services/sqlstore/postgres/tenant.go:275-294`). A tenant on a custom domain gets a canonical URL set (`tenant.go` middleware lines 62-68). Custom domains get certificates via ACME stored in `blobs` (`app/pkg/web/ssl.go`).
- Tenant states: active, pending (email not verified), locked (read-only, `BlockLockedTenants`), disabled (`app/models/enum/tenant_status.go`, `app/middlewares/tenant.go:93-160`).
- Isolation in queries is manual: every SQL function receives the tenant from context via `using()` (`app/services/sqlstore/postgres/postgres.go:173-178`) and writes `WHERE tenant_id = $1` itself. No row-level security. The composite FKs are the safety net.
- Session tokens are re-scoped: the user lookup from a JWT is done with the host's tenant id so a token from tenant A resolves to "not found" on tenant B (`app/middlewares/user.go:52-68`). A domain-wide signup cookie is promoted to a host-only cookie only after the tenant check (`user.go:131-140`).
- Deletion is scheduled with a cancel key and a cron job (`app/jobs/delete_scheduled_tenants_job.go`, `app/services/sqlstore/postgres/tenant_deletion.go`).

### A3. Identity

- **Email sign-in = link + code.** `SignInByEmail` creates a 64-char random link key and a 6-digit numeric code (`app/models/entity/email_verification.go:25-32`), lifetime 15 minutes (`app/handlers/signin.go:94-98`), and first invalidates previous active codes for that email (`signin.go:88-92`, SQL `tenant.go:316-319`). Signup verification lives 48 h (`handlers/signup.go:115`), change-email 24 h (`handlers/settings.go:30`).
- **Code brute force:** max 5 attempts, counter incremented before comparison, last failed attempt invalidates the code (`signin.go:155-205`, `tenant.go:209-219`).
- **Single use with a grace window:** a link already verified is refused only if verified more than 5 minutes ago, explicitly to survive Outlook/Safe Links prefetch (`app/handlers/common.go:127-155`). Expired keys are marked verified on first touch.
- **Enumeration:** the sign-in endpoint returns `userExists` to the client (`signin.go:106-109`). Resend of tenant signup mail is throttled to once per minute (`app/actions/tenant.go:166-175`); I found no other rate limiting in Go code.
- **Sessions:** stateless JWT HS256 signed with `JWT_SECRET` (`app/pkg/jwt/jwt.go`), claims user id/name/email/origin/security_stamp, 365-day expiry, cookie `auth` HttpOnly, SameSite=Lax, Secure when HTTPS (`app/pkg/web/util/webutil.go:20-45`, `app/pkg/web/context.go:366-378`). Revocation by `users.security_stamp`: changed on role change and block (`app/services/sqlstore/postgres/user.go` changeUserRole/blockUser), mismatch forces re-login (`app/middlewares/user.go:70-88`). Blocked users get 401 on every request (`user.go:132-136`).
- **API keys:** `Authorization: Bearer`, only collaborators/admins may use them, admins may impersonate with `X-Fider-UserID` (`app/middlewares/user.go:89-127`). Keys are stored in clear in `users.api_key` and looked up by equality (`app/services/sqlstore/postgres/user.go:110-135`).
- **OAuth:** built-in providers plus per-tenant custom providers configured by JSON paths for id, name, email, and since 2026-03 roles (`oauth_providers`, `app/services/oauth/oauth.go`). Callback flow (`app/handlers/oauth.go:225-317`): find user by (provider, uid), else by email, auto-link the provider to the email match; `allowed_roles` gate (staff bypass it); new account allowed if provider `is_trusted` or tenant allows signups (`app/models/entity/tenant.go:48-69`). A host-wide callback hands off to the tenant host with a short JWT bound to provider, origin and session-id hash (`app/pkg/jwt/jwt.go` OAuthHandoffClaims, `handlers/oauth.go:97`).
- **"Fider SSO" / identify by JWT:** not found in this checkout. SSO is done through custom OAuth providers only.
- **Anonymous feedback:** not supported; every post/vote requires a user (`app/cmd/routes.go:253-268` behind `IsAuthenticated`).

### A4. Duplicate ("merge")

Code: `app/actions/post.go:245-286`, `app/services/sqlstore/postgres/post.go:177-219`, `app/handlers/apiv1/post.go:205-234`, `app/tasks/status_change.go`.

- Triggered by setting status `duplicate` with `originalNumber`; self-duplicate rejected; original must exist.
- **Votes:** each voter of the duplicate gets `AddVote` on the original; `ON CONFLICT DO NOTHING` deduplicates (`vote.go:16-33`). The duplicate keeps its own `post_votes` rows. Moved votes get `created_at = now()`, so they count as "recent" in trending.
- If the original is completed/declined/duplicate, `CanBeVoted()` is false and `AddVote` silently returns nil (`app/models/entity/post.go:28-31`, `vote.go:18-20`): those votes are lost without error.
- **Comments, subscribers, tags:** not moved. Subscribers of the duplicate are notified (web + email with a link to the original, template `change_status`, `status_change.go:53-58`); subscribers of the original are not.
- The duplicate can no longer be voted (`CanBeVoted`). It stays visible with `original_*` fields joined in (`post.go:93-97`).
- Un-merge: any other status runs `SetPostResponse` which sets `original_id = NULL` (`post.go:150-154`) but does not remove the votes copied to the original.
- `PostIsReferenced` lets the UI know a post is someone's original (`post.go:120-138`).

### A5. Status workflow and notifications

- Status change by collaborator/admin via `PUT /api/v1/posts/:number/status` with a markdown `response` text (`routes.go:270-271`). `deleted` goes through `DELETE /api/v1/posts/:number` (admin) and wipes in-app notifications of that post (`post.go:160-165`).
- Work is enqueued as tasks (`c.Enqueue(tasks.NotifyAboutStatusChange(...))`). The worker is an in-process Go channel (`app/pkg/worker/worker.go:36-60, 188-194`): tasks are lost on crash or restart.
- **Events** (`app/models/enum/notification.go`): new_post, new_comment, mention, change_status. Each user has a per-event bitmask setting (1 web, 2 email) in `user_settings`; defaults depend on role.
- **Recipient rule** (`app/services/sqlstore/postgres/notification.go:176-245`): events with `RequiresSubscriptionUserRoles` empty go to everyone whose setting allows it (new_post goes to staff by default). Comment and status events require visitors to have an active `post_subscribers` row; staff are included unless they unsubscribed. Only active users; email channel excludes `email_supressed_at`. The author of the action is skipped (`status_change.go:36, 61`). Pending (unmoderated) content notifies staff only (`app/tasks/tasks.go:46-75`).
- **Who is subscribed:** only the post author is auto-subscribed on creation (`post.go:264`, `internalAddSubscriber`). Voting and commenting do not subscribe in current code (no other caller of `internalAddSubscriber`/`AddSubscriber` except the explicit endpoint `routes.go:267-268`). The 2018 seed migration did subscribe voters and commenters (201802071816), so behaviour changed over time.
- **Email templates:** Go `html/template` files `views/email/*.html` (change_status, new_comment, new_post, delete_post, signin, signup, invite, change_emailaddress, delete_account_*), wrapped by `base_email.html`; functions `translate`, `markdown`, `format`, `truncate` (`app/pkg/tpl/funcs.go`).
- **Batching:** one `SendMail` per event with all recipients. Mailgun sends one batch call with `recipient-variables` (`app/services/email/mailgun/sendmail.go:35-92`); SMTP and SES loop per recipient (`smtp/smtp.go:63`, `awsses/awsses.go:67`). No digest.
- **Unsubscribe:** footer links are "unsubscribe" = the post page (user clicks the bell) and "change" = `/settings` (`status_change.go:76-78`). No one-click token, no `List-Unsubscribe` header (not found). Bounces: hourly job pulls provider suppressions and sets `email_supressed_at` for that address across all tenants (`app/jobs/email_supression_job.go`, `notification.go` supressEmail has no tenant filter).

### A6. Sorting and search

`app/services/sqlstore/postgres/common.go:39-98`:

- `trending` (default):
  `((COALESCE(recent_votes_count,0)*5 + COALESCE(recent_comments_count,0)*3) - 1) / pow((EXTRACT(EPOCH FROM current_timestamp - created_at)/3600) + 2, 1.4)`
  where recent = created in the last 30 days (`post.go:44-62`, comments must be approved and not deleted). Hacker-News style gravity 1.4 on age in hours, but numerator only counts the 30-day window, so an old post with fresh activity can resurface.
- `most-wanted` = votes_count, `most-discussed` = comments_count, `recent` = id, status views sort by `response_date`. Default status filter: open, started, planned.
- **Full-text:** `posts.language` detected per post at write time with lingua-go (`post.go:292-311`), stored as a config name TEXT (regconfig OIDs broke pg_upgrade, 202601191200). Generated column: language-specific tsvector for title (A) and description (B) plus `simple` tsvector (C, D); `simple` only when language unknown. GIN index. Query is built with both the tenant's config and `simple`, ranked by `ts_rank_cd(a) + ts_rank_cd(b)` (`post.go:446-471`). Unsupported languages (zh, ja, ko, pl, cs...) fall back to `simple`.
- **Similar posts while typing:** `GET /api/v1/similarposts` returns 5 matches among non-deleted statuses (`post.go:370-422`). Noise words list in env (`env.go:155`). Two oddities as read: the noise-word-filtered string is only used to decide emptiness, the unfiltered query is sent to SQL (`post.go:374, 411`); `ToTSQuery` joins words with `|` (`common.go:21-24`) before the SQL regex that was meant to insert `& ` between whitespace-separated words, so matching is effectively OR with a prefix only on the last token.
- pg_trgm is installed (201802231910) but I found no use in current queries.

### A7. Moderation, rate limits, roles, privacy, blocking

- Roles: visitor, collaborator, administrator (`app/models/enum/user_role.go`). Route groups enforce them (`app/cmd/routes.go:164, 187, 270, 280, 297`).
- **Moderation (Pro tier only, `RequirePro`)**: tenant flag `is_moderation_enabled`; new posts/comments from visitors not marked `is_trusted` are inserted with `is_approved=false` (`app/models/entity/user.go:45-48`, `post.go:245`, `comment.go:18`). Visibility: anonymous sees approved only; a signed-in user sees approved plus own pending; staff can filter pending/approved (`post.go:533-569`). Actions: approve, decline (sets status deleted), approve-and-verify (marks user trusted), decline-and-block, bulk (`app/services/sqlstore/postgres/moderation.go`, `routes.go:305-316`). Approval re-fires notifications to non-staff (`tasks/new_post.go:28`).
- Private site: `is_private` redirects unauthenticated users to sign-in (`app/middlewares/tenant.go:109-133`) and disables self-signup (`entity/tenant.go:65-69`). No per-board privacy (no boards). Tags have `is_public`; private tags hidden from non-staff (`post.go:534-537`).
- Blocking: status 3 plus security stamp change; blocked users fail auth (`middlewares/user.go:132-136`).
- Rate limiting: only the signup resend throttle (`actions/tenant.go:166`). No IP throttling found.

### A8. API, webhooks, i18n

- REST under `/api/v1` (`app/cmd/routes.go:239-319`): public read (posts, post, comments, votes, tags, similarposts, taggable-users); members write (create/update post, comment CRUD, reactions, vote add/remove/toggle, subscription); staff (users list, invitations, tag assign); admin (create user, tags CRUD, delete post, moderation). Internal UI endpoints live under `/_api`. CSRF middleware on cookie routes (`routes.go:80`).
- **Webhooks** (`app/services/webhook/webhook.go`, `app/models/enum/webhook*.go`): events `new_post`, `new_comment`, `change_status`, `delete_post`. Admin writes the URL and body as Go `text/template` over flat props (`post_title`, `post_url`, `post_old_status`, `author_name`, `tenant_url`, `post_response_original_url`...; `app/pkg/webhook/props.go`) with helpers `quote`, `escape`, `markdown`, `lower`, `upper`, `truncate` (`app/pkg/tpl/funcs.go`). Preview with dummy props and a test endpoint (`routes.go:206-208`). SSRF guard at preflight and at dial time (`webhook.go:86-104`, `app/pkg/netguard`). Fired sequentially inside the task; no retry; any error or HTTP >= 400 marks the webhook `failed` when `WEBHOOK_DISABLE_ON_FAILURE` (default true, `env.go:151-153`). No signature header (not found).
- **i18n:** tenant-level `locale`; React side uses Lingui (`lingui.config.js`), catalogs `locale/<lang>/client.json`, server/email strings `locale/<lang>/server.json` with ICU messageformat (`app/pkg/i18n/i18n.go`). 23 locales. Admin pages are forced to English (`routes.go:168, 278, 295`).

### A9. Widget / embedding

Not found. Atom feeds exist (`/feed/global.atom`, `/feed/posts/:path`, `routes.go:49-58`), and a public roadmap page (`/roadmap`).

---

## PART B: ASTUTO

### B1. Data model (astuto/db/schema.rb, version 2024_11_30)

| Table | Key columns | Constraints / indexes |
|---|---|---|
| `tenants` | site_name, subdomain, custom_domain, locale, status (active/pending/blocked) | unique `custom_domain`; **no unique index on `subdomain`** (only model validation, `app/models/tenant.rb:20`) |
| `tenant_settings` | brand_display, root_board_id, show_vote_count, allow_anonymous_feedback, feedback_approval_policy, is_private, email_registration_policy, allowed_email_domains, use_browser_locale, custom_css | index tenant_id |
| `users` | Devise columns (encrypted_password, confirmation, reset, trackable), role (user/moderator/admin/owner), status (active/blocked/deleted), notifications_enabled, recap_notification_frequency, oauth_token, has_set_password | unique `(email, tenant_id)` |
| `boards` | name, slug, description, order | unique `(name, tenant_id)`, `(slug, tenant_id)` |
| `post_statuses` | name, color, order, show_in_roadmap | unique `(name, tenant_id)` |
| `posts` | board_id, user_id **nullable** (anonymous), post_status_id nullable (= open), slug, approval_status (approved/pending/rejected) | unique `(slug, tenant_id)` |
| `post_status_changes` | post_id, user_id, post_status_id | status history log |
| `likes` (votes) | user_id, post_id | unique `(user_id, post_id)` |
| `comments` | parent_id (threading), is_post_update | |
| `follows` (subscriptions) | user_id, post_id | unique `(user_id, post_id)` |
| `webhooks` | trigger, url (encrypted), http_body, http_method, http_headers (encrypted) | unique `(name, tenant_id)` |
| `o_auths` + `tenant_default_o_auths` | custom OAuth per tenant, or global (tenant_id NULL) toggled per tenant | unique `(slug, tenant_id)` |
| `api_keys` | HMAC token_digest, prefixes | unique digest, one key per user |
| `invitations` | email, token_digest, accepted_at | unique `(email, tenant_id)` |

Statuses are per-tenant rows with order and colour (`app/models/post_status.rb`); `dependent: :nullify` reverts posts to "no status" on status deletion. Tags: not found. Duplicate/merge: not found (no column, no endpoint). In-app notifications table: not found (email only).
Every tenant FK is single-column (`tenant_id` -> tenants) with no composite constraint between, say, a like and its post's tenant.
**Counters:** none stored; `likes_count`, `comments_count` computed with `COUNT(DISTINCT ...)` over left joins per request (`app/controllers/posts_controller.rb:11-31`). Deletes are hard and cascade through `dependent: :destroy` (`app/models/post.rb:9-13`); users are soft-deleted with an email scramble (`app/controllers/registrations_controller.rb` destroy).

### B2. Multi-tenancy

- `get_tenant_from_request` (`app/helpers/application_helper.rb:76-94`): host taken from `X-Forwarded-Host` header if present, else `request.host`; if it ends with the app base host, tenant by `request.subdomain` (reserved subdomains excluded, `config/initializers/reserved_subdomains.rb`), else by `custom_domain`. Single-tenant mode = `Tenant.first`.
- Isolation: `TenantOwnable` concern adds `default_scope { where(tenant: Current.tenant_or_raise!) }` (`app/models/concerns/tenant_ownable.rb`); `Current` is `ActiveSupport::CurrentAttributes` (`app/models/current.rb`). Jobs must set `Current.tenant` themselves (`app/jobs/run_webhook.rb:5`, `app/mailers/user_mailer.rb`). `unscoped` is used for cross-tenant jobs (`app/jobs/send_recap_emails.rb`).
- `Current.tenant_or_raise!` raises `CurrentTenantBlocked`, a constant that is not defined (only `MissingCurrentTenant`, `CurrentTenantNotActive`), so that branch would raise NameError (`app/models/current.rb`).
- Pending and blocked tenants are redirected in `load_tenant_data` (`app/controllers/application_controller.rb`). Billing gate `check_tenant_subscription` on write actions.
- Special subdomains `login`, `billing`, `api`, `showcase` routed by constraints (`config/routes.rb:7-27`).

### B3. Identity

- Devise: `database_authenticatable, registerable, recoverable, rememberable, confirmable, trackable` (`app/models/user.rb:3-5`). Password reset valid 8 h, remember-me 1 year, remember tokens expired on sign-out (`config/initializers/devise.rb:155-215`). `timeout_in = 8.hours` is set but `:timeoutable` is not in the module list, so it has no effect.
- Magic link / passwordless email: not found. JWT SSO: not found.
- Registration policy per tenant: all, none, or allowed email domains (`app/models/tenant_setting.rb:26-30`, `registrations_controller.rb:46-60`). Invitations bypass it.
- OAuth (`app/controllers/o_auths_controller.rb`): state = `reason,tenant_subdomain,random` stored in a cookie on the parent domain and compared on callback; global "default" providers serve every tenant and are toggled per tenant. Profile JSON read by configured paths (email required, name optional). User matched by email only, created with random password and confirmation skipped (`app/workflows/o_auth_sign_in_user_workflow.rb`). This workflow does not consult `email_registration_policy` or `is_private`. Handoff from the central callback to the tenant host passes `user_id` and a one-time `oauth_token` in the query string, compared with `==`, invalidated after use, no expiry (`o_auths_controller.rb:57-66, 121-136`).
- **Anonymous feedback:** post created with `user_id = nil` when `is_anonymous` and the tenant allows it (`posts_controller.rb:39-66, 168-176`). Votes and comments require login (`likes_controller.rb:2`, `comments_controller.rb:2`).
- API keys: `tkn_admin_xxxxxx...` / `tkn_mod_...` with a visible prefix; only an HMAC-SHA256 digest is stored (`app/models/api_key.rb`). Admin keys may impersonate (`app/controllers/api/v1/helpers.rb`).

### B4. Duplicate / merge

Not implemented (no schema column, no route, no model method; grep for duplicate/merge in models and controllers returns nothing).

### B5. Status workflow and notifications

- Moderators change `post_status_id` through `PATCH /posts/:id`; on change, `ExecutePostStatusChangeLogicWorkflow` writes a `post_status_changes` row and mails every follower (`app/workflows/execute_post_status_change_logic_workflow.rb`). It does not skip the actor and does not check `notifications_enabled`.
- Comments: `is_post_update = true` comments are official updates mailed to all followers; a top-level comment mails the post owner if they follow and have notifications enabled; a reply mails the parent comment author (`app/workflows/send_notification_for_comment_workflow.rb`).
- Auto-follow: the author of a non-anonymous post follows it (`posts_controller.rb:62`). Voting does not follow (no follow in `likes_controller.rb`).
- **Recap digest:** daily job; daily/weekly (Mondays)/monthly (1st) recap to owner/admin/moderator with counts of published and pending posts, skipping their own posts, only for tenants with active billing (`app/jobs/send_recap_emails.rb`). User picks frequency (`users.recap_notification_frequency`).
- Templates: ERB in `app/views/user_mailer/*.html.erb` with shared partials `_opening`, `_closing`, `_quoted_text`, `_unsubscribe_from_post`, `_unsubscribe_from_site`. Unsubscribe links go to the post page or to the account edit page (no token, no header).
- Delivery: `deliver_later` through ActiveJob, Sidekiq when `ACTIVE_JOB_BACKEND=sidekiq` (`config/initializers/sidekiq.rb`). One mail per recipient.

### B6. Sorting and search

- `trending`: `(LOG(likes+1) + LOG(comments+1)) + EXTRACT(EPOCH FROM posts.created_at)/45000` (`posts_controller.rb:20`). PostgreSQL `LOG` is base 10, so ten times more votes is worth 45 000 s (12.5 h) of freshness. Reddit-like, monotonic in creation time, never decays a post with recent activity.
- Other sorts: newest, oldest, most_voted (`app/models/post.rb:46-60`). Filters: board, status ids (0 = no status), date range.
- Search: `ILIKE '%term%'` on title and description, no index, no language handling (`app/models/post.rb:37-42`).

### B7. Moderation, rate limits, roles, privacy, blocking

- Roles: user < moderator < admin < owner, implemented as cumulative predicates (`app/models/user.rb` `moderator?`, `admin?`). Pundit policies per model (`app/policies/*.rb`); e.g. post update fields widen for moderators (`app/policies/post_policy.rb`).
- **Approval queue:** `feedback_approval_policy` = anonymous_require_approval (default), never_require_approval, always_require_approval (`tenant_setting.rb:32-36`). Default status `pending`, auto-approved if policy allows or author is moderator (`posts_controller.rb:46-55`). Queue endpoint lists pending+rejected, limit 100 (`posts_controller.rb:139-160`). Separate webhook trigger `new_post_pending_approval`. Pending posts visible only to moderators (`authenticate_moderator_if_post_not_approved`). The roadmap query does not filter on `approval_status` (`app/controllers/static_pages_controller.rb:46-54`).
- **Anti-spam for anonymous posts:** two honeypot fields `dnf1`, `dnf2` and a minimum 2 s between form render and submit (`posts_controller.rb:163-166`). Rack::Attack jails the IP for an hour once a honeypot trips (`config/initializers/rack_attack.rb`).
- **Rate limits** (Rack::Attack): 300 req/5 min/IP, API 100/5 min per IP and per key, logins 5/20 s per IP and per email, tenant signups 5/20 s.
- Private tenant: `is_private` checked only for an allowlist of controllers (posts, boards, comments, root, roadmap) (`application_controller.rb` `should_check_tenant_is_private?`). Likes, follows, post_status_changes and the embedded roadmap are outside that list. `GET /posts/:id/likes` returns voters' `full_name` and `email` without authentication (`app/controllers/likes_controller.rb:5-14`).
- Blocking: `users.status = blocked`; Devise `active_for_authentication?` refuses it (`user.rb`); API `PUT /api/v1/users/:id/block`.

### B8. API, webhooks, i18n

- REST `/api/v1` documented with rswag (`config/initializers/rswag_api.rb`): boards, post_statuses, posts (+ update_board, update_status, approve, reject), comments (+ mark_as_post_update), votes (controller `likes`), users (+ get_by_email, block) (`config/routes.rb:104-127`).
- **Webhooks:** triggers new_post, new_post_pending_approval, delete_post, post_status_change, new_comment, new_vote, new_user (`app/models/webhook.rb`). Fired from model callbacks (`after_create`), queued on Sidekiq queue `webhooks` with entity ids, re-loaded in the job (`app/jobs/run_webhook.rb`). URL and body are Liquid templates over whitelisted attributes per entity (`app/workflows/create_liquid_template_context_workflow.rb`), custom filter `escape_json` (`app/lib/custom_liquid_filters.rb`); body must parse as JSON. URL and headers encrypted at rest with a key derived from `secret_key_base`. Test and preview endpoints (`config/routes.rb:54-55`). No SSRF guard (grep empty), response status ignored, no retry policy beyond Sidekiq defaults, no signature.
- **i18n:** Rails YAML `config/locales/*.yml` (+ `devise/`, `backend/`), Crowdin sync (`crowdin.yml`), `i18n-js` on the React side (`package.json`). Locale = tenant locale, or browser `Accept-Language` when `use_browser_locale` (`application_controller.rb` load_tenant_data).

### B9. Widget / embedding

`GET /embedded_roadmap` renders the roadmap in an `embedded` layout and sets `X-Frame-Options: ALLOWALL` (`app/controllers/static_pages_controller.rb:5, 26-32, 56-58`). Read-only; no embeddable submit/vote widget found.

---

## C. Ideas worth taking (ranked)

1. **Composite tenant FKs** `(child.parent_id, tenant_id) -> parent(id, tenant_id)` on every table (Fider 201803011831). Makes cross-tenant references impossible at the DB level; pair it with Postgres RLS, which neither project has.
2. **Similar-posts lookup while typing the title** (Fider `/api/v1/similarposts`). Cheapest duplicate prevention there is.
3. **Per-post language detection feeding a generated, weighted tsvector** (language config + `simple` fallback, GIN) (Fider 202510211300, 202601191200). Store the config name as TEXT, not regconfig.
4. **Session revocation by security stamp** inside a stateless token (Fider `middlewares/user.go:70-88`): role change or block kills sessions without a session table.
5. **Email sign-in as link + 6-digit code**, 15 min, invalidate previous, 5 attempts, short grace window for link scanners (Fider `handlers/signin.go`, `handlers/common.go:127-155`).
6. **Approval queue with "approve and trust" / "decline and block"** and per-tenant policy for anonymous vs signed-in (Fider moderation.go + Astuto feedback_approval_policy). Pending content notifies staff only, then everyone on approval (Fider `tasks/tasks.go:46-75`).
7. **Anonymous posting guarded by honeypot + time-to-submit + IP jail** (Astuto `posts_controller.rb:163-166`, `rack_attack.rb`).
8. **Status history table plus "official update" comments** that notify all followers (Astuto `post_status_changes`, `comments.is_post_update`). Gives a changelog per post for free.
9. **Tenant-defined statuses with colour, order, show_in_roadmap** (Astuto `post_statuses`) instead of a fixed enum; keep a small fixed set of semantic categories (open/active/done/closed) behind them so logic like "can be voted" survives renames.
10. **Webhook templating with preview, test and dummy props** (both), SSRF guard at dial time and auto-disable on failure (Fider `webhook.go`). Add what both lack: HMAC signature, durable queue, retries with backoff, delivery log.
11. **API keys stored as HMAC digest with a readable prefix** (`tkn_admin_...`, Astuto `api_key.rb`), admin impersonation header for server-side integrations (both).
12. **Notification preferences as a per-event channel bitmask with role defaults** (Fider `enum/notification.go`, `user_settings`), plus staff digests (Astuto recap daily/weekly/monthly).
13. **Trending that looks at recent activity only** (Fider: 30-day window, gravity 1.4) rather than creation time (Astuto). Better: precompute and store the score.
14. **Bounce suppression job** setting `email_supressed_at` (Fider `email_supression_job.go`).
15. **OAuth role gate from a JSON path** (`allowed_roles`, Fider 202603061000) for "only employees of customer X" boards.
16. **Embeddable read-only roadmap** (Astuto) as a first step to a widget; scope frame-ancestors per tenant instead of ALLOWALL.

## D. Pitfalls and weaknesses to avoid

1. **In-memory job queue** (Fider `pkg/worker/worker.go`): notifications and webhooks vanish on restart. Use a durable queue (outbox table or Postgres-backed jobs).
2. **Recomputing counts over the whole tenant on every list** (Fider CTEs `post.go:27-117`, Astuto joins). Keep stored counters updated in the same transaction, or a materialised score, and reconcile periodically.
3. **Merge that loses data silently**: Fider drops votes when the original is closed, does not move comments or subscribers, does not notify the original's followers, and does not revert copied votes on un-merge. Design merge as an explicit, reversible operation with an audit row.
4. **Moved votes stamped `now()`** inflate trending of the original (Fider `vote.go:22`). Preserve the original timestamp.
5. **Account linking by email from any OAuth provider** (Fider `handlers/oauth.go:250-254`, Astuto `o_auth_sign_in_user_workflow.rb`). Only link when the provider asserts a verified email, and never let OAuth bypass the tenant's registration policy (Astuto does).
6. **Trusting `X-Forwarded-Host` for tenant resolution** (Astuto `application_helper.rb:78`). Only trust it from known proxies.
7. **Secrets in clear**: Fider API keys in `users.api_key`, OAuth client secrets in clear in both; Astuto's one-time `oauth_token` in a URL, compared with `==`, no expiry. Hash tokens, constant-time compare, short TTL.
8. **Privacy check by controller allowlist** (Astuto `should_check_tenant_is_private?`) and a public endpoint leaking voter emails (Astuto `likes_controller.rb:5-14`). Default-deny on private tenants; never expose emails in public JSON.
9. **Uniqueness only in the model** (Astuto `tenants.subdomain`). Every business-unique key needs a DB index.
10. **Inconsistent tenant discipline in newer tables** (Fider `reactions`, `mention_notifications`, `attachments`). Enforce it with a migration lint or RLS.
11. **Account enumeration** via `userExists` in the sign-in response (Fider `signin.go:106`). Return the same response for both cases.
12. **Rate limiting absent** in Fider except one resend throttle. Astuto's Rack::Attack set is a reasonable minimum.
13. **Unsubscribe without token or header**: both send users to a page that requires login. Provide signed one-click links and `List-Unsubscribe`/`List-Unsubscribe-Post`.
14. **Search string handling bugs** (Fider: noise-word filtering not applied, OR semantics contrary to the comment, `common.go:21-24`, `post.go:374-411`). Use `websearch_to_tsquery` or build the tsquery in one place with tests.
15. **Configuration that does nothing** (Astuto `timeout_in` without `:timeoutable`) and **undefined constants on error paths** (Astuto `Current::CurrentTenantBlocked`). Test the failure paths.
16. **Status-change mail ignores preferences and notifies the actor** (Astuto workflow). Centralise recipient resolution in one function as Fider does.
17. **Webhooks without SSRF guard or response handling** (Astuto `run_webhook.rb`), and **fire-once without retry** (Fider). Both lack signing.
18. **Hard deletes cascading through votes and comments** (Astuto) lose history; prefer soft delete with a partial unique index on slug like Fider 201901072106.
19. **Admin UI locked to English** (Fider `SetLocale("en")` on admin routes). Translate staff screens too if the audience is non-English.
20. **regconfig column type** breaks `pg_upgrade` (Fider fixed it in 202601191200): store text-search config names as TEXT.
