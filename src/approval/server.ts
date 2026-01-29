/**
 * sumomo - 承認サーバー
 * PreToolUse Hook からの承認リクエストを処理する Express サーバー
 */

import express, { type Express, type Request, type Response } from 'express';
import type { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import type { App } from '@slack/bolt';
import type { HookInput, HookOutput } from '../types/index.js';
import { RequestApproval, AskQuestion } from '../slack/handlers.js';

// サーバー状態
let _server: Server | undefined;
let _app: Express | undefined;

// Slack Bot への参照（承認リクエスト送信用）
let _slackApp: App | undefined;
let _slackChannelId: string | undefined;

// 現在のタスクID（承認リクエストに紐付ける）
let _currentTaskId: string | undefined;
let _currentThreadTs: string | undefined;

// 現在のタスクで許可されたツール（同じタスク内では自動許可）
const _allowedToolsForTask = new Set<string>();
const _autoApproveCounter = new Map<string, number>();

// 承認が必要なコマンドパターン
const DANGEROUS_BASH_PATTERNS = [
  /\bgit\s+push\b/,
  /\bgit\s+commit\b/,
  /\brm\s+/,
  /\bnpm\s+publish\b/,
];

/**
 * 承認サーバーを初期化する
 */
export function InitApprovalServer(
  slackApp: App,
  channelId: string
): Express {
  _slackApp = slackApp;
  _slackChannelId = channelId;

  _app = express();
  _app.use(express.json());

  // ヘルスチェック
  _app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // 承認リクエストエンドポイント（PreToolUse Hook から呼ばれる）
  _app.post('/approve', async (req: Request, res: Response) => {
    try {
      const hookInput = req.body as HookInput;
      const result = await HandleApprovalRequest(hookInput);
      res.json(result);
    } catch (error) {
      console.error('Approval request error:', error);
      res.status(500).json({
        permissionDecision: 'deny',
        message: 'Internal server error',
      });
    }
  });

  // 現在のタスクIDを設定するエンドポイント
  _app.post('/set-task', (req: Request, res: Response) => {
    const { taskId } = req.body as { taskId: string };
    _currentTaskId = taskId;
    res.json({ success: true });
  });

  // 質問エンドポイント（ask-human MCP から呼ばれる）
  _app.post('/ask', async (req: Request, res: Response) => {
    try {
      const { question, options, context } = req.body as {
        question: string;
        options?: string[];
        context?: string;
      };

      if (!_slackApp || !_slackChannelId) {
        res.status(500).json({ error: 'Slack not configured' });
        return;
      }

      const requestId = uuidv4();
      const taskId = _currentTaskId ?? 'unknown';

      // 質問テキストを構築
      let fullQuestion = question;
      if (context) {
        fullQuestion = `${context}\n\n${question}`;
      }

      // デフォルトの選択肢
      const finalOptions = options && options.length > 0
        ? options
        : ['はい', 'いいえ', 'わからない'];

      const answer = await AskQuestion(
        _slackApp,
        _slackChannelId,
        requestId,
        taskId,
        fullQuestion,
        finalOptions
      );

      res.json({ answer });
    } catch (error) {
      console.error('Ask question error:', error);
      res.status(500).json({ error: 'Failed to ask question' });
    }
  });

  return _app;
}

/**
 * 承認サーバーを起動する
 */
export function StartApprovalServer(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!_app) {
      reject(new Error('Approval server not initialized'));
      return;
    }

    _server = _app.listen(port, () => {
      console.log(`Approval server started on port ${port}`);
      resolve();
    });

    _server.on('error', reject);
  });
}

/**
 * 承認サーバーを停止する
 */
export function StopApprovalServer(): Promise<void> {
  return new Promise((resolve) => {
    if (_server) {
      _server.close(() => {
        console.log('Approval server stopped');
        _server = undefined;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

/**
 * 承認リクエストを処理する
 */
async function HandleApprovalRequest(hookInput: HookInput): Promise<HookOutput> {
  const { tool_name, tool_input } = hookInput;

  // 承認が必要かどうかを判定
  const needsApproval = CheckNeedsApproval(tool_name, tool_input);

  if (!needsApproval) {
    return { permissionDecision: 'allow' };
  }

  // 同じタスク内で既に許可されたツールは自動許可
  if (_allowedToolsForTask.has(tool_name)) {
    // 自動許可のログは最初の5回だけ表示（ログ汚染防止）
    const autoApproveCount = (_autoApproveCounter.get(tool_name) ?? 0) + 1;
    _autoApproveCounter.set(tool_name, autoApproveCount);
    if (autoApproveCount <= 5) {
      console.log(`Auto-approved ${tool_name} (${autoApproveCount})`);
    } else if (autoApproveCount === 6) {
      console.log(`Auto-approved ${tool_name} (suppressing further logs...)`);
    }
    return {
      permissionDecision: 'allow',
      message: 'Auto-approved (already allowed in this task)',
    };
  }

  // Slack に承認リクエストを送信
  if (!_slackApp || !_slackChannelId) {
    console.error('Slack not configured for approval');
    return {
      permissionDecision: 'deny',
      message: 'Slack not configured',
    };
  }

  const requestId = uuidv4();
  const taskId = _currentTaskId ?? 'unknown';
  const command = FormatCommand(tool_name, tool_input);

  console.log(`Requesting approval for: ${tool_name}`);

  try {
    const result = await RequestApproval(
      _slackApp,
      _slackChannelId,
      requestId,
      taskId,
      tool_name,
      command,
      _currentThreadTs
    );

    let message = result.decision === 'allow' ? 'Approved by user' : 'Denied by user';
    if (result.comment) {
      message += `: ${result.comment}`;
    }

    // 許可された場合、このタスク内では同じツールを自動許可
    if (result.decision === 'allow') {
      _allowedToolsForTask.add(tool_name);
    }

    return {
      permissionDecision: result.decision,
      message,
    };
  } catch (error) {
    console.error('Approval request failed:', error);
    return {
      permissionDecision: 'deny',
      message: 'Approval request failed',
    };
  }
}

/**
 * 承認が必要かどうかを判定する
 */
function CheckNeedsApproval(
  toolName: string,
  toolInput: Record<string, unknown>
): boolean {
  // Write と Edit は常に承認が必要
  if (toolName === 'Write' || toolName === 'Edit') {
    return true;
  }

  // Bash コマンドの場合
  if (toolName === 'Bash') {
    const command = toolInput['command'] as string | undefined;
    if (!command) return false;

    for (const pattern of DANGEROUS_BASH_PATTERNS) {
      if (pattern.test(command)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * コマンドをフォーマットする
 */
function FormatCommand(
  toolName: string,
  toolInput: Record<string, unknown>
): string {
  if (toolName === 'Bash') {
    return toolInput['command'] as string ?? '';
  }

  if (toolName === 'Write') {
    const filePath = toolInput['file_path'] as string ?? '';
    const content = toolInput['content'] as string ?? '';
    const preview = content.slice(0, 200);
    return `Write to: ${filePath}\n\nContent preview:\n${preview}${content.length > 200 ? '...' : ''}`;
  }

  if (toolName === 'Edit') {
    const filePath = toolInput['file_path'] as string ?? '';
    const oldString = toolInput['old_string'] as string ?? '';
    const newString = toolInput['new_string'] as string ?? '';
    return `Edit: ${filePath}\n\nOld:\n${oldString.slice(0, 100)}\n\nNew:\n${newString.slice(0, 100)}`;
  }

  return JSON.stringify(toolInput, null, 2);
}

/**
 * 現在のタスクIDを設定する
 */
export function SetCurrentTaskId(taskId: string, threadTs?: string): void {
  _currentTaskId = taskId;
  _currentThreadTs = threadTs;
  // 新しいタスクでは許可済みツールをリセット
  _allowedToolsForTask.clear();
}

/**
 * 現在のタスクIDをクリアする
 */
export function ClearCurrentTaskId(): void {
  _currentTaskId = undefined;
  _currentThreadTs = undefined;
  _allowedToolsForTask.clear();
  _autoApproveCounter.clear();
}
