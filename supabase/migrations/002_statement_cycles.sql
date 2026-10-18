-- v0.4.7 — statement cycles and per-program cap reset periods
-- Non-destructive: preserves existing cards, reward programs and transactions.
-- Run once in Supabase SQL Editor before using statement-cycle settings.

alter table public.cards
  add column if not exists statement_close_day integer;

-- NULL: no closing date configured yet. 1-31: bank's nominal monthly closing day.
-- For short months, the cycle ends on that month's last calendar day.
alter table public.cards
  drop constraint if exists cards_statement_close_day_check;
alter table public.cards
  add constraint cards_statement_close_day_check
  check (statement_close_day is null or statement_close_day between 1 and 31);

alter table public.reward_programs
  add column if not exists cap_period text not null default 'calendar';
alter table public.reward_programs
  drop constraint if exists reward_programs_cap_period_check;
alter table public.reward_programs
  add constraint reward_programs_cap_period_check
  check (cap_period in ('calendar','statement'));

-- YYYY-MM identifies the month in which the assigned statement closes.
-- NULL means automatic assignment from posted_date, falling back to transaction_date.
alter table public.transactions
  add column if not exists statement_period_override text;
alter table public.transactions
  drop constraint if exists transactions_statement_period_override_check;
alter table public.transactions
  add constraint transactions_statement_period_override_check
  check (
    statement_period_override is null
    or statement_period_override ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
  );

-- Existing RLS policies and authenticated table grants remain unchanged.
