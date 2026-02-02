# sumomo 🍑

GitHub Issue / Slack 連携 Claude 自動対応システム

## これは何？

`[sumomo]` タグを付けるだけで、Claude が自動でコード修正・PR作成を行うBotです。

- **GitHub Issue** に `[sumomo]` タグ → Issue を分析してコード修正、PR作成
- **Slack** で `@sumomo` → 指示に従ってタスク実行
- **危険な操作** → Slack モーダルで承認を求める（コメント入力可）
- **判断が必要な時** → Slack で質問してくる

## 主な機能

| 機能 | 説明 |
|------|------|
| **worktree分離** | Issue毎に独立したworktreeで作業、メインブランチに影響なし |
| **自動PR作成** | 作業完了後に自動でコミット・プッシュ・PR作成 |
| **tmux制御** | Claude CLIを対話モードで実行、権限制御も可能 |
| **Slackスレッド** | Issue処理の進捗をスレッドでリアルタイム通知 |
| **モーダル承認** | 許可/拒否時にコメント入力可能 |
| **セッション継続** | 同じスレッド/Issueでの会話を継続可能 |
| **管理UI** | ホワイトリストやリポジトリをWebで管理 |

## 名前の由来

CLAMPの漫画「ちょびっツ」に登場するモバイルパソコン「すもも」から。
小さいけど一生懸命働くイメージ。

## クイックスタート

```bash
# 依存インストール
npm install

# 環境変数設定
cp .env.example .env
# .env を編集して認証情報を設定

# ビルド
npm run build

# 起動
npm start
```

## 必要な環境

| ツール | バージョン | 用途 |
|--------|-----------|------|
| Node.js | >= 20.0.0 | ランタイム |
| Claude CLI | 最新 | AI実行エンジン |
| tmux | 最新 | セッション管理 |
| Git | >= 2.20 | worktree機能 |
| GitHub CLI (gh) | 最新 | PR作成 |

## 環境変数

### 必須

| 項目 | 形式 | 説明 |
|------|------|------|
| `SLACK_BOT_TOKEN` | `xoxb-...` | Slack Bot Token |
| `SLACK_APP_TOKEN` | `xapp-...` | Slack App Token (Socket Mode) |
| `SLACK_CHANNEL_ID` | `C0123456789` | 通知先チャンネルID |
| `SLACK_TEAM_ID` | `T0123456789` | SlackワークスペースID |
| `GITHUB_TOKEN` | `github_pat_...` | GitHub Personal Access Token |
| `GITHUB_REPOS` | `owner/repo1,owner/repo2` | 監視対象リポジトリ（カンマ区切り） |

### 任意

| 項目 | デフォルト | 説明 |
|------|-----------|------|
| `ANTHROPIC_API_KEY` | - | Anthropic API Key（Max Plan使用時は不要） |
| `APPROVAL_SERVER_PORT` | `3001` | 承認サーバーポート |
| `ADMIN_SERVER_PORT` | `3002` | 管理画面サーバーポート |
| `GITHUB_POLL_INTERVAL` | `300000` | GitHub監視間隔（ミリ秒） |
| `ALLOWED_GITHUB_USERS` | - | 許可するGitHubユーザー（カンマ区切り） |
| `ALLOWED_SLACK_USERS` | - | 許可するSlackユーザーID（カンマ区切り） |

## 使い方

### GitHub Issue から自動対応

1. Issue を作成
2. タイトルまたは本文に `[sumomo]` を含める
3. sumomo が自動検知して処理開始
4. 完了後、PRが自動作成される

```markdown
# Issue タイトル例
[sumomo] ログイン画面のバグを修正

# Issue 本文例
ログインボタンが反応しない問題を修正してください。
```

### Slack から指示

```
@sumomo このファイルのテストを書いて
```

### 管理UI

```
http://localhost:3002/
```

管理UIで設定可能:
- 許可GitHubユーザー
- 許可Slackユーザー
- 監視対象リポジトリ
- GitHubユーザー ↔ Slackユーザーのマッピング

## 利用可能なスクリプト

| コマンド | 説明 |
|----------|------|
| `npm run build` | TypeScriptをコンパイル |
| `npm start` | 本番モードで起動 |
| `npm run dev` | 開発モードで起動（ホットリロード） |
| `npm run lint` | ESLintで静的解析 |
| `npm run typecheck` | TypeScriptの型チェック |

## ドキュメント

- [設計書](./docs/DESIGN.md) - システム構成、処理フロー、実装詳細
- [開発者ガイド](./docs/CONTRIB.md) - 開発環境セットアップ、コーディング規約
- [運用手順書](./docs/RUNBOOK.md) - デプロイ、監視、トラブルシューティング

## ライセンス

MIT
