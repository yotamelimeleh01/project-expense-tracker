# Master Project Expense Tracker

A live, editable expense tracker for the **450 Spring Dr, Ocala, FL 34472**
renovation project — the interactive version of the original PDF ledger.

Everything runs client-side (plain HTML/CSS/JS), so it hosts for free on
GitHub Pages and works on any device with a browser.

**Live app:** https://yotamelimeleh01.github.io/project-expense-tracker/

## Features

- **Auto-computed totals** — Partner A, Partner Z, and Total Outlay are always
  calculated from the line items, so the numbers can never drift.
- **Loan payoff at sale** — tracks the $137,700 note, the $42,500 construction
  holdback, and every draw you pull, so you always know what's owed back.
- **Receipt photos** — attach multiple images per expense (auto-compressed),
  tap any thumbnail to view it full screen.
- **Notes per expense** — record exactly what a receipt covers.
- **Add / edit / delete** expenses via a simple form.
- **Group by** section or partner, each with subtotals.
- **CSV export** and **print / save-to-PDF** to reproduce the original document.
- **Backup / Restore JSON** to move data between devices.
- **Reset to PDF** to restore the original seeded line items.

## Sections

1. **Closing & Deal Costs** — everyone who took a cut at settlement
2. **Utilities, Insurance, Loan & Taxes** — ongoing costs after closing
3. **Materials, Tools & Supplies**
4. **Contractors, Crew & Services**

---

## Cloud sync setup (Supabase)

Without setup the app runs in **offline mode**, saving to one browser only
(~5 MB cap). Connecting Supabase adds cross-device sync, logins, and room for
far more receipt photos. The free tier is more than this project needs.

### 1. Create the project

Sign up at [supabase.com](https://supabase.com), create a new project, and wait
for it to finish provisioning.

### 2. Create the tables

Open **SQL Editor → New query**, paste the contents of
[`supabase-setup.sql`](supabase-setup.sql), and click **Run**.

### 3. Create your login

1. Go to **Authentication → Users → Add user**.
2. Enter an email and password, and tick *Auto Confirm User*.
3. Repeat for your partner if they need access.
4. Go to **Authentication → Sign In / Up** and **disable public sign-ups**, so
   only users you create can log in.

### 4. Connect the app

Copy the **Project URL** and **anon public key** from **Project Settings → API**
into [`config.js`](config.js):

```js
const SUPABASE_CONFIG = {
  url: "https://YOUR-PROJECT.supabase.co",
  anonKey: "eyJhbGciOi...",
};
```

Commit and push — GitHub Pages redeploys automatically.

### 5. First sign-in

Sign in from the header. If the cloud database is empty and this browser already
has expenses saved offline, the app offers to upload them for you.

### Is the anon key safe to commit?

Yes. The anon key is meant to be public and grants **no access on its own**.
Both tables have Row Level Security enabled with policies that only allow
**signed-in** users to read or write, so an anonymous visitor holding the key
gets nothing back. Never commit the `service_role` key — that one bypasses RLS.

---

## Run locally

Just open `index.html` in a browser, or serve the folder:

```bash
npx serve .
```

## Deploy

Hosted via GitHub Pages from the `main` branch (root). Any push to `main`
updates the live site.
