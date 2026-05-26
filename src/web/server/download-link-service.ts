import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DownloadLinkRecord {
  id: string;
  absolutePath: string;
  authorizedRealPath: string;
  authorizedDev: number;
  authorizedIno: number;
  displayPath: string;
  filename: string;
  size: number;
  href: string;
  createdAt: string;
  expiresAt: string;
}

export interface DownloadLinkServiceOptions {
  runtimeDataDir: string;
  publicBaseUrl?: string;
  ttlMs?: number;
  now?: () => Date;
}

export interface CreateDownloadLinkInput {
  absolutePath: string;
  displayPath?: string;
  filename?: string;
  size?: number;
}

const DEFAULT_DOWNLOAD_LINK_TTL_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_LINK_ID_BYTES = 18;

function normalizePublicBaseUrl(value: string | undefined): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    return '';
  }
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('publicBaseUrl must use http or https');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function normalizeTtlMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_DOWNLOAD_LINK_TTL_MS;
  }
  return Math.floor(value);
}

function safeFilename(value: string | undefined, absolutePath: string): string {
  const candidate = path.basename(String(value ?? '').trim() || absolutePath);
  return candidate || 'download';
}

function isDownloadLinkRecord(value: unknown): value is DownloadLinkRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<DownloadLinkRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.absolutePath === 'string' &&
    typeof record.authorizedRealPath === 'string' &&
    typeof record.authorizedDev === 'number' &&
    typeof record.authorizedIno === 'number' &&
    typeof record.displayPath === 'string' &&
    typeof record.filename === 'string' &&
    typeof record.size === 'number' &&
    typeof record.href === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.expiresAt === 'string'
  );
}

export class DownloadLinkService {
  private readonly storePath: string;
  private readonly publicBaseUrl: string;
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private loaded = false;
  private readonly records = new Map<string, DownloadLinkRecord>();

  constructor(options: DownloadLinkServiceOptions) {
    this.storePath = path.join(options.runtimeDataDir, 'download-links.json');
    this.publicBaseUrl = normalizePublicBaseUrl(options.publicBaseUrl);
    this.ttlMs = normalizeTtlMs(options.ttlMs);
    this.now = options.now ?? (() => new Date());
  }

  createLink(input: CreateDownloadLinkInput): DownloadLinkRecord {
    this.ensureLoaded();
    this.pruneExpired();

    const absolutePath = path.resolve(input.absolutePath);
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) {
      throw new Error(`Download target is not a file: ${absolutePath}`);
    }
    const authorizedRealPath = fs.realpathSync.native(absolutePath);

    const id = this.createUniqueId();
    const createdAtDate = this.now();
    const expiresAtDate = new Date(createdAtDate.getTime() + this.ttlMs);
    const filename = safeFilename(input.filename, absolutePath);
    const href = `${this.publicBaseUrl}/download/${id}/${encodeURIComponent(filename)}`;
    const record: DownloadLinkRecord = {
      id,
      absolutePath,
      authorizedRealPath,
      authorizedDev: stat.dev,
      authorizedIno: stat.ino,
      displayPath: String(input.displayPath ?? absolutePath),
      filename,
      size: typeof input.size === 'number' && Number.isFinite(input.size) ? input.size : stat.size,
      href,
      createdAt: createdAtDate.toISOString(),
      expiresAt: expiresAtDate.toISOString(),
    };
    this.records.set(id, record);
    this.persist();
    return record;
  }

  resolve(id: string): DownloadLinkRecord | null {
    this.ensureLoaded();
    this.pruneExpired();
    const record = this.records.get(String(id ?? '').trim());
    if (!record) {
      return null;
    }
    try {
      const stat = fs.statSync(record.absolutePath);
      const currentRealPath = fs.realpathSync.native(record.absolutePath);
      if (
        !stat.isFile() ||
        currentRealPath !== record.authorizedRealPath ||
        stat.dev !== record.authorizedDev ||
        stat.ino !== record.authorizedIno
      ) {
        this.records.delete(record.id);
        this.persist();
        return null;
      }
      return { ...record, size: stat.size };
    } catch {
      this.records.delete(record.id);
      this.persist();
      return null;
    }
  }

  private createUniqueId(): string {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = crypto.randomBytes(DOWNLOAD_LINK_ID_BYTES).toString('hex');
      if (!this.records.has(id)) {
        return id;
      }
    }
    throw new Error('Failed to allocate a unique download link id');
  }

  private ensureLoaded(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    try {
      const raw = fs.readFileSync(this.storePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      const items = Array.isArray(parsed) ? parsed : [];
      for (const item of items) {
        if (isDownloadLinkRecord(item)) {
          this.records.set(item.id, item);
        }
      }
      this.pruneExpired();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.records.clear();
      }
    }
  }

  private pruneExpired(): void {
    const nowMs = this.now().getTime();
    let changed = false;
    for (const [id, record] of this.records) {
      const expiresAtMs = Date.parse(record.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
        this.records.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    fs.writeFileSync(
      this.storePath,
      JSON.stringify(Array.from(this.records.values()), null, 2),
      'utf-8'
    );
  }
}
