import { boolean, timestamp } from "drizzle-orm/pg-core";

export const timestamps = {
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/**
 * Marks development seed records. Demo rows are shown with a visible "Demo" label in the UI and
 * are removed by `npm run db:purge-demo`. Real business data must always have is_demo = false.
 */
export const demoFlag = { isDemo: boolean().notNull().default(false) };
