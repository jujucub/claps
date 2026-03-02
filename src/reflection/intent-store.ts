/**
 * claps - インテントストア
 * ユーザーごとのインテント（意図・目標）を永続化する
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { UserIntent } from '../types/index.js';

// 保存ディレクトリ
const INTENTS_DIR = path.join(os.homedir(), '.claps', 'intents');

/**
 * ユーザーIDをサニタイズしてファイル名に使用する
 */
function SanitizeUserId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * インテントストアクラス
 */
export class IntentStore {
  /**
   * ユーザーのインテントを取得する
   */
  Get(userId: string): UserIntent | undefined {
    const filePath = path.join(INTENTS_DIR, `${SanitizeUserId(userId)}.json`);

    if (!fs.existsSync(filePath)) {
      return undefined;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as UserIntent;
    } catch (error) {
      console.error(`Failed to read intent for user ${userId}:`, error);
      return undefined;
    }
  }

  /**
   * ユーザーのインテントを保存する
   */
  Save(intent: UserIntent): void {
    try {
      if (!fs.existsSync(INTENTS_DIR)) {
        fs.mkdirSync(INTENTS_DIR, { recursive: true, mode: 0o700 });
      }

      const filePath = path.join(INTENTS_DIR, `${SanitizeUserId(intent.userId)}.json`);
      fs.writeFileSync(filePath, JSON.stringify(intent, null, 2), { mode: 0o600 });

      console.log(`Intent saved for user ${intent.userId}`);
    } catch (error) {
      console.error(`Failed to save intent for user ${intent.userId}:`, error);
    }
  }

  /**
   * 全ユーザーのインテントを取得する
   */
  GetAll(): readonly UserIntent[] {
    if (!fs.existsSync(INTENTS_DIR)) {
      return [];
    }

    const intents: UserIntent[] = [];

    try {
      const files = fs.readdirSync(INTENTS_DIR).filter((f) => f.endsWith('.json'));

      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(INTENTS_DIR, file), 'utf-8');
          intents.push(JSON.parse(content) as UserIntent);
        } catch {
          // 不正なファイルはスキップ
        }
      }
    } catch (error) {
      console.error('Failed to list intents:', error);
    }

    return intents;
  }
}

// シングルトンインスタンス
let _instance: IntentStore | undefined;

/**
 * インテントストアのシングルトンインスタンスを取得する
 */
export function GetIntentStore(): IntentStore {
  if (!_instance) {
    _instance = new IntentStore();
  }
  return _instance;
}
