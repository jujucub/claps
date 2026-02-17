/**
 * claps - HTTP REST API ルート (M5 Stack 等のデバイス向け)
 * contracts/http-api.md に基づく実装
 */

import { Router, type Request, type Response } from 'express';
import type { AdapterRegistry } from '../channel/registry.js';

// HTTP アダプタへの参照取得用コールバック
export interface HttpRoutesDeps {
  /** タスク状態を取得する */
  readonly getTaskState: (taskId: string) => PendingTaskState | undefined;
  /** 新規メッセージを処理する */
  readonly onMessage: (message: string, deviceId: string | undefined, targetRepo: string | undefined) => string;
  /** 承認応答を処理する */
  readonly onApprovalResponse: (taskId: string, requestId: string, decision: 'allow' | 'deny', comment?: string) => boolean;
  /** 質問応答を処理する */
  readonly onAnswerResponse: (taskId: string, requestId: string, answer: string) => boolean;
  /** アダプタレジストリ（ヘルスチェック用） */
  readonly registry: AdapterRegistry;
  /** Bearer token 検証 */
  readonly validateToken: (token: string) => boolean;
  /** デバイスID がホワイトリストに含まれるか */
  readonly isDeviceAllowed: (deviceId: string | undefined) => boolean;
}

/**
 * タスクの状態（ポーリング用の in-memory 状態管理）
 */
export type HttpTaskStatus = 'queued' | 'processing' | 'awaiting_approval' | 'awaiting_answer' | 'completed' | 'failed';

export interface PendingApprovalInfo {
  readonly type: 'approval';
  readonly id: string;
  readonly tool: string;
  readonly command: string;
  readonly timestamp: string;
}

export interface PendingQuestionInfo {
  readonly type: 'question';
  readonly id: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly timestamp: string;
}

export interface PendingTaskState {
  readonly taskId: string;
  status: HttpTaskStatus;
  result?: {
    readonly success: boolean;
    readonly output: string;
    readonly prUrl?: string;
    readonly error?: string;
  };
  pending?: PendingApprovalInfo | PendingQuestionInfo | null;
  progressMessages: string[];
}

/**
 * HTTP API Express Router を作成する
 */
export function CreateHttpApiRouter(deps: HttpRoutesDeps): Router {
  const router = Router();

  // Bearer token 認証ミドルウェア
  router.use((req: Request, res: Response, next) => {
    // ヘルスチェックは認証不要
    if (req.path === '/health') {
      next();
      return;
    }

    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

    if (!token || !deps.validateToken(token)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    next();
  });

  // POST /api/v1/messages - タスク起動
  router.post('/messages', (req: Request, res: Response) => {
    const { message, deviceId, targetRepo } = req.body as {
      message?: string;
      deviceId?: string;
      targetRepo?: string;
    };

    if (!message || message.trim() === '') {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    // デバイス認可チェック
    if (!deps.isDeviceAllowed(deviceId)) {
      res.status(403).json({ error: 'Device not allowed' });
      return;
    }

    const taskId = deps.onMessage(message, deviceId, targetRepo);

    res.status(202).json({
      taskId,
      status: 'queued',
      pollUrl: `/api/v1/tasks/${taskId}`,
    });
  });

  // GET /api/v1/tasks/:taskId - タスク状態取得（ポーリング）
  router.get('/tasks/:taskId', (req: Request, res: Response) => {
    const taskId = req.params['taskId'] as string;
    const state = deps.getTaskState(taskId);

    if (!state) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    res.json({
      taskId: state.taskId,
      status: state.status,
      result: state.result ?? null,
      pending: state.pending ?? null,
    });
  });

  // POST /api/v1/tasks/:taskId/approve - 承認応答
  router.post('/tasks/:taskId/approve', (req: Request, res: Response) => {
    const taskId = req.params['taskId'] as string;
    const { requestId, decision, comment } = req.body as {
      requestId?: string;
      decision?: string;
      comment?: string;
    };

    if (!requestId || !decision || (decision !== 'allow' && decision !== 'deny')) {
      res.status(400).json({ error: 'requestId and decision (allow/deny) are required' });
      return;
    }

    const accepted = deps.onApprovalResponse(taskId, requestId, decision, comment);
    if (!accepted) {
      res.status(404).json({ error: 'Approval request not found or expired' });
      return;
    }

    res.json({ requestId, decision, accepted: true });
  });

  // POST /api/v1/tasks/:taskId/answer - 質問応答
  router.post('/tasks/:taskId/answer', (req: Request, res: Response) => {
    const taskId = req.params['taskId'] as string;
    const { requestId, answer } = req.body as {
      requestId?: string;
      answer?: string;
    };

    if (!requestId || !answer) {
      res.status(400).json({ error: 'requestId and answer are required' });
      return;
    }

    const accepted = deps.onAnswerResponse(taskId, requestId, answer);
    if (!accepted) {
      res.status(404).json({ error: 'Question request not found or expired' });
      return;
    }

    res.json({ requestId, answer, accepted: true });
  });

  // GET /api/v1/health - ヘルスチェック
  router.get('/health', (_req: Request, res: Response) => {
    const healthAll = deps.registry.getHealthAll();
    const channels: Record<string, string> = {};
    for (const [source, health] of Object.entries(healthAll)) {
      channels[source] = health.status;
    }

    res.json({
      status: 'healthy',
      channels,
    });
  });

  return router;
}
