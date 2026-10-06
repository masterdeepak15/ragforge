import { ApiError, api as defaultApi } from './api-client';

export const MB = 1024 * 1024;

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'duplicate' | 'error' | 'cancelled';

export interface UploadItem {
  id: string;
  name: string;
  size: number;
  status: UploadStatus;
  /** Bytes sent so far. */
  loaded: number;
  documentId?: string;
  error?: string;
}

interface UploadedDocument {
  id: string;
  title: string;
  status: string;
  deduplicated: boolean;
}

export interface UploadDeps {
  /** Used for the resumable API. */
  api: { request: <T>(method: string, path: string, body?: unknown, extras?: { headers?: Record<string, string>; signal?: AbortSignal | null }) => Promise<T> };
  /** One multipart request carrying a single file. */
  multipart: (args: { kbId: string; file: File; signal: AbortSignal; onProgress: (loaded: number) => void }) => Promise<UploadedDocument[]>;
}

export interface UploadOptions {
  /** Files uploaded at once. Default 3. */
  concurrency?: number;
  /** Files above this size use the resumable API. Default 50 MB. */
  resumableThreshold?: number;
  /** Resumable chunk size. Default 8 MB. */
  chunkSize?: number;
  /** Consecutive chunk failures tolerated before the file fails. Default 5. */
  maxChunkRetries?: number;
  retryDelayMs?: number;
  deps?: Partial<UploadDeps>;
}

export interface UploadHandle {
  /** Aborts running uploads and marks everything unfinished as cancelled. */
  cancel(): void;
  done: Promise<void>;
}

function readToken(): string | null {
  try {
    return localStorage.getItem('ragforge_token');
  } catch {
    return null;
  }
}

/** Default transport: XHR, because fetch cannot report upload progress. */
function xhrMultipart({ kbId, file, signal, onProgress }: Parameters<UploadDeps['multipart']>[0]): Promise<UploadedDocument[]> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/documents/upload');
    const token = readToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
    xhr.onload = () => {
      let body: any;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body?.items ?? []);
      reject(new ApiError(xhr.status, body?.error ?? `Upload failed (HTTP ${xhr.status})`, body));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Could not reach the server. Check your connection and try again.'));
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });

    const form = new FormData();
    form.append('knowledgeBaseId', kbId); // the server requires this field before the file
    form.append('file', file);
    xhr.send(form);
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isAbort = (e: unknown) => (e as { name?: string })?.name === 'AbortError';

export function uploadFiles(files: File[], kbId: string, onUpdate: (item: UploadItem) => void, opts: UploadOptions = {}): UploadHandle {
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const threshold = opts.resumableThreshold ?? 50 * MB;
  const chunkSize = opts.chunkSize ?? 8 * MB;
  const maxRetries = opts.maxChunkRetries ?? 5;
  const retryDelay = opts.retryDelayMs ?? 1000;
  const deps: UploadDeps = { api: opts.deps?.api ?? (defaultApi as unknown as UploadDeps['api']), multipart: opts.deps?.multipart ?? xhrMultipart };

  const controller = new AbortController();
  const items: UploadItem[] = files.map((f, i) => ({ id: `${Date.now()}-${i}-${f.name}`, name: f.name, size: f.size, status: 'queued', loaded: 0 }));
  items.forEach((it) => onUpdate({ ...it }));

  const update = (item: UploadItem, patch: Partial<UploadItem>) => {
    Object.assign(item, patch);
    onUpdate({ ...item });
  };

  async function resumable(file: File, item: UploadItem): Promise<UploadedDocument[]> {
    const { id } = await deps.api.request<{ id: string }>(
      'POST',
      '/api/uploads',
      { knowledgeBaseId: kbId, filename: file.name, size: file.size, mimeType: file.type || 'application/octet-stream' },
      { signal: controller.signal },
    );
    let offset = 0;
    let failures = 0;
    while (offset < file.size) {
      const end = Math.min(file.size, offset + chunkSize);
      try {
        const res = await deps.api.request<{ offset: number }>('PATCH', `/api/uploads/${id}`, file.slice(offset, end), {
          headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset) },
          signal: controller.signal,
        });
        offset = res.offset;
        failures = 0;
        update(item, { loaded: offset });
      } catch (err) {
        if (isAbort(err) || controller.signal.aborted) throw err;
        const serverOffset = err instanceof ApiError && err.status === 409 ? (err.body as { offset?: number } | undefined)?.offset : undefined;
        if (typeof serverOffset === 'number') {
          offset = serverOffset; // the server knows best where we are
          continue;
        }
        const transient = err instanceof ApiError && (err.status === 0 || err.status >= 500);
        if (!transient || ++failures > maxRetries) throw err;
        await sleep(retryDelay * failures);
        try {
          offset = (await deps.api.request<{ offset: number }>('GET', `/api/uploads/${id}`, undefined, { signal: controller.signal })).offset;
        } catch (statusErr) {
          if (isAbort(statusErr) || controller.signal.aborted) throw statusErr;
          /* keep the current offset; the next PATCH will be corrected by a 409 if needed */
        }
      }
    }
    const done = await deps.api.request<{ items: UploadedDocument[] }>('POST', `/api/uploads/${id}/complete`, {}, { signal: controller.signal });
    return done.items;
  }

  async function uploadOne(file: File, item: UploadItem): Promise<void> {
    if (controller.signal.aborted) return update(item, { status: 'cancelled' });
    update(item, { status: 'uploading' });
    try {
      const docs =
        file.size > threshold
          ? await resumable(file, item)
          : await deps.multipart({ kbId, file, signal: controller.signal, onProgress: (loaded) => update(item, { loaded }) });
      const doc = docs[0];
      update(item, { status: doc?.deduplicated ? 'duplicate' : 'done', loaded: file.size, documentId: doc?.id });
    } catch (err) {
      if (isAbort(err) || controller.signal.aborted) update(item, { status: 'cancelled' });
      else update(item, { status: 'error', error: (err as Error).message || 'Upload failed' });
    }
  }

  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      await uploadOne(files[i], items[i]);
    }
  };
  const done = Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker)).then(() => undefined);

  return {
    cancel() {
      controller.abort();
      for (const item of items) if (item.status === 'queued' || item.status === 'uploading') update(item, { status: 'cancelled' });
    },
    done,
  };
}
