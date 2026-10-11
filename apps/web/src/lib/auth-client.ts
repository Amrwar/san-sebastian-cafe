"use client";

import { emailOTPClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/** Browser auth client. Calls the same-origin /api/auth endpoints (rate-limited server-side). */
export const authClient = createAuthClient({ plugins: [emailOTPClient()] });
