-- Alarm rules and events (ADR 0001, decision 9): normal range + delay + hysteresis, acknowledgement.
-- The rule row also carries its evaluation state, so one row lock serializes evaluation per rule.

create table alarm_rules (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  device_id       uuid not null references devices(id) on delete cascade,
  metric_key      text not null,
  severity        text not null check (severity in ('warning', 'critical')),
  min_value       double precision,
  max_value       double precision,
  delay_seconds   integer not null default 0 check (delay_seconds between 0 and 86400),
  hysteresis      double precision not null default 0 check (hysteresis >= 0),
  enabled         boolean not null default true,
  phase           text not null default 'normal' check (phase in ('normal', 'pending', 'active')),
  phase_since     timestamptz,
  last_eval_time  timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (min_value is not null or max_value is not null),
  check (min_value is null or max_value is null or min_value < max_value),
  unique (device_id, metric_key, severity)
);
create index alarm_rules_eval_idx on alarm_rules (device_id, metric_key) where enabled;

create table alarm_events (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  device_id        uuid not null references devices(id) on delete cascade,
  rule_id          uuid references alarm_rules(id) on delete set null,
  metric_key       text not null,
  severity         text not null check (severity in ('warning', 'critical')),
  min_value        double precision,
  max_value        double precision,
  started_at       timestamptz not null,
  start_value      double precision not null,
  ended_at         timestamptz,
  end_value        double precision,
  acknowledged_at  timestamptz,
  acknowledged_by  uuid references users(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index alarm_events_org_time_idx on alarm_events (org_id, started_at desc);
create index alarm_events_open_idx on alarm_events (org_id, started_at desc) where ended_at is null;
create unique index alarm_events_one_open_per_rule on alarm_events (rule_id) where ended_at is null;
create index alarm_events_device_idx on alarm_events (device_id);
create index alarm_events_ack_user_idx on alarm_events (acknowledged_by) where acknowledged_by is not null;
