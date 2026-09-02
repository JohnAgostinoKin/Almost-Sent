# almost sent.

the draft they never sent.

One page. One paste. One invented deleted draft.

This is fiction. It does not open anyone's phone.

## Stack

- `index.html` — the whole site
- `api/draft.js` — Vercel serverless function
- Groq for the model (free tier). No key? It still runs on built-in mocks so you can design.

## Local

```bash
npm i -g vercel
cp .env.example .env
# paste GROQ_API_KEY
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
3. Add env var `GROQ_API_KEY`.
4. In the domain registrar, point `almostsent.app` to Vercel.
5. In Vercel → Project → Domains → add `almostsent.app`.

## Prompt quality

The product lives or dies in `api/draft.js` (`SYSTEM`).
Write 20 real texts through it before you show anyone.
If a line sounds like therapy, change the prompt, not the page.

## Do not add yet

Accounts, a feed, a chatbot, analytics that store pastes.
Save cards are generated in the browser. Nothing is kept.
