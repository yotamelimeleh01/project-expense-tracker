"use strict";

// ---------------------------------------------------------------------------
// Shared vocabulary. Everything that used to be hard-coded for one property
// (address, lender, loan amounts, partner names) now lives on each project row
// in the database. What is left here is the stuff that is the same for every
// deal: the sections you file an expense under and the buckets they roll into.
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

// The four everyday sections every project is organized by.
const SECTIONS = [
  "Closing & Deal Costs",
  "Utilities, Insurance, Loan & Taxes",
  "Materials, Tools & Supplies",
  "Contractors, Crew & Services",
];

// Roll-up buckets that answer the three questions that actually matter:
// what did it cost to BUY it, to FIX it, and to HOLD it.
// Each bucket is built from the sections above, so nothing has to be
// re-tagged — add an expense to a section and it lands in the right bucket.
const COST_GROUPS = [
  {
    label: "Cost To Purchase",
    blurb:
      "Everything it took to acquire the property — closing costs, fees, " +
      "deposits, plus the loan principal the lender funded at settlement.",
    sections: [SECTIONS[0]],
    includeLoanFunded: true,
  },
  {
    label: "Cost To Do The Work",
    blurb: "The renovation itself — materials, tools, contractors and crew.",
    sections: [SECTIONS[2], SECTIONS[3]],
  },
  {
    label: "Cost To Hold",
    blurb: "Carrying the property — utilities, insurance, loan payments and taxes.",
    sections: [SECTIONS[1]],
  },
];

// A brand-new project starts with two money partners; rename or add more in
// project settings.
const DEFAULT_PARTNER_NAMES = ["Partner A", "Partner B"];

const MEMBER_ROLES = [
  { value: "owner",  label: "Owner",  hint: "Full control, can share the project" },
  { value: "editor", label: "Editor", hint: "Can add and change expenses" },
  { value: "viewer", label: "Viewer", hint: "Read only" },
];
