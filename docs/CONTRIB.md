# Contributing Guide (開発者ガイド)

> sumomo 開発に参加するための手順書

## 目次

- [開発環境セットアップ](#開発環境セットアップ)
- [利用可能なスクリプト](#利用可能なスクリプト)
- [環境変数](#環境変数)
- [プロジェクト構成](#プロジェクト構成)
- [開発ワークフロー](#開発ワークフロー)
- [テスト手順](#テスト手順)
- [コーディング規約](#コーディング規約)

---

## 開発環境セットアップ

### 必要な環境

| ツール | バージョン | 用途 |
|--------|-----------|------|
| Node.js | >= 20.0.0 | ランタイム |
| npm | >= 10.0.0 | パッケージ管理 |
| Claude CLI | 最新 | AI実行エンジン |
| tmux | 最新 | セッション管理 |
| Git | >= 2.20 | worktree機能 |
| GitHub CLI (gh) | 最新 | PR作成 |

### セットアップ手順

```bash
# 1. リポジトリをクローン
git clone https://github.com/jujucub/sumomo.git
cd sumomo

# 2. 依存関係をインストール
npm install

# 3. 環境変数を設定
cp .env.example .env
# .env を編集して認証情報を設定

# 4. ビルド
npm run build

# 5. 開発サーバー起動
npm run dev
```

---

## 利用可能なスクリプト

| コマンド | 説明 |
|----------|------|
| `npm run build` | TypeScriptをコンパイルし、管理画面の静的ファイルをdist/admin/にコピー |
| `npm start` | ビルド済みアプリケーションを本番モードで起動 |
| `npm run dev` | 開発モードでホットリロード付きで起動（tsx watch使用） |
| `npm run lint` | ESLintでソースコードの静的解析を実行 |
| `npm run typecheck` | TypeScriptの型チェックのみ実行（出力なし） |

### スクリプト詳細

#### `npm run build`
```bash
tsc && cp -r src/admin/public dist/admin/
```
- TypeScriptコンパイル
- 管理画面の静的ファイル（HTML/CSS/JS）をdistにコピー

#### `npm run dev`
```bash
tsx watch src/index.ts
```
- ファイル変更を監視して自動再起動
- 開発中はこちらを使用

---

## 環境変数

### 必須環境変数

| 変数名 | 形式 | 説明 |
|--------|------|------|
| `SLACK_BOT_TOKEN` | `xoxb-...` | Slack Bot Token（Slack App設定から取得） |
| `SLACK_APP_TOKEN` | `xapp-...` | Slack App Token（Socket Mode有効化が必要） |
| `SLACK_CHANNEL_ID` | `C0123456789` | 通知先Slackチャンネル |
| `SLACK_TEAM_ID` | `T0123456789` | SlackワークスペースID |
| `GITHUB_TOKEN` | `github_pat_...` | GitHub Personal Access Token |
| `GITHUB_REPOS` | `owner/repo1,owner/repo2` | 監視対象リポジトリ（カンマ区切り） |

### 任意環境変数

| 変数名 | デフォルト | 説明 |
|--------|-----------|------|
| `ANTHROPIC_API_KEY` | - | Anthropic API Key（Max Plan使用時は不要） |
| `APPROVAL_SERVER_PORT` | `3001` | 承認サーバーのポート番号 |
| `ADMIN_SERVER_PORT` | `3002` | 管理画面サーバーのポート番号 |
| `GITHUB_POLL_INTERVAL` | `300000` | GitHub Issue監視間隔（ミリ秒、デフォルト5分） |
| `ALLOWED_GITHUB_USERS` | - | 許可するGitHubユーザー（カンマ区切り） |
| `ALLOWED_SLACK_USERS` | - | 許可するSlackユーザーID（カンマ区切り） |

### 環境変数の読み込み優先順位

1. `~/.sumomo/.env` （存在する場合）
2. プロジェクトルートの `.env`

---

## プロジェクト構成

```
sumomo/
├── src/                        # ソースコード
│   ├── index.ts                # メインエントリーポイント
│   ├── config.ts               # 設定読み込み
│   ├── types/
│   │   └── index.ts            # 型定義
│   ├── slack/
│   │   ├── bot.ts              # Slack Bot (Socket Mode)
│   │   └── handlers.ts         # イベントハンドラー
│   ├── github/
│   │   └── poller.ts           # Issue監視 (ポーリング)
│   ├── approval/
│   │   └── server.ts           # 承認サーバー (Express)
│   ├── claude/
│   │   ├── runner.ts           # Claude CLI 直接実行
│   │   └── tmuxRunner.ts       # tmux経由Claude実行
│   ├── queue/
│   │   └── taskQueue.ts        # タスクキュー管理
│   ├── git/
│   │   ├── repo.ts             # リポジトリ管理
│   │   └── worktree.ts         # Git worktree管理
│   ├── tmux/
│   │   └── session.ts          # tmuxセッション管理
│   ├── mcp/
│   │   └── setup.ts            # MCP設定
│   ├── session/
│   │   └── store.ts            # セッション永続化
│   └── admin/
│       ├── server.ts           # 管理画面サーバー
│       ├── store.ts            # 管理設定ストア
│       └── public/             # 静的ファイル
│           ├── index.html
│           ├── style.css
│           └── app.js
├── mcp-servers/
│   └── ask-human/              # ask-human MCPサーバー
├── templates/                  # プロジェクトテンプレート
│   ├── android/
│   └── unity/
├── docs/                       # ドキュメント
│   ├── DESIGN.md               # 設計書
│   ├── CONTRIB.md              # 開発者ガイド（本ファイル）
│   └── RUNBOOK.md              # 運用手順書
└── .claude/
    ├── settings.json           # Claude設定
    └── hooks/
        └── slack-approval.py   # 承認フック
```

---

## 開発ワークフロー

### 1. ブランチ戦略

```
main ─────────────────────────────────
  └─ feature/xxx ─────────────────────
       └─ sumomo/issue-{N} ──────────
```

- `main`: 本番ブランチ
- `feature/*`: 機能開発ブランチ
- `sumomo/issue-{N}`: sumomoが自動作成するブランチ

### 2. コミットメッセージ規約

```
<type>: <description>

<optional body>
```

**Types:**
- `feat`: 新機能
- `fix`: バグ修正
- `refactor`: リファクタリング
- `docs`: ドキュメント
- `test`: テスト
- `chore`: その他

### 3. PRワークフロー

1. ブランチを作成
2. 変更を実装
3. `npm run lint` でチェック
4. `npm run typecheck` で型チェック
5. PRを作成
6. レビューを受ける

---

## テスト手順

### ローカルテスト

```bash
# 1. 開発モードで起動
npm run dev

# 2. Slackでテスト
# @sumomo テストメッセージ

# 3. GitHub Issueでテスト
# [sumomo] テストIssue を作成
```

### 型チェック

```bash
npm run typecheck
```

### Lintチェック

```bash
npm run lint
```

---

## コーディング規約

### TypeScript

- 厳密な型定義を使用
- `any` は避ける
- インターフェースは `readonly` を活用

### 命名規約

| 種類 | 規約 | 例 |
|------|------|-----|
| クラス名 | UpperCamelCase | `TaskQueue` |
| 関数名 | UpperCamelCase | `ProcessTask` |
| private変数 | _lowerCamelCase | `_isRunning` |
| public変数 | UpperCamelCase | `Config` |
| 定数 | UPPER_SNAKE_CASE | `POLL_INTERVAL_MS` |

### コメント

- コメントは日本語
- JSDocスタイルで関数を説明

```typescript
/**
 * タスクを処理する
 * @param task - 処理対象のタスク
 * @returns 処理結果
 */
async function ProcessTask(task: Task): Promise<TaskResult> {
  // ...
}
```

### 非同期処理

- `async/await` を使用
- CancellationToken のサポート（将来）

---

## トラブルシューティング

### よくある問題

#### ビルドエラー

```bash
# node_modules を再インストール
rm -rf node_modules
npm install
```

#### Slack接続エラー

- `SLACK_BOT_TOKEN` と `SLACK_APP_TOKEN` を確認
- Socket Mode が有効か確認

#### GitHub連携エラー

- `GITHUB_TOKEN` の権限を確認
- リポジトリへのアクセス権があるか確認

---

## 参考リンク

- [Slack Bolt for JavaScript](https://slack.dev/bolt-js/)
- [Octokit REST API](https://octokit.github.io/rest.js/)
- [Claude CLI Documentation](https://docs.anthropic.com/)
