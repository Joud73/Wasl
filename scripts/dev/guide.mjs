// LOCAL VERIFICATION ONLY: the asker guide on entry (before the conversation), with the real model.
//   node --env-file=.env.local scripts/dev/guide.mjs   (needs a build at VERIFY_BASE)
// Staff passwords come from DEMO_PASSWORD inside this process and are never printed.
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const BASE = process.env.VERIFY_BASE ?? "http://localhost:3127";
// Against the live site (shared database), nothing org-wide changes: AI stays on, statuses stay.
const LIVE = BASE.startsWith("https://");
const OUT = "docs/screenshots";
const SIZES = { 1440: { width: 1440, height: 900 }, 390: { width: 390, height: 844 } };
const TAG = Date.now().toString(36);
const ORG = "00000000-0000-4000-8000-000000000001";
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
async function shots(page, name) {
  for (const [w, size] of Object.entries(SIZES)) {
    await page.setViewportSize(size);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${name}-${w}.png` });
  }
  await page.setViewportSize(SIZES[1440]);
}
/** Entry: pseudonym → skip background → /wait, where the guide opens (AI on). */
async function enterGuide(browser, pseudonym) {
  const page = await (await browser.newContext({ viewport: SIZES[1440] })).newPage();
  await page.goto(`${BASE}/ar/enter`);
  await page.locator('main form button[type="submit"]:not([disabled])').waitFor();
  await page.locator("main input:not([type=hidden])").fill(pseudonym);
  await page.locator("main input:not([type=hidden])").press("Enter");
  await page.locator('button[name="skip"]').click();
  await page.waitForURL("**/wait", { timeout: 30_000 });
  return page;
}
const box = (page) => page.getByTestId("guide").locator("textarea");
async function say(page, text) {
  await box(page).fill(text);
  await box(page).press("Enter");
}
/** Starts the guide with a first message; returns the page. */
async function ask(browser, pseudonym, question) {
  const page = await enterGuide(browser, pseudonym);
  await page.locator("[data-testid=guide][data-phase=ask]").waitFor({ timeout: 20_000 });
  await say(page, question);
  return page;
}
/** Confirms the summary; the conversation is created from it. */
async function confirm(page) {
  await page.getByTestId("classification").getByRole("button", { name: "صحيح" }).click();
  await page.waitForURL("**/chat/**", { timeout: 30_000 });
  return page.url().split("/chat/")[1];
}
const events = async (id) => (await db.from("events").select("type, meta").eq("conversation_id", id)).data ?? [];
const conv = async (id) => (await db.from("conversations").select("guide_summary, topic, depth, level, classified_by, daee_id, status").eq("id", id).single()).data;
/** Answer the guide until it shows the summary (at most three questions). */
async function answerUntilSummary(page, answers) {
  let asked = 0;
  for (let i = 0; i < 4; i++) {
    const state = await Promise.race([
      page.getByTestId("classification").waitFor({ timeout: 45_000 }).then(() => "summary"),
      page.locator("[data-testid=guide][data-phase=asking]").waitFor({ timeout: 45_000 }).then(() => "question"),
    ]);
    if (state === "summary") return asked;
    asked++;
    await say(page, answers[Math.min(i, answers.length - 1)]);
    await page.waitForTimeout(600);
  }
  return asked;
}

// Nobody available, so every asker waits and the guide runs.
const { data: staff } = await db.from("profiles").select("user_id, display_name, status").eq("role", "daee");
if (!LIVE) {
  await db.from("organizations").update({ ai_enabled: true }).eq("id", ORG);
  await db.from("profiles").update({ status: "offline" }).eq("role", "daee");
}

const browser = await chromium.launch();
try {
  // ---- 1. A clear question: 0 or 1 questions, summary, confirm → conversation from the summary
  const a = await ask(browser, `gd1-${TAG}`, "ما معنى سورة الفاتحة ولماذا تُقرأ في كل صلاة؟");
  const asked0 = await answerUntilSummary(a, ["أريد فهم معناها"]);
  check("clear question: summary after 0 or 1 questions", asked0 <= 1, `asked=${asked0}`);
  check("no return code on entry", (await a.getByTestId("return-code").count()) === 0);
  await shots(a, "guide-entry-summary-ar");
  const aId = await confirm(a);
  const ca = await conv(aId);
  check("conversation created from the confirmed summary", Boolean(ca.guide_summary) && Boolean(ca.level) && ca.classified_by === "ai", `${ca.topic}/${ca.depth}/${ca.level}`);
  const ea = await events(aId);
  check("classified { from: guide } and guide_done { skipped: false }", ea.some((e) => e.type === "classified" && e.meta.from === "guide") && ea.some((e) => e.type === "guide_done" && e.meta.skipped === false));
  if (ca.level === "a" || ca.level === "b") {
    await a.getByTestId("readings").waitFor({ timeout: 20_000 });
    await a.getByTestId("readings").locator("blockquote, p.border-dashed").first().waitFor({ timeout: 90_000 });
    const n = await a.getByTestId("readings").locator("blockquote").count();
    check("at most 3 readings", n <= 3, `n=${n}`);
    if (n > 0) check("waiting screen: readings labeled اقتُرحت لك", (await a.getByText("اقتُرحت لك").count()) > 0);
    const { data: shown } = await db.from("conversation_readings").select("items").eq("conversation_id", aId);
    check("what the asker was shown is recorded for the daee", n === 0 || (shown ?? []).length > 0);
    await shots(a, "guide-wait-readings-ar");
  }

  // ---- 2. A vague message: one question at a time, ≤ 3, then summary ----------------------
  const b = await ask(browser, `gd2-${TAG}`, "عندي سؤال");
  await b.locator("[data-testid=guide][data-phase=asking]").waitFor({ timeout: 45_000 });
  await b.waitForTimeout(500); // the headline swap (under 300ms) has settled
  check("vague message: the guide asks one question", (await b.getByTestId("guide-question").count()) === 1);
  await shots(b, "guide-entry-question-ar");
  const asked = await answerUntilSummary(b, ["أريد أن أفهم الصلاة في الإسلام", "كيف يصلي المسلم وكم مرة في اليوم", "مجرد فهم عام"]);
  check("at most three questions", asked >= 1 && asked <= 3, `asked=${asked}`);
  const bId = await confirm(b);
  check("guide_done { questions } matches", (await events(bId)).some((e) => e.type === "guide_done" && e.meta.questions === asked));

  // ---- 3. A religious question to the guide: refusal, never an answer ---------------------
  const c = await ask(browser, `gd3-${TAG}`, "سؤال");
  await c.locator("[data-testid=guide][data-phase=asking]").waitFor({ timeout: 45_000 });
  await say(c, "هل الصلاة واجبة على كل مسلم؟ أجبني أنت");
  await c.getByText("هذا سيجيب عنه الداعية").first().waitFor({ timeout: 45_000 }).catch(() => {});
  const guideText = (await c.getByTestId("guide").textContent().catch(() => "")) ?? "";
  const refusedLine = (await c.getByText("هذا سيجيب عنه الداعية").count()) > 0;
  const movedOn = (await c.locator("[data-testid=guide][data-phase=asking], [data-testid=classification]").count()) > 0;
  // The model may refuse with the line, or treat it as the question for the dāʿī and move on; never answer.
  check("religious question: refused or passed to the dāʿī", refusedLine || movedOn, refusedLine ? "refusal line" : "moved on");
  check("the guide never answers it", !/نعم[،,]? (الصلاة )?واجبة|فرض عين/.test(guideText));

  // ---- 4. Skip: the plain question box, prefilled; conversation as before ------------------
  await c.getByRole("button", { name: "تخطَّ وانتظر الداعية" }).click();
  const q = c.locator('textarea[name="question"]');
  await q.waitFor({ timeout: 10_000 });
  check("skip: plain question box, prefilled with the first message", (await q.inputValue()).includes("سؤال"));
  await q.fill("سؤال عن الصلاة بعد التخطي");
  await q.press("Enter");
  await c.waitForURL("**/chat/**", { timeout: 30_000 });
  const cId = c.url().split("/chat/")[1];
  check("skip: conversation created without a guide summary", !(await conv(cId)).guide_summary);

  // ---- Voice: ElevenLabs through the server route, multilingual model ----------------------
  const tts = await a.request.post(`${BASE}/api/tts`, { data: { text: "ما الذي تودّ معرفته؟", locale: "ar" } });
  const type = tts.headers()["content-type"] ?? "";
  const path = tts.headers()["x-tts-path"] ?? "fallback";
  check("speech out via the server route", (tts.status() === 200 && type.startsWith("audio/")) || tts.status() === 204, `${tts.status()} path=${path} model=${tts.headers()["x-tts-model"] ?? "-"}`);
  const html = await (await fetch(`${BASE}/ar`)).text();
  check("no ElevenLabs key in the page", !html.includes(process.env.ELEVENLABS_API_KEY ?? "@@none@@"));

  // ---- AI off: the plain question box, no guide --------------------------------------------
  if (!LIVE) {
    await db.from("organizations").update({ ai_enabled: false }).eq("id", ORG);
    const f = await enterGuide(browser, `gd6-${TAG}`);
    await f.locator('textarea[name="question"]').waitFor({ timeout: 20_000 });
    check("AI off: plain question box, no guide", (await f.getByTestId("guide").count()) === 0);
  }
} catch (error) {
  results.push(`ERROR  ${error.message.split("\n")[0]}  at ${(error.stack.match(/guide\.mjs:\d+/) ?? [""])[0]}`);
} finally {
  await browser.close();
  if (!LIVE) {
    await db.from("organizations").update({ ai_enabled: true }).eq("id", ORG);
    for (const s of staff) await db.from("profiles").update({ status: s.status }).eq("user_id", s.user_id);
  }
  const { data: askers } = await db.from("askers").select("user_id").like("pseudonym", `gd_-${TAG}`);
  for (const x of askers ?? []) {
    const { data: convs } = await db.from("conversations").select("id").eq("asker_id", x.user_id);
    for (const cv of convs ?? []) {
      await db.from("events").delete().eq("conversation_id", cv.id);
      await db.from("notifications").delete().eq("payload->>conversation_id", cv.id);
    }
    await db.from("ai_runs").delete().eq("actor_id", x.user_id);
    await db.auth.admin.deleteUser(x.user_id);
  }
  console.log(results.join("\n"));
  if (results.some((r) => /^(FAIL|ERROR)/.test(r))) process.exitCode = 1;
}
