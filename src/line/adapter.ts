/**
 * claps - LINE チャネルアダプタ
 * LINE Bot (@line/bot-sdk) を ChannelAdapter インターフェースでラップする
 */

import express, { type Express } from 'express';
import type { Server } from 'http';
import { messagingApi } from '@line/bot-sdk';
import type { TextMessage, QuickReply, QuickReplyItem } from '@line/bot-sdk';
import type {
  TaskSource,
  Config,
  LineTaskMetadata,
  ApprovalResult,
  ReflectionResult,
  HealthStatus,
  NotificationContext,
  AdapterCallbacks,
} from '../types/index.js';
import type { ChannelAdapter } from '../channel/adapter.js';
import { SplitMessage } from '../channel/formatter.js';
import { PlainMsg } from '../messages.js';
import { CreateLineWebhookRouter } from './webhook.js';

// LINE テキストメッセージの最大文字数（UTF-16コードユニット）
const LINE_MAX_MESSAGE_LENGTH = 5000;

// 1回の push/reply で送れる最大メッセージ数
const LINE_MAX_MESSAGES_PER_PUSH = 5;

/**
 * Deferred Promise（承認/質問の非同期応答待ちに使用）
 */
interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function CreateDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * LineAdapter
 * LINE Messaging API を ChannelAdapter インターフェースでラップする
 */
export class LineAdapter implements ChannelAdapter {
  private readonly _config: Config;
  private _client: messagingApi.MessagingApiClient | undefined;
  private _expressApp: Express | undefined;
  private _server: Server | undefined;
  private _callbacks: AdapterCallbacks | undefined;
  private _started = false;

  // 承認/質問の Deferred Promise マップ
  private readonly _pendingApprovals = new Map<string, Deferred<ApprovalResult>>();
  private readonly _pendingQuestions = new Map<string, Deferred<string>>();

  constructor(config: Config) {
    this._config = config;
  }

  getName(): string {
    return 'line';
  }

  getSource(): TaskSource {
    return 'line';
  }

  // --- Lifecycle ---

  async init(callbacks: AdapterCallbacks): Promise<void> {
    this._callbacks = callbacks;

    const lineConfig = this._config.channelConfig.line;
    if (!lineConfig) {
      throw new Error('LINE channel config is not set');
    }

    // MessagingApiClient を初期化
    this._client = new messagingApi.MessagingApiClient({
      channelAccessToken: lineConfig.channelToken,
    });

    console.log('[LineAdapter] Initialized with MessagingApiClient');
  }

  async start(): Promise<void> {
    if (!this._client || !this._callbacks) {
      throw new Error('LineAdapter not initialized');
    }

    const lineConfig = this._config.channelConfig.line;
    if (!lineConfig) {
      throw new Error('LINE channel config is not set');
    }

    // Express アプリを作成
    this._expressApp = express();

    // LINE Webhook ルーターをマウント
    // NOTE: express.json() は LINE middleware と競合するため、Webhook ルートの前には適用しない
    const webhookRouter = CreateLineWebhookRouter(lineConfig.channelSecret, {
      onTextMessage: (userId, messageText, replyToken) => {
        this._handleTextMessage(userId, messageText, replyToken);
      },
      onPostback: (userId, data, replyToken) => {
        this._handlePostback(userId, data, replyToken);
      },
    });
    this._expressApp.use(webhookRouter);

    // Express サーバーを起動
    const port = lineConfig.webhookPort;
    await new Promise<void>((resolve, reject) => {
      this._server = this._expressApp!.listen(port, () => {
        console.log(`[LineAdapter] Webhook server started on port ${port}`);
        resolve();
      });
      this._server.on('error', reject);
    });

    this._started = true;
    console.log('[LineAdapter] Started successfully');
  }

  async stop(): Promise<void> {
    if (this._server) {
      await new Promise<void>((resolve) => {
        this._server!.close(() => {
          console.log('[LineAdapter] Webhook server stopped');
          resolve();
        });
      });
      this._server = undefined;
    }
    this._started = false;
  }

  getHealth(): HealthStatus {
    return {
      name: this.getName(),
      status: this._started ? 'healthy' : 'stopped',
    };
  }

  // --- Auth ---

  isUserAllowed(userId: string): boolean {
    if (this._config.allowedUsers.line.length === 0) return false;
    return this._config.allowedUsers.line.includes(userId);
  }

  // --- Internal Event Handlers ---

  /**
   * テキストメッセージの処理
   * ユーザー認証を行い、タスクとしてキューに追加する
   */
  private _handleTextMessage(userId: string, messageText: string, replyToken: string): void {
    if (!this._callbacks) return;

    // ユーザー認証チェック
    if (!this.isUserAllowed(userId)) {
      console.warn(`[LineAdapter] Unauthorized user: ${userId}`);
      // 未認可ユーザーには reply token で通知（push は不要）
      void this._replyText(replyToken, 'このボットを使用する権限がありません。');
      return;
    }

    // メタデータを構築
    const metadata: LineTaskMetadata = {
      source: 'line',
      userId,
      replyToken,
      messageText,
    };

    // 受付通知を reply token で即座に返す
    void this._replyText(replyToken, PlainMsg('mention.start'));

    // タスクをキューに追加
    void this._callbacks.onMessage(metadata, messageText);
  }

  /**
   * Postbackイベントの処理（承認/質問応答）
   */
  private _handlePostback(userId: string, data: string, _replyToken: string): void {
    // data を URLSearchParams としてパース
    const params = new URLSearchParams(data);
    const action = params.get('action');
    const requestId = params.get('requestId');

    if (!action || !requestId) {
      console.warn(`[LineAdapter] Invalid postback data: ${data}`);
      return;
    }

    if (action === 'approve' || action === 'deny') {
      // 承認応答
      const deferred = this._pendingApprovals.get(requestId);
      if (deferred) {
        this._pendingApprovals.delete(requestId);
        const result: ApprovalResult = {
          decision: action === 'approve' ? 'allow' : 'deny',
          respondedBy: userId,
        };
        deferred.resolve(result);
        console.log(`[LineAdapter] Approval ${action} for ${requestId}`);
      } else {
        console.warn(`[LineAdapter] No pending approval for ${requestId}`);
      }
    } else if (action === 'answer') {
      // 質問応答
      const answer = params.get('answer');
      const deferred = this._pendingQuestions.get(requestId);
      if (deferred && answer) {
        this._pendingQuestions.delete(requestId);
        deferred.resolve(answer);
        console.log(`[LineAdapter] Answer "${answer}" for ${requestId}`);
      } else {
        console.warn(`[LineAdapter] No pending question for ${requestId} or missing answer`);
      }
    }
  }

  // --- Messaging ---

  async sendMessage(context: NotificationContext, message: string): Promise<void> {
    const userId = this._getUserId(context);
    if (!userId) return;

    await this._pushText(userId, message);
  }

  async sendSplitMessage(context: NotificationContext, message: string): Promise<void> {
    const userId = this._getUserId(context);
    if (!userId) return;

    const chunks = SplitMessage(message, LINE_MAX_MESSAGE_LENGTH);

    // LINE は 1回の push で最大5メッセージ
    for (let i = 0; i < chunks.length; i += LINE_MAX_MESSAGES_PER_PUSH) {
      const batch = chunks.slice(i, i + LINE_MAX_MESSAGES_PER_PUSH);
      const messages: TextMessage[] = batch.map((text) => ({
        type: 'text' as const,
        text,
      }));

      await this._client!.pushMessage({
        to: userId,
        messages,
      });
    }
  }

  // --- Approval ---

  async requestApproval(
    context: NotificationContext,
    requestId: string,
    tool: string,
    command: string,
    _requestedByUserId?: string
  ): Promise<ApprovalResult> {
    const userId = this._getUserId(context);
    if (!userId) {
      return { decision: 'deny' };
    }

    // Deferred Promise を作成
    const deferred = CreateDeferred<ApprovalResult>();
    this._pendingApprovals.set(requestId, deferred);

    // Quick Reply 付きメッセージを送信
    const text = `承認が必要です。\n\nツール: ${tool}\nコマンド: ${command.slice(0, 200)}`;
    const quickReply: QuickReply = {
      items: [
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '承認',
            data: `action=approve&requestId=${requestId}`,
          },
        },
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '拒否',
            data: `action=deny&requestId=${requestId}`,
          },
        },
      ] as QuickReplyItem[],
    };

    await this._client!.pushMessage({
      to: userId,
      messages: [{ type: 'text', text, quickReply } as TextMessage],
    });

    return deferred.promise;
  }

  // --- Question ---

  async askQuestion(
    context: NotificationContext,
    requestId: string,
    question: string,
    options: readonly string[]
  ): Promise<string> {
    const userId = this._getUserId(context);
    if (!userId) {
      return '';
    }

    // Deferred Promise を作成
    const deferred = CreateDeferred<string>();
    this._pendingQuestions.set(requestId, deferred);

    // Quick Reply の選択肢を構築（最大13ボタン）
    const items: QuickReplyItem[] = options.slice(0, 13).map((option) => ({
      type: 'action' as const,
      action: {
        type: 'postback' as const,
        label: option.slice(0, 20), // ラベルは20文字まで
        data: `action=answer&requestId=${requestId}&answer=${encodeURIComponent(option)}`,
      },
    }));

    const quickReply: QuickReply = { items };
    const text = `質問があります。\n\n${question}`;

    await this._client!.pushMessage({
      to: userId,
      messages: [{ type: 'text', text, quickReply } as TextMessage],
    });

    return deferred.promise;
  }

  // --- Notifications ---

  async notifyTaskStarted(context: NotificationContext, description: string): Promise<void> {
    const userId = this._getUserId(context);
    if (!userId) return;

    const text = PlainMsg('task.started', { description });
    await this._pushText(userId, text);
  }

  async notifyTaskCompleted(context: NotificationContext, message: string, prUrl?: string): Promise<void> {
    const userId = this._getUserId(context);
    if (!userId) return;

    let text = PlainMsg('task.completed', { message });
    if (prUrl) {
      text += PlainMsg('task.completedPr', { prUrl });
    }
    await this._pushText(userId, text);
  }

  async notifyError(context: NotificationContext, error: string): Promise<void> {
    const userId = this._getUserId(context);
    if (!userId) return;

    const text = PlainMsg('task.error', { error });
    await this._pushText(userId, text);
  }

  async notifyProgress(context: NotificationContext, message: string): Promise<void> {
    const userId = this._getUserId(context);
    if (!userId) return;

    const text = PlainMsg('task.progress', { message });
    await this._pushText(userId, text);
  }

  async notifyWorkLog(
    context: NotificationContext,
    logType: string,
    message: string,
    _details?: string
  ): Promise<void> {
    const userId = this._getUserId(context);
    if (!userId) return;

    // 作業ログは簡潔に（LINEではスレッドがないため頻繁な通知を避ける）
    // approval_pending のみ通知
    if (logType !== 'approval_pending') {
      return;
    }

    await this._pushText(userId, `${PlainMsg('task.progress', { message })}`);
  }

  // --- Special ---

  async postReflectionResult(result: ReflectionResult): Promise<void> {
    // LINE では内省レポートは全許可ユーザーに送信
    const users = this._config.allowedUsers.line;
    if (users.length === 0) return;

    // 簡潔な内省レポートを構築
    const summaries = result.userReflections.map((r) => r.summary).join('\n\n');
    const text = PlainMsg('reflection.result', {
      date: result.date,
      summaries,
    });

    for (const userId of users) {
      try {
        await this._pushText(userId as string, text);
      } catch (error) {
        console.error(`[LineAdapter] Failed to send reflection to ${userId}:`, error);
      }
    }
  }

  async createIssueThread(
    _owner: string,
    _repo: string,
    _issueNumber: number,
    _issueTitle: string,
    _issueUrl: string
  ): Promise<string> {
    // LINE にはスレッド概念がないため no-op
    return '';
  }

  // --- Private Helpers ---

  /**
   * NotificationContext から LINE userId を抽出する
   */
  private _getUserId(context: NotificationContext): string | undefined {
    if (context.metadata.source === 'line') {
      return (context.metadata as LineTaskMetadata).userId;
    }
    console.warn(`[LineAdapter] Cannot extract userId from source: ${context.metadata.source}`);
    return undefined;
  }

  /**
   * pushMessage でテキストを送信する
   */
  private async _pushText(userId: string, text: string): Promise<void> {
    if (!this._client) return;

    // LINE の文字数制限を超える場合は分割送信
    if (text.length > LINE_MAX_MESSAGE_LENGTH) {
      const chunks = SplitMessage(text, LINE_MAX_MESSAGE_LENGTH);
      for (let i = 0; i < chunks.length; i += LINE_MAX_MESSAGES_PER_PUSH) {
        const batch = chunks.slice(i, i + LINE_MAX_MESSAGES_PER_PUSH);
        const messages: TextMessage[] = batch.map((t) => ({
          type: 'text' as const,
          text: t,
        }));
        await this._client.pushMessage({ to: userId, messages });
      }
      return;
    }

    await this._client.pushMessage({
      to: userId,
      messages: [{ type: 'text' as const, text }],
    });
  }

  /**
   * replyMessage でテキストを返信する（reply token 使用、1回限り）
   */
  private async _replyText(replyToken: string, text: string): Promise<void> {
    if (!this._client) return;

    try {
      await this._client.replyMessage({
        replyToken,
        messages: [{ type: 'text' as const, text }],
      });
    } catch (error) {
      // reply token の有効期限切れ等は無視
      console.warn('[LineAdapter] Reply failed (token may be expired):', error);
    }
  }
}
