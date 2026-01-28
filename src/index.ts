/**
 * sumomo - メインエントリーポイント
 * GitHub Issue / Slack 連携 Claude 自動対応システム
 */

import { LoadConfig } from './config.js';
import type { Config, GitHubTaskMetadata, SlackTaskMetadata, Task } from './types/index.js';
import { GetTaskQueue, type TaskQueue } from './queue/taskQueue.js';
import { GetClaudeRunner, type ClaudeRunner } from './claude/runner.js';
import {
  InitSlackBot,
  StartSlackBot,
  StopSlackBot,
  GetSlackBot,
} from './slack/bot.js';
import {
  RegisterSlackHandlers,
  NotifyTaskStarted,
  NotifyTaskCompleted,
  NotifyError,
} from './slack/handlers.js';
import {
  InitGitHubPoller,
  StartGitHubPoller,
  StopGitHubPoller,
  PostIssueComment,
} from './github/poller.js';
import {
  InitApprovalServer,
  StartApprovalServer,
  StopApprovalServer,
  SetCurrentTaskId,
  ClearCurrentTaskId,
} from './approval/server.js';

// アプリケーション状態
let _isRunning = false;
let _config: Config | undefined;
let _taskQueue: TaskQueue | undefined;
let _claudeRunner: ClaudeRunner | undefined;
let _isProcessing = false;

/**
 * アプリケーションを起動する
 */
async function Start(): Promise<void> {
  console.log('🍑 sumomo を起動しています...');

  // 設定を読み込む
  _config = LoadConfig();

  // コンポーネントを初期化
  _taskQueue = GetTaskQueue();
  _claudeRunner = GetClaudeRunner();

  // Slack Bot を初期化・起動
  const slackApp = InitSlackBot(_config);
  RegisterSlackHandlers(slackApp, _config.slackChannelId, HandleSlackMention);
  await StartSlackBot();

  // 承認サーバーを初期化・起動
  InitApprovalServer(slackApp, _config.slackChannelId);
  await StartApprovalServer(_config.approvalServerPort);

  // GitHub Poller を初期化・開始
  InitGitHubPoller(_config);
  StartGitHubPoller(_config, HandleGitHubIssue);

  // タスクキューのイベントを監視
  _taskQueue.On('added', OnTaskAdded);

  _isRunning = true;
  console.log('🍑 sumomo が起動しました');
}

/**
 * アプリケーションを停止する
 */
async function Stop(): Promise<void> {
  console.log('🍑 sumomo を停止しています...');

  _isRunning = false;

  // 各コンポーネントを停止
  StopGitHubPoller();
  await StopApprovalServer();
  await StopSlackBot();

  console.log('🍑 sumomo を停止しました');
}

/**
 * Slack メンションを処理する
 */
async function HandleSlackMention(
  metadata: SlackTaskMetadata,
  prompt: string
): Promise<void> {
  if (!_taskQueue || !_config) return;

  // タスクをキューに追加
  const task = _taskQueue.AddTask('slack', prompt, metadata);

  console.log(`Task added from Slack: ${task.id}`);
}

/**
 * GitHub Issue を処理する
 */
async function HandleGitHubIssue(
  metadata: GitHubTaskMetadata,
  prompt: string
): Promise<void> {
  if (!_taskQueue || !_config) return;

  // タスクをキューに追加
  const task = _taskQueue.AddTask('github', prompt, metadata);

  // Slack に通知
  const slackApp = GetSlackBot();
  await NotifyTaskStarted(
    slackApp,
    _config.slackChannelId,
    task.id,
    `Issue #${metadata.issueNumber}: ${metadata.issueTitle}`
  );

  console.log(`Task added from GitHub: ${task.id}`);
}

/**
 * タスクが追加されたときの処理
 */
function OnTaskAdded(_task: Task): void {
  // タスク処理を開始
  void ProcessNextTask();
}

/**
 * 次のタスクを処理する
 */
async function ProcessNextTask(): Promise<void> {
  if (!_taskQueue || !_claudeRunner || !_config) return;
  if (_isProcessing) return;
  if (!_isRunning) return;

  const task = _taskQueue.GetNextTask();
  if (!task) return;

  _isProcessing = true;
  SetCurrentTaskId(task.id);

  console.log(`Processing task: ${task.id}`);

  try {
    // Claude CLI を実行
    const result = await _claudeRunner.Run(task.id, task.prompt, {
      workingDirectory: process.cwd(),
    });

    // タスクを完了としてマーク
    _taskQueue.CompleteTask(task.id, result);

    // 結果を通知
    await NotifyResult(task, result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Task failed: ${task.id}`, error);

    _taskQueue.CompleteTask(task.id, {
      success: false,
      output: '',
      error: errorMessage,
    });

    // エラーを通知
    await NotifyError(
      GetSlackBot(),
      _config.slackChannelId,
      task.id,
      errorMessage,
      GetThreadTs(task)
    );
  } finally {
    ClearCurrentTaskId();
    _isProcessing = false;

    // 次のタスクを処理
    void ProcessNextTask();
  }
}

/**
 * 結果を通知する
 */
async function NotifyResult(
  task: Task,
  result: { success: boolean; output: string; prUrl?: string; error?: string }
): Promise<void> {
  if (!_config) return;

  const slackApp = GetSlackBot();
  const threadTs = GetThreadTs(task);

  if (result.success) {
    // Claudeの出力を送信（長すぎる場合は切り詰め）
    const maxLength = 3000;
    let message = result.output.trim();
    if (message.length > maxLength) {
      message = message.slice(0, maxLength) + '\n...(省略)';
    }
    if (!message) {
      message = '処理が完了しました（出力なし）';
    }

    await NotifyTaskCompleted(
      slackApp,
      _config.slackChannelId,
      task.id,
      message,
      result.prUrl,
      threadTs
    );

    // GitHub Issue の場合はコメントを投稿
    if (task.metadata.source === 'github') {
      const meta = task.metadata;
      let comment = '🍑 sumomo が処理を完了しました。';
      if (result.prUrl) {
        comment += `\n\nPR: ${result.prUrl}`;
      }
      await PostIssueComment(meta.owner, meta.repo, meta.issueNumber, comment);
    }
  } else {
    await NotifyError(
      slackApp,
      _config.slackChannelId,
      task.id,
      result.error ?? '不明なエラー',
      threadTs
    );
  }
}

/**
 * タスクからスレッドタイムスタンプを取得する
 */
function GetThreadTs(task: Task): string | undefined {
  if (task.metadata.source === 'slack') {
    return task.metadata.threadTs;
  }
  return undefined;
}

/**
 * シグナルハンドラーを設定する
 */
function SetupSignalHandlers(): void {
  process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT');
    await Stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM');
    await Stop();
    process.exit(0);
  });

  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    void Stop().then(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
  });
}

/**
 * メインエントリーポイント
 */
async function Main(): Promise<void> {
  SetupSignalHandlers();

  try {
    await Start();

    // 起動通知を送信
    if (_config) {
      const slackApp = GetSlackBot();
      await slackApp.client.chat.postMessage({
        channel: _config.slackChannelId,
        text: '🍑 sumomo が起動しました。@sumomo でメンションしてください。',
      });
    }
  } catch (error) {
    console.error('Failed to start sumomo:', error);
    process.exit(1);
  }
}

Main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
