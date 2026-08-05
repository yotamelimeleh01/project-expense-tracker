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

// The login token is a plain JSON payload in the middle of the string. Reading
// it is not a security check — the database re-checks the signature — it only
// lets us tell the difference between "you are not allowed" and "log in again".
function readToken(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const body = token.split(".")[1];
    if (!body) return null;
    return JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
  } catch (e) {
    return null;
  }
}

// Postgres refuses a blocked insert with "new row violates row-level security
// policy", which is accurate and tells you nothing. There are only three ways to
// get there, and the login token says which one it was.
function explainDenial(error, session, row) {
  if (!error || error.code !== "42501") return error;
  const claims = readToken(session && session.access_token);
  let why;
  if (!claims || claims.role !== "authenticated") {
    why =
      "The database did not see a signed-in user on this request (it saw \"" +
      ((claims && claims.role) || "nobody") +
      "\"). Sign out and sign back in.";
  } else if (row && row.created_by && claims.sub !== row.created_by) {
    why = "The row was stamped with a different account than the one you are signed in as.";
  } else {
    why =
      "You are signed in correctly, so the database is missing the rule that lets a " +
      "signed-in user create a project. Run supabase-fix-project-create.sql in the " +
      "Supabase SQL editor.";
  }
  const explained = new Error(error.message + "\n\n" + why);
  explained.code = error.code;
  return explained;
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
      if (data.session) return this.freshen(data.session);
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Not signed in \u2014 could not reach your data.");
  },

  // A login that lapses mid-request comes back from the database as a permission
  // error, which reads like "you are not allowed to do this" rather than "your
  // session ran out". Renew it a minute early instead of finding out the hard way.
  async freshen(session) {
    if (!session.expires_at || typeof this.client.auth.refreshSession !== "function") {
      return session;
    }
    if (session.expires_at * 1000 - Date.now() > 60000) return session;
    try {
      const { data } = await this.client.auth.refreshSession();
      return (data && data.session) || session;
    } catch (e) {
      return session;
    }
  },

  async select(table, columns, build) {
    await this.requireSession();
    let q = this.client.from(table).select(columns || "*");
    if (build) q = build(q);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },

  // ---------- Writing without signal ----------
  // Everything you touch standing in a driveway goes through here. If the write
  // cannot leave the phone it is put in a durable queue and the caller is handed
  // the row it would have got back, so the screen updates and the ledger is
  // right the moment there is signal again.
  //
  // Only writes that failed on the way out are queued. A permission error or a
  // rejected column is a real answer and has to surface immediately, or it would
  // sit in the queue being retried forever.
  async writeThrough(kind, payload, run, shape) {
    if (!Offline.online()) {
      await Offline.add(kind, payload);
      return shape ? shape(payload) : undefined;
    }
    try {
      return await run();
    } catch (err) {
      if (!Offline.isNetworkError(err)) throw err;
      await Offline.add(kind, payload);
      return shape ? shape(payload) : undefined;
    }
  },

  // Replays the queue oldest first. Order matters: an expense is saved before
  // the photo that belongs to it, which is exactly the order they were queued.
  async sync() {
    const items = await Offline.pending();
    const result = { sent: 0, stuck: 0, left: items.length };
    if (!items.length || !Offline.online()) return result;

    for (const item of items) {
      try {
        await this.replay(item);
        await Offline.remove(item.id);
        result.sent++;
        result.left--;
      } catch (err) {
        // Still no signal: stop and keep the rest for next time, unchanged.
        if (Offline.isNetworkError(err)) break;
        // A real rejection. Keep it, record why, and let the app show it rather
        // than throwing the entry away.
        item.tries++;
        item.error = String(err.message || err);
        await Offline.update(item);
        result.stuck++;
      }
    }
    Offline.announce();
    return result;
  },

  async replay(item) {
    const p = item.payload;
    switch (item.kind) {
      case "expense.save":
        return this.send("expenses", p);
      case "expense.delete":
        return this.erase("expenses", p.id);
      case "draw.save":
        return this.send("draws", p);
      case "draw.delete":
        return this.erase("draws", p.id);
      case "task.save":
        return this.send("tasks", p);
      case "task.delete":
        return this.erase("tasks", p.id);
      case "budget.save":
        return this.send("budget_lines", p, { onConflict: "project_id,category" });
      case "budget.delete":
        return this.erase("budget_lines", p.id);
      case "receipt.upload": {
        const blob = await Offline.takeReceipt(p.path);
        // The photo is gone from this device — a cleared cache, most likely.
        // Nothing can bring it back, so drop the entry rather than retry.
        if (!blob) return;
        await this.requireSession();
        const { error } = await this.client.storage
          .from("receipts")
          .upload(p.path, blob, { contentType: p.type || "image/jpeg", upsert: true });
        if (error) throw error;
        await Offline.dropReceipt(p.path);
        return;
      }
      case "receipt.delete": {
        await this.requireSession();
        const { error } = await this.client.storage.from("receipts").remove(p.paths);
        if (error) throw error;
        return;
      }
      default:
        throw new Error("Nothing knows how to send a " + item.kind);
    }
  },

  async send(table, row, opts) {
    await this.requireSession();
    const { error } = await this.client.from(table).upsert(row, opts);
    if (error) throw error;
  },

  async erase(table, id) {
    await this.requireSession();
    const { error } = await this.client.from(table).delete().eq("id", id);
    if (error) throw error;
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
    if (error) throw explainDenial(error, session, row);
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

  // ---------- Categories (the scope of work) ----------
  // A row with a project_id is that project's list. A row without one belongs
  // to your own library, which is what a new project is started from.
  // Pass no id to load every project's list at once.
  async getCategories(projectId) {
    const rows = await this.select("categories", "*", (q) => {
      const base = q.not("project_id", "is", null).order("sort", { ascending: true });
      return projectId ? base.eq("project_id", projectId) : base;
    });
    return rows.map(categoryFromRow);
  },

  async getCategoryLibrary() {
    const session = await this.requireSession();
    const rows = await this.select("categories", "*", (q) =>
      q.is("project_id", null).eq("owner", session.user.id).order("sort", { ascending: true })
    );
    return rows.map(categoryFromRow);
  },

  async saveCategory(record, id) {
    const session = await this.requireSession();
    const row = {
      id: id || newId(),
      project_id: record.projectId || null,
      owner: record.projectId ? null : session.user.id,
      name: record.name,
      group_key: record.group || "build",
      default_cost_type: record.defaultCostType || "Other",
      sort: Number(record.sort) || 0,
    };
    const { data, error } = await this.client
      .from("categories")
      .upsert(row)
      .select()
      .single();
    if (error) throw explainDenial(error, session, row);
    return categoryFromRow(data);
  },

  async deleteCategory(id) {
    await this.requireSession();
    const { error } = await this.client.from("categories").delete().eq("id", id);
    if (error) throw error;
  },

  // Renaming a phase has to carry everything filed under it. The name is what
  // an expense, a budget line and a schedule phase all point at, so leaving any
  // of them behind would empty the category the moment it was renamed.
  async renameCategory(projectId, from, to) {
    await this.requireSession();
    for (const table of ["expenses", "budget_lines", "tasks"]) {
      const { error } = await this.client
        .from(table)
        .update({ category: to })
        .eq("project_id", projectId)
        .eq("category", from);
      if (error) throw error;
    }
  },

  // A new project starts from your library, or from the built-in list the
  // first time round when the library is still empty.
  async seedCategories(projectId, list) {
    const session = await this.requireSession();
    const rows = list.map((c, i) => ({
      id: newId(),
      project_id: projectId,
      owner: null,
      name: c.name,
      group_key: c.group || "build",
      default_cost_type: c.defaultCostType || "Other",
      sort: (i + 1) * 10,
    }));
    if (!rows.length) return [];
    const { data, error } = await this.client.from("categories").insert(rows).select();
    if (error) throw explainDenial(error, session, rows[0]);
    return (data || []).map(categoryFromRow);
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

  // ---------- Schedule ----------
  // Tasks for every project you can see. The schedule panel needs only the
  // open project's, but the dashboard flags projects running late, which
  // means it needs them all.
  async getTasks(projectId) {
    const rows = await this.select("tasks", "*", (q) => {
      const ordered = q.order("sort", { ascending: true });
      return projectId ? ordered.eq("project_id", projectId) : ordered;
    });
    return rows.map(taskFromRow);
  },

  async saveTask(record, id) {
    const row = taskToRow(record, id || newId());
    return this.writeThrough(
      "task.save",
      row,
      async () => {
        await this.requireSession();
        const { data, error } = await this.client.from("tasks").upsert(row).select().single();
        if (error) throw error;
        return taskFromRow(data);
      },
      taskFromRow
    );
  },

  async deleteTask(id) {
    return this.writeThrough("task.delete", { id }, async () => {
      await this.requireSession();
      const { error } = await this.client.from("tasks").delete().eq("id", id);
      if (error) throw error;
    });
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
      schedule: !!opts.showSchedule,
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
    const row = {
      id: id || newId(),
      project_id: record.projectId,
      category: record.category,
      amount: Number(record.amount) || 0,
      notes: record.notes || null,
    };
    return this.writeThrough(
      "budget.save",
      row,
      async () => {
        await this.requireSession();
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
      budgetFromRow
    );
  },

  async deleteBudgetLine(id) {
    return this.writeThrough("budget.delete", { id }, async () => {
      await this.requireSession();
      const { error } = await this.client.from("budget_lines").delete().eq("id", id);
      if (error) throw error;
    });
  },

  // ---------- Receipt photos ----------
  // Photos live in a private Storage bucket under "<projectId>/<expenseId>/".
  // The first folder is what the storage policies read to decide who may look,
  // so the path is not cosmetic — never build one by hand.
  receiptPath(projectId, expenseId, ext) {
    const rand = Math.random().toString(36).slice(2, 10);
    return `${projectId}/${expenseId || "loose"}/${Date.now().toString(36)}${rand}.${ext || "jpg"}`;
  },

  // The photo is held on the device and uploaded when there is signal. The path
  // is decided here either way, so the expense row can reference it straight
  // away and nothing has to be patched up afterwards.
  async uploadReceipt(projectId, expenseId, blob) {
    const ext = (blob.type || "image/jpeg").split("/")[1].replace("jpeg", "jpg");
    const path = this.receiptPath(projectId, expenseId, ext);
    const queue = async () => {
      await Offline.holdReceipt(path, blob);
      await Offline.add("receipt.upload", { path, type: blob.type || "image/jpeg" });
      return path;
    };

    if (!Offline.online()) return queue();
    try {
      await this.requireSession();
      const { error } = await this.client.storage
        .from("receipts")
        .upload(path, blob, { contentType: blob.type || "image/jpeg", upsert: false });
      if (error) throw error;
      return path;
    } catch (err) {
      if (!Offline.isNetworkError(err)) throw err;
      return queue();
    }
  },

  // Nothing in the bucket is publicly readable, so every image needs a signed
  // URL. One round trip for the whole project rather than one per photo.
  async signReceipts(paths, seconds = 3600) {
    // A photo still waiting to upload has no URL to sign; the app shows it
    // straight off the device instead.
    const list = paths.filter((p) => p && !isDataUrl(p) && !Offline.previewUrl(p));
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
    // A photo that never made it off the device is dropped locally instead of
    // asking the server to remove something it has never seen.
    const pending = [];
    const remote = [];
    for (const p of list) {
      if (Offline.previewUrl(p)) pending.push(p);
      else remote.push(p);
    }
    for (const p of pending) await Offline.dropReceipt(p);
    if (!remote.length) return;

    return this.writeThrough("receipt.delete", { paths: remote }, async () => {
      await this.requireSession();
      const { error } = await this.client.storage.from("receipts").remove(remote);
      if (error) throw error;
    });
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
    const row = expenseToRow(record, id || newId());
    return this.writeThrough(
      "expense.save",
      row,
      async () => {
        await this.requireSession();
        const { data, error } = await this.client.from("expenses").upsert(row).select().single();
        if (error) throw error;
        return expenseFromRow(data);
      },
      expenseFromRow
    );
  },

  async deleteExpense(id) {
    return this.writeThrough("expense.delete", { id }, async () => {
      await this.requireSession();
      const { error } = await this.client.from("expenses").delete().eq("id", id);
      if (error) throw error;
    });
  },

  async saveDraw(record, id) {
    const row = drawToRow(record, id || newId());
    return this.writeThrough(
      "draw.save",
      row,
      async () => {
        await this.requireSession();
        const { data, error } = await this.client.from("draws").upsert(row).select().single();
        if (error) throw error;
        return drawFromRow(data);
      },
      drawFromRow
    );
  },

  async deleteDraw(id) {
    return this.writeThrough("draw.delete", { id }, async () => {
      await this.requireSession();
      const { error } = await this.client.from("draws").delete().eq("id", id);
      if (error) throw error;
    });
  },
};

// ---------- Row mappers ----------
function num(v) {
  return v === null || v === undefined || v === "" ? null : Number(v);
}

function categoryFromRow(r) {
  return {
    id: r.id,
    projectId: r.project_id || null,
    name: r.name,
    group: r.group_key || "build",
    defaultCostType: r.default_cost_type || "Other",
    sort: r.sort || 0,
  };
}

function projectToRow(p, id) {
  return {
    id,
    name: p.name,
    address: p.address || null,
    status: p.status || "before_closing",
    funding: p.funding === "cash" ? "cash" : "financed",
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
    funding: r.funding === "cash" ? "cash" : "financed",
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
    showSchedule: !!r.show_schedule,
    expiresAt: r.expires_at || null,
    createdAt: r.created_at || "",
  };
}

function taskToRow(t, id) {
  return {
    id,
    project_id: t.projectId,
    name: t.name,
    category: t.category || null,
    contractor_id: t.contractorId || null,
    duration_days: Math.max(1, Number(t.durationDays) || 1),
    planned_start: t.plannedStart || null,
    actual_start: t.actualStart || null,
    actual_end: t.actualEnd || null,
    status: t.status || "not_started",
    depends_on: Array.isArray(t.dependsOn) ? t.dependsOn : [],
    sort: Number(t.sort) || 0,
    notes: t.notes || null,
  };
}

function taskFromRow(r) {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name || "Untitled task",
    category: r.category || "",
    contractorId: r.contractor_id || null,
    durationDays: Math.max(1, Number(r.duration_days) || 1),
    plannedStart: r.planned_start || "",
    actualStart: r.actual_start || "",
    actualEnd: r.actual_end || "",
    status: r.status || "not_started",
    dependsOn: Array.isArray(r.depends_on) ? r.depends_on : [],
    sort: Number(r.sort) || 0,
    notes: r.notes || "",
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
