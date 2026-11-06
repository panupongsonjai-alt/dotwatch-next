-- migrate:no-transaction
-- migrate:requires timescaledb
-- Batch 4 (decision 11, old 6.10): hourly rollup for long history ranges, and compression of old raw data.
-- Continuous aggregates cannot be created in a transaction, so each part below runs as its own statement
-- and every part is safe to run again. On plain PostgreSQL this file is skipped (and checked again next time).

-- Old raw chunks compress about 10x. Segmenting by device and metric keeps one device's history fast to read.
do $$
begin
  if not exists (select 1 from timescaledb_information.compression_settings where hypertable_name = 'readings') then
    alter table readings set (timescaledb.compress, timescaledb.compress_segmentby = 'device_id, metric_key', timescaledb.compress_orderby = 'time desc');
  end if;
end
$$;
-- migrate:split
select add_compression_policy('readings', interval '7 days', if_not_exists => true);
-- migrate:split
-- materialized_only = false: the newest hour comes from raw readings, so long-range charts are never stale.
create materialized view if not exists readings_1h
with (timescaledb.continuous, timescaledb.materialized_only = false) as
select device_id, metric_key, time_bucket(interval '1 hour', time) as bucket,
       avg(value) as avg, min(value) as min, max(value) as max, count(*) as n, bool_or(backfilled) as backfilled
  from readings
 group by device_id, metric_key, bucket
with no data;
-- migrate:split
-- 8 days back covers readings that a Pi queue delivers late (backfill up to 7 days).
select add_continuous_aggregate_policy('readings_1h',
  start_offset => interval '8 days', end_offset => interval '1 hour', schedule_interval => interval '30 minutes',
  if_not_exists => true);
-- migrate:split
-- Fill the rollup for data that is already there (empty on a new database, so this is instant).
call refresh_continuous_aggregate('readings_1h', null, now() - interval '1 hour');
