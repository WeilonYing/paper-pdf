/* Headless verification harness.
 *
 * Loads the editor in Chromium, drives it through real edits on each
 * fixture, writes the resulting PDFs out for inspection, and asserts the
 * things that actually matter: the new text is present, the old text is
 * gone from the file (not just hidden), and the page still renders. */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const OUT = path.join(__dirname, 'out');

// Use whatever Chromium Playwright installed; CHROMIUM_PATH overrides it
// for environments that ship their own build.
const LAUNCH = process.env.CHROMIUM_PATH
  ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] }
  : {};
fs.mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.pdf': 'application/pdf', '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream', '.ttf': 'font/ttf'
};

function serve(port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
        res.writeHead(404); res.end('nope'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(port, () => resolve(srv));
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

async function main() {
  const srv = await serve(8813);
  const browser = await chromium.launch(LAUNCH);
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });

  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + e.message));

  await page.goto('http://localhost:8813/index.html');
  await page.waitForFunction(() => window.Paper && window.PDFLib && window.pdfjsLib, null, { timeout: 20000 });

  async function load(file) {
    const bytes = Array.from(fs.readFileSync(path.join(FIX, file)));
    await page.evaluate(async ([b, n]) => {
      await window.Paper.open(new Uint8Array(b), n);
    }, [bytes, file]);
    await page.waitForFunction(() => window.Paper.ready(), null, { timeout: 30000 });
  }

  // Track what this run produced, so the validity sweep below covers
  // exactly these files and the assertion count stays deterministic
  // regardless of what other suites left in tests/out.
  const produced = [];
  async function build(outName) {
    const res = await page.evaluate(() => window.Paper.build());
    const buf = Buffer.from(res.bytes);
    fs.writeFileSync(path.join(OUT, outName), buf);
    produced.push(outName);
    return { buf, report: res.report };
  }

  /* ---------------------------------------------- simple.pdf */
  console.log('\n\x1b[1msimple.pdf — standard fonts, no embedding\x1b[0m');
  await load('simple.pdf');
  let blocks = await page.evaluate(() => window.Paper.blocks(0));
  check('extracts text blocks', blocks.length >= 5, 'got ' + blocks.length);
  const heading = blocks.find(b => b.text.includes('Quarterly Report'));
  check('finds the heading', !!heading, JSON.stringify(blocks.slice(0, 3).map(b => b.text)));
  const para = blocks.find(b => b.text.includes('quick brown fox'));
  check('joins wrapped lines into one paragraph', !!para && para.lines >= 3,
    para ? para.lines + ' lines: ' + JSON.stringify(para.text.slice(0, 90)) : 'not found');
  check('paragraph text reads continuously', !!para && /fox jumps over the lazy dog while/.test(para.text),
    para && para.text.slice(0, 120));
  const centred = blocks.find(b => b.text.includes('Centred footer'));
  check('detects centred alignment', centred && centred.align === 'center', centred && centred.align);
  const right = blocks.find(b => b.text.includes('Page 1 of 1'));
  check('finds the right-aligned footer', !!right);

  await page.evaluate((id) => window.Paper.setText(id, 'Annual Review'), heading.id);
  await page.evaluate((id) => window.Paper.setText(id,
    'The nimble auburn fox vaults across the indolent hound while the assembly of owls weighs the case for nocturnal rule. Deliberations proved inconclusive.'), para.id);
  await page.evaluate((id) => window.Paper.remove(id), right.id);
  let r = await build('simple-edited.pdf');
  let text = await pdftotext('simple-edited.pdf');
  check('new heading is in the output', /Annual Review/.test(text));
  check('old heading is gone from the file', !/Quarterly Report/.test(text));
  check('replacement paragraph present', /nimble auburn fox/.test(text));
  check('old paragraph text removed', !/quick brown fox/.test(text));
  check('deleted line is really gone', !/Page 1 of 1/.test(text));
  check('untouched text survives', /Office of Unremarkable Findings/.test(text));
  check('monospaced line survives', /monospaced_value = 42/.test(text));
  check('reported a font reuse or substitution', r.report.painted >= 2, JSON.stringify(r.report));

  /* ---------------------------------------------- embedded.pdf */
  console.log('\n\x1b[1membedded.pdf — subset TrueType, the font-reuse path\x1b[0m');
  await load('embedded.pdf');
  blocks = await page.evaluate(() => window.Paper.blocks(0));
  const eh = blocks.find(b => b.text.includes('Embedded Subset Heading'));
  check('reads text out of a subset font', !!eh, JSON.stringify(blocks.map(b => b.text.slice(0, 40))));
  check('knows the font is embedded', eh && eh.embedded === true);
  await page.evaluate((id) => window.Paper.setText(id, 'Embedded Subset Edited'), eh.id);
  r = await build('embedded-edited.pdf');
  check('reused the original font (pixel-perfect path)', r.report.reused >= 1, JSON.stringify(r.report));
  text = await pdftotext('embedded-edited.pdf');
  check('edited heading present', /Embedded Subset Edited/.test(text));
  check('original heading gone', !/Embedded Subset Heading/.test(text));

  // now force a character the subset cannot possibly contain
  await page.evaluate(() => {
    const b = window.Paper.blocks(0).find(x => x.text.includes('Embedded Subset'));
    window.Paper.setText(b.id, 'Heading with 日本語 characters');
  });
  r = await build('embedded-fallback.pdf');
  check('falls back when the subset lacks a glyph', r.report.substituted >= 1, JSON.stringify(r.report));

  /* ---------------------------------------------- gradient.pdf */
  console.log('\n\x1b[1mgradient.pdf — the case whiteout would ruin\x1b[0m');
  await load('gradient.pdf');
  blocks = await page.evaluate(() => window.Paper.blocks(0));
  const gh = blocks.find(b => b.text.includes('Text On A Gradient'));
  check('finds text drawn over a gradient', !!gh);
  const rot = blocks.find(b => b.text.includes('ROTATED'));
  check('finds rotated text', !!rot);
  const cell = blocks.find(b => b.text.includes('Northern Territories'));
  check('finds text in a shaded table cell', !!cell);
  await page.evaluate((id) => window.Paper.setText(id, 'Repainted On A Gradient'), gh.id);
  await page.evaluate((id) => window.Paper.setText(id, 'Southern Territories'), cell.id);
  check('table cells split into separate blocks', !/412,900/.test(cell.text), JSON.stringify(cell.text));
  await page.evaluate((id) => window.Paper.setText(id, 'ROTATED FINAL STAMP'), rot.id);
  await build('gradient-edited.pdf');
  text = await pdftotext('gradient-edited.pdf');
  check('gradient heading replaced', /Repainted On A Gradient/.test(text));
  check('table cell replaced', /Southern Territories/.test(text));
  check('rotated text replaced', /ROTATED FINAL STAMP/.test(text));
  check('neighbouring cells untouched', /412,900/.test(text) && /Coastal Districts/.test(text));

  /* ---------------------------------------------- flowing.pdf */
  console.log('\n\x1b[1mflowing.pdf — justified paragraphs and tables\x1b[0m');
  await load('flowing.pdf');
  blocks = await page.evaluate(() => window.Paper.blocks(0));
  const justified = blocks.filter(b => b.align === 'justify');
  check('detects justified paragraphs', justified.length >= 1,
    'aligns seen: ' + JSON.stringify(blocks.map(b => b.align)));
  const longP = blocks.filter(b => b.lines >= 4).sort((a, b) => b.lines - a.lines)[0];
  check('groups a multi-line paragraph', !!longP && longP.lines >= 4, longP && longP.lines + ' lines');
  await page.evaluate((id) => window.Paper.setText(id,
    'Rewritten body copy that should re-wrap to the original column width and stay justified across every line except the last one, which is why this sentence keeps going for a while longer than strictly necessary.'), longP.id);
  r = await build('flowing-edited.pdf');
  text = await pdftotext('flowing-edited.pdf');
  check('rewrapped paragraph present', /Rewritten body copy/.test(text));
  check('table survived the edit', /Perches/.test(text));

  /* ---------------------------------------------- latex.pdf */
  console.log('\n\x1b[1mlatex.pdf — Type1 subsets, TJ-driven word spacing\x1b[0m');
  await load('latex.pdf');
  blocks = await page.evaluate(() => window.Paper.blocks(0));
  const lp = blocks.find(b => b.text.includes('quick brown fox'));
  check('recovers word spaces from TJ adjustments', !!lp && /quick brown fox jumps/.test(lp.text),
    lp ? JSON.stringify(lp.text.slice(0, 100)) : JSON.stringify(blocks.map(b => b.text.slice(0, 50))));
  const lh = blocks.find(b => b.text.includes('Nocturnal Committees'));
  check('finds the section heading', !!lh);
  if (lh) {
    await page.evaluate((id) => window.Paper.setText(id, 'A Study of Diurnal Committees'), lh.id);
    r = await build('latex-edited.pdf');
    text = await pdftotext('latex-edited.pdf');
    check('LaTeX heading replaced', /Diurnal Committees/.test(text));
    check('old LaTeX heading gone', !/Nocturnal Committees/.test(text));
    check('body text untouched', /parliament of owls/.test(text));
  }

  /* ---------------------------------------------- form.pdf */
  console.log('\n\x1b[1mform.pdf — AcroForm fields\x1b[0m');
  await load('form.pdf');
  await page.waitForTimeout(700);
  const fieldCount = await page.evaluate(() => document.querySelectorAll('#formFields input').length);
  check('surfaces form fields in the UI', fieldCount >= 3, 'found ' + fieldCount);
  await page.evaluate(() => {
    window.Paper.setField('fullName', 'Ada Lovelace');
    window.Paper.setField('email', 'ada@example.org');
    window.Paper.setField('subscribe', true);
  });
  await build('form-filled.pdf');
  text = await pdftotext('form-filled.pdf');
  check('field values written into the file', /Ada Lovelace/.test(text), JSON.stringify(text.slice(0, 200)));

  /* ---------------------------------------------- cjk.pdf */
  console.log('\n\x1b[1mcjk.pdf — Identity-H CID font\x1b[0m');
  await load('cjk.pdf');
  blocks = await page.evaluate(() => window.Paper.blocks(0));
  const jp = blocks.find(b => /日本語/.test(b.text));
  check('decodes CID text via ToUnicode', !!jp, JSON.stringify(blocks.map(b => b.text.slice(0, 24))));
  if (jp) {
    // every character here already appears in the document, so it is
    // guaranteed to be present in the embedded subset
    await page.evaluate((id) => window.Paper.setText(id, 'テキスト編集の日本語'), jp.id);
    r = await build('cjk-edited.pdf');
    check('reuses the embedded subset for Japanese', r.report.reused >= 1, JSON.stringify(r.report));
    text = await pdftotext('cjk-edited.pdf');
    check('Japanese replacement present', /テキスト編集の日本語/.test(text), JSON.stringify(text.slice(0, 120)));
    check('original Japanese heading gone', !/日本語のテキスト編集/.test(text));

    // and a character the subset cannot contain must degrade, not corrupt
    await page.evaluate((id) => window.Paper.setText(id, '置換された文字'), jp.id);
    r = await build('cjk-missing-glyph.pdf');
    check('refuses to reuse a subset missing the glyph', r.report.substituted >= 1, JSON.stringify(r.report));
  }

  /* ---------------------------------------------- type3.pdf */
  console.log('\n\x1b[1mtype3.pdf — TeX bitmap fonts with a custom FontMatrix\x1b[0m');
  await load('type3.pdf');
  blocks = await page.evaluate(() => window.Paper.blocks(0));
  const t3 = blocks.find(b => b.text.includes('quick brown fox'));
  check('reads Type 3 text', !!t3, JSON.stringify(blocks.map(b => b.text.slice(0, 40))));
  check('Type 3 advances use the FontMatrix, not /1000',
    !!t3 && (t3.x1 - t3.x0) > 300 && (t3.x1 - t3.x0) < 500,
    t3 && 'block width ' + (t3.x1 - t3.x0).toFixed(1));
  const t3h = blocks.find(b => b.text.includes('Nocturnal Committees'));
  if (t3h) {
    await page.evaluate((id) => window.Paper.setText(id, 'A Study of Diurnal Committees'), t3h.id);
    r = await build('type3-edited.pdf');
    check('Type 3 text is substituted, never reused', r.report.substituted >= 1, JSON.stringify(r.report));
    text = await pdftotext('type3-edited.pdf');
    check('Type 3 replacement written', /Diurnal Committees/.test(text), JSON.stringify(text.slice(0, 160)));
  }

  /* ---------------------------------------------- shapes & images */
  console.log('\n\x1b[1mshapes, images and new text boxes\x1b[0m');
  await load('simple.pdf');
  const png = fs.readFileSync(path.join(__dirname, 'stamp.png')).toString('base64');
  await page.evaluate((b64) => {
    window.Paper.addItem({ type: 'shape', kind: 'rect', page: 0, x: 300, y: 300, w: 160, h: 70,
      stroke: [0.8, 0.1, 0.1], fill: [1, 0.95, 0.6], lineWidth: 2 });
    window.Paper.addItem({ type: 'shape', kind: 'ellipse', page: 0, x: 100, y: 300, w: 120, h: 60,
      stroke: [0.1, 0.3, 0.8], fill: null, lineWidth: 1.5 });
    window.Paper.addItem({ type: 'shape', kind: 'line', page: 0, x1: 100, y1: 260, x2: 460, y2: 260,
      stroke: [0, 0, 0], lineWidth: 1 });
    window.Paper.addItem({ type: 'shape', kind: 'path', page: 0,
      points: [[120, 180], [150, 210], [180, 170], [220, 205], [260, 175]],
      stroke: [0.05, 0.05, 0.3], lineWidth: 1.8 });
    window.Paper.addItem({ type: 'text', page: 0, x: 310, y: 330, width: 150,
      text: 'Stamped annotation added on top', style: { size: 11, color: [0.7, 0, 0], align: 'left' } });
    window.Paper.addItem({ type: 'image', page: 0, x: 330, y: 150, w: 120, h: 90,
      mime: 'image/png', b64: b64 });
  }, png);
  r = await build('annotated.pdf');
  text = await pdftotext('annotated.pdf');
  check('new text box written', /Stamped annotation/.test(text));
  check('no warnings from shapes or the image', r.report.warnings.length === 0, JSON.stringify(r.report.warnings));
  const objs = (await run(`qpdf --show-npages ${path.join(OUT, 'annotated.pdf')}`)).trim();
  check('annotated file is structurally valid', objs === '1', objs);

  /* ---------------------------------------------- undo */
  console.log('\n\x1b[1mundo / redo\x1b[0m');
  await load('simple.pdf');
  const hid = (await page.evaluate(() => window.Paper.blocks(0)))
    .find(b => b.text.includes('Quarterly Report')).id;
  await page.evaluate((id) => window.Paper.setText(id, 'Changed'), hid);
  await page.evaluate(() => window.Paper.undo());
  r = await build('undone.pdf');
  text = await pdftotext('undone.pdf');
  check('undo restores the original text', /Quarterly Report/.test(text) && !/Changed/.test(text));

  /* ---------------------------------------------- validity sweep */
  console.log('\n\x1b[1mstructural validity of every output\x1b[0m');
  for (const f of produced) {
    const out = await run(`qpdf --check ${path.join(OUT, f)} 2>&1 || true`);
    const ok = /No syntax or stream encoding errors found/i.test(out);
    check(f + ' passes qpdf --check', ok, ok ? '' : out.split('\n').filter(l => /error|damaged|WARNING/i.test(l)).slice(0, 4).join(' | '));
  }

  check('no uncaught errors in the page', consoleErrors.length === 0,
    consoleErrors.slice(0, 5).join(' | '));

  await browser.close();
  srv.close();

  console.log('\n' + '─'.repeat(60));
  console.log(`\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log('  • ' + f));
  }
  process.exit(fail ? 1 : 0);
}

function run(cmd) {
  return new Promise((res) => {
    require('child_process').exec(cmd, { maxBuffer: 1 << 24 }, (e, so, se) => res((so || '') + (se || '')));
  });
}
// PyMuPDF rather than pdftotext: it recovers rotated and transformed
// text correctly, which is exactly what we need to verify here.
async function pdftotext(name) {
  return await run(`python3 ${path.join(__dirname, 'extract.py')} ${path.join(OUT, name)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
