/**
 * sumomo - MCP (Model Context Protocol) 設定管理
 * ~/.claude.json にMCPサーバー設定を追加する
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface McpServerConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Record<string, string>;
}

interface ClaudeConfig {
  mcpServers?: Record<string, McpServerConfig>;
  [key: string]: unknown;
}

/**
 * グローバルな~/.claude.jsonにsumomo用のMCPサーバー設定を追加する
 * 既存の設定はマージして保持する
 */
export function SetupGlobalMcpConfig(): void {
  const configPath = path.join(os.homedir(), '.claude.json');

  // 既存の設定を読み込む
  let config: ClaudeConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      config = JSON.parse(content) as ClaudeConfig;
      console.log('📋 既存の ~/.claude.json を検出しました');
    } catch (error) {
      console.warn('⚠️ ~/.claude.json のパースに失敗、新規作成します');
    }
  }

  // 既存のmcpServersを保持
  const existingMcpServers = config.mcpServers ?? {};

  // sumomo用のMCPサーバーを追加（プレフィックスで衝突回避）
  const sumomoMcpServers: Record<string, McpServerConfig> = {};

  // GitHub MCP Server（GITHUB_TOKENが設定されている場合のみ）
  if (process.env['GITHUB_TOKEN']) {
    sumomoMcpServers['sumomo-github'] = {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: process.env['GITHUB_TOKEN'],
      },
    };
    console.log('✅ sumomo-github MCP Server を設定しました');
  } else {
    console.log('⏭️ GITHUB_TOKEN が未設定のため sumomo-github をスキップ');
  }

  // Slack MCP Server（SLACK_BOT_TOKENとSLACK_TEAM_IDが両方設定されている場合のみ）
  if (process.env['SLACK_BOT_TOKEN'] && process.env['SLACK_TEAM_ID']) {
    sumomoMcpServers['sumomo-slack'] = {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-slack'],
      env: {
        SLACK_BOT_TOKEN: process.env['SLACK_BOT_TOKEN'],
        SLACK_TEAM_ID: process.env['SLACK_TEAM_ID'],
      },
    };
    console.log('✅ sumomo-slack MCP Server を設定しました');
  } else {
    const missing: string[] = [];
    if (!process.env['SLACK_BOT_TOKEN']) missing.push('SLACK_BOT_TOKEN');
    if (!process.env['SLACK_TEAM_ID']) missing.push('SLACK_TEAM_ID');
    console.log(`⏭️ ${missing.join(', ')} が未設定のため sumomo-slack をスキップ`);
  }

  // 設定をマージ（既存のsumomo-*は上書き、それ以外は保持）
  const mergedMcpServers: Record<string, McpServerConfig> = {};

  // 既存の非sumomo設定を保持
  for (const [key, value] of Object.entries(existingMcpServers)) {
    if (!key.startsWith('sumomo-')) {
      mergedMcpServers[key] = value;
    }
  }

  // sumomo設定を追加
  for (const [key, value] of Object.entries(sumomoMcpServers)) {
    mergedMcpServers[key] = value;
  }

  // 設定を更新
  config.mcpServers = mergedMcpServers;

  // ファイルに書き出し
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`📝 MCP設定を保存しました: ${configPath}`);
}

/**
 * sumomo用のMCPサーバー設定を削除する
 * （アンインストール時などに使用）
 */
export function RemoveSumomoMcpConfig(): void {
  const configPath = path.join(os.homedir(), '.claude.json');

  if (!fs.existsSync(configPath)) {
    return;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content) as ClaudeConfig;

    if (!config.mcpServers) {
      return;
    }

    // sumomo-*の設定を削除
    const filteredMcpServers: Record<string, McpServerConfig> = {};
    for (const [key, value] of Object.entries(config.mcpServers)) {
      if (!key.startsWith('sumomo-')) {
        filteredMcpServers[key] = value;
      }
    }

    config.mcpServers = filteredMcpServers;

    // mcpServersが空になったら削除
    if (Object.keys(config.mcpServers).length === 0) {
      delete config.mcpServers;
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    console.log('🗑️ sumomo用のMCP設定を削除しました');
  } catch (error) {
    console.error('MCP設定の削除に失敗:', error);
  }
}

/**
 * 現在のMCP設定状態を確認する
 */
export function GetMcpConfigStatus(): {
  configExists: boolean;
  sumomoGithub: boolean;
  sumomoSlack: boolean;
  otherServers: readonly string[];
} {
  const configPath = path.join(os.homedir(), '.claude.json');

  if (!fs.existsSync(configPath)) {
    return {
      configExists: false,
      sumomoGithub: false,
      sumomoSlack: false,
      otherServers: [],
    };
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content) as ClaudeConfig;
    const mcpServers = config.mcpServers ?? {};

    const otherServers = Object.keys(mcpServers).filter(
      (key) => !key.startsWith('sumomo-')
    );

    return {
      configExists: true,
      sumomoGithub: 'sumomo-github' in mcpServers,
      sumomoSlack: 'sumomo-slack' in mcpServers,
      otherServers,
    };
  } catch {
    return {
      configExists: true,
      sumomoGithub: false,
      sumomoSlack: false,
      otherServers: [],
    };
  }
}
