-- Privacy: a daee reads an asker's background and an intake's text only for a
-- conversation assigned to them, or through a card they may view. Before this, any daee
-- read every asker and every intake in the database (askers_staff_read, intakes_daee).
-- The admin reads neither. Queue metadata for staff comes from daee_queue_meta(), which
-- returns non-content fields only.

drop policy if exists askers_staff_read on askers;
drop policy if exists intakes_daee on intakes;

-- security definer: reads conversations and cards without their RLS (no policy recursion),
-- and is scoped to the caller by auth.uid() inside.
create or replace function daee_reads_asker(a uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_daee() and me_active() and (
    exists (select 1 from conversations c where c.asker_id = a and c.daee_id = auth.uid())
    or exists (select 1 from cards k where k.asker_id = a and can_view_card(k.id))
  )
$$;

-- An intake: its conversation is assigned to the caller, or a card of that conversation
-- (or the asker's master card, which has no conversation) is one the caller may view.
create or replace function daee_reads_intake(i uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_daee() and me_active() and (
    exists (select 1 from conversations c where c.intake_id = i and c.daee_id = auth.uid())
    or exists (
      select 1 from conversations c join cards k on k.conversation_id = c.id
       where c.intake_id = i and can_view_card(k.id)
    )
    or exists (
      select 1 from intakes n join cards k on k.asker_id = n.asker_id and k.scope = 'master'
       where n.id = i and can_view_card(k.id)
    )
  )
$$;

revoke execute on function daee_reads_asker(uuid) from public, anon;
revoke execute on function daee_reads_intake(uuid) from public, anon;
grant execute on function daee_reads_asker(uuid) to authenticated;
grant execute on function daee_reads_intake(uuid) to authenticated;

create policy askers_daee_scoped on askers for select to authenticated using (daee_reads_asker(askers.user_id));
create policy intakes_daee_scoped on intakes for select to authenticated using (daee_reads_intake(intakes.id));

-- The org's open queue for an active daee: ids, state, routing metadata and times. Never
-- text (no question, summary, background, messages) and never the asker's identity.
create or replace function daee_queue_meta()
returns table (
  conversation_id uuid,
  status conv_status,
  topic text,
  language text,
  level text,
  depth text,
  assigned_to_me boolean,
  created_at timestamptz,
  assigned_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select c.id, c.status, c.topic, a.language, c.level::text, c.depth::text,
         c.daee_id is not distinct from auth.uid(), c.created_at, c.assigned_at
    from conversations c
    join askers a on a.user_id = c.asker_id
    join profiles p on p.user_id = auth.uid() and p.role = 'daee' and p.org_id = c.org_id
   where c.status in ('waiting', 'active')
     and is_active_staff(auth.uid())
   order by c.created_at
$$;
revoke execute on function daee_queue_meta() from public, anon;
grant execute on function daee_queue_meta() to authenticated;
