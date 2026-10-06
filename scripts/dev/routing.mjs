// LOCAL VERIFICATION ONLY: AI routing, first slice (classification, confirmation and
// correction, explainable match, daee intake strip, AI off), against the real fast model.
//   node --env-file=.env.local scripts/dev/routing.mjs   (needs a running build at VERIFY_BASE)
// Staff passwords come from DEMO_PASSWORD inside this process and are never printed.
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { plainQuestionBox } from "./lib/entry.mjs";

const BASE = process.env.VERIFY_BASE ?? "http://localhost:3127";
const OUT = "docs/screenshots";
const SIZES = { 1440: { width: 1440, height: 900 }, 390: { width: 390, height: 844 } };
const TAG = Date.now().toString(36);
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const ORG = "00000000-0000-4000-8000-000000000001";

const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
async function shots(page, name) {
  for (const [w, size] of Object.entries(SIZES)) {
    await page.setViewportSize(size);
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${OUT}/${name}-${w}.png` });
  }
  await page.setViewportSize(SIZES[1440]);
}
async function login(browser, email) {
  const page = await (await browser.newContext({ viewport: SIZES[1440] })).newPage();
  await page.goto(`${BASE}/en/login`);
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(process.env.DEMO_PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL("**/daee**", { timeout: 20_000 });
  return page;
}
async function ask(browser, locale, pseudonym, question, chip) {
  const page = await (await browser.newContext({ viewport: SIZES[1440] })).newPage();
  await page.goto(`${BASE}/${locale}/enter`);
  await page.locator('main form button[type="submit"]:not([disabled])').waitFor();
  await page.locator("main input:not([type=hidden])").fill(pseudonym);
  await page.locator("main input:not([type=hidden])").press("Enter");
  await page.locator('button[name="skip"]').click();
  await page.waitForURL("**/wait", { timeout: 30_000 });
  await plainQuestionBox(page);
  const q = page.locator('textarea[name="question"]');
  await q.waitFor();
  if (chip) await page.getByRole("button", { name: chip }).click();
  await q.fill(question);
  await q.press("Enter");
  await page.waitForURL("**/chat/**", { timeout: 30_000 });
  return { page, id: page.url().split("/chat/")[1] };
}
const conv = async (id) => (await db.from("conversations").select("topic, depth, classified_by, match_quality, match_reasons, daee_id, status").eq("id", id).single()).data;
const events = async (id, type) => (await db.from("events").select("meta").eq("conversation_id", id).eq("type", type)).data ?? [];

const { data: staff } = await db.from("profiles").select("user_id, display_name").eq("role", "daee");
const KHALID = staff.find((s) => s.display_name === "خالد").user_id;
await db.from("organizations").update({ ai_enabled: true }).eq("id", ORG);
await db.from("profiles").update({ status: "available", last_seen: new Date().toISOString() }).eq("user_id", KHALID);

const browser = await chromium.launch();
try {
  const d1 = await login(browser, "daee1@wasl.demo");

  // ---- Full match: Arabic, about the Qur'an → خالد (Arabic, Qur'an) ------------------------
  const a = await ask(browser, "ar", `rt1-${TAG}`, "ما معنى سورة الفاتحة؟ ولماذا تُقرأ في كل صلاة؟");
  const ca = await conv(a.id);
  check("classified by the AI guide", ca.classified_by === "ai", `topic=${ca.topic} depth=${ca.depth}`);
  const cl = await events(a.id, "classified");
  check("classified event { topic, confidence, source: ai }", cl[0]?.meta.source === "ai" && typeof cl[0]?.meta.confidence === "number");
  check("full match to خالد", ca.match_quality === "full" && ca.daee_id === KHALID, JSON.stringify(ca.match_reasons));
  check("asker sees the match reasons", (await a.page.getByTestId("match").textContent()).includes("خالد"));
  await shots(a.page, "routing-confirm-ar");

  // Daee intake strip before the first reply.
  await d1.goto(`${BASE}/ar/daee/${a.id}`);
  await d1.getByTestId("intake-strip").waitFor({ timeout: 15_000 });
  check("daee intake strip: classified by the AI guide", (await d1.getByTestId("intake-strip").textContent()).includes("صنّف المرشد الآلي"));
  await shots(d1, "routing-intake-strip-ar");

  // ---- Partial match: the asker picks worship; خالد (Arabic, no worship) still takes it ----
  // (Correcting the topic now happens in the guide's summary card: scripts/dev/guide.mjs.)
  await d1.goto(`${BASE}/en/daee/${a.id}`);
  await d1.getByRole("button", { name: /End conversation/ }).click();
  await d1.getByRole("button", { name: "Confirm end" }).click();
  await d1.waitForTimeout(800);
  const p2 = await ask(browser, "ar", `rt4-${TAG}`, "سؤال عن الصلاة وأوقاتها.", "العبادة");
  const cb = await conv(p2.id);
  check("partial match when the topic isn't the daee's (worship)", cb.topic === "worship" && cb.match_quality === "partial" && cb.daee_id === KHALID, JSON.stringify(cb.match_reasons));
  await p2.page.getByTestId("match").waitFor({ timeout: 10_000 });
  check("asker sees the partial match", (await p2.page.getByTestId("match").textContent()).includes("تطابق جزئي"));
  await shots(p2.page, "routing-partial-ar");
  const a2 = p2;
  // Free خالد's slot for the next cases.
  await d1.goto(`${BASE}/en/daee/${a2.id}`);
  await d1.getByRole("button", { name: /End conversation/ }).click();
  await d1.getByRole("button", { name: "Confirm end" }).click();
  await d1.waitForTimeout(800);

  // ---- No match: Indonesian, nobody free in it ---------------------------------------------
  const b = await ask(browser, "id", `rt2-${TAG}`, "Bagaimana kehidupan Nabi Muhammad di Madinah?");
  const cbn = await conv(b.id);
  check("no match: waits, quality none", cbn.match_quality === "none" && cbn.daee_id === null && cbn.status === "waiting");
  await b.page.getByTestId("match").waitFor({ timeout: 10_000 });
  check("asker sees why it waits", (await b.page.getByTestId("match").textContent()).length > 10);
  await shots(b.page, "routing-none-id");

  // ---- AI off: the chip decides, no confirmation card, strip says the asker chose ----------
  await db.from("organizations").update({ ai_enabled: false }).eq("id", ORG);
  const c = await ask(browser, "ar", `rt3-${TAG}`, "سؤال عن معنى التوحيد بلا ذكاء اصطناعي.", "التوحيد");
  const cc = await conv(c.id);
  check("AI off: topic from the chip", cc.classified_by === "chip" && cc.topic === "tawhid");
  const clc = await events(c.id, "classified");
  check("AI off: classified event with source chip", clc[0]?.meta.source === "chip");
  await c.page.waitForTimeout(1500);
  check("AI off: no confirmation card", (await c.page.getByTestId("classification").count()) === 0);
  await d1.goto(`${BASE}/ar/daee/${c.id}`);
  await d1.getByTestId("intake-strip").waitFor({ timeout: 15_000 });
  check("AI off: strip says the asker chose", (await d1.getByTestId("intake-strip").textContent()).includes("اختار السائل"));
  await shots(d1, "routing-intake-chip-ar");
} catch (error) {
  results.push(`ERROR  ${error.message.split("\n")[0]}  at ${(error.stack.match(/routing\.mjs:\d+/) ?? [""])[0]}`);
} finally {
  await browser.close();
  await db.from("organizations").update({ ai_enabled: true }).eq("id", ORG);
  const { data: askers } = await db.from("askers").select("user_id").like("pseudonym", `rt_-${TAG}`);
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
