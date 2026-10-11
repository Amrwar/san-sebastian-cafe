/** Runs once when a server instance starts: fail fast on invalid configuration. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getServerEnv } = await import("@ssc/env");
    getServerEnv();
  }
}
