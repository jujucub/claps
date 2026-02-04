/**
 * sumomo - Slack イベントハンドラー
 * メンション、ボタンクリック、モーダル、メッセージの処理
 */

import type { App } from '@slack/bolt';
import type {
  ApprovalResult,
  SlackTaskMetadata,
  AllowedUsers,
} from '../types/index.js';
import {
  GetAdminSlackUser,
  GetAdminConfig,
  SaveAdminConfig,
} from '../admin/store.js';
import { UpdateRepos } from '../github/poller.js';
import { UpdateAllowedUsers as UpdateGitHubAllowedUsers } from '../github/poller.js';

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

  // /sumomo スラッシュコマンドの処理
  app.command('/sumomo', async ({ command, ack, respond }) => {
    await ack();

    const userId = command.user_id;

    // ホワイトリストチェック
    if (!IsUserAllowed(userId)) {
      console.log(`Denied Slack command from ${userId} (not in whitelist)`);
      await respond({
        response_type: 'ephemeral',
        text: 'このコマンドを使用する権限がないのです。',
      });
      return;
    }

    const text = command.text.trim();
    const parts = text.split(/\s+/);
    const subCommand = parts[0]?.toLowerCase() ?? '';

    // ヘルプ表示
    if (!text || subCommand === 'help') {
      const isAdmin = IsAdmin(userId);
      let helpText = `🍑 *すももコマンドの使い方*

*基本コマンド:*
\`/sumomo owner/repo メッセージ\`
→ 指定したリポジトリの環境でClaudeを実行

\`/sumomo repos\`
→ 監視対象リポジトリの一覧を表示

*例:*
\`/sumomo h-sato/my-project バグを修正して\``;

      if (isAdmin) {
        helpText += `

*管理者コマンド:*
\`/sumomo add-repo owner/repo\`
→ 監視リポジトリを追加

\`/sumomo remove-repo owner/repo\`
→ 監視リポジトリを削除

\`/sumomo whitelist\`
→ ホワイトリストを表示

\`/sumomo whitelist add @user\`
→ Slackユーザーをホワイトリストに追加

\`/sumomo whitelist add-github username\`
→ GitHubユーザーをホワイトリストに追加

\`/sumomo whitelist remove @user\`
→ Slackユーザーをホワイトリストから削除

\`/sumomo whitelist remove-github username\`
→ GitHubユーザーをホワイトリストから削除`;
      }

      await respond({
        response_type: 'ephemeral',
        text: helpText,
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
          text: '🍑 監視対象のリポジトリはまだ登録されていないのです。',
        });
        return;
      }

      const repoList = repos.map((repo, i) => `${i + 1}. \`${repo}\``).join('\n');
      await respond({
        response_type: 'ephemeral',
        text: `🍑 *監視対象リポジトリ一覧* (${repos.length}件)\n\n${repoList}`,
      });
      return;
    }

    // add-repo サブコマンド（管理者のみ）
    if (subCommand === 'add-repo') {
      if (!IsAdmin(userId)) {
        await respond({
          response_type: 'ephemeral',
          text: '🍑 このコマンドは管理者のみ使用できるのです。',
        });
        return;
      }

      const repoToAdd = parts[1] ?? '';
      if (!IsValidRepoFormat(repoToAdd)) {
        await respond({
          response_type: 'ephemeral',
          text: '🍑 リポジトリの形式が正しくないのです。\n使い方: `/sumomo add-repo owner/repo`',
        });
        return;
      }

      const config = GetAdminConfig();
      if (config.githubRepos.includes(repoToAdd)) {
        await respond({
          response_type: 'ephemeral',
          text: `🍑 \`${repoToAdd}\` は既に監視対象に含まれているのです。`,
        });
        return;
      }

      const newRepos = [...config.githubRepos, repoToAdd];
      SaveAdminConfig({ ...config, githubRepos: newRepos });
      UpdateRepos(newRepos);

      await respond({
        response_type: 'ephemeral',
        text: `🍑 \`${repoToAdd}\` を監視対象に追加したのでーす！`,
      });
      return;
    }

    // remove-repo サブコマンド（管理者のみ）
    if (subCommand === 'remove-repo') {
      if (!IsAdmin(userId)) {
        await respond({
          response_type: 'ephemeral',
          text: '🍑 このコマンドは管理者のみ使用できるのです。',
        });
        return;
      }

      const repoToRemove = parts[1] ?? '';
      if (!IsValidRepoFormat(repoToRemove)) {
        await respond({
          response_type: 'ephemeral',
          text: '🍑 リポジトリの形式が正しくないのです。\n使い方: `/sumomo remove-repo owner/repo`',
        });
        return;
      }

      const config = GetAdminConfig();
      if (!config.githubRepos.includes(repoToRemove)) {
        await respond({
          response_type: 'ephemeral',
          text: `🍑 \`${repoToRemove}\` は監視対象に含まれていないのです。`,
        });
        return;
      }

      const newRepos = config.githubRepos.filter((r) => r !== repoToRemove);
      SaveAdminConfig({ ...config, githubRepos: newRepos });
      UpdateRepos(newRepos);

      await respond({
        response_type: 'ephemeral',
        text: `🍑 \`${repoToRemove}\` を監視対象から削除したのでーす！`,
      });
      return;
    }

    // whitelist サブコマンド（管理者のみ）
    if (subCommand === 'whitelist') {
      if (!IsAdmin(userId)) {
        await respond({
          response_type: 'ephemeral',
          text: '🍑 このコマンドは管理者のみ使用できるのです。',
        });
        return;
      }

      const whitelistAction = parts[1]?.toLowerCase() ?? '';
      const config = GetAdminConfig();

      // whitelist のみ - 一覧表示
      if (!whitelistAction) {
        const slackUsers = config.allowedSlackUsers;
        const githubUsers = config.allowedGithubUsers;

        let text = '🍑 *ホワイトリスト*\n\n';
        text += `*Slackユーザー* (${slackUsers.length}件):\n`;
        if (slackUsers.length > 0) {
          text += slackUsers.map((u) => `• <@${u}>`).join('\n');
        } else {
          text += '(なし)';
        }

        text += `\n\n*GitHubユーザー* (${githubUsers.length}件):\n`;
        if (githubUsers.length > 0) {
          text += githubUsers.map((u) => `• \`${u}\``).join('\n');
        } else {
          text += '(なし)';
        }

        await respond({
          response_type: 'ephemeral',
          text,
        });
        return;
      }

      // whitelist add @user - Slackユーザー追加
      if (whitelistAction === 'add') {
        const userMention = parts[2] ?? '';
        const match = userMention.match(/<@([A-Z0-9]+)(?:\|[^>]+)?>/);
        if (!match) {
          await respond({
            response_type: 'ephemeral',
            text: '🍑 ユーザーを@メンションで指定してくださいなのです。\n使い方: `/sumomo whitelist add @user`',
          });
          return;
        }

        const targetUserId = match[1] ?? '';
        if (config.allowedSlackUsers.includes(targetUserId)) {
          await respond({
            response_type: 'ephemeral',
            text: `🍑 <@${targetUserId}> は既にホワイトリストに含まれているのです。`,
          });
          return;
        }

        const newSlackUsers = [...config.allowedSlackUsers, targetUserId];
        SaveAdminConfig({ ...config, allowedSlackUsers: newSlackUsers });
        UpdateAllowedUsers(newSlackUsers);

        await respond({
          response_type: 'ephemeral',
          text: `🍑 <@${targetUserId}> をホワイトリストに追加したのでーす！`,
        });
        return;
      }

      // whitelist add-github username - GitHubユーザー追加
      if (whitelistAction === 'add-github') {
        const githubUsername = parts[2] ?? '';
        if (!IsValidGitHubUsername(githubUsername)) {
          await respond({
            response_type: 'ephemeral',
            text: '🍑 GitHubユーザー名が正しくないのです。\n英数字とハイフンのみ使用可能（1〜39文字）\n使い方: `/sumomo whitelist add-github username`',
          });
          return;
        }

        const lowerUsername = githubUsername.toLowerCase();
        if (config.allowedGithubUsers.some((u) => u.toLowerCase() === lowerUsername)) {
          await respond({
            response_type: 'ephemeral',
            text: `🍑 \`${githubUsername}\` は既にホワイトリストに含まれているのです。`,
          });
          return;
        }

        const newGithubUsers = [...config.allowedGithubUsers, githubUsername];
        SaveAdminConfig({ ...config, allowedGithubUsers: newGithubUsers });
        UpdateGitHubAllowedUsers(newGithubUsers);

        await respond({
          response_type: 'ephemeral',
          text: `🍑 GitHubユーザー \`${githubUsername}\` をホワイトリストに追加したのでーす！`,
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
            text: '🍑 ユーザーを@メンションで指定してくださいなのです。\n使い方: `/sumomo whitelist remove @user`',
          });
          return;
        }

        const targetUserId = match[1] ?? '';
        if (!config.allowedSlackUsers.includes(targetUserId)) {
          await respond({
            response_type: 'ephemeral',
            text: `🍑 <@${targetUserId}> はホワイトリストに含まれていないのです。`,
          });
          return;
        }

        // 管理者自身は削除できない
        if (targetUserId === userId) {
          await respond({
            response_type: 'ephemeral',
            text: '🍑 自分自身をホワイトリストから削除することはできないのです。',
          });
          return;
        }

        const newSlackUsers = config.allowedSlackUsers.filter((u) => u !== targetUserId);
        SaveAdminConfig({ ...config, allowedSlackUsers: newSlackUsers });
        UpdateAllowedUsers(newSlackUsers);

        await respond({
          response_type: 'ephemeral',
          text: `🍑 <@${targetUserId}> をホワイトリストから削除したのでーす！`,
        });
        return;
      }

      // whitelist remove-github username - GitHubユーザー削除
      if (whitelistAction === 'remove-github') {
        const githubUsername = parts[2] ?? '';
        if (!IsValidGitHubUsername(githubUsername)) {
          await respond({
            response_type: 'ephemeral',
            text: '🍑 GitHubユーザー名が正しくないのです。\n英数字とハイフンのみ使用可能（1〜39文字）\n使い方: `/sumomo whitelist remove-github username`',
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
            text: `🍑 \`${githubUsername}\` はホワイトリストに含まれていないのです。`,
          });
          return;
        }

        const newGithubUsers = config.allowedGithubUsers.filter(
          (u) => u.toLowerCase() !== lowerUsername
        );
        SaveAdminConfig({ ...config, allowedGithubUsers: newGithubUsers });
        UpdateGitHubAllowedUsers(newGithubUsers);

        await respond({
          response_type: 'ephemeral',
          text: `🍑 GitHubユーザー \`${existingUser}\` をホワイトリストから削除したのでーす！`,
        });
        return;
      }

      // 不明なwhitelistサブコマンド
      await respond({
        response_type: 'ephemeral',
        text: '🍑 不明なサブコマンドなのです。\n使い方: `/sumomo whitelist [add|add-github|remove|remove-github]`',
      });
      return;
    }

    // owner/repo 形式のチェック（タスク実行）
    const firstPart = parts[0] ?? '';

    if (!IsValidRepoFormat(firstPart)) {
      await respond({
        response_type: 'ephemeral',
        text: `🍑 リポジトリの形式が正しくないか、不明なコマンドなのです。\n\n使い方: \`/sumomo owner/repo メッセージ\`\nヘルプ: \`/sumomo help\``,
      });
      return;
    }

    const targetRepo = firstPart;
    const prompt = parts.slice(1).join(' ').trim();

    if (!prompt) {
      await respond({
        response_type: 'ephemeral',
        text: '🍑 メッセージを入力してくださいなのです！\n\n例: `/sumomo owner/repo バグを修正して`',
      });
      return;
    }

    // チャンネルに開始通知を投稿（スレッドの起点となる）
    const startMessage = await app.client.chat.postMessage({
      channel: command.channel_id,
      text: `🍑 あいっ！\`${targetRepo}\` で処理を開始するのでーす！`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `🍑 *すももコマンド実行*\nリポジトリ: \`${targetRepo}\`\nリクエスト: ${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}\n実行者: <@${userId}>`,
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
      text: `🍑 \`${targetRepo}\` で処理を開始したのでーす！スレッドで進捗を確認できます。`,
    });
  });

  // @sumomo メンションの処理
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

    // @sumomo を除いた指示テキスト
    const prompt = text.replace(/<@[A-Z0-9]+>/g, '').trim();

    if (!prompt) {
      await say({
        text: 'はいっ！何をお手伝いしましょうか〜？ご用件をお聞かせくださいなのです！',
        thread_ts: threadTs,
      });
      return;
    }

    // スレッドで処理開始を通知
    await say({
      text: '🍑 あいっ！処理を開始するのでーす！',
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
        text: '🍑 この承認はリクエストした人だけができるのです！',
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
        text: '🍑 この承認はリクエストした人だけができるのです！',
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
      ? `<@${requestedBySlackId}> 承認をお願いするのでーす！`
      : '';

    // Slack にメッセージを送信（threadTs がある場合はスレッドに投稿）
    void app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `🍑 実行許可リクエストなのです: ${tool}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '🍑 すももからの実行許可リクエストであります！',
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
      text: `🍑 お聞きしたいことがあるのです: ${question}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '🍑 すももからの質問なのでーす！',
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
    text: `🍑 あいっ！GitHub Issue の処理を開始するのでーす！`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '🍑 GitHub Issue 処理開始であります！',
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
            text: '処理の進捗はこのスレッドに投稿するのです！お楽しみに〜♪',
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
    text: `🍑 了解であります！処理を開始するのでーす: ${description}`,
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
  let text = `🍑 任務完了であります！${message}`;
  if (prUrl) {
    text += `\nPRを作成したのでーす: ${prUrl}`;
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
    text: `🍑 あわわ…エラーが発生してしまったのです…: ${error}`,
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
    text: `🍑 ${message}`,
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
