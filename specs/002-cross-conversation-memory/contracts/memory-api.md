# Internal API Contracts: メモリシステム

**Date**: 2026-02-21
**Feature**: 002-cross-conversation-memory

本ドキュメントはメモリシステムの内部モジュール間インターフェースを定義する。
外部 REST/HTTP API ではなく、TypeScript モジュール間の関数契約である。

## MemoryStore (`src/memory/store.ts`)

メモリファイルの CRUD 操作を提供するシングルトン。

### GetMemoryStore(): MemoryStore

シングルトンインスタンスを返す。

### ListProjects(): ProjectSummary[]

登録済みプロジェクトの一覧を返す。

```typescript
interface ProjectSummary {
  readonly projectName: string;
  readonly description: string;
  readonly lastUpdatedAt: string;
}
```

**動作**: `~/.claps/memory/projects/` 配下のディレクトリを走査し、
各 `MEMORY.md` のブロック引用行から description を抽出する。

### ReadMemory(projectName: string): ProjectMemoryContent

指定プロジェクトの MEMORY.md 内容を読み取る。

```typescript
interface ProjectMemoryContent {
  readonly projectName: string;
  readonly memoryContent: string;   // MEMORY.md の全文
  readonly pinnedContent: string;   // pinned.md の全文
  readonly sizeBytes: number;       // MEMORY.md のバイトサイズ
}
```

**エラー**: プロジェクトが存在しない場合は `null` を返す。

### CreateProject(projectName: string, description: string): ProjectMemoryContent

新規プロジェクトのメモリディレクトリおよび初期ファイルを作成する。

**動作**:
1. `~/.claps/memory/projects/{projectName}/` ディレクトリ作成
2. MEMORY.md をフォーマット規約に従い初期化
3. pinned.md を空ファイルとして作成
4. decisions.md を空ファイルとして作成

**バリデーション**: `projectName` が命名規則に合致すること。
重複する場合はエラー。

### AppendMemory(projectName: string, entry: MemoryEntryInput): void

MEMORY.md の「最近の活動」セクションにエントリを追記する。

```typescript
interface MemoryEntryInput {
  readonly content: string;
  readonly source: MemorySource;
}
```

**動作**: タイムスタンプを付与して追記後、ファイルを保存。

### AppendPinned(projectName: string, entry: PinnedEntryInput): void

pinned.md にユーザー明示指示の記憶を追記する。

```typescript
interface PinnedEntryInput {
  readonly content: string;
  readonly originalPrompt: string;
  readonly source: MemorySource;
}
```

### GetMemorySize(projectName: string): number

MEMORY.md のバイトサイズを返す。

### BackupMemory(projectName: string): string

MEMORY.md のバックアップを作成し、バックアップファイルパスを返す。
直近 `maxBackups` 件を超えた古いバックアップは削除する。

### ReplaceMemoryContent(projectName: string, newContent: string): void

MEMORY.md の内容を全置換する（概要化後の書き戻し用）。
呼び出し前に `BackupMemory()` を実行すること。

---

## MemoryRouter (`src/memory/router.ts`)

LLM ベースのプロジェクト分類を提供する。

### GetMemoryRouter(): MemoryRouter

シングルトンインスタンスを返す。

### RouteConversation(message: string, currentProject?: string): Promise\<MemoryRoutingResult\>

会話メッセージを分析し、該当プロジェクトを推定する。

**入力**:
- `message`: ユーザーの会話メッセージ
- `currentProject`: 現在アクティブなプロジェクト名（省略可能）

**動作**:
1. `MemoryStore.ListProjects()` でプロジェクトカタログを構築
2. ルーティングプロンプトを構築
3. Claude CLI を軽量呼び出しして分類結果を取得
4. JSON レスポンスをパースして `MemoryRoutingResult` を返す

**エラーハンドリング**:
- Claude CLI 呼び出し失敗時: `currentProject` があればそれを返す。
  なければ `confidence: 'low'` で新規作成を提案
- JSON パース失敗時: 同上

### BuildCatalogue(projects: ProjectSummary[]): string

プロジェクト一覧をルーティングプロンプト用の
番号付きリスト文字列に変換する。

---

## MemorySummarizer (`src/memory/summarizer.ts`)

メモリの概要化・圧縮を提供する。

### GetMemorySummarizer(): MemorySummarizer

シングルトンインスタンスを返す。

### ShouldSummarize(projectName: string): boolean

指定プロジェクトの MEMORY.md が概要化閾値を超えているか判定する。

### Summarize(projectName: string): Promise\<SummarizeResult\>

MEMORY.md を概要化する。

```typescript
interface SummarizeResult {
  readonly success: boolean;
  readonly originalSize: number;
  readonly newSize: number;
  readonly entriesSummarized: number;
  readonly entriesPreserved: number;
  readonly backupPath: string;
}
```

**動作**:
1. `MemoryStore.BackupMemory()` でバックアップ作成
2. MEMORY.md の内容を解析
3. pinned エントリ、7 日以内のエントリを保護対象に分離
4. 保護対象外のエントリを LLM で概要化
5. 概要化結果と保護対象を結合して新しい MEMORY.md を構築
6. `MemoryStore.ReplaceMemoryContent()` で書き戻し

**エラーハンドリング**:
- 概要化失敗時: バックアップから復元し、
  `success: false` を返す

---

## MemoryInjector (`src/memory/injector.ts`)

プロンプトへのメモリコンテキスト注入を提供する。

### GetMemoryInjector(): MemoryInjector

シングルトンインスタンスを返す。

### BuildMemoryContext(routingResult: MemoryRoutingResult): Promise\<string\>

ルーティング結果に基づき、プロンプトに注入する
メモリコンテキスト文字列を構築する。

**動作**:
1. primary プロジェクトの MEMORY.md + pinned.md を読み込み
2. secondary プロジェクトがある場合、その MEMORY.md の概要部分のみ読み込み
3. 合計サイズが `maxInjectionSize` を超えないよう切り詰め
4. フォーマットされたコンテキスト文字列を返す

**出力フォーマット例**:
```
---
## プロジェクトメモリ: api-refactoring

[MEMORY.md の内容]

### 固定記憶
[pinned.md の内容]

---
```

### InjectIntoPrompt(prompt: string, memoryContext: string): string

既存のプロンプトにメモリコンテキストを結合する。

---

## パイプライン統合 (`src/index.ts` への変更)

### タスク処理フロー（変更後）

```
1. GetNextTask()
2. タスク種別判定
3. [NEW] MemoryRouter.RouteConversation(task.prompt)
4. [NEW] MemoryInjector.BuildMemoryContext(routingResult)
5. BuildSlackContext() / BuildGitHubContext()
6. [MOD] promptWithContext = prompt + channelContext + memoryContext
7. _claudeRunner.Run(taskId, promptWithContext, options)
8. RecordTaskCompletion(task, result)
9. [NEW] MemoryStore.AppendMemory(projectName, entry)
10. [NEW] if ShouldSummarize(projectName): Summarize(projectName)
11. [NEW] RecordMemoryEvent(event)
12. 結果通知
```

### 変更対象関数

- `ProcessNextTask()` — ステップ 3-4、9-11 を追加
- `ProcessGitHubTask()` — メモリコンテキストの受け渡し
- `ProcessSlackAsIssueTask()` — 同上
- `ProcessSlackWithTargetRepo()` — 同上

### 型定義追加 (`src/types/index.ts`)

- `MemorySource` — 判別共用体
- `MemoryRoutingResult` — ルーティング結果
- `MemoryEvent` / `MemoryEventType` — 履歴記録用
- `MemoryConfig` — 設定
- `ProjectSummary` — プロジェクト一覧用
- `ProjectMemoryContent` — メモリ読み取り結果
