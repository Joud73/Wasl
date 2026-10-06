// Database probes for the staff read scope (migration 0019). Builds a synthetic fixture
// (an asker with a background, an intake, a conversation assigned to daee1), then reads it
// through RLS as daee1 (assigned), daee2 (unassigned, no card access) and the admin.
// Run: node --env-file=.env.local scripts/dev/privacy-probes.mjs   Exits 1 on any failure.
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const service = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const password = process.env.DEMO_PASSWORD;
if (!url || !anon || !password) throw new Error("NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and DEMO_PASSWORD are required");

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

async function as(email) {
  const client = createClient(url, anon, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in ${email}: ${error.message}`);
  return client;
}

async function userId(email) {
  const { data } = await service.from("profiles").select("user_id, org_id").eq("display_name", email === "daee1@wasl.demo" ? "خالد" : "سارة").single();
  return data;
}

const stamp = Date.now();
const fixture = {};
try {
  const daee1 = await userId("daee1@wasl.demo");
  const { data: user, error: userError } = await service.auth.admin.createUser({ email: `probe-${stamp}@wasl.invalid`, email_confirm: true });
  if (userError) throw userError;
  fixture.user = user.user.id;
  let r = await service.from("askers").insert({ user_id: fixture.user, org_id: daee1.org_id, pseudonym: `probe-${stamp}`, return_code_hash: "probe", background: "PROBE-BACKGROUND", language: "ar" });
  if (r.error) throw r.error;
  r = await service.from("intakes").insert({ asker_id: fixture.user, raw_text: "PROBE-RAW-TEXT", transcript: [{ role: "asker", text: "PROBE-TRANSCRIPT" }], status: "routed" }).select("id").single();
  if (r.error) throw r.error;
  fixture.intake = r.data.id;
  r = await service
    .from("conversations")
    .insert({ org_id: daee1.org_id, asker_id: fixture.user, intake_id: fixture.intake, daee_id: daee1.user_id, status: "active", topic: "quran", assigned_at: new Date().toISOString(), started_at: new Date().toISOString() })
    .select("id")
    .single();
  if (r.error) throw r.error;
  fixture.conversation = r.data.id;

  const read = async (client) => {
    const asker = await client.from("askers").select("pseudonym, background").eq("user_id", fixture.user).maybeSingle();
    const intake = await client.from("intakes").select("raw_text, transcript").eq("id", fixture.intake).maybeSingle();
    const embedded = await client.from("conversations").select("id, asker:askers(background), intake:intakes(raw_text)").eq("id", fixture.conversation).maybeSingle();
    return { asker: asker.data, intake: intake.data, embedded: embedded.data };
  };

  // The assigned daee still reads what the workspace needs.
  const assigned = await read(await as("daee1@wasl.demo"));
  check("assigned daee reads askers.background", assigned.asker?.background === "PROBE-BACKGROUND");
  check("assigned daee reads intakes.raw_text", assigned.intake?.raw_text === "PROBE-RAW-TEXT");
  check("assigned daee reads intakes.transcript", JSON.stringify(assigned.intake?.transcript ?? "").includes("PROBE-TRANSCRIPT"));
  check("assigned daee: inbox embed returns the asker and intake", assigned.embedded?.asker?.background === "PROBE-BACKGROUND" && assigned.embedded?.intake?.raw_text === "PROBE-RAW-TEXT");

  // An unassigned daee (no card access) reads nothing.
  const daee2 = await as("daee2@wasl.demo");
  const other = await read(daee2);
  check("unassigned daee reads no askers row", other.asker === null, JSON.stringify(other.asker));
  check("unassigned daee reads no intakes row", other.intake === null, JSON.stringify(other.intake));
  check("unassigned daee reads no conversation", other.embedded === null);
  const all = await daee2.from("intakes").select("raw_text").not("raw_text", "is", null).limit(1000);
  check("unassigned daee: bulk intakes read contains no fixture text", !(all.data ?? []).some((x) => x.raw_text === "PROBE-RAW-TEXT"), `${all.data?.length ?? 0} visible`);

  // The queue function returns metadata only, never content or identity.
  const queue = await daee2.rpc("daee_queue_meta");
  const row = (queue.data ?? []).find((q) => q.conversation_id === fixture.conversation);
  check("daee_queue_meta lists the fixture for another daee", Boolean(row), queue.error?.message);
  check("daee_queue_meta returns no content fields", row ? !JSON.stringify(row).includes("PROBE") && !("background" in row) && !("raw_text" in row) && !("pseudonym" in row) : false);

  // The admin reads none of it.
  const admin = await read(await as("admin@wasl.demo"));
  check("admin reads no askers row", admin.asker === null);
  check("admin reads no intakes row", admin.intake === null);
  check("admin: conversation embed carries no asker or intake", !admin.embedded || (admin.embedded.asker === null && admin.embedded.intake === null));

  // Anonymous key without a session reads nothing.
  const anonClient = createClient(url, anon, { auth: { persistSession: false } });
  const anonRead = await anonClient.from("intakes").select("raw_text").eq("id", fixture.intake).maybeSingle();
  check("anonymous reads no intake", anonRead.data === null);
} catch (error) {
  console.log(`FAIL  probe setup: ${error?.message ?? error}`);
  failures++;
} finally {
  if (fixture.conversation) await service.from("conversations").delete().eq("id", fixture.conversation);
  if (fixture.intake) await service.from("intakes").delete().eq("id", fixture.intake);
  if (fixture.user) await service.auth.admin.deleteUser(fixture.user);
}

console.log(failures ? `\n${failures} probe(s) failed` : "\nall probes passed");
process.exitCode = failures ? 1 : 0;
