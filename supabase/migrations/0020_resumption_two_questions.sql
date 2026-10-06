-- Correct resumption depends on both questions the daee answers when ending a card-based
-- follow-up: the context was enough to go on without starting over, and the card was
-- accurate. The sample is card follow-ups (manual or AI card) with both questions answered;
-- a resumption is correct when both answers are yes. Before this, only the first counted.
-- Only the resumption block changes from 0011.

create or replace function admin_kpis(p_from timestamptz, p_to timestamptz) returns json
language plpgsql stable security definer set search_path = public as $$
declare
  o uuid := admin_org();
  routed_n bigint; routed_ok bigint;
  resume_n bigint; resume_ok bigint;
  card_n bigint; card_ok bigint;
  master_n bigint; master_ok bigint;
begin
  select count(distinct e.conversation_id),
         count(distinct e.conversation_id) filter (where not exists (
           select 1 from events t where t.org_id = o and t.type = 'transfer_completed' and t.conversation_id = e.conversation_id))
    into routed_n, routed_ok
    from events e
   where e.org_id = o and e.type = 'routed' and e.created_at >= p_from and e.created_at < p_to;

  select count(*),
         count(*) filter (where (meta ->> 'sufficient')::boolean is true and (meta ->> 'card_accurate')::boolean is true)
    into resume_n, resume_ok
    from events
   where org_id = o and type = 'followup_rated' and meta ->> 'mode' in ('manual', 'ai')
     and meta ->> 'sufficient' is not null and meta ->> 'card_accurate' is not null
     and created_at >= p_from and created_at < p_to;

  select count(*), count(*) filter (where (meta ->> 'edited_major')::boolean is false)
    into card_n, card_ok
    from events
   where org_id = o and type = 'card_approved' and created_at >= p_from and created_at < p_to;

  select count(*), count(*) filter (where (meta ->> 'edited_major')::boolean is false)
    into master_n, master_ok
    from events
   where org_id = o and type = 'master_card_approved' and created_at >= p_from and created_at < p_to;

  return json_build_object(
    'correct_first_routing', json_build_object('n', routed_n, 'correct', routed_ok, 'rate', sample_rate(routed_ok, routed_n)),
    'correct_resumption', json_build_object('n', resume_n, 'correct', resume_ok, 'rate', sample_rate(resume_ok, resume_n)),
    'card_accuracy', json_build_object('n', card_n, 'correct', card_ok, 'rate', sample_rate(card_ok, card_n)),
    'master_card_accuracy', json_build_object('n', master_n, 'correct', master_ok, 'rate', sample_rate(master_ok, master_n))
  );
end;
$$;
