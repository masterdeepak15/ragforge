import { describe, it, expect, afterEach } from 'vitest';
import { createTestApp, type TestApp } from '../test/helpers.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const ADMIN = { username: 'Deepak', email: 'deepak@example.com', password: 'correct-horse-battery' };

describe('POST /api/setup/init', () => {
  it('returns the new admin user together with the token, so the app can sign in straight away', async () => {
    t = await createTestApp({ skipSetup: true });
    expect((await t.app.inject({ method: 'GET', url: '/api/setup/status' })).json().isInitialized).toBe(false);

    const res = await t.app.inject({ method: 'POST', url: '/api/setup/init', payload: ADMIN });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBeTruthy();
    expect(body.user).toMatchObject({ email: 'deepak@example.com', username: 'Deepak', role: 'admin' });
    expect(body.user.id).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('correct-horse-battery');
    expect(JSON.stringify(body)).not.toMatch(/password_?hash/i);

    // the token really belongs to that user
    const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${body.token}` } });
    expect(me.json()).toMatchObject({ id: body.user.id, email: 'deepak@example.com' });
  });

  it('marks the system as set up and refuses a second setup', async () => {
    t = await createTestApp({ skipSetup: true });
    await t.app.inject({ method: 'POST', url: '/api/setup/init', payload: ADMIN });
    expect((await t.app.inject({ method: 'GET', url: '/api/setup/status' })).json().isInitialized).toBe(true);
    const again = await t.app.inject({ method: 'POST', url: '/api/setup/init', payload: { ...ADMIN, email: 'other@example.com' } });
    expect(again.statusCode).toBe(409);
  });

  it('lets the admin sign in with the password they chose', async () => {
    t = await createTestApp({ skipSetup: true });
    await t.app.inject({ method: 'POST', url: '/api/setup/init', payload: ADMIN });
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: ADMIN.email, password: ADMIN.password } });
    expect(login.statusCode).toBe(200);
    expect(login.json().user).toMatchObject({ email: ADMIN.email, role: 'admin' });
  });
});
