// Migration: preserve the native MemOS catalog baseline from catalog pruning.
// The published catalog is allowed to omit MemOS while its native provider is
// still routable, so these rows are owned by the bundled provider baseline.

import type { Db } from '../types.js';

const MODEL_IDS = ['deepseek-r1', 'qwen2.5-72b-instruct', 'qwen3-32b'] as const;

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memos_native_ownership_migration_rows (
      row_id INTEGER PRIMARY KEY,
      previous_source TEXT NOT NULL
    )
  `);
  const rows = db.prepare(`
    SELECT id, source
      FROM models
     WHERE platform = 'memos'
       AND model_id IN (${MODEL_IDS.map(() => '?').join(', ')})
       AND key_id IS NULL
       AND endpoint_scope = ''
       AND source = 'catalog'
  `).all(...MODEL_IDS) as { id: number; source: string }[];
  const record = db.prepare(`
    INSERT OR IGNORE INTO memos_native_ownership_migration_rows (row_id, previous_source)
    VALUES (?, ?)
  `);
  const markBuiltin = db.prepare("UPDATE models SET source = 'builtin' WHERE id = ?");
  db.transaction(() => {
    for (const row of rows) {
      record.run(row.id, row.source);
      markBuiltin.run(row.id);
    }
  })();
}

export function down(db: Db): void {
  db.transaction(() => {
    db.prepare(`
      UPDATE models
         SET source = (
           SELECT previous_source
             FROM memos_native_ownership_migration_rows r
            WHERE r.row_id = models.id
         )
       WHERE id IN (SELECT row_id FROM memos_native_ownership_migration_rows)
         AND source = 'builtin'
    `).run();
    db.exec('DROP TABLE memos_native_ownership_migration_rows');
  })();
}
