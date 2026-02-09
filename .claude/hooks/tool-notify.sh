#!/bin/bash
# sumomo - ツール使用通知 Hook スクリプト
# PreToolUse Hook として実行され、承認サーバーに作業ログを非同期送信する

# sumomoタスクでなければ何もしない
if [ -z "$SUMOMO_TASK_ID" ]; then
  exit 0
fi

# 標準入力からHook入力を読み取る
INPUT=$(cat)

# 認証トークンを読み込む
AUTH_TOKEN_FILE="$HOME/.sumomo/auth-token"
if [ ! -f "$AUTH_TOKEN_FILE" ]; then
  exit 0
fi
AUTH_TOKEN=$(cat "$AUTH_TOKEN_FILE")

APPROVAL_SERVER_URL="${APPROVAL_SERVER_URL:-http://localhost:3001}"

# 承認サーバーに非同期で通知（バックグラウンド実行、パイプ経由でインジェクション防止）
echo "$INPUT" | curl -s -X POST "${APPROVAL_SERVER_URL}/notify-tool" \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: ${AUTH_TOKEN}" \
  -d @- \
  --max-time 5 \
  > /dev/null 2>&1 &

# Claude CLIに何も返さない（許可/拒否の判断はしない）
exit 0
