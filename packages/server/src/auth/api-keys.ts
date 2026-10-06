import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type { DatabaseContext } from '../db/connection.js';

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopeKbIds: string[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface VerifiedKey {
  id: string;
  /** `null` = every knowledge base. */
  scopeKbIds: string[] | null;
}

const KEY_PREFIX = 'rf_';
const MAX_KEY_LENGTH = 200;
const LAST_USED_GRANULARITY_MS = 60_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const iso = (ms: unknown) => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());

/**
 * API keys for non-interactive clients (MCP). Only a SHA-256 of the key is stored, so a database
 * leak does not reveal usable keys; the full key is returned exactly once, by `create`.
 */
export class ApiKeyService {
  private readonly now: () => number;

  constructor(private db: DatabaseContext, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  async create(input: { name: string; scopeKbIds: string[] | null; createdBy: string }): Promise<{ id: string; key: string; prefix: string }> {
    const key = KEY_PREFIX + randomBytes(32).toString('base64url');
    const id = randomUUID();
    await this.db.client.execute({
      sql: `INSERT INTO api_keys (id, name, key_hash, key_prefix, scope_kb_ids, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, input.name, sha256(key), key.slice(0, 8), input.scopeKbIds ? JSON.stringify(input.scopeKbIds) : null, input.createdBy],
    });
    return { id, key, prefix: key.slice(0, 8) };
  }

  /** Returns the key's identity and scope, or null for unknown, malformed or revoked keys. */
  async verify(rawKey: string): Promise<VerifiedKey | null> {
    if (typeof rawKey !== 'string' || !rawKey.startsWith(KEY_PREFIX) || rawKey.length > MAX_KEY_LENGTH) return null;
    const hash = sha256(rawKey);
    const rs = await this.db.client.execute({
      sql: `SELECT id, key_hash, scope_kb_ids, last_used_at, revoked_at FROM api_keys WHERE key_hash = ?`,
      args: [hash],
    });
    const row = rs.rows[0] as any;
    if (!row || row.revoked_at !== null) return null;
    if (!timingSafeEqual(Buffer.from(String(row.key_hash)), Buffer.from(hash))) return null;

    const now = this.now();
    if (row.last_used_at === null || now - Number(row.last_used_at) >= LAST_USED_GRANULARITY_MS) {
      await this.db.client.execute({ sql: `UPDATE api_keys SET last_used_at = ? WHERE id = ?`, args: [now, row.id] });
    }
    return { id: row.id as string, scopeKbIds: row.scope_kb_ids ? JSON.parse(row.scope_kb_ids as string) : null };
  }

  /** Revokes a key; returns false when it does not exist. Revoking twice is harmless. */
  async revoke(id: string): Promise<boolean> {
    const exists = await this.db.client.execute({ sql: `SELECT id FROM api_keys WHERE id = ?`, args: [id] });
    if (!exists.rows[0]) return false;
    await this.db.client.execute({ sql: `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, args: [this.now(), id] });
    return true;
  }

  async list(): Promise<ApiKeyView[]> {
    const rs = await this.db.client.execute(
      `SELECT id, name, key_prefix, scope_kb_ids, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC, id`
    );
    return (rs.rows as any[]).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      prefix: r.key_prefix as string,
      scopeKbIds: r.scope_kb_ids ? JSON.parse(r.scope_kb_ids as string) : null,
      createdAt: r.created_at as string,
      lastUsedAt: iso(r.last_used_at),
      revokedAt: iso(r.revoked_at),
    }));
  }
}
