-- Import recovery remains tenant-scoped and preserves the audit trail. Raw
-- uploaded rows are never added to the database; row-level rollback pointers
-- refer only to students created by the batch.
alter table import_batches
  add column if not exists created_count integer not null default 0 check (created_count >= 0),
  add column if not exists duplicate_count integer not null default 0 check (duplicate_count >= 0),
  add column if not exists skipped_count integer not null default 0 check (skipped_count >= 0),
  add column if not exists rolled_back_count integer not null default 0 check (rolled_back_count >= 0),
  add column if not exists rollback_blocked_count integer not null default 0 check (rollback_blocked_count >= 0),
  add column if not exists audit_event_id uuid,
  add column if not exists rollback_audit_event_id uuid;

alter table import_batches drop constraint if exists import_batches_status_check;
alter table import_batches add constraint import_batches_status_check
  check (status in ('previewed','committed','rejected','partially_rolled_back','rolled_back'));

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'import_batches_audit_event_fk') then
    alter table import_batches add constraint import_batches_audit_event_fk
      foreign key (tenant_id, audit_event_id) references audit_events(tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'import_batches_rollback_audit_event_fk') then
    alter table import_batches add constraint import_batches_rollback_audit_event_fk
      foreign key (tenant_id, rollback_audit_event_id) references audit_events(tenant_id, id);
  end if;
end $$;

alter table import_rows add column if not exists created_student_id uuid;
alter table import_rows drop constraint if exists import_rows_status_check;
alter table import_rows add constraint import_rows_status_check
  check (status in ('valid','error','duplicate','imported','skipped','rolled_back','rollback_blocked'));

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'import_rows_created_student_fk') then
    alter table import_rows add constraint import_rows_created_student_fk
      foreign key (tenant_id, created_student_id) references students(tenant_id, id);
  end if;
end $$;

create index if not exists import_batches_recent_by_school
  on import_batches(tenant_id, school_id, created_at desc);
