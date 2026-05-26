import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AsrError } from '../../asr/index.js';

export interface MappedAsrError {
  status: number;
  code: string;
  message: string;
}

export interface AsrStreamError {
  code: string;
  message: string;
}

export function extensionFromAudioMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('wav')) return '.wav';
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return '.mp3';
  if (normalized.includes('ogg')) return '.ogg';
  if (normalized.includes('webm')) return '.webm';
  if (normalized.includes('mp4')) return '.m4a';
  return '.audio';
}

export function mapAsrHttpError(error: unknown): MappedAsrError {
  if (error instanceof AsrError) {
    if (error.code === 'ASR_DISABLED' || error.code === 'ASR_NOT_READY') {
      return { status: 503, code: error.code, message: error.message };
    }
    if (
      error.code === 'AUDIO_NOT_FOUND' ||
      error.code === 'AUDIO_NOT_FILE' ||
      error.code === 'AUDIO_EMPTY' ||
      error.code === 'AUDIO_TOO_LARGE' ||
      error.code === 'ASR_BUSY'
    ) {
      return { status: 400, code: error.code, message: error.message };
    }
    return { status: 502, code: error.code, message: error.message };
  }
  return {
    status: 500,
    code: 'ASR_INTERNAL_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
}

export function mapAsrStreamError(error: unknown): AsrStreamError {
  if (error instanceof AsrError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'ASR_STREAM_FAILED',
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function writeTempAudioFile(input: {
  runtimeDataDir?: string;
  bucket: string;
  ownerId: string;
  fileStem: string;
  body: Buffer;
  extension: string;
}): Promise<{ tempDir: string; audioPath: string }> {
  const tempDir = await createBucketTempDir({
    runtimeDataDir: input.runtimeDataDir,
    bucket: input.bucket,
    ownerId: input.ownerId,
    fallbackOwnerId: 'audio',
  });
  const safeFileStem = sanitizeTempPathPart(input.fileStem) || 'audio';
  const audioPath = path.join(tempDir, `${safeFileStem}${input.extension}`);
  await fs.writeFile(audioPath, input.body);
  return { tempDir, audioPath };
}

export async function createAsrTempDir(input: {
  runtimeDataDir?: string;
  bucket: string;
  ownerId: string;
}): Promise<string> {
  return await createBucketTempDir({
    runtimeDataDir: input.runtimeDataDir,
    bucket: input.bucket,
    ownerId: input.ownerId,
    fallbackOwnerId: 'stream',
  });
}

async function createBucketTempDir(input: {
  runtimeDataDir?: string;
  bucket: string;
  ownerId: string;
  fallbackOwnerId: string;
}): Promise<string> {
  const baseDir = path.resolve(input.runtimeDataDir ?? './runtime', input.bucket);
  await fs.mkdir(baseDir, { recursive: true });
  const safeOwnerId = sanitizeTempPathPart(input.ownerId) || input.fallbackOwnerId;
  return await fs.mkdtemp(path.join(baseDir, `${safeOwnerId}-`));
}

function sanitizeTempPathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
}
