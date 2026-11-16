-- Tribune: feedback boards, votes, roadmap, changelog. One schema, many sites.
-- Idempotent: safe to run on every start. Every table carries site_id (directly
-- or through its post) so one instance can serve all sites without leaks.

create schema if not exists tribune;
create extension if not exists pg_trgm with schema public;
create extension if not exists unaccent with schema public;

-- unaccent() is STABLE, so it cannot feed an index or a generated column.
-- This wrapper pins the dictionary and is declared IMMUTABLE on purpose.
create or replace function tribune.norm(t text) returns text
language sql immutable parallel safe
set search_path = public, extensions, tribune, pg_catalog as
$$ select lower(unaccent('unaccent'::regdictionary, coalesce(t, ''))) $$;

create table if not exists tribune.site (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name             text not null,
  domains          text[] not null default '{}',          -- host pages allowed to embed the widget
  default_locale   text not null default 'fr' check (default_locale in ('fr','en')),
  jwt_secret       text not null,                          -- HS256 secret shared with the host site server
  api_key_hash     text not null,                          -- sha256 of the server-to-server key
  config           jsonb not null default '{}'::jsonb,     -- segment weights, limits, privacy switches
  next_post_number integer not null default 1,
  created_at       timestamptz not null default now()
);

create table if not exists tribune.company (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references tribune.site(id) on delete cascade,
  external_id text not null,
  name        text not null,
  plan        text,
  mrr         numeric(12,2) not null default 0 check (mrr >= 0),
  updated_at  timestamptz not null default now(),
  unique (site_id, external_id)
);

create table if not exists tribune.app_user (
  id             uuid primary key default gen_random_uuid(),
  site_id        uuid not null references tribune.site(id) on delete cascade,
  external_id    text,                                    -- id in the host site, from the JWT
  email          text,
  email_verified boolean not null default false,
  name           text not null default '',
  avatar_url     text,
  segment        text,
  weight         numeric(6,2),                            -- null: weight of the segment, else 1
  role           text not null default 'user' check (role in ('user','moderator','admin')),
  company_id     uuid references tribune.company(id) on delete set null,
  locale         text check (locale in ('fr','en')),
  banned         boolean not null default false,
  email_opt_out  boolean not null default false,
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now()
);
create unique index if not exists app_user_site_email on tribune.app_user (site_id, lower(email)) where email is not null;
create unique index if not exists app_user_site_ext on tribune.app_user (site_id, external_id) where external_id is not null;

create table if not exists tribune.session (
  token_hash text primary key,
  user_id    uuid not null references tribune.app_user(id) on delete cascade,
  site_id    uuid not null references tribune.site(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists session_expiry on tribune.session (expires_at);

create table if not exists tribune.magic_link (
  token_hash text primary key,
  site_id    uuid not null references tribune.site(id) on delete cascade,
  email      text not null,
  name       text,
  return_to  text,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists tribune.board (
  id               uuid primary key default gen_random_uuid(),
  site_id          uuid not null references tribune.site(id) on delete cascade,
  slug             text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,40}$'),
  name             jsonb not null,                        -- {"fr": "...", "en": "..."}
  description      jsonb not null default '{}'::jsonb,
  visibility       text not null default 'public' check (visibility in ('public','private','segment')),
  segments         text[] not null default '{}',
  require_approval boolean not null default false,
  position         integer not null default 0,
  created_at       timestamptz not null default now(),
  unique (site_id, slug)
);

create table if not exists tribune.category (
  id       uuid primary key default gen_random_uuid(),
  board_id uuid not null references tribune.board(id) on delete cascade,
  name     jsonb not null,
  color    text not null default '#64748b',
  position integer not null default 0
);

create table if not exists tribune.status (
  id           uuid primary key default gen_random_uuid(),
  site_id      uuid not null references tribune.site(id) on delete cascade,
  key          text not null check (key ~ '^[a-z][a-z0-9_]{1,30}$'),
  label        jsonb not null,
  color        text not null,
  position     integer not null,
  on_roadmap   boolean not null default false,
  closes_votes boolean not null default false,
  is_default   boolean not null default false,
  in_backlog   boolean not null default false,
  unique (site_id, key)
);

create table if not exists tribune.post (
  id             uuid primary key default gen_random_uuid(),
  site_id        uuid not null references tribune.site(id) on delete cascade,
  board_id       uuid not null references tribune.board(id) on delete cascade,
  number         integer not null,
  title          text not null check (char_length(title) between 3 and 120),
  body           text not null default '' check (char_length(body) <= 10000),
  author_id      uuid references tribune.app_user(id) on delete set null,
  created_by     uuid references tribune.app_user(id) on delete set null,  -- team member who filed it for a customer
  category_id    uuid references tribune.category(id) on delete set null,
  status_id      uuid not null references tribune.status(id),
  approved       boolean not null default true,
  hidden         boolean not null default false,
  merged_into_id uuid references tribune.post(id) on delete set null,
  vote_count     integer not null default 0,
  comment_count  integer not null default 0,
  score_trending double precision not null default 0,
  impact         smallint check (impact between 1 and 3),
  confidence     numeric(3,2) check (confidence between 0.1 and 1),
  effort         numeric(6,1) check (effort > 0),
  eta            text,
  search         tsvector,
  title_norm     text not null default '',
  last_vote_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (site_id, number),
  check (merged_into_id is null or merged_into_id <> id)
);
create index if not exists post_board_top on tribune.post (board_id, vote_count desc) where merged_into_id is null and not hidden;
create index if not exists post_board_trending on tribune.post (board_id, score_trending desc) where merged_into_id is null and not hidden;
create index if not exists post_board_new on tribune.post (board_id, created_at desc) where merged_into_id is null and not hidden;
create index if not exists post_site_status on tribune.post (site_id, status_id);
create index if not exists post_search on tribune.post using gin (search);
create index if not exists post_title_trgm on tribune.post using gin (title_norm gin_trgm_ops);

create table if not exists tribune.vote (
  id             uuid primary key default gen_random_uuid(),
  post_id        uuid not null references tribune.post(id) on delete cascade,
  user_id        uuid not null references tribune.app_user(id) on delete cascade,
  created_by     uuid references tribune.app_user(id) on delete set null,  -- set when the team votes for a customer
  source         text not null default 'self' check (source in ('self','author','on_behalf','import','merge')),
  source_url     text,                                    -- support ticket, email, call note
  note           text check (char_length(note) <= 2000),  -- the customer's own words
  origin_post_id uuid references tribune.post(id) on delete set null,  -- set when a merge moved it, so unmerge can move it back
  created_at     timestamptz not null default now(),
  unique (post_id, user_id)
);
create index if not exists vote_user on tribune.vote (user_id);
create index if not exists vote_origin on tribune.vote (origin_post_id) where origin_post_id is not null;

create table if not exists tribune.comment (
  id             uuid primary key default gen_random_uuid(),
  post_id        uuid not null references tribune.post(id) on delete cascade,
  author_id      uuid references tribune.app_user(id) on delete set null,
  parent_id      uuid references tribune.comment(id) on delete cascade,
  body           text not null check (char_length(body) between 1 and 5000),
  internal       boolean not null default false,
  official       boolean not null default false,          -- team reply, highlighted
  origin_post_id uuid references tribune.post(id) on delete set null,
  created_at     timestamptz not null default now(),
  edited_at      timestamptz,
  deleted_at     timestamptz
);
create index if not exists comment_post on tribune.comment (post_id, created_at);

create table if not exists tribune.subscription (
  user_id    uuid not null references tribune.app_user(id) on delete cascade,
  post_id    uuid not null references tribune.post(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);

create table if not exists tribune.activity (
  id         bigserial primary key,
  site_id    uuid not null references tribune.site(id) on delete cascade,
  post_id    uuid references tribune.post(id) on delete cascade,
  actor_id   uuid references tribune.app_user(id) on delete set null,
  type       text not null,
  public     boolean not null default true,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists activity_post on tribune.activity (post_id, created_at);
create index if not exists activity_actor_day on tribune.activity (actor_id, type, created_at);

create table if not exists tribune.notification (
  id         bigserial primary key,
  site_id    uuid not null references tribune.site(id) on delete cascade,
  user_id    uuid not null references tribune.app_user(id) on delete cascade,
  post_id    uuid references tribune.post(id) on delete cascade,
  type       text not null,
  payload    jsonb not null default '{}'::jsonb,
  read_at    timestamptz,
  emailed_at timestamptz,
  email_skip text,                                        -- why no email went out (opt-out, no address, unverified)
  created_at timestamptz not null default now()
);
create index if not exists notification_user on tribune.notification (user_id, created_at desc);
create index if not exists notification_mail_queue on tribune.notification (created_at) where emailed_at is null and email_skip is null;

create table if not exists tribune.changelog (
  id           uuid primary key default gen_random_uuid(),
  site_id      uuid not null references tribune.site(id) on delete cascade,
  title        text not null check (char_length(title) between 3 and 160),
  body         text not null default '',
  published_at timestamptz,
  created_by   uuid references tribune.app_user(id) on delete set null,
  created_at   timestamptz not null default now()
);
create table if not exists tribune.changelog_post (
  changelog_id uuid not null references tribune.changelog(id) on delete cascade,
  post_id      uuid not null references tribune.post(id) on delete cascade,
  primary key (changelog_id, post_id)
);

create table if not exists tribune.webhook (
  id         uuid primary key default gen_random_uuid(),
  site_id    uuid not null references tribune.site(id) on delete cascade,
  url        text not null check (url ~ '^https?://'),
  secret     text not null,
  events     text[] not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists tribune.webhook_delivery (
  id              bigserial primary key,
  webhook_id      uuid not null references tribune.webhook(id) on delete cascade,
  event           text not null,
  payload         jsonb not null,
  attempts        integer not null default 0,
  status          text not null default 'pending' check (status in ('pending','sent','failed')),
  last_error      text,
  next_attempt_at timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
create index if not exists webhook_delivery_due on tribune.webhook_delivery (next_attempt_at) where status = 'pending';

-- Search fields: filled by trigger because unaccent cannot sit in a generated column.
create or replace function tribune.post_search_fill() returns trigger language plpgsql as $$
begin
  new.title_norm := tribune.norm(new.title);
  new.search := setweight(to_tsvector('simple', tribune.norm(new.title)), 'A')
             || setweight(to_tsvector('simple', tribune.norm(new.body)), 'B');
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists post_search_fill on tribune.post;
create trigger post_search_fill before insert or update of title, body on tribune.post
  for each row execute function tribune.post_search_fill();

-- Counters live in triggers, not in application code, so no path can skip them.
create or replace function tribune.recount_votes(p uuid) returns void language sql as $$
  update tribune.post set
    vote_count   = (select count(*) from tribune.vote where post_id = p),
    last_vote_at = (select max(created_at) from tribune.vote where post_id = p)
  where id = p
$$;
create or replace function tribune.vote_count_trg() returns trigger language plpgsql as $$
begin
  if tg_op in ('INSERT','UPDATE') then perform tribune.recount_votes(new.post_id); end if;
  if tg_op in ('DELETE','UPDATE') then perform tribune.recount_votes(old.post_id); end if;
  return null;
end $$;
drop trigger if exists vote_count_trg on tribune.vote;
create trigger vote_count_trg after insert or delete or update of post_id on tribune.vote
  for each row execute function tribune.vote_count_trg();

create or replace function tribune.recount_comments(p uuid) returns void language sql as $$
  update tribune.post set comment_count =
    (select count(*) from tribune.comment where post_id = p and not internal and deleted_at is null)
  where id = p
$$;
create or replace function tribune.comment_count_trg() returns trigger language plpgsql as $$
begin
  if tg_op in ('INSERT','UPDATE') then perform tribune.recount_comments(new.post_id); end if;
  if tg_op in ('DELETE','UPDATE') then perform tribune.recount_comments(old.post_id); end if;
  return null;
end $$;
drop trigger if exists comment_count_trg on tribune.comment;
create trigger comment_count_trg after insert or delete or update of post_id, internal, deleted_at on tribune.comment
  for each row execute function tribune.comment_count_trg();

-- Trending: every vote counts 1 when cast and half as much every 14 days,
-- public comments count half a vote with the same decay. The half-life is
-- published on the portal, and raw counts stay visible next to it.
create or replace function tribune.refresh_trending(p uuid default null) returns integer language sql as $$
  with s as (
    select po.id,
      coalesce((select sum(power(0.5, extract(epoch from now() - v.created_at) / 86400.0 / 14))
                from tribune.vote v where v.post_id = po.id), 0)
      + 0.5 * coalesce((select sum(power(0.5, extract(epoch from now() - c.created_at) / 86400.0 / 14))
                from tribune.comment c where c.post_id = po.id and not c.internal and c.deleted_at is null), 0) as score
    from tribune.post po
    where (p is null or po.id = p) and po.merged_into_id is null
  ), u as (
    update tribune.post po set score_trending = s.score from s
    where po.id = s.id and po.score_trending is distinct from s.score
    returning 1
  )
  select count(*)::integer from u
$$;

-- Backlog: demand is kept as separate signals (people, companies, MRR exposure
-- counted once per company, weighted votes) before being combined into a
-- RICE-like priority. Weight of a voter: its own weight, else its segment
-- weight from site.config.segment_weights, else 1.
create or replace view tribune.backlog_v as
select
  po.id, po.site_id, po.board_id, po.number, po.title, po.status_id, po.vote_count,
  po.impact, po.confidence, po.effort, po.created_at,
  count(distinct v.user_id)                                    as people,
  count(distinct u.company_id)                                 as companies,
  coalesce((select sum(c.mrr) from tribune.company c where c.id in (
     select u2.company_id from tribune.vote v2 join tribune.app_user u2 on u2.id = v2.user_id
     where v2.post_id = po.id and u2.company_id is not null)), 0) as mrr,
  coalesce(sum(coalesce(u.weight, (s.config->'segment_weights'->>u.segment)::numeric, 1)), 0) as weighted_votes,
  case when po.impact is not null and po.effort is not null then
    round(coalesce(sum(coalesce(u.weight, (s.config->'segment_weights'->>u.segment)::numeric, 1)), 0)
          * po.impact * coalesce(po.confidence, 0.8) / po.effort, 2)
  end as priority
from tribune.post po
join tribune.site s on s.id = po.site_id
left join tribune.vote v on v.post_id = po.id
left join tribune.app_user u on u.id = v.user_id
where po.merged_into_id is null and not po.hidden
group by po.id, s.config;

create table if not exists tribune.migration (
  name       text primary key,
  applied_at timestamptz not null default now()
);
