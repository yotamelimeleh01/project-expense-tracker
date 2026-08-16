// Paperwork for the demo account.
//
// A sample project with no documents attached is not a sample project, so this
// makes real files rather than placeholders: settlement statements, supplier
// invoices and photographed till receipts. Everything is generated from
// scratch with nothing but Node's own zlib, because the app itself has no
// dependencies and its tools should not either.
//
// Exports: receiptPdf, altaPdf, simpleDocPdf, receiptPhoto.
const zlib = require("zlib");

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------
// Enough of the format to lay text on a page: one page, two Helvetica faces,
// an uncompressed content stream. Anything more would be showing off.

const PAGE_W = 612; // US Letter at 72dpi
const PAGE_H = 792;

function esc(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

// A block is { x, y, text, size, bold, align, gray }. y counts down from the
// top of the page, which is how anyone laying out a page actually thinks.
function drawBlocks(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.rule) {
      const g = b.gray === undefined ? 0.8 : b.gray;
      out.push(
        `${g} G ${b.width || 0.7} w ${b.x} ${PAGE_H - b.y} m ${b.x2} ${PAGE_H - b.y} l S`
      );
      continue;
    }
    const size = b.size || 10;
    const font = b.bold ? "/F2" : "/F1";
    let x = b.x;
    if (b.align === "right") x = b.x - textWidth(b.text, size, b.bold);
    else if (b.align === "center") x = b.x - textWidth(b.text, size, b.bold) / 2;
    const g = b.gray === undefined ? 0 : b.gray;
    out.push(
      `BT ${g} g ${font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${(PAGE_H - b.y).toFixed(2)} Tm (${esc(b.text)}) Tj ET`
    );
  }
  return out.join("\n");
}

// Helvetica advance widths, near enough for right-aligning money columns.
const WIDTHS = { " ": 278, ".": 278, ",": 278, "-": 333, "$": 556, "/": 278, ":": 278 };
function textWidth(text, size, bold) {
  let units = 0;
  for (const ch of String(text)) {
    if (WIDTHS[ch] !== undefined) units += WIDTHS[ch];
    else if (ch >= "0" && ch <= "9") units += 556;
    else if (ch >= "A" && ch <= "Z") units += bold ? 722 : 667;
    else units += bold ? 556 : 500;
  }
  return (units / 1000) * size;
}

function buildPdf(blocks, title) {
  const content = Buffer.from(drawBlocks(blocks), "latin1");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      "/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>",
    { stream: content },
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Title (${esc(title || "Document")}) /Producer (FlipSmart demo seeder) >>`,
  ];

  const parts = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  let offset = parts[0].length;
  const offsets = [];

  objects.forEach((obj, i) => {
    offsets.push(offset);
    let body;
    if (typeof obj === "object" && obj.stream) {
      body = Buffer.concat([
        Buffer.from(`${i + 1} 0 obj\n<< /Length ${obj.stream.length} >>\nstream\n`, "latin1"),
        obj.stream,
        Buffer.from("\nendstream\nendobj\n", "latin1"),
      ]);
    } else {
      body = Buffer.from(`${i + 1} 0 obj\n${obj}\nendobj\n`, "latin1");
    }
    parts.push(body);
    offset += body.length;
  });

  const xrefAt = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += String(o).padStart(10, "0") + " 00000 n \n";
  xref +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\n` +
    `startxref\n${xrefAt}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "latin1"));

  return Buffer.concat(parts);
}

const usd = (n) =>
  "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// --- Supplier invoice / receipt -------------------------------------------
function receiptPdf(r) {
  const b = [];
  let y = 66;
  b.push({ x: 56, y, text: r.vendor.toUpperCase(), size: 17, bold: true });
  y += 16;
  b.push({ x: 56, y, text: r.vendorAddress || "", size: 9, gray: 0.42 });
  y += 12;
  b.push({ x: 56, y, text: r.vendorPhone || "", size: 9, gray: 0.42 });

  b.push({ x: 556, y: 66, text: r.title || "INVOICE", size: 15, bold: true, align: "right" });
  b.push({ x: 556, y: 84, text: "No. " + r.number, size: 9, align: "right", gray: 0.42 });
  b.push({ x: 556, y: 96, text: r.date, size: 9, align: "right", gray: 0.42 });

  y = 122;
  b.push({ rule: true, x: 56, x2: 556, y });
  y += 20;
  b.push({ x: 56, y, text: "BILL TO", size: 8, bold: true, gray: 0.45 });
  b.push({ x: 300, y, text: "JOB SITE", size: 8, bold: true, gray: 0.45 });
  y += 13;
  b.push({ x: 56, y, text: r.billTo, size: 10 });
  b.push({ x: 300, y, text: r.jobSite, size: 10 });

  y += 34;
  b.push({ x: 56, y, text: "DESCRIPTION", size: 8, bold: true, gray: 0.45 });
  b.push({ x: 400, y, text: "QTY", size: 8, bold: true, gray: 0.45, align: "right" });
  b.push({ x: 556, y, text: "AMOUNT", size: 8, bold: true, gray: 0.45, align: "right" });
  y += 6;
  b.push({ rule: true, x: 56, x2: 556, y, gray: 0.65 });

  for (const line of r.lines) {
    y += 18;
    b.push({ x: 56, y, text: line.desc, size: 10 });
    b.push({ x: 400, y, text: String(line.qty), size: 10, align: "right" });
    b.push({ x: 556, y, text: usd(line.amount), size: 10, align: "right" });
  }

  y += 12;
  b.push({ rule: true, x: 340, x2: 556, y, gray: 0.65 });
  const sub = r.lines.reduce((s, l) => s + l.amount, 0);
  const tax = r.tax || 0;
  y += 18;
  b.push({ x: 470, y, text: "Subtotal", size: 10, align: "right", gray: 0.4 });
  b.push({ x: 556, y, text: usd(sub), size: 10, align: "right" });
  if (tax) {
    y += 15;
    b.push({ x: 470, y, text: "Sales tax", size: 10, align: "right", gray: 0.4 });
    b.push({ x: 556, y, text: usd(tax), size: 10, align: "right" });
  }
  y += 8;
  b.push({ rule: true, x: 340, x2: 556, y, gray: 0.65 });
  y += 20;
  b.push({ x: 470, y, text: "TOTAL", size: 12, bold: true, align: "right" });
  b.push({ x: 556, y, text: usd(sub + tax), size: 12, bold: true, align: "right" });

  y += 40;
  b.push({ x: 56, y, text: "Paid by " + (r.method || "company card") + ". Thank you.", size: 9, gray: 0.45 });
  b.push({ x: 56, y: 756, text: "Generated for the FlipSmart demo account. Not a real invoice.", size: 7.5, gray: 0.6 });

  return buildPdf(b, r.vendor + " " + r.number);
}

// --- ALTA settlement statement --------------------------------------------
function altaPdf(a) {
  const b = [];
  b.push({ x: 306, y: 62, text: "ALTA SETTLEMENT STATEMENT", size: 15, bold: true, align: "center" });
  b.push({ x: 306, y: 80, text: a.side === "seller" ? "SELLER" : "BUYER / BORROWER", size: 10, align: "center", gray: 0.4 });
  b.push({ rule: true, x: 56, x2: 556, y: 96 });

  let y = 122;
  const pair = (label, value) => {
    b.push({ x: 56, y, text: label, size: 8, bold: true, gray: 0.45 });
    b.push({ x: 150, y, text: value, size: 10 });
    y += 17;
  };
  pair("FILE NO.", a.file);
  pair("SETTLEMENT", a.settlementDate);
  pair("PROPERTY", a.property);
  pair("BUYER", a.buyer);
  pair("SELLER", a.seller);
  if (a.lender) pair("LENDER", a.lender);
  pair("SETTLEMENT AGENT", a.agent || "Keystone Title & Escrow, LLC");

  y += 10;
  b.push({ rule: true, x: 56, x2: 556, y });
  y += 22;
  b.push({ x: 56, y, text: "DESCRIPTION", size: 8, bold: true, gray: 0.45 });
  b.push({ x: 460, y, text: "DEBIT", size: 8, bold: true, gray: 0.45, align: "right" });
  b.push({ x: 556, y, text: "CREDIT", size: 8, bold: true, gray: 0.45, align: "right" });
  y += 6;
  b.push({ rule: true, x: 56, x2: 556, y, gray: 0.65 });

  let debits = 0;
  let credits = 0;
  for (const row of a.rows) {
    y += 17;
    if (row.heading) {
      b.push({ x: 56, y, text: row.heading, size: 9, bold: true, gray: 0.3 });
      continue;
    }
    b.push({ x: 66, y, text: row.desc, size: 9.5 });
    if (row.debit) {
      b.push({ x: 460, y, text: usd(row.debit), size: 9.5, align: "right" });
      debits += row.debit;
    }
    if (row.credit) {
      b.push({ x: 556, y, text: usd(row.credit), size: 9.5, align: "right" });
      credits += row.credit;
    }
  }

  y += 10;
  b.push({ rule: true, x: 56, x2: 556, y, gray: 0.65 });
  y += 19;
  b.push({ x: 66, y, text: "SUBTOTALS", size: 10, bold: true });
  b.push({ x: 460, y, text: usd(debits), size: 10, bold: true, align: "right" });
  b.push({ x: 556, y, text: usd(credits), size: 10, bold: true, align: "right" });

  y += 22;
  const due = debits - credits;
  b.push({
    x: 66,
    y,
    text: due >= 0 ? "CASH DUE FROM BORROWER AT SETTLEMENT" : "CASH TO SELLER AT SETTLEMENT",
    size: 10,
    bold: true,
  });
  b.push({ x: 556, y, text: usd(Math.abs(due)), size: 11, bold: true, align: "right" });

  y += 46;
  b.push({ x: 56, y, text: "Certified a true and correct copy of the settlement of this transaction.", size: 9, gray: 0.4 });
  y += 40;
  b.push({ rule: true, x: 56, x2: 260, y, gray: 0.55 });
  b.push({ rule: true, x: 330, x2: 534, y, gray: 0.55 });
  y += 13;
  b.push({ x: 56, y, text: "Settlement Agent", size: 8, gray: 0.45 });
  b.push({ x: 330, y, text: "Borrower", size: 8, gray: 0.45 });

  b.push({ x: 56, y: 756, text: "Generated for the FlipSmart demo account. Not a real settlement statement.", size: 7.5, gray: 0.6 });
  return buildPdf(b, "ALTA Settlement Statement " + a.file);
}

// --- Any other one-page document ------------------------------------------
function simpleDocPdf(d) {
  const b = [];
  b.push({ x: 56, y: 66, text: d.title.toUpperCase(), size: 15, bold: true });
  b.push({ x: 556, y: 66, text: d.date || "", size: 9, align: "right", gray: 0.42 });
  b.push({ rule: true, x: 56, x2: 556, y: 84 });

  let y = 112;
  for (const row of d.rows) {
    if (row.heading) {
      y += 8;
      b.push({ x: 56, y, text: row.heading, size: 10, bold: true, gray: 0.25 });
      y += 18;
      continue;
    }
    if (row.text) {
      b.push({ x: 56, y, text: row.text, size: 9.5, gray: 0.3 });
      y += 16;
      continue;
    }
    b.push({ x: 66, y, text: row.label, size: 9.5 });
    b.push({ x: 556, y, text: row.value, size: 9.5, align: "right", bold: !!row.bold });
    y += 16;
  }

  b.push({ x: 56, y: 756, text: "Generated for the FlipSmart demo account.", size: 7.5, gray: 0.6 });
  return buildPdf(b, d.title);
}

// ---------------------------------------------------------------------------
// PNG — a photographed till receipt
// ---------------------------------------------------------------------------
// Some receipts arrive as paper and get photographed, so the demo needs those
// too. A 3x5 pixel font keeps the vendor and the total readable at thumbnail
// size without dragging in a font file.

// prettier-ignore
const FONT = {
  "A":["010","101","111","101","101"], "B":["110","101","110","101","110"],
  "C":["011","100","100","100","011"], "D":["110","101","101","101","110"],
  "E":["111","100","110","100","111"], "F":["111","100","110","100","100"],
  "G":["011","100","101","101","011"], "H":["101","101","111","101","101"],
  "I":["111","010","010","010","111"], "J":["001","001","001","101","010"],
  "K":["101","110","100","110","101"], "L":["100","100","100","100","111"],
  "M":["101","111","111","101","101"], "N":["101","111","111","111","101"],
  "O":["010","101","101","101","010"], "P":["110","101","110","100","100"],
  "Q":["010","101","101","111","011"], "R":["110","101","110","110","101"],
  "S":["011","100","010","001","110"], "T":["111","010","010","010","010"],
  "U":["101","101","101","101","011"], "V":["101","101","101","010","010"],
  "W":["101","101","111","111","101"], "X":["101","101","010","101","101"],
  "Y":["101","101","010","010","010"], "Z":["111","001","010","100","111"],
  "0":["111","101","101","101","111"], "1":["010","110","010","010","111"],
  "2":["110","001","010","100","111"], "3":["110","001","010","001","110"],
  "4":["101","101","111","001","001"], "5":["111","100","110","001","110"],
  "6":["011","100","110","101","010"], "7":["111","001","010","010","010"],
  "8":["010","101","010","101","010"], "9":["010","101","011","001","110"],
  "$":["000","000","000","000","000"], ".":["000","000","000","000","010"],
  ",":["000","000","000","010","010"], "-":["000","000","111","000","000"],
  "/":["001","001","010","100","100"], ":":["000","010","000","010","000"],
  "#":["101","111","101","111","101"], "*":["101","010","101","000","000"],
  " ":["000","000","000","000","000"],
};

function makeCanvas(w, h, fill) {
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = fill[0];
    px[i * 4 + 1] = fill[1];
    px[i * 4 + 2] = fill[2];
    px[i * 4 + 3] = 255;
  }
  return { w, h, px };
}

function dot(c, x, y, rgb) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 4;
  c.px[i] = rgb[0];
  c.px[i + 1] = rgb[1];
  c.px[i + 2] = rgb[2];
}

function rect(c, x, y, w, h, rgb) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) dot(c, x + i, y + j, rgb);
}

function write(c, text, x, y, scale, rgb) {
  let cx = x;
  for (const raw of String(text).toUpperCase()) {
    const g = FONT[raw] || FONT[" "];
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (g[row][col] === "1") rect(c, cx + col * scale, y + row * scale, scale, scale, rgb);
      }
    }
    cx += 4 * scale;
  }
  return cx;
}

function writeRight(c, text, right, y, scale, rgb) {
  const w = String(text).length * 4 * scale - scale;
  write(c, text, right - w, y, scale, rgb);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(c) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.w, 0);
  ihdr.writeUInt32BE(c.h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = c.w * 4;
  const raw = Buffer.alloc(c.h * (stride + 1));
  for (let y = 0; y < c.h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    c.px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function receiptPhoto(r) {
  const W = 520;
  const H = 720;
  const desk = [38, 44, 54];
  const paper = [246, 244, 238];
  const ink = [46, 48, 52];
  const faded = [128, 130, 134];

  const c = makeCanvas(W, H, desk);

  // The receipt itself, sitting on a dark surface with a soft edge shadow.
  const px = 46;
  const py = 34;
  const pw = W - px * 2;
  const ph = H - py * 2;
  rect(c, px + 7, py + 9, pw, ph, [24, 28, 36]);
  rect(c, px, py, pw, ph, paper);

  // Paper is never perfectly flat under a phone camera.
  for (let i = 0; i < 5200; i++) {
    const x = px + Math.floor(Math.random() * pw);
    const y = py + Math.floor(Math.random() * ph);
    const n = 236 + Math.floor(Math.random() * 16);
    dot(c, x, y, [n, n - 2, n - 6]);
  }

  const left = px + 26;
  const right = px + pw - 26;
  let y = py + 36;

  write(c, r.vendor, left, y, 4, ink);
  y += 34;
  write(c, r.vendorLine || "", left, y, 2, faded);
  y += 20;
  write(c, r.date + "  " + (r.time || "14:22"), left, y, 2, faded);
  y += 26;
  rect(c, left, y, right - left, 1, [200, 198, 192]);
  y += 20;

  for (const line of r.lines) {
    write(c, line.desc.slice(0, 20), left, y, 2, ink);
    writeRight(c, usd(line.amount).replace("$", ""), right, y, 2, ink);
    y += 18;
  }

  y += 8;
  rect(c, left, y, right - left, 1, [200, 198, 192]);
  y += 20;
  const sub = r.lines.reduce((s, l) => s + l.amount, 0);
  const tax = r.tax || 0;
  write(c, "SUBTOTAL", left, y, 2, faded);
  writeRight(c, usd(sub).replace("$", ""), right, y, 2, ink);
  y += 18;
  write(c, "TAX", left, y, 2, faded);
  writeRight(c, usd(tax).replace("$", ""), right, y, 2, ink);
  y += 26;
  // No currency symbol: a dollar sign drawn 3 pixels wide reads as a pound.
  write(c, "TOTAL USD", left, y, 3, ink);
  writeRight(c, usd(sub + tax).replace("$", ""), right, y, 4, ink);
  y += 40;
  rect(c, left, y, right - left, 1, [200, 198, 192]);
  y += 20;
  write(c, (r.method || "VISA") + " ****" + (r.card || "4417"), left, y, 2, faded);
  y += 18;
  write(c, "AUTH " + (r.auth || "004821"), left, y, 2, faded);
  y += 30;
  write(c, "THANK YOU", left, y, 2, faded);

  // A barcode-ish block, because every till receipt has one.
  y += 34;
  let bx = left;
  while (bx < right - 4) {
    const w = 1 + Math.floor(Math.random() * 4);
    if (Math.random() > 0.35) rect(c, bx, y, w, 30, ink);
    bx += w + 1 + Math.floor(Math.random() * 3);
  }

  return encodePng(c);
}

module.exports = { receiptPdf, altaPdf, simpleDocPdf, receiptPhoto, usd };
