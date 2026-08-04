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

### Contractors

**Contractors** on the dashboard is your directory of the people you pay. It is
deliberately not owned by a project — the same electrician works on several of
your deals, and at year end the numbers have to add up across all of them.

A partner on a shared project can see a contractor named on that project's
expenses, and nothing else in your directory. They cannot edit it.

### Insurance and licence expiry

Put a COI or licence expiry date against a contractor and the dashboard warns
you when it lapses, or within 30 days of lapsing. A contractor is judged on
whichever of the two dates is worse — current insurance is no help if the
licence ran out last month.

### 1099s

The **1099s** tab totals what each contractor was paid in a calendar year,
across every project you can see, counting only labour and services. Materials
are never reportable, which is precisely why cost type is a separate field from
category.

Anyone over $600 is flagged, and the app tells you which of them still has no
W-9 on file. Export the lot as CSV for your accountant. Corporations are
generally exempt, so the report flags people rather than filing anything.

Only the last four digits of a tax ID are stored. Do not type a full SSN or EIN
into this app — keep the W-9 itself somewhere built to hold it.

### Who takes home what

Give each partner an equity percentage in project settings and a sold project
shows the waterfall:

1. **Capital back.** Every partner gets their own money out first, less their
   share of any construction draws already received.
2. **Preferred return.** If the deal pays one, it accrues on each dollar from
   the day it was spent to the day of the sale.
3. **The upside.** Whatever is left is divided by the equity percentages.

Equity decides the upside only, which is why the partner who fronted more cash
does not automatically take more profit — they take their cash back first, and
then their agreed share. Leave every percentage at zero and the split falls
back to each partner's share of the money that went in.

The payouts always add up to the cash on the table at closing, and the upside
always equals the profit shown at the top of the page. If the sale does not
cover what went in, everyone takes the same proportional loss rather than
first-in-best-dressed. Percentages that miss 100% and spend not assigned to any
partner are both called out rather than quietly absorbed.

### Read-only links

**Who Has Access** can also mint a link for someone with no account — a lender,
an investor, a spouse. Four switches decide how much the link shows: budget vs
actual, the schedule and finish date, every line item, and partner names with
the split. Everything else is left out. Receipts, internal notes, the borrower
name, contractors and the access list are never sent, whatever the switches say.

The token is generated in the database, never in the browser. Opening the link
calls one function that checks the token and returns exactly what that link is
allowed to see; there is no path from a link to any other project. Links carry
an expiry (30 days by default) and revoking one takes effect immediately.

Treat a link like a password: anyone holding it can read what it covers.

### The schedule

A rehab is a chain of trades, and each one waits for the one before it. Add the
phases, say how long each takes and what it waits for, and the app works out
the dates. **Start From A Typical Rehab** writes the usual twelve phases —
permits through final inspection — in the order they normally happen, so there
is something to edit rather than a blank page.

Nothing about lateness is stored, because a stored flag goes stale the moment
anything moves. A phase is *blocked* when something it waits for is unfinished,
and *late* when the date it should have started or finished has passed. Marking
demolition finished five days over pushes framing, drywall and everything after
it out by five days automatically.

The phases outlined in red are the **critical path** — the ones with no slack.
Lose a day on any of them and the project finishes a day later. Lose a week on
anything else and the finish date does not move at all. That is the difference
between a problem and an inconvenience.

Delay is priced from the ledger rather than guessed at. Everything already
recorded under *Cost To Hold* — interest, taxes, insurance, utilities — divided
by the days since settlement gives what a day of holding this property actually
costs, and the schedule multiplies that by the current slip.

Days are calendar days, weekends included. A circular dependency is reported by
name rather than silently accepted, and deleting a phase clears it from
whatever was waiting on it.

### On site with no signal

The app installs to a phone's home screen — open it in the browser and choose
**Add to Home Screen**. From then on it opens full screen with its own icon and
no address bar.

A half-gutted house is exactly where the signal dies, so nothing depends on
having one. Expenses, draws, budget lines and schedule phases can all be typed
with no connection. They appear on screen immediately and every total updates,
but they are held on the device and a bar under the header says how many are
waiting. When the signal comes back they go up on their own, and the page
reloads from the server so what you see is what was actually saved.

Receipt photos work the same way. **Take A Photo** opens the camera straight
from the expense form. The photo is compressed, held in the device's storage,
and shown in the expense while it waits its turn to upload.

The difference that matters is between a change that never left the phone and a
change the server looked at and refused. The first is queued and retried. The
second is never queued — you are told what the server said the moment it says
it, because quietly retrying a rejected write forever, while claiming the work
was saved, is worse than losing it.

Opening the app with no signal at all still shows the portfolio: the last
successful load is kept in the browser's storage. Receipt photos are the one
thing that will not appear, since they live in Storage. That cached copy is
wiped on sign-out.

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
5. [`supabase-phase3-contractors.sql`](supabase-phase3-contractors.sql) — the
   contractor directory and the link from expenses to it
6. [`supabase-phase4-splits-shares.sql`](supabase-phase4-splits-shares.sql) —
   equity percentages, preferred return, and read-only share links
7. [`supabase-phase5-schedule.sql`](supabase-phase5-schedule.sql) — the schedule
   table, trade dependencies, and the schedule switch on share links

Every script after the first is additive and safe to re-run. On an existing
database they move what you already have onto the new shape rather than
deleting anything.

Working offline needs no migration \u2014 the queue and the cached copy live in the
browser, not the database.

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

The app is cached by a service worker, so anyone who already has it open keeps
the old version until they accept the reload it offers them. Bump `CACHE` in
`sw.js` whenever the list of shell files changes, or the new files will not be
picked up.
