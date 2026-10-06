// LOCAL VERIFICATION ONLY: readings in the app (asker while waiting, daee panel), the
// retrieval order (live, then the auto cache), and AI off (no live search).
//   node --env-file=.env.local scripts/dev/sources.mjs   (needs a build at VERIFY_BASE)
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { plainQuestionBox } from "./lib/entry.mjs";

const BASE = process.env.VERIFY_BASE ?? "http://localhost:3127";
const OUT = "docs/screenshots";
const SIZES = { 1440: { width: 1440, height: 900 }, 390: { width: 390, height: 844 } };
const TAG = Date.now().toString(36);
const ORG = "00000000-0000-4000-8000-000000000001";
const ALLOWED = ["dawa.center", "islamic-content.com", "quranpedia.net", "dorar.net", "shamela.ws"];
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
async function shots(page, name) {
  for (const [w, size] of Object.entries(SIZES)) {
    await page.setViewportSize(size);
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${OUT}/${name}-${w}.png`, fullPage: w === "390" });
  }
  await page.setViewportSize(SIZES[1440]);
}
async function ask(browser, pseudonym, question, chip) {
  const page = await (await browser.newContext({ viewport: SIZES[1440] })).newPage();
  await page.goto(`${BASE}/ar/enter`);
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
const found = async (id) => (await db.from("events").select("meta").eq("conversation_id", id).eq("type", "sources_found")).data ?? [];
const allowedLinks = async (page) => {
  const hrefs = await page.getByTestId("readings").locator("a[href^='http']").evaluateAll((as) => as.map((a) => a.href));
  return { count: hrefs.length, ok: hrefs.every((h) => ALLOWED.some((d) => new URL(h).hostname === d || new URL(h).hostname.endsWith(`.${d}`))) };
};

// Nobody available: the askers wait, and the readings show while they wait.
const { data: staff } = await db.from("profiles").select("user_id, display_name, status").eq("role", "daee");
await db.from("organizations").update({ ai_enabled: true }).eq("id", ORG);
await db.from("profiles").update({ status: "offline" }).eq("role", "daee");

// Start the live case from an empty cache for Arabic doubts (auto items are regenerable).
await db.from("library_items").delete().eq("verified_by", "auto").eq("topic", "doubts").eq("language", "ar");

const browser = await chromium.launch();
try {
  // ---- Live: the asker waits; readings fill in from a live search of the approved sites ----
  // Doubts in Arabic has no human-verified items, so this one goes to the live search.
  const a = await ask(browser, `src1-${TAG}`, "هل انتشر الإسلام بالسيف؟", "الشبهات");
  await a.page.getByTestId("readings").waitFor({ timeout: 15_000 });
  await a.page.getByTestId("readings").locator("blockquote").first().waitFor({ timeout: 60_000 });
  const la = await allowedLinks(a.page);
  check("asker sees readings while waiting", la.count > 0, `${la.count} items`);
  check("every reading links to an approved domain", la.ok);
  check("each reading says it is quoted verbatim", await a.page.getByText("منقول حرفيًا من المصدر").first().isVisible());
  const fa = await found(a.id);
  check("sources_found { count, live: true }", fa.some((e) => e.meta.live === true && e.meta.count > 0), JSON.stringify(fa[0]?.meta));
  await shots(a.page, "readings-asker-ar");
  const { count: autoCount } = await db.from("library_items").select("id", { count: "exact", head: true }).eq("verified_by", "auto").eq("topic", "doubts").eq("language", "ar");
  check("live citations stored as auto", (autoCount ?? 0) > 0, `auto=${autoCount}`);

  // ---- Cache: the same need (normalized) comes from the stored items, not a live search ----
  const b = await ask(browser, `src2-${TAG}`, "هل  انتشر الإسلام بالسيف ؟", "الشبهات");
  await b.page.getByTestId("readings").locator("blockquote").first().waitFor({ timeout: 30_000 });
  const fb = await found(b.id);
  check("the same need from another asker served from the cache (live: false)", fb.some((e) => e.meta.live === false));

  // ---- Daee panel: the same readings, for the daee ----------------------------------------
  const khalid = staff.find((s) => s.display_name === "خالد").user_id;
  await db.from("profiles").update({ status: "available", last_seen: new Date().toISOString() }).eq("user_id", khalid);
  await db.from("conversations").update({ daee_id: khalid, assigned_at: new Date().toISOString() }).eq("id", a.id);
  const d1 = await (await browser.newContext({ viewport: SIZES[1440] })).newPage();
  await d1.goto(`${BASE}/en/login`);
  await d1.locator("#login-email").fill("daee1@wasl.demo");
  await d1.locator("#login-password").fill(process.env.DEMO_PASSWORD);
  await d1.locator('form button[type="submit"]').click();
  await d1.waitForURL("**/daee**", { timeout: 20_000 });
  await d1.goto(`${BASE}/ar/daee/${a.id}`);
  await d1.getByTestId("readings").locator("blockquote").first().waitFor({ timeout: 60_000 });
  check("daee sees readings in the context panel", (await allowedLinks(d1)).count > 0);
  await d1.screenshot({ path: `${OUT}/readings-daee-ar-1440.png` });
  await db.from("profiles").update({ status: "offline" }).eq("user_id", khalid);

  // ---- AI off: no live search; an uncached topic shows the empty state --------------------
  await db.from("organizations").update({ ai_enabled: false }).eq("id", ORG);
  const { count: ethicsAr } = await db.from("library_items").select("id", { count: "exact", head: true }).eq("topic", "ethics").eq("language", "ar");
  const c = await ask(browser, `src3-${TAG}`, "كيف أتعامل مع جاري بلطف؟", "الأخلاق");
  await c.page.getByTestId("readings").waitFor({ timeout: 15_000 });
  await c.page.waitForTimeout(3000);
  const fc = await found(c.id);
  if ((ethicsAr ?? 0) === 0) {
    check("AI off, nothing cached: the empty state, no live search", await c.page.getByText("لا توجد قراءات معتمدة لهذا السؤال بعد").isVisible());
    check("AI off: no live search ran", !fc.some((e) => e.meta.live === true));
  } else {
    check("AI off: cached readings only", !fc.some((e) => e.meta.live === true));
  }
  await shots(c.page, "readings-empty-ar");
} catch (error) {
  results.push(`ERROR  ${error.message.split("\n")[0]}  at ${(error.stack.match(/sources\.mjs:\d+/) ?? [""])[0]}`);
} finally {
  await browser.close();
  await db.from("organizations").update({ ai_enabled: true }).eq("id", ORG);
  for (const s of staff) await db.from("profiles").update({ status: s.status }).eq("user_id", s.user_id);
  const { data: askers } = await db.from("askers").select("user_id").like("pseudonym", `src_-${TAG}`);
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
