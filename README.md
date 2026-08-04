# Project Expense Tracker

A live, multi-project expense tracker for real estate deals. Run several
projects side by side, see what each one has cost you all-in, and share
individual projects with the partners who belong on them.

Everything runs client-side (plain HTML/CSS/JS), so it hosts for free on
GitHub Pages and works on any device with a browser.

**Live app:** https://yotamelimeleh01.github.io/project-expense-tracker/

## How it works

### Dashboard

Every project you have access to, as a card: status, all-in cost, your cash in,
what you owe the lender, and profit once a sale price is entered. Above them, a
portfolio line that adds it all up.

Statuses run **Before Closing → Closed → In Progress → Done → Sold**, and can be
changed from the project page without opening a form.

### A project

- **Total all-in** — your cash out of pocket plus the loan principal the lender
  funded at closing. The one number that answers "what is in this deal".
- **Profit** — sale price minus all-in, shown as soon as you enter a sale price.
  Projected while the project is live, final once it is marked Sold.
- **Per-partner totals** — one card per partner, however many the project has.
- **Where the money went** — three buckets that always add up to the all-in
  figure: *Cost To Purchase*, *Cost To Do The Work*, *Cost To Hold*.
- **Loan payoff at sale** — the note, the construction holdback, and every draw
  you pull, so you always know what has to be repaid.
- **Receipt photos** — several per expense, auto-compressed, tap to enlarge.
- **Notes** per expense, **CSV export**, and **print / save-to-PDF**.

### Two kinds of people

They are deliberately separate:

- **Partners** are whose money is in the deal. Expenses are attributed to them.
  A partner does not need a login.
- **Members** are who can open the project in the app. Roles are **owner**
  (full control, can share), **editor** (can change expenses), and **viewer**
  (read only). Add them under *Who Has Access*.

Access is enforced by Postgres Row Level Security, not by the browser — a
project you are not a member of is invisible to you at the database level.

### Sections

1. **Closing & Deal Costs** — everyone who took a cut at settlement
2. **Utilities, Insurance, Loan & Taxes** — ongoing costs after closing
3. **Materials, Tools & Supplies**
4. **Contractors, Crew & Services**

### Why draws are not added to all-in

A construction draw reimburses an expense that is already a line item, so
counting both would inflate the total by every draw. Draws do raise the lender
payoff, which is tracked separately.

---

## Setup (Supabase)

The app needs a Supabase project. The free tier covers this comfortably.

### 1. Create the project

Sign up at [supabase.com](https://supabase.com), create a project, and wait for
it to provision.

### 2. Create the schema

Open **SQL Editor → New query** and run these in order:

1. [`supabase-setup.sql`](supabase-setup.sql) — the expense and draw tables
2. [`supabase-multiproject.sql`](supabase-multiproject.sql) — projects,
   partners, access control, and RLS

The second script is additive and safe to re-run. On an existing single-project
database it moves everything you already have into a project rather than
deleting anything.

### 3. Create logins

1. **Authentication → Users → Add user**, tick *Auto Confirm User*.
2. Repeat for anyone who needs access.
3. **Authentication → Sign In / Up** → disable public sign-ups, so only users
   you create can log in.

Someone must have an account before you can add them to a project.

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

### Is the anon key safe to commit?

Yes. The anon key is meant to be public and grants **no access on its own**.
Every table has Row Level Security enabled, and every policy requires a
signed-in user who is a member of the project in question. An anonymous visitor
holding the key gets nothing back. Never commit the `service_role` key — that
one bypasses RLS.

---

## Run locally

Serve the folder (the app needs a real origin for auth to persist):

```bash
npx serve .
```

## Deploy

Hosted via GitHub Pages from the `main` branch (root). Any push to `main`
updates the live site.
