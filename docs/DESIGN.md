# sumomo - 設計書

> GitHub Issue / Slack 連携 Claude 自動対応システム

## 概要

GitHub Issue や Slack メンションをトリガーに、ローカル環境の Claude CLI が自動でコード修正・PR作成を行うシステム。

**名前の由来**: CLAMPの漫画「ちょびっツ」に登場するモバイルパソコン「すもも」から。小さいけど一生懸命働くイメージ。

---

## システム構成図

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Slack                                      │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐ │
│  │ @sumomo 指示    │  │ 承認モーダル    │  │ Issueスレッド           │ │
│  │ 「このバグ直して」│  │ [許可] [拒否]   │  │ 進捗通知                │ │
│  │                 │  │ + コメント入力  │  │                         │ │
│  └────────┬────────┘  └────────┬────────┘  └────────────┬────────────┘ │
└───────────┼────────────────────┼────────────────────────┼───────────────┘
            │                    │                        │
            │ Socket Mode        │                        │
            ▼                    ▼                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  ローカルPC - sumomo Bot                                                │
│  ┌────────────────────────────────────────────────────────────────────┐│
│  │                                                                    ││
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐ ││
│  │  │ Slack Bot    │  │ GitHub監視   │  │ 承認サーバー             │ ││
│  │  │ Socket Mode  │  │ ポーリング   │  │ Express (port:3001)      │ ││
│  │  └──────┬───────┘  └──────┬───────┘  └────────────┬─────────────┘ ││
│  │         │                 │                       │               ││
│  │         └─────────────────┼───────────────────────┘               ││
│  │                           ▼                                       ││
│  │                  ┌─────────────────┐                              ││
│  │                  │  タスクキュー   │                              ││
│  │                  └────────┬────────┘                              ││
│  │                           │                                       ││
│  │         ┌─────────────────┼─────────────────┐                     ││
│  │         ▼                                   ▼                     ││
│  │  ┌─────────────────┐              ┌─────────────────────────────┐ ││
│  │  │ Slackタスク     │              │ GitHub Issueタスク          │ ││
│  │  │ 直接Claude実行  │              │ worktree + tmux             │ ││
│  │  └─────────────────┘              └──────────────┬──────────────┘ ││
│  │                                                  │                ││
│  └──────────────────────────────────────────────────┼────────────────┘│
│                                                     │                 │
│  ┌──────────────────────────────────────────────────┼────────────────┐│
│  │  Git worktree                                    │                ││
│  │  ┌────────────────────────────────────────────┐  │                ││
│  │  │ .worktrees/issue-{N}/                      │  │                ││
│  │  │ ├── ブランチ: sumomo/issue-{N}             │  │                ││
│  │  │ └── 独立した作業ディレクトリ               │  │                ││
│  │  └────────────────────────────────────────────┘  │                ││
│  └──────────────────────────────────────────────────┼────────────────┘│
│                                                     │                 │
│  ┌──────────────────────────────────────────────────┼────────────────┐│
│  │  tmux セッション                                 │                ││
│  │  ┌────────────────────────────────────────────┐  │                ││
│  │  │ セッション名: sumomo-{owner}-{repo}-{N}   │◀─┘                ││
│  │  │ ┌──────────────────────────────────────┐  │                   ││
│  │  │ │ Claude CLI (対話モード)              │  │                   ││
│  │  │ │ - ワークスペース信頼確認: 自動承認    │  │                   ││
│  │  │ │ - 権限要求: tmux send-keys で応答    │  │                   ││
│  │  │ └──────────────────────────────────────┘  │                   ││
│  │  └────────────────────────────────────────────┘                   ││
│  └───────────────────────────────────────────────────────────────────┘│
│                                                                       │
│  ┌───────────────────────────────────────────────────────────────────┐│
│  │  PreToolUse Hook                                                  ││
│  │  ┌──────────────────────────────────────────────────────────────┐ ││
│  │  │ Edit/Write/Bash → slack-approval.py                          │ ││
│  │  │ - SUMOMO_TMUX_SESSION が設定されている場合のみ承認フロー      │ ││
│  │  │ - Slack承認 → tmux send-keys で Claude に応答                │ ││
│  │  └──────────────────────────────────────────────────────────────┘ ││
│  └───────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
            │
            │ 処理完了
            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  GitHub                                                                 │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ 自動コミット → プッシュ → PR作成 → Issueコメント              │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 機能一覧

| 機能 | トリガー | 動作 |
|------|---------|------|
| **Issue自動対応** | GitHub Issue に `[sumomo]` タグ | worktreeで作業、コード修正、PR作成 |
| **Slack指示** | Slack で `@sumomo` | 指示に従ってタスク実行 |
| **実行承認** | 危険なコマンド実行時 | Slackモーダルで許可/拒否（コメント可） |
| **質問回答** | sumomoが判断を求める時 | Slackで選択肢または自由入力 |
| **進捗通知** | 処理開始・完了時 | Slackスレッドで状況報告 |

---

## コンポーネント詳細

### 1. 統合Bot (メインプロセス)

```
src/
├── index.ts           # エントリーポイント、タスク処理
├── config.ts          # 設定読み込み（~/.sumomo/.env優先）
├── types/
│   └── index.ts       # 型定義
├── slack/
│   ├── bot.ts         # Slack Bot (Socket Mode)
│   └── handlers.ts    # メンション・モーダル・ボタン処理
├── github/
│   └── poller.ts      # Issue監視 (ポーリング間隔設定可)
├── approval/
│   └── server.ts      # 承認サーバー (Express)
├── claude/
│   ├── runner.ts      # Claude CLI 直接実行
│   └── tmuxRunner.ts  # tmux経由Claude実行
├── queue/
│   └── taskQueue.ts   # タスク管理
├── git/
│   ├── repo.ts        # リポジトリ管理（クローン・更新）
│   └── worktree.ts    # Git worktree 管理
├── tmux/
│   └── session.ts     # tmux セッション管理
├── mcp/
│   └── setup.ts       # MCP設定（~/.claude.json管理）
├── session/
│   └── store.ts       # セッション永続化（会話継続用）
└── admin/
    ├── server.ts      # 管理画面サーバー
    ├── store.ts       # 管理設定ストア
    └── public/        # 静的ファイル（HTML/CSS/JS）
```

### 2. tmux セッション管理

**役割**
- Claude CLI を対話モードで実行
- ワークスペース信頼確認プロンプトを自動承認
- 権限要求に対して tmux send-keys で応答

**主要関数**
```typescript
// セッション作成（Claude CLI起動）
CreateTmuxSession(sessionName, workingDirectory, issueNumber, prompt)

// 許可を送信（Enter / Tab+コメント+Enter）
SendApproval(sessionName, comment?)

// 拒否を送信（Down Down + Enter / Tab+コメント+Enter）
SendDenial(sessionName, comment?)

// 出力をキャプチャ
CapturePane(sessionName, lines)

// Claude終了検出
IsClaudeFinished(output)
```

### 3. Git worktree 管理

**役割**
- Issue毎に独立した作業ディレクトリを作成
- メインブランチに影響を与えずに作業
- 自動コミット・プッシュ・PR作成

**主要関数**
```typescript
// worktree作成
CreateWorktree(repoPath, owner, repo, issueNumber)
// → .worktrees/issue-{N}/ に sumomo/issue-{N} ブランチで作成

// コミット＆プッシュ
CommitAndPush(worktreeInfo, message)

// PR作成
CreatePullRequest(worktreeInfo, title, body)

// worktree削除
RemoveWorktree(owner, repo, issueNumber)
```

### 4. PreToolUse Hook (実行承認)

**設定 (~/.claude/settings.json)**
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "tool == \"Edit\" || tool == \"Write\" || tool == \"Bash\"",
        "hooks": [{
          "type": "command",
          "command": "~/.claude/hooks/slack-approval.py"
        }]
      }
    ]
  }
}
```

**承認フロー**
```
Claude CLI がツール実行
       │
       ▼
PreToolUse Hook 起動
       │
       ├─ SUMOMO_TMUX_SESSION 未設定 → 自動許可（通常のClaude使用）
       │
       └─ SUMOMO_TMUX_SESSION 設定済み
              │
              ▼
       承認サーバーに問い合わせ
              │
              ▼
       Slackにモーダル表示
       [許可] [拒否] + コメント入力欄
              │
              ▼
       ユーザー応答待機
              │
       ┌──────┴──────┐
       ▼             ▼
    [許可]         [拒否]
       │             │
       ▼             ▼
tmux send-keys   tmux send-keys
    Enter         Down Down Enter
       │             │
       ▼             ▼
   実行継続       ブロック
```

---

## 処理フロー

### GitHub Issue 対応フロー

```
1. GitHub Issue 作成
   └─ タイトルまたは本文に [sumomo] を含む

2. sumomo Bot が検知 (5分間隔ポーリング)

3. Slack にスレッド作成
   └─ 「🍑 GitHub Issue 処理開始」
   └─ Issue リンク表示

4. worktree 作成
   └─ .worktrees/issue-{N}/ ディレクトリ
   └─ sumomo/issue-{N} ブランチ

5. tmux セッション作成
   └─ Claude CLI を対話モードで起動
   └─ ワークスペース信頼確認を自動承認

6. Claude がコード分析・修正
   │
   ├─ Edit/Write/Bash 実行時
   │   └─ PreToolUse Hook → Slack承認待ち
   │       └─ 承認後 tmux send-keys で応答
   │
   └─ 進捗をSlackスレッドに投稿

7. 作業完了
   ├─ 変更をコミット・プッシュ
   └─ PR 自動作成

8. 完了通知
   ├─ Slack スレッド: 「🍑 完了しました PR: https://...」
   └─ GitHub Issue: コメント追加

9. クリーンアップ
   ├─ tmux セッション終了
   └─ worktree 削除
```

### Slack 指示フロー

```
1. Slack で @sumomo メンション
   └─ 「LoginService.cs のバグを直して」

2. スレッドで処理開始通知
   └─ 「🍑 処理を開始します...」

3. Claude CLI 実行
   └─ カレントディレクトリで直接実行
   └─ 出力をスレッドに投稿

4. スレッドで結果報告
   └─ 「🍑 完了しました。変更内容: ...」
```

---

## 承認が必要な操作

| ツール | パターン | 理由 |
|--------|---------|------|
| Bash | `git push` | リモートへの変更 |
| Bash | `git commit` | 履歴の変更 |
| Bash | `rm ` | ファイル削除 |
| Bash | `npm publish` | パッケージ公開 |
| Write | すべて | ファイル作成 |
| Edit | すべて | ファイル編集 |

※ sumomo のtmuxセッション内でのみ承認フローが発動

---

## 必要な認証情報

### 必須

| 項目 | 形式 | 取得方法 |
|------|------|---------|
| `SLACK_BOT_TOKEN` | `xoxb-...` | Slack App設定 |
| `SLACK_APP_TOKEN` | `xapp-...` | Slack App設定 (Socket Mode) |
| `SLACK_CHANNEL_ID` | `C0123456789` | Slack チャンネル情報 |
| `SLACK_TEAM_ID` | `T0123456789` | Slackワークスペース情報 |
| `GITHUB_TOKEN` | `github_pat_...` | GitHub Settings > Developer settings |
| `GITHUB_REPOS` | `owner/repo1,owner/repo2` | 監視対象リポジトリ（カンマ区切り） |

### 任意

| 項目 | デフォルト | 用途 |
|------|-----------|------|
| `ANTHROPIC_API_KEY` | - | Claude API（Max Plan使用時は不要） |
| `APPROVAL_SERVER_PORT` | 3001 | 承認サーバーポート |
| `ADMIN_SERVER_PORT` | 3002 | 管理画面サーバーポート |
| `GITHUB_POLL_INTERVAL` | 300000 | GitHub監視間隔（ミリ秒） |
| `ALLOWED_GITHUB_USERS` | - | 許可GitHubユーザー（カンマ区切り） |
| `ALLOWED_SLACK_USERS` | - | 許可SlackユーザーID（カンマ区切り） |

---

## Slack App 設定

| 項目 | 設定値 |
|------|--------|
| App Name | sumomo |
| Socket Mode | ON |
| Event Subscriptions | `app_mention`, `message.channels` |
| Interactivity & Shortcuts | ON |
| Bot Token Scopes | `app_mentions:read`, `chat:write`, `channels:history` |

**必要なスコープ**
- `app_mentions:read` - メンション検知
- `chat:write` - メッセージ投稿
- `channels:history` - メッセージ履歴取得

---

## ディレクトリ構成

```
sumomo/
├── docs/
│   ├── DESIGN.md              # 本設計書
│   ├── CONTRIB.md             # 開発者ガイド
│   └── RUNBOOK.md             # 運用手順書
├── src/                       # 統合Botソース
│   ├── index.ts               # エントリーポイント
│   ├── config.ts              # 設定
│   ├── types/
│   │   └── index.ts           # 型定義
│   ├── slack/
│   │   ├── bot.ts             # Slack Bot
│   │   └── handlers.ts        # イベントハンドラー
│   ├── github/
│   │   └── poller.ts          # Issue監視
│   ├── approval/
│   │   └── server.ts          # 承認サーバー
│   ├── claude/
│   │   ├── runner.ts          # Claude CLI直接実行
│   │   └── tmuxRunner.ts      # tmux経由実行
│   ├── queue/
│   │   └── taskQueue.ts       # タスクキュー
│   ├── git/
│   │   ├── repo.ts            # リポジトリ管理
│   │   └── worktree.ts        # worktree管理
│   ├── tmux/
│   │   └── session.ts         # tmuxセッション管理
│   ├── mcp/
│   │   └── setup.ts           # MCP設定
│   ├── session/
│   │   └── store.ts           # セッション永続化
│   └── admin/
│       ├── server.ts          # 管理画面サーバー
│       ├── store.ts           # 管理設定ストア
│       └── public/            # 管理画面静的ファイル
├── mcp-servers/
│   └── ask-human/             # ask-human MCPサーバー
├── templates/                 # プロジェクトテンプレート
│   ├── android/
│   └── unity/
├── .claude/
│   ├── settings.json          # Claude設定
│   └── hooks/
│       └── slack-approval.py  # 承認スクリプト
├── ~/.sumomo/                 # ユーザー設定ディレクトリ
│   ├── .env                   # 環境変数（優先読み込み）
│   ├── admin-config.json      # 管理設定
│   └── repos/                 # クローンしたリポジトリ
│       └── {owner}/{repo}/
│           └── .worktrees/    # Issue作業用ディレクトリ
├── package.json
├── tsconfig.json
└── README.md
```

---

## 起動方法

```bash
# 1. 依存インストール
npm install

# 2. 環境変数設定（.envファイル推奨）
cp .env.example ~/.sumomo/.env
# ~/.sumomo/.env を編集

# または環境変数を直接設定
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_APP_TOKEN="xapp-..."
export SLACK_CHANNEL_ID="C0123456789"
export SLACK_TEAM_ID="T0123456789"
export GITHUB_TOKEN="github_pat_..."
export GITHUB_REPOS="owner/repo1,owner/repo2"
export ALLOWED_GITHUB_USERS="user1,user2"
export ALLOWED_SLACK_USERS="U01234567,U09876543"

# 3. ビルド
npm run build

# 4. 起動
npm start
```

### 環境変数の読み込み優先順位

1. `~/.sumomo/.env` （存在する場合）
2. プロジェクトルートの `.env`

### 管理画面

起動後、以下のURLで管理画面にアクセス可能:

```
http://localhost:3002/
```

管理画面で設定可能:
- 許可GitHubユーザー
- 許可Slackユーザー
- 監視対象リポジトリ
- GitHubユーザー ↔ Slackユーザーのマッピング

---

## Slack表示イメージ

### Issue処理開始（スレッド親メッセージ）

```
┌─────────────────────────────────────────────────────────────┐
│ 🍑 GitHub Issue 処理開始                                    │
│                                                             │
│ #42: ログイン画面のバグを修正                               │
│ your-org/your-repo                                          │
│                                                             │
│ 処理の進捗はこのスレッドに投稿されます                      │
└─────────────────────────────────────────────────────────────┘
```

### 進捗通知（スレッド内）

```
└─ 🍑 worktree を作成中...
└─ 🍑 ブランチ `sumomo/issue-42` で作業を開始します
└─ 🍑 Claude を起動中...
└─ 🍑 ```
   // コード修正中の出力...
   ```
└─ 🍑 コミット＆プッシュ中...
└─ 🍑 PR を作成中...
└─ 🍑 完了しました
   PR: https://github.com/your-org/your-repo/pull/123
```

### 承認モーダル

```
┌─────────────────────────────────────────────────────────────┐
│ 実行を許可                                          [×]     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ ツール: Edit                                                │
│ コマンド:                                                   │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Edit: src/login.ts                                      │ │
│ │                                                         │ │
│ │ Old:                                                    │ │
│ │ const isValid = false;                                  │ │
│ │                                                         │ │
│ │ New:                                                    │ │
│ │ const isValid = validateInput(input);                   │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ コメント                                                    │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ コメントがあれば入力してください（任意）                │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│                           [キャンセル]  [許可する]          │
└─────────────────────────────────────────────────────────────┘
```

### 質問

```
┌─────────────────────────────────────────────────────────────┐
│ 🍑 sumomo からの質問                                        │
│                                                             │
│ 認証方式について確認させてください。                        │
│ 現在JWT認証を使用していますが、セッション認証に             │
│ 変更しますか？                                              │
│                                                             │
│ [JWT維持] [セッションに変更] [両方サポート]                 │
└─────────────────────────────────────────────────────────────┘
```
