/* Interaction tests — real mouse and keyboard, not the scripting API.
 *
 * The scripting surface can't catch UI-layer bugs like an overlay
 * rebuild destroying the textarea the user is typing into, so these
 * drive the editor the way a person does. */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'out');

// Use whatever Chromium Playwright installed; CHROMIUM_PATH overrides it
// for environments that ship their own build.
const LAUNCH = process.env.CHROMIUM_PATH
  ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] }
  : {};
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.pdf': 'application/pdf' };

function serve(port) {
  return new Promise((r) => {
    http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const f = p.startsWith('/fx/') ? path.join(__dirname, 'fixtures', p.slice(4)) : path.join(ROOT, p);
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    }).listen(port, () => r());
  });
}

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else {
    fail++; failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  \x1b[31m✗\x1b[0m ' + name + (detail ? '\n      ' + detail : ''));
  }
}

function run(cmd) {
  return new Promise((res) => {
    require('child_process').exec(cmd, { maxBuffer: 1 << 24 }, (e, so, se) => res((so || '') + (se || '')));
  });
}

async function main() {
  await serve(8818);
  const browser = await chromium.launch(LAUNCH);
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('http://localhost:8818/index.html');
  await page.waitForFunction(() => window.Paper);
  await page.evaluate(async () => {
    const r = await fetch('/fx/simple.pdf');
    await window.Paper.open(new Uint8Array(await r.arrayBuffer()), 'simple.pdf');
  });
  await page.waitForFunction(() => window.Paper.ready());
  await page.waitForTimeout(1200);

  const box = await (await page.$('.pagewrap')).boundingBox();
  const at = (x, y) => ({ x: box.x + x, y: box.y + y });

  async function saveAs(name) {
    const res = await page.evaluate(() => window.Paper.build());
    fs.writeFileSync(path.join(OUT, name), Buffer.from(res.bytes));
    return await run(`python3 ${path.join(__dirname, 'extract.py')} ${path.join(OUT, name)}`);
  }

  /* ---------------------------------------------- adding a text box */
  console.log('\n\x1b[1madding a new text box\x1b[0m');

  await page.click('.tool[data-tool="text"]');
  const p1 = at(150, 560);
  await page.mouse.click(p1.x, p1.y);
  await page.waitForTimeout(200);

  let ta = await page.$('.editor-box');
  check('clicking with the Text tool opens an editor immediately', !!ta);
  check('the new editor has keyboard focus',
    await page.evaluate(() => document.activeElement && document.activeElement.className === 'editor-box'));
  check('the tool reverts to Edit after placing', await page.evaluate(() => window.Paper.state.tool) === 'select');

  await page.keyboard.type('Hello from a new text box');
  await page.waitForTimeout(150);
  check('typed characters land in the editor, not in tool shortcuts',
    (await page.$eval('.editor-box', e => e.value)) === 'Hello from a new text box',
    await page.$eval('.editor-box', e => JSON.stringify(e.value)));
  check('typing did not switch tools',
    await page.evaluate(() => window.Paper.state.tool) === 'select',
    await page.evaluate(() => window.Paper.state.tool));

  // the editor must survive the debounced preview rebuild
  await page.waitForTimeout(900);
  check('the editor survives a preview rebuild', !!(await page.$('.editor-box')));

  await page.mouse.click(box.x + 560, box.y + 400);   // click away, on empty page area, to commit
  await page.waitForTimeout(1400);
  check('editor closes on commit', !(await page.$('.editor-box')));

  let text = await saveAs('interact-newtext.pdf');
  check('new text box is written to the PDF', /Hello from a new text box/.test(text),
    JSON.stringify(text.slice(0, 160)));

  /* ---------------------------------------------- re-editing it */
  console.log('\n\x1b[1mre-editing an existing text box\x1b[0m');

  const itemBox = await (await page.$('.item')).boundingBox();
  await page.mouse.click(itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2);
  await page.waitForTimeout(300);
  ta = await page.$('.editor-box');
  check('clicking an existing text box reopens the editor', !!ta);
  check('it reopens with the current text',
    ta && (await page.$eval('.editor-box', e => e.value)) === 'Hello from a new text box',
    ta ? await page.$eval('.editor-box', e => JSON.stringify(e.value)) : 'no editor');

  await page.keyboard.press('End');
  await page.keyboard.type(' — edited again');
  await page.mouse.click(box.x + 560, box.y + 400);
  await page.waitForTimeout(1400);

  text = await saveAs('interact-reedit.pdf');
  check('the edit is written through', /edited again/.test(text), JSON.stringify(text.slice(0, 200)));
  check('the old version is not duplicated',
    (text.match(/Hello from a new text box/g) || []).length === 1,
    JSON.stringify((text.match(/Hello from a new text box/g) || []).length));

  /* ---------------------------------------------- dragging it */
  console.log('\n\x1b[1mdragging a text box\x1b[0m');

  const before = await page.evaluate(() => {
    const it = window.Paper.state.edits.items[0];
    return { x: it.x, y: it.y };
  });
  const ib = await (await page.$('.item')).boundingBox();
  await page.mouse.move(ib.x + 10, ib.y + ib.height / 2);
  await page.mouse.down();
  await page.mouse.move(ib.x + 130, ib.y + ib.height / 2 - 60, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(1200);

  const after = await page.evaluate(() => {
    const it = window.Paper.state.edits.items[0];
    return { x: it.x, y: it.y };
  });
  check('dragging moves the box', Math.abs(after.x - before.x) > 50 && Math.abs(after.y - before.y) > 20,
    JSON.stringify({ before, after }));
  check('dragging does not open the editor', !(await page.$('.editor-box')));

  /* ---------------------------------------------- escape on a new box */
  console.log('\n\x1b[1mabandoning an empty text box\x1b[0m');

  const itemsBefore = await page.evaluate(() => window.Paper.state.edits.items.length);
  await page.click('.tool[data-tool="text"]');
  const p2 = at(200, 640);
  await page.mouse.click(p2.x, p2.y);
  await page.waitForTimeout(200);
  check('a second text box opens an editor', !!(await page.$('.editor-box')));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const itemsAfter = await page.evaluate(() => window.Paper.state.edits.items.length);
  check('escaping an empty new box discards it', itemsAfter === itemsBefore,
    itemsBefore + ' -> ' + itemsAfter);

  // and clicking away from an empty one discards it too
  await page.click('.tool[data-tool="text"]');
  await page.mouse.click(at(240, 680).x, at(240, 680).y);
  await page.waitForTimeout(200);
  await page.mouse.click(box.x + 560, box.y + 430);
  await page.waitForTimeout(500);
  check('clicking away from an empty new box discards it',
    (await page.evaluate(() => window.Paper.state.edits.items.length)) === itemsBefore);

  /* ---------------------------------------------- body text still works */
  console.log('\n\x1b[1mediting body text by mouse\x1b[0m');

  const blocks = await page.$$('.blk');
  const target = blocks[0];
  await target.click();
  await page.waitForTimeout(300);
  check('clicking body text opens an editor', !!(await page.$('.editor-box')));
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Rewritten Heading');
  await page.waitForTimeout(150);
  check('body text editor received the typing',
    (await page.$eval('.editor-box', e => e.value)) === 'Rewritten Heading',
    await page.$eval('.editor-box', e => JSON.stringify(e.value)));
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(1400);
  text = await saveAs('interact-body.pdf');
  check('body text edit written to the PDF', /Rewritten Heading/.test(text), JSON.stringify(text.slice(0, 120)));
  check('original heading removed', !/Quarterly Report/.test(text));

  /* ---------------------------------------------- drawing a shape by mouse */
  console.log('\n\x1b[1mdrawing shapes by mouse\x1b[0m');

  const shapesBefore = await page.evaluate(() => window.Paper.state.edits.items.length);
  await page.click('.tool[data-tool="rect"]');
  await page.mouse.move(at(320, 460).x, at(320, 460).y);
  await page.mouse.down();
  await page.mouse.move(at(470, 530).x, at(470, 530).y, { steps: 10 });
  check('a drag ghost is shown while drawing', !!(await page.$('.marquee')));
  await page.mouse.up();
  await page.waitForTimeout(1200);
  check('ghost is cleaned up', !(await page.$('.marquee')));
  const shapesAfter = await page.evaluate(() => window.Paper.state.edits.items.length);
  check('the rectangle was added', shapesAfter === shapesBefore + 1, shapesBefore + ' -> ' + shapesAfter);
  const rect = await page.evaluate(() => window.Paper.state.edits.items.slice(-1)[0]);
  check('rectangle has sensible geometry', rect.kind === 'rect' && rect.w > 100 && rect.h > 40,
    JSON.stringify(rect));

  await page.click('.tool[data-tool="draw"]');
  await page.mouse.move(at(150, 480).x, at(150, 480).y);
  await page.mouse.down();
  for (let i = 0; i < 8; i++) await page.mouse.move(at(150 + i * 12, 480 + (i % 2 ? 18 : -18)).x, at(150 + i * 12, 480 + (i % 2 ? 18 : -18)).y);
  await page.mouse.up();
  await page.waitForTimeout(1200);
  const stroke = await page.evaluate(() => window.Paper.state.edits.items.slice(-1)[0]);
  check('freehand stroke captured', stroke.kind === 'path' && stroke.points.length >= 4,
    JSON.stringify({ kind: stroke.kind, pts: stroke.points && stroke.points.length }));

  text = await saveAs('interact-shapes.pdf');
  const qp = await run(`qpdf --check ${path.join(OUT, 'interact-shapes.pdf')} 2>&1 || true`);
  check('the file with mouse-drawn shapes is valid',
    /No syntax or stream encoding errors found/i.test(qp), qp.split('\n').slice(0, 3).join(' | '));

  check('no page errors throughout', errors.length === 0, errors.slice(0, 4).join(' | '));

  await browser.close();
  console.log('\n' + '─'.repeat(60));
  console.log(`\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
  if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log('  • ' + f)); }
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
