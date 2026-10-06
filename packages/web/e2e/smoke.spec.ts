import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const OLLAMA = 'http://127.0.0.1:11999';
const ADMIN = { username: 'Deepak', email: 'e2e@example.com', password: 'correct-horse-battery' };

const FILES = [
  { name: 'zeppelin.txt', body: 'The zeppelin hangar in Friedrichshafen was enormous and cold. Airship engineers gathered there every winter.' },
  { name: 'payments-runbook.md', body: '# Payments runbook\n\nIf the payments queue backs up, page the on-call engineer and inspect the dead letter queue first.' },
  { name: 'on-call.txt', body: 'On-call rotation: weeks alternate between the platform team and the payments team every Monday morning.' },
];

let token = '';
const authz = () => ({ Authorization: `Bearer ${token}` });

async function mcp(request: APIRequestContext, key: string, name: string, args: Record<string, unknown> = {}) {
  const res = await request.post('/mcp', {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  return { status: res.status(), body: await res.json() };
}

async function signIn(page: Page) {
  const me = await page.request.get('/api/auth/me', { headers: authz() });
  const user = await me.json();
  await page.addInitScript(([t, u]) => {
    localStorage.setItem('ragforge_token', t as string);
    localStorage.setItem('ragforge_user', JSON.stringify(u));
  }, [token, user]);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  const init = await request.post('/api/setup/init', { data: ADMIN });
  expect(init.status()).toBe(200);
  token = (await init.json()).token;
});

test('upload, live indexing, search, MCP access, themes and deletion', async ({ page, request }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await signIn(page);

  // --- connect an AI provider through Settings (a regression test for the broken Add provider form)
  await page.goto('/settings');
  await expect(page.getByText('No AI provider yet')).toBeVisible();
  await page.getByRole('button', { name: 'Add provider' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add AI provider' });
  await dialog.getByLabel('Server address').fill(OLLAMA);
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await expect(dialog.getByText(/Connected\. Found 1 model\./)).toBeVisible();
  await dialog.getByRole('button', { name: 'Add provider' }).click();
  const providerRow = page.getByRole('row', { name: /Ollama \(local\)/ });
  await expect(providerRow).toContainText('Answers');
  await expect(providerRow).toContainText('Indexing');

  // --- create a knowledge base through the UI
  await page.goto('/knowledge-bases');
  await expect(page.getByText('No knowledge bases yet')).toBeVisible();
  await page.getByRole('button', { name: 'New knowledge base' }).first().click();
  await page.getByLabel('Name').fill('E2E handbook');
  await page.getByRole('button', { name: 'Create knowledge base' }).click();
  await expect(page.getByRole('heading', { name: 'E2E handbook' })).toBeVisible();
  const kbUrl = page.url();

  // --- upload three files; indexing progress arrives live (no manual refresh)
  await page.getByLabel('Choose files').setInputFiles(FILES.map((f) => ({ name: f.name, mimeType: 'text/plain', buffer: Buffer.from(f.body) })));
  for (const f of FILES) {
    await expect(page.getByRole('row').filter({ hasText: f.name }).filter({ hasText: 'Ready' })).toBeVisible();
  }
  await expect(page.getByText(/3 documents ready/)).toBeVisible();

  // --- inspect what was indexed
  await page.getByRole('button', { name: 'View chunks of zeppelin.txt' }).click();
  await expect(page.getByRole('dialog')).toContainText('zeppelin hangar');
  await page.keyboard.press('Escape');

  // --- deep link survives a refresh
  await page.reload();
  await expect(page.getByRole('heading', { name: 'E2E handbook' })).toBeVisible();
  expect(page.url()).toBe(kbUrl);

  // --- create an API key through the UI and use it against /mcp
  await page.goto('/connect');
  await page.getByRole('button', { name: 'Create API key' }).first().click();
  await page.getByLabel('Name').fill('e2e client');
  await page.getByRole('button', { name: 'Create key' }).click();
  const key = await page.getByLabel('API key', { exact: true }).inputValue();
  expect(key).toMatch(/^rf_/);
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText(/Connected\. This key can see 1 knowledge base\./)).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('row', { name: /e2e client/ })).toBeVisible();

  const search = await mcp(request, key, 'search_knowledge', { query: 'zeppelin hangar airship' });
  expect(search.status).toBe(200);
  const hits = JSON.parse(search.body.result.content[0].text).results;
  expect(hits[0]).toMatchObject({ document_title: 'zeppelin.txt' });
  expect(hits[0].text).toContain('zeppelin');

  const other = await mcp(request, key, 'search_knowledge', { query: 'payments queue on-call' });
  expect(JSON.parse(other.body.result.content[0].text).results.map((r: { document_title: string }) => r.document_title)).toContain('payments-runbook.md');

  // --- revoking takes effect immediately
  await page.getByRole('button', { name: 'Revoke e2e client' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke key' }).click();
  await expect(page.getByRole('row', { name: /e2e client/ })).toContainText('Revoked');
  expect((await mcp(request, key, 'list_knowledge_bases')).status).toBe(401);

  // --- theme choice persists across reloads
  await page.getByRole('button', { name: 'Dark theme' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Light theme' }).click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);

  // --- command palette
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Search or jump to…').fill('E2E');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'E2E handbook' })).toBeVisible();

  // --- delete a document with an in-app confirmation
  await page.getByRole('checkbox', { name: 'Select on-call.txt' }).check();
  await page.getByRole('button', { name: 'Delete selected' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete document' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'on-call.txt' })).toHaveCount(0);
  await expect(page.getByText(/2 documents ready/)).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('an unreadable PDF fails with a clear reason and can be retried', async ({ page }) => {
  await signIn(page);
  await page.goto('/knowledge-bases');
  await page.getByRole('table', { name: 'Knowledge bases' }).getByRole('link', { name: 'E2E handbook' }).click();
  await page.getByLabel('Choose files').setInputFiles([{ name: 'scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not really a pdf') }]);
  const row = page.getByRole('row').filter({ hasText: 'scan.pdf' }).filter({ hasText: 'Failed' }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText(/Could not read pdf/i);
  await expect(page.getByRole('button', { name: 'Retry scan.pdf' })).toBeVisible();
});
