-- scripts/funnel.sql
--
-- Weekly funnel queries against Supabase's `events` table (device_id,
-- event, meta jsonb, created_at — see api/event.js for the event
-- whitelist and what each one's meta carries) and, where noted, `inbox`
-- (created_at confirmed via api/cron/cleanup.js's 30-day retention job).
-- Meant to be run one query at a time in the Supabase SQL editor, not as
-- a single script — each is its own numbered block below, independent of
-- the others.
--
-- Every query filters to a trailing 7-day window (`created_at > now() -
-- interval '7 days'`) — change that interval in place if a different
-- window is wanted for a given run. None of this is exact: events are
-- anonymous and correlated only by device_id and rough timing, not a
-- strict request id, so treat every rate here as directionally useful,
-- not a precise A/B-grade number.

-- 1. Generation completion rate: of every "paste", how many produced a
-- first result (draft_shown with revealIndex 0) for the same device
-- within 60 seconds. A no-show here means the request errored, timed
-- out, or got abandoned before a response landed.
with pastes as (
  select device_id, created_at
  from events
  where event = 'paste' and created_at > now() - interval '7 days'
),
completions as (
  select p.device_id, p.created_at
  from pastes p
  where exists (
    select 1 from events e
    where e.device_id = p.device_id
      and e.event = 'draft_shown'
      and (e.meta->>'revealIndex')::int = 0
      and e.created_at between p.created_at and p.created_at + interval '60 seconds'
  )
)
select
  (select count(*) from pastes) as pastes,
  (select count(*) from completions) as completions,
  round(100.0 * (select count(*) from completions) / nullif((select count(*) from pastes), 0), 1) as completion_rate_pct;

-- 2. Median and p95 t_total (server wall-clock, ms) for first results
-- only — logged in draft_shown's own meta.t_total (see index.html's
-- submit handler). Excludes crisis/refusal responses, which don't carry
-- a meaningful generation time and don't log this field at all.
select
  percentile_cont(0.5) within group (order by (meta->>'t_total')::numeric) as median_t_total_ms,
  percentile_cont(0.95) within group (order by (meta->>'t_total')::numeric) as p95_t_total_ms
from events
where event = 'draft_shown'
  and (meta->>'revealIndex')::int = 0
  and meta->>'t_total' is not null
  and created_at > now() - interval '7 days';

-- 2b. t_cold (ms since this container's own module load — see api/
-- draft.js's MODULE_LOADED_AT) for first results, cold vs. warm split,
-- against the same t_total — this is the number that says whether "11s
-- on a cold paste" is still actually happening, and whether it's cold
-- starts specifically dragging t_total up or something else. 500ms is a
-- rough cutoff, not a measured threshold — a container that's truly cold
-- (post keep-warm-miss) should read in the seconds, not hundreds of ms;
-- adjust in place if that line turns out to be in the wrong place once
-- there's real data to look at.
select
  count(*) filter (where (meta->>'t_cold')::numeric >= 500) as cold_count,
  count(*) filter (where (meta->>'t_cold')::numeric < 500) as warm_count,
  percentile_cont(0.5) within group (order by (meta->>'t_cold')::numeric) as median_t_cold_ms,
  percentile_cont(0.95) within group (order by (meta->>'t_cold')::numeric) as p95_t_cold_ms,
  percentile_cont(0.5) within group (order by (meta->>'t_total')::numeric) filter (where (meta->>'t_cold')::numeric >= 500) as median_t_total_ms_when_cold,
  percentile_cont(0.5) within group (order by (meta->>'t_total')::numeric) filter (where (meta->>'t_cold')::numeric < 500) as median_t_total_ms_when_warm
from events
where event = 'draft_shown'
  and (meta->>'revealIndex')::int = 0
  and meta->>'t_cold' is not null
  and created_at > now() - interval '7 days';

-- 3a. First-result 😂 ("hit") rate — reactions tapped on position 1 only.
select
  count(*) filter (where meta->>'value' = 'hit') as hits,
  count(*) as total_reactions,
  round(100.0 * count(*) filter (where meta->>'value' = 'hit') / nullif(count(*), 0), 1) as hit_rate_pct
from events
where event = 'rate'
  and (meta->>'position')::int = 1
  and created_at > now() - interval '7 days';

-- 3b. Any-result 😂 ("hit") rate — reactions across all positions (1-3).
select
  count(*) filter (where meta->>'value' = 'hit') as hits,
  count(*) as total_reactions,
  round(100.0 * count(*) filter (where meta->>'value' = 'hit') / nullif(count(*), 0), 1) as hit_rate_pct
from events
where event = 'rate'
  and created_at > now() - interval '7 days';

-- 4. First-result share rate: of devices that saw a first result, what
-- fraction of THOSE devices logged any share event afterward — native
-- share (files or text), image, copy, text, or email all count the same
-- way toward this (meta.via just distinguishes which). Share events
-- don't carry a position, so this can't cleanly isolate "shared position
-- 1 specifically" from "escalated first, then shared" — read it as
-- "shared at all, at some point after a result" rather than a strict
-- first-line-only share rate.
with first_results as (
  select device_id, min(created_at) as shown_at
  from events
  where event = 'draft_shown' and (meta->>'revealIndex')::int = 0
    and created_at > now() - interval '7 days'
  group by device_id
),
shares as (
  select distinct device_id
  from events
  where event = 'share' and created_at > now() - interval '7 days'
)
select
  count(*) as devices_with_first_result,
  count(*) filter (where s.device_id is not null) as devices_who_shared,
  round(100.0 * count(*) filter (where s.device_id is not null) / nullif(count(*), 0), 1) as share_rate_pct
from first_results f
left join shares s on s.device_id = f.device_id;

-- 5. Second-message rate: of devices that pasted at least once, what
-- fraction pasted a second time (any later "paste" event, same device,
-- same window).
with paste_counts as (
  select device_id, count(*) as pastes
  from events
  where event = 'paste' and created_at > now() - interval '7 days'
  group by device_id
)
select
  count(*) as devices_who_pasted,
  count(*) filter (where pastes >= 2) as devices_with_second_message,
  round(100.0 * count(*) filter (where pastes >= 2) / nullif(count(*), 0), 1) as second_message_rate_pct
from paste_counts;

-- 6. Arrivals / shares: how many share events actually brought a new
-- visitor in (an "arrival" event — a brand-new device's first-ever
-- event, logged only when it showed up via someone else's ?r= link —
-- see index.html's getDeviceId), versus how many shares went out. Not a
-- strict per-share match (a share sent today can land a click next
-- week) — a coarse ratio over the same trailing window, not causal
-- attribution.
select
  (select count(*) from events where event = 'arrival' and created_at > now() - interval '7 days') as arrivals,
  (select count(*) from events where event = 'share' and created_at > now() - interval '7 days') as shares,
  round(
    (select count(*) from events where event = 'arrival' and created_at > now() - interval '7 days')::numeric
    / nullif((select count(*) from events where event = 'share' and created_at > now() - interval '7 days'), 0),
    3
  ) as arrivals_per_share;

-- 7. Crisis rate by source: of every safety verdict logged, what
-- fraction routed to the 988 screen, broken out by which layer caught
-- it — "keyword" (lib/block.js's synchronous regex, state "crisis") or
-- "classifier" (lib/crisis.js's model pre-check, state "explicit_crisis"
-- or "ambiguous_distress"). "curated" never reaches either check, so it
-- never contributes a crisis hit here.
select
  meta->>'source' as source,
  count(*) as total_checks,
  count(*) filter (where meta->>'state' in ('crisis', 'explicit_crisis', 'ambiguous_distress')) as crisis_hits,
  round(100.0 * count(*) filter (where meta->>'state' in ('crisis', 'explicit_crisis', 'ambiguous_distress')) / nullif(count(*), 0), 2) as crisis_rate_pct
from events
where event = 'safety' and created_at > now() - interval '7 days'
group by meta->>'source'
order by source;

-- No query 8 (A/B variant comparison for the proof-first landing test):
-- that test was cancelled before it shipped — item 5 landed as one
-- unconditional example for every visitor, with no meta.variant logged
-- anywhere. Nothing to compare.
