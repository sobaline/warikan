-- 2026-11-25 まとめて反映する分
-- ・ログに変更前を残す ・削除した支払いを割る人ごと記録する ・精算の確定
-- ・支払いの時間と種類 ・個別金額

alter table public.logs add column if not exists old_detail jsonb;
alter table public.groups add column if not exists confirmed_at timestamptz;
alter table public.groups add column if not exists confirmed_by uuid;
alter table public.expenses add column if not exists paid_time time;
alter table public.expenses add column if not exists category text;
alter table public.expense_shares add column if not exists fixed_amount numeric(14, 0);

create or replace function public.write_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare rec jsonb; old_rec jsonb;
begin
  if tg_op = 'DELETE' then rec := to_jsonb(old); else rec := to_jsonb(new); end if;
  if tg_op = 'UPDATE' then old_rec := to_jsonb(old); end if;
  if tg_table_name = 'expenses' and tg_op = 'DELETE' then
    rec := rec || jsonb_build_object('shares', coalesce((
      select jsonb_agg(jsonb_build_object(
        'member_id', s.member_id, 'settled', s.settled, 'fixed_amount', s.fixed_amount))
      from public.expense_shares s where s.expense_id = old.id), '[]'::jsonb));
  end if;
  insert into public.logs (group_id, member_id, table_name, action, detail, old_detail)
  values ((rec ->> 'group_id')::uuid, public.req_member(), tg_table_name, tg_op, rec, old_rec);
  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

drop trigger if exists expenses_log on public.expenses;
drop trigger if exists expenses_log_delete on public.expenses;
create trigger expenses_log after insert or update on public.expenses
  for each row execute function public.write_log();
create trigger expenses_log_delete before delete on public.expenses
  for each row execute function public.write_log();

create or replace function public.groups_confirm_time() returns trigger
language plpgsql as $$
begin
  if new.confirmed_at is not null and new.confirmed_at is distinct from old.confirmed_at then
    new.confirmed_at := now();
  end if;
  return new;
end $$;

drop trigger if exists groups_confirm_time on public.groups;
create trigger groups_confirm_time before update on public.groups
  for each row execute function public.groups_confirm_time();
