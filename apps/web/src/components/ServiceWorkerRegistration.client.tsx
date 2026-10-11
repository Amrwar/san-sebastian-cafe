"use client";

import { useEffect } from "react";

/** Registers /sw.js in production builds only (it would interfere with development hot reload). */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // Registration failure only disables offline support; the app keeps working.
    });
  }, []);
  return null;
}
