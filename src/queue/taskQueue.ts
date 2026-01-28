/**
 * sumomo - タスクキュー管理
 * GitHub Issue と Slack からのタスクを管理するキューシステム
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  Task,
  TaskSource,
  TaskStatus,
  TaskMetadata,
  TaskResult,
} from '../types/index.js';

// イベントリスナーの型定義
type TaskEventType = 'added' | 'started' | 'completed' | 'failed';
type TaskEventListener = (task: Task) => void;

/**
 * タスクキュークラス
 * イミュータブルな設計でタスクを管理する
 */
export class TaskQueue {
  private _tasks: Map<string, Task>;
  private _listeners: Map<TaskEventType, Set<TaskEventListener>>;

  constructor() {
    this._tasks = new Map();
    this._listeners = new Map();
  }

  /**
   * 新しいタスクをキューに追加する
   */
  AddTask(
    source: TaskSource,
    prompt: string,
    metadata: TaskMetadata
  ): Task {
    const task: Task = {
      id: uuidv4(),
      source,
      createdAt: new Date(),
      prompt,
      metadata,
      status: 'pending',
    };

    this._tasks.set(task.id, task);
    this._emitEvent('added', task);

    return task;
  }

  /**
   * 次の保留中タスクを取得し、実行中に変更する
   */
  GetNextTask(): Task | undefined {
    for (const task of this._tasks.values()) {
      if (task.status === 'pending') {
        const updatedTask: Task = {
          ...task,
          status: 'running',
          startedAt: new Date(),
        };
        this._tasks.set(task.id, updatedTask);
        this._emitEvent('started', updatedTask);
        return updatedTask;
      }
    }
    return undefined;
  }

  /**
   * タスクを完了としてマークする
   */
  CompleteTask(taskId: string, result: TaskResult): Task | undefined {
    const task = this._tasks.get(taskId);
    if (!task) {
      return undefined;
    }

    const status: TaskStatus = result.success ? 'completed' : 'failed';
    const updatedTask: Task = {
      ...task,
      status,
      completedAt: new Date(),
      result,
    };

    this._tasks.set(taskId, updatedTask);
    this._emitEvent(result.success ? 'completed' : 'failed', updatedTask);

    return updatedTask;
  }

  /**
   * タスクIDでタスクを取得する
   */
  GetTask(taskId: string): Task | undefined {
    return this._tasks.get(taskId);
  }

  /**
   * 特定ステータスのタスク一覧を取得する
   */
  GetTasksByStatus(status: TaskStatus): readonly Task[] {
    return Array.from(this._tasks.values()).filter(
      (task) => task.status === status
    );
  }

  /**
   * 全タスク一覧を取得する
   */
  GetAllTasks(): readonly Task[] {
    return Array.from(this._tasks.values());
  }

  /**
   * 保留中タスクの数を取得する
   */
  GetPendingCount(): number {
    return this.GetTasksByStatus('pending').length;
  }

  /**
   * 実行中タスクの数を取得する
   */
  GetRunningCount(): number {
    return this.GetTasksByStatus('running').length;
  }

  /**
   * GitHub Issue が既に処理済みかどうかを確認する
   */
  IsIssueProcessed(owner: string, repo: string, issueNumber: number): boolean {
    for (const task of this._tasks.values()) {
      if (task.metadata.source === 'github') {
        const meta = task.metadata;
        if (
          meta.owner === owner &&
          meta.repo === repo &&
          meta.issueNumber === issueNumber
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * イベントリスナーを登録する
   */
  On(event: TaskEventType, listener: TaskEventListener): void {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event)!.add(listener);
  }

  /**
   * イベントリスナーを解除する
   */
  Off(event: TaskEventType, listener: TaskEventListener): void {
    const listeners = this._listeners.get(event);
    if (listeners) {
      listeners.delete(listener);
    }
  }

  /**
   * イベントを発火する
   */
  private _emitEvent(event: TaskEventType, task: Task): void {
    const listeners = this._listeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(task);
        } catch (error) {
          console.error(`Task event listener error (${event}):`, error);
        }
      }
    }
  }
}

// シングルトンインスタンス
let _instance: TaskQueue | undefined;

/**
 * タスクキューのシングルトンインスタンスを取得する
 */
export function GetTaskQueue(): TaskQueue {
  if (!_instance) {
    _instance = new TaskQueue();
  }
  return _instance;
}
