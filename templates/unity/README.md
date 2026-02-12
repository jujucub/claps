# Unity プロジェクト用テンプレート

clapsでUnityプロジェクトのIssue対応を行うための設定テンプレートです。

## 含まれるファイル

```
.claude/
├── settings.json              # Unity MCP設定
└── commands/
    └── unity-implement.md     # Unity作業Skill
```

## セットアップ

### 1. テンプレートをコピー

対象のUnityプロジェクトに`.claude/`ディレクトリをコピーします。

```bash
cp -r templates/unity/.claude /path/to/unity-project/
```

### 2. Unity MCPパッケージをインストール

Unity Editorで対象プロジェクトを開き、以下の手順でMCPパッケージをインストールします。

1. `Window > Package Manager` を開く
2. `+` ボタン > `Add package from git URL` を選択
3. 以下のURLを入力:
   ```
   https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#main
   ```

### 3. MCP Serverを起動

1. `Window > MCP for Unity` を開く
2. `Start Server` をクリック
3. `Connected ✓` 表示を確認

## 使い方

clapsがIssue対応時に以下のSkillを使用できます。

```
/unity-implement プレイヤーのHPバーを追加して
```

### Skillの機能

- Unity MCPを使用したEditor操作
- コーディング規約に従ったスクリプト生成
- Editorスクリプトによる複雑な操作

## 動作要件

- Unity 2021.3 LTS 以上
- Unity MCPパッケージがインストール済み
- MCP Serverが起動中（localhost:8080）

## コーディング規約

Skillに含まれる規約:

| 対象 | 規則 | 例 |
|------|------|-----|
| クラス名 | UpperCamelCase | `PlayerController` |
| private変数 | _lowerCamelCase | `_currentHealth` |
| public変数 | UpperCamelCase | `MaxHealth` |
| 関数名 | UpperCamelCase | `TakeDamage()` |
| コメント | 日本語 | `// ダメージ処理` |
| 非同期 | UniTask + CancellationToken | - |

## トラブルシューティング

### Unity MCPに接続できない

1. Unity Editorが起動しているか確認
2. `Window > MCP for Unity > Start Server` でサーバー起動
3. ファイアウォールでlocalhost:8080がブロックされていないか確認

### Skillが認識されない

1. `.claude/commands/unity-implement.md` が存在するか確認
2. Claude CLIを再起動

## 関連リンク

- [Unity MCP (CoplayDev)](https://github.com/CoplayDev/unity-mcp)
- [claps](https://github.com/jujucub/claps)
