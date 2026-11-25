-- 貸し借りの記録：送金の記録（payments）に種類とメモを足す
alter table public.payments add column if not exists kind text not null default 'payment'
  check (kind in ('payment', 'loan'));
alter table public.payments add column if not exists note text;
