import { describe, it, expect, vi } from 'vitest';
import { ApiError } from './api-client';
import { uploadFiles, MB, type UploadItem } from './upload';

function fakeFile(name: string, size: number): File {
  return {
    name,
    size,
    type: 'application/octet-stream',
    slice: (start = 0, end = size) => new Blob([new Uint8Array(Math.min(16, Math.max(0, end - start)))]),
  } as unknown as File;
}

interface Call { method: string; path: string; body?: unknown; offset?: number }

/** A fake resumable-upload server that records calls and can be told to fail. */
function fakeServer(over: { failPatchAt?: number[]; mismatchAt?: number; status0Once?: boolean } = {}) {
  const calls: Call[] = [];
  let stored = 0;
  let patchCount = 0;
  const request = vi.fn(async (method: string, path: string, body?: unknown, extras?: { headers?: Record<string, string> }) => {
    const offset = extras?.headers?.['Upload-Offset'] === undefined ? undefined : Number(extras.headers['Upload-Offset']);
    calls.push({ method, path, body, offset });
    if (method === 'POST' && path === '/api/uploads') return { id: 'up1' };
    if (method === 'GET' && path === '/api/uploads/up1') return { offset: stored, size: 0 };
    if (method === 'PATCH') {
      patchCount++;
      if (over.failPatchAt?.includes(patchCount)) throw new ApiError(0, 'Could not reach the server.');
      if (over.mismatchAt === patchCount) throw new ApiError(409, 'Offset mismatch', { offset: stored });
      if (offset !== stored) throw new ApiError(409, 'Offset mismatch', { offset: stored });
      stored += 8 * MB; // the fake server always stores a full chunk
      return { offset: Math.min(stored, 60 * MB) };
    }
    if (method === 'POST' && path === '/api/uploads/up1/complete') return { items: [{ id: 'doc1', title: 'big.bin', status: 'pending', deduplicated: false }] };
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { request, calls };
}

function run(files: File[], deps: Parameters<typeof uploadFiles>[3] = {}) {
  const updates = new Map<string, UploadItem>();
  const handle = uploadFiles(files, 'kb1', (item) => updates.set(item.id, { ...item }), deps);
  return { handle, updates, final: () => [...updates.values()] };
}

describe('uploadFiles: small files', () => {
  it('sends a small file as one multipart request and records the document', async () => {
    const multipart = vi.fn().mockResolvedValue([{ id: 'doc1', title: 'a.txt', status: 'pending', deduplicated: false }]);
    const { handle, final } = run([fakeFile('a.txt', 1000)], { deps: { multipart } });
    await handle.done;
    expect(multipart).toHaveBeenCalledTimes(1);
    expect(multipart.mock.calls[0][0]).toMatchObject({ kbId: 'kb1' });
    expect(final()).toEqual([expect.objectContaining({ name: 'a.txt', status: 'done', documentId: 'doc1', loaded: 1000 })]);
  });

  it('marks a duplicate instead of an error', async () => {
    const multipart = vi.fn().mockResolvedValue([{ id: 'doc1', title: 'a.txt', status: 'pending', deduplicated: true }]);
    const { handle, final } = run([fakeFile('a.txt', 10)], { deps: { multipart } });
    await handle.done;
    expect(final()[0].status).toBe('duplicate');
  });

  it('keeps going when one file fails, and reports why', async () => {
    const multipart = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(400, 'knowledgeBaseId is required'))
      .mockResolvedValue([{ id: 'd2', title: 'b.txt', status: 'pending', deduplicated: false }]);
    const { handle, final } = run([fakeFile('a.txt', 10), fakeFile('b.txt', 10)], { concurrency: 1, deps: { multipart } });
    await handle.done;
    const byName = Object.fromEntries(final().map((i) => [i.name, i]));
    expect(byName['a.txt']).toMatchObject({ status: 'error', error: 'knowledgeBaseId is required' });
    expect(byName['b.txt'].status).toBe('done');
  });

  it('never runs more uploads at once than the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const multipart = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return [{ id: 'x', title: 'x', status: 'pending', deduplicated: false }];
    });
    const files = Array.from({ length: 8 }, (_, i) => fakeFile(`f${i}.txt`, 10));
    await run(files, { concurrency: 3, deps: { multipart } }).handle.done;
    expect(peak).toBe(3);
    expect(multipart).toHaveBeenCalledTimes(8);
  });

  it('cancel stops pending files and aborts the running one', async () => {
    const multipart = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
    const { handle, final } = run([fakeFile('a.txt', 10), fakeFile('b.txt', 10), fakeFile('c.txt', 10)], { concurrency: 1, deps: { multipart: multipart as never } });
    await new Promise((r) => setTimeout(r, 10));
    handle.cancel();
    await handle.done;
    expect(final().map((i) => i.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect(multipart).toHaveBeenCalledTimes(1);
  });
});

describe('uploadFiles: large files use the resumable API', () => {
  it('splits a 60 MB file into 8 MB chunks with ascending offsets, then completes', async () => {
    const server = fakeServer();
    const multipart = vi.fn();
    const { handle, final } = run([fakeFile('big.bin', 60 * MB)], { deps: { api: server as never, multipart } });
    await handle.done;
    expect(multipart).not.toHaveBeenCalled();
    const patches = server.calls.filter((c) => c.method === 'PATCH');
    expect(patches.map((p) => p.offset)).toEqual([0, 8, 16, 24, 32, 40, 48, 56].map((n) => n * MB));
    expect(server.calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/uploads/up1/complete' });
    expect(final()[0]).toMatchObject({ status: 'done', documentId: 'doc1', loaded: 60 * MB });
  });

  it('resumes from the server offset after a network drop mid-upload', async () => {
    const server = fakeServer({ failPatchAt: [3] });
    const { handle, final } = run([fakeFile('big.bin', 60 * MB)], { retryDelayMs: 1, deps: { api: server as never } });
    await handle.done;
    expect(final()[0].status).toBe('done');
    const patches = server.calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(9); // 8 chunks + the one retry
    expect(patches[2].offset).toBe(16 * MB);
    expect(patches[3].offset).toBe(16 * MB); // retried from the offset the server reported
    expect(server.calls.some((c) => c.method === 'GET')).toBe(true);
  });

  it('adopts the server offset when it answers 409', async () => {
    const server = fakeServer({ mismatchAt: 2 });
    const { handle, final } = run([fakeFile('big.bin', 60 * MB)], { retryDelayMs: 1, deps: { api: server as never } });
    await handle.done;
    expect(final()[0].status).toBe('done');
  });

  it('gives up after repeated failures and reports an error', async () => {
    const server = fakeServer({ failPatchAt: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
    const { handle, final } = run([fakeFile('big.bin', 60 * MB)], { retryDelayMs: 1, maxChunkRetries: 3, deps: { api: server as never } });
    await handle.done;
    expect(final()[0]).toMatchObject({ status: 'error' });
    expect(final()[0].error).toMatch(/could not reach the server/i);
  });

  it('uses the resumable path only above the threshold', async () => {
    const server = fakeServer();
    const multipart = vi.fn().mockResolvedValue([{ id: 'd', title: 't', status: 'pending', deduplicated: false }]);
    await run([fakeFile('mid.bin', 40 * MB)], { deps: { api: server as never, multipart } }).handle.done;
    expect(multipart).toHaveBeenCalledTimes(1);
    expect(server.request).not.toHaveBeenCalled();
  });
});
