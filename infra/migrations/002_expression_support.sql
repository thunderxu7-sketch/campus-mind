-- Campus Mind expression-and-support workflow migration.
-- The feature is intentionally student-led: entries are encrypted, sharing is
-- explicit and revocable, and support requests are not crisis diagnoses.
-- Apply with the migration identity after 001_initial.sql; never with the app
-- role.  The tables below are tenant-scoped and all have RLS + FORCE RLS.

-- Existing enum-like checks must accept the two new consent purposes and the
-- cancelled outbox state.  Dropping/recreating named checks is rerunnable and
-- leaves existing rows untouched.
alter table consents drop constraint if exists consents_purpose_check;
alter table consents add constraint consents_purpose_check check (purpose in ('assessment','support','research','self_expression','visual_interaction'));
alter table outbox_events drop constraint if exists outbox_events_status_check;
alter table outbox_events add constraint outbox_events_status_check check (status in ('pending','published','dead_letter','cancelled'));
do $$
begin
  alter table consents add constraint consents_tenant_id_id_key unique (tenant_id, id);
exception when duplicate_object or duplicate_table then null;
end $$;
do $$
begin
  alter table consents add constraint consents_tenant_student_id_key unique (tenant_id, student_id, id);
exception when duplicate_object or duplicate_table then null;
end $$;
do $$
begin
  alter table users add constraint users_tenant_school_id_key unique (tenant_id, school_id, id);
exception when duplicate_object or duplicate_table then null;
end $$;

create table if not exists expression_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  school_id uuid not null,
  student_id uuid not null,
  source text not null check (source = 'student_self_report'),
  payload_ciphertext text,
  consent_id uuid not null,
  notice_version text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  deleted_at timestamptz,
  idempotency_key text not null,
  request_digest text not null,
  digest_key_version text not null,
  unique (tenant_id, id),
  unique (tenant_id, school_id, student_id, id),
  unique (tenant_id, student_id, idempotency_key),
  foreign key (tenant_id, school_id) references schools(tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, student_id, consent_id) references consents(tenant_id, student_id, id),
  check (expires_at > created_at),
  check (char_length(idempotency_key) between 16 and 128)
);
create index if not exists expression_entries_student_active on expression_entries(tenant_id, student_id, created_at desc) where deleted_at is null;

create table if not exists expression_shares (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  school_id uuid not null,
  student_id uuid not null,
  entry_id uuid not null,
  recipient_id uuid not null,
  consent_id uuid not null,
  notice_version text not null,
  status text not null check (status in ('active','revoked','expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  idempotency_key text not null,
  request_digest text not null,
  digest_key_version text not null,
  unique (tenant_id, id),
  unique (tenant_id, school_id, student_id, id),
  unique (tenant_id, student_id, idempotency_key),
  foreign key (tenant_id, school_id) references schools(tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, school_id, student_id, entry_id) references expression_entries(tenant_id, school_id, student_id, id),
  foreign key (tenant_id, school_id, recipient_id) references users(tenant_id, school_id, id),
  foreign key (tenant_id, student_id, consent_id) references consents(tenant_id, student_id, id),
  check (expires_at > created_at)
);
create unique index if not exists active_expression_share_per_entry on expression_shares(tenant_id, entry_id) where status = 'active';

create table if not exists support_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  school_id uuid not null,
  student_id uuid not null,
  recipient_id uuid not null,
  share_id uuid,
  consent_id uuid not null,
  notice_version text not null,
  state text not null check (state in ('requested','acknowledged','in_contact','follow_up','completed','cancelled')),
  version integer not null default 1,
  policy_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ack_due_at timestamptz not null,
  first_acknowledged_at timestamptz,
  next_follow_up_at timestamptz,
  closed_at timestamptz,
  cancellation_reason text check (cancellation_reason is null or cancellation_reason in ('user_requested','consent_withdrawn')),
  idempotency_key text not null,
  request_digest text not null,
  digest_key_version text not null,
  unique (tenant_id, id),
  unique (tenant_id, student_id, idempotency_key),
  unique (tenant_id, school_id, id),
  unique (tenant_id, school_id, student_id, id),
  foreign key (tenant_id, school_id) references schools(tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, school_id, recipient_id) references users(tenant_id, school_id, id),
  foreign key (tenant_id, school_id, student_id, share_id) references expression_shares(tenant_id, school_id, student_id, id),
  foreign key (tenant_id, student_id, consent_id) references consents(tenant_id, student_id, id),
  check (version > 0),
  check (ack_due_at >= created_at)
);
create index if not exists support_requests_recipient_state on support_requests(tenant_id, recipient_id, state, updated_at desc);
create unique index if not exists active_support_request_per_recipient on support_requests(tenant_id, student_id, recipient_id) where state in ('requested','acknowledged','in_contact','follow_up');

create table if not exists support_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  school_id uuid not null,
  request_id uuid not null,
  author_id uuid not null,
  note_ciphertext text not null,
  created_at timestamptz not null default now(),
  idempotency_key text not null,
  request_digest text not null,
  digest_key_version text not null,
  unique (tenant_id, id),
  unique (tenant_id, author_id, request_id, idempotency_key),
  foreign key (tenant_id, school_id) references schools(tenant_id, id),
  foreign key (tenant_id, school_id, request_id) references support_requests(tenant_id, school_id, id),
  foreign key (tenant_id, school_id, author_id) references users(tenant_id, school_id, id)
);

create table if not exists expression_revocations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  school_id uuid not null,
  student_id uuid not null,
  target_type text not null check (target_type in ('entry','share','consent')),
  target_id uuid not null,
  effect text not null check (effect in ('delete','revoke')),
  recorded_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, school_id) references schools(tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id)
);

-- Explicit policies keep the tenant boundary visible in review and are
-- idempotent for repeatable staging migrations.
do $$
declare t text;
begin
  foreach t in array array['expression_entries','expression_shares','support_requests','support_notes','expression_revocations'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    begin
      execute format('create policy %I on %I using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))', t || '_isolation', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
