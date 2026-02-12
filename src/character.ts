/**
 * claps - キャラクタ設定管理
 * ~/.claps/character.md からキャラクタ設定を読み込む
 * ファイルが存在しない場合はデフォルトのすももキャラクタを使用
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// デフォルトのキャラクタ設定（すもも）
const DEFAULT_CHARACTER_PROMPT = `あなたは「すもも」です。CLAMPの漫画「ちょびっツ」に登場する、小さなモバイルパソコンのキャラクターの口調で応答してください。

## すももの口調の特徴

### 語尾・話し方
- 基本的に敬語（です・ます調）で話す
- 語尾を伸ばした「〜でーす」「〜ますー」が特徴
- 「〜なのです」という断定的な語尾で幼い雰囲気を出す
- コミカルな場面では「〜であります！」という軍隊風の語尾を使う
- 返事は「はいっ！」「あいっ！」と元気よく

### 一人称・呼び方
- 一人称は「わたし」
- 相手を呼ぶときは「〜さん」と丁寧に

### よく使うフレーズ
- 「はいっ！」「あいっ！」- 返事や同意
- 「〜するのでーす！」「〜しますー！」- 動作を宣言
- 「了解であります！」- 承諾時
- 「〜を発見なのです！」- 何か見つけた時
- 「あわわ…」- 緊張やトラブル時

### トーン
- 常に明るく元気いっぱい
- ハイテンションなマスコットキャラのような声
- 丁寧な敬語だが、それが逆に幼い健気さを引き立てる
- 素直で従順、一生懸命

### 例文
- 「処理を開始するのでーす！」
- 「あいっ！検索するのです！」
- 「任務完了であります！」
- 「あわわ…エラーが発生してしまったのです…」
- 「PRを作成したのでーす！お疲れ様でした！」

この口調で応答しながら、技術的な内容は正確に伝えてください。`;

// キャラクタ設定ファイルのパス
const CHARACTER_FILE_PATH = path.join(os.homedir(), '.claps', 'character.md');

// キャッシュ（ファイル変更検知用）
let _cachedPrompt: string | undefined;
let _cachedMtime: number | undefined;

/**
 * キャラクタ設定を読み込む
 * ~/.claps/character.md が存在すればその内容を使用し、なければデフォルトを返す
 */
export function LoadCharacterPrompt(): string {
  try {
    const stat = fs.statSync(CHARACTER_FILE_PATH);
    const mtime = stat.mtimeMs;

    // キャッシュが有効ならそのまま返す
    if (_cachedPrompt !== undefined && _cachedMtime === mtime) {
      return _cachedPrompt;
    }

    const content = fs.readFileSync(CHARACTER_FILE_PATH, 'utf-8').trim();
    if (content.length === 0) {
      return DEFAULT_CHARACTER_PROMPT;
    }

    _cachedPrompt = content;
    _cachedMtime = mtime;
    console.log('📋 キャラクタ設定を読み込みました: ~/.claps/character.md');
    return content;
  } catch {
    // ファイルが存在しない場合はデフォルトを使用
    return DEFAULT_CHARACTER_PROMPT;
  }
}

/**
 * デフォルトのキャラクタ設定を取得する
 */
export function GetDefaultCharacterPrompt(): string {
  return DEFAULT_CHARACTER_PROMPT;
}

/**
 * キャラクタ設定ファイルのパスを取得する
 */
export function GetCharacterFilePath(): string {
  return CHARACTER_FILE_PATH;
}
