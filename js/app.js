/* ------------------------------------------------------------------
 * app.js — the editor itself.
 *
 * The document is never mutated in place. Every change is recorded as
 * an edit against the *original* bytes, and the preview you see is the
 * result of replaying all of them. That means undo is exact, the file
 * can't drift through repeated re-encoding, and what you see on screen
 * is a real render of the PDF you'll get when you press Save.
 * ------------------------------------------------------------------ */
(function () {
  'use strict';

  var pdfjsLib = window.pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  /* ------------------------------------------------------------------
   * CMap and standard-font data
   *
   * pdf.js normally fetches these from ~185 loose files. We pack them
   * into one generated script instead (vendor/pdfjs-data.js) and hand
   * pdf.js factories that read from it, which keeps the repo to a
   * handful of files and makes the app work when index.html is opened
   * straight from disk — a file:// page can't fetch its own siblings.
   *
   * The data is loaded lazily, on the first CMap or standard-font
   * request. Most documents never make one: embedded fonts need no CMap
   * data, and the standard 14 are substituted from system fonts. It's
   * predefined CJK CMaps (Adobe-Japan1 and friends) that need this, and
   * without it those pages render blank.
   * ---------------------------------------------------------------- */

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = function () { reject(new Error('could not load ' + src)); };
      document.head.appendChild(el);
    });
  }

  var pdfjsDataPromise = null;

  function loadPdfjsData() {
    if (pdfjsDataPromise) return pdfjsDataPromise;
    pdfjsDataPromise = (async function () {
      await loadScript('vendor/pdfjs-data.js');
      var pack = window.PdfjsData;
      if (!pack) throw new Error('vendor/pdfjs-data.js did not load');
      if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream unavailable');

      var bin = atob(pack.data);
      var packed = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) packed[i] = bin.charCodeAt(i);
      var stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'));
      var all = new Uint8Array(await new Response(stream).arrayBuffer());

      return function (name) {
        var e = pack.index[name];
        return e ? all.subarray(e[0], e[0] + e[1]) : null;
      };
    })();
    return pdfjsDataPromise;
  }

  /* If the packed data can't be read, the pages that needed it come out
   * blank with only a console warning. Say so instead. */
  var warnedAboutData = false;
  function packedDataFailed(err) {
    console.warn('pdfjs-data.js could not be read', err);
    if (warnedAboutData) return;
    warnedAboutData = true;
    var why = /DecompressionStream/.test(String(err && err.message))
      ? 'this browser is too old to unpack it (needs Chrome 80, Safari 16.4, or Firefox 113)'
      : 'vendor/pdfjs-data.js is missing or unreadable';
    toast('Some characters may not display: ' + why + '. Most PDFs are unaffected — this only ' +
          'matters for CJK documents that don\'t embed their fonts.', 'warn');
  }

  function PackedCMapFactory() {}
  PackedCMapFactory.prototype.fetch = async function (params) {
    var get;
    try { get = await loadPdfjsData(); }
    catch (e) { packedDataFailed(e); throw e; }
    var data = get('cmaps/' + params.name + '.bcmap');
    if (!data) throw new Error('CMap not packed: ' + params.name);
    return { cMapData: data, compressionType: 1 }; // CMapCompressionType.BINARY
  };

  function PackedFontFactory() {}
  PackedFontFactory.prototype.fetch = async function (params) {
    var get;
    try { get = await loadPdfjsData(); }
    catch (e) { packedDataFailed(e); throw e; }
    var data = get('standard_fonts/' + params.filename);
    if (!data) throw new Error('font not packed: ' + params.filename);
    return data;
  };

  // Supplying factories switches pdf.js off its own fetching entirely.
  var PDFJS_OPTS = {
    cMapPacked: true,
    CMapReaderFactory: PackedCMapFactory,
    StandardFontDataFactory: PackedFontFactory
  };

  /* pdf-lib's default parseSpeed yields to the event loop after *every*
   * object it reads, which turns a 6 MB scan into a 40-second open.
   * We're already off the critical path, so parse flat out. */
  var LOAD_OPTS = {
    ignoreEncryption: true,
    updateMetadata: false,
    parseSpeed: PDFLib.ParseSpeeds.Fastest,
    throwOnInvalidObject: false
  };

  var $ = function (id) { return document.getElementById(id); };
  var E = window.PDFEngine;

  /* ---------------- state ---------------- */

  var S = {
    fileName: '',
    originalBytes: null,
    libDoc: null,
    analyses: new Map(),
    blocksByPage: new Map(),
    pdfjsDoc: null,
    pageCount: 0,
    views: [],
    zoom: 1,
    prevZoom: 1,
    tool: 'select',
    edits: { blocks: {}, deleted: {}, items: [], fields: {} },
    history: [],
    hIndex: -1,
    selection: null,
    editing: null,
    customFontBytes: null,
    customFontName: null,
    itemSeq: 0,
    dirty: false,
    rebuildTimer: null,
    rebuildToken: 0,
    encrypted: false
  };

  /* ---------------- small helpers ---------------- */

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function status(msg) { $('status').textContent = msg; }

  var toastTimer = null;
  function toast(msg, kind) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, kind === 'error' ? 7000 : 4200);
  }

  function busy(on) { $('busy').hidden = !on; }

  function rgbToHex(c) {
    function h(v) { return ('0' + Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16)).slice(-2); }
    return '#' + h(c[0]) + h(c[1]) + h(c[2]);
  }
  function hexToRgb(h) {
    var m = /^#?([0-9a-f]{6})$/i.exec(h);
    if (!m) return [0, 0, 0];
    var n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  /* ---------------- opening a file ---------------- */

  async function openFile(file) {
    try {
      status('Reading ' + file.name + '…');
      var buf = new Uint8Array(await file.arrayBuffer());
      S.fileName = file.name;
      S.originalBytes = buf;
      resetEdits();
      await analyze();
      $('fileName').textContent = file.name;
      $('dropzone').style.display = 'none';
      $('btnSave').disabled = false;
      await renderAll(buf);
      status(S.pageCount + ' page' + (S.pageCount === 1 ? '' : 's') + ' • ready');
    } catch (err) {
      console.error(err);
      toast('Could not open that file: ' + err.message, 'error');
      status('Failed to open the file.');
    }
  }

  function ensureAnalysis(i) {
    if (S.analyses.has(i)) return S.blocksByPage.get(i);
    if (!S.pages || !S.pages[i]) return null;
    try {
      var analysis = E.analyzePage(S.libDoc, S.pages[i], i);
      S.analyses.set(i, analysis);
      var built = window.PDFBlocks.build(analysis);
      S.blocksByPage.set(i, built);
      return built;
    } catch (e) {
      console.warn('page ' + (i + 1) + ' could not be analysed', e);
      S.analyses.set(i, { pageIndex: i, buf: new Uint8Array(0), instrs: [], runs: [], fonts: {} });
      S.blocksByPage.set(i, { blocks: [], hiddenBlocks: [] });
      return S.blocksByPage.get(i);
    }
  }

  function resetEdits() {
    S.edits = { blocks: {}, deleted: {}, items: [], fields: {} };
    S.history = [clone(S.edits)];
    S.hIndex = 0;
    S.selection = null;
    S.itemSeq = 0;
    updateUndoButtons();
  }

  async function analyze() {
    status('Reading the page contents…');
    var doc;
    try {
      doc = await PDFLib.PDFDocument.load(S.originalBytes, LOAD_OPTS);
    } catch (e) {
      throw new Error('this file could not be parsed (' + e.message + ')');
    }
    S.libDoc = doc;
    S.encrypted = !!(doc.context.lookup && doc.isEncrypted);
    if (S.encrypted) {
      toast('This PDF is encrypted. It can be edited, but some viewers may reject the result.', 'warn');
    }

    S.pages = doc.getPages();
    S.pageCount = S.pages.length;
    S.analyses.clear();
    S.blocksByPage.clear();

    // Parsing every page up front makes a 500-page file feel broken.
    // Do enough to answer "is there any text here?" and leave the rest
    // to be parsed the first time each page is actually shown.
    var eager = Math.min(S.pageCount, 4);
    for (var i = 0; i < eager; i++) ensureAnalysis(i);

    var totalBlocks = 0, hiddenOnly = 0;
    S.blocksByPage.forEach(function (b) {
      totalBlocks += b.blocks.length;
      hiddenOnly += b.hiddenBlocks.length;
    });
    if (totalBlocks === 0 && hiddenOnly > 0) {
      toast('This looks like a scan with an invisible OCR layer — the visible page is an image, so text edits ' +
            'won\'t change what you see. Use the shape and text tools to annotate instead.', 'warn');
    } else if (totalBlocks === 0) {
      toast('No editable text found — this PDF appears to be pure images.', 'warn');
    }
  }

  /* ---------------- rendering ---------------- */

  async function renderAll(bytes) {
    if (S.pdfjsDoc) { try { await S.pdfjsDoc.destroy(); } catch (e) {} }
    var task = pdfjsLib.getDocument(Object.assign({ data: bytes.slice(0) }, PDFJS_OPTS));
    S.pdfjsDoc = await task.promise;

    var host = $('pagesHost');
    host.innerHTML = '';
    S.views = [];

    for (var i = 1; i <= S.pdfjsDoc.numPages; i++) {
      var wrap = document.createElement('div');
      wrap.className = 'pagewrap';
      wrap.dataset.page = String(i - 1);
      var canvas = document.createElement('canvas');
      var overlay = document.createElement('div');
      overlay.className = 'overlay';
      wrap.appendChild(canvas);
      wrap.appendChild(overlay);
      // Reserve the right amount of space before the page is rendered,
      // so scroll position is meaningful and off-screen pages can be
      // skipped instead of all being drawn at once.
      var size = S.pages && S.pages[i - 1] ? S.pages[i - 1].getSize() : { width: 612, height: 792 };
      var rot = S.pages && S.pages[i - 1] ? (S.pages[i - 1].getRotation().angle % 180) : 0;
      var pw = rot === 90 ? size.height : size.width;
      var ph = rot === 90 ? size.width : size.height;
      wrap.style.width = Math.round(pw * S.zoom) + 'px';
      wrap.style.height = Math.round(ph * S.zoom) + 'px';
      host.appendChild(wrap);
      S.views.push({ index: i - 1, wrap: wrap, canvas: canvas, overlay: overlay, rendered: false, viewport: null });
    }
    await renderVisible(true);
    buildThumbs();
    await loadFormFields();
  }

  async function renderPage(view, force) {
    if (view.rendering) return;
    var page = await S.pdfjsDoc.getPage(view.index + 1);
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var viewport = page.getViewport({ scale: S.zoom });
    var scaled = page.getViewport({ scale: S.zoom * dpr });

    view.rendering = true;
    view.canvas.width = Math.floor(scaled.width);
    view.canvas.height = Math.floor(scaled.height);
    view.canvas.style.width = Math.floor(viewport.width) + 'px';
    view.canvas.style.height = Math.floor(viewport.height) + 'px';
    view.wrap.style.width = Math.floor(viewport.width) + 'px';
    view.wrap.style.height = Math.floor(viewport.height) + 'px';
    view.viewport = viewport;

    var ctx = view.canvas.getContext('2d', { willReadFrequently: true });
    try {
      await page.render({ canvasContext: ctx, viewport: scaled }).promise;
    } catch (e) {
      if (e && e.name !== 'RenderingCancelledException') console.warn(e);
    }
    view.rendering = false;
    view.rendered = true;
    layoutOverlay(view);
  }

  async function renderVisible(initial) {
    var viewer = $('viewer');
    var top = viewer.scrollTop - 500;
    var bottom = viewer.scrollTop + viewer.clientHeight + 700;
    var drawn = 0;
    for (var i = 0; i < S.views.length; i++) {
      var v = S.views[i];
      if (v.rendered) continue;
      var y = v.wrap.offsetTop, h = v.wrap.offsetHeight || 800;
      var near = y + h > top && y < bottom;
      if (near || (initial && drawn < 2)) {
        await renderPage(v);
        drawn++;
      } else if (y > bottom) {
        break; // everything below is further away still
      }
    }
  }

  function toViewport(view, x, y) {
    var p = view.viewport.convertToViewportPoint(x, y);
    return { x: p[0], y: p[1] };
  }
  function fromViewport(view, x, y) {
    var p = view.viewport.convertToPdfPoint(x, y);
    return { x: p[0], y: p[1] };
  }

  function rectFor(view, x0, y0, x1, y1) {
    var a = toViewport(view, x0, y0), b = toViewport(view, x1, y1);
    return {
      left: Math.min(a.x, b.x), top: Math.min(a.y, b.y),
      width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y)
    };
  }

  /* ---------------- overlay: text blocks + item hit boxes ---------------- */

  function layoutOverlay(view) {
    if (!view.viewport) return;
    // Never tear down an overlay that's hosting a live editor or a drag
    // ghost — rebuilding it would destroy what the user is working in.
    if (S.editing && S.editing.view === view) return;
    // A shape/freehand drag owns a ghost element in this overlay; move and
    // resize drags redraw through here deliberately, so let those pass.
    if (drag && drag.view === view && (drag.kind === 'shape' || drag.kind === 'draw')) return;
    var ov = view.overlay;
    ov.innerHTML = '';
    var built = ensureAnalysis(view.index);
    if (!built) return;

    var all = built.blocks.concat(built.hiddenBlocks);
    all.forEach(function (b) {
      var pad = Math.max(1, b.size * 0.12);
      var r = rectFor(view, b.x0 - pad, b.bottom - pad, b.x1 + pad, b.top + pad);
      var el = document.createElement('div');
      el.className = 'blk' + (b.invisible ? ' is-hidden-layer' : '');
      if (S.edits.deleted[b.id]) el.className += ' is-deleted';
      else if (S.edits.blocks[b.id]) el.className += ' is-edited';
      if (S.selection && S.selection.type === 'block' && S.selection.id === b.id) el.className += ' is-selected';
      el.style.left = r.left + 'px';
      el.style.top = r.top + 'px';
      el.style.width = Math.max(4, r.width) + 'px';
      el.style.height = Math.max(4, r.height) + 'px';
      el.dataset.block = b.id;
      el.title = b.invisible ? 'Invisible OCR text — editing it changes the text layer, not the picture' : '';
      ov.appendChild(el);
    });

    S.edits.items.filter(function (it) { return it.page === view.index; }).forEach(function (it) {
      var bounds = itemBounds(it);
      var r = rectFor(view, bounds.x0, bounds.y0, bounds.x1, bounds.y1);
      var el = document.createElement('div');
      el.className = 'item' + (S.selection && S.selection.type === 'item' && S.selection.id === it.id ? ' is-selected' : '');
      el.style.left = r.left + 'px';
      el.style.top = r.top + 'px';
      el.style.width = Math.max(6, r.width) + 'px';
      el.style.height = Math.max(6, r.height) + 'px';
      el.dataset.item = it.id;
      var h = document.createElement('div');
      h.className = 'handle se';
      el.appendChild(h);
      ov.appendChild(el);
    });
  }

  function itemBounds(it) {
    if (it.type === 'text') {
      var w = it.width || 200;
      var lines = String(it.text || '').split('\n').length;
      var lead = (it.style && it.style.leading) || (it.style.size || 12) * 1.2;
      return { x0: it.x, y0: it.y - lead * (lines - 1) - (it.style.size || 12) * 0.25, x1: it.x + w, y1: it.y + (it.style.size || 12) * 0.85 };
    }
    if (it.type === 'image') return { x0: it.x, y0: it.y, x1: it.x + it.w, y1: it.y + it.h };
    if (it.kind === 'line') {
      return { x0: Math.min(it.x1, it.x2), y0: Math.min(it.y1, it.y2), x1: Math.max(it.x1, it.x2), y1: Math.max(it.y1, it.y2) };
    }
    if (it.kind === 'path') {
      var xs = it.points.map(function (p) { return p[0]; });
      var ys = it.points.map(function (p) { return p[1]; });
      return { x0: Math.min.apply(null, xs), y0: Math.min.apply(null, ys), x1: Math.max.apply(null, xs), y1: Math.max.apply(null, ys) };
    }
    return { x0: Math.min(it.x, it.x + it.w), y0: Math.min(it.y, it.y + it.h), x1: Math.max(it.x, it.x + it.w), y1: Math.max(it.y, it.y + it.h) };
  }

  function relayoutAll() { S.views.forEach(function (v) { if (v.rendered) layoutOverlay(v); }); }

  /* ---------------- block lookup ---------------- */

  function findBlock(id) {
    var pi = parseInt(String(id).split(/[#~]/)[0], 10);
    var built = ensureAnalysis(pi);
    if (!built) return null;
    var all = built.blocks.concat(built.hiddenBlocks);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  function blockText(b) {
    var e = S.edits.blocks[b.id];
    return e && e.text != null ? e.text : b.text;
  }
  function blockStyle(b) {
    var e = S.edits.blocks[b.id] || {};
    var st = e.style || {};
    return {
      size: st.size != null ? st.size : b.size,
      color: st.color || b.fill,
      align: st.align || b.align,
      leading: st.leading != null ? st.leading : b.leading
    };
  }

  /* ---------------- inline editing ---------------- */

  function sampleBackground(view, rect) {
    try {
      var dpr = view.canvas.width / parseFloat(view.canvas.style.width);
      var x = Math.max(0, Math.floor(rect.left * dpr));
      var y = Math.max(0, Math.floor(rect.top * dpr));
      var w = Math.min(view.canvas.width - x, Math.ceil(rect.width * dpr));
      var h = Math.min(view.canvas.height - y, Math.ceil(rect.height * dpr));
      if (w <= 0 || h <= 0) return '#ffffff';
      var data = view.canvas.getContext('2d').getImageData(x, y, w, h).data;
      var counts = new Map(), best = null, bestN = 0;
      for (var i = 0; i < data.length; i += 4 * 3) { // sample every 3rd pixel
        var key = (data[i] >> 3) * 1024 + (data[i + 1] >> 3) * 32 + (data[i + 2] >> 3);
        var n = (counts.get(key) || 0) + 1;
        counts.set(key, n);
        if (n > bestN) { bestN = n; best = [data[i], data[i + 1], data[i + 2]]; }
      }
      return best ? 'rgb(' + best[0] + ',' + best[1] + ',' + best[2] + ')' : '#ffffff';
    } catch (e) { return '#ffffff'; }
  }

  function cssFontFor(b) {
    var name = (b.fontLabel || '').toLowerCase();
    var family = 'ui-sans-serif, system-ui, sans-serif';
    if (/times|serif|roman|georgia|garamond|minion|book/.test(name) && !/sans/.test(name)) family = 'Georgia, "Times New Roman", serif';
    if (/courier|mono|consol/.test(name)) family = 'ui-monospace, Menlo, Consolas, monospace';
    return {
      family: family,
      weight: /bold|black|heavy|semibold/.test(name) ? 700 : 400,
      style: /italic|oblique/.test(name) ? 'italic' : 'normal'
    };
  }

  function startEditing(view, b) {
    commitEditing();
    // Select first: selection redraws the overlay, and doing that after
    // the textarea exists would wipe it out.
    S.selection = { type: 'block', id: b.id };
    relayoutAll();
    updateInspector();

    var st = blockStyle(b);
    var pad = Math.max(1, b.size * 0.12);
    var r = rectFor(view, b.x0 - pad, b.bottom - pad, b.x1 + pad, b.top + pad);
    var scale = S.zoom;
    var f = cssFontFor(b);

    var ta = document.createElement('textarea');
    ta.className = 'editor-box';
    ta.value = blockText(b);
    ta.spellcheck = false;
    ta.style.left = r.left + 'px';
    ta.style.top = r.top + 'px';
    ta.style.width = Math.max(40, r.width + 12) + 'px';
    ta.style.minHeight = Math.max(18, r.height) + 'px';
    ta.style.fontFamily = f.family;
    ta.style.fontWeight = f.weight;
    ta.style.fontStyle = f.style;
    ta.style.fontSize = (st.size * scale) + 'px';
    ta.style.lineHeight = (st.leading * scale) + 'px';
    ta.style.color = rgbToHex(st.color);
    ta.style.textAlign = st.align === 'justify' ? 'justify' : st.align;
    ta.style.setProperty('--edit-bg', sampleBackground(view, r));
    ta.style.background = sampleBackground(view, r);
    ta.style.padding = '0 2px';

    view.overlay.appendChild(ta);
    autoGrow(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    S.editing = { kind: 'block', view: view, block: b, el: ta, original: blockText(b) };

    ta.addEventListener('input', function () {
      autoGrow(ta);
      // keep the "on save" readout honest while the user types — it's
      // what tells them whether they'll get an exact font match
      updateFidelity(b, ta.value);
    });
    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); cancelEditing(); }
      else if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); commitEditing(); }
      ev.stopPropagation();
    });
    // Commit on blur, but only if this editor is still the live one —
    // clicking straight from one text box into another would otherwise
    // let the queued blur commit the editor that just replaced it.
    ta.addEventListener('blur', function () {
      setTimeout(function () { if (S.editing && S.editing.el === ta) commitEditing(); }, 0);
    });
  }

  function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = (ta.scrollHeight + 2) + 'px';
  }

  function commitEditing() {
    var ed = S.editing;
    if (!ed) return;
    S.editing = null;
    var val = ed.el.value;
    if (ed.el.parentNode) ed.el.parentNode.removeChild(ed.el);

    if (ed.kind === 'item') {
      // A text box the user opened and then left empty was never wanted.
      if (ed.isNew && val.trim() === '') {
        S.edits.items = S.edits.items.filter(function (x) { return x.id !== ed.item.id; });
        S.selection = null;
        relayoutAll();
        updateInspector();
        return;
      }
      if (val === ed.original) { relayoutAll(); return; }
      ed.item.text = val;
      pushHistory();
      scheduleRebuild();
      return;
    }

    if (val === ed.original) { relayoutAll(); return; }
    var b = ed.block;
    if (val.trim() === '') {
      delete S.edits.blocks[b.id];
      S.edits.deleted[b.id] = true;
    } else {
      delete S.edits.deleted[b.id];
      var prev = S.edits.blocks[b.id] || {};
      S.edits.blocks[b.id] = { text: val, style: prev.style || {} };
    }
    pushHistory();
    scheduleRebuild();
  }

  function cancelEditing() {
    var ed = S.editing;
    if (!ed) return;
    S.editing = null;
    if (ed.el.parentNode) ed.el.parentNode.removeChild(ed.el);
    if (ed.kind === 'item' && ed.isNew) {
      S.edits.items = S.edits.items.filter(function (x) { return x.id !== ed.item.id; });
      S.selection = null;
      updateInspector();
    }
    relayoutAll();
  }

  /* ---------------- selection & inspector ---------------- */

  function select(sel) {
    S.selection = sel;
    relayoutAll();
    updateInspector();
  }

  function updateInspector() {
    var sel = S.selection;
    var body = $('inspBody'), empty = $('inspEmpty');
    document.querySelectorAll('.shape-only').forEach(function (e) { e.hidden = true; });

    if (!sel) { body.hidden = true; empty.hidden = false; return; }
    body.hidden = false; empty.hidden = true;

    if (sel.type === 'block') {
      var b = findBlock(sel.id);
      if (!b) { body.hidden = true; empty.hidden = false; return; }
      var st = blockStyle(b);
      $('inspTitle').textContent = S.edits.deleted[b.id] ? 'Text (deleted)' : 'Text';
      $('inspFontLabel').textContent = 'Font in the file';
      $('inspFont').textContent = b.fontLabel + (b.embedded ? ' · embedded' : ' · not embedded') +
        (b.invisible ? ' · invisible OCR layer' : '');
      updateFidelity(b);
      $('inspSize').value = Math.round(st.size * 10) / 10;
      $('inspColor').value = rgbToHex(st.color);
      $('inspLeading').value = Math.round(st.leading * 10) / 10;
      setSegment('inspAlign', st.align);
    } else {
      var it = S.edits.items.find(function (x) { return x.id === sel.id; });
      if (!it) { body.hidden = true; empty.hidden = false; return; }
      $('inspTitle').textContent = it.type === 'text' ? 'Text box' : it.type === 'image' ? 'Image' : 'Shape';
      $('inspFontLabel').textContent = it.type === 'text' ? 'Font' : 'Kind';
      $('inspFont').textContent = it.type === 'text'
        ? (S.customFontName || 'Helvetica (standard)')
        : (it.kind || it.type);
      $('inspFidelity').textContent = 'Drawn as new content.';
      $('inspFidelity').className = 'readout';
      if (it.type === 'text') {
        $('inspSize').value = it.style.size;
        $('inspColor').value = rgbToHex(it.style.color);
        $('inspLeading').value = Math.round((it.style.leading || it.style.size * 1.2) * 10) / 10;
        setSegment('inspAlign', it.style.align || 'left');
      }
      if (it.type === 'shape') {
        $('strokeField').hidden = false;
        $('fillField').hidden = false;
        $('inspStroke').value = rgbToHex(it.stroke || [0, 0, 0]);
        $('inspWidth').value = it.lineWidth;
        $('inspFill').value = rgbToHex(it.fill || [1, 1, 1]);
        $('inspNoFill').checked = !it.fill;
      }
    }
  }

  function updateFidelity(b, liveText) {
    var el = $('inspFidelity');
    var text = liveText != null ? liveText : blockText(b);
    var anchor = b.anchorRun;
    if (S.edits.deleted[b.id]) {
      el.textContent = 'The original drawing operators will be removed. Nothing is painted back.';
      el.className = 'readout';
      return;
    }
    if (liveText == null && !S.edits.blocks[b.id]) {
      el.textContent = 'Unchanged — this block is written through untouched.';
      el.className = 'readout';
      return;
    }
    if (liveText != null && liveText === b.text) {
      el.textContent = 'Unchanged — this block is written through untouched.';
      el.className = 'readout';
      return;
    }
    var canReuse = anchor && anchor.font && anchor.font.canEncode(text.replace(/\n/g, ' ').replace(/ /g, ''));
    var hasSpace = anchor && anchor.font && (anchor.font.fromUni.has(' ') || anchor.spaceGapEm > 0);
    if (canReuse && (hasSpace || text.indexOf(' ') < 0)) {
      el.textContent = 'Pixel-perfect: repainted with the file\'s own font.';
      el.className = 'readout ok';
    } else {
      el.textContent = 'Substituted: this font lacks some characters you typed, so a close standard font is used. '
        + 'Load a fallback font below for an exact match.';
      el.className = 'readout warn';
    }
  }

  function setSegment(id, value) {
    $(id).querySelectorAll('button').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.dataset.align === value);
    });
  }

  function mutateSelectionStyle(patch) {
    var sel = S.selection;
    if (!sel) return;
    if (sel.type === 'block') {
      var b = findBlock(sel.id);
      if (!b) return;
      var cur = S.edits.blocks[b.id] || { text: b.text, style: {} };
      cur.style = Object.assign({}, cur.style, patch);
      if (cur.text == null) cur.text = b.text;
      S.edits.blocks[b.id] = cur;
    } else {
      var it = S.edits.items.find(function (x) { return x.id === sel.id; });
      if (!it) return;
      if (it.type === 'text') it.style = Object.assign({}, it.style, patch);
      else Object.assign(it, patch);
    }
    pushHistory();
    scheduleRebuild();
    updateInspector();
  }

  /* ---------------- history ---------------- */

  function pushHistory() {
    S.history = S.history.slice(0, S.hIndex + 1);
    S.history.push(clone(S.edits));
    if (S.history.length > 120) S.history.shift();
    S.hIndex = S.history.length - 1;
    updateUndoButtons();
  }

  function updateUndoButtons() {
    $('btnUndo').disabled = S.hIndex <= 0;
    $('btnRedo').disabled = S.hIndex >= S.history.length - 1;
  }

  function undo() {
    if (S.hIndex <= 0) return;
    S.hIndex--;
    S.edits = clone(S.history[S.hIndex]);
    updateUndoButtons();
    scheduleRebuild();
    updateInspector();
  }
  function redo() {
    if (S.hIndex >= S.history.length - 1) return;
    S.hIndex++;
    S.edits = clone(S.history[S.hIndex]);
    updateUndoButtons();
    scheduleRebuild();
    updateInspector();
  }

  /* ---------------- building the edited document ---------------- */

  function editsForWriter() {
    var out = { textBlocks: [], deletions: [], newItems: [], fields: S.edits.fields };

    Object.keys(S.edits.blocks).forEach(function (id) {
      var b = findBlock(id);
      if (!b) return;
      var e = S.edits.blocks[id];
      var st = e.style || {};
      out.textBlocks.push({
        page: b.page,
        runIds: b.runIds,
        anchorRun: b.anchorRun,
        text: e.text != null ? e.text : b.text,
        detectedAlign: b.align,
        style: {
          size: st.size, color: st.color, align: st.align,
          leading: st.leading,
          width: b.x1 - b.x0,
          noWrap: st.noWrap != null ? st.noWrap : b.noWrap,
          font: st.font
        }
      });
    });

    Object.keys(S.edits.deleted).forEach(function (id) {
      var b = findBlock(id);
      if (b) out.deletions.push({ page: b.page, runIds: b.runIds });
    });

    S.edits.items.forEach(function (it) {
      if (it.type === 'image' && it.b64) {
        out.newItems.push(Object.assign({}, it, { bytes: b64ToBytes(it.b64) }));
      } else {
        out.newItems.push(it);
      }
    });

    return out;
  }

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  async function buildBytes() {
    var doc = await PDFLib.PDFDocument.load(S.originalBytes, LOAD_OPTS);
    var report = await window.PDFWriter.applyEdits(doc, S.analyses, editsForWriter(), {
      customFontBytes: S.customFontBytes,
      customFontName: S.customFontName,
      fontkit: window.fontkit
    });
    var bytes = await doc.save({ useObjectStreams: true });
    return { bytes: bytes, report: report };
  }

  function hasEdits() {
    return Object.keys(S.edits.blocks).length > 0 ||
           Object.keys(S.edits.deleted).length > 0 ||
           S.edits.items.length > 0 ||
           Object.keys(S.edits.fields).length > 0;
  }

  function scheduleRebuild() {
    clearTimeout(S.rebuildTimer);
    S.rebuildTimer = setTimeout(rebuildPreview, 260);
    relayoutAll();
  }

  async function rebuildPreview() {
    if (!S.originalBytes) return;
    var token = ++S.rebuildToken;
    busy(true);
    try {
      var res = hasEdits() ? await buildBytes() : { bytes: S.originalBytes, report: null };
      if (token !== S.rebuildToken) return;

      var scrollTop = $('viewer').scrollTop;
      var wasRendered = S.views.map(function (v) { return v.rendered; });

      if (S.pdfjsDoc) { try { await S.pdfjsDoc.destroy(); } catch (e) {} }
      S.pdfjsDoc = await pdfjsLib.getDocument(Object.assign({ data: res.bytes.slice(0) }, PDFJS_OPTS)).promise;

      for (var i = 0; i < S.views.length; i++) {
        S.views[i].rendered = false;
        if (wasRendered[i]) await renderPage(S.views[i]);
      }
      $('viewer').scrollTop = scrollTop;
      buildThumbs();

      if (res.report && res.report.warnings.length) {
        toast(res.report.warnings[0], 'warn');
      }
      if (res.report) {
        var bits = [];
        if (res.report.reused) bits.push(res.report.reused + ' block' + (res.report.reused === 1 ? '' : 's') + ' repainted in the original font');
        if (res.report.substituted) bits.push(res.report.substituted + ' substituted');
        if (res.report.removed) bits.push(res.report.removed + ' original operator' + (res.report.removed === 1 ? '' : 's') + ' removed');
        status(bits.length ? bits.join(' • ') : 'Ready.');
      }
    } catch (err) {
      console.error(err);
      toast('Preview failed: ' + err.message, 'error');
    } finally {
      if (token === S.rebuildToken) busy(false);
    }
  }

  async function save() {
    if (!S.originalBytes) return;
    busy(true);
    status('Building the file…');
    try {
      var res = hasEdits() ? await buildBytes() : { bytes: S.originalBytes, report: null };
      var blob = new Blob([res.bytes], { type: 'application/pdf' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = S.fileName.replace(/\.pdf$/i, '') + '-edited.pdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      status('Saved ' + a.download);
      if (res.report && res.report.warnings.length) toast(res.report.warnings[0], 'warn');
    } catch (err) {
      console.error(err);
      toast('Could not build the file: ' + err.message, 'error');
    } finally { busy(false); }
  }

  /* ---------------- thumbnails ---------------- */

  async function buildThumbs() {
    var strip = $('pageStrip');
    strip.innerHTML = '';
    if (!S.pdfjsDoc || S.pdfjsDoc.numPages < 2) return;
    for (var i = 1; i <= Math.min(S.pdfjsDoc.numPages, 60); i++) {
      (function (n) {
        var d = document.createElement('div');
        d.className = 'thumb';
        var c = document.createElement('canvas');
        var tag = document.createElement('span');
        tag.className = 'n';
        tag.textContent = n;
        d.appendChild(c); d.appendChild(tag);
        d.addEventListener('click', function () {
          var v = S.views[n - 1];
          if (v) $('viewer').scrollTo({ top: v.wrap.offsetTop - 20, behavior: 'smooth' });
        });
        strip.appendChild(d);
        S.pdfjsDoc.getPage(n).then(function (p) {
          var vp = p.getViewport({ scale: 1 });
          var scale = 110 / vp.width;
          var v2 = p.getViewport({ scale: scale });
          c.width = v2.width; c.height = v2.height;
          return p.render({ canvasContext: c.getContext('2d'), viewport: v2 }).promise;
        }).catch(function () {});
      })(i);
    }
  }

  /* ---------------- form fields ---------------- */

  async function loadFormFields() {
    var host = $('formFields');
    host.innerHTML = '';
    var section = $('formSection');
    section.hidden = true;
    if (!S.pdfjsDoc) return;
    var seen = new Set();
    var limit = Math.min(S.pdfjsDoc.numPages, 60);
    for (var i = 1; i <= limit; i++) {
      var page = await S.pdfjsDoc.getPage(i);
      var annots = await page.getAnnotations({ intent: 'display' });
      annots.forEach(function (a) {
        if (a.subtype !== 'Widget' || !a.fieldName || seen.has(a.fieldName)) return;
        if (a.fieldType !== 'Tx' && a.fieldType !== 'Btn' && a.fieldType !== 'Ch') return;
        seen.add(a.fieldName);
        section.hidden = false;
        var wrap = document.createElement('div');
        wrap.className = 'formfield';
        var lab = document.createElement('label');
        lab.textContent = a.fieldName;
        var input = document.createElement('input');
        input.type = a.fieldType === 'Btn' ? 'checkbox' : 'text';
        if (a.fieldType === 'Btn') input.checked = !!a.fieldValue && a.fieldValue !== 'Off';
        else input.value = a.fieldValue || '';
        input.addEventListener('change', function () {
          S.edits.fields[a.fieldName] = a.fieldType === 'Btn' ? input.checked : input.value;
          pushHistory();
          scheduleRebuild();
        });
        wrap.appendChild(lab); wrap.appendChild(input);
        host.appendChild(wrap);
      });
      if (seen.size > 80) break;
    }
    if (!seen.size) section.hidden = true;
  }

  /* ---------------- pointer interaction on pages ---------------- */

  var drag = null;

  function viewFromEvent(ev) {
    var wrap = ev.target.closest ? ev.target.closest('.pagewrap') : null;
    if (!wrap) return null;
    return S.views[parseInt(wrap.dataset.page, 10)] || null;
  }

  function localPoint(view, ev) {
    var r = view.wrap.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  document.addEventListener('pointerdown', function (ev) {
    var view = viewFromEvent(ev);
    if (!view || !view.viewport) return;
    if (ev.target.classList.contains('editor-box')) return;

    var pt = localPoint(view, ev);
    var pdfPt = fromViewport(view, pt.x, pt.y);

    if (S.tool === 'select') {
      var blkEl = ev.target.closest('.blk');
      var itemEl = ev.target.closest('.item');
      if (itemEl) {
        var it = S.edits.items.find(function (x) { return x.id === itemEl.dataset.item; });
        select({ type: 'item', id: itemEl.dataset.item });
        var resizing = ev.target.classList.contains('handle');
        drag = {
          kind: resizing ? 'resize-item' : 'move-item', item: it, view: view,
          start: pdfPt, snapshot: clone(it), moved: false
        };
        ev.preventDefault();
        return;
      }
      if (blkEl) {
        var b = findBlock(blkEl.dataset.block);
        if (b) { ev.preventDefault(); startEditing(view, b); }
        return;
      }
      commitEditing();
      select(null);
      return;
    }

    if (S.tool === 'text') {
      var item = {
        id: 'i' + (++S.itemSeq), type: 'text', page: view.index,
        x: pdfPt.x, y: pdfPt.y, width: 240, text: '',
        style: { size: 12, color: [0, 0, 0], align: 'left', leading: 14.4 }
      };
      S.edits.items.push(item);
      setTool('select');
      // Open the editor straight away rather than after a rebuild — the
      // rebuild would redraw the overlay and destroy the textarea.
      editItemText(view, item, true);
      ev.preventDefault();
      return;
    }

    if (S.tool === 'image') { $('imageInput').dataset.page = view.index; $('imageInput').dataset.x = pdfPt.x; $('imageInput').dataset.y = pdfPt.y; $('imageInput').click(); return; }

    if (S.tool === 'draw') {
      drag = { kind: 'draw', view: view, points: [[pdfPt.x, pdfPt.y]] };
      ev.preventDefault();
      return;
    }

    // rect / ellipse / line
    drag = { kind: 'shape', shape: S.tool, view: view, start: pdfPt, startLocal: pt };
    var ghost = document.createElement('div');
    ghost.className = 'marquee';
    view.overlay.appendChild(ghost);
    drag.ghost = ghost;
    ev.preventDefault();
  });

  document.addEventListener('pointermove', function (ev) {
    if (!drag) return;
    var view = drag.view;
    var pt = localPoint(view, ev);
    var pdfPt = fromViewport(view, pt.x, pt.y);

    if (drag.kind === 'shape') {
      var l = Math.min(drag.startLocal.x, pt.x), t = Math.min(drag.startLocal.y, pt.y);
      drag.ghost.style.left = l + 'px';
      drag.ghost.style.top = t + 'px';
      drag.ghost.style.width = Math.abs(pt.x - drag.startLocal.x) + 'px';
      drag.ghost.style.height = Math.abs(pt.y - drag.startLocal.y) + 'px';
      drag.end = pdfPt;
    } else if (drag.kind === 'draw') {
      var last = drag.points[drag.points.length - 1];
      if (Math.hypot(pdfPt.x - last[0], pdfPt.y - last[1]) > 0.8) drag.points.push([pdfPt.x, pdfPt.y]);
    } else if (drag.kind === 'move-item') {
      var dx = pdfPt.x - drag.start.x, dy = pdfPt.y - drag.start.y;
      if (Math.hypot(dx, dy) > 0.7) drag.moved = true;
      if (!drag.moved) return;   // a click that hasn't become a drag yet
      moveItem(drag.item, drag.snapshot, dx, dy);
      layoutOverlay(view);
    } else if (drag.kind === 'resize-item') {
      drag.moved = true;
      resizeItem(drag.item, drag.snapshot, pdfPt);
      layoutOverlay(view);
    }
  });

  document.addEventListener('pointerup', function () {
    if (!drag) return;
    var d = drag; drag = null;

    if (d.kind === 'shape') {
      if (d.ghost && d.ghost.parentNode) d.ghost.parentNode.removeChild(d.ghost);
      if (!d.end) return;
      var x0 = Math.min(d.start.x, d.end.x), y0 = Math.min(d.start.y, d.end.y);
      var w = Math.abs(d.end.x - d.start.x), h = Math.abs(d.end.y - d.start.y);
      if (w < 2 && h < 2) return;
      var item = {
        id: 'i' + (++S.itemSeq), type: 'shape', kind: d.shape, page: d.view.index,
        lineWidth: 1.5, stroke: [0.85, 0.15, 0.15], fill: null
      };
      if (d.shape === 'line') {
        item.x1 = d.start.x; item.y1 = d.start.y; item.x2 = d.end.x; item.y2 = d.end.y;
      } else {
        item.x = x0; item.y = y0; item.w = w; item.h = h;
      }
      S.edits.items.push(item);
      pushHistory();
      setTool('select');
      select({ type: 'item', id: item.id });
      scheduleRebuild();
    } else if (d.kind === 'draw') {
      if (d.points.length < 2) return;
      var stroke = {
        id: 'i' + (++S.itemSeq), type: 'shape', kind: 'path', page: d.view.index,
        points: d.points, lineWidth: 1.6, stroke: [0.05, 0.05, 0.2], fill: null
      };
      S.edits.items.push(stroke);
      pushHistory();
      scheduleRebuild();
    } else if (d.kind === 'move-item' || d.kind === 'resize-item') {
      if (d.moved) {
        pushHistory();
        scheduleRebuild();
      } else if (d.item && d.item.type === 'text') {
        // A click that never turned into a drag: open the text box for
        // editing, the same way clicking body text does.
        editItemText(d.view, d.item, false);
      }
    }
  });

  function moveItem(it, snap, dx, dy) {
    if (it.kind === 'line') {
      it.x1 = snap.x1 + dx; it.y1 = snap.y1 + dy;
      it.x2 = snap.x2 + dx; it.y2 = snap.y2 + dy;
    } else if (it.kind === 'path') {
      it.points = snap.points.map(function (p) { return [p[0] + dx, p[1] + dy]; });
    } else {
      it.x = snap.x + dx; it.y = snap.y + dy;
    }
  }

  function resizeItem(it, snap, pt) {
    if (it.type === 'text') { it.width = Math.max(20, pt.x - snap.x); return; }
    if (it.kind === 'line') { it.x2 = pt.x; it.y2 = pt.y; return; }
    if (it.kind === 'path') return;
    it.w = Math.max(3, pt.x - snap.x);
    it.h = Math.max(3, snap.y + snap.h - pt.y) ;
    it.y = Math.min(pt.y, snap.y + snap.h);
    it.h = Math.abs(snap.y + snap.h - pt.y);
  }

  function editItemText(view, item, isNew) {
    commitEditing();
    // Select first — selection redraws the overlay, and doing that after
    // the textarea exists would tear it out from under the user.
    S.selection = { type: 'item', id: item.id };
    relayoutAll();
    updateInspector();

    var vp = toViewport(view, item.x, item.y);
    var size = item.style.size || 12;
    var ta = document.createElement('textarea');
    ta.className = 'editor-box';
    ta.value = item.text || '';
    ta.placeholder = 'Type here…';
    ta.spellcheck = false;
    ta.style.left = vp.x + 'px';
    ta.style.top = (vp.y - size * S.zoom) + 'px';
    ta.style.width = Math.max(60, (item.width || 200) * S.zoom) + 'px';
    // a textarea defaults to monospace, which looks nothing like what
    // will actually be painted
    var fam = (item.style.family || 'Helvetica').toLowerCase();
    ta.style.fontFamily = /times|serif/.test(fam) ? 'Georgia, "Times New Roman", serif'
      : /courier|mono/.test(fam) ? 'ui-monospace, Menlo, Consolas, monospace'
      : 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Arial, sans-serif';
    ta.style.fontWeight = item.style.bold ? 700 : 400;
    ta.style.fontStyle = item.style.italic ? 'italic' : 'normal';
    ta.style.textAlign = item.style.align === 'justify' ? 'justify' : (item.style.align || 'left');
    ta.style.fontSize = (size * S.zoom) + 'px';
    ta.style.lineHeight = ((item.style.leading || size * 1.2) * S.zoom) + 'px';
    ta.style.color = rgbToHex(item.style.color || [0, 0, 0]);
    ta.style.background = '#fff';
    ta.style.padding = '0 2px';
    view.overlay.appendChild(ta);
    autoGrow(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    S.editing = {
      kind: 'item', view: view, item: item, el: ta,
      original: item.text || '', isNew: !!isNew
    };

    ta.addEventListener('input', function () { autoGrow(ta); });
    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); cancelEditing(); }
      else if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); commitEditing(); }
      ev.stopPropagation();
    });
    // Commit on blur, but only if this editor is still the live one —
    // clicking straight from one text box into another would otherwise
    // let the queued blur commit the editor that just replaced it.
    ta.addEventListener('blur', function () {
      setTimeout(function () { if (S.editing && S.editing.el === ta) commitEditing(); }, 0);
    });
  }

  document.addEventListener('dblclick', function (ev) {
    var itemEl = ev.target.closest ? ev.target.closest('.item') : null;
    if (!itemEl) return;
    var view = viewFromEvent(ev);
    var it = S.edits.items.find(function (x) { return x.id === itemEl.dataset.item; });
    if (it && it.type === 'text' && view) editItemText(view, it, false);
  });

  /* ---------------- deleting ---------------- */

  function deleteSelection() {
    var sel = S.selection;
    if (!sel) return;
    if (sel.type === 'block') {
      var b = findBlock(sel.id);
      if (!b) return;
      if (S.edits.deleted[b.id]) delete S.edits.deleted[b.id];
      else { S.edits.deleted[b.id] = true; delete S.edits.blocks[b.id]; }
    } else {
      S.edits.items = S.edits.items.filter(function (x) { return x.id !== sel.id; });
      S.selection = null;
    }
    pushHistory();
    scheduleRebuild();
    updateInspector();
  }

  function revertSelection() {
    var sel = S.selection;
    if (!sel || sel.type !== 'block') return;
    delete S.edits.blocks[sel.id];
    delete S.edits.deleted[sel.id];
    pushHistory();
    scheduleRebuild();
    updateInspector();
  }

  /* ---------------- tools & chrome ---------------- */

  function setTool(name) {
    S.tool = name;
    document.querySelectorAll('.tool').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.tool === name);
    });
    $('viewer').style.cursor = name === 'select' ? '' : 'crosshair';
  }

  async function setZoom(z) {
    S.zoom = Math.max(0.25, Math.min(5, z));
    $('zoomLabel').textContent = Math.round(S.zoom * 100) + '%';
    commitEditing();
    var prevZoom = S.prevZoom || 1;
    for (var i = 0; i < S.views.length; i++) {
      var v = S.views[i];
      if (v.rendered) { v.rendered = false; await renderPage(v); }
      else {
        // keep unrendered placeholders the right size so scrolling and
        // visibility checks stay correct
        var w = parseFloat(v.wrap.style.width) || 612 * prevZoom;
        var h = parseFloat(v.wrap.style.height) || 792 * prevZoom;
        v.wrap.style.width = Math.round(w / prevZoom * S.zoom) + 'px';
        v.wrap.style.height = Math.round(h / prevZoom * S.zoom) + 'px';
      }
    }
    S.prevZoom = S.zoom;
    renderVisible(false);
  }

  /* ---------------- wiring ---------------- */

  function wire() {
    $('btnOpen').addEventListener('click', function () { $('fileInput').click(); });
    $('dzOpen').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function (e) {
      if (e.target.files[0]) openFile(e.target.files[0]);
      e.target.value = '';
    });

    var dz = $('dropzone');
    ['dragenter', 'dragover'].forEach(function (t) {
      document.addEventListener(t, function (e) { e.preventDefault(); dz.classList.add('is-hot'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      document.addEventListener(t, function (e) { e.preventDefault(); dz.classList.remove('is-hot'); });
    });
    document.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files[0];
      if (f && /pdf$/i.test(f.name)) openFile(f);
    });

    document.querySelectorAll('.tool').forEach(function (b) {
      b.addEventListener('click', function () { commitEditing(); setTool(b.dataset.tool); });
    });

    $('btnSave').addEventListener('click', function () { commitEditing(); setTimeout(save, 50); });
    $('btnUndo').addEventListener('click', undo);
    $('btnRedo').addEventListener('click', redo);
    $('zoomIn').addEventListener('click', function () { setZoom(S.zoom * 1.25); });
    $('zoomOut').addEventListener('click', function () { setZoom(S.zoom / 1.25); });

    $('btnDeleteSel').addEventListener('click', deleteSelection);
    $('btnResetSel').addEventListener('click', revertSelection);

    $('inspSize').addEventListener('change', function () {
      mutateSelectionStyle({ size: parseFloat(this.value) || 12 });
    });
    $('inspLeading').addEventListener('change', function () {
      mutateSelectionStyle({ leading: parseFloat(this.value) || 14 });
    });
    $('inspColor').addEventListener('change', function () {
      mutateSelectionStyle({ color: hexToRgb(this.value) });
    });
    $('inspAlign').querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () { mutateSelectionStyle({ align: b.dataset.align }); });
    });
    $('inspStroke').addEventListener('change', function () { mutateSelectionStyle({ stroke: hexToRgb(this.value) }); });
    $('inspWidth').addEventListener('change', function () { mutateSelectionStyle({ lineWidth: parseFloat(this.value) || 1 }); });
    $('inspFill').addEventListener('change', function () {
      $('inspNoFill').checked = false;
      mutateSelectionStyle({ fill: hexToRgb(this.value) });
    });
    $('inspNoFill').addEventListener('change', function () {
      mutateSelectionStyle({ fill: this.checked ? null : hexToRgb($('inspFill').value) });
    });

    $('btnFont').addEventListener('click', function () { $('fontInput').click(); });
    $('fontInput').addEventListener('change', async function (e) {
      var f = e.target.files[0];
      if (!f) return;
      S.customFontBytes = new Uint8Array(await f.arrayBuffer());
      S.customFontName = f.name;
      $('fontReadout').textContent = f.name + ' — used when the file\'s own font can\'t spell a character';
      scheduleRebuild();
      e.target.value = '';
    });

    $('imageInput').addEventListener('change', async function (e) {
      var f = e.target.files[0];
      if (!f) return;
      var page = parseInt(this.dataset.page, 10);
      var x = parseFloat(this.dataset.x), y = parseFloat(this.dataset.y);
      var bytes = new Uint8Array(await f.arrayBuffer());
      var bmp = await createImageBitmap(f).catch(function () { return null; });
      var w = bmp ? bmp.width : 200, h = bmp ? bmp.height : 200;
      var maxW = 260;
      var scale = Math.min(1, maxW / w);
      var b64 = '';
      var CH = 8192;
      for (var i = 0; i < bytes.length; i += CH) {
        b64 += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
      }
      S.edits.items.push({
        id: 'i' + (++S.itemSeq), type: 'image', page: page,
        x: x, y: y - h * scale, w: w * scale, h: h * scale,
        mime: f.type === 'image/jpeg' ? 'image/jpeg' : 'image/png',
        b64: btoa(b64)
      });
      pushHistory();
      setTool('select');
      scheduleRebuild();
      e.target.value = '';
    });

    $('viewer').addEventListener('scroll', function () {
      clearTimeout(S.scrollTimer);
      S.scrollTimer = setTimeout(function () { renderVisible(false); updatePageInfo(); }, 90);
    });

    document.addEventListener('keydown', function (ev) {
      if (S.editing) return;
      var t = ev.target;
      var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (typing && !(ev.ctrlKey || ev.metaKey)) return;
      var mod = ev.ctrlKey || ev.metaKey;
      if (mod && ev.key.toLowerCase() === 'z') {
        ev.preventDefault();
        ev.shiftKey ? redo() : undo();
      } else if (mod && ev.key.toLowerCase() === 's') {
        ev.preventDefault(); save();
      } else if (mod && ev.key.toLowerCase() === 'o') {
        ev.preventDefault(); $('fileInput').click();
      } else if (!mod && (ev.key === 'Delete' || ev.key === 'Backspace')) {
        if (S.selection) { ev.preventDefault(); deleteSelection(); }
      } else if (!mod && ev.key === 'Escape') {
        select(null);
      } else if (!mod && !ev.altKey) {
        var map = { v: 'select', t: 'text', r: 'rect', o: 'ellipse', l: 'line', d: 'draw', i: 'image' };
        var t = map[ev.key.toLowerCase()];
        if (t && document.activeElement === document.body) { setTool(t); }
      }
    });

    window.addEventListener('beforeunload', function (e) {
      if (hasEdits()) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  function updatePageInfo() {
    if (!S.views.length) return;
    var viewer = $('viewer');
    var mid = viewer.scrollTop + viewer.clientHeight / 2;
    var cur = 0;
    for (var i = 0; i < S.views.length; i++) {
      if (S.views[i].wrap.offsetTop <= mid) cur = i;
    }
    $('pageInfo').textContent = 'Page ' + (cur + 1) + ' of ' + S.views.length;
    document.querySelectorAll('.thumb').forEach(function (t, i) {
      t.classList.toggle('is-current', i === cur);
    });
  }

  wire();
  setTool('select');
  status('Open a PDF to begin. Everything stays on this machine.');

  /* A small scripting surface. Used by the test harness, and handy if
   * you ever want to drive the editor from the console. */
  window.Paper = {
    state: S,
    open: function (bytes, name) {
      return openFile(new File([bytes], name || 'input.pdf', { type: 'application/pdf' }));
    },
    blocks: function (pageIndex) {
      var built = S.blocksByPage.get(pageIndex);
      if (!built) return [];
      return built.blocks.map(function (b) {
        return {
          id: b.id, text: b.text, size: b.size, align: b.align,
          font: b.fontLabel, embedded: b.embedded, lines: b.lines.length,
          x0: b.x0, x1: b.x1, top: b.top, bottom: b.bottom, invisible: b.invisible
        };
      });
    },
    hiddenBlocks: function (pageIndex) {
      var built = S.blocksByPage.get(pageIndex);
      return built ? built.hiddenBlocks.map(function (b) { return { id: b.id, text: b.text }; }) : [];
    },
    setText: function (id, text) {
      var b = findBlock(id);
      if (!b) throw new Error('no such block: ' + id);
      S.edits.blocks[id] = { text: text, style: (S.edits.blocks[id] || {}).style || {} };
      delete S.edits.deleted[id];
      pushHistory();
      return true;
    },
    setStyle: function (id, style) {
      var b = findBlock(id);
      if (!b) throw new Error('no such block: ' + id);
      var cur = S.edits.blocks[id] || { text: b.text, style: {} };
      cur.style = Object.assign({}, cur.style, style);
      S.edits.blocks[id] = cur;
      pushHistory();
      return true;
    },
    remove: function (id) {
      if (!findBlock(id)) throw new Error('no such block: ' + id);
      S.edits.deleted[id] = true;
      delete S.edits.blocks[id];
      pushHistory();
      return true;
    },
    addItem: function (item) {
      item.id = item.id || 'i' + (++S.itemSeq);
      S.edits.items.push(item);
      pushHistory();
      return item.id;
    },
    setField: function (name, value) { S.edits.fields[name] = value; pushHistory(); },
    build: async function () {
      var res = await buildBytes();
      return { bytes: Array.from(res.bytes), report: res.report };
    },
    undo: undo,
    redo: redo,
    ready: function () { return !!S.originalBytes && S.pageCount > 0; },
    pageCount: function () { return S.pageCount; }
  };
})();
