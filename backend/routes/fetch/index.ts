// @ts-nocheck
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { createXwlbRoutes } from './xwlb.js';
import { createRssRoutes } from './rss.js';
import { createWechatRoutes } from './wechat.js';
import { createRmrbRoutes } from './rmrb.js';
import { createAiNewsRoutes } from './ai-news.js';
import { createPentiRoutes } from './penti.js';
import { createTranscribeRoutes } from '../../services/transcribe.js';

export function createFetchRoutes(sql: Sql): Hono {
  const router = new Hono();
  router.route('/', createXwlbRoutes(sql));
  router.route('/', createRssRoutes(sql));
  router.route('/', createWechatRoutes(sql));
  router.route('/', createRmrbRoutes(sql));
  router.route('/', createAiNewsRoutes(sql));
  router.route('/', createPentiRoutes(sql));
  router.route('/', createTranscribeRoutes(sql));
  return router;
}
