// Synthetic demo journeys on top of `npm run seed` (run after `npm run demo:reset -- --yes`).
// Safe to run repeatedly: each asker is looked up by pseudonym first and left alone when
// complete; an incomplete one (an earlier run that failed half way) is removed and rebuilt.
//
//  - سالم: a returning asker, two ended Quran conversations with the daee خالد, an approved
//    card per session and an approved AI-drafted master card merged from them. His return code
//    is fixed (synthetic) and printed at the end; every run resets it to that value.
//  - Noura: an English asker waiting with a question about prayer, with the readings the app
//    had already found for that exact need (existing library rows only, verbatim).
//
// Every text here is invented for the demo. No religious text is written: the readings come
// from library_items as they are.
import { createClient } from "@supabase/supabase-js";
import { allowedDomain, askerAllowed, isFeqhia } from "../lib/ai/sources/allowlist";
import { generateReturnCode, hashReturnCode } from "../lib/auth/return-code";
import { UNDEFINED_FIELD } from "../lib/cards/types";
import { createServiceClient } from "../lib/db/service";
import type { Database } from "../lib/db/types";
import { needHash, type Reading } from "../lib/sources/readings";

type Db = ReturnType<typeof createServiceClient>;
type EventInsert = Database["public"]["Tables"]["events"]["Insert"];

const SALEM = "سالم";
/** Synthetic, from the app's alphabet (no 0/O, 1/I/L). Documented for the demo. */
const SALEM_CODE = "QRAN-7SM3-K4";
const NOURA = "Noura";
const NOURA_QUESTION = "I want to understand what prayer means in daily life.";
const DAEE_NAME = "خالد";
const RIYADH_OFFSET_HOURS = 3;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Set it in .env.local.`);
    process.exit(1);
  }
  return value;
}

/** A Riyadh wall-clock time `daysAgo` days back, as ISO. */
function at(daysAgo: number, hour: number, minute: number, second = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(hour - RIYADH_OFFSET_HOURS, minute, second, 0);
  return d.toISOString();
}
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

type Result<T> = { data: T; error: { message: string } | null };

/** Throws on an error; returns the data as is (null for a write without a select). */
function run<T>(step: string, result: Result<T>): T {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
  return result.data;
}

/** Throws on an error or on missing data. */
function check<T>(step: string, result: Result<T>): NonNullable<T> {
  const data = run(step, result);
  if (data == null) throw new Error(`${step}: no data`);
  return data;
}

/** A real anonymous auth user, like the app's signInAnonymously, so demo:reset removes it. */
async function anonymousUser(): Promise<string> {
  const client = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInAnonymously();
  if (error || !data.user) throw new Error(`anonymous sign-in: ${error?.message ?? "no user"}`);
  return data.user.id;
}

async function findAsker(db: Db, orgId: string, pseudonym: string) {
  return run(
    `find ${pseudonym}`,
    await db.from("askers").select("user_id").eq("org_id", orgId).ilike("pseudonym", pseudonym).maybeSingle(),
  );
}

/** Removes a half-built asker: their events, then the auth user (cascades to everything else). */
async function removeAsker(db: Db, userId: string) {
  const conversations = check("list conversations", await db.from("conversations").select("id").eq("asker_id", userId));
  const ids = conversations.map((c) => c.id);
  if (ids.length) run("delete events", await db.from("events").delete().in("conversation_id", ids));
  const { error } = await db.auth.admin.deleteUser(userId);
  if (error) run("delete asker", await db.from("askers").delete().eq("user_id", userId));
}

async function insertMessages(db: Db, conversationId: string, rows: { sender: string; body: string; at: string }[]) {
  const ids: string[] = [];
  // One at a time: the triggers set sender_role and log the daee events per message.
  for (const row of rows) {
    const inserted = check(
      "insert message",
      await db
        .from("messages")
        .insert({ conversation_id: conversationId, sender_id: row.sender, sender_role: "asker", body: row.body, created_at: row.at })
        .select("id")
        .single(),
    );
    ids.push(inserted.id);
  }
  return ids;
}

/** The trigger logs first_substantive_reply at now(); move it to when the reply was sent. */
async function backdateTriggerEvents(db: Db, conversationId: string, firstSubstantiveAt: string) {
  run(
    "backdate first_substantive_reply",
    await db.from("events").update({ created_at: firstSubstantiveAt }).eq("conversation_id", conversationId).eq("type", "first_substantive_reply"),
  );
}

async function logEvents(db: Db, rows: EventInsert[]) {
  run("insert events", await db.from("events").insert(rows.map((r) => ({ meta: {}, ...r }))));
}

type CardFields = { follow_up: string; covered: string; remaining: string; next_step: string };

/** Saved as a draft, then approved, as the asker's submit does (forever, this daee only). */
async function approvedCard(
  db: Db,
  insert: Database["public"]["Tables"]["cards"]["Insert"],
  approvedAt: string,
  viewer: string,
): Promise<string> {
  const card = check("insert card", await db.from("cards").insert({ ...insert, status: "draft" }).select("id").single());
  run(
    "approve card",
    await db.from("cards").update({ status: "approved", approved_at: approvedAt, expires_at: null }).eq("id", card.id),
  );
  run("card access", await db.from("card_access").upsert({ card_id: card.id, viewer_id: viewer, until: "infinity" }));
  return card.id;
}

async function seedSalem(db: Db, orgId: string, daeeId: string) {
  const existing = await findAsker(db, orgId, SALEM);
  if (existing) {
    const [ended, master] = await Promise.all([
      db.from("conversations").select("id", { count: "exact", head: true }).eq("asker_id", existing.user_id).eq("status", "ended").eq("daee_id", daeeId),
      db.from("cards").select("id", { count: "exact", head: true }).eq("asker_id", existing.user_id).eq("scope", "master").eq("status", "approved"),
    ]);
    if ((ended.count ?? 0) >= 2 && (master.count ?? 0) >= 1) {
      console.log(`${SALEM}: exists with his journeys, left as is`);
      return existing.user_id;
    }
    console.log(`${SALEM}: incomplete from an earlier run, rebuilding`);
    await removeAsker(db, existing.user_id);
  }

  const askerId = await anonymousUser();
  run(
    "insert سالم",
    await db.from("askers").insert({
      user_id: askerId,
      org_id: orgId,
      pseudonym: SALEM,
      language: "ar",
      background: null,
      return_code_hash: "pending",
      codes_revealed: 1,
      created_at: at(5, 18, 55),
    }),
  );

  // ---- Session 1 (five days ago): how the Quran came down. ----
  const intake1 = check(
    "intake 1",
    await db
      .from("intakes")
      .insert({ asker_id: askerId, raw_text: "السلام عليكم، أقرأ عن القرآن لأول مرة وأريد أن أفهم كيف نزل.", language: "ar", topic: "quran", generated_by: "manual", status: "routed", created_at: at(5, 19, 0) })
      .select("id")
      .single(),
  );
  const c1 = check(
    "conversation 1",
    await db
      .from("conversations")
      .insert({
        org_id: orgId,
        asker_id: askerId,
        daee_id: daeeId,
        intake_id: intake1.id,
        topic: "quran",
        classified_by: "chip",
        status: "active",
        match_quality: "full",
        match_reasons: { name: DAEE_NAME, language: "ar", topic: "quran", language_ok: true, topic_ok: true, available: true },
        created_at: at(5, 19, 0),
        assigned_at: at(5, 19, 0, 4),
        started_at: at(5, 19, 2),
      })
      .select("id")
      .single(),
  );
  const m1 = await insertMessages(db, c1.id, [
    { sender: askerId, at: at(5, 19, 0), body: "السلام عليكم، أقرأ عن القرآن لأول مرة وأريد أن أفهم كيف نزل." },
    { sender: daeeId, at: at(5, 19, 2), body: "وعليكم السلام يا سالم، أهلًا بك. سؤال جميل، لنبدأ بما قرأته حتى الآن." },
    { sender: askerId, at: at(5, 19, 6), body: "قرأت أنه نزل على مراحل وليس دفعة واحدة، لكن لم أفهم السبب." },
    { sender: daeeId, at: at(5, 19, 9), body: "صحيح، نزل مفرّقًا على مدى سنوات. نتحدث عن الحكمة من ذلك خطوة خطوة." },
    { sender: askerId, at: at(5, 19, 15), body: "ممتاز. أريد في المرة القادمة أن نتحدث عن ترتيب السور أيضًا." },
    { sender: daeeId, at: at(5, 19, 17), body: "اتفقنا، نكمل في الجلسة القادمة إن شاء الله." },
  ]);
  await backdateTriggerEvents(db, c1.id, at(5, 19, 2));
  run("end conversation 1", await db.from("conversations").update({ status: "ended", ended_at: at(5, 19, 20) }).eq("id", c1.id));

  // The asker wrote this one by hand from the messages they selected.
  const card1 = await approvedCard(
    db,
    {
      conversation_id: c1.id,
      asker_id: askerId,
      version: 1,
      generated_by: "manual",
      origin: "manual",
      follow_up: "أن أفهم لماذا نزل القرآن على مراحل.",
      covered: "أن القرآن نزل على مراحل وليس دفعة واحدة.",
      remaining: "ترتيب السور.",
      next_step: "الحديث عن ترتيب السور في الجلسة القادمة.",
      source_message_ids: [m1[2], m1[4]],
      preferred_daee: daeeId,
      accept_substitute: true,
      visibility: "this_daee",
      created_at: at(5, 19, 22),
    },
    at(5, 19, 24),
    daeeId,
  );

  // ---- Session 2 (two days ago): a follow-up from that card. ----
  const intake2 = check(
    "intake 2",
    await db
      .from("intakes")
      .insert({ asker_id: askerId, raw_text: "عدت لنكمل حديثنا عن القرآن، أريد أن أفهم ترتيب السور.", language: "ar", topic: "quran", generated_by: "manual", status: "routed", created_at: at(2, 20, 10) })
      .select("id")
      .single(),
  );
  const c2 = check(
    "conversation 2",
    await db
      .from("conversations")
      .insert({
        org_id: orgId,
        asker_id: askerId,
        daee_id: daeeId,
        intake_id: intake2.id,
        topic: "quran",
        classified_by: "chip",
        status: "active",
        previous_conversation_id: c1.id,
        card_id: card1,
        followup_mode: "manual",
        preferred_daee_id: daeeId,
        match_quality: "full",
        match_reasons: { name: DAEE_NAME, language: "ar", topic: "quran", language_ok: true, topic_ok: true, available: true },
        created_at: at(2, 20, 10),
        assigned_at: at(2, 20, 10, 3),
        started_at: at(2, 20, 12),
      })
      .select("id")
      .single(),
  );
  const m2 = await insertMessages(db, c2.id, [
    { sender: askerId, at: at(2, 20, 10), body: "عدت لنكمل حديثنا عن القرآن، أريد أن أفهم ترتيب السور." },
    { sender: daeeId, at: at(2, 20, 12), body: "أهلًا بعودتك يا سالم. قرأت بطاقتك، توقفنا عند ترتيب السور فلنبدأ من هناك." },
    { sender: askerId, at: at(2, 20, 16), body: "لاحظت أن السور ليست مرتبة حسب زمن نزولها، هل هذا صحيح؟" },
    { sender: daeeId, at: at(2, 20, 19), body: "نعم، ترتيبها في المصحف يختلف عن ترتيب نزولها، وسنتوقف عند أمثلة على ذلك معًا." },
    { sender: askerId, at: at(2, 20, 25), body: "شكرًا. ما زلت أريد أن أعرف كيف جُمع القرآن في مصحف واحد." },
    { sender: daeeId, at: at(2, 20, 27), body: "سؤال مهم، نخصص له جلستنا القادمة إن شاء الله." },
  ]);
  await backdateTriggerEvents(db, c2.id, at(2, 20, 12));
  run(
    "end conversation 2",
    await db.from("conversations").update({ status: "ended", ended_at: at(2, 20, 30), followup_sufficient: true, followup_card_accurate: true }).eq("id", c2.id),
  );

  // Drafted by the AI from the selected messages and approved unchanged.
  const draft2: CardFields = {
    follow_up: "فهم ترتيب سور القرآن.",
    covered: "أن ترتيب السور في المصحف يختلف عن ترتيب نزولها.",
    remaining: "كيف جُمع القرآن في مصحف واحد.",
    next_step: UNDEFINED_FIELD,
  };
  const card2 = await approvedCard(
    db,
    {
      conversation_id: c2.id,
      asker_id: askerId,
      version: 1,
      generated_by: "ai",
      origin: "ai",
      ...draft2,
      ai_draft: draft2,
      field_sources: { follow_up: [m2[0]], covered: [m2[2], m2[3]], remaining: [m2[4]], next_step: [] },
      edited_major: false,
      source_message_ids: [m2[0], m2[2], m2[3], m2[4]],
      preferred_daee: daeeId,
      accept_substitute: true,
      visibility: "this_daee",
      created_at: at(2, 20, 32),
    },
    at(2, 20, 34),
    daeeId,
  );

  // KPI events, as the real flows log them (routing and starts are logged by SQL in the app).
  await logEvents(db, [
    { org_id: orgId, type: "intake_created", conversation_id: c1.id, actor_role: "asker", meta: { topic: "quran", language: "ar", generated_by: "manual" }, created_at: at(5, 19, 0) },
    { org_id: orgId, type: "classified", conversation_id: c1.id, actor_role: "system", meta: { topic: "quran", confidence: null, source: "chip", ai_topic: null }, created_at: at(5, 19, 0, 1) },
    { org_id: orgId, type: "routed", conversation_id: c1.id, actor_role: "system", meta: { daee_id: daeeId, topic_match: true }, created_at: at(5, 19, 0, 4) },
    { org_id: orgId, type: "conversation_started", conversation_id: c1.id, actor_role: "daee", created_at: at(5, 19, 2) },
    { org_id: orgId, type: "card_generated", conversation_id: c1.id, actor_role: "asker", meta: { origin: "manual" }, created_at: at(5, 19, 22) },
    { org_id: orgId, type: "card_approved", conversation_id: c1.id, actor_role: "asker", meta: { origin: "manual", edited_major: false }, created_at: at(5, 19, 24) },
    { org_id: orgId, type: "intake_created", conversation_id: c2.id, actor_role: "asker", meta: { topic: "quran", language: "ar", generated_by: "manual" }, created_at: at(2, 20, 10) },
    { org_id: orgId, type: "classified", conversation_id: c2.id, actor_role: "system", meta: { topic: "quran", confidence: null, source: "chip", ai_topic: null }, created_at: at(2, 20, 10, 1) },
    { org_id: orgId, type: "followup_started", conversation_id: c2.id, actor_role: "asker", meta: { mode: "manual" }, created_at: at(2, 20, 10, 2) },
    { org_id: orgId, type: "routed", conversation_id: c2.id, actor_role: "system", meta: { daee_id: daeeId, topic_match: true }, created_at: at(2, 20, 10, 3) },
    { org_id: orgId, type: "conversation_started", conversation_id: c2.id, actor_role: "daee", created_at: at(2, 20, 12) },
    { org_id: orgId, type: "followup_rated", conversation_id: c2.id, actor_role: "daee", meta: { mode: "manual", sufficient: true, card_accurate: true }, created_at: at(2, 20, 30) },
    { org_id: orgId, type: "card_generated", conversation_id: c2.id, actor_role: "asker", meta: { origin: "ai" }, created_at: at(2, 20, 32) },
    { org_id: orgId, type: "card_approved", conversation_id: c2.id, actor_role: "asker", meta: { origin: "ai", edited_major: false }, created_at: at(2, 20, 34) },
    { org_id: orgId, type: "master_card_generated", actor_role: "asker", meta: { origin: "ai" }, created_at: at(2, 20, 36) },
    { org_id: orgId, type: "master_card_approved", actor_role: "asker", meta: { origin: "ai", edited_major: false }, created_at: at(2, 20, 37) },
  ]);
  // Last, so a run that stops earlier is rebuilt next time.
  // ---- The master card: merged by the AI from both approved session cards. ----
  const master: CardFields = {
    follow_up: "فهم القرآن: كيف نزل، وكيف رُتّبت سوره، وكيف جُمع.",
    covered: "أن القرآن نزل على مراحل، وأن ترتيب السور في المصحف يختلف عن ترتيب نزولها.",
    remaining: "كيف جُمع القرآن في مصحف واحد.",
    next_step: UNDEFINED_FIELD,
  };
  await approvedCard(
    db,
    {
      scope: "master",
      conversation_id: null,
      asker_id: askerId,
      version: 1,
      generated_by: "ai",
      origin: "ai",
      ...master,
      source_card_ids: [card1, card2],
      field_sources: { follow_up: [card1, card2], covered: [card1, card2], remaining: [card2], next_step: [] },
      ai_draft: master,
      edited_major: false,
      preferred_daee: daeeId,
      visibility: "this_daee",
      created_at: at(2, 20, 36),
    },
    at(2, 20, 37),
    daeeId,
  );

  console.log(`${SALEM}: created (2 ended conversations with ${DAEE_NAME}, 2 session cards, 1 AI master card)`);
  return askerId;
}

async function seedNoura(db: Db, orgId: string, salt: string) {
  const existing = await findAsker(db, orgId, NOURA);
  if (existing) {
    // Her events are written last: with them, the earlier rows are there too.
    const conversations = check("list conversations", await db.from("conversations").select("id").eq("asker_id", existing.user_id));
    const { count } = conversations.length
      ? await db.from("events").select("id", { count: "exact", head: true }).in("conversation_id", conversations.map((c) => c.id)).eq("type", "intake_created")
      : { count: 0 };
    if ((count ?? 0) > 0) {
      console.log(`${NOURA}: exists with her question, left as is`);
      return;
    }
    console.log(`${NOURA}: incomplete from an earlier run, rebuilding`);
    await removeAsker(db, existing.user_id);
  }

  // The readings the app already found for this exact need (tier "need" in lib/sources/readings.ts):
  // the same query and filters an asker gets, so nothing is written to the library.
  const hash = needHash(NOURA_QUESTION);
  const rows = check(
    "cached readings",
    await db
      .from("library_items")
      .select("id, title, body, source_url, verified_by")
      .eq("org_id", orgId)
      .eq("need_hash", hash)
      .eq("language", "en")
      .eq("asker_ok", true)
      .order("created_at", { ascending: false })
      .limit(3),
  );
  const items: Reading[] = rows
    .filter((r) => Boolean(allowedDomain(r.source_url)) && askerAllowed(r.source_url))
    .map((r) => ({ id: r.id, title: r.title, text: r.body, url: r.source_url, verified_by: r.verified_by === "human" ? "human" : "auto", feqhia: isFeqhia(r.source_url) }));
  if (items.length === 0) console.warn(`${NOURA}: no cached library readings for her question; she is seeded without readings`);

  const askerId = await anonymousUser();
  run(
    "insert Noura",
    await db.from("askers").insert({ user_id: askerId, org_id: orgId, pseudonym: NOURA, language: "en", background: null, return_code_hash: hashReturnCode(generateReturnCode(), salt), created_at: minutesAgo(14) }),
  );
  const intake = check(
    "intake",
    await db
      .from("intakes")
      .insert({ asker_id: askerId, raw_text: NOURA_QUESTION, language: "en", topic: "worship", generated_by: "manual", status: "routed", created_at: minutesAgo(12) })
      .select("id")
      .single(),
  );
  // Waiting: nobody was free in English when she asked (route_conversation's "none").
  const conversation = check(
    "conversation",
    await db
      .from("conversations")
      .insert({
        org_id: orgId,
        asker_id: askerId,
        intake_id: intake.id,
        topic: "worship",
        classified_by: "chip",
        status: "waiting",
        match_quality: "none",
        match_reasons: { language: "en", topic: "worship", language_ok: false, topic_ok: false, available: false },
        created_at: minutesAgo(12),
      })
      .select("id")
      .single(),
  );
  await insertMessages(db, conversation.id, [{ sender: askerId, at: minutesAgo(12), body: NOURA_QUESTION }]);
  if (items.length) {
    run(
      "conversation readings",
      await db.from("conversation_readings").insert({ conversation_id: conversation.id, items, need_hash: hash, created_at: minutesAgo(11) }),
    );
  }
  await logEvents(db, [
    { org_id: orgId, type: "intake_created", conversation_id: conversation.id, actor_role: "asker", meta: { topic: "worship", language: "en", generated_by: "manual" }, created_at: minutesAgo(12) },
    { org_id: orgId, type: "classified", conversation_id: conversation.id, actor_role: "system", meta: { topic: "worship", confidence: null, source: "chip", ai_topic: null }, created_at: minutesAgo(12) },
    ...(items.length
      ? [{ org_id: orgId, type: "sources_found", conversation_id: conversation.id, actor_role: "asker", meta: { count: items.length, live: false, tier: "need" }, created_at: minutesAgo(11) }]
      : []),
  ]);
  console.log(`${NOURA}: created (waiting, worship, ${items.length} cached readings)`);
}

async function main() {
  requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const db = createServiceClient();

  // The app's organization: the oldest one (lib/db/queries/org.ts).
  const org = check("organization", await db.from("organizations").select("id, return_code_salt").order("created_at").limit(1).single());
  const daee = check(
    `daee ${DAEE_NAME}`,
    await db.from("profiles").select("user_id").eq("org_id", org.id).eq("role", "daee").eq("display_name", DAEE_NAME),
  );
  if (daee.length !== 1) throw new Error(`expected one daee named ${DAEE_NAME}, found ${daee.length}. Run npm run seed first.`);

  const salemId = await seedSalem(db, org.id, daee[0].user_id);
  // The documented code always works after a run (the demo may have issued a new one).
  run(
    "return code",
    await db.from("askers").update({ return_code_hash: hashReturnCode(SALEM_CODE, org.return_code_salt) }).eq("user_id", salemId),
  );
  run("clear lockout", await db.from("return_attempts").delete().eq("org_id", org.id).eq("pseudonym_key", SALEM.toLowerCase()));

  await seedNoura(db, org.id, org.return_code_salt);
  console.log(`Demo data ready. Return as ${SALEM} with the code ${SALEM_CODE} (synthetic).`);
}

main().catch((error) => {
  console.error("Demo seed failed:", error.message ?? error);
  process.exit(1);
});
