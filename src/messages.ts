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
  readonly messages: Readonly<Record<string, string>>;
}

// デフォルト設定
const DEFAULT_EMOJI = '🍑';
const DEFAULT_SLACK_EMOJI = ':peach:';
const DEFAULT_NAME = 'すもも';

// デフォルトメッセージテンプレート
// {emoji}, {name} は自動的に設定値で置換される
// その他の {変数名} は Msg() 呼び出し時に渡す
const DEFAULT_MESSAGES: Readonly<Record<string, string>> = {
  // --- コンソールログ ---
  'console.startup': '{emoji} {name}を起動するのでーす！',
  'console.startupComplete': '{emoji} {name}の起動完了であります！',
  'console.shutdown': '{emoji} {name}を停止するのでーす...',
  'console.shutdownComplete': '{emoji} {name}、おやすみなさいなのです！',

  // --- 起動通知 ---
  'morning.greeting': '{emoji} 朝でーす！{name}が起動したのでーす！@claps でメンションしてくださいなのです！',

  // --- タスク進捗 ---
  'task.resumeIssue': 'Issue #{issueNumber} の作業を継続するのでーす！',
  'task.commitPush': '変更をコミット＆プッシュしたのでーす！',
  'task.resumeBranch': '既存のブランチ `{branch}` で作業を継続するのでーす！',
  'task.startBranch': 'ブランチ `{branch}` で作業を開始するのです！',
  'task.resumeSession': '前回のセッションを継続するのでーす！',
  'task.startClaude': 'Claude を起動中なのでーす！',
  'task.completeNoOutput': '処理が完了したのでーす！（出力なしなのです）',
  'task.completeComment': '{emoji} {name}が処理を完了したのでーす！お疲れ様でした！',
  'task.completeCommentPr': '\n\nPRを作成したのです: {prUrl}',
  'task.started': '{emoji} 了解であります！処理を開始するのでーす: {description}',
  'task.completed': '{emoji} 任務完了であります！{message}',
  'task.completedPr': '\nPRを作成したのでーす: {prUrl}',
  'task.error': '{emoji} あわわ…エラーが発生してしまったのです…: {error}',
  'task.progress': '{emoji} {message}',

  // --- メンション応答 ---
  'mention.emptyPrompt': 'はいっ！何をお手伝いしましょうか〜？ご用件をお聞かせくださいなのです！',
  'mention.start': '{emoji} あいっ！処理を開始するのでーす！',

  // --- スラッシュコマンド ---
  'command.noPermission': 'このコマンドを使用する権限がないのです。',
  'command.helpTitle': '{emoji} *{name}コマンドの使い方*',
  'command.start': '{emoji} あいっ！`{repo}` で処理を開始するのでーす！',
  'command.execution': '{emoji} *{name}コマンド実行*\nリポジトリ: `{repo}`\nリクエスト: {prompt}\n実行者: <@{userId}>',
  'command.started': '{emoji} `{repo}` で処理を開始したのでーす！スレッドで進捗を確認できます。',
  'command.invalidRepo': '{emoji} リポジトリの形式が正しくないか、不明なコマンドなのです。\n\n使い方: `/claps owner/repo メッセージ`\nヘルプ: `/claps help`',
  'command.noMessage': '{emoji} メッセージを入力してくださいなのです！\n\n例: `/claps owner/repo バグを修正して`',
  'command.adminOnly': '{emoji} このコマンドは管理者のみ使用できるのです。',

  // --- 内省 ---
  'reflection.title': '{slackEmoji} おはようなのでーす！日次内省レポート ({date})',
  'reflection.header': '{slackEmoji} 日次内省レポートであります！',
  'reflection.result': '*{date}* の内省結果なのでーす！\n\n{summaries}',
  'reflection.userSummary': '<@{userId}> さんへの提案が {count} 件ありますー！',
  'reflection.status': '{emoji} *内省機能ステータス*\n\n• 状態: {status}\n• 実行時刻: {schedule} ({timezone})\n• 履歴日数: {historyDays}日\n• 最終実行: {lastRun}',
  'reflection.manualRun': '{emoji} 内省を手動実行するのでーす！しばらくお待ちください。',
  'reflection.noResult': '{emoji} 内省の実行結果がなかったのです。アクティブユーザーがいないか、エラーが発生した可能性があります。',
  'reflection.enabled': '{emoji} 内省機能を有効化したのでーす！',
  'reflection.disabled': '{emoji} 内省機能を無効化したのでーす！',
  'reflection.invalidTime': '{emoji} 時刻の形式が正しくないのです。\n使い方: `/claps reflection schedule HH:MM`',
  'reflection.scheduleChanged': '{emoji} 内省の実行時刻を {time} に変更したのでーす！',
  'reflection.unknownCommand': '{emoji} 不明なサブコマンドなのです。\n使い方: `/claps reflection [run|enable|disable|schedule HH:MM]`',

  // --- リポジトリ管理 ---
  'repos.empty': '{emoji} 監視対象のリポジトリはまだ登録されていないのです。',
  'repos.list': '{emoji} *監視対象リポジトリ一覧* ({count}件)\n\n{repoList}',
  'repos.invalidFormat': '{emoji} リポジトリの形式が正しくないのです。\n使い方: `/claps {command} owner/repo`',
  'repos.alreadyAdded': '{emoji} `{repo}` は既に監視対象に含まれているのです。',
  'repos.added': '{emoji} `{repo}` を監視対象に追加したのでーす！',
  'repos.notFound': '{emoji} `{repo}` は監視対象に含まれていないのです。',
  'repos.removed': '{emoji} `{repo}` を監視対象から削除したのでーす！',

  // --- ホワイトリスト ---
  'whitelist.title': '{emoji} *ホワイトリスト*\n\n',
  'whitelist.addMention': '{emoji} ユーザーを@メンションで指定してくださいなのです。\n使い方: `/claps whitelist {command}`',
  'whitelist.invalidGithub': '{emoji} GitHubユーザー名が正しくないのです。\n英数字とハイフンのみ使用可能（1〜39文字）',
  'whitelist.invalidGithubUsage': '{emoji} GitHubユーザー名が正しくないのです。\n英数字とハイフンのみ使用可能（1〜39文字）\n使い方: `/claps whitelist {command} username`',
  'whitelist.alreadyExists': '{emoji} `{username}` は既にホワイトリストに含まれているのです。',
  'whitelist.githubAdded': '{emoji} GitHubユーザー `{username}` をホワイトリストに追加したのでーす！',
  'whitelist.removeMention': '{emoji} ユーザーを@メンションで指定してくださいなのです。\n使い方: `/claps whitelist remove @user`',
  'whitelist.notInList': '{emoji} <@{userId}> はホワイトリストに含まれていないのです。',
  'whitelist.cannotRemoveSelf': '{emoji} 自分自身をホワイトリストから削除することはできないのです。',
  'whitelist.removed': '{emoji} <@{userId}> をホワイトリストから削除したのでーす！',
  'whitelist.githubNotInList': '{emoji} `{username}` はホワイトリストに含まれていないのです。',
  'whitelist.githubRemoved': '{emoji} GitHubユーザー `{username}` をホワイトリストから削除したのでーす！',
  'whitelist.completed': '{emoji} 完了したのでーす！\n{results}',
  'whitelist.unknownCommand': '{emoji} 不明なサブコマンドなのです。\n使い方: `/claps whitelist [add|add-github|remove|remove-github]`',

  // --- 承認 ---
  'approval.onlyRequester': '{emoji} この承認はリクエストした人だけができるのです！',
  'approval.mentionRequest': '<@{userId}> 承認をお願いするのでーす！',
  'approval.requestText': '{emoji} 実行許可リクエストなのです: {tool}',
  'approval.requestHeader': '{emoji} {name}からの実行許可リクエストであります！',

  // --- 質問 ---
  'question.text': '{emoji} お聞きしたいことがあるのです: {question}',
  'question.header': '{emoji} {name}からの質問なのでーす！',

  // --- GitHub Issue ---
  'issue.startText': '{emoji} あいっ！GitHub Issue の処理を開始するのでーす！',
  'issue.startHeader': '{emoji} GitHub Issue 処理開始であります！',
  'issue.threadContext': '処理の進捗はこのスレッドに投稿するのです！お楽しみに〜♪',

  // --- 提案 ---
  'suggestion.modalText': 'この提案をタスクとして実行するのでーす！追加の指示があれば入力してください。',
  'suggestion.execute': '{emoji} 提案「{title}」をタスクとして実行するのでーす！',
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
  };

  // テンプレート変数を置換
  return template.replace(/\{(\w+)\}/g, (match, varName: string) => {
    return vars?.[varName] ?? builtinVars[varName] ?? match;
  });
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
