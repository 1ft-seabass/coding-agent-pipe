/**
 * routes.js - Claude Code 固有の REST ルート
 *
 * GET /claude-version は claude CLI のバージョンを返す。claude に固有なので、adapter が登録する。
 */

import { spawn } from 'node:child_process';

function mountRoutes(api) {
  // GET /claude-version - Claude Code CLI バージョン情報
  // 子プロセスのイベントで結果が決まるので、Promise にして最初に決まった結果を返す
  api.get('/claude-version', (c) => {
    return new Promise((resolve) => {
      try {
        const proc = spawn('claude', ['-v']);
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        proc.on('close', (code) => {
          if (code !== 0) {
            console.error('[claude-code] Error getting claude version:', stderr);
            return resolve(c.json({
              error: 'Failed to get claude version',
              details: stderr
            }, 500));
          }

          // claude -v の出力をパース（"x.y.z (Claude Code)" 形式）
          const raw = stdout.trim();
          const versionMatch = raw.match(/^(\d+\.\d+\.\d+)/);
          const version = versionMatch ? versionMatch[1] : raw;

          resolve(c.json({
            version,
            raw
          }));
        });

        proc.on('error', (err) => {
          console.error('[claude-code] Failed to execute claude -v:', err);
          resolve(c.json({
            error: 'Failed to execute claude command',
            details: err.message
          }, 500));
        });
      } catch (error) {
        console.error('[claude-code] Error in /claude-version:', error);
        resolve(c.json({ error: 'Internal server error' }, 500));
      }
    });
  });
}

export { mountRoutes };
