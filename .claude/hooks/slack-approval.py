#!/usr/bin/env python3
"""
claps - Slack 承認 Hook スクリプト
PreToolUse Hook として実行され、ツール使用の承認を制御する

--dangerously-skip-permissions モードで動作:
- 安全なツール（Read, Glob, Grep等）は即許可
- mcp__claps-* ツールは即許可
- その他のツールは承認サーバー経由でSlack承認を求める
- 承認サーバー接続失敗時は deny（安全側）
"""

import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

# clapsタスクID（環境変数から取得、なければこのHookは無効）
TASK_ID = os.environ.get('CLAPS_TASK_ID', '')

# 承認サーバーのURL
APPROVAL_SERVER_URL = os.environ.get('APPROVAL_SERVER_URL', 'http://localhost:3001')

# 認証トークンファイルのパス
AUTH_TOKEN_FILE = Path.home() / '.claps' / 'auth-token'

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


def _debug_log(msg: str):
    """デバッグログを /tmp に書き出す"""
    import datetime
    with open('/tmp/claps-hook-debug.log', 'a') as f:
        f.write(f"{datetime.datetime.now()} {msg}\n")


def main():
    """メインエントリーポイント"""
    _debug_log(f"[START] TASK_ID='{TASK_ID}' APPROVAL_URL='{APPROVAL_SERVER_URL}'")

    # clapsタスクIDがなければ何もしない（ローカル開発時等）
    if not TASK_ID:
        _debug_log("[EXIT] No TASK_ID, exiting")
        exit(0)

    print("[Hook] slack-approval.py started", file=sys.stderr)

    # 標準入力からHook入力を読み取る
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        _debug_log("[ERROR] JSON parse error")
        output_result("deny", "JSON parse error")
        return

    tool_name = input_data.get('tool_name', '')
    tool_input = input_data.get('tool_input', {})
    _debug_log(f"[TOOL] tool_name='{tool_name}'")

    # 安全なツールは即許可
    if tool_name in SAFE_TOOLS:
        _debug_log(f"[ALLOW] Safe tool: {tool_name}")
        output_result("allow")
        return

    # mcp__claps-* ツールは即許可
    if tool_name.startswith('mcp__claps-'):
        _debug_log(f"[ALLOW] MCP tool: {tool_name}")
        output_result("allow")
        return

    # その他のツールは承認サーバーに問い合わせ
    _debug_log(f"[APPROVAL] Requesting approval for: {tool_name}")
    try:
        result = request_approval(tool_name, tool_input)
        decision = result.get("permissionDecision", "deny")
        reason = result.get("message", "")
        _debug_log(f"[RESULT] decision='{decision}' reason='{reason}'")
        output_result(decision, reason)
    except Exception as e:
        _debug_log(f"[ERROR] Approval failed: {e}")
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
        raise Exception("Auth token not found. Is claps running?")

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
