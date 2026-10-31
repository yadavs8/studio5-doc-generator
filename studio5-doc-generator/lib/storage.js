const supabase = require("./supabase");

// The po-tracker's private bucket (its migration_002). Files go in under the
// same "<doc type>/..." layout the tracker uses, and document.file_url holds
// the path inside the bucket, so the tracker's own download code
// (createSignedUrl(file_url)) opens files saved from here unchanged.
const BUCKET = "studio5-documents";

const CONTENT_TYPES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

// e.g. pi/<site_id>/26-27-112_r2_k3f9a1.docx — files are never overwritten,
// so every revision stays downloadable. The random tag gives each save
// attempt its own path: if two retries of the same revision race, one
// attempt's clean-up can never delete the file the other one finalized.
function pathFor(docType, siteId, docNumber, revision, ext) {
  const safeNumber = String(docNumber).replace(/[^\w.\-]+/g, "-");
  const tag = require("crypto").randomBytes(3).toString("hex");
  return `${docType}/${siteId}/${safeNumber}_r${revision}_${tag}.${ext}`;
}

async function upload(path, buffer, ext) {
  const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, {
    contentType: CONTENT_TYPES[ext] || "application/octet-stream",
    upsert: false,
  });
  if (error) throw new Error(`Could not save the file to storage: ${error.message}`);
}

// Best effort: used to clean up a file whose database record failed, so a
// retry can upload to the same path. A leftover file is harmless.
async function remove(path) {
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  if (error) console.warn(`[storage] Could not remove ${path}: ${error.message}`);
}

async function signedUrl(path, seconds = 300) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, seconds);
  if (error) throw new Error(`Could not create a download link: ${error.message}`);
  return data.signedUrl;
}

module.exports = { BUCKET, pathFor, upload, remove, signedUrl };
