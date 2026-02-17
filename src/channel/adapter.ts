/**
 * claps - チャネルアダプタ インターフェース定義
 * 全メッセージングチャネルが実装する共通インターフェース
 */

import type {
  TaskSource,
  ApprovalResult,
  ReflectionResult,
  HealthStatus,
  NotificationContext,
  AdapterCallbacks,
} from '../types/index.js';

/**
 * ChannelAdapter インターフェース
 * Slack, LINE, HTTP 等の各チャネルがこれを実装する
 */
export interface ChannelAdapter {
  /** アダプタ名（表示用） */
  getName(): string;

  /** タスクソースの識別子 */
  getSource(): TaskSource;

  // --- Lifecycle ---

  /** 初期化（SDK初期化、コールバック登録） */
  init(callbacks: AdapterCallbacks): Promise<void>;

  /** 開始（イベントリスナー開始、Webhook開始） */
  start(): Promise<void>;

  /** 停止（クリーンアップ） */
  stop(): Promise<void>;

  /** 健全性チェック */
  getHealth(): HealthStatus;

  // --- Auth ---

  /** ユーザーがホワイトリストに含まれているかチェック */
  isUserAllowed(userId: string): boolean;

  // --- Messaging ---

  /** メッセージを送信 */
  sendMessage(context: NotificationContext, message: string): Promise<void>;

  /** 長文メッセージを分割送信 */
  sendSplitMessage(context: NotificationContext, message: string): Promise<void>;

  // --- Approval ---

  /** 承認リクエストを送信し、結果を待つ */
  requestApproval(
    context: NotificationContext,
    requestId: string,
    tool: string,
    command: string,
    requestedByUserId?: string
  ): Promise<ApprovalResult>;

  // --- Question ---

  /** 質問を送信し、回答を待つ */
  askQuestion(
    context: NotificationContext,
    requestId: string,
    question: string,
    options: readonly string[]
  ): Promise<string>;

  // --- Notifications ---

  /** タスク開始通知 */
  notifyTaskStarted(context: NotificationContext, description: string): Promise<void>;

  /** タスク完了通知 */
  notifyTaskCompleted(context: NotificationContext, message: string, prUrl?: string): Promise<void>;

  /** エラー通知 */
  notifyError(context: NotificationContext, error: string): Promise<void>;

  /** 進捗通知 */
  notifyProgress(context: NotificationContext, message: string): Promise<void>;

  /** 作業ログ通知 */
  notifyWorkLog(
    context: NotificationContext,
    logType: string,
    message: string,
    details?: string
  ): Promise<void>;

  // --- Special ---

  /** 内省結果を投稿 */
  postReflectionResult(result: ReflectionResult): Promise<void>;

  /** Issue用の通知スレッドを作成（Slack固有、他チャネルはno-op） */
  createIssueThread(
    owner: string,
    repo: string,
    issueNumber: number,
    issueTitle: string,
    issueUrl: string
  ): Promise<string>;
}
