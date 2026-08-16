// Fills a demo account with five deals that between them show every state the
// app can be in: cash and financed, pre-closing through sold, on budget and
// badly over, a schedule running to plan and one that slipped.
//
//   node tools/seed-demo.js
//   node tools/seed-demo.js --email demo@flipsmart.app --password "..."
//
// Talks to Supabase over plain REST with the anon key, signed in as the demo
// user, so row level security applies exactly as it would in the browser. It
// is safe to run twice: everything the demo user owns is removed first.
//
// Requires Node 18 or newer for fetch.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { receiptPdf, altaPdf, simpleDocPdf, receiptPhoto, usd } = require("./demo-files.js");

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const ROOT = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i > -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const EMAIL = arg("email", "demo@flipsmart.app");
const PASSWORD = arg("password", "FlipSmartDemo2026!");

const cfg = fs.readFileSync(path.join(ROOT, "config.js"), "utf8");
const URL_ = (cfg.match(/url:\s*"([^"]+)"/) || [])[1];
const ANON = (cfg.match(/anonKey:\s*"([^"]+)"/) || [])[1];
if (!URL_ || !ANON) {
  console.error("Could not read the Supabase url and anon key out of config.js.");
  process.exit(1);
}

const id = () => crypto.randomUUID();
let TOKEN = null;
let USER = null;

function headers(extra) {
  return Object.assign(
    { apikey: ANON, Authorization: "Bearer " + (TOKEN || ANON) },
    extra || {}
  );
}

async function rest(method, pathname, body, prefer) {
  const res = await fetch(URL_ + "/rest/v1/" + pathname, {
    method,
    headers: headers({
      "Content-Type": "application/json",
      Prefer: prefer || "return=representation",
    }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(method + " " + pathname + " -> " + res.status + " " + text);
  return text ? JSON.parse(text) : null;
}

async function upload(bucket, objectPath, buffer, contentType) {
  const res = await fetch(
    URL_ + "/storage/v1/object/" + bucket + "/" + objectPath,
    {
      method: "POST",
      headers: headers({ "Content-Type": contentType, "x-upsert": "true" }),
      body: buffer,
    }
  );
  if (!res.ok) throw new Error("upload " + objectPath + " -> " + res.status + " " + (await res.text()));
  return objectPath;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
async function signIn() {
  const login = async () => {
    const res = await fetch(URL_ + "/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    return { ok: res.ok, data: await res.json() };
  };

  let out = await login();
  if (!out.ok) {
    const res = await fetch(URL_ + "/auth/v1/signup", {
      method: "POST",
      headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error("Could not create the demo account: " + JSON.stringify(data));
    if (!data.access_token) {
      throw new Error(
        "The account was created but Supabase wants the email confirmed first.\n" +
          "Turn off Authentication -> Providers -> Email -> Confirm email, then run this again."
      );
    }
    console.log("  created the account");
    out = await login();
    if (!out.ok) throw new Error("Signed up but could not sign in: " + JSON.stringify(out.data));
  }
  TOKEN = out.data.access_token;
  USER = out.data.user;
  console.log("  signed in as " + USER.email);
}

// ---------------------------------------------------------------------------
// Clearing a previous run
// ---------------------------------------------------------------------------
async function listFolder(bucket, prefix) {
  const res = await fetch(URL_ + "/storage/v1/object/list/" + bucket, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ prefix, limit: 200, offset: 0 }),
  });
  if (!res.ok) return [];
  return res.json();
}

// Storage has no foreign keys, so deleting the project row leaves the files
// behind. Walk the folders and take them with it.
async function emptyFolder(bucket, prefix) {
  const entries = await listFolder(bucket, prefix);
  const files = [];
  for (const e of entries) {
    const child = prefix ? prefix + "/" + e.name : e.name;
    if (e.id === null || e.metadata === null) files.push(...(await emptyFolder(bucket, child)));
    else files.push(child);
  }
  if (!prefix.includes("/") && files.length) {
    await fetch(URL_ + "/storage/v1/object/" + bucket, {
      method: "DELETE",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ prefixes: files }),
    });
  }
  return files;
}

async function wipe() {
  const projects = await rest("GET", "projects?select=id,name");
  for (const p of projects) {
    await emptyFolder("receipts", p.id);
    await emptyFolder("documents", p.id);
    await rest("DELETE", "projects?id=eq." + p.id, undefined, "return=minimal");
  }
  await rest("DELETE", "contractors?owner_id=eq." + USER.id, undefined, "return=minimal");
  if (projects.length) console.log("  cleared " + projects.length + " project(s) from a previous run");
}

// ---------------------------------------------------------------------------
// The demo data
// ---------------------------------------------------------------------------
const CONTRACTORS = [
  { key: "framing", name: "Ridgeline Framing", company: "Ridgeline Framing LLC", trade: "Framing & structural", phone: "(555) 204-8871", email: "office@ridgelineframing.com", w9OnFile: true, taxIdLast4: "4471", coiExpires: "2027-02-11", licenseNumber: "GC-118204", licenseExpires: "2027-05-30" },
  // Deliberately about to lapse: the dashboard should be shouting about this.
  { key: "electric", name: "Vega Electric", company: "Vega Electric Inc", trade: "Electrical", phone: "(555) 661-2210", email: "dispatch@vegaelectric.com", w9OnFile: true, taxIdLast4: "9012", coiExpires: "2026-08-25", licenseNumber: "EC-44120", licenseExpires: "2027-01-15" },
  // No W-9, and over the 1099 threshold. Chase it before January.
  { key: "tile", name: "Cedar Tile Co", company: "Cedar Tile Company", trade: "Tile & stone", phone: "(555) 903-4412", email: "hello@cedartile.co", w9OnFile: false, coiExpires: "2027-04-02", licenseNumber: "SC-20918", licenseExpires: "2026-11-30" },
  { key: "plumbing", name: "Nova Plumbing", company: "Nova Plumbing & Heating", trade: "Plumbing", phone: "(555) 448-7712", email: "service@novaplumbing.com", w9OnFile: true, taxIdLast4: "3388", coiExpires: "2026-12-01", licenseNumber: "MP-77140", licenseExpires: "2027-03-22" },
  // Already expired.
  { key: "haul", name: "Handy Haul", company: "Handy Haul Services", trade: "Hauling & debris", phone: "(555) 118-6640", email: "book@handyhaul.com", w9OnFile: true, taxIdLast4: "1120", coiExpires: "2026-05-02", licenseNumber: "", licenseExpires: "" },
  { key: "roof", name: "Sterling Roofing", company: "Sterling Roofing LLC", trade: "Roofing", phone: "(555) 772-3390", email: "quotes@sterlingroof.com", w9OnFile: true, taxIdLast4: "5502", coiExpires: "2027-03-19", licenseNumber: "RC-31288", licenseExpires: "2027-08-04" },
  { key: "hvac", name: "Apex HVAC", company: "Apex Climate Systems", trade: "HVAC", phone: "(555) 330-9987", email: "info@apexhvac.com", w9OnFile: true, taxIdLast4: "7741", coiExpires: "2027-01-08", licenseNumber: "MC-90211", licenseExpires: "2027-06-17" },
  { key: "paint", name: "Halcyon Painting", company: "Halcyon Painting Co", trade: "Painting & finishes", phone: "(555) 615-2204", email: "crew@halcyonpainting.com", w9OnFile: true, taxIdLast4: "6613", coiExpires: "2027-05-25", licenseNumber: "", licenseExpires: "" },
];

const CATS = {
  closing: "Closing & Deal Costs",
  permits: "Permits & Inspections",
  demo: "Demolition & Debris",
  framing: "Framing & Structural",
  roof: "Roofing & Exterior",
  windows: "Windows & Doors",
  mep: "MEP \u2014 Mechanical, Electrical, Plumbing",
  drywall: "Insulation & Drywall",
  kitchen: "Kitchen & Bath",
  interior: "Interior Finishes",
  floor: "Flooring",
  land: "Landscaping & Curb Appeal",
  general: "General Construction",
  misc: "Contingency & Misc",
  hold: "Utilities, Insurance, Taxes & Loan",
  sell: "Sale & Disposition Costs",
};

// Every project starts from the standard rehab, in build order.
const PHASES = [
  ["Permits & approvals", 14, CATS.permits, null],
  ["Demolition", 8, CATS.demo, "haul"],
  ["Framing & structural", 18, CATS.framing, "framing"],
  ["Roof & exterior", 12, CATS.roof, "roof"],
  ["Windows & doors", 6, CATS.windows, null],
  ["Rough-in MEP", 16, CATS.mep, "electric"],
  ["Insulation & drywall", 14, CATS.drywall, null],
  ["Kitchen & bath", 20, CATS.kitchen, "tile"],
  ["Interior finishes", 15, CATS.interior, "paint"],
  ["Flooring", 9, CATS.floor, null],
  ["Landscaping & curb appeal", 7, CATS.land, null],
  ["Final inspection", 4, CATS.permits, null],
];
// Each phase waits on the one before it, except the two that can run alongside.
const PHASE_DEPS = [[], [0], [1], [2], [2], [2], [5], [6], [7], [8], [3], [9]];

const day = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const plus = (dateStr, days) => iso(new Date(dateStr).getTime() + days * day);

const PROJECTS = [
  // ---------------------------------------------------------------- 1 of 5
  {
    name: "88 Larkspur Lane",
    address: "88 Larkspur Lane, Springfield",
    status: "before_closing",
    funding: "cash",
    borrower: "Larkspur Holdings LLC",
    settlementDate: "2026-09-04",
    purchasePrice: 168000,
    varianceThreshold: 10,
    prefAnnualPct: 0,
    notes: "Under contract. Estate sale, 3/1 ranch, needs everything. Cash deal, no lender.",
    partners: [["Dana Reyes", 60], ["Marcus Tate", 40]],
    budget: { [CATS.closing]: 9000, [CATS.demo]: 9000, [CATS.kitchen]: 26000, [CATS.mep]: 24000, [CATS.floor]: 12000, [CATS.interior]: 15000 },
    expenses: [
      ["2026-07-28", CATS.closing, "Fees", "Earnest money deposit \u2014 Keystone Title", 5000, 0, null, null],
      ["2026-08-03", CATS.permits, "Fees", "Whole-house inspection \u2014 Beacon Home Inspections", 675, 0, null, "pdf"],
      ["2026-08-05", CATS.permits, "Fees", "Appraisal \u2014 Corbin Valuation", 550, 1, null, "photo"],
      ["2026-08-11", CATS.closing, "Fees", "Title search & lien report", 385, 0, null, "pdf"],
    ],
    // Nothing has started: the whole schedule sits after settlement.
    schedule: { start: "2026-09-08", done: -1, running: -1, late: [] },
    draws: [],
    docs: [
      { kind: "Purchase Contract", name: "Purchase contract \u2014 88 Larkspur Lane.pdf", build: "contract" },
      { kind: "Inspection & Appraisal", name: "Inspection report \u2014 Beacon.pdf", build: "inspection" },
    ],
  },

  // ---------------------------------------------------------------- 2 of 5
  {
    name: "19 Grove Court",
    address: "19 Grove Court, Springfield",
    status: "closed",
    funding: "financed",
    borrower: "Grove Court Partners LLC",
    lender: "Meridian Capital Partners",
    settlementDate: "2026-08-03",
    purchasePrice: 240000,
    loanAmount: 195000,
    loanHoldback: 45000,
    varianceThreshold: 10,
    prefAnnualPct: 6,
    notes: "Closed two weeks ago. Demo crew starts Monday. Permits already filed.",
    partners: [["Dana Reyes", 55], ["Marcus Tate", 45]],
    budget: { [CATS.closing]: 115000, [CATS.permits]: 6000, [CATS.demo]: 14000, [CATS.framing]: 38000, [CATS.roof]: 26000, [CATS.mep]: 52000, [CATS.drywall]: 24000, [CATS.kitchen]: 46000, [CATS.interior]: 28000, [CATS.floor]: 19000, [CATS.hold]: 16000 },
    expenses: [
      // All-in counts partner cash plus the loan principal funded at closing,
      // so the cash actually wired at settlement has to be in the ledger.
      ["2026-08-03", CATS.closing, "Fees", "Cash to close at settlement", 90000, 0, null, null],
      ["2026-08-03", CATS.closing, "Fees", "Settlement charges \u2014 Keystone Title & Escrow", 14820, 0, null, "pdf"],
      ["2026-08-03", CATS.closing, "Fees", "Lender origination fee 1.5%", 2925, 0, null, null],
      ["2026-08-04", CATS.hold, "Fees", "Builder's risk insurance \u2014 12 months", 3180, 1, null, "pdf"],
      ["2026-08-06", CATS.hold, "Fees", "Utility reconnection deposits", 640, 1, null, "photo"],
      ["2026-08-10", CATS.permits, "Fees", "Building permit \u2014 full gut rehab", 2240, 0, null, "pdf"],
      ["2026-08-12", CATS.demo, "Services", "Roll-off dumpster \u2014 first two", 1900, 0, "haul", "photo"],
      ["2026-08-14", CATS.misc, "Materials", "Site security, locks & lockbox", 415, 1, null, "photo"],
    ],
    schedule: { start: "2026-08-24", done: -1, running: -1, late: [] },
    draws: [],
    docs: [
      { kind: "ALTA / Settlement Statement", name: "ALTA settlement \u2014 19 Grove Court.pdf", build: "alta" },
      { kind: "Loan Documents", name: "Construction loan terms \u2014 Meridian.pdf", build: "loan" },
      { kind: "Permits", name: "Building permit BP-2026-4471.pdf", build: "permit" },
    ],
  },

  // ---------------------------------------------------------------- 3 of 5
  {
    name: "42 Maple Street",
    address: "42 Maple Street, Springfield",
    status: "in_progress",
    funding: "financed",
    borrower: "Larkspur Holdings LLC",
    lender: "Meridian Capital Partners",
    settlementDate: "2026-03-14",
    purchasePrice: 285000,
    loanAmount: 300000,
    loanHoldback: 60000,
    salePrice: 565000,
    varianceThreshold: 10,
    prefAnnualPct: 8,
    notes: "Rough-in MEP is running late and it is on the critical path. Everything else is holding.",
    partners: [["Dana Reyes", 55], ["Marcus Tate", 30], ["Ivy Holdings", 15]],
    budget: { [CATS.closing]: 72000, [CATS.permits]: 7000, [CATS.demo]: 20000, [CATS.framing]: 46000, [CATS.roof]: 34000, [CATS.windows]: 18000, [CATS.mep]: 62000, [CATS.drywall]: 30000, [CATS.kitchen]: 75000, [CATS.interior]: 40000, [CATS.floor]: 22000, [CATS.land]: 12000, [CATS.hold]: 24000 },
    expenses: [
      ["2026-03-14", CATS.closing, "Fees", "Cash to close at settlement", 45000, 0, null, null],
      ["2026-03-14", CATS.closing, "Fees", "Settlement charges \u2014 Keystone Title & Escrow", 18626, 0, null, "pdf"],
      ["2026-03-14", CATS.closing, "Fees", "Loan origination fee 1.5%", 4500, 0, null, null],
      ["2026-04-02", CATS.permits, "Fees", "Building & electrical permits", 3180, 0, null, "pdf"],
      ["2026-06-28", CATS.hold, "Fees", "Property insurance & taxes \u2014 Q2", 4120, 1, null, "pdf"],
      ["2026-07-02", CATS.demo, "Services", "Roll-off dumpsters x3", 2850, 0, "haul", "photo"],
      ["2026-07-05", CATS.demo, "Labor", "Interior strip-out crew", 11450, 1, "haul", "pdf"],
      ["2026-07-18", CATS.framing, "Labor", "Ridgeline Framing \u2014 progress draw 1", 38000, 0, "framing", "pdf"],
      ["2026-07-29", CATS.framing, "Materials", "Engineered beam & hardware package", 9240, 0, "framing", "pdf"],
      ["2026-08-01", CATS.kitchen, "Materials", "Cabinet package \u2014 Cedar Tile Co supply", 21900, 1, "tile", "pdf"],
      ["2026-08-04", CATS.roof, "Labor", "Sterling Roofing \u2014 tear-off & dry-in", 16400, 2, "roof", "pdf"],
      ["2026-08-07", CATS.mep, "Labor", "Vega Electric \u2014 rough-in phase 1", 27600, 0, "electric", "pdf"],
      ["2026-08-08", CATS.mep, "Labor", "Nova Plumbing \u2014 rough-in & repipe", 24900, 1, "plumbing", "pdf"],
      ["2026-08-09", CATS.mep, "Labor", "Apex HVAC \u2014 ductwork & condenser", 19400, 2, "hvac", "pdf"],
      ["2026-08-11", CATS.mep, "Materials", "Panel upgrade & service mast", 5500, 0, "electric", "photo"],
      ["2026-08-12", CATS.framing, "Materials", "Prime Lumber Co \u2014 studs & sheathing", 1284.6, 0, "framing", "pdf"],
      ["2026-08-13", CATS.windows, "Materials", "Window package \u2014 14 units", 12840, 1, null, "pdf"],
      ["2026-08-14", CATS.misc, "Other", "Site fencing & portable toilet", 980, 2, null, "photo"],
    ],
    // The app recomputes phase dates forward from the start, so a phase is only
    // late if the whole schedule began early enough for its window to have
    // passed while it is still running. Rough-in MEP lands eight days overdue.
    schedule: { start: "2026-05-26", done: 4, running: 3, late: [5] },
    draws: [
      { date: "2026-07-24", amount: 18500, note: "Draw 1 \u2014 demolition & framing start" },
      { date: "2026-08-08", amount: 23000, note: "Draw 2 \u2014 framing complete, roof dry-in" },
    ],
    docs: [
      { kind: "ALTA / Settlement Statement", name: "ALTA settlement \u2014 42 Maple Street.pdf", build: "alta" },
      { kind: "Permits", name: "Building permit BP-2026-1180.pdf", build: "permit" },
      { kind: "Scope & Bids", name: "Scope of work & trade bids.pdf", build: "scope" },
      { kind: "Insurance", name: "Builder's risk certificate.pdf", build: "insurance" },
    ],
  },

  // ---------------------------------------------------------------- 4 of 5
  {
    name: "7 Harbour Row",
    address: "7 Harbour Row, Springfield",
    status: "done",
    funding: "financed",
    borrower: "Harbour Row Ventures LLC",
    lender: "Ironbridge Private Credit",
    settlementDate: "2025-11-10",
    purchasePrice: 298000,
    loanAmount: 265000,
    loanHoldback: 60000,
    salePrice: 532000,
    varianceThreshold: 10,
    prefAnnualPct: 8,
    notes: "Rot behind the shower wall turned into a structural job. Finished six weeks late and well over budget. Listed now.",
    partners: [["Dana Reyes", 50], ["Marcus Tate", 50]],
    budget: { [CATS.closing]: 115000, [CATS.permits]: 6000, [CATS.demo]: 11000, [CATS.framing]: 28000, [CATS.roof]: 21000, [CATS.windows]: 14000, [CATS.mep]: 34000, [CATS.drywall]: 18000, [CATS.kitchen]: 24000, [CATS.interior]: 16000, [CATS.floor]: 13000, [CATS.land]: 8000, [CATS.hold]: 18000, [CATS.misc]: 6000 },
    expenses: [
      ["2025-11-10", CATS.closing, "Fees", "Cash to close at settlement", 93000, 0, null, null],
      ["2025-11-10", CATS.closing, "Fees", "Settlement charges \u2014 Harbour closing", 14600, 0, null, "pdf"],
      ["2025-11-10", CATS.closing, "Fees", "Lender points & underwriting", 6800, 0, null, null],
      ["2025-11-22", CATS.permits, "Fees", "Permits, plan review & re-inspection fees", 7350, 1, null, "pdf"],
      ["2025-12-04", CATS.demo, "Labor", "Demolition & selective structural removal", 12900, 0, "haul", "pdf"],
      ["2026-01-08", CATS.framing, "Labor", "Ridgeline Framing \u2014 sistered joists & wall rebuild", 28400, 0, "framing", "pdf"],
      ["2026-01-19", CATS.framing, "Materials", "Structural lumber & steel post package", 8900, 1, "framing", "pdf"],
      ["2026-02-03", CATS.roof, "Labor", "Sterling Roofing \u2014 full replacement", 19600, 1, "roof", "pdf"],
      ["2026-02-20", CATS.mep, "Labor", "Vega Electric \u2014 full rewire", 21400, 0, "electric", "pdf"],
      ["2026-03-05", CATS.mep, "Labor", "Nova Plumbing \u2014 repipe & fixtures", 17800, 1, "plumbing", "pdf"],
      ["2026-03-28", CATS.drywall, "Labor", "Insulation & drywall \u2014 whole house", 16900, 0, null, "pdf"],
      ["2026-04-22", CATS.kitchen, "Materials", "Kitchen & two baths \u2014 Cedar Tile Co", 26300, 1, "tile", "pdf"],
      ["2026-05-14", CATS.interior, "Labor", "Halcyon Painting \u2014 interior & trim", 14400, 0, "paint", "pdf"],
      ["2026-06-02", CATS.floor, "Materials", "Engineered oak throughout", 12600, 1, null, "pdf"],
      ["2026-06-25", CATS.land, "Labor", "Landscaping, drive & curb appeal", 7200, 0, null, "photo"],
      ["2026-07-10", CATS.hold, "Fees", "Loan interest, insurance & taxes \u2014 to date", 22400, 1, null, "pdf"],
      ["2026-07-28", CATS.misc, "Other", "Change orders & contingency drawdown", 8600, 0, null, "photo"],
    ],
    schedule: { start: "2025-11-24", done: 11, running: -1, late: [], slipped: true },
    draws: [
      { date: "2026-01-14", amount: 22000, note: "Draw 1 \u2014 demolition & structural" },
      { date: "2026-03-02", amount: 24500, note: "Draw 2 \u2014 roof & rough-in" },
      { date: "2026-05-06", amount: 21000, note: "Draw 3 \u2014 drywall & kitchen" },
    ],
    docs: [
      { kind: "ALTA / Settlement Statement", name: "ALTA settlement \u2014 7 Harbour Row.pdf", build: "alta" },
      { kind: "Permits", name: "Permit set & structural revision.pdf", build: "permit" },
      { kind: "Invoices & Lien Releases", name: "Final lien releases \u2014 all trades.pdf", build: "lien" },
      { kind: "Listing & Sale", name: "Listing agreement \u2014 532,000.pdf", build: "listing" },
    ],
  },

  // ---------------------------------------------------------------- 5 of 5
  {
    name: "510 Ridgeway Avenue",
    address: "510 Ridgeway Avenue, Springfield",
    status: "sold",
    funding: "financed",
    borrower: "Ridgeway Deal Co LLC",
    lender: "Meridian Capital Partners",
    settlementDate: "2025-06-20",
    purchasePrice: 212000,
    loanAmount: 230000,
    loanHoldback: 50000,
    salePrice: 525000,
    saleDate: "2026-02-27",
    varianceThreshold: 10,
    prefAnnualPct: 8,
    notes: "Closed out. Came in under budget and eleven days early. This is the one to copy.",
    partners: [["Dana Reyes", 50], ["Marcus Tate", 30], ["Ivy Holdings", 20]],
    budget: { [CATS.closing]: 52000, [CATS.permits]: 5000, [CATS.demo]: 10000, [CATS.framing]: 22000, [CATS.roof]: 19000, [CATS.windows]: 11000, [CATS.mep]: 34000, [CATS.drywall]: 17000, [CATS.kitchen]: 32000, [CATS.interior]: 20000, [CATS.floor]: 13000, [CATS.land]: 8000, [CATS.hold]: 15000, [CATS.sell]: 26000 },
    expenses: [
      ["2025-06-20", CATS.closing, "Fees", "Cash to close at settlement", 32000, 0, null, null],
      ["2025-06-20", CATS.closing, "Fees", "Settlement charges \u2014 Keystone Title & Escrow", 15900, 0, null, "pdf"],
      ["2025-07-02", CATS.permits, "Fees", "Permits & inspections", 3900, 0, null, "pdf"],
      ["2025-07-15", CATS.demo, "Services", "Demolition & haul-away", 8400, 1, "haul", "pdf"],
      ["2025-08-06", CATS.framing, "Labor", "Ridgeline Framing \u2014 wall & deck repairs", 19800, 0, "framing", "pdf"],
      ["2025-08-28", CATS.roof, "Labor", "Sterling Roofing \u2014 replacement", 17600, 2, "roof", "pdf"],
      ["2025-09-12", CATS.windows, "Materials", "Window & exterior door package", 9800, 1, null, "pdf"],
      ["2025-09-30", CATS.mep, "Labor", "Vega Electric \u2014 rewire & panel", 16200, 0, "electric", "pdf"],
      ["2025-10-08", CATS.mep, "Labor", "Nova Plumbing \u2014 repipe", 14100, 1, "plumbing", "pdf"],
      ["2025-10-27", CATS.drywall, "Labor", "Insulation & drywall", 15600, 0, null, "photo"],
      ["2025-11-18", CATS.kitchen, "Materials", "Kitchen & bath package", 29400, 1, "tile", "pdf"],
      ["2025-12-09", CATS.interior, "Labor", "Halcyon Painting \u2014 full interior", 17900, 2, "paint", "pdf"],
      ["2026-01-06", CATS.floor, "Materials", "LVP flooring throughout", 11800, 0, null, "pdf"],
      ["2026-01-20", CATS.land, "Labor", "Landscaping & exterior paint", 7300, 1, null, "photo"],
      ["2026-02-02", CATS.hold, "Fees", "Loan interest, insurance & taxes", 14200, 0, null, "pdf"],
      ["2026-02-27", CATS.sell, "Fees", "Agent commission, staging & seller closing", 24800, 0, null, "pdf"],
    ],
    schedule: { start: "2025-07-01", done: 11, running: -1, late: [] },
    draws: [
      { date: "2025-08-20", amount: 16000, note: "Draw 1 \u2014 demolition & framing" },
      { date: "2025-10-14", amount: 18000, note: "Draw 2 \u2014 roof, windows & rough-in" },
      { date: "2025-12-16", amount: 14000, note: "Draw 3 \u2014 drywall, kitchen & finishes" },
    ],
    docs: [
      { kind: "ALTA / Settlement Statement", name: "ALTA settlement \u2014 purchase.pdf", build: "alta" },
      { kind: "ALTA / Settlement Statement", name: "ALTA settlement \u2014 sale 27 Feb 2026.pdf", build: "altaSale" },
      { kind: "Deed & Title", name: "Warranty deed & title policy.pdf", build: "deed" },
      { kind: "Listing & Sale", name: "Closing statement \u2014 525,000.pdf", build: "listing" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Turning an expense into a piece of paper
// ---------------------------------------------------------------------------
const VENDOR_ADDRESS = {
  "Ridgeline Framing": ["1420 Mill Road, Springfield", "(555) 204-8871"],
  "Vega Electric": ["77 Foundry Street, Springfield", "(555) 661-2210"],
  "Cedar Tile Co": ["2200 Quarry Lane, Springfield", "(555) 903-4412"],
  "Nova Plumbing": ["18 Cistern Way, Springfield", "(555) 448-7712"],
  "Handy Haul": ["940 Depot Road, Springfield", "(555) 118-6640"],
  "Sterling Roofing": ["605 Shingle Court, Springfield", "(555) 772-3390"],
  "Apex HVAC": ["31 Compressor Drive, Springfield", "(555) 330-9987"],
  "Halcyon Painting": ["12 Palette Street, Springfield", "(555) 615-2204"],
};

function vendorFor(description, contractorName) {
  if (contractorName) return contractorName;
  const dash = description.indexOf("\u2014");
  if (dash > -1) return description.slice(dash + 1).trim();
  return description.split(",")[0].trim();
}

// Split the amount into a couple of believable line items that add back up.
function splitAmount(total, description) {
  const cents = Math.round(total * 100);
  if (cents < 100000) return [{ desc: description.slice(0, 44), qty: 1, amount: total }];
  const a = Math.round(cents * 0.68);
  const b = Math.round(cents * 0.22);
  const c = cents - a - b;
  return [
    { desc: description.slice(0, 44), qty: 1, amount: a / 100 },
    { desc: "Materials & consumables", qty: 1, amount: b / 100 },
    { desc: "Delivery, fuel & handling", qty: 1, amount: c / 100 },
  ];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function pretty(dateStr) {
  const d = new Date(dateStr);
  return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear();
}
function loud(dateStr) {
  const d = new Date(dateStr);
  return String(d.getUTCDate()).padStart(2, "0") + " " + MONTHS[d.getUTCMonth()].toUpperCase() + " " + d.getUTCFullYear();
}

let invoiceNo = 88200;
function buildReceipt(kind, project, exp) {
  const [date, , , description, amount, , contractorKey] = exp;
  const contractor = contractorKey ? CONTRACTORS.find((c) => c.key === contractorKey) : null;
  const vendor = vendorFor(description, contractor ? contractor.name : null);
  const lines = splitAmount(amount, description);
  const where = VENDOR_ADDRESS[vendor] || ["Springfield, IL", "(555) 000-0000"];

  if (kind === "photo") {
    return {
      ext: "png",
      mime: "image/png",
      buffer: receiptPhoto({
        vendor: vendor.slice(0, 16),
        vendorLine: "SPRINGFIELD IL",
        date: loud(date),
        lines: lines.map((l) => ({ desc: l.desc, amount: l.amount })),
        tax: 0,
        card: String(4000 + (invoiceNo % 900)),
        auth: String(100000 + (invoiceNo % 800000)),
      }),
    };
  }
  return {
    ext: "pdf",
    mime: "application/pdf",
    buffer: receiptPdf({
      vendor,
      vendorAddress: where[0],
      vendorPhone: where[1],
      title: "INVOICE",
      number: "INV-" + ++invoiceNo,
      date: pretty(date),
      billTo: project.borrower || "Demo Holdings LLC",
      jobSite: project.address,
      lines,
      tax: 0,
      method: "company card",
    }),
  };
}

function buildDocument(build, project) {
  const funded = (project.loanAmount || 0) - (project.loanHoldback || 0);
  switch (build) {
    case "alta":
      return altaPdf({
        file: "KT-" + project.settlementDate.slice(0, 4) + "-" + (1000 + project.name.length * 37),
        settlementDate: pretty(project.settlementDate),
        property: project.address,
        buyer: project.borrower,
        seller: "Estate of R. Whitfield",
        lender: project.lender || "",
        side: "buyer",
        rows: [
          { heading: "PURCHASE" },
          { desc: "Contract sales price", debit: project.purchasePrice },
          project.lender ? { heading: "LOAN CHARGES" } : { heading: "CASH PURCHASE" },
          project.lender ? { desc: "Loan origination fee 1.5%", debit: Math.round(project.loanAmount * 0.015) } : { desc: "No lender in this transaction", debit: 0 },
          project.lender ? { desc: "Loan proceeds funded at closing", credit: funded } : { desc: "Buyer funds wired", credit: 0 },
          { heading: "TITLE & SETTLEMENT" },
          { desc: "Settlement fee", debit: 850 },
          { desc: "Lender's title insurance", debit: 1240 },
          { desc: "Owner's title insurance", debit: 1685 },
          { heading: "GOVERNMENT RECORDING & TRANSFER" },
          { desc: "Recording fees", debit: 186 },
          { desc: "State & county transfer tax", debit: Math.round(project.purchasePrice * 0.01) },
          { heading: "PRORATIONS & DEPOSITS" },
          { desc: "County taxes prorated", debit: 1420 },
          { desc: "Earnest money deposit", credit: 10000 },
        ],
      });
    case "altaSale":
      return altaPdf({
        file: "KT-2026-SALE-" + (2000 + project.name.length),
        settlementDate: pretty(project.saleDate),
        property: project.address,
        buyer: "T. & M. Okonkwo",
        seller: project.borrower,
        lender: "",
        side: "seller",
        agent: "Keystone Title & Escrow, LLC",
        rows: [
          { heading: "SALE" },
          { desc: "Contract sales price", credit: project.salePrice },
          { heading: "PAYOFF" },
          { desc: "Payoff of construction loan \u2014 " + project.lender, debit: funded + 48000 },
          { heading: "SELLING COSTS" },
          { desc: "Real estate commission 5%", debit: Math.round(project.salePrice * 0.05) },
          { desc: "Seller settlement fee", debit: 795 },
          { desc: "Transfer tax", debit: Math.round(project.salePrice * 0.01) },
          { desc: "Staging & pre-listing repairs", debit: 4200 },
          { heading: "PRORATIONS" },
          { desc: "Taxes prorated to closing", debit: 1180 },
        ],
      });
    case "contract":
      return simpleDocPdf({
        title: "Residential purchase contract",
        date: "Executed 24 Jul 2026",
        rows: [
          { heading: "PARTIES & PROPERTY" },
          { label: "Buyer", value: project.borrower },
          { label: "Seller", value: "Estate of H. Lindqvist" },
          { label: "Property", value: project.address },
          { heading: "PRICE & TERMS" },
          { label: "Purchase price", value: usd(project.purchasePrice), bold: true },
          { label: "Earnest money", value: usd(5000) },
          { label: "Financing", value: "None \u2014 cash purchase" },
          { label: "Settlement date", value: pretty(project.settlementDate) },
          { heading: "CONTINGENCIES" },
          { label: "Inspection period", value: "10 days from execution" },
          { label: "Title review", value: "15 days from execution" },
          { label: "Appraisal", value: "Waived" },
          { heading: "" },
          { text: "Sold strictly as-is. Seller makes no representation as to condition." },
        ],
      });
    case "inspection":
      return simpleDocPdf({
        title: "Whole-house inspection report",
        date: pretty("2026-08-03"),
        rows: [
          { heading: "SUMMARY" },
          { text: "3 bed / 1 bath ranch, 1,180 sq ft, built 1962. Occupied until March." },
          { heading: "MATERIAL DEFECTS" },
          { label: "Roof \u2014 remaining life", value: "2 to 4 years" },
          { label: "Electrical panel", value: "60 amp fuse box, replace" },
          { label: "Plumbing", value: "Galvanised supply, repipe" },
          { label: "Heating", value: "Gas furnace, 1998, at end of life" },
          { label: "Foundation", value: "Sound, minor settlement cracks" },
          { heading: "ESTIMATED REMEDIATION" },
          { label: "Total", value: usd(64500), bold: true },
        ],
      });
    case "loan":
      return simpleDocPdf({
        title: "Construction loan summary",
        date: pretty(project.settlementDate),
        rows: [
          { heading: "LENDER" },
          { label: "Lender", value: project.lender },
          { label: "Borrower", value: project.borrower },
          { label: "Property", value: project.address },
          { heading: "TERMS" },
          { label: "Note amount", value: usd(project.loanAmount), bold: true },
          { label: "Funded at closing", value: usd(funded) },
          { label: "Construction holdback", value: usd(project.loanHoldback) },
          { label: "Rate", value: "10.75% interest only" },
          { label: "Term", value: "12 months, one 3-month extension" },
          { label: "Draw schedule", value: "On inspection, 5 business days" },
        ],
      });
    case "permit":
      return simpleDocPdf({
        title: "Building permit",
        date: pretty(project.settlementDate),
        rows: [
          { heading: "PERMIT" },
          { label: "Permit number", value: "BP-2026-" + (1000 + project.name.length * 29) },
          { label: "Property", value: project.address },
          { label: "Scope", value: "Full interior rehabilitation" },
          { heading: "TRADES COVERED" },
          { label: "Structural", value: "Approved" },
          { label: "Electrical", value: "Approved" },
          { label: "Plumbing", value: "Approved" },
          { label: "Mechanical", value: "Approved" },
          { heading: "FEES" },
          { label: "Total permit fees", value: usd(3180), bold: true },
        ],
      });
    case "scope":
      return simpleDocPdf({
        title: "Scope of work & trade bids",
        date: pretty("2026-04-10"),
        rows: [
          { heading: "AWARDED BIDS" },
          { label: "Demolition \u2014 Handy Haul", value: usd(14300) },
          { label: "Framing \u2014 Ridgeline Framing", value: usd(47240) },
          { label: "Roofing \u2014 Sterling Roofing", value: usd(16400) },
          { label: "Electrical \u2014 Vega Electric", value: usd(33100) },
          { label: "Plumbing \u2014 Nova Plumbing", value: usd(24900) },
          { label: "HVAC \u2014 Apex HVAC", value: usd(19400) },
          { label: "Tile & stone \u2014 Cedar Tile Co", value: usd(21900) },
          { label: "Painting \u2014 Halcyon Painting", value: usd(18600) },
          { heading: "TOTAL AWARDED" },
          { label: "All trades", value: usd(195840), bold: true },
        ],
      });
    case "insurance":
      return simpleDocPdf({
        title: "Certificate of insurance",
        date: pretty(project.settlementDate),
        rows: [
          { heading: "COVERAGE" },
          { label: "Named insured", value: project.borrower },
          { label: "Property", value: project.address },
          { label: "Policy type", value: "Builder's risk & general liability" },
          { label: "Dwelling limit", value: usd(400000), bold: true },
          { label: "Liability limit", value: usd(1000000) },
          { label: "Deductible", value: usd(2500) },
          { label: "Mortgagee", value: project.lender || "None" },
        ],
      });
    case "lien":
      return simpleDocPdf({
        title: "Final lien releases",
        date: pretty("2026-07-30"),
        rows: [
          { heading: "UNCONDITIONAL RELEASES ON FINAL PAYMENT" },
          { label: "Ridgeline Framing LLC", value: "Received" },
          { label: "Sterling Roofing LLC", value: "Received" },
          { label: "Vega Electric Inc", value: "Received" },
          { label: "Nova Plumbing & Heating", value: "Received" },
          { label: "Cedar Tile Company", value: "Received" },
          { label: "Halcyon Painting Co", value: "Received" },
          { label: "Handy Haul Services", value: "Received" },
          { heading: "" },
          { text: "All trades paid in full. No outstanding claims of lien on record." },
        ],
      });
    case "listing":
      return simpleDocPdf({
        title: project.status === "sold" ? "Closing statement" : "Listing agreement",
        date: pretty(project.saleDate || "2026-08-01"),
        rows: [
          { heading: "PROPERTY" },
          { label: "Address", value: project.address },
          { label: project.status === "sold" ? "Sale price" : "List price", value: usd(project.salePrice), bold: true },
          { heading: "COSTS OF SALE" },
          { label: "Listing commission 2.5%", value: usd(Math.round(project.salePrice * 0.025)) },
          { label: "Buyer agent commission 2.5%", value: usd(Math.round(project.salePrice * 0.025)) },
          { label: "Staging", value: usd(3200) },
          { label: "Seller settlement fee", value: usd(795) },
          { heading: "NET" },
          { label: "Estimated net to seller", value: usd(Math.round(project.salePrice * 0.94)), bold: true },
        ],
      });
    case "deed":
      return simpleDocPdf({
        title: "Warranty deed & owner's title policy",
        date: pretty(project.settlementDate),
        rows: [
          { heading: "CONVEYANCE" },
          { label: "Grantor", value: "Estate of R. Whitfield" },
          { label: "Grantee", value: project.borrower },
          { label: "Property", value: project.address },
          { label: "Recorded", value: pretty(plus(project.settlementDate, 3)) },
          { label: "Instrument number", value: "2025-0044182" },
          { heading: "TITLE POLICY" },
          { label: "Owner's policy amount", value: usd(project.purchasePrice), bold: true },
          { label: "Exceptions", value: "Utility easement, north boundary" },
        ],
      });
    default:
      return simpleDocPdf({ title: "Document", rows: [{ text: "Demo document." }] });
  }
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------
let pdfReceiptsAllowed = true;

async function seedProject(spec, contractorIds) {
  const pid = id();
  const p = {
    id: pid,
    name: spec.name,
    address: spec.address,
    status: spec.status,
    funding: spec.funding,
    borrower: spec.borrower || null,
    lender: spec.lender || null,
    settlement_date: spec.settlementDate || null,
    loan_amount: spec.loanAmount || 0,
    loan_holdback: spec.loanHoldback || 0,
    purchase_price: spec.purchasePrice || null,
    sale_price: spec.salePrice || null,
    sale_date: spec.saleDate || null,
    notes: spec.notes || null,
    variance_threshold: spec.varianceThreshold || 10,
    pref_annual_pct: spec.prefAnnualPct || 0,
    created_by: USER.id,
  };
  await rest("POST", "projects", p);

  // Partners
  const partnerIds = [];
  const partnerRows = spec.partners.map(([name, equity], i) => {
    const rowId = id();
    partnerIds.push(rowId);
    return { id: rowId, project_id: pid, name, sort: i, equity_pct: equity };
  });
  await rest("POST", "project_partners", partnerRows);

  // Budget
  const budgetRows = Object.entries(spec.budget).map(([category, amount]) => ({
    id: id(),
    project_id: pid,
    category,
    amount,
  }));
  if (budgetRows.length) await rest("POST", "budget_lines", budgetRows);

  // Expenses, each with its paperwork
  const expenseRows = [];
  let receiptCount = 0;
  for (const exp of spec.expenses) {
    const [date, category, costType, description, amount, partnerIdx, contractorKey, receiptKind] = exp;
    const eid = id();
    const receipts = [];
    if (receiptKind) {
      let want = receiptKind;
      if (want === "pdf" && !pdfReceiptsAllowed) want = "photo";
      const built = buildReceipt(want, spec, exp);
      const objectPath = `${pid}/${eid}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}.${built.ext}`;
      try {
        await upload("receipts", objectPath, built.buffer, built.mime);
        receipts.push(objectPath);
        receiptCount++;
      } catch (err) {
        if (built.ext === "pdf" && /mime|content type|invalid/i.test(err.message)) {
          // The bucket has not had supabase-phase9-pdf-receipts.sql run against
          // it yet. Fall back to a photograph and say so once.
          pdfReceiptsAllowed = false;
          const photo = buildReceipt("photo", spec, exp);
          const alt = objectPath.replace(/\.pdf$/, ".png");
          await upload("receipts", alt, photo.buffer, photo.mime);
          receipts.push(alt);
          receiptCount++;
        } else {
          throw err;
        }
      }
    }
    expenseRows.push({
      id: eid,
      project_id: pid,
      date,
      description,
      notes: null,
      category,
      cost_type: costType,
      partner_id: partnerIds[partnerIdx] || null,
      contractor_id: contractorKey ? contractorIds[contractorKey] : null,
      amount,
      receipts,
    });
  }
  await rest("POST", "expenses", expenseRows);

  // Schedule
  const s = spec.schedule;
  const taskIds = PHASES.map(() => id());
  const taskRows = [];
  let cursor = s.start;
  PHASES.forEach((phase, i) => {
    const [name, duration, category, contractorKey] = phase;
    const plannedStart = cursor;
    cursor = plus(cursor, duration);
    let status = "not_started";
    let actualStart = null;
    let actualEnd = null;
    if (i <= s.done) {
      status = "done";
      actualStart = plannedStart;
      // A project that overran finished each phase a little later than planned.
      actualEnd = plus(plannedStart, duration + (s.slipped ? 3 : 0));
    } else if (i === s.running || s.late.includes(i)) {
      status = "in_progress";
      actualStart = plannedStart;
    }
    taskRows.push({
      id: taskIds[i],
      project_id: pid,
      name,
      category,
      contractor_id: contractorKey ? contractorIds[contractorKey] : null,
      duration_days: duration,
      // A late phase started on time and simply has not finished, so its
      // planned end is already in the past.
      planned_start: s.late.includes(i) ? plus(plannedStart, -6) : plannedStart,
      actual_start: actualStart,
      actual_end: actualEnd,
      status,
      depends_on: PHASE_DEPS[i].map((d) => taskIds[d]),
      sort: i,
      notes: s.late.includes(i) ? "Held up waiting on the panel upgrade inspection." : null,
    });
  });
  await rest("POST", "tasks", taskRows);

  // Draws
  if (spec.draws.length) {
    await rest(
      "POST",
      "draws",
      spec.draws.map((d) => ({ id: id(), project_id: pid, date: d.date, note: d.note, amount: d.amount }))
    );
  }

  // Documents
  const docRows = [];
  for (const d of spec.docs) {
    const did = id();
    const buffer = buildDocument(d.build, spec);
    const objectPath = `${pid}/${did}/${Date.now().toString(36)}.pdf`;
    await upload("documents", objectPath, buffer, "application/pdf");
    docRows.push({
      id: did,
      project_id: pid,
      name: d.name,
      kind: d.kind,
      path: objectPath,
      size: buffer.length,
      mime: "application/pdf",
      note: "",
      uploaded_by: USER.id,
    });
  }
  await rest("POST", "documents", docRows);

  const spent = spec.expenses.reduce((t, e) => t + e[4], 0);
  const funded = (spec.loanAmount || 0) - (spec.loanHoldback || 0);
  const allIn = spent + funded;
  console.log(
    "  " +
      spec.name.padEnd(24) +
      spec.status.padEnd(16) +
      "all-in " +
      usd(allIn).padStart(12) +
      (spec.salePrice ? "   profit " + usd(spec.salePrice - allIn).padStart(12) : "") 
  );
  console.log(
    "    " +
      spec.expenses.length + " expenses, " +
      receiptCount + " receipts, " +
      docRows.length + " documents, " +
      taskRows.length + " phases, " +
      spec.draws.length + " draws, " +
      spec.partners.length + " partners"
  );
}

async function main() {
  console.log("\nSeeding the FlipSmart demo account\n");
  await signIn();
  await wipe();

  const contractorIds = {};
  const contractorRows = CONTRACTORS.map((c) => {
    const rowId = id();
    contractorIds[c.key] = rowId;
    return {
      id: rowId,
      owner_id: USER.id,
      name: c.name,
      company: c.company || null,
      trade: c.trade || null,
      phone: c.phone || null,
      email: c.email || null,
      w9_on_file: !!c.w9OnFile,
      tax_id_last4: c.taxIdLast4 || null,
      coi_expires: c.coiExpires || null,
      license_number: c.licenseNumber || null,
      license_expires: c.licenseExpires || null,
      notes: null,
    };
  });
  await rest("POST", "contractors", contractorRows);
  console.log("  " + contractorRows.length + " contractors\n");

  for (const spec of PROJECTS) await seedProject(spec, contractorIds);

  if (!pdfReceiptsAllowed) {
    console.log(
      "\n  Note: the receipts bucket rejected PDFs, so those became photographs.\n" +
        "  Run supabase-phase9-pdf-receipts.sql and seed again for PDF receipts."
    );
  }

  console.log("\nDone. Sign in at app.html with:");
  console.log("  email    " + EMAIL);
  console.log("  password " + PASSWORD + "\n");
}

main().catch((err) => {
  console.error("\nFailed: " + err.message + "\n");
  process.exit(1);
});
