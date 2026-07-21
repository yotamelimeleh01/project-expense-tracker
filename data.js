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

// The six master buckets from the PDF's categorization guide.
const BUCKETS = [
  "Financing & Lender",
  "Utilities & Taxes",
  "Insurance & Legal",
  "Demo, Waste & Landscape",
  "Materials & Hardware",
  "Labor & Subcontractors",
];

// The six report sections from the PDF (used for grouping/subtotals).
const SECTIONS = [
  "Lender Charges & Financing Fees",
  "Title, Escrow & Government Transfer Fees",
  "Property Insurance, Wholesale Assignments & Closing Admin",
  "Site Prep, Waste & Landscaping Cleanout",
  "Materials, Tools & Store Purchases",
  "Direct Labor, Contractor Pay & Crew Lodging",
  "Utilities & Operational Costs",
];

const PARTNERS = { A: "Partner A", Z: "Partner Z" };

// Fixed category list for the Add/Edit dropdown.
const CATEGORIES = [
  "Deposit / Cash to Close",
  "Lender Fee",
  "Prepaid Interest",
  "Title / Settlement",
  "Title Search",
  "Title Endorsement",
  "Title Insurance",
  "Recording Fees",
  "Transfer Tax",
  "Property Insurance",
  "Wholesale Fee",
  "Brokerage Fee",
  "Closing Admin",
  "Demo & Waste",
  "Landscaping",
  "Materials/Tools",
  "Crew Lodging",
  "Contractor Labor",
  "Utility Deposit",
  "Utilities",
  "Property Taxes",
  "Permits",
  "Other",
];

// paidBy: "A" | "Z"
const SEED_EXPENSES = [
  // 1. Lender Charges & Financing Fees
  { date: "", description: "Earnest Money & Deposit Paid Before Closing (part of $29,684 closing)", category: "Deposit / Cash to Close", section: SECTIONS[0], bucket: "Financing & Lender", paidBy: "Z", amount: 5934.98 },
  { date: "2026-07-08", description: "Origination Fee (Pay to Sherman Bridge)", category: "Lender Fee", section: SECTIONS[0], bucket: "Financing & Lender", paidBy: "Z", amount: 2754.0 },
  { date: "2026-07-08", description: "Prepaid Interest (07/08/26 - 08/01/26)", category: "Prepaid Interest", section: SECTIONS[0], bucket: "Financing & Lender", paidBy: "Z", amount: 908.82 },
  { date: "2026-07-08", description: "Document Prep Fee (National Loan Funding LLC)", category: "Lender Fee", section: SECTIONS[0], bucket: "Financing & Lender", paidBy: "Z", amount: 1995.0 },
  { date: "2026-07-08", description: "Credit Report Fee (National Loan Funding LLC)", category: "Lender Fee", section: SECTIONS[0], bucket: "Financing & Lender", paidBy: "Z", amount: 65.0 },

  // 2. Title, Escrow & Government Transfer Fees
  { date: "2026-07-08", description: "Title Settlement / Closing Fee (First International Title)", category: "Title / Settlement", section: SECTIONS[1], bucket: "Insurance & Legal", paidBy: "Z", amount: 895.0 },
  { date: "2026-07-08", description: "Title Search (First International Title)", category: "Title Search", section: SECTIONS[1], bucket: "Insurance & Legal", paidBy: "Z", amount: 200.0 },
  { date: "2026-07-08", description: "Environmental Protection Endorsement (FL 8.1-21)", category: "Title Endorsement", section: SECTIONS[1], bucket: "Insurance & Legal", paidBy: "Z", amount: 100.0 },
  { date: "2026-07-08", description: "Lender's Title Insurance ($137,700 Policy)", category: "Title Insurance", section: SECTIONS[1], bucket: "Insurance & Legal", paidBy: "Z", amount: 628.5 },
  { date: "2026-07-08", description: "Owner's Title Insurance ($112,000 Policy)", category: "Title Insurance", section: SECTIONS[1], bucket: "Insurance & Legal", paidBy: "Z", amount: 635.0 },
  { date: "2026-07-08", description: "Government Recording Fees (Deed & Mortgage)", category: "Recording Fees", section: SECTIONS[1], bucket: "Utilities & Taxes", paidBy: "Z", amount: 198.5 },
  { date: "2026-07-08", description: "Affidavits Recording (Death Cert & LLC)", category: "Recording Fees", section: SECTIONS[1], bucket: "Utilities & Taxes", paidBy: "Z", amount: 37.0 },
  { date: "2026-07-08", description: "State Intangible Tax", category: "Transfer Tax", section: SECTIONS[1], bucket: "Utilities & Taxes", paidBy: "Z", amount: 275.4 },

  // 3. Property Insurance, Wholesale Assignments & Closing Admin
  { date: "2026-07-08", description: "Homeowner's Insurance Premium (Runnels Insurance)", category: "Property Insurance", section: SECTIONS[2], bucket: "Insurance & Legal", paidBy: "Z", amount: 1927.55 },
  { date: "2026-07-08", description: "Assignment Fee 1 (Andrew The Home Buyer LLC)", category: "Wholesale Fee", section: SECTIONS[2], bucket: "Financing & Lender", paidBy: "Z", amount: 3500.0 },
  { date: "2026-07-08", description: "Assignment Fee 2 (I'm in Mud, LLC)", category: "Wholesale Fee", section: SECTIONS[2], bucket: "Financing & Lender", paidBy: "Z", amount: 3500.0 },
  { date: "2026-07-08", description: "Assignment Fee 3 (Pinellas Equities LLC)", category: "Wholesale Fee", section: SECTIONS[2], bucket: "Financing & Lender", paidBy: "Z", amount: 5000.0 },
  { date: "2026-07-08", description: "Brokerage Fee (New Western Acquisitions)", category: "Brokerage Fee", section: SECTIONS[2], bucket: "Financing & Lender", paidBy: "Z", amount: 395.0 },
  { date: "2026-07-08", description: "Closing Admin & Notary (Mobile Notary, Research, Tech)", category: "Closing Admin", section: SECTIONS[2], bucket: "Insurance & Legal", paidBy: "Z", amount: 734.25 },

  // 4. Site Prep, Waste & Landscaping Cleanout
  { date: "", description: "On-Site Waste Dumpster Rental", category: "Demo & Waste", section: SECTIONS[3], bucket: "Demo, Waste & Landscape", paidBy: "Z", amount: 450.0 },
  { date: "", description: "Gardener Initial Property & Yard Cleanout", category: "Landscaping", section: SECTIONS[3], bucket: "Demo, Waste & Landscape", paidBy: "Z", amount: 325.0 },

  // 5. Materials, Tools & Store Purchases
  { date: "2026-07-16", description: "Home Depot - Materials & Hardware (Day 1)", category: "Materials/Tools", section: SECTIONS[4], bucket: "Materials & Hardware", paidBy: "A", amount: 112.29 },
  { date: "2026-07-17", description: "Home Depot - Materials & Lumber Supply", category: "Materials/Tools", section: SECTIONS[4], bucket: "Materials & Hardware", paidBy: "Z", amount: 913.62 },

  // 6. Direct Labor, Contractor Pay & Crew Lodging
  { date: "", description: "Carlos - Hotel Accommodation (4 Nights)", category: "Crew Lodging", section: SECTIONS[5], bucket: "Labor & Subcontractors", paidBy: "A", amount: 200.0 },
  { date: "", description: "Carlos - On-Site Direct Labor (2 Days)", category: "Contractor Labor", section: SECTIONS[5], bucket: "Labor & Subcontractors", paidBy: "Z", amount: 400.0 },

  // 7. Utilities & Operational Costs
  { date: "", description: "Water Service Deposit", category: "Utility Deposit", section: SECTIONS[6], bucket: "Utilities & Taxes", paidBy: "A", amount: 235.0 },
];

// The totals the original PDF header displayed (kept for reconciliation).
const PDF_STATED_TOTALS = { partnerA: 547.29, partnerZ: 31772.62, total: 32319.91 };
