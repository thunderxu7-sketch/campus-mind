-- Student-owned read/favorite state is intentionally metadata-only and is
-- erased with the subject's retained learning/support data on deletion.
alter table content_items add column if not exists subtitle_asset_id uuid;
alter table content_items add column if not exists category text not null default 'general';
do $$ begin
  alter table content_items add constraint content_items_category_check
    check (category in ('wellbeing','emotion','stress','relationships','sleep','help_seeking','general'));
exception when duplicate_object then null;
end $$;
do $$ begin
  alter table content_items add constraint content_items_subtitle_asset_fk
    foreign key (tenant_id, subtitle_asset_id) references media_assets(tenant_id, id);
exception when duplicate_object then null;
end $$;

create table if not exists content_engagements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  content_id uuid not null,
  read_at timestamptz,
  favorite_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, student_id, content_id),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, content_id) references content_items(tenant_id, id)
);
alter table content_engagements enable row level security;
do $$ begin
  execute 'create policy content_engagements_isolation on content_engagements using (tenant_id::text = current_setting(''app.tenant_id'', true)) with check (tenant_id::text = current_setting(''app.tenant_id'', true))';
exception when duplicate_object then null;
end $$;
alter table content_engagements force row level security;

create index if not exists content_engagements_student_updated
  on content_engagements(tenant_id, student_id, updated_at desc);
