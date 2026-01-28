/**
 * sumomo - Claude CLI ランナー
 * Claude CLI を子プロセスとして実行する
 */

import { spawn, type ChildProcess } from 'child_process';
import type { TaskResult } from '../types/index.js';

// 実行オプション
export interface RunnerOptions {
  readonly workingDirectory: string;
  readonly timeout?: number;
  readonly maxOutputSize?: number;
}

// 実行中のプロセス管理
interface RunningProcess {
  readonly taskId: string;
  readonly process: ChildProcess;
  readonly startedAt: Date;
}

/**
 * Claude CLI ランナークラス
 */
export class ClaudeRunner {
  private _runningProcesses: Map<string, RunningProcess>;
  private readonly _defaultTimeout: number;
  private readonly _maxOutputSize: number;

  constructor() {
    this._runningProcesses = new Map();
    this._defaultTimeout = 600000; // 10分
    this._maxOutputSize = 1024 * 1024; // 1MB
  }

  /**
   * Claude CLI を実行する
   */
  async Run(
    taskId: string,
    prompt: string,
    options: RunnerOptions
  ): Promise<TaskResult> {
    const timeout = options.timeout ?? this._defaultTimeout;
    const maxOutputSize = options.maxOutputSize ?? this._maxOutputSize;

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let isResolved = false;

      // Claude CLI を起動
      const claudeProcess = spawn('claude', ['--print', prompt], {
        cwd: options.workingDirectory,
        env: {
          ...process.env,
          // Claude CLI に必要な環境変数を継承
        },
        shell: true,
      });

      // 実行中プロセスとして登録
      this._runningProcesses.set(taskId, {
        taskId,
        process: claudeProcess,
        startedAt: new Date(),
      });

      // タイムアウト設定
      const timeoutHandle = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          this._killProcess(taskId);
          resolve({
            success: false,
            output: stdout,
            error: `Timeout after ${timeout}ms`,
          });
        }
      }, timeout);

      // 標準出力
      claudeProcess.stdout?.on('data', (data: Buffer) => {
        if (stdout.length < maxOutputSize) {
          stdout += data.toString();
        }
      });

      // 標準エラー
      claudeProcess.stderr?.on('data', (data: Buffer) => {
        if (stderr.length < maxOutputSize) {
          stderr += data.toString();
        }
      });

      // プロセス終了
      claudeProcess.on('close', (code) => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutHandle);
          this._runningProcesses.delete(taskId);

          if (code === 0) {
            // PR URL を出力から抽出
            const prUrl = this._extractPrUrl(stdout);
            resolve({
              success: true,
              output: stdout,
              prUrl,
            });
          } else {
            resolve({
              success: false,
              output: stdout,
              error: stderr || `Process exited with code ${code}`,
            });
          }
        }
      });

      // エラー
      claudeProcess.on('error', (error) => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutHandle);
          this._runningProcesses.delete(taskId);
          resolve({
            success: false,
            output: stdout,
            error: error.message,
          });
        }
      });
    });
  }

  /**
   * 対話モードで Claude CLI を実行する（継続的な入出力用）
   */
  StartInteractive(
    taskId: string,
    options: RunnerOptions
  ): {
    process: ChildProcess;
    sendInput: (input: string) => void;
    stop: () => void;
  } {
    const claudeProcess = spawn('claude', [], {
      cwd: options.workingDirectory,
      env: process.env,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._runningProcesses.set(taskId, {
      taskId,
      process: claudeProcess,
      startedAt: new Date(),
    });

    return {
      process: claudeProcess,
      sendInput: (input: string) => {
        claudeProcess.stdin?.write(input + '\n');
      },
      stop: () => {
        this._killProcess(taskId);
      },
    };
  }

  /**
   * 実行中のプロセスを停止する
   */
  Stop(taskId: string): boolean {
    return this._killProcess(taskId);
  }

  /**
   * 実行中のタスク一覧を取得する
   */
  GetRunningTasks(): readonly string[] {
    return Array.from(this._runningProcesses.keys());
  }

  /**
   * タスクが実行中かどうかを確認する
   */
  IsRunning(taskId: string): boolean {
    return this._runningProcesses.has(taskId);
  }

  /**
   * プロセスを強制終了する
   */
  private _killProcess(taskId: string): boolean {
    const running = this._runningProcesses.get(taskId);
    if (running) {
      running.process.kill('SIGTERM');
      this._runningProcesses.delete(taskId);
      return true;
    }
    return false;
  }

  /**
   * 出力から PR URL を抽出する
   */
  private _extractPrUrl(output: string): string | undefined {
    // GitHub PR URL パターン
    const prUrlPattern = /https:\/\/github\.com\/[^\/]+\/[^\/]+\/pull\/\d+/;
    const match = output.match(prUrlPattern);
    return match ? match[0] : undefined;
  }
}

// シングルトンインスタンス
let _instance: ClaudeRunner | undefined;

/**
 * Claude ランナーのシングルトンインスタンスを取得する
 */
export function GetClaudeRunner(): ClaudeRunner {
  if (!_instance) {
    _instance = new ClaudeRunner();
  }
  return _instance;
}
