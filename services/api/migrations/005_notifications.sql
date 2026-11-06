-- Batch 2: alarm notifications (ADR 0001, decision 9).

-- Remind until acknowledged, with a ceiling so a forgotten alarm cannot burn the LINE message quota.
alter table organizations
  add column notify_repeat_minutes integer default 30 check (notify_repeat_minutes is null or notify_repeat_minutes between 5 and 1440),
  add column notify_max_reminders integer not null default 3 check (notify_max_reminders between 1 and 10);

create table notification_targets (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  kind             text not null check (kind in ('line', 'email')),
  name             text not null,
  -- email address or LINE user/group/room id; null while a LINE recipient waits for its link code
  address          text,
  min_severity     text not null default 'warning' check (min_severity in ('warning', 'critical')),
  enabled          boolean not null default true,
  link_code        text unique,
  link_expires_at  timestamptz,
  last_sent_at     timestamptz,
  last_error       text,
  created_at       timestamptz not null default now(),
  check (kind = 'line' or address is not null),
  unique (org_id, kind, address)
);
create index notification_targets_org_idx on notification_targets (org_id);

-- Delivery state lives on the event so every step is one idempotent statement.
-- Existing events count as already notified: upgrading must not send a burst of old alarms.
alter table alarm_events
  add column notified_open boolean not null default true,
  add column notified_close boolean not null default true,
  add column reminders_sent integer not null default 0,
  add column last_notified_at timestamptz;
alter table alarm_events alter column notified_open set default false, alter column notified_close set default false;
create index alarm_events_notify_open_idx on alarm_events (started_at) where not notified_open;
create index alarm_events_notify_close_idx on alarm_events (ended_at) where not notified_close and ended_at is not null;

-- Outbox: one row per message per recipient. Sending happens outside any transaction (audit 3.1).
create table notification_jobs (
  id               bigserial primary key,
  org_id           uuid not null references organizations(id) on delete cascade,
  event_id         uuid references alarm_events(id) on delete cascade,
  target_id        uuid not null references notification_targets(id) on delete cascade,
  reason           text not null check (reason in ('opened', 'closed', 'reminder', 'test')),
  reminder_no      integer,
  status           text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'dry_run', 'failed')),
  attempts         integer not null default 0,
  -- sent to LINE / the mail API so a retry after a timeout is not delivered twice
  retry_key        uuid not null default gen_random_uuid(),
  next_attempt_at  timestamptz not null default now(),
  claimed_at       timestamptz,
  sent_at          timestamptz,
  error            text,
  created_at       timestamptz not null default now()
);
create index notification_jobs_due_idx on notification_jobs (next_attempt_at) where status in ('pending', 'sending');
create index notification_jobs_event_idx on notification_jobs (event_id);
create index notification_jobs_target_idx on notification_jobs (target_id, created_at desc);
create index notification_jobs_org_idx on notification_jobs (org_id);
