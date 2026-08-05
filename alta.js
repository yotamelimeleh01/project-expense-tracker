// ===========================================================================
// Reading a settlement statement.
//
// An ALTA statement and a Closing Disclosure are regulated forms. The line
// numbers are fixed, the columns are always the same, and the wording barely
// moves between title companies. That makes this a parsing job rather than a
// guessing one, which is what you want: it runs on the device, nothing is
// sent anywhere, it costs nothing per document, and when it cannot read a
// statement it says so instead of inventing a figure.
//
// Everything below the reader is a pure function of positioned text, so the
// hard part can be tested without a PDF anywhere near it.
// ===========================================================================

// A cell is one run of text with an x position. Two runs on the same line get
// stuck together when there is no real gap, because a PDF will happily split
// "1,234.56" into "1,234" and ".56" and think nothing of it.
function altaMergeCells(cells) {
  const out = [];
  for (const c of cells) {
    const last = out[out.length - 1];
    if (last && c.x - (last.x + last.w) < 1.5) {
      last.str += c.str;
      last.w = c.x + c.w - last.x;
    } else {
      out.push({ x: c.x, w: c.w, str: c.str });
    }
  }
  return out;
}

// Text in a PDF has no notion of a line, only of a position. Anything within
// a couple of points of the same height is the same row.
function altaRows(items) {
  const rows = [];
  const cells = items
    .filter((i) => i.str && i.str.trim())
    .map((i) => ({
      x: i.transform ? i.transform[4] : i.x,
      y: i.transform ? i.transform[5] : i.y,
      w: i.width || 0,
      str: i.str,
    }));
  for (const c of cells) {
    let row = rows.find((r) => Math.abs(r.y - c.y) <= 2.5);
    if (!row) {
      row = { y: c.y, cells: [] };
      rows.push(row);
    }
    row.cells.push(c);
  }
  rows.sort((a, b) => b.y - a.y);
  for (const r of rows) {
    r.cells.sort((a, b) => a.x - b.x);
    r.cells = altaMergeCells(r.cells);
    r.text = r.cells.map((c) => c.str).join(" ").replace(/\s+/g, " ").trim();
  }
  return rows;
}

// Money on these forms is "1,234.56", "$1,234.56" or "(1,234.56)" for a
// negative. Anything else is a date, a line number or a percentage.
function altaMoney(s) {
  const t = String(s).trim().replace(/[$,\s]/g, "");
  if (!/^\(?-?\d{1,12}\.\d{2}\)?$/.test(t)) return null;
  const negative = t.startsWith("(") || t.startsWith("-");
  const n = parseFloat(t.replace(/[()\-]/g, ""));
  if (isNaN(n)) return null;
  return negative ? -n : n;
}

// The header row names the columns. An ALTA says "Debit" and "Credit" under
// the borrower's half of the page; a Closing Disclosure says "Borrower-Paid".
// Either way, where that word sits is where the numbers we want line up.
function altaColumns(rows) {
  for (const row of rows) {
    const debit = row.cells.find((c) => /^debits?$/i.test(c.str.trim()));
    if (debit) {
      const credit = row.cells.find((c) => /^credits?$/i.test(c.str.trim()) && c.x > debit.x);
      return { debitX: debit.x, creditX: credit ? credit.x : null };
    }
    const paid = row.cells.find((c) => /borrower\s*-?\s*paid/i.test(c.str));
    if (paid) {
      const seller = row.cells.find((c) => /seller\s*-?\s*paid/i.test(c.str) && c.x > paid.x);
      return { debitX: paid.x, creditX: seller ? seller.x : null };
    }
  }
  return null;
}

// Which of the numbers on this row is the borrower's debit. With two columns
// it is whichever sits nearer the debit heading; with one it is the last
// number on the line, which is where a single-column form puts the charge.
function altaAmountOn(row, col) {
  const monies = [];
  for (const c of row.cells) {
    const n = altaMoney(c.str);
    if (n !== null) monies.push({ x: c.x, n });
  }
  if (!monies.length) return null;
  if (!col) return monies[monies.length - 1];
  if (col.creditX == null) {
    const near = monies.find((m) => Math.abs(m.x - col.debitX) < 90);
    return near || null;
  }
  const pick = monies.find(
    (m) => Math.abs(m.x - col.debitX) <= Math.abs(m.x - col.creditX)
  );
  return pick || null;
}

// Lines that are real money but not a cost you incurred. The purchase price
// is already a field on the project, a loan amount is money coming in, and a
// total is the same money counted twice. Importing any of them would put the
// deal thousands of dollars out.
const ALTA_SKIP = [
  /contract sales price/i,
  /sale price of (the )?property/i,
  /purchase price/i,
  /personal property/i,
  /principal amount of (the )?(new )?loan/i,
  /^\s*(new )?loan amount/i,
  /loan proceeds/i,
  /deposit|earnest money/i,
  /excess deposit/i,
  /payoff of (the )?(first|second|existing)/i,
  /cash (from|to) (the )?(borrower|buyer|seller)/i,
  /^balance due/i,
  /^sub-?totals?/i,
  /^totals?\b/i,
  /gross amount due/i,
  /less amounts? paid/i,
  /(seller|lender|closing cost) credit/i,
  /credit from seller/i,
  /due (from|to) (the )?(borrower|buyer|seller)/i,
  /^adjustments for items/i,
  /paid by others/i,
];

// Where a charge belongs. First match wins, so the specific rules come first.
// The names are the built-in ones; whatever the project's own list actually
// says is resolved against these later.
const ALTA_RULES = [
  { re: /wood destroying|termite|pest inspection/i, cat: "Permits & Inspections" },
  { re: /home inspection|inspection fee|appraisal|re-?inspection/i, cat: "Permits & Inspections" },
  { re: /permit/i, cat: "Permits & Inspections" },
  { re: /(county|city|state|school|borough) tax|property tax|tax(es)? proration|taxes? from|tax certificate/i,
    cat: "Utilities, Insurance, Taxes & Loan" },
  { re: /hazard insurance|homeowner'?s insurance|insurance premium|flood insurance|wind (mitigation|insurance)/i,
    cat: "Utilities, Insurance, Taxes & Loan" },
  { re: /\bhoa\b|association (dues|fee)|condo(minium)? fee|estoppel/i,
    cat: "Utilities, Insurance, Taxes & Loan" },
  { re: /water|sewer|electric|gas (bill|service)|utility/i, cat: "Utilities, Insurance, Taxes & Loan" },
  { re: /prepaid interest|interest from|per diem interest/i, cat: "Utilities, Insurance, Taxes & Loan" },
  { re: /escrow (reserve|deposit)|reserves? deposited/i, cat: "Utilities, Insurance, Taxes & Loan" },
  { re: /commission|listing (agent|broker)|selling (agent|broker)/i, cat: "Sale & Disposition Costs" },
];

function altaCategoryFor(description) {
  for (const rule of ALTA_RULES) {
    if (rule.re.test(description)) return rule.cat;
  }
  return "Closing & Deal Costs";
}

// 03/14/2024, 3-14-24 or 2024-03-14, all of which turn up.
function altaDate(text) {
  let m = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = text.match(/\b(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})\b/);
  if (!m) return "";
  const month = Number(m[1]);
  const day = Number(m[2]);
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// A description is everything to the left of the first number on the row,
// minus the line number the form puts in front of it.
function altaDescription(row) {
  const parts = [];
  for (const c of row.cells) {
    if (altaMoney(c.str) !== null) break;
    parts.push(c.str);
  }
  return parts
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/^\d{2,4}\.?\s*/, "")
    .replace(/^[A-H]\.\s*/, "")
    .replace(/^\d{2}\.\s*/, "")
    .replace(/[.\s]+$/, "")
    .trim();
}

function altaParse(rows) {
  const col = altaColumns(rows);
  const lines = [];
  let settlementDate = "";
  let salesPrice = 0;

  for (const row of rows) {
    const text = row.text;
    if (!text) continue;

    if (!settlementDate && /(settlement|disbursement|closing) date/i.test(text)) {
      settlementDate = altaDate(text);
    }

    const found = altaAmountOn(row, col);
    if (!found || !found.n) continue;

    if (!salesPrice && /contract sales price|sale price of (the )?property|purchase price/i.test(text)) {
      salesPrice = Math.abs(found.n);
    }

    if (ALTA_SKIP.some((re) => re.test(text))) continue;

    const description = altaDescription(row);
    // A row with a number and no words is a column total that lost its label.
    if (description.length < 3) continue;
    if (found.n <= 0) continue;

    lines.push({
      description,
      amount: found.n,
      category: altaCategoryFor(description),
    });
  }

  return { lines, settlementDate, salesPrice, twoColumn: !!col };
}

// ===========================================================================
// The reader itself. pdf.js is a big download, so it is fetched the first
// time somebody actually uploads a settlement statement and never before.
// ===========================================================================
const Alta = {
  SOURCE: "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs",
  WORKER: "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs",
  loading: null,

  ready() {
    return typeof window !== "undefined" && !!window.pdfjsLib;
  },

  load() {
    if (this.ready()) return Promise.resolve(window.pdfjsLib);
    if (this.loading) return this.loading;
    this.loading = import(this.SOURCE)
      .then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = this.WORKER;
        window.pdfjsLib = lib;
        return lib;
      })
      .catch(() => {
        this.loading = null;
        throw new Error("Could not download the PDF reader.");
      });
    return this.loading;
  },

  // isEvalSupported is off deliberately. A settlement statement arrives by
  // email from a title company and there is no reason on earth for one to be
  // running code on the way past.
  async rows(buffer) {
    const lib = await this.load();
    const pdf = await lib.getDocument({
      data: buffer,
      isEvalSupported: false,
      disableAutoFetch: true,
    }).promise;
    const all = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      for (const row of altaRows(content.items)) all.push(row);
      page.cleanup();
    }
    return { rows: all, pages: pdf.numPages };
  },

  async scan(buffer) {
    const read = await this.rows(buffer);
    // A statement that was scanned rather than printed to PDF has pictures of
    // words in it, not words. Saying so beats handing back an empty list.
    if (!read.rows.length) {
      throw new Error(
        "This looks like a scan rather than a text PDF, so there is nothing to read. " +
          "Ask the title company for the original."
      );
    }
    const parsed = altaParse(read.rows);
    parsed.pages = read.pages;
    return parsed;
  },
};
