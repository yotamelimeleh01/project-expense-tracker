"use strict";

// ---------------------------------------------------------------------------
// Supabase-backed storage.
//
// Every read and write is scoped to a project, and Row Level Security decides
// which projects you are allowed to see at all — the client never filters for
// security, only for convenience.
// ---------------------------------------------------------------------------

function newId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

const Store = {
  client: null,
  ready: false,

  async init() {
    if (
      !SUPABASE_CONFIG.url ||
      !SUPABASE_CONFIG.anonKey ||
      !window.supabase ||
      typeof window.supabase.createClient !== "function"
    ) {
      this.ready = false;
      return false;
    }
    this.client = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
    this.ready = true;
    return true;
  },

  // ---------- Auth ----------
  async currentUser() {
    const { data } = await this.client.auth.getSession();
    return data.session ? data.session.user : null;
  },

  onAuthChange(cb) {
    this.client.auth.onAuthStateChange((_event, session) => {
      // Never call other Supabase methods synchronously from inside this
      // callback: supabase-js holds an internal auth lock while it runs, and
      // any nested call that needs the session (a query, signOut) will wait on
      // that lock forever. setTimeout pushes the work into a fresh task, after
      // the lock has been released.
      const user = session ? session.user : null;
      setTimeout(() => cb(user), 0);
    });
  },

  async signIn(email, password) {
    const { error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
  },

  async signOut() {
    await this.client.auth.signOut();
  },

  // Row Level Security answers an unauthenticated SELECT with an empty list and
  // a 200, not an error. Querying a beat too early therefore looks exactly like
  // "all your data is gone". Wait for the session to be in place first, and
  // fail loudly rather than silently reporting an empty ledger.
  async requireSession() {
    for (let attempt = 0; attempt < 20; attempt++) {
      const { data } = await this.client.auth.getSession();
      if (data.session) return data.session;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Not signed in \u2014 could not reach your data.");
  },

  async select(table, columns, build) {
    await this.requireSession();
    let q = this.client.from(table).select(columns || "*");
    if (build) q = build(q);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },

  // ---------- Projects ----------
  async getProjects() {
    const rows = await this.select("projects", "*", (q) =>
      q.order("created_at", { ascending: true })
    );
    return rows.map(projectFromRow);
  },

  // Insert and update are kept apart on purpose. An upsert would be re-checked
  // against the INSERT policy ("you must be the creator"), which would stop an
  // editor from so much as changing the status of someone else's project.
  async saveProject(record, id) {
    const session = await this.requireSession();
    const row = projectToRow(record, id || newId());
    if (id) {
      const { data, error } = await this.client
        .from("projects")
        .update(row)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return projectFromRow(data);
    }
    row.created_by = session.user.id;
    const { data, error } = await this.client.from("projects").insert(row).select().single();
    if (error) throw error;
    return projectFromRow(data);
  },

  async deleteProject(id) {
    await this.requireSession();
    const { error } = await this.client.from("projects").delete().eq("id", id);
    if (error) throw error;
  },

  // Ids are generated here so a receipt can be filed under its expense before
  // that expense exists in the database.
  newId() {
    return newId();
  },

  // ---------- Partners (whose money is in the deal) ----------
  async getPartners() {
    const rows = await this.select("project_partners", "*", (q) =>
      q.order("sort", { ascending: true })
    );
    return rows.map(partnerFromRow);
  },

  async savePartner(record, id) {
    await this.requireSession();
    const row = {
      id: id || newId(),
      project_id: record.projectId,
      name: record.name,
      sort: Number(record.sort) || 0,
      equity_pct: Number(record.equityPct) || 0,
    };
    const { data, error } = await this.client
      .from("project_partners")
      .upsert(row)
      .select()
      .single();
    if (error) throw error;
    return partnerFromRow(data);
  },

  async deletePartner(id) {
    await this.requireSession();
    const { error } = await this.client.from("project_partners").delete().eq("id", id);
    if (error) throw error;
  },

  // ---------- Share links (read-only access without an account) ----------
  async getShareLinks(projectId) {
    const rows = await this.select("share_links", "*", (q) =>
      q.eq("project_id", projectId).order("created_at", { ascending: true })
    );
    return rows.map(shareLinkFromRow);
  },

  // The token is minted in the database so it is always full-strength random.
  async createShareLink(projectId, opts) {
    await this.requireSession();
    const { data, error } = await this.client.rpc("share_link_create", {
      pid: projectId,
      link_label: opts.label || null,
      ledger: !!opts.showLedger,
      splits: !!opts.showSplits,
      budget: !!opts.showBudget,
      days: Number(opts.days) || 0,
    });
    if (error) throw error;
    return data;
  },

  async deleteShareLink(token) {
    await this.requireSession();
    const { error } = await this.client.from("share_links").delete().eq("token", token);
    if (error) throw error;
  },

  // The one call that deliberately does not wait for a session: whoever opens
  // a share link has no account. The token is the whole credential, and the
  // database decides what it is worth.
  async openShare(token) {
    const { data, error } = await this.client.rpc("share_view", { tok: token });
    if (error) throw error;
    return data || null;
  },

  // ---------- Members (who can open the project) ----------
  // Every membership row for every project you belong to. Gives both your own
  // role (what you're allowed to do) and the head count shown on each card.
  async getMemberships() {
    const rows = await this.select("project_members", "project_id,user_id,role");
    return rows.map((r) => ({ projectId: r.project_id, userId: r.user_id, role: r.role }));
  },

  async listMembers(projectId) {
    await this.requireSession();
    const { data, error } = await this.client.rpc("project_members_list", { pid: projectId });
    if (error) throw error;
    return (data || []).map((r) => ({ userId: r.user_id, email: r.email, role: r.role }));
  },

  async addMember(projectId, email, role) {
    await this.requireSession();
    const { error } = await this.client.rpc("project_member_add", {
      pid: projectId,
      member_email: email,
      member_role: role,
    });
    if (error) throw error;
  },

  async removeMember(projectId, userId) {
    await this.requireSession();
    const { error } = await this.client.rpc("project_member_remove", {
      pid: projectId,
      member_user_id: userId,
    });
    if (error) throw error;
  },

  // ---------- Budget ----------
  // Loaded for every project at once: the dashboard needs each project's
  // budget to show a health badge, and the numbers are tiny.
  async getBudgetLines() {
    const rows = await this.select("budget_lines", "*");
    return rows.map(budgetFromRow);
  },

  async saveBudgetLine(record, id) {
    await this.requireSession();
    const row = {
      id: id || newId(),
      project_id: record.projectId,
      category: record.category,
      amount: Number(record.amount) || 0,
      notes: record.notes || null,
    };
    // Upsert on (project_id, category) so re-saving the budget sheet updates
    // in place instead of piling up duplicate lines.
    const { data, error } = await this.client
      .from("budget_lines")
      .upsert(row, { onConflict: "project_id,category" })
      .select()
      .single();
    if (error) throw error;
    return budgetFromRow(data);
  },

  async deleteBudgetLine(id) {
    await this.requireSession();
    const { error } = await this.client.from("budget_lines").delete().eq("id", id);
    if (error) throw error;
  },

  // ---------- Receipt photos ----------
  // Photos live in a private Storage bucket under "<projectId>/<expenseId>/".
  // The first folder is what the storage policies read to decide who may look,
  // so the path is not cosmetic — never build one by hand.
  receiptPath(projectId, expenseId, ext) {
    const rand = Math.random().toString(36).slice(2, 10);
    return `${projectId}/${expenseId || "loose"}/${Date.now().toString(36)}${rand}.${ext || "jpg"}`;
  },

  async uploadReceipt(projectId, expenseId, blob) {
    await this.requireSession();
    const ext = (blob.type || "image/jpeg").split("/")[1].replace("jpeg", "jpg");
    const path = this.receiptPath(projectId, expenseId, ext);
    const { error } = await this.client.storage
      .from("receipts")
      .upload(path, blob, { contentType: blob.type || "image/jpeg", upsert: false });
    if (error) throw error;
    return path;
  },

  // Nothing in the bucket is publicly readable, so every image needs a signed
  // URL. One round trip for the whole project rather than one per photo.
  async signReceipts(paths, seconds = 3600) {
    const list = paths.filter((p) => p && !isDataUrl(p));
    if (!list.length) return {};
    await this.requireSession();
    const { data, error } = await this.client.storage
      .from("receipts")
      .createSignedUrls(list, seconds);
    if (error) throw error;
    const out = {};
    for (const row of data || []) {
      if (row.signedUrl && !row.error) out[row.path] = row.signedUrl;
    }
    return out;
  },

  async deleteReceipts(paths) {
    const list = (paths || []).filter((p) => p && !isDataUrl(p));
    if (!list.length) return;
    await this.requireSession();
    const { error } = await this.client.storage.from("receipts").remove(list);
    if (error) throw error;
  },

  // ---------- Contractors ----------
  // The directory is yours, not a project's: the same trade works across
  // several deals and the IRS wants one total per person per year.
  async getContractors() {
    const rows = await this.select("contractors", "*", (q) =>
      q.order("name", { ascending: true })
    );
    return rows.map(contractorFromRow);
  },

  async saveContractor(record, id) {
    await this.requireSession();
    const row = contractorToRow(record, id || newId());
    const { data, error } = await this.client
      .from("contractors")
      .upsert(row)
      .select()
      .single();
    if (error) throw error;
    return contractorFromRow(data);
  },

  async deleteContractor(id) {
    await this.requireSession();
    const { error } = await this.client.from("contractors").delete().eq("id", id);
    if (error) throw error;
  },

  // ---------- Ledger ----------
  // The dashboard needs every project's totals but none of the receipt images,
  // which are base64 and by far the heaviest column. Ask for just the numbers.
  async getExpenseSummaries() {
    const rows = await this.select(
      "expenses",
      "id,project_id,date,description,category,cost_type,partner_id,contractor_id,amount"
    );
    return rows.map(expenseFromRow);
  },

  async getExpenses(projectId) {
    const rows = await this.select("expenses", "*", (q) =>
      q.eq("project_id", projectId).order("date", { ascending: true })
    );
    return rows.map(expenseFromRow);
  },

  async getDraws(projectId) {
    const rows = await this.select("draws", "*", (q) => {
      const scoped = projectId ? q.eq("project_id", projectId) : q;
      return scoped.order("date", { ascending: true });
    });
    return rows.map(drawFromRow);
  },

  async saveExpense(record, id) {
    await this.requireSession();
    const row = expenseToRow(record, id || newId());
    const { data, error } = await this.client.from("expenses").upsert(row).select().single();
    if (error) throw error;
    return expenseFromRow(data);
  },

  async deleteExpense(id) {
    await this.requireSession();
    const { error } = await this.client.from("expenses").delete().eq("id", id);
    if (error) throw error;
  },

  async saveDraw(record, id) {
    await this.requireSession();
    const row = drawToRow(record, id || newId());
    const { data, error } = await this.client.from("draws").upsert(row).select().single();
    if (error) throw error;
    return drawFromRow(data);
  },

  async deleteDraw(id) {
    await this.requireSession();
    const { error } = await this.client.from("draws").delete().eq("id", id);
    if (error) throw error;
  },
};

// ---------- Row mappers ----------
function num(v) {
  return v === null || v === undefined || v === "" ? null : Number(v);
}

function projectToRow(p, id) {
  return {
    id,
    name: p.name,
    address: p.address || null,
    status: p.status || "before_closing",
    borrower: p.borrower || null,
    lender: p.lender || null,
    settlement_date: p.settlementDate || null,
    loan_amount: Number(p.loanAmount) || 0,
    loan_holdback: Number(p.loanHoldback) || 0,
    variance_threshold: Number(p.varianceThreshold) || 10,
    pref_annual_pct: Number(p.prefAnnualPct) || 0,
    purchase_price: num(p.purchasePrice),
    sale_price: num(p.salePrice),
    sale_date: p.saleDate || null,
    notes: p.notes || null,
  };
}

function projectFromRow(r) {
  return {
    id: r.id,
    name: r.name || "Untitled project",
    address: r.address || "",
    status: r.status || "before_closing",
    borrower: r.borrower || "",
    lender: r.lender || "",
    settlementDate: r.settlement_date || "",
    loanAmount: Number(r.loan_amount) || 0,
    loanHoldback: Number(r.loan_holdback) || 0,
    varianceThreshold: r.variance_threshold === null || r.variance_threshold === undefined
      ? 10
      : Number(r.variance_threshold),
    prefAnnualPct: Number(r.pref_annual_pct) || 0,
    purchasePrice: num(r.purchase_price),
    salePrice: num(r.sale_price),
    saleDate: r.sale_date || "",
    notes: r.notes || "",
    createdBy: r.created_by || null,
    createdAt: r.created_at || "",
  };
}

function partnerFromRow(r) {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name || "Partner",
    sort: Number(r.sort) || 0,
    equityPct: Number(r.equity_pct) || 0,
  };
}

function shareLinkFromRow(r) {
  return {
    token: r.token,
    projectId: r.project_id,
    label: r.label || "",
    showLedger: !!r.show_ledger,
    showSplits: !!r.show_splits,
    showBudget: !!r.show_budget,
    expiresAt: r.expires_at || null,
    createdAt: r.created_at || "",
  };
}

function budgetFromRow(r) {
  return {
    id: r.id,
    projectId: r.project_id,
    category: r.category,
    amount: Number(r.amount) || 0,
    notes: r.notes || "",
  };
}

// A receipt entry is either a storage path or an old base64 image still
// waiting to be moved. Everything that touches receipts has to know which.
function isDataUrl(s) {
  return typeof s === "string" && s.startsWith("data:");
}

function expenseToRow(e, id) {
  return {
    id,
    project_id: e.projectId,
    date: e.date || null,
    description: e.description,
    notes: e.notes || null,
    category: e.category,
    cost_type: e.costType || "Other",
    partner_id: e.partnerId || null,
    contractor_id: e.contractorId || null,
    amount: Number(e.amount) || 0,
    receipts: Array.isArray(e.receipts) ? e.receipts : [],
  };
}

function expenseFromRow(r) {
  return {
    id: r.id,
    projectId: r.project_id,
    date: r.date || "",
    description: r.description || "",
    notes: r.notes || "",
    category: r.category || "",
    costType: r.cost_type || "Other",
    partnerId: r.partner_id || null,
    contractorId: r.contractor_id || null,
    amount: Number(r.amount) || 0,
    receipts: Array.isArray(r.receipts) ? r.receipts : [],
  };
}

function contractorToRow(c, id) {
  return {
    id,
    name: c.name,
    company: c.company || null,
    trade: c.trade || null,
    phone: c.phone || null,
    email: c.email || null,
    w9_on_file: !!c.w9OnFile,
    tax_id_last4: c.taxIdLast4 || null,
    coi_expires: c.coiExpires || null,
    license_number: c.licenseNumber || null,
    license_expires: c.licenseExpires || null,
    notes: c.notes || null,
  };
}

function contractorFromRow(r) {
  return {
    id: r.id,
    ownerId: r.owner_id || null,
    name: r.name || "",
    company: r.company || "",
    trade: r.trade || "",
    phone: r.phone || "",
    email: r.email || "",
    w9OnFile: !!r.w9_on_file,
    taxIdLast4: r.tax_id_last4 || "",
    coiExpires: r.coi_expires || "",
    licenseNumber: r.license_number || "",
    licenseExpires: r.license_expires || "",
    notes: r.notes || "",
  };
}

function drawToRow(d, id) {
  return {
    id,
    project_id: d.projectId,
    date: d.date || null,
    note: d.note || null,
    amount: Number(d.amount) || 0,
  };
}

function drawFromRow(r) {
  return {
    id: r.id,
    projectId: r.project_id,
    date: r.date || "",
    note: r.note || "",
    amount: Number(r.amount) || 0,
  };
}
