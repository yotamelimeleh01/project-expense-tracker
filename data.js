// Seed data extracted from the "Master Project Expense Tracker" PDF.
// Property: 450 Spring Dr, Ocala, FL 34472 | Settlement Date: 2026-07-08
//
// NOTE: Totals in this app are always computed from these line items.
// Reconciled against the borrower's own ledger (Ocala.txt) and the ALTA
// Settlement Statement (File 267286-50). Two items the first PDF omitted have
// been added: Partner A's $235 water service deposit, and Partner Z's
// $5,934.98 pre-closing deposit (earnest money + additional deposit paid
// before settlement; part of the $29,684 "Closing" figure that the ALTA's
// itemized fees alone did not cover). Totals now match the header exactly:
// A $547.29 / Z $31,772.62 / $32,319.91.

const PROPERTY = {
  name: "450 Spring Dr, Ocala, FL 34472",
  borrower: "Ryan Locksmith LLC",
  settlementDate: "2026-07-08",
};

// Loan structure from the ALTA (File 267286-50).
// Total note is $137,700, of which $42,500 is a construction holdback that is
// drawn over time. Funded principal at closing = amount - holdback = $95,200.
// Payoff owed at sale = funded principal + construction draws taken
// (excludes interest & exit fees).
const LOAN = {
  lender: "National Loan Funding LLC",
  amount: 137700,
  holdback: 42500,
};

// Construction draws pulled from the holdback (none drawn yet).
const SEED_DRAWS = [];


// The four everyday sections the tracker is organized by.
const SECTIONS = [
  "Closing & Deal Costs",
  "Utilities, Insurance, Loan & Taxes",
  "Materials, Tools & Supplies",
  "Contractors, Crew & Services",
];

const PARTNERS = { A: "Partner A", Z: "Partner Z" };

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

// paidBy: "A" | "Z"
const SEED_EXPENSES = [
  // Closing & Deal Costs — everyone who took a cut at settlement
  { date: "", description: "Earnest Money & Deposit Paid Before Closing (part of $29,684 closing)", section: SECTIONS[0], paidBy: "Z", amount: 5934.98 },
  { date: "2026-07-08", description: "Origination Fee (Pay to Sherman Bridge)", section: SECTIONS[0], paidBy: "Z", amount: 2754.0 },
  { date: "2026-07-08", description: "Prepaid Interest (07/08/26 - 08/01/26)", section: SECTIONS[0], paidBy: "Z", amount: 908.82 },
  { date: "2026-07-08", description: "Document Prep Fee (National Loan Funding LLC)", section: SECTIONS[0], paidBy: "Z", amount: 1995.0 },
  { date: "2026-07-08", description: "Credit Report Fee (National Loan Funding LLC)", section: SECTIONS[0], paidBy: "Z", amount: 65.0 },
  { date: "2026-07-08", description: "Title Settlement / Closing Fee (First International Title)", section: SECTIONS[0], paidBy: "Z", amount: 895.0 },
  { date: "2026-07-08", description: "Title Search (First International Title)", section: SECTIONS[0], paidBy: "Z", amount: 200.0 },
  { date: "2026-07-08", description: "Environmental Protection Endorsement (FL 8.1-21)", section: SECTIONS[0], paidBy: "Z", amount: 100.0 },
  { date: "2026-07-08", description: "Lender's Title Insurance ($137,700 Policy)", section: SECTIONS[0], paidBy: "Z", amount: 628.5 },
  { date: "2026-07-08", description: "Owner's Title Insurance ($112,000 Policy)", section: SECTIONS[0], paidBy: "Z", amount: 635.0 },
  { date: "2026-07-08", description: "Government Recording Fees (Deed & Mortgage)", section: SECTIONS[0], paidBy: "Z", amount: 198.5 },
  { date: "2026-07-08", description: "Affidavits Recording (Death Cert & LLC)", section: SECTIONS[0], paidBy: "Z", amount: 37.0 },
  { date: "2026-07-08", description: "State Intangible Tax", section: SECTIONS[0], paidBy: "Z", amount: 275.4 },
  { date: "2026-07-08", description: "Homeowner's Insurance Premium (Runnels Insurance)", section: SECTIONS[0], paidBy: "Z", amount: 1927.55 },
  { date: "2026-07-08", description: "Assignment Fee 1 (Andrew The Home Buyer LLC)", section: SECTIONS[0], paidBy: "Z", amount: 3500.0 },
  { date: "2026-07-08", description: "Assignment Fee 2 (I'm in Mud, LLC)", section: SECTIONS[0], paidBy: "Z", amount: 3500.0 },
  { date: "2026-07-08", description: "Assignment Fee 3 (Pinellas Equities LLC)", section: SECTIONS[0], paidBy: "Z", amount: 5000.0 },
  { date: "2026-07-08", description: "Brokerage Fee (New Western Acquisitions)", section: SECTIONS[0], paidBy: "Z", amount: 395.0 },
  { date: "2026-07-08", description: "Closing Admin & Notary (Mobile Notary, Research, Tech)", section: SECTIONS[0], paidBy: "Z", amount: 734.25 },

  // Utilities, Insurance, Loan & Taxes — ongoing after closing
  { date: "", description: "Water Service Deposit", section: SECTIONS[1], paidBy: "A", amount: 235.0 },

  // Materials, Tools & Supplies
  { date: "2026-07-16", description: "Home Depot - Materials & Hardware (Day 1)", section: SECTIONS[2], paidBy: "A", amount: 112.29 },
  { date: "2026-07-17", description: "Home Depot - Materials & Lumber Supply", section: SECTIONS[2], paidBy: "Z", amount: 913.62 },

  // Contractors, Crew & Services
  { date: "", description: "On-Site Waste Dumpster Rental", section: SECTIONS[3], paidBy: "Z", amount: 450.0 },
  { date: "", description: "Gardener Initial Property & Yard Cleanout", section: SECTIONS[3], paidBy: "Z", amount: 325.0 },
  { date: "", description: "Carlos - Hotel Accommodation (4 Nights)", section: SECTIONS[3], paidBy: "A", amount: 200.0 },
  { date: "", description: "Carlos - On-Site Direct Labor (2 Days)", section: SECTIONS[3], paidBy: "Z", amount: 400.0 },
];
