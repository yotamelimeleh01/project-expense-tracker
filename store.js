"use strict";

// ---------------------------------------------------------------------------
// Storage abstraction.
//
// Two interchangeable backends behind one async API:
//   * LocalStore    - browser localStorage, works with no setup (single device)
//   * SupabaseStore - Postgres + Auth, syncs across every device you log into
//
// The app picks SupabaseStore automatically when config.js has credentials.
// ---------------------------------------------------------------------------

const LS_EXPENSES = "mpet.expenses.v3";
const LS_DRAWS = "mpet.draws.v1";

function newId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ---------- Local (offline) backend ----------
const LocalStore = {
  mode: "local",
  requiresAuth: false,

  async init() {},

  async getExpenses() {
    return readArray(LS_EXPENSES, () => SEED_EXPENSES.map((e) => ({ id: newId(), ...e })));
  },

  async getDraws() {
    return readArray(LS_DRAWS, () => SEED_DRAWS.map((d) => ({ id: newId(), ...d })));
  },

  async saveExpense(record, id) {
    const list = await this.getExpenses();
    const saved = id ? { ...list.find((e) => e.id === id), ...record, id } : { id: newId(), ...record };
    const next = id ? list.map((e) => (e.id === id ? saved : e)) : list.concat([saved]);
    writeArray(LS_EXPENSES, next);
    return saved;
  },

  async deleteExpense(id) {
    const list = await this.getExpenses();
    writeArray(LS_EXPENSES, list.filter((e) => e.id !== id));
  },

  async saveDraw(record, id) {
    const list = await this.getDraws();
    const saved = id ? { ...list.find((d) => d.id === id), ...record, id } : { id: newId(), ...record };
    const next = id ? list.map((d) => (d.id === id ? saved : d)) : list.concat([saved]);
    writeArray(LS_DRAWS, next);
    return saved;
  },

  async deleteDraw(id) {
    const list = await this.getDraws();
    writeArray(LS_DRAWS, list.filter((d) => d.id !== id));
  },
};

function readArray(key, fallback) {
  const raw = localStorage.getItem(key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      console.warn("Corrupt data in " + key + ", using seed.", e);
    }
  }
  return fallback();
}

function writeArray(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch (err) {
    alert(
      "Browser storage is full — that change could not be saved.\n\n" +
        "Offline mode is limited to about 5 MB. Connect Supabase (see README) " +
        "for unlimited receipt photos and cross-device sync."
    );
    throw err;
  }
}

// ---------- Supabase (cloud) backend ----------
const SupabaseStore = {
  mode: "cloud",
  requiresAuth: true,
  client: null,

  async init() {
    this.client = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
  },

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

  async getExpenses() {
    await this.requireSession();
    const { data, error } = await this.client
      .from("expenses")
      .select("*")
      .order("date", { ascending: true });
    if (error) throw error;
    return data.map(expenseFromRow);
  },

  async getDraws() {
    await this.requireSession();
    const { data, error } = await this.client
      .from("draws")
      .select("*")
      .order("date", { ascending: true });
    if (error) throw error;
    return data.map(drawFromRow);
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

function expenseToRow(e, id) {
  return {
    id,
    date: e.date || null,
    description: e.description,
    notes: e.notes || null,
    section: e.section,
    paid_by: e.paidBy,
    amount: Number(e.amount) || 0,
    receipts: Array.isArray(e.receipts) ? e.receipts : [],
  };
}

function expenseFromRow(r) {
  return {
    id: r.id,
    date: r.date || "",
    description: r.description || "",
    notes: r.notes || "",
    section: r.section || "",
    paidBy: r.paid_by,
    amount: Number(r.amount) || 0,
    receipts: Array.isArray(r.receipts) ? r.receipts : [],
  };
}

function drawToRow(d, id) {
  return {
    id,
    date: d.date || null,
    note: d.note || null,
    amount: Number(d.amount) || 0,
  };
}

function drawFromRow(r) {
  return {
    id: r.id,
    date: r.date || "",
    note: r.note || "",
    amount: Number(r.amount) || 0,
  };
}

function isCloudConfigured() {
  return Boolean(
    SUPABASE_CONFIG.url &&
      SUPABASE_CONFIG.anonKey &&
      window.supabase &&
      typeof window.supabase.createClient === "function"
  );
}

const Store = isCloudConfigured() ? SupabaseStore : LocalStore;
