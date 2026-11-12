# Almanac

A chat agent with one tool (web search) that knows what day it is and remembers what you asked before.
Architecture and trade-offs: see [DESIGN.md](./DESIGN.md).

## Run it

```bash
npm install
cp .env.example .env     # add TAVILY_API_KEY and GEMINI_API_KEY
npm run dev              # http://localhost:3000
```

| Key | Where to get it | Cost |
|---|---|---|
| `TAVILY_API_KEY` (search, required) | https://app.tavily.com/ | free plan, no card |
| `GEMINI_API_KEY` (model) | https://aistudio.google.com/apikey | free tier, no card |
| `ANTHROPIC_API_KEY` (model, alternative) | https://console.anthropic.com/ | paid / credits |

You need Tavily plus **one** model key. If both model keys are set, Gemini is used unless `PROVIDER=anthropic`.
Everything else in `.env.example` is optional. Needs Node 20.12 or newer.

The default Gemini model is `gemini-3.5-flash-lite` because free-tier daily request caps are much higher for Flash-Lite than for Flash.
Set `MODEL=gemini-3.8-flash` for stronger answers if your quota allows. Free-tier limits change; check yours in Google AI Studio.

## Try the memory questions

A fresh install has no history, so "what did I ask on 3 November?" correctly answers that it has no record.
To try recall without waiting a week:

```bash
npm run seed    # optional: writes three clearly-labelled demo conversations into data/ledger.jsonl
```

then ask *"On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"*
Delete `data/` to reset memory.

## Scripts

| | |
|---|---|
| `npm run dev` | web UI with reload |
| `npm run chat` | same agent in the terminal |
| `npm test` | 35 offline tests (date resolver, recall, search tool, Gemini adapter, full agent loop with a scripted model) |
| `npm run eval` | live behavioural checks (uses real API keys) |
| `npm run typecheck` | `tsc --noEmit` |

## Layout

```
src/clock.ts      calendar maths in the user's time zone
src/temporal.ts   "last Tuesday" → concrete days, ambiguity preserved
src/ledger.ts     append-only JSONL memory + BM25 index
src/recall.ts     pre-retrieval: records, or an explicit NO-RECORD notice
src/search.ts     the one tool: parallel, date-filtered, cached, validated
src/agent.ts      the loop, citation guard, ledger write, async digest
src/model.ts      tiny model interface (+ Anthropic adapter); tests use a scripted model
src/gemini.ts     Gemini adapter (plain fetch + SSE, thought-signature round trip)
src/server.ts     zero-dependency HTTP + SSE;  public/index.html is the UI
```
