-- Credit Card Rewards - initial schema
create extension if not exists pgcrypto;

create table if not exists public.cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  bank text,
  last4 text,
  color_a text not null default '#222831',
  color_b text not null default '#38414d',
  monthly_spend_limit numeric(14,2),
  tip text,
  reward_date_basis text not null default 'transaction' check (reward_date_basis in ('transaction','posted')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.reward_programs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  card_id uuid not null references public.cards(id) on delete cascade,
  name text not null,
  rate numeric(8,4) not null default 0,
  reward_cap numeric(14,2),
  spend_cap numeric(14,2),
  calc_mode text not null default 'monthly_total' check (calc_mode in ('monthly_total','per_transaction')),
  rounding text not null default 'floor' check (rounding in ('floor','round')),
  start_date date,
  end_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  card_id uuid not null references public.cards(id) on delete cascade,
  transaction_date date not null,
  posted_date date,
  title text not null,
  amount numeric(14,2) not null,
  excluded boolean not null default false,
  reconciled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.transaction_reward_exclusions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  reward_program_id uuid not null references public.reward_programs(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(transaction_id, reward_program_id)
);

create index if not exists idx_cards_user on public.cards(user_id);
create index if not exists idx_rewards_card on public.reward_programs(card_id);
create index if not exists idx_tx_user_card_date on public.transactions(user_id, card_id, transaction_date desc);

-- Explicit API privileges because "Automatically expose new tables" is disabled.
revoke all on table public.cards from anon;
revoke all on table public.reward_programs from anon;
revoke all on table public.transactions from anon;
revoke all on table public.transaction_reward_exclusions from anon;

grant select, insert, update, delete on table public.cards to authenticated;
grant select, insert, update, delete on table public.reward_programs to authenticated;
grant select, insert, update, delete on table public.transactions to authenticated;
grant select, insert, update, delete on table public.transaction_reward_exclusions to authenticated;

alter table public.cards enable row level security;
alter table public.reward_programs enable row level security;
alter table public.transactions enable row level security;
alter table public.transaction_reward_exclusions enable row level security;

drop policy if exists "cards_owner_all" on public.cards;
drop policy if exists "rewards_owner_all" on public.reward_programs;
drop policy if exists "transactions_owner_all" on public.transactions;
drop policy if exists "tx_reward_exclusions_owner_all" on public.transaction_reward_exclusions;

create policy "cards_owner_all" on public.cards
for all to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "rewards_owner_all" on public.reward_programs
for all to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "transactions_owner_all" on public.transactions
for all to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "tx_reward_exclusions_owner_all" on public.transaction_reward_exclusions
for all to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
