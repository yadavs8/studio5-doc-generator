const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn(
    "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set — document " +
      "numbering and history will not work until they are configured on Render."
  );
}

// Service-role key: bypasses RLS, used server-side only, never exposed to
// the browser. This is the same pattern studio5-po-tracker's own backend
// uses for its own Supabase project.
const supabase =
  supabaseUrl && supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } })
    : null;

module.exports = supabase;
