/**
 * file-tail.js - ファイル追記の監視（chokidar）
 *
 * chokidar で watchDir 配下の指定拡張子のファイルを監視し、
 * 新しい行が追加されたら adapter の parse でパースして message イベントを発火する。
 * どのファイルを・どう解釈するかは adapter(observe / parse / sessionIdFromPath)が決める。
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import chokidar from 'chokidar';
import { expandHome } from '../platform.js';

/** watchDir が存在しないとき、現れるのを待つ確認の間隔(ミリ秒) */
const WAIT_INTERVAL_MS = 5000;

class FileTailSource extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.watchDir - 監視対象ディレクトリ
   * @param {string} options.extension - 監視するファイルの拡張子(例: '.jsonl')
   * @param {(line: string) => object|null} options.parse - 1行を正規化イベントに変換する
   * @param {(filePath: string) => string|null} [options.sessionIdFromPath] - sessionId が無い行の補完用
   * @param {number} [options.waitIntervalMs] - watchDir が存在しないとき、現れるのを待つ確認の間隔(既定 5000)
   */
  constructor({ watchDir, extension, parse, sessionIdFromPath, waitIntervalMs }) {
    super();
    this.watchDir = expandHome(watchDir);
    this.extension = extension;
    this.parse = parse;
    this.sessionIdFromPath = sessionIdFromPath || (() => null);
    this.filePositions = new Map(); // ファイルパス → 最終読み込み位置
    this.waitIntervalMs = waitIntervalMs || WAIT_INTERVAL_MS;
    this.waitTimer = null;
    this.watcher = null;
  }

  /**
   * ファイルの末尾位置を記録（起動時の初期化用）
   */
  async recordCurrentPosition(filePath) {
    try {
      const stats = await fs.promises.stat(filePath);
      this.filePositions.set(filePath, stats.size);
    } catch (error) {
      console.error(`[watcher] Failed to stat file ${filePath}:`, error.message);
    }
  }

  /**
   * ファイルの追記部分を読み取ってパース
   */
  async processNewLines(filePath) {
    try {
      const stats = await fs.promises.stat(filePath);
      const currentSize = stats.size;
      const lastPosition = this.filePositions.get(filePath) || 0;

      if (currentSize <= lastPosition) {
        // ファイルサイズが変わっていないか、縮小している場合はスキップ
        return;
      }

      // 追記部分を読み取る
      const stream = fs.createReadStream(filePath, {
        start: lastPosition,
        end: currentSize - 1,
        encoding: 'utf8'
      });

      let buffer = '';

      stream.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        // 最後の要素は不完全な行の可能性があるので保持
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          const event = this.parse(line);
          if (event) {
            // sessionId をファイルパスから推定して補完
            if (!event.sessionId) {
              event.sessionId = this.sessionIdFromPath(filePath);
            }
            // イベントの出どころ(ファイルパス)を追加
            event.sourcePath = filePath;
            this.emit('message', event);
          }
        }
      });

      stream.on('end', () => {
        // 最後に残ったバッファも処理（改行なしで終わる場合）
        if (buffer.trim()) {
          const event = this.parse(buffer);
          if (event) {
            if (!event.sessionId) {
              event.sessionId = this.sessionIdFromPath(filePath);
            }
            // イベントの出どころ(ファイルパス)を追加
            event.sourcePath = filePath;
            this.emit('message', event);
          }
        }
        // 読み込み位置を更新
        this.filePositions.set(filePath, currentSize);
      });

      stream.on('error', (error) => {
        console.error(`[watcher] Error reading file ${filePath}:`, error.message);
      });

    } catch (error) {
      console.error(`[watcher] Failed to process file ${filePath}:`, error.message);
    }
  }

  /**
   * 監視を開始
   */
  async start() {
    console.log(`[watcher] Starting to watch: ${this.watchDir}`);

    // watchDir が存在しない場合は、作らない(タイプミスで余計なディレクトリができるため)。警告を 1 回出して、現れるのを待つ
    // (chokidar は、存在しないディレクトリの下を監視しても、あとからできたものを拾えないので、現れてから監視を始める)
    if (!fs.existsSync(this.watchDir)) {
      console.warn(`[watcher] Watch directory does not exist: ${this.watchDir} (not creating it; waiting for it to appear)`);
      this.waitTimer = setInterval(() => {
        if (!fs.existsSync(this.watchDir)) return;
        clearInterval(this.waitTimer);
        this.waitTimer = null;
        console.log(`[watcher] Watch directory appeared: ${this.watchDir}`);
        // 起動後にできたものなので、中のファイルは新規として、先頭から読む
        this.beginWatching({ readExistingFromStart: true }).catch((error) => {
          console.error('[watcher] Failed to start watching:', error.message);
        });
      }, this.waitIntervalMs);
      this.waitTimer.unref();
      return;
    }

    await this.beginWatching({ readExistingFromStart: false });
  }

  /**
   * chokidar での監視を始める(watchDir が存在するとき)
   * @param {object} options
   * @param {boolean} options.readExistingFromStart - 既存のファイルも先頭から読む(起動後に watchDir ができたとき)。
   *   false なら、既存のファイルの末尾位置を記録して、過去ログは読まない
   */
  async beginWatching({ readExistingFromStart }) {
    if (!readExistingFromStart) {
      // 既存ファイルの末尾位置を記録（過去ログは読まない）
      const existingFiles = await this.findExistingFiles();
      for (const file of existingFiles) {
        await this.recordCurrentPosition(file);
      }
    }

    // chokidar で監視開始
    this.watcher = chokidar.watch(path.join(this.watchDir, `**/*${this.extension}`), {
      persistent: true,
      ignoreInitial: false, // 既存ファイルも検出する
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50
      }
    });

    this.watcher.on('add', async (filePath) => {
      console.log(`[watcher] File added: ${filePath}`);
      if (this.filePositions.has(filePath)) {
        // 既存ファイル（start() で既にポジション記録済み）→ スキップ
        return;
      }
      // watcher 起動後に新規作成されたファイル → 先頭から読む
      this.filePositions.set(filePath, 0);
      await this.processNewLines(filePath);
    });

    this.watcher.on('change', async (filePath) => {
      console.log(`[watcher] File changed: ${filePath}`);
      await this.processNewLines(filePath);
    });

    this.watcher.on('error', (error) => {
      console.error('[watcher] Watcher error:', error);
    });

    console.log('[watcher] Watching started');
  }

  /**
   * 既存のファイルを検索
   */
  async findExistingFiles() {
    const files = [];

    const extension = this.extension;

    async function walk(dir) {
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(fullPath);
          } else if (entry.isFile() && entry.name.endsWith(extension)) {
            files.push(fullPath);
          }
        }
      } catch (error) {
        // ディレクトリが存在しない等のエラーは無視
      }
    }

    await walk(this.watchDir);
    return files;
  }

  /**
   * 監視を停止
   */
  async stop() {
    if (this.waitTimer) {
      clearInterval(this.waitTimer);
      this.waitTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      console.log('[watcher] Watching stopped');
    }
  }
}

export default FileTailSource;
