// Explicitly invoked, read-only research. Captures public pages locally; output is gitignored.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const out = 'output/playwright/research';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(25000);
let events = [];
page.on('response', async response => {
  if (response.request().method() !== 'POST' || !response.url().startsWith('https://www.cipa.co.bw/')) return;
  try {
    const data = await response.json();
    events.push({ status: response.status(), keys: Object.keys(data), elapsedMs: data.elapsedMs, state: data.state });
  } catch { /* not a UI JSON response */ }
});
async function act(action) {
  const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes('/ui/'), { timeout: 25000 });
  await action();
  await (await response).finished();
  await page.waitForLoadState('networkidle');
  await page.getByRole('main').waitFor();
}
async function capture(name) {
  await page.locator('[role="main"] .cat-loading-component:visible').first().waitFor({ state: 'hidden' });
  await writeFile(`${out}/${name}.html`, await page.getByRole('main').evaluate(el => el.outerHTML));
  await writeFile(`${out}/${name}.txt`, await page.getByRole('main').innerText());
  console.log(name, (await page.getByRole('main').innerText()).slice(0, 350));
}
try {
  for (const [slug, query] of [['sefalana', 'Sefalana Cash & Carry'], ['choppies', 'Choppies Enterprises']]) {
    await page.goto('https://www.cipa.co.bw/master/ui/start/CIPARegisterSearch');
    await page.getByRole('textbox', { name: 'Name or number' }).fill(query);
    await act(() => page.getByRole('button', { name: 'Search', exact: true }).click());
    await page.locator('.search-result').first().waitFor();
    await capture(`${slug}-search`);
    await page.locator('.search-result').first().getByRole('link').first().click();
    await page.getByRole('tab', { name: 'General Details', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'General Details', exact: true }).waitFor();
    await page.locator('[role="main"] .cat-loading-component:visible').first().waitFor({ state: 'hidden' });
    const names = await page.getByRole('tab').allTextContents();
    await writeFile(`${out}/${slug}-tabs.json`, JSON.stringify(names));
    for (const name of names.map(n => n.trim()).filter(n => !['Company Details', 'Visualisation'].includes(n)).sort((a,b) => Number(a === 'Filings') - Number(b === 'Filings'))) {
      if (name !== 'General Details') await act(() => page.getByRole('tab', { name, exact: true }).click());
      const panel = page.getByRole('tabpanel', { name, exact: true });
      await panel.getByRole('heading', { name, exact: true }).first().waitFor().catch(() => {});
      // Expand only read-only disclosure controls, never purchases/documents.
      for (let i = 0; i < 30; i++) {
        const candidate = panel.locator('[aria-expanded="false"]').first();
        if (!await candidate.count()) break;
        const label = (await candidate.getAttribute('aria-label')) || (await candidate.innerText());
        if (!/show|more details/i.test(label)) break;
        await candidate.click();
        await page.waitForLoadState('networkidle');
      }
      await capture(`${slug}-${name.toLowerCase().replaceAll(' ', '-')}`);
    }
  }
  await writeFile(`${out}/responses.json`, JSON.stringify(events));
} finally { await browser.close(); }
