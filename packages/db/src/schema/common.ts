import { integer, text } from 'drizzle-orm/sqlite-core';

export const id = () => text('id').primaryKey();
export const tenantId = () => text('tenant_id').notNull();
export const timestamps = {
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
};
export const version = () => integer('version').notNull().default(1);
