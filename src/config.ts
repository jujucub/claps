/**
 * sumomo - 設定管理
 */

import 'dotenv/config';
import type { Config, AllowedUsers } from './types/index.js';

/**
 * カンマ区切りの文字列を配列に変換する（空の場合は空配列）
 */
function ParseCommaSeparatedList(value: string | undefined): readonly string[] {
  if (!value || value.trim() === '') {
    return [];
  }
  return value.split(',').map((item) => item.trim()).filter((item) => item !== '');
}

/**
 * 環境変数から設定を読み込む
 */
export function LoadConfig(): Config {
  // ANTHROPIC_API_KEY は 認証して使用する時は不要（任意）
  const anthropicApiKey = process.env['ANTHROPIC_API_KEY'];
  const slackBotToken = process.env['SLACK_BOT_TOKEN'];
  const slackAppToken = process.env['SLACK_APP_TOKEN'];
  const slackChannelId = process.env['SLACK_CHANNEL_ID'];
  const githubToken = process.env['GITHUB_TOKEN'];
  const githubReposStr = process.env['GITHUB_REPOS'];

  // 必須項目のバリデーション
  if (!slackBotToken) {
    throw new Error('SLACK_BOT_TOKEN is required');
  }
  if (!slackAppToken) {
    throw new Error('SLACK_APP_TOKEN is required');
  }
  if (!slackChannelId) {
    throw new Error('SLACK_CHANNEL_ID is required');
  }
  if (!githubToken) {
    throw new Error('GITHUB_TOKEN is required');
  }
  if (!githubReposStr) {
    throw new Error('GITHUB_REPOS is required');
  }

  const githubRepos = githubReposStr.split(',').map((repo) => repo.trim());

  const approvalServerPort = parseInt(
    process.env['APPROVAL_SERVER_PORT'] ?? '3001',
    10
  );
  const githubPollInterval = parseInt(
    process.env['GITHUB_POLL_INTERVAL'] ?? '300000',
    10
  );

  // ホワイトリスト設定（空の場合は全員拒否）
  const allowedUsers: AllowedUsers = {
    github: ParseCommaSeparatedList(process.env['ALLOWED_GITHUB_USERS']),
    slack: ParseCommaSeparatedList(process.env['ALLOWED_SLACK_USERS']),
  };

  // ホワイトリストが空の場合は警告
  if (allowedUsers.github.length === 0) {
    console.warn('⚠️ ALLOWED_GITHUB_USERS is empty - all GitHub requests will be denied');
  }
  if (allowedUsers.slack.length === 0) {
    console.warn('⚠️ ALLOWED_SLACK_USERS is empty - all Slack requests will be denied');
  }

  return {
    anthropicApiKey,
    slackBotToken,
    slackAppToken,
    slackChannelId,
    githubToken,
    githubRepos,
    approvalServerPort,
    githubPollInterval,
    allowedUsers,
  };
}
