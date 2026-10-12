-- Optional school-provided grade label for staff workbench filtering.
-- Grade is never inferred from age; existing rows remain NULL until the
-- school's authorized roster import supplies a value.
alter table students add column if not exists grade text;

do $$
begin
  alter table students add constraint students_grade_length_check
    check (grade is null or length(grade) <= 100);
exception when duplicate_object then null;
end $$;
