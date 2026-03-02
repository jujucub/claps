# LINE Bot セットアップ手順

CLAPS の LINE Bot チャネルを有効化し、動作確認するまでの手順。

## 前提条件

- CLAPS が Slack 経由で正常に動作していること
- LINE アカウントを持っていること

---

## 1. LINE Developers Console でチャネルを作成

1. https://developers.line.biz/console/ にログイン
2. **プロバイダー** を選択（なければ新規作成）
3. **新規チャネル作成** → **Messaging API** を選択
4. 必要情報を入力して作成

### 取得する情報

作成したチャネルの設定画面から以下を取得する:

| 項目 | 場所 |
|------|------|
| **Channel Secret** | 「チャネル基本設定」タブ → チャネルシークレット |
| **Channel Access Token** | 「Messaging API設定」タブ → チャネルアクセストークン（長期）→「発行」ボタン |

### 自分の LINE userId を確認する

LINE userId（`U` + 32桁の16進数）は以下のいずれかで取得:

- **方法A**: Messaging API設定タブの「あなたのユーザーID」（自分のIDが表示される）
- **方法B**: CLAPS 起動後、Bot にメッセージを送るとコンソールログに `[LINE] Text message from U...` と表示される（この段階では権限エラーになるが userId は確認できる）

### Webhook 以外の設定

「Messaging API設定」タブで:

- **応答メッセージ**: 無効にする（CLAPSが応答するため）
- **あいさつメッセージ**: 任意（有効のままでもOK）

---

## 2. 環境変数を設定

`~/.claps/.env` に以下を追加:

```bash
# LINE Bot
LINE_CHANNEL_SECRET=取得したチャネルシークレット
LINE_CHANNEL_TOKEN=取得したチャネルアクセストークン
LINE_WEBHOOK_PORT=3002

# LINE 許可ユーザー（自分の LINE userId）
ALLOWED_LINE_USERS=U8189cf6745fc0d808977bdb0b9f22995
```

> `LINE_WEBHOOK_PORT` のデフォルトは `3002`。変更する場合のみ記載。

---

## 3. ユーザーマッピングを設定（任意）

チャネル横断セッション共有を使う場合、`~/.claps/admin-config.json` の `userMappings` に LINE userId を追加:

```json
{
  "userMappings": [
    {
      "github": "your-github-username",
      "slack": "U_YOUR_SLACK_ID",
      "line": "U_YOUR_LINE_USER_ID"
    }
  ]
}
```

> この設定は Phase 6 (US4) のチャネル横断セッション共有で使用する。LINE 単体の動作確認では不要。

---

## 4. Webhook URL を公開する

LINE Platform からの Webhook を受信するには、CLAPS の LINE Webhook エンドポイントをインターネットから到達可能にする必要がある。

### ローカル開発の場合: ngrok を使用

```bash
# ngrok でポート 3002 を公開
ngrok http 3002
```

表示された HTTPS URL（例: `https://xxxx-xxx-xxx.ngrok-free.app`）をメモ。

### サーバーの場合

リバースプロキシ（nginx 等）でポート 3002 を HTTPS で公開する。

### LINE Developers Console で Webhook URL を設定

1. Messaging API設定タブ → **Webhook URL** に以下を設定:

   ```
   https://xxxx-xxx-xxx.ngrok-free.app/webhook/line
   ```

   パスは必ず `/webhook/line` で終わること。

2. **Webhookの利用** を有効にする
3. 「検証」ボタンで接続テスト（CLAPS が起動している状態で）

---

## 5. CLAPS を起動

```bash
cd claps
npm run dev
```

起動ログに以下が表示されることを確認:

```
Channel adapter registered: line (line)
[LineAdapter] Initialized with MessagingApiClient
Adapter initialized: line
[LineAdapter] Webhook server started on port 3002
Adapter started: line
[LineAdapter] Started successfully
```

> LINE 関連の環境変数が未設定の場合、LINE アダプタは登録されず Slack のみで起動する（後方互換）。

---

## 6. 動作確認

### 6-1. Bot を友だち追加

LINE Developers Console の Messaging API設定タブに表示される **QRコード** をLINEアプリでスキャンして友だち追加。

### 6-2. メッセージ送信テスト

LINE アプリで Bot にテキストメッセージを送信:

```
こんにちは
```

**期待される動作**:

1. 即座に受付応答が返る（reply token による即時返信）
2. CLAPS コンソールに `Task added from line: ...` と表示
3. タスク処理が開始され、進捗通知が LINE に push される
4. 処理完了後、結果が LINE に push される

### 6-3. 承認フローテスト

承認が必要な操作を含むメッセージを送信:

```
README.md を更新してください
```

**期待される動作**:

1. タスク処理中に承認が必要になると、Quick Reply 付きメッセージが届く
2. 「承認」「拒否」ボタンをタップして応答
3. 承認後、処理が継続される

### 6-4. 権限エラーテスト

`ALLOWED_LINE_USERS` に含まれていないユーザーからメッセージを送ると:

```
このボットを使用する権限がありません。
```

と返されることを確認。

---

## トラブルシューティング

| 症状 | 確認事項 |
|------|----------|
| Bot からの応答がない | CLAPS コンソールログを確認。`[LINE]` プレフィックスのログが出ているか |
| `Webhook URL is invalid` | URL が HTTPS か、パスが `/webhook/line` か確認 |
| `Signature validation failed` | `LINE_CHANNEL_SECRET` が正しいか確認 |
| `Unauthorized user` | `ALLOWED_LINE_USERS` に自分の userId が含まれているか確認 |
| ngrok で接続できない | `ngrok http 3002` が起動しているか、CLAPS が先に起動しているか確認 |
| 受付応答は来るが結果が来ない | タスク処理自体のエラー。CLAPS コンソールログを確認 |
| 起動時に LINE アダプタが登録されない | `LINE_CHANNEL_SECRET` と `LINE_CHANNEL_TOKEN` の **両方** が `~/.claps/.env` に設定されているか確認 |
| ポートが使用中 | `LINE_WEBHOOK_PORT` を別のポート番号に変更 |

### ログの確認ポイント

```bash
# LINE 関連のログだけフィルタ
npm run dev 2>&1 | grep -E '\[LINE|LineAdapter|line\]'
```

---

## 設定まとめ

| 環境変数 | 説明 | 必須 | デフォルト |
|----------|------|------|-----------|
| `LINE_CHANNEL_SECRET` | Webhook 署名検証用シークレット | Yes | - |
| `LINE_CHANNEL_TOKEN` | Messaging API アクセストークン | Yes | - |
| `LINE_WEBHOOK_PORT` | Webhook リスナーポート | No | `3002` |
| `ALLOWED_LINE_USERS` | 許可ユーザー（カンマ区切り） | Yes | - |
