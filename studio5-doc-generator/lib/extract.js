// Reads a photo / PDF of a site measurement sheet into line items with Google Gemini.
// Needs the internet and a Gemini key (GEMINI_API_KEY on the server, or the key entered in the app).

const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"];
const MAX_BASE64_CHARS = Math.ceil((10 * 1024 * 1024 * 4) / 3); // ~10 MB file
const MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/models";

function getExtractionPrompt(scopeMode) {
  const isRenovation = scopeMode !== "new_work";
  return `You are an expert quantity surveyor and estimator for Studio5 Interiors (an interior architecture and contracting firm in India).
The attached image or text is a handwritten site measurement sheet, diary note, BOQ list, or contractor quotation.

CRITICAL CONTRACTING RULES & SCOPE IMPROVISATION:
Site notes are written in brief shorthand (e.g. "Ceiling 400 sqft", "Flooring 650 sqft", "Master bed renovation", "2 mirrors 4x3").
You must intelligently IMPROVISE and EXPAND raw shorthand into complete professional contracting line items according to real-world interior execution standards:

${isRenovation ? `
1. RENOVATION & MAJOR WORKS EXPANSION (Area-based in 'sqft' or running length in 'rft'):
   When a note mentions "ceiling", "flooring", "partition", "tile work", or general renovation for an area/room, DO NOT just return a single supply item.
   Break it down into the realistic contracting sequence:
   a) DISMANTLING / DEMOLITION:
      - For ceiling: "Dismantling of existing old false ceiling including framework and hardware safely without damaging structure" (UOM: sqft).
      - For flooring: "Dismantling/hacking of existing floor tiles, skirting and cement mortar bed" (UOM: sqft).
      - For walls/partitions: "Dismantling of existing wall panelling/partition/doors" (UOM: sqft or nos).
   b) DEBRIS CLEARING & CARTING AWAY:
      - "Collecting, lifting, cleaning and carting away all dismantled debris, malba and waste material from site to approved municipal dumping ground" (UOM: sqft or lumpsum).
   c) SURFACE PREPARATION / BASE WORK:
      - For flooring: "Surface preparation and cement mortar leveling screed bed complete" (UOM: sqft).
   d) REBUILDING & NEW FABRICATION:
      - For ceiling: "Providing & fixing new Gypsum board false ceiling with G.I. framing, perimeter channels, joint tape & compound finishing complete" (UOM: sqft).
      - For flooring: "Laying new glazed vitrified tiles / wooden flooring complete with adhesive, spacer and epoxy grouting" (UOM: sqft).
      - If cove is mentioned or standard: "Providing & fixing cove lighting profile detail in Gypsum false ceiling" (UOM: rft).
` : `
1. NEW WORK ONLY:
   Generate direct supply and installation line items with complete technical specifications (without demolition/dismantling steps).
`}

2. DISCRETE GOODS & FIXTURES (strictly in 'nos'):
   Items like mirrors, LED mirrors, vanity units, flush doors, door locks/handles, electrical fixtures, sanitary ware, loose furniture items MUST ALWAYS have UOM as "nos" (numbers) or "set", NEVER sqft or rft.
   - Example: "Supplying & installing 5mm bevelled edge designer mirror / LED backlit mirror with mounting bracket complete" -> UOM: "nos".
   - Example: "Providing & fixing 32mm flush door shutter with laminate finish, teak lipping, hinges & mortise lock" -> UOM: "nos".

3. ACCURATE UNITS (UOM) ENFORCEMENT:
   - Areas (ceilings, flooring, wall panelling, painting, plastering, dismantling) -> "sqft"
   - Running lengths (cove profiles, skirting, pelmet, kitchen counter length, AC copper piping) -> "rft"
   - Discrete fixtures (mirrors, lights, switches, doors, vanity, chairs, basins) -> "nos"
   - General cleaning / bulk debris dumping -> "lumpsum" or "sqft"

4. QUANTITIES & CALCULATIONS:
   - If dimensions are given (e.g. 10x12 or 15*20), compute the area (120, 300) for sqft items.
   - When a ceiling/floor area is given (e.g. 400 sqft), apply the SAME 400 sqft to the Dismantling, Debris, and Rebuilding steps.
   - Rates: Extract rates if written. If missing, leave rate as null.

5. SECTION & ROOM ORGANIZATION:
   Group items into logical sections by room/area (e.g. "Drawing Room", "Master Bedroom", "Kitchen", "Common Area"). If no room is mentioned, use "Main Fit-Out Works".

Respond ONLY in valid JSON matching this schema:
{
  "sections": [
    {
      "section_name": "Master Bedroom",
      "items": [
        {
          "particulars": "Dismantling of existing old false ceiling including framework safely",
          "uom": "sqft",
          "qty": 350,
          "rate": 18
        },
        {
          "particulars": "Collecting and carting away ceiling debris / malba from site",
          "uom": "sqft",
          "qty": 350,
          "rate": 8
        },
        {
          "particulars": "Providing & fixing Gypsum board false ceiling with G.I. channels complete",
          "uom": "sqft",
          "qty": 350,
          "rate": 125
        },
        {
          "particulars": "Supplying & installing 5mm bevelled edge LED backlit mirror complete",
          "uom": "nos",
          "qty": 2,
          "rate": 3500
        }
      ]
    }
  ]
}`;
}


const httpErr = (status, message) => Object.assign(new Error(message), { status });

/** Gemini sometimes wraps JSON in ``` fences or adds text around it. */
function parseModelJson(text) {
  const t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const first = t.indexOf("{"), last = t.lastIndexOf("}");
  if (first < 0 || last < first) throw httpErr(502, "The reading service returned something that is not a list of items. Please try again or type the items.");
  try {
    return JSON.parse(t.slice(first, last + 1));
  } catch {
    throw httpErr(502, "The reading service returned an incomplete answer. Please try again or type the items.");
  }
}

/** Keeps only well-formed sections and items, so odd model output cannot break the page. */
function cleanSections(parsed) {
  const sections = Array.isArray(parsed && parsed.sections) ? parsed.sections : [];
  return {
    sections: sections.slice(0, 50).map((s) => ({
      section_name: String((s && s.section_name) || "Main Fit-Out Works").slice(0, 200),
      items: (Array.isArray(s && s.items) ? s.items : []).slice(0, 300).map((it) => ({
        particulars: String((it && it.particulars) || "").slice(0, 1000),
        uom: String((it && it.uom) || "nos").slice(0, 20),
        qty: Number.isFinite(Number(it && it.qty)) ? Number(it.qty) : 0,
        rate: it && it.rate != null && Number.isFinite(Number(it.rate)) ? Number(it.rate) : null,
      })).filter((it) => it.particulars),
    })).filter((s) => s.items.length),
  };
}

async function extractItems(body, serverKey, fetchImpl = fetch) {
  const apiKey = (typeof body.apiKey === "string" && body.apiKey.trim()) || serverKey;
  if (!apiKey) throw httpErr(400, "A Gemini API key is needed to read photos. Set GEMINI_API_KEY on the server or enter it in the Library tab.");
  const mime = String(body.mimeType || "image/jpeg").toLowerCase();
  if (!ALLOWED_MIME.includes(mime)) throw httpErr(400, "Only photos (JPG, PNG, WEBP, HEIC) and PDFs can be read.");
  const data = String(body.image || "").replace(/^data:[^;]+;base64,/, "");
  if (!data) throw httpErr(400, "No image was sent.");
  if (data.length > MAX_BASE64_CHARS) throw httpErr(413, "The file is too large to read (10 MB at most).");

  const request = {
    contents: [{ parts: [{ inlineData: { mimeType: mime, data } }, { text: getExtractionPrompt(body.scopeMode || "renovation") }] }],
    generationConfig: { responseMimeType: "application/json" },
  };
  let lastStatus = 502;
  for (const model of MODELS) {
    let res;
    try {
      res = await fetchImpl(`${GEMINI}/${model}:generateContent`, {
        method: "POST",
        // The key goes in a header, not the URL, so it never lands in proxy or server logs.
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(request),
      });
    } catch {
      throw httpErr(503, "Could not reach the reading service. Check the internet connection (reading photos needs the internet; typing items works offline).");
    }
    if (res.ok) {
      const out = await res.json();
      const text = out && out.candidates && out.candidates[0] && out.candidates[0].content && out.candidates[0].content.parts && out.candidates[0].content.parts[0] && out.candidates[0].content.parts[0].text;
      if (!text) throw httpErr(502, "The reading service returned no items.");
      return cleanSections(parseModelJson(text));
    }
    lastStatus = res.status;
    console.warn(`[extract-items] ${model} answered ${res.status}`);
    if (res.status === 400 || res.status === 401 || res.status === 403) break; // bad key: no point trying others
  }
  throw httpErr(lastStatus === 401 || lastStatus === 403 || lastStatus === 400 ? 400 : 502,
    lastStatus === 401 || lastStatus === 403 || lastStatus === 400
      ? "The Gemini key was not accepted. Check it in the Library tab."
      : "The reading service is busy or unavailable. Please try again in a minute.");
}

module.exports = { getExtractionPrompt, extractItems, parseModelJson, cleanSections };
