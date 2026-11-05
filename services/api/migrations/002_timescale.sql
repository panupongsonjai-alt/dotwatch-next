-- Turn readings into a hypertable when TimescaleDB is available (Tiger Cloud, docker compose).
-- Plain PostgreSQL is accepted only outside production (REQUIRE_TIMESCALE is checked by the runner).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'timescaledb') then
    create extension if not exists timescaledb;
    perform create_hypertable('readings', by_range('time', interval '7 days'), if_not_exists => true, migrate_data => true);
  else
    raise notice 'timescaledb not available: readings stays a plain table';
  end if;
end
$$;
