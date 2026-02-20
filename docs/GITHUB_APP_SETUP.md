# GitHub App セットアップガイド

CLAPS では GitHub Personal Access Token（PAT）に加えて、GitHub App 認証をサポートしています。
GitHub App を使用すると、コミット著者が `キャラ名[bot]` として表示され、1時間有効の短命トークンによりセキュリティも向上します。

## PAT との比較

| | PAT | GitHub App |
|---|-----|-----------|
| コミット著者 | 個人アカウント名 | `キャラ名[bot]` |
| トークン有効期限 | 長期（手動ローテーション） | 1時間（自動リフレッシュ） |
| セットアップ | トークン1つ | App作成・インストール・秘密鍵 |
| 推奨用途 | ローカル開発・テスト | 本番運用 |

## 1. GitHub App の作成

1. [GitHub App 作成ページ](https://github.com/settings/apps/new) を開く（Organization の場合は `https://github.com/organizations/{org}/settings/apps/new`）
2. 以下を入力:

| 項目 | 値 |
|------|-----|
| **GitHub App name** | キャラ名（例: `claris-bot`） |
| **Description** | `claps自動実装エージェント - Issue対応・PR作成` |
| **Homepage URL** | リポジトリURL（例: `https://github.com/jujucub/claps`） |

3. **Webhook**: 「Active」のチェックを**外す**（claps はポーリング方式のため不要）

## 2. Permissions の設定

**Repository permissions** で以下を設定:

| Permission | Access | 用途 |
|-----------|--------|------|
| **Contents** | Read and write | clone, fetch, push |
| **Issues** | Read and write | Issue読み取り、コメント投稿 |
| **Pull requests** | Read and write | PR作成 |
| **Metadata** | Read-only | 自動付与 |

それ以外の権限は不要です。設定したら **Create GitHub App** をクリック。

## 3. Private Key の生成

App 作成後の設定ページ下部「Private keys」セクションで:

1. **Generate a private key** をクリック
2. `.pem` ファイルがダウンロードされる
3. 安全な場所に配置:

```bash
mkdir -p ~/.claps
mv ~/Downloads/*.private-key.pem ~/.claps/github-app.pem
chmod 600 ~/.claps/github-app.pem
```

> **重要**: 秘密鍵のパーミッションは `600` にしてください。claps 起動時にパーミッションを検証し、不適切な場合は警告が表示されます。

## 4. App のインストール

1. App 設定ページの左メニューから **Install App** を選択
2. 対象のアカウントまたは Organization を選択
3. **Only select repositories** で対象リポジトリを選んでインストール

## 5. 必要な情報の確認

環境変数に設定する3つの値を確認します:

| 値 | 確認場所 |
|----|---------|
| **App ID** | App 設定ページ「General」→「About」セクションの「App ID」 |
| **Private Key パス** | Step 3 で配置したパス（例: `~/.claps/github-app.pem`） |
| **Installation ID** | インストール後の URL `https://github.com/settings/installations/{ID}` の末尾の数字 |

## 6. 環境変数の設定

`~/.claps/.env`（または `.env`）に以下を追加:

```bash
GITHUB_AUTH_MODE=github-app
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=~/.claps/github-app.pem
GITHUB_APP_INSTALLATION_ID=78901234
```

> `GITHUB_TOKEN` は設定不要です（`GITHUB_AUTH_MODE=github-app` の場合は無視されます）。

## 7. 動作確認

```bash
npm run build && npm start
```

起動ログに以下が表示されれば成功です:

```
GitHub auth mode: github-app
GitHub App token refreshed (expires: ...)
GitHub App bot username: キャラ名[bot]
```

## トラブルシューティング

### `GitHub App秘密鍵が見つかりません`

`GITHUB_APP_PRIVATE_KEY_PATH` のパスを確認してください。`~` はホームディレクトリに展開されます。

### `秘密鍵のパーミッションが ... です`

```bash
chmod 600 ~/.claps/github-app.pem
```

### トークンが1時間で切れる

claps は git 操作（fetch/push）やAPI呼び出しの直前に自動でトークンをリフレッシュするため、通常は問題ありません。有効期限の10分前に自動更新されます。

### Installation ID がわからない

GitHub CLI で確認できます:

```bash
gh api /app/installations --jq '.[].id'
```

> `GITHUB_TOKEN` に App の JWT を設定する必要があるため、通常は URL から確認する方が簡単です。
