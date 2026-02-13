/**
 * claps - セッションストア
 * Slackスレッド/GitHub IssueとClaudeセッションIDを管理する
 */

// セッション取得時の戻り値型
export interface SessionResult {
  readonly sessionId: string;
  readonly workingDirectory?: string;
}

// セッション情報
interface SessionInfo {
  readonly sessionId: string;
  readonly workingDirectory?: string;
  readonly createdAt: Date;
  lastUsedAt: Date;
}

// Issue情報（スレッドとIssueの紐付け用）
interface IssueInfo {
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
}

// セッションキー
// Slack: slack:{threadTs}:{userId}
// GitHub: github:{owner}/{repo}#{issueNumber}
type SessionKey = string;

/**
 * セッションストアクラス
 */
class SessionStore {
  private _sessions: Map<SessionKey, SessionInfo>;
  private _threadToIssue: Map<string, IssueInfo>; // threadTs -> IssueInfo
  private _threadToTargetRepo: Map<string, string>; // threadTs -> targetRepo (owner/repo)
  private readonly _maxAge: number; // セッションの最大有効期間（ミリ秒）

  constructor(maxAgeHours: number = 24) {
    this._sessions = new Map();
    this._threadToIssue = new Map();
    this._threadToTargetRepo = new Map();
    this._maxAge = maxAgeHours * 60 * 60 * 1000;
  }

  /**
   * Slackスレッド用のキーを生成
   */
  private _makeSlackKey(threadTs: string, userId: string): SessionKey {
    return `slack:${threadTs}:${userId}`;
  }

  /**
   * GitHub Issue用のキーを生成
   */
  private _makeGitHubKey(owner: string, repo: string, issueNumber: number): SessionKey {
    return `github:${owner}/${repo}#${issueNumber}`;
  }

  /**
   * キーからセッションを取得（共通処理）
   */
  private _getByKey(key: SessionKey): SessionResult | undefined {
    const session = this._sessions.get(key);

    if (!session) {
      return undefined;
    }

    // 有効期限チェック
    const now = Date.now();
    if (now - session.lastUsedAt.getTime() > this._maxAge) {
      this._sessions.delete(key);
      return undefined;
    }

    // 最終使用時刻を更新
    session.lastUsedAt = new Date();
    return {
      sessionId: session.sessionId,
      workingDirectory: session.workingDirectory,
    };
  }

  /**
   * キーにセッションを保存（共通処理）
   */
  private _setByKey(key: SessionKey, sessionId: string, workingDirectory?: string): void {
    const now = new Date();
    this._sessions.set(key, {
      sessionId,
      workingDirectory,
      createdAt: now,
      lastUsedAt: now,
    });
    console.log(`Session stored: ${key} -> ${sessionId}${workingDirectory ? ` (dir: ${workingDirectory})` : ''}`);
  }

  /**
   * Slackスレッドのセッションを取得
   */
  Get(threadTs: string, userId: string): SessionResult | undefined {
    const key = this._makeSlackKey(threadTs, userId);
    return this._getByKey(key);
  }

  /**
   * Slackスレッドのセッションを保存
   */
  Set(threadTs: string, userId: string, sessionId: string, workingDirectory?: string): void {
    const key = this._makeSlackKey(threadTs, userId);
    this._setByKey(key, sessionId, workingDirectory);
  }

  /**
   * Slackスレッドのセッションを削除
   */
  Delete(threadTs: string, userId: string): boolean {
    const key = this._makeSlackKey(threadTs, userId);
    return this._sessions.delete(key);
  }

  /**
   * GitHub Issueのセッションを取得
   */
  GetForIssue(owner: string, repo: string, issueNumber: number): SessionResult | undefined {
    const key = this._makeGitHubKey(owner, repo, issueNumber);
    return this._getByKey(key);
  }

  /**
   * GitHub Issueのセッションを保存
   */
  SetForIssue(owner: string, repo: string, issueNumber: number, sessionId: string, workingDirectory?: string): void {
    const key = this._makeGitHubKey(owner, repo, issueNumber);
    this._setByKey(key, sessionId, workingDirectory);
  }

  /**
   * GitHub Issueのセッションを削除
   */
  DeleteForIssue(owner: string, repo: string, issueNumber: number): boolean {
    const key = this._makeGitHubKey(owner, repo, issueNumber);
    return this._sessions.delete(key);
  }

  /**
   * SlackスレッドとGitHub Issueを紐付ける
   */
  LinkThreadToIssue(threadTs: string, owner: string, repo: string, issueNumber: number): void {
    this._threadToIssue.set(threadTs, { owner, repo, issueNumber });
    console.log(`Thread ${threadTs} linked to issue ${owner}/${repo}#${issueNumber}`);
  }

  /**
   * SlackスレッドからGitHub Issue情報を取得
   */
  GetIssueForThread(threadTs: string): IssueInfo | undefined {
    return this._threadToIssue.get(threadTs);
  }

  /**
   * GitHub Issueに紐付いたスレッドの紐付けを解除
   */
  UnlinkThreadForIssue(owner: string, repo: string, issueNumber: number): void {
    for (const [threadTs, info] of this._threadToIssue) {
      if (info.owner === owner && info.repo === repo && info.issueNumber === issueNumber) {
        this._threadToIssue.delete(threadTs);
        console.log(`Thread ${threadTs} unlinked from issue ${owner}/${repo}#${issueNumber}`);
        break;
      }
    }
  }

  /**
   * Slackスレッドにターゲットリポジトリを紐付ける
   */
  LinkThreadToTargetRepo(threadTs: string, targetRepo: string): void {
    this._threadToTargetRepo.set(threadTs, targetRepo);
    console.log(`Thread ${threadTs} linked to target repo ${targetRepo}`);
  }

  /**
   * Slackスレッドからターゲットリポジトリを取得
   */
  GetTargetRepoForThread(threadTs: string): string | undefined {
    return this._threadToTargetRepo.get(threadTs);
  }

  /**
   * 期限切れセッションをクリーンアップ
   */
  Cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, session] of this._sessions) {
      if (now - session.lastUsedAt.getTime() > this._maxAge) {
        this._sessions.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`Cleaned up ${cleaned} expired sessions`);
    }

    return cleaned;
  }

  /**
   * すべてのセッションをクリア
   */
  Clear(): void {
    this._sessions.clear();
  }

  /**
   * セッション数を取得
   */
  get Size(): number {
    return this._sessions.size;
  }
}

// シングルトンインスタンス
let _instance: SessionStore | undefined;

/**
 * セッションストアのシングルトンインスタンスを取得
 */
export function GetSessionStore(): SessionStore {
  if (!_instance) {
    _instance = new SessionStore();

    // 1時間ごとに期限切れセッションをクリーンアップ
    setInterval(() => {
      _instance?.Cleanup();
    }, 60 * 60 * 1000);
  }
  return _instance;
}
