-- Batch 1: offline alarms (decision 8) and device settings.

-- Offline alarm threshold per device; null turns it off. 15 minutes by default.
alter table devices add column offline_after_sec integer default 900
  check (offline_after_sec is null or offline_after_sec between 120 and 86400);

-- Two kinds of alarm event share one table so lists, acknowledgement and realtime stay the same.
alter table alarm_events add column kind text not null default 'threshold' check (kind in ('threshold', 'offline'));
alter table alarm_events alter column start_value drop not null;
alter table alarm_events add constraint alarm_events_value_by_kind
  check ((kind = 'threshold' and start_value is not null) or (kind = 'offline' and start_value is null));

-- At most one open offline alarm per device; the offline check relies on this to stay idempotent.
create unique index alarm_events_one_open_offline on alarm_events (device_id) where ended_at is null and kind = 'offline';

-- Offline check scans live devices that have reported at least once.
create index devices_offline_check_idx on devices (last_seen_at) where deleted_at is null and offline_after_sec is not null;
