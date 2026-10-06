// LOCAL VERIFICATION ONLY: the master card across three sessions for one asker, with the
// real model. node --env-file=.env.local scripts/dev/master.mjs  (needs a build at VERIFY_BASE)
// Staff passwords come from DEMO_PASSWORD inside this process and are never printed.
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { plainQuestionBox } from "./lib/entry.mjs";

const BASE = process.env.VERIFY_BASE ?? "http://localhost:3127";
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
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${OUT}/${name}-${w}.png` });
  }
  await page.setViewportSize(SIZES[1440]);
}
async function say(page, selector, text) {
  const box = page.locator(selector);
  await box.waitFor();
  await box.fill(text);
  await box.press("Enter");
  await page.waitForTimeout(500);
}
async function askOn(page, question, resume) {
  await page.goto(`${BASE}/en/wait`);
  if (resume) await page.getByRole("button", { name: /Continue with .?خالد/ }).click();
  await plainQuestionBox(page);
  const q = page.locator('textarea[name="question"]');
  await q.waitFor();
  await q.fill(question);
  await q.press("Enter");
  await page.waitForURL("**/chat/**", { timeout: 30_000 });
  return page.url().split("/chat/")[1];
}
/** One session: the asker asks, خالد replies, the asker answers; returns the conversation id. */
async function session(asker, d1, question, reply, answer, resume) {
  const id = await askOn(asker, question, resume);
  await d1.goto(`${BASE}/en/daee/${id}`);
  await say(d1, "main textarea", reply);
  await say(asker, "footer textarea", answer);
  return id;
}
/** The session card: everything selected, the AI draft, shared with the team, approved. */
async function approveSessionCard(asker, id) {
  await asker.goto(`${BASE}/en/card/${id}`);
  await asker.getByRole("button", { name: "Continue" }).click();
  await asker.getByText("Draft ready").waitFor({ timeout: 40_000 });
  await asker.getByRole("button", { name: "Continue" }).click();
  await asker.locator("label", { hasText: "The team" }).click();
  await asker.getByRole("button", { name: "Continue" }).click();
  await asker.getByRole("button", { name: "Approve and share" }).click();
  await asker.getByText(/^Approved\./).first().waitFor({ timeout: 15_000 });
}
async function approveMaster(asker, { ai }) {
  if (ai) await asker.getByText("Draft ready").waitFor({ timeout: 40_000 });
  await asker.getByRole("button", { name: "Continue" }).click();
  await asker.locator("label", { hasText: "The team" }).click();
  await asker.getByRole("button", { name: "Continue" }).click();
  await asker.getByRole("button", { name: "Approve and share" }).click();
  await asker.getByText(/Master card approved/).waitFor({ timeout: 15_000 });
}
async function end(d1, id, followup) {
  await d1.goto(`${BASE}/en/daee/${id}`);
  await d1.getByRole("button", { name: /End conversation/ }).click();
  if (followup) await d1.getByRole("dialog").getByRole("button", { name: "Skip and end" }).click();
  else await d1.getByRole("button", { name: "Confirm end" }).click();
  await d1.waitForTimeout(800);
}
const masters = async (askerId) =>
  (await db.from("cards").select("id, version, status, origin, source_card_ids, field_sources, follow_up").eq("asker_id", askerId).eq("scope", "master").order("version")).data ?? [];

const { data: staff } = await db.from("profiles").select("user_id, display_name").eq("role", "daee");
const KHALID = staff.find((s) => s.display_name === "خالد").user_id;
await db.from("organizations").update({ ai_enabled: true }).eq("id", ORG);
// Real conversations may fill خالد's capacity: raise it for this run, restore it after.
const { data: khalidProfile } = await db.from("profiles").select("capacity").eq("user_id", KHALID).single();
await db.from("profiles").update({ status: "available", last_seen: new Date().toISOString(), capacity: khalidProfile.capacity + 3 }).eq("user_id", KHALID);

const browser = await chromium.launch();
let askerId = null;
try {
  const d1page = await (await browser.newContext({ viewport: SIZES[1440] })).newPage();
  await d1page.goto(`${BASE}/en/login`);
  await d1page.locator("#login-email").fill("daee1@wasl.demo");
  await d1page.locator("#login-password").fill(process.env.DEMO_PASSWORD);
  await d1page.locator('form button[type="submit"]').click();
  await d1page.waitForURL("**/daee**", { timeout: 20_000 });
  const d1 = d1page;

  const asker = await (await browser.newContext({ viewport: SIZES[1440] })).newPage();
  await asker.goto(`${BASE}/en/enter`);
  await asker.locator('main form button[type="submit"]:not([disabled])').waitFor();
  await asker.locator("main input:not([type=hidden])").fill(`mc-${TAG}`);
  await asker.locator("main input:not([type=hidden])").press("Enter");
  await asker.locator('button[name="skip"]').click();
  await asker.waitForURL("**/wait", { timeout: 30_000 });
  askerId = (await db.from("askers").select("user_id").eq("pseudonym", `mc-${TAG}`).single()).data.user_id;

  // ---- Session 1 --------------------------------------------------------------------------
  const c1 = await session(asker, d1, "I want to understand what prayer means in daily life.", "Welcome. What do you know about prayer so far, and what puzzles you?", "I know there are five prayers, but I don't see how they fit a working day. Next time I'd like to talk about the times.", false);
  await approveSessionCard(asker, c1);
  check("one session card: no master offer yet", (await asker.getByTestId("update-master").count()) === 0);
  await end(d1, c1, false);

  // ---- Session 2: the master card is offered, merged by the AI, approved -------------------
  const c2 = await session(asker, d1, "Continuing: how do people fit the prayer times into work?", "Many people plan breaks around them. Shall we look at your own schedule?", "Yes. I covered the times now; I still want to understand the meaning of the words said in prayer.", true);
  await approveSessionCard(asker, c2);
  await asker.getByTestId("update-master").waitFor({ timeout: 10_000 });
  check("second session card: master offered", true);
  await asker.getByRole("link", { name: "Update your master card" }).click();
  await asker.getByText("What the AI guide will read:").first().waitFor({ timeout: 15_000 });
  await asker.getByText(/Reading|Drafting|Writing the fields|Draft ready/).first().waitFor({ timeout: 20_000 });
  await asker.waitForTimeout(1500);
  await asker.screenshot({ path: `${OUT}/master-streaming-en-1440.png` });
  await approveMaster(asker, { ai: true });
  await shots(asker, "master-approved-en");
  const { data: sessionCards } = await db.from("cards").select("id").eq("asker_id", askerId).eq("scope", "session").eq("status", "approved");
  const sessionIds = new Set(sessionCards.map((c) => c.id));
  let m = await masters(askerId);
  check("master v1 approved, merged from the two session cards", m.length === 1 && m[0].status === "approved" && m[0].origin === "ai" && m[0].source_card_ids.length === 2 && m[0].source_card_ids.every((id) => sessionIds.has(id)));
  check("master chips point at session cards only", Object.values(m[0].field_sources).flat().every((id) => sessionIds.has(id)));
  const { data: ev } = await db.from("events").select("type, meta").eq("org_id", ORG).in("type", ["master_card_generated", "master_card_approved"]).order("created_at", { ascending: false }).limit(2);
  check("master_card_generated and master_card_approved (origin ai)", ev.some((e) => e.type === "master_card_generated" && e.meta.origin === "ai") && ev.some((e) => e.type === "master_card_approved" && e.meta.origin === "ai" && typeof e.meta.edited_major === "boolean"));
  await end(d1, c2, true);

  // ---- Session 3: return uses the master; the daee sees master + folded sessions ----------
  const c3 = await askOn(asker, "Back again: I'd like to talk about the meaning of the words in prayer.", true);
  const { data: conv3 } = await db.from("conversations").select("card_id, followup_mode").eq("id", c3).single();
  check("return links the master card (an AI-drafted master: mode ai)", conv3.card_id === m[0].id && conv3.followup_mode === "ai");
  await d1.goto(`${BASE}/ar/daee/${c3}`);
  await d1.getByTestId("master-card").waitFor({ timeout: 15_000 });
  check("daee sees the master card first", (await d1.getByTestId("master-card").textContent()).includes("محدّثة بعد جلستين"));
  check("the two sessions are folded under the master", (await d1.getByTestId("session-list").locator(":scope > li").count()) === 2 && !(await d1.getByTestId("session-list").isVisible()));
  check("header picks up from the master card", await d1.getByTestId("resume-from").isVisible());
  check("no rating panel on open", (await d1.getByRole("dialog").count()) === 0);
  await shots(d1, "inbox-master-ar");
  await d1.getByRole("button", { name: /الجلسات السابقة/ }).click();
  await d1.getByTestId("session-list").getByRole("button").first().click();
  check("a folded session opens", (await d1.getByTestId("session-list").locator("article").count()) === 1);
  await shots(d1, "inbox-master-sessions-ar");
  await d1.goto(`${BASE}/en/daee/${c3}`);
  await say(d1, "main textarea", "Welcome back. Let's go through the words of the opening prayer together today.");
  await say(asker, "footer textarea", "Thank you. Next time I want to practise the first words myself.");
  await approveSessionCard(asker, c3);
  await asker.getByRole("link", { name: "Update your master card" }).click();
  await approveMaster(asker, { ai: true });
  m = await masters(askerId);
  check("master updated twice (two approved versions)", m.length === 2 && m.every((x) => x.status === "approved") && m[1].source_card_ids.length === 3);
  await d1.goto(`${BASE}/en/daee/${c3}`);
  await d1.getByRole("button", { name: /End conversation/ }).click();
  check("rating panel appears only after End", await d1.getByRole("dialog").isVisible());
  await d1.getByRole("dialog").getByRole("button", { name: "Skip and end" }).click();
  await d1.waitForTimeout(800);

  // ---- AI off: the current master prefilled for editing -----------------------------------
  await db.from("organizations").update({ ai_enabled: false }).eq("id", ORG);
  await asker.goto(`${BASE}/en/card/master`);
  await asker.locator("#master-follow_up").waitFor({ timeout: 15_000 });
  const prefilled = await asker.locator("#master-follow_up").inputValue();
  check("AI off: the master prefilled from the current version", prefilled.length > 0 && prefilled === m[1].follow_up.trim(), prefilled.slice(0, 60));
  check("AI off: no AI status on the page", (await asker.getByText("Draft ready").count()) === 0);
  await shots(asker, "master-manual-en");
  await asker.locator("#master-next_step").fill("Practise the first words of prayer with the dāʿī.");
  await approveMaster(asker, { ai: false });
  m = await masters(askerId);
  check("AI off: a manual master version approved", m.length === 3 && m[2].origin === "manual" && m[2].status === "approved");
} catch (error) {
  results.push(`ERROR  ${error.message.split("\n")[0]}  at ${(error.stack.match(/master\.mjs:\d+/) ?? [""])[0]}`);
} finally {
  await browser.close();
  await db.from("organizations").update({ ai_enabled: true }).eq("id", ORG);
  await db.from("profiles").update({ capacity: khalidProfile.capacity }).eq("user_id", KHALID);
  if (askerId) {
    const { data: convs } = await db.from("conversations").select("id").eq("asker_id", askerId);
    for (const c of convs ?? []) {
      await db.from("events").delete().eq("conversation_id", c.id);
      await db.from("notifications").delete().eq("payload->>conversation_id", c.id);
    }
    await db.from("ai_runs").delete().eq("actor_id", askerId);
    await db.auth.admin.deleteUser(askerId);
  }
  console.log(results.join("\n"));
  if (results.some((r) => /^(FAIL|ERROR)/.test(r))) process.exitCode = 1;
}
