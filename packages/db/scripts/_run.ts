import { getServerEnv } from "@ssc/env";
import { createDb, type Database } from "../src/index";

/** Runs a maintenance task against DATABASE_URL with validated env and a clean exit code. */
export async function run(name: string, task: (db: Database, appEnv: string) => Promise<string>) {
  const env = getServerEnv();
  const { db, close } = createDb(env.DATABASE_URL, { max: 1 });
  try {
    const message = await task(db, env.APP_ENV);
    console.log(`[db:${name}] ${message}`);
  } catch (error) {
    console.error(`[db:${name}] failed:`, error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await close();
  }
}
