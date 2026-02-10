/**
 * sumomo - 作業履歴ストア
 * JSONL形式で作業履歴を永続化する
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { WorkHistoryRecord } from '../types/index.js';

// 履歴保存ディレクトリ
const HISTORY_BASE_DIR = path.join(os.homedir(), '.sumomo', 'history');

/**
 * 日付文字列（YYYY-MM-DD）を取得する
 */
function FormatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * ユーザーの履歴ディレクトリパスを取得する
 */
function GetUserDir(userId: string): string {
  // ユーザーIDをサニタイズ（ディレクトリトラバーサル防止）
  const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(HISTORY_BASE_DIR, safeUserId);
}

/**
 * 作業履歴ストアクラス
 */
export class HistoryStore {
  /**
   * 作業履歴レコードを追記する
   */
  Append(record: WorkHistoryRecord): void {
    const userDir = GetUserDir(record.userId);
    const dateStr = FormatDate(new Date(record.timestamp));
    const filePath = path.join(userDir, `${dateStr}.jsonl`);

    try {
      // ディレクトリがなければ作成
      if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
      }

      // JSONL形式で追記
      const line = JSON.stringify(record) + '\n';
      fs.appendFileSync(filePath, line, { mode: 0o600 });

      console.log(`History recorded: ${record.id} for user ${record.userId}`);
    } catch (error) {
      console.error('Failed to append history record:', error);
    }
  }

  /**
   * ユーザーの履歴レコードを取得する
   */
  GetRecords(userId: string, days: number, maxRecords: number = 50): readonly WorkHistoryRecord[] {
    const userDir = GetUserDir(userId);

    if (!fs.existsSync(userDir)) {
      return [];
    }

    const records: WorkHistoryRecord[] = [];
    const now = new Date();

    // 指定日数分のファイルを読み込む
    for (let i = 0; i < days; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dateStr = FormatDate(date);
      const filePath = path.join(userDir, `${dateStr}.jsonl`);

      if (!fs.existsSync(filePath)) {
        continue;
      }

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter((line) => line.trim() !== '');

        for (const line of lines) {
          try {
            const record = JSON.parse(line) as WorkHistoryRecord;
            records.push(record);
          } catch {
            // 不正なJSONL行はスキップ
            console.warn(`Skipping invalid JSONL line in ${filePath}`);
          }
        }
      } catch (error) {
        console.error(`Failed to read history file ${filePath}:`, error);
      }
    }

    // タイムスタンプの降順でソートし、上限を適用
    const sorted = records.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    return sorted.slice(0, maxRecords);
  }

  /**
   * 指定日数内にアクティブだったユーザーIDの一覧を取得する
   */
  GetActiveUsers(days: number): readonly string[] {
    if (!fs.existsSync(HISTORY_BASE_DIR)) {
      return [];
    }

    const activeUsers: Set<string> = new Set();
    const now = new Date();

    // 対象日付のセットを作成
    const targetDates: Set<string> = new Set();
    for (let i = 0; i < days; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      targetDates.add(FormatDate(date));
    }

    try {
      const userDirs = fs.readdirSync(HISTORY_BASE_DIR);

      for (const userDir of userDirs) {
        const userPath = path.join(HISTORY_BASE_DIR, userDir);

        // ディレクトリでなければスキップ
        if (!fs.statSync(userPath).isDirectory()) {
          continue;
        }

        // 対象日付のファイルが存在するかチェック
        try {
          const files = fs.readdirSync(userPath);
          for (const file of files) {
            const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
            if (dateMatch && targetDates.has(dateMatch[1] as string)) {
              activeUsers.add(userDir);
              break;
            }
          }
        } catch {
          // ディレクトリの読み込みに失敗した場合はスキップ
        }
      }
    } catch (error) {
      console.error('Failed to list active users:', error);
    }

    return Array.from(activeUsers);
  }
}

// シングルトンインスタンス
let _instance: HistoryStore | undefined;

/**
 * 作業履歴ストアのシングルトンインスタンスを取得する
 */
export function GetHistoryStore(): HistoryStore {
  if (!_instance) {
    _instance = new HistoryStore();
  }
  return _instance;
}
