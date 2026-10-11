"use client";

import { Button } from "@ssc/ui";
import { cart } from "@/lib/cart";
import { setCartExtras } from "@/lib/cart-extras";

/**
 * Submit button for the sign-out form. Clears this device's cart first so the next person on a
 * shared device doesn't inherit it (the account keeps its own copy).
 */
export function SignOutButton({ label }: { label: string }) {
  return (
    <Button
      type="submit"
      variant="secondary"
      onClick={() => {
        cart.clear();
        setCartExtras({ promoCode: "", useReward: false });
      }}
    >
      {label}
    </Button>
  );
}
