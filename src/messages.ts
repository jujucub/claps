/**
 * claps - メッセージテンプレート管理
 * ~/.claps/messages.json からメッセージ設定を読み込む
 * ユーザーは emoji, name, 個別メッセージを自由にカスタマイズ可能
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// メッセージ設定
interface MessageConfig {
  readonly emoji: string;
  readonly slackEmoji: string;
  readonly name: string;
  readonly botName: string;
  readonly messages: Readonly<Record<string, string>>;
}

// デフォルト設定
const DEFAULT_EMOJI = '☕';
const DEFAULT_SLACK_EMOJI = ':coffee:';
const DEFAULT_NAME = 'クラリス';
const DEFAULT_BOT_NAME = 'claris';

// デフォルトメッセージテンプレート
// {emoji}, {name} は自動的に設定値で置換される
// その他の {変数名} は Msg() 呼び出し時に渡す
const DEFAULT_MESSAGES: Readonly<Record<string, string>> = {
  // --- コンソールログ ---
  'console.startup': '{emoji} {name}、起動いたしますわ',
  'console.startupComplete': '{emoji} {name}の起動が完了しましたわ。…べ、別にあなたのために急いだわけじゃないですからね',
  'console.shutdown': '{emoji} {name}、停止いたしますわ。…少し寂しいだなんて思ってないですからね',
  'console.shutdownComplete': '{emoji} {name}、おやすみなさいませ。…また明日もお仕えいたしますわ',

  // --- 起動通知 ---
  'morning.greeting': '{emoji} おはようございますわ。{name}、本日も勤務開始ですわ。@{botName} でお呼びくださいませ。…待ってるとかじゃないですからね',

  // --- タスク進捗 ---
  'task.resumeIssue': 'Issue #{issueNumber} の作業を継続いたしますわ。ちゃんと覚えてましたのよ',
  'task.commitPush': '変更をコミット＆プッシュしておきましたわ。…感謝しなさいよね',
  'task.resumeBranch': '既存のブランチ `{branch}` で作業を継続いたしますわ',
  'task.startBranch': 'ブランチ `{branch}` で作業を開始いたしますわ',
  'task.resumeSession': '前回のセッションを継続いたしますわ。途中で投げ出したりしませんの',
  'task.startClaude': 'Claude を起動中ですわ。少々お待ちなさい',
  'task.completeNoOutput': '処理は完了いたしましたわ。特に報告することはありませんけれど',
  'task.completeComment': '{emoji} {name}が処理を完了いたしましたわ。…お疲れ様、ですわ',
  'task.completeCommentPr': '\n\nPRも作成しておきましたわよ: {prUrl}',
  'task.started': '{emoji} 仕方ないですわね…処理を開始してあげますわ: {description}',
  'task.completed': '{emoji} 完了ですわ。{message}',
  'task.completedPr': '\nPRも作成しておきましたわ: {prUrl}',
  'task.error': '{emoji} ちっ…エラーが出てしまいましたわ。すぐに対処いたします: {error}',
  'task.progress': '{emoji} {message}',

  // --- メンション応答 ---
  'mention.emptyPrompt': 'わたくしをお呼びですの？ご用件をおっしゃいなさいな。…暇だったから応じたわけじゃないですからね',
  'mention.start': '{emoji} 仕方ないですわね、処理を開始いたしますわ',

  // --- スラッシュコマンド ---
  'command.noPermission': 'あなたにはこのコマンドの権限がありませんわ。身の程を知りなさい',
  'command.helpTitle': '{emoji} *{name}のコマンド一覧ですわ*',
  'command.start': '{emoji} `{repo}` の処理を開始いたしますわ。お任せくださいませ',
  'command.execution': '{emoji} *{name}コマンド実行*\nリポジトリ: `{repo}`\nリクエスト: {prompt}\n実行者: <@{userId}>',
  'command.started': '{emoji} `{repo}` の処理を開始いたしましたわ。進捗はスレッドでご確認くださいませ',
  'command.invalidRepo': '{emoji} リポジトリの形式が正しくありませんわ。もう少し丁寧に入力なさい\n\n使い方: `/{botName} owner/repo メッセージ`\nヘルプ: `/{botName} help`',
  'command.noMessage': '{emoji} メッセージが入力されていませんわよ。何をしてほしいか言いなさいな\n\n例: `/{botName} owner/repo バグを修正して`',
  'command.adminOnly': '{emoji} このコマンドは管理者専用ですわ',

  // --- 内省 ---
  'reflection.title': '{slackEmoji} おはようございますわ。日次内省レポート ({date}) をお持ちいたしました',
  'reflection.header': '{slackEmoji} 日次内省レポートですわ',
  'reflection.result': '*{date}* の内省結果ですわ。しっかり目を通しなさいよね\n\n{summaries}',
  'reflection.userSummary': '<@{userId}> さんへの提案が {count} 件ありますわ',
  'reflection.status': '{emoji} *内省機能ステータス*\n\n• 状態: {status}\n• 実行時刻: {schedule} ({timezone})\n• 履歴日数: {historyDays}日\n• 最終実行: {lastRun}',
  'reflection.manualRun': '{emoji} 内省を手動実行いたしますわ。少々お待ちなさい',
  'reflection.noResult': '{emoji} 内省の結果がありませんでしたわ。アクティブなユーザーがいないようですわね',
  'reflection.enabled': '{emoji} 内省機能を有効化いたしましたわ',
  'reflection.disabled': '{emoji} 内省機能を無効化いたしましたわ',
  'reflection.invalidTime': '{emoji} 時刻の形式が正しくありませんわ。ちゃんと確認なさい\n使い方: `/{botName} reflection schedule HH:MM`',
  'reflection.scheduleChanged': '{emoji} 内省の実行時刻を {time} に変更いたしましたわ',
  'reflection.unknownCommand': '{emoji} 不明なサブコマンドですわね\n使い方: `/{botName} reflection [run|enable|disable|schedule HH:MM]`',

  // --- リポジトリ管理 ---
  'repos.empty': '{emoji} 監視対象のリポジトリはまだ登録されていませんわ',
  'repos.list': '{emoji} *監視対象リポジトリ一覧* ({count}件)\n\n{repoList}',
  'repos.invalidFormat': '{emoji} リポジトリの形式が正しくありませんわ\n使い方: `/{botName} {command} owner/repo`',
  'repos.alreadyAdded': '{emoji} `{repo}` は既に監視対象に含まれていますわよ',
  'repos.added': '{emoji} `{repo}` を監視対象に追加いたしましたわ',
  'repos.notFound': '{emoji} `{repo}` は監視対象に含まれていませんわ',
  'repos.removed': '{emoji} `{repo}` を監視対象から削除いたしましたわ',

  // --- ホワイトリスト ---
  'whitelist.title': '{emoji} *ホワイトリスト*\n\n',
  'whitelist.addMention': '{emoji} ユーザーを@メンションで指定なさい\n使い方: `/{botName} whitelist {command}`',
  'whitelist.invalidGithub': '{emoji} GitHubユーザー名が正しくありませんわ\n英数字とハイフンのみ使用可能（1〜39文字）',
  'whitelist.invalidGithubUsage': '{emoji} GitHubユーザー名が正しくありませんわ\n英数字とハイフンのみ使用可能（1〜39文字）\n使い方: `/{botName} whitelist {command} username`',
  'whitelist.alreadyExists': '{emoji} `{username}` は既にホワイトリストに含まれていますわよ',
  'whitelist.githubAdded': '{emoji} GitHubユーザー `{username}` をホワイトリストに追加いたしましたわ',
  'whitelist.removeMention': '{emoji} ユーザーを@メンションで指定なさい\n使い方: `/{botName} whitelist remove @user`',
  'whitelist.notInList': '{emoji} <@{userId}> はホワイトリストに含まれていませんわ',
  'whitelist.cannotRemoveSelf': '{emoji} 自分自身をホワイトリストから削除することはできませんわよ',
  'whitelist.removed': '{emoji} <@{userId}> をホワイトリストから削除いたしましたわ',
  'whitelist.githubNotInList': '{emoji} `{username}` はホワイトリストに含まれていませんわ',
  'whitelist.githubRemoved': '{emoji} GitHubユーザー `{username}` をホワイトリストから削除いたしましたわ',
  'whitelist.completed': '{emoji} 完了ですわ\n{results}',
  'whitelist.unknownCommand': '{emoji} 不明なサブコマンドですわね\n使い方: `/{botName} whitelist [add|add-github|remove|remove-github]`',

  // --- 承認 ---
  'approval.onlyRequester': '{emoji} この承認はリクエストした方だけが行えますわ',
  'approval.mentionRequest': '<@{userId}> 承認をお願いいたしますわ',
  'approval.requestText': '{emoji} 実行許可のリクエストですわ: {tool}',
  'approval.requestHeader': '{emoji} {name}からの実行許可リクエストですわ',

  // --- 質問 ---
  'question.text': '{emoji} 少しお聞きしたいことがありますわ: {question}',
  'question.header': '{emoji} {name}からの質問ですわ',

  // --- GitHub Issue ---
  'issue.startText': '{emoji} GitHub Issue の処理を開始いたしますわ',
  'issue.startHeader': '{emoji} GitHub Issue の処理開始ですわ',
  'issue.threadContext': '進捗はこのスレッドに投稿いたしますわ。…べ、別に気にかけてほしいわけじゃないですからね',

  // --- 提案 ---
  'suggestion.modalText': 'この提案をタスクとして実行いたしますわ。追加の指示があればどうぞ',
  'suggestion.execute': '{emoji} 提案「{title}」をタスクとして実行いたしますわ',
};

// 設定ファイルのパス
const MESSAGES_FILE_PATH = path.join(os.homedir(), '.claps', 'messages.json');

// キャッシュ
let _cachedConfig: MessageConfig | undefined;
let _cachedMtime: number | undefined;

/**
 * メッセージ設定を読み込む
 */
function LoadMessageConfig(): MessageConfig {
  const defaultConfig: MessageConfig = {
    emoji: DEFAULT_EMOJI,
    slackEmoji: DEFAULT_SLACK_EMOJI,
    name: DEFAULT_NAME,
    botName: DEFAULT_BOT_NAME,
    messages: {},
  };

  try {
    const stat = fs.statSync(MESSAGES_FILE_PATH);
    const mtime = stat.mtimeMs;

    // キャッシュが有効ならそのまま返す
    if (_cachedConfig && _cachedMtime === mtime) {
      return _cachedConfig;
    }

    const content = fs.readFileSync(MESSAGES_FILE_PATH, 'utf-8').trim();
    if (content.length === 0) {
      return defaultConfig;
    }

    const parsed = JSON.parse(content) as Partial<MessageConfig>;
    const config: MessageConfig = {
      emoji: parsed.emoji ?? DEFAULT_EMOJI,
      slackEmoji: parsed.slackEmoji ?? DEFAULT_SLACK_EMOJI,
      name: parsed.name ?? DEFAULT_NAME,
      botName: parsed.botName ?? DEFAULT_BOT_NAME,
      messages: parsed.messages ?? {},
    };

    _cachedConfig = config;
    _cachedMtime = mtime;
    console.log('📋 メッセージ設定を読み込みました: ~/.claps/messages.json');
    return config;
  } catch {
    return defaultConfig;
  }
}

/**
 * メッセージを取得する
 * テンプレート内の {変数名} を置換して返す
 *
 * @param key メッセージキー (例: 'task.started')
 * @param vars 置換変数 (例: { repo: 'owner/repo' })
 * @returns 置換済みメッセージ文字列
 */
export function Msg(key: string, vars?: Readonly<Record<string, string>>): string {
  const config = LoadMessageConfig();

  // ユーザーオーバーライド → デフォルト → キーそのまま
  const template = config.messages[key] ?? DEFAULT_MESSAGES[key] ?? key;

  // 組み込み変数
  const builtinVars: Record<string, string> = {
    emoji: config.emoji,
    slackEmoji: config.slackEmoji,
    name: config.name,
    botName: config.botName,
  };

  // テンプレート変数を置換
  return template.replace(/\{(\w+)\}/g, (match, varName: string) => {
    return vars?.[varName] ?? builtinVars[varName] ?? match;
  });
}

/**
 * プレーンテキスト用メッセージを取得する
 * Slack絵文字（:coffee:等）をUnicode絵文字に置換した版
 * LINE / HTTP など Slack以外のチャネルで使用する
 */
export function PlainMsg(key: string, vars?: Readonly<Record<string, string>>): string {
  const config = LoadMessageConfig();

  const template = config.messages[key] ?? DEFAULT_MESSAGES[key] ?? key;

  // slackEmoji の代わりに emoji を使う
  const builtinVars: Record<string, string> = {
    emoji: config.emoji,
    slackEmoji: config.emoji, // Slack絵文字をUnicodeに置換
    name: config.name,
    botName: config.botName,
  };

  return template.replace(/\{(\w+)\}/g, (match, varName: string) => {
    return vars?.[varName] ?? builtinVars[varName] ?? match;
  });
}

/**
 * ボット名を取得する（スラッシュコマンド、メンション、タグ等に使用）
 */
export function GetBotName(): string {
  const config = LoadMessageConfig();
  return config.botName;
}

/**
 * メッセージ設定ファイルのパスを取得する
 */
export function GetMessagesFilePath(): string {
  return MESSAGES_FILE_PATH;
}

/**
 * 利用可能なメッセージキーの一覧を取得する
 */
export function GetMessageKeys(): readonly string[] {
  return Object.keys(DEFAULT_MESSAGES);
}
