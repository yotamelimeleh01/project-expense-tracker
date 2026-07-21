"use strict";

const STORAGE_KEY = "mpet.expenses.v3";

// ---------- State ----------
let expenses = load();

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function load() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      console.warn("Corrupt saved data, falling back to seed.", e);
    }
  }
  return seedWithIds();
}

function seedWithIds() {
  return SEED_EXPENSES.map((e) => ({ id: uid(), ...e }));
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(expenses));
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

  renderReconcileBanner(t);
  renderGroups();
}

function renderReconcileBanner(t) {
  const banner = document.getElementById("reconcile-banner");
  const diff = PDF_STATED_TOTALS.total - t.total;
  if (Math.abs(diff) < 0.01) {
    banner.classList.add("hidden");
    return;
  }
  banner.classList.remove("hidden");
  const sign = diff > 0 ? "less than" : "more than";
  banner.innerHTML =
    `<strong>Reconciliation:</strong> Line items total <strong>${money(t.total)}</strong>, ` +
    `which is <strong>${money(Math.abs(diff))}</strong> ${sign} the original PDF header ` +
    `(<strong>${money(PDF_STATED_TOTALS.total)}</strong>). Add any missing receipts to close the gap.`;
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
}

function rowHtml(e) {
  const badgeClass = e.paidBy === "A" ? "badge a" : "badge";
  return `
    <tr>
      <td class="col-date">${escapeHtml(e.date || "—")}</td>
      <td>${escapeHtml(e.description)}</td>
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
}

function saveFromForm() {
  const id = document.getElementById("f-id").value;
  const record = {
    date: document.getElementById("f-date").value,
    amount: parseFloat(document.getElementById("f-amount").value) || 0,
    description: document.getElementById("f-description").value.trim(),
    paidBy: document.getElementById("f-paidBy").value,
    section: document.getElementById("f-section").value,
  };

  if (id) {
    const idx = expenses.findIndex((e) => e.id === id);
    if (idx > -1) expenses[idx] = { ...expenses[idx], ...record };
  } else {
    expenses.push({ id: uid(), ...record });
  }
  save();
  closeModal();
  render();
}

function removeExpense(id) {
  const e = expenses.find((x) => x.id === id);
  if (!e) return;
  if (!confirm(`Delete "${e.description}" (${money(e.amount)})?`)) return;
  expenses = expenses.filter((x) => x.id !== id);
  save();
  render();
}

// ---------- Import / Export ----------
function exportCsv() {
  const headers = ["Date", "Description", "Section", "Paid By", "Amount"];
  const lines = [headers.join(",")];
  for (const e of expenses) {
    const row = [
      e.date,
      e.description,
      e.section,
      PARTNERS[e.paidBy] || e.paidBy,
      (Number(e.amount) || 0).toFixed(2),
    ].map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`);
    lines.push(row.join(","));
  }
  download("expenses.csv", "text/csv", lines.join("\r\n"));
}

function backupJson() {
  download("expense-backup.json", "application/json", JSON.stringify(expenses, null, 2));
}

function restoreJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data)) throw new Error("Not an array");
      expenses = data.map((e) => ({ id: e.id || uid(), ...e }));
      save();
      render();
      alert(`Restored ${expenses.length} expenses.`);
    } catch (err) {
      alert("Could not read that file: " + err.message);
    }
  };
  reader.readAsText(file);
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

function resetToPdf() {
  if (!confirm("Reset all data back to the original PDF line items? This discards your changes.")) return;
  expenses = seedWithIds();
  save();
  render();
}

// ---------- Wire up ----------
document.getElementById("add-btn").addEventListener("click", () => openModal(null));
document.getElementById("cancel-btn").addEventListener("click", closeModal);
document.getElementById("group-select").addEventListener("change", renderGroups);
document.getElementById("export-btn").addEventListener("click", exportCsv);
document.getElementById("backup-btn").addEventListener("click", backupJson);
document.getElementById("print-btn").addEventListener("click", () => window.print());
document.getElementById("reset-btn").addEventListener("click", resetToPdf);
document.getElementById("restore-input").addEventListener("change", (e) => {
  if (e.target.files[0]) restoreJson(e.target.files[0]);
  e.target.value = "";
});
document.getElementById("modal").addEventListener("click", (e) => {
  if (e.target.id === "modal") closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

render();
