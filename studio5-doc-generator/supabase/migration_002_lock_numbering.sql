-- ============================================================================
-- Studio5 Document Generator — migration 002: only the backend may number documents.
-- migration_001 created two SECURITY DEFINER functions without revoking EXECUTE, and
-- Postgres grants EXECUTE to everyone by default — so on a fresh project anyone holding
-- the public (anon) key could burn or move document numbers through /rest/v1/rpc.
-- The live studio5-portal project was already locked by hand; this makes it permanent.
-- The backend uses the service_role key, which keeps access.
-- Safe to run again. ROLLBACK: grant execute on both functions to anon, authenticated.
-- ============================================================================
begin;
revoke execute on function public.fn_allocate_document_number(text, text) from public, anon, authenticated;
revoke execute on function public.fn_bump_document_sequence(text, text, int) from public, anon, authenticated;
grant  execute on function public.fn_allocate_document_number(text, text) to service_role;
grant  execute on function public.fn_bump_document_sequence(text, text, int) to service_role;
revoke all on public.doc_number_sequences, public.generated_documents from anon, authenticated;
commit;
