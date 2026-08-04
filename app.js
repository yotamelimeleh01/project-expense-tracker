"use strict";

// ---------- State ----------
let expenses = [];
let draws = [];
let pendingReceipts = [];

// Resize + compress an image file into a small JPEG data URL so receipts stay
// light to store and quick to load.
function compressImage(file, maxDim = 1200, quality = 0.65) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read " + file.name));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not decode " + file.name));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function reportError(action, err) {
  console.error(action, err);
  alert("Could not " + action + ".\n\n" + (err && err.message ? err.message : err));
}

// ---------- Formatting ----------
const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
function money(n) {
  return fmt.format(Number(n) || 0);
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ---------- Totals ----------
function totals() {
  let a = 0, z = 0;
  for (const e of expenses) {
    const amt = Number(e.amount) || 0;
    if (e.paidBy === "A") a += amt;
    else z += amt;
  }
  return { a, z, total: a + z };
}

// ---------- Rendering ----------
function render() {
  document.getElementById("meta-property").textContent = PROPERTY.name;
  document.getElementById("meta-date").textContent = PROPERTY.settlementDate;
  document.getElementById("meta-borrower").textContent = PROPERTY.borrower;
  document.getElementById("foot-property").textContent = PROPERTY.name;

  const t = totals();
  document.getElementById("total-a").textContent = money(t.a);
  document.getElementById("total-z").textContent = money(t.z);
  document.getElementById("total-all").textContent = money(t.total);

  renderAllIn(t);
  renderLoan();
  renderGroups();
}

// ---------- Headline all-in figure ----------
// Total capital deployed into the deal = every dollar the partners have paid
// out of pocket, plus the loan principal the lender funded at closing.
//
// Construction draws are deliberately NOT added here. A draw reimburses an
// expense that is already entered as a line item above, so counting both would
// inflate this number by the amount of every draw. Draws still increase what
// is owed back to the lender, which is what the payoff panel tracks.
function allInNumbers() {
  const t = totals();
  const { funded, totalDraws } = loanNumbers();
  return { partnerCash: t.total, funded, totalDraws, allIn: t.total + funded };
}

function renderAllIn(t) {
  const n = allInNumbers();
  document.getElementById("total-allin").textContent = money(n.allIn);

  const drawNote = n.totalDraws
    ? "<span class=\"allin-note\">" + money(n.totalDraws) +
      " of construction draws are not added again here \u2014 they reimburse expenses already " +
      "counted above. They do raise the lender payoff below.</span>"
    : "";

  document.getElementById("allin-breakdown").innerHTML =
    "Partner cash <strong>" + money(n.partnerCash) + "</strong>" +
    " &nbsp;+&nbsp; Lender funded at closing <strong>" + money(n.funded) + "</strong>" +
    drawNote;
}

// ---------- Loan payoff ----------
function loanNumbers() {
  const totalDraws = draws.reduce((s, d) => s + (Number(d.amount) || 0), 0);
  const funded = LOAN.amount - LOAN.holdback;
  const remaining = LOAN.holdback - totalDraws;
  const payoff = funded + totalDraws;
  return { totalDraws, funded, remaining, payoff };
}

function renderLoan() {
  const n = loanNumbers();
  document.getElementById("loan-lender").textContent =
    LOAN.lender + " \u00b7 Note " + money(LOAN.amount);
  document.getElementById("loan-funded").textContent = money(n.funded);
  document.getElementById("loan-draws").textContent = money(n.totalDraws);
  document.getElementById("loan-payoff").textContent = money(n.payoff);

  const holdbackStatus =
    n.remaining < 0
      ? "over-drawn by <strong>" + money(-n.remaining) + "</strong>"
      : "remaining: <strong>" + money(n.remaining) + "</strong>";
  document.getElementById("loan-holdback-note").innerHTML =
    "Construction holdback " + holdbackStatus + " of " + money(LOAN.holdback) +
    " available to draw. Payoff shown is principal only \u2014 it excludes interest & exit fees.";

  renderDrawsTable();
}

function renderDrawsTable() {
  const el = document.getElementById("draws-table");
  if (!draws.length) {
    el.innerHTML =
      '<p class="empty">No construction draws logged yet \u2014 $0 of the ' +
      money(LOAN.holdback) +
      " holdback drawn. Add a draw each time you pull from the construction reserve.</p>";
    return;
  }
  const rows = draws
    .slice()
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""))
    .map(
      (d) =>
        '<tr>' +
        '<td class="col-date">' + escapeHtml(d.date || "\u2014") + "</td>" +
        "<td>" + escapeHtml(d.note || "Construction draw") + "</td>" +
        '<td class="amount">' + money(d.amount) + "</td>" +
        '<td class="actions-cell">' +
        '<button class="icon-btn" data-draw-edit="' + d.id + '" title="Edit">Edit</button>' +
        '<button class="icon-btn del" data-draw-del="' + d.id + '" title="Delete">Delete</button>' +
        "</td></tr>"
    )
    .join("");
  el.innerHTML =
    "<table><thead><tr>" +
    '<th class="col-date">Date</th><th>Note / Purpose</th>' +
    '<th class="amount">Amount</th><th class="actions-col"></th>' +
    "</tr></thead><tbody>" + rows + "</tbody></table>";

  el.querySelectorAll("[data-draw-edit]").forEach((b) =>
    b.addEventListener("click", () => openDrawModal(b.dataset.drawEdit))
  );
  el.querySelectorAll("[data-draw-del]").forEach((b) =>
    b.addEventListener("click", () => removeDraw(b.dataset.drawDel))
  );
}

function openDrawModal(id) {
  const form = document.getElementById("draw-form");
  const existing = id ? draws.find((d) => d.id === id) : null;
  document.getElementById("draw-modal-title").textContent = existing
    ? "Edit Construction Draw"
    : "Add Construction Draw";
  document.getElementById("d-id").value = existing ? existing.id : "";
  document.getElementById("d-date").value = existing ? existing.date || "" : "";
  document.getElementById("d-amount").value = existing ? existing.amount : "";
  document.getElementById("d-note").value = existing ? existing.note || "" : "";
  document.getElementById("draw-modal").classList.remove("hidden");
  document.getElementById("d-amount").focus();
  form.onsubmit = (ev) => {
    ev.preventDefault();
    saveDrawFromForm();
  };
}

function closeDrawModal() {
  document.getElementById("draw-modal").classList.add("hidden");
}

async function saveDrawFromForm() {
  const id = document.getElementById("d-id").value;
  const record = {
    date: document.getElementById("d-date").value,
    amount: parseFloat(document.getElementById("d-amount").value) || 0,
    note: document.getElementById("d-note").value.trim(),
  };
  try {
    const saved = await Store.saveDraw(record, id || null);
    if (id) {
      const idx = draws.findIndex((d) => d.id === id);
      if (idx > -1) draws[idx] = saved;
    } else {
      draws.push(saved);
    }
  } catch (err) {
    reportError("save this draw", err);
    return;
  }
  closeDrawModal();
  render();

  const n = loanNumbers();
  if (n.remaining < 0) {
    alert(
      "Heads up: total draws (" + money(n.totalDraws) + ") now exceed the " +
        money(LOAN.holdback) + " construction holdback by " + money(-n.remaining) + "."
    );
  }
}

async function removeDraw(id) {
  const d = draws.find((x) => x.id === id);
  if (!d) return;
  if (!confirm("Delete this draw (" + money(d.amount) + ")?")) return;
  try {
    await Store.deleteDraw(id);
  } catch (err) {
    reportError("delete this draw", err);
    return;
  }
  draws = draws.filter((x) => x.id !== id);
  render();
}

function groupKey(e, mode) {
  if (mode === "paidBy") return PARTNERS[e.paidBy] || "Unknown";
  return e.section || "Uncategorized";
}

function orderedGroups(mode) {
  if (mode === "paidBy") return [PARTNERS.A, PARTNERS.Z];
  return SECTIONS.slice();
}

function renderGroups() {
  const mode = document.getElementById("group-select").value;
  const container = document.getElementById("groups");
  container.innerHTML = "";

  const map = new Map();
  for (const e of expenses) {
    const key = groupKey(e, mode);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }

  // Preserve canonical order, then append any extra keys.
  const keys = orderedGroups(mode).filter((k) => map.has(k));
  for (const k of map.keys()) if (!keys.includes(k)) keys.push(k);

  for (const key of keys) {
    const rows = map.get(key);
    const subtotal = rows.reduce((s, e) => s + (Number(e.amount) || 0), 0);

    const block = document.createElement("section");
    block.className = "group-block";
    block.innerHTML = `
      <div class="group-head">
        <span class="group-title">${escapeHtml(key)}</span>
        <span class="group-subtotal">${money(subtotal)}</span>
      </div>
      <table>
        <thead>
          <tr>
            <th class="col-date">Date</th>
            <th>Description / Payable To</th>
            <th>Paid By</th>
            <th class="amount">Amount</th>
            <th class="actions-col"></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(rowHtml).join("")}
        </tbody>
      </table>`;
    container.appendChild(block);
  }

  container.querySelectorAll("[data-edit]").forEach((b) =>
    b.addEventListener("click", () => openModal(b.dataset.edit))
  );
  container.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => removeExpense(b.dataset.del))
  );
  container.querySelectorAll("[data-lightbox]").forEach((img) =>
    img.addEventListener("click", () => openLightbox(img.dataset.lightbox))
  );
}

function rowHtml(e) {
  const badgeClass = e.paidBy === "A" ? "badge a" : "badge";
  const receipts = Array.isArray(e.receipts) ? e.receipts : [];
  const thumbs = receipts
    .map(
      (src, i) =>
        '<img class="thumb" src="' + src + '" alt="Receipt ' + (i + 1) +
        '" data-lightbox="' + src + '" />'
    )
    .join("");
  const notes = e.notes
    ? '<div class="row-notes">' + escapeHtml(e.notes) + "</div>"
    : "";
  const extras = notes || thumbs ? '<div class="row-extras">' + notes +
    (thumbs ? '<div class="thumbs">' + thumbs + "</div>" : "") + "</div>" : "";
  return `
    <tr>
      <td class="col-date">${escapeHtml(e.date || "—")}</td>
      <td>${escapeHtml(e.description)}${extras}</td>
      <td><span class="${badgeClass}">${escapeHtml(PARTNERS[e.paidBy] || e.paidBy)}</span></td>
      <td class="amount">${money(e.amount)}</td>
      <td class="actions-cell">
        <button class="icon-btn" data-edit="${e.id}" title="Edit">Edit</button>
        <button class="icon-btn del" data-del="${e.id}" title="Delete">Delete</button>
      </td>
    </tr>`;
}

// ---------- Modal / CRUD ----------
function fillSelect(el, values, current) {
  el.innerHTML = values
    .map((v) => `<option value="${escapeHtml(v.value)}"${v.value === current ? " selected" : ""}>${escapeHtml(v.label)}</option>`)
    .join("");
}

function openModal(id) {
  const form = document.getElementById("expense-form");
  const existing = id ? expenses.find((e) => e.id === id) : null;

  document.getElementById("modal-title").textContent = existing ? "Edit Expense" : "Add Expense";
  document.getElementById("f-id").value = existing ? existing.id : "";
  document.getElementById("f-date").value = existing ? existing.date || "" : "";
  document.getElementById("f-amount").value = existing ? existing.amount : "";
  document.getElementById("f-description").value = existing ? existing.description : "";
  document.getElementById("f-notes").value = existing ? existing.notes || "" : "";
  pendingReceipts = existing && Array.isArray(existing.receipts) ? existing.receipts.slice() : [];
  renderReceiptPreviews();

  fillSelect(
    document.getElementById("f-paidBy"),
    [{ value: "Z", label: PARTNERS.Z }, { value: "A", label: PARTNERS.A }],
    existing ? existing.paidBy : "Z"
  );
  fillSelect(
    document.getElementById("f-section"),
    SECTIONS.map((s) => ({ value: s, label: s })),
    existing ? existing.section : SECTIONS[2]
  );

  document.getElementById("modal").classList.remove("hidden");
  document.getElementById("f-description").focus();
  form.onsubmit = (ev) => {
    ev.preventDefault();
    saveFromForm();
  };
}

function closeModal() {
  document.getElementById("modal").classList.add("hidden");
  pendingReceipts = [];
}

// ---------- Receipts ----------
function renderReceiptPreviews() {
  const el = document.getElementById("receipt-previews");
  if (!pendingReceipts.length) {
    el.innerHTML = '<span class="no-receipts">No photos attached yet.</span>';
    return;
  }
  el.innerHTML = pendingReceipts
    .map(
      (src, i) =>
        '<div class="preview">' +
        '<img src="' + src + '" alt="Receipt ' + (i + 1) + '" data-lightbox="' + src + '" />' +
        '<button type="button" class="remove-receipt" data-remove="' + i + '" title="Remove">&times;</button>' +
        "</div>"
    )
    .join("");
  el.querySelectorAll("[data-remove]").forEach((b) =>
    b.addEventListener("click", () => {
      pendingReceipts.splice(Number(b.dataset.remove), 1);
      renderReceiptPreviews();
    })
  );
  el.querySelectorAll("[data-lightbox]").forEach((img) =>
    img.addEventListener("click", () => openLightbox(img.dataset.lightbox))
  );
}

async function handleReceiptFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
  for (const file of files) {
    try {
      pendingReceipts.push(await compressImage(file));
    } catch (err) {
      alert(err.message);
    }
  }
  renderReceiptPreviews();
}

function openLightbox(src) {
  document.getElementById("lightbox-img").src = src;
  document.getElementById("lightbox").classList.remove("hidden");
}

function closeLightbox() {
  document.getElementById("lightbox").classList.add("hidden");
  document.getElementById("lightbox-img").src = "";
}

async function saveFromForm() {
  const record = {
    date: document.getElementById("f-date").value,
    amount: parseFloat(document.getElementById("f-amount").value) || 0,
    description: document.getElementById("f-description").value.trim(),
    notes: document.getElementById("f-notes").value.trim(),
    receipts: pendingReceipts.slice(),
    paidBy: document.getElementById("f-paidBy").value,
    section: document.getElementById("f-section").value,
  };
  const id = document.getElementById("f-id").value;

  try {
    const saved = await Store.saveExpense(record, id || null);
    if (id) {
      const idx = expenses.findIndex((e) => e.id === id);
      if (idx > -1) expenses[idx] = saved;
    } else {
      expenses.push(saved);
    }
  } catch (err) {
    reportError("save this expense", err); // modal stays open so nothing is lost
    return;
  }
  closeModal();
  render();
}

async function removeExpense(id) {
  const e = expenses.find((x) => x.id === id);
  if (!e) return;
  if (!confirm(`Delete "${e.description}" (${money(e.amount)})?`)) return;
  try {
    await Store.deleteExpense(id);
  } catch (err) {
    reportError("delete this expense", err);
    return;
  }
  expenses = expenses.filter((x) => x.id !== id);
  render();
}

// ---------- Import / Export ----------
function exportCsv() {
  const headers = ["Date", "Description", "Notes", "Section", "Paid By", "Amount", "Receipts"];
  const lines = [headers.join(",")];
  for (const e of expenses) {
    const row = [
      e.date,
      e.description,
      e.notes || "",
      e.section,
      PARTNERS[e.paidBy] || e.paidBy,
      (Number(e.amount) || 0).toFixed(2),
      (Array.isArray(e.receipts) ? e.receipts.length : 0),
    ].map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`);
    lines.push(row.join(","));
  }
  download("expenses.csv", "text/csv", lines.join("\r\n"));
}

function download(filename, type, content) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- Wire up ----------
document.getElementById("add-btn").addEventListener("click", () => openModal(null));
document.getElementById("cancel-btn").addEventListener("click", closeModal);
document.getElementById("group-select").addEventListener("change", renderGroups);
document.getElementById("export-btn").addEventListener("click", exportCsv);
document.getElementById("print-btn").addEventListener("click", () => window.print());
document.getElementById("modal").addEventListener("click", (e) => {
  if (e.target.id === "modal") closeModal();
});
document.getElementById("add-draw-btn").addEventListener("click", () => openDrawModal(null));
document.getElementById("draw-cancel-btn").addEventListener("click", closeDrawModal);
document.getElementById("f-receipts").addEventListener("change", (e) => {
  handleReceiptFiles(e.target.files);
  e.target.value = "";
});
document.getElementById("lightbox").addEventListener("click", closeLightbox);
document.getElementById("draw-modal").addEventListener("click", (e) => {
  if (e.target.id === "draw-modal") closeDrawModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!document.getElementById("lightbox").classList.contains("hidden")) {
      closeLightbox();
      return;
    }
    closeModal();
    closeDrawModal();
  }
});
document.getElementById("auth-btn").addEventListener("click", () => {
  if (Store.mode !== "cloud") return;
  if (currentUser) Store.signOut();
  else openLoginModal();
});
document.getElementById("login-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const errEl = document.getElementById("login-error");
  errEl.classList.add("hidden");
  try {
    await Store.signIn(
      document.getElementById("l-email").value.trim(),
      document.getElementById("l-password").value
    );
  } catch (err) {
    errEl.textContent = err.message || "Sign-in failed.";
    errEl.classList.remove("hidden");
  }
});

// ---------- Boot ----------
let currentUser = null;

function openLoginModal() {
  document.getElementById("login-error").classList.add("hidden");
  document.getElementById("login-modal").classList.remove("hidden");
  document.getElementById("l-email").focus();
}

function closeLoginModal() {
  document.getElementById("login-modal").classList.add("hidden");
  document.getElementById("login-form").reset();
}

function setAppEnabled(enabled) {
  document
    .querySelectorAll(".toolbar button, .toolbar label, .toolbar select, #add-draw-btn")
    .forEach((el) => el.classList.toggle("disabled", !enabled));
}

function setAuthUi(user) {
  const status = document.getElementById("auth-status");
  const btn = document.getElementById("auth-btn");
  if (Store.mode === "local") {
    status.textContent = "Offline mode \u2014 saved in this browser only";
    btn.classList.add("hidden");
    return;
  }
  btn.classList.remove("hidden");
  if (user) {
    status.textContent = "Synced \u00b7 " + user.email;
    btn.textContent = "Sign Out";
  } else {
    status.textContent = "Not signed in";
    btn.textContent = "Sign In";
  }
}

async function loadAll() {
  expenses = await Store.getExpenses();
  draws = await Store.getDraws();
  render();
}

async function onSignedIn(user) {
  currentUser = user;
  setAuthUi(user);
  closeLoginModal();
  setAppEnabled(true);
  try {
    await loadAll();
    // First run against an empty cloud database: offer to move local data up.
    if (!expenses.length && !draws.length) {
      const local = await LocalStore.getExpenses();
      if (
        local.length &&
        confirm(
          "Your cloud database is empty.\n\nUpload the " + local.length +
            " expenses currently saved in this browser to the cloud?"
        )
      ) {
        await SupabaseStore.importLocalData();
        await loadAll();
      }
    }
  } catch (err) {
    reportError("load your data", err);
  }
}

function onSignedOut() {
  currentUser = null;
  expenses = [];
  draws = [];
  setAuthUi(null);
  setAppEnabled(false);
  render();
  openLoginModal();
}

async function boot() {
  await Store.init();
  if (Store.mode === "local") {
    setAuthUi(null);
    setAppEnabled(true);
    await loadAll();
    return;
  }
  Store.onAuthChange((user) => (user ? onSignedIn(user) : onSignedOut()));
  const user = await Store.currentUser();
  if (user) await onSignedIn(user);
  else onSignedOut();
}

boot();
