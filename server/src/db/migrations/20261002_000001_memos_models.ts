// Migration: seed the MemOS catalog models
// Created: 2026-10-02
//
// DOWN: reversible

import type { Db } from '../types.js';

const MODELS = [
  ['deepseek-r1', 'DeepSeek R1'],
  ['qwen2.5-72b-instruct', 'Qwen2.5 72B Instruct'],
  ['qwen3-32b', 'Qwen3 32B'],
] as const;

export function up(db: Db): void {
  const insertModel = db.prepare(`
    INSERT OR IGNORE INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
      enabled, supports_vision, supports_tools, key_id, source, endpoint_scope
    ) VALUES (?, ?, ?, 50, 50, 'Medium', NULL, NULL, NULL, NULL, '', NULL, 1, 0, 1, NULL, 'catalog', '')
  `);
  const findModel = db.prepare(`
    SELECT id FROM models
     WHERE platform = 'memos' AND model_id = ? AND source = 'catalog' AND key_id IS NULL
  `);
  const insertFallback = db.prepare(
    'INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)',
  );

  db.transaction(() => {
    const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS value FROM fallback_config').get() as { value: number }).value;
    MODELS.forEach(([modelId, displayName], index) => {
      insertModel.run('memos', modelId, displayName);
      const model = findModel.get(modelId) as { id: number } | undefined;
      if (model) insertFallback.run(model.id, maxPriority + index + 1);
    });
  })();
}

export function down(db: Db): void {
  db.transaction(() => {
    db.prepare(`
      DELETE FROM fallback_config
       WHERE model_db_id IN (
         SELECT id FROM models
          WHERE platform = 'memos' AND source = 'catalog' AND key_id IS NULL
            AND model_id IN ('deepseek-r1', 'qwen2.5-72b-instruct', 'qwen3-32b')
       )
    `).run();
    db.prepare(`
      DELETE FROM models
       WHERE platform = 'memos' AND source = 'catalog' AND key_id IS NULL
         AND model_id IN ('deepseek-r1', 'qwen2.5-72b-instruct', 'qwen3-32b')
    `).run();
  })();
}
