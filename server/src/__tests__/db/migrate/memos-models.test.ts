import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { up, down } from '../../../db/migrations/20261002_000001_memos_models.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL, model_id TEXT NOT NULL, display_name TEXT NOT NULL,
      intelligence_rank INTEGER NOT NULL, speed_rank INTEGER NOT NULL,
      size_label TEXT NOT NULL DEFAULT '', rpm_limit INTEGER, rpd_limit INTEGER,
      tpm_limit INTEGER, tpd_limit INTEGER, monthly_token_budget TEXT NOT NULL DEFAULT '',
      context_window INTEGER, enabled INTEGER NOT NULL DEFAULT 1,
      supports_vision INTEGER NOT NULL DEFAULT 0, key_id INTEGER,
      supports_tools INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'catalog',
      endpoint_scope TEXT NOT NULL DEFAULT '', UNIQUE(platform, model_id, endpoint_scope)
    );
    CREATE TABLE fallback_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_db_id INTEGER NOT NULL REFERENCES models(id),
      priority INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(model_db_id)
    );
    INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label
    ) VALUES ('other', 'existing', 'Existing', 1, 1, 'Large');
    INSERT INTO fallback_config (model_db_id, priority) VALUES (1, 1);
  `);
  return db;
}

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

describe('MemOS catalog models migration', () => {
  it('seeds exactly the requested models and fallback rows', () => {
    const db = makeDb();
    dbs.push(db);
    up(db);

    expect(db.prepare(`
      SELECT model_id, display_name, enabled, supports_vision, supports_tools,
             key_id, source, intelligence_rank, speed_rank, size_label,
             monthly_token_budget, context_window
        FROM models WHERE platform = 'memos' ORDER BY id
    `).all()).toEqual([
      { model_id: 'deepseek-r1', display_name: 'DeepSeek R1', enabled: 1, supports_vision: 0, supports_tools: 1, key_id: null, source: 'catalog', intelligence_rank: 50, speed_rank: 50, size_label: 'Medium', monthly_token_budget: '', context_window: null },
      { model_id: 'qwen2.5-72b-instruct', display_name: 'Qwen2.5 72B Instruct', enabled: 1, supports_vision: 0, supports_tools: 1, key_id: null, source: 'catalog', intelligence_rank: 50, speed_rank: 50, size_label: 'Medium', monthly_token_budget: '', context_window: null },
      { model_id: 'qwen3-32b', display_name: 'Qwen3 32B', enabled: 1, supports_vision: 0, supports_tools: 1, key_id: null, source: 'catalog', intelligence_rank: 50, speed_rank: 50, size_label: 'Medium', monthly_token_budget: '', context_window: null },
    ]);
    expect(db.prepare(`
      SELECT f.priority, f.enabled FROM fallback_config f
      JOIN models m ON m.id = f.model_db_id WHERE m.platform = 'memos' ORDER BY f.priority
    `).all()).toEqual([
      { priority: 2, enabled: 1 }, { priority: 3, enabled: 1 }, { priority: 4, enabled: 1 },
    ]);
  });

  it('is idempotent and down removes only catalog-owned MemOS rows', () => {
    const db = makeDb();
    dbs.push(db);
    up(db);
    up(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM models WHERE platform = 'memos'").get()).toEqual({ n: 3 });
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, key_id, source, endpoint_scope) VALUES ('memos', 'deepseek-r1', 'User row', 1, 1, 9, 'user', 'user-endpoint')").run();
    down(db);
    expect(db.prepare("SELECT platform, model_id, source FROM models ORDER BY id").all()).toEqual([
      { platform: 'other', model_id: 'existing', source: 'catalog' },
      { platform: 'memos', model_id: 'deepseek-r1', source: 'user' },
    ]);
  });

  it('preserves pre-existing catalog rows and custom endpoint scopes on down', () => {
    const db = makeDb();
    dbs.push(db);
    db.prepare(`
      INSERT INTO models (
        platform, model_id, display_name, intelligence_rank, speed_rank,
        key_id, source, endpoint_scope
      ) VALUES
        ('memos', 'deepseek-r1', 'Existing default', 1, 1, NULL, 'catalog', ''),
        ('memos', 'deepseek-r1', 'Existing custom', 1, 1, NULL, 'catalog', 'custom-endpoint')
    `).run();

    up(db);
    down(db);

    expect(db.prepare(`
      SELECT model_id, display_name, source, endpoint_scope
        FROM models
       WHERE platform = 'memos'
       ORDER BY endpoint_scope
    `).all()).toEqual([
      { model_id: 'deepseek-r1', display_name: 'Existing default', source: 'catalog', endpoint_scope: '' },
      { model_id: 'deepseek-r1', display_name: 'Existing custom', source: 'catalog', endpoint_scope: 'custom-endpoint' },
    ]);
    expect(db.prepare(`
      SELECT COUNT(*) AS count
        FROM fallback_config f
        JOIN models m ON m.id = f.model_db_id
       WHERE m.platform = 'memos'
    `).get()).toEqual({ count: 0 });
  });
});
