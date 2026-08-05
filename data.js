"use strict";

// ---------------------------------------------------------------------------
// Shared vocabulary. Everything specific to one property (address, lender,
// loan amounts, partner names, budget) lives on the project row in the
// database. What is here is the language every deal shares.
// ---------------------------------------------------------------------------

// Lifecycle of a deal, in order.
const PROJECT_STATUSES = [
  { value: "before_closing", label: "Before Closing", hint: "Under contract, not yet yours" },
  { value: "closed",         label: "Closed",         hint: "Purchased, work not started" },
  { value: "in_progress",    label: "In Progress",    hint: "Renovation underway" },
  { value: "done",           label: "Done",           hint: "Work finished, ready to sell" },
  { value: "sold",           label: "Sold",           hint: "Closed out — profit is final" },
];

function statusLabel(value) {
  const s = PROJECT_STATUSES.find((x) => x.value === value);
  return s ? s.label : "Before Closing";
}

// Where the money for the deal came from. A cash purchase has no lender, no
// note and no holdback, so every loan figure and panel is beside the point.
const FUNDING_TYPES = [
  { value: "financed", label: "Financed \u2014 a lender is in the deal" },
  { value: "cash", label: "Cash out of pocket \u2014 no lender" },
];

function isFinanced(project) {
  return !project || project.funding !== "cash";
}

// ---------------------------------------------------------------------------
// Categories.
//
// The construction phases are the Scope of Work — the order a house actually
// gets built in. But a flip is not only construction: money goes out before
// you own it and after the work is done, and those dollars have no phase. So
// the phase list sits inside a wider set of four buckets that together cover
// every dollar in the deal.
// ---------------------------------------------------------------------------
const CATEGORY_GROUPS = [
  {
    key: "acquire",
    label: "Cost To Purchase",
    blurb:
      "Everything it took to acquire the property — closing costs, fees, " +
      "deposits, plus the loan principal the lender funded at settlement.",
    includeLoanFunded: true,
  },
  {
    key: "build",
    label: "Cost To Do The Work",
    blurb: "The renovation itself, phase by phase — the scope of work you budgeted.",
  },
  {
    key: "hold",
    label: "Cost To Hold",
    blurb: "Carrying the property — utilities, insurance, taxes and loan payments.",
  },
  {
    key: "sell",
    label: "Cost To Sell",
    blurb: "Getting it off your books — commissions, staging, concessions and seller-paid closing.",
  },
];

// Order matters: this is the sequence they appear in every dropdown, budget
// sheet and report, and it follows the real order of a job.
const CATEGORIES = [
  { name: "Closing & Deal Costs", group: "acquire", defaultCostType: "Fees" },

  { name: "Permits & Inspections",           group: "build", defaultCostType: "Fees" },
  { name: "Demolition & Debris",             group: "build", defaultCostType: "Labor" },
  { name: "Framing & Structural",            group: "build", defaultCostType: "Labor" },
  { name: "Roofing & Exterior",              group: "build", defaultCostType: "Labor" },
  { name: "Windows & Doors",                 group: "build", defaultCostType: "Materials" },
  { name: "MEP — Mechanical, Electrical, Plumbing", group: "build", defaultCostType: "Labor" },
  { name: "Insulation & Drywall",            group: "build", defaultCostType: "Labor" },
  { name: "Kitchen & Bath",                  group: "build", defaultCostType: "Materials" },
  { name: "Interior Finishes",               group: "build", defaultCostType: "Materials" },
  { name: "Flooring",                        group: "build", defaultCostType: "Materials" },
  { name: "Landscaping & Curb Appeal",       group: "build", defaultCostType: "Labor" },
  { name: "General Construction",            group: "build", defaultCostType: "Materials" },
  { name: "Contingency & Misc",              group: "build", defaultCostType: "Other" },

  { name: "Utilities, Insurance, Taxes & Loan", group: "hold", defaultCostType: "Fees" },

  { name: "Sale & Disposition Costs", group: "sell", defaultCostType: "Fees" },
];

const CATEGORY_NAMES = CATEGORIES.map((c) => c.name);

function categoryGroup(name) {
  const c = CATEGORIES.find((x) => x.name === name);
  return c ? c.group : "build";
}

function categoriesIn(groupKey) {
  return CATEGORIES.filter((c) => c.group === groupKey).map((c) => c.name);
}

function defaultCostTypeFor(category) {
  const c = CATEGORIES.find((x) => x.name === category);
  return c ? c.defaultCostType : "Other";
}

// The second axis: what kind of spend it was. Kept separate from the phase
// because "who do I file a 1099 for" is a different question from "what part
// of the house did this pay for".
const COST_TYPES = [
  { value: "Materials", label: "Materials", is1099: false },
  { value: "Labor",     label: "Labor / Subcontractor", is1099: true },
  { value: "Services",  label: "Services (rentals, hauling, cleaning)", is1099: true },
  { value: "Fees",      label: "Fees, Taxes & Insurance", is1099: false },
  { value: "Other",     label: "Other", is1099: false },
];

function is1099CostType(value) {
  const t = COST_TYPES.find((c) => c.value === value);
  return !!(t && t.is1099);
}

// File a 1099-NEC for anyone you paid this much or more in a calendar year for
// services. Corporations are generally exempt, which is why the report flags a
// contractor rather than filing anything for you.
const IRS_1099_THRESHOLD = 600;

// How close an expiry has to be before the app starts nagging.
const EXPIRY_WARNING_DAYS = 30;

// Compliance state for a certificate of insurance or a licence.
const COMPLIANCE = {
  none:    { key: "none",    label: "No date on file" },
  ok:      { key: "ok",      label: "Current" },
  soon:    { key: "soon",    label: "Expiring soon" },
  expired: { key: "expired", label: "Expired" },
};

function expiryState(dateStr, today) {
  if (!dateStr) return COMPLIANCE.none;
  const now = today ? new Date(today) : new Date();
  const days = Math.floor((new Date(dateStr) - now) / 86400000);
  if (days < 0) return COMPLIANCE.expired;
  if (days <= EXPIRY_WARNING_DAYS) return COMPLIANCE.soon;
  return COMPLIANCE.ok;
}

// A brand-new project starts with two money partners; rename or add more in
// project settings.
const DEFAULT_PARTNER_NAMES = ["Partner A", "Partner B"];

const MEMBER_ROLES = [
  { value: "owner",  label: "Owner",  hint: "Full control, can share the project" },
  { value: "editor", label: "Editor", hint: "Can add and change expenses" },
  { value: "viewer", label: "Viewer", hint: "Read only" },
];

// How a project's budget health is described once it drifts.
const HEALTH = {
  none:  { key: "none",  label: "No Budget Set" },
  under: { key: "under", label: "On Budget" },
  watch: { key: "watch", label: "Watch" },
  over:  { key: "over",  label: "Over Budget" },
};

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------
// Only three states are ever stored. Blocked and late are worked out from the
// dependencies and the calendar, because a stored flag would go stale the
// moment anything moved.
const TASK_STATUSES = [
  { value: "not_started", label: "Not Started" },
  { value: "in_progress", label: "In Progress" },
  { value: "done",        label: "Done" },
];

const SCHEDULE_STATE = {
  done:     { key: "done",     label: "Done" },
  running:  { key: "running",  label: "In Progress" },
  blocked:  { key: "blocked",  label: "Blocked" },
  late:     { key: "late",     label: "Late" },
  ready:    { key: "ready",    label: "Ready" },
  waiting:  { key: "waiting",  label: "Waiting" },
};

// The order trades actually happen in on a rehab. Offered as a starting point
// so nobody has to type twelve rows to find out their finish date; every
// duration is a guess and meant to be edited.
const STARTER_SCHEDULE = [
  { name: "Permits & approvals",   category: "Permits & Inspections",              days: 10, after: [] },
  { name: "Demolition",            category: "Demolition & Debris",                days: 5,  after: [0] },
  { name: "Framing & structural",  category: "Framing & Structural",               days: 7,  after: [1] },
  { name: "Roof & exterior",       category: "Roofing & Exterior",                 days: 5,  after: [2] },
  { name: "Windows & doors",       category: "Windows & Doors",                    days: 3,  after: [2] },
  { name: "Rough-in MEP",          category: "MEP \u2014 Mechanical, Electrical, Plumbing", days: 8, after: [2] },
  { name: "Insulation & drywall",  category: "Insulation & Drywall",               days: 7,  after: [4, 5] },
  { name: "Kitchen & bath",        category: "Kitchen & Bath",                     days: 10, after: [6] },
  { name: "Interior finishes",     category: "Interior Finishes",                  days: 8,  after: [6] },
  { name: "Flooring",              category: "Flooring",                           days: 5,  after: [8] },
  { name: "Landscaping",           category: "Landscaping & Curb Appeal",          days: 4,  after: [3] },
  { name: "Final inspection",      category: "Permits & Inspections",              days: 2,  after: [7, 9, 10] },
];

