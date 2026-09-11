-- Campus Mind reference schema. Apply with a migration identity, never the app role.
-- This is intentionally not wired to a live database in the local demo.
create extension if not exists pgcrypto;

create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);
create table if not exists schools (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  school_id uuid,
  email text not null,
  display_name text not null,
  password_hash text not null,
  role text not null check (role in ('platform_ops','school_admin','professional_lead','counselor','teacher','student','guardian','privacy_auditor')),
  active boolean not null default true,
  mfa_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, email),
  foreign key (tenant_id, school_id) references schools(tenant_id, id)
);
create table if not exists students (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  school_id uuid not null,
  class_id text not null,
  external_ref_hash text not null,
  display_name_ciphertext text not null,
  age smallint check (age is null or age between 6 and 19),
  guardian_verified boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, external_ref_hash),
  foreign key (tenant_id, school_id) references schools(tenant_id, id)
);
create table if not exists consents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  purpose text not null check (purpose in ('assessment','support','research')),
  notice_version text not null,
  actor_type text not null check (actor_type in ('student','guardian','school_legal_basis')),
  actor_id text not null,
  status text not null check (status in ('active','withdrawn','expired')),
  recorded_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  foreign key (tenant_id, student_id) references students(tenant_id, id)
);
create unique index if not exists active_consent_per_purpose on consents(tenant_id, student_id, purpose) where status = 'active';

create table if not exists assessment_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  code text not null,
  title text not null,
  version text not null,
  provenance text not null check (provenance in ('synthetic_only','licensed')),
  status text not null check (status in ('draft','approved','revoked')),
  min_age smallint not null,
  max_age smallint not null,
  scoring_version text not null,
  notice_version text not null,
  config_json jsonb not null,
  approved_by uuid,
  approved_at timestamptz,
  unique (tenant_id, code, version)
);
create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  school_id uuid not null,
  name text not null,
  purpose text not null check (purpose in ('screening','survey')),
  state text not null check (state in ('draft','approved','scheduled','open','paused','closed','cancelled','archived')),
  academic_year text not null,
  opens_at timestamptz not null,
  closes_at timestamptz not null,
  plan_id uuid not null,
  participant_snapshot jsonb not null,
  report_visibility text not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  foreign key (tenant_id, school_id) references schools(tenant_id, id),
  foreign key (tenant_id, plan_id) references assessment_plans(tenant_id, id)
);
create table if not exists frequency_reservations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  academic_year text not null,
  purpose text not null check (purpose = 'assessment'),
  status text not null check (status in ('reserved','consumed','released','exception')),
  campaign_id uuid not null,
  approved_by uuid,
  reason text,
  created_at timestamptz not null default now(),
  unique (tenant_id, student_id, academic_year) deferrable initially immediate,
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, campaign_id) references campaigns(tenant_id, id)
);

create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  actor_id uuid,
  action text not null,
  object_type text not null,
  object_id text not null,
  purpose text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create table if not exists outbox_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  type text not null,
  aggregate_id text not null,
  payload jsonb not null,
  status text not null check (status in ('pending','published','dead_letter')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Every tenant-owned table must have a policy in the production migration set.
-- The application sets app.tenant_id only inside a transaction; an absent setting denies rows.
alter table tenants enable row level security;
alter table schools enable row level security;
alter table users enable row level security;
alter table students enable row level security;
alter table consents enable row level security;
alter table assessment_plans enable row level security;
alter table campaigns enable row level security;
alter table frequency_reservations enable row level security;
alter table audit_events enable row level security;
alter table outbox_events enable row level security;

do $$
begin
  execute 'create policy tenant_isolation on tenants using (id::text = current_setting(''app.tenant_id'', true)) with check (id::text = current_setting(''app.tenant_id'', true))';
  execute 'create policy schools_isolation on schools using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
  execute 'create policy users_isolation on users using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
  execute 'create policy students_isolation on students using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
  execute 'create policy consents_isolation on consents using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
  execute 'create policy plans_isolation on assessment_plans using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
  execute 'create policy campaigns_isolation on campaigns using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
  execute 'create policy frequency_isolation on frequency_reservations using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
  execute 'create policy audit_isolation on audit_events using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
  execute 'create policy outbox_isolation on outbox_events using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
exception when duplicate_object then null;
end $$;

-- The runtime role must not own these tables and must not have BYPASSRLS.
-- GRANT SELECT, INSERT, UPDATE, DELETE ... to campus_mind_app; is intentionally environment-specific.
