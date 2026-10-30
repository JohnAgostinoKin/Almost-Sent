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
impact; the owner's completed review is summarized below.

The recorded comparison is ready at
`/scripts/bake-rate.html?review=roast-v12&systems=BEFORE,AFTER&rubric=impact-v1`.
Both versions returned six own-model first reveals without fallback. The
previous version used profanity in one of six leads; roast-v12 used it in six
of six. One previous-version lead was unscored after the taste judge failed;
that fact is retained in the snapshot. No results were replaced or rerolled.
All fifteen automated tests pass.

The completed owner review is preserved as `owner-ratings.csv`, joined to
the exact recorded outputs in `owner-feedback.json`. Both versions earned
three STRONG ratings. BEFORE also earned one MILD and two NONE; AFTER earned
two MILD and one NONE. Screenshot picks increased from zero to two: the new
weirdo/mother-return roast and the profile-picture roast. Pairwise reaction
strength improved on two inputs, declined on one, and tied on three. The
previous promotion line beat the new one despite its unavailable automatic
taste score. The new speech line was marked NONE / too far; this is specific
feedback, not a blanket ban on family jokes, since the mother-return line
was a screenshot pick.

One of those two screenshot picks was on the supplied tone-reference input.
Across the five fresh inputs, AFTER earned two STRONG ratings and one
screenshot pick; BEFORE earned three STRONG ratings and no screenshot picks.
This supports the voice direction but does not establish consistent shock
or a broad quality win. No shock, embarrassment or disgust tags were selected;
optional omissions do not prove those reactions were absent. These ratings
are saved as evidence and have not changed runtime prompts. A future
calibration should retain the positively rated examples and test fresh inputs,
with strength, share intent and unwanted reactions still measured separately.

## Hermes versus Sonnet with the roast voice

`bake/reviews/roast-model-v12/` records a separate model comparison using six
fresh inputs from `bake/roast-model-inputs-v12.json`. Both previews ran commit
`5c8d63101f8585fb14501befd4f355532cee6756`, with identical initial writer
messages, lane mix, examples, judging and runtime deadlines. The latest owner
ratings were not used to change those prompts. Initial message hashes and
the model-compatible reasoning settings are recorded in `run.json`.

Claude Sonnet 5.5 produced six of six own-model first reveals; Hermes 4 405B
produced five of six. Hermes' emergency-contact attempt stalled after its
candidates were filtered by safety. No fallback writer appeared. Median
HTTP roundtrip was 8.22 seconds for Claude and 8.64 seconds for Hermes across
all six attempts each. These are observed run timings, not a general speed
benchmark. Normal in-request retry and rescue behavior was left intact, but
there were no manual rerolls and no swaps to later reveals.

Rate the actual first reveals blind at
`/scripts/bake-rate.html?review=roast-model-v12&systems=CLAUDE,HERMES&rubric=impact-v1`.
The failed attempt remains visible as a no-reveal placeholder. All eleven
reviewable outputs now have owner ratings in `owner-feedback.json`, alongside
the original CSV. Hermes won three of five paired ratings; Claude won one and
one tied. Each model earned one STRONG rating and zero screenshot picks.
Two outputs were flagged too long. The unrated Hermes stall is kept separate
from real outputs; no NONE rating is invented for it. Neither writer has
established a launch-quality voice.

## Short roast revision (v13)

The owner's next direction is an abrupt, filthy reveal that stops on its
strongest word. Aim for six to ten continuation words, with fourteen as a
hard ceiling. The exact tail `, you fucking cockroach` weakened a reviewed
line; a narrow cleanup removes terminal comma-led name-calling before the
word cap and judges run. It preserves an insult that is the entire reveal
or part of a substantive clause; it does not truncate at arbitrary commas.

Writer examples are shorter, using the owner's non-graphic excuse/sister
and party references as calibration. Safety boundaries remain in place,
including the exclusion of graphic sexual-act descriptions. Two roast slots
are balanced with exposure, grossness and an unhinged admission, instead of
three roast slots. The judge now sees the latest NONE-rated examples rather
than treating bizarre imagery or profanity as automatically high impact.
Cache version: `short-roast-v13`. Seventeen automated tests cover the known
tail regression, preserved clauses, short word cap, model parameter
compatibility and existing generation behavior.

The model comparison in `bake/reviews/short-roast-v13/` uses six fresh inputs
committed before generation in `bake/short-roast-inputs-v13.json`. All three
previews ran frozen commit `1607a03`; initial prompt messages were reconstructed,
compared and hashed. Claude Sonnet 5.5 and DeepSeek V4.1 Flash 1017 each returned
six own-model first reveals with no fallback. Mistral Large 4 returned none:
five attempts used the older Mistral Large 2512 fallback and one stalled.
Those six attempts remain in `MISTRAL.json` with empty rating entries, rather
than attributing fallback text to the requested writer. Mistral used supported
low reasoning; DeepSeek used its supported non-thinking mode. Normal runtime
retries and rescue were enabled, with no manual rerolls or later-reveal swaps.

Median HTTP time was 7.93 seconds for Sonnet, 8.40 for DeepSeek and 14.35 for
the unsuccessful Mistral Large 4 attempts. All twelve valid continuations fit
the 14-word app ceiling (Sonnet: 9–13; DeepSeek: 9–14, using the app's whitespace
count, which can count standalone punctuation). The owner's eleven ratings
are saved in `owner-ratings.csv` and joined to the exact outputs in
`owner-feedback.json`: Sonnet has one STRONG and five MILD; DeepSeek has four
MILD and one NONE, with its sixth real output unrated. Both have zero screenshot
picks. Sonnet wins two of five rated pairs, with three ties. The owner rejects
this direction; these results do not establish a launch-quality writer.
One Sonnet snapshot preserves a duplicated question mark from
the existing composer, rather than silently altering the recorded result.

Rate the twelve valid first reveals at
`/scripts/bake-rate.html?review=short-roast-v13&systems=CLAUDE,DEEPSEEK&rubric=impact-v1`.
Mistral Large 4 is excluded from this rating UI because it has no own-model
outputs to rate; its failures remain part of the recorded test. Production
and the preview's Sonnet writer configuration remain unchanged.

## Recovered original five-category reference

The owner recalls an early setup with shock, gross and deranged among five
categories. The original v7 setup at `0fddc35c8dd14e98a839dad29e8b9787203b6b57`
matches: **shock, raunchy, deranged, confession, gross**. Its writer is
`nousresearch/hermes-4-405b`, with the original prompt examples and judge/selection
rules. Later Hermes experiments rewrote those rules; the model name alone does
not identify the version. These category keys also survive in later versions,
so the category clue is a match rather than proof of the owner's exact memory.

The existing immutable reference preview is
https://almost-sent-fsvlosw65-agostino-technology-group.vercel.app . Vercel metadata
confirms that preview's original commit, and captured first-run traces confirm
Hermes for all 19 real outputs (one further attempt stalled). The original
20-attempt blind review in `bake/reviews/comedy-model-v8/` received seven LOL
ratings and three screenshot picks, versus three LOLs and zero picks for the
first rewrite using the same writer. That older laughter rubric is not pooled
with the later impact rubric.

Two recognition examples from the owner's original screenshot picks:

- "I added you to the team photo. i also added myself to all your childhood photos. we go way back."
- "I left my umbrella at your place yesterday. and my underwear. you'll find them both soaked."

This recovery records and reopens the original reference. It does not rewrite
prompts again, start another model bake, or change production or preview writer
configuration. The latest partial owner ratings are preserved before any next
creative revision.

## Original five voices plus roast direction (v14 experiment)

Branch `codex/original-roast-v14` is a separate preview experiment. It restores
the original Hermes 4 405B writer's five example banks from `0fddc35` verbatim:
shock, raunchy, deranged, confession and gross. The original taste calibration
examples and unweighted reaction + specificity − interchangeable formula are
restored, with a new adult insult-room brief. This is an adaptation of the old
creative setup, not a full runtime rollback.

Removed creative restrictions: blanket bans on adult body/intelligence/family
roasts; invitation-keyword gating of the raunchy lane (prompt, normal results,
stragglers and rescue); mandatory exact-word anchors and separate comic turns;
and automatic rejection of ordinary vocabulary such as “apparently,” “landlord”
or animal names. Same-sender continuity and readability remain taste gates.
The original 18-word ceiling is restored; the brief still asks for under twelve
and an immediate stop at the payoff. The requested trailing-insult cleanup stays.
The current safety judge, input classifier, animal-contact regression guard,
normalization fixes and strongest-first selection behavior are retained.

Preview-only branch settings: `WILDCARD_MODEL=nousresearch/hermes-4-405b` and
`LIVE_DEMOS=1`. The latter makes every homepage chip use real generation rather
than the fixed demo bank. No production database credentials are added. Cache
version: `original-roast-v14b`. Main, production and the original reference
preview are unchanged.

Validation: 20 automated tests pass, including the full handler's uncued raunchy
path and live-demo path, vocabulary filtering, short-tail regression and existing
safety behavior. All five example banks were compared with the original commit;
the safety implementation was checked unchanged from the preceding branch.
The first live smoke run exposed numeric taste scores being parsed as rejection
reasons when the judge omitted a separator. Explicit output examples and a
bounded parser now handle the observed numeric formats; malformed data does not
become a fabricated rejection. The cache version was bumped for the repair.
`bake/original-roast-smoke-v14.json` freezes four functional-check inputs before
deployment. These are smoke checks, not a blind quality benchmark; no improvement
claim or owner rating is implied.

The corrected live preview returned four of four own-model Hermes first reveals,
including the uncued family/looks inputs and `k` through live generation. Every
lead stayed within the 18-word ceiling. One family input needed the normal fill
round and took 12.65 seconds. Both the initial run (three reveals, one stall) and
the corrected run are saved in `bake/reviews/original-roast-v14/`; regenerated
outputs are not presented as a controlled quality improvement. No owner ratings
have been collected for this experiment.

### Thirty-text first-result run

At the owner's request, `bake/reviews/original-roast-v14-30/` records 30 varied
fictional texts against the frozen `48c9655` preview. Three texts per topic were
sampled randomly from a 60-text pool, then shuffled. The inputs and reproducible
sampling manifest were committed before generation. One initial request per
text; only the actual first shipped reveal is shown, with no manual rerolls or
alternate selection. Normal in-request retries and rescue stayed enabled.

Results: 29 Hermes first reveals, zero fallback writers and one safety-eliminated
stall (attempt 20). Median HTTP time: 9.35 seconds. All 29 continuations meet the
18-word ceiling. This is a convenience sample, not random real-user traffic or
a controlled improvement test. Owner ratings are pending.

The unedited JSON and CSV are evaluation records, not approved example banks.
Manual review flags attempt 12's speech-disability insult as a safety miss and
attempts 8 and 23 for possible speaker/situation mismatches. These annotations
are separate from owner ratings. No writer, judge, safety or runtime behavior
was changed during this run.

## Do not add yet

Accounts, a feed, a chatbot, analytics that store pastes.
Save cards are generated in the browser. Nothing is kept.
