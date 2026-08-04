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
    this.client.auth.onAuthStateChange((_event, session) => cb(session ? session.user : null));
  },

  async signIn(email, password) {
    const { error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
  },

  async signOut() {
    await this.client.auth.signOut();
  },

  async getExpenses() {
    const { data, error } = await this.client
      .from("expenses")
      .select("*")
      .order("date", { ascending: true });
    if (error) throw error;
    return data.map(expenseFromRow);
  },

  async getDraws() {
    const { data, error } = await this.client
      .from("draws")
      .select("*")
      .order("date", { ascending: true });
    if (error) throw error;
    return data.map(drawFromRow);
  },

  async saveExpense(record, id) {
    const row = expenseToRow(record, id || newId());
    const { data, error } = await this.client.from("expenses").upsert(row).select().single();
    if (error) throw error;
    return expenseFromRow(data);
  },

  async deleteExpense(id) {
    const { error } = await this.client.from("expenses").delete().eq("id", id);
    if (error) throw error;
  },

  async saveDraw(record, id) {
    const row = drawToRow(record, id || newId());
    const { data, error } = await this.client.from("draws").upsert(row).select().single();
    if (error) throw error;
    return drawFromRow(data);
  },

  async deleteDraw(id) {
    const { error } = await this.client.from("draws").delete().eq("id", id);
    if (error) throw error;
  },

  async replaceAll(expenses, draws) {
    // neq on a value no id can hold = "delete everything" without disabling RLS.
    let res = await this.client.from("expenses").delete().neq("id", "__none__");
    if (res.error) throw res.error;
    if (expenses.length) {
      res = await this.client
        .from("expenses")
        .insert(expenses.map((e) => expenseToRow(e, e.id || newId())));
      if (res.error) throw res.error;
    }
    if (draws) {
      res = await this.client.from("draws").delete().neq("id", "__none__");
      if (res.error) throw res.error;
      if (draws.length) {
        res = await this.client.from("draws").insert(draws.map((d) => drawToRow(d, d.id || newId())));
        if (res.error) throw res.error;
      }
    }
  },

  // Pull anything still sitting in this browser's offline storage into the cloud.
  async importLocalData() {
    const expenses = await LocalStore.getExpenses();
    const draws = await LocalStore.getDraws();
    await this.replaceAll(expenses, draws);
    return expenses.length;
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
