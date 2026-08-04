// ===========================================================================
// READING A RECEIPT
//
// A photo of a receipt is turned into text by Tesseract, and the text is turned
// into an amount, a date and a vendor here. The reading is the easy half. The
// hard half is that a receipt is not a form: the total is somewhere near the
// bottom, the date is in whatever format the register felt like, and half the
// page is item lines nobody wants typed in.
//
// Everything below the engine is a pure function of a string, so it can be
// tested against real receipt text without a photo or a network.
// ===========================================================================

// Two decimal places is what separates money from a phone number, a quantity or
// an item code, so it is required. A comma is accepted as a decimal point
// because OCR mistakes one for the other constantly.
const MONEY_RE = /(?:^|[^\d.,])\$?\s?(\d{1,3}(?:,\d{3})+|\d+)[.,](\d{2})(?![\d])/g;

// Lines that carry a number which is emphatically not what was paid.
const NOT_TOTAL = /\b(sub\s?-?\s?total|tax|change|cash|tender|savings?|discount|coupon|balance forward|acct|account|card|auth|approval|ref|invoice\s*#|order\s*#)\b/i;
const IS_TOTAL = /\b(total|amount due|balance due|total due|grand total|amount paid|charged?)\b/i;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Vendor guesses that are really the receipt talking about itself.
const NOT_VENDOR = /^(receipt|sales? receipt|invoice|customer copy|merchant copy|duplicate|thank you|welcome|order|store|reg|lane|register|tel|phone|fax|date|time|cashier|server|table)\b/i;

// Ordered most specific first, because a lumber yard sells paint and a big-box
// store sells everything. The generic names have to lose to the specific ones.
const CATEGORY_HINTS = [
  [/\b(dumpster|hauling|haul away|debris|demolition|demo|disposal|landfill|junk removal)\b/i, "Demolition & Debris"],
  [/\b(permit|inspection|building dept|county of|city of|zoning|impact fee)\b/i, "Permits & Inspections"],
  [/\b(roof|shingle|gutter|soffit|fascia|siding|stucco)\b/i, "Roofing & Exterior"],
  [/\b(window|windows|door|doors|andersen|pella|jeld|milgard)\b/i, "Windows & Doors"],
  [/\b(electric|electrical|plumb|plumbing|hvac|a\/c|air condition|furnace|ferguson|water heater|ductwork)\b/i, "MEP — Mechanical, Electrical, Plumbing"],
  [/\b(drywall|sheetrock|insulation|joint compound|blown in)\b/i, "Insulation & Drywall"],
  [/\b(cabinet|vanity|countertop|counter top|granite|quartz|appliance|kitchen|bath|shower|toilet)\b/i, "Kitchen & Bath"],
  [/\b(floor|flooring|tile|carpet|laminate|hardwood|lvp|vinyl plank)\b/i, "Flooring"],
  [/\b(paint|sherwin|behr|benjamin moore|primer|trim|molding|moulding|baseboard|casing)\b/i, "Interior Finishes"],
  [/\b(landscap|lawn|mulch|sod|nursery|garden|tree|irrigation|sprinkler)\b/i, "Landscaping & Curb Appeal"],
  [/\b(lumber|framing|truss|joist|stud|plywood|osb|2x4|2 x 4)\b/i, "Framing & Structural"],
  [/\b(insurance|premium|property tax|escrow|interest|utility|utilities|power co|water dept|electric co)\b/i, "Utilities, Insurance, Taxes & Loan"],
  [/\b(title|closing|attorney|realtor|commission|mls|staging|escrow co)\b/i, "Sale & Disposition Costs"],
  [/\b(home depot|lowe|menards|ace hardware|hardware|building supply|supply co|84 lumber)\b/i, "General Construction"],
];

function ocrLines(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);
}

// Every money-shaped number on one line, left to right.
function moneyOn(line) {
  const out = [];
  MONEY_RE.lastIndex = 0;
  let m;
  while ((m = MONEY_RE.exec(line))) {
    const value = Number(m[1].replace(/,/g, "") + "." + m[2]);
    if (Number.isFinite(value)) out.push(value);
  }
  return out;
}

// The total is looked for from the bottom up, because that is where it lives and
// because a receipt often says "total" once in a header and once for real.
function findAmount(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!IS_TOTAL.test(line) || NOT_TOTAL.test(line)) continue;
    const here = moneyOn(line);
    if (here.length) return here[here.length - 1];
    // "TOTAL" on its own line, the number underneath it.
    const next = lines[i + 1] ? moneyOn(lines[i + 1]) : [];
    if (next.length) return next[next.length - 1];
  }

  // No total anywhere. A subtotal is the next best thing.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/\bsub\s?-?\s?total\b/i.test(lines[i])) continue;
    const here = moneyOn(lines[i]);
    if (here.length) return here[here.length - 1];
  }

  // Otherwise the biggest number on the page, which on a receipt is almost
  // always the thing that was paid.
  let best = null;
  for (const line of lines) {
    if (NOT_TOTAL.test(line)) continue;
    for (const v of moneyOn(line)) if (best === null || v > best) best = v;
  }
  return best;
}

function validDate(y, m, d) {
  if (!(y >= 2000 && y <= new Date().getFullYear() + 1)) return null;
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return String(y) + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}

function findDate(lines) {
  for (const line of lines) {
    let m;

    // Already the way we want it.
    if ((m = line.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/))) {
      const iso = validDate(+m[1], +m[2], +m[3]);
      if (iso) return iso;
    }

    // 7/14/26, 07-14-2026, 14.07.2026. American order is assumed unless the
    // first number cannot be a month.
    if ((m = line.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/))) {
      let year = +m[3];
      if (year < 100) year += 2000;
      const a = +m[1], b = +m[2];
      const iso = a > 12 ? validDate(year, b, a) : validDate(year, a, b);
      if (iso) return iso;
    }

    // Jul 14, 2026
    if ((m = line.match(/\b([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/i))) {
      const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
      if (mi > -1) {
        const iso = validDate(+m[3], mi + 1, +m[2]);
        if (iso) return iso;
      }
    }

    // 14 Jul 2026
    if ((m = line.match(/\b(\d{1,2})\s+([a-z]{3,9})\.?\s+(\d{4})\b/i))) {
      const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
      if (mi > -1) {
        const iso = validDate(+m[3], mi + 1, +m[1]);
        if (iso) return iso;
      }
    }
  }
  return null;
}

// A shop shouts its name at the top of the receipt, above the address and the
// phone number, so only the first few lines are considered.
function findVendor(lines) {
  for (const raw of lines.slice(0, 6)) {
    const line = raw.replace(/^[^a-z0-9]+|[^a-z0-9)]+$/gi, "").trim();
    if (line.length < 3 || line.length > 42) continue;
    if (NOT_VENDOR.test(line)) continue;
    if (/https?:|www\.|\.com|@/i.test(line)) continue;
    if (/\d{3}[-.\s)]\s?\d{3}[-.\s]\d{4}/.test(line)) continue;   // phone
    if (/\b[A-Z]{2}\s+\d{5}(-\d{4})?\b/.test(line)) continue;      // city, ST 12345
    if (/^\d+\s+[a-z]/i.test(line)) continue;                      // street address
    const letters = (line.match(/[a-z]/gi) || []).length;
    if (letters < 3 || letters < line.length / 2) continue;
    return tidyVendor(line);
  }
  return null;
}

// Receipts are printed in capitals. Left alone it looks like the app is
// shouting, so a name that is all caps gets sentence case back.
function tidyVendor(name) {
  if (!/[a-z]/.test(name)) {
    return name
      .toLowerCase()
      .replace(/\b[a-z]/g, (c) => c.toUpperCase())
      .replace(/\b(Llc|Inc|Co|Ltd|Llp|Pa|Usa|Hvac|Mep)\b/g, (w) => w.toUpperCase());
  }
  return name;
}

// The vendor's name is the strongest signal, so it is asked first. The rest of
// the page is a fallback, and a noisy one.
function guessCategory(vendor, text) {
  for (const [re, category] of CATEGORY_HINTS) if (vendor && re.test(vendor)) return category;
  for (const [re, category] of CATEGORY_HINTS) if (re.test(text || "")) return category;
  return null;
}

// Matching a vendor to somebody already in the directory, so the 1099 total
// keeps adding up without anybody choosing from a list on a phone.
function matchContractor(vendor, list) {
  if (!vendor) return null;
  const norm = (s) => String(s || "").toLowerCase().replace(/\b(llc|inc|co|ltd|corp|company)\b/g, "").replace(/[^a-z0-9]/g, "");
  const want = norm(vendor);
  if (want.length < 4) return null;
  for (const c of list || []) {
    for (const field of [c.company, c.name]) {
      const have = norm(field);
      if (have.length < 4) continue;
      if (have === want || have.includes(want) || want.includes(have)) return c.id;
    }
  }
  return null;
}

function parseReceipt(text) {
  const lines = ocrLines(text);
  const vendor = findVendor(lines);
  return {
    amount: findAmount(lines),
    date: findDate(lines),
    vendor,
    category: guessCategory(vendor, String(text || "")),
    lines: lines.length,
  };
}

// ===========================================================================
// The engine itself, which is 2 MB of WebAssembly and is therefore never
// downloaded until somebody actually asks to read a photo.
// ===========================================================================
const Ocr = {
  SOURCE: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js",
  loading: null,

  ready() {
    return typeof window !== "undefined" && !!window.Tesseract;
  },

  load() {
    if (this.ready()) return Promise.resolve(window.Tesseract);
    if (this.loading) return this.loading;
    this.loading = new Promise((resolve, reject) => {
      const tag = document.createElement("script");
      tag.src = this.SOURCE;
      tag.async = true;
      tag.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error("The reader loaded but did not start.")));
      tag.onerror = () => {
        this.loading = null;
        reject(new Error("Could not download the reader."));
      };
      document.head.appendChild(tag);
    });
    return this.loading;
  },

  // onProgress is called with a whole number 0-100 so the button can say
  // something truthful while a phone chews through a photo.
  async read(blob, onProgress) {
    const T = await this.load();
    const worker = await T.createWorker("eng", 1, {
      logger: (m) => {
        if (onProgress && m && m.status === "recognizing text") {
          onProgress(Math.round((m.progress || 0) * 100));
        }
      },
    });
    try {
      const result = await worker.recognize(blob);
      return { text: result.data.text || "", confidence: result.data.confidence || 0 };
    } finally {
      await worker.terminate();
    }
  },

  async scan(blob, onProgress) {
    const read = await this.read(blob, onProgress);
    const found = parseReceipt(read.text);
    found.confidence = read.confidence;
    found.text = read.text;
    return found;
  },
};
