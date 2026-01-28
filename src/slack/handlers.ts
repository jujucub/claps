/**
 * sumomo - Slack イベントハンドラー
 * メンション、ボタンクリック、メッセージの処理
 */

import type { App } from '@slack/bolt';
import type {
  ApprovalDecision,
  SlackTaskMetadata,
} from '../types/index.js';

// 承認待ちリクエストの管理
interface PendingApproval {
  readonly requestId: string;
  readonly taskId: string;
  resolve: (decision: ApprovalDecision) => void;
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
 * Slack ハンドラーを登録する
 */
export function RegisterSlackHandlers(
  app: App,
  channelId: string,
  onMention: (metadata: SlackTaskMetadata, prompt: string) => Promise<void>
): void {
  // @sumomo メンションの処理
  app.event('app_mention', async ({ event, say }) => {
    const text = event.text;
    const userId = event.user ?? 'unknown';
    const threadTs = event.thread_ts ?? event.ts;

    // @sumomo を除いた指示テキスト
    const prompt = text.replace(/<@[A-Z0-9]+>/g, '').trim();

    if (!prompt) {
      await say({
        text: '何をお手伝いしましょうか？',
        thread_ts: threadTs,
      });
      return;
    }

    // スレッドで処理開始を通知
    await say({
      text: '🍑 処理を開始します...',
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

  // 承認ボタンのクリック処理
  app.action('approval_allow', async ({ ack, body, client }) => {
    await ack();

    if (body.type !== 'block_actions') return;

    const action = body.actions[0];
    if (!action || action.type !== 'button') return;

    const requestId = action.value;
    if (!requestId) return;

    const pending = _pendingApprovals.get(requestId);
    if (pending) {
      pending.resolve('allow');
      _pendingApprovals.delete(requestId);

      // メッセージを更新
      await client.chat.update({
        channel: body.channel?.id ?? channelId,
        ts: body.message?.ts ?? '',
        text: '✅ 許可されました',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `✅ *許可されました* by <@${body.user.id}>`,
            },
          },
        ],
      });
    }
  });

  app.action('approval_deny', async ({ ack, body, client }) => {
    await ack();

    if (body.type !== 'block_actions') return;

    const action = body.actions[0];
    if (!action || action.type !== 'button') return;

    const requestId = action.value;
    if (!requestId) return;

    const pending = _pendingApprovals.get(requestId);
    if (pending) {
      pending.resolve('deny');
      _pendingApprovals.delete(requestId);

      // メッセージを更新
      await client.chat.update({
        channel: body.channel?.id ?? channelId,
        ts: body.message?.ts ?? '',
        text: '❌ 拒否されました',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `❌ *拒否されました* by <@${body.user.id}>`,
            },
          },
        ],
      });
    }
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
 * 承認リクエストを Slack に送信し、回答を待つ
 */
export async function RequestApproval(
  app: App,
  channelId: string,
  requestId: string,
  taskId: string,
  tool: string,
  command: string
): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    // 承認待ちとして登録
    _pendingApprovals.set(requestId, {
      requestId,
      taskId,
      resolve,
    });

    // Slack にメッセージを送信
    void app.client.chat.postMessage({
      channel: channelId,
      text: `🍑 実行許可リクエスト: ${tool}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '🍑 sumomo 実行許可リクエスト',
            emoji: true,
          },
        },
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
  options: readonly string[]
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
      text: `🍑 質問: ${question}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '🍑 sumomo からの質問',
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
    text: `🍑 処理を開始します: ${description}`,
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
  let text = `🍑 ${message}`;
  if (prUrl) {
    text += `\nPR: ${prUrl}`;
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
    text: `🍑 エラーが発生しました: ${error}`,
    thread_ts: threadTs,
  });
}
