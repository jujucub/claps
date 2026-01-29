/**
 * sumomo - tmux セッション管理
 * Claude CLI を対話モードで実行するための tmux セッション制御
 */

import { execSync } from 'child_process';

export interface TmuxSession {
  readonly sessionName: string;
  readonly issueNumber: number;
  readonly workingDirectory: string;
}

const _activeSessions = new Map<string, TmuxSession>();

/**
 * tmux セッションを作成して Claude CLI を起動する
 */
export async function CreateTmuxSession(
  sessionName: string,
  workingDirectory: string,
  issueNumber: number,
  prompt: string
): Promise<TmuxSession> {
  // 既存のセッションがあれば削除
  if (SessionExists(sessionName)) {
    KillSession(sessionName);
  }

  // 新しいセッションを作成（Claude CLI を起動）
  // -d: デタッチモード
  // -s: セッション名
  // -c: 作業ディレクトリ
  execSync(
    `tmux new-session -d -s "${sessionName}" -c "${workingDirectory}"`,
    { stdio: 'pipe' }
  );

  // 環境変数を設定（Hook がtmuxセッション名を知るため）
  execSync(
    `tmux set-environment -t "${sessionName}" SUMOMO_TMUX_SESSION "${sessionName}"`,
    { stdio: 'pipe' }
  );

  // Claude CLI を起動（対話モード）
  // プロンプトをエスケープしてシングルクォートで囲む
  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  execSync(
    `tmux send-keys -t "${sessionName}" 'SUMOMO_TMUX_SESSION="${sessionName}" claude "${escapedPrompt}"' Enter`,
    { stdio: 'pipe' }
  );

  // ワークスペース信頼確認プロンプトを待ってから自動承認
  // "Yes, I trust this folder" がデフォルト選択なので Enter を送信
  await WaitForTrustPrompt(sessionName);
  execSync(`tmux send-keys -t "${sessionName}" Enter`, { stdio: 'pipe' });
  console.log(`Auto-accepted workspace trust for session: ${sessionName}`);

  const session: TmuxSession = {
    sessionName,
    issueNumber,
    workingDirectory,
  };

  _activeSessions.set(sessionName, session);

  console.log(`Created tmux session: ${sessionName}`);

  return session;
}

/**
 * ワークスペース信頼確認プロンプトが表示されるまで待機
 */
async function WaitForTrustPrompt(sessionName: string): Promise<void> {
  const maxWaitMs = 10000; // 最大10秒待機
  const checkIntervalMs = 500;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    const output = CapturePane(sessionName, 50);

    // 信頼確認プロンプトを検出
    // "Yes, I trust this folder" または "はい、このフォルダを信頼します"
    if (
      output.includes('trust this folder') ||
      output.includes('このフォルダを信頼') ||
      output.includes('Quick safety check')
    ) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, checkIntervalMs));
  }

  // タイムアウトしても続行（プロンプトが表示されない場合もある）
  console.log(`Trust prompt wait timed out for session: ${sessionName}`);
}

/**
 * セッションが存在するか確認
 */
export function SessionExists(sessionName: string): boolean {
  try {
    execSync(`tmux has-session -t "${sessionName}"`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * セッションを終了
 */
export function KillSession(sessionName: string): void {
  try {
    execSync(`tmux kill-session -t "${sessionName}"`, { stdio: 'pipe' });
    _activeSessions.delete(sessionName);
    console.log(`Killed tmux session: ${sessionName}`);
  } catch {
    // セッションが存在しない場合は無視
  }
}

/**
 * 許可を送信（Yes）
 */
export function SendApproval(sessionName: string, comment?: string): void {
  if (!SessionExists(sessionName)) {
    console.error(`Session ${sessionName} does not exist`);
    return;
  }

  if (comment) {
    // コメントがある場合: Tab → コメント → Enter
    execSync(`tmux send-keys -t "${sessionName}" Tab`, { stdio: 'pipe' });
    // コメントをエスケープ
    const escapedComment = comment.replace(/'/g, "'\\''");
    execSync(`tmux send-keys -t "${sessionName}" '${escapedComment}'`, { stdio: 'pipe' });
    execSync(`tmux send-keys -t "${sessionName}" Enter`, { stdio: 'pipe' });
  } else {
    // コメントなし: そのまま Enter（Yesがデフォルト選択）
    execSync(`tmux send-keys -t "${sessionName}" Enter`, { stdio: 'pipe' });
  }

  console.log(`Sent approval to session: ${sessionName}`);
}

/**
 * 拒否を送信（NO）
 */
export function SendDenial(sessionName: string, comment?: string): void {
  if (!SessionExists(sessionName)) {
    console.error(`Session ${sessionName} does not exist`);
    return;
  }

  // NOに移動（下矢印2回）
  execSync(`tmux send-keys -t "${sessionName}" Down Down`, { stdio: 'pipe' });

  if (comment) {
    // コメントがある場合: Tab → コメント → Enter
    execSync(`tmux send-keys -t "${sessionName}" Tab`, { stdio: 'pipe' });
    const escapedComment = comment.replace(/'/g, "'\\''");
    execSync(`tmux send-keys -t "${sessionName}" '${escapedComment}'`, { stdio: 'pipe' });
    execSync(`tmux send-keys -t "${sessionName}" Enter`, { stdio: 'pipe' });
  } else {
    // コメントなし: そのまま Enter
    execSync(`tmux send-keys -t "${sessionName}" Enter`, { stdio: 'pipe' });
  }

  console.log(`Sent denial to session: ${sessionName}`);
}

/**
 * セッションの出力をキャプチャ
 */
export function CapturePane(sessionName: string, lines: number = 100): string {
  if (!SessionExists(sessionName)) {
    return '';
  }

  try {
    const output = execSync(
      `tmux capture-pane -t "${sessionName}" -p -S -${lines}`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return output;
  } catch {
    return '';
  }
}

/**
 * セッションの出力を監視し、コールバックを呼び出す
 */
export function WatchSession(
  sessionName: string,
  onOutput: (output: string) => void,
  intervalMs: number = 1000
): () => void {
  let lastOutput = '';
  let isRunning = true;

  const check = () => {
    if (!isRunning) return;
    if (!SessionExists(sessionName)) {
      isRunning = false;
      return;
    }

    const currentOutput = CapturePane(sessionName, 200);
    if (currentOutput !== lastOutput) {
      lastOutput = currentOutput;
      onOutput(currentOutput);
    }

    setTimeout(check, intervalMs);
  };

  check();

  // 停止関数を返す
  return () => {
    isRunning = false;
  };
}

/**
 * Claude CLI が終了したかどうかを検出
 */
export function IsClaudeFinished(output: string): boolean {
  // Claude CLI が終了すると、プロンプトに戻る
  // または特定のメッセージが表示される
  const finishPatterns = [
    /\$\s*$/m,  // シェルプロンプト
    /❯\s*$/m,  // zsh プロンプト
    />\s*$/m,  // 一般的なプロンプト
  ];

  // 最後の数行をチェック
  const lastLines = output.split('\n').slice(-5).join('\n');

  for (const pattern of finishPatterns) {
    if (pattern.test(lastLines)) {
      return true;
    }
  }

  return false;
}

/**
 * アクティブなセッション一覧を取得
 */
export function GetActiveSessions(): readonly TmuxSession[] {
  return Array.from(_activeSessions.values());
}

/**
 * セッション名からセッション情報を取得
 */
export function GetSession(sessionName: string): TmuxSession | undefined {
  return _activeSessions.get(sessionName);
}

/**
 * すべてのセッションをクリーンアップ
 */
export function CleanupAllSessions(): void {
  for (const session of _activeSessions.values()) {
    KillSession(session.sessionName);
  }
  _activeSessions.clear();
  console.log('Cleaned up all tmux sessions');
}

/**
 * Issue番号からセッション名を生成
 */
export function GetSessionNameForIssue(owner: string, repo: string, issueNumber: number): string {
  return `sumomo-${owner}-${repo}-${issueNumber}`;
}
