# Android テスト用テンプレート

clapsでAndroid端末へのAPKインストール・テストを行うための設定テンプレートです。

## 含まれるファイル

```
.claude/
└── commands/
    └── android-test.md     # Android操作Skill
```

## セットアップ

### 1. テンプレートをコピー

対象プロジェクトに`.claude/`ディレクトリをコピーします。

```bash
cp -r templates/android/.claude /path/to/project/
```

### 2. adbのインストール確認

```bash
adb version
# Android Debug Bridge version X.X.X
```

インストールされていない場合:
- macOS: `brew install android-platform-tools`
- Windows: Android Studio付属またはPlatform Tools単体ダウンロード
- Linux: `sudo apt install adb`

### 3. Android端末の準備

1. **開発者オプションを有効化**
   - 設定 > 端末情報 > ビルド番号を7回タップ

2. **USBデバッグを有効化**
   - 設定 > 開発者オプション > USBデバッグ ON

3. **PCに接続**
   - USBケーブルで接続
   - 端末に表示される「USBデバッグを許可」を承認

4. **接続確認**
   ```bash
   adb devices
   # XXXXXXXX    device と表示されればOK
   ```

## 使い方

```bash
/android-test アプリをインストールして起動確認

/android-test build/app.apk をインストールしてログを取得

/android-test スクリーンショットを5枚取得して動作確認
```

## 主な機能

| 機能 | コマンド例 |
|------|-----------|
| APKインストール | `adb install app.apk` |
| アプリ起動 | `adb shell am start -n パッケージ/.Activity` |
| ログ取得 | `adb logcat` |
| スクリーンショット | `adb shell screencap` |
| タップ操作 | `adb shell input tap x y` |
| スワイプ | `adb shell input swipe x1 y1 x2 y2` |

## Unity + Android の組み合わせ

UnityでビルドしたAPKをテストする場合、両方のテンプレートを使用できます。

```bash
# 両方のテンプレートをコピー
cp -r templates/unity/.claude /path/to/unity-project/
cp -r templates/android/.claude/commands/* /path/to/unity-project/.claude/commands/
```

これで `/unity-implement` と `/android-test` の両方が使えます。

## トラブルシューティング

### デバイスが認識されない

```bash
# adbサーバー再起動
adb kill-server
adb start-server
adb devices
```

### unauthorized と表示される

端末側で「USBデバッグを許可」ダイアログを確認し、「常に許可」にチェックを入れて許可。

### 複数デバイス接続時

```bash
# デバイス一覧確認
adb devices

# 特定デバイスを指定
adb -s DEVICE_SERIAL install app.apk
```

## 関連リンク

- [Android Debug Bridge (adb)](https://developer.android.com/tools/adb)
- [claps](https://github.com/jujucub/claps)
