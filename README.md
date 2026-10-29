# almost sent.

the draft they never sent.

One page. One paste. One invented deleted draft.

This is fiction. It does not open anyone's phone.

## Stack

- `index.html` — the whole site
- `api/draft.js` — Vercel serverless function
- OpenRouter for the model. No key? It still runs on built-in mocks so you can design.

## Local

```bash
npm i -g vercel
cp .env.example .env
# paste LLM_API_KEY
vercel dev
```

Open http://localhost:3000

Without Vercel:

```bash
npx serve .
```

The page will load. `/api/draft` only works with `vercel dev` or after deploy.

## Deploy to almostsent.app

1. Push this folder to a GitHub repo.
2. Import the repo in Vercel.
3. Add env var `LLM_API_KEY` (and `WILDCARD_MODEL`/`JUDGE_MODEL` once
   you've picked them — see `.env.example` and `npm run bake`).
4. In the domain registrar, point `almostsent.app` to Vercel.
5. In Vercel → Project → Domains → add `almostsent.app`.

## Prompt quality

`lib/prompt.js` writes six candidates in two parallel calls. `lib/judge.js`
checks the sender's point of view, anchor, comic turn and clarity for every
lane. The final winner appears first; later reveals must clear the previous
reaction score and diversity checks. A weaker line no longer fills an empty
slot. One good reveal is enough; an extra round is reserved for a weak or
missing lead. Raunch has no automatic ranking bonus.

Run `npm test` for selection, composition, demo API, and cache regressions.
Tests establish behavior, **not whether a joke is funny**.

For the twelve fixed demo jokes, serve this directory and open
`/scripts/bake-rate.html?review=comedy-v8`. It compares the previous release
with this candidate, hides the labels, randomizes the order, and downloads
ratings locally. These checked-in samples are hand-written demo results,
not AI output. Two unchanged leads serve as controls.

The recorded v8 comparison remains available at
`/scripts/bake-rate.html?review=comedy-model-v8&systems=BEFORE,AFTER,GPT54`.
The owner's uploaded blind ratings are saved with the outputs as
`owner-ratings.csv`; `owner-feedback.json` joins all 58 ratings to the exact
jokes and records the summary. The two unrated cards were failed generations.

| Configuration | Laughs / 20 attempts | Smirks | Screenshot picks | Stalls |
| --- | --- | --- | --- | --- |
| Original Hermes | 7 | 3 | 3 | 1 |
| Revised Hermes | 3 | 5 | 0 | 1 |
| Revised GPT-5.4 | 2 | 7 | 0 | 0 |

This is one rater and one unreplicated sample, but it rejects the claim that
our v8 rewrite improved comedy. The new v10 candidate restores the original
writer examples, tone and lane mix, adds the three screenshot picks and the
owner's meeting-notes edit, and calibrates the judge against actual LOL/BAD
ratings. Selection, invitation filtering, punctuation fixes and safety checks
remain in place. The v10 candidate has not yet earned a human-rated win.

All twenty v8 inputs are now calibration material. Use the fresh
`bake/comedy-inputs-v10.json` corpus for future comparisons. Testing models
must use the same prompt, selection rules and inputs; do not count another
model's fallback response as a successful output from the requested model.
Hermes is a control, not a launch-quality conclusion. A six-input comparison
of `anthropic/claude-sonnet-5.5` and `x-ai/grok-4.7`, using their supported low
reasoning setting, is recorded in `bake/reviews/comedy-model-v10/`. All three
configurations used the same source commit and fresh inputs. Claude returned
6/6 own-model reveals (8.25s median client round trip), Hermes 5/6 (9.63s), and
Grok 0/6 (five stalls and one Mistral fallback, excluded from Grok's results).
These measurements establish runtime behavior, not a human-rated comedy win.
Claude is the next experimental preview writer; production retains Hermes.

Open `/scripts/bake-rate.html?review=comedy-model-v10&systems=HERMES,CLAUDE`
for the six-input blind review. The full failed Grok run remains in the files
and can also be included with `systems=HERMES,CLAUDE,GROK`. No new human
ratings are recorded yet. The first test's owner ratings are not reused as
scores for these new outputs.

For a real model comparison, run the same held-out 20-text corpus against
both checkouts with the same development model credentials:

```bash
# Load a development LLM_API_KEY through your shell/secret manager first.
npm run comedy-check -- --repo ../Almost-Sent-before --system BEFORE
npm run comedy-check -- --system AFTER
# Serve locally, then open /scripts/bake-rate.html?systems=BEFORE,AFTER
npm run bake-tally -- path/to/ratings.csv
```

The runner calls the actual request handler, records only first reveals,
disables database reads/writes, and saves failed requests too. It refuses
to substitute demo results when model credentials are missing. Model tests
incur normal provider costs (up to 20 requests per run, plus judging/retries).

Before promoting a comedy revision, have adults rate the blinded outputs.
Compare laughs and screenshot intent, with stalls included in the request
count. Check wrong-speaker errors and slow requests separately. Judge scores
alone are not a launch gate. Bump `COMEDY_CACHE_VERSION` when the writing or
selection changes so persisted results cannot hide the new behavior.

## Do not add yet

Accounts, a feed, a chatbot, analytics that store pastes.
Save cards are generated in the browser. Nothing is kept.
