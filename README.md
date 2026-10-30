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
checks the sender's point of view, subject connection, impact and clarity for every
lane. The final winner appears first; later reveals must clear the previous
reaction score and diversity checks. A weaker line no longer fills an empty
slot. One good reveal is enough; an extra round is reserved for a weak or
missing lead. Raunch has no automatic ranking bonus.

Run `npm test` for selection, composition, demo API, and cache regressions.
Tests establish behavior, **not whether a joke is funny**.

For the archived comparison of twelve fixed demo jokes, serve this directory and open
`/scripts/bake-rate.html?review=comedy-v8`. It compares the two historical versions,
hides the labels, randomizes the order, and downloads
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
and can also be included with `systems=HERMES,CLAUDE,GROK`. The owner's
subsequent partial review is saved as `owner-ratings.csv`, with exact output
joins and original automatic scores in `owner-feedback.json`.

| Writer | Rated outputs | LOL | Smirk | Nothing | Bad | Screenshot picks |
| --- | --- | --- | --- | --- | --- | --- |
| Hermes | 4 | 0 | 1 | 3 | 0 | 0 |
| Claude | 5 | 0 | 1 | 2 | 2 | 0 |

Both reply-all outputs are unrated; the Hermes ex-invitation attempt stalled.
Missing ratings are not counted as negative reactions. Neither writer has
earned a comedy win in this sample. The automatic judge gave the Claude
dessert line reaction 7/10 while the owner rated it BAD, and gave the two
SMIRK outputs only 6/10. That mismatch warrants checking the full candidate
pools against selected leads before another model switch or broader rewrite.
These ratings are evaluation evidence, not new runtime calibration. The first
test's owner ratings are not reused as scores for these new outputs.

The owner subsequently clarified the goal: "I can't believe they almost sent
that" — shock, embarrassment, disgust or a brutal cut; laughter is optional.
The historical tables above measure the old laughter rubric and cannot establish
success or failure on these other reactions. The reaction-v11 writer, taste
judge and pairwise final now accept a concrete revelation without a comic
punchline. Same-sender, anchor, clarity and safety checks remain in place.
This aligns the objective; it is not evidence of improved live output.

New reviews use STRONG / MILD / NONE for reaction strength, with optional
shock, embarrassment, disgust, brutal and laugh tags. Screenshot intent and
failure reasons remain separate: a strong reaction can still miss the owner's
taste. To reconsider the existing samples, use
`/scripts/bake-rate.html?review=comedy-model-v10&systems=HERMES,CLAUDE&rubric=impact-v1`.
Old comedy review URLs retain their original labels and saved ratings. The new
rubric uses separate browser storage and an explicit CSV schema; the tally
prints each rubric separately and never converts old ratings into new ones.

The reaction-v11 bake compares the recorded v10 Claude first reveals with
new v11 Claude first reveals for the same six messages:
`/scripts/bake-rate.html?review=reaction-v11&systems=BEFORE,AFTER&rubric=impact-v1`.
The writer model stays the same; the writing and judging objective changes.
The two versions are unlabeled and randomly ordered on each review card.
Previously seen examples can be recognizable, so this is an exploratory
comparison rather than a fresh held-out evaluation. No old ratings are carried
into it. Exact outputs, source commits and request outcomes are recorded in
`bake/reviews/reaction-v11/`.
Two new attempts have no reviewable Claude lead: one was blocked by the
animal-contact safety correction, and one fell back to a different writer.
Both stay visible as no-reveal attempts; neither was replaced or rerolled.

The owner's partial impact review is preserved in `owner-ratings.csv` and
joined to exact outputs in `owner-feedback.json` within that review directory.

| Version | Rated | Strong | Mild | None | Screenshot picks |
| --- | --- | --- | --- | --- | --- |
| Previous | 4 | 0 | 2 | 2 | 0 |
| Reaction-v11 | 3 | 1 | 0 | 2 | 1 |

The new dessert reveal earned STRONG shock and the only screenshot pick.
The new last-night and airport reveals both earned NONE with a `random`
failure reason. Of three rated pairs, the new version wins on strength once
and the previous version twice. Three valid outputs remain unrated; the two
excluded attempts remain separate. This supplies a specific positive example,
not a consistent overall win. A plausible next writing hypothesis is a clear,
personal revelation carried by a detail in the setup; arbitrary gross details
or a switch to an unrelated situation did not land here. This is an inference
from one owner's small sample, not a new automated acceptance rule.

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

Before promoting a revision, have adults rate the blinded outputs for reaction
strength, type, unwanted reactions and screenshot intent, with stalls included
in the request count. Laughter is optional. Check wrong-speaker errors and slow requests separately. Judge scores
alone are not a launch gate. Bump `COMEDY_CACHE_VERSION` when the writing or
selection changes so persisted results cannot hide the new behavior.

## Current roast direction

The owner wants the energy of an opt-in insult restaurant: blunt, personal,
uncensored and outrageous, with shock and embarrassment valid without a laugh.
Their own reference is “man is he a weirdo ... i wonder if his mother had any
kids that lived!” This is a tone reference, not a claim about an actual family.

Roast-v12 replaces the mild writer examples, makes three of six candidates
direct roasts, and asks for natural profanity in at least two thirds of each
batch. A stronger clean insult can still win. The taste judge accepts direct
personal cuts without requiring a confession, wordplay or a unique noun
callback. Historical laughter examples no longer dominate its calibration;
it uses the owner's explicit examples and actual impact ratings.

Safety now evaluates one sender's full message, rather than incorrectly
describing the continuation as a reply. Ordinary nonliteral adult insults
about looks, intelligence and generic family disappointment are allowed.
Specific unsafe categories stay blocked, including the animal-contact guard.
The cache version is `roast-v12`. Homepage demo leads and alternates match the
new voice, but remain clearly identified in source as assistant-written,
unrated examples.

`bake/roast-inputs-v12.json` contains six comparison inputs. The first is the
owner's supplied example and is a direction check, not held-out evidence.
The other five inputs are fresh. Compare the prior and roast-v12 versions
with the same Claude writer and preserve all failed or fallback attempts.
More profanity establishes a change in voice, not a proven improvement in
impact; that still requires owner ratings.

## Do not add yet

Accounts, a feed, a chatbot, analytics that store pastes.
Save cards are generated in the browser. Nothing is kept.
