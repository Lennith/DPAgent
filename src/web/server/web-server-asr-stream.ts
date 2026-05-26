import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { AsrError, type AsrLifecycleStatus, type AsrTranscriptionInput, type AsrTranscriptionResult } from '../../asr/index.js';
import type { ContextRef, SessionInteractionState } from '../../types.js';
import { webServerLogger } from '../../utils/logger.js';
import { isContextRef, isSocketOpen, type WSMessage } from './web-server-shared.js';
import { createAsrTempDir, extensionFromAudioMime, mapAsrStreamError } from './web-server-asr-utils.js';

export interface AsrStreamStartRequest {
  streamId?: string;
  sessionId?: string;
  context?: ContextRef;
  language?: string;
}

export interface AsrStreamChunkRequest {
  streamId?: string;
  sequence?: number;
  mimeType?: string;
  audioBase64?: string;
  isFinal?: boolean;
}

export interface AsrStreamStopRequest {
  streamId?: string;
}

export interface WebAsrStreamControllerOptions {
  getRuntimeDataDir: () => string | undefined;
  getStatus: () => AsrLifecycleStatus;
  transcribe: (input: AsrTranscriptionInput) => Promise<AsrTranscriptionResult>;
  canAccessContext: (ws: WebSocket, context: ContextRef) => boolean;
  hasFullAccess: (ws: WebSocket) => boolean;
  getInteractionStateForContext: (context: ContextRef) => SessionInteractionState;
  emit: (ws: WebSocket | undefined, message: WSMessage) => void;
}

interface ActiveAsrStream {
  ws: WebSocket;
  streamId: string;
  context: ContextRef;
  language?: string;
  tempDir: string;
  queue: Promise<void>;
  closed: boolean;
}

export class WebAsrStreamController {
  private readonly streams = new Map<string, ActiveAsrStream>();
  private readonly startingStreams = new Map<string, Promise<void>>();

  constructor(private readonly options: WebAsrStreamControllerOptions) {}

  async start(ws: WebSocket, request: AsrStreamStartRequest): Promise<void> {
    const streamId = this.normalizeStreamId(request.streamId);
    const context = this.resolveSessionContext(request);
    if (!context) {
      this.emitError(ws, streamId, 'ASR_BAD_REQUEST', 'ASR stream requires a session context.');
      return;
    }
    if (!this.options.hasFullAccess(ws) || !this.options.canAccessContext(ws, context)) {
      this.emitError(ws, streamId, 'ASR_FORBIDDEN', 'ASR stream is not allowed for this socket.');
      return;
    }
    const interaction = this.options.getInteractionStateForContext(context);
    if (interaction.mode === 'observe_only') {
      this.emitError(ws, streamId, 'ASR_OBSERVE_ONLY', 'ASR stream is not allowed in observe-only mode.');
      return;
    }
    const status = this.options.getStatus();
    if (!status.ready) {
      webServerLogger.warn(`[ASR Stream] rejected start stream=${streamId} state=${status.state}`);
      this.emitError(ws, streamId, 'ASR_NOT_READY', 'ASR worker is not ready.');
      return;
    }
    const startPromise = (async (): Promise<void> => {
      const tempDir = await this.createStreamTempDir(streamId);
      await this.cleanupStream(streamId);
      this.streams.set(streamId, {
        ws,
        streamId,
        context,
        language: request.language?.trim() || undefined,
        tempDir,
        queue: Promise.resolve(),
        closed: false,
      });
      webServerLogger.info(`[ASR Stream] start stream=${streamId} session=${context.namespace}`);
      this.options.emit(ws, {
        type: 'asr_stream_ready',
        data: { streamId, context },
      });
    })();
    this.startingStreams.set(streamId, startPromise);
    try {
      await startPromise;
    } finally {
      this.startingStreams.delete(streamId);
    }
  }

  async chunk(ws: WebSocket, request: AsrStreamChunkRequest): Promise<void> {
    const starting = request.streamId ? this.startingStreams.get(request.streamId) : undefined;
    if (starting) {
      await starting.catch(() => undefined);
    }
    const stream = this.resolveOwnedStream(ws, request.streamId);
    if (!stream) {
      this.emitError(ws, request.streamId ?? '', 'ASR_STREAM_NOT_FOUND', 'ASR stream was not started.');
      return;
    }
    const maxAudioBytes = this.options.getStatus().maxAudioBytes;
    let audio: Buffer;
    try {
      audio = this.decodeAudio(request.audioBase64, maxAudioBytes);
    } catch (error) {
      const mapped = mapAsrStreamError(error);
      this.emitError(stream.ws, stream.streamId, mapped.code, mapped.message);
      return;
    }
    if (audio.length === 0) {
      webServerLogger.warn(`[ASR Stream] empty chunk stream=${request.streamId ?? ''} seq=${String(request.sequence ?? '')}`);
      return;
    }
    const sequence = this.normalizeSequence(request.sequence);
    const isFinal = request.isFinal === true;
    webServerLogger.info(
      `[ASR Stream] chunk stream=${stream.streamId} seq=${sequence} final=${isFinal} mime=${request.mimeType ?? 'unknown'} bytes=${audio.length}`
    );
    const audioPath = path.join(
      stream.tempDir,
      `chunk-${sequence}${extensionFromAudioMime(request.mimeType ?? '')}`
    );
    stream.queue = stream.queue
      .then(async () => {
        if (stream.closed) {
          return;
        }
        await fs.writeFile(audioPath, audio);
        if (stream.closed) {
          await fs.rm(audioPath, { force: true }).catch(() => undefined);
          return;
        }
        await this.processChunk(stream, audioPath, request.mimeType ?? 'application/octet-stream', sequence, isFinal);
      })
      .catch((error) => {
        if (stream.closed) {
          return;
        }
        const mapped = mapAsrStreamError(error);
        webServerLogger.warn(`[ASR Stream] queue failed stream=${stream.streamId} code=${mapped.code}: ${mapped.message}`);
        this.emitError(stream.ws, stream.streamId, mapped.code, mapped.message);
      });
  }

  async stop(ws: WebSocket, request: AsrStreamStopRequest): Promise<void> {
    const stream = this.resolveOwnedStream(ws, request.streamId);
    if (!stream) {
      return;
    }
    await stream.queue;
    if (!stream.closed) {
      webServerLogger.info(`[ASR Stream] stop stream=${stream.streamId}`);
      this.options.emit(ws, {
        type: 'asr_stream_done',
        data: { streamId: stream.streamId, context: stream.context },
      });
    }
    await this.cleanupStream(stream.streamId);
  }

  async cancel(ws: WebSocket, request: AsrStreamStopRequest): Promise<void> {
    const stream = this.resolveOwnedStream(ws, request.streamId);
    if (stream) {
      webServerLogger.info(`[ASR Stream] cancel stream=${stream.streamId}`);
      stream.closed = true;
      await stream.queue.finally(() => this.cleanupStream(stream.streamId));
    }
  }

  detach(ws: WebSocket): void {
    for (const stream of [...this.streams.values()]) {
      if (stream.ws === ws) {
        stream.closed = true;
        void stream.queue.finally(() => this.cleanupStream(stream.streamId));
      }
    }
  }

  private async processChunk(
    stream: ActiveAsrStream,
    audioPath: string,
    mimeType: string,
    sequence: number,
    isFinal: boolean
  ): Promise<void> {
    try {
      if (stream.closed || !isSocketOpen(stream.ws)) {
        return;
      }
      const result = await this.options.transcribe({
        audioPath,
        mimeType,
        language: stream.language,
        requestId: `${stream.streamId}-${path.basename(audioPath)}`,
      });
      const text = result.text.trim();
      webServerLogger.info(
        `[ASR Stream] result stream=${stream.streamId} chunk=${path.basename(audioPath)} textChars=${text.length} durationMs=${result.durationMs ?? 0}`
      );
      if (!stream.closed && (text || isFinal)) {
        this.options.emit(stream.ws, {
          type: 'asr_stream_partial',
          data: {
            streamId: stream.streamId,
            context: stream.context,
            text,
            sequence,
            isFinal,
            language: result.language,
            model: result.model,
            durationMs: result.durationMs,
          },
        });
      }
    } catch (error) {
      if (!stream.closed) {
        const mapped = mapAsrStreamError(error);
        webServerLogger.warn(`[ASR Stream] error stream=${stream.streamId} code=${mapped.code} message=${mapped.message}`);
        this.emitError(stream.ws, stream.streamId, mapped.code, mapped.message);
      }
    } finally {
      await fs.rm(audioPath, { force: true }).catch(() => undefined);
    }
  }

  private resolveSessionContext(request: AsrStreamStartRequest): ContextRef | null {
    if (isContextRef(request.context) && request.context.scope === 'session') {
      return request.context;
    }
    const sessionId = request.sessionId?.trim();
    return sessionId ? { scope: 'session', namespace: sessionId } : null;
  }

  private resolveOwnedStream(ws: WebSocket, streamId: string | undefined): ActiveAsrStream | null {
    const id = streamId?.trim() ?? '';
    const stream = id ? this.streams.get(id) : null;
    return stream && stream.ws === ws ? stream : null;
  }

  private normalizeStreamId(streamId: string | undefined): string {
    const trimmed = streamId?.trim();
    return trimmed || `asr-stream-${Date.now()}-${randomUUID().slice(0, 8)}`;
  }

  private normalizeSequence(sequence: number | undefined): number {
    return Number.isFinite(sequence) && Number(sequence) >= 0 ? Math.floor(Number(sequence)) : Date.now();
  }

  private decodeAudio(audioBase64: string | undefined, maxAudioBytes: number): Buffer {
    const encoded = audioBase64?.trim();
    if (!encoded) {
      return Buffer.alloc(0);
    }
    const estimatedBytes = Math.floor((encoded.replace(/=+$/, '').length * 3) / 4);
    if (estimatedBytes > maxAudioBytes) {
      throw new AsrError(
        'ASR_STREAM_TOO_LARGE',
        `ASR stream chunk is about ${estimatedBytes} bytes, exceeding limit ${maxAudioBytes}.`
      );
    }
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.length > maxAudioBytes) {
      throw new AsrError(
        'ASR_STREAM_TOO_LARGE',
        `ASR stream chunk is ${decoded.length} bytes, exceeding limit ${maxAudioBytes}.`
      );
    }
    return decoded;
  }

  private async createStreamTempDir(streamId: string): Promise<string> {
    return await createAsrTempDir({
      runtimeDataDir: this.options.getRuntimeDataDir(),
      bucket: 'asr-stream',
      ownerId: streamId,
    });
  }

  private async cleanupStream(streamId: string): Promise<void> {
    const stream = this.streams.get(streamId);
    if (!stream) {
      return;
    }
    stream.closed = true;
    this.streams.delete(streamId);
    await fs.rm(stream.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private emitError(ws: WebSocket | undefined, streamId: string, code: string, message: string): void {
    this.options.emit(ws, {
      type: 'asr_stream_error',
      data: { streamId, code, message },
    });
  }
}
