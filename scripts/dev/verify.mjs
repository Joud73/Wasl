// LOCAL VERIFICATION ONLY: two-session chat test plus screenshots of every changed screen.
// Needs a running build at BASE (default http://localhost:3127) and .env.local.
//   node --env-file=.env.local scripts/dev/verify.mjs
// Staff passwords are read from DEMO_PASSWORD inside this process and never printed.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { plainQuestionBox } from "./lib/entry.mjs";

const BASE = process.env.VERIFY_BASE ?? "http://localhost:3127";
const OUT = "docs/screenshots";
const WIDTHS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 }, admin: { width: 1440, height: 1500 } };
const LOCALES = ["ar", "en"];
const PSEUDONYM = `e2e-${Date.now().toString(36)}`;
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) console.error(`FAIL ${name} ${detail}`);
};
const shot = async (page, name, size, fullPage = false) => {
  await page.setViewportSize(WIDTHS[size]);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}-${size === "mobile" ? 390 : 1440}.png`, fullPage });
};
const shotBoth = async (page, name) => {
  for (const size of ["desktop", "mobile"]) await shot(page, name, size);
  await page.setViewportSize(WIDTHS.desktop);
};

async function login(context, email, landing) {
  const page = await context.newPage();
  await page.goto(`${BASE}/ar/login`);
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(process.env.DEMO_PASSWORD);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(`**${landing}**`, { timeout: 20_000 });
  return page;
}

const browser = await chromium.launch();
try {
  // Seeded presence: daee1 available.
  const { data: profile } = await db.from("profiles").select("user_id").eq("display_name", "خالد").single();
  await db.from("profiles").update({ status: "available", last_seen: new Date().toISOString() }).eq("user_id", profile.user_id);

  // ---- Public screens --------------------------------------------------------------------
  // The organization name is editable in Settings, so read the current one.
  const { data: org } = await db.from("organizations").select("name").order("created_at").limit(1).single();
  const anon = await browser.newContext({ viewport: WIDTHS.desktop });
  const pub = await anon.newPage();
  for (const locale of LOCALES) {
    await pub.goto(`${BASE}/${locale}`);
    check(`landing ${locale} shows org name`, await pub.locator("header").getByText(org.name, { exact: true }).first().isVisible());
    // Landing screenshots: scripts/dev/landing.mjs.
    await pub.goto(`${BASE}/${locale}/login`);
    await pub.waitForTimeout(500);
    await shotBoth(pub, `login-${locale}`);
  }
  await pub.goto(`${BASE}/ar/login`);
  await pub.locator("#login-password").fill("x");
  await pub.locator('button[aria-pressed]').first().click();
  check("password show/hide toggles type", (await pub.locator("#login-password").getAttribute("type")) === "text");
  await anon.close();

  // ---- Two sessions: daee1 and an asker ------------------------------------------------
  const daeeCtx = await browser.newContext({ viewport: WIDTHS.desktop });
  const askerCtx = await browser.newContext({ viewport: WIDTHS.desktop });
  const daee = await login(daeeCtx, "daee1@wasl.demo", "/daee");
  check("daee1 login lands on inbox", daee.url().includes("/ar/daee"));
  await shotBoth(daee, "inbox-empty-ar");

  const asker = await askerCtx.newPage();
  await asker.goto(`${BASE}/ar/enter`);
  const pseudonymBox = asker.locator("main input:not([type=hidden])");
  await asker.locator('main form button[type="submit"]:not([disabled])').waitFor();
  await pseudonymBox.fill(PSEUDONYM);
  await pseudonymBox.press("Enter");
  await asker.locator('button[name="skip"]').click();
  await asker.waitForURL("**/wait", { timeout: 30_000 });
  check("no return code at entry", (await asker.getByTestId("return-code").count()) === 0);
  await plainQuestionBox(asker);
  const question = asker.locator('textarea[name="question"]');
  await question.waitFor();
  await asker.getByRole("button", { name: "التوحيد" }).click();
  await question.fill("سؤال اختبار آلي من سكربت التحقق");
  await question.press("Enter");
  await asker.waitForURL("**/chat/**", { timeout: 20_000 });
  const conversationId = asker.url().split("/chat/")[1];

  const row = daee.locator("aside a", { hasText: PSEUDONYM });
  await daee.getByRole("tab", { name: /^بانتظار الرد/ }).click();
  await row.waitFor({ timeout: 15_000 });
  check("routed live into daee list", await row.isVisible());
  const toast = daee.locator("[data-sonner-toast]");
  check("toast shown on routing", await toast.isVisible().catch(() => false));
  const badge = await daee.locator('nav [role="status"]').textContent().catch(() => null);
  const unreadRows = await daee.locator('aside ul li .bg-brand-violet').count();
  check("badge matches unread rows", badge !== null && Number(badge) === unreadRows, `badge=${badge} rows=${unreadRows}`);

  await row.click();
  await daee.waitForURL(`**/daee/${conversationId}`);
  const reply = daee.locator("main textarea");
  await reply.waitFor();
  await reply.fill("أهلًا بك، هذا رد آلي طويل بما يكفي لتسجيل أول رد جوهري في المحادثة.");
  await reply.press("Enter");
  await asker.getByText("هذا رد آلي طويل").first().waitFor({ timeout: 15_000 });
  check("daee message arrives live for asker", true);
  await asker.locator("footer textarea").fill("شكرًا، وصلت الرسالة");
  await asker.locator("footer textarea").press("Enter");
  await daee.getByText("شكرًا، وصلت الرسالة").first().waitFor({ timeout: 15_000 });
  check("asker message arrives live for daee", true);

  await asker.locator("footer textarea").fill("سطر أول");
  await asker.locator("footer textarea").press("Shift+Enter");
  check("Shift+Enter does not send", (await asker.locator("footer textarea").inputValue()).startsWith("سطر أول"));
  await asker.locator("footer textarea").fill("");

  for (const locale of LOCALES) {
    await daee.goto(`${BASE}/${locale}/daee/${conversationId}`);
    await daee.locator("main textarea").waitFor();
    await shotBoth(daee, `inbox-conversation-${locale}`);
    await asker.goto(`${BASE}/${locale}/chat/${conversationId}`);
    await asker.locator("footer textarea").waitFor();
    await shotBoth(asker, `chat-${locale}`);
  }

  await daee.goto(`${BASE}/ar/daee/${conversationId}`);
  await daee.getByRole("button", { name: /إنهاء المحادثة/ }).click();
  await daee.getByRole("button", { name: "تأكيد الإنهاء" }).click();
  await asker.goto(`${BASE}/ar/chat/${conversationId}`);
  await asker.getByText("انتهت هذه المحادثة").waitFor({ timeout: 15_000 });
  check("asker sees conversation ended", true);
  await daee.getByText(/^انتهت /).first().waitFor({ timeout: 15_000 });
  await shotBoth(daee, "inbox-ended-ar");
  await shotBoth(asker, "chat-ended-ar");

  const { data: events } = await db.from("events").select("type").eq("conversation_id", conversationId);
  const types = new Set(events.map((e) => e.type));
  for (const type of ["intake_created", "routed", "conversation_started", "first_substantive_reply"]) {
    check(`event ${type} logged`, types.has(type));
  }
  await daeeCtx.close();
  await askerCtx.close();

  // ---- Admin ------------------------------------------------------------------------------
  const adminCtx = await browser.newContext({ viewport: WIDTHS.desktop });
  const admin = await login(adminCtx, "admin@wasl.demo", "/admin");
  const sections = { overview: "/admin?range=all", team: "/admin/team", log: "/admin/log", settings: "/admin/settings" };
  for (const locale of LOCALES) {
    for (const [name, path] of Object.entries(sections)) {
      await admin.goto(`${BASE}/${locale}${path}`);
      await admin.waitForTimeout(800);
      await shot(admin, `admin-${name}-empty-${locale}`, "admin");
    }
  }
  execFileSync("node", ["--env-file=.env.local", "scripts/dev/admin-synthetic.mjs", "--seed"], { stdio: "inherit" });
  try {
    for (const locale of LOCALES) {
      await admin.goto(`${BASE}/${locale}/admin?range=all`);
      await admin.waitForTimeout(1200);
      await shot(admin, `admin-overview-${locale}`, "admin");
      if (locale === "en") {
        // Since launch mixes in real routed conversations, so only check that a rate is shown (n ≥ 5).
        check("routing tile shows a rate", /^\d+%$/.test((await admin.locator("p.text-4xl").first().textContent()) ?? ""));
        check("alerts list shows uncovered language", await admin.getByText(/no available dāʿī speaks it/).isVisible().catch(() => false));
      }
      await admin.goto(`${BASE}/${locale}/admin/log`);
      await shot(admin, `admin-log-${locale}`, "admin");
      await admin.goto(`${BASE}/${locale}/admin/log?tab=ai`);
      await shot(admin, `admin-log-ai-${locale}`, "admin");
    }
  } finally {
    execFileSync("node", ["--env-file=.env.local", "scripts/dev/admin-synthetic.mjs", "--remove"], { stdio: "inherit" });
  }
  await adminCtx.close();
} catch (error) {
  results.push(`ERROR  ${error.message.split("\n")[0]}`);
} finally {
  await browser.close();
  // Remove the asker this run created (and its rows).
  const { data: askers } = await db.from("askers").select("user_id").like("pseudonym", "e2e-%");
  for (const a of askers ?? []) {
    const { data: convs } = await db.from("conversations").select("id").eq("asker_id", a.user_id);
    for (const c of convs ?? []) {
      await db.from("events").delete().eq("conversation_id", c.id);
      await db.from("notifications").delete().eq("payload->>conversation_id", c.id);
    }
    await db.auth.admin.deleteUser(a.user_id);
  }
  console.log(results.join("\n"));
  if (results.some((r) => /^(FAIL|ERROR)/.test(r))) process.exitCode = 1;
}
