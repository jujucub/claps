/**
 * claps - Slack イベントハンドラー
 * メンション、ボタンクリック、モーダル、メッセージの処理
 */

import type { App } from '@slack/bolt';
import type {
  ApprovalResult,
  SlackTaskMetadata,
  AllowedUsers,
  ReflectionResult,
  TaskSuggestion,
} from '../types/index.js';
import {
  GetAdminSlackUser,
  GetAdminConfig,
  SaveAdminConfig,
} from '../admin/store.js';
import { UpdateRepos } from '../github/poller.js';
import { UpdateAllowedUsers as UpdateGitHubAllowedUsers } from '../github/poller.js';
import { GetReflectionStore } from '../reflection/store.js';
import {
  RunReflectionManually,
  UpdateReflectionConfig,
  GetReflectionConfig,
} from '../reflection/scheduler.js';
import { Msg, GetBotName } from '../messages.js';

// ホワイトリスト（RegisterSlackHandlersで設定、UpdateAllowedUsersで更新可能）
let _allowedUsers: AllowedUsers | undefined;

/**
 * SlackユーザーIDがホワイトリストに含まれているかチェック
 */
function IsUserAllowed(userId: string): boolean {
  if (!_allowedUsers) return false;
  // ホワイトリストが空の場合は全員拒否
  if (_allowedUsers.slack.length === 0) return false;
  return _allowedUsers.slack.includes(userId);
}

/**
 * SlackユーザーIDが管理者かどうかチェック
 */
function IsAdmin(userId: string): boolean {
  const adminUser = GetAdminSlackUser();
  if (!adminUser) return false;
  return adminUser === userId;
}

/**
 * Slackホワイトリストを動的に更新する
 */
export function UpdateAllowedUsers(slackUsers: readonly string[]): void {
  if (!_allowedUsers) {
    _allowedUsers = { github: [], slack: slackUsers };
  } else {
    _allowedUsers = {
      ..._allowedUsers,
      slack: slackUsers,
    };
  }
  console.log(`Slack allowed users updated: ${slackUsers.length} users`);
}

// 承認待ちリクエストの管理
interface PendingApproval {
  readonly requestId: string;
  readonly taskId: string;
  readonly tool: string;
  readonly command: string;
  readonly channelId: string;
  readonly messageTs: string;
  readonly requestedBySlackId?: string; // 承認権限を持つユーザー
  resolve: (result: ApprovalResult) => void;
}

// 質問待ちリクエストの管理
interface PendingQuestion {
  readonly requestId: string;
  readonly taskId: string;
  resolve: (answer: string) => void;
}

const _pendingApprovals = new Map<string, PendingApproval>();
const _pendingQuestions = new Map<string, PendingQuestion>();

/**
 * リポジトリ形式 (owner/repo) を検証する
 */
function IsValidRepoFormat(repo: string): boolean {
  const parts = repo.split('/');
  const owner = parts[0];
  const repoName = parts[1];
  return parts.length === 2 && !!owner && owner.length > 0 && !!repoName && repoName.length > 0;
}

/**
 * GitHubユーザー名を検証する
 * GitHubユーザー名: 1-39文字、英数字とハイフン、先頭/末尾ハイフン不可、連続ハイフン不可
 */
function IsValidGitHubUsername(username: string): boolean {
  if (!username || username.length === 0 || username.length > 39) return false;
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(username);
}

// 提案承認時のタスク実行コールバック
let _onSuggestionApproved:
  | ((metadata: SlackTaskMetadata, prompt: string) => Promise<void>)
  | undefined;

/**
 * 提案承認コールバックを設定する
 */
export function SetSuggestionApprovedCallback(
  callback: (metadata: SlackTaskMetadata, prompt: string) => Promise<void>
): void {
  _onSuggestionApproved = callback;
}

/**
 * 内省結果をSlackに投稿する
 */
export async function PostReflectionResult(
  app: App,
  channelId: string,
  result: ReflectionResult
): Promise<void> {
  // ユーザーごとの提案数を集計
  const userSummaries = result.userReflections.map((r) => {
    return Msg('reflection.userSummary', { userId: r.userId, count: String(r.suggestions.length) });
  });

  // 親メッセージを投稿
  const parentResult = await app.client.chat.postMessage({
    channel: channelId,
    text: Msg('reflection.title', { date: result.date }),
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: Msg('reflection.header'),
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: Msg('reflection.result', { date: result.date, summaries: userSummaries.join('\n') }),
        },
      },
    ],
  });

  const parentTs = parentResult.ts;
  if (!parentTs) return;

  // ユーザーごとにスレッドで提案を投稿
  for (const reflection of result.userReflections) {
    // ユーザーサマリーを投稿
    await app.client.chat.postMessage({
      channel: channelId,
      thread_ts: parentTs,
      text: `<@${reflection.userId}> さんの分析結果`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*<@${reflection.userId}> さんの分析*\n\n${reflection.summary}`,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*発見したパターン:*\n${reflection.patterns.map((p) => `• ${p}`).join('\n')}`,
          },
        },
      ],
    });

    // 各提案をボタン付きで投稿
    for (let i = 0; i < reflection.suggestions.length; i++) {
      const suggestion = reflection.suggestions[i] as TaskSuggestion;
      const priorityEmoji: Record<string, string> = {
        high: ':red_circle:',
        medium: ':large_orange_circle:',
        low: ':white_circle:',
      };
      const emoji = priorityEmoji[suggestion.priority] ?? ':white_circle:';

      const repoInfo = suggestion.relatedRepo ? `\n関連: \`${suggestion.relatedRepo}\`` : '';

      await app.client.chat.postMessage({
        channel: channelId,
        thread_ts: parentTs,
        text: `提案 ${i + 1}: ${suggestion.title}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:bulb: *提案 ${i + 1}: ${suggestion.title}*\n優先度: ${emoji} ${suggestion.priority}\n説明: ${suggestion.description}${repoInfo}\n予想工数: ${suggestion.estimatedEffort}`,
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: '実行する',
                  emoji: true,
                },
                style: 'primary',
                action_id: `suggestion_approve_${suggestion.id}`,
                value: suggestion.id,
              },
              {
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: '却下する',
                  emoji: true,
                },
                style: 'danger',
                action_id: `suggestion_reject_${suggestion.id}`,
                value: suggestion.id,
              },
            ],
          },
        ],
      });
    }
  }
}

/**
 * Slack ハンドラーを登録する
 */
export function RegisterSlackHandlers(
  app: App,
  channelId: string,
  onMention: (metadata: SlackTaskMetadata, prompt: string) => Promise<void>,
  allowedUsers: AllowedUsers
): void {
  // ホワイトリストを保存
  _allowedUsers = allowedUsers;

  // スラッシュコマンドの処理（ボット名で動的登録）
  const botName = GetBotName();
  app.command(`/${botName}`, async ({ command, ack, respond }) => {
    await ack();

    const userId = command.user_id;

    // ホワイトリストチェック
    if (!IsUserAllowed(userId)) {
      console.log(`Denied Slack command from ${userId} (not in whitelist)`);
      await respond({
        response_type: 'ephemeral',
        text: Msg('command.noPermission'),
      });
      return;
    }

    const text = command.text.trim();
    const parts = text.split(/\s+/);
    const subCommand = parts[0]?.toLowerCase() ?? '';

    // ヘルプ表示
    if (!text || subCommand === 'help') {
      const isAdmin = IsAdmin(userId);
      const cmd = `/${botName}`;
      let helpText = `${Msg('command.helpTitle')}

*基本コマンド:*
\`${cmd} owner/repo メッセージ\`
→ 指定したリポジトリの環境でClaudeを実行

\`${cmd} repos\`
→ 監視対象リポジトリの一覧を表示

*例:*
\`${cmd} h-sato/my-project バグを修正して\``;

      helpText += `

*内省コマンド:*
\`${cmd} reflection\`
→ 内省機能のステータス表示`;

      if (isAdmin) {
        helpText += `

*管理者コマンド:*
\`${cmd} add-repo owner/repo\`
→ 監視リポジトリを追加

\`${cmd} remove-repo owner/repo\`
→ 監視リポジトリを削除

\`${cmd} reflection run\`
→ 内省を手動実行

\`${cmd} reflection enable\`
→ 内省機能を有効化

\`${cmd} reflection disable\`
→ 内省機能を無効化

\`${cmd} reflection schedule HH:MM\`
→ 内省の実行時刻を変更

\`${cmd} whitelist\`
→ ホワイトリストを表示（マッピング情報含む）

\`${cmd} whitelist add @user [github-username]\`
→ ユーザーをホワイトリストに追加（GitHub名を指定するとマッピングも同時作成）

\`${cmd} whitelist add-github username\`
→ GitHubユーザーのみをホワイトリストに追加

\`${cmd} whitelist remove @user\`
→ Slackユーザーをホワイトリストから削除

\`${cmd} whitelist remove-github username\`
→ GitHubユーザーをホワイトリストから削除`;
      }

      await respond({
        response_type: 'ephemeral',
        text: helpText,
      });
      return;
    }

    // reflection サブコマンド
    if (subCommand === 'reflection') {
      const reflectionAction = parts[1]?.toLowerCase() ?? '';
      const reflectionConfig = GetReflectionConfig();

      // ステータス表示（全ユーザー可）
      if (!reflectionAction) {
        const status = reflectionConfig?.enabled ? '有効' : '無効';
        const schedule = reflectionConfig?.schedule ?? '09:00';
        const timezone = reflectionConfig?.timezone ?? 'Asia/Tokyo';
        const historyDays = reflectionConfig?.historyDays ?? 7;

        const reflectionStore = GetReflectionStore();
        const latest = reflectionStore.GetLatest();
        const lastRun = latest ? latest.generatedAt : 'まだ実行されていません';

        await respond({
          response_type: 'ephemeral',
          text: Msg('reflection.status', { status, schedule, timezone, historyDays: String(historyDays), lastRun }),
        });
        return;
      }

      // 以下は管理者のみ
      if (!IsAdmin(userId)) {
        await respond({
          response_type: 'ephemeral',
          text: Msg('command.adminOnly'),
        });
        return;
      }

      // reflection run - 手動実行
      if (reflectionAction === 'run') {
        await respond({
          response_type: 'ephemeral',
          text: Msg('reflection.manualRun'),
        });

        void RunReflectionManually().then((result) => {
          if (!result) {
            void app.client.chat.postEphemeral({
              channel: command.channel_id,
              user: userId,
              text: Msg('reflection.noResult'),
            });
          }
        });
        return;
      }

      // reflection enable
      if (reflectionAction === 'enable') {
        UpdateReflectionConfig({ enabled: true });
        await respond({
          response_type: 'ephemeral',
          text: Msg('reflection.enabled'),
        });
        return;
      }

      // reflection disable
      if (reflectionAction === 'disable') {
        UpdateReflectionConfig({ enabled: false });
        await respond({
          response_type: 'ephemeral',
          text: Msg('reflection.disabled'),
        });
        return;
      }

      // reflection schedule HH:MM
      if (reflectionAction === 'schedule') {
        const time = parts[2] ?? '';
        if (!/^\d{2}:\d{2}$/.test(time)) {
          await respond({
            response_type: 'ephemeral',
            text: Msg('reflection.invalidTime'),
          });
          return;
        }

        UpdateReflectionConfig({ schedule: time });
        await respond({
          response_type: 'ephemeral',
          text: Msg('reflection.scheduleChanged', { time }),
        });
        return;
      }

      await respond({
        response_type: 'ephemeral',
        text: Msg('reflection.unknownCommand'),
      });
      return;
    }

    // repos サブコマンド - 監視対象リポジトリ一覧
    if (subCommand === 'repos') {
      const config = GetAdminConfig();
      const repos = config.githubRepos;

      if (repos.length === 0) {
        await respond({
          response_type: 'ephemeral',
          text: Msg('repos.empty'),
        });
        return;
      }

      const repoList = repos.map((repo, i) => `${i + 1}. \`${repo}\``).join('\n');
      await respond({
        response_type: 'ephemeral',
        text: Msg('repos.list', { count: String(repos.length), repoList }),
      });
      return;
    }

    // add-repo サブコマンド（管理者のみ）
    if (subCommand === 'add-repo') {
      if (!IsAdmin(userId)) {
        await respond({
          response_type: 'ephemeral',
          text: Msg('command.adminOnly'),
        });
        return;
      }

      const repoToAdd = parts[1] ?? '';
      if (!IsValidRepoFormat(repoToAdd)) {
        await respond({
          response_type: 'ephemeral',
          text: Msg('repos.invalidFormat', { command: 'add-repo' }),
        });
        return;
      }

      const config = GetAdminConfig();
      if (config.githubRepos.includes(repoToAdd)) {
        await respond({
          response_type: 'ephemeral',
          text: Msg('repos.alreadyAdded', { repo: repoToAdd }),
        });
        return;
      }

      const newRepos = [...config.githubRepos, repoToAdd];
      SaveAdminConfig({ ...config, githubRepos: newRepos });
      UpdateRepos(newRepos);

      await respond({
        response_type: 'ephemeral',
        text: Msg('repos.added', { repo: repoToAdd }),
      });
      return;
    }

    // remove-repo サブコマンド（管理者のみ）
    if (subCommand === 'remove-repo') {
      if (!IsAdmin(userId)) {
        await respond({
          response_type: 'ephemeral',
          text: Msg('command.adminOnly'),
        });
        return;
      }

      const repoToRemove = parts[1] ?? '';
      if (!IsValidRepoFormat(repoToRemove)) {
        await respond({
          response_type: 'ephemeral',
          text: Msg('repos.invalidFormat', { command: 'remove-repo' }),
        });
        return;
      }

      const config = GetAdminConfig();
      if (!config.githubRepos.includes(repoToRemove)) {
        await respond({
          response_type: 'ephemeral',
          text: Msg('repos.notFound', { repo: repoToRemove }),
        });
        return;
      }

      const newRepos = config.githubRepos.filter((r) => r !== repoToRemove);
      SaveAdminConfig({ ...config, githubRepos: newRepos });
      UpdateRepos(newRepos);

      await respond({
        response_type: 'ephemeral',
        text: Msg('repos.removed', { repo: repoToRemove }),
      });
      return;
    }

    // whitelist サブコマンド（管理者のみ）
    if (subCommand === 'whitelist') {
      if (!IsAdmin(userId)) {
        await respond({
          response_type: 'ephemeral',
          text: Msg('command.adminOnly'),
        });
        return;
      }

      const whitelistAction = parts[1]?.toLowerCase() ?? '';
      const config = GetAdminConfig();

      // whitelist のみ - 一覧表示
      if (!whitelistAction) {
        const slackUsers = config.allowedSlackUsers;
        const githubUsers = config.allowedGithubUsers;
        const mappings = config.userMappings;

        let text = Msg('whitelist.title');
        text += `*Slackユーザー* (${slackUsers.length}件):\n`;
        if (slackUsers.length > 0) {
          text += slackUsers.map((u) => {
            const mapping = mappings.find((m) => m.slack === u);
            return mapping ? `• <@${u}> → \`${mapping.github}\`` : `• <@${u}>`;
          }).join('\n');
        } else {
          text += '(なし)';
        }

        text += `\n\n*GitHubユーザー* (${githubUsers.length}件):\n`;
        if (githubUsers.length > 0) {
          text += githubUsers.map((u) => {
            const mapping = mappings.find((m) => m.github.toLowerCase() === u.toLowerCase());
            return mapping ? `• \`${u}\` → <@${mapping.slack}>` : `• \`${u}\``;
          }).join('\n');
        } else {
          text += '(なし)';
        }

        await respond({
          response_type: 'ephemeral',
          text,
        });
        return;
      }

      // whitelist add @user [github-username] - Slackユーザー追加（GitHub連携オプション付き）
      if (whitelistAction === 'add') {
        const userMention = parts[2] ?? '';
        const match = userMention.match(/<@([A-Z0-9]+)(?:\|[^>]+)?>/);
        if (!match) {
          await respond({
            response_type: 'ephemeral',
            text: Msg('whitelist.addMention', { command: 'add @user [github-username]' }),
          });
          return;
        }

        const targetUserId = match[1] ?? '';
        const githubUsername = parts[3] ?? '';
        let updatedConfig = { ...config };
        const results: string[] = [];

        // Slackユーザーをホワイトリストに追加
        if (config.allowedSlackUsers.includes(targetUserId)) {
          results.push(`<@${targetUserId}> は既にSlackホワイトリストに含まれています`);
        } else {
          updatedConfig = {
            ...updatedConfig,
            allowedSlackUsers: [...updatedConfig.allowedSlackUsers, targetUserId],
          };
          results.push(`<@${targetUserId}> をSlackホワイトリストに追加しました`);
        }

        // GitHubユーザー名が指定されている場合
        if (githubUsername) {
          if (!IsValidGitHubUsername(githubUsername)) {
            await respond({
              response_type: 'ephemeral',
              text: Msg('whitelist.invalidGithub'),
            });
            return;
          }

          const lowerUsername = githubUsername.toLowerCase();

          // GitHubユーザーをホワイトリストに追加
          if (updatedConfig.allowedGithubUsers.some((u) => u.toLowerCase() === lowerUsername)) {
            results.push(`\`${githubUsername}\` は既にGitHubホワイトリストに含まれています`);
          } else {
            updatedConfig = {
              ...updatedConfig,
              allowedGithubUsers: [...updatedConfig.allowedGithubUsers, githubUsername],
            };
            results.push(`\`${githubUsername}\` をGitHubホワイトリストに追加しました`);
          }

          // ユーザーマッピングを追加
          const existingMapping = updatedConfig.userMappings.find(
            (m) => m.slack === targetUserId || m.github.toLowerCase() === lowerUsername
          );
          if (existingMapping) {
            results.push(`マッピングは既に存在します（${existingMapping.github} ↔ <@${existingMapping.slack}>）`);
          } else {
            updatedConfig = {
              ...updatedConfig,
              userMappings: [...updatedConfig.userMappings, { github: githubUsername, slack: targetUserId }],
            };
            results.push(`マッピングを作成しました（\`${githubUsername}\` ↔ <@${targetUserId}>）`);
          }

          // GitHub ホワイトリストも通知
          UpdateGitHubAllowedUsers(updatedConfig.allowedGithubUsers);
        }

        SaveAdminConfig(updatedConfig);
        UpdateAllowedUsers(updatedConfig.allowedSlackUsers);

        await respond({
          response_type: 'ephemeral',
          text: Msg('whitelist.completed', { results: results.map((r) => `• ${r}`).join('\n') }),
        });
        return;
      }

      // whitelist add-github username - GitHubユーザー追加
      if (whitelistAction === 'add-github') {
        const githubUsername = parts[2] ?? '';
        if (!IsValidGitHubUsername(githubUsername)) {
          await respond({
            response_type: 'ephemeral',
            text: Msg('whitelist.invalidGithubUsage', { command: 'add-github' }),
          });
          return;
        }

        const lowerUsername = githubUsername.toLowerCase();
        if (config.allowedGithubUsers.some((u) => u.toLowerCase() === lowerUsername)) {
          await respond({
            response_type: 'ephemeral',
            text: Msg('whitelist.alreadyExists', { username: githubUsername }),
          });
          return;
        }

        const newGithubUsers = [...config.allowedGithubUsers, githubUsername];
        SaveAdminConfig({ ...config, allowedGithubUsers: newGithubUsers });
        UpdateGitHubAllowedUsers(newGithubUsers);

        await respond({
          response_type: 'ephemeral',
          text: Msg('whitelist.githubAdded', { username: githubUsername }),
        });
        return;
      }

      // whitelist remove @user - Slackユーザー削除
      if (whitelistAction === 'remove') {
        const userMention = parts[2] ?? '';
        const match = userMention.match(/<@([A-Z0-9]+)(?:\|[^>]+)?>/);
        if (!match) {
          await respond({
            response_type: 'ephemeral',
            text: Msg('whitelist.removeMention'),
          });
          return;
        }

        const targetUserId = match[1] ?? '';
        if (!config.allowedSlackUsers.includes(targetUserId)) {
          await respond({
            response_type: 'ephemeral',
            text: Msg('whitelist.notInList', { userId: targetUserId }),
          });
          return;
        }

        // 管理者自身は削除できない
        if (targetUserId === userId) {
          await respond({
            response_type: 'ephemeral',
            text: Msg('whitelist.cannotRemoveSelf'),
          });
          return;
        }

        const newSlackUsers = config.allowedSlackUsers.filter((u) => u !== targetUserId);
        // 関連するマッピングも削除
        const removedMapping = config.userMappings.find((m) => m.slack === targetUserId);
        const newMappings = config.userMappings.filter((m) => m.slack !== targetUserId);
        SaveAdminConfig({ ...config, allowedSlackUsers: newSlackUsers, userMappings: newMappings });
        UpdateAllowedUsers(newSlackUsers);

        let responseText = Msg('whitelist.removed', { userId: targetUserId });
        if (removedMapping) {
          responseText += `\nマッピング（\`${removedMapping.github}\` ↔ <@${targetUserId}>）も削除しました。`;
        }

        await respond({
          response_type: 'ephemeral',
          text: responseText,
        });
        return;
      }

      // whitelist remove-github username - GitHubユーザー削除
      if (whitelistAction === 'remove-github') {
        const githubUsername = parts[2] ?? '';
        if (!IsValidGitHubUsername(githubUsername)) {
          await respond({
            response_type: 'ephemeral',
            text: Msg('whitelist.invalidGithubUsage', { command: 'remove-github' }),
          });
          return;
        }

        const lowerUsername = githubUsername.toLowerCase();
        const existingUser = config.allowedGithubUsers.find(
          (u) => u.toLowerCase() === lowerUsername
        );
        if (!existingUser) {
          await respond({
            response_type: 'ephemeral',
            text: Msg('whitelist.githubNotInList', { username: githubUsername }),
          });
          return;
        }

        const newGithubUsers = config.allowedGithubUsers.filter(
          (u) => u.toLowerCase() !== lowerUsername
        );
        // 関連するマッピングも削除
        const removedMapping = config.userMappings.find(
          (m) => m.github.toLowerCase() === lowerUsername
        );
        const newMappings = config.userMappings.filter(
          (m) => m.github.toLowerCase() !== lowerUsername
        );
        SaveAdminConfig({ ...config, allowedGithubUsers: newGithubUsers, userMappings: newMappings });
        UpdateGitHubAllowedUsers(newGithubUsers);

        let responseText = Msg('whitelist.githubRemoved', { username: existingUser });
        if (removedMapping) {
          responseText += `\nマッピング（\`${existingUser}\` ↔ <@${removedMapping.slack}>）も削除しました。`;
        }

        await respond({
          response_type: 'ephemeral',
          text: responseText,
        });
        return;
      }

      // 不明なwhitelistサブコマンド
      await respond({
        response_type: 'ephemeral',
        text: Msg('whitelist.unknownCommand'),
      });
      return;
    }

    // owner/repo 形式のチェック（タスク実行）
    const firstPart = parts[0] ?? '';

    if (!IsValidRepoFormat(firstPart)) {
      await respond({
        response_type: 'ephemeral',
        text: Msg('command.invalidRepo'),
      });
      return;
    }

    const targetRepo = firstPart;
    const prompt = parts.slice(1).join(' ').trim();

    if (!prompt) {
      await respond({
        response_type: 'ephemeral',
        text: Msg('command.noMessage'),
      });
      return;
    }

    // チャンネルに開始通知を投稿（スレッドの起点となる）
    const startMessage = await app.client.chat.postMessage({
      channel: command.channel_id,
      text: Msg('command.start', { repo: targetRepo }),
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: Msg('command.execution', { repo: targetRepo, prompt: `${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}`, userId }),
          },
        },
      ],
    });

    const threadTs = startMessage.ts ?? '';

    const metadata: SlackTaskMetadata = {
      source: 'slack',
      channelId: command.channel_id,
      threadTs,
      userId,
      messageText: text,
      targetRepo,
    };

    await onMention(metadata, prompt);

    // ephemeral レスポンス
    await respond({
      response_type: 'ephemeral',
      text: Msg('command.started', { repo: targetRepo }),
    });
  });

  // @bot メンションの処理
  app.event('app_mention', async ({ event, say }) => {
    const text = event.text;
    const userId = event.user ?? 'unknown';
    const threadTs = event.thread_ts ?? event.ts;

    // ホワイトリストチェック
    if (!IsUserAllowed(userId)) {
      console.log(`Denied Slack request from ${userId} (not in whitelist)`);
      await say({
        text: 'このリクエストは処理できませんでした。',
        thread_ts: threadTs,
      });
      return;
    }

    // @bot を除いた指示テキスト
    const prompt = text.replace(/<@[A-Z0-9]+>/g, '').trim();

    if (!prompt) {
      await say({
        text: Msg('mention.emptyPrompt'),
        thread_ts: threadTs,
      });
      return;
    }

    // スレッドで処理開始を通知
    await say({
      text: Msg('mention.start'),
      thread_ts: threadTs,
    });

    const metadata: SlackTaskMetadata = {
      source: 'slack',
      channelId: event.channel,
      threadTs,
      userId,
      messageText: text,
    };

    await onMention(metadata, prompt);
  });

  // 承認ボタンのクリック処理（モーダルを開く）
  app.action('approval_allow', async ({ ack, body, client }) => {
    await ack();

    if (body.type !== 'block_actions') return;

    const action = body.actions[0];
    if (!action || action.type !== 'button') return;

    const requestId = action.value;
    console.log(`[approval_allow] requestId: ${requestId}`);
    if (!requestId) return;

    const pending = _pendingApprovals.get(requestId);
    console.log(`[approval_allow] pending found: ${!!pending}, pendingApprovals size: ${_pendingApprovals.size}`);
    if (!pending) return;

    // 権限チェック: リクエストした人だけが承認可能
    if (pending.requestedBySlackId && body.user.id !== pending.requestedBySlackId) {
      await client.chat.postEphemeral({
        channel: pending.channelId,
        user: body.user.id,
        text: Msg('approval.onlyRequester'),
      });
      return;
    }

    // モーダルを開く
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: `approval_modal_allow_${requestId}`,
        title: {
          type: 'plain_text',
          text: '実行を許可',
        },
        submit: {
          type: 'plain_text',
          text: '許可する',
        },
        close: {
          type: 'plain_text',
          text: 'キャンセル',
        },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*ツール:* ${pending.tool}\n*コマンド:*\n\`\`\`${pending.command.slice(0, 500)}\`\`\``,
            },
          },
          {
            type: 'input',
            block_id: 'comment_block',
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'comment_input',
              multiline: true,
              placeholder: {
                type: 'plain_text',
                text: 'コメントがあれば入力してください（任意）',
              },
            },
            label: {
              type: 'plain_text',
              text: 'コメント',
            },
          },
        ],
      },
    });
  });

  app.action('approval_deny', async ({ ack, body, client }) => {
    await ack();

    if (body.type !== 'block_actions') return;

    const action = body.actions[0];
    if (!action || action.type !== 'button') return;

    const requestId = action.value;
    if (!requestId) return;

    const pending = _pendingApprovals.get(requestId);
    if (!pending) return;

    // 権限チェック: リクエストした人だけが拒否可能
    if (pending.requestedBySlackId && body.user.id !== pending.requestedBySlackId) {
      await client.chat.postEphemeral({
        channel: pending.channelId,
        user: body.user.id,
        text: Msg('approval.onlyRequester'),
      });
      return;
    }

    // モーダルを開く
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: `approval_modal_deny_${requestId}`,
        title: {
          type: 'plain_text',
          text: '実行を拒否',
        },
        submit: {
          type: 'plain_text',
          text: '拒否する',
        },
        close: {
          type: 'plain_text',
          text: 'キャンセル',
        },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*ツール:* ${pending.tool}\n*コマンド:*\n\`\`\`${pending.command.slice(0, 500)}\`\`\``,
            },
          },
          {
            type: 'input',
            block_id: 'comment_block',
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'comment_input',
              multiline: true,
              placeholder: {
                type: 'plain_text',
                text: '拒否理由や代替案があれば入力してください（任意）',
              },
            },
            label: {
              type: 'plain_text',
              text: 'コメント',
            },
          },
        ],
      },
    });
  });

  // モーダル送信処理（許可）
  app.view(/^approval_modal_allow_/, async ({ ack, view, body, client }) => {
    await ack();

    const callbackId = view.callback_id;
    const requestId = callbackId.replace('approval_modal_allow_', '');
    console.log(`[modal_allow] callbackId: ${callbackId}, requestId: ${requestId}`);

    const pending = _pendingApprovals.get(requestId);
    console.log(`[modal_allow] pending found: ${!!pending}, pendingApprovals size: ${_pendingApprovals.size}`);
    if (!pending) return;

    // コメントを取得
    const commentBlock = view.state.values['comment_block'];
    const comment = commentBlock?.['comment_input']?.value ?? '';

    // 承認を解決
    console.log(`[modal_allow] Resolving approval with decision: allow`);
    pending.resolve({
      decision: 'allow',
      comment: comment || undefined,
      respondedBy: body.user.id,
    });
    _pendingApprovals.delete(requestId);
    console.log(`[modal_allow] Deleted from pendingApprovals, size: ${_pendingApprovals.size}`);

    // 元のメッセージを更新
    let updateText = `✅ *許可されました* by <@${body.user.id}>`;
    if (comment) {
      updateText += `\n💬 コメント: ${comment}`;
    }

    await client.chat.update({
      channel: pending.channelId,
      ts: pending.messageTs,
      text: '✅ 許可されました',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: updateText,
          },
        },
      ],
    });
  });

  // モーダル送信処理（拒否）
  app.view(/^approval_modal_deny_/, async ({ ack, view, body, client }) => {
    await ack();

    const callbackId = view.callback_id;
    const requestId = callbackId.replace('approval_modal_deny_', '');

    const pending = _pendingApprovals.get(requestId);
    if (!pending) return;

    // コメントを取得
    const commentBlock = view.state.values['comment_block'];
    const comment = commentBlock?.['comment_input']?.value ?? '';

    // 拒否を解決
    pending.resolve({
      decision: 'deny',
      comment: comment || undefined,
      respondedBy: body.user.id,
    });
    _pendingApprovals.delete(requestId);

    // 元のメッセージを更新
    let updateText = `❌ *拒否されました* by <@${body.user.id}>`;
    if (comment) {
      updateText += `\n💬 コメント: ${comment}`;
    }

    await client.chat.update({
      channel: pending.channelId,
      ts: pending.messageTs,
      text: '❌ 拒否されました',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: updateText,
          },
        },
      ],
    });
  });

  // 質問への回答ボタン（動的アクションID対応）
  app.action(/^answer_/, async ({ ack, body, client }) => {
    await ack();

    if (body.type !== 'block_actions') return;

    const action = body.actions[0];
    if (!action || action.type !== 'button') return;

    // action_id から requestId と answer を抽出
    // フォーマット: answer_{requestId}_{answerIndex}
    const parts = action.action_id.split('_');
    if (parts.length < 3) return;

    const requestId = parts[1];
    const answer = action.value ?? '';

    if (!requestId) return;

    const pending = _pendingQuestions.get(requestId);
    if (pending) {
      pending.resolve(answer);
      _pendingQuestions.delete(requestId);

      // メッセージを更新
      await client.chat.update({
        channel: body.channel?.id ?? channelId,
        ts: body.message?.ts ?? '',
        text: `回答: ${answer}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `💬 *回答:* ${answer} by <@${body.user.id}>`,
            },
          },
        ],
      });
    }
  });

  // 提案承認ボタン（モーダルで追加コメント入力）
  app.action(/^suggestion_approve_/, async ({ ack, body, client }) => {
    await ack();

    if (body.type !== 'block_actions') return;

    const action = body.actions[0];
    if (!action || action.type !== 'button') return;

    const suggestionId = action.value ?? '';
    if (!suggestionId) return;

    // モーダルを開く
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: `suggestion_modal_approve_${suggestionId}`,
        title: {
          type: 'plain_text',
          text: '提案を実行',
        },
        submit: {
          type: 'plain_text',
          text: '実行する',
        },
        close: {
          type: 'plain_text',
          text: 'キャンセル',
        },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: Msg('suggestion.modalText'),
            },
          },
          {
            type: 'input',
            block_id: 'suggestion_comment_block',
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'suggestion_comment_input',
              multiline: true,
              placeholder: {
                type: 'plain_text',
                text: '追加の指示があれば入力してください（任意）',
              },
            },
            label: {
              type: 'plain_text',
              text: '追加コメント',
            },
          },
        ],
      },
    });
  });

  // 提案却下ボタン
  app.action(/^suggestion_reject_/, async ({ ack, body, client }) => {
    await ack();

    if (body.type !== 'block_actions') return;

    const action = body.actions[0];
    if (!action || action.type !== 'button') return;

    const suggestionId = action.value ?? '';
    if (!suggestionId) return;

    const reflectionStore = GetReflectionStore();
    reflectionStore.UpdateSuggestionStatus(suggestionId, 'rejected', body.user.id);

    // メッセージを更新
    await client.chat.update({
      channel: body.channel?.id ?? channelId,
      ts: body.message?.ts ?? '',
      text: '提案が却下されました',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `❌ *却下されました* by <@${body.user.id}>`,
          },
        },
      ],
    });
  });

  // 提案承認モーダルの送信処理
  app.view(/^suggestion_modal_approve_/, async ({ ack, view, body, client }) => {
    await ack();

    const callbackId = view.callback_id;
    const suggestionId = callbackId.replace('suggestion_modal_approve_', '');

    const reflectionStore = GetReflectionStore();
    const found = reflectionStore.GetSuggestion(suggestionId);
    if (!found) return;

    const { suggestion } = found;

    // コメントを取得
    const commentBlock = view.state.values['suggestion_comment_block'];
    const comment = commentBlock?.['suggestion_comment_input']?.value ?? '';

    // ステータスを更新
    reflectionStore.UpdateSuggestionStatus(suggestionId, 'approved', body.user.id);

    // タスクとして実行
    if (_onSuggestionApproved) {
      const prompt = `${suggestion.title}\n\n${suggestion.description}${comment ? `\n\n追加指示: ${comment}` : ''}`;

      // 開始メッセージを投稿
      const startResult = await client.chat.postMessage({
        channel: channelId,
        text: Msg('suggestion.execute', { title: suggestion.title }),
      });

      const threadTs = startResult.ts ?? '';

      const metadata: SlackTaskMetadata = {
        source: 'slack',
        channelId,
        threadTs,
        userId: body.user.id,
        messageText: prompt,
        targetRepo: suggestion.relatedRepo,
      };

      await _onSuggestionApproved(metadata, prompt);

      // ステータスを実行中に更新
      reflectionStore.UpdateSuggestionStatus(suggestionId, 'executing');
    }
  });
}

/**
 * 承認リクエストを Slack に送信し、回答を待つ（モーダル対応）
 */
export async function RequestApproval(
  app: App,
  channelId: string,
  requestId: string,
  taskId: string,
  tool: string,
  command: string,
  threadTs?: string,
  requestedBySlackId?: string
): Promise<ApprovalResult> {
  // スレッドに投稿されるか確認用ログ
  console.log(`RequestApproval: channelId=${channelId}, threadTs=${threadTs ?? 'undefined'}`);
  if (!threadTs) {
    console.warn(`WARNING: RequestApproval called without threadTs - message will go to channel`);
  }

  return new Promise((resolve) => {
    // 先に承認待ちとして登録（ボタンクリック時に参照できるように）
    _pendingApprovals.set(requestId, {
      requestId,
      taskId,
      tool,
      command,
      channelId,
      messageTs: '', // 後で更新
      requestedBySlackId,
      resolve,
    });

    // メンションテキストを構築
    const mentionText = requestedBySlackId
      ? Msg('approval.mentionRequest', { userId: requestedBySlackId })
      : '';

    // Slack にメッセージを送信（threadTs がある場合はスレッドに投稿）
    void app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: Msg('approval.requestText', { tool }),
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: Msg('approval.requestHeader'),
            emoji: true,
          },
        },
        ...(mentionText
          ? [
              {
                type: 'section' as const,
                text: {
                  type: 'mrkdwn' as const,
                  text: mentionText,
                },
              },
            ]
          : []),
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*ツール:*\n${tool}`,
            },
            {
              type: 'mrkdwn',
              text: `*タスクID:*\n${taskId.slice(0, 8)}...`,
            },
          ],
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*詳細:*\n\`\`\`${command.slice(0, 500)}${command.length > 500 ? '...' : ''}\`\`\``,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '✅ 許可',
                emoji: true,
              },
              style: 'primary',
              action_id: 'approval_allow',
              value: requestId,
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '❌ 拒否',
                emoji: true,
              },
              style: 'danger',
              action_id: 'approval_deny',
              value: requestId,
            },
          ],
        },
      ],
    }).then((result) => {
      // messageTsを更新
      const pending = _pendingApprovals.get(requestId);
      if (pending) {
        _pendingApprovals.set(requestId, {
          ...pending,
          messageTs: result.ts ?? '',
        });
      }
    });
  });
}

/**
 * 質問を Slack に送信し、回答を待つ
 */
export async function AskQuestion(
  app: App,
  channelId: string,
  requestId: string,
  taskId: string,
  question: string,
  options: readonly string[],
  threadTs?: string
): Promise<string> {
  return new Promise((resolve) => {
    // 質問待ちとして登録
    _pendingQuestions.set(requestId, {
      requestId,
      taskId,
      resolve,
    });

    // 選択肢ボタンを生成
    const buttons = options.map((option, index) => ({
      type: 'button' as const,
      text: {
        type: 'plain_text' as const,
        text: option,
        emoji: true,
      },
      action_id: `answer_${requestId}_${index}`,
      value: option,
    }));

    // Slack にメッセージを送信
    void app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: Msg('question.text', { question }),
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: Msg('question.header'),
            emoji: true,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: question,
          },
        },
        {
          type: 'actions',
          elements: buttons,
        },
      ],
    });
  });
}

/**
 * GitHub Issue 用のスレッドを作成する
 */
export async function CreateIssueThread(
  app: App,
  channelId: string,
  owner: string,
  repo: string,
  issueNumber: number,
  issueTitle: string,
  issueUrl: string
): Promise<string> {
  const result = await app.client.chat.postMessage({
    channel: channelId,
    text: Msg('issue.startText'),
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: Msg('issue.startHeader'),
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*<${issueUrl}|#${issueNumber}: ${issueTitle}>*\n\`${owner}/${repo}\``,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: Msg('issue.threadContext'),
          },
        ],
      },
    ],
  });

  return result.ts ?? '';
}

/**
 * 処理開始を通知する
 */
export async function NotifyTaskStarted(
  app: App,
  channelId: string,
  _taskId: string,
  description: string,
  threadTs?: string
): Promise<string> {
  const result = await app.client.chat.postMessage({
    channel: channelId,
    text: Msg('task.started', { description }),
    thread_ts: threadTs,
  });
  return result.ts ?? '';
}

/**
 * 処理完了を通知する
 */
export async function NotifyTaskCompleted(
  app: App,
  channelId: string,
  _taskId: string,
  message: string,
  prUrl?: string,
  threadTs?: string
): Promise<void> {
  let text = Msg('task.completed', { message });
  if (prUrl) {
    text += Msg('task.completedPr', { prUrl });
  }

  await app.client.chat.postMessage({
    channel: channelId,
    text,
    thread_ts: threadTs,
  });
}

/**
 * エラーを通知する
 */
export async function NotifyError(
  app: App,
  channelId: string,
  _taskId: string,
  error: string,
  threadTs?: string
): Promise<void> {
  await app.client.chat.postMessage({
    channel: channelId,
    text: Msg('task.error', { error }),
    thread_ts: threadTs,
  });
}

/**
 * 進捗を通知する
 */
export async function NotifyProgress(
  app: App,
  channelId: string,
  message: string,
  threadTs?: string
): Promise<void> {
  await app.client.chat.postMessage({
    channel: channelId,
    text: Msg('task.progress', { message }),
    thread_ts: threadTs,
  });
}

/**
 * 作業ログを通知する（ツール使用状況など）
 */
export async function NotifyWorkLog(
  app: App,
  channelId: string,
  logType: 'tool_start' | 'tool_end' | 'thinking' | 'text' | 'error' | 'approval_pending',
  message: string,
  details?: string,
  threadTs?: string
): Promise<void> {
  // ログタイプに応じた絵文字を選択
  const emoji: Record<string, string> = {
    tool_start: '🔧',
    tool_end: '✅',
    thinking: '🤔',
    text: '💬',
    error: '❌',
    approval_pending: '⏳',
  };

  const icon = emoji[logType] ?? '📋';

  // 詳細がある場合はフォーマット
  let text = `${icon} ${message}`;
  if (details) {
    text += `\n\`${details.slice(0, 100)}${details.length > 100 ? '...' : ''}\``;
  }

  await app.client.chat.postMessage({
    channel: channelId,
    text,
    thread_ts: threadTs,
  });
}
