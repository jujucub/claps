/**
 * claps - アダプタレジストリ
 * チャネルアダプタの登録・ライフサイクル管理
 */

import type { TaskSource, HealthStatus, AdapterCallbacks } from '../types/index.js';
import type { ChannelAdapter } from './adapter.js';

/**
 * AdapterRegistry
 * 登録されたアダプタの初期化・起動・停止を管理する
 * 1つのアダプタの失敗が他に影響しないよう、エラーを隔離する
 */
export class AdapterRegistry {
  private readonly _adapters = new Map<TaskSource, ChannelAdapter>();
  private readonly _initializedAdapters = new Set<TaskSource>();
  private readonly _activeAdapters = new Set<TaskSource>();
  private _defaultSource: TaskSource | undefined;

  /**
   * アダプタを登録する
   * 最初に登録されたアダプタがデフォルトになる
   */
  register(adapter: ChannelAdapter): void {
    const source = adapter.getSource();
    if (this._adapters.has(source)) {
      throw new Error(`Adapter already registered for source: ${source}`);
    }
    this._adapters.set(source, adapter);

    if (!this._defaultSource) {
      this._defaultSource = source;
    }

    console.log(`Channel adapter registered: ${adapter.getName()} (${source})`);
  }

  /**
   * ソースタイプでアダプタを取得
   */
  getAdapter(source: TaskSource): ChannelAdapter | undefined {
    return this._adapters.get(source);
  }

  /**
   * デフォルトアダプタを取得（最初に登録されたもの）
   */
  getDefaultAdapter(): ChannelAdapter | undefined {
    if (!this._defaultSource) return undefined;
    return this._adapters.get(this._defaultSource);
  }

  /**
   * アクティブ（正常起動済み）なアダプタのみを取得
   */
  getActiveAdapters(): ChannelAdapter[] {
    const active: ChannelAdapter[] = [];
    for (const [source, adapter] of this._adapters) {
      if (this._activeAdapters.has(source)) {
        active.push(adapter);
      }
    }
    return active;
  }

  /**
   * 全アダプタを初期化する
   * 1つの失敗が他をブロックしない
   */
  async initAll(callbacks: AdapterCallbacks): Promise<void> {
    for (const [source, adapter] of this._adapters) {
      try {
        await adapter.init(callbacks);
        this._initializedAdapters.add(source);
        console.log(`Adapter initialized: ${adapter.getName()}`);
      } catch (error) {
        console.error(`Failed to initialize adapter ${adapter.getName()} (${source}):`, error);
      }
    }
  }

  /**
   * 全アダプタを起動する
   * 1つの失敗が他をブロックしない
   */
  async startAll(): Promise<void> {
    for (const [source, adapter] of this._adapters) {
      if (!this._initializedAdapters.has(source)) {
        console.warn(`Skipping start for adapter ${adapter.getName()} (${source}): not initialized`);
        continue;
      }
      try {
        await adapter.start();
        this._activeAdapters.add(source);
        console.log(`Adapter started: ${adapter.getName()}`);
      } catch (error) {
        console.error(`Failed to start adapter ${adapter.getName()} (${source}):`, error);
      }
    }
  }

  /**
   * 全アダプタを停止する
   */
  async stopAll(): Promise<void> {
    for (const [source, adapter] of this._adapters) {
      try {
        await adapter.stop();
        this._activeAdapters.delete(source);
        console.log(`Adapter stopped: ${adapter.getName()}`);
      } catch (error) {
        console.error(`Failed to stop adapter ${adapter.getName()} (${source}):`, error);
      }
    }
  }

  /**
   * 全アダプタの健全性を集約
   */
  getHealthAll(): Record<string, HealthStatus> {
    const health: Record<string, HealthStatus> = {};
    for (const [source, adapter] of this._adapters) {
      health[source] = adapter.getHealth();
    }
    return health;
  }
}
