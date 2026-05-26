import type { WebSocket } from 'ws';
import type { ContextRef, Message, SessionInteractionState } from '../../types.js';
import type { ActiveRunState } from './web-server-runtime-contracts.js';
import type { ChatRequest, TextAskRequest, TextHistoryRequest, WSMessage } from './web-server-shared.js';
import { buildShareTextHistory, normalizeShareTextTurns } from './share-text-protocol.js';
import type { WebSocketAccessScope } from './websocket-access-controller.js';

interface SendFileToUserLink {
  href: string;
  displayPath: string;
  filename: string;
  size?: number;
  expiresAt?: string;
}

export interface ShareTextSocketProtocolOptions {
  emit: (ws: WebSocket, message: WSMessage) => void;
  getContextMessages: (context: ContextRef) => Message[];
  canAccessContext: (ws: WebSocket, context: ContextRef) => boolean;
  getActiveRunState: (context: ContextRef) => ActiveRunState | null;
  getActiveRunStateForSocket: (ws: WebSocket, context: ContextRef) => ActiveRunState | null;
  resolveInteractionStateForSocket: (ws: WebSocket, context: ContextRef) => SessionInteractionState;
  handleChat: (ws: WebSocket, request: ChatRequest) => Promise<void>;
}

export class ShareTextSocketProtocol {
  private readonly options: ShareTextSocketProtocolOptions;

  constructor(options: ShareTextSocketProtocolOptions) {
    this.options = options;
  }

  messageForSocket(
    scope: Extract<WebSocketAccessScope, { mode: 'shared_ls' }>,
    context: ContextRef,
    message: WSMessage
  ): WSMessage | null {
    if (context.scope !== 'session' || context.namespace !== scope.sessionId) {
      return null;
    }
    const data = message.data && typeof message.data === 'object' && !Array.isArray(message.data)
      ? (message.data as Record<string, unknown>)
      : {};
    const runId = typeof data.runId === 'string' ? data.runId : undefined;
    if (message.type === 'message') {
      if (data.role !== 'assistant') {
        return null;
      }
      const content = typeof data.content === 'string' ? data.content : '';
      if (!content) {
        return null;
      }
      return {
        type: 'text_delta',
        data: {
          ...(runId ? { runId } : {}),
          sessionId: scope.sessionId,
          content,
        },
      };
    }
    if (message.type === 'complete') {
      const content = typeof data.content === 'string' ? data.content : '';
      return {
        type: 'done',
        data: {
          ...(runId ? { runId } : {}),
          sessionId: scope.sessionId,
          content,
        },
      };
    }
    if (message.type === 'tool_result' && data.name === 'send_file_to_user') {
      const result = data.result && typeof data.result === 'object' && !Array.isArray(data.result)
        ? (data.result as Record<string, unknown>)
        : null;
      if (result?.success !== true || typeof result.content !== 'string') {
        return null;
      }
      const link = this.parseSendFileToUserLink(result.content);
      if (!link) {
        return null;
      }
      return {
        type: 'file_link',
        data: {
          ...(runId ? { runId } : {}),
          sessionId: scope.sessionId,
          ...this.withShareTokenOnFileLink(link, scope.shareToken),
        },
      };
    }
    if (message.type === 'error' || message.type === 'server_error') {
      return {
        type: 'error',
        data: {
          code: String(data.code ?? data.error ?? 'RUN_ERROR'),
          message: String(data.message ?? data.error ?? 'DPAgent run failed.'),
          ...(runId ? { runId } : {}),
          sessionId: scope.sessionId,
        },
      };
    }
    return null;
  }

  handleHistory(ws: WebSocket, scope: Extract<WebSocketAccessScope, { mode: 'shared_ls' }>, request: TextHistoryRequest): void {
    const context: ContextRef = { scope: 'session', namespace: scope.sessionId };
    if (!this.options.canAccessContext(ws, context)) {
      this.options.emit(ws, {
        type: 'error',
        data: {
          code: 'SHARE_SCOPE_FORBIDDEN',
          message: 'This shared link can only access its bound session.',
        },
      });
      return;
    }
    const turns = normalizeShareTextTurns(request.turns, 3);
    this.options.emit(ws, {
      type: 'history',
      data: {
        sessionId: scope.sessionId,
        turns,
        messages: buildShareTextHistory(this.options.getContextMessages(context), turns),
      },
    });
  }

  async handleAsk(ws: WebSocket, scope: Extract<WebSocketAccessScope, { mode: 'shared_ls' }>, request: TextAskRequest): Promise<void> {
    const text = String(request.text ?? '').trim();
    if (!text) {
      this.options.emit(ws, {
        type: 'error',
        data: {
          code: 'TEXT_REQUIRED',
          message: 'Text ask requires non-empty text.',
        },
      });
      return;
    }
    const context: ContextRef = { scope: 'session', namespace: scope.sessionId };
    if (!this.options.canAccessContext(ws, context)) {
      this.options.emit(ws, {
        type: 'error',
        data: {
          code: 'SHARE_SCOPE_FORBIDDEN',
          message: 'This shared link can only access its bound session.',
        },
      });
      return;
    }
    const active = this.options.getActiveRunState(context);
    if (active) {
      const interactionState = this.options.resolveInteractionStateForSocket(ws, context);
      this.options.emit(ws, {
        type: interactionState.mode === 'observe_only' ? 'observe_only' : 'busy',
        data: {
          sessionId: scope.sessionId,
          activeRun: this.options.getActiveRunStateForSocket(ws, context),
          interactionState,
        },
      });
      return;
    }
    await this.options.handleChat(ws, {
      prompt: text,
      sessionId: scope.sessionId,
      clientMessageId: typeof request.clientMessageId === 'string' ? request.clientMessageId.trim() : undefined,
    });
  }

  private parseSendFileToUserLink(content: string): SendFileToUserLink | null {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
      }
      const record = parsed as Record<string, unknown>;
      if (record.success !== true || typeof record.href !== 'string' || typeof record.displayPath !== 'string') {
        return null;
      }
      const filename = typeof record.filename === 'string' && record.filename.trim()
        ? record.filename.trim()
        : record.displayPath.trim();
      return {
        href: record.href.trim(),
        displayPath: record.displayPath.trim(),
        filename,
        ...(typeof record.size === 'number' && Number.isFinite(record.size) ? { size: record.size } : {}),
        ...(typeof record.expiresAt === 'string' && record.expiresAt.trim() ? { expiresAt: record.expiresAt.trim() } : {}),
      };
    } catch {
      return null;
    }
  }

  private withShareTokenOnFileLink<T extends { href: string }>(link: T, shareToken: string | undefined): T {
    const token = String(shareToken ?? '').trim();
    if (!token) {
      return link;
    }
    return {
      ...link,
      href: this.appendShareTokenToHref(link.href, token),
    };
  }

  private appendShareTokenToHref(href: string, shareToken: string): string {
    const rawHref = String(href ?? '').trim();
    if (!rawHref) {
      return rawHref;
    }
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(rawHref);
    try {
      const parsed = new URL(rawHref, 'http://dpagent.local');
      parsed.searchParams.set('shareToken', shareToken);
      return absolute ? parsed.toString() : `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      const separator = rawHref.includes('?') ? '&' : '?';
      return `${rawHref}${separator}shareToken=${encodeURIComponent(shareToken)}`;
    }
  }
}
