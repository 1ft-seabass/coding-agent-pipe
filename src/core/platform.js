/**
 * platform.js - 実行環境(OS・ホームディレクトリ)に関する小さな補助関数
 */

import fs from 'node:fs';

/**
 * Windows (non-WSL) 環境かどうかを判定
 * @returns {boolean} true if Windows (non-WSL)
 */
function isWindowsNonWSL() {
  if (process.platform !== 'win32') {
    return false;
  }

  // WSL判定
  try {
    const procVersion = fs.readFileSync('/proc/version', 'utf8');
    return !procVersion.toLowerCase().includes('microsoft');
  } catch {
    // /proc/version が読めない = Windows native
    return true;
  }
}

/**
 * サーバーの OS 種別を返す
 * WSL は Node.js から "linux" に見えるため linux 扱い
 * @returns {"mac" | "linux" | "windows"}
 */
function getOsInfo() {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

/** 先頭の "~" をホームディレクトリに展開する */
function expandHome(p) {
  return p.replace(/^~/, process.env.HOME || '');
}

export { isWindowsNonWSL, getOsInfo, expandHome };
