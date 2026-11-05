-- Core model (ADR 0001): organizations own everything, users join through memberships.

create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  personal    boolean not null default false,
  created_at  timestamptz not null default now()
);

create table users (
  id            uuid primary key default gen_random_uuid(),
  firebase_uid  text not null unique,
  email         text,
  display_name  text,
  created_at    timestamptz not null default now()
);

create table memberships (
  org_id      uuid not null references organizations(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  role        text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user_idx on memberships (user_id);

create table devices (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete restrict,
  code              text not null unique,
  name              text not null,
  secret_hash       bytea not null,
  firmware_version  text,
  last_seen_at      timestamptz,
  created_at        timestamptz not null default now(),
  -- soft delete; telemetry is purged by a background job (fixes old 6.6)
  deleted_at        timestamptz
);
create index devices_org_idx on devices (org_id) where deleted_at is null;

-- One narrow table for every metric (decision 11). The primary key makes device retries idempotent.
create table readings (
  device_id   uuid not null references devices(id),
  metric_key  text not null,
  time        timestamptz not null,
  value       double precision not null,
  backfilled  boolean not null default false,
  primary key (device_id, metric_key, time)
);

-- Newest value per metric, so the dashboard never scans telemetry.
create table latest (
  device_id   uuid not null references devices(id),
  metric_key  text not null,
  time        timestamptz not null,
  value       double precision not null,
  primary key (device_id, metric_key)
);
