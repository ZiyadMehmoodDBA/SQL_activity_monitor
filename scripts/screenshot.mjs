import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'docs', 'assets', 'dashboard.png');

const browser = await puppeteer.launch({
  headless: true,
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 2 });

await page.goto('http://localhost:3000', { waitUntil: 'networkidle2', timeout: 15000 });

// Wait for React to mount
await page.waitForSelector('#root', { timeout: 10000 });
await new Promise(r => setTimeout(r, 2000));

// Save connect modal screenshot
await page.screenshot({ path: OUT, fullPage: false });
console.log('Screenshot saved (modal):', OUT);

// Also capture empty dashboard by dismissing the modal
await page.keyboard.press('Escape');
await new Promise(r => setTimeout(r, 800));

const outEmpty = OUT.replace('dashboard.png', 'dashboard-empty.png');
await page.screenshot({ path: outEmpty, fullPage: false });
console.log('Screenshot saved (empty dashboard):', outEmpty);

await browser.close();
