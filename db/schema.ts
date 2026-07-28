import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const publicAiUsage = sqliteTable(
  "public_ai_usage",
  {
    scope: text("scope").notNull(),
    bucket: text("bucket").notNull(),
    count: integer("count").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.bucket] })],
);
