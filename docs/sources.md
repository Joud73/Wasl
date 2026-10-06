# Sources, services and credits

## Approved sources (the fence)

Readings come only from these five domains (subdomains count). The list is in `lib/ai/sources/allowlist.ts`; it is passed to the web search tool as `allowed_domains` and applied again to every citation by `rejectReason`. Nothing else is ever shown.

| Domain | Rules |
| --- | --- |
| dawa.center | Allowed. For topic `doubts`, the بينات file (URL containing 7937) is sorted first. |
| islamic-content.com | Allowed. Dictionary pages get a dedicated extractor when a passage is extended (`lib/ai/sources/fetch.ts`). |
| quranpedia.net | Allowed. The only domain verse text may come from. |
| dorar.net | Only the sections hadith (ahadith), aqeeda, tafseer, history and feqhia; any other section is dropped. A language prefix (`/en/tafseer/…`) is ignored. Hadith only with a grading in the passage. Feqhia never reaches an asker; a daee sees it labeled "فقه، لا يُحوَّل إلى فتوى". |
| shamela.ws | Allowed. |

Rules on every citation, in order:
- off the list, not http(s), or a lookalike host: dropped;
- empty text, or page chrome (headings, the page title, bare ellipses) under 40 characters: dropped;
- verse text (﴿﴾, "قال تعالى" formulas, `[سورة …]`, `{…}` with Arabic, `(البقرة: 256)`) outside quranpedia.net: dropped;
- a hadith narration formula anywhere without a grading next to it: dropped;
- passages are verbatim, never edited: at most 600 characters from the search, deduped by URL and text, at most 3 per search.

After the fence, a citation's snippet may be extended to the original passage on the page that contains it (≤ 1,500 characters, a substring of the page). The extended passage goes through the same fence; if it fails, or the fetch fails, the snippet stays as it is. Fetches are https only, no query strings, no raw IPs, public addresses only, redirects checked.

Audience rules:
- an asker gets no readings at level c or d (a personal ruling is level d);
- `library_items.asker_ok = false` marks items kept for daee only.

Tests: `evals/sources-rules.ts` (deterministic) and `evals/sources.yaml` (live). After a rule change, `scripts/dev/recheck-library.ts` re-applies the fence to stored auto items.

## Human-verified library

Seeded from `wasl_reading_library.csv` by `npm run library:seed`; every row passes the same validator (allowlisted URL, per-domain rules, known topic, language and level, non-empty verbatim body) and is stored with `verified_by = human`. Bodies are quoted verbatim in the app with their source.

21 items in the demo database on 2026-10-06, all from islamic-content.com (الجمهرة), all level a except one level b, all `asker_ok`:

| Topic | Lang | Title | Source |
| --- | --- | --- | --- |
| ethics | ar | الأخلاق في الإسلام (حسن الخلق) | https://islamic-content.com/legacy-dictionary/word/4318 |
| ethics | en | Ethics in Islam (good character) | https://islamic-content.com/legacy-dictionary/word/4318/en |
| general | ar | لماذا توجد أحكام مختلفة عند العلماء؟ (معنى الاجتهاد) | https://islamic-content.com/dictionary/word/196 |
| general | ar | ما الإسلام؟ | https://islamic-content.com/legacy-dictionary/word/1018 |
| general | ar | كيف يصبح الشخص مسلمًا؟ (الشهادتان) | https://islamic-content.com/legacy-dictionary/word/6027 |
| general | ar | ماذا يحدث بعد الموت في الإسلام؟ (البعث) | https://islamic-content.com/legacy-dictionary/word/2118 |
| general | en | What is Islam? | https://islamic-content.com/legacy-dictionary/word/1018/en |
| general | en | What happens after death in Islam? (Resurrection) | https://islamic-content.com/legacy-dictionary/word/2118/en |
| general | en | How does someone become a Muslim? (The Two Testimonies) | https://islamic-content.com/legacy-dictionary/word/6027/en |
| prophet | ar | من هو النبي محمد ﷺ؟ | https://islamic-content.com/t/2018 |
| prophet | ar | ما الذي يقوله الإسلام عن عيسى عليه السلام؟ | https://islamic-content.com/t/2017 |
| prophet | ar | ما معنى النبوة؟ | https://islamic-content.com/legacy-dictionary/word/10342 |
| prophet | en | What does prophethood mean? | https://islamic-content.com/legacy-dictionary/word/10342/en |
| quran | ar | ما الوحي؟ | https://islamic-content.com/legacy-dictionary/word/10849 |
| quran | en | What is revelation (Wahy)? | https://islamic-content.com/legacy-dictionary/word/10849/en |
| tawhid | ar | ما معنى التوحيد؟ | https://islamic-content.com/legacy-dictionary/word/3529 |
| tawhid | ar | ما أركان الإيمان؟ وهل يؤمن المسلمون بالأنبياء والكتب السابقة؟ | https://islamic-content.com/legacy-dictionary/word/1190 |
| tawhid | en | What does Tawheed (monotheism) mean? | https://islamic-content.com/legacy-dictionary/word/3529/en |
| tawhid | en | What are the pillars of faith? | https://islamic-content.com/legacy-dictionary/word/1190/en |
| worship | ar | ما معنى العبادة في الإسلام؟ | https://islamic-content.com/legacy-dictionary/word/6732 |
| worship | en | What does worship (Ibaadah) mean in Islam? | https://islamic-content.com/legacy-dictionary/word/6732/en |

Source names: "الجمهرة - معجم المصطلحات الشرعية" for the dictionary pages, "الجمهرة - موسوعة الأعلام" for `/t/2017` and `/t/2018`.

The same database also held 80 `verified_by = auto` items: verbatim citations stored by live searches after passing the fence. They are not human-verified.

## External services

| Service | Used for | Where |
| --- | --- | --- |
| Anthropic API, Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) | Fast tier: `intake`, `classify`, `plan_queries`, `find_sources` (with the `web_search_20250305` tool), `assist_tone` | `lib/ai/runAI.ts`, `lib/ai/tasks/find-sources.ts` |
| Anthropic API, Claude Sonnet (`claude-sonnet-5-5`) | Card tier: `card`, `merge_master` | `lib/ai/runAI.ts` |
| ElevenLabs | Text to speech for the guide's questions (default model `eleven_multilingual_v2`, a premade default voice) | `app/api/tts/route.ts` |
| Web Speech API (browser) | Speech in, and the voice when ElevenLabs is unavailable | `lib/guide/voice.ts` |
| Supabase | Postgres with RLS, Auth (email and anonymous), Realtime | `lib/db/*`, `supabase/migrations` |
| Vercel | Hosting the Next.js app | https://wasl-swart-pi.vercel.app |

Model ids are set in env (`ANTHROPIC_MODEL_FAST`, `ANTHROPIC_MODEL_CARD`); the ids above are the values in `.env.example`. All Anthropic and ElevenLabs calls are server-side.

## Dependencies

Direct dependencies from `package.json`, with the license each package declares (versions as installed).

| Package | Version | License |
| --- | --- | --- |
| @ai-sdk/anthropic | 4.0.71 | Apache-2.0 |
| @base-ui/react | 1.8.0 | MIT |
| @supabase/ssr | 0.12.7 | MIT |
| @supabase/supabase-js | 2.117.2 | MIT |
| ai | 7.0.127 | Apache-2.0 |
| class-variance-authority | 0.7.1 | Apache-2.0 |
| cn | 0.4.0 | MIT |
| lucide-react | 1.52.0 | ISC |
| motion | 14.0.0 | MIT |
| next | 16.3.8 | MIT |
| next-intl | 4.14.9 | MIT |
| react | 19.2.8 | MIT |
| react-dom | 19.2.8 | MIT |
| recharts | 3.10.1 | MIT |
| server-only | 0.0.1 | MIT |
| shadcn | 4.21.1 | MIT |
| sonner | 2.0.8 | MIT |
| tw-animate-css | 1.4.0 | MIT |
| zod | 4.6.5 | MIT |

Dev dependencies:

| Package | Version | License |
| --- | --- | --- |
| @tailwindcss/postcss | 4.3.3 | MIT |
| @types/node | 20.19.43 | MIT |
| @types/react | 19.3.0 | MIT |
| @types/react-dom | 19.3.0 | MIT |
| eslint | 9.39.5 | MIT |
| eslint-config-next | 16.3.8 | MIT |
| playwright | 1.63.0 | Apache-2.0 |
| promptfoo | 0.123.1 | MIT |
| supabase | 2.119.0 | MIT |
| tailwindcss | 4.3.3 | MIT |
| tsx | 4.23.15 | MIT |
| typescript | 5.9.3 | Apache-2.0 |

Fonts: IBM Plex Sans Arabic and Inter (SIL Open Font License).

## Credits

Ahmed, from his contextual-recommendations branch, ported into this repo:
- **Need triggers** (`lib/recommendations/triggers.ts` → `lib/ai/sources/needs.ts`): `normalizeNeed`, `isSubstantiveNeed`, `chooseNeed`. They decide which asker message is a real need worth a search; greetings, thanks and repeats never search, a correction is a new need.
- **Fetch adapter** (`lib/recommendations/fetch-source.ts` → `lib/ai/sources/fetch.ts`): the public-address (SSRF) guard, checked redirects, `extractOriginalArticle`, and the islamic-content.com dictionary adapter. Used to extend a citation's snippet to its verbatim original passage.
