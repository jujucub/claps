/**
 * sumomo - 設定管理
 */

import 'dotenv/config';
import type { Config } from './types/index.js';

/**
 * 環境変数から設定を読み込む
 */
export function LoadConfig(): Config {
  const anthropicApiKey = process.env['ANTHROPIC_API_KEY'];
  const slackBotToken = process.env['SLACK_BOT_TOKEN'];
  const slackAppToken = process.env['SLACK_APP_TOKEN'];
  const slackChannelId = process.env['SLACK_CHANNEL_ID'];
  const githubToken = process.env['GITHUB_TOKEN'];
  const githubReposStr = process.env['GITHUB_REPOS'];

  // 必須項目のバリデーション
  if (!anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY is required');
  }
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

  return {
    anthropicApiKey,
    slackBotToken,
    slackAppToken,
    slackChannelId,
    githubToken,
    githubRepos,
    approvalServerPort,
    githubPollInterval,
  };
}
