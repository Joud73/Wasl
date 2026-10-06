// LOCAL VERIFICATION ONLY: the three manual journeys end to end, with two daee and askers.
//   node --env-file=.env.local scripts/dev/journey.mjs   (needs a running build at VERIFY_BASE)
// Staff passwords come from DEMO_PASSWORD inside this process and are never printed.
import { mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { plainQuestionBox } from "./lib/entry.mjs";

const BASE = process.env.VERIFY_BASE ?? "http://localhost:3127";
const OUT = "docs/screenshots";
const SIZES = { 1440: { width: 1440, height: 900 }, 390: { width: 390, height: 844 } };
const TAG = Date.now().toString(36);
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) console.error(`FAIL ${name} ${detail}`);
};
async function shots(page, name) {
  for (const [w, size] of Object.entries(SIZES)) {
    await page.setViewportSize(size);
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${OUT}/${name}-${w}.png` });
  }
  await page.setViewportSize(SIZES[1440]);
}
async function login(browser, email, landing) {
  const context = await browser.newContext({ viewport: SIZES[1440] });
  const page = await context.newPage();
  await page.goto(`${BASE}/en/login`);
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(process.env.DEMO_PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(`**${landing}**`, { timeout: 20_000 });
  return page;
}
async function enter(page, pseudonym) {
  await page.goto(`${BASE}/en/enter`);
  await page.locator('main form button[type="submit"]:not([disabled])').waitFor();
  await page.locator("main input:not([type=hidden])").fill(pseudonym);
  await page.locator("main input:not([type=hidden])").press("Enter");
  await page.locator('button[name="skip"]').click();
  await page.waitForURL("**/wait", { timeout: 30_000 });
  // No return code at entry: the first one exists only as its hash.
  await page.waitForTimeout(500);
  check(`no return code shown at entry (${pseudonym})`, (await page.getByTestId("return-code").count()) === 0);
}
async function ask(page, text) {
  await plainQuestionBox(page);
  const q = page.locator('textarea[name="question"]');
  await q.waitFor();
  await q.fill(text);
  await q.press("Enter");
  await page.waitForURL("**/chat/**", { timeout: 20_000 });
  return page.url().split("/chat/")[1];
}
async function say(page, selector, text) {
  const box = page.locator(selector);
  await box.waitFor();
  await box.fill(text);
  await box.press("Enter");
}
const events = async (conversationId) =>
  (await db.from("events").select("type, meta").eq("conversation_id", conversationId)).data ?? [];

const { data: staff } = await db.from("profiles").select("user_id, display_name").eq("role", "daee");
const id = (name) => staff.find((s) => s.display_name === name).user_id;
const DAEE1 = id("خالد"), DAEE2 = id("سارة");
// A status set from here counts as a fresh heartbeat (open workspaces keep it fresh after that).
const setStatus = (user, status) => db.from("profiles").update({ status, last_seen: new Date().toISOString() }).eq("user_id", user);

const browser = await chromium.launch();
try {
  await setStatus(DAEE1, "available");
  await setStatus(DAEE2, "busy");
  const d1 = await login(browser, "daee1@wasl.demo", "/daee");
  const d2 = await login(browser, "daee2@wasl.demo", "/daee");

  // ---- 1. First conversation with daee1 ------------------------------------------------
  const askerCtx = await browser.newContext({ viewport: SIZES[1440] });
  const asker = await askerCtx.newPage();
  const pseudonym = `jr-${TAG}`;
  await enter(asker, pseudonym);
  const conv1 = await ask(asker, "I read about prayer and want to understand it better.");
  // "Return code" in the chat header: the first reveal, no warning (no code was ever shown).
  await asker.getByTestId("code-button").click();
  const firstCodeBox = asker.getByTestId("return-code-value");
  await firstCodeBox.waitFor({ timeout: 15_000 });
  const headerCode = (await firstCodeBox.textContent())?.trim();
  check("header reveals a return code", /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{2}$/.test(headerCode ?? ""));
  check("first reveal has no previous-code warning", (await asker.getByText("Your previous code will stop working.").count()) === 0);
  await shots(asker, "chat-code-en");
  await asker.keyboard.press("Escape");
  const row = d1.locator("aside a", { hasText: pseudonym });
  // Other open conversations can put the list on Active; new ones arrive under Waiting.
  await d1.getByRole("tab", { name: /^Waiting/ }).click();
  await row.waitFor({ timeout: 15_000 });
  await row.click();
  await d1.waitForURL(`**/daee/${conv1}`);
  await say(d1, "main textarea", "Welcome. Prayer is a daily practice; let's start with what you've read so far.");
  await asker.getByText("let's start with what you've read").first().waitFor({ timeout: 15_000 });
  await say(asker, "footer textarea", "I read that there are five daily prayers.");
  await d1.getByText("five daily prayers").first().waitFor({ timeout: 15_000 });
  check("chat with daee1 both ways", true);
  const { data: seen } = await db.from("profiles").select("last_seen").eq("user_id", DAEE1).single();
  check("workspace heartbeat keeps last_seen fresh", Date.now() - Date.parse(seen.last_seen) < 45_000);

  // Account menu: profile sheet with today's numbers.
  await d1.locator("nav").getByRole("button", { name: "Account" }).click();
  await d1.getByRole("menuitem", { name: "Profile" }).click();
  await d1.getByText("Conversations today").first().waitFor({ timeout: 15_000 });
  check("profile sheet shows today's numbers", await d1.getByText("Median first reply").first().isVisible());
  await shots(d1, "profile-sheet-en");
  await d1.keyboard.press("Escape");

  // Shared device: "Not X? Start as someone new" ends the session and restarts the questions.
  const shared = await (await browser.newContext({ viewport: SIZES[390] })).newPage();
  await enter(shared, `jr3-${TAG}`);
  await shared.goto(`${BASE}/en/enter`);
  await shared.getByRole("button", { name: /Start as someone new/ }).click();
  await shared.getByText("What should we call you?").waitFor({ timeout: 15_000 });
  check("not you? starts the enter flow again", true);

  // ---- 2. Manual card ---------------------------------------------------------------------
  await asker.locator(`a[href$="/card/${conv1}"]`).first().click();
  await asker.waitForURL(`**/card/${conv1}`);
  await asker.getByRole("button", { name: "Clear all" }).click();
  await asker.locator("ul li label").nth(0).click();
  await asker.locator("ul li label").nth(2).click();
  await shots(asker, "card-select-en");
  await asker.getByRole("button", { name: "Continue" }).click();
  // The AI draft starts by default; this journey writes the card by hand.
  await asker.getByRole("button", { name: "Write it from scratch" }).click();
  await asker.locator("#card-follow_up").fill("How the five prayers fit into a working day.");
  await asker.locator("#card-covered").fill("What the five daily prayers are.");
  await asker.locator("#card-next_step").fill("Talk through a typical day.");
  await shots(asker, "card-fields-en");
  await asker.getByRole("button", { name: "Continue" }).click();
  await asker.locator("label", { hasText: "The team" }).click();
  check("card duration defaults to until deleted", (await asker.getByRole("radio", { name: "Until I delete it" }).getAttribute("aria-checked")) === "true");
  await asker.getByRole("radio", { name: "7 days" }).click();
  await shots(asker, "card-sharing-en");
  await asker.getByRole("button", { name: "Continue" }).click();
  await shots(asker, "card-review-en");
  await asker.getByRole("button", { name: "Approve and share" }).click();
  await asker.getByText(/Approved\. Visible until/).first().waitFor({ timeout: 15_000 });
  const { data: card } = await db.from("cards").select("*").eq("conversation_id", conv1).single();
  check("card stored approved, version 1, team, 2 sources", card.status === "approved" && card.version === 1 && card.visibility === "team" && card.source_message_ids.length === 2);
  check("empty field saved as غير محدد", card.remaining === "غير محدد");
  const ev1 = await events(conv1);
  check("card_generated (manual) logged", ev1.some((e) => e.type === "card_generated" && e.meta.origin === "manual"));
  check("card_approved (manual, edited_major false) logged", ev1.some((e) => e.type === "card_approved" && e.meta.origin === "manual" && e.meta.edited_major === false));

  // Arabic: the approved view, then a new version's steps (not approved, so nothing changes).
  await asker.goto(`${BASE}/ar/card/${conv1}`);
  await asker.getByRole("button", { name: "نسخة جديدة" }).waitFor();
  await shots(asker, "card-approved-ar");
  await asker.getByRole("button", { name: "نسخة جديدة" }).click();
  await shots(asker, "card-select-ar");
  await asker.getByRole("button", { name: "متابعة" }).click();
  await asker.getByRole("button", { name: "اكتبها من الصفر" }).click();
  await shots(asker, "card-fields-ar");
  await asker.getByRole("button", { name: "متابعة" }).click();
  await shots(asker, "card-sharing-ar");
  await asker.getByRole("button", { name: "متابعة" }).click();
  await shots(asker, "card-review-ar");
  check("Arabic card builder renders all steps", (await db.from("cards").select("id").eq("conversation_id", conv1)).data.length === 1);

  // ---- 3. Card in daee1's panel ----------------------------------------------------------
  await d1.reload();
  await d1.getByText("How the five prayers fit into a working day.").first().waitFor({ timeout: 15_000 });
  await d1.getByRole("button", { name: "Sources (2)" }).click();
  await d1.locator("aside li", { hasText: "five daily prayers" }).first().waitFor();
  check("daee1 sees the card with its sources", true);
  await shots(d1, "inbox-card-en");

  // ---- 4. Transfer to daee2 ---------------------------------------------------------------
  await setStatus(DAEE2, "available");
  await d1.locator("main header").getByRole("button", { name: "Transfer" }).click();
  await d1.getByRole("radio", { name: /سارة/ }).click();
  await d1.screenshot({ path: `${OUT}/transfer-menu-en-1440.png` });
  await d1.getByRole("dialog").getByRole("button", { name: "Transfer" }).click();
  await d1.waitForURL(/\/daee$/, { timeout: 15_000 });
  await d2.locator("[data-sonner-toast]", { hasText: "transferred" }).waitFor({ timeout: 15_000 });
  check("daee2 notified of transfer", true);
  await d2.goto(`${BASE}/en/daee/${conv1}`);
  await d2.getByText("How the five prayers fit into a working day.").first().waitFor({ timeout: 15_000 });
  check("daee2 sees the card before replying", true);
  await asker.goto(`${BASE}/en/chat/${conv1}`);
  await asker.getByText(/Your conversation moved to .?سارة/).first().waitFor({ timeout: 15_000 });
  check("asker sees the transfer line", true);
  await shots(asker, "chat-transfer-en");
  check("daee1 lost access", (await d1.goto(`${BASE}/en/daee/${conv1}`), /\/daee$/.test(d1.url())));
  check("transfer_completed logged", (await events(conv1)).some((e) => e.type === "transfer_completed" && e.meta.to_daee === DAEE2));

  // ---- 5. daee2 ends; the asker returns with the code -----------------------------------
  await say(d2, "main textarea", "Thank you, I have your card and will be glad to continue another time.");
  await d2.getByRole("button", { name: /End conversation/ }).click();
  await d2.getByRole("button", { name: "Confirm end" }).click();
  await asker.getByText("This conversation has ended").first().waitFor({ timeout: 15_000 });
  // The ended panel reveals a new code automatically, above sign-out, with the warning.
  await asker.getByText("Save your code before signing out").waitFor();
  const endedBox = asker.getByTestId("return-code-value");
  await endedBox.waitFor({ timeout: 15_000 });
  const code = (await endedBox.textContent())?.trim();
  check("ended panel reveals a new code", /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{2}$/.test(code ?? "") && code !== headerCode);
  check("second reveal warns the previous code stops", await asker.getByText("Your previous code will stop working.").isVisible());
  await shots(asker, "chat-ended-code-en");
  await askerCtx.close();

  const returnCtx = await browser.newContext({ viewport: SIZES[1440] });
  const back = await returnCtx.newPage();
  await back.goto(`${BASE}/en/return`);
  await back.locator('main form button[type="submit"]').waitFor();
  await back.waitForTimeout(800);
  await back.locator("#return-pseudonym").fill(pseudonym);
  await back.locator("#return-code").fill(code);
  await back.locator('main form button[type="submit"]').click();
  await back.waitForURL("**/wait", { timeout: 20_000 });
  await back.getByRole("button", { name: /Continue with .?خالد/ }).waitFor({ timeout: 15_000 });
  check("resume offers the same daee", true);
  await shots(back, "resume-en");
  await back.goto(`${BASE}/ar/wait`);
  await back.getByRole("button", { name: /تابع مع .?خالد/ }).waitFor();
  await shots(back, "resume-ar");
  await back.getByRole("button", { name: /تابع مع .?خالد/ }).click();
  const conv2 = await ask(back, "I'd like to continue about fitting prayer into my day.");
  const { data: fu } = await db.from("conversations").select("previous_conversation_id, card_id, followup_mode, preferred_daee_id, daee_id").eq("id", conv2).single();
  check("follow-up linked to previous conversation and card", fu.previous_conversation_id === conv1 && fu.card_id === card.id);
  check("follow-up with the same daee", fu.followup_mode === "manual" && fu.preferred_daee_id === DAEE1 && fu.daee_id === DAEE1);
  check("followup_started (manual) logged", (await events(conv2)).some((e) => e.type === "followup_started" && e.meta.mode === "manual"));

  // ---- 6. daee1 resumes; rating when the follow-up ends -----------------------------------
  await d1.goto(`${BASE}/en/daee/${conv2}`);
  await d1.getByText("How the five prayers fit into a working day.").first().waitFor({ timeout: 15_000 });
  await say(d1, "main textarea", "Welcome back. From your card, let's walk through a typical working day together.");
  check("no rating before the end", (await d1.getByText("Did the context help you continue").count()) === 0);
  await d1.goto(`${BASE}/ar/daee/${conv2}`);
  await d1.getByRole("button", { name: /إنهاء المحادثة/ }).click();
  await d1.getByText("هل ساعدك السياق على المتابعة دون البدء من الصفر؟").first().waitFor({ timeout: 15_000 });
  await shots(d1, "inbox-rating-ar");
  await d1.getByRole("button", { name: "إلغاء" }).first().click();
  await d1.goto(`${BASE}/en/daee/${conv2}`);
  await d1.getByRole("button", { name: /End conversation/ }).click();
  const endPanel = d1.getByRole("dialog");
  await endPanel.getByText(/Did the card summarize the previous conversation accurately/).first().waitFor({ timeout: 15_000 });
  check("end of a card follow-up asks both questions", true);
  await shots(d1, "inbox-rating-en");
  await endPanel.getByRole("radiogroup", { name: /Did the context help/ }).getByRole("radio", { name: "Yes" }).click();
  await endPanel.getByRole("radiogroup", { name: /Did the card summarize the previous conversation accurately/ }).getByRole("radio", { name: "Yes" }).click();
  await endPanel.getByRole("button", { name: "Save and end" }).click();
  // The asker resumed from the Arabic page.
  await back.getByText("انتهت هذه المحادثة").first().waitFor({ timeout: 15_000 });
  const rated2 = (await events(conv2)).find((e) => e.type === "followup_rated");
  check("followup_rated { manual, sufficient, card_accurate } logged", rated2?.meta.mode === "manual" && rated2.meta.sufficient === true && rated2.meta.card_accurate === true);
  await back.goto(`${BASE}/ar/chat/${conv2}`);
  await back.getByText("انتهت هذه المحادثة").first().waitFor();
  await shots(back, "chat-followup-ar");

  // The asker deletes the card: every version goes and daee access ends at once.
  await back.goto(`${BASE}/en/card/${conv1}`);
  await back.getByRole("button", { name: "Delete card" }).click();
  await back.getByRole("button", { name: "Delete permanently" }).click();
  await back.waitForURL(`**/chat/${conv1}`, { timeout: 15_000 });
  const { data: left } = await db.from("cards").select("id").eq("conversation_id", conv1);
  const { data: link } = await db.from("conversations").select("card_id").eq("id", conv2).single();
  check("asker deleted the card (all versions, follow-up unlinked)", left.length === 0 && link.card_id === null);
  await d1.goto(`${BASE}/en/daee/${conv2}`);
  await d1.getByText("No card yet").first().waitFor({ timeout: 15_000 });
  check("daee loses the deleted card immediately", (await d1.getByText("How the five prayers fit into a working day.").count()) === 0);

  // Returning with a code links the asker to that new session, so this comes last.
  // New return code at the end: the old code stops working, the new one works.
  await back.goto(`${BASE}/en/chat/${conv2}`);
  const newCodeBox = back.getByTestId("return-code-value");
  await newCodeBox.waitFor({ timeout: 15_000 });
  check("new-code hint says the old code stops", await back.getByText("Your previous code will stop working.").isVisible());
  const newCode = (await newCodeBox.textContent())?.trim();
  check("new return code shown once", /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{2}$/.test(newCode ?? "") && newCode !== code);
  await shots(back, "chat-new-code-en");
  const tryCode = async (value) => {
    const ctx = await browser.newContext({ viewport: SIZES[1440] });
    const pg = await ctx.newPage();
    await pg.goto(`${BASE}/en/return`);
    await pg.locator('main form button[type="submit"]').waitFor();
    await pg.waitForTimeout(800);
    await pg.locator("#return-pseudonym").fill(pseudonym);
    await pg.locator("#return-code").fill(value);
    await pg.locator('main form button[type="submit"]').click();
    const ok = await pg.waitForURL("**/wait", { timeout: 10_000 }).then(() => true, () => false);
    await ctx.close();
    return ok;
  };
  check("header code stopped at the next reveal", !(await tryCode(headerCode)));
  check("old return code no longer works", !(await tryCode(code)));
  check("new return code works", await tryCode(newCode));

  // ---- 7. A follow-up without a card (mode none) ------------------------------------------
  const ctx3 = await browser.newContext({ viewport: SIZES[1440] });
  const other = await ctx3.newPage();
  const pseudonym2 = `jr2-${TAG}`;
  await enter(other, pseudonym2);
  const conv3 = await ask(other, "A first question without a card.");
  const { data: c3 } = await db.from("conversations").select("daee_id").eq("id", conv3).single();
  const owner = c3.daee_id === DAEE1 ? d1 : d2;
  await owner.goto(`${BASE}/en/daee/${conv3}`);
  await owner.getByRole("button", { name: /End conversation/ }).click();
  await owner.getByRole("button", { name: "Confirm end" }).click();
  await other.getByText("This conversation has ended").first().waitFor({ timeout: 15_000 });
  await other.goto(`${BASE}/en/wait`);
  await other.getByText("This continues your previous conversation.").first().waitFor();
  const conv4 = await ask(other, "Coming back without a card.");
  check("followup_started (none) logged", (await events(conv4)).some((e) => e.type === "followup_started" && e.meta.mode === "none"));
  const { data: c4 } = await db.from("conversations").select("daee_id").eq("id", conv4).single();
  const owner4 = c4.daee_id === DAEE1 ? d1 : d2;
  await owner4.goto(`${BASE}/en/daee/${conv4}`);
  await say(owner4, "main textarea", "Welcome back. I don't have a card, so could you remind me where we stopped?");
  await owner4.getByRole("button", { name: /End conversation/ }).click();
  const endPanel4 = owner4.getByRole("dialog");
  await endPanel4.getByText(/Did the context help/).first().waitFor({ timeout: 15_000 });
  check("no card question without a card", (await endPanel4.getByText(/Did the card summarize the previous conversation accurately/).count()) === 0);
  await endPanel4.getByRole("radio", { name: "No" }).click();
  await endPanel4.getByRole("button", { name: "Save and end" }).click();
  await other.getByText("This conversation has ended").first().waitFor({ timeout: 15_000 });
  const rated4 = (await events(conv4)).find((e) => e.type === "followup_rated");
  check("followup_rated { none, insufficient, card_accurate null } logged", rated4?.meta.mode === "none" && rated4.meta.sufficient === false && rated4.meta.card_accurate === null);
  await other.goto(`${BASE}/en/chat/${conv4}`);
  await other.getByText("This conversation has ended").first().waitFor({ timeout: 15_000 });

  // ---- 8. Deactivation returns open conversations to the queue ---------------------------
  await setStatus(DAEE1, "offline");
  const conv5 = await ask((await other.goto(`${BASE}/en/wait`), other), "Another question for the deactivation check.");
  const { data: c5 } = await db.from("conversations").select("daee_id").eq("id", conv5).single();
  check("conversation routed to daee2", c5.daee_id === DAEE2);
  // daee2 starts it, so the reassignment below must not log conversation_started again.
  await d2.goto(`${BASE}/en/daee/${conv5}`);
  await say(d2, "main textarea", "Hello, I'm here. Tell me a little more about your question.");
  await other.getByText("Tell me a little more").first().waitFor({ timeout: 15_000 });
  const admin = await login(browser, "admin@wasl.demo", "/admin");
  await setStatus(DAEE1, "available");
  await admin.goto(`${BASE}/en/admin/team`);
  const row2 = admin.locator("tr", { hasText: "daee2@wasl.demo" });
  await row2.getByRole("button", { name: "Deactivate" }).click();
  await row2.getByRole("button", { name: "Confirm" }).click();
  await admin.locator("tr", { hasText: "daee2@wasl.demo" }).getByText("Deactivated").first().waitFor({ timeout: 15_000 });
  const { data: c5b } = await db.from("conversations").select("daee_id, status").eq("id", conv5).single();
  check("deactivated daee's conversation re-routed", c5b.daee_id === DAEE1, `daee=${c5b.daee_id === DAEE1 ? "daee1" : c5b.daee_id}`);
  await d2.goto(`${BASE}/en/daee/${conv1}`);
  check("deactivated daee loses access", !d2.url().includes(conv1));
  await admin.locator("tr", { hasText: "daee2@wasl.demo" }).getByRole("button", { name: "Reactivate" }).click();
  await admin.locator("tr", { hasText: "daee2@wasl.demo" }).getByRole("button", { name: "Deactivate" }).waitFor({ timeout: 15_000 });
  await d1.goto(`${BASE}/en/daee/${conv5}`);
  await say(d1, "main textarea", "Hello, I'm continuing with you from here.");
  await other.getByText("continuing with you from here").first().waitFor({ timeout: 15_000 });
  const started = (await events(conv5)).filter((e) => e.type === "conversation_started").length;
  check("conversation_started logged once across reassignment", started === 1, `count=${started}`);

  // ---- 8b. Card-first transfer whose target leaves before the asker answers ---------------
  await setStatus(DAEE2, "available");
  await d1.reload();
  await d1.locator("main header").getByRole("button", { name: "Transfer" }).click();
  await d1.getByRole("radio", { name: /سارة/ }).click();
  await d1.getByRole("dialog").getByText("Ask the asker for a card first").click();
  await d1.getByRole("dialog").getByRole("button", { name: "Transfer" }).click();
  await other.getByText("suggests continuing with").first().waitFor({ timeout: 15_000 });
  await setStatus(DAEE2, "offline");
  await other.getByText("isn't available right now").first().waitFor({ timeout: 30_000 });
  check("move now disabled with the reason", await other.getByRole("button", { name: "Move now" }).isDisabled());
  await shots(other, "chat-transfer-unavailable-en");
  await other.getByRole("button", { name: "Return to the queue" }).click();
  await other.getByText("Your conversation went back to the queue").first().waitFor({ timeout: 15_000 });
  check("asker sees the requeue line", true);
  const { data: tr5 } = await db.from("transfers").select("status, requeued_at").eq("conversation_id", conv5).order("created_at", { ascending: false }).limit(1).single();
  const { data: c5c } = await db.from("conversations").select("daee_id, status").eq("id", conv5).single();
  check("transfer dropped and conversation back in the queue", tr5.status === "declined" && tr5.requeued_at && c5c.status === "waiting" && c5c.daee_id === null, `daee=${c5c.daee_id} status=${c5c.status}`);

  // ---- 8c. Presence truth: a stale heartbeat is offline; signing out is offline -----------
  const YUSUF = id("يوسف");
  await db.from("profiles").update({ status: "available", last_seen: new Date(Date.now() - 3 * 60_000).toISOString() }).eq("user_id", YUSUF);
  const anonDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data: urCount } = await anonDb.rpc("public_availability", { p_language: "ur" });
  check("stale daee not counted as available", urCount === 0, `ur=${urCount}`);
  let yusufStatus = "available";
  for (let i = 0; i < 16 && yusufStatus !== "offline"; i++) {
    await new Promise((r) => setTimeout(r, 5_000));
    yusufStatus = (await db.from("profiles").select("status").eq("user_id", YUSUF).single()).data.status;
  }
  check("scheduled expiry marks the stale daee offline", yusufStatus === "offline");
  await setStatus(DAEE1, "available");
  await d1.goto(`${BASE}/en/daee`);
  await d1.locator("nav").getByRole("button", { name: "Account" }).click();
  await d1.getByRole("menuitem", { name: "Sign out" }).click();
  await d1.waitForURL("**/login", { timeout: 15_000 });
  const { data: afterOut } = await db.from("profiles").select("status").eq("user_id", DAEE1).single();
  check("signing out sets the daee offline", afterOut.status === "offline");

  // ---- 9. Admin KPIs show real n ----------------------------------------------------------
  for (const locale of ["en", "ar"]) {
    await admin.setViewportSize({ width: 1440, height: 1500 });
    await admin.goto(`${BASE}/${locale}/admin?range=today`);
    await admin.waitForTimeout(1200);
    await admin.screenshot({ path: `${OUT}/admin-overview-journeys-${locale}-1440.png` });
  }
  const { data: kpis } = await (async () => {
    const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    await c.auth.signInWithPassword({ email: "admin@wasl.demo", password: process.env.DEMO_PASSWORD });
    const from = new Date(Date.now() - 3600_000).toISOString(), to = new Date(Date.now() + 60_000).toISOString();
    const [k, cmp] = await Promise.all([c.rpc("admin_kpis", { p_from: from, p_to: to }), c.rpc("admin_comparison", { p_from: from, p_to: to })]);
    return { data: { k: k.data, cmp: cmp.data } };
  })();
  check("resumption KPI has real n", kpis.k.correct_resumption.n >= 1, `n=${kpis.k.correct_resumption.n}`);
  check("card accuracy KPI has real n", kpis.k.card_accuracy.n >= 1, `n=${kpis.k.card_accuracy.n}`);
  const byMode = Object.fromEntries(kpis.cmp.map((r) => [r.mode, r]));
  check("comparison has manual and none sessions", byMode.manual.sessions >= 1 && byMode.none.sessions >= 1, `manual=${byMode.manual.sessions} none=${byMode.none.sessions}`);
} catch (error) {
  results.push(`ERROR  ${error.message.split("\n")[0]}  at ${(error.stack.match(/journey\.mjs:\d+/) ?? [""])[0]}`);
} finally {
  await browser.close();
  await db.auth.admin.updateUserById(DAEE2, { ban_duration: "none" });
  const { data: askers } = await db.from("askers").select("user_id").like("pseudonym", "jr%-" + TAG);
  for (const a of askers ?? []) {
    const { data: convs } = await db.from("conversations").select("id").eq("asker_id", a.user_id);
    for (const c of convs ?? []) {
      await db.from("events").delete().eq("conversation_id", c.id);
      await db.from("notifications").delete().eq("payload->>conversation_id", c.id);
    }
    await db.auth.admin.deleteUser(a.user_id);
  }
  await setStatus(DAEE1, "available");
  await setStatus(DAEE2, "busy");
  console.log(results.join("\n"));
  if (results.some((r) => /^(FAIL|ERROR)/.test(r))) process.exitCode = 1;
}
