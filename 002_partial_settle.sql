-- 部分精算：支払いごとに「その場で払い済みの人」を記録する
alter table public.expense_shares add column if not exists settled boolean not null default false;
