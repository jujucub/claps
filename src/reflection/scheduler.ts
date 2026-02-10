/**
 * sumomo - 内省スケジューラ
 * setTimeoutベースで毎日定時に内省を実行する
 */

import type { Config, ReflectionConfig, ReflectionResult } from '../types/index.js';
import { RunReflection } from './engine.js';

// スケジューラの状態
let _timer: ReturnType<typeof setTimeout> | undefined;
let _config: Config | undefined;
let _onReflectionComplete: ((result: ReflectionResult) => Promise<void>) | undefined;

/**
 * 次回実行時刻までのミリ秒を計算する
 */
function CalculateNextRunMs(schedule: string, timezone: string): number {
  const [hoursStr, minutesStr] = schedule.split(':');
  const targetHour = parseInt(hoursStr ?? '9', 10);
  const targetMinute = parseInt(minutesStr ?? '0', 10);

  // 現在時刻を対象タイムゾーンで取得
  const now = new Date();
  const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: timezone }));

  // 今日の実行時刻を計算
  const todayRun = new Date(nowInTz);
  todayRun.setHours(targetHour, targetMinute, 0, 0);

  // 今日の実行時刻を過ぎていれば明日にスケジュール
  let nextRun: Date;
  if (nowInTz.getTime() >= todayRun.getTime()) {
    nextRun = new Date(todayRun);
    nextRun.setDate(nextRun.getDate() + 1);
  } else {
    nextRun = todayRun;
  }

  // 差分を計算（タイムゾーン補正: 実際のDateオブジェクトとの差を考慮）
  const tzOffsetMs = now.getTime() - nowInTz.getTime();
  const nextRunActual = new Date(nextRun.getTime() + tzOffsetMs);
  const delayMs = nextRunActual.getTime() - now.getTime();

  return Math.max(delayMs, 1000); // 最低1秒
}

/**
 * 平日かどうかを判定する
 */
function IsWeekday(timezone: string): boolean {
  const now = new Date();
  const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
  const day = nowInTz.getDay();
  return day >= 1 && day <= 5;
}

/**
 * 内省実行のメインループ
 */
async function ExecuteReflection(): Promise<void> {
  if (!_config) return;

  const reflectionConfig = _config.reflectionConfig;

  // 平日のみ実行
  if (!IsWeekday(reflectionConfig.timezone)) {
    console.log('Reflection scheduler: Skipping (weekend)');
    ScheduleNext();
    return;
  }

  console.log('Reflection scheduler: Executing daily reflection...');

  try {
    const result = await RunReflection(
      reflectionConfig,
      _config.githubRepos,
      _config.approvalServerPort
    );

    if (result && _onReflectionComplete) {
      await _onReflectionComplete(result);
    }
  } catch (error) {
    console.error('Reflection scheduler: Execution failed:', error);
  }

  // 翌日をスケジュール
  ScheduleNext();
}

/**
 * 次回実行をスケジュールする
 */
function ScheduleNext(): void {
  if (!_config) return;

  const reflectionConfig = _config.reflectionConfig;
  const delayMs = CalculateNextRunMs(reflectionConfig.schedule, reflectionConfig.timezone);
  const nextRunDate = new Date(Date.now() + delayMs);

  console.log(`Reflection scheduler: Next run at ${nextRunDate.toISOString()} (in ${Math.round(delayMs / 60000)} minutes)`);

  _timer = setTimeout(() => {
    void ExecuteReflection();
  }, delayMs);
}

/**
 * スケジューラを初期化する
 */
export function InitReflectionScheduler(
  config: Config,
  onReflectionComplete: (result: ReflectionResult) => Promise<void>
): void {
  _config = config;
  _onReflectionComplete = onReflectionComplete;
}

/**
 * スケジューラを開始する
 */
export function StartReflectionScheduler(): void {
  if (!_config) {
    console.error('Reflection scheduler: Not initialized');
    return;
  }

  if (!_config.reflectionConfig.enabled) {
    console.log('Reflection scheduler: Disabled');
    return;
  }

  console.log(`Reflection scheduler: Starting (schedule: ${_config.reflectionConfig.schedule} ${_config.reflectionConfig.timezone})`);
  ScheduleNext();
}

/**
 * スケジューラを停止する
 */
export function StopReflectionScheduler(): void {
  if (_timer) {
    clearTimeout(_timer);
    _timer = undefined;
    console.log('Reflection scheduler: Stopped');
  }
}

/**
 * 手動で内省を実行する
 */
export async function RunReflectionManually(): Promise<ReflectionResult | undefined> {
  if (!_config) {
    console.error('Reflection scheduler: Not initialized');
    return undefined;
  }

  const result = await RunReflection(
    _config.reflectionConfig,
    _config.githubRepos,
    _config.approvalServerPort
  );

  if (result && _onReflectionComplete) {
    await _onReflectionComplete(result);
  }

  return result;
}

/**
 * 内省設定を動的に更新する
 */
export function UpdateReflectionConfig(updates: Partial<ReflectionConfig>): void {
  if (!_config) return;

  _config = {
    ..._config,
    reflectionConfig: {
      ..._config.reflectionConfig,
      ...updates,
    },
  };

  // スケジューラを再起動
  StopReflectionScheduler();
  StartReflectionScheduler();
}

/**
 * 現在の設定を取得する
 */
export function GetReflectionConfig(): ReflectionConfig | undefined {
  return _config?.reflectionConfig;
}
