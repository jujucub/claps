/**
 * claps - 内省エンジン
 * 作業履歴を分析し、ユーザーごとの振り返りとタスク提案を生成する
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  ReflectionConfig,
  ReflectionResult,
  UserReflection,
  TaskSuggestion,
  WorkHistoryRecord,
  UserIntent,
} from '../types/index.js';
import { GetHistoryStore } from '../history/store.js';
import { GetReflectionStore } from './store.js';
import { GetIntentStore } from './intent-store.js';
import { ExtractUserIntents } from './intent-extractor.js';
import { GetClaudeRunner } from '../claude/runner.js';
import { LoadCharacterPrompt } from '../character.js';
import { GetWorkspacePath } from '../git/repo.js';

// 内省処理中かどうかの参照（index.tsの_isProcessingを参照するために外部から注入）
let _isProcessingRef: () => boolean = () => false;

/**
 * 処理中フラグの参照を設定する
 */
export function SetProcessingRef(ref: () => boolean): void {
  _isProcessingRef = ref;
}

/**
 * 内省用プロンプトを構築する
 */
function BuildReflectionPrompt(
  userId: string,
  records: readonly WorkHistoryRecord[],
  repos: readonly string[],
  pendingSuggestions: readonly TaskSuggestion[] = [],
  userIntent?: UserIntent
): string {
  // 履歴のサマリーを構築
  const historyLines = records.map((record) => {
    const date = new Date(record.timestamp).toLocaleDateString('ja-JP');
    const status = record.result === 'success' ? '成功' : '失敗';
    const durationMin = Math.round(record.duration / 60000);
    const repoInfo = record.repo ? ` [${record.repo}]` : '';
    const issueInfo = record.issueNumber ? ` #${record.issueNumber}` : '';
    const prInfo = record.prUrl ? ` PR作成済み` : '';
    return `- ${date} | ${status} | ${durationMin}分${repoInfo}${issueInfo}${prInfo}\n  プロンプト: ${record.prompt}\n  結果: ${record.summary}`;
  });

  const reposList = repos.map((repo) => `  - ${repo}`).join('\n');

  // 保留中の提案セクション
  let pendingSection = '';
  if (pendingSuggestions.length > 0) {
    const pendingLines = pendingSuggestions.map(
      (s) => `- [${s.status}] ${s.title}: ${s.description} (優先度: ${s.priority})`
    );
    pendingSection = `
## 既に保留中の提案（重複しないようにしてください）
${pendingLines.join('\n')}

注意: 上記の提案はすでに保留中または実行中です。これらと同じ内容の提案は生成しないでください。
もし全ての提案が長期間pendingのまま放置されている場合は、より優先度の高い新しい提案や、既存の提案を統合した形での改善提案を検討してください。
`;
  }

  // インテントセクション
  let intentSection = '';
  if (userIntent) {
    const shortTermLines = userIntent.shortTermGoals
      .filter((g) => g.status === 'active')
      .map((g) => `- [${g.confidence}] ${g.description} (根拠: ${g.evidence.join(', ')})`);
    const longTermLines = userIntent.longTermGoals
      .filter((g) => g.status === 'active')
      .map((g) => `- [${g.confidence}] ${g.description} (根拠: ${g.evidence.join(', ')})`);

    if (shortTermLines.length > 0 || longTermLines.length > 0) {
      intentSection = `
## ユーザーのインテント（意図・目標）

### 短期ゴール（今週の戦術的作業）
${shortTermLines.length > 0 ? shortTermLines.join('\n') : '（検出なし）'}

### 長期ゴール（プロジェクト戦略）
${longTermLines.length > 0 ? longTermLines.join('\n') : '（検出なし）'}

`;
    }
  }

  return `以下のユーザーの作業履歴を分析し、日次内省レポートを生成してください。

## 対象ユーザー
Slack User ID: ${userId}

## 作業履歴（直近）
${historyLines.join('\n\n')}

## 監視対象リポジトリ
${reposList}
${pendingSection}${intentSection}
## 分析タスク

以下の観点で分析し、JSON形式で出力してください:

1. **作業パターンの発見**: どのような種類のタスクが多いか、成功率、平均所要時間
2. **改善提案**: 自動化できそうな作業、テストカバレッジ改善、リファクタリング候補など
3. **タスク提案**: 具体的に実行可能な改善タスクを1〜3件提案${userIntent ? '\n4. **インテントとの整合性**: 提案がユーザーの短期・長期ゴールにどう貢献するかを考慮してください\n5. **戦略的タスク提案**: ユーザーの長期ゴールに沿った戦略的なタスクを少なくとも1件含めてください' : ''}

## 出力フォーマット（厳密にこのJSON形式で出力してください）

\`\`\`json
{
  "summary": "このユーザーの作業パターンの要約（日本語、2-3文）",
  "patterns": ["パターン1", "パターン2"],
  "suggestions": [
    {
      "title": "提案タイトル",
      "description": "提案の詳細説明",
      "priority": "high|medium|low",
      "estimatedEffort": "見積もり時間（例: 1時間程度）",
      "relatedRepo": "owner/repo（関連リポジトリがあれば）"${userIntent ? ',\n      "alignedGoal": "この提案が貢献するユーザーゴールの説明（任意）"' : ''}
    }
  ]
}
\`\`\`

JSONのみを出力してください。JSONの前後に説明文は不要です。`;
}

/**
 * Claude出力からJSONをパースする
 */
function ParseReflectionOutput(output: string): {
  summary: string;
  patterns: readonly string[];
  suggestions: ReadonlyArray<{
    title: string;
    description: string;
    priority: 'high' | 'medium' | 'low';
    estimatedEffort: string;
    relatedRepo?: string;
  }>;
} | undefined {
  try {
    // コードブロック内のJSONを抽出
    const jsonMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : output.trim();

    if (!jsonStr) {
      return undefined;
    }

    const parsed = JSON.parse(jsonStr);

    // 型のバリデーション
    if (
      typeof parsed.summary !== 'string' ||
      !Array.isArray(parsed.patterns) ||
      !Array.isArray(parsed.suggestions)
    ) {
      console.error('Invalid reflection output structure');
      return undefined;
    }

    return parsed;
  } catch (error) {
    console.error('Failed to parse reflection output:', error);
    return undefined;
  }
}

/**
 * 処理中タスクの完了を待つ（最大5回、1分間隔）
 */
async function WaitForProcessingComplete(): Promise<boolean> {
  const MAX_RETRIES = 5;
  const WAIT_MS = 60000;

  for (let i = 0; i < MAX_RETRIES; i++) {
    if (!_isProcessingRef()) {
      return true;
    }
    console.log(`Reflection: Waiting for current task to complete (attempt ${i + 1}/${MAX_RETRIES})...`);
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  }

  return !_isProcessingRef();
}

/**
 * 内省を実行する
 */
export async function RunReflection(
  config: ReflectionConfig,
  repos: readonly string[],
  approvalServerPort: number
): Promise<ReflectionResult | undefined> {
  console.log('Reflection: Starting daily reflection...');

  // 処理中のタスクがあれば待機
  const canProceed = await WaitForProcessingComplete();
  if (!canProceed) {
    console.log('Reflection: Skipping - task processing still in progress after retries');
    return undefined;
  }

  const historyStore = GetHistoryStore();
  const reflectionStore = GetReflectionStore();
  const intentStore = GetIntentStore();
  const claudeRunner = GetClaudeRunner();

  // 前回の内省以降に新規会話がなければスキップ
  const latestReflection = reflectionStore.GetLatest();
  if (latestReflection) {
    const allActiveUsers = historyStore.GetActiveUsers(config.historyDays);
    const hasNewConversations = allActiveUsers.some((userId) => {
      const newRecords = historyStore.GetRecordsSince(userId, latestReflection.generatedAt);
      return newRecords.length > 0;
    });

    if (!hasNewConversations) {
      console.log('Reflection: Skipping - no new conversations since last reflection');
      return undefined;
    }
  }

  // アクティブユーザーを取得
  const activeUsers = historyStore.GetActiveUsers(config.historyDays);

  if (activeUsers.length === 0) {
    console.log('Reflection: No active users found, skipping');
    return undefined;
  }

  console.log(`Reflection: Found ${activeUsers.length} active user(s)`);

  const userReflections: UserReflection[] = [];

  // ユーザーごとに内省を実行
  for (const userId of activeUsers) {
    try {
      const records = historyStore.GetRecords(userId, config.historyDays, config.maxRecordsPerUser);

      if (records.length === 0) {
        continue;
      }

      console.log(`Reflection: Analyzing ${records.length} records for user ${userId}`);

      // Phase 1: インテント抽出・更新
      const existingIntent = intentStore.Get(userId);
      const workingDir = GetWorkspacePath();
      const userIntent = await ExtractUserIntents(
        userId,
        records,
        existingIntent,
        claudeRunner,
        workingDir,
        approvalServerPort
      );

      // インテントを保存（抽出成功時のみ）
      if (userIntent) {
        intentStore.Save(userIntent);
      }

      // 保留中の提案を取得
      const pendingSuggestions = reflectionStore.GetPendingSuggestions(userId);
      if (pendingSuggestions.length > 0) {
        console.log(`Reflection: Found ${pendingSuggestions.length} pending suggestion(s) for user ${userId}`);
      }

      // Phase 2: 内省プロンプトを構築（インテント + pending提案を反映）
      const prompt = BuildReflectionPrompt(userId, records, repos, pendingSuggestions, userIntent);

      // 内省専用のシステムプロンプト
      const systemPrompt = `${LoadCharacterPrompt()}

あなたは今、日次内省モードです。ユーザーの作業履歴を分析し、改善提案を生成してください。
出力は必ずJSON形式で行ってください。日本語で記述してください。`;

      // Claude CLIを実行
      const result = await claudeRunner.Run(`reflection-${userId}-${Date.now()}`, prompt, {
        workingDirectory: GetWorkspacePath(),
        systemPrompt,
        approvalServerPort,
      });

      if (!result.success) {
        console.error(`Reflection: Failed for user ${userId}: ${result.error}`);
        continue;
      }

      // 出力をパース
      const parsed = ParseReflectionOutput(result.output);
      if (!parsed) {
        console.error(`Reflection: Failed to parse output for user ${userId}`);
        continue;
      }

      // TaskSuggestionに変換（IDとステータスを付与）
      const suggestions: TaskSuggestion[] = parsed.suggestions.map((s) => ({
        id: uuidv4(),
        title: s.title,
        description: s.description,
        priority: s.priority,
        estimatedEffort: s.estimatedEffort,
        relatedRepo: s.relatedRepo,
        status: 'pending' as const,
      }));

      const userReflection: UserReflection = {
        userId,
        summary: parsed.summary,
        suggestions,
        patterns: parsed.patterns,
      };

      userReflections.push(userReflection);
    } catch (error) {
      console.error(`Reflection: Error processing user ${userId}:`, error);
    }
  }

  if (userReflections.length === 0) {
    console.log('Reflection: No reflections generated');
    return undefined;
  }

  // 内省結果を構築
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const reflectionResult: ReflectionResult = {
    date: dateStr,
    generatedAt: now.toISOString(),
    userReflections,
  };

  // 結果を保存
  reflectionStore.Save(reflectionResult);

  console.log(`Reflection: Completed with ${userReflections.length} user reflection(s)`);
  return reflectionResult;
}
