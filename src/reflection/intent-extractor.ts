/**
 * claps - インテント抽出
 * 作業履歴からユーザーの意図・目標を抽出する
 */

import { v4 as uuidv4 } from 'uuid';
import type { UserIntent, IntentGoal, WorkHistoryRecord } from '../types/index.js';
import type { ClaudeRunner } from '../claude/runner.js';
import { LoadCharacterPrompt } from '../character.js';

/**
 * インテント抽出用プロンプトを構築する
 */
function BuildIntentPrompt(
  userId: string,
  records: readonly WorkHistoryRecord[],
  existingIntent: UserIntent | undefined
): string {
  const historyLines = records.map((record) => {
    const date = new Date(record.timestamp).toLocaleDateString('ja-JP');
    const status = record.result === 'success' ? '成功' : '失敗';
    const repoInfo = record.repo ? ` [${record.repo}]` : '';
    return `- ${date} | ${status}${repoInfo}\n  プロンプト: ${record.prompt}\n  結果: ${record.summary}`;
  });

  let existingSection = '';
  if (existingIntent) {
    const shortTermLines = existingIntent.shortTermGoals.map(
      (g) => `  - [${g.id}] [${g.status}/${g.confidence}] ${g.description} (初検出: ${g.firstSeenAt}, 根拠: ${g.evidence.join(', ')})`
    );
    const longTermLines = existingIntent.longTermGoals.map(
      (g) => `  - [${g.id}] [${g.status}/${g.confidence}] ${g.description} (初検出: ${g.firstSeenAt}, 根拠: ${g.evidence.join(', ')})`
    );

    existingSection = `
## 既存のインテント（差分更新してください）

### 短期ゴール
${shortTermLines.length > 0 ? shortTermLines.join('\n') : '（なし）'}

### 長期ゴール
${longTermLines.length > 0 ? longTermLines.join('\n') : '（なし）'}

注意: 既存ゴールのIDは維持してください。statusを更新（active/completed/stale）し、新しい根拠があればevidenceに追加してください。
新規ゴールにはnewIdを設定してください（後でIDを振ります）。
`;
  }

  return `以下のユーザーの作業履歴から、ユーザーの意図・目標を抽出してください。

## 対象ユーザー
Slack User ID: ${userId}

## 作業履歴
${historyLines.join('\n\n')}
${existingSection}
## 抽出タスク

作業履歴から以下を推定し、JSON形式で出力してください:

1. **短期ゴール**: 今週の戦術的な作業目標（具体的なタスクや機能実装など）
2. **長期ゴール**: プロジェクト全体の戦略的な目標（アーキテクチャ改善、新機能開発の方向性など）

各ゴールには以下を含めてください:
- description: ゴールの説明
- confidence: 推定の確信度（high/medium/low）
- evidence: 根拠となる作業履歴の要約（配列）
- status: 状態（active/completed/stale）
${existingIntent ? '- id: 既存ゴールの場合はそのID、新規の場合は "newId"' : ''}

## 出力フォーマット（厳密にこのJSON形式で出力してください）

\`\`\`json
{
  "shortTermGoals": [
    {
      ${existingIntent ? '"id": "既存IDまたはnewId",' : ''}
      "description": "ゴールの説明",
      "confidence": "high|medium|low",
      "evidence": ["根拠1", "根拠2"],
      "status": "active|completed|stale"
    }
  ],
  "longTermGoals": [
    {
      ${existingIntent ? '"id": "既存IDまたはnewId",' : ''}
      "description": "ゴールの説明",
      "confidence": "high|medium|low",
      "evidence": ["根拠1", "根拠2"],
      "status": "active|completed|stale"
    }
  ]
}
\`\`\`

JSONのみを出力してください。JSONの前後に説明文は不要です。`;
}

/**
 * Claude出力からインテントJSONをパースする
 */
function ParseIntentOutput(output: string): {
  shortTermGoals: ReadonlyArray<{
    id?: string;
    description: string;
    confidence: 'high' | 'medium' | 'low';
    evidence: readonly string[];
    status: 'active' | 'completed' | 'stale';
  }>;
  longTermGoals: ReadonlyArray<{
    id?: string;
    description: string;
    confidence: 'high' | 'medium' | 'low';
    evidence: readonly string[];
    status: 'active' | 'completed' | 'stale';
  }>;
} | undefined {
  try {
    const jsonMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : output.trim();

    if (!jsonStr) {
      return undefined;
    }

    const parsed = JSON.parse(jsonStr);

    if (!Array.isArray(parsed.shortTermGoals) || !Array.isArray(parsed.longTermGoals)) {
      console.error('Invalid intent output structure');
      return undefined;
    }

    return parsed;
  } catch (error) {
    console.error('Failed to parse intent output:', error);
    return undefined;
  }
}

/**
 * パースされたゴールを既存インテントとマージする
 */
function MergeGoals(
  parsedGoals: ReadonlyArray<{
    id?: string;
    description: string;
    confidence: 'high' | 'medium' | 'low';
    evidence: readonly string[];
    status: 'active' | 'completed' | 'stale';
  }>,
  existingGoals: readonly IntentGoal[] | undefined,
  now: string
): readonly IntentGoal[] {
  const existingMap = new Map<string, IntentGoal>();
  if (existingGoals) {
    for (const goal of existingGoals) {
      existingMap.set(goal.id, goal);
    }
  }

  return parsedGoals.map((parsed) => {
    const existingGoal = parsed.id && parsed.id !== 'newId'
      ? existingMap.get(parsed.id)
      : undefined;

    if (existingGoal) {
      // 既存ゴールの差分更新: firstSeenAt保持、lastSeenAt更新
      return {
        ...existingGoal,
        description: parsed.description,
        confidence: parsed.confidence,
        lastSeenAt: now,
        evidence: [...new Set([...existingGoal.evidence, ...parsed.evidence])],
        status: parsed.status,
      };
    }

    // 新規ゴール
    return {
      id: uuidv4(),
      description: parsed.description,
      confidence: parsed.confidence,
      firstSeenAt: now,
      lastSeenAt: now,
      evidence: [...parsed.evidence],
      status: parsed.status,
    };
  });
}

/**
 * ユーザーのインテントを抽出・更新する
 * 失敗時は既存インテントをそのまま返却する（フォールバック）
 */
export async function ExtractUserIntents(
  userId: string,
  records: readonly WorkHistoryRecord[],
  existingIntent: UserIntent | undefined,
  claudeRunner: ClaudeRunner,
  workingDir: string,
  port: number
): Promise<UserIntent | undefined> {
  if (records.length === 0) {
    return existingIntent;
  }

  console.log(`Intent: Extracting intents for user ${userId}`);

  try {
    const prompt = BuildIntentPrompt(userId, records, existingIntent);

    const systemPrompt = `${LoadCharacterPrompt()}

あなたは今、インテント抽出モードです。ユーザーの作業履歴から意図・目標を推定してください。
出力は必ずJSON形式で行ってください。日本語で記述してください。`;

    const result = await claudeRunner.Run(`intent-${userId}-${Date.now()}`, prompt, {
      workingDirectory: workingDir,
      systemPrompt,
      approvalServerPort: port,
    });

    if (!result.success) {
      console.error(`Intent: Failed for user ${userId}: ${result.error}`);
      return existingIntent;
    }

    const parsed = ParseIntentOutput(result.output);
    if (!parsed) {
      console.error(`Intent: Failed to parse output for user ${userId}`);
      return existingIntent;
    }

    const now = new Date().toISOString();

    const shortTermGoals = MergeGoals(
      parsed.shortTermGoals,
      existingIntent?.shortTermGoals,
      now
    );
    const longTermGoals = MergeGoals(
      parsed.longTermGoals,
      existingIntent?.longTermGoals,
      now
    );

    return {
      userId,
      updatedAt: now,
      shortTermGoals,
      longTermGoals,
    };
  } catch (error) {
    console.error(`Intent: Error extracting intents for user ${userId}:`, error);
    return existingIntent;
  }
}
