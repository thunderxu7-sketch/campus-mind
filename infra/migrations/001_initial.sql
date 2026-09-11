-- Campus Mind reference schema. Apply with a migration identity, never the app role.
-- This is intentionally not wired to a live database in the local demo.
create extension if not exists pgcrypto;

create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  region text,
  created_at timestamptz not null default now()
);
alter table tenants add column if not exists region text;
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
  mfa_secret_ciphertext text,
  mfa_last_used_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, email),
  unique (tenant_id, id),
  foreign key (tenant_id, school_id) references schools(tenant_id, id)
);
alter table users add column if not exists mfa_secret_ciphertext text;
alter table users add column if not exists mfa_last_used_at timestamptz;
create table if not exists sessions (
  token_hash text primary key,
  tenant_id uuid not null references tenants(id),
  user_id uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (tenant_id, token_hash),
  foreign key (tenant_id, user_id) references users(tenant_id, id)
);
create index if not exists active_sessions_by_user on sessions(tenant_id, user_id, expires_at) where revoked_at is null;
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
  unique (tenant_id, id),
  foreign key (tenant_id, school_id) references schools(tenant_id, id)
);
create table if not exists student_access_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  code_hash text not null,
  expires_at timestamptz not null,
  issued_by uuid not null,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, code_hash),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, issued_by) references users(tenant_id, id)
);
create index if not exists active_student_credentials on student_access_credentials(tenant_id, student_id, expires_at) where used_at is null;
create table if not exists guardian_links (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), student_id uuid not null, guardian_user_id uuid not null,
  status text not null check (status in ('pending','verified','revoked')), verified_by uuid, verified_at timestamptz, created_at timestamptz not null default now(),
  unique (tenant_id, id), unique (tenant_id, student_id, guardian_user_id),
  foreign key (tenant_id, student_id) references students(tenant_id, id), foreign key (tenant_id, guardian_user_id) references users(tenant_id, id)
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
  created_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  foreign key (tenant_id, created_by) references users(tenant_id, id),
  unique (tenant_id, code, version),
  unique (tenant_id, id)
);
alter table assessment_plans add column if not exists created_by uuid;
do $$
begin
  alter table assessment_plans add constraint assessment_plans_created_by_fk foreign key (tenant_id, created_by) references users(tenant_id, id);
exception when duplicate_object then null;
end $$;
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
  foreign key (tenant_id, plan_id) references assessment_plans(tenant_id, id),
  unique (tenant_id, id)
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
  unique (tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, campaign_id) references campaigns(tenant_id, id)
);
-- A reviewed exception may coexist with the ordinary annual reservation. Normal
-- reservations remain unique while an exception row is kept as an audit marker.
alter table frequency_reservations drop constraint if exists frequency_reservations_tenant_id_student_id_academic_year_key;
create unique index if not exists active_frequency_reservation on frequency_reservations(tenant_id, student_id, academic_year) where status in ('reserved','consumed');
create unique index if not exists exception_frequency_reservation on frequency_reservations(tenant_id, student_id, academic_year, campaign_id) where status = 'exception';

create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  actor_id uuid,
  action text not null,
  object_type text not null,
  object_id text not null,
  purpose text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
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
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

-- Spreadsheet intake is a two-step, tenant-scoped workflow.  The preview hash
-- prevents a caller from validating one file and committing another payload.
create table if not exists import_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  school_id uuid not null,
  created_by uuid not null,
  filename text not null,
  status text not null check (status in ('previewed','committed','rejected')),
  mapping_version integer not null check (mapping_version > 0),
  row_count integer not null check (row_count between 1 and 10000),
  valid_row_count integer not null check (valid_row_count between 0 and row_count),
  error_count integer not null check (error_count between 0 and row_count),
  preview_hash text not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, school_id) references schools(tenant_id, id),
  foreign key (tenant_id, created_by) references users(tenant_id, id),
  unique (tenant_id, id)
);
create table if not exists import_rows (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  batch_id uuid not null,
  row_number integer not null check (row_number between 1 and 10000),
  status text not null check (status in ('valid','error')),
  message text,
  synthetic_student_id text,
  foreign key (tenant_id, batch_id) references import_batches(tenant_id, id),
  unique (tenant_id, id),
  unique (tenant_id, batch_id, row_number)
);

-- Every tenant-owned table must have a policy in the production migration set.
-- The application sets app.tenant_id only inside a transaction; an absent setting denies rows.
alter table tenants enable row level security;
alter table schools enable row level security;
alter table users enable row level security;
alter table sessions enable row level security;
alter table students enable row level security;
alter table student_access_credentials enable row level security;
alter table guardian_links enable row level security;
alter table consents enable row level security;
alter table assessment_plans enable row level security;
alter table campaigns enable row level security;
alter table frequency_reservations enable row level security;
alter table audit_events enable row level security;
alter table outbox_events enable row level security;
alter table import_batches enable row level security;
alter table import_rows enable row level security;

do $$
begin
  execute 'create policy tenant_isolation on tenants using (id::text = current_setting(''app.tenant_id'', true)) with check (id::text = current_setting(''app.tenant_id'', true))';
  execute 'create policy schools_isolation on schools using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
  execute 'create policy users_isolation on users using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
  execute 'create policy sessions_isolation on sessions using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
  execute 'create policy students_isolation on students using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
  execute 'create policy student_access_credentials_isolation on student_access_credentials using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
  execute 'create policy guardian_links_isolation on guardian_links using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
  execute 'create policy consents_isolation on consents using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
  execute 'create policy plans_isolation on assessment_plans using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
  execute 'create policy campaigns_isolation on campaigns using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
  execute 'create policy frequency_isolation on frequency_reservations using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
  execute 'create policy audit_isolation on audit_events using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
  execute 'create policy outbox_isolation on outbox_events using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
  execute 'create policy import_batches_isolation on import_batches using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
  execute 'create policy import_rows_isolation on import_rows using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
exception when duplicate_object then null;
end $$;
-- Keep the session policy migration-safe when older databases already have
-- the core policies created by the block above.
do $$ begin
  execute 'create policy sessions_isolation on sessions using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
exception when duplicate_object then null;
end $$;
do $$ begin
  execute 'create policy student_access_credentials_isolation on student_access_credentials using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
exception when duplicate_object then null;
end $$;

-- The runtime role must not own these tables and must not have BYPASSRLS.
-- GRANT SELECT, INSERT, UPDATE, DELETE ... to campus_mind_app; is intentionally environment-specific.

-- Remaining tenant-owned workflow tables (all references carry tenant_id).
create table if not exists assignments (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), campaign_id uuid not null,
  student_id uuid not null, frequency_reservation_id uuid not null, status text not null, created_at timestamptz not null default now(),
  foreign key (tenant_id, campaign_id) references campaigns(tenant_id, id), foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, frequency_reservation_id) references frequency_reservations(tenant_id, id), unique (tenant_id, campaign_id, student_id), unique (tenant_id, id)
);
create table if not exists attempts (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), assignment_id uuid not null,
  student_id uuid not null, plan_id uuid not null, state text not null, current_revision integer not null default 0,
  started_at timestamptz not null default now(), submitted_at timestamptz, submission_id uuid,
  foreign key (tenant_id, assignment_id) references assignments(tenant_id, id), foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, plan_id) references assessment_plans(tenant_id, id), unique (tenant_id, assignment_id), unique (tenant_id, id)
);
create table if not exists answer_revisions (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), attempt_id uuid not null,
  revision integer not null, answers_ciphertext text not null, saved_at timestamptz not null default now(), actor_id uuid not null,
  foreign key (tenant_id, attempt_id) references attempts(tenant_id, id), unique (tenant_id, attempt_id, revision), unique (tenant_id, id)
);
create table if not exists submissions (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), attempt_id uuid not null,
  answer_revision_id uuid not null, idempotency_key text not null, content_hash text not null, submitted_at timestamptz not null default now(),
  foreign key (tenant_id, attempt_id) references attempts(tenant_id, id), foreign key (tenant_id, answer_revision_id) references answer_revisions(tenant_id, id),
  unique (tenant_id, attempt_id), unique (tenant_id, idempotency_key), unique (tenant_id, id)
);
create table if not exists score_runs (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), submission_id uuid not null,
  scoring_version text not null, status text not null, factor_scores jsonb not null, total numeric not null, validity text not null,
  completed_at timestamptz, error_code text, foreign key (tenant_id, submission_id) references submissions(tenant_id, id), unique (tenant_id, submission_id), unique (tenant_id, id)
);
create table if not exists reports (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), student_id uuid not null, score_run_id uuid not null,
  state text not null, title text not null, summary_ciphertext text not null, limitations_ciphertext text not null, created_at timestamptz not null default now(),
  approved_by uuid, approved_at timestamptz, released_at timestamptz, revoked_at timestamptz,
  foreign key (tenant_id, student_id) references students(tenant_id, id), foreign key (tenant_id, score_run_id) references score_runs(tenant_id, id)
);
create table if not exists risk_signals (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), student_id uuid not null,
  source text not null, submission_id uuid, score_run_id uuid, rule_version text, level text not null, reason_ciphertext text not null,
  status text not null, created_at timestamptz not null default now(), foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, submission_id) references submissions(tenant_id, id), foreign key (tenant_id, score_run_id) references score_runs(tenant_id, id), unique (tenant_id, id), unique (tenant_id, submission_id)
);
create table if not exists risk_cases (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), student_id uuid not null,
  state text not null, priority text not null, signal_ids jsonb not null, assigned_to uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), closure_reason_ciphertext text,
  foreign key (tenant_id, student_id) references students(tenant_id, id), unique (tenant_id, id)
);
create table if not exists risk_reviews (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), case_id uuid not null,
  reviewer_id uuid not null, decision text not null, note_ciphertext text not null, created_at timestamptz not null default now(),
  foreign key (tenant_id, case_id) references risk_cases(tenant_id, id), unique (tenant_id, id)
);
create table if not exists case_acknowledgements (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), case_id uuid not null,
  user_id uuid not null, acknowledged_at timestamptz not null default now(), foreign key (tenant_id, case_id) references risk_cases(tenant_id, id), unique (tenant_id, case_id, user_id)
);
create table if not exists follow_ups (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), case_id uuid not null,
  author_id uuid not null, kind text not null, note_ciphertext text not null, due_at timestamptz, created_at timestamptz not null default now(),
  foreign key (tenant_id, case_id) references risk_cases(tenant_id, id), unique (tenant_id, id)
);
create table if not exists rights_requests (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), student_id uuid not null,
  kind text not null, requester_id uuid not null, status text not null, reason text, result_ciphertext text, created_at timestamptz not null default now(), completed_at timestamptz,
  foreign key (tenant_id, student_id) references students(tenant_id, id), unique (tenant_id, id)
);
-- Keep the reference migration safe to rerun after an earlier draft of the table.
alter table rights_requests add column if not exists result_ciphertext text;
create table if not exists deletion_tombstones (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), student_id uuid not null,
  request_id uuid not null, deleted_at timestamptz not null default now(), retained_categories jsonb not null,
  foreign key (tenant_id, student_id) references students(tenant_id, id), foreign key (tenant_id, request_id) references rights_requests(tenant_id, id), unique (tenant_id, id)
);
create table if not exists export_jobs (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), requested_by uuid not null, approved_by uuid,
  purpose text not null default 'legacy', kind text not null, student_id uuid, status text not null, expires_at timestamptz not null, payload_ciphertext text, created_at timestamptz not null default now(), approved_at timestamptz,
  foreign key (tenant_id, student_id) references students(tenant_id, id), unique (tenant_id, id)
);
alter table export_jobs add column if not exists purpose text;
update export_jobs set purpose = 'legacy' where purpose is null;
alter table export_jobs alter column purpose set default 'legacy';
alter table export_jobs alter column purpose set not null;
create table if not exists delivery_attempts (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), outbox_event_id uuid not null,
  channel text not null, status text not null, attempted_at timestamptz not null default now(), error_code text,
  foreign key (tenant_id, outbox_event_id) references outbox_events(tenant_id, id), unique (tenant_id, id)
);
create table if not exists availability_slots (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), counselor_id uuid not null,
  starts_at timestamptz not null, ends_at timestamptz not null, room text, status text not null,
  check (starts_at < ends_at), unique (tenant_id, id)
);
create table if not exists appointments (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), student_id uuid not null,
  counselor_id uuid not null, slot_id uuid not null, state text not null, note_ciphertext text, idempotency_key text, idempotency_hash text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key (tenant_id, student_id) references students(tenant_id, id), foreign key (tenant_id, slot_id) references availability_slots(tenant_id, id)
);
alter table appointments add column if not exists idempotency_key text;
alter table appointments add column if not exists idempotency_hash text;
create unique index if not exists active_appointment_slot on appointments(tenant_id, slot_id) where state in ('requested','confirmed');
create unique index if not exists appointments_idempotency_key_unique on appointments(tenant_id, student_id, idempotency_key) where idempotency_key is not null;
create table if not exists media_assets (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), filename text not null,
  media_type text not null, kind text not null check (kind in ('image','audio','video','subtitle')), byte_size integer not null check (byte_size > 0 and byte_size <= 1500000),
  sha256 text not null, content_ciphertext text not null, scan_status text not null check (scan_status in ('clean','rejected')),
  created_by uuid not null, created_at timestamptz not null default now(), unique (tenant_id, id), unique (tenant_id, sha256)
);
alter table media_assets add column if not exists object_key text;
create unique index if not exists media_assets_tenant_object_key on media_assets(tenant_id, object_key) where object_key is not null;
create table if not exists content_items (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), title text not null, kind text not null,
  age_min smallint not null, age_max smallint not null, body_ciphertext text not null, state text not null, copyright_source text not null,
  created_by uuid not null, media_asset_id uuid, alt_text text, caption_text text, reviewed_by uuid, published_at timestamptz, created_at timestamptz not null default now(), unique (tenant_id, id),
  foreign key (tenant_id, media_asset_id) references media_assets(tenant_id, id), check (kind in ('article','announcement','media')), check (age_min between 6 and 19 and age_max between age_min and 19)
);
create table if not exists profile_schemas (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), version text not null, fields jsonb not null,
  state text not null, approved_by uuid, created_at timestamptz not null default now(), unique (tenant_id, version), unique (tenant_id, id)
);

-- Enable RLS for every tenant-owned relation declared above. Policies are intentionally explicit.
do $$
declare t text;
begin
  foreach t in array array['assignments','attempts','answer_revisions','submissions','score_runs','reports','risk_signals','risk_cases','risk_reviews','case_acknowledgements','follow_ups','rights_requests','deletion_tombstones','export_jobs','delivery_attempts','availability_slots','appointments','media_assets','content_items','profile_schemas'] loop
    execute format('alter table %I enable row level security', t);
    begin
      execute format('create policy %I on %I using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))', t || '_isolation', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
create table if not exists profile_responses (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id), student_id uuid not null,
  schema_id uuid not null, values_ciphertext text not null, submitted_at timestamptz not null default now(),
  foreign key (tenant_id, student_id) references students(tenant_id, id), foreign key (tenant_id, schema_id) references profile_schemas(tenant_id, id)
);
alter table profile_responses enable row level security;
do $$ begin
  execute 'create policy profile_responses_isolation on profile_responses using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
exception when duplicate_object then null;
end $$;

-- FORCE prevents a table owner from accidentally bypassing policies in a test or maintenance session.
do $$
declare t text;
begin
  foreach t in array array['tenants','schools','users','sessions','students','student_access_credentials','guardian_links','consents','assessment_plans','campaigns','frequency_reservations','audit_events','outbox_events','import_batches','import_rows','assignments','attempts','answer_revisions','submissions','score_runs','reports','risk_signals','risk_cases','risk_reviews','case_acknowledgements','follow_ups','rights_requests','deletion_tombstones','export_jobs','delivery_attempts','availability_slots','appointments','media_assets','content_items','profile_schemas','profile_responses'] loop
    execute format('alter table %I force row level security', t);
  end loop;
end $$;

-- Domain checks backstop the service validation at the database boundary.
do $$
begin
  alter table assessment_plans add constraint assessment_plans_age_check check (min_age between 6 and 19 and max_age between min_age and 19);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table campaigns add constraint campaigns_window_check check (opens_at < closes_at);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table assignments add constraint assignments_status_check check (status in ('assigned','started','completed','declined','expired'));
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table attempts add constraint attempts_state_check check (state in ('not_started','in_progress','submitted','scoring_pending','scored','scoring_failed','invalid','withdrawn','expired'));
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table answer_revisions add constraint answer_revisions_revision_check check (revision > 0);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table risk_signals add constraint risk_signals_shape_check check (source in ('score_rule','self_request','staff_observation','external_referral') and level in ('attention','urgent') and status in ('open','reviewed','dismissed'));
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table rights_requests add constraint rights_requests_shape_check check (kind in ('access','correct','delete','withdraw') and status in ('open','processing','completed','rejected'));
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table export_jobs add constraint export_jobs_shape_check check (kind in ('aggregate','report') and status in ('requested','approved','ready','expired','revoked'));
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table export_jobs add constraint export_jobs_purpose_check check (char_length(btrim(purpose)) between 1 and 120 and purpose !~ E'[\\r\\n]');
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table availability_slots add constraint availability_slots_status_check check (status in ('available','held','blocked'));
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table appointments add constraint appointments_state_check check (state in ('requested','confirmed','completed','cancelled','no_show'));
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table profile_schemas add constraint profile_schemas_state_check check (state in ('draft','approved','retired'));
exception when duplicate_object then null;
end $$;

-- Audit evidence is append-only.  The trigger protects the invariant even if
-- a maintenance session accidentally receives broader table privileges.
create or replace function deny_audit_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'audit_events are append-only';
end;
$$;
drop trigger if exists audit_events_immutable on audit_events;
create trigger audit_events_immutable before update or delete on audit_events
for each row execute function deny_audit_mutation();

-- Approved assessment plans are immutable versions.  A later revocation is a
-- state change, not an in-place edit to scoring, wording, or provenance.
create or replace function enforce_assessment_plan_immutability() returns trigger language plpgsql as $$
begin
  if old.status = 'revoked' then
    raise exception 'revoked assessment plans cannot change';
  end if;
  if old.status = 'approved' and new.status not in ('approved', 'revoked') then
    raise exception 'approved assessment plans can only be revoked';
  end if;
  if old.status = 'approved' and (
    new.code is distinct from old.code or new.title is distinct from old.title or
    new.version is distinct from old.version or new.provenance is distinct from old.provenance or
    new.min_age is distinct from old.min_age or new.max_age is distinct from old.max_age or
    new.scoring_version is distinct from old.scoring_version or new.notice_version is distinct from old.notice_version or
    new.config_json is distinct from old.config_json
  ) then
    raise exception 'approved assessment plans are immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists assessment_plans_immutable on assessment_plans;
create trigger assessment_plans_immutable before update on assessment_plans
for each row execute function enforce_assessment_plan_immutability();

-- Cross-entity references must carry the tenant key as well as the object ID.
-- These constraints are declared after all tables exist so the migration can
-- be re-run against an earlier draft that created the tables without the full
-- relationship set.  A duplicate constraint is harmless on re-application;
-- any existing cross-tenant rows still fail the migration and require an
-- explicit data repair rather than silently weakening isolation.
do $$
begin
  alter table audit_events add constraint audit_events_actor_fk foreign key (tenant_id, actor_id) references users(tenant_id, id);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table assessment_plans add constraint assessment_plans_approved_by_fk foreign key (tenant_id, approved_by) references users(tenant_id, id);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table campaigns add constraint campaigns_created_by_fk foreign key (tenant_id, created_by) references users(tenant_id, id);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table frequency_reservations add constraint frequency_reservations_approved_by_fk foreign key (tenant_id, approved_by) references users(tenant_id, id);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table guardian_links add constraint guardian_links_verified_by_fk foreign key (tenant_id, verified_by) references users(tenant_id, id);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table answer_revisions add constraint answer_revisions_actor_fk foreign key (tenant_id, actor_id) references users(tenant_id, id);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table reports add constraint reports_approved_by_fk foreign key (tenant_id, approved_by) references users(tenant_id, id);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table risk_cases add constraint risk_cases_assigned_to_fk foreign key (tenant_id, assigned_to) references users(tenant_id, id);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table risk_reviews add constraint risk_reviews_reviewer_fk foreign key (tenant_id, reviewer_id) references users(tenant_id, id);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table case_acknowledgements add constraint case_acknowledgements_user_fk foreign key (tenant_id, user_id) references users(tenant_id, id);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table follow_ups add constraint follow_ups_author_fk foreign key (tenant_id, author_id) references users(tenant_id, id);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table rights_requests add constraint rights_requests_requester_fk foreign key (tenant_id, requester_id) references users(tenant_id, id);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table export_jobs add constraint export_jobs_requested_by_fk foreign key (tenant_id, requested_by) references users(tenant_id, id);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table export_jobs add constraint export_jobs_approved_by_fk foreign key (tenant_id, approved_by) references users(tenant_id, id);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table availability_slots add constraint availability_slots_counselor_fk foreign key (tenant_id, counselor_id) references users(tenant_id, id);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table appointments add constraint appointments_counselor_fk foreign key (tenant_id, counselor_id) references users(tenant_id, id);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table media_assets add constraint media_assets_created_by_fk foreign key (tenant_id, created_by) references users(tenant_id, id);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table content_items add constraint content_items_created_by_fk foreign key (tenant_id, created_by) references users(tenant_id, id);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table content_items add constraint content_items_reviewed_by_fk foreign key (tenant_id, reviewed_by) references users(tenant_id, id);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table profile_schemas add constraint profile_schemas_approved_by_fk foreign key (tenant_id, approved_by) references users(tenant_id, id);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table attempts add constraint attempts_submission_fk foreign key (tenant_id, submission_id) references submissions(tenant_id, id);
exception when duplicate_object then null;
end $$;
do $$
begin
  alter table submissions add constraint submissions_answer_revision_fk foreign key (tenant_id, answer_revision_id) references answer_revisions(tenant_id, id);
exception when duplicate_object then null;
end $$;
