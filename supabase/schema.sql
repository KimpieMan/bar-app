create extension if not exists "pgcrypto";

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (char_length(code) between 4 and 12),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.persons (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  person_id uuid not null references public.persons(id) on delete cascade,
  type text not null check (type in ('tick', 'payment')),
  amount numeric(12, 2) not null check (amount > 0),
  event_date date not null,
  created_at timestamptz not null default now()
);

create unique index if not exists transactions_tick_unique
  on public.transactions(group_id, person_id, event_date, type)
  where type = 'tick';

create index if not exists transactions_group_event_idx
  on public.transactions(group_id, event_date desc);

alter table public.groups enable row level security;
alter table public.persons enable row level security;
alter table public.transactions enable row level security;

drop policy if exists "public_access_groups" on public.groups;
drop policy if exists "public_access_persons" on public.persons;
drop policy if exists "public_access_transactions" on public.transactions;

create policy "public_access_groups" on public.groups
  for all
  using (true)
  with check (true);

create policy "public_access_persons" on public.persons
  for all
  using (true)
  with check (true);

create policy "public_access_transactions" on public.transactions
  for all
  using (true)
  with check (true);

alter publication supabase_realtime add table public.persons;
alter publication supabase_realtime add table public.transactions;
