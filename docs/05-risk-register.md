# 05 — Risk Register

_Likelihood/Impact: L/M/H · Owner: who must act · Reviewed 2026-10-10_

| ID | Risk | L | I | Mitigation | Owner |
|---|---|---|---|---|---|
| **R1** | **Québec mandatory billing (SRS / WEB-SRM).** Restaurant operators, including cafés, must record sales through a Revenu Québec–certified sales recording system and give customers a bill produced by it. An online order paid outside the POS may not satisfy this. | H | **H** | Treat as a launch blocker. Identify the café's POS and its certification. Plan Phase 12 to push online orders into the certified POS. Get confirmation from an accountant or Revenu Québec. Label platform receipts as "order confirmation" until confirmed. | Owner + accountant |
| R2 | The payment provider choice conflicts with the POS (two processors, reconciliation pain, or duplicate fees) | M | M | Defer the provider decision to Phase 6 with the POS known. Use the adapter pattern and keep the fake provider for development. | Owner / Eng |
| R3 | Client-side price or discount tampering | M | H | Server-side quoting, snapshot on order, integration tests that send tampered payloads | Eng |
| R4 | Double charging, or orders marked paid without payment | M | H | Webhook-only payment truth, unique provider event IDs, idempotency keys, server re-fetch of the payment object, reconciliation report | Eng |
| R5 | Loyalty abuse or race conditions (double redemption, earn on refunded drinks, multi-account farming) | M | M | Ledger with unique constraints and row locks, reversal on refund, earn only on paid qualifying units, rate limits, stamp-claim window for guests, staff adjustments audited | Eng |
| R6 | Law 25 non-compliance: no privacy officer, missing PIA for out-of-Québec processing, no incident register, over-collection | M | H | Canadian hosting regions, data minimization, privacy features in Phase 11, list of all vendors (subprocessors) for the PIA. **Requires professional review.** | Owner + counsel |
| R7 | French-language obligations (Charter of the French Language as amended by Bill 96): the French version must be at least equivalent and available first. Terms and contracts presented in French first. | M | M | `fr-CA` default locale, CI check for missing FR keys, French-first legal pages, professional translation of marketing copy | Owner / translator |
| R8 | Consumer protection: tip suggestions must be on pre-tax amounts with equal emphasis; advertised prices must include all mandatory fees except taxes; gift card expiry/fees banned; loyalty points can't expire by time alone | M | M | Encode rules in the domain and UI. Legal review of copy. Delivery and service fees shown in the displayed price where required. | Eng + counsel |
| R9 | Tax treatment errors (prepared vs. zero-rated items, rounding, small-supplier status, tips not taxable) | M | M | Configurable tax categories with effective dates, documented rounding, accountant sign-off before launch, report of taxes collected | Owner + accountant |
| R10 | iOS web push only works for installed PWAs (iOS 16.4+), so ready notifications may not arrive | H | L | Email/SMS fallback, a clear "add to home screen" prompt, an in-app live status page, and staff calling out the name | Eng |
| R11 | Menu content (photos, bilingual descriptions, allergens) not delivered on time | H | M | Placeholder seed data clearly marked; an admin UI lets the owner self-serve. Launch is gated on real content. | Owner |
| R12 | Allergen information inaccurate, which is a safety and liability issue | L | H | Allergen fields are owner-managed with a disclaimer. No allergen claims are invented. Staff confirmation flow is optional. | Owner |
| R13 | Staff overwhelmed at rush, causing missed online orders | M | M | Pause ordering, slot capacity limits, dynamic prep time, loud alerts, auto-accept setting | Owner / Eng |
| R14 | Vendor lock-in or data residency (database host without a Canadian region) | M | M | Plain Postgres + Drizzle, a ca-central-1 host, adapters for all third parties | Eng |
| R15 | Scope creep (gift cards, delivery, inventory) delays the core launch | H | M | Phased roadmap. Optional modules gated behind owner approval and feature flags. | Owner / Eng |
| R16 | Accessibility gaps (contrast with brand gold, touch targets, screen-reader order flow) | M | M | Token contrast rules (gold is never used for text on ivory), axe in CI, manual SR audit | Eng / Design |
| R17 | Secrets leakage or misconfiguration | L | H | Zod env validation, no secrets in the client bundle (checked), secret scanning in CI, least-privilege keys | Eng |
| R18 | Reference designs belong to third-party designers and could be copied | M | L | Use them as mood references only. Our layouts, illustrations and compositions are original. | Design |
