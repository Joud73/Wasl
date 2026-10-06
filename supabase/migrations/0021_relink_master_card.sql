-- A returning asker with a master card could not come back: relink_asker updates
-- askers.user_id, the cascade updates cards.asker_id row by row, and cards_guard rejected the
-- master card because its session cards still carried the old id at that moment. The master
-- sources are now checked only when they are set or changed. Otherwise as in 0011.

create or replace function cards_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  service boolean := coalesce(auth.jwt() ->> 'role', '') = 'service_role';
begin
  -- A master card's sources are the asker's approved session cards, never messages.
  if new.scope = 'master' then
    if new.conversation_id is not null or cardinality(new.source_message_ids) > 0 then
      raise exception 'a master card has no conversation and no message sources';
    end if;
    -- Checked when the sources are set, not when a return relinks the asker: that cascade
    -- updates asker_id row by row, so the session cards may still carry the old id here.
    if (tg_op = 'INSERT' or new.source_card_ids is distinct from old.source_card_ids) and exists (
      select 1 from unnest(new.source_card_ids) as s(id)
       where not exists (select 1 from cards k where k.id = s.id and k.asker_id = new.asker_id and k.scope = 'session' and k.status = 'approved')
    ) then
      raise exception 'master sources must be the asker''s approved session cards';
    end if;
  elsif new.conversation_id is null then
    raise exception 'a session card belongs to a conversation';
  end if;

  if exists (
    select 1 from unnest(new.source_message_ids) as s(id)
     where not exists (select 1 from messages m where m.id = s.id and m.conversation_id = new.conversation_id)
  ) then
    raise exception 'source messages must belong to the conversation';
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'approved' then raise exception 'a new version starts as a draft'; end if;
    return new;
  end if;

  if old.status = 'approved' then
    -- Only removal (soft delete) or expiry may touch an approved version.
    if (new.follow_up, new.covered, new.remaining, new.next_step, new.source_message_ids, new.visibility,
        new.accept_substitute, new.preferred_daee, new.field_sources, new.origin, new.approved_at, new.source_card_ids, new.scope)
       is distinct from
       (old.follow_up, old.covered, old.remaining, old.next_step, old.source_message_ids, old.visibility,
        old.accept_substitute, old.preferred_daee, old.field_sources, old.origin, old.approved_at, old.source_card_ids, old.scope)
       or new.status not in ('approved', 'expired') then
      raise exception 'an approved card is immutable; save a new version';
    end if;
    return new;
  end if;

  if new.status = 'approved' and not service and new.asker_id is distinct from auth.uid() then
    raise exception 'only the asker approves a card';
  end if;
  return new;
end;
$$;
