#!/usr/bin/env python3
"""
sumomo - Slack 承認 Hook スクリプト
PreToolUse Hook として実行され、危険な操作に対して Slack 経由で承認を求める
"""

import json
import os
import sys
import urllib.request
import urllib.error

# 承認サーバーのURL
APPROVAL_SERVER_URL = os.environ.get('APPROVAL_SERVER_URL', 'http://localhost:3001')


def main():
    """メインエントリーポイント"""
    # 標準入力からHook入力を読み取る
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        # JSONパースエラーの場合は許可（安全側に倒さない設計）
        print(json.dumps({"permissionDecision": "allow"}))
        return

    tool_name = input_data.get('tool_name', '')
    tool_input = input_data.get('tool_input', {})

    # 承認サーバーに問い合わせ
    try:
        result = request_approval(tool_name, tool_input)
        print(json.dumps(result))
    except Exception as e:
        # エラーの場合は拒否（安全側に倒す）
        print(json.dumps({
            "permissionDecision": "deny",
            "message": f"Approval request failed: {str(e)}"
        }))


def request_approval(tool_name: str, tool_input: dict) -> dict:
    """承認サーバーに承認リクエストを送信する"""
    url = f"{APPROVAL_SERVER_URL}/approve"

    data = json.dumps({
        "tool_name": tool_name,
        "tool_input": tool_input
    }).encode('utf-8')

    headers = {
        'Content-Type': 'application/json'
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


if __name__ == '__main__':
    main()
