# 27 — Delivery Report

_2026-10-28. Migration `0014_delivery_out_for_delivery.sql`. Scope: the delivery part of
[04 Phase 14](04-implementation-plan.md#phase-14--optional-modules-each-needs-an-owner-go-ahead),
with the café's own couriers. **Built switched off:** delivery appears at checkout only once a
manager switches a zone on, which waits for the owner's decision D12
([07](07-open-decisions.md))._

**Status in one line:** a manager sets up zones by postal-code prefix with a fee, a minimum and a
travel time; customers in a zone that is on can choose delivery at checkout (address, phone for
the courier, estimated arrival); the counter sees the address and phone on the queue and moves the
order ready → handed to the courier → delivered; the customer is told it is on its way; reports
show delivery fees; addresses are erased six months on.

## 1. What was already there

The data model (zones, the order's fulfilment, address and fee), the quote (fee, minimum, zone
matched by postal code) and the checkout form were built with checkout in Phase 6, but nothing let
anyone set up a zone, and nothing after payment knew about delivery: staff saw a "Livraison" badge
without the address, a delivery order could only be "picked up", and the customer's "ready" email
told them to come to the counter.

## 2. What was added

| Area                                               | Behaviour                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zones (Administration → Livraison, manager and up) | Name FR/EN, postal-code prefixes (first 3 characters, e.g. H2T; stored in capitals, once each), fee 0–50 $, minimum order, travel time 5–180 min. New zones start **off**. Two zones that are on can't share a prefix (a customer's fee must not depend on luck). Never deleted (orders point to them): switched off. Every change audited     |
| Checkout                                           | Unchanged form, now with the **phone required** for delivery (checked on the server too: at least 7 digits)                                                                                                                                                                                                                                    |
| Estimated arrival                                  | Preparation time plus the zone's travel time, saved with the order; shown on the order page, the staff card and in the confirmation email ("Livraison prévue vers …")                                                                                                                                                                          |
| Order lifecycle                                    | New status **`out_for_delivery`** (delivery orders only): ready → out for delivery → completed ("Livrée"). A delivery order can't be completed without going to the courier; a pickup order never goes out for delivery. A failed delivery is cancelled by a shift lead with a reason (full refund); the food has left, so no stock comes back |
| Staff queue                                        | Delivery cards show the address, instructions, a tap-to-call phone number and the arrival time; buttons **Remise au livreur** then **Livrée**; orders on their way stay in the "Prêtes" column with an "En route" badge until delivered                                                                                                        |
| Customer                                           | Tracking shows the delivery steps (… Prête → En route → Livrée); no "come to the counter" message; an **"on its way" email and push** when it leaves (the "ready" notice is not sent for deliveries)                                                                                                                                           |
| Reports                                            | Delivery fees charged and number of deliveries under the tax table; a "Livraison" column in the orders CSV. The fee is part of goods and taxed like them (⚖ to confirm with the accountant, as noted since Phase 3)                                                                                                                            |
| Privacy (Law 25)                                   | Addresses are in the customer's data export; removed when the account is deleted (as before); **erased by the retention job 180 days after the order**, for customers with an account too (the order stays for the books, marked as a delivery)                                                                                                |

## 3. Not built (each needs a decision or an account)

- **Third-party couriers** (Uber Direct, DoorDash Drive): need the café's account with one of
  them. The zone and order model don't change; a courier adapter would request the pickup when the
  order is ready and move it to "out for delivery" and "delivered" from the courier's updates.
- **Scheduled deliveries**: delivery is as soon as possible only, as before (pickup keeps its time
  slots). Slots for deliveries need a courier capacity the café hasn't set.
- **Map-drawn zones**: postal-code prefixes only, as designed in Phase 0.
- Delivery terms (fees, refunds when nobody answers) belong in the conditions of sale, for the
  lawyer's review.

## 4. Tests

| Suite                       | Result                                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain (Vitest)             | ✔ 149 (4 new: the delivery path, no skipping the courier, pickup never out for delivery, failed delivery cancelled by a shift lead with a reason, no stock back once it left)                                                                                                                                                                  |
| Integration (real Postgres) | ✔ 268 web + 12 db (new `delivery.int.test.ts`, 8: offered only while a zone is on, prefixes normalised and audited, no shared prefix between zones that are on, roles and invalid values, fee + phone + arrival time, courier step with its notice and no "ready" email, failed delivery refunded, report fees, export then retention erasure) |
| E2E (Playwright + axe)      | new `delivery.spec.ts`: a manager opens a zone → a guest orders delivery (phone required) and pays → the counter sees the address and tap-to-call phone, hands it to the courier → the customer sees "en route" live and gets the email → delivered; the zone is switched off again                                                            |
