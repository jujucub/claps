/**
 * claps - Slack チャネルアダプタ
 * 既存の Slack 連携機能を ChannelAdapter インターフェースでラップする
 */

import type { App } from '@slack/bolt';
import type {
  TaskSource,
  Config,
  ApprovalResult,
  ReflectionResult,
  SlackTaskMetadata,
  GitHubTaskMetadata,
  HealthStatus,
  NotificationContext,
  AdapterCallbacks,
} from '../types/index.js';
import type { ChannelAdapter } from '../channel/adapter.js';
import { SplitMessage } from '../channel/formatter.js';
import { InitSlackBot, StartSlackBot, StopSlackBot, GetSlackBot } from './bot.js';
import {
  RegisterSlackHandlers,
  NotifyTaskStarted as SlackNotifyTaskStarted,
  NotifyTaskCompleted as SlackNotifyTaskCompleted,
  NotifyError as SlackNotifyError,
  NotifyProgress as SlackNotifyProgress,
  NotifyWorkLog as SlackNotifyWorkLog,
  RequestApproval as SlackRequestApproval,
  AskQuestion as SlackAskQuestion,
  CreateIssueThread as SlackCreateIssueThread,
  PostReflectionResult as SlackPostReflectionResult,
  SetSuggestionApprovedCallback,
} from './handlers.js';

// Slack メッセージブロックの最大文字数
const SLACK_MAX_MESSAGE_LENGTH = 4000;

/**
 * SlackAdapter
 * 既存の Slack Bot / handlers を ChannelAdapter インターフェースでラップする
 */
export class SlackAdapter implements ChannelAdapter {
  private readonly _config: Config;
  private _slackApp: App | undefined;
  private _callbacks: AdapterCallbacks | undefined;
  private _started = false;

  constructor(config: Config) {
    this._config = config;
  }

  getName(): string {
    return 'slack';
  }

  getSource(): TaskSource {
    return 'slack';
  }

  // --- Lifecycle ---

  async init(callbacks: AdapterCallbacks): Promise<void> {
    this._callbacks = callbacks;
    this._slackApp = InitSlackBot(this._config);

    // Bolt フレームワークレベルのエラーハンドラ
    this._slackApp.error(async (error) => {
      console.error('[SlackAdapter] Bolt framework error:', error);
    });

    // 全イベント診断ミドルウェア（イベントが Bolt に届いているか確認）
    this._slackApp.use(async (args) => {
      const body = args.body as Record<string, unknown>;
      const evt = body['event'] as Record<string, string> | undefined;
      console.log(`[SlackAdapter:middleware] type=${body['type']}, event=${evt?.['type'] ?? 'none'}`);
      await args.next();
    });
  }

  async start(): Promise<void> {
    if (!this._slackApp || !this._callbacks) {
      throw new Error('SlackAdapter not initialized');
    }

    console.log('SlackAdapter: Registering handlers...');

    // SlackTaskMetadata を TaskMetadata として渡す（構造的部分型で互換）
    RegisterSlackHandlers(
      this._slackApp,
      this._config.slackChannelId,
      this._callbacks.onMessage,
      this._config.allowedUsers
    );

    // 提案承認時のコールバック
    SetSuggestionApprovedCallback(this._callbacks.onMessage);

    console.log('SlackAdapter: Starting Socket Mode...');
    await StartSlackBot();
    this._started = true;
    console.log('SlackAdapter: Started successfully');
  }

  async stop(): Promise<void> {
    await StopSlackBot();
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
    if (this._config.allowedUsers.slack.length === 0) return false;
    return this._config.allowedUsers.slack.includes(userId);
  }

  // --- Helpers ---

  /** コンテキストからSlack通知用のchannelIdとthreadTsを抽出 */
  private _extractSlackParams(context: NotificationContext): {
    app: App;
    channelId: string;
    threadTs: string | undefined;
  } {
    const app = GetSlackBot();
    const meta = context.metadata;

    if (meta.source === 'slack') {
      const slackMeta = meta as SlackTaskMetadata;
      return {
        app,
        channelId: slackMeta.channelId,
        threadTs: slackMeta.threadTs,
      };
    }

    if (meta.source === 'github') {
      const githubMeta = meta as GitHubTaskMetadata;
      return {
        app,
        channelId: this._config.slackChannelId,
        threadTs: githubMeta.slackThreadTs,
      };
    }

    // フォールバック（github以外のソースがSlackにルーティングされた場合）
    return {
      app,
      channelId: this._config.slackChannelId,
      threadTs: undefined,
    };
  }

  // --- Messaging ---

  async sendMessage(context: NotificationContext, message: string): Promise<void> {
    const { app, channelId, threadTs } = this._extractSlackParams(context);
    await app.client.chat.postMessage({
      channel: channelId,
      text: message,
      thread_ts: threadTs,
    });
  }

  async sendSplitMessage(context: NotificationContext, message: string): Promise<void> {
    const chunks = SplitMessage(message, SLACK_MAX_MESSAGE_LENGTH);
    const { app, channelId, threadTs } = this._extractSlackParams(context);
    for (const chunk of chunks) {
      await app.client.chat.postMessage({
        channel: channelId,
        text: chunk,
        thread_ts: threadTs,
      });
    }
  }

  // --- Approval ---

  async requestApproval(
    context: NotificationContext,
    requestId: string,
    tool: string,
    command: string,
    requestedByUserId?: string
  ): Promise<ApprovalResult> {
    const { app, channelId, threadTs } = this._extractSlackParams(context);
    return SlackRequestApproval(
      app,
      channelId,
      requestId,
      context.taskId,
      tool,
      command,
      threadTs,
      requestedByUserId
    );
  }

  // --- Question ---

  async askQuestion(
    context: NotificationContext,
    requestId: string,
    question: string,
    options: readonly string[]
  ): Promise<string> {
    const { app, channelId, threadTs } = this._extractSlackParams(context);
    return SlackAskQuestion(
      app,
      channelId,
      requestId,
      context.taskId,
      question,
      options,
      threadTs
    );
  }

  // --- Notifications ---

  async notifyTaskStarted(context: NotificationContext, description: string): Promise<void> {
    const { app, channelId, threadTs } = this._extractSlackParams(context);
    await SlackNotifyTaskStarted(app, channelId, context.taskId, description, threadTs);
  }

  async notifyTaskCompleted(context: NotificationContext, message: string, prUrl?: string): Promise<void> {
    const { app, channelId, threadTs } = this._extractSlackParams(context);
    await SlackNotifyTaskCompleted(app, channelId, context.taskId, message, prUrl, threadTs);
  }

  async notifyError(context: NotificationContext, error: string): Promise<void> {
    const { app, channelId, threadTs } = this._extractSlackParams(context);
    await SlackNotifyError(app, channelId, context.taskId, error, threadTs);
  }

  async notifyProgress(context: NotificationContext, message: string): Promise<void> {
    const { app, channelId, threadTs } = this._extractSlackParams(context);
    await SlackNotifyProgress(app, channelId, message, threadTs);
  }

  async notifyWorkLog(
    context: NotificationContext,
    logType: string,
    message: string,
    details?: string
  ): Promise<void> {
    const { app, channelId, threadTs } = this._extractSlackParams(context);
    await SlackNotifyWorkLog(
      app,
      channelId,
      logType as 'tool_start' | 'tool_end' | 'thinking' | 'text' | 'error' | 'approval_pending',
      message,
      details,
      threadTs
    );
  }

  // --- Special ---

  async postReflectionResult(result: ReflectionResult): Promise<void> {
    const app = GetSlackBot();
    await SlackPostReflectionResult(app, this._config.slackChannelId, result);
  }

  async createIssueThread(
    owner: string,
    repo: string,
    issueNumber: number,
    issueTitle: string,
    issueUrl: string
  ): Promise<string> {
    const app = GetSlackBot();
    return SlackCreateIssueThread(
      app,
      this._config.slackChannelId,
      owner,
      repo,
      issueNumber,
      issueTitle,
      issueUrl
    );
  }
}
