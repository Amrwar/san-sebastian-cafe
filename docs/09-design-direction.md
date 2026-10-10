# 09 — Design Direction

_Status: Proposed for Phase 2 · inputs: owner palette + two reference mobile concepts (2026-10-10)_

## 1. Palette & roles

| Token | Hex | Role |
|---|---|---|
| `--color-ivory` | `#F6F0E6` | Main background |
| `--color-espresso` | `#38251F` | Primary text, dark surfaces (hero, product header, staff console header) |
| `--color-burgundy` | `#772F3B` | Brand accent, primary buttons, links, selected states |
| `--color-crema` | `#D7B77A` ⚠ | Rewards, stamps, highlights. **Confirm the hex:** the second message listed `#38251F`. |

Derived tokens are generated in Phase 2 (tints/shades for surfaces, borders, hover/pressed, focus ring, success/warning/danger tuned to the palette) and dark-surface variants.

### Contrast (computed, WCAG 2.x)
| Pair | Ratio | Use |
|---|---|---|
| Espresso on Ivory | ≈ 12.8 : 1 | Body text ✔ |
| Burgundy on Ivory | ≈ 8.2 : 1 | Links, accent text, button fill with ivory label ✔ |
| Crema on Espresso | ≈ 7.5 : 1 | Reward text on dark surfaces ✔ |
| Crema on Ivory | ≈ 1.7 : 1 | ✘ **Never for text or essential icons on ivory.** Decorative fills, stamp graphics with an espresso outline, and highlights only. |

## 2. What we take from the reference concepts

- **Editorial serif display type** for headlines and product names, paired with a clean humanist sans for UI. Candidates to be evaluated in Phase 2 for French diacritics, weights and licensing: a high-contrast serif (e.g. Newsreader, Cormorant, Gloock, or a licensed face if the café has one) with a sans (e.g. Inter Tight, Manrope, Figtree).
- **Dark, photo-led headers.** A full-bleed product photo transitions into an espresso panel with the name and price. This gives a premium feel and lets real photography carry the brand.
- **Chip/segmented selectors** for size, temperature, milk and syrup. These are fast, thumb-friendly and suit drink customization well.
- **Sticky bottom action bar** on the product page: quantity stepper, live server-quoted price, and an "Add to order" primary action.
- **Horizontal category rails** on mobile, which become a multi-column grid on tablet and desktop.
- **Personal greeting and quick actions** for signed-in users ("Your usual", stamp progress).

## 3. Where we diverge, and why

| Reference element | Our approach | Reason |
|---|---|---|
| Very large corner radii on everything, cards inside rounded frames | Restrained radius scale (4 / 8 / 14 px). Pills only for chips and buttons. Photography can be square-cropped and editorial. | Brief: avoid excessive rounded cards; aim for a premium brand look rather than a template |
| Heavy brown gradients | Gradients only as **photo scrims** for text legibility. Otherwise flat colour planes. | Brief: avoid excessive gradients |
| Star ratings (4.3, 4.8) | **Omitted.** No review system exists and none will be invented. | Don't fabricate data |
| "Volume 160 mL" | Shown only if the owner supplies sizes or volumes | Don't invent menu facts |
| "Buy now" on each product | "Add to order" + cart. Express "Reorder" for favourites. | Café orders are multi-item |
| White label on tan buttons | Ivory on burgundy (8.2:1) | Tan with white fails contrast |
| Location header ("Los Vegas") | Pickup location and time chip ("Pickup · ASAP ~10 min") | More useful information |
| Emoji-like category icons | A custom line-icon set (1.5 px stroke) or Lucide, consistent sizes | Brief: no emoji as primary icons |

The reference concepts are third-party work. They're used for mood only. Layouts, compositions and assets will be original (Risk R18).

## 4. Key screens (Phase 2–8)

1. **Menu home:** greeting and stamp progress (crema stamps on an espresso card), pickup chip, search, category rail, featured editorial row, then product grid.
2. **Product:** photo header → espresso info panel (name, short description, allergens link) → modifier sections (size chips, hot/iced segmented control, milk, syrups with quantity, shots, extras) → sticky add bar.
3. **Cart & checkout:** line items with edit, pickup time selector, reward toggle ("Use a free drink"), tip (equal-weight options on the pre-tax amount), price breakdown (GST/QST shown separately), then pay.
4. **Order tracking:** large status timeline, order number, pickup name, live updates, "add to home screen for alerts" prompt.
5. **Rewards:** stamp card (5 stamps), wallet of free drinks, history ledger.
6. **Staff queue (tablet, landscape):** columns for New / In preparation / Ready, oversized cards with modifiers in bold, one-tap actions, high-contrast mode.
7. **Admin:** quiet, dense, data-first layout. Same tokens with neutral surfaces, so it stays readable rather than decorative.

## 5. Motion & detail
- 150–250 ms ease-out transitions. Respect `prefers-reduced-motion`.
- A subtle stamp "press" animation when a stamp is earned. Skeletons rather than spinners for content.
- Soft single-layer shadows with low opacity espresso tint (no stacked blur shadows).
- French text expansion: design for ~30% longer labels. Buttons wrap rather than truncate.
