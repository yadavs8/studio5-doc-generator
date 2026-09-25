-- ============================================================================
-- Studio5 Document Generator — number ledger
-- Run this in the SAME Supabase project as studio5-po-tracker (Supabase SQL
-- editor), once. It adds two tables private to the doc-generator backend —
-- they do not touch or rename any of studio5-po-tracker's own tables.
-- ============================================================================

-- One row per (doc_type, scope_key) tracking the next number to hand out.
-- scope_key is 'GLOBAL' for document types that never reset (PO, PI,
-- Challan), or "{addressSeriesCode}:{financialYear}" for Tax Invoice, which
-- resets every financial year per GST's sequential-numbering requirement.
create table if not exists doc_number_sequences (
    doc_type   text not null,
    scope_key  text not null,
    next_seq   int  not null default 1,
    updated_at timestamptz not null default now(),
    primary key (doc_type, scope_key)
);

-- Permanent record of every document ever generated — this is the "gets
-- saved somewhere" ledger. A rejected/void document keeps its number and
-- its reason on record instead of leaving a silent, unexplained gap.
create table if not exists generated_documents (
    id                  uuid primary key default gen_random_uuid(),
    doc_type            text not null check (doc_type in ('po', 'pi', 'invoice', 'challan')),
    doc_number          text not null,
    status              text not null default 'issued' check (status in ('issued', 'void')),
    void_reason         text,
    issuing_address_key text,
    counterparty_name   text,
    total_amount        numeric,
    payload             jsonb not null,
    created_at          timestamptz not null default now(),
    voided_at           timestamptz
);

-- The hard guarantee: the same number can never be issued twice for the
-- same document type, no matter how it got there (auto-allocated or typed
-- in manually).
create unique index if not exists uq_generated_documents_type_number
    on generated_documents (doc_type, doc_number);

create index if not exists idx_generated_documents_type_created
    on generated_documents (doc_type, created_at desc);

-- RLS enabled with NO policies defined: PostgREST's anon/authenticated
-- roles get zero access to either table. Only the service_role key —
-- used exclusively by the doc-generator's Node backend, set as an
-- environment variable on Render, never sent to the browser — can read or
-- write these, since service_role bypasses RLS entirely.
alter table doc_number_sequences enable row level security;
alter table generated_documents  enable row level security;

-- Atomically allocates and returns the next sequence number for a
-- (doc_type, scope_key), creating the row on first use. A single UPDATE
-- ... RETURNING statement is one atomic operation under Postgres row
-- locking, so two concurrent "Generate" clicks can never receive the same
-- number.
create or replace function fn_allocate_document_number(p_doc_type text, p_scope_key text default 'GLOBAL')
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    v_seq int;
begin
    insert into doc_number_sequences (doc_type, scope_key, next_seq)
    values (p_doc_type, p_scope_key, 1)
    on conflict (doc_type, scope_key) do nothing;

    update doc_number_sequences
       set next_seq = next_seq + 1, updated_at = now()
     where doc_type = p_doc_type and scope_key = p_scope_key
    returning next_seq - 1 into v_seq;

    return v_seq;
end;
$$;

-- Self-heals the counter forward when someone types a document number by
-- hand instead of using the auto-allocated one, so the next auto-suggested
-- number can never collide with a manually issued one that was ahead of it.
-- Never moves the counter backwards.
create or replace function fn_bump_document_sequence(p_doc_type text, p_scope_key text, p_at_least int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into doc_number_sequences (doc_type, scope_key, next_seq)
    values (p_doc_type, p_scope_key, p_at_least)
    on conflict (doc_type, scope_key) do update
        set next_seq = greatest(doc_number_sequences.next_seq, excluded.next_seq),
            updated_at = now();
end;
$$;
