/**
 * claps - GitHub認証プロバイダー
 * PAT と GitHub App の両方をサポートする統一的なトークン管理
 */

import * as fs from 'fs';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import type { GitHubAuthConfig } from '../types/index.js';

// トークンプロバイダーインターフェース
export interface GitHubTokenProvider {
  /** 有効なトークンを返す（自動リフレッシュ） */
  GetToken(): Promise<string>;
  /** 認証モードを返す */
  GetAuthMode(): 'pat' | 'github-app';
  /** Botユーザー名を返す（App: "app-name[bot]", PAT: undefined） */
  GetBotUsername(): string | undefined;
  /** 認証済みOctokitインスタンスを返す */
  GetOctokit(): Promise<Octokit>;
}

// キャッシュされたトークン情報
interface CachedToken {
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * PAT（Personal Access Token）トークンプロバイダー
 * 既存動作と完全に同等
 */
class PatTokenProvider implements GitHubTokenProvider {
  private readonly _token: string;
  private readonly _octokit: Octokit;

  constructor(token: string) {
    this._token = token;
    this._octokit = new Octokit({ auth: token });
  }

  async GetToken(): Promise<string> {
    return this._token;
  }

  GetAuthMode(): 'pat' {
    return 'pat';
  }

  GetBotUsername(): string | undefined {
    return undefined;
  }

  async GetOctokit(): Promise<Octokit> {
    return this._octokit;
  }
}

/**
 * GitHub App トークンプロバイダー
 * Installation Access Token を都度生成し、キャッシュと自動リフレッシュを行う
 */
class GitHubAppTokenProvider implements GitHubTokenProvider {
  private readonly _appId: string;
  private readonly _privateKey: string;
  private readonly _installationId: number;
  private _cachedToken: CachedToken | null = null;
  private _refreshPromise: Promise<string> | null = null;
  private _botUsername: string | undefined;

  constructor(appId: string, privateKeyPath: string, installationId: number) {
    this._appId = appId;
    this._installationId = installationId;

    // 秘密鍵を読み込む
    const resolvedPath = privateKeyPath.replace(/^~/, process.env['HOME'] ?? '');
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`GitHub App秘密鍵が見つかりません: ${resolvedPath}`);
    }

    // ファイルパーミッションを検証
    const stats = fs.statSync(resolvedPath);
    const mode = stats.mode & 0o777;
    if (mode !== 0o600 && mode !== 0o400) {
      console.warn(`⚠️ GitHub App秘密鍵のパーミッションが ${mode.toString(8)} です。0600 に変更することを推奨します: ${resolvedPath}`);
    }

    this._privateKey = fs.readFileSync(resolvedPath, 'utf-8');
  }

  async GetToken(): Promise<string> {
    // キャッシュされたトークンが有効なら再利用（有効期限の10分前まで）
    if (this._cachedToken) {
      const now = new Date();
      const bufferMs = 10 * 60 * 1000; // 10分
      if (now.getTime() + bufferMs < this._cachedToken.expiresAt.getTime()) {
        return this._cachedToken.token;
      }
    }

    // 既にリフレッシュ中のPromiseがあれば共有
    if (this._refreshPromise) {
      return this._refreshPromise;
    }

    this._refreshPromise = this._refreshToken();
    try {
      return await this._refreshPromise;
    } finally {
      this._refreshPromise = null;
    }
  }

  GetAuthMode(): 'github-app' {
    return 'github-app';
  }

  GetBotUsername(): string | undefined {
    return this._botUsername;
  }

  async GetOctokit(): Promise<Octokit> {
    const token = await this.GetToken();
    return new Octokit({ auth: token });
  }

  private async _refreshToken(): Promise<string> {
    const auth = createAppAuth({
      appId: this._appId,
      privateKey: this._privateKey,
      installationId: this._installationId,
    });

    const result = await auth({ type: 'installation' });

    // Botユーザー名を初回取得時にフェッチ
    if (!this._botUsername) {
      try {
        const octokit = new Octokit({ auth: result.token });
        const response = await octokit.apps.getAuthenticated();
        const appSlug = response.data?.slug ?? response.data?.name ?? 'github-app';
        this._botUsername = `${appSlug}[bot]`;
        console.log(`GitHub App bot username: ${this._botUsername}`);
      } catch (error) {
        console.warn('GitHub Appのbot名取得に失敗:', error);
      }
    }

    this._cachedToken = {
      token: result.token,
      expiresAt: new Date(result.expiresAt),
    };

    console.log(`GitHub App token refreshed (expires: ${result.expiresAt})`);
    return result.token;
  }
}

/**
 * 設定に基づいてトークンプロバイダーを生成するファクトリ関数
 */
export function CreateTokenProvider(config: GitHubAuthConfig): GitHubTokenProvider {
  if (config.mode === 'pat') {
    return new PatTokenProvider(config.token);
  }
  return new GitHubAppTokenProvider(config.appId, config.privateKeyPath, config.installationId);
}

// シングルトン管理
let _provider: GitHubTokenProvider | undefined;

/**
 * トークンプロバイダーを初期化する（起動時に1回呼ぶ）
 */
export function InitTokenProvider(config: GitHubAuthConfig): void {
  _provider = CreateTokenProvider(config);
  console.log(`GitHub auth initialized: mode=${config.mode}`);
}

/**
 * トークンプロバイダーのシングルトンを取得する
 * @throws InitTokenProvider が呼ばれていない場合
 */
export function GetTokenProvider(): GitHubTokenProvider {
  if (!_provider) {
    throw new Error('TokenProvider not initialized. Call InitTokenProvider first.');
  }
  return _provider;
}
