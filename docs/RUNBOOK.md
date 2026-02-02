# Runbook (運用手順書)

> sumomo の運用・保守に関する手順書

## 目次

- [デプロイメント手順](#デプロイメント手順)
- [起動・停止手順](#起動停止手順)
- [監視とアラート](#監視とアラート)
- [よくある問題と対処法](#よくある問題と対処法)
- [ロールバック手順](#ロールバック手順)
- [メンテナンス作業](#メンテナンス作業)

---

## デプロイメント手順

### 初回デプロイ

```bash
# 1. リポジトリをクローン
git clone https://github.com/jujucub/sumomo.git
cd sumomo

# 2. 依存関係をインストール
npm install

# 3. 環境変数を設定
mkdir -p ~/.sumomo
cp .env.example ~/.sumomo/.env
# ~/.sumomo/.env を編集して認証情報を設定

# 4. ビルド
npm run build

# 5. 起動（バックグラウンド）
nohup npm start > sumomo.log 2>&1 &
```

### 更新デプロイ

```bash
# 1. 最新コードを取得
git pull origin main

# 2. 依存関係を更新
npm install

# 3. ビルド
npm run build

# 4. プロセスを再起動
# (既存プロセスを停止してから起動)
pkill -f "node dist/index.js"
nohup npm start > sumomo.log 2>&1 &
```

### systemd サービスとして運用（推奨）

```ini
# /etc/systemd/system/sumomo.service
[Unit]
Description=sumomo - Claude Automation Bot
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/sumomo
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
# サービスを有効化・起動
sudo systemctl daemon-reload
sudo systemctl enable sumomo
sudo systemctl start sumomo

# ステータス確認
sudo systemctl status sumomo

# ログ確認
sudo journalctl -u sumomo -f
```

---

## 起動・停止手順

### 起動

```bash
# 直接起動
npm start

# バックグラウンド起動
nohup npm start > sumomo.log 2>&1 &

# systemd使用時
sudo systemctl start sumomo
```

起動時のログ:
```
🍑 すももを起動するのでーす！
📋 Using admin-config.json for whitelist and repos
🍑 すももの起動完了であります！
```

### 停止

```bash
# プロセスを停止
pkill -f "node dist/index.js"

# systemd使用時
sudo systemctl stop sumomo
```

停止時のログ:
```
🍑 すももを停止するのでーす...
🍑 すもも、おやすみなさいなのです！
```

### 再起動

```bash
# systemd使用時
sudo systemctl restart sumomo
```

---

## 監視とアラート

### ヘルスチェック

#### 管理画面でのステータス確認

```
http://localhost:3002/
```

管理画面で以下を確認可能:
- 許可ユーザー一覧
- 監視対象リポジトリ
- ユーザーマッピング

#### プロセス監視

```bash
# プロセス確認
ps aux | grep "node dist/index.js"

# ポート確認
lsof -i :3001  # 承認サーバー
lsof -i :3002  # 管理画面
```

### ログ監視

```bash
# リアルタイムログ監視
tail -f sumomo.log

# エラーのみ表示
grep -i error sumomo.log

# systemd使用時
sudo journalctl -u sumomo -f
```

### 重要なログパターン

| パターン | 意味 | 対応 |
|----------|------|------|
| `Task added from Slack` | Slackタスク受信 | 正常 |
| `Task added from GitHub` | Issueタスク受信 | 正常 |
| `Processing task` | タスク処理開始 | 正常 |
| `Session saved` | セッション保存 | 正常 |
| `⚠️ ALLOWED_*_USERS is empty` | ホワイトリスト未設定 | 設定確認 |
| `Failed to` | 処理失敗 | 要調査 |
| `Uncaught exception` | 未処理例外 | 即時対応 |

---

## よくある問題と対処法

### 1. Slack接続エラー

**症状:**
```
Error: An API error occurred: invalid_auth
```

**原因:** Slackトークンが無効

**対処:**
1. `.env` の `SLACK_BOT_TOKEN` を確認
2. Slack App設定でトークンを再生成
3. Socket Mode が有効か確認

---

### 2. GitHub API エラー

**症状:**
```
Error: Bad credentials
```

**原因:** GitHubトークンが無効または権限不足

**対処:**
1. `.env` の `GITHUB_TOKEN` を確認
2. トークンの権限を確認（repo, workflow）
3. トークンを再生成

---

### 3. tmuxセッションが残る

**症状:** 古いtmuxセッションが残っている

**対処:**
```bash
# sumomoのセッションを一覧
tmux ls | grep sumomo

# 特定セッションを終了
tmux kill-session -t sumomo-owner-repo-123

# 全sumomoセッションを終了
tmux ls | grep sumomo | cut -d: -f1 | xargs -I{} tmux kill-session -t {}
```

---

### 4. worktreeが残る

**症状:** 古いworktreeが残っている

**対処:**
```bash
# worktree一覧を確認
ls ~/.sumomo/repos/owner/repo/.worktrees/

# 特定worktreeを削除
git -C ~/.sumomo/repos/owner/repo worktree remove .worktrees/issue-123 --force
```

---

### 5. ポートが使用中

**症状:**
```
Error: listen EADDRINUSE: address already in use :::3001
```

**対処:**
```bash
# 使用中のプロセスを確認
lsof -i :3001

# プロセスを終了
kill -9 <PID>

# または別のポートを使用
export APPROVAL_SERVER_PORT=3003
```

---

### 6. Claude CLI エラー

**症状:** Claude CLIの実行に失敗

**対処:**
1. Claude CLIがインストールされているか確認
   ```bash
   which claude
   claude --version
   ```
2. 認証状態を確認
   ```bash
   claude auth status
   ```
3. 再認証
   ```bash
   claude auth login
   ```

---

## ロールバック手順

### 手順

```bash
# 1. 現在のプロセスを停止
sudo systemctl stop sumomo  # または pkill

# 2. 前のバージョンにチェックアウト
git log --oneline -10  # コミット履歴確認
git checkout <previous-commit-hash>

# 3. 再ビルド
npm install
npm run build

# 4. 起動
sudo systemctl start sumomo
```

### 緊急ロールバック

```bash
# 1. 即時停止
sudo systemctl stop sumomo

# 2. 最後の安定版にリセット
git reset --hard <stable-commit>

# 3. 再ビルド・起動
npm install && npm run build && sudo systemctl start sumomo
```

---

## メンテナンス作業

### 定期メンテナンス

#### ログローテーション

```bash
# logrotate設定 (/etc/logrotate.d/sumomo)
/path/to/sumomo/sumomo.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
}
```

#### ディスク使用量確認

```bash
# worktreeサイズ確認
du -sh ~/.sumomo/repos/

# 古いworktreeを削除
find ~/.sumomo/repos -name ".worktrees" -type d -exec du -sh {} \;
```

#### tmuxセッションクリーンアップ

```bash
# 古いセッションを削除（週次推奨）
tmux ls | grep sumomo | cut -d: -f1 | xargs -I{} tmux kill-session -t {}
```

### 設定変更

#### ホワイトリスト更新

管理画面（`http://localhost:3002/`）で更新可能:
- 許可GitHubユーザー
- 許可Slackユーザー
- 監視対象リポジトリ

または `~/.sumomo/admin-config.json` を直接編集:

```json
{
  "allowedGithubUsers": ["user1", "user2"],
  "allowedSlackUsers": ["U01234567", "U09876543"],
  "githubRepos": ["owner/repo1", "owner/repo2"],
  "userMappings": [
    {"github": "octocat", "slack": "U01234567"}
  ],
  "adminSlackUser": "U01234567"
}
```

#### ポーリング間隔変更

```bash
# .env で設定（ミリ秒）
GITHUB_POLL_INTERVAL=600000  # 10分
```

---

## 連絡先・エスカレーション

| レベル | 条件 | 連絡先 |
|--------|------|--------|
| L1 | 軽微な問題 | Slackチャンネル |
| L2 | サービス停止 | 管理者 |
| L3 | データ損失 | 緊急連絡先 |

---

## 参考情報

- [設計書](./DESIGN.md)
- [開発者ガイド](./CONTRIB.md)
- [GitHub リポジトリ](https://github.com/jujucub/sumomo)
