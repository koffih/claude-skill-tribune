-- Email queue with a lease and bounded retries (see events.ts flushEmails).
alter table tribune.notification add column if not exists mail_claimed_at timestamptz;
alter table tribune.notification add column if not exists mail_attempts integer not null default 0;
alter table tribune.notification add column if not exists mail_next_at timestamptz not null default now();
alter table tribune.notification add column if not exists mail_error text;
drop index if exists tribune.notification_mail_queue;
create index if not exists notification_mail_due on tribune.notification (mail_next_at, created_at)
  where emailed_at is null and email_skip is null;
-- One row per job: last run, last success, last error, for /healthz.
create table if not exists tribune.job_run (
  name        text primary key,
  last_run    timestamptz,
  last_ok     timestamptz,
  last_error  text,
  last_result jsonb
);
