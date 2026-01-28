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

      console.log(`Starting Claude CLI with prompt: ${prompt.slice(0, 100)}...`);
      console.log(`Working directory: ${options.workingDirectory}`);

      // Claude CLI を起動（-p オプションで非対話モード）
      const claudeProcess = spawn(
        'claude',
        ['-p', '--output-format', 'text', prompt],
        {
          cwd: options.workingDirectory,
          env: {
            ...process.env,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
        }
      );

      console.log(`Claude process spawned with PID: ${claudeProcess.pid}`);

      // spawn エラーをすぐにキャッチ
      claudeProcess.on('spawn', () => {
        console.log('Claude process spawn event fired');
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
        const chunk = data.toString();
        console.log(`Claude stdout: ${chunk.slice(0, 200)}`);
        if (stdout.length < maxOutputSize) {
          stdout += chunk;
        }
      });

      // 標準エラー
      claudeProcess.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        console.log(`Claude stderr: ${chunk.slice(0, 200)}`);
        if (stderr.length < maxOutputSize) {
          stderr += chunk;
        }
      });

      // プロセス終了
      claudeProcess.on('close', (code) => {
        console.log(`Claude process exited with code: ${code}`);
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
        console.log(`Claude process error: ${error.message}`);
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

      // stdin/stdout/stderr の接続確認
      console.log(`stdout connected: ${!!claudeProcess.stdout}`);
      console.log(`stderr connected: ${!!claudeProcess.stderr}`);

      // 重要: stdin を閉じないと Claude CLI が入力待ちでブロックする
      claudeProcess.stdin?.end();
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
