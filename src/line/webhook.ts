/**
 * claps - LINE Webhook ハンドラ
 * Express router + @line/bot-sdk middleware で署名検証・イベント処理
 */

import { Router, type Request, type Response } from 'express';
import { middleware as lineMiddleware } from '@line/bot-sdk';
import type { WebhookRequestBody, WebhookEvent, MessageEvent, PostbackEvent, TextEventMessage } from '@line/bot-sdk';

// Webhook イベントコールバック型
export interface LineWebhookCallbacks {
  /** テキストメッセージ受信 */
  readonly onTextMessage: (userId: string, messageText: string, replyToken: string) => void;
  /** Postback（承認/質問応答） */
  readonly onPostback: (userId: string, data: string, replyToken: string) => void;
}

/**
 * LINE Webhook Express Router を作成する
 *
 * @param channelSecret LINE Channel Secret（署名検証用）
 * @param callbacks イベントコールバック
 * @returns Express Router
 */
export function CreateLineWebhookRouter(
  channelSecret: string,
  callbacks: LineWebhookCallbacks
): Router {
  const router = Router();

  // @line/bot-sdk の署名検証ミドルウェア
  // NOTE: middleware は raw body を必要とするため、express.json() より前に適用する必要がある
  // ただし Express Router にマウントする場合、親の express.json() パースとの競合に注意
  // → line middleware は自前で body をパースするので、このルートでは express.json() を経由させない
  router.post(
    '/webhook/line',
    lineMiddleware({ channelSecret }),
    (req: Request, res: Response) => {
      // 即座に 200 を返す（LINE Platform の要件）
      res.status(200).end();

      // イベントを非同期で処理
      const body = req.body as WebhookRequestBody;
      if (!body.events || !Array.isArray(body.events)) {
        return;
      }

      for (const event of body.events) {
        HandleEvent(event as WebhookEvent, callbacks);
      }
    }
  );

  return router;
}

/**
 * Webhook イベントを処理する
 */
function HandleEvent(event: WebhookEvent, callbacks: LineWebhookCallbacks): void {
  switch (event.type) {
    case 'message':
      HandleMessageEvent(event as MessageEvent, callbacks);
      break;
    case 'postback':
      HandlePostbackEvent(event as PostbackEvent, callbacks);
      break;
    case 'follow':
      // フォローイベント（ウェルカムメッセージ等は将来対応）
      console.log(`[LINE] New follower: ${event.source.userId ?? 'unknown'}`);
      break;
    default:
      // その他のイベントは無視
      break;
  }
}

/**
 * テキストメッセージイベントを処理する
 */
function HandleMessageEvent(event: MessageEvent, callbacks: LineWebhookCallbacks): void {
  if (event.message.type !== 'text') {
    // テキスト以外は無視
    return;
  }

  const userId = event.source.userId;
  if (!userId) {
    console.warn('[LINE] Message event without userId');
    return;
  }

  const textMessage = event.message as TextEventMessage;
  const replyToken = event.replyToken;

  console.log(`[LINE] Text message from ${userId}: ${textMessage.text.slice(0, 50)}...`);
  callbacks.onTextMessage(userId, textMessage.text, replyToken);
}

/**
 * Postbackイベントを処理する（承認/質問応答の Quick Reply）
 */
function HandlePostbackEvent(event: PostbackEvent, callbacks: LineWebhookCallbacks): void {
  const userId = event.source.userId;
  if (!userId) {
    console.warn('[LINE] Postback event without userId');
    return;
  }

  const data = event.postback.data;
  const replyToken = event.replyToken;

  console.log(`[LINE] Postback from ${userId}: ${data}`);
  callbacks.onPostback(userId, data, replyToken);
}
