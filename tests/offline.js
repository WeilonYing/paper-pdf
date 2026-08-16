/* Verifies the app works when index.html is opened straight from disk.
 *
 * A file:// page can't spawn a worker from a file:// URL and can't
 * fetch() sibling files, so this exercises a genuinely different code
 * path from the other suites — and one that's easy to break without
 * noticing, because everything still works over HTTP. */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const LAUNCH = process.env.CHROMIUM_PATH
  ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] }
  : {};

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else {
    fail++; failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  \x1b[31m✗\x1b[0m ' + name + (detail ? '\n      ' + detail : ''));
  }
}

async function main() {
  // Note: no --allow-file-access-from-files. If that flag were set the
  // test would pass for the wrong reason.
  const browser = await chromium.launch(LAUNCH);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  console.log('\n\x1b[1mopening index.html from disk (file://)\x1b[0m');

  await page.goto('file://' + path.join(ROOT, 'index.html'));
  await page.waitForFunction(() => window.Paper, null, { timeout: 20000 });
  check('the app boots from file://', (await page.evaluate(() => location.protocol)) === 'file:');

  async function open(name) {
    const bytes = Array.from(fs.readFileSync(path.join(FIX, name)));
    await page.evaluate(async ([b, n]) => { await window.Paper.open(new Uint8Array(b), n); }, [bytes, name]);
    await page.waitForFunction(() => window.Paper.ready(), null, { timeout: 30000 });
    await page.waitForTimeout(2500);
  }

  // Is the canvas actually painted, or silently blank? A missing worker
  // shows up here and nowhere else.
  async function inkOnPage() {
    return await page.evaluate(() => {
      const c = document.querySelector('.pagewrap canvas');
      if (!c) return -1;
      const d = c.getContext('2d').getImageData(0, 0, c.width, Math.min(c.height, 700)).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4 * 7) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) n++;
      return n;
    });
  }

  await open('simple.pdf');
  const blocks = await page.evaluate(() => window.Paper.blocks(0).length);
  check('text is extracted with the worker on the main thread', blocks >= 5, 'blocks: ' + blocks);
  const ink = await inkOnPage();
  check('the page actually renders', ink > 100, 'non-white samples: ' + ink);

  await open('cjk.pdf');
  const jp = await page.evaluate(() => window.Paper.blocks(0).some(b => /日本語/.test(b.text)));
  check('embedded CJK subsets work', jp);
  check('the CJK page renders', (await inkOnPage()) > 50);

  // The case that actually needs the packed data: a predefined CMap with a
  // font that isn't embedded. Without it this page comes out blank.
  await open('cmap-predefined.pdf');
  const cjkInk = await page.evaluate(() => {
    const c = document.querySelector('.pagewrap canvas');
    if (!c || !c.width) return -1;
    const top = Math.round(c.height * 0.09), bot = Math.round(c.height * 0.13);
    const d = c.getContext('2d').getImageData(0, top, c.width, bot - top).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 180) n++;
    return n;
  });
  check('predefined CJK CMaps resolve from the packed data', cjkInk > 200,
    'glyph pixels: ' + cjkInk);

  await open('gradient.pdf');
  const id = (await page.evaluate(() => window.Paper.blocks(0)))
    .find(b => b.text.includes('Text On A Gradient')).id;
  await page.evaluate((i) => window.Paper.setText(i, 'Edited from a file page'), id);
  const res = await page.evaluate(() => window.Paper.build());
  const out = path.join(__dirname, 'out', 'offline-edited.pdf');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(res.bytes));
  check('an edit round-trips offline', res.report.painted >= 1, JSON.stringify(res.report));

  const text = await new Promise((r) => require('child_process').exec(
    `python3 ${path.join(__dirname, 'extract.py')} ${out}`, (e, so) => r(so || '')));
  check('the edit is in the saved file', /Edited from a file page/.test(text));
  check('the original text is gone', !/Text On A Gradient/.test(text));

  check('no console errors', errors.length === 0, errors.slice(0, 4).join(' | '));

  await browser.close();
  console.log('\n' + '─'.repeat(60));
  console.log(`\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
  if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log('  • ' + f)); }
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
