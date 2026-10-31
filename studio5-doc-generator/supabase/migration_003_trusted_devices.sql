-- ============================================================================
-- Studio5 Document Generator — migration 003: trusted devices + MPIN.
-- Run AFTER migration_002_issue_flow.sql, in the same Supabase project.
--
-- A device becomes trusted after its user signs in once with an email OTP and
-- sets a 4-digit MPIN. From then on that device unlocks with the MPIN alone.
-- The MPIN only works together with the device's own secret (kept in that
-- browser), so knowing someone's MPIN is useless from another phone.
-- ============================================================================

create table if not exists trusted_devices (
    id                 uuid primary key default gen_random_uuid(),
    user_id            uuid not null,          -- Supabase Auth user (auth.users.id)
    email              text not null,
    device_name        text,
    -- sha256 of the random secret stored in the browser; the secret itself
    -- is shown to the device once and never stored here.
    secret_hash        text not null,
    -- scrypt(MPIN, salt, server pepper). NULL until the MPIN is set.
    pin_hash           text,
    pin_salt           text,
    -- The user's Supabase refresh token, AES-256-GCM encrypted with the
    -- server's DEVICE_TOKEN_KEY, so a copy of this table alone can't be
    -- turned into a sign-in.
    refresh_token_enc  text not null,
    failed_attempts    int  not null default 0,
    locked_at          timestamptz,
    revoked_at         timestamptz,
    revoked_reason     text,
    created_at         timestamptz not null default now(),
    last_used_at       timestamptz
);

create index if not exists idx_trusted_devices_user on trusted_devices (user_id) where revoked_at is null;

-- Counts a wrong MPIN in one atomic step and locks the device on the 5th,
-- so parallel guesses can't slip past the limit. Returns attempts so far.
create or replace function fn_record_pin_failure(p_device_id uuid)
returns int
language sql
set search_path = public
as $$
    update trusted_devices
       set failed_attempts = failed_attempts + 1,
           locked_at = case when failed_attempts + 1 >= 5 then now() else locked_at end
     where id = p_device_id
    returning failed_attempts;
$$;
revoke execute on function fn_record_pin_failure(uuid) from public, anon, authenticated;
grant  execute on function fn_record_pin_failure(uuid) to service_role;

-- RLS on with no policies: only the doc-generator backend (service_role)
-- can read or write this table — same pattern as generated_documents.
alter table trusted_devices enable row level security;
revoke all on trusted_devices from anon, authenticated;
