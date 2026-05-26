import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchAsrStatus, type AsrStatusView } from '../../asr-api.js';
import type { WSMessage } from '../../hooks/useWebSocket.js';

type VoiceInputState = 'checking' | 'unavailable' | 'idle' | 'recording' | 'transcribing' | 'error';

const PCM_SAMPLE_RATE = 16000;
const PCM_SEGMENT_MS = 2000;
const PCM_PROCESSOR_BUFFER_SIZE = 4096;
const VAD_SPEECH_THRESHOLD = 0.001;
const VAD_SILENCE_MS = 400;
const VAD_MIN_UTTERANCE_MS = 500;
const VAD_MAX_UTTERANCE_MS = 10000;
const ASR_CLIENT_DEBUG_STORAGE_KEY = 'dpagent.asrClientDebug';

interface UseVoiceInputOptions {
  sessionId?: string | null;
  input: string;
  setInput: (value: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  disabled: boolean;
  websocketConnected: boolean;
  sendWebSocket?: (message: WSMessage) => boolean;
  subscribeWebSocket?: (type: string, listener: (data: unknown) => void) => () => void;
}

export interface VoiceInputController {
  state: VoiceInputState;
  status: AsrStatusView | null;
  error: string | null;
  recordingSeconds: number;
  canRecord: boolean;
  isRecording: boolean;
  isBusy: boolean;
  shouldShowButton: boolean;
  toggleRecording: () => void;
  cancelRecording: () => void;
}

interface AsrStreamEvent {
  streamId?: string;
  text?: string;
  sequence?: number;
  isFinal?: boolean;
  code?: string;
  message?: string;
}

type AudioContextConstructor = typeof AudioContext;

export interface VoiceTranscriptRange {
  start: number;
  end: number;
  text: string;
}

export interface VoiceTranscriptUpdateInput {
  input: string;
  transcript: string;
  range: VoiceTranscriptRange | null;
  selectionStart?: number;
  selectionEnd?: number;
  isFinal: boolean;
}

export interface VoiceTranscriptUpdateResult {
  value: string;
  cursor: number;
  range: VoiceTranscriptRange | null;
}

function getAudioContextConstructor(): AudioContextConstructor | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  return window.AudioContext || (window as Window & { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
}

function resolveTranscriptRange(input: string, range: VoiceTranscriptRange | null): VoiceTranscriptRange | null {
  if (!range) {
    return null;
  }
  if (range.start >= 0 && range.end >= range.start && range.end <= input.length && input.slice(range.start, range.end) === range.text) {
    return range;
  }
  return null;
}

function needsLatinBoundarySpace(left: string, right: string): boolean {
  return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
}

export function applyVoiceTranscriptUpdate(update: VoiceTranscriptUpdateInput): VoiceTranscriptUpdateResult {
  const normalized = update.transcript.trim();
  if (!normalized) {
    const resolvedRange = resolveTranscriptRange(update.input, update.range);
    if (update.isFinal && resolvedRange) {
      const before = update.input.slice(0, resolvedRange.start);
      const after = update.input.slice(resolvedRange.end);
      return {
        value: `${before}${after}`,
        cursor: resolvedRange.start,
        range: null,
      };
    }
    return {
      value: update.input,
      cursor: update.selectionStart ?? update.input.length,
      range: update.isFinal ? null : update.range,
    };
  }
  const resolvedRange = resolveTranscriptRange(update.input, update.range);
  const hasStaleRange = Boolean(update.range && !resolvedRange);
  const fallbackCursor = Math.max(0, Math.min(update.selectionEnd ?? update.selectionStart ?? update.input.length, update.input.length));
  const start = resolvedRange
    ? resolvedRange.start
    : hasStaleRange
      ? fallbackCursor
      : Math.max(0, Math.min(update.selectionStart ?? update.input.length, update.input.length));
  const end = resolvedRange
    ? resolvedRange.end
    : hasStaleRange
      ? fallbackCursor
      : Math.max(start, Math.min(update.selectionEnd ?? start, update.input.length));
  const before = update.input.slice(0, start);
  const after = update.input.slice(end);
  const prefix = before && !/\s$/.test(before) && needsLatinBoundarySpace(before, normalized) ? ' ' : '';
  const suffix = after && !/^\s/.test(after) && needsLatinBoundarySpace(normalized, after) ? ' ' : '';
  const insertion = `${prefix}${normalized}${suffix}`;
  const cursor = before.length + insertion.length;
  return {
    value: `${before}${insertion}${after}`,
    cursor,
    range: update.isFinal ? null : { start, end: cursor, text: insertion },
  };
}

function browserSupportsRecording(status: AsrStatusView | null): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  if (status?.secureContextRequired && !window.isSecureContext) {
    return false;
  }
  return Boolean(typeof navigator.mediaDevices?.getUserMedia === 'function' && getAudioContextConstructor());
}

function debugPayload(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    source: 'voice-input',
    at: new Date().toISOString(),
    ...fields,
  };
}

export function isAsrClientDebugEnabled(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    if (window.localStorage?.getItem(ASR_CLIENT_DEBUG_STORAGE_KEY) === 'true') {
      return true;
    }
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
  return new URLSearchParams(window.location.search).get('asrClientDebug') === '1';
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return window.btoa(binary);
}

function downsampleTo16k(input: Float32Array, inputSampleRate: number): Float32Array {
  if (inputSampleRate === PCM_SAMPLE_RATE) {
    return new Float32Array(input);
  }
  const ratio = inputSampleRate / PCM_SAMPLE_RATE;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index++) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let cursor = start; cursor < end; cursor++) {
      sum += input[cursor] ?? 0;
      count++;
    }
    output[index] = count > 0 ? sum / count : 0;
  }
  return output;
}

function computeRms(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

function encodeWav(samples: Float32Array[], sampleRate: number): Uint8Array {
  const totalSamples = samples.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(44 + totalSamples * 2);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + totalSamples * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, totalSamples * 2, true);
  let offset = 44;
  for (const chunk of samples) {
    for (const sample of chunk) {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }
  return bytes;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index++) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

export function useVoiceInput(options: UseVoiceInputOptions): VoiceInputController {
  const { sessionId, input, setInput, textareaRef, disabled, websocketConnected, sendWebSocket, subscribeWebSocket } = options;
  const [status, setStatus] = useState<AsrStatusView | null>(null);
  const [state, setState] = useState<VoiceInputState>('checking');
  const [error, setError] = useState<string | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const inputRef = useRef(input);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const pcmSampleCountRef = useRef(0);
  const speechSeenRef = useRef(false);
  const silenceSampleCountRef = useRef(0);
  const lastDraftSampleCountRef = useRef(0);
  const captureActiveRef = useRef(false);
  const pendingChunkPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const requestGenerationRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  const disabledRef = useRef(disabled);
  const streamIdRef = useRef<string | null>(null);
  const sequenceRef = useRef(0);
  const draftRangeRef = useRef<VoiceTranscriptRange | null>(null);

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  const sendDebug = useCallback(
    (fields: Record<string, unknown>): void => {
      if (!isAsrClientDebugEnabled() || !sendWebSocket) {
        return;
      }
      sendWebSocket({ type: 'asr_client_debug', data: debugPayload(fields) });
    },
    [sendWebSocket]
  );

  useEffect(() => {
    let canceled = false;
    const loadStatus = async (): Promise<void> => {
      try {
        const nextStatus = await fetchAsrStatus();
        if (canceled) return;
        setStatus(nextStatus);
        const available = nextStatus.ready && browserSupportsRecording(nextStatus);
        setError(
          available
            ? null
            : nextStatus.configured && nextStatus.error
              ? nextStatus.error.message
              : nextStatus.ready
                ? 'Secure context or browser audio support is required.'
                : null
        );
        setState((current) =>
          current === 'recording' || current === 'transcribing' ? current : available ? 'idle' : 'unavailable'
        );
      } catch (fetchError) {
        if (canceled) return;
        setStatus(null);
        setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
        setState('unavailable');
      }
    };
    setState('checking');
    setError(null);
    void loadStatus();
    const timer = window.setInterval(loadStatus, 2000);
    return () => {
      canceled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (state !== 'recording') {
      setRecordingSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setRecordingSeconds(Math.max(1, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [state]);

  const stopAudioCapture = useCallback((): void => {
    processorRef.current?.disconnect();
    processorRef.current = null;
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== 'closed') {
      void context.close().catch(() => undefined);
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const resetPcmSegment = useCallback((): void => {
    pcmChunksRef.current = [];
    pcmSampleCountRef.current = 0;
    speechSeenRef.current = false;
    silenceSampleCountRef.current = 0;
    lastDraftSampleCountRef.current = 0;
  }, []);

  useEffect(() => {
    sessionIdRef.current = sessionId;
    requestGenerationRef.current += 1;
    captureActiveRef.current = false;
    stopAudioCapture();
    resetPcmSegment();
    pendingChunkPromiseRef.current = Promise.resolve();
    if (streamIdRef.current && sendWebSocket) {
      sendWebSocket({ type: 'asr_stream_cancel', data: { streamId: streamIdRef.current } });
    }
    streamIdRef.current = null;
    draftRangeRef.current = null;
    setState(status?.ready && sessionId && !disabled && websocketConnected && browserSupportsRecording(status) ? 'idle' : 'unavailable');
  }, [disabled, resetPcmSegment, sendWebSocket, sessionId, status?.ready, status?.secureContextRequired, stopAudioCapture, websocketConnected]);

  useEffect(() => {
    disabledRef.current = disabled;
    if (disabled) {
      requestGenerationRef.current += 1;
      captureActiveRef.current = false;
      stopAudioCapture();
      resetPcmSegment();
      setState('unavailable');
    } else if (status?.ready && sessionId && websocketConnected && browserSupportsRecording(status)) {
      setState((current) => (current === 'recording' || current === 'transcribing' ? current : 'idle'));
    }
  }, [disabled, resetPcmSegment, sessionId, status?.ready, status?.secureContextRequired, stopAudioCapture, websocketConnected]);

  const applyTranscript = useCallback(
    (transcript: string, isFinal: boolean): void => {
      const textarea = textareaRef.current;
      const currentInput = inputRef.current;
      const next = applyVoiceTranscriptUpdate({
        input: currentInput,
        transcript,
        range: draftRangeRef.current,
        selectionStart: textarea?.selectionStart ?? currentInput.length,
        selectionEnd: textarea?.selectionEnd ?? textarea?.selectionStart ?? currentInput.length,
        isFinal,
      });
      draftRangeRef.current = next.range;
      inputRef.current = next.value;
      setInput(next.value);
      window.requestAnimationFrame(() => {
        textarea?.focus();
        textarea?.setSelectionRange(next.cursor, next.cursor);
      });
    },
    [setInput, textareaRef]
  );

  const cancelRecording = useCallback((): void => {
    captureActiveRef.current = false;
    stopAudioCapture();
    resetPcmSegment();
    pendingChunkPromiseRef.current = Promise.resolve();
    if (streamIdRef.current && sendWebSocket) {
      sendWebSocket({ type: 'asr_stream_cancel', data: { streamId: streamIdRef.current } });
    }
    streamIdRef.current = null;
    draftRangeRef.current = null;
  }, [resetPcmSegment, sendWebSocket, stopAudioCapture]);

  useEffect(() => {
    if (!subscribeWebSocket) {
      return;
    }
    const onPartial = (data: unknown): void => {
      const event = data as AsrStreamEvent;
      if (!event.streamId || event.streamId !== streamIdRef.current) {
        return;
      }
      const text = typeof event.text === 'string' ? event.text.trim() : '';
      if (text || event.isFinal === true) {
        applyTranscript(text, event.isFinal === true);
      }
    };
    const onDone = (data: unknown): void => {
      const event = data as AsrStreamEvent;
      if (!event.streamId || event.streamId !== streamIdRef.current) {
        return;
      }
      streamIdRef.current = null;
      draftRangeRef.current = null;
      setState('idle');
      setError(null);
    };
    const onError = (data: unknown): void => {
      const event = data as AsrStreamEvent;
      if (event.streamId && event.streamId !== streamIdRef.current) {
        return;
      }
      const message = event.message || event.code || 'Voice input failed.';
      cancelRecording();
      setState('error');
      setError(message);
    };
    const unsubscribePartial = subscribeWebSocket('asr_stream_partial', onPartial);
    const unsubscribeDone = subscribeWebSocket('asr_stream_done', onDone);
    const unsubscribeError = subscribeWebSocket('asr_stream_error', onError);
    return () => {
      unsubscribePartial();
      unsubscribeDone();
      unsubscribeError();
    };
  }, [applyTranscript, cancelRecording, subscribeWebSocket]);

  const sendPcmChunk = useCallback(
    async (chunks: Float32Array[], sampleCount: number, isFinal: boolean): Promise<void> => {
      const streamId = streamIdRef.current;
      if (!streamId || sampleCount === 0 || !sendWebSocket) {
        return;
      }
      const sequence = sequenceRef.current++;
      const wavBytes = encodeWav(chunks, PCM_SAMPLE_RATE);
      const sent = sendWebSocket({
        type: 'asr_stream_chunk',
        data: {
          streamId,
          sequence,
          isFinal,
          mimeType: 'audio/wav',
          audioBase64: encodeBase64(wavBytes),
        },
      });
      sendDebug({ event: 'pcm_chunk_sent', streamId, sequence, samples: sampleCount, bytes: wavBytes.length, isFinal, sent });
      if (!sent) {
        throw new Error('WebSocket is not connected.');
      }
    },
    [sendDebug, sendWebSocket]
  );

  const flushPcmSegment = useCallback(
    (isFinal: boolean, reason: string): void => {
      const chunks = pcmChunksRef.current.slice();
      const sampleCount = pcmSampleCountRef.current;
      const speechSeen = speechSeenRef.current;
      if (sampleCount === 0 || !speechSeen) {
        if (isFinal) {
          resetPcmSegment();
        }
        sendDebug({ event: 'pcm_segment_dropped', samples: sampleCount, speechSeen, isFinal, reason });
        return;
      }
      if (!isFinal && sampleCount === lastDraftSampleCountRef.current) {
        return;
      }
      lastDraftSampleCountRef.current = sampleCount;
      pendingChunkPromiseRef.current = pendingChunkPromiseRef.current.then(() => sendPcmChunk(chunks, sampleCount, isFinal));
      pendingChunkPromiseRef.current.catch((chunkError) => {
        setState('error');
        setError(chunkError instanceof Error ? chunkError.message : String(chunkError));
      });
      if (isFinal) {
        resetPcmSegment();
      }
    },
    [resetPcmSegment, sendDebug, sendPcmChunk]
  );

  const finishStream = useCallback((): void => {
    stopAudioCapture();
    setState('transcribing');
    void pendingChunkPromiseRef.current.finally(() => {
      if (streamIdRef.current && sendWebSocket) {
        const stopped = sendWebSocket({ type: 'asr_stream_stop', data: { streamId: streamIdRef.current } });
        if (!stopped) {
          setState('error');
          setError('WebSocket is not connected.');
        }
      }
    });
  }, [sendWebSocket, stopAudioCapture]);

  const startPcmCapture = useCallback(
    async (stream: MediaStream): Promise<void> => {
      const AudioContextConstructor = getAudioContextConstructor();
      if (!AudioContextConstructor) {
        throw new Error('Browser audio capture is not supported.');
      }
      const context = new AudioContextConstructor();
      if (context.state === 'suspended') {
        await context.resume().catch(() => undefined);
      }
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(PCM_PROCESSOR_BUFFER_SIZE, 1, 1);
      audioContextRef.current = context;
      sourceRef.current = source;
      processorRef.current = processor;
      resetPcmSegment();
      processor.onaudioprocess = (event) => {
        event.outputBuffer.getChannelData(0).fill(0);
        if (!captureActiveRef.current) {
          return;
        }
        const inputSamples = event.inputBuffer.getChannelData(0);
        const pcmSamples = downsampleTo16k(inputSamples, context.sampleRate);
        const rms = computeRms(pcmSamples);
        const hasSpeech = rms >= VAD_SPEECH_THRESHOLD;
        if (!speechSeenRef.current && !hasSpeech) {
          return;
        }
        if (hasSpeech) {
          speechSeenRef.current = true;
          silenceSampleCountRef.current = 0;
        } else {
          silenceSampleCountRef.current += pcmSamples.length;
        }
        pcmChunksRef.current.push(pcmSamples);
        pcmSampleCountRef.current += pcmSamples.length;
        const silenceMs = (silenceSampleCountRef.current / PCM_SAMPLE_RATE) * 1000;
        if (pcmSampleCountRef.current >= (PCM_SAMPLE_RATE * VAD_MAX_UTTERANCE_MS) / 1000) {
          sendDebug({
            event: 'pcm_sentence_boundary',
            streamId: streamIdRef.current,
            samples: pcmSampleCountRef.current,
            silenceSamples: silenceSampleCountRef.current,
            silenceMs: Math.round(silenceMs),
            reason: 'max_utterance',
            rms: Number(rms.toFixed(4)),
          });
          flushPcmSegment(true, 'max_utterance');
          return;
        }
        if (pcmSampleCountRef.current - lastDraftSampleCountRef.current >= (PCM_SAMPLE_RATE * PCM_SEGMENT_MS) / 1000) {
          sendDebug({
            event: 'pcm_segment_ready',
            streamId: streamIdRef.current,
            samples: pcmSampleCountRef.current,
            rms: Number(rms.toFixed(4)),
            silenceMs: Math.round(silenceMs),
            speechSeen: speechSeenRef.current,
            isFinal: false,
          });
          flushPcmSegment(false, 'draft_interval');
        }
        if (
          speechSeenRef.current &&
          pcmSampleCountRef.current >= (PCM_SAMPLE_RATE * VAD_MIN_UTTERANCE_MS) / 1000 &&
          silenceSampleCountRef.current >= (PCM_SAMPLE_RATE * VAD_SILENCE_MS) / 1000
        ) {
          sendDebug({
            event: 'pcm_sentence_boundary',
            streamId: streamIdRef.current,
            samples: pcmSampleCountRef.current,
            silenceSamples: silenceSampleCountRef.current,
            silenceMs: Math.round(silenceMs),
            reason: 'vad_silence',
            rms: Number(rms.toFixed(4)),
          });
          flushPcmSegment(true, 'vad_silence');
        }
      };
      source.connect(processor);
      processor.connect(context.destination);
      sendDebug({ event: 'pcm_capture_started', streamId: streamIdRef.current, inputSampleRate: context.sampleRate });
    },
    [flushPcmSegment, resetPcmSegment, sendDebug]
  );

  const stopRecording = useCallback((): void => {
    if (!captureActiveRef.current) {
      return;
    }
    captureActiveRef.current = false;
    flushPcmSegment(true, 'manual_stop');
    finishStream();
  }, [finishStream, flushPcmSegment]);

  const startRecording = useCallback(async (): Promise<void> => {
    sendDebug({
      event: 'start_requested',
      sessionId,
      disabled,
      statusReady: Boolean(status?.ready),
      websocketConnected,
      browserRecordingSupported: browserSupportsRecording(status),
    });
    if (!sessionId || disabled || !status?.ready || !websocketConnected || !sendWebSocket || !browserSupportsRecording(status)) {
      sendDebug({ event: 'start_blocked' });
      return;
    }
    try {
      const recordingGeneration = requestGenerationRef.current;
      const recordingSessionId = sessionId;
      const streamId = `asr-stream-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      streamIdRef.current = streamId;
      draftRangeRef.current = null;
      sequenceRef.current = 0;
      pendingChunkPromiseRef.current = Promise.resolve();
      const started = sendWebSocket({
        type: 'asr_stream_start',
        data: { streamId, sessionId: recordingSessionId },
      });
      sendDebug({ event: 'stream_start_sent', streamId, sent: started });
      if (!started) {
        throw new Error('WebSocket is not connected.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
        },
      });
      sendDebug({
        event: 'media_granted',
        streamId,
        tracks: stream.getAudioTracks().map((track) => ({
          enabled: track.enabled,
          muted: track.muted,
          readyState: track.readyState,
          label: track.label,
        })),
      });
      if (
        recordingGeneration !== requestGenerationRef.current ||
        recordingSessionId !== sessionIdRef.current ||
        disabledRef.current
      ) {
        stream.getTracks().forEach((track) => track.stop());
        if (streamIdRef.current && sendWebSocket) {
          sendWebSocket({ type: 'asr_stream_cancel', data: { streamId: streamIdRef.current } });
        }
        streamIdRef.current = null;
        return;
      }
      streamRef.current = stream;
      captureActiveRef.current = true;
      await startPcmCapture(stream);
      setState('recording');
      setError(null);
    } catch (recordError) {
      captureActiveRef.current = false;
      sendDebug({
        event: 'start_failed',
        message: recordError instanceof Error ? recordError.message : String(recordError),
        name: recordError instanceof Error ? recordError.name : undefined,
      });
      if (streamIdRef.current && sendWebSocket) {
        sendWebSocket({ type: 'asr_stream_cancel', data: { streamId: streamIdRef.current } });
      }
      streamIdRef.current = null;
      stopAudioCapture();
      resetPcmSegment();
      setState('error');
      setError(recordError instanceof Error ? recordError.message : String(recordError));
    }
  }, [disabled, resetPcmSegment, sendDebug, sendWebSocket, sessionId, startPcmCapture, status, stopAudioCapture, websocketConnected]);

  useEffect(() => cancelRecording, [cancelRecording]);
  useEffect(() => {
    if ((disabled || !sessionId) && state === 'recording') {
      cancelRecording();
      setState(status?.ready && browserSupportsRecording(status) ? 'idle' : 'unavailable');
    }
  }, [cancelRecording, disabled, sessionId, state, status]);

  const canRecord = useMemo(
    () => Boolean(sessionId && !disabled && status?.ready && websocketConnected && sendWebSocket && browserSupportsRecording(status)),
    [disabled, sendWebSocket, sessionId, status, websocketConnected]
  );
  const shouldShowButton = useMemo(
    () => Boolean(status?.ready && websocketConnected && browserSupportsRecording(status)),
    [status, websocketConnected]
  );
  const isRecording = state === 'recording';
  const isBusy = state === 'checking' || state === 'recording' || state === 'transcribing';

  return {
    state,
    status,
    error,
    recordingSeconds,
    canRecord,
    isRecording,
    isBusy,
    shouldShowButton,
    cancelRecording,
    toggleRecording: () => {
      if (isRecording) {
        stopRecording();
      } else {
        void startRecording();
      }
    },
  };
}
