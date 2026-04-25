-- InfoHub 数据库初始化脚本

-- 信息源
CREATE TABLE IF NOT EXISTS sources (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    type        VARCHAR(20)  NOT NULL,     -- xwlb / rss / wechat / magazine / news / web / aggregation / import
    icon        VARCHAR(10)  DEFAULT '',
    description TEXT,
    config      JSONB        DEFAULT '{}',
    enabled     BOOLEAN      DEFAULT TRUE,
    parent_id   INT          REFERENCES sources(id) ON DELETE CASCADE,
    last_fetch  TIMESTAMP,
    created_at  TIMESTAMP    DEFAULT NOW(),
    updated_at  TIMESTAMP    DEFAULT NOW()
);

-- 文章（统一表）
CREATE TABLE IF NOT EXISTS articles (
    id            SERIAL PRIMARY KEY,
    source_id     INT           REFERENCES sources(id) ON DELETE CASCADE,
    title         TEXT          NOT NULL,
    content       TEXT,
    summary       TEXT,
    url           TEXT,
    author        VARCHAR(100),
    published_at  TIMESTAMP,
    fetched_at    TIMESTAMP     DEFAULT NOW(),
    category      VARCHAR(50),
    tags          TEXT[]        DEFAULT '{}',
    is_read       BOOLEAN       DEFAULT FALSE,
    is_starred    BOOLEAN       DEFAULT FALSE,
    is_watch_later BOOLEAN      DEFAULT FALSE,
    extra         JSONB         DEFAULT '{}',
    content_hash  VARCHAR(32)   UNIQUE NOT NULL
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source_id);
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category);
CREATE INDEX IF NOT EXISTS idx_articles_read ON articles(is_read);
CREATE INDEX IF NOT EXISTS idx_articles_starred ON articles(is_starred);
CREATE INDEX IF NOT EXISTS idx_articles_watch_later ON articles(is_watch_later);
CREATE INDEX IF NOT EXISTS idx_articles_tags ON articles USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_articles_fts ON articles USING GIN(to_tsvector('simple', title || ' ' || COALESCE(content, '')));

-- 采集日志
CREATE TABLE IF NOT EXISTS fetch_logs (
    id          SERIAL PRIMARY KEY,
    source_id   INT           REFERENCES sources(id) ON DELETE SET NULL,
    action      VARCHAR(50)   NOT NULL,
    status      VARCHAR(20)   NOT NULL,    -- success / error / running
    articles_count INT        DEFAULT 0,
    detail      TEXT,
    started_at  TIMESTAMP     DEFAULT NOW(),
    duration_ms INT
);

-- 初始化顶级信息源
INSERT INTO sources (name, type, icon, description, config) VALUES
    ('新闻联播', 'xwlb', '📺', 'CCTV 官网每日文字稿', '{"schedule": "0 20 * * *", "source_url": "https://tv.cctv.com/lm/xwlb/day/"}'),
    ('RSS订阅', 'rss', '📡', 'Miniflux RSS 聚合', '{}'),
    ('微信公众号', 'wechat', '💬', '微信公众号文章', '{}'),
    ('报刊杂志', 'magazine', '📰', '报刊杂志精选', '{}')
ON CONFLICT DO NOTHING;

-- 初始化子信息源：财新周刊（报刊杂志下的子源）
INSERT INTO sources (name, type, icon, description, config, parent_id)
SELECT '财新周刊', 'magazine', '🗞️', '财新周刊深度报道',
       '{"schedule": "0 8 * * 1", "source_type": "caixin"}', s.id
FROM sources s WHERE s.type = 'magazine' AND s.parent_id IS NULL LIMIT 1
ON CONFLICT DO NOTHING;
