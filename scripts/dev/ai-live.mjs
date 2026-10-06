// LIVE SMOKE: one AI card generation on the deployed app, then cleanup of the test asker.
//   node --env-file=.env.local scripts/dev/ai-live.mjs
// Synthetic messages only. Prints the generated card and its ai_runs row (output redacted).
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { plainQuestionBox } from "./lib/entry.mjs";

const BASE = process.env.LIVE_BASE ?? "https://wasl-swart-pi.vercel.app";
const TAG = `live-${Date.now().toString(36)}`;
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const browser = await chromium.launch();
let askerId = null;
try {
  const page = await (await browser.newContext()).newPage();
  // Indonesian entry: no daee online for it, so this test conversation isn't routed to anyone.
  await page.goto(`${BASE}/id/enter`);
  await page.locator('main form button[type="submit"]:not([disabled])').waitFor();
  await page.locator("main input:not([type=hidden])").fill(TAG);
  await page.locator("main input:not([type=hidden])").press("Enter");
  await page.locator('button[name="skip"]').click();
  await page.waitForURL("**/wait", { timeout: 30_000 });
  await plainQuestionBox(page);
  const q = page.locator('textarea[name="question"]');
  await q.waitFor();
  await q.fill("أريد أن أفهم معنى الصيام في رمضان وكيف يعيشه الناس.");
  await q.press("Enter");
  await page.waitForURL("**/chat/**", { timeout: 30_000 });
  const conversationId = page.url().split("/chat/")[1];
  for (const text of ["أعرف أنه شهر كامل، لكن لا أعرف كيف يوفّق الناس بين الصيام والعمل.", "في المرة القادمة أريد أن نتحدث عن يوم عادي في رمضان."]) {
    await page.locator("footer textarea").fill(text);
    await page.locator("footer textarea").press("Enter");
    await page.waitForTimeout(1200);
  }
  const { data: conv } = await db.from("conversations").select("asker_id").eq("id", conversationId).single();
  askerId = conv.asker_id;
  const { data: messages } = await db.from("messages").select("id").eq("conversation_id", conversationId).order("created_at");
  const started = Date.now();
  const res = await page.request.post(`${BASE}/api/ai/card`, {
    data: { conversationId, messageIds: messages.map((m) => m.id), locale: "ar" },
    timeout: 60_000,
  });
  const lines = (await res.text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const last = lines.at(-1);
  if (!res.ok()) process.exitCode = 1;
  console.log(JSON.stringify({ status: res.status(), partials: lines.length - 1, roundTripMs: Date.now() - started, result: last }, null, 2));
  const { data: run } = await db
    .from("ai_runs")
    .select("task, model, input_hash, output, latency_ms, fallback, reason, created_at")
    .eq("actor_id", askerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  console.log("AI_RUN", JSON.stringify(run, null, 2));
} finally {
  await browser.close();
  if (askerId) {
    const { data: convs } = await db.from("conversations").select("id").eq("asker_id", askerId);
    for (const c of convs ?? []) await db.from("events").delete().eq("conversation_id", c.id);
    await db.from("ai_runs").delete().eq("actor_id", askerId);
    await db.auth.admin.deleteUser(askerId);
  }
}
