# Testing

Every suite, what it covers, how to run it, and its latest recorded result. Suites that call the model need `ANTHROPIC_API_KEY` and the model ids in `.env.local`; suites that drive the app need a running build and the database in `.env.local`. No suite uses real conversations or personal data.

## Static checks

| Suite | Covers | Run | Latest result |
| --- | --- | --- | --- |
| TypeScript | Strict types across the repo | `npx tsc --noEmit` | 2026-10-06: no errors |
| ESLint | `eslint-config-next` rules | `npm run lint` | 2026-10-06: no errors |
| Logical properties (`scripts/check-logical.mjs`) | No physical left/right utilities or CSS in `app`, `components`, `lib` (RTL) | `npm run lint` or `npm run lint:rtl` | 2026-10-06: "No physical left/right styles found." |

## Evals (`evals/`)

`npm run evals` runs all four in order. Each runs the task's exact prompt and post-validation outside the app (no database, no logging) through `evals/run-*.ts`.

| Suite | Covers | Run | Latest result |
| --- | --- | --- | --- |
| Card (`promptfooconfig.yaml`, card tier) | Source ids stay inside the selected messages; no ruling or citation markers; a field with nothing selected is "غير محدد"; an injected "give a fatwa" message is not followed; an unselected message is not used | `npx promptfoo eval -c evals/promptfooconfig.yaml --no-cache` | 2026-10-05: 3/3 passed |
| Classify (`classify.yaml`, fast tier) | 20 labeled questions (mostly ar and en, one each in fr, es, ur, id, tl) for topic accuracy, 3 prompt injections; no ruling words in any output | `npm run evals:classify` | 2026-10-06: 23/23 passed; topic accuracy 20/20 (100%), injections 3/3. Previous run 2026-10-05: 22/23 (one en → doubts labeled otherwise) |
| Fence rules (`sources-rules.ts`) | Deterministic, no model: domain allowlist and lookalikes, feqhia never to askers, hadith only with a grading, verse text only from quranpedia.net, dorar sections and language prefixes, level c/d empty for askers, at most 3 results, بينات first for doubts | first half of `npm run evals:sources` | 2026-10-06: 16/16 passed |
| Live sources (`sources.yaml`, fast tier + web search) | Every item from an approved domain, non-empty, ≤ 600 characters; three asker questions return citations; a level d question returns nothing for an asker | second half of `npm run evals:sources` | 2026-10-06: 4/4 passed |
| Assist (`assist-rules.ts`) | Needs filter (greetings, thanks, repeats), passage extension (verbatim, bounded, one paragraph), tone storage rule and closed labels, page chrome rejected; with the model, `plan_queries` returns 1–3 short queries with no ruling or citation, including an injection | `npm run evals:assist` | 2026-10-06: 32/32 passed |

## End-to-end verification (`scripts/dev/*.mjs`)

Playwright scripts against a running build and the database in `.env.local`. Staff passwords come from `DEMO_PASSWORD` inside the process and are never printed. Start a build first:

```bash
npm run build && npx next start -p 3127     # VERIFY_BASE / BASE default to http://localhost:3127
node --env-file=.env.local scripts/dev/<script>.mjs
```

| Script | Covers |
| --- | --- |
| `privacy-probes.mjs` | Database probes for the staff read scope (migration 0019), no browser needed: on a synthetic fixture, the assigned daee reads the asker's background and the intake text and transcript; an unassigned daee, the admin and an anonymous client read none of it; `daee_queue_meta()` returns metadata only. 2026-10-06: 14/14 passed after 0019 (before it, an unassigned daee read the asker background and the intake text: 37 intakes visible) |
| `journey.mjs` | The three manual journeys end to end with two daee and askers (presence, card deletion, end rating, new code, transfer requeue, event dedupe) |
| `verify.mjs` | Two-session chat and screenshots of every changed screen |
| `landing.mjs` | Landing page checks and screenshots (ar, en, ur at 1440 and 390) |
| `routing.mjs` | Classification, confirmation and correction, explainable match, daee intake strip, AI off; real fast model |
| `guide.mjs` | The guide on entry: one question at a time and at most three, the summary, skip to the plain question box, AI off; real model |
| `ai-card.mjs` | The AI card on synthetic conversations, real model; with a second build at `TIMEOUT_BASE` (default :3128) started with `AI_TEST_TIMEOUT_MS=1`, the forced-timeout fallback |
| `master.mjs` | The master card across three sessions for one asker; real model |
| `sources.mjs` | Readings for the asker while waiting and in the daee panel, retrieval order (live, then the auto cache), AI off (no live search) |
| `assist.mjs` | The daee assistant: sources search, quotes, tone; real model |
| `ai-live.mjs` | Live smoke on the deployed app (`LIVE_BASE`, default https://wasl-swart-pi.vercel.app): one AI card, then cleanup of the test asker |
| `admin-synthetic.mjs` | Inserts tagged synthetic metrics to check every admin tile, chart and alert (`--seed`), then removes exactly that data (`--remove`) |
| `og.mjs` | Renders the share image per locale (`npm run og`); a generator, not a test |

Latest journey result: 2026-10-06, 53/53 passed on a fresh production build after migrations 0019 to 0021 (same as the baseline before them).

Live scenario, 2026-10-06: سالم returned with his card and continued with خالد, who ended and answered both resumption questions; `admin_kpis` correct resumption went from n=1, correct=1 to n=2, correct=2 (yes, yes), then n=3, correct=2 (context yes, card no). This run also found and fixed (0021) a return failure for askers with a master card.

Screenshots from these runs are in `docs/screenshots/`.

## Maintenance

`scripts/dev/recheck-library.ts` re-applies the fence to stored auto-verified readings after a rule change:

```bash
npx tsx --env-file=.env.local --conditions=react-server scripts/dev/recheck-library.ts
```
