// LOCAL VERIFICATION ONLY: landing page checks and screenshots (ar, en, ur at 1440 and 390).
// Needs a running build at BASE (default http://localhost:3127) and .env.local.
//   node --env-file=.env.local scripts/dev/landing.mjs
import { mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const BASE = process.env.VERIFY_BASE ?? "http://localhost:3127";
const OUT = "docs/screenshots";
const SIZES = { 1440: { width: 1440, height: 900 }, 390: { width: 390, height: 844 } };
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);

// Two Arabic speakers available (خالد, يوسف); يوسف also covers Urdu. Restored at the end.
const { data: before } = await db.from("profiles").select("user_id, display_name, status").eq("role", "daee");
const yusuf = before.find((p) => p.display_name === "يوسف");
const khalid = before.find((p) => p.display_name === "خالد");
// No workspace is open for them, so this run keeps their heartbeat fresh itself.
const keepFresh = () =>
  db.from("profiles").update({ status: "available", last_seen: new Date().toISOString() }).in("user_id", [yusuf.user_id, khalid.user_id]);
await keepFresh();
const freshTimer = setInterval(keepFresh, 20_000);

const browser = await chromium.launch();
try {
  // RPC returns a number only.
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const { data: count, error } = await anon.rpc("public_availability", { p_language: "ar" });
  check("public availability is a bare count for anon", !error && typeof count === "number" && count >= 2, `count=${count}`);

  for (const locale of ["ar", "en", "ur"]) {
    for (const [w, viewport] of Object.entries(SIZES)) {
      const ctx = await browser.newContext({ viewport });
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${BASE}/${locale}`);
      await page.evaluate(() => document.fonts.ready);
      // Mid-loop: the card assembled from the highlighted messages.
      await page.waitForTimeout(3300);
      await page.screenshot({ path: `${OUT}/landing-${locale}-${w}.png` });
      // Scroll through once so the on-scroll reveals run, then back to the top.
      for (let y = 0; y < 6000; y += 400) {
        await page.evaluate((top) => window.scrollTo(0, top), y);
        await page.waitForTimeout(120);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/landing-full-${locale}-${w}.png`, fullPage: true });

      if (w === "1440") {
        const avail = await page.locator("p[aria-live]").first().textContent();
        check(`${locale}: availability line shown`, Boolean(avail?.trim()), avail?.trim());
        check(`${locale}: availability names nobody`, !/خالد|يوسف|سارة/.test(avail ?? ""));
        check(`${locale}: dir`, (await page.locator("html").getAttribute("dir")) === (locale === "en" ? "ltr" : "rtl"));
        // The header's start button appears once the hero's scrolls out.
        const headerCta = page.locator("header a[href$='/enter']");
        check(`${locale}: header start hidden at top`, (await headerCta.count()) === 0);
        await page.mouse.wheel(0, 900);
        await page.waitForTimeout(600);
        check(`${locale}: header start shown after scroll`, await headerCta.isVisible());
        await page.screenshot({ path: `${OUT}/landing-scrolled-${locale}-1440.png` });
        // Animation is on the left in both directions (start in LTR, end in RTL).
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(300);
        const anim = await page.locator("[data-hero-animation]").boundingBox();
        const h1 = await page.locator("h1").boundingBox();
        check(`${locale}: animation beside the copy, on the left`, anim && h1 && anim.x < h1.x, `anim.x=${anim?.x} h1.x=${h1?.x}`);
        // Language menu, by keyboard.
        const trigger = page.locator("header [data-slot=dropdown-menu-trigger]");
        await trigger.focus();
        await page.keyboard.press("Enter");
        await page.locator("[role=menuitemradio]").first().waitFor();
        const checked = await page.locator("[role=menuitemradio][aria-checked=true]").textContent();
        check(`${locale}: menu checks the current language`, Boolean(checked?.trim()), checked?.trim());
        check(`${locale}: menu lists seven languages`, (await page.locator("[role=menuitemradio]").count()) === 7);
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${OUT}/landing-menu-${locale}-1440.png` });
        await page.keyboard.press("Escape");
      }
      check(`${locale} ${w}: no page errors`, errors.length === 0, errors.join(" | "));
      if (w === "390") {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        check(`${locale} 390: no horizontal scroll`, !overflow);
      }
      await ctx.close();
    }
  }

  // Keyboard switch: ar → English via the menu.
  const ctx = await browser.newContext({ viewport: SIZES[1440] });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/ar`);
  await page.locator("header [data-slot=dropdown-menu-trigger]").focus();
  await page.keyboard.press("Enter");
  await page.locator("[role=menuitemradio]").first().waitFor();
  await page.locator("[role=menuitemradio]", { hasText: "English" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForURL("**/en", { timeout: 10_000 });
  check("keyboard language switch ar → en", page.url().endsWith("/en"));

  // Reduced motion: one still frame, no loop.
  const still = await browser.newContext({ viewport: SIZES[1440], reducedMotion: "reduce" });
  const sp = await still.newPage();
  await sp.goto(`${BASE}/en`);
  await sp.waitForTimeout(800);
  const a = await sp.locator("[data-hero-animation]").innerText();
  await sp.waitForTimeout(2500);
  const b = await sp.locator("[data-hero-animation]").innerText();
  check("reduced motion: static frame with the card", a === b && a.includes("Wasl card"));
  await sp.screenshot({ path: `${OUT}/landing-reduced-en-1440.png` });

  // Language now has an Urdu daee: the ur landing shows availability, Tagalog shows none (سارة busy).
  await page.goto(`${BASE}/tl`);
  await page.waitForTimeout(1500);
  check("tl: zero available invites a question", ((await page.locator("p[aria-live]").first().textContent()) ?? "").includes("Iwan ang iyong tanong"));

  // Footer: one row with three links and the year, no language menu.
  await page.goto(`${BASE}/en`);
  const footer = page.locator("footer");
  check("footer has the three links", (await footer.getByRole("link").count()) === 3);
  check("footer has no language menu", (await footer.locator("[data-slot=dropdown-menu-trigger]").count()) === 0);

  // Privacy page, login (footer + back), enter (back steps through the questions).
  for (const locale of ["ar", "en"]) {
    for (const [w, viewport] of Object.entries(SIZES)) {
      const ctx2 = await browser.newContext({ viewport });
      const pg = await ctx2.newPage();
      await pg.goto(`${BASE}/${locale}/privacy`);
      await pg.evaluate(() => document.fonts.ready);
      await pg.screenshot({ path: `${OUT}/privacy-${locale}-${w}.png`, fullPage: true });
      await pg.goto(`${BASE}/${locale}/login`);
      await pg.waitForTimeout(400);
      await pg.screenshot({ path: `${OUT}/login-${locale}-${w}.png`, fullPage: true });
      await pg.goto(`${BASE}/${locale}/enter`);
      await pg.waitForTimeout(400);
      await pg.screenshot({ path: `${OUT}/enter-${locale}-${w}.png` });
      await ctx2.close();
    }
  }
  const privacyText = await (await fetch(`${BASE}/en/privacy`)).text();
  check("privacy page states the 12-month card removal", privacyText.includes("12 months"));
  for (const path of ["enter", "return", "wait"]) {
    const html = await (await fetch(`${BASE}/en/${path}`)).text();
    check(`no footer on /${path}`, !html.includes("<footer"));
  }
  check("no footer on login", !(await (await fetch(`${BASE}/en/login`)).text()).includes("<footer"));

  const flow = await (await browser.newContext({ viewport: SIZES[390] })).newPage();
  await flow.goto(`${BASE}/en/enter`);
  await flow.locator('main form button[type="submit"]:not([disabled])').waitFor();
  await flow.locator("main input:not([type=hidden])").fill("back-test");
  await flow.locator("main input:not([type=hidden])").press("Enter");
  await flow.getByText("Anything you'd like the dāʿī to know about you?").waitFor();
  await flow.getByRole("link", { name: "Back" }).click();
  await flow.getByText("What should we call you?").waitFor({ timeout: 5_000 });
  check("enter: back steps to the previous question", (await flow.locator("main input:not([type=hidden])").inputValue()) === "back-test");
  await flow.getByRole("link", { name: "Back" }).click();
  await flow.waitForURL(/\/en$/, { timeout: 10_000 });
  check("enter: back from the first question leaves for the landing page", true);

  // Share metadata.
  const html = await (await fetch(`${BASE}/ur`)).text();
  check("ur: og:image per locale", /og:image" content="[^"]*\/og\/ur\.png/.test(html));
  check("ur: og image file served", (await fetch(`${BASE}/og/ur.png`)).ok);
} catch (error) {
  results.push(`ERROR  ${error.message.split("\n")[0]}`);
} finally {
  clearInterval(freshTimer);
  await browser.close();
  for (const p of before) await db.from("profiles").update({ status: p.status }).eq("user_id", p.user_id);
  console.log(results.join("\n"));
  if (results.some((r) => /^(FAIL|ERROR)/.test(r))) process.exitCode = 1;
}
