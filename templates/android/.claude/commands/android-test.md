---
description: Android端末にAPKをインストールしてテストを実行する。adbを使用した操作。
---

# Android Test Command

Android端末にAPKをインストールし、アプリを起動してテストを行います。

## 前提条件

- Android端末がUSBデバッグ有効で接続されていること
- adbコマンドが使用可能であること
- APKファイルが存在すること

## 作業開始前の確認

```bash
# 接続デバイス確認
adb devices

# 期待される出力:
# List of devices attached
# XXXXXXXX    device
```

デバイスが表示されない場合:
1. USBケーブルを確認
2. 端末でUSBデバッグを許可
3. `adb kill-server && adb start-server` で再起動

## 基本操作

### APKインストール

```bash
# 通常インストール
adb install /path/to/app.apk

# 上書きインストール（既存アプリがある場合）
adb install -r /path/to/app.apk

# ダウングレードも許可
adb install -r -d /path/to/app.apk
```

### アプリ起動

```bash
# パッケージ名とアクティビティ名で起動
adb shell am start -n com.example.app/.MainActivity

# パッケージ名のみで起動（ランチャーアクティビティ）
adb shell monkey -p com.example.app -c android.intent.category.LAUNCHER 1
```

### ログ確認

```bash
# 全ログをリアルタイム表示
adb logcat

# 特定タグのみ
adb logcat -s Unity

# エラーのみ
adb logcat *:E

# バッファクリアしてから取得
adb logcat -c && adb logcat
```

### スクリーンショット取得

```bash
# 端末内に保存
adb shell screencap /sdcard/screenshot.png

# PCに転送
adb pull /sdcard/screenshot.png ./screenshot.png

# 一括実行
adb shell screencap /sdcard/screenshot.png && adb pull /sdcard/screenshot.png ./
```

### 画面操作

```bash
# タップ（x, y座標）
adb shell input tap 500 800

# スワイプ（開始x, y → 終了x, y, 時間ms）
adb shell input swipe 500 1500 500 500 300

# テキスト入力
adb shell input text "hello"

# キー送信（戻るボタン）
adb shell input keyevent KEYCODE_BACK

# ホームボタン
adb shell input keyevent KEYCODE_HOME
```

### アプリ操作

```bash
# アプリ停止
adb shell am force-stop com.example.app

# アプリデータ削除
adb shell pm clear com.example.app

# アンインストール
adb uninstall com.example.app

# インストール済みパッケージ一覧
adb shell pm list packages | grep example
```

## テストワークフロー

### 1. デバイス確認
```bash
adb devices
```

### 2. 既存アプリを削除（クリーンインストール）
```bash
adb uninstall com.example.app 2>/dev/null || true
```

### 3. APKインストール
```bash
adb install /path/to/app.apk
```

### 4. アプリ起動
```bash
adb shell monkey -p com.example.app -c android.intent.category.LAUNCHER 1
```

### 5. 動作確認（ログ監視）
```bash
adb logcat -s Unity:V *:E
```

### 6. スクリーンショット取得
```bash
adb shell screencap /sdcard/test_$(date +%Y%m%d_%H%M%S).png
adb pull /sdcard/test_*.png ./
```

## 複数デバイス対応

```bash
# デバイス一覧確認
adb devices

# 特定デバイスを指定して実行
adb -s DEVICE_SERIAL install app.apk
adb -s DEVICE_SERIAL shell am start -n com.example.app/.MainActivity
```

## トラブルシューティング

### INSTALL_FAILED_UPDATE_INCOMPATIBLE
署名が異なる。既存アプリをアンインストールしてから再インストール。
```bash
adb uninstall com.example.app
adb install app.apk
```

### INSTALL_FAILED_NO_MATCHING_ABIS
APKがデバイスのCPUアーキテクチャに対応していない。
ビルド設定でarm64-v8a/armeabi-v7aを確認。

### デバイスがoffline
```bash
adb kill-server
adb start-server
adb devices
```

### 権限エラー
端末側でUSBデバッグを再許可。

## キーコード一覧

| キーコード | 機能 |
|-----------|------|
| `KEYCODE_HOME` | ホーム |
| `KEYCODE_BACK` | 戻る |
| `KEYCODE_MENU` | メニュー |
| `KEYCODE_VOLUME_UP` | 音量+ |
| `KEYCODE_VOLUME_DOWN` | 音量- |
| `KEYCODE_POWER` | 電源 |
| `KEYCODE_ENTER` | 決定 |

## 作業内容

$ARGUMENTS
