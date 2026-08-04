// A pre-flight check for the whole app. Run it before pushing anything:
//
//   node tools/check.js
//
// It does not test behaviour — that is what the browser is for. It catches the
// class of mistake that is silent until the one moment it matters: a button
// wired to an element that does not exist, a file the service worker promises
// to cache but which was never committed, a migration in the repo that the
// setup instructions forgot to mention.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const exists = (f) => fs.existsSync(path.join(ROOT, f.replace(/^\.\//, "")));
const problems = [];
const note = (line) => console.log("  " + line);

const html = read("index.html");
const app = read("app.js");

// Ids in the markup, plus the ones the app writes into the page itself.
const markupIds = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const renderedIds = [...app.matchAll(/id=\\?["']([a-z][\w-]*)\\?["']/g)].map((m) => m[1]);
const ids = new Set([...markupIds, ...renderedIds]);

// 1. Every element the code reaches for has to exist somewhere.
const wanted = new Set([...app.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]));
for (const id of wanted) {
  if (!ids.has(id)) problems.push("app.js looks for #" + id + ", which nothing ever creates");
}
note(wanted.size + " element ids referenced, " + ids.size + " defined in the markup or rendered by the app");

// 2. A duplicate id makes getElementById return whichever came first, which is
//    a bug that only shows up on the second one.
const seen = new Set();
for (const id of markupIds) {
  if (seen.has(id)) problems.push("index.html defines #" + id + " more than once");
  seen.add(id);
}

// 3. Everything the page loads has to be there.
for (const m of html.matchAll(/(?:src|href)="(?!https?:)([^"#?]+\.(?:js|css|png|webmanifest))"/g)) {
  if (!exists(m[1])) problems.push("index.html points at " + m[1] + ", which is missing");
}

// 4. The service worker precaches by name. A missing file fails the install
//    quietly and the app simply will not open offline.
const sw = read("sw.js");
const shell = [...sw.matchAll(/"(\.\/[^"]*)"/g)].map((m) => m[1]);
for (const f of shell) {
  if (f !== "./" && !exists(f)) problems.push("sw.js precaches " + f + ", which is missing");
}
for (const m of html.matchAll(/<script src="((?!https?:)[^"]+)"><\/script>/g)) {
  if (!shell.includes("./" + m[1])) problems.push("index.html loads " + m[1] + " but sw.js does not cache it");
}
note(shell.length + " files precached by the service worker");

// 5. The icons the manifest promises.
const manifest = JSON.parse(read("manifest.webmanifest"));
for (const icon of manifest.icons) {
  if (!exists(icon.src)) problems.push("the manifest promises " + icon.src + ", which is missing");
}
note(manifest.icons.length + " icons, scope " + manifest.scope);

// 6. The setup instructions are the only thing standing between a new database
//    and a broken one, so the list has to match the repo exactly.
const readme = read("README.md");
const listed = [...readme.matchAll(/\(([a-z0-9-]+\.sql)\)/g)].map((m) => m[1]);
const onDisk = fs.readdirSync(ROOT).filter((f) => f.endsWith(".sql"));
for (const f of onDisk) if (!listed.includes(f)) problems.push(f + " is in the repo but the README never tells you to run it");
for (const f of listed) if (!onDisk.includes(f)) problems.push("the README tells you to run " + f + ", which is missing");
note(onDisk.length + " migrations, all listed in the setup steps");

// 7. Only the anon key belongs in the browser.
const config = read("config.js");
const assigned = config.replace(/^\s*\/\/.*$/gm, "");
if (/service_role|sk_live|sk_test/.test(assigned)) problems.push("config.js looks like it holds a secret key");
if (!/https:\/\/[a-z0-9]+\.supabase\.co/.test(assigned)) problems.push("config.js has no Supabase URL in it");
if (!/eyJ[\w-]+\.[\w-]+\.[\w-]+/.test(assigned)) problems.push("config.js has no Supabase key in it");

// 8. Escape sequences that were meant to be characters, sitting in prose where
//    nothing will ever decode them.
for (const f of fs.readdirSync(ROOT).filter((x) => /\.(md|html|webmanifest)$/.test(x))) {
  const stray = read(f).match(/\\u[0-9a-f]{4}/gi);
  if (stray) problems.push(f + " has unrendered escape sequences: " + [...new Set(stray)].join(", "));
}

console.log("");
if (problems.length) {
  for (const p of problems) console.log("  PROBLEM  " + p);
  console.log("\n" + problems.length + " problem" + (problems.length === 1 ? "" : "s") + " to fix");
  process.exit(1);
}
console.log("Nothing out of place.");
