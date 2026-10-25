# 16 — Phase 6 Report: Admin Console

_2026-10-17. No migration (the schema already had what the admin needed).
Scope: [04 Phase 9](04-implementation-plan.md#phase-9--admin)._

**Status in one line:** the café can now run its own menu, store settings, loyalty rules and team
from the admin console, and every change is audited and permission-tested. Photo upload followed
on 2026-10-25, on Vercel Blob (§6). Tax rates stay in code (§4).

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

- ~~No photo upload~~: built 2026-10-25 (§6).
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

1. ~~Photo storage~~: **decided 2026-10-25 by owner: Vercel Blob** (§6).
2. **Demo data.** Real menu, hours and settings can now be entered from the console. Purging the
   demo data (`npm run db:purge-demo`) is the last step before going live.

## 6. Addendum (2026-10-25): product photos

**What was built.** The product edit page has a **Photo** section. A manager picks a photo, sees a
preview, and saves it with **required French and English alt text**. They can then change the alt
text alone, replace the photo, or remove it (the illustration comes back). The public menu and
product pages already displayed photos through `next/image`; they now show the uploaded ones.

**How it works.**

- **Storage interface** (`apps/web/src/server/storage.ts`) with two drivers:
  - **`local`** (development and tests): files in `apps/web/.dev-uploads`, served by
    `/api/dev/uploads`. On Vercel, where the filesystem is read-only, an upload is refused with
    "storage not set up" instead of failing silently.
  - **`vercel-blob`**: a public Vercel Blob store. Authentication uses `BLOB_STORE_ID` with the
    deployment's OIDC token, or `BLOB_READ_WRITE_TOKEN` elsewhere.
- **Checks on the server:**
  - JPEG, PNG or WebP only, recognised from the file's own bytes (the declared type isn't
    trusted, and SVG is refused).
  - 4 MB at most, to stay under Vercel's 4.5 MB request limit.
  - Alt text required in both languages, 200 characters each.
- **No broken images and no stray files.**
  - The file is stored first, then the product row points to it.
  - A replaced or removed photo is deleted only after the change is saved.
  - If the save fails, the new file is deleted.
  - Files that aren't in our store are never deleted.
  - Each upload gets a new address, so caches never show an old photo.
- **Audited:** each change is logged as `catalog.product_photo_set` (added, replaced, or alt text
  only) or `catalog.product_photo_removed`, with readable labels in the audit log.
- **API:** `PUT /api/v1/admin/products/:id/photo` (form upload) and `DELETE` on the same address.
  Manager and above only.
- **Residency:** menu photos contain no personal information, so the Law 25 concern for the
  database (D21) doesn't apply to them.

**Tests.**

| Suite       | Result                                                                                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | Recognising file types from their bytes; settings validation (local storage refused in staging/production; Blob credentials required)                                                                    |
| Integration | 6 photo scenarios: add (shown on the public menu), replace and alt-text-only, refusals, no stray file after a failed save or upload, remove, foreign URLs never deleted. Permission matrix +2. 155 total |
| E2E         | A manager uploads a photo; a wrong file type is refused; the public menu loads the photo through the image optimiser; the photo is removed; axe scan of the page                                         |

**To switch it on in the Vercel demo:**

1. In the Vercel dashboard, create a Blob store with **Public** access.
2. Connect it to `san-sebastian-cafe`.
3. Set `STORAGE_DRIVER=vercel-blob` and redeploy.

**Limitations.**

- **Photos aren't resized or compressed before storage.** The image optimiser resizes them when
  they're shown.
- **The file picker's own text** ("Choose File") follows the browser's language, not the site's.
