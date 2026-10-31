-- ============================================================================
-- Studio5 Document Generator — migration 002: draft / final / revise flow,
-- linked to studio5-po-tracker's proforma_invoice + document tables.
-- Run AFTER migration_001_document_ledger.sql, in the SAME Supabase project
-- (the po-tracker's), once, in the SQL editor. It requires the po-tracker's
-- studio5_schema.sql + migration_002..007 to already be applied there.
--
-- Safe to run against the live ledger: existing rows become revision 1 and
-- keep their status; the current backend keeps working unchanged until the
-- new /generate flow (step 1.3) starts calling the functions below.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. LEDGER COLUMNS
-- pending    = number spent, file not yet built/uploaded (retry or void it)
-- issued     = the one live revision of this number
-- superseded = an older revision, kept on record (never deleted)
-- void       = rejected; the number stays on record with its reason
-- ---------------------------------------------------------------------------
alter table generated_documents drop constraint if exists generated_documents_status_check;
alter table generated_documents add constraint generated_documents_status_check
    check (status in ('pending', 'issued', 'superseded', 'void'));

alter table generated_documents
    add column if not exists revision       int  not null default 1 check (revision >= 1),
    add column if not exists supersedes_id  uuid references generated_documents(id),
    add column if not exists site_id        uuid references site(site_id),
    add column if not exists po_id          uuid references purchase_order(po_id),
    add column if not exists pi_id          uuid references proforma_invoice(pi_id),
    add column if not exists storage_path   text,
    add column if not exists created_by     uuid,
    add column if not exists finalized_at   timestamptz,
    add column if not exists superseded_at  timestamptz;

-- ---------------------------------------------------------------------------
-- 2. UNIQUENESS
-- Old rule: one row per (doc_type, doc_number). New rules:
--   * each revision of a number exists once (two simultaneous "Revise" clicks
--     compute the same next revision, so the second one fails here);
--   * at most ONE issued revision per number;
--   * at most ONE pending revision per number (one revise in flight at a time).
-- A voided number still holds revision 1, so it can never be re-issued.
-- ---------------------------------------------------------------------------
drop index if exists uq_generated_documents_type_number;

create unique index if not exists uq_generated_documents_type_number_rev
    on generated_documents (doc_type, doc_number, revision);
create unique index if not exists uq_generated_documents_one_issued
    on generated_documents (doc_type, doc_number) where status = 'issued';
create unique index if not exists uq_generated_documents_one_pending
    on generated_documents (doc_type, doc_number) where status = 'pending';

create index if not exists idx_generated_documents_site
    on generated_documents (site_id, doc_type);

-- ---------------------------------------------------------------------------
-- 3. START A REVISION
-- Locks the live revision and records the next one as pending. The backend
-- then builds + uploads the file and calls fn_finalize_pi.
-- ---------------------------------------------------------------------------
create or replace function fn_begin_revision(
    p_doc_type text, p_doc_number text, p_payload jsonb,
    p_total_amount numeric, p_counterparty_name text,
    p_issuing_address_key text, p_user_id uuid default null
) returns table (ledger_id uuid, revision int)
language plpgsql
set search_path = public
as $$
declare
    v_live generated_documents%rowtype;
    v_next int;
begin
    select * into v_live from generated_documents g
     where g.doc_type = p_doc_type and g.doc_number = trim(p_doc_number) and g.status = 'issued'
     for update;
    if not found then
        raise exception 'There is no issued % numbered "%" to revise.', p_doc_type, p_doc_number;
    end if;

    -- Above every earlier revision, not just the live one: a revision that
    -- failed and was voided keeps its number on record.
    select max(g.revision) + 1 into v_next from generated_documents g
     where g.doc_type = v_live.doc_type and g.doc_number = v_live.doc_number;

    return query
    insert into generated_documents (doc_type, doc_number, status, revision, supersedes_id,
                                     issuing_address_key, counterparty_name, total_amount,
                                     payload, site_id, po_id, pi_id, created_by)
    values (v_live.doc_type, v_live.doc_number, 'pending', v_next, v_live.id,
            coalesce(p_issuing_address_key, v_live.issuing_address_key),
            coalesce(p_counterparty_name, v_live.counterparty_name),
            p_total_amount, p_payload, v_live.site_id, v_live.po_id, v_live.pi_id, p_user_id)
    returning generated_documents.id, generated_documents.revision;
end $$;

-- ---------------------------------------------------------------------------
-- 4. FINALIZE A PI — the all-or-nothing step
-- After the file is uploaded to storage, in one transaction:
--   * record the file in the tracker's document table;
--   * new number  -> create the tracker's proforma_invoice row (or link the
--                    one already typed into the tracker by hand, same
--                    number + site);
--     revision    -> update that proforma_invoice row to the new amount/date/file;
--   * old revision -> superseded, this one -> issued.
-- If anything fails, nothing changes and the ledger row stays pending.
-- ---------------------------------------------------------------------------
create or replace function fn_finalize_pi(
    p_ledger_id uuid, p_site_id uuid, p_po_id uuid, p_sub_project_id uuid,
    p_pi_date date, p_amount numeric, p_remarks text,
    p_storage_path text, p_user_id uuid default null
) returns uuid
language plpgsql
set search_path = public
as $$
declare
    v_row    generated_documents%rowtype;
    v_old    generated_documents%rowtype;
    v_pi     proforma_invoice%rowtype;
    v_doc_id uuid;
    v_pi_id  uuid;
begin
    -- The po-tracker's audit trigger records auth.uid(); the backend calls
    -- this with the service-role key, so pass the signed-in user through.
    if p_user_id is not null then
        perform set_config('request.jwt.claim.sub', p_user_id::text, true);
    end if;

    select * into v_row from generated_documents where id = p_ledger_id for update;
    if not found then raise exception 'Ledger entry % does not exist.', p_ledger_id; end if;
    if v_row.doc_type <> 'pi' then raise exception 'Ledger entry % is a %, not a PI.', p_ledger_id, v_row.doc_type; end if;
    if v_row.status <> 'pending' then
        raise exception 'PI % (revision %) is already %, so it cannot be finalized again.', v_row.doc_number, v_row.revision, v_row.status;
    end if;
    if p_storage_path is null or btrim(p_storage_path) = '' then
        raise exception 'The PI file has not been uploaded yet (no storage path).';
    end if;

    insert into document (file_url, document_type, uploaded_by)
    values (p_storage_path, 'pi', p_user_id)
    returning document_id into v_doc_id;

    if v_row.supersedes_id is not null then
        select * into v_old from generated_documents where id = v_row.supersedes_id for update;
        if v_old.status <> 'issued' then
            raise exception 'The revision this replaces (PI % revision %) is no longer the live one.', v_old.doc_number, v_old.revision;
        end if;
        v_pi_id := v_old.pi_id;
    end if;

    -- Not linked yet (a brand-new number, or a revision of a PI issued before
    -- this migration): look for one typed into the tracker by hand.
    if v_pi_id is null then
        select pi_id into v_pi_id from proforma_invoice
         where site_id = p_site_id and pi_number = v_row.doc_number;
    end if;

    if v_pi_id is null then
        insert into proforma_invoice (site_id, sub_project_id, po_id, pi_number, pi_date,
                                      amount, submitted_date, remarks, status, document_id)
        values (p_site_id, p_sub_project_id, p_po_id, v_row.doc_number, p_pi_date,
                p_amount, p_pi_date, nullif(btrim(p_remarks), ''), 'sent', v_doc_id)
        returning pi_id into v_pi_id;
    else
        select * into v_pi from proforma_invoice where pi_id = v_pi_id for update;
        if v_pi.site_id <> p_site_id then
            raise exception 'PI % belongs to a different site in the tracker.', v_row.doc_number;
        end if;
        if v_pi.status = 'converted_to_invoice' then
            raise exception 'PI % has already been converted to a tax invoice, so it cannot be revised. Raise a credit/debit note instead.', v_row.doc_number;
        end if;
        update proforma_invoice
           set po_id          = coalesce(p_po_id, po_id),
               sub_project_id = coalesce(p_sub_project_id, sub_project_id),
               pi_date        = p_pi_date,
               amount         = p_amount,
               remarks        = coalesce(nullif(btrim(p_remarks), ''), remarks),
               status         = 'sent',
               document_id    = v_doc_id,
               updated_at     = now()
         where pi_id = v_pi_id;
    end if;

    -- Old revision must leave 'issued' before the new one enters it
    -- (uq_generated_documents_one_issued).
    if v_row.supersedes_id is not null then
        update generated_documents set status = 'superseded', superseded_at = now()
         where id = v_row.supersedes_id;
    end if;

    update generated_documents
       set status       = 'issued',
           site_id      = p_site_id,
           po_id        = p_po_id,
           pi_id        = v_pi_id,
           storage_path = p_storage_path,
           total_amount = p_amount,
           finalized_at = now()
     where id = p_ledger_id;

    return v_pi_id;
end $$;

-- ---------------------------------------------------------------------------
-- 5. ABANDON A PENDING ENTRY
-- When building/uploading the file failed and won't be retried. A pending
-- revision is voided and the live revision stays untouched; a pending new
-- number is voided so the gap is explained on record.
-- ---------------------------------------------------------------------------
create or replace function fn_abandon_pending(p_ledger_id uuid, p_reason text)
returns void
language plpgsql
set search_path = public
as $$
begin
    update generated_documents
       set status = 'void', void_reason = coalesce(nullif(btrim(p_reason), ''), 'Generation failed'), voided_at = now()
     where id = p_ledger_id and status = 'pending';
    if not found then raise exception 'No pending ledger entry %.', p_ledger_id; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. PERMISSIONS
-- Only the doc-generator backend (service_role) may call these. This also
-- closes a gap from migration 001: its two functions are SECURITY DEFINER and
-- were executable by anon — anyone holding the po-tracker's public
-- publishable key could have spent document numbers.
-- ---------------------------------------------------------------------------
revoke execute on function fn_allocate_document_number(text, text)     from public, anon, authenticated;
revoke execute on function fn_bump_document_sequence(text, text, int)  from public, anon, authenticated;
revoke execute on function fn_begin_revision(text, text, jsonb, numeric, text, text, uuid)                  from public, anon, authenticated;
revoke execute on function fn_finalize_pi(uuid, uuid, uuid, uuid, date, numeric, text, text, uuid)           from public, anon, authenticated;
revoke execute on function fn_abandon_pending(uuid, text)                                                     from public, anon, authenticated;
grant  execute on function fn_allocate_document_number(text, text)     to service_role;
grant  execute on function fn_bump_document_sequence(text, text, int)  to service_role;
grant  execute on function fn_begin_revision(text, text, jsonb, numeric, text, text, uuid)                  to service_role;
grant  execute on function fn_finalize_pi(uuid, uuid, uuid, uuid, date, numeric, text, text, uuid)           to service_role;
grant  execute on function fn_abandon_pending(uuid, text)                                                     to service_role;
