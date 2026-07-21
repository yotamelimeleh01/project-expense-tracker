# Master Project Expense Tracker

A live, editable expense tracker for the **450 Spring Dr, Ocala, FL 34472**
renovation project — the interactive version of the original PDF ledger.

Everything runs client-side (plain HTML/CSS/JS), so it hosts for free on
GitHub Pages and works on any device with a browser.

## Features

- **Auto-computed totals** — Partner A, Partner Z, and Total Outlay are always
  calculated from the line items, so the numbers can never drift.
- **Reconciliation banner** — flags any gap between the live total and the
  original PDF header total.
- **Add / edit / delete** expenses via a simple form.
- **Group by** section or partner, each with subtotals.
- **CSV export** and **print / save-to-PDF** to reproduce the original document.
- **Backup / Restore JSON** to move data between devices.
- **Reset to PDF** to restore the original 24 seeded line items.

## Data & storage

Expenses are stored in the browser's `localStorage` on each device. To use the
same data on your phone and laptop, use **Backup JSON** on one device and
**Restore JSON** on the other. (See below for optional live cloud sync.)

The original PDF's header totals did not reconcile with its itemized rows — the
24 seeded rows sum to **$26,149.93**, not the header's **$32,319.91**. The app
surfaces this gap so the missing receipts can be added.

## Run locally

Just open `index.html` in a browser, or serve the folder:

```bash
npx serve .
```

## Deploy

Hosted via GitHub Pages from the `main` branch (root). Any push to `main`
updates the live site.

## Optional: live cross-device sync

To make edits sync automatically across devices (instead of manual JSON
backup/restore), the `load`/`save` functions in `app.js` can be pointed at a
free [Supabase](https://supabase.com) table. Ask and this can be wired up.
