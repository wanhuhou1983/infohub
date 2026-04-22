import { pgTable, serial, text, varchar, boolean, timestamp, jsonb, integer, index } from 'drizzle-orm/pg-core';

export const sources = pgTable('sources', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  type: varchar('type', { length: 20 }).notNull(),
  icon: varchar('icon', { length: 10 }).default(''),
  description: text('description'),
  config: jsonb('config').default({}),
  enabled: boolean('enabled').default(true),
  lastFetch: timestamp('last_fetch'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const articles = pgTable('articles', {
  id: serial('id').primaryKey(),
  sourceId: integer('source_id').references(() => sources.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  content: text('content'),
  summary: text('summary'),
  url: text('url'),
  author: varchar('author', { length: 100 }),
  publishedAt: timestamp('published_at'),
  fetchedAt: timestamp('fetched_at').defaultNow(),
  category: varchar('category', { length: 50 }),
  tags: text('tags').array().default([]),
  isRead: boolean('is_read').default(false),
  isStarred: boolean('is_starred').default(false),
  extra: jsonb('extra').default({}),
  contentHash: varchar('content_hash', { length: 32 }).unique().notNull(),
}, (table) => [
  index('idx_articles_source').on(table.sourceId),
  index('idx_articles_published').on(table.publishedAt),
  index('idx_articles_category').on(table.category),
  index('idx_articles_read').on(table.isRead),
  index('idx_articles_starred').on(table.isStarred),
]);

export const fetchLogs = pgTable('fetch_logs', {
  id: serial('id').primaryKey(),
  sourceId: integer('source_id').references(() => sources.id, { onDelete: 'set null' }),
  action: varchar('action', { length: 50 }).notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  articlesCount: integer('articles_count').default(0),
  detail: text('detail'),
  startedAt: timestamp('started_at').defaultNow(),
  durationMs: integer('duration_ms'),
});
