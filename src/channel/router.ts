/**
 * claps - 通知ルーター
 * タスクメタデータからアダプタを解決し、通知を委譲する
 */

import type {
  TaskMetadata,
  ApprovalResult,
  ReflectionResult,
  NotificationContext,
} from '../types/index.js';
import type { AdapterRegistry } from './registry.js';
import type { ChannelAdapter } from './adapter.js';

/**
 * NotificationRouter
 * タスクのメタデータから起動元アダプタを解決し、全通知呼び出しを委譲する
 */
export class NotificationRouter {
  constructor(private readonly _registry: AdapterRegistry) {}

  /**
   * メタデータからアダプタを解決する
   * - source に対応するアダプタがあればそれを返す
   * - なければデフォルトアダプタにフォールバック（GitHub → Slack）
   */
  private _resolveAdapter(metadata: TaskMetadata): ChannelAdapter {
    const adapter = this._registry.getAdapter(metadata.source);
    if (adapter) return adapter;

    // フォールバック（GitHub Issue等はSlackに通知）
    const defaultAdapter = this._registry.getDefaultAdapter();
    if (defaultAdapter) return defaultAdapter;

    throw new Error(`No adapter found for source: ${metadata.source}`);
  }

  /**
   * NotificationContext を構築する
   */
  private _makeContext(taskId: string, metadata: TaskMetadata): NotificationContext {
    return { taskId, metadata };
  }

  // --- Messaging ---

  async sendMessage(taskId: string, metadata: TaskMetadata, message: string): Promise<void> {
    const adapter = this._resolveAdapter(metadata);
    const context = this._makeContext(taskId, metadata);
    await adapter.sendMessage(context, message);
  }

  async sendSplitMessage(taskId: string, metadata: TaskMetadata, message: string): Promise<void> {
    const adapter = this._resolveAdapter(metadata);
    const context = this._makeContext(taskId, metadata);
    await adapter.sendSplitMessage(context, message);
  }

  // --- Approval ---

  async requestApproval(
    taskId: string,
    metadata: TaskMetadata,
    requestId: string,
    tool: string,
    command: string,
    requestedByUserId?: string
  ): Promise<ApprovalResult> {
    const adapter = this._resolveAdapter(metadata);
    const context = this._makeContext(taskId, metadata);
    return adapter.requestApproval(context, requestId, tool, command, requestedByUserId);
  }

  // --- Question ---

  async askQuestion(
    taskId: string,
    metadata: TaskMetadata,
    requestId: string,
    question: string,
    options: readonly string[]
  ): Promise<string> {
    const adapter = this._resolveAdapter(metadata);
    const context = this._makeContext(taskId, metadata);
    return adapter.askQuestion(context, requestId, question, options);
  }

  // --- Notifications ---

  async notifyTaskStarted(taskId: string, metadata: TaskMetadata, description: string): Promise<void> {
    const adapter = this._resolveAdapter(metadata);
    const context = this._makeContext(taskId, metadata);
    await adapter.notifyTaskStarted(context, description);
  }

  async notifyTaskCompleted(
    taskId: string,
    metadata: TaskMetadata,
    message: string,
    prUrl?: string
  ): Promise<void> {
    const adapter = this._resolveAdapter(metadata);
    const context = this._makeContext(taskId, metadata);
    await adapter.notifyTaskCompleted(context, message, prUrl);
  }

  async notifyError(taskId: string, metadata: TaskMetadata, error: string): Promise<void> {
    const adapter = this._resolveAdapter(metadata);
    const context = this._makeContext(taskId, metadata);
    await adapter.notifyError(context, error);
  }

  async notifyProgress(taskId: string, metadata: TaskMetadata, message: string): Promise<void> {
    const adapter = this._resolveAdapter(metadata);
    const context = this._makeContext(taskId, metadata);
    await adapter.notifyProgress(context, message);
  }

  async notifyWorkLog(
    taskId: string,
    metadata: TaskMetadata,
    logType: string,
    message: string,
    details?: string
  ): Promise<void> {
    const adapter = this._resolveAdapter(metadata);
    const context = this._makeContext(taskId, metadata);
    await adapter.notifyWorkLog(context, logType, message, details);
  }

  // --- Special ---

  /**
   * 内省結果を投稿（全アクティブアダプタに送信）
   */
  async postReflectionResult(result: ReflectionResult): Promise<void> {
    const activeAdapters = this._registry.getActiveAdapters();
    if (activeAdapters.length === 0) {
      console.error('No active adapters for reflection result');
      return;
    }
    for (const adapter of activeAdapters) {
      try {
        await adapter.postReflectionResult(result);
      } catch (error) {
        console.error(`Failed to post reflection result to ${adapter.getName()}:`, error);
      }
    }
  }

  /**
   * Issue用の通知スレッドを作成（デフォルトアダプタに委譲）
   */
  async createIssueThread(
    owner: string,
    repo: string,
    issueNumber: number,
    issueTitle: string,
    issueUrl: string
  ): Promise<string> {
    const adapter = this._registry.getDefaultAdapter();
    if (!adapter) {
      console.error('No default adapter for issue thread');
      return '';
    }
    return adapter.createIssueThread(owner, repo, issueNumber, issueTitle, issueUrl);
  }
}
