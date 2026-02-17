/**
 * claps - 承認サーバー
 * PreToolUse Hook からの承認リクエストを処理する Express サーバー
 */

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import type { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { HookInput, HookOutput, TaskMetadata } from '../types/index.js';
import type { NotificationRouter } from '../channel/router.js';

// サーバー状態
let _server: Server | undefined;
let _app: Express | undefined;

// 認証トークン
let _authToken: string | undefined;
const AUTH_TOKEN_DIR = path.join(os.homedir(), '.claps');
const AUTH_TOKEN_FILE = path.join(AUTH_TOKEN_DIR, 'auth-token');

// 通知ルーターへの参照（承認リクエスト送信用）
let _router: NotificationRouter | undefined;

/**
 * 認証トークンを生成してファイルに保存する
 */
function GenerateAuthToken(): string {
  const token = crypto.randomBytes(32).toString('hex');

  // ディレクトリがなければ作成
  if (!fs.existsSync(AUTH_TOKEN_DIR)) {
    fs.mkdirSync(AUTH_TOKEN_DIR, { mode: 0o700 });
  }

  // トークンをファイルに保存（所有者のみ読み書き可能）
  fs.writeFileSync(AUTH_TOKEN_FILE, token, { mode: 0o600 });

  console.log(`Auth token saved to ${AUTH_TOKEN_FILE}`);
  return token;
}

/**
 * 認証トークンを検証するミドルウェア
 * タイミング攻撃を防ぐため、定数時間比較を使用
 */
function AuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  // ヘルスチェックは認証不要
  if (req.path === '/health') {
    next();
    return;
  }

  // /api/v1/ 配下は HTTP アダプタ側の認証ミドルウェアに委譲
  if (req.path.startsWith('/api/v1/')) {
    next();
    return;
  }

  const token = req.headers['x-auth-token'] as string | undefined;

  if (!token || !_authToken) {
    console.warn(`Unauthorized request to ${req.path} from ${req.ip}`);
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // タイミング攻撃を防ぐため、定数時間比較を使用
  const tokenBuffer = Buffer.from(token);
  const authTokenBuffer = Buffer.from(_authToken);

  if (tokenBuffer.length !== authTokenBuffer.length ||
      !crypto.timingSafeEqual(tokenBuffer, authTokenBuffer)) {
    console.warn(`Unauthorized request to ${req.path} from ${req.ip}`);
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}

// 現在のタスクID（承認リクエストに紐付ける）
let _currentTaskId: string | undefined;
let _currentTaskMetadata: TaskMetadata | undefined;
let _currentRequestedByUserId: string | undefined;

// 現在のタスクで許可されたツール+内容キー（同一内容のみ自動許可）
// Bash: "Bash:<command>", Write: "Write:<filePath>", Edit: "Edit:<filePath>"
// Task等: "Task" （ツール名のみ）
const _allowedKeysForTask = new Set<string>();
const _autoApproveCounter = new Map<string, number>();

// 作業ログの投稿間隔（ミリ秒）
const WORK_LOG_INTERVAL_MS = 10000;
let _lastWorkLogTime = 0;


/**
 * 承認サーバーを初期化する
 */
export function InitApprovalServer(
  router: NotificationRouter
): Express {
  _router = router;

  // 認証トークンを生成
  _authToken = GenerateAuthToken();

  _app = express();
  _app.use(express.json());

  // 認証ミドルウェアを追加
  _app.use(AuthMiddleware);

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

  // ツール使用通知エンドポイント（PreToolUse Hook から呼ばれる）
  _app.post('/notify-tool', (req: Request, res: Response) => {
    try {
      const hookInput = req.body as HookInput;
      if (!hookInput?.tool_name || typeof hookInput.tool_name !== 'string') {
        res.status(400).json({ error: 'Invalid hook input' });
        return;
      }
      void HandleToolNotification(hookInput);
      res.json({ success: true });
    } catch (error) {
      console.error('Tool notification error:', error);
      res.status(500).json({ error: 'Internal server error' });
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

      if (!_router || !_currentTaskMetadata) {
        res.status(500).json({ error: 'Router or task metadata not configured' });
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

      const answer = await _router.askQuestion(
        taskId,
        _currentTaskMetadata,
        requestId,
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
 * Express アプリインスタンスを取得する（HTTP アダプタがルートをマウントするため）
 */
export function GetExpressApp(): Express | undefined {
  return _app;
}

/**
 * 承認サーバーを起動する
 * セキュリティのため 127.0.0.1 のみにバインド
 */
export function StartApprovalServer(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!_app) {
      reject(new Error('Approval server not initialized'));
      return;
    }

    // 127.0.0.1 のみにバインド（外部からのアクセスを防止）
    _server = _app.listen(port, '127.0.0.1', () => {
      console.log(`Approval server started on 127.0.0.1:${port} (localhost only)`);
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
    // 認証トークンファイルを削除
    if (fs.existsSync(AUTH_TOKEN_FILE)) {
      fs.unlinkSync(AUTH_TOKEN_FILE);
      console.log('Auth token file removed');
    }
    _authToken = undefined;

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

  // 同じタスク内で同じ内容が既に許可されていれば自動許可
  const approvalKey = GetApprovalKey(tool_name, tool_input);
  if (_allowedKeysForTask.has(approvalKey)) {
    // 自動許可のログは最初の5回だけ表示（ログ汚染防止）
    const autoApproveCount = (_autoApproveCounter.get(approvalKey) ?? 0) + 1;
    _autoApproveCounter.set(approvalKey, autoApproveCount);
    if (autoApproveCount <= 5) {
      console.log(`Auto-approved ${tool_name} (${autoApproveCount})`);
    } else if (autoApproveCount === 6) {
      console.log(`Auto-approved ${tool_name} (suppressing further logs...)`);
    }
    return {
      permissionDecision: 'allow',
      message: 'Auto-approved (same content already allowed in this task)',
    };
  }

  // ルーター経由で承認リクエストを送信
  if (!_router || !_currentTaskMetadata) {
    console.error('Router or task metadata not configured for approval');
    return {
      permissionDecision: 'deny',
      message: 'Router not configured',
    };
  }

  const requestId = uuidv4();
  const taskId = _currentTaskId ?? 'unknown';
  const command = FormatCommand(tool_name, tool_input);

  console.log(`Requesting approval for: ${tool_name}`);

  try {
    const result = await _router.requestApproval(
      taskId,
      _currentTaskMetadata,
      requestId,
      tool_name,
      command,
      _currentRequestedByUserId
    );

    let message = result.decision === 'allow' ? 'Approved by user' : 'Denied by user';
    if (result.comment) {
      message += `: ${result.comment}`;
    }

    // 許可された場合、このタスク内では同じ内容を自動許可
    if (result.decision === 'allow') {
      _allowedKeysForTask.add(approvalKey);
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
 * ツール使用通知を処理し、チャネルに作業ログを投稿する
 */
async function HandleToolNotification(hookInput: HookInput): Promise<void> {
  const { tool_name, tool_input } = hookInput;

  if (!_router || !_currentTaskMetadata) {
    return;
  }

  // 投稿間隔を制御（10秒間隔）
  const now = Date.now();
  if (now - _lastWorkLogTime < WORK_LOG_INTERVAL_MS) {
    return;
  }
  _lastWorkLogTime = now;

  // ツール名に対応するメッセージを生成
  const message = GetToolMessage(tool_name);
  const details = GetToolDetails(tool_name, tool_input);
  const taskId = _currentTaskId ?? 'unknown';

  try {
    await _router.notifyWorkLog(taskId, _currentTaskMetadata, 'tool_start', message, details);
  } catch (error) {
    console.error('Failed to post tool notification:', error);
  }
}

/**
 * ツール名に対応するメッセージを取得する
 */
function GetToolMessage(toolName: string): string {
  const toolMessages: Record<string, string> = {
    Read: 'ファイルを読み込み中',
    Write: 'ファイルを作成中',
    Edit: 'ファイルを編集中',
    Bash: 'コマンドを実行中',
    Glob: 'ファイルを検索中',
    Grep: 'コードを検索中',
    Task: 'サブタスクを実行中',
    WebFetch: 'Webページを取得中',
    WebSearch: 'Web検索中',
    LSP: 'コード解析中',
  };
  return toolMessages[toolName] ?? `${toolName}を実行中`;
}

/**
 * ツール入力から詳細情報を抽出する
 */
function GetToolDetails(toolName: string, toolInput: Record<string, unknown>): string {
  if (toolName === 'Read' && toolInput['file_path']) {
    return String(toolInput['file_path']);
  }
  if (toolName === 'Write' && toolInput['file_path']) {
    return String(toolInput['file_path']);
  }
  if (toolName === 'Edit' && toolInput['file_path']) {
    return String(toolInput['file_path']);
  }
  if (toolName === 'Bash' && toolInput['command']) {
    return String(toolInput['command']).slice(0, 100);
  }
  if (toolName === 'Glob' && toolInput['pattern']) {
    return String(toolInput['pattern']);
  }
  if (toolName === 'Grep' && toolInput['pattern']) {
    return String(toolInput['pattern']);
  }
  if (toolName === 'Task' && toolInput['description']) {
    return String(toolInput['description']);
  }
  return '';
}

/**
 * 承認が必要なツール
 * これらのツールはファイル変更やコマンド実行など副作用を伴うため、
 * 初回使用時にSlack承認を求める（内容が変わる場合は再承認）
 */
const TOOLS_REQUIRING_APPROVAL = new Set([
  'Bash',
  'Write',
  'Edit',
  'Task',
  'NotebookEdit',
]);

/**
 * 自動承認のキーを生成する
 * Claude Code の標準動作に合わせ、ツール内容が変わる場合は再承認を要求する
 * - Bash: コマンド文字列で識別
 * - Write/Edit: ファイルパスで識別
 * - Task/NotebookEdit: ツール名のみ
 */
function GetApprovalKey(
  toolName: string,
  toolInput: Record<string, unknown>
): string {
  if (toolName === 'Bash') {
    const command = String(toolInput['command'] ?? '');
    return `Bash:${command}`;
  }
  if (toolName === 'Write') {
    const filePath = String(toolInput['file_path'] ?? '');
    return `Write:${filePath}`;
  }
  if (toolName === 'Edit') {
    const filePath = String(toolInput['file_path'] ?? '');
    return `Edit:${filePath}`;
  }
  // Task, NotebookEdit 等はツール名のみ
  return toolName;
}

/**
 * 承認が必要かどうかを判定する
 */
function CheckNeedsApproval(
  toolName: string,
  _toolInput: Record<string, unknown>
): boolean {
  return TOOLS_REQUIRING_APPROVAL.has(toolName);
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
 * 現在のタスクIDとメタデータを設定する
 */
export function SetCurrentTaskId(
  taskId: string,
  metadata: TaskMetadata,
  requestedByUserId?: string
): void {
  _currentTaskId = taskId;
  _currentTaskMetadata = metadata;
  _currentRequestedByUserId = requestedByUserId;
  // 新しいタスクでは許可済みツールをリセット
  _allowedKeysForTask.clear();
}

/**
 * 現在のタスクIDをクリアする
 */
export function ClearCurrentTaskId(): void {
  _currentTaskId = undefined;
  _currentTaskMetadata = undefined;
  _currentRequestedByUserId = undefined;
  _allowedKeysForTask.clear();
  _autoApproveCounter.clear();
  _lastWorkLogTime = 0;
}
