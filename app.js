"use strict";

// ---------- State ----------
let projects = [];
let partners = [];       // partner rows for every project you can see
let memberships = [];    // your access + everyone else's, per project
let contractors = [];    // your directory of people you pay
let budgets = [];        // budget lines for every project you can see
let tasks = [];          // schedule phases for every project you can see
let summaries = [];      // lightweight expense rows for every project
let allDraws = [];       // draw rows for every project
let allCategories = [];  // the scope of work for every project you can see
let allDocs = [];        // the paperwork filed against every project you can see

let expenses = [];       // full rows (with receipts) for the open project
let draws = [];          // draw rows for the open project
let activeProjectId = null;

let pendingReceipts = [];
let pendingExpenseId = null;
let removedReceiptPaths = [];
let receiptUrls = {};    // storage path -> signed URL, refreshed per project
let pendingPartners = [];
let pendingBudget = {};
let currentUser = null;
let shareMode = false;    // true when a read-only link is being viewed
let booted = false;

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
function sum(list, pick) {
  return list.reduce((s, x) => s + (Number(pick ? pick(x) : x.amount) || 0), 0);
}
function reportError(action, err) {
  console.error(action, err);
  alert("Could not " + action + ".\n\n" + (err && err.message ? err.message : err));
}

// Resize + compress an image file into a small JPEG. Storage is cheap but
// bandwidth in the field is not, and a phone photo is 4 MB of detail nobody
// needs to read a receipt.
function compressImage(file, maxDim = 1600, quality = 0.7) {
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
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("Could not compress " + file.name))),
          "image/jpeg",
          quality
        );
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// A data URL is an image that has not been moved to Storage yet. Turning one
// back into a blob is what lets the migration upload it.
function dataUrlToBlob(dataUrl) {
  const [head, body] = dataUrl.split(",");
  const type = (head.match(/data:([^;]+)/) || [])[1] || "image/jpeg";
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

// ---------- Lookups ----------
function activeProject() {
  return projects.find((p) => p.id === activeProjectId) || null;
}
function partnersOf(projectId) {
  return partners.filter((p) => p.projectId === projectId).sort((a, b) => a.sort - b.sort);
}
function partnerName(id) {
  const p = partners.find((x) => x.id === id);
  return p ? p.name : "Unassigned";
}
function myRole(projectId) {
  if (!currentUser) return null;
  const m = memberships.find((x) => x.projectId === projectId && x.userId === currentUser.id);
  return m ? m.role : null;
}
function canEdit(projectId) {
  const r = myRole(projectId);
  return r === "owner" || r === "editor";
}
function isOwner(projectId) {
  return myRole(projectId) === "owner";
}
function memberCount(projectId) {
  return memberships.filter((m) => m.projectId === projectId).length;
}

// ---------- Budget vs actual ----------
// One row per category that has either a budget or some spend against it.
// A category with no budget is reported, but never counted as a variance —
// you cannot be over a number you never set.
function budgetRows(projectId, expenseList) {
  const lines = budgets.filter((b) => b.projectId === projectId);
  const names = new Set(lines.map((b) => b.category));
  for (const e of expenseList) if (e.category) names.add(e.category);

  const known = categoryNames();
  return known
    .concat([...names].filter((n) => !known.includes(n)))
    .filter((n) => names.has(n))
    .map((name) => {
      const line = lines.find((b) => b.category === name);
      const budget = line ? line.amount : null;
      const actual = sum(expenseList.filter((e) => e.category === name));
      const variance = budget === null ? null : actual - budget;
      return {
        category: name,
        group: categoryGroup(name),
        budget,
        actual,
        variance,
        pct: budget ? (actual / budget) * 100 : null,
      };
    });
}

function healthOf(project, expenseList) {
  const rows = budgetRows(project.id, expenseList).filter((r) => r.budget !== null);
  if (!rows.length) return { ...HEALTH.none, over: [], budget: 0, actual: 0 };

  const threshold = Number(project.varianceThreshold) || 10;
  const budget = rows.reduce((s, r) => s + r.budget, 0);
  const actual = rows.reduce((s, r) => s + r.actual, 0);
  const over = rows.filter((r) => r.pct !== null && r.pct > 100 + threshold);
  const watch = rows.filter((r) => r.pct !== null && r.pct > 100 && r.pct <= 100 + threshold);

  let state = HEALTH.under;
  if (over.length || actual > budget * (1 + threshold / 100)) state = HEALTH.over;
  else if (watch.length || actual > budget) state = HEALTH.watch;

  return { ...state, over, watch, budget, actual, threshold };
}

function rowHealth(row, threshold) {
  if (row.budget === null) return "none";
  if (row.pct > 100 + threshold) return "over";
  if (row.pct > 100) return "watch";
  return "under";
}

// ---------- Money math ----------
// One set of formulas, used by both the dashboard cards and the project page,
// so a number can never mean two different things in two places.
function loanNumbers(project, drawList) {
  const totalDraws = sum(drawList);
  const funded = (Number(project.loanAmount) || 0) - (Number(project.loanHoldback) || 0);
  return {
    totalDraws,
    funded,
    remaining: (Number(project.loanHoldback) || 0) - totalDraws,
    payoff: funded + totalDraws,
  };
}

// Total capital deployed into the deal = every dollar the partners have paid
// out of pocket, plus the loan principal the lender funded at closing.
//
// Construction draws are deliberately NOT added here. A draw reimburses an
// expense that is already entered as a line item, so counting both would
// inflate this number by the amount of every draw. Draws still increase what
// is owed back to the lender, which is what the payoff panel tracks.
function allInNumbers(project, expenseList, drawList) {
  const partnerCash = sum(expenseList);
  const loan = loanNumbers(project, drawList);
  return {
    partnerCash,
    funded: loan.funded,
    totalDraws: loan.totalDraws,
    payoff: loan.payoff,
    allIn: partnerCash + loan.funded,
  };
}

// Profit = sale price − all-in.
//
// The long way round is: sale price, less the lender payoff, plus the draws the
// partners received, less the cash the partners put in. The draws cancel out,
// because a draw both raises the payoff and comes back as cash — which leaves
// exactly sale price minus all-in.
function profitOf(project, expenseList, drawList) {
  if (project.salePrice === null || project.salePrice === undefined) return null;
  const n = allInNumbers(project, expenseList, drawList);
  return { sale: Number(project.salePrice) || 0, allIn: n.allIn, profit: Number(project.salePrice) - n.allIn };
}

function statusClass(status) {
  return "status status-" + String(status || "before_closing").replace(/_/g, "-");
}

// ---------- Profit split ----------
// The waterfall a small partnership actually runs at closing:
//
//   1. everybody gets their own money back
//   2. anybody owed a preferred return gets it
//   3. whatever is left is split by the agreed percentages
//
// Every figure is derived from the ledger, so the split can never drift away
// from the expenses it came from. Tier 3 works out to exactly profit minus
// the preferred return, which is the same profit shown at the top of the page.
function splitWaterfall(project, partnerList, expenseList, drawList) {
  if (project.salePrice === null || project.salePrice === undefined) return null;
  if (!partnerList.length) return null;

  const loan = loanNumbers(project, drawList);
  const proceeds = (Number(project.salePrice) || 0) - loan.payoff;
  const contributedTotal = sum(expenseList.filter((e) => e.partnerId));
  const unassigned = sum(expenseList.filter((e) => !e.partnerId));

  // A draw reimburses the partnership, not one named partner, so it comes off
  // everybody's capital in proportion to what they put in.
  const drawShare = contributedTotal > 0 ? loan.totalDraws / contributedTotal : 0;

  // The preferred return accrues on each pound from the day it was spent to
  // the day the deal closes — or to today, while it is still running.
  const end = project.saleDate || new Date().toISOString().slice(0, 10);
  const rate = (Number(project.prefAnnualPct) || 0) / 100;

  const rows = partnerList.map((pt) => {
    const mine = expenseList.filter((e) => e.partnerId === pt.id);
    const contributed = sum(mine);
    const pref = rate
      ? mine.reduce((s, e) => s + (Number(e.amount) || 0) * rate * (daysBetween(e.date, end) / 365), 0)
      : 0;
    return {
      id: pt.id,
      name: pt.name,
      equityPct: Number(pt.equityPct) || 0,
      contributed,
      reimbursed: contributed * drawShare,
      netCapital: contributed * (1 - drawShare),
      pref,
    };
  });

  // If nobody has set a percentage, fall back to splitting the way the money
  // went in. Better than dividing by zero and better than a silent 50/50.
  const equityTotal = rows.reduce((s, r) => s + r.equityPct, 0);
  const usingFallback = equityTotal <= 0;
  for (const r of rows) {
    r.share = usingFallback
      ? contributedTotal > 0 ? r.contributed / contributedTotal : 1 / rows.length
      : r.equityPct / equityTotal;
  }

  let left = proceeds;

  // Tier 1 — capital back. If the sale did not even cover this, everyone takes
  // the same proportional haircut rather than first-in-best-dressed.
  const capitalNeed = rows.reduce((s, r) => s + r.netCapital, 0);
  const capitalRatio = capitalNeed > 0 ? Math.min(1, Math.max(0, left / capitalNeed)) : 1;
  for (const r of rows) r.capitalBack = r.netCapital * capitalRatio;
  left -= capitalNeed * capitalRatio;

  // Tier 2 — the preferred return, pro-rated the same way if it is short.
  const prefNeed = rows.reduce((s, r) => s + r.pref, 0);
  const prefRatio = prefNeed > 0 ? Math.min(1, Math.max(0, left / prefNeed)) : 0;
  for (const r of rows) r.prefPaid = r.pref * prefRatio;
  left -= prefNeed * prefRatio;

  // Tier 3 — the upside.
  const remainder = left;
  for (const r of rows) {
    r.profitShare = remainder * r.share;
    r.total = r.capitalBack + r.prefPaid + r.profitShare;
    r.gain = r.total - r.netCapital;
  }

  return {
    rows,
    proceeds,
    payoff: loan.payoff,
    capitalNeed,
    prefNeed,
    prefPaid: prefNeed * prefRatio,
    remainder,
    shortfall: capitalRatio < 1 || (prefNeed > 0 && prefRatio < 1),
    unassigned,
    equityTotal,
    usingFallback,
    end,
  };
}

function daysBetween(from, to) {
  if (!from || !to) return 0;
  const a = Date.parse(from + "T00:00:00Z");
  const b = Date.parse(to + "T00:00:00Z");
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.max(0, (b - a) / 86400000);
}

// ---------- The schedule ----------
// ISO dates sort and compare correctly as plain strings, which keeps every
// date calculation here free of time zones.
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  const t = Date.parse(dateStr + "T00:00:00Z");
  if (isNaN(t)) return dateStr;
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}
function laterOf(a, b) {
  return !a ? b : !b ? a : a > b ? a : b;
}
function earlierOf(a, b) {
  return !a ? b : !b ? a : a < b ? a : b;
}

// Two passes over the dependency graph.
//
// Forward: the earliest each phase can start, given everything it waits for.
// Backward: the latest it could start without moving the finish date.
//
// A phase with no room between the two is on the critical path — slip it by a
// day and the whole project finishes a day later. Everything else has slack.
function scheduleOf(project, taskList, now) {
  if (!taskList.length) return null;
  const day = now || todayIso();

  const byId = new Map(taskList.map((t) => [t.id, t]));
  const deps = new Map(
    taskList.map((t) => [t.id, (t.dependsOn || []).filter((d) => byId.has(d) && d !== t.id)])
  );

  // A circular dependency is a data problem, not a reason to hang. Every task
  // caught in the loop is named, and then scheduled as if it were free.
  const order = [];
  const mark = new Map();
  const looped = new Set();
  const stack = [];
  const visit = (id) => {
    const state = mark.get(id);
    if (state === 1) return;
    if (state === 0) {
      for (const back of stack.slice(stack.indexOf(id))) looped.add(back);
      return;
    }
    mark.set(id, 0);
    stack.push(id);
    for (const d of deps.get(id)) visit(d);
    stack.pop();
    mark.set(id, 1);
    order.push(id);
  };
  for (const t of taskList) visit(t.id);
  for (const id of looped) deps.set(id, []);

  const base =
    project.settlementDate ||
    taskList.map((t) => t.plannedStart).filter(Boolean).sort()[0] ||
    day;

  // Forward pass. What actually happened always beats what was planned.
  // A dependency that has not been placed yet only happens on the broken edge
  // of a loop, and is ignored rather than allowed to throw.
  const span = new Map();
  for (const id of order) {
    const t = byId.get(id);
    let start = t.plannedStart || base;
    for (const d of deps.get(id)) {
      const before = span.get(d);
      if (before) start = laterOf(start, addDays(before.end, 1));
    }
    if (t.actualStart) start = t.actualStart;
    const end = t.actualEnd || addDays(start, Math.max(1, t.durationDays) - 1);
    span.set(id, { start, end });
  }

  const finish = order.reduce((f, id) => laterOf(f, span.get(id).end), "");

  // Backward pass, in reverse topological order so every successor is known.
  const succ = new Map(taskList.map((t) => [t.id, []]));
  for (const [id, list] of deps) for (const d of list) succ.get(d).push(id);

  const lateEnd = new Map();
  const lateStart = new Map();
  for (const id of [...order].reverse()) {
    let le = finish;
    for (const s of succ.get(id)) {
      const after = lateStart.get(s);
      if (after) le = earlierOf(le, addDays(after, -1));
    }
    lateEnd.set(id, le);
    lateStart.set(id, addDays(le, -(Math.max(1, byId.get(id).durationDays) - 1)));
  }

  const rows = taskList.map((t) => {
    const { start, end } = span.get(t.id);
    const slack = daysBetween(end, lateEnd.get(t.id));
    const blockers = deps.get(t.id).filter((d) => byId.get(d).status !== "done");
    let state;
    if (t.status === "done") state = SCHEDULE_STATE.done;
    else if (t.status === "in_progress") state = end < day ? SCHEDULE_STATE.late : SCHEDULE_STATE.running;
    else if (blockers.length) state = SCHEDULE_STATE.blocked;
    else if (start < day) state = SCHEDULE_STATE.late;
    else if (start <= day) state = SCHEDULE_STATE.ready;
    else state = SCHEDULE_STATE.waiting;

    return {
      ...t,
      start,
      end,
      slack,
      critical: slack === 0,
      blockers: blockers.map((d) => byId.get(d).name),
      looped: looped.has(t.id),
      state,
      daysLate: t.status === "done" ? 0 : Math.max(0, daysBetween(end, day)),
    };
  });

  const first = rows.reduce((f, r) => earlierOf(f, r.start), "");
  const late = rows.filter((r) => r.state.key === "late");
  return {
    rows,
    start: first,
    finish,
    days: daysBetween(first, finish) + 1,
    late,
    slip: late.reduce((m, r) => Math.max(m, r.daysLate), 0),
    blocked: rows.filter((r) => r.state.key === "blocked"),
    remaining: rows.filter((r) => r.status !== "done").length,
    criticalCount: rows.filter((r) => r.critical).length,
    cycles: [...looped].map((id) => byId.get(id).name),
    today: day,
  };
}

// What a day of delay costs, taken from what holding this project has actually
// been costing rather than from a number somebody guessed. Interest, taxes,
// insurance and utilities are all already in the ledger under Cost To Hold.
function carryPerDay(project, expenseList, day) {
  if (!project.settlementDate) return 0;
  const held = sum(expenseList.filter((e) => categoryGroup(e.category) === "hold"));
  const elapsed = daysBetween(project.settlementDate, day || todayIso());
  return elapsed > 0 && held > 0 ? held / elapsed : 0;
}

// ---------- Routing ----------
function currentRoute() {
  const m = String(location.hash || "").match(/^#\/p\/(.+)$/);
  return m ? { view: "project", id: decodeURIComponent(m[1]) } : { view: "dashboard" };
}

function goDashboard() {
  location.hash = "#/";
}
function goProject(id) {
  location.hash = "#/p/" + encodeURIComponent(id);
}

// ---------- Project tabs ----------
// One project used to be a single long scroll. It is now five, because on a
// phone the schedule sat four screens below the number you opened the app for.
// The tab survives a re-render on purpose: adding an expense must not throw you
// back to the overview halfway through a stack of receipts.
const PROJECT_TABS = ["overview", "expenses", "budget", "schedule", "documents", "loan"];
let projectTab = "overview";

function showProjectTab(name) {
  projectTab = PROJECT_TABS.includes(name) ? name : "overview";
  document.querySelectorAll("#project-tabs .tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.ptab === projectTab)
  );
  PROJECT_TABS.forEach((t) =>
    document.getElementById("ptab-" + t).classList.toggle("hidden", t !== projectTab)
  );
}

async function route() {
  if (shareMode) return;
  const r = currentRoute();
  const dash = document.getElementById("dashboard-view");
  const proj = document.getElementById("project-view");
  const crumbs = document.getElementById("crumbs");

  if (r.view === "project" && projects.some((p) => p.id === r.id)) {
    activeProjectId = r.id;
    setActiveCategories(allCategories.filter((c) => c.projectId === activeProjectId));
    dash.classList.add("hidden");
    proj.classList.remove("hidden");
    crumbs.classList.remove("hidden");
    document.getElementById("crumb-current").textContent = activeProject().name;
    try {
      expenses = await Store.getExpenses(activeProjectId);
      draws = allDraws.filter((d) => d.projectId === activeProjectId);
      syncSummaries();
      await refreshReceiptUrls();
    } catch (err) {
      if (!Offline.isNetworkError(err)) {
        reportError("load this project", err);
        return;
      }
      // With no signal the cached summaries carry every figure on the page.
      // Only the receipt photos are missing, and they say so themselves.
      expenses = summaries.filter((e) => e.projectId === activeProjectId);
      draws = allDraws.filter((d) => d.projectId === activeProjectId);
      receiptUrls = {};
    }
    renderProject();
    if (Offline.online()) migrateLegacyReceipts();
    return;
  }

  activeProjectId = null;
  setActiveCategories(null);
  expenses = [];
  draws = [];
  proj.classList.add("hidden");
  crumbs.classList.add("hidden");
  dash.classList.remove("hidden");
  renderDashboard();
}

// Full rows are only loaded for the open project. Fold them back into the
// lightweight list so the dashboard totals stay right after an edit.
function syncSummaries() {
  summaries = summaries
    .filter((e) => e.projectId !== activeProjectId)
    .concat(expenses.map((e) => ({ ...e, receipts: [] })));
}

// ===========================================================================
// DASHBOARD
// ===========================================================================
function renderDashboard() {
  const filter = document.getElementById("status-filter").value;
  const visible = filter ? projects.filter((p) => p.status === filter) : projects;

  let portfolioAllIn = 0;
  let portfolioCash = 0;
  let realized = 0;
  let projected = 0;
  let overBudget = 0;

  const cards = visible
    .slice()
    .sort((a, b) => PROJECT_STATUSES.findIndex((s) => s.value === a.status) -
                    PROJECT_STATUSES.findIndex((s) => s.value === b.status))
    .map((p) => {
      const exp = summaries.filter((e) => e.projectId === p.id);
      const dr = allDraws.filter((d) => d.projectId === p.id);
      const n = allInNumbers(p, exp, dr);
      const pr = profitOf(p, exp, dr);

      const profitRow = pr
        ? '<div class="pc-row"><span>' +
          (p.status === "sold" ? "Profit" : "Projected profit") +
          '</span><strong class="' + (pr.profit >= 0 ? "pos" : "neg") + '">' +
          money(pr.profit) + "</strong></div>"
        : "";

      const h = healthOf(p, exp);
      const budgetRow =
        h.key === "none"
          ? '<div class="pc-row"><span>Budget</span><strong class="muted">not set</strong></div>'
          : '<div class="pc-row"><span>Budget used</span><strong>' +
            money(h.actual) + " of " + money(h.budget) + "</strong></div>";

      // Only worth saying something about the schedule while there is still
      // work left to slip.
      const s = scheduleOf(p, tasksOf(p.id), todayIso());
      const scheduleRow =
        s && s.remaining
          ? '<div class="pc-row"><span>Finishes</span><strong class="' +
            (s.late.length ? "neg" : "") + '">' + escapeHtml(s.finish) +
            (s.late.length ? " \u00b7 " + s.slip + "d late" : "") + "</strong></div>"
          : "";

      return (
        '<button class="project-card" data-open="' + escapeHtml(p.id) + '">' +
        '<div class="pc-head">' +
        '<span class="pc-name">' + escapeHtml(p.name) + "</span>" +
        '<span class="' + statusClass(p.status) + '">' + escapeHtml(statusLabel(p.status)) + "</span>" +
        "</div>" +
        (p.address ? '<div class="pc-address">' + escapeHtml(p.address) + "</div>" : "") +
        '<div class="pc-allin"><span>All-in</span><strong>' + money(n.allIn) + "</strong></div>" +
        '<div class="pc-rows">' +
        '<div class="pc-row"><span>Partner cash</span><strong>' + money(n.partnerCash) + "</strong></div>" +
        (isFinanced(p)
          ? '<div class="pc-row"><span>Lender payoff</span><strong>' + money(n.payoff) + "</strong></div>"
          : '<div class="pc-row"><span>Funding</span><strong>Cash</strong></div>') +
        budgetRow +
        scheduleRow +
        profitRow +
        "</div>" +
        '<div class="pc-health health-' + h.key + '">' + escapeHtml(h.label) +
        (h.over && h.over.length
          ? " · " + h.over.length + " categor" + (h.over.length === 1 ? "y" : "ies") + " over"
          : "") +
        "</div>" +
        '<div class="pc-foot">' + exp.length + " expense" + (exp.length === 1 ? "" : "s") +
        " \u00b7 " + memberCount(p.id) + " with access \u00b7 " + escapeHtml(myRole(p.id) || "member") +
        "</div>" +
        "</button>"
      );
    })
    .join("");

  for (const p of projects) {
    const exp = summaries.filter((e) => e.projectId === p.id);
    const dr = allDraws.filter((d) => d.projectId === p.id);
    const n = allInNumbers(p, exp, dr);
    portfolioAllIn += n.allIn;
    portfolioCash += n.partnerCash;
    const pr = profitOf(p, exp, dr);
    if (pr) {
      if (p.status === "sold") realized += pr.profit;
      else projected += pr.profit;
    }
    if (healthOf(p, exp).key === "over") overBudget++;
  }

  document.getElementById("portfolio-allin").textContent = money(portfolioAllIn);
  document.getElementById("portfolio-sub").innerHTML =
    "Your cash <strong>" + money(portfolioCash) + "</strong>" +
    " &nbsp;+&nbsp; Lender funded <strong>" + money(portfolioAllIn - portfolioCash) + "</strong>";

  const counts = PROJECT_STATUSES.map((s) => ({
    label: s.label,
    n: projects.filter((p) => p.status === s.value).length,
  })).filter((s) => s.n > 0);

  document.getElementById("portfolio-stats").innerHTML =
    '<div class="pstat"><span>Projects</span><strong>' + projects.length + "</strong></div>" +
    (overBudget
      ? '<div class="pstat"><span>Over budget</span><strong class="neg">' + overBudget + "</strong></div>"
      : "") +
    (realized
      ? '<div class="pstat"><span>Profit realized</span><strong class="' +
        (realized >= 0 ? "pos" : "neg") + '">' + money(realized) + "</strong></div>"
      : "") +
    (projected
      ? '<div class="pstat"><span>Profit projected</span><strong class="' +
        (projected >= 0 ? "pos" : "neg") + '">' + money(projected) + "</strong></div>"
      : "") +
    counts.map((c) => '<div class="pstat"><span>' + escapeHtml(c.label) +
      "</span><strong>" + c.n + "</strong></div>").join("");

  document.getElementById("project-grid").innerHTML = cards;
  document.getElementById("dashboard-empty").classList.toggle("hidden", projects.length > 0);
  renderComplianceAlert();

  document.querySelectorAll("[data-open]").forEach((b) =>
    b.addEventListener("click", () => goProject(b.dataset.open))
  );
}

// ===========================================================================
// PROJECT PAGE
// ===========================================================================
function renderProject() {
  const p = activeProject();
  if (!p) return;
  const editable = canEdit(p.id);

  // A cash deal has nothing to pay off, so the tab goes with the panel. The
  // marker keeps it off the printed page too, where every tab is unfolded.
  document.getElementById("project-view").classList.toggle("no-loan", !isFinanced(p));
  document.getElementById("ptab-loan-btn").classList.toggle("hidden", !isFinanced(p));
  if (!isFinanced(p) && projectTab === "loan") projectTab = "overview";
  showProjectTab(projectTab);

  document.getElementById("p-name").textContent = p.name;
  document.getElementById("p-address").textContent = p.address || "";
  document.getElementById("p-status").value = p.status;
  document.getElementById("p-status").disabled = !editable;

  const meta = [];
  if (p.settlementDate) meta.push(["Settlement", p.settlementDate]);
  if (p.borrower) meta.push(["Borrower", p.borrower]);
  if (p.purchasePrice) meta.push(["Purchase price", money(p.purchasePrice)]);
  if (p.saleDate) meta.push(["Sold", p.saleDate]);
  document.getElementById("p-meta").innerHTML = meta
    .map(([k, v]) => "<span><strong>" + escapeHtml(k) + ":</strong> " + escapeHtml(v) + "</span>")
    .join("");

  document.getElementById("share-btn").classList.toggle("hidden", !isOwner(p.id));
  setAppEnabled(editable);

  renderAllIn(p);
  renderProfit(p);
  renderPartnerCards(p);
  renderSplit(p);
  renderBudget(p);
  renderSchedule(p);
  renderDocuments(p);
  renderBreakdown(p);
  renderLoan(p);
  renderGroups();
}

function renderAllIn(p) {
  const n = allInNumbers(p, expenses, draws);
  document.getElementById("total-allin").textContent = money(n.allIn);

  const drawNote = n.totalDraws
    ? '<span class="allin-note">' + money(n.totalDraws) +
      " of construction draws are not added again here \u2014 they reimburse expenses already " +
      "counted above. They do raise the lender payoff below.</span>"
    : "";

  document.getElementById("allin-breakdown").innerHTML = isFinanced(p)
    ? "Partner cash <strong>" + money(n.partnerCash) + "</strong>" +
      " &nbsp;+&nbsp; Lender funded at closing <strong>" + money(n.funded) + "</strong>" +
      drawNote
    : "Paid for in cash \u2014 every dollar here is your own.";
}

function renderProfit(p) {
  const panel = document.getElementById("profit-panel");
  const pr = profitOf(p, expenses, draws);
  if (!pr) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  document.getElementById("profit-sale").textContent = money(pr.sale);
  document.getElementById("profit-allin").textContent = money(pr.allIn);
  document.getElementById("profit-label").textContent =
    p.status === "sold" ? "Profit" : "Projected Profit";
  const el = document.getElementById("profit-value");
  el.textContent = money(pr.profit);
  el.className = "card-value " + (pr.profit >= 0 ? "pos" : "neg");

  const n = allInNumbers(p, expenses, draws);
  document.getElementById("profit-note").textContent =
    "Sale price minus everything in the deal. At closing you hand the lender " +
    money(n.payoff) + " and keep the rest; the " + money(n.totalDraws) +
    " of draws you already received is why the payoff is larger than what was funded. " +
    "Interest, exit fees and selling costs are not included.";
}

function renderPartnerCards(p) {
  const list = partnersOf(p.id);
  const total = sum(expenses);
  const cards = list.map((pt, i) => {
    const paid = sum(expenses.filter((e) => e.partnerId === pt.id));
    return (
      '<div class="card">' +
      '<div class="card-label">' + escapeHtml(pt.name) + " Total Paid</div>" +
      '<div class="card-value' + (i % 2 ? " accent" : "") + '">' + money(paid) + "</div>" +
      "</div>"
    );
  });

  const unassigned = sum(expenses.filter((e) => !e.partnerId));
  if (unassigned > 0) {
    cards.push(
      '<div class="card"><div class="card-label">Unassigned</div>' +
      '<div class="card-value">' + money(unassigned) + "</div></div>"
    );
  }

  cards.push(
    '<div class="card"><div class="card-label">Total Outlay To Date</div>' +
    '<div class="card-value">' + money(total) + "</div></div>"
  );
  document.getElementById("partner-cards").innerHTML = cards.join("");
}

// The waterfall, laid out so anyone can follow the money left to right:
// what went in, what came back mid-project, what the deal owes, what is left.
function renderSplit(p) {
  const panel = document.getElementById("split-panel");
  const w = splitWaterfall(p, partnersOf(p.id), expenses, draws);
  if (!w) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");

  document.getElementById("split-basis").textContent = w.usingFallback
    ? "Split in proportion to what each partner put in"
    : "Split " + w.rows.map((r) => Math.round(r.equityPct) + "%").join(" / ");

  const head =
    "<thead><tr><th>Partner</th><th>Put In</th><th>Draws Back</th><th>At Risk</th>" +
    (w.prefNeed > 0 ? "<th>Preferred</th>" : "") +
    "<th>Profit Share</th><th>Takes Home</th></tr></thead>";

  const body = w.rows
    .map(
      (r) =>
        "<tr><td>" + escapeHtml(r.name) + "</td>" +
        "<td>" + money(r.contributed) + "</td>" +
        "<td>" + money(r.reimbursed) + "</td>" +
        "<td>" + money(r.netCapital) + "</td>" +
        (w.prefNeed > 0 ? "<td>" + money(r.prefPaid) + "</td>" : "") +
        '<td class="' + (r.profitShare >= 0 ? "pos" : "neg") + '">' + money(r.profitShare) + "</td>" +
        '<td class="split-take">' + money(r.total) + "</td></tr>"
    )
    .join("");

  const totals =
    "<tfoot><tr><td>Total</td>" +
    "<td>" + money(sum(w.rows, (r) => r.contributed)) + "</td>" +
    "<td>" + money(sum(w.rows, (r) => r.reimbursed)) + "</td>" +
    "<td>" + money(w.capitalNeed) + "</td>" +
    (w.prefNeed > 0 ? "<td>" + money(w.prefPaid) + "</td>" : "") +
    "<td>" + money(w.remainder) + "</td>" +
    '<td class="split-take">' + money(w.proceeds) + "</td></tr></tfoot>";

  document.getElementById("split-table").innerHTML =
    '<table class="split-table">' + head + "<tbody>" + body + "</tbody>" + totals + "</table>";

  const notes = [
    "Sale price less the " + money(w.payoff) + " lender payoff leaves " +
      money(w.proceeds) + " on the table. Capital goes back first" +
      (w.prefNeed > 0 ? ", then the preferred return" : "") +
      ", and the rest is split.",
  ];
  if (w.prefNeed > 0) {
    notes.push(
      "The preferred return is " + p.prefAnnualPct + "% a year on each pound from the day " +
      "it was spent to " + w.end + "."
    );
  }
  if (w.shortfall) {
    notes.push("The sale does not cover what the partners put in, so everyone takes the same proportional loss.");
  }
  if (!w.usingFallback && Math.abs(w.equityTotal - 100) > 0.01) {
    notes.push(
      "Warning: the equity percentages add up to " + w.equityTotal + "%, not 100%. " +
      "The split still uses each partner's share of that total, but the numbers are worth checking."
    );
  }
  if (w.unassigned > 0) {
    notes.push(
      "Warning: " + money(w.unassigned) + " of spend is not assigned to a partner, so it is " +
      "not being returned to anyone. Assign it for this split to be right."
    );
  }
  document.getElementById("split-note").textContent = notes.join(" ");
}

// ---------- Cost breakdown ----------
// Buckets roll up from the category groups in data.js, so every bucket total
// and the grand total are derived from the same line items as everything else.
// The buckets sum to exactly the all-in headline figure.
function breakdownGroups(p) {
  const { funded } = loanNumbers(p, draws);
  return CATEGORY_GROUPS.map((g) => {
    const lines = categoriesIn(g.key)
      .map((name) => ({
        label: name,
        amount: sum(expenses.filter((e) => e.category === name)),
      }))
      .filter((l) => l.amount !== 0);
    if (g.includeLoanFunded && funded !== 0) {
      lines.push({ label: "Lender principal funded at closing", amount: funded, lender: true });
    }
    return { ...g, lines, total: lines.reduce((s, l) => s + l.amount, 0) };
  }).filter((g) => g.lines.length);
}

function renderBreakdown(p) {
  const groups = breakdownGroups(p);
  const grand = groups.reduce((s, g) => s + g.total, 0);
  document.getElementById("breakdown-total").textContent = money(grand) + " total";

  document.getElementById("breakdown-groups").innerHTML = groups
    .map((g) => {
      const pct = grand > 0 ? (g.total / grand) * 100 : 0;
      const lines = g.lines
        .map(
          (l) =>
            '<div class="bd-line' + (l.lender ? " lender" : "") + '">' +
            "<span>" + escapeHtml(l.label) + "</span>" +
            '<span class="bd-line-amt">' + money(l.amount) + "</span>" +
            "</div>"
        )
        .join("");
      return (
        '<div class="bd-group">' +
        '<div class="bd-top">' +
        '<div class="bd-title">' + escapeHtml(g.label) +
        '<span class="bd-pct">' + pct.toFixed(1) + "% of all-in</span></div>" +
        '<div class="bd-total">' + money(g.total) + "</div>" +
        "</div>" +
        '<div class="bd-bar"><span style="width:' + pct.toFixed(2) + '%"></span></div>' +
        '<p class="bd-blurb">' + escapeHtml(g.blurb) + "</p>" +
        '<div class="bd-lines">' + lines + "</div>" +
        "</div>"
      );
    })
    .join("");

  document.getElementById("breakdown-note").textContent =
    "These buckets add up to the " + money(grand) +
    " all-in figure above. Construction draws are not counted here — they " +
    "reimburse expenses already listed, and are tracked as lender payoff below.";
}

// ---------- Budget vs actual ----------
function renderBudget(p) {
  const rows = budgetRows(p.id, expenses);
  const h = healthOf(p, expenses);
  const threshold = Number(p.varianceThreshold) || 10;

  const badge = document.getElementById("budget-health");
  badge.textContent = h.label;
  badge.className = "budget-health health-" + h.key;

  if (!rows.length) {
    document.getElementById("budget-summary").innerHTML = "";
    document.getElementById("budget-table").innerHTML =
      '<p class="empty">No budget yet. Set one and this turns into an early warning system — ' +
      "you'll see a phase drifting while you can still do something about it.</p>";
    document.getElementById("budget-note").textContent = "";
    return;
  }

  const budgeted = rows.filter((r) => r.budget !== null);
  const unbudgeted = rows.filter((r) => r.budget === null && r.actual !== 0);
  const totalBudget = budgeted.reduce((s, r) => s + r.budget, 0);
  const totalActual = budgeted.reduce((s, r) => s + r.actual, 0);
  const left = totalBudget - totalActual;

  document.getElementById("budget-summary").innerHTML = totalBudget
    ? '<div class="bsum"><span>Budgeted</span><strong>' + money(totalBudget) + "</strong></div>" +
      '<div class="bsum"><span>Spent</span><strong>' + money(totalActual) + "</strong></div>" +
      '<div class="bsum"><span>' + (left >= 0 ? "Left to spend" : "Over by") +
      '</span><strong class="' + (left >= 0 ? "pos" : "neg") + '">' + money(Math.abs(left)) +
      "</strong></div>" +
      '<div class="bsum"><span>Budget used</span><strong>' +
      (totalBudget ? ((totalActual / totalBudget) * 100).toFixed(0) : 0) + "%</strong></div>"
    : "";

  const line = (r) => {
    const state = rowHealth(r, threshold);
    const pct = r.pct === null ? null : Math.min(r.pct, 100);
    const over = r.pct !== null && r.pct > 100 ? Math.min(r.pct - 100, 100) : 0;
    return (
      "<tr>" +
      '<td class="bcat">' + escapeHtml(r.category) + "</td>" +
      '<td class="amount">' + (r.budget === null ? "—" : money(r.budget)) + "</td>" +
      '<td class="amount">' + money(r.actual) + "</td>" +
      '<td class="amount var-' + state + '">' +
      (r.variance === null ? "—" : (r.variance > 0 ? "+" : "") + money(r.variance)) +
      "</td>" +
      '<td class="bbar-cell">' +
      (r.budget === null
        ? '<span class="bnobudget">no budget</span>'
        : '<div class="bbar bbar-' + state + '">' +
          '<span style="width:' + pct.toFixed(1) + '%"></span>' +
          (over ? '<i style="width:' + over.toFixed(1) + '%"></i>' : "") +
          "</div>" +
          '<span class="bpct">' + r.pct.toFixed(0) + "%</span>") +
      "</td></tr>"
    );
  };

  const section = (key, label) => {
    const inGroup = rows.filter((r) => r.group === key);
    if (!inGroup.length) return "";
    return (
      '<tr class="bgroup"><td colspan="5">' + escapeHtml(label) + "</td></tr>" +
      inGroup.map(line).join("")
    );
  };

  document.getElementById("budget-table").innerHTML =
    "<table class=\"budget-table\"><thead><tr>" +
    "<th>Category / Phase</th>" +
    '<th class="amount">Budget</th>' +
    '<th class="amount">Actual</th>' +
    '<th class="amount">Variance</th>' +
    '<th class="bbar-col">Used</th>' +
    "</tr></thead><tbody>" +
    CATEGORY_GROUPS.map((g) => section(g.key, g.label)).join("") +
    "</tbody></table>";

  const parts = [];
  if (h.over && h.over.length) {
    parts.push(
      "Over by more than " + threshold + "%: " +
      h.over.map((r) => r.category + " (" + r.pct.toFixed(0) + "%)").join(", ") + "."
    );
  }
  if (h.watch && h.watch.length) {
    parts.push("Just over budget: " + h.watch.map((r) => r.category).join(", ") + ".");
  }
  if (unbudgeted.length) {
    parts.push(
      money(sum(unbudgeted, (r) => r.actual)) + " was spent in " + unbudgeted.length +
      " categor" + (unbudgeted.length === 1 ? "y" : "ies") + " with no budget set, so it is not counted above."
    );
  }
  document.getElementById("budget-note").textContent = parts.join(" ");
}

// ---------- The schedule ----------
function tasksOf(projectId) {
  return tasks.filter((t) => t.projectId === projectId);
}

function scheduleStateClass(key) {
  return "sched sched-" + key;
}

function renderSchedule(p) {
  const list = tasksOf(p.id);
  const s = scheduleOf(p, list, todayIso());
  const gantt = document.getElementById("gantt");
  const health = document.getElementById("schedule-health");
  const note = document.getElementById("schedule-note");

  if (!s) {
    health.className = "budget-health health-none";
    health.textContent = "No Schedule";
    document.getElementById("schedule-summary").innerHTML = "";
    gantt.innerHTML =
      '<div class="sched-empty">' +
      "<p>No phases yet. A schedule is what turns \u201cwe are running late\u201d into a date and a number.</p>" +
      (canEdit(p.id)
        ? '<button id="seed-schedule" class="btn btn-primary">Start From A Typical Rehab</button>'
        : "") +
      "</div>";
    note.textContent = "";
    const seed = document.getElementById("seed-schedule");
    if (seed) seed.addEventListener("click", seedSchedule);
    return;
  }

  const behind = s.late.length;
  const key = behind ? "over" : s.blocked.length ? "watch" : "under";
  health.className = "budget-health health-" + key;
  health.textContent = behind
    ? behind + " Phase" + (behind === 1 ? "" : "s") + " Late"
    : s.remaining === 0
    ? "Finished"
    : "On Track";

  const carry = carryPerDay(p, expenses, s.today);
  document.getElementById("schedule-summary").innerHTML =
    '<div class="bsum"><span>Finishes</span><strong>' + escapeHtml(s.finish) + "</strong></div>" +
    '<div class="bsum"><span>Days end to end</span><strong>' + s.days + "</strong></div>" +
    '<div class="bsum"><span>Phases left</span><strong>' + s.remaining + "</strong></div>" +
    '<div class="bsum"><span>Worst slip</span><strong class="' + (s.slip ? "neg" : "") + '">' +
    (s.slip ? s.slip + " day" + (s.slip === 1 ? "" : "s") : "none") + "</strong></div>" +
    (carry && s.slip
      ? '<div class="bsum"><span>That slip costs</span><strong class="neg">' +
        money(carry * s.slip) + "</strong></div>"
      : "");

  // The bars share one timeline, so a phase twice as long looks twice as long.
  const span = Math.max(1, daysBetween(s.start, s.finish) + 1);
  const todayPct = ((daysBetween(s.start, s.today) / span) * 100).toFixed(2);
  const inWindow = s.today >= s.start && s.today <= s.finish;

  const rows = s.rows
    .slice()
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.sort - b.sort))
    .map((r) => {
      const left = ((daysBetween(s.start, r.start) / span) * 100).toFixed(2);
      const width = Math.max(1.5, ((daysBetween(r.start, r.end) + 1) / span) * 100).toFixed(2);
      const who = contractorName(r.contractorId);
      const sub = [r.category, who].filter(Boolean).join(" \u00b7 ");
      return (
        '<div class="gantt-row' + (r.critical ? " is-critical" : "") + '" data-task="' +
        escapeHtml(r.id) + '" role="button" tabindex="0">' +
        '<div class="g-label"><span class="g-name">' + escapeHtml(r.name) + "</span>" +
        (sub ? '<span class="g-sub">' + escapeHtml(sub) + "</span>" : "") + "</div>" +
        '<div class="g-track">' +
        '<div class="g-bar bar-' + r.state.key + '" style="left:' + left + "%;width:" + width + '%">' +
        '<span class="g-dates">' + escapeHtml(r.start) + " \u2192 " + escapeHtml(r.end) + "</span>" +
        "</div></div>" +
        '<div class="g-state"><span class="' + scheduleStateClass(r.state.key) + '">' +
        escapeHtml(r.state.label) + "</span>" +
        (r.state.key === "late" ? '<span class="g-slip">' + r.daysLate + "d</span>" : "") +
        "</div></div>"
      );
    })
    .join("");

  gantt.innerHTML =
    '<div class="gantt">' +
    (inWindow ? '<div class="g-now"><div class="g-today" style="left:' + todayPct + '%"></div></div>' : "") +
    rows +
    "</div>";

  const parts = [];
  if (s.cycles.length) {
    parts.push(
      "These phases wait on each other in a circle, so their dates are guesses until you fix it: " +
      s.cycles.join(", ") + "."
    );
  }
  if (s.blocked.length) {
    parts.push(
      "Waiting on something else: " +
      s.blocked.map((r) => r.name + " (needs " + r.blockers.join(", ") + ")").join("; ") + "."
    );
  }
  if (s.criticalCount) {
    parts.push(
      s.criticalCount + " phase" + (s.criticalCount === 1 ? " is" : "s are") +
      " on the critical path \u2014 outlined below. A day lost on any of them is a day lost on the whole project."
    );
  }
  if (carry) {
    parts.push(
      "Holding this project has cost " + money(carry) + " a day so far, so every extra day on the " +
      "critical path costs about that much again."
    );
  }
  parts.push("Days are calendar days, weekends included.");
  note.textContent = parts.join(" ");

  document.querySelectorAll("#gantt [data-task]").forEach((el) => {
    const open = () => openTaskModal(el.dataset.task);
    el.addEventListener("click", open);
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        open();
      }
    });
  });
}

// Twelve rows nobody wants to type. Durations are deliberately round numbers
// meant to be argued with.
async function seedSchedule() {
  const p = activeProject();
  if (!p || !canEdit(p.id)) return;
  const start = p.settlementDate || todayIso();
  try {
    const ids = [];
    for (let i = 0; i < STARTER_SCHEDULE.length; i++) {
      const t = STARTER_SCHEDULE[i];
      const saved = await Store.saveTask({
        projectId: p.id,
        name: t.name,
        category: t.category,
        durationDays: t.days,
        plannedStart: i === 0 ? start : "",
        dependsOn: t.after.map((n) => ids[n]).filter(Boolean),
        status: "not_started",
        sort: i * 10,
      });
      ids.push(saved.id);
      tasks.push(saved);
    }
    renderSchedule(p);
    renderDashboard();
  } catch (err) {
    reportError("create the starter schedule", err);
  }
}

function renderDepPicker(taskId, selected) {
  const p = activeProject();
  const others = tasksOf(p.id).filter((t) => t.id !== taskId);
  const box = document.getElementById("t-deps");
  if (!others.length) {
    box.innerHTML = '<span class="form-hint">Nothing else to wait for yet.</span>';
    return;
  }
  box.innerHTML = others
    .slice()
    .sort((a, b) => a.sort - b.sort)
    .map(
      (t) =>
        '<label class="checkbox-field"><input type="checkbox" data-dep="' + escapeHtml(t.id) + '"' +
        (selected.includes(t.id) ? " checked" : "") + " /> " + escapeHtml(t.name) + "</label>"
    )
    .join("");
}

function openTaskModal(id) {
  const p = activeProject();
  if (!p || !canEdit(p.id)) return;
  const t = tasks.find((x) => x.id === id) || null;

  document.getElementById("task-title").textContent = t ? "Edit Phase" : "Add Phase";
  document.getElementById("t-id").value = t ? t.id : "";
  document.getElementById("t-name").value = t ? t.name : "";
  fillCategorySelect(document.getElementById("t-category"), t ? t.category : "");

  const who = document.getElementById("t-contractor");
  who.innerHTML =
    '<option value="">Not assigned</option>' +
    contractors
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.name) + "</option>")
      .join("");
  who.value = t && t.contractorId ? t.contractorId : "";

  document.getElementById("t-days").value = t ? t.durationDays : 5;
  document.getElementById("t-planned").value = t ? t.plannedStart : "";
  document.getElementById("t-actual-start").value = t ? t.actualStart : "";
  document.getElementById("t-actual-end").value = t ? t.actualEnd : "";
  document.getElementById("t-status").innerHTML = TASK_STATUSES.map(
    (s) =>
      '<option value="' + s.value + '"' +
      ((t ? t.status : "not_started") === s.value ? " selected" : "") + ">" + s.label + "</option>"
  ).join("");
  document.getElementById("t-notes").value = t ? t.notes : "";
  renderDepPicker(t ? t.id : "", t ? t.dependsOn : []);

  document.getElementById("t-delete").classList.toggle("hidden", !t);
  document.getElementById("task-modal").classList.remove("hidden");
  document.getElementById("t-name").focus();
}

function closeTaskModal() {
  document.getElementById("task-modal").classList.add("hidden");
}

async function saveTaskFromForm() {
  const p = activeProject();
  if (!p) return;
  const id = document.getElementById("t-id").value;
  const name = document.getElementById("t-name").value.trim();
  if (!name) return;

  const existing = tasks.find((t) => t.id === id);
  const record = {
    projectId: p.id,
    name,
    category: document.getElementById("t-category").value,
    contractorId: document.getElementById("t-contractor").value || null,
    durationDays: Math.max(1, Number(document.getElementById("t-days").value) || 1),
    plannedStart: document.getElementById("t-planned").value,
    actualStart: document.getElementById("t-actual-start").value,
    actualEnd: document.getElementById("t-actual-end").value,
    status: document.getElementById("t-status").value,
    notes: document.getElementById("t-notes").value.trim(),
    dependsOn: [...document.querySelectorAll("#t-deps [data-dep]")]
      .filter((el) => el.checked)
      .map((el) => el.dataset.dep),
    sort: existing ? existing.sort : tasksOf(p.id).length * 10,
  };

  // A phase marked done with no end date would sit on the chart forever, so
  // fill in today rather than quietly leaving it open.
  if (record.status === "done" && !record.actualEnd) record.actualEnd = todayIso();
  if (record.status !== "not_started" && !record.actualStart) record.actualStart = record.plannedStart || todayIso();

  try {
    const saved = await Store.saveTask(record, id || undefined);
    if (existing) tasks = tasks.map((t) => (t.id === saved.id ? saved : t));
    else tasks.push(saved);
    closeTaskModal();
    renderSchedule(p);
    renderDashboard();
  } catch (err) {
    reportError("save this phase", err);
  }
}

async function deleteTaskFromForm() {
  const p = activeProject();
  const id = document.getElementById("t-id").value;
  const t = tasks.find((x) => x.id === id);
  if (!p || !t) return;
  if (!confirm("Delete \u201c" + t.name + "\u201d from the schedule?")) return;

  // Anything waiting on this phase would otherwise keep a reference to a task
  // that no longer exists.
  const orphaned = tasksOf(p.id).filter((x) => x.dependsOn.includes(id));
  try {
    await Store.deleteTask(id);
    tasks = tasks.filter((x) => x.id !== id);
    for (const o of orphaned) {
      const next = { ...o, dependsOn: o.dependsOn.filter((d) => d !== id) };
      const saved = await Store.saveTask(next, o.id);
      tasks = tasks.map((x) => (x.id === saved.id ? saved : x));
    }
    closeTaskModal();
    renderSchedule(p);
    renderDashboard();
  } catch (err) {
    reportError("delete this phase", err);
  }
}

// ---------- Documents ----------
// A deal generates a stack of paper: the contract, the ALTA, the deed, the
// permits, the payoff letter. They normally live in email, which means that a
// year later nobody can find them. Here they live on the deal.
let editingDocId = null;

function projectDocs(projectId) {
  return allDocs.filter((d) => d.projectId === projectId);
}

function renderDocuments(p) {
  const mine = projectDocs(p.id);
  const editable = canEdit(p.id);
  document.getElementById("add-doc-btn").classList.toggle("hidden", !editable);
  document.getElementById("docs-health").textContent = mine.length
    ? mine.length + (mine.length === 1 ? " file" : " files")
    : "";

  const box = document.getElementById("docs-list");
  if (!mine.length) {
    box.innerHTML =
      '<p class="empty">Nothing filed yet. The contract, the ALTA, the permits ' +
      "\u2014 put them here and they are with the deal wherever you open it.</p>";
    document.getElementById("docs-note").textContent = "";
    return;
  }

  // Grouped by what a thing is rather than when it arrived, because that is
  // how you look for it: you want "the ALTA", not "the file from March".
  const order = DOCUMENT_KINDS.filter((k) => mine.some((d) => d.kind === k));
  const loose = mine.filter((d) => !DOCUMENT_KINDS.includes(d.kind));
  box.innerHTML =
    order
      .map((kind) => docGroupHtml(kind, mine.filter((d) => d.kind === kind), editable))
      .join("") + (loose.length ? docGroupHtml("Other", loose, editable) : "");

  const bytes = mine.reduce((sum, d) => sum + (d.size || 0), 0);
  document.getElementById("docs-note").textContent =
    "Held privately \u2014 only people on this project can open them. " +
    fileSize(bytes) + " in total.";
}

function docGroupHtml(kind, list, editable) {
  return (
    '<div class="doc-group"><h4>' + escapeHtml(kind) + "</h4>" +
    list
      .map(
        (d) =>
          '<div class="doc-row" data-doc="' + escapeHtml(d.id) + '">' +
          '<button type="button" class="doc-open" data-act="open">' +
          escapeHtml(d.name) + "</button>" +
          '<span class="doc-meta">' + escapeHtml(fileSize(d.size)) +
          (d.createdAt ? " \u00b7 " + escapeHtml(String(d.createdAt).slice(0, 10)) : "") +
          "</span>" +
          (d.note ? '<span class="doc-note">' + escapeHtml(d.note) + "</span>" : "") +
          (editable
            ? '<button type="button" class="btn btn-small" data-act="edit">Rename</button>' +
              '<button type="button" class="btn btn-small btn-danger" data-act="delete">Delete</button>'
            : "") +
          "</div>"
      )
      .join("") +
    "</div>"
  );
}

function docError(message) {
  const el = document.getElementById("doc-error");
  el.textContent = message || "";
  el.classList.toggle("cat-error", !!message);
}

function openDocModal(docId) {
  const p = activeProject();
  if (!p || !canEdit(p.id)) return;
  const doc = docId ? allDocs.find((d) => d.id === docId) : null;
  editingDocId = doc ? doc.id : null;

  fillSelect(
    document.getElementById("doc-kind"),
    DOCUMENT_KINDS.map((k) => ({ value: k, label: k })),
    doc ? doc.kind : DOCUMENT_KINDS[0]
  );
  document.getElementById("doc-name").value = doc ? doc.name : "";
  document.getElementById("doc-note").value = doc ? doc.note : "";
  document.getElementById("doc-file").value = "";
  // The file itself cannot be swapped out from under a name. Delete it and
  // upload again if it was the wrong file; that way the old one really goes.
  document.getElementById("doc-file").closest(".field").classList.toggle("hidden", !!doc);
  document.getElementById("doc-modal-title").textContent = doc
    ? "Rename a Document"
    : "Add a Document";
  docError("");
  document.getElementById("doc-modal").classList.remove("hidden");
}

function closeDocModal() {
  document.getElementById("doc-modal").classList.add("hidden");
  editingDocId = null;
}

async function saveDocFromForm() {
  const p = activeProject();
  if (!p) return;
  const kind = document.getElementById("doc-kind").value;
  const note = document.getElementById("doc-note").value.trim();
  const typed = document.getElementById("doc-name").value.trim();
  const file = (document.getElementById("doc-file").files || [])[0];

  if (editingDocId) {
    const existing = allDocs.find((d) => d.id === editingDocId);
    if (!existing) return closeDocModal();
    if (!typed) return docError("Give it a name so you can find it again.");
    try {
      const saved = await Store.saveDocument(
        { ...existing, name: typed, kind, note },
        existing.id
      );
      allDocs = allDocs.map((d) => (d.id === saved.id ? saved : d));
      closeDocModal();
      renderProject();
    } catch (err) {
      docError(err.message || "Could not save that.");
    }
    return;
  }

  if (!file) return docError("Choose a file first.");
  // The row carries the id so the file can be filed under it before either
  // exists. If the upload fails there is no orphaned row to clean up.
  const id = Store.newId();
  const save = document.getElementById("doc-save");
  save.disabled = true;
  save.textContent = "Uploading\u2026";
  try {
    const path = await Store.uploadDocument(p.id, id, file);
    const saved = await Store.saveDocument(
      {
        projectId: p.id,
        name: typed || file.name,
        kind,
        path,
        size: file.size || 0,
        mime: file.type || "",
        note,
      },
      id
    );
    allDocs = [saved, ...allDocs];
    closeDocModal();
    renderProject();
  } catch (err) {
    docError(err.message || "Could not upload that.");
  } finally {
    save.disabled = false;
    save.textContent = "Save";
  }
}

// Nothing in the bucket is readable without a signed link, so opening one is a
// round trip. The window is opened first and pointed afterwards, because a
// browser only trusts a new tab that was opened during the click itself.
async function openDocument(id) {
  const doc = allDocs.find((d) => d.id === id);
  if (!doc) return;
  const tab = window.open("", "_blank", "noopener");
  try {
    const urls = await Store.signDocuments([doc.path], 3600);
    const url = urls[doc.path];
    if (!url) throw new Error("That file is no longer in storage.");
    if (tab) tab.location = url;
    else window.location = url;
  } catch (err) {
    if (tab) tab.close();
    reportError("open that document", err);
  }
}

async function deleteDocument(id) {
  const doc = allDocs.find((d) => d.id === id);
  if (!doc) return;
  if (!confirm('Delete "' + doc.name + '"? The file goes with it.')) return;
  try {
    await Store.deleteDocument(doc);
    allDocs = allDocs.filter((d) => d.id !== id);
    renderProject();
  } catch (err) {
    reportError("delete that document", err);
  }
}

// ---------- Loan payoff ----------
function renderLoan(p) {
  // Nothing to pay off on a cash deal, and no tab to show it on either.
  if (!isFinanced(p)) return;

  const n = loanNumbers(p, draws);
  document.getElementById("loan-lender").textContent = p.lender
    ? p.lender + " \u00b7 Note " + money(p.loanAmount)
    : "No lender on this project";
  document.getElementById("loan-funded").textContent = money(n.funded);
  document.getElementById("loan-draws").textContent = money(n.totalDraws);
  document.getElementById("loan-payoff").textContent = money(n.payoff);

  const holdbackStatus =
    n.remaining < 0
      ? "over-drawn by <strong>" + money(-n.remaining) + "</strong>"
      : "remaining: <strong>" + money(n.remaining) + "</strong>";
  document.getElementById("loan-holdback-note").innerHTML =
    "Construction holdback " + holdbackStatus + " of " + money(p.loanHoldback) +
    " available to draw. Payoff shown is principal only \u2014 it excludes interest & exit fees.";

  renderDrawsTable(p);
}

function renderDrawsTable(p) {
  const el = document.getElementById("draws-table");
  if (!draws.length) {
    el.innerHTML =
      '<p class="empty">No construction draws logged yet \u2014 $0 of the ' +
      money(p.loanHoldback) +
      " holdback drawn. Add a draw each time you pull from the construction reserve.</p>";
    return;
  }
  const rows = draws
    .slice()
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""))
    .map(
      (d) =>
        "<tr>" +
        '<td class="col-date">' + escapeHtml(d.date || "\u2014") + "</td>" +
        "<td>" + escapeHtml(d.note || "Construction draw") + "</td>" +
        '<td class="amount">' + money(d.amount) + "</td>" +
        '<td class="actions-cell">' +
        '<button class="icon-btn" data-draw-edit="' + d.id + '">Edit</button>' +
        '<button class="icon-btn del" data-draw-del="' + d.id + '">Delete</button>' +
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

// ---------- Grouped expense tables ----------
function groupKey(e, mode) {
  if (mode === "partner") return partnerName(e.partnerId);
  if (mode === "costType") return e.costType || "Other";
  return e.category || "Uncategorized";
}

function orderedGroups(mode) {
  if (mode === "partner") return partnersOf(activeProjectId).map((p) => p.name);
  if (mode === "costType") return COST_TYPES.map((c) => c.value);
  return categoryNames();
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
    const subtotal = sum(rows);

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
  const list = partnersOf(activeProjectId);
  const idx = list.findIndex((p) => p.id === e.partnerId);
  const badgeClass = idx % 2 === 0 ? "badge a" : "badge";
  const receipts = Array.isArray(e.receipts) ? e.receipts : [];
  const thumbs = receipts
    .map((entry, i) => {
      const src = receiptSrc(entry);
      if (!src) return "";
      return (
        '<img class="thumb" src="' + escapeHtml(src) + '" alt="Receipt ' + (i + 1) +
        '" data-lightbox="' + escapeHtml(src) + '" />'
      );
    })
    .join("");
  const notes = e.notes ? '<div class="row-notes">' + escapeHtml(e.notes) + "</div>" : "";
  const who = e.contractorId && contractorName(e.contractorId)
    ? '<div class="row-contractor">Paid to ' + escapeHtml(contractorName(e.contractorId)) + "</div>"
    : "";
  const extras =
    notes || who || thumbs
      ? '<div class="row-extras">' + notes + who +
        (thumbs ? '<div class="thumbs">' + thumbs + "</div>" : "") + "</div>"
      : "";
  return `
    <tr>
      <td class="col-date">${escapeHtml(e.date || "—")}</td>
      <td>${escapeHtml(e.description)}${extras}</td>
      <td><span class="${badgeClass}">${escapeHtml(partnerName(e.partnerId))}</span></td>
      <td class="amount">${money(e.amount)}</td>
      <td class="actions-cell">
        <button class="icon-btn" data-edit="${e.id}">Edit</button>
        <button class="icon-btn del" data-del="${e.id}">Delete</button>
      </td>
    </tr>`;
}

// ===========================================================================
// EXPENSE MODAL
// ===========================================================================
function fillSelect(el, values, current) {
  el.innerHTML = values
    .map(
      (v) =>
        `<option value="${escapeHtml(v.value)}"${v.value === current ? " selected" : ""}>${escapeHtml(v.label)}</option>`
    )
    .join("");
}

// Categories are grouped so the construction phases read as a scope of work
// rather than one long alphabetical list.
function fillCategorySelect(el, current) {
  el.innerHTML = CATEGORY_GROUPS.map(
    (g) =>
      '<optgroup label="' + escapeHtml(g.label) + '">' +
      categoriesIn(g.key)
        .map(
          (name) =>
            '<option value="' + escapeHtml(name) + '"' +
            (name === current ? " selected" : "") + ">" + escapeHtml(name) + "</option>"
        )
        .join("") +
      "</optgroup>"
  ).join("");
}

function openModal(id) {
  const list = partnersOf(activeProjectId);
  if (!list.length) {
    alert("Add at least one partner in Project Details first, so expenses can be attributed.");
    return;
  }
  const form = document.getElementById("expense-form");
  const existing = id ? expenses.find((e) => e.id === id) : null;

  document.getElementById("modal-title").textContent = existing ? "Edit Expense" : "Add Expense";
  document.getElementById("f-id").value = existing ? existing.id : "";
  document.getElementById("f-date").value = existing ? existing.date || "" : "";
  document.getElementById("f-amount").value = existing ? existing.amount : "";
  document.getElementById("f-description").value = existing ? existing.description : "";
  document.getElementById("f-notes").value = existing ? existing.notes || "" : "";
  // Photos are addressed by storage path; the id has to exist before the
  // upload so the file lands in the folder its policies expect.
  pendingExpenseId = existing ? existing.id : Store.newId();
  removedReceiptPaths = [];
  pendingReceipts = (existing && Array.isArray(existing.receipts) ? existing.receipts : [])
    .map((entry) => ({ path: entry, blob: null, url: receiptSrc(entry) }));
  scanUndo = null;
  scanSay("", false);
  renderReceiptPreviews();

  fillSelect(
    document.getElementById("f-partner"),
    list.map((p) => ({ value: p.id, label: p.name })),
    existing ? existing.partnerId : list[0].id
  );
  fillCategorySelect(document.getElementById("f-category"),
    existing ? existing.category : "General Construction");
  fillSelect(
    document.getElementById("f-costtype"),
    COST_TYPES.map((c) => ({ value: c.value, label: c.label })),
    existing ? existing.costType : defaultCostTypeFor("General Construction")
  );
  fillSelect(
    document.getElementById("f-contractor"),
    [{ value: "", label: "— not tracked —" }].concat(
      contractors.map((c) => ({ value: c.id, label: c.company ? c.name + " (" + c.company + ")" : c.name }))
    ),
    existing ? existing.contractorId || "" : ""
  );
  syncContractorField();

  document.getElementById("modal").classList.remove("hidden");
  document.getElementById("f-description").focus();
  form.onsubmit = (ev) => {
    ev.preventDefault();
    saveFromForm();
  };
}

// Naming who was paid only matters for the spend that ends up on a 1099.
// Asking for a contractor against a load of tile would just be noise.
function syncContractorField() {
  const relevant = is1099CostType(document.getElementById("f-costtype").value);
  document.getElementById("f-contractor-field").classList.toggle("hidden", !relevant);
  if (!relevant) document.getElementById("f-contractor").value = "";
}

function closeModal() {
  document.getElementById("modal").classList.add("hidden");
  for (const r of pendingReceipts) if (r.url.startsWith("blob:")) URL.revokeObjectURL(r.url);
  pendingReceipts = [];
  removedReceiptPaths = [];
  pendingExpenseId = null;
}

async function saveFromForm() {
  const id = document.getElementById("f-id").value;
  const expenseId = id || pendingExpenseId;

  // Upload first. A half-written row pointing at a photo that never arrived is
  // worse than a failed save, so nothing touches the database until every
  // image is in the bucket.
  let paths;
  try {
    paths = [];
    for (const r of pendingReceipts) {
      paths.push(r.blob ? await Store.uploadReceipt(activeProjectId, expenseId, r.blob) : r.path);
    }
  } catch (err) {
    reportError("upload the receipt photos", err);
    return;
  }

  const record = {
    projectId: activeProjectId,
    date: document.getElementById("f-date").value,
    amount: parseFloat(document.getElementById("f-amount").value) || 0,
    description: document.getElementById("f-description").value.trim(),
    notes: document.getElementById("f-notes").value.trim(),
    receipts: paths,
    partnerId: document.getElementById("f-partner").value,
    category: document.getElementById("f-category").value,
    costType: document.getElementById("f-costtype").value,
    contractorId: document.getElementById("f-contractor").value || null,
  };

  try {
    const saved = await Store.saveExpense(record, expenseId);
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

  try {
    await Store.deleteReceipts(removedReceiptPaths);
    Object.assign(receiptUrls, await Store.signReceipts(paths));
  } catch (err) {
    console.warn("Expense saved; tidying up the photos failed:", err.message);
  }

  syncSummaries();
  closeModal();
  renderProject();
}

async function removeExpense(id) {
  const e = expenses.find((x) => x.id === id);
  if (!e) return;
  if (!confirm(`Delete "${e.description}" (${money(e.amount)})?`)) return;
  try {
    await Store.deleteExpense(id);
    // Only once the row is gone, so a failed delete never orphans the photos.
    await Store.deleteReceipts(e.receipts);
  } catch (err) {
    reportError("delete this expense", err);
    return;
  }
  expenses = expenses.filter((x) => x.id !== id);
  syncSummaries();
  renderProject();
}

// ---------- Receipts ----------
// A receipt is a storage path. Storage is private, so a path is useless on its
// own — it has to be exchanged for a signed URL before an <img> can show it.
// Sign the whole project in one call rather than one call per thumbnail.
async function refreshReceiptUrls() {
  const paths = [];
  for (const e of expenses) for (const r of e.receipts || []) if (!isDataUrl(r)) paths.push(r);
  receiptUrls = paths.length ? await Store.signReceipts(paths) : {};
}

function receiptSrc(entry) {
  if (isDataUrl(entry)) return entry;
  // A photo taken with no signal exists only on this device until the queue
  // drains, so it is shown straight from local storage.
  return Offline.previewUrl(entry) || receiptUrls[entry] || "";
}

// ===========================================================================
// WORKING WITHOUT SIGNAL
// ===========================================================================
let syncing = false;

// The bar under the header is the only place the app talks about connectivity.
// It stays out of the way when there is nothing to report.
async function renderSyncBar() {
  const bar = document.getElementById("sync-bar");
  const text = document.getElementById("sync-text");
  const now = document.getElementById("sync-now");
  const discard = document.getElementById("sync-discard");

  const items = await Offline.pending();
  const stuck = items.filter((i) => i.tries > 0);
  const offline = !Offline.online();

  if (!items.length && !offline) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  bar.classList.toggle("sync-stuck", stuck.length > 0);
  bar.classList.toggle("sync-offline", offline && !stuck.length);

  const n = items.length;
  const changes = n + (n === 1 ? " change" : " changes");

  if (stuck.length) {
    text.textContent =
      stuck.length + " of your " + changes + " were refused by the server: " +
      stuck[0].error + ". The rest are still queued.";
  } else if (offline && n) {
    text.textContent = "No signal. " + changes + " saved on this device and will go up on their own.";
  } else if (offline) {
    text.textContent = "No signal. You can keep working \u2014 everything is saved here until it can be sent.";
  } else if (syncing) {
    text.textContent = "Sending " + changes + "\u2026";
  } else {
    text.textContent = changes + " waiting to be sent.";
  }

  now.classList.toggle("hidden", offline || !n || syncing);
  discard.classList.toggle("hidden", !stuck.length);
}

async function syncNow() {
  if (syncing || !Offline.online()) return;
  syncing = true;
  await renderSyncBar();
  try {
    const result = await Store.sync();
    // What came back from the server is the truth, so reload rather than trying
    // to reconcile by hand.
    if (result.sent) await loadAll();
  } catch (err) {
    console.error(err);
  } finally {
    syncing = false;
    await renderSyncBar();
  }
}

// Only ever offered for entries the server has actually refused, never for
// anything that is merely waiting.
async function discardStuck() {
  const items = await Offline.pending();
  const stuck = items.filter((i) => i.tries > 0);
  if (!stuck.length) return;
  if (!confirm(
    "Throw away " + stuck.length + " change" + (stuck.length === 1 ? "" : "s") +
    " the server refused? This cannot be undone."
  )) return;
  for (const i of stuck) await Offline.remove(i.id);
  await renderSyncBar();
}

// A cached copy of the last successful load, so opening the app in a basement
// shows the project instead of an empty dashboard.
function snapshotNow() {
  if (!currentUser) return;
  Offline.saveSnapshot(currentUser.id, {
    projects, partners, memberships, contractors, budgets, tasks, summaries, allDraws,
    allCategories, allDocs,
  });
}

function restoreSnapshot() {
  if (!currentUser) return false;
  const snap = Offline.readSnapshot(currentUser.id);
  if (!snap || !snap.data) return false;
  const d = snap.data;
  projects = d.projects || [];
  partners = d.partners || [];
  memberships = d.memberships || [];
  contractors = d.contractors || [];
  budgets = d.budgets || [];
  tasks = d.tasks || [];
  summaries = d.summaries || [];
  allDraws = d.allDraws || [];
  allCategories = d.allCategories || [];
  allDocs = d.allDocs || [];
  return true;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  navigator.serviceWorker.register("sw.js").then((reg) => {
    // Look for a new version on every load, not only when the browser feels
    // like it. A deploy nobody is told about may as well not have happened.
    reg.update().catch(() => {});
    // A new version is never forced on someone mid-entry; they are asked.
    reg.addEventListener("updatefound", () => {
      const fresh = reg.installing;
      if (!fresh) return;
      fresh.addEventListener("statechange", () => {
        if (fresh.state === "installed" && navigator.serviceWorker.controller) {
          if (confirm("A newer version of the app is ready. Reload now?")) {
            fresh.postMessage("skip-waiting");
            location.reload();
          }
        }
      });
    });
  }).catch((err) => console.warn("[app] service worker did not register", err));
}

// Old receipts were base64 blobs inside the expense row. Move them across as
// each project is opened: upload first, confirm the upload is readable, and
// only then rewrite the row. If any step fails the original is left untouched.
async function migrateLegacyReceipts() {
  const projectId = activeProjectId;
  if (!canEdit(projectId)) return;
  const stale = expenses.filter((e) => (e.receipts || []).some(isDataUrl));
  if (!stale.length) return;

  let moved = 0;
  for (const e of stale) {
    if (activeProjectId !== projectId) return; // user navigated away
    const next = [];
    let changed = false;
    for (const entry of e.receipts) {
      if (!isDataUrl(entry)) {
        next.push(entry);
        continue;
      }
      try {
        const path = await Store.uploadReceipt(projectId, e.id, dataUrlToBlob(entry));
        const signed = await Store.signReceipts([path]);
        if (!signed[path]) throw new Error("uploaded receipt was not readable");
        receiptUrls[path] = signed[path];
        next.push(path);
        changed = true;
        moved++;
      } catch (err) {
        console.warn("Leaving a receipt in the database for now:", err.message);
        next.push(entry);
      }
    }
    if (!changed) continue;
    try {
      const saved = await Store.saveExpense({ ...e, receipts: next }, e.id);
      const i = expenses.findIndex((x) => x.id === e.id);
      if (i > -1) expenses[i] = saved;
    } catch (err) {
      console.warn("Could not rewrite the expense, receipts stay as they were:", err.message);
    }
  }
  if (moved && activeProjectId === projectId) renderGroups();
}

function renderReceiptPreviews() {
  const el = document.getElementById("receipt-previews");
  // Only a photo still on the device can be read; one already in Storage would
  // have to be downloaded again to tell us what we saved from it.
  document.getElementById("scan-receipt").classList.toggle("hidden", !scannablePhoto());
  if (!pendingReceipts.length) {
    el.innerHTML = '<span class="no-receipts">No photos attached yet.</span>';
    return;
  }
  el.innerHTML = pendingReceipts
    .map(
      (r, i) =>
        '<div class="preview">' +
        '<img src="' + escapeHtml(r.url) + '" alt="Receipt ' + (i + 1) +
        '" data-lightbox="' + escapeHtml(r.url) + '" />' +
        '<button type="button" class="remove-receipt" data-remove="' + i + '" title="Remove">&times;</button>' +
        "</div>"
    )
    .join("");
  el.querySelectorAll("[data-remove]").forEach((b) =>
    b.addEventListener("click", () => {
      const [gone] = pendingReceipts.splice(Number(b.dataset.remove), 1);
      // Deleted from storage only after the expense saves, so cancelling out
      // of the form cannot destroy a photo.
      if (gone && gone.path) removedReceiptPaths.push(gone.path);
      if (gone && gone.url.startsWith("blob:")) URL.revokeObjectURL(gone.url);
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
      const blob = await compressImage(file);
      pendingReceipts.push({ path: null, blob, url: URL.createObjectURL(blob) });
    } catch (err) {
      alert(err.message);
    }
  }
  renderReceiptPreviews();
}

// ===========================================================================
// READING A RECEIPT INTO THE FORM
// ===========================================================================
let scanUndo = null;

function scanSay(message, undoable) {
  const box = document.getElementById("scan-status");
  document.getElementById("scan-text").textContent = message || "";
  document.getElementById("scan-undo").classList.toggle("hidden", !undoable);
  box.classList.toggle("hidden", !message);
}

// Only the photo just taken is offered, since that is the one being looked at.
function scannablePhoto() {
  for (let i = pendingReceipts.length - 1; i >= 0; i--) {
    if (pendingReceipts[i].blob) return pendingReceipts[i];
  }
  return null;
}

async function scanReceipt() {
  const shot = scannablePhoto();
  if (!shot) return;
  const btn = document.getElementById("scan-receipt");

  if (!Ocr.ready() && !Offline.online()) {
    scanSay("Reading a photo needs a connection the first time. Type it in for now.", false);
    return;
  }

  btn.disabled = true;
  scanSay("Reading the photo\u2026", false);
  try {
    const found = await Ocr.scan(shot.blob, (pct) => scanSay("Reading the photo\u2026 " + pct + "%", false));
    applyScan(found);
  } catch (err) {
    console.warn("[ocr]", err);
    scanSay("Could not read that photo. " + (err.message || ""), false);
  } finally {
    btn.disabled = false;
  }
}

// Nothing the user typed is ever overwritten. A guess off a crumpled photo has
// no business beating something somebody entered deliberately.
function applyScan(found) {
  const set = (id, value) => {
    const el = document.getElementById(id);
    scanUndo.push([id, el.value]);
    el.value = value;
  };
  scanUndo = [];
  const said = [];

  const amountEl = document.getElementById("f-amount");
  if (found.amount && !(parseFloat(amountEl.value) > 0)) {
    set("f-amount", String(found.amount));
    said.push(money(found.amount));
  }
  if (found.date && !document.getElementById("f-date").value) {
    set("f-date", found.date);
    said.push(found.date);
  }
  if (found.vendor && !document.getElementById("f-description").value.trim()) {
    set("f-description", found.vendor);
    said.push(found.vendor);
  }

  // The category is only suggested over the default, never over a choice — and
  // only if this project actually runs on the phase the photo looks like. The
  // list is the project's own now, so a guess can name one it does not have.
  const catEl = document.getElementById("f-category");
  if (
    found.category &&
    catEl.value === "General Construction" &&
    found.category !== catEl.value &&
    categoryNames().includes(found.category)
  ) {
    set("f-category", found.category);
    document.getElementById("f-costtype").value = defaultCostTypeFor(found.category);
    syncContractorField();
    said.push(found.category);
  }

  const contractorId = matchContractor(found.vendor, contractors);
  const contractorEl = document.getElementById("f-contractor");
  if (contractorId && !contractorEl.value && !document.getElementById("f-contractor-field").classList.contains("hidden")) {
    set("f-contractor", contractorId);
    said.push(contractorName(contractorId));
  }

  if (!said.length) {
    scanUndo = null;
    scanSay(
      found.amount || found.date || found.vendor
        ? "Nothing new on that photo \u2014 what it found is already filled in."
        : "Nothing legible on that photo. Type it in.",
      false
    );
    return;
  }
  scanSay("From the photo: " + said.join(" \u00b7 ") + ". Check it against the paper.", true);
}

function undoScan() {
  if (!scanUndo) return;
  for (const [id, was] of scanUndo) document.getElementById(id).value = was;
  syncContractorField();
  scanUndo = null;
  scanSay("Put back the way it was.", false);
}

function openLightbox(src) {
  document.getElementById("lightbox-img").src = src;
  document.getElementById("lightbox").classList.remove("hidden");
}

function closeLightbox() {
  document.getElementById("lightbox").classList.add("hidden");
  document.getElementById("lightbox-img").src = "";
}

// ===========================================================================
// DRAW MODAL
// ===========================================================================
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
    projectId: activeProjectId,
    date: document.getElementById("d-date").value,
    amount: parseFloat(document.getElementById("d-amount").value) || 0,
    note: document.getElementById("d-note").value.trim(),
  };
  try {
    const saved = await Store.saveDraw(record, id || null);
    if (id) {
      const i = draws.findIndex((d) => d.id === id);
      if (i > -1) draws[i] = saved;
      const j = allDraws.findIndex((d) => d.id === id);
      if (j > -1) allDraws[j] = saved;
    } else {
      draws.push(saved);
      allDraws.push(saved);
    }
  } catch (err) {
    reportError("save this draw", err);
    return;
  }
  closeDrawModal();
  renderProject();

  const p = activeProject();
  const n = loanNumbers(p, draws);
  if (n.remaining < 0) {
    alert(
      "Heads up: total draws (" + money(n.totalDraws) + ") now exceed the " +
        money(p.loanHoldback) + " construction holdback by " + money(-n.remaining) + "."
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
  allDraws = allDraws.filter((x) => x.id !== id);
  renderProject();
}

// ===========================================================================
// LENDER DRAW REQUEST
//
// A draw request is an invoice to the lender: here is the work we paid for
// since the last draw, here are the receipts, please release the money. The
// slowest part of a rehab is usually waiting on that, so the app builds it
// rather than making you retype the ledger into a spreadsheet.
// ===========================================================================
let drawReqSelection = new Set();

// Anything filed under the construction bucket, spent after the last draw was
// taken. Holding costs and closing fees are excluded: a construction lender
// reimburses work, not insurance.
function drawRequestCandidates() {
  const last = draws
    .map((d) => d.date)
    .filter(Boolean)
    .sort()
    .pop();
  return expenses
    .filter((e) => categoryGroup(e.category) === "build")
    .filter((e) => !last || !e.date || e.date > last)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function openDrawRequest() {
  const p = activeProject();
  if (!p) return;
  const list = drawRequestCandidates();
  if (!list.length) {
    alert("Nothing to request yet — no work has been paid for since your last draw.");
    return;
  }

  drawReqSelection = new Set(list.map((e) => e.id));
  document.getElementById("dr-number").value = draws.length + 1;
  document.getElementById("dr-date").value = new Date().toISOString().slice(0, 10);
  document.getElementById("dr-all").checked = true;

  document.getElementById("drawreq-picker").innerHTML = list
    .map(
      (e) =>
        '<label class="drawreq-row">' +
        '<input type="checkbox" data-dr="' + escapeHtml(e.id) + '" checked />' +
        '<span class="dr-date">' + escapeHtml(e.date || "—") + "</span>" +
        '<span class="dr-desc">' + escapeHtml(e.description) +
        '<em>' + escapeHtml(e.category) + " · " + escapeHtml(e.costType) +
        ((e.receipts || []).length ? " · " + e.receipts.length + " receipt" +
          (e.receipts.length === 1 ? "" : "s") : " · no receipt") +
        "</em></span>" +
        '<span class="dr-amount">' + money(e.amount) + "</span>" +
        "</label>"
    )
    .join("");

  document.getElementById("drawreq-picker")
    .querySelectorAll("[data-dr]")
    .forEach((cb) =>
      cb.addEventListener("change", () => {
        if (cb.checked) drawReqSelection.add(cb.dataset.dr);
        else drawReqSelection.delete(cb.dataset.dr);
        updateDrawRequestTotal();
      })
    );

  updateDrawRequestTotal();
  document.getElementById("drawreq-modal").classList.remove("hidden");
}

function updateDrawRequestTotal() {
  const p = activeProject();
  const picked = expenses.filter((e) => drawReqSelection.has(e.id));
  const total = sum(picked);
  document.getElementById("dr-total").textContent = money(total);

  const { remaining } = loanNumbers(p, draws);
  const missing = picked.filter((e) => !(e.receipts || []).length).length;
  const notes = [];
  if (total > remaining) {
    notes.push(
      "This is more than the " + money(remaining) +
      " left in the holdback. The lender will not fund the difference."
    );
  }
  if (missing) {
    notes.push(missing + " line" + (missing === 1 ? " has" : "s have") +
      " no receipt attached, which is the usual reason a draw gets held up.");
  }
  document.getElementById("dr-warning").textContent = notes.join(" ");
}

function closeDrawRequest() {
  document.getElementById("drawreq-modal").classList.add("hidden");
}

// The document is built into a hidden element and revealed by the print
// stylesheet, so what you see in the print preview is the whole page and
// nothing else — no app chrome, no buttons.
function printDrawRequest() {
  const p = activeProject();
  const picked = expenses.filter((e) => drawReqSelection.has(e.id));
  if (!picked.length) {
    alert("Tick at least one line to request.");
    return;
  }
  const total = sum(picked);
  const { funded, totalDraws, remaining } = loanNumbers(p, draws);
  const number = document.getElementById("dr-number").value || draws.length + 1;
  const date = document.getElementById("dr-date").value || new Date().toISOString().slice(0, 10);

  const byCategory = {};
  for (const e of picked) (byCategory[e.category] = byCategory[e.category] || []).push(e);

  const field = (label, value) =>
    '<div class="dq-field"><span>' + escapeHtml(label) + "</span><strong>" +
    escapeHtml(value || "—") + "</strong></div>";

  document.getElementById("drawreq-doc").innerHTML =
    '<div class="dq-head">' +
    "<h1>Construction Draw Request</h1>" +
    '<div class="dq-number">Draw #' + escapeHtml(String(number)) + " · " + escapeHtml(date) + "</div>" +
    "</div>" +
    '<div class="dq-fields">' +
    field("Property", p.address || p.name) +
    field("Borrower", p.borrower) +
    field("Lender", p.lender) +
    field("Settlement date", p.settlementDate) +
    "</div>" +
    '<div class="dq-fields">' +
    field("Loan amount", money(p.loanAmount)) +
    field("Funded at closing", money(funded)) +
    field("Draws taken to date", money(totalDraws)) +
    field("Holdback remaining", money(remaining)) +
    "</div>" +
    "<h2>Work completed and paid</h2>" +
    '<table class="dq-table"><thead><tr>' +
    "<th>Date</th><th>Description</th><th>Cost type</th><th>Paid by</th>" +
    '<th class="amount">Amount</th><th>Receipt</th>' +
    "</tr></thead><tbody>" +
    Object.keys(byCategory)
      .map(
        (cat) =>
          '<tr class="dq-cat"><td colspan="6">' + escapeHtml(cat) + "</td></tr>" +
          byCategory[cat]
            .map(
              (e) =>
                "<tr>" +
                "<td>" + escapeHtml(e.date || "—") + "</td>" +
                "<td>" + escapeHtml(e.description) +
                (e.notes ? '<em class="dq-note">' + escapeHtml(e.notes) + "</em>" : "") +
                (contractorName(e.contractorId)
                  ? '<em class="dq-note">Paid to ' + escapeHtml(contractorName(e.contractorId)) + "</em>"
                  : "") + "</td>" +
                "<td>" + escapeHtml(e.costType) + "</td>" +
                "<td>" + escapeHtml(partnerName(e.partnerId)) + "</td>" +
                '<td class="amount">' + money(e.amount) + "</td>" +
                "<td>" + ((e.receipts || []).length ? "Attached" : "—") + "</td>" +
                "</tr>"
            )
            .join("") +
          '<tr class="dq-subtotal"><td colspan="4">' + escapeHtml(cat) + " subtotal</td>" +
          '<td class="amount">' + money(sum(byCategory[cat])) + "</td><td></td></tr>"
      )
      .join("") +
    "</tbody><tfoot><tr>" +
    '<td colspan="4">Total requested</td>' +
    '<td class="amount">' + money(total) + "</td><td></td>" +
    "</tr></tfoot></table>" +
    '<p class="dq-cert">The undersigned certifies that the costs listed above have been ' +
    "incurred and paid in connection with the property described, and that this request " +
    "does not include any amount for which a previous draw has been received.</p>" +
    '<div class="dq-sign">' +
    '<div class="dq-sign-line"><span></span>Borrower signature</div>' +
    '<div class="dq-sign-line"><span></span>Date</div>' +
    "</div>";

  document.body.classList.add("printing-draw");
  window.print();
  document.body.classList.remove("printing-draw");
}

// ===========================================================================
// CONTRACTORS, COMPLIANCE AND 1099s
//
// The directory is deliberately not per project. The same tile setter works on
// three of your deals, his insurance either lapses or it does not, and at year
// end the IRS wants one number per person across everything you paid them.
// ===========================================================================
function contractorById(id) {
  return contractors.find((c) => c.id === id) || null;
}

function contractorName(id) {
  const c = contractorById(id);
  return c ? c.company || c.name : "";
}

// The worst of the two dates is what the contractor is judged on: current
// insurance is no help if the licence lapsed last month.
function complianceOf(c) {
  const coi = expiryState(c.coiExpires);
  const lic = expiryState(c.licenseExpires);
  const rank = { expired: 3, soon: 2, none: 1, ok: 0 };
  return rank[coi.key] >= rank[lic.key] ? coi : lic;
}

function contractorsNeedingAttention() {
  return contractors
    .map((c) => ({ contractor: c, state: complianceOf(c) }))
    .filter((x) => x.state.key === "expired" || x.state.key === "soon");
}

function renderComplianceAlert() {
  const el = document.getElementById("compliance-alert");
  const flagged = contractorsNeedingAttention();
  if (!flagged.length) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  const expired = flagged.filter((x) => x.state.key === "expired");
  const soon = flagged.filter((x) => x.state.key === "soon");
  const parts = [];
  if (expired.length) {
    parts.push(
      "<strong>" + expired.length + " contractor" + (expired.length === 1 ? " has" : "s have") +
      " expired paperwork:</strong> " +
      expired.map((x) => escapeHtml(x.contractor.name)).join(", ")
    );
  }
  if (soon.length) {
    parts.push(
      soon.length + " expiring within " + EXPIRY_WARNING_DAYS + " days: " +
      soon.map((x) => escapeHtml(x.contractor.name)).join(", ")
    );
  }
  el.className = "compliance-alert " + (expired.length ? "alert-expired" : "alert-soon");
  el.innerHTML =
    '<div class="alert-body">' + parts.join(" &nbsp;·&nbsp; ") + "</div>" +
    '<button class="btn btn-small" id="alert-open">Review</button>';
  document.getElementById("alert-open").addEventListener("click", () => openContractorModal("directory"));
}

// ---------- Directory ----------
function openContractorModal(tab) {
  showContractorTab(tab || "directory");
  renderContractorList();
  fillTaxYears();
  renderTaxList();
  document.getElementById("contractor-modal").classList.remove("hidden");
}

function closeContractorModal() {
  document.getElementById("contractor-modal").classList.add("hidden");
}

function showContractorTab(name) {
  document.querySelectorAll("#contractor-modal .tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === name)
  );
  document.getElementById("tab-directory").classList.toggle("hidden", name !== "directory");
  document.getElementById("tab-tax").classList.toggle("hidden", name !== "tax");
}

// ===========================================================================
// CATEGORIES
//
// The scope of work is not the same on every job, so the list is yours to
// change. It is edited in two places, through the same screen:
//
//   a project   the phases that job is actually run on. Everyone with access
//               sees the same list, because they are looking at one job.
//   the library  your own template, which every new project starts from.
//
// Saving happens as you type rather than behind a Save button, because a
// half-applied rename would leave expenses pointing at a phase that is gone.
// ===========================================================================
let categoryScope = null; // a project id, or null for the library
let editingCategories = [];

async function openCategories(projectId) {
  categoryScope = projectId || null;
  catError("");
  document.getElementById("category-modal-title").textContent = projectId
    ? "Categories on " + (activeProject() ? activeProject().name : "this project")
    : "Your Category Library";
  document.getElementById("category-modal-blurb").textContent = projectId
    ? "The phases this job is run on. Everyone with access to the project sees this list."
    : "The list every new project starts from. Nobody else can see it.";

  fillSelect(
    document.getElementById("cat-new-group"),
    CATEGORY_GROUPS.map((g) => ({ value: g.key, label: g.label })),
    "build"
  );
  fillSelect(
    document.getElementById("cat-new-costtype"),
    COST_TYPES.map((c) => ({ value: c.value, label: c.label })),
    "Materials"
  );
  document.getElementById("cat-new-name").value = "";
  document.getElementById("category-modal").classList.remove("hidden");

  try {
    editingCategories = projectId
      ? allCategories.filter((c) => c.projectId === projectId).slice()
      : await Store.getCategoryLibrary();
  } catch (err) {
    reportError("open your categories", err);
    return;
  }
  renderCategoryEditor();
}

function closeCategories() {
  document.getElementById("category-modal").classList.add("hidden");
  editingCategories = [];
}

function catError(message) {
  const el = document.getElementById("cat-error");
  el.textContent = message || "";
  el.classList.toggle("cat-error", !!message);
}

// How many expenses and budget lines are filed under a name, which decides
// whether it can be deleted and warns what a rename will carry with it.
function categoryUsage(name) {
  if (!categoryScope) return 0;
  return (
    summaries.filter((e) => e.projectId === categoryScope && e.category === name).length +
    budgets.filter((b) => b.projectId === categoryScope && b.category === name).length +
    tasks.filter((t) => t.projectId === categoryScope && t.category === name).length
  );
}

function renderCategoryEditor() {
  const el = document.getElementById("category-editor");
  if (!editingCategories.length) {
    el.innerHTML =
      '<p class="empty">No categories yet. Add the first one below, or restore ' +
      "the list the app ships with.</p>";
    return;
  }

  el.innerHTML = CATEGORY_GROUPS.map((g) => {
    const rows = editingCategories.filter((c) => c.group === g.key);
    if (!rows.length) return "";
    return (
      '<div class="cat-group">' +
      "<h4>" + escapeHtml(g.label) + "</h4>" +
      rows
        .map((c) => {
          const used = categoryUsage(c.name);
          return (
            '<div class="cat-row" data-cat="' + escapeHtml(c.id) + '">' +
            '<input type="text" class="cat-name" value="' + escapeHtml(c.name) + '" />' +
            '<select class="cat-group-pick">' +
            CATEGORY_GROUPS.map(
              (o) =>
                '<option value="' + o.key + '"' +
                (o.key === c.group ? " selected" : "") +
                ">" + escapeHtml(o.label) + "</option>"
            ).join("") +
            "</select>" +
            '<select class="cat-cost-pick">' +
            COST_TYPES.map(
              (o) =>
                '<option value="' + o.value + '"' +
                (o.value === c.defaultCostType ? " selected" : "") +
                ">" + escapeHtml(o.label) + "</option>"
            ).join("") +
            "</select>" +
            '<span class="cat-used">' + (used ? used + " in use" : "") + "</span>" +
            '<button type="button" class="icon-btn del cat-del">Remove</button>' +
            "</div>"
          );
        })
        .join("") +
      "</div>"
    );
  }).join("");
}

function categoryRowId(ev) {
  const row = ev.target.closest(".cat-row");
  return row ? row.dataset.cat : null;
}

async function saveCategoryEdit(id, changes, renamedFrom) {
  const current = editingCategories.find((c) => c.id === id);
  if (!current) return;
  const next = { ...current, ...changes };

  const clash = editingCategories.some(
    (c) => c.id !== id && c.name.toLowerCase() === next.name.toLowerCase()
  );
  if (clash) {
    catError("There is already a category called " + next.name + ".");
    renderCategoryEditor();
    return;
  }

  try {
    // The cascade goes first. If it fails the category keeps its old name and
    // everything filed under it is still pointing somewhere real.
    if (renamedFrom && categoryScope) {
      await Store.renameCategory(categoryScope, renamedFrom, next.name);
    }
    const saved = await Store.saveCategory({ ...next, projectId: categoryScope }, id);
    Object.assign(current, saved);
    if (renamedFrom && categoryScope) {
      for (const e of summaries) {
        if (e.projectId === categoryScope && e.category === renamedFrom) e.category = next.name;
      }
      for (const e of expenses) if (e.category === renamedFrom) e.category = next.name;
      for (const b of budgets) {
        if (b.projectId === categoryScope && b.category === renamedFrom) b.category = next.name;
      }
      for (const t of tasks) {
        if (t.projectId === categoryScope && t.category === renamedFrom) t.category = next.name;
      }
    }
    afterCategoryChange();
  } catch (err) {
    reportError("save that category", err);
    renderCategoryEditor();
  }
}

async function addCategory() {
  const name = document.getElementById("cat-new-name").value.trim();
  if (!name) return;
  if (editingCategories.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    catError("There is already a category called " + name + ".");
    return;
  }
  catError("");

  try {
    const saved = await Store.saveCategory(
      {
        projectId: categoryScope,
        name,
        group: document.getElementById("cat-new-group").value,
        defaultCostType: document.getElementById("cat-new-costtype").value,
        sort: (editingCategories.length + 1) * 10,
      },
      null
    );
    editingCategories.push(saved);
    document.getElementById("cat-new-name").value = "";
    afterCategoryChange();
  } catch (err) {
    reportError("add that category", err);
  }
}

async function removeCategory(id) {
  const c = editingCategories.find((x) => x.id === id);
  if (!c) return;

  const used = categoryUsage(c.name);
  if (used) {
    catError(
      c.name + " cannot be removed: " + used + " " + (used === 1 ? "entry is" : "entries are") +
      " filed under it. Rename it, or move those over to another category first."
    );
    return;
  }
  if (!confirm("Remove " + c.name + "?")) return;

  try {
    await Store.deleteCategory(id);
    editingCategories = editingCategories.filter((x) => x.id !== id);
    catError("");
    afterCategoryChange();
  } catch (err) {
    reportError("remove that category", err);
  }
}

// Anything the app shipped with that is no longer on the list comes back. It
// is additive: nothing you renamed or added is touched.
async function restoreDefaultCategories() {
  const have = new Set(editingCategories.map((c) => c.name.toLowerCase()));
  const missing = DEFAULT_CATEGORIES.filter((d) => !have.has(d.name.toLowerCase()));
  if (!missing.length) {
    catError("Every default category is already on the list.");
    return;
  }
  catError("");

  try {
    let sort = editingCategories.length * 10;
    for (const d of missing) {
      sort += 10;
      const saved = await Store.saveCategory({ ...d, projectId: categoryScope, sort }, null);
      editingCategories.push(saved);
    }
    afterCategoryChange();
  } catch (err) {
    reportError("restore the default categories", err);
  }
}

// A project's list is the one the rest of the page is drawn from, so it has to
// go back into the shared state and the page redrawn. The library is only a
// template and changes nothing that is on screen.
function afterCategoryChange() {
  if (categoryScope) {
    allCategories = allCategories
      .filter((c) => c.projectId !== categoryScope)
      .concat(editingCategories);
    if (categoryScope === activeProjectId) {
      setActiveCategories(editingCategories);
      renderProject();
    }
  }
  editingCategories.sort((a, b) => (a.sort || 0) - (b.sort || 0));
  renderCategoryEditor();
}

function renderContractorList() {
  const el = document.getElementById("contractor-list");
  if (!contractors.length) {
    el.innerHTML =
      '<p class="empty">No contractors yet. Add the people you pay and the app will ' +
      "watch their insurance dates and total up their 1099s for you.</p>";
    document.getElementById("directory-summary").textContent = "";
    return;
  }

  const paid = {};
  for (const e of summaries) {
    if (e.contractorId) paid[e.contractorId] = (paid[e.contractorId] || 0) + (Number(e.amount) || 0);
  }

  el.innerHTML = contractors
    .map((c) => {
      const state = complianceOf(c);
      const dates = [
        c.coiExpires ? "COI " + c.coiExpires : "",
        c.licenseExpires ? "Licence " + c.licenseExpires : "",
      ].filter(Boolean).join(" · ");
      return (
        '<div class="contractor-row" data-contractor="' + escapeHtml(c.id) + '">' +
        '<div class="cr-main">' +
        '<div class="cr-name">' + escapeHtml(c.name) +
        (c.company ? ' <span class="cr-company">' + escapeHtml(c.company) + "</span>" : "") +
        "</div>" +
        '<div class="cr-sub">' +
        [c.trade, c.phone, c.email].filter(Boolean).map(escapeHtml).join(" · ") +
        (dates ? '<span class="cr-dates">' + escapeHtml(dates) + "</span>" : "") +
        "</div>" +
        "</div>" +
        '<div class="cr-side">' +
        '<span class="cr-paid">' + money(paid[c.id] || 0) + "</span>" +
        '<span class="compliance compliance-' + state.key + '">' + escapeHtml(state.label) + "</span>" +
        (c.w9OnFile ? '<span class="w9 yes">W-9</span>' : '<span class="w9 no">No W-9</span>') +
        "</div>" +
        "</div>"
      );
    })
    .join("");

  el.querySelectorAll("[data-contractor]").forEach((row) =>
    row.addEventListener("click", () => openContractorEdit(row.dataset.contractor))
  );

  const flagged = contractorsNeedingAttention().length;
  document.getElementById("directory-summary").textContent =
    contractors.length + " contractor" + (contractors.length === 1 ? "" : "s") +
    (flagged ? " · " + flagged + " need paperwork" : " · all paperwork current");
}

function openContractorEdit(id) {
  const c = id ? contractorById(id) : null;
  document.getElementById("contractor-edit-title").textContent =
    c ? "Edit Contractor" : "Add Contractor";
  document.getElementById("c-id").value = c ? c.id : "";
  document.getElementById("c-name").value = c ? c.name : "";
  document.getElementById("c-company").value = c ? c.company : "";
  document.getElementById("c-trade").value = c ? c.trade : "";
  document.getElementById("c-phone").value = c ? c.phone : "";
  document.getElementById("c-email").value = c ? c.email : "";
  document.getElementById("c-coi").value = c ? c.coiExpires : "";
  document.getElementById("c-license-exp").value = c ? c.licenseExpires : "";
  document.getElementById("c-license").value = c ? c.licenseNumber : "";
  document.getElementById("c-w9").checked = c ? c.w9OnFile : false;
  document.getElementById("c-taxid").value = c ? c.taxIdLast4 : "";
  document.getElementById("c-notes").value = c ? c.notes : "";
  document.getElementById("c-delete").classList.toggle("hidden", !c);
  document.getElementById("contractor-edit-modal").classList.remove("hidden");
  document.getElementById("c-name").focus();
}

function closeContractorEdit() {
  document.getElementById("contractor-edit-modal").classList.add("hidden");
}

async function saveContractorFromForm() {
  const id = document.getElementById("c-id").value;
  const record = {
    name: document.getElementById("c-name").value.trim(),
    company: document.getElementById("c-company").value.trim(),
    trade: document.getElementById("c-trade").value.trim(),
    phone: document.getElementById("c-phone").value.trim(),
    email: document.getElementById("c-email").value.trim(),
    coiExpires: document.getElementById("c-coi").value || null,
    licenseExpires: document.getElementById("c-license-exp").value || null,
    licenseNumber: document.getElementById("c-license").value.trim(),
    w9OnFile: document.getElementById("c-w9").checked,
    taxIdLast4: document.getElementById("c-taxid").value.replace(/\D/g, "").slice(-4),
    notes: document.getElementById("c-notes").value.trim(),
  };
  if (!record.name) return;

  try {
    const saved = await Store.saveContractor(record, id || null);
    const i = contractors.findIndex((c) => c.id === saved.id);
    if (i > -1) contractors[i] = saved;
    else contractors.push(saved);
    contractors.sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    reportError("save this contractor", err);
    return;
  }
  closeContractorEdit();
  renderContractorList();
  renderTaxList();
  renderComplianceAlert();
}

async function deleteContractorFromForm() {
  const id = document.getElementById("c-id").value;
  const c = contractorById(id);
  if (!c) return;
  const used = summaries.filter((e) => e.contractorId === id).length;
  if (
    !confirm(
      "Delete " + c.name + "?" +
      (used
        ? "\n\n" + used + " expense" + (used === 1 ? "" : "s") +
          " will stay exactly as they are, but will no longer say who was paid."
        : "")
    )
  ) {
    return;
  }
  try {
    await Store.deleteContractor(id);
  } catch (err) {
    reportError("delete this contractor", err);
    return;
  }
  contractors = contractors.filter((x) => x.id !== id);
  for (const e of summaries) if (e.contractorId === id) e.contractorId = null;
  for (const e of expenses) if (e.contractorId === id) e.contractorId = null;
  closeContractorEdit();
  renderContractorList();
  renderTaxList();
  renderComplianceAlert();
}

// ---------- 1099s ----------
// Every project you can see, one calendar year, labour and services only.
// Materials are not reportable, which is exactly why cost type is a separate
// field from category.
function taxYears() {
  const years = new Set(
    summaries.map((e) => String(e.date || "").slice(0, 4)).filter((y) => /^\d{4}$/.test(y))
  );
  years.add(String(new Date().getFullYear()));
  return [...years].sort().reverse();
}

function fillTaxYears() {
  const sel = document.getElementById("tax-year");
  const current = sel.value;
  const years = taxYears();
  sel.innerHTML = years.map((y) => '<option value="' + y + '">' + y + "</option>").join("");
  sel.value = years.includes(current) ? current : years[0];
}

function taxRows(year) {
  const totals = {};
  for (const e of summaries) {
    if (!e.contractorId || !is1099CostType(e.costType)) continue;
    if (String(e.date || "").slice(0, 4) !== String(year)) continue;
    const t = (totals[e.contractorId] = totals[e.contractorId] || { paid: 0, lines: 0 });
    t.paid += Number(e.amount) || 0;
    t.lines++;
  }
  return Object.keys(totals)
    .map((id) => {
      const c = contractorById(id);
      return {
        id,
        name: c ? c.name : "Unknown contractor",
        company: c ? c.company : "",
        w9OnFile: c ? c.w9OnFile : false,
        taxIdLast4: c ? c.taxIdLast4 : "",
        paid: totals[id].paid,
        lines: totals[id].lines,
        reportable: totals[id].paid >= IRS_1099_THRESHOLD,
      };
    })
    .sort((a, b) => b.paid - a.paid);
}

function renderTaxList() {
  const year = document.getElementById("tax-year").value;
  const rows = taxRows(year);
  const el = document.getElementById("tax-list");

  if (!rows.length) {
    el.innerHTML =
      '<p class="empty">Nothing reportable in ' + escapeHtml(String(year)) +
      ". Tag labour and service expenses with a contractor and they will total up here.</p>";
    document.getElementById("tax-note").textContent = "";
    return;
  }

  el.innerHTML =
    '<table class="tax-table"><thead><tr>' +
    "<th>Contractor</th><th>Payments</th>" +
    '<th class="amount">Paid in ' + escapeHtml(String(year)) + "</th>" +
    "<th>W-9</th><th>1099 needed</th>" +
    "</tr></thead><tbody>" +
    rows
      .map(
        (r) =>
          "<tr>" +
          "<td><strong>" + escapeHtml(r.name) + "</strong>" +
          (r.company ? '<em class="tax-company">' + escapeHtml(r.company) + "</em>" : "") +
          (r.taxIdLast4 ? '<em class="tax-company">ID ending ' + escapeHtml(r.taxIdLast4) + "</em>" : "") +
          "</td>" +
          "<td>" + r.lines + "</td>" +
          '<td class="amount">' + money(r.paid) + "</td>" +
          '<td>' + (r.w9OnFile
            ? '<span class="w9 yes">On file</span>'
            : '<span class="w9 no">Missing</span>') + "</td>" +
          "<td>" + (r.reportable
            ? '<span class="tax-flag yes">Yes</span>'
            : '<span class="tax-flag no">Under ' + money(IRS_1099_THRESHOLD) + "</span>") + "</td>" +
          "</tr>"
      )
      .join("") +
    "</tbody></table>";

  const due = rows.filter((r) => r.reportable);
  const missing = due.filter((r) => !r.w9OnFile);
  document.getElementById("tax-note").textContent =
    due.length + " contractor" + (due.length === 1 ? "" : "s") + " passed the " +
    money(IRS_1099_THRESHOLD) + " threshold in " + year +
    (missing.length
      ? ". " + missing.length + " of them ha" + (missing.length === 1 ? "s" : "ve") +
        " no W-9 on file — chase that before January."
      : ". Every one of them has a W-9 on file.") +
    " Corporations are usually exempt, so check before you file.";
}

function exportTaxCsv() {
  const year = document.getElementById("tax-year").value;
  const rows = taxRows(year);
  const headers = ["Contractor", "Company", "Tax ID last 4", "Payments", "Paid " + year, "W-9 on file", "1099 needed"];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      [r.name, r.company, r.taxIdLast4, r.lines, r.paid.toFixed(2), r.w9OnFile ? "Yes" : "No",
       r.reportable ? "Yes" : "No"]
        .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
        .join(",")
    );
  }
  download("1099-summary-" + year + ".csv", "text/csv", lines.join("\r\n"));
}

// ===========================================================================
// PROJECT MODAL (create / edit)
// ===========================================================================
function openProjectModal(id) {
  const existing = id ? projects.find((p) => p.id === id) : null;
  document.getElementById("project-modal-title").textContent = existing
    ? "Project Details"
    : "New Project";
  document.getElementById("pr-id").value = existing ? existing.id : "";
  document.getElementById("pr-name").value = existing ? existing.name : "";
  document.getElementById("pr-address").value = existing ? existing.address : "";
  document.getElementById("pr-borrower").value = existing ? existing.borrower : "";
  document.getElementById("pr-lender").value = existing ? existing.lender : "";
  document.getElementById("pr-settlement").value = existing ? existing.settlementDate : "";
  document.getElementById("pr-purchase").value =
    existing && existing.purchasePrice !== null ? existing.purchasePrice : "";
  document.getElementById("pr-loan").value = existing ? existing.loanAmount : 0;
  document.getElementById("pr-holdback").value = existing ? existing.loanHoldback : 0;
  document.getElementById("pr-sale").value =
    existing && existing.salePrice !== null ? existing.salePrice : "";
  document.getElementById("pr-saledate").value = existing ? existing.saleDate : "";
  document.getElementById("pr-notes").value = existing ? existing.notes : "";
  document.getElementById("pr-pref").value = existing ? existing.prefAnnualPct : 0;

  fillSelect(
    document.getElementById("pr-status"),
    PROJECT_STATUSES.map((s) => ({ value: s.value, label: s.label })),
    existing ? existing.status : "before_closing"
  );

  fillSelect(
    document.getElementById("pr-funding"),
    FUNDING_TYPES.map((f) => ({ value: f.value, label: f.label })),
    existing ? existing.funding : "financed"
  );
  syncFundingFields();

  pendingPartners = existing
    ? partnersOf(existing.id).map((p) => ({ id: p.id, name: p.name, equityPct: p.equityPct }))
    : DEFAULT_PARTNER_NAMES.map((name) => ({ id: null, name, equityPct: 0 }));
  renderPartnerEditor();

  document.getElementById("pr-delete").classList.toggle("hidden", !existing || !isOwner(existing.id));
  document.getElementById("project-modal").classList.remove("hidden");
  document.getElementById("pr-name").focus();
}

function closeProjectModal() {
  document.getElementById("project-modal").classList.add("hidden");
  pendingPartners = [];
}

// Asking for a lender, a note amount and a holdback on a deal you paid for
// yourself is three questions with no answer. Put them away instead.
function syncFundingFields() {  const cash = document.getElementById("pr-funding").value === "cash";
  document.getElementById("pr-loan-fields").classList.toggle("hidden", cash);
  document.getElementById("pr-cash-hint").classList.toggle("hidden", !cash);
}

function renderPartnerEditor() {  const el = document.getElementById("pr-partners");
  el.innerHTML = pendingPartners
    .map(
      (p, i) =>
        '<div class="partner-row">' +
        '<input type="text" data-partner-name="' + i + '" value="' + escapeHtml(p.name) + '" placeholder="Partner name" />' +
        '<input type="number" class="equity-input" data-partner-eq="' + i + '" value="' +
          (Number(p.equityPct) || 0) + '" step="0.1" min="0" max="100" title="Share of the profit" />' +
        '<span class="equity-sign">%</span>' +
        '<button type="button" class="icon-btn del" data-partner-del="' + i + '">Remove</button>' +
        "</div>"
    )
    .join("");
  el.querySelectorAll("[data-partner-name]").forEach((input) =>
    input.addEventListener("input", () => {
      pendingPartners[Number(input.dataset.partnerName)].name = input.value;
    })
  );
  el.querySelectorAll("[data-partner-eq]").forEach((input) =>
    input.addEventListener("input", () => {
      pendingPartners[Number(input.dataset.partnerEq)].equityPct = parseFloat(input.value) || 0;
    })
  );
  el.querySelectorAll("[data-partner-del]").forEach((b) =>
    b.addEventListener("click", () => {
      const i = Number(b.dataset.partnerDel);
      const p = pendingPartners[i];
      // A partner with expenses against them cannot just vanish — the money
      // would lose its owner.
      if (p.id && summaries.some((e) => e.partnerId === p.id)) {
        alert(
          "\u201c" + p.name + "\u201d has expenses recorded against them. " +
          "Move those expenses to another partner first, or just rename this one."
        );
        return;
      }
      pendingPartners.splice(i, 1);
      renderPartnerEditor();
    })
  );
}

async function saveProjectFromForm() {
  const id = document.getElementById("pr-id").value;
  const saleRaw = document.getElementById("pr-sale").value;
  const purchaseRaw = document.getElementById("pr-purchase").value;
  const funding = document.getElementById("pr-funding").value === "cash" ? "cash" : "financed";
  const financed = funding === "financed";

  const record = {
    name: document.getElementById("pr-name").value.trim(),
    address: document.getElementById("pr-address").value.trim(),
    status: document.getElementById("pr-status").value,
    funding,
    borrower: document.getElementById("pr-borrower").value.trim(),
    lender: financed ? document.getElementById("pr-lender").value.trim() : "",
    settlementDate: document.getElementById("pr-settlement").value,
    loanAmount: financed ? parseFloat(document.getElementById("pr-loan").value) || 0 : 0,
    loanHoldback: financed ? parseFloat(document.getElementById("pr-holdback").value) || 0 : 0,
    purchasePrice: purchaseRaw === "" ? null : parseFloat(purchaseRaw),
    salePrice: saleRaw === "" ? null : parseFloat(saleRaw),
    saleDate: document.getElementById("pr-saledate").value,
    prefAnnualPct: parseFloat(document.getElementById("pr-pref").value) || 0,
    notes: document.getElementById("pr-notes").value.trim(),
  };

  if (record.loanHoldback > record.loanAmount) {
    alert("The construction holdback cannot be larger than the total note amount.");
    return;
  }

  const names = pendingPartners.map((p) => p.name.trim()).filter(Boolean);
  if (!names.length) {
    alert("A project needs at least one partner.");
    return;
  }

  let saved;
  try {
    saved = await Store.saveProject(record, id || null);
    const i = projects.findIndex((p) => p.id === saved.id);
    if (i > -1) projects[i] = saved;
    else projects.push(saved);

    await syncPartners(saved.id);
    if (!id) memberships = await Store.getMemberships();
    if (!id) await seedProjectCategories(saved.id);
  } catch (err) {
    reportError("save this project", err);
    return;
  }

  closeProjectModal();
  if (id) {
    renderProject();
    document.getElementById("crumb-current").textContent = saved.name;
  } else {
    goProject(saved.id);
  }
}

// A new project is started from your own library. The first time round that
// library is empty, so it starts from the list the app ships with.
async function seedProjectCategories(projectId) {
  let library = [];
  try {
    library = await Store.getCategoryLibrary();
  } catch (err) {
    // A library that will not load is not worth losing a new project over.
    console.warn("[app] could not read the category library", err);
  }
  const made = await Store.seedCategories(
    projectId,
    library.length ? library : DEFAULT_CATEGORIES
  );
  allCategories = allCategories.concat(made);
}

// Reconcile the partner rows in the editor against what is stored.
async function syncPartners(projectId) {
  const existing = partnersOf(projectId);
  const keptIds = pendingPartners.filter((p) => p.id).map((p) => p.id);

  for (const gone of existing.filter((p) => !keptIds.includes(p.id))) {
    await Store.deletePartner(gone.id);
    partners = partners.filter((p) => p.id !== gone.id);
  }

  for (let i = 0; i < pendingPartners.length; i++) {
    const p = pendingPartners[i];
    const name = p.name.trim();
    if (!name) continue;
    const before = p.id ? existing.find((x) => x.id === p.id) : null;
    if (before && before.name === name && before.sort === i && before.equityPct === (Number(p.equityPct) || 0)) continue;
    const saved = await Store.savePartner(
      { projectId, name, sort: i, equityPct: Number(p.equityPct) || 0 },
      p.id || null
    );
    const idx = partners.findIndex((x) => x.id === saved.id);
    if (idx > -1) partners[idx] = saved;
    else partners.push(saved);
  }
}

async function deleteActiveProject() {
  const id = document.getElementById("pr-id").value;
  const p = projects.find((x) => x.id === id);
  if (!p) return;
  const count = summaries.filter((e) => e.projectId === id).length;
  if (
    !confirm(
      "Delete \u201c" + p.name + "\u201d and all " + count +
      " of its expenses, draws and receipts?\n\nThis cannot be undone."
    )
  ) {
    return;
  }
  if (prompt('Type the project name to confirm:') !== p.name) {
    alert("Name did not match — nothing was deleted.");
    return;
  }
  try {
    await Store.deleteProject(id);
    // The database cascades, Storage does not, so the photos have to be
    // swept up by hand or they sit in the bucket forever.
    if (id === activeProjectId) {
      await Store.deleteReceipts(expenses.flatMap((e) => e.receipts || []));
    }
  } catch (err) {
    reportError("delete this project", err);
    return;
  }
  projects = projects.filter((x) => x.id !== id);
  partners = partners.filter((x) => x.projectId !== id);
  budgets = budgets.filter((x) => x.projectId !== id);
  summaries = summaries.filter((x) => x.projectId !== id);
  allDraws = allDraws.filter((x) => x.projectId !== id);
  memberships = memberships.filter((x) => x.projectId !== id);
  closeProjectModal();
  goDashboard();
}

// ===========================================================================
// BUDGET SHEET
// ===========================================================================
function openBudgetModal() {
  const p = activeProject();
  if (!p) return;
  pendingBudget = {};
  for (const b of budgets.filter((x) => x.projectId === p.id)) {
    pendingBudget[b.category] = b.amount;
  }
  document.getElementById("bg-threshold").value = Number(p.varianceThreshold) || 10;

  const spent = {};
  for (const e of expenses) spent[e.category] = (spent[e.category] || 0) + (Number(e.amount) || 0);

  document.getElementById("budget-editor").innerHTML = CATEGORY_GROUPS.map(
    (g) =>
      '<div class="bedit-group"><h4>' + escapeHtml(g.label) + "</h4>" +
      categoriesIn(g.key)
        .map((name) => {
          const val = pendingBudget[name];
          const already = spent[name] || 0;
          return (
            '<div class="bedit-row">' +
            '<label for="bg-' + escapeHtml(name) + '">' + escapeHtml(name) +
            (already ? '<span class="bedit-spent">' + money(already) + " already spent</span>" : "") +
            "</label>" +
            '<input type="number" step="0.01" min="0" placeholder="\u2014" ' +
            'id="bg-' + escapeHtml(name) + '" data-budget-cat="' + escapeHtml(name) + '" ' +
            'value="' + (val === undefined ? "" : val) + '" />' +
            "</div>"
          );
        })
        .join("") +
      "</div>"
  ).join("");

  document.getElementById("budget-editor")
    .querySelectorAll("[data-budget-cat]")
    .forEach((input) =>
      input.addEventListener("input", () => {
        const cat = input.dataset.budgetCat;
        if (input.value === "") delete pendingBudget[cat];
        else pendingBudget[cat] = parseFloat(input.value) || 0;
        updateBudgetTotal();
      })
    );

  updateBudgetTotal();
  document.getElementById("budget-modal").classList.remove("hidden");
}

function updateBudgetTotal() {
  document.getElementById("bg-total").textContent =
    money(Object.values(pendingBudget).reduce((s, v) => s + (Number(v) || 0), 0));
}

function closeBudgetModal() {
  document.getElementById("budget-modal").classList.add("hidden");
  pendingBudget = {};
}

async function saveBudgetFromForm() {
  const p = activeProject();
  const threshold = parseFloat(document.getElementById("bg-threshold").value);
  const existing = budgets.filter((b) => b.projectId === p.id);

  try {
    // Clearing a field means "stop tracking this category", so the line goes.
    for (const line of existing) {
      if (pendingBudget[line.category] === undefined) {
        await Store.deleteBudgetLine(line.id);
        budgets = budgets.filter((b) => b.id !== line.id);
      }
    }
    for (const [category, amount] of Object.entries(pendingBudget)) {
      const before = existing.find((b) => b.category === category);
      if (before && before.amount === amount) continue;
      const saved = await Store.saveBudgetLine(
        { projectId: p.id, category, amount },
        before ? before.id : null
      );
      const i = budgets.findIndex((b) => b.id === saved.id);
      if (i > -1) budgets[i] = saved;
      else budgets.push(saved);
    }
    if (!Number.isNaN(threshold) && threshold !== p.varianceThreshold) {
      const saved = await Store.saveProject({ ...p, varianceThreshold: threshold }, p.id);
      projects[projects.findIndex((x) => x.id === p.id)] = saved;
    }
  } catch (err) {
    reportError("save the budget", err);
    return;
  }

  closeBudgetModal();
  renderProject();
}

// ===========================================================================
// SHARING
// ===========================================================================
async function openShareModal() {
  const p = activeProject();
  if (!p) return;
  document.getElementById("share-project-name").textContent =
    "Anyone listed here can open \u201c" + p.name + "\u201d.";
  document.getElementById("share-error").classList.add("hidden");
  document.getElementById("sl-result").classList.add("hidden");
  document.getElementById("share-modal").classList.remove("hidden");
  fillSelect(
    document.getElementById("sh-role"),
    MEMBER_ROLES.map((r) => ({ value: r.value, label: r.label + " \u2014 " + r.hint })),
    "editor"
  );
  await renderMembers();
  await renderShareLinks();
}

async function renderMembers() {
  const el = document.getElementById("member-list");
  el.innerHTML = '<p class="empty">Loading\u2026</p>';
  let list;
  try {
    list = await Store.listMembers(activeProjectId);
  } catch (err) {
    el.innerHTML = '<p class="empty">Could not load the access list.</p>';
    console.error(err);
    return;
  }
  el.innerHTML = list
    .map(
      (m) =>
        '<div class="member-row">' +
        '<span class="member-email">' + escapeHtml(m.email) + "</span>" +
        '<span class="member-role">' + escapeHtml(m.role) + "</span>" +
        (m.role === "owner"
          ? '<span class="member-lock">owner</span>'
          : '<button class="icon-btn del" data-member-del="' + escapeHtml(m.userId) + '">Remove</button>') +
        "</div>"
    )
    .join("");
  el.querySelectorAll("[data-member-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Remove this person's access?")) return;
      try {
        await Store.removeMember(activeProjectId, b.dataset.memberDel);
        memberships = await Store.getMemberships();
        await renderMembers();
      } catch (err) {
        reportError("remove that person", err);
      }
    })
  );
}

// ---------- Read-only links ----------
function shareUrlFor(token) {
  return location.origin + location.pathname + "#/s/" + token;
}

async function renderShareLinks() {
  const el = document.getElementById("link-list");
  el.innerHTML = '<p class="empty">Loading\u2026</p>';
  let links;
  try {
    links = await Store.getShareLinks(activeProjectId);
  } catch (err) {
    el.innerHTML = '<p class="empty">Could not load the links.</p>';
    console.error(err);
    return;
  }
  if (!links.length) {
    el.innerHTML = '<p class="empty">No read-only links yet.</p>';
    return;
  }
  el.innerHTML = links
    .map((l) => {
      const shows = [
        l.showBudget ? "budget" : null,
        l.showSchedule ? "schedule" : null,
        l.showLedger ? "line items" : null,
        l.showSplits ? "splits" : null,
      ].filter(Boolean);
      const dead = l.expiresAt && new Date(l.expiresAt) <= new Date();
      const when = l.expiresAt
        ? (dead ? "expired " : "expires ") + String(l.expiresAt).slice(0, 10)
        : "no expiry";
      return (
        '<div class="link-row' + (dead ? " link-dead" : "") + '">' +
        '<div class="link-main">' +
        '<span class="link-label">' + escapeHtml(l.label || "Untitled link") + "</span>" +
        '<span class="link-sub">' + escapeHtml(when) +
        (shows.length ? " \u00b7 shows " + escapeHtml(shows.join(", ")) : " \u00b7 headline figures only") +
        "</span></div>" +
        '<button type="button" class="icon-btn" data-link-copy="' + escapeHtml(l.token) + '">Copy</button>' +
        '<button type="button" class="icon-btn del" data-link-del="' + escapeHtml(l.token) + '">Revoke</button>' +
        "</div>"
      );
    })
    .join("");

  el.querySelectorAll("[data-link-copy]").forEach((b) =>
    b.addEventListener("click", () => {
      copyText(shareUrlFor(b.dataset.linkCopy));
      b.textContent = "Copied";
      setTimeout(() => (b.textContent = "Copy"), 1500);
    })
  );
  el.querySelectorAll("[data-link-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Revoke this link? Anyone still holding it will lose access immediately.")) return;
      try {
        await Store.deleteShareLink(b.dataset.linkDel);
        await renderShareLinks();
      } catch (err) {
        reportError("revoke that link", err);
      }
    })
  );
}

async function createShareLink() {
  const btn = document.getElementById("sl-create");
  btn.disabled = true;
  try {
    const token = await Store.createShareLink(activeProjectId, {
      label: document.getElementById("sl-label").value.trim(),
      showBudget: document.getElementById("sl-budget").checked,
      showSchedule: document.getElementById("sl-schedule").checked,
      showLedger: document.getElementById("sl-ledger").checked,
      showSplits: document.getElementById("sl-splits").checked,
      days: parseInt(document.getElementById("sl-days").value, 10),
    });
    const url = shareUrlFor(token);
    copyText(url);
    const out = document.getElementById("sl-result");
    out.textContent = "Link copied to your clipboard: " + url;
    out.classList.remove("hidden");
    document.getElementById("sl-label").value = "";
    await renderShareLinks();
  } catch (err) {
    reportError("create that link", err);
  } finally {
    btn.disabled = false;
  }
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch (err) {
    /* the URL is on screen either way */
  }
  ta.remove();
}

// ===========================================================================
// STAKEHOLDER VIEW
//
// What somebody with a read-only link sees. They have no account, so every
// figure here comes from the single payload the database hands back for their
// token — and the same math functions the owner's own page uses, so the two
// can never disagree.
// ===========================================================================
function shareTokenFromHash() {
  const m = String(location.hash || "").match(/^#\/s\/([A-Za-z0-9]{16,})$/);
  return m ? m[1] : null;
}

async function openStakeholderView(token) {
  shareMode = true;
  document.getElementById("dashboard-view").classList.add("hidden");
  document.getElementById("project-view").classList.add("hidden");
  document.getElementById("crumbs").classList.add("hidden");
  document.getElementById("auth-btn").classList.add("hidden");
  document.getElementById("auth-status").textContent = "Shared view";
  const view = document.getElementById("share-view");
  view.classList.remove("hidden");
  view.innerHTML = '<p class="empty">Loading\u2026</p>';

  let payload = null;
  try {
    payload = await Store.openShare(token);
  } catch (err) {
    console.error(err);
  }

  if (!payload || !payload.project) {
    view.innerHTML =
      '<div class="share-dead"><h2>This link is not working</h2>' +
      "<p>It has either expired or been revoked by whoever sent it. " +
      "Ask them for a fresh one.</p></div>";
    return;
  }
  renderShareView(payload);
}

function renderShareView(payload) {
  const p = projectFromRow(payload.project);
  const scope = payload.scope || {};

  // Load the payload into the same globals the owner's page uses, so the math
  // functions below need no special case for being in shared mode.
  projects = [p];
  partners = (payload.partners || []).map(partnerFromRow);
  budgets = (payload.budget_lines || []).map(budgetFromRow);
  tasks = (payload.tasks || []).map(taskFromRow);
  expenses = (payload.expenses || []).map(expenseFromRow);
  draws = (payload.draws || []).map(drawFromRow);
  activeProjectId = p.id;

  const n = allInNumbers(p, expenses, draws);
  const pr = profitOf(p, expenses, draws);

  const meta = [];
  if (p.address) meta.push(p.address);
  if (p.settlementDate) meta.push("Settled " + p.settlementDate);
  if (p.saleDate) meta.push("Sold " + p.saleDate);

  let html =
    '<div class="share-banner">Read-only view' +
    (payload.label ? " for " + escapeHtml(payload.label) : "") +
    ". Figures are live and update as the project does.</div>" +
    '<section class="project-head"><div class="project-head-main">' +
    "<h1>" + escapeHtml(p.name) + "</h1>" +
    (meta.length ? '<p class="share-meta">' + escapeHtml(meta.join(" \u00b7 ")) + "</p>" : "") +
    '<span class="' + escapeHtml(statusClass(p.status)) + '">' + escapeHtml(statusLabel(p.status)) + "</span>" +
    "</div></section>" +
    '<section class="allin"><div class="allin-label">Total All-In</div>' +
    '<div class="allin-value">' + money(n.allIn) + "</div>" +
    '<div class="allin-break">Partner cash <strong>' + money(n.partnerCash) +
    "</strong> &nbsp;+&nbsp; Lender funded at closing <strong>" + money(n.funded) +
    "</strong></div></section>";

  if (pr) {
    html +=
      '<section class="cards">' +
      '<div class="card"><div class="card-label">Sale Price</div><div class="card-value">' +
      money(pr.sale) + "</div></div>" +
      '<div class="card"><div class="card-label">All-In</div><div class="card-value">' +
      money(pr.allIn) + "</div></div>" +
      '<div class="card"><div class="card-label">' +
      (p.status === "sold" ? "Profit" : "Projected Profit") +
      '</div><div class="card-value ' + (pr.profit >= 0 ? "pos" : "neg") + '">' +
      money(pr.profit) + "</div></div></section>";
  }

  html +=
    '<section class="cards"><div class="card"><div class="card-label">Lender Payoff</div>' +
    '<div class="card-value">' + money(n.payoff) + "</div></div>" +
    '<div class="card"><div class="card-label">Draws Taken</div>' +
    '<div class="card-value">' + money(n.totalDraws) + "</div></div>" +
    '<div class="card"><div class="card-label">Holdback Left</div>' +
    '<div class="card-value">' + money(loanNumbers(p, draws).remaining) + "</div></div></section>";

  if (scope.budget) html += shareBudgetHtml(p);
  if (scope.schedule) html += shareScheduleHtml(p);
  if (scope.splits) html += shareSplitHtml(p);
  if (scope.ledger) html += shareLedgerHtml(scope);

  html +=
    '<p class="share-foot">Shared from Project Expense Tracker. ' +
    (payload.expires_at
      ? "This link stops working on " + escapeHtml(String(payload.expires_at).slice(0, 10)) + "."
      : "This link has no expiry date.") +
    "</p>";

  document.getElementById("share-view").innerHTML = html;
}

// A stakeholder gets the dates and nothing else: no bars to misread, no
// contractor names, no notes.
function shareScheduleHtml(p) {
  const s = scheduleOf(p, tasksOf(p.id), todayIso());
  if (!s) return "";
  const body = s.rows
    .slice()
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.sort - b.sort))
    .map(
      (r) =>
        "<tr><td>" + escapeHtml(r.name) + "</td>" +
        "<td>" + escapeHtml(r.start) + "</td>" +
        "<td>" + escapeHtml(r.end) + "</td>" +
        '<td><span class="' + scheduleStateClass(r.state.key) + '">' +
        escapeHtml(r.state.label) + "</span></td></tr>"
    )
    .join("");
  return (
    '<section class="schedule-panel"><div class="breakdown-head"><h2>Schedule</h2></div>' +
    '<div class="budget-summary">' +
    '<div class="bsum"><span>Finishes</span><strong>' + escapeHtml(s.finish) + "</strong></div>" +
    '<div class="bsum"><span>Phases left</span><strong>' + s.remaining + "</strong></div>" +
    (s.slip
      ? '<div class="bsum"><span>Worst slip</span><strong class="neg">' + s.slip + " days</strong></div>"
      : "") +
    "</div>" +
    '<table class="split-table"><thead><tr><th>Phase</th><th>Starts</th><th>Finishes</th>' +
    "<th>Status</th></tr></thead><tbody>" + body + "</tbody></table>" +
    '<p class="breakdown-note">Dates are projected from what is finished so far. ' +
    "Days are calendar days.</p></section>"
  );
}

function shareBudgetHtml(p) {
  const rows = budgetRows(p.id, expenses).filter((r) => r.budget !== null || r.actual !== 0);
  if (!rows.length) return "";
  const threshold = Number(p.varianceThreshold) || 10;
  const body = rows
    .map((r) => {
      const cls = r.variance === null ? "" : "var-" + rowHealth(r, threshold);
      return (
        "<tr><td>" + escapeHtml(r.category) + "</td>" +
        "<td>" + (r.budget === null ? "\u2014" : money(r.budget)) + "</td>" +
        "<td>" + money(r.actual) + "</td>" +
        '<td class="' + cls + '">' +
        (r.variance === null ? "\u2014" : (r.variance > 0 ? "+" : "") + money(r.variance)) +
        "</td></tr>"
      );
    })
    .join("");
  const budget = rows.reduce((s, r) => s + (r.budget || 0), 0);
  const actual = rows.reduce((s, r) => s + r.actual, 0);
  return (
    '<section class="budget-panel"><div class="breakdown-head"><h2>Budget vs Actual</h2></div>' +
    '<table class="split-table"><thead><tr><th>Category</th><th>Budget</th><th>Spent</th>' +
    "<th>Variance</th></tr></thead><tbody>" + body + "</tbody>" +
    "<tfoot><tr><td>Total</td><td>" + money(budget) + "</td><td>" + money(actual) +
    "</td><td>" + (actual - budget > 0 ? "+" : "") + money(actual - budget) +
    "</td></tr></tfoot></table></section>"
  );
}

function shareSplitHtml(p) {
  const w = splitWaterfall(p, partnersOf(p.id), expenses, draws);
  if (!w) return "";
  const body = w.rows
    .map(
      (r) =>
        "<tr><td>" + escapeHtml(r.name) + "</td>" +
        "<td>" + money(r.contributed) + "</td>" +
        "<td>" + money(r.netCapital) + "</td>" +
        (w.prefNeed > 0 ? "<td>" + money(r.prefPaid) + "</td>" : "") +
        "<td>" + money(r.profitShare) + "</td>" +
        '<td class="split-take">' + money(r.total) + "</td></tr>"
    )
    .join("");
  return (
    '<section class="split-panel"><div class="breakdown-head"><h2>Who Takes Home What</h2></div>' +
    '<table class="split-table"><thead><tr><th>Partner</th><th>Put In</th><th>At Risk</th>' +
    (w.prefNeed > 0 ? "<th>Preferred</th>" : "") +
    "<th>Profit Share</th><th>Takes Home</th></tr></thead><tbody>" + body + "</tbody></table>" +
    '<p class="budget-note">Capital comes back first' +
    (w.prefNeed > 0 ? ", then the preferred return" : "") +
    ", and the remaining " + money(w.remainder) + " is split.</p></section>"
  );
}

function shareLedgerHtml(scope) {
  const body = expenses
    .map(
      (e) =>
        "<tr><td>" + escapeHtml(e.date) + "</td>" +
        "<td>" + escapeHtml(e.description || "\u2014") + "</td>" +
        "<td>" + escapeHtml(e.category) + "</td>" +
        (scope.splits ? "<td>" + escapeHtml(partnerName(e.partnerId)) + "</td>" : "") +
        '<td class="dq-amount">' + money(e.amount) + "</td></tr>"
    )
    .join("");
  return (
    '<section class="ledger-panel"><div class="breakdown-head"><h2>Every Line Item</h2>' +
    '<span class="muted">' + expenses.length + " entries</span></div>" +
    '<table class="split-table"><thead><tr><th>Date</th><th>Description</th><th>Category</th>' +
    (scope.splits ? "<th>Paid By</th>" : "") +
    "<th>Amount</th></tr></thead><tbody>" + body + "</tbody>" +
    "<tfoot><tr><td colspan=\"" + (scope.splits ? 4 : 3) + '">Total</td><td class="dq-amount">' +
    money(sum(expenses)) + "</td></tr></tfoot></table></section>"
  );
}

// ===========================================================================
// EXPORT
// ===========================================================================
function exportCsv() {
  const p = activeProject();
  const headers = ["Project", "Date", "Description", "Notes", "Category", "Cost Type", "Paid By", "Paid To", "Amount", "Receipts"];
  const lines = [headers.join(",")];
  for (const e of expenses) {
    const row = [
      p.name,
      e.date,
      e.description,
      e.notes || "",
      e.category,
      e.costType,
      partnerName(e.partnerId),
      contractorName(e.contractorId),
      (Number(e.amount) || 0).toFixed(2),
      Array.isArray(e.receipts) ? e.receipts.length : 0,
    ].map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`);
    lines.push(row.join(","));
  }
  download(p.name.replace(/[^\w.-]+/g, "-") + "-expenses.csv", "text/csv", lines.join("\r\n"));
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

// ===========================================================================
// WIRE UP
// ===========================================================================
document.getElementById("home-btn").addEventListener("click", goDashboard);
document.getElementById("crumb-home").addEventListener("click", goDashboard);
document.getElementById("new-project-btn").addEventListener("click", () => openProjectModal(null));
document.getElementById("status-filter").addEventListener("change", renderDashboard);
document.getElementById("settings-btn").addEventListener("click", () => openProjectModal(activeProjectId));
document.getElementById("share-btn").addEventListener("click", openShareModal);
document.getElementById("sl-create").addEventListener("click", createShareLink);
document.getElementById("add-task-btn").addEventListener("click", () => openTaskModal(null));
document.getElementById("t-cancel").addEventListener("click", closeTaskModal);
document.getElementById("t-delete").addEventListener("click", deleteTaskFromForm);
document.getElementById("task-form").addEventListener("submit", (e) => {
  e.preventDefault();
  saveTaskFromForm();
});
document.getElementById("task-modal").addEventListener("click", (e) => {
  if (e.target.id === "task-modal") closeTaskModal();
});
document.getElementById("budget-btn").addEventListener("click", openBudgetModal);
document.getElementById("bg-cancel").addEventListener("click", closeBudgetModal);
document.getElementById("draw-request-btn").addEventListener("click", openDrawRequest);
document.getElementById("dr-cancel").addEventListener("click", closeDrawRequest);
document.getElementById("dr-print").addEventListener("click", printDrawRequest);
document.getElementById("drawreq-modal").addEventListener("click", (e) => {
  if (e.target.id === "drawreq-modal") closeDrawRequest();
});
document.getElementById("dr-all").addEventListener("change", (ev) => {
  document.getElementById("drawreq-picker")
    .querySelectorAll("[data-dr]")
    .forEach((cb) => {
      cb.checked = ev.target.checked;
      if (cb.checked) drawReqSelection.add(cb.dataset.dr);
      else drawReqSelection.delete(cb.dataset.dr);
    });
  updateDrawRequestTotal();
});
document.getElementById("budget-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  saveBudgetFromForm();
});
document.getElementById("budget-modal").addEventListener("click", (e) => {
  if (e.target.id === "budget-modal") closeBudgetModal();
});

// Picking a phase pre-selects the kind of spend it usually is, but never
// overrides a choice already made on an existing expense.
document.getElementById("f-category").addEventListener("change", (ev) => {
  if (document.getElementById("f-id").value) return;
  document.getElementById("f-costtype").value = defaultCostTypeFor(ev.target.value);
  syncContractorField();
});
document.getElementById("f-costtype").addEventListener("change", syncContractorField);

document.getElementById("contractors-btn").addEventListener("click", () => openContractorModal("directory"));
document.getElementById("contractor-close").addEventListener("click", closeContractorModal);
document.getElementById("contractor-modal").addEventListener("click", (e) => {
  if (e.target.id === "contractor-modal") closeContractorModal();
});
document.querySelectorAll("#contractor-modal .tab").forEach((t) =>
  t.addEventListener("click", () => showContractorTab(t.dataset.tab))
);
document.querySelectorAll("#project-tabs .tab").forEach((t) =>
  t.addEventListener("click", () => showProjectTab(t.dataset.ptab))
);

document.getElementById("library-btn").addEventListener("click", () => openCategories(null));
document.getElementById("categories-btn").addEventListener("click", () =>
  openCategories(activeProjectId)
);
document.getElementById("cat-close").addEventListener("click", closeCategories);
document.getElementById("cat-add-btn").addEventListener("click", addCategory);
document.getElementById("cat-restore").addEventListener("click", restoreDefaultCategories);
document.getElementById("cat-new-name").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    addCategory();
  }
});

// One listener for the whole editor: the rows are redrawn constantly and
// re-binding a handler per row per redraw is how you end up firing twice.
document.getElementById("category-editor").addEventListener("change", (ev) => {
  const id = categoryRowId(ev);
  if (!id) return;
  const was = editingCategories.find((c) => c.id === id);
  if (ev.target.classList.contains("cat-name")) {
    const name = ev.target.value.trim();
    if (!name || name === was.name) {
      renderCategoryEditor();
      return;
    }
    saveCategoryEdit(id, { name }, was.name);
  } else if (ev.target.classList.contains("cat-group-pick")) {
    saveCategoryEdit(id, { group: ev.target.value }, null);
  } else if (ev.target.classList.contains("cat-cost-pick")) {
    saveCategoryEdit(id, { defaultCostType: ev.target.value }, null);
  }
});
document.getElementById("category-editor").addEventListener("click", (ev) => {
  if (!ev.target.classList.contains("cat-del")) return;
  const id = categoryRowId(ev);
  if (id) removeCategory(id);
});
document.getElementById("add-doc-btn").addEventListener("click", () => openDocModal(null));
document.getElementById("doc-cancel").addEventListener("click", closeDocModal);
document.getElementById("doc-save").addEventListener("click", saveDocFromForm);
// A file you have just chosen suggests its own name, so the common case is
// choose, save. Anything already typed is left alone.
document.getElementById("doc-file").addEventListener("change", (ev) => {
  const file = (ev.target.files || [])[0];
  const name = document.getElementById("doc-name");
  if (file && !name.value.trim()) name.value = file.name;
});
// One listener for the list: the rows are redrawn on every change.
document.getElementById("docs-list").addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-act]");
  if (!btn) return;
  const row = btn.closest(".doc-row");
  if (!row) return;
  const id = row.dataset.doc;
  if (btn.dataset.act === "open") openDocument(id);
  else if (btn.dataset.act === "edit") openDocModal(id);
  else if (btn.dataset.act === "delete") deleteDocument(id);
});

document.getElementById("add-contractor-btn").addEventListener("click", () => openContractorEdit(null));
document.getElementById("tax-year").addEventListener("change", renderTaxList);
document.getElementById("tax-export-btn").addEventListener("click", exportTaxCsv);
document.getElementById("c-cancel").addEventListener("click", closeContractorEdit);
document.getElementById("c-delete").addEventListener("click", deleteContractorFromForm);
document.getElementById("contractor-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  saveContractorFromForm();
});

document.getElementById("p-status").addEventListener("change", async (ev) => {
  const p = activeProject();
  const previous = p.status;
  const next = ev.target.value;
  try {
    const saved = await Store.saveProject({ ...p, status: next }, p.id);
    projects[projects.findIndex((x) => x.id === p.id)] = saved;
  } catch (err) {
    ev.target.value = previous;
    reportError("change the status", err);
    return;
  }
  renderProject();
});

document.getElementById("project-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  saveProjectFromForm();
});
document.getElementById("pr-cancel").addEventListener("click", closeProjectModal);
document.getElementById("pr-funding").addEventListener("change", syncFundingFields);
document.getElementById("pr-delete").addEventListener("click", deleteActiveProject);
document.getElementById("pr-add-partner").addEventListener("click", () => {
  pendingPartners.push({ id: null, name: "", equityPct: 0 });
  renderPartnerEditor();
});
document.getElementById("project-modal").addEventListener("click", (e) => {
  if (e.target.id === "project-modal") closeProjectModal();
});

document.getElementById("share-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const errEl = document.getElementById("share-error");
  errEl.classList.add("hidden");
  try {
    await Store.addMember(
      activeProjectId,
      document.getElementById("sh-email").value.trim(),
      document.getElementById("sh-role").value
    );
    document.getElementById("sh-email").value = "";
    memberships = await Store.getMemberships();
    await renderMembers();
  } catch (err) {
    errEl.textContent = err.message || "Could not add that person.";
    errEl.classList.remove("hidden");
  }
});
document.getElementById("share-close").addEventListener("click", () =>
  document.getElementById("share-modal").classList.add("hidden")
);
document.getElementById("share-modal").addEventListener("click", (e) => {
  if (e.target.id === "share-modal") e.currentTarget.classList.add("hidden");
});

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
document.getElementById("draw-modal").addEventListener("click", (e) => {
  if (e.target.id === "draw-modal") closeDrawModal();
});
document.getElementById("f-receipts").addEventListener("change", (e) => {
  handleReceiptFiles(e.target.files);
  e.target.value = "";
});
document.getElementById("f-camera").addEventListener("change", (e) => {
  handleReceiptFiles(e.target.files);
  e.target.value = "";
});
document.getElementById("scan-receipt").addEventListener("click", scanReceipt);
document.getElementById("scan-undo").addEventListener("click", undoScan);
document.getElementById("sync-now").addEventListener("click", syncNow);
document.getElementById("sync-discard").addEventListener("click", discardStuck);

// Anything added while offline is announced by the queue itself, so the bar
// never has to be refreshed by hand from a dozen call sites.
Offline.onChange(() => renderSyncBar());
window.addEventListener("online", () => {
  renderSyncBar();
  syncNow();
});
window.addEventListener("offline", () => renderSyncBar());
document.getElementById("lightbox").addEventListener("click", closeLightbox);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!document.getElementById("lightbox").classList.contains("hidden")) {
    closeLightbox();
    return;
  }
  closeModal();
  closeDrawModal();
  closeProjectModal();
  closeBudgetModal();
  closeDrawRequest();
  closeTaskModal();
  closeContractorEdit();
  closeContractorModal();
  document.getElementById("share-modal").classList.add("hidden");
});

document.getElementById("auth-btn").addEventListener("click", async () => {
  if (!currentUser) {
    openLoginModal();
    return;
  }
  const btn = document.getElementById("auth-btn");
  btn.disabled = true;
  btn.textContent = "Signing out\u2026";
  try {
    await Store.signOut();
  } catch (err) {
    reportError("sign out", err);
  } finally {
    btn.disabled = false;
    // Don't wait on the auth event to come back — drop to signed-out locally.
    if (currentUser) onSignedOut();
  }
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

window.addEventListener("hashchange", route);

// ===========================================================================
// BOOT
// ===========================================================================
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
    .querySelectorAll("#project-view .toolbar button, #project-view .toolbar label, #add-draw-btn, #add-task-btn")
    .forEach((el) => el.classList.toggle("disabled", !enabled));
}

function setAuthUi(user) {
  const status = document.getElementById("auth-status");
  const btn = document.getElementById("auth-btn");
  btn.classList.remove("hidden");
  if (user) {
    status.textContent = "Synced \u00b7 " + user.email;
    btn.textContent = "Sign Out";
  } else {
    status.textContent = "Not signed in";
    btn.textContent = "Sign In";
  }
}

function fillStaticSelects() {
  fillSelect(
    document.getElementById("p-status"),
    PROJECT_STATUSES.map((s) => ({ value: s.value, label: s.label }))
  );
  document.getElementById("status-filter").innerHTML =
    '<option value="">All statuses</option>' +
    PROJECT_STATUSES.map(
      (s) => '<option value="' + s.value + '">' + escapeHtml(s.label) + "</option>"
    ).join("");
}

async function loadAll() {
  try {
    [projects, partners, memberships, contractors, budgets, tasks, summaries, allDraws, allCategories, allDocs] = await Promise.all([
      Store.getProjects(),
      Store.getPartners(),
      Store.getMemberships(),
      Store.getContractors(),
      Store.getBudgetLines(),
      Store.getTasks(null),
      Store.getExpenseSummaries(),
      Store.getDraws(null),
      Store.getCategories(null),
      Store.getDocuments(null),
    ]);
    snapshotNow();
  } catch (err) {
    // Losing signal is not the same as losing the data. Fall back to the last
    // copy that did load and say so, rather than showing an empty portfolio.
    if (!Offline.isNetworkError(err) || !restoreSnapshot()) throw err;
    console.warn("[app] offline, showing the last data that loaded", err);
  }
  await renderSyncBar();
  await route();
}

async function onSignedIn(user) {
  currentUser = user;
  booted = true;
  setAuthUi(user);
  closeLoginModal();
  try {
    await loadAll();
  } catch (err) {
    document.getElementById("auth-status").textContent = "Signed in \u00b7 could not load data";
    reportError("load your data", err);
  }
  // Anything typed on the last trip out goes up now.
  syncNow();
}

function onSignedOut() {
  // The cached copy belongs to whoever was signed in. It goes with them.
  if (currentUser) Offline.clearSnapshot(currentUser.id);
  currentUser = null;
  booted = true;
  projects = [];
  partners = [];
  memberships = [];
  contractors = [];
  budgets = [];
  tasks = [];
  summaries = [];
  allDraws = [];
  allCategories = [];
  allDocs = [];
  expenses = [];
  draws = [];
  setAuthUi(null);
  renderDashboard();
  openLoginModal();
}

async function boot() {
  fillStaticSelects();
  registerServiceWorker();

  if (!(await Store.init())) {
    document.getElementById("auth-status").textContent =
      "Not connected \u2014 add your Supabase URL and key to config.js";
    return;
  }

  // A read-only link is opened by somebody with no account, so it must never
  // go anywhere near the sign-in flow.
  const token = shareTokenFromHash();
  if (token) {
    await openStakeholderView(token);
    return;
  }

  // Restoring a saved session takes a moment. Say so instead of flashing an
  // empty dashboard that looks like the data is gone.
  document.getElementById("auth-status").textContent = "Restoring session\u2026";

  Store.onAuthChange((user) => {
    if (user && currentUser && user.id === currentUser.id) return; // token refresh
    if (user) onSignedIn(user);
    else if (currentUser || !booted) onSignedOut();
  });

  // Safety net in case the auth event never arrives.
  const user = await Store.currentUser();
  if (user && !currentUser) onSignedIn(user);
  else if (!user && !currentUser) onSignedOut();
}

boot();
