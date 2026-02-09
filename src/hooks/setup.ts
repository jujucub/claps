/**
 * sumomo - グローバル Hook 設定管理
 * ユーザーレベルの ~/.claude/settings.json に PreToolUse Hook を注入する
 *
 * プロジェクトレベル（worktree内の .claude/settings.json）に加え、
 * ユーザーレベルにも hook を設定することで、新規プロジェクトの信頼問題
 * （Claude CLI が未知のプロジェクトの hook を読み込まない問題）を回避する
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { GetSumomoDir } from '../git/repo.js';

/**
 * グローバルな hook を設定する
 * 1. hook スクリプトを ~/.sumomo/hooks/ にコピー
 * 2. ~/.claude/settings.json に PreToolUse hook 設定を注入
 */
export function SetupGlobalHooks(): void {
  const sumomoHooksDir = path.join(GetSumomoDir(), 'hooks');

  // hookスクリプトを固定パスにコピー
  CopyHookScripts(sumomoHooksDir);

  // ユーザーレベルの settings.json にhook設定を注入
  InjectUserLevelHooks(sumomoHooksDir);
}

/**
 * hook スクリプトを ~/.sumomo/hooks/ にコピーする
 */
function CopyHookScripts(destDir: string): void {
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // dist/hooks/setup.js -> ../../.claude/hooks/
  const sumomoRoot = path.resolve(__dirname, '..', '..');
  const hookFiles = ['slack-approval.py', 'tool-notify.sh'];

  for (const hookFile of hookFiles) {
    const sourcePath = path.join(sumomoRoot, '.claude', 'hooks', hookFile);
    const destPath = path.join(destDir, hookFile);

    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, destPath);
      fs.chmodSync(destPath, 0o755);
    } else {
      console.warn(`Warning: ${hookFile} not found at ${sourcePath}`);
    }
  }

  console.log(`Hook scripts copied to ${destDir}`);
}

/**
 * ユーザーレベルの ~/.claude/settings.json にhook設定を注入する
 * 既存の設定はマージして保持する
 */
function InjectUserLevelHooks(hooksDir: string): void {
  const claudeDir = path.join(os.homedir(), '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');

  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  // 既存の settings.json を読み込む
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const content = fs.readFileSync(settingsPath, 'utf-8');
      settings = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // パースエラーの場合はそのまま進行
    }
  }

  // hooks.PreToolUse 配列を取得または作成
  if (!settings['hooks']) {
    settings['hooks'] = {};
  }
  const hooks = settings['hooks'] as Record<string, unknown>;

  if (!hooks['PreToolUse']) {
    hooks['PreToolUse'] = [];
  }
  const preToolUseHooks = hooks['PreToolUse'] as Array<Record<string, unknown>>;

  // 絶対パスでhookスクリプトを参照
  const approvalScriptPath = path.join(hooksDir, 'slack-approval.py');
  const notifyScriptPath = path.join(hooksDir, 'tool-notify.sh');

  // sumomo 承認 hook の更新または追加
  const approvalHookIndex = preToolUseHooks.findIndex((hook) => {
    const hookList = hook['hooks'] as Array<Record<string, unknown>> | undefined;
    return hookList?.some((h) => {
      const cmd = h['command'] as string | undefined;
      return cmd?.includes('slack-approval.py');
    });
  });

  const approvalHookConfig = {
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: `python3 "${approvalScriptPath}"`,
        timeout: 320,
      },
    ],
  };

  if (approvalHookIndex >= 0) {
    // 既存のhookを更新（パスやtimeoutが変わっている可能性）
    preToolUseHooks[approvalHookIndex] = approvalHookConfig;
  } else {
    // 先頭に追加（優先度を上げる）
    preToolUseHooks.unshift(approvalHookConfig);
  }

  // sumomo 通知 hook の更新または追加
  const notifyHookIndex = preToolUseHooks.findIndex((hook) => {
    const hookList = hook['hooks'] as Array<Record<string, unknown>> | undefined;
    return hookList?.some((h) => {
      const cmd = h['command'] as string | undefined;
      return cmd?.includes('tool-notify.sh');
    });
  });

  const notifyHookConfig = {
    matcher: '.*',
    hooks: [
      {
        type: 'command',
        command: `bash "${notifyScriptPath}"`,
        timeout: 5,
      },
    ],
  };

  if (notifyHookIndex >= 0) {
    preToolUseHooks[notifyHookIndex] = notifyHookConfig;
  } else {
    preToolUseHooks.push(notifyHookConfig);
  }

  // 書き出し
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log(`Injected sumomo hooks into ${settingsPath}`);
}
