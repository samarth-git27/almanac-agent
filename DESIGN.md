# Almanac: design

**Thesis.** The example prompts are not really about search. They are about *time* ("last Tuesday", "since Monday", "still correct today") and *memory* ("what did I ask you"). Search is the easy part; what makes an agent untrustworthy is wrong calendar arithmetic, an invented past, and stale facts. So **code decides everything that has a right answer** (today's date, which day "last Tuesday" is, what was said then, which URLs were really returned) and **the model does only what a model is for**: choosing queries, reading evidence, writing.

## The three example prompts, walked through
| Prompt | What a naive agent does | What Almanac does |
|---|---|---|
| "On Monday we shortlisted 5 CRMs… changed since?" | Invents the five tools; guesses which Monday | Resolver pins *Monday = Mon 9 Nov*. Recall loads the stored shortlist and its volatile claims, which are re-checked. If nothing is stored, the agent says so in its first sentence, then researches the leading options, labelled as its assumption. |
| "What did I ask on 3 November? Still correct today?" | Fabricates a plausible question | Day lookup returns that day's turns, the stored answer and its claims. Each volatile claim is re-checked and reported as still true / changed / unverifiable. No record means an explicit notice, never a guess. |
| "Last Tuesday I asked about Postgres hosting. Pricing changed since?" | Picks a date by feel; a date filter hides undated pricing pages | "Last Tuesday" on a Wednesday is 3 Nov *or* 10 Nov; both are kept and **the ledger's evidence decides**. One search call asks for *current pricing, no filter* and *news since that date* together. |

## How a turn works
```
message ─► temporal resolver + ledger recall (pure code, no network) ─┐
clock in the user's time zone ───────────────────────────────────────┤
                                                                     ▼
                       model ⇄ web_search  (≤4 rounds, ≤4 parallel searches per call)
                                                                     ▼
       streamed answer ─► citation guard ─► ledger append ─► digest (off the hot path)
```
- **Temporal resolver** (`temporal.ts`): rules turn "on Monday", "last Tuesday", "3 November", "two weeks ago" into concrete days in the user's zone and keep genuine ambiguity. The model is handed `"Monday" = Mon 9 Nov 2026` and never does date maths.
- **Ledger + recall** (`ledger.ts`, `recall.ts`): turns are appended to JSONL; a small model later adds a digest (topic, what the user stated, the assistant's claims, each flagged *volatile* or not). Recall runs *before* the model (resolved days, then BM25 over topical terms) and injects the records or a `NO record exists` notice. It is pre-retrieval, not a tool: the brief allows one tool, and a memory tool would cost a model round-trip.
- **One tool** (`search.ts`): parallel searches, each with its own date filter; results show publication date and age computed in code; bad or future dates are dropped with a note; cached, deduped, size-capped, framed as untrusted.
- **Loop + guards** (`agent.ts`): the last round has tools disabled, so every turn ends in an answer; a failed search is reported as a failure, not "no results"; every URL in the answer must have come from a search or a recalled record, and unknown ones are flagged in the UI.
- **Model-agnostic**: the loop uses a small `ChatModel` interface. Gemini (free tier, default) and Anthropic are separate adapters; the loop is tested offline against a scripted model.
- **Speed**: streaming from the first token, no planner/router call, stable prompt prefix before per-turn context, parallel fan-out, digests written after the answer is sent, no search for timeless questions.

## Considered and rejected
- **A planner/router LLM step**: one extra round-trip per message for a decision the main model makes for free.
- **Vector store or embeddings for memory**: a second API and a dependency. Recall queries are "date + keywords"; dates are resolved exactly, BM25 handles keywords.
- **SQLite or an agent framework**: native builds and abstraction I would have to defend.
- **LLM date parsing**: this is exactly what models get wrong with confidence.
- **A verifier model on every answer**: doubles latency. The citation guard plus per-claim re-check covers most of the value.
- **Summarising history into the prompt**: lossy. Raw turns within a session, structured digests across sessions.

## Honest limits
English-only date grammar. One local user, flat-file memory. Lexical recall misses pure paraphrase. Search relies on snippets, not full pages. Free-tier model quotas cap how many turns a day it can serve.

## With another week
Recorded-fixture evals with an LLM judge (`npm run eval` holds the first tripwires); semantic recall as a fallback when lexical recall misses; prefetching searches for stored volatile claims in parallel with the first model call; multilingual date rules; real auth and storage; a page-extract step for thin snippets; tracing and cost dashboards.
