-- Batch 3: invite people into an organization by email (ADR 0001, decision 7).
create table org_invitations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  email       text not null check (email = lower(email)),
  role        text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  invited_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  unique (org_id, email)
);
create index org_invitations_email_idx on org_invitations (email);
create index org_invitations_invited_by_idx on org_invitations (invited_by) where invited_by is not null;
create index users_email_lower_idx on users (lower(email));
