-- Batch 4: per-device names and units for metrics, and bookkeeping for the import from the old system.

-- How a metric is shown: the old system let users rename channels (e.g. "ช่อง 3 ห้องแช่แข็ง") and set units.
create table metric_settings (
  device_id   uuid not null references devices(id) on delete cascade,
  metric_key  text not null,
  label       text not null check (char_length(label) between 1 and 60),
  unit        text not null default '' check (char_length(unit) <= 16),
  decimals    smallint not null default 1 check (decimals between 0 and 4),
  sort_order  integer not null default 0,
  hidden      boolean not null default false,
  primary key (device_id, metric_key)
);

-- Old id → new id for everything the import creates, so it can be re-run and resumed safely.
create table legacy_ids (
  kind    text not null,
  old_id  text not null,
  new_id  uuid not null,
  primary key (kind, old_id)
);

-- Telemetry copy progress per old device and source table.
create table legacy_copy_progress (
  old_device_id  text not null,
  source         text not null,
  copied_until   timestamptz not null,
  rows_copied    bigint not null default 0,
  primary key (old_device_id, source)
);
