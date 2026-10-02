// Migration: seed the MemOS catalog models
// Created: 2026-10-02
//
// DOWN: reversible

import type { Db } from '../types.js';
import { ensureModelInProfiles } from '../../services/profile-models.js';

const MODELS = [
  ['deepseek-r1', 'DeepSeek R1'],
  ['qwen2.5-72b-instruct', 'Qwen2.5 72B Instruct'],
  ['qwen3-32b', 'Qwen3 32B'],
] as const;

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memos_models_migration_rows (
      row_type TEXT NOT NULL,
      row_id INTEGER NOT NULL,
      PRIMARY KEY (row_type, row_id)
    )
  `);
  const insertModel = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, supports_vision, supports_tools, key_id, source, endpoint_scope
    ) VALUES (?, ?, ?, 50, 50, 'Medium', NULL, NULL, NULL, NULL, '', NULL, 1, 0, 1, NULL, 'builtin', '')
  `);
  const findModel = db.prepare(`
    SELECT id FROM models
     WHERE platform = 'memos' AND model_id = ? AND source = 'builtin'
       AND key_id IS NULL AND endpoint_scope = ''
  `);
  const insertFallback = db.prepare(
    'INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)',
  );

  db.transaction(() => {
    const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS value FROM fallback_config').get() as { value: number }).value;
    MODELS.forEach(([modelId, displayName], index) => {
      const modelInsert = insertModel.run('memos', modelId, displayName);
      if (modelInsert.changes === 1) {
        db.prepare(`
          INSERT INTO memos_models_migration_rows (row_type, row_id)
          VALUES ('model', ?)
        `).run(modelInsert.lastInsertRowid);
      }
      const model = findModel.get(modelId) as { id: number } | undefined;
      if (model) {
        const fallbackInsert = insertFallback.run(model.id, maxPriority + index + 1);
        if (fallbackInsert.changes === 1) {
          db.prepare(`
            INSERT INTO memos_models_migration_rows (row_type, row_id)
            VALUES ('fallback', ?)
          `).run(fallbackInsert.lastInsertRowid);
        }
        const before = new Set((db.prepare(
          'SELECT id FROM profile_models WHERE model_db_id = ?',
        ).all(model.id) as { id: number }[]).map(row => row.id));
        ensureModelInProfiles(db, model.id);
        const profileRows = db.prepare(
          'SELECT id FROM profile_models WHERE model_db_id = ?',
        ).all(model.id) as { id: number }[];
        const recordProfileRow = db.prepare(`
          INSERT INTO memos_models_migration_rows (row_type, row_id)
          VALUES ('profile_model', ?)
        `);
        for (const row of profileRows) {
          if (!before.has(row.id)) recordProfileRow.run(row.id);
        }
      }
    });
  })();
}

export function down(db: Db): void {
  db.transaction(() => {
    // Older executions of this migration did not create the ownership table;
    // in that case there are no rows this rollback can safely claim.
    db.exec(`
      CREATE TABLE IF NOT EXISTS memos_models_migration_rows (
        row_type TEXT NOT NULL,
        row_id INTEGER NOT NULL,
        PRIMARY KEY (row_type, row_id)
      )
    `);
    db.prepare(`
      DELETE FROM profile_models
       WHERE id IN (
         SELECT row_id FROM memos_models_migration_rows WHERE row_type = 'profile_model'
       )
    `).run();
    db.prepare(`
      DELETE FROM fallback_config
       WHERE id IN (
         SELECT row_id FROM memos_models_migration_rows WHERE row_type = 'fallback'
       )
    `).run();
    db.prepare(`
      DELETE FROM models
       WHERE id IN (
         SELECT row_id FROM memos_models_migration_rows WHERE row_type = 'model'
       )
    `).run();
    db.exec('DROP TABLE memos_models_migration_rows');
  })();
}
