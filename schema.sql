-- 割り勘アプリ v1：テーブル作成
-- ログインなし。アプリは通信のたびに「x-group-id（どのグループか）」と
-- 「x-member-id（誰が操作したか）」を送り、そのグループのデータだけ読み書きできる。

-- 通信に付いてきたグループID・メンバーIDを読む関数
create or replace function public.req_group() returns uuid
language sql stable as $$
  select nullif(current_setting('request.headers', true)::json ->> 'x-group-id', '')::uuid
$$;

create or replace function public.req_member() returns uuid
language sql stable as $$
  select nullif(current_setting('request.headers', true)::json ->> 'x-member-id', '')::uuid
$$;

-- グループ（旅行・飲み会の単位）
create table public.groups (
  id uuid primary key,
  name text not null,
  settle_mode text not null default 'auto' check (settle_mode in ('auto', 'hub')),
  hub_member_id uuid,
  created_at timestamptz not null default now()
);

-- メンバー
create table public.members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

-- 支払い（立て替え）
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  payer_id uuid not null references public.members(id) on delete cascade,
  title text not null,
  amount numeric(14, 2) not null check (amount >= 0),   -- 元の通貨での金額
  currency text not null default 'JPY',
  rate numeric(14, 6) not null default 1,               -- 1単位あたり何円か
  jpy_amount numeric(14, 0) not null check (jpy_amount >= 0), -- 精算に使う円の金額
  jpy_confirmed boolean not null default false,         -- 明細の実額に書き換え済みか
  receipt_path text,                                    -- レシート写真（あとで使う）
  paid_at date not null default current_date,
  created_at timestamptz not null default now()
);

-- その支払いを誰で割るか
create table public.expense_shares (
  expense_id uuid not null references public.expenses(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  group_id uuid not null references public.groups(id) on delete cascade,
  settled boolean not null default false,               -- その場で払い済みか
  primary key (expense_id, member_id)
);

-- 送金済みの記録（「払った」ボタン）
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  from_member_id uuid not null references public.members(id) on delete cascade,
  to_member_id uuid not null references public.members(id) on delete cascade,
  amount numeric(14, 0) not null check (amount > 0),
  kind text not null default 'payment' check (kind in ('payment', 'loan')), -- 送金 or 貸し借り
  note text,
  created_at timestamptz not null default now()
);

-- メモ
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  body text not null default '',
  created_at timestamptz not null default now()
);

-- チェックリスト
create table public.checklist_items (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  text text not null,
  done boolean not null default false,
  done_by uuid references public.members(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ログ（誰がいつ何を変えたか）。自動で書き込まれる
create table public.logs (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null,
  member_id uuid,
  table_name text not null,
  action text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index on public.logs (group_id, created_at desc);

-- 見られる範囲の制限（RLS）と許可
alter table public.groups enable row level security;
create policy groups_select on public.groups for select to anon using (id = public.req_group());
create policy groups_insert on public.groups for insert to anon with check (id = public.req_group());
create policy groups_update on public.groups for update to anon
  using (id = public.req_group()) with check (id = public.req_group());
grant select, insert, update on public.groups to anon;

do $$
declare t text;
begin
  foreach t in array array['members', 'expenses', 'expense_shares', 'payments', 'notes', 'checklist_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for all to anon using (group_id = public.req_group()) with check (group_id = public.req_group())',
      t || '_same_group', t);
    execute format('grant select, insert, update, delete on public.%I to anon', t);
    execute format('create index on public.%I (group_id)', t);
  end loop;
end $$;

alter table public.logs enable row level security;
create policy logs_select on public.logs for select to anon using (group_id = public.req_group());
grant select on public.logs to anon;

-- 変更があったら自動でログを書く仕組み
create or replace function public.write_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare rec jsonb;
begin
  if tg_op = 'DELETE' then rec := to_jsonb(old); else rec := to_jsonb(new); end if;
  insert into public.logs (group_id, member_id, table_name, action, detail)
  values ((rec ->> 'group_id')::uuid, public.req_member(), tg_table_name, tg_op, rec);
  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

do $$
declare t text;
begin
  foreach t in array array['members', 'expenses', 'payments', 'notes', 'checklist_items'] loop
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function public.write_log()',
      t || '_log', t);
  end loop;
end $$;
