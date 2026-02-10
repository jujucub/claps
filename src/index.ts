/**
 * sumomo - メインエントリーポイント
 * GitHub Issue / Slack 連携 Claude 自動対応システム
 */

import { LoadConfig } from './config.js';
import type { App } from '@slack/bolt';
import type { Config, GitHubTaskMetadata, SlackTaskMetadata, Task } from './types/index.js';
import { GetTaskQueue, type TaskQueue } from './queue/taskQueue.js';
import { GetClaudeRunner, type ClaudeRunner, type WorkLog } from './claude/runner.js';
import { GetSessionStore } from './session/store.js';
import {
  InitSlackBot,
  StartSlackBot,
  StopSlackBot,
  GetSlackBot,
} from './slack/bot.js';
import {
  RegisterSlackHandlers,
  NotifyTaskCompleted,
  NotifyError,
  NotifyProgress,
  NotifyWorkLog,
  CreateIssueThread,
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
import {
  CommitAndPush,
  CleanupAllWorktrees,
  GetOrCreateWorktree,
  RemoveWorktree,
  InitializeWorkspace,
} from './git/worktree.js';
import { GetOrCloneRepo, GetWorkspacePath } from './git/repo.js';
import {
  GetSlackUserForGitHub,
  GetAdminSlackUser,
} from './admin/store.js';
import { SetupGlobalMcpConfig } from './mcp/setup.js';

// 作業ログの投稿間隔（ミリ秒）
const WORK_LOG_INTERVAL_MS = 10000;

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
  console.log('🍑 すももを起動するのでーす！');

  // 設定を読み込む
  _config = LoadConfig();

  // MCP設定をセットアップ（~/.claude.jsonに追加）
  SetupGlobalMcpConfig();

  // 汎用ワークスペースを初期化（hook設定を注入）
  const workspacePath = GetWorkspacePath();
  await InitializeWorkspace(workspacePath);

  // コンポーネントを初期化
  _taskQueue = GetTaskQueue();
  _claudeRunner = GetClaudeRunner();

  // Slack Bot を初期化・起動
  const slackApp = InitSlackBot(_config);
  RegisterSlackHandlers(slackApp, _config.slackChannelId, HandleSlackMention, _config.allowedUsers);
  await StartSlackBot();

  // 承認サーバーを初期化・起動
  InitApprovalServer(slackApp, _config.slackChannelId);
  await StartApprovalServer(_config.approvalServerPort);

  // GitHub Poller を初期化・開始
  InitGitHubPoller(_config);
  StartGitHubPoller(_config, HandleGitHubIssue, HandleIssueClosed);

  // タスクキューのイベントを監視
  _taskQueue.On('added', OnTaskAdded);

  _isRunning = true;
  console.log('🍑 すももの起動完了であります！');
}

/**
 * アプリケーションを停止する
 */
async function Stop(): Promise<void> {
  console.log('🍑 すももを停止するのでーす...');

  _isRunning = false;

  // 各コンポーネントを停止
  StopGitHubPoller();
  await StopApprovalServer();
  await StopSlackBot();

  // worktree をクリーンアップ
  await CleanupAllWorktrees();

  console.log('🍑 すもも、おやすみなさいなのです！');
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

  // Slack にスレッドを作成
  const slackApp = GetSlackBot();
  const threadTs = await CreateIssueThread(
    slackApp,
    _config.slackChannelId,
    metadata.owner,
    metadata.repo,
    metadata.issueNumber,
    metadata.issueTitle,
    metadata.issueUrl
  );

  // スレッドTsをmetadataに保存
  const metadataWithThread: GitHubTaskMetadata = {
    ...metadata,
    slackThreadTs: threadTs,
  };

  // スレッドとIssueを紐付け（スレッドでの追加メンション用）
  const sessionStore = GetSessionStore();
  sessionStore.LinkThreadToIssue(threadTs, metadata.owner, metadata.repo, metadata.issueNumber);

  // タスクをキューに追加
  const task = _taskQueue.AddTask('github', prompt, metadataWithThread);

  console.log(`Task added from GitHub: ${task.id} (thread: ${threadTs})`);
}

/**
 * GitHub Issue がクローズされたときの処理
 */
async function HandleIssueClosed(
  owner: string,
  repo: string,
  issueNumber: number
): Promise<void> {
  console.log(`Issue closed: ${owner}/${repo}#${issueNumber}`);

  const sessionStore = GetSessionStore();

  // スレッドとIssueの紐付けを解除
  sessionStore.UnlinkThreadForIssue(owner, repo, issueNumber);

  // セッションを削除
  const hadSession = sessionStore.DeleteForIssue(owner, repo, issueNumber);
  if (hadSession) {
    console.log(`Session deleted for issue #${issueNumber}`);
  }

  // worktree を削除
  try {
    await RemoveWorktree(owner, repo, issueNumber);
    console.log(`Worktree removed for issue #${issueNumber}`);
  } catch (error) {
    console.error(`Failed to remove worktree for issue #${issueNumber}:`, error);
  }
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
  const threadTs = GetThreadTs(task);
  const requestedBySlackId = GetRequestedBySlackId(task);
  SetCurrentTaskId(task.id, threadTs, requestedBySlackId);

  console.log(`Processing task: ${task.id} (requestedBy: ${requestedBySlackId ?? 'none'})`);

  try {
    let result: { success: boolean; output: string; prUrl?: string; error?: string };

    if (task.metadata.source === 'github') {
      // GitHub Issue の場合は worktree で処理
      result = await ProcessGitHubTask(task);
    } else {
      // Slack の場合
      const slackApp = GetSlackBot();
      const slackMeta = task.metadata;
      const sessionStore = GetSessionStore();

      // Issue用スレッドかどうかをチェック
      const linkedIssue = sessionStore.GetIssueForThread(slackMeta.threadTs);

      if (linkedIssue) {
        // Issue用スレッドの場合: Issueのセッションとworktreeを使用
        console.log(`Thread ${slackMeta.threadTs} is linked to issue #${linkedIssue.issueNumber}`);
        result = await ProcessSlackAsIssueTask(task, linkedIssue);
      } else if (slackMeta.targetRepo) {
        // targetRepoが指定されている場合: そのリポジトリのworktreeで作業
        console.log(`Processing with target repo: ${slackMeta.targetRepo}`);
        result = await ProcessSlackWithTargetRepo(task, slackMeta.targetRepo);
      } else {
        // スレッドにtargetRepoが紐づいているかチェック（スラッシュコマンドで開始したスレッド）
        const linkedTargetRepo = sessionStore.GetTargetRepoForThread(slackMeta.threadTs);
        if (linkedTargetRepo) {
          console.log(`Thread ${slackMeta.threadTs} is linked to target repo: ${linkedTargetRepo}`);
          result = await ProcessSlackWithTargetRepo(task, linkedTargetRepo);
        } else {
        // 通常のSlackタスク
        // 同じスレッドの既存セッションを取得
        const existingSessionId = sessionStore.Get(slackMeta.threadTs, slackMeta.userId);
        if (existingSessionId) {
          console.log(`Resuming existing session for thread ${slackMeta.threadTs}: ${existingSessionId}`);
        } else {
          console.log(`Creating new session for thread ${slackMeta.threadTs}`);
        }

        const onWorkLog = CreateWorkLogCallback(slackApp, _config!.slackChannelId, slackMeta.threadTs);

        // Slackコンテキストをプロンプトに追加
        const promptWithContext = task.prompt + BuildSlackContext(
          slackMeta.userId,
          slackMeta.channelId,
          slackMeta.threadTs,
          _config.githubRepos
        );

        const runResult = await _claudeRunner.Run(task.id, promptWithContext, {
          workingDirectory: GetWorkspacePath(),
          onWorkLog,
          resumeSessionId: existingSessionId,
          approvalServerPort: _config.approvalServerPort,
        });

        // 新しいセッションIDが返された場合は保存
        if (runResult.sessionId) {
          sessionStore.Set(slackMeta.threadTs, slackMeta.userId, runResult.sessionId);
          console.log(`Session saved for thread ${slackMeta.threadTs}: ${runResult.sessionId}`);
        }

        result = runResult;
        }
      }
    }

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
 * Issue用スレッドでのSlackメンションをIssueとして処理する
 */
async function ProcessSlackAsIssueTask(
  task: Task,
  issueInfo: { owner: string; repo: string; issueNumber: number }
): Promise<{ success: boolean; output: string; prUrl?: string; error?: string }> {
  if (!_config || !_claudeRunner) {
    return { success: false, output: '', error: 'Not initialized' };
  }

  const slackMeta = task.metadata as SlackTaskMetadata;
  const slackApp = GetSlackBot();
  const sessionStore = GetSessionStore();

  try {
    // リポジトリをクローン（または更新）
    const repoPath = await GetOrCloneRepo(
      issueInfo.owner,
      issueInfo.repo,
      _config.githubToken
    );

    // 既存の worktree を取得（なければ作成）
    const { worktreeInfo, isExisting } = await GetOrCreateWorktree(
      repoPath,
      issueInfo.owner,
      issueInfo.repo,
      issueInfo.issueNumber
    );

    if (isExisting) {
      await NotifyProgress(
        slackApp,
        _config.slackChannelId,
        `Issue #${issueInfo.issueNumber} の作業を継続するのでーす！`,
        slackMeta.threadTs
      );
    }

    // Issueのセッションを取得
    const existingSessionId = sessionStore.GetForIssue(
      issueInfo.owner,
      issueInfo.repo,
      issueInfo.issueNumber
    );
    if (existingSessionId) {
      console.log(`Resuming issue session: ${existingSessionId}`);
    } else {
      console.log(`Creating new session for issue #${issueInfo.issueNumber}`);
    }

    const onWorkLog = CreateWorkLogCallback(slackApp, _config!.slackChannelId, slackMeta.threadTs);

    // Slackコンテキストをプロンプトに追加して Claude CLI を実行
    const promptWithContext = task.prompt + BuildSlackContext(
      slackMeta.userId,
      slackMeta.channelId,
      slackMeta.threadTs,
      _config!.githubRepos
    );

    const runResult = await _claudeRunner.Run(task.id, promptWithContext, {
      workingDirectory: worktreeInfo.worktreePath,
      onWorkLog,
      resumeSessionId: existingSessionId,
      approvalServerPort: _config.approvalServerPort,
    });

    // セッションIDを保存
    if (runResult.sessionId) {
      sessionStore.SetForIssue(issueInfo.owner, issueInfo.repo, issueInfo.issueNumber, runResult.sessionId);
    }

    // 変更があればコミット＆プッシュ
    const commitMessage = `fix: Issue #${issueInfo.issueNumber} - additional changes`;
    const hasChanges = await CommitAndPush(worktreeInfo, commitMessage);

    if (hasChanges) {
      await NotifyProgress(
        slackApp,
        _config.slackChannelId,
        '変更をコミット＆プッシュしたのでーす！',
        slackMeta.threadTs
      );
    }

    return {
      success: runResult.success,
      output: runResult.output,
      error: runResult.error,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`ProcessSlackAsIssueTask error: ${errorMessage}`);
    return {
      success: false,
      output: '',
      error: errorMessage,
    };
  }
}

/**
 * 指定されたリポジトリのworktreeでSlackタスクを処理する
 */
async function ProcessSlackWithTargetRepo(
  task: Task,
  targetRepo: string
): Promise<{ success: boolean; output: string; prUrl?: string; error?: string }> {
  if (!_config || !_claudeRunner) {
    return { success: false, output: '', error: 'Not initialized' };
  }

  const slackMeta = task.metadata as SlackTaskMetadata;
  const slackApp = GetSlackBot();
  const sessionStore = GetSessionStore();

  // owner/repo を分離（バリデーション済みなので必ず2要素）
  const parts = targetRepo.split('/');
  const owner = parts[0] as string;
  const repo = parts[1] as string;

  try {
    // リポジトリをクローン（または更新）
    console.log(`Getting or cloning repo ${targetRepo}...`);
    const repoPath = await GetOrCloneRepo(owner, repo, _config.githubToken);

    // スレッドにtargetRepoを紐づける（同じスレッドでのメンションも同じworktreeで作業するため）
    sessionStore.LinkThreadToTargetRepo(slackMeta.threadTs, targetRepo);

    // スレッドIDからworktree用の識別子を生成（短いハッシュ）
    const threadHash = slackMeta.threadTs.replace('.', '').slice(-8);
    const worktreeIdentifier = parseInt(threadHash, 10) || Date.now();

    // worktree を取得または作成
    const { worktreeInfo, isExisting } = await GetOrCreateWorktree(
      repoPath,
      owner,
      repo,
      worktreeIdentifier
    );

    if (isExisting) {
      await NotifyProgress(
        slackApp,
        _config.slackChannelId,
        `既存のブランチ \`${worktreeInfo.branchName}\` で作業を継続するのでーす！`,
        slackMeta.threadTs
      );
    } else {
      await NotifyProgress(
        slackApp,
        _config.slackChannelId,
        `ブランチ \`${worktreeInfo.branchName}\` で作業を開始するのです！`,
        slackMeta.threadTs
      );
    }

    // セッションを取得（スレッド+ユーザー単位）
    const existingSessionId = sessionStore.Get(slackMeta.threadTs, slackMeta.userId);
    if (existingSessionId) {
      console.log(`Resuming existing session: ${existingSessionId}`);
    } else {
      console.log(`Creating new session for thread ${slackMeta.threadTs}`);
    }

    const onWorkLog = CreateWorkLogCallback(slackApp, _config!.slackChannelId, slackMeta.threadTs);

    // コンテキストをプロンプトに追加
    const promptWithContext = task.prompt + BuildSlackRepoContext(
      slackMeta.userId,
      slackMeta.channelId,
      slackMeta.threadTs,
      targetRepo,
      worktreeInfo.branchName
    );

    const runResult = await _claudeRunner.Run(task.id, promptWithContext, {
      workingDirectory: worktreeInfo.worktreePath,
      onWorkLog,
      resumeSessionId: existingSessionId,
      approvalServerPort: _config.approvalServerPort,
    });

    return {
      success: runResult.success,
      output: runResult.output,
      prUrl: runResult.prUrl,
      error: runResult.error,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`ProcessSlackWithTargetRepo error: ${errorMessage}`);
    return {
      success: false,
      output: '',
      error: errorMessage,
    };
  }
}

/**
 * GitHub Issue タスクを worktree で処理する（セッション継続対応）
 */
async function ProcessGitHubTask(
  task: Task
): Promise<{ success: boolean; output: string; prUrl?: string; error?: string }> {
  if (!_config || !_claudeRunner) {
    return { success: false, output: '', error: 'Not initialized' };
  }

  const meta = task.metadata as GitHubTaskMetadata;
  const slackApp = GetSlackBot();
  const threadTs = meta.slackThreadTs;
  const sessionStore = GetSessionStore();

  try {
    // リポジトリをクローン（または更新）
    console.log(`Getting or cloning repo ${meta.owner}/${meta.repo}...`);
    const repoPath = await GetOrCloneRepo(meta.owner, meta.repo, _config.githubToken);

    // 既存の worktree があれば再利用、なければ新規作成
    console.log(`Getting or creating worktree for issue #${meta.issueNumber}...`);

    const { worktreeInfo, isExisting } = await GetOrCreateWorktree(
      repoPath,
      meta.owner,
      meta.repo,
      meta.issueNumber
    );

    if (isExisting) {
      await NotifyProgress(
        slackApp,
        _config.slackChannelId,
        `既存のブランチ \`${worktreeInfo.branchName}\` で作業を継続するのでーす！`,
        threadTs
      );
    } else {
      await NotifyProgress(
        slackApp,
        _config.slackChannelId,
        `ブランチ \`${worktreeInfo.branchName}\` で作業を開始するのです！`,
        threadTs
      );
    }

    // 同じIssueの既存セッションを取得
    const existingSessionId = sessionStore.GetForIssue(meta.owner, meta.repo, meta.issueNumber);
    if (existingSessionId) {
      console.log(`Resuming existing session for issue #${meta.issueNumber}: ${existingSessionId}`);
      await NotifyProgress(
        slackApp,
        _config.slackChannelId,
        '前回のセッションを継続するのでーす！',
        threadTs
      );
    } else {
      console.log(`Creating new session for issue #${meta.issueNumber}`);
    }

    // Claude 用のプロンプトを構築（GitHub情報とSlack情報を含む）
    const worktreePrompt = task.prompt + BuildGitHubContext(
      meta,
      worktreeInfo.branchName,
      _config.slackChannelId,
      threadTs
    );

    await NotifyProgress(slackApp, _config.slackChannelId, 'Claude を起動中なのでーす！', threadTs);

    const onWorkLog = CreateWorkLogCallback(slackApp, _config!.slackChannelId, threadTs);

    const runResult = await _claudeRunner.Run(task.id, worktreePrompt, {
      workingDirectory: worktreeInfo.worktreePath,
      onWorkLog,
      resumeSessionId: existingSessionId,
      approvalServerPort: _config.approvalServerPort,
    });

    // セッションIDを保存
    if (runResult.sessionId) {
      sessionStore.SetForIssue(meta.owner, meta.repo, meta.issueNumber, runResult.sessionId);
    }

    // Claude CLIの結果をそのまま返す（コミット・PR作成はLLMが判断して実行）
    return {
      success: runResult.success,
      output: runResult.output,
      prUrl: runResult.prUrl,
      error: runResult.error,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`ProcessGitHubTask error: ${errorMessage}`);
    return {
      success: false,
      output: '',
      error: errorMessage,
    };
  }
  // 注意: worktreeは削除せずに維持（セッション継続のため）
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
      message = '処理が完了したのでーす！（出力なしなのです）';
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
      let comment = '🍑 すももが処理を完了したのでーす！お疲れ様でした！';
      if (result.prUrl) {
        comment += `\n\nPRを作成したのです: ${result.prUrl}`;
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
  if (task.metadata.source === 'github') {
    return task.metadata.slackThreadTs;
  }
  return undefined;
}

/**
 * Slackコンテキスト情報をプロンプトに追加する
 */
function BuildSlackContext(
  userId: string,
  channelId: string,
  threadTs: string,
  githubRepos: readonly string[]
): string {
  const reposList = githubRepos.map(repo => `  - ${repo}`).join('\n');
  return `
---
Slackコンテキスト情報:
- Channel ID: ${channelId}
- Thread TS: ${threadTs}
- User ID: ${userId}
- このユーザーへの返信は <@${userId}> でメンションできます

監視対象GitHubリポジトリ:
${reposList}
---`;
}

/**
 * 指定リポジトリでのSlackコンテキスト情報をプロンプトに追加する
 */
function BuildSlackRepoContext(
  userId: string,
  channelId: string,
  threadTs: string,
  targetRepo: string,
  branchName: string
): string {
  return `
---
Slackコンテキスト情報:
- Channel ID: ${channelId}
- Thread TS: ${threadTs}
- User ID: ${userId}
- このユーザーへの返信は <@${userId}> でメンションできます

作業リポジトリ:
- リポジトリ: ${targetRepo}
- 作業ブランチ: ${branchName}

目標:
- リクエストされた内容を実装してください
- 実装が完了したら、コミットしてPull Requestを作成してください
---`;
}

/**
 * GitHub Issueコンテキスト情報をプロンプトに追加する
 */
function BuildGitHubContext(
  meta: GitHubTaskMetadata,
  branchName: string,
  slackChannelId: string,
  slackThreadTs?: string
): string {
  return `
---
GitHub Issue コンテキスト:
- リポジトリ: ${meta.owner}/${meta.repo}
- Issue: #${meta.issueNumber} - ${meta.issueTitle}
- Issue URL: ${meta.issueUrl}
- 作業ブランチ: ${branchName}
${meta.requestingUser ? `- リクエストユーザー: ${meta.requestingUser}` : ''}

Slack通知先:
- Channel ID: ${slackChannelId}
${slackThreadTs ? `- Thread TS: ${slackThreadTs}` : ''}

目標:
- このIssueを解決するコードを実装してください
- 実装が完了したら、コミットしてPull Requestを作成してください
- PRのタイトルには Issue番号を含めてください（例: fix: #${meta.issueNumber} - 説明）
---`;
}

/**
 * 作業ログを Slack に投稿するコールバックを生成する
 */
function CreateWorkLogCallback(
  slackApp: App,
  channelId: string,
  threadTs?: string
): (log: WorkLog) => void {
  let lastWorkLogTime = 0;

  return async (log: WorkLog) => {
    // 投稿するログタイプを絞る：現在何をしているか（tool_start）と許可・不許可（approval_pending）のみ
    if (log.type !== 'tool_start' && log.type !== 'approval_pending') {
      return;
    }

    const now = Date.now();
    // approval_pending は常に投稿、それ以外は間隔を空ける
    if (log.type !== 'approval_pending') {
      if (now - lastWorkLogTime < WORK_LOG_INTERVAL_MS) return;
    }
    lastWorkLogTime = now;

    try {
      await NotifyWorkLog(
        slackApp,
        channelId,
        log.type,
        log.message,
        log.details,
        threadTs
      );
    } catch (e) {
      console.error('Failed to post work log to Slack:', e);
    }
  };
}

/**
 * タスクから承認権限を持つSlackユーザーIDを取得する
 */
function GetRequestedBySlackId(task: Task): string | undefined {
  if (task.metadata.source === 'slack') {
    // Slackからのリクエストはそのユーザーが承認権限を持つ
    return task.metadata.userId;
  }

  if (task.metadata.source === 'github') {
    // GitHubからのリクエストはマッピングから解決
    const githubUser = task.metadata.requestingUser;
    if (githubUser) {
      const slackUserId = GetSlackUserForGitHub(githubUser);
      if (slackUserId) {
        return slackUserId;
      }
    }
    // マッピングがない場合は管理者に通知
    return GetAdminSlackUser();
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
        text: '🍑 朝でーす！すももが起動したのでーす！@sumomo でメンションしてくださいなのです！',
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
