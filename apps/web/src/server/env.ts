import "server-only";
import { getServerEnv, type ServerEnv } from "@ssc/env";

/** Validated server environment. Throws (and the app refuses to start) on invalid config. */
export function env(): ServerEnv {
  return getServerEnv();
}
