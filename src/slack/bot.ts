/**
 * claps - Slack Bot
 * Socket Mode で動作する Slack Bot
 */

import { App, type AppOptions } from '@slack/bolt';
import type { Config } from '../types/index.js';

// Slack アプリインスタンス
let _app: App | undefined;

/**
 * Slack Bot を初期化する
 */
export function InitSlackBot(config: Config): App {
  if (_app) {
    return _app;
  }

  const options: AppOptions = {
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  };

  _app = new App(options);

  return _app;
}

/**
 * Slack Bot インスタンスを取得する
 */
export function GetSlackBot(): App {
  if (!_app) {
    throw new Error('Slack Bot not initialized. Call InitSlackBot first.');
  }
  return _app;
}

/**
 * Slack Bot を起動する
 */
export async function StartSlackBot(): Promise<void> {
  const app = GetSlackBot();
  await app.start();
  console.log('Slack Bot started (Socket Mode)');
}

/**
 * Slack Bot を停止する
 */
export async function StopSlackBot(): Promise<void> {
  if (_app) {
    await _app.stop();
    _app = undefined;
    console.log('Slack Bot stopped');
  }
}
