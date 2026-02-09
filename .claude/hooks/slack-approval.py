#!/usr/bin/env python3
"""
sumomo - Slack 承認 Hook スクリプト
PreToolUse Hook として実行され、ツール使用の承認を制御する

--dangerously-skip-permissions モードで動作:
- 安全なツール（Read, Glob, Grep等）は即許可
- mcp__sumomo-* ツールは即許可
- その他のツールは承認サーバー経由でSlack承認を求める
- 承認サーバー接続失敗時は deny（安全側）
"""

import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

# sumomoタスクID（環境変数から取得、なければこのHookは無効）
TASK_ID = os.environ.get('SUMOMO_TASK_ID', '')

# 承認サーバーのURL
APPROVAL_SERVER_URL = os.environ.get('APPROVAL_SERVER_URL', 'http://localhost:3001')

# 認証トークンファイルのパス
AUTH_TOKEN_FILE = Path.home() / '.sumomo' / 'auth-token'

# 安全なツール（即許可）
SAFE_TOOLS = {
    'Read',
    'Glob',
    'Grep',
    'LSP',
    'WebSearch',
    'WebFetch',
    'TodoRead',
    'TodoWrite',
    'TaskCreate',
    'TaskGet',
    'TaskList',
    'TaskUpdate',
    'AskFollowupQuestion',
}


def get_auth_token() -> str:
    """認証トークンをファイルから読み込む"""
    try:
        return AUTH_TOKEN_FILE.read_text().strip()
    except FileNotFoundError:
        return ''


def main():
    """メインエントリーポイント"""
    # sumomoタスクIDがなければ何もしない（ローカル開発時等）
    if not TASK_ID:
        exit(0)

    print("[Hook] slack-approval.py started", file=sys.stderr)

    # 標準入力からHook入力を読み取る
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        print("[Hook] JSON parse error, denying for safety", file=sys.stderr)
        output_result("deny", "JSON parse error")
        return

    tool_name = input_data.get('tool_name', '')
    tool_input = input_data.get('tool_input', {})
    print(f"[Hook] tool_name={tool_name}, task_id={TASK_ID}", file=sys.stderr)

    # 安全なツールは即許可
    if tool_name in SAFE_TOOLS:
        print(f"[Hook] Safe tool, auto-allowing: {tool_name}", file=sys.stderr)
        output_result("allow")
        return

    # mcp__sumomo-* ツールは即許可
    if tool_name.startswith('mcp__sumomo-'):
        print(f"[Hook] Sumomo MCP tool, auto-allowing: {tool_name}", file=sys.stderr)
        output_result("allow")
        return

    # その他のツールは承認サーバーに問い合わせ
    try:
        result = request_approval(tool_name, tool_input)
        decision = result.get("permissionDecision", "deny")
        reason = result.get("message", "")
        print(f"[Hook] Server decision: {decision} ({reason})", file=sys.stderr)
        output_result(decision, reason)
    except Exception as e:
        print(f"[Hook] Approval request failed: {e}", file=sys.stderr)
        # エラーの場合は拒否（安全側）
        output_result("deny", f"Approval request failed: {str(e)}")


def request_approval(tool_name: str, tool_input: dict) -> dict:
    """承認サーバーに承認リクエストを送信する"""
    url = f"{APPROVAL_SERVER_URL}/approve"

    data = json.dumps({
        "tool_name": tool_name,
        "tool_input": tool_input
    }).encode('utf-8')

    # 認証トークンを取得
    auth_token = get_auth_token()
    if not auth_token:
        raise Exception("Auth token not found. Is sumomo running?")

    headers = {
        'Content-Type': 'application/json',
        'X-Auth-Token': auth_token
    }

    request = urllib.request.Request(url, data=data, headers=headers, method='POST')

    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            result = json.loads(response.read().decode('utf-8'))
            return result
    except urllib.error.HTTPError as e:
        raise Exception(f"HTTP error: {e.code}")
    except urllib.error.URLError as e:
        raise Exception(f"URL error: {e.reason}")


def output_result(decision: str, reason: str = ""):
    """Claude CLI が期待する形式で結果を出力する"""
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason
        }
    }))


if __name__ == '__main__':
    main()
