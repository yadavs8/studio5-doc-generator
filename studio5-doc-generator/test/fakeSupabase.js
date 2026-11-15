// A tiny in-memory stand-in for the two ledger tables and the two numbering functions.
function fakeSupabase() {
  const db = { doc_number_sequences: [], generated_documents: [] };
  const state = { offline: false };
  // What supabase-js returns when there is no internet: an error object, not a throw.
  const NET = { data: null, error: { message: "TypeError: fetch failed", details: "getaddrinfo ENOTFOUND" } };
  function query(table) {
    let rows = () => db[table];
    const filters = [];
    let op = "select", values = null, orderDesc = false, limitN = null;
    const api = {
      select() { return api; },
      eq(col, val) { filters.push((r) => r[col] === val); return api; },
      order(col, o) { orderDesc = !(o && o.ascending); return api; },
      limit(n) { limitN = n; return api; },
      insert(v) { op = "insert"; values = v; return api; },
      update(v) { op = "update"; values = v; return api; },
      async maybeSingle() { const r = await run(); return { data: r.data ? r.data[0] || null : null, error: r.error }; },
      then(res, rej) { return run().then(res, rej); },
    };
    async function run() {
      if (state.offline) return NET;
      if (op === "insert") {
        if (table === "generated_documents" && db[table].some((r) => r.doc_type === values.doc_type && r.doc_number === values.doc_number)) {
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        db[table].push({ id: String(db[table].length + 1), created_at: new Date().toISOString(), ...values });
        return { data: [values], error: null };
      }
      let out = rows().filter((r) => filters.every((f) => f(r)));
      if (op === "update") { out.forEach((r) => Object.assign(r, values)); return { data: out, error: null }; }
      if (orderDesc) out = [...out].reverse();
      if (limitN) out = out.slice(0, limitN);
      return { data: out, error: null };
    }
    return api;
  }
  return {
    db,
    from: query,
    state,
    async rpc(name, args) {
      if (state.offline) return NET;
      const seqs = db.doc_number_sequences;
      let row = seqs.find((r) => r.doc_type === args.p_doc_type && r.scope_key === args.p_scope_key);
      if (name === "fn_allocate_document_number") {
        if (!row) { row = { doc_type: args.p_doc_type, scope_key: args.p_scope_key, next_seq: 1 }; seqs.push(row); }
        row.next_seq += 1;
        return { data: row.next_seq - 1, error: null };
      }
      if (name === "fn_bump_document_sequence") {
        if (!row) seqs.push({ doc_type: args.p_doc_type, scope_key: args.p_scope_key, next_seq: args.p_at_least });
        else row.next_seq = Math.max(row.next_seq, args.p_at_least);
        return { data: null, error: null };
      }
      return { data: null, error: { message: "unknown rpc" } };
    },
  };
}
module.exports = { fakeSupabase };
