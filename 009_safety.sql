-- 安全対策の追加
-- 1. 支払いや送金に関わるメンバーは、データベース側でも削除できないようにする
--    （これまでは、メンバーを消すとその人の支払いも一緒に消える設定だった）
-- 2. 暗証番号のまちがいが続くたびに、ロックを 10分 → 1時間 → 1日 と長くする。
--    ロックしたことはログに残し、本人に知らせる

-- 1. メンバー削除の巻き添えを防ぐ
--    「NO ACTION」は、処理の最後に確認する設定。グループごと消すとき（管理者の作業）は
--    支払いも一緒に消えるので通り、メンバーだけを消そうとしたときは拒否される
alter table public.expenses drop constraint if exists expenses_payer_id_fkey;
alter table public.expenses add constraint expenses_payer_id_fkey
  foreign key (payer_id) references public.members(id) on delete no action;

alter table public.expense_shares drop constraint if exists expense_shares_member_id_fkey;
alter table public.expense_shares add constraint expense_shares_member_id_fkey
  foreign key (member_id) references public.members(id) on delete no action;

alter table public.payments drop constraint if exists payments_from_member_id_fkey;
alter table public.payments add constraint payments_from_member_id_fkey
  foreign key (from_member_id) references public.members(id) on delete no action;

alter table public.payments drop constraint if exists payments_to_member_id_fkey;
alter table public.payments add constraint payments_to_member_id_fkey
  foreign key (to_member_id) references public.members(id) on delete no action;

-- 2. ロックを段階的に長くする
alter table public.pin_attempts add column if not exists lock_level int not null default 0;

create or replace function public.login(p_member uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m public.members; a public.pin_attempts; f int; lvl int; mins int;
begin
  select * into m from public.members where id = p_member and group_id = public.req_group();
  if not found then return jsonb_build_object('error', 'member_not_found'); end if;
  if m.pin_hash is null then return jsonb_build_object('error', 'pin_not_set'); end if;
  select * into a from public.pin_attempts where member_id = p_member;
  if a.locked_until is not null and a.locked_until > now() then
    return jsonb_build_object('error', 'locked', 'minutes', ceil(extract(epoch from (a.locked_until - now())) / 60));
  end if;
  if m.pin_hash <> extensions.crypt(coalesce(p_pin, ''), m.pin_hash) then
    insert into public.pin_attempts (member_id, fails) values (p_member, 1)
    on conflict (member_id) do update set fails = public.pin_attempts.fails + 1
    returning fails, lock_level into f, lvl;
    if f >= 5 then
      -- ロックの長さ：1回目 10分、2回目 1時間、3回目以降 1日
      mins := case when lvl <= 0 then 10 when lvl = 1 then 60 else 1440 end;
      update public.pin_attempts
        set fails = 0, lock_level = lock_level + 1, locked_until = now() + make_interval(mins => mins)
        where member_id = p_member;
      insert into public.logs (group_id, member_id, table_name, action, detail)
      values (public.req_group(), null, 'members', 'PIN_LOCKED',
              jsonb_build_object('name', m.name, 'target', p_member, 'minutes', mins));
      return jsonb_build_object('error', 'locked', 'minutes', mins);
    end if;
    return jsonb_build_object('error', 'wrong_pin', 'left', 5 - f);
  end if;
  delete from public.pin_attempts where member_id = p_member;
  perform public.add_log(p_member, 'LOGIN', jsonb_build_object('name', m.name));
  return jsonb_build_object('token', public.new_session(p_member));
end $$;

grant execute on function public.login(uuid, text) to anon;

-- 管理用のログ一覧に、ロックも読みやすく出す
create or replace view admin.logs as
select
  g.name as "グループ",
  l.created_at as "日時",
  m.name as "操作した人",
  case l.table_name
    when 'members' then 'メンバー' when 'expenses' then '支払い' when 'payments' then '送金・貸し借り'
    when 'notes' then 'メモ' when 'checklist_items' then 'チェック項目' when 'groups' then '精算'
    else l.table_name end as "対象",
  case l.action
    when 'INSERT' then '追加' when 'UPDATE' then '変更' when 'DELETE' then '削除'
    when 'CONFIRM' then '確定' when 'UNCONFIRM' then '確定の取り消し' when 'SETTLE_MODE' then '精算方法の変更'
    when 'PIN_SET' then '暗証番号を設定' when 'LOGIN' then 'ログイン' when 'PIN_RESET' then '暗証番号をリセット'
    when 'PIN_LOCKED' then '暗証番号のまちがいでロック'
    else l.action end as "操作",
  coalesce(l.detail ->> 'title', l.detail ->> 'name', l.detail ->> 'text', l.detail ->> 'body', l.detail ->> 'amount') as "内容",
  l.old_detail as "変更前（詳細）",
  l.detail as "変更後（詳細）"
from public.logs l
left join public.groups g on g.id = l.group_id
left join public.members m on m.id = l.member_id
order by l.created_at desc;
