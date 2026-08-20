import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

await mkdir('docs/qa', { recursive: true });
const browser = await chromium.launch({ headless: true });

const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await desktop.goto('http://127.0.0.1:4310', { waitUntil: 'networkidle' });
await desktop.getByText('活动引流渠道效果复盘', { exact: true }).click();
await desktop.getByRole('heading', { name: '活动引流渠道效果复盘' }).waitFor();
await desktop.waitForTimeout(300);
await desktop.screenshot({ path: 'docs/qa/dashboard-desktop.png', fullPage: false });

const mobile = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1 });
await mobile.goto('http://127.0.0.1:4310', { waitUntil: 'networkidle' });
await mobile.screenshot({ path: 'docs/qa/dashboard-mobile.png', fullPage: true });

await browser.close();
