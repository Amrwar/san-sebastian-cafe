# 03 — Data Model (logical)

_Status: Proposed · PostgreSQL · all money in integer cents (CAD) · all timestamps `timestamptz` (UTC; displayed in America/Toronto — Montréal's IANA zone)_

Conventions: `id uuid pk` (UUIDv7 for time-ordering), `created_at`, `updated_at` on every table; soft delete (`archived_at`) for catalog entities referenced by historical orders; bilingual text stored as paired columns (`name_fr`, `name_en`) — simple, queryable, and forces both languages to exist (FR required, EN required before publish).

## 1. Identity & access

| Table | Key columns | Notes |
|---|---|---|
| `users` | email (citext, unique), email_verified, name, phone?, preferred_locale (`fr-CA`/`en-CA`), status | Managed with Better Auth |
| `sessions`, `accounts`, `verifications` | Better Auth standard tables | HTTP-only secure cookies; session rotation |
| `staff_memberships` | user_id, location_id, role (`staff`/`shift_lead`/`manager`/`owner`), active | Role per location |
| `consents` | user_id, kind (`marketing_email`, `marketing_sms`, `push`), granted, source, ip_hash, recorded_at | Append-only history (CASL / Law 25 proof) |
| `audit_log` | actor_user_id, action, entity_type, entity_id, before jsonb, after jsonb, reason, ip_hash, at | Append-only |

## 2. Store & configuration

| Table | Key columns |
|---|---|
| `locations` | name, address, timezone, phone, gst_number?, qst_number?, online_ordering_enabled, paused_until?, default_prep_minutes |
| `opening_hours` | location_id, weekday, opens_at, closes_at (multiple ranges per day allowed) |
| `closures` | location_id, date, reason_fr/en (holidays) |
| `pickup_slot_config` | location_id, slot_minutes, max_orders_per_slot, max_items_per_slot, min_lead_minutes, max_days_ahead |
| `tax_rates` | code (`GST`,`QST`), rate_bps (e.g. 500, 9975), effective_from, effective_to |
| `tax_categories` | code (`prepared_food_beverage`, `zero_rated_grocery`, `exempt`), applicable taxes — **to be confirmed by accountant** |
| `settings` | location_id, key, value jsonb (tip presets, guest stamp-claim window, etc.) |

## 3. Catalog

| Table | Key columns | Notes |
|---|---|---|
| `categories` | location_id, slug, name_fr/en, description_fr/en, image_id?, sort, visible | |
| `products` | category_id, slug, name_fr/en, description_fr/en, base_price_cents, tax_category_id, is_drink, loyalty_qualifying, reward_eligible, availability (`available`/`sold_out`/`hidden`), available_windows jsonb?, allergens text[], dietary text[], sort, archived_at | |
| `product_images` | product_id, storage_key, alt_fr/en, width, height, blurhash, sort | Alt text is required in both languages |
| `modifier_groups` | name_fr/en, selection (`single`/`multi`), min, max, required, sort | Reusable across products |
| `product_modifier_groups` | product_id, group_id, sort, overrides jsonb? | Many-to-many |
| `modifier_options` | group_id, name_fr/en, price_delta_cents, is_default, availability, sort, archived_at | |
| `option_price_rules` | product_id, option_id, price_delta_cents | Optional, e.g. "oat milk +0.75 on small, +0.90 on large" |

## 4. Cart, orders & payments

| Table | Key columns | Notes |
|---|---|---|
| `orders` | location_id, number (human short code, per-day sequence), user_id?, guest_email?, guest_name?, fulfilment (`pickup`/`delivery`), pickup_at?, asap, status, version (optimistic lock), subtotal_cents, discount_cents, reward_discount_cents, gst_cents, qst_cents, tip_cents, delivery_fee_cents, total_cents, pricing_snapshot jsonb, locale, notes, idempotency_key (unique), expires_at, placed_at, paid_at, ready_at, picked_up_at | Snapshot = immutable pricing evidence |
| `order_lines` | order_id, product_id, product_name_fr/en (snapshot), qty, unit_price_cents, modifiers_total_cents, line_subtotal_cents, line_discount_cents, tax_category_code, is_drink, loyalty_qualifying, reward_redemption_id? | Snapshotted at quote time |
| `order_line_modifiers` | order_line_id, option_id, name_fr/en (snapshot), price_delta_cents | |
| `order_status_events` | order_id, from_status, to_status, actor_user_id?, actor_kind (`customer`/`staff`/`system`/`webhook`), reason, at | |
| `payments` | order_id, provider, provider_payment_id (unique), status (`requires_action`/`processing`/`succeeded`/`failed`/`cancelled`), amount_cents, currency='CAD', captured_at | No card data — only provider references (brand + last4 for receipt, if provider returns) |
| `refunds` | payment_id, provider_refund_id (unique), amount_cents, reason, status, requested_by | |
| `payment_events` | provider, event_id (**unique**), type, payload jsonb, received_at, processed_at?, error? | Webhook idempotency/inbox |
| `slot_reservations` | location_id, slot_start, order_id (unique), items | Capacity enforcement (counted under row lock) |

## 5. Loyalty

| Table | Key columns | Notes |
|---|---|---|
| `loyalty_programs` | location_id, version, stamps_per_reward (5), reward_value_cap_cents?, reward_includes_modifiers bool, earn_trigger (`paid`/`picked_up`), active_from, active_to | Versioned; orders record program version |
| `loyalty_accounts` | user_id (unique), stamp_balance, lifetime_stamps, version | Cached balance; locked FOR UPDATE on mutation |
| `loyalty_entries` | account_id, kind (`earn`/`reverse`/`convert`/`adjust`), stamps (+/−), order_line_id?, reason?, actor_user_id?, at; **unique (order_line_id, kind)** | Append-only stamp ledger |
| `rewards` | account_id, program_version, status (`available`/`reserved`/`redeemed`/`revoked`), issued_at, reserved_order_id?, redeemed_order_id?, redeemed_at | One row per earned free drink |
| `reward_redemptions` | reward_id (unique where status active), order_id, order_line_id, discount_cents | |

Invariant (tested): `stamp_balance = Σ entries.stamps` and `stamp_balance ≥ 0` unless policy allows negative after refunds; reward count = floor(conversions).

## 6. Engagement & growth (later phases)

| Table | Key columns |
|---|---|
| `favorites` | user_id, product_id, saved_config jsonb (options), name? |
| `push_subscriptions` | user_id, endpoint (unique), p256dh, auth, user_agent, created_at |
| `promotions` | code?, kind, value, scope (order/product/category), starts_at, ends_at, max_uses, per_customer_limit, stackable_with_rewards, active |
| `promotion_redemptions` | promotion_id, order_id, user_id?, discount_cents |
| `referral_codes` / `referrals` | user_id, code (unique) / referrer_id, referee_id, status, rewarded_at |
| `gift_cards` / `gift_card_ledger` | code_hash, balance_cents, status / card_id, delta_cents, order_id?, kind — **no expiry (QC)** |
| `inventory_items` / `stock_movements` | later |
| `delivery_zones` | polygon/geojson or postal-prefix list, fee_cents, min_order_cents | later |

## 7. Infrastructure

| Table | Purpose |
|---|---|
| `outbox` | id, topic, payload jsonb, available_at, attempts, last_error, processed_at — reliable side effects |
| `idempotency_keys` | key, scope, request_hash, response jsonb, created_at — API idempotency |
| `rate_limits` (or Redis later) | key, window_start, count |
| `privacy_requests` | user_id, kind (`export`/`delete`/`rectify`), status, due_at, completed_at — Law 25 (30-day response) |

## 8. Entity relationships (summary)

```
users 1─* staff_memberships *─1 locations 1─* categories 1─* products *─* modifier_groups 1─* modifier_options
users 1─1 loyalty_accounts 1─* loyalty_entries          loyalty_accounts 1─* rewards 1─0..1 reward_redemptions
users 1─* orders 1─* order_lines 1─* order_line_modifiers
orders 1─* order_status_events · orders 1─* payments 1─* refunds · payment_events (inbox, by provider event id)
```
