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

### Categories

Every expense is filed under a **category** (what the money was for) and a
**cost type** (what kind of spend it was — materials, labour, services, fees).
The two axes are independent, so "who do I owe a 1099" and "how much did the
kitchen cost" are both answerable from the same rows.

Categories roll up into four buckets:

1. **Cost To Purchase** — closing and deal costs, plus the lender principal
2. **Cost To Do The Work** — the construction phases, permits through landscaping
3. **Cost To Hold** — utilities, insurance, taxes and loan carry
4. **Cost To Sell** — commissions and disposition costs

### Budget vs actual

Set a number against any category on a project and the app tracks spend
against it. A category with no budget is still listed, but never counted as a
variance — you cannot be over a number you never set.

Each project has a variance threshold (10% by default). Once a category passes
its budget the project is flagged **Watch**; once it passes the threshold it is
flagged **Over Budget**, on the project page and on the dashboard card, so a
phase that is drifting shows up while there is still time to react.

### Receipts

Photos are resized in the browser and uploaded to a private Supabase Storage
bucket, filed under `<project>/<expense>/`. Nothing in the bucket is readable
without a signed URL, and the same membership rules that hide a project's
ledger hide its photos.

Receipts taken before this change were stored as base64 inside the expense row.
The app moves them across the first time you open the project: it uploads the
image, checks the upload is readable, and only then rewrites the row. If any
step fails the original is left exactly where it was.

### Lender draw request

**Draw Request** in the loan panel lists everything filed under *Cost To Do The
Work* since your last draw, already ticked. Untick what the lender will not
reimburse and print it, or save it as a PDF from the print dialog. The document
carries the property, borrower, lender, loan position, an itemised schedule
subtotalled by category, a certification paragraph and a signature line.

It warns you if the request exceeds the holdback remaining, or if any line has
no receipt attached — the usual reason a draw sits on someone's desk.

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
3. [`supabase-phase1-budgets.sql`](supabase-phase1-budgets.sql) — categories,
   cost types, and budget lines
4. [`supabase-phase2-storage.sql`](supabase-phase2-storage.sql) — the private
   receipts bucket and its access policies

Every script after the first is additive and safe to re-run. On an existing
database they move what you already have onto the new shape rather than
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
