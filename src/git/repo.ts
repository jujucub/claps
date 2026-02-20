/**
 * claps - リポジトリ管理
 * 監視対象リポジトリの自動クローン・管理機能を提供する
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GetTokenProvider } from '../github/auth.js';

/**
 * .claps ディレクトリのパスを取得する
 * すべてのデータは ~/.claps/ に保存される
 */
export function GetClapsDir(): string {
  return path.join(os.homedir(), '.claps');
}

/**
 * リポジトリのローカルパスを取得する
 * @param owner リポジトリオーナー
 * @param repo リポジトリ名
 * @returns .claps/repos/{owner}/{repo} のパス
 */
export function GetRepoPath(owner: string, repo: string): string {
  return path.join(GetClapsDir(), 'repos', owner, repo);
}

/**
 * 汎用ワークスペースのパスを取得する
 * リポジトリ指定なしの Slack タスクで使用する作業ディレクトリ
 * @returns .claps/workspace のパス
 */
export function GetWorkspacePath(): string {
  return path.join(GetClapsDir(), 'workspace');
}

/**
 * リポジトリをクローンまたは更新する
 * - リポジトリがクローン済みなら fetch して最新化
 * - 未クローンなら git clone を実行
 * トークンはシングルトンの GetTokenProvider() から取得する
 * @param owner リポジトリオーナー
 * @param repo リポジトリ名
 * @returns クローンしたリポジトリのパス
 */
export async function GetOrCloneRepo(
  owner: string,
  repo: string,
): Promise<string> {
  const repoPath = GetRepoPath(owner, repo);
  const token = await GetTokenProvider().GetToken();
  const repoUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

  if (fs.existsSync(path.join(repoPath, '.git'))) {
    // 既にクローン済みの場合は remote URL を更新してから fetch（トークンリフレッシュ対応）
    console.log(`Fetching existing repo: ${owner}/${repo}`);
    try {
      execSync(`git remote set-url origin "${repoUrl}"`, {
        cwd: repoPath,
        stdio: 'pipe',
      });
      execSync('git fetch --all', {
        cwd: repoPath,
        stdio: 'pipe',
      });
      console.log(`Fetched repo: ${owner}/${repo}`);
    } catch (error) {
      console.error(`Failed to fetch repo: ${error}`);
      throw new Error(`Failed to fetch repository ${owner}/${repo}`, { cause: error });
    }
  } else {
    // クローンする
    console.log(`Cloning repo: ${owner}/${repo}`);

    // 親ディレクトリを作成
    const parentDir = path.dirname(repoPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    try {
      execSync(`git clone "${repoUrl}" "${repoPath}"`, {
        stdio: 'pipe',
      });
      console.log(`Cloned repo: ${owner}/${repo} to ${repoPath}`);
    } catch (error) {
      console.error(`Failed to clone repo: ${error}`);
      throw new Error(`Failed to clone repository ${owner}/${repo}`, { cause: error });
    }
  }

  return repoPath;
}

/**
 * リポジトリがクローン済みかどうかを確認する
 * @param owner リポジトリオーナー
 * @param repo リポジトリ名
 * @returns クローン済みなら true
 */
export function IsRepoCloned(owner: string, repo: string): boolean {
  const repoPath = GetRepoPath(owner, repo);
  return fs.existsSync(path.join(repoPath, '.git'));
}
