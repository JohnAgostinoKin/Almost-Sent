-- scripts/precompute-schema.sql
--
-- Run once, by hand, in the Supabase SQL editor (this repo has no migration
-- runner — see scripts/entries-schema.sql). Backs the nightly cache pre-warm:
-- api/cron/precompute.js ranks inbox texts by `hits`, generates each with
-- gpt-6-astra, and writes the result to `precomputed`, which api/draft.js
-- reads on an in-memory cache miss.
--
-- Safe to push the code BEFORE running this: api/draft.js falls back to the
-- plain inbox upsert when bump_inbox is missing, and treats a missing
-- `precomputed` table as a cache miss. The cron itself refuses to run until
-- both exist.

-- 1. Repeat-paste counter. Every existing row starts at 1.
alter table inbox add column if not exists hits integer not null default 1;

-- Same upsert api/draft.js's remember() has always done (merge-duplicates on
-- key, sent refreshed), plus hits + 1 on a repeat. Atomic, unlike a
-- read-modify-write from the client.
create or replace function bump_inbox(p_key text, p_sent text) returns void
language sql as $$
  insert into inbox (key, sent) values (p_key, p_sent)
  on conflict (key) do update set hits = inbox.hits + 1, sent = excluded.sent;
$$;
-- Service role only; the anon/authenticated keys must not be able to call it.
revoke execute on function bump_inbox(text, text) from public, anon, authenticated;

-- 2. Pre-warmed results (7-day TTL, set per row by the cron). `key` is
-- lib/prompt.js's normalizeBefore(sent). Rows whose key starts with "__" are
-- the cron's own per-night spend ledger, not results.
create table if not exists precomputed (
  key text primary key,
  payload jsonb not null,
  gen_model text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists precomputed_expires_idx on precomputed (expires_at);
-- No policies on purpose: only the service role (which bypasses RLS) touches it.
alter table precomputed enable row level security;
