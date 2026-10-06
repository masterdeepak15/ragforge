import { describe, it, expect, afterAll } from 'vitest';
import { createTestApp } from './helpers.js';

describe('createTestApp', () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;

  afterAll(async () => {
    await ctx?.close();
  });

  it('serves authenticated API routes at their documented paths', async () => {
    ctx = await createTestApp();
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/knowledge-bases',
      headers: { authorization: `Bearer ${ctx.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('produces deterministic 8-dimension fake embeddings', async () => {
    ctx ??= await createTestApp();
    const a = ctx.fakeEmbed('hello');
    expect(a).toHaveLength(8);
    expect(ctx.fakeEmbed('hello')).toEqual(a);
    expect(ctx.fakeEmbed('world')).not.toEqual(a);
  });
});
