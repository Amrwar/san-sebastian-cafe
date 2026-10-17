# 16 — Phase 6 Report: Admin Console

_2026-10-17. No migration (the schema already had what the admin needed).
Scope: [04 Phase 9](04-implementation-plan.md#phase-9--admin)._

**Status in one line:** the café can now run its own menu, store settings, loyalty rules and team
from the admin console, and every change is audited and permission-tested. **Photo upload is not
built yet**: it needs a storage decision (§5). Tax rates stay in code (§4).

## 1. What was built

The console has seven sections, linked by a shared navigation. Each section appears only to roles
that can use it.

| Section            | Who                        | What                                                                                                                                                                                                                                                             |
| ------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aperçu (overview)  | manager+                   | Catalogue counts, the demo-data warning, recent audit entries and a link to the full log.                                                                                                                                                                        |
| Menu               | manager+                   | Categories: create, rename, show or hide, archive (only when empty), reorder. Products: details, allergen notes, tax category, drink and loyalty flags, availability, sizes and prices, option groups in display order, weekly sales schedule; archive; reorder. |
| Options            | manager+                   | Option groups (milk, syrups…): single or multiple choice, min/max, options with extra charges and defaults, how many products use each group. Archiving is refused while a group is in use.                                                                      |
| Café               | manager+                   | Online ordering settings (on/off, auto-accept, prep time, slot length, days ahead, cutoff, minimum notice, slot capacity, payment window); weekly opening hours with split periods; dated closures that report orders already booked that day.                   |
| Fidélité (loyalty) | owner edits, managers read | Every loyalty rule from the engine, saved as a new version with a note. Unchanged rules are refused. The version history is shown below the form.                                                                                                                |
| Équipe (team)      | owner                      | Give a role (barista, shift lead, manager) to an email address; the account is created if needed. Change roles; remove access. Lowering a role signs the person out everywhere. The owner role and your own account can't be changed here.                       |
| Journal (audit)    | manager+                   | Every audited action, newest first: a readable label (raw code kept), who did it (staff by name, customers by role only), expandable details, area filters, pagination.                                                                                          |

**Guarantees:**

- **Nothing an order points to is deleted.** Removed sizes, options, products and categories are
  archived. Orders keep their own name and price snapshots, so a price change applies to new
  orders only (tested).
- **Every mutation is audited**, including before/after prices, changed fields and role changes.
- **Every mutation checks permission first.** A table-driven test runs each one as every role
  below the required one.

**API:** `/api/v1/admin/` covers categories, products, modifier groups, menu order, store
settings, hours and closures, loyalty programs, and team.

## 2. Test results (run locally 2026-10-17)

| Suite                                   | Result                                                               |
| --------------------------------------- | -------------------------------------------------------------------- |
| Typecheck · ESLint · Prettier           | ✔ clean                                                              |
| Unit — domain · web                     | ✔ 107 · 27 passed                                                    |
| Integration — db                        | ✔ 12 passed                                                          |
| Integration — web (real Postgres)       | ✔ 147 passed, incl. **31 new admin scenarios** (`admin.int.test.ts`) |
| E2E — Playwright + axe, desktop + phone | ✔ 69 passed (7 new admin flows) · 2 skipped: Stripe sandbox          |

**Admin scenarios covered:**

- **Menu:** a product appears on the public menu with its sizes and options; validation (loyalty
  flags need a drink, exactly one default size, unknown references, bad schedules); a price change
  leaves an existing order untouched; removed sizes are archived; archiving; categories (hidden,
  non-empty refused); reordering (a stale list is refused); option-group rules; a group in use
  can't be archived.
- **Store:** settings ranges and audit; split hours; a closed day blocks ordering; a closure
  reports booked orders and can be removed.
- **Team:** owner only; inviting creates a provisioned account; promote and demote (demotion ends
  sessions); owner and self protected; email and role validation; last sign-in.
- **Audit:** area filter, pagination, customers not named.
- **Permissions:** every mutation, every role.

**New E2E coverage:** create, edit and archive a product (seen live on the public menu); option
groups; closing and reopening a date; read-only vs. owner loyalty rules (including a real save);
invite, change and remove a team member; the audit log with filters; baristas denied. Screens were
reviewed at desktop and phone widths.

## 3. Issues found and fixed during the phase

- **Team page showed everyone as never signed in.** The correlated SQL subquery compared the
  session's own id. Last sign-in now comes from a grouped query, with a test.
- **Emails with spaces were rejected.** Pasted addresses failed validation; they are now trimmed
  first.
- **A role change would have wiped its own confirmation message.** Rows were keyed on the role,
  so they remounted.
- **E2E rate-limit budget.** Signing the owner in during setup used up `auth.spec`'s sign-in
  budget. The counters are now reset after setup; the app's limits are unchanged.

## 4. Known limitations

- **No photo upload** (§5). Products show the existing illustration. The menu marks products with
  "Sans photo".
- **Tax rates stay in code**, effective-dated in `packages/domain/src/pricing/tax.ts`. GST/QST
  rates change by law, rarely, and a mistake would mis-tax every order, so a reviewed code change
  is the safer route. Each product's tax category _is_ editable.
- **Size-specific option rules have no editor yet.** For example, "no iced single espresso" or a
  different extra price per size. Existing rules are kept.
- **Size-level loyalty exclusions have no editor yet.** Product-level exclusions are editable.
- **Ownership can't be transferred** from the console.
- **New team members get no invitation email.** The owner tells them to sign in with their address.
- **Category descriptions** are stored but not yet shown on the public menu.

## 5. Decisions and inputs needed

1. **Photo storage.** Product photos need somewhere to live. The app runs on Vercel (D21), so the
   natural fit is **Vercel Blob**, a public store with a CDN, set up from the Vercel dashboard.
   Choose:
   - **Vercel Blob:** I'll add a storage interface, use it in development with local files, and
     build the upload (required FR/EN alt text, size and type checks).
   - **Another host:** tell me which.
2. **Demo data.** Real menu, hours and settings can now be entered from the console. Purging the
   demo data (`npm run db:purge-demo`) is the last step before going live.
