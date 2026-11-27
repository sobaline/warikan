-- 「旅行前の支払い」（航空券・ホテルなど、旅行より前に払ったもの）の印
alter table public.expenses add column if not exists prepaid boolean not null default false;

-- 管理用の支払い一覧にも出す
drop view if exists admin.expenses;
create view admin.expenses as
select
  g.name as "グループ",
  e.paid_at as "日付",
  e.paid_time as "時間",
  e.title as "内容",
  e.jpy_amount as "金額（円）",
  case when e.currency = 'JPY' then null else e.amount || ' ' || e.currency end as "元の金額",
  p.name as "立て替えた人",
  (select string_agg(m.name, '、' order by m.created_at)
     from public.expense_shares s join public.members m on m.id = s.member_id
     where s.expense_id = e.id) as "割った人",
  coalesce(e.category, '未分類') as "種類",
  case when e.prepaid then '旅行前' else '' end as "旅行前",
  e.created_at as "入力日時"
from public.expenses e
join public.groups g on g.id = e.group_id
left join public.members p on p.id = e.payer_id
order by e.paid_at desc, e.paid_time desc nulls last, e.created_at desc;
