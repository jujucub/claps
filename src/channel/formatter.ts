/**
 * claps - メッセージフォーマッタ
 * 長文メッセージの分割送信等の共通ロジック
 */

/**
 * テキストを自然な境界で分割する
 * 各チャンクに [N/M] プレフィックスを付与
 *
 * @param text 分割するテキスト
 * @param maxLength 1チャンクの最大文字数
 * @returns 分割されたテキスト配列
 */
export function SplitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // maxLength以内で自然な境界を探す
    let splitAt = maxLength;

    // 改行で分割を試みる
    const newlineIdx = remaining.lastIndexOf('\n', maxLength);
    if (newlineIdx > maxLength * 0.3) {
      splitAt = newlineIdx + 1;
    } else {
      // スペースで分割を試みる
      const spaceIdx = remaining.lastIndexOf(' ', maxLength);
      if (spaceIdx > maxLength * 0.3) {
        splitAt = spaceIdx + 1;
      }
      // それでも見つからなければハードカット
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  // 2チャンク以上の場合、[N/M] プレフィックスを付与
  if (chunks.length > 1) {
    return chunks.map((chunk, i) => `[${i + 1}/${chunks.length}] ${chunk}`);
  }

  return chunks;
}
