// LOCAL VERIFICATION ONLY: the daee assistant (sources search, quotes, tone), with the real model.
//   node --env-file=.env.local scripts/dev/assist.mjs   (needs a build at VERIFY_BASE)
// Staff passwords come from DEMO_PASSWORD inside this process and are never printed.
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { plainQuestionBox } from "./lib/entry.mjs";

const BASE = process.env.VERIFY_BASE ?? "http://localhost:3127";
// Against the live site (shared database), nothing org-wide changes: AI stays on, statuses stay.
const LIVE = BASE.startsWith("https://");
const OUT = "docs/screenshots";
const TAG = Date.now().toString(36);
const ORG = "00000000-0000-4000-8000-000000000001";
const VIEW = { width: 1440, height: 900 };
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
async function login(browser, email, landing) {
  const page = await (await browser.newContext({ viewport: VIEW })).newPage();
  await page.goto(`${BASE}/en/login`);
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(process.env.DEMO_PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(`**${landing}**`, { timeout: 20_000 });
  return page;
}
/** Waits until the assistant shows results or the empty state; returns the result count. */
async function settled(page) {
  const panel = page.getByTestId("assistant");
  await panel.locator("[data-testid=assist-results], p.border-dashed").first().waitFor({ timeout: 120_000 });
  return panel.getByTestId("assist-results").locator("li").count();
}

const { data: staff } = await db.from("profiles").select("user_id, display_name, status").eq("role", "daee");
const KHALID = staff.find((s) => s.display_name === "خالد").user_id;
if (!LIVE) {
  await db.from("organizations").update({ ai_enabled: true }).eq("id", ORG);
  await db.from("profiles").update({ status: "offline" }).eq("role", "daee");
}

let debugPage = null;
const browser = await chromium.launch();
const started = new Date().toISOString();
try {
  // An asker with three messages, assigned to خالد.
  const asker = await (await browser.newContext({ viewport: VIEW })).newPage();
  await asker.goto(`${BASE}/ar/enter`);
  await asker.locator('main form button[type="submit"]:not([disabled])').waitFor();
  await asker.locator("main input:not([type=hidden])").fill(`as-${TAG}`);
  await asker.locator("main input:not([type=hidden])").press("Enter");
  await asker.locator('button[name="skip"]').click();
  await asker.waitForURL("**/wait", { timeout: 30_000 });
  await plainQuestionBox(asker);
  await asker.locator('textarea[name="question"]').fill("أريد أن أفهم لماذا يصلي المسلمون خمس مرات في اليوم");
  await asker.locator('textarea[name="question"]').press("Enter");
  await asker.waitForURL("**/chat/**", { timeout: 30_000 });
  const id = asker.url().split("/chat/")[1];
  for (const text of ["وهل الصلاة صعبة على من يعمل طوال اليوم؟", "أرجو الرد بسرعة، ليس لدي وقت كثير"]) {
    await asker.locator("footer textarea").fill(text);
    await asker.locator("footer textarea").press("Enter");
    await asker.waitForTimeout(1200);
  }
  await db.from("conversations").update({ daee_id: KHALID, assigned_at: new Date().toISOString(), status: "active" }).eq("id", id);
  const countMessages = async () => (await db.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", id)).count;
  const before = await countMessages();

  const d = await login(browser, "daee1@wasl.demo", "/daee");
  debugPage = d;
  d.on("pageerror", (e) => results.push("PAGEERROR " + e.message.slice(0, 200)));
  d.on("console", (m) => m.type() === "error" && results.push("CONSOLE " + m.text().slice(0, 200)));
  await d.goto(`${BASE}/ar/daee/${id}`);
  const sparkles = d.getByTestId("assist-sparkle");
  await sparkles.first().waitFor({ timeout: 20_000 });
  await d.waitForLoadState("networkidle").catch(() => {});
  await d.waitForTimeout(1500); // hydrated before clicking
  check("a sparkle beside each asker message", (await sparkles.count()) === 3, `n=${await sparkles.count()}`);

  // Per-message search: the assistant tab opens with verbatim results (or the empty state).
  await sparkles.first().click();
  await d.getByTestId("assistant").waitFor({ timeout: 10_000 });
  const n1 = await settled(d);
  check("per-message search returns citations (or the empty state)", n1 >= 0, `n=${n1}`);
  if (n1 > 0) {
    check("results carry a source link", (await d.getByTestId("assist-results").locator("a[href^='https://']").count()) >= n1);
    const fiqh = await d.getByText("فقه، لا يُحوَّل إلى فتوى").count();
    const dorarFeqhia = await d.getByTestId("assist-results").locator("a[href*='dorar.net/feqhia']").count();
    check("every dorar feqhia result is labeled فقه، لا يُحوَّل إلى فتوى", fiqh === dorarFeqhia, `${fiqh}/${dorarFeqhia}`);
  }
  await d.screenshot({ path: `${OUT}/assist-message-ar-1440.png` });

  // Multi-select: shift-click two messages, then "search selected".
  await sparkles.nth(0).click({ modifiers: ["Shift"] });
  await sparkles.nth(1).click();
  await d.getByTestId("assist-selection").waitFor({ timeout: 5_000 });
  check("multi-select: two messages selected", (await d.getByTestId("assist-selection").textContent()).includes("2"));
  await d.screenshot({ path: `${OUT}/assist-select-ar-1440.png` });
  await d.getByTestId("assist-selection").getByRole("button").first().click();
  const n2 = await settled(d);
  check("search selected returns citations (or the empty state)", n2 >= 0, `n=${n2}`);

  // Free search.
  await d.getByPlaceholder("ابحث في المصادر المعتمدة").fill("أوقات الصلوات الخمس");
  await d.getByPlaceholder("ابحث في المصادر المعتمدة").press("Enter");
  const n3 = await settled(d);
  check("free search returns citations (or the empty state)", n3 >= 0, `n=${n3}`);

  // Insert as quote: into the composer, never sent.
  const quoteButton = d.getByRole("button", { name: "أدرج كاقتباس" }).first();
  if (await quoteButton.count()) {
    await quoteButton.click();
    await d.waitForTimeout(800);
    const draft = await d.locator("main textarea").inputValue();
    check("insert as quote fills the composer", draft.startsWith("«") && /https:\/\//.test(draft));
    await d.waitForTimeout(2000);
    check("insert as quote never sends", (await countMessages()) === before, `${before} → ${await countMessages()}`);
    await d.screenshot({ path: `${OUT}/assist-quote-ar-1440.png` });
  } else {
    check("insert as quote (skipped: no results to quote)", true);
  }

  // Tone: one quiet line, computed on demand, never stored.
  await d.getByRole("button", { name: "اقرأ نبرة الرسائل الأخيرة" }).click();
  await d.getByTestId("tone").waitFor({ timeout: 60_000 });
  const toneText = (await d.getByTestId("tone").textContent()) ?? "";
  check("tone: one line about the messages", /الرسائل الأخيرة/.test(toneText), toneText);
  const { data: toneRuns } = await db.from("ai_runs").select("output").eq("task", "assist_tone").gte("created_at", started);
  check("tone never persisted (ai_runs output null)", (toneRuns ?? []).length > 0 && toneRuns.every((r) => r.output === null), `runs=${toneRuns?.length}`);
  const { data: evs } = await db.from("events").select("meta").eq("conversation_id", id);
  check("tone not in any event", !JSON.stringify(evs ?? []).match(/hurried|confused|frustrated|مستعجلة/));
  await d.screenshot({ path: `${OUT}/assist-tone-ar-1440.png` });

  // Admin never sees tone: the AI log shows no output for it.
  const admin = await login(browser, "admin@wasl.demo", "/admin");
  await admin.goto(`${BASE}/ar/admin/log?tab=ai`);
  await admin.waitForTimeout(2000);
  const adminText = (await admin.locator("main").textContent()) ?? "";
  check("admin never sees a tone label", !/مستعجلة|مرتبكة|منزعجة|hurried|confused|frustrated/.test(adminText));

  // AI off: no tone; search still works on human-verified items.
  if (!LIVE) {
    await db.from("organizations").update({ ai_enabled: false }).eq("id", ORG);
    await d.reload();
    await d.getByRole("tab", { name: "المساعد" }).click();
    await d.getByTestId("assistant").waitFor();
    check("AI off: tone hidden", (await d.getByRole("button", { name: "اقرأ نبرة الرسائل الأخيرة" }).count()) === 0);
  }
} catch (error) {
  await debugPage?.screenshot({ path: `${OUT}/_assist-debug.png` }).catch(() => {});
  results.push(`ERROR  ${error.message.split("\n")[0]}  at ${(error.stack.match(/assist\.mjs:\d+/) ?? [""])[0]}`);
} finally {
  await browser.close();
  if (!LIVE) {
    await db.from("organizations").update({ ai_enabled: true }).eq("id", ORG);
    for (const s of staff) await db.from("profiles").update({ status: s.status }).eq("user_id", s.user_id);
  }
  const { data: askers } = await db.from("askers").select("user_id").eq("pseudonym", `as-${TAG}`);
  for (const x of askers ?? []) {
    const { data: convs } = await db.from("conversations").select("id").eq("asker_id", x.user_id);
    for (const cv of convs ?? []) {
      await db.from("events").delete().eq("conversation_id", cv.id);
      await db.from("notifications").delete().eq("payload->>conversation_id", cv.id);
    }
    await db.from("ai_runs").delete().eq("actor_id", x.user_id);
    await db.auth.admin.deleteUser(x.user_id);
  }
  await db.from("ai_runs").delete().eq("task", "assist_tone").gte("created_at", started);
  console.log(results.join("\n"));
  if (results.some((r) => /^(FAIL|ERROR)/.test(r))) process.exitCode = 1;
}
