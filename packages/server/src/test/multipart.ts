import { randomUUID } from 'crypto';
import type { TestApp } from './helpers.js';

export interface MultipartPart {
  name: string;
  value?: string;
  filename?: string;
  contentType?: string;
  data?: Buffer;
}

export function multipartBoundary(): string {
  return `----ragforge${randomUUID()}`;
}

export function multipartHead(boundary: string, p: MultipartPart): Buffer {
  let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
  if (p.filename !== undefined) head += `; filename="${p.filename}"`;
  head += '\r\n';
  if (p.filename !== undefined) head += `Content-Type: ${p.contentType ?? 'application/octet-stream'}\r\n`;
  head += '\r\n';
  return Buffer.from(head, 'utf8');
}

/** Builds an in-memory multipart/form-data body (small payloads only). */
export function buildMultipart(parts: MultipartPart[]): { payload: Buffer; headers: Record<string, string> } {
  const boundary = multipartBoundary();
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(multipartHead(boundary, p), p.data ?? Buffer.from(p.value ?? ''), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

export async function createKb(t: TestApp, name = 'kb'): Promise<string> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/knowledge-bases',
    headers: { authorization: `Bearer ${t.token}` },
    payload: { name },
  });
  if (res.statusCode >= 300) throw new Error(`createKb failed: ${res.statusCode} ${res.body}`);
  return res.json().id;
}
