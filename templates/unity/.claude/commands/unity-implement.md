---
description: Unity作業を実行。Editor操作、スクリプト作成、シーン編集などをUnity MCPを使って行う。
---

# Unity Implement Command

Unityプロジェクトでの実装作業を行います。Unity MCPを使用してEditor操作を実行します。

## 前提条件

- Unity Editorが起動していること
- Unity MCP Server が有効であること（Window > MCP for Unity > Start Server）
- localhost:8080 でMCPサーバーが応答すること

## 作業開始前の確認

1. **Unity MCP接続確認**: MCPツールが使えるか確認する
2. **接続できない場合**: 作業を中断し、ユーザーにUnity起動を依頼する

## コーディング規約

### 命名規則
- クラス名: **UpperCamelCase** (例: `PlayerController`)
- private変数: **_lowerCamelCase** (例: `_currentHealth`)
- public変数: **UpperCamelCase** (例: `MaxHealth`)
- 関数名: **UpperCamelCase** (例: `TakeDamage()`)
- コメント: **日本語**

### 非同期処理
- `UniTask` を使用する（Taskではない）
- 必ず `CancellationToken` を引数に渡す

```csharp
public async UniTask LoadDataAsync(CancellationToken cancellationToken)
{
    // 処理
    await UniTask.Delay(1000, cancellationToken: cancellationToken);
}
```

## 作業パターン

### A. スクリプト作成・編集
通常のファイル操作で対応。Unity MCPは不要。

```csharp
// Assets/Scripts/Player/PlayerHealth.cs
using UnityEngine;
using Cysharp.Threading.Tasks;
using System.Threading;

public class PlayerHealth : MonoBehaviour
{
    [SerializeField] private int _maxHealth = 100;
    private int _currentHealth;

    /// <summary>
    /// ダメージを受ける
    /// </summary>
    public void TakeDamage(int damage)
    {
        _currentHealth = Mathf.Max(0, _currentHealth - damage);
    }
}
```

### B. Editor操作が必要な場合
Unity MCPのツールを使用する。

対象:
- シーン操作（オブジェクト追加、コンポーネント追加）
- Prefab作成・編集
- アセット生成（Material, ScriptableObject等）
- ビルド設定変更

### C. MCPで対応できない複雑な操作
Editorスクリプトを作成して実行する。

```csharp
// Assets/Editor/Claps/ClapsEditorTask.cs
using UnityEditor;
using UnityEngine;

public static class ClapsEditorTask
{
    [MenuItem("Claps/Execute Current Task")]
    public static void Execute()
    {
        // ここに複雑な操作を記述

        Debug.Log("[Claps] タスク完了");
    }
}
```

実行後は `Assets/Editor/Claps/` 内の一時スクリプトを削除する。

## Unity MCP 主要ツール

| ツール | 用途 |
|--------|------|
| `get_active_gameobjects` | シーン内のGameObject一覧取得 |
| `create_gameobject` | 新規GameObject作成 |
| `add_component` | コンポーネント追加 |
| `modify_component` | コンポーネントのプロパティ変更 |
| `create_prefab` | Prefab作成 |
| `execute_menu_item` | メニューアイテム実行 |
| `run_editor_script` | Editorスクリプト実行 |

## エラー対応

### Unity MCPに接続できない
```
Unity Editorが起動しているか確認してください。
Window > MCP for Unity > Start Server でMCPサーバーを起動してください。
```

### コンパイルエラーが発生
1. エラー内容を確認
2. 該当スクリプトを修正
3. Unity Editorでコンパイル完了を待つ

### シーンが保存されていない
変更を加える前に、現在のシーンの保存状態を確認し、必要であれば保存を促す。

## 作業完了後

1. 変更したファイルを確認
2. シーンを保存（必要な場合）
3. コンパイルエラーがないことを確認
4. 動作確認方法があれば提示

## 作業内容

$ARGUMENTS
