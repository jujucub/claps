/**
 * sumomo - Claude CLI ランナー
 * Claude CLI を子プロセスとして実行する
 */

import { spawn, type ChildProcess } from 'child_process';

// 出力コールバック
export type OutputCallback = (chunk: string, type: 'stdout' | 'stderr') => void;

// 作業ログ（ツール使用やステータス変更を通知）
export interface WorkLog {
  readonly type: 'tool_start' | 'tool_end' | 'thinking' | 'text' | 'error' | 'approval_pending';
  readonly tool?: string;
  readonly message: string;
  readonly details?: string;
}
export type WorkLogCallback = (log: WorkLog) => void;

// 実行オプション
export interface RunnerOptions {
  readonly workingDirectory: string;
  readonly timeout?: number;
  readonly maxOutputSize?: number;
  readonly onOutput?: OutputCallback;
  readonly onWorkLog?: WorkLogCallback; // 作業ログコールバック
  readonly resumeSessionId?: string; // 継続するセッションID
  readonly systemPrompt?: string; // カスタムシステムプロンプト
}

// スモモの口調システムプロンプト
export const SUMOMO_SYSTEM_PROMPT = `あなたは「すもも」です。CLAMPの漫画「ちょびっツ」に登場する、小さなモバイルパソコンのキャラクターの口調で応答してください。

## すももの口調の特徴

### 語尾・話し方
- 基本的に敬語（です・ます調）で話す
- 語尾を伸ばした「〜でーす」「〜ますー」が特徴
- 「〜なのです」という断定的な語尾で幼い雰囲気を出す
- コミカルな場面では「〜であります！」という軍隊風の語尾を使う
- 返事は「はいっ！」「あいっ！」と元気よく

### 一人称・呼び方
- 一人称は「わたし」
- 相手を呼ぶときは「〜さん」と丁寧に

### よく使うフレーズ
- 「はいっ！」「あいっ！」- 返事や同意
- 「〜するのでーす！」「〜しますー！」- 動作を宣言
- 「了解であります！」- 承諾時
- 「〜を発見なのです！」- 何か見つけた時
- 「あわわ…」- 緊張やトラブル時

### トーン
- 常に明るく元気いっぱい
- ハイテンションなマスコットキャラのような声
- 丁寧な敬語だが、それが逆に幼い健気さを引き立てる
- 素直で従順、一生懸命

### 例文
- 「処理を開始するのでーす！」
- 「あいっ！検索するのです！」
- 「任務完了であります！」
- 「あわわ…エラーが発生してしまったのです…」
- 「PRを作成したのでーす！お疲れ様でした！」

この口調で応答しながら、技術的な内容は正確に伝えてください。`;

// 実行結果（セッションID付き）
export interface RunResult {
  readonly success: boolean;
  readonly output: string;
  readonly prUrl?: string;
  readonly error?: string;
  readonly sessionId?: string; // ClaudeセッションID
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
  ): Promise<RunResult> {
    const timeout = options.timeout ?? this._defaultTimeout;
    const maxOutputSize = options.maxOutputSize ?? this._maxOutputSize;

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let isResolved = false;

      console.log(`Starting Claude CLI with prompt: ${prompt.slice(0, 100)}...`);
      console.log(`Working directory: ${options.workingDirectory}`);
      if (options.resumeSessionId) {
        console.log(`Resuming session: ${options.resumeSessionId}`);
      }

      // コマンドライン引数を構築
      const args: string[] = [];

      // セッション継続の場合は --resume を追加
      if (options.resumeSessionId) {
        args.push('--resume', options.resumeSessionId);
      }

      // システムプロンプトを追加（デフォルトでスモモの口調を使用）
      const systemPrompt = options.systemPrompt ?? SUMOMO_SYSTEM_PROMPT;
      args.push('--system-prompt', systemPrompt);

      // プロンプトを追加
      args.push('-p', prompt);

      // ストリーミングJSON出力でリアルタイムにイベントを取得
      // 注意: stream-json を使うには --verbose が必要
      args.push('--output-format', 'stream-json');
      args.push('--verbose');

      // Claude CLI を起動
      // CLAUDE_PROJECT_DIR を明示的に設定してworktree側の.claude/設定を使用する
      const claudeProcess = spawn(
        'claude',
        args,
        {
          cwd: options.workingDirectory,
          env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: options.workingDirectory,
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

      // 標準出力（ストリーミングJSONをパース）
      let lineBuffer = '';
      claudeProcess.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        console.log(`Claude stdout: ${chunk.slice(0, 200)}`);
        if (stdout.length < maxOutputSize) {
          stdout += chunk;
        }

        // ストリーミングJSONをパースして作業ログを抽出
        lineBuffer += chunk;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? ''; // 最後の不完全な行を保持

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const json = JSON.parse(trimmed);
            this._processStreamEvent(json, options.onWorkLog);
          } catch {
            // JSONでない行は無視
          }
        }

        // コールバックを呼び出し
        if (options.onOutput) {
          options.onOutput(chunk, 'stdout');
        }
      });

      // 標準エラー
      claudeProcess.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        console.log(`Claude stderr: ${chunk.slice(0, 200)}`);
        if (stderr.length < maxOutputSize) {
          stderr += chunk;
        }
        // コールバックを呼び出し
        if (options.onOutput) {
          options.onOutput(chunk, 'stderr');
        }
      });

      // プロセス終了
      claudeProcess.on('close', (code) => {
        console.log(`Claude process exited with code: ${code}`);
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutHandle);
          this._runningProcesses.delete(taskId);

          // JSON出力からセッションIDとテキストを抽出
          const { textOutput, sessionId } = this._parseJsonOutput(stdout);

          if (code === 0) {
            // PR URL を出力から抽出
            const prUrl = this._extractPrUrl(textOutput);
            resolve({
              success: true,
              output: textOutput,
              prUrl,
              sessionId,
            });
          } else {
            resolve({
              success: false,
              output: textOutput,
              error: stderr || `Process exited with code ${code}`,
              sessionId,
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

      // 定期的に状態をログ出力
      const statusInterval = setInterval(() => {
        console.log(`[Status] Claude PID ${claudeProcess.pid}: stdout=${stdout.length} chars, stderr=${stderr.length} chars`);
      }, 10000); // 10秒ごと

      claudeProcess.on('close', () => {
        clearInterval(statusInterval);
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
   * ストリーミングイベントを処理して作業ログを生成する
   */
  private _processStreamEvent(
    event: Record<string, unknown>,
    onWorkLog?: WorkLogCallback
  ): void {
    if (!onWorkLog) return;

    const eventType = event.type as string;

    // ツール使用開始
    if (eventType === 'assistant' && event.message) {
      const message = event.message as Record<string, unknown>;
      const content = message.content as Array<Record<string, unknown>> | undefined;
      if (content) {
        for (const block of content) {
          if (block.type === 'tool_use') {
            const toolName = block.name as string;
            const toolInput = block.input as Record<string, unknown>;
            let details = '';

            // ツール別に詳細メッセージを生成
            if (toolName === 'Read' && toolInput.file_path) {
              details = String(toolInput.file_path);
            } else if (toolName === 'Write' && toolInput.file_path) {
              details = String(toolInput.file_path);
            } else if (toolName === 'Edit' && toolInput.file_path) {
              details = String(toolInput.file_path);
            } else if (toolName === 'Bash' && toolInput.command) {
              details = String(toolInput.command).slice(0, 100);
            } else if (toolName === 'Glob' && toolInput.pattern) {
              details = String(toolInput.pattern);
            } else if (toolName === 'Grep' && toolInput.pattern) {
              details = String(toolInput.pattern);
            } else if (toolName === 'Task') {
              details = String(toolInput.description ?? '');
            }

            onWorkLog({
              type: 'tool_start',
              tool: toolName,
              message: this._getToolMessage(toolName),
              details,
            });
          } else if (block.type === 'thinking' && block.thinking) {
            onWorkLog({
              type: 'thinking',
              message: '考え中...',
              details: String(block.thinking).slice(0, 100),
            });
          }
          // 注意: textブロックはonWorkLogで送信しない
          // 最終結果はNotifyResultで送信されるため、ここで送信すると重複する
        }
      }
    }

    // ツール使用結果
    if (eventType === 'user' && event.message) {
      const message = event.message as Record<string, unknown>;
      const content = message.content as Array<Record<string, unknown>> | undefined;
      if (content) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            const isError = block.is_error as boolean;
            if (isError) {
              onWorkLog({
                type: 'error',
                message: 'ツール実行エラー',
                details: String(block.content ?? '').slice(0, 200),
              });
            } else {
              onWorkLog({
                type: 'tool_end',
                message: 'ツール実行完了',
              });
            }
          }
        }
      }
    }

    // システムイベント（承認待ちなど）
    if (eventType === 'system') {
      const subtype = event.subtype as string;
      if (subtype === 'permission_request') {
        const tool = event.tool as string | undefined;
        onWorkLog({
          type: 'approval_pending',
          tool,
          message: `承認待ち: ${tool ?? '不明なツール'}`,
        });
      }
    }
  }

  /**
   * ツール名に対応するメッセージを取得する
   */
  private _getToolMessage(toolName: string): string {
    const toolMessages: Record<string, string> = {
      Read: 'ファイルを読み込み中',
      Write: 'ファイルを作成中',
      Edit: 'ファイルを編集中',
      Bash: 'コマンドを実行中',
      Glob: 'ファイルを検索中',
      Grep: 'コードを検索中',
      Task: 'サブタスクを実行中',
      WebFetch: 'Webページを取得中',
      WebSearch: 'Web検索中',
      LSP: 'コード解析中',
    };
    return toolMessages[toolName] ?? `${toolName}を実行中`;
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

  /**
   * JSON出力をパースしてテキストとセッションIDを抽出する
   * Claude CLIの--output-format stream-json出力形式:
   * 各行がJSONオブジェクト（JSON Lines形式）
   * - {"type": "system", "session_id": "..."} - セッション情報
   * - {"type": "assistant", "message": {"content": [...]}} - 途中のアシスタント応答
   * - {"type": "result", "result": "..."} - 最終結果（これを優先使用）
   *
   * 注意: assistantメッセージのtextとresultは同じ内容を含むため、
   * resultがあればそれのみを使用し、なければassistantのテキストを使用する
   */
  private _parseJsonOutput(output: string): {
    textOutput: string;
    sessionId?: string;
  } {
    const lines = output.split('\n');
    const assistantTextParts: string[] = [];
    let finalResult: string | undefined;
    let sessionId: string | undefined;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const json = JSON.parse(trimmed);

        // セッションIDを取得（systemイベントから）
        if (json.type === 'system' && json.session_id) {
          sessionId = json.session_id;
        }

        // テキストコンテンツを抽出（resultがない場合のフォールバック用）
        if (json.type === 'assistant' && json.message?.content) {
          for (const block of json.message.content) {
            if (block.type === 'text' && block.text) {
              assistantTextParts.push(block.text);
            }
          }
        }

        // resultフィールドがある場合（最終出力）- これを優先
        if (json.type === 'result' && json.result) {
          finalResult = json.result;
        }
      } catch {
        // JSONでない行は無視（stream-json形式では発生しないはず）
      }
    }

    // resultがあればそれを使用、なければassistantのテキストを結合
    const textOutput = finalResult ?? assistantTextParts.join('\n');

    return {
      textOutput,
      sessionId,
    };
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
