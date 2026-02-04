/**
 * sumomo - tmux 経由の Claude CLI ランナー
 * Claude CLI を対話モードで実行し、権限リクエストを自動処理する
 */

import { v4 as uuidv4 } from 'uuid';
import type { App } from '@slack/bolt';
import {
  CreateTmuxSession,
  WatchSession,
  KillSession,
  SessionExists,
  SendApproval,
  SendDenial,
  GetSessionNameForIssue,
} from '../tmux/session.js';
import { RequestApproval } from '../slack/handlers.js';

// 実行結果
export interface TmuxRunResult {
  readonly success: boolean;
  readonly output: string;
  readonly prUrl?: string;
  readonly error?: string;
  readonly sessionId?: string;
}

// 作業ログ
export interface WorkLog {
  readonly type: 'tool_start' | 'tool_end' | 'thinking' | 'text' | 'error' | 'approval_pending';
  readonly tool?: string;
  readonly message: string;
  readonly details?: string;
}
export type WorkLogCallback = (log: WorkLog) => void;

// 実行オプション
export interface TmuxRunnerOptions {
  readonly workingDirectory: string;
  readonly timeout?: number;
  readonly onWorkLog?: WorkLogCallback;
  readonly systemPrompt?: string;
  // Slack 承認用
  readonly slackApp?: App;
  readonly slackChannelId?: string;
  readonly slackThreadTs?: string;
  readonly requestedBySlackId?: string;
}

// 自動許可するMCPツールパターン（sumomo 関係）
const AUTO_APPROVE_MCP_PATTERNS = [
  /mcp__sumomo-github__/,
  /mcp__sumomo-slack__/,
];

// その他のMCPツールパターン（Slack承認が必要）
const OTHER_MCP_PATTERN = /mcp__[\w-]+__[\w-]+/;

// 権限リクエスト検出パターン
const PERMISSION_REQUEST_PATTERN = /Allow\s+([\w_-]+)/i;

// Claude CLI 終了検出パターン（プロンプトで指示した終了マーカー）
const FINISH_PATTERN = /SUMOMO_EXIT/;

// PR URL 抽出パターン
const PR_URL_PATTERN = /https:\/\/github\.com\/[^\/]+\/[^\/]+\/pull\/\d+/;

// 処理済み権限リクエストを追跡（重複防止）
const _processedRequests = new Set<string>();

/**
 * tmux 経由で Claude CLI を実行する
 */
export async function RunWithTmux(
  taskId: string,
  prompt: string,
  owner: string,
  repo: string,
  issueNumber: number,
  options: TmuxRunnerOptions
): Promise<TmuxRunResult> {
  const sessionName = GetSessionNameForIssue(owner, repo, issueNumber);
  const timeout = options.timeout ?? 600000; // 10分
  let output = '';
  let lastOutput = '';
  let isRunning = true;
  let isWaitingApproval = false;

  // このセッション用の処理済みリクエストをクリア
  _processedRequests.clear();

  console.log(`Starting tmux session: ${sessionName}`);
  console.log(`Working directory: ${options.workingDirectory}`);
  console.log(`Prompt: ${prompt.slice(0, 100)}...`);

  return new Promise(async (resolve) => {

    // タイムアウト設定
    const timeoutHandle = setTimeout(() => {
      if (isRunning) {
        isRunning = false;
        console.log(`Session ${sessionName} timed out`);
        KillSession(sessionName);
        resolve({
          success: false,
          output,
          error: `Timeout after ${timeout}ms`,
        });
      }
    }, timeout);

    try {
      // tmux セッションを作成して Claude CLI を起動
      await CreateTmuxSession(
        sessionName,
        options.workingDirectory,
        issueNumber,
        prompt
      );

      // セッションの出力を監視
      const stopWatch = WatchSession(sessionName, async (currentOutput) => {
        if (!isRunning) return;
        if (isWaitingApproval) return; // 承認待ち中は処理をスキップ

        output = currentOutput;

        // 新しい出力があるかチェック
        if (currentOutput !== lastOutput) {
          const newContent = currentOutput.slice(lastOutput.length);
          lastOutput = currentOutput;

          // 権限リクエストを検出して処理
          const permissionResult = await HandlePermissionRequest(
            sessionName,
            currentOutput,
            taskId,
            options,
            () => { isWaitingApproval = true; },
            () => { isWaitingApproval = false; }
          );

          if (permissionResult === 'waiting') {
            return; // 承認待ち中
          }

          // 作業ログを抽出
          if (options.onWorkLog) {
            ParseWorkLog(newContent, options.onWorkLog);
          }
        }

        // Claude CLI が終了したかチェック（SUMOMO_EXIT マーカーを検出）
        if (IsClaudeFinished(currentOutput)) {
          isRunning = false;
          clearTimeout(timeoutHandle);
          stopWatch();

          // PR URL を抽出
          const prUrl = ExtractPrUrl(output);

          console.log(`Session ${sessionName} finished`);

          resolve({
            success: true,
            output: CleanOutput(output),
            prUrl,
          });
        }
      }, 500); // 500ms間隔で監視

    } catch (error) {
      isRunning = false;
      clearTimeout(timeoutHandle);

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Failed to start session ${sessionName}:`, errorMessage);

      resolve({
        success: false,
        output,
        error: errorMessage,
      });
    }
  });
}

/**
 * 権限リクエストを検出して処理する
 */
async function HandlePermissionRequest(
  sessionName: string,
  output: string,
  taskId: string,
  options: TmuxRunnerOptions,
  onWaitStart: () => void,
  onWaitEnd: () => void
): Promise<'approved' | 'denied' | 'waiting' | 'none'> {
  // 最後の数行をチェック
  const lines = output.split('\n');
  const recentLines = lines.slice(-30).join('\n');

  // 権限リクエストパターンをチェック
  const match = recentLines.match(PERMISSION_REQUEST_PATTERN);
  if (!match) {
    return 'none';
  }

  const toolName = match[1];
  if (!toolName) {
    return 'none';
  }

  // 既に処理済みかチェック（重複防止）
  const requestKey = `${sessionName}:${toolName}:${lines.length}`;
  if (_processedRequests.has(requestKey)) {
    return 'none';
  }
  _processedRequests.add(requestKey);

  console.log(`Permission request detected for tool: ${toolName}`);

  // sumomo 関係の MCP ツールは自動承認
  for (const pattern of AUTO_APPROVE_MCP_PATTERNS) {
    if (pattern.test(toolName)) {
      console.log(`Auto-approving sumomo MCP tool: ${toolName}`);
      SendApproval(sessionName);
      return 'approved';
    }
  }

  // その他の MCP ツールは Slack 承認
  if (OTHER_MCP_PATTERN.test(toolName)) {
    if (options.slackApp && options.slackChannelId) {
      console.log(`Requesting Slack approval for MCP tool: ${toolName}`);
      console.log(`  - slackChannelId: ${options.slackChannelId}`);
      console.log(`  - slackThreadTs: ${options.slackThreadTs ?? 'undefined'}`);

      // 作業ログで承認待ちを通知
      if (options.onWorkLog) {
        options.onWorkLog({
          type: 'approval_pending',
          tool: toolName,
          message: `MCP ツール承認待ち: ${toolName}`,
        });
      }

      onWaitStart();

      try {
        const requestId = uuidv4();
        // threadTs が必ず渡されるようにする（スレッドへ投稿するため）
        if (!options.slackThreadTs) {
          console.warn(`WARNING: slackThreadTs is undefined for approval request`);
        }
        const result = await RequestApproval(
          options.slackApp,
          options.slackChannelId,
          requestId,
          taskId,
          toolName,
          `MCP ツールの使用許可: ${toolName}`,
          options.slackThreadTs,
          options.requestedBySlackId
        );

        onWaitEnd();

        if (result.decision === 'allow') {
          console.log(`Slack approved MCP tool: ${toolName}`);
          SendApproval(sessionName, result.comment);
          return 'approved';
        } else {
          console.log(`Slack denied MCP tool: ${toolName}`);
          SendDenial(sessionName, result.comment);
          return 'denied';
        }
      } catch (error) {
        onWaitEnd();
        console.error(`Failed to request Slack approval: ${error}`);
        // エラーの場合は拒否
        SendDenial(sessionName);
        return 'denied';
      }
    } else {
      // Slack が設定されていない場合は自動承認
      console.log(`No Slack configured, auto-approving MCP tool: ${toolName}`);
      SendApproval(sessionName);
      return 'approved';
    }
  }

  // MCP 以外のツール（Read, Glob, Grep など）は自動承認
  // Write, Edit, Bash は PreToolUse Hook で処理される
  console.log(`Auto-approving non-MCP tool: ${toolName}`);
  SendApproval(sessionName);
  return 'approved';
}

/**
 * Claude CLI が終了したかチェック
 * Claude がプロンプトの指示に従って出力する SUMOMO_EXIT マーカーを検出
 */
function IsClaudeFinished(output: string): boolean {
  if (FINISH_PATTERN.test(output)) {
    console.log(`Claude finished: SUMOMO_EXIT marker detected`);
    return true;
  }
  return false;
}

/**
 * 出力から PR URL を抽出
 */
function ExtractPrUrl(output: string): string | undefined {
  const match = output.match(PR_URL_PATTERN);
  return match ? match[0] : undefined;
}

/**
 * 出力をクリーンアップ
 */
function CleanOutput(output: string): string {
  // エスケープシーケンスを除去
  return output
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\r/g, '')
    .trim();
}

/**
 * 出力から作業ログを解析
 */
function ParseWorkLog(content: string, callback: WorkLogCallback): void {
  // ツール使用を検出
  const toolPatterns = [
    { pattern: /Reading file: (.+)/i, type: 'tool_start' as const, tool: 'Read', getMessage: (m: RegExpMatchArray) => `ファイルを読み込み中: ${m[1]}` },
    { pattern: /Writing to: (.+)/i, type: 'tool_start' as const, tool: 'Write', getMessage: (m: RegExpMatchArray) => `ファイルを作成中: ${m[1]}` },
    { pattern: /Editing: (.+)/i, type: 'tool_start' as const, tool: 'Edit', getMessage: (m: RegExpMatchArray) => `ファイルを編集中: ${m[1]}` },
    { pattern: /Running: (.+)/i, type: 'tool_start' as const, tool: 'Bash', getMessage: (m: RegExpMatchArray) => `コマンドを実行中: ${m[1]?.slice(0, 50)}` },
    { pattern: /Searching for: (.+)/i, type: 'tool_start' as const, tool: 'Grep', getMessage: (m: RegExpMatchArray) => `検索中: ${m[1]}` },
  ];

  for (const { pattern, type, tool, getMessage } of toolPatterns) {
    const match = content.match(pattern);
    if (match) {
      callback({
        type,
        tool,
        message: getMessage(match),
      });
      return;
    }
  }

  // エラーを検出
  if (/error:|failed:/i.test(content)) {
    callback({
      type: 'error',
      message: 'エラーが発生',
      details: content.slice(0, 200),
    });
  }
}

/**
 * セッションを停止する
 */
export function StopTmuxSession(
  owner: string,
  repo: string,
  issueNumber: number
): void {
  const sessionName = GetSessionNameForIssue(owner, repo, issueNumber);
  if (SessionExists(sessionName)) {
    KillSession(sessionName);
  }
}
