/**
 * claps - Git Worktree 管理
 * Issue ごとに独立した作業ディレクトリを提供する
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// clapsのPreToolUseフック設定（承認用）
// matcher空文字列で全ツールに対してHookを実行
const CLAPS_APPROVAL_HOOK_CONFIG = {
  matcher: '',
  hooks: [
    {
      type: 'command',
      command: 'python3 "$CLAUDE_PROJECT_DIR"/.claude/hooks/slack-approval.py',
      timeout: 320,
    },
  ],
};

// clapsのPreToolUseフック設定（ツール使用通知用）
const CLAPS_NOTIFY_HOOK_CONFIG = {
  matcher: '.*',
  hooks: [
    {
      type: 'command',
      command: 'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/tool-notify.sh',
      timeout: 5,
    },
  ],
};

export interface WorktreeInfo {
  readonly branchName: string;
  readonly worktreePath: string;
  readonly issueNumber: number;
  readonly owner: string;
  readonly repo: string;
}

const _activeWorktrees = new Map<string, WorktreeInfo>();

/**
 * Issue 用の worktree を作成する
 */
export async function CreateWorktree(
  baseDir: string,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<WorktreeInfo> {
  const branchName = `claps/issue-${issueNumber}`;
  const worktreeDir = path.join(baseDir, '.worktrees', `issue-${issueNumber}`);
  const worktreeKey = `${owner}/${repo}#${issueNumber}`;

  // 既存の worktree がある場合は削除
  if (_activeWorktrees.has(worktreeKey)) {
    await RemoveWorktree(owner, repo, issueNumber);
  }

  // .worktrees ディレクトリを作成
  const worktreesRoot = path.join(baseDir, '.worktrees');
  if (!fs.existsSync(worktreesRoot)) {
    fs.mkdirSync(worktreesRoot, { recursive: true });
  }

  // 最新の main/master を取得
  const defaultBranch = GetDefaultBranch(baseDir);
  execSync(`git fetch origin ${defaultBranch}`, {
    cwd: baseDir,
    stdio: 'pipe',
  });

  // リモートブランチが存在する場合は削除
  try {
    execSync(`git push origin --delete ${branchName}`, {
      cwd: baseDir,
      stdio: 'pipe',
    });
  } catch {
    // ブランチが存在しない場合は無視
  }

  // ローカルブランチが存在する場合は削除
  try {
    execSync(`git branch -D ${branchName}`, {
      cwd: baseDir,
      stdio: 'pipe',
    });
  } catch {
    // ブランチが存在しない場合は無視
  }

  // 既存の worktree ディレクトリを削除
  if (fs.existsSync(worktreeDir)) {
    try {
      execSync(`git worktree remove --force "${worktreeDir}"`, {
        cwd: baseDir,
        stdio: 'pipe',
      });
    } catch {
      // worktree が存在しない場合は無視
    }
    // ディレクトリが残っている場合は強制削除
    if (fs.existsSync(worktreeDir)) {
      fs.rmSync(worktreeDir, { recursive: true, force: true });
    }
  }

  // 新しいブランチで worktree を作成
  execSync(
    `git worktree add -b ${branchName} "${worktreeDir}" origin/${defaultBranch}`,
    {
      cwd: baseDir,
      stdio: 'pipe',
    }
  );

  // clapsのPreToolUseフック設定を注入 + プロジェクト信頼を確立
  await InjectClaudeSettings(worktreeDir);
  await WarmUpClaudeProject(worktreeDir);

  const info: WorktreeInfo = {
    branchName,
    worktreePath: worktreeDir,
    issueNumber,
    owner,
    repo,
  };

  _activeWorktrees.set(worktreeKey, info);

  console.log(`Created worktree: ${worktreeDir} (branch: ${branchName})`);

  return info;
}

/**
 * worktree を削除する
 */
export async function RemoveWorktree(
  owner: string,
  repo: string,
  issueNumber: number
): Promise<void> {
  const worktreeKey = `${owner}/${repo}#${issueNumber}`;
  const info = _activeWorktrees.get(worktreeKey);

  if (!info) {
    return;
  }

  try {
    // worktree を削除
    const baseDir = path.dirname(path.dirname(info.worktreePath));
    execSync(`git worktree remove --force "${info.worktreePath}"`, {
      cwd: baseDir,
      stdio: 'pipe',
    });
  } catch (error) {
    console.error(`Failed to remove worktree: ${error}`);
    // ディレクトリが残っている場合は強制削除
    if (fs.existsSync(info.worktreePath)) {
      fs.rmSync(info.worktreePath, { recursive: true, force: true });
    }
  }

  _activeWorktrees.delete(worktreeKey);

  console.log(`Removed worktree: ${info.worktreePath}`);
}

/**
 * worktree でコミットしてプッシュする
 */
export async function CommitAndPush(
  worktreeInfo: WorktreeInfo,
  commitMessage: string
): Promise<boolean> {
  try {
    // 変更があるか確認
    const status = execSync('git status --porcelain', {
      cwd: worktreeInfo.worktreePath,
      encoding: 'utf-8',
    });

    if (!status.trim()) {
      console.log('No changes to commit');
      return false;
    }

    // 全ての変更をステージング
    execSync('git add -A', {
      cwd: worktreeInfo.worktreePath,
      stdio: 'pipe',
    });

    // コミット
    execSync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, {
      cwd: worktreeInfo.worktreePath,
      stdio: 'pipe',
    });

    // プッシュ
    execSync(`git push -u origin ${worktreeInfo.branchName}`, {
      cwd: worktreeInfo.worktreePath,
      stdio: 'pipe',
    });

    console.log(`Pushed branch: ${worktreeInfo.branchName}`);
    return true;
  } catch (error) {
    console.error(`Failed to commit and push: ${error}`);
    return false;
  }
}

/**
 * PR を作成する
 */
export async function CreatePullRequest(
  worktreeInfo: WorktreeInfo,
  title: string,
  body: string
): Promise<string | undefined> {
  try {
    const defaultBranch = GetDefaultBranch(worktreeInfo.worktreePath);

    // gh コマンドで PR を作成
    const result = execSync(
      `gh pr create --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}" --base ${defaultBranch} --head ${worktreeInfo.branchName}`,
      {
        cwd: worktreeInfo.worktreePath,
        encoding: 'utf-8',
      }
    );

    const prUrl = result.trim();
    console.log(`Created PR: ${prUrl}`);
    return prUrl;
  } catch (error) {
    console.error(`Failed to create PR: ${error}`);
    return undefined;
  }
}

/**
 * デフォルトブランチを取得する
 */
function GetDefaultBranch(repoDir: string): string {
  try {
    const result = execSync(
      'git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo "refs/remotes/origin/main"',
      {
        cwd: repoDir,
        encoding: 'utf-8',
      }
    );
    const branch = result.trim().replace('refs/remotes/origin/', '');
    return branch || 'main';
  } catch {
    return 'main';
  }
}

/**
 * アクティブな worktree 情報を取得する
 */
export function GetWorktreeInfo(
  owner: string,
  repo: string,
  issueNumber: number
): WorktreeInfo | undefined {
  const worktreeKey = `${owner}/${repo}#${issueNumber}`;
  return _activeWorktrees.get(worktreeKey);
}

/**
 * 既存の worktree があれば再利用し、なければ新規作成する
 */
export async function GetOrCreateWorktree(
  baseDir: string,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<{ worktreeInfo: WorktreeInfo; isExisting: boolean }> {
  const worktreeKey = `${owner}/${repo}#${issueNumber}`;
  const existing = _activeWorktrees.get(worktreeKey);

  if (existing && fs.existsSync(existing.worktreePath)) {
    console.log(`Reusing existing worktree: ${existing.worktreePath}`);
    // 既存worktreeでも毎回hook設定を再注入（git merge等で上書きされる可能性があるため）
    await InjectClaudeSettings(existing.worktreePath);
    await WarmUpClaudeProject(existing.worktreePath);
    return { worktreeInfo: existing, isExisting: true };
  }

  // 既存がない場合は新規作成
  const worktreeInfo = await CreateWorktree(baseDir, owner, repo, issueNumber);
  return { worktreeInfo, isExisting: false };
}

/**
 * 全ての worktree をクリーンアップする
 */
export async function CleanupAllWorktrees(): Promise<void> {
  for (const [_key, info] of _activeWorktrees) {
    try {
      const baseDir = path.dirname(path.dirname(info.worktreePath));
      execSync(`git worktree remove --force "${info.worktreePath}"`, {
        cwd: baseDir,
        stdio: 'pipe',
      });
    } catch {
      // 無視
    }
  }
  _activeWorktrees.clear();
  console.log('Cleaned up all worktrees');
}

/**
 * worktree に claps の .claude 設定を注入する
 * 既存の settings.json がある場合はマージする
 */
export async function InjectClaudeSettings(worktreeDir: string): Promise<void> {
  const claudeDir = path.join(worktreeDir, '.claude');
  const hooksDir = path.join(claudeDir, 'hooks');
  const settingsPath = path.join(claudeDir, 'settings.json');

  // .claude ディレクトリを作成
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  // hooks ディレクトリを作成
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  // 既存の settings.json を読み込むか、空のオブジェクトを作成
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const content = fs.readFileSync(settingsPath, 'utf-8');
      settings = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // パースエラーの場合は空で開始
    }
  }

  // hooks.PreToolUse 配列を取得または作成
  if (!settings['hooks']) {
    settings['hooks'] = {};
  }
  const hooks = settings['hooks'] as Record<string, unknown>;

  if (!hooks['PreToolUse']) {
    hooks['PreToolUse'] = [];
  }
  const preToolUseHooks = hooks['PreToolUse'] as Array<Record<string, unknown>>;

  // claps の承認hook が既に存在するか確認（コマンド文字列で判定）
  const hasClapsApprovalHook = preToolUseHooks.some(
    (hook) => {
      const hookList = hook['hooks'] as Array<Record<string, unknown>> | undefined;
      return hookList?.some((h) => {
        const cmd = h['command'] as string | undefined;
        return cmd?.includes('slack-approval.py');
      });
    }
  );

  if (!hasClapsApprovalHook) {
    // claps の承認hook を追加（先頭に追加して優先度を上げる）
    preToolUseHooks.unshift(CLAPS_APPROVAL_HOOK_CONFIG);
  }

  // claps の通知hook が既に存在するか確認
  const hasClapsNotifyHook = preToolUseHooks.some(
    (hook) => {
      const hookList = hook['hooks'] as Array<Record<string, unknown>> | undefined;
      return hookList?.some((h) => {
        const cmd = h['command'] as string | undefined;
        return cmd?.includes('tool-notify.sh');
      });
    }
  );

  if (!hasClapsNotifyHook) {
    // claps の通知hook を追加（末尾に追加、承認hookの後に実行）
    preToolUseHooks.push(CLAPS_NOTIFY_HOOK_CONFIG);
  }

  // settings.json を書き込み
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  // hookスクリプトをコピー
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // dist/git/worktree.js -> ../../.claude/hooks/
  const clapsRoot = path.resolve(__dirname, '..', '..');
  const hookFiles = ['slack-approval.py', 'tool-notify.sh'];

  for (const hookFile of hookFiles) {
    const sourceHookPath = path.join(clapsRoot, '.claude', 'hooks', hookFile);
    const destHookPath = path.join(hooksDir, hookFile);

    if (fs.existsSync(sourceHookPath)) {
      fs.copyFileSync(sourceHookPath, destHookPath);
      // 実行権限を付与
      fs.chmodSync(destHookPath, 0o755);
    } else {
      console.warn(`Warning: ${hookFile} not found at ${sourceHookPath}`);
    }
  }

  console.log(`Injected claps .claude settings into ${worktreeDir}`);
}

// ワークスペース用のスターター CLAUDE.md
const WORKSPACE_CLAUDE_MD = `# Claps Workspace

このディレクトリは claps の汎用ワークスペースです。
リポジトリ指定なしの Slack タスクがここで実行されます。

## 注意事項
- このディレクトリにはリポジトリのコードはありません
- 調査・質問応答・一般的なタスクに使用されます
`;

/**
 * 汎用ワークスペースを初期化する
 * git init、hook設定注入、スターター CLAUDE.md の配置、プロジェクトプリウォームを行う
 * Claude CLI がプロジェクト設定（.claude/settings.json）を認識するには
 * git リポジトリである必要がある
 */
export async function InitializeWorkspace(workspacePath: string): Promise<void> {
  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath, { recursive: true });
  }

  // git リポジトリとして初期化（Claude CLI が .claude/settings.json を認識するために必須）
  if (!fs.existsSync(path.join(workspacePath, '.git'))) {
    execSync('git init', { cwd: workspacePath, stdio: 'pipe' });
    console.log(`Initialized git repository in ${workspacePath}`);
  }

  await InjectClaudeSettings(workspacePath);

  // スターター CLAUDE.md を作成（初回のみ）
  const claudeMdPath = path.join(workspacePath, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(claudeMdPath, WORKSPACE_CLAUDE_MD);
  }

  // Claude CLI のプロジェクト初期化（初回のみ）
  // --dangerously-skip-permissions の初回起動ではhookが発火しないバグがあるため、
  // 事前に通常モードでダミーセッションを実行してプロジェクトを認識させる
  await WarmUpClaudeProject(workspacePath);
}

/**
 * Claude CLI のプロジェクト信頼を確立するため、tmux でインタラクティブに起動する
 * --dangerously-skip-permissions の初回起動では hook が発火しないバグがあるため、
 * 事前にターミナルモードで起動し信頼ダイアログで "Yes" を選択する必要がある
 * (ref: https://github.com/anthropics/claude-code/issues/10385)
 */
async function WarmUpClaudeProject(workspacePath: string): Promise<void> {
  const markerPath = path.join(workspacePath, '.claude', '.warmup-done');
  if (fs.existsSync(markerPath)) {
    return;
  }

  // tmux が必要
  try {
    execSync('which tmux', { stdio: 'pipe' });
  } catch {
    console.warn('tmux not found. Skipping Claude CLI warmup. Hooks may not work on first run.');
    return;
  }

  console.log('Warming up Claude CLI project via tmux (interactive trust)...');
  const sessionName = 'claps-warmup';

  // 既存セッションをクリーンアップ
  try {
    execSync(`tmux kill-session -t ${sessionName}`, { stdio: 'pipe' });
  } catch {
    // 存在しない場合は無視
  }

  try {
    // Claude CLI をインタラクティブモードで tmux 内に起動
    execSync(
      `tmux new-session -d -s ${sessionName} -c "${workspacePath}" 'claude'`,
      { stdio: 'pipe' }
    );

    // 信頼ダイアログの表示を待ち、承認する
    let accepted = false;
    const maxAttempts = 60; // 500ms × 60 = 30秒

    for (let i = 0; i < maxAttempts; i++) {
      await Sleep(500);

      let paneContent: string;
      try {
        paneContent = execSync(
          `tmux capture-pane -t ${sessionName} -p`,
          { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
        );
      } catch {
        // セッションが終了した場合
        break;
      }

      // 信頼ダイアログを検出 → Enter で "Yes" を選択
      if (paneContent.includes('Yes') || paneContent.includes('trust')) {
        execSync(`tmux send-keys -t ${sessionName} Enter`, { stdio: 'pipe' });
        accepted = true;
        await Sleep(3000);
        break;
      }

      // Claude のプロンプトが表示されている → 既に信頼済み
      if (paneContent.includes('>')) {
        accepted = true;
        break;
      }
    }

    // Claude CLI を終了
    try {
      execSync(`tmux send-keys -t ${sessionName} '/exit' Enter`, { stdio: 'pipe' });
      await Sleep(2000);
    } catch {
      // 無視
    }

    // tmux セッションをクリーンアップ
    try {
      execSync(`tmux kill-session -t ${sessionName}`, { stdio: 'pipe' });
    } catch {
      // 既に終了している場合は無視
    }

    if (accepted) {
      fs.writeFileSync(markerPath, new Date().toISOString());
      console.log('Claude CLI project warmup completed (trust accepted)');
    } else {
      console.warn('Claude CLI warmup: trust dialog not detected within timeout');
    }
  } catch (error) {
    console.warn('Claude CLI project warmup failed:', error);
    // クリーンアップ
    try {
      execSync(`tmux kill-session -t ${sessionName}`, { stdio: 'pipe' });
    } catch {
      // 無視
    }
  }
}

function Sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
