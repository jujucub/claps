/**
 * sumomo - 内省結果ストア
 * 内省結果と提案の状態を永続化する
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ReflectionResult, TaskSuggestion } from '../types/index.js';

// 保存ディレクトリ
const REFLECTIONS_DIR = path.join(os.homedir(), '.sumomo', 'reflections');

/**
 * 内省結果ストアクラス
 */
export class ReflectionStore {
  /**
   * 内省結果を保存する
   */
  Save(result: ReflectionResult): void {
    try {
      if (!fs.existsSync(REFLECTIONS_DIR)) {
        fs.mkdirSync(REFLECTIONS_DIR, { recursive: true, mode: 0o700 });
      }

      const filePath = path.join(REFLECTIONS_DIR, `${result.date}.json`);
      fs.writeFileSync(filePath, JSON.stringify(result, null, 2), { mode: 0o600 });

      console.log(`Reflection saved: ${result.date}`);
    } catch (error) {
      console.error('Failed to save reflection result:', error);
    }
  }

  /**
   * 最新の内省結果を取得する
   */
  GetLatest(): ReflectionResult | undefined {
    if (!fs.existsSync(REFLECTIONS_DIR)) {
      return undefined;
    }

    try {
      const files = fs.readdirSync(REFLECTIONS_DIR)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse();

      if (files.length === 0) {
        return undefined;
      }

      const latestFile = files[0] as string;
      const filePath = path.join(REFLECTIONS_DIR, latestFile);
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as ReflectionResult;
    } catch (error) {
      console.error('Failed to read latest reflection:', error);
      return undefined;
    }
  }

  /**
   * 指定日の内省結果を取得する
   */
  GetByDate(date: string): ReflectionResult | undefined {
    const filePath = path.join(REFLECTIONS_DIR, `${date}.json`);

    if (!fs.existsSync(filePath)) {
      return undefined;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as ReflectionResult;
    } catch (error) {
      console.error(`Failed to read reflection for ${date}:`, error);
      return undefined;
    }
  }

  /**
   * 提案のステータスを更新する
   */
  UpdateSuggestionStatus(
    suggestionId: string,
    status: TaskSuggestion['status'],
    approvedBy?: string
  ): boolean {
    // 最新の内省結果から該当する提案を検索
    const latest = this.GetLatest();
    if (!latest) {
      return false;
    }

    let found = false;
    const updatedReflections = latest.userReflections.map((reflection) => {
      const updatedSuggestions = reflection.suggestions.map((suggestion) => {
        if (suggestion.id === suggestionId) {
          found = true;
          return {
            ...suggestion,
            status,
            approvedBy: approvedBy ?? suggestion.approvedBy,
            approvedAt: status === 'approved' ? new Date().toISOString() : suggestion.approvedAt,
          };
        }
        return suggestion;
      });

      return {
        ...reflection,
        suggestions: updatedSuggestions,
      };
    });

    if (!found) {
      return false;
    }

    const updatedResult: ReflectionResult = {
      ...latest,
      userReflections: updatedReflections,
    };

    this.Save(updatedResult);
    return true;
  }

  /**
   * IDで提案を取得する
   */
  GetSuggestion(suggestionId: string): { suggestion: TaskSuggestion; userId: string } | undefined {
    const latest = this.GetLatest();
    if (!latest) {
      return undefined;
    }

    for (const reflection of latest.userReflections) {
      for (const suggestion of reflection.suggestions) {
        if (suggestion.id === suggestionId) {
          return { suggestion, userId: reflection.userId };
        }
      }
    }

    return undefined;
  }
}

// シングルトンインスタンス
let _instance: ReflectionStore | undefined;

/**
 * 内省結果ストアのシングルトンインスタンスを取得する
 */
export function GetReflectionStore(): ReflectionStore {
  if (!_instance) {
    _instance = new ReflectionStore();
  }
  return _instance;
}
