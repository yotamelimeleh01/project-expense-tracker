// Draws the app icons from scratch and writes them as PNGs.
//
// Run by hand when the mark changes:  node tools/make-icons.js
//
// Doing it this way rather than checking in a binary from a design tool means
// the icon is readable, reviewable and reproducible. No dependencies: the PNG
// is assembled byte by byte and deflated with the zlib that ships with Node.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const NAVY = [15, 32, 56];
const WHITE = [255, 255, 255];
const BLUE = [47, 111, 237];

// ---------------------------------------------------------------------------
// The mark: a roof over three rising bars. A property, and the numbers on it.
// Coordinates are 0..1 so the same description works at any size.
// ---------------------------------------------------------------------------
function inTriangle(x, y, ax, ay, bx, by, cx, cy) {
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  const a = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
  const b = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
  return a >= 0 && b >= 0 && a + b <= 1;
}

function inRect(x, y, x0, y0, x1, y1) {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

// A square with the corners taken off, used for the standalone icon. The
// maskable icon skips this because the platform does its own masking.
function inRoundedSquare(x, y, r) {
  if (x < r && y < r) return (x - r) ** 2 + (y - r) ** 2 <= r * r;
  if (x > 1 - r && y < r) return (x - (1 - r)) ** 2 + (y - r) ** 2 <= r * r;
  if (x < r && y > 1 - r) return (x - r) ** 2 + (y - (1 - r)) ** 2 <= r * r;
  if (x > 1 - r && y > 1 - r) return (x - (1 - r)) ** 2 + (y - (1 - r)) ** 2 <= r * r;
  return true;
}

// Returns [r, g, b, a] for a point, or null for nothing at all.
function sample(x, y, opts) {
  // The art sits inside a safe zone so a circular or squircle mask cannot
  // clip it. Maskable icons need a lot more room than they look like they do.
  const s = opts.inset;
  const u = (x - 0.5) / s + 0.5;
  const v = (y - 0.5) / s + 0.5;

  const background = opts.rounded ? inRoundedSquare(x, y, 0.22) : true;
  if (!background) return null;

  if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
    if (inTriangle(u, v, 0.5, 0.16, 0.14, 0.47, 0.86, 0.47)) return [...WHITE, 255];
    if (inRect(u, v, 0.20, 0.68, 0.35, 0.86)) return [...WHITE, 255];
    if (inRect(u, v, 0.42, 0.60, 0.57, 0.86)) return [...WHITE, 255];
    if (inRect(u, v, 0.64, 0.52, 0.79, 0.86)) return [...BLUE, 255];
  }
  return [...NAVY, 255];
}

// ---------------------------------------------------------------------------
// Rendering. Four samples per axis, averaged, which is enough to keep the
// roof's diagonal from looking like a staircase.
// ---------------------------------------------------------------------------
const SS = 4;

function render(size, opts) {
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample(
            (pxi + (sx + 0.5) / SS) / size,
            (py + (sy + 0.5) / SS) / size,
            opts
          );
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += c[3]; }
        }
      }
      const n = SS * SS;
      const i = (py * size + pxi) * 4;
      // Premultiplied averaging would darken the edge against transparency, so
      // the colour is averaged over the covered samples only.
      const covered = a / 255;
      px[i] = covered ? Math.round(r / covered) : 0;
      px[i + 1] = covered ? Math.round(g / covered) : 0;
      px[i + 2] = covered ? Math.round(b / covered) : 0;
      px[i + 3] = Math.round(a / n);
    }
  }
  return px;
}

// ---------------------------------------------------------------------------
// PNG container
// ---------------------------------------------------------------------------
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

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  // 10, 11, 12 are compression, filter and interlace, all zero.

  // Every scanline gets a leading filter byte. Filter 0 keeps this simple and
  // deflate still gets the flat colour down to almost nothing.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
const out = path.join(__dirname, "..", "icons");
fs.mkdirSync(out, { recursive: true });

const jobs = [
  ["icon-192.png", 192, { rounded: true, inset: 0.78 }],
  ["icon-512.png", 512, { rounded: true, inset: 0.78 }],
  // Maskable icons are cropped to whatever shape the platform likes, so the
  // art is pulled well inside and the navy runs to every edge.
  ["maskable-512.png", 512, { rounded: false, inset: 0.56 }],
];

for (const [name, size, opts] of jobs) {
  const file = path.join(out, name);
  fs.writeFileSync(file, png(size, render(size, opts)));
  console.log(name + "  " + fs.statSync(file).size + " bytes");
}
