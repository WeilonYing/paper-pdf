/* ------------------------------------------------------------------
 * writer.js — turn an edit list into new PDF bytes.
 *
 * Two passes per page:
 *   1. Splice the original content stream, deleting the drawing
 *      operators for every run the user removed or replaced. Where
 *      removal would shift neighbouring text, an equivalent zero-ink
 *      advance is left in its place.
 *   2. Append a fresh stream that paints the replacement text, plus any
 *      shapes and images, on top.
 *
 * Nothing is whited out. The original glyphs are gone from the file, so
 * the page background — gradients, scans, shaded table cells — survives
 * untouched, and the old words can't be recovered with Ctrl+F.
 * ------------------------------------------------------------------ */
(function (global) {
  'use strict';

  var PDFLib = global.PDFLib;
  var PDFName = PDFLib.PDFName;
  var E = global.PDFEngine;
  var fmt = E.fmt;

  /* ---------------- font resolution ----------------
   *
   * A resolver hands back an object with:
   *   parts(str)      -> array of '<hex>' tokens and numeric adjustments
   *   width(str,size) -> advance width in points
   * The caller assembles parts into a `[ ... ] TJ`, which is valid
   * regardless of whether spaces are real glyphs or pure gaps.
   */

  function FontResolver(pdfDoc, page, cache) {
    this.doc = pdfDoc;
    this.page = page;
    this.cache = cache;
  }

  FontResolver.prototype.embedStandard = function (family, bold, italic) {
    var S = PDFLib.StandardFonts;
    var name;
    if (family === 'Courier') {
      name = bold && italic ? S.CourierBoldOblique : bold ? S.CourierBold : italic ? S.CourierOblique : S.Courier;
    } else if (family === 'Times') {
      name = bold && italic ? S.TimesRomanBoldItalic : bold ? S.TimesRomanBold : italic ? S.TimesRomanItalic : S.TimesRoman;
    } else {
      name = bold && italic ? S.HelveticaBoldOblique : bold ? S.HelveticaBold : italic ? S.HelveticaOblique : S.Helvetica;
    }
    if (!this.cache.std[name]) this.cache.std[name] = this.doc.embedStandardFont(name);
    return { font: this.cache.std[name], label: String(name) };
  };

  FontResolver.prototype.resNameFor = function (fontObj) {
    var perPage = this.cache.resNames.get(this.page);
    if (!perPage) { perPage = new Map(); this.cache.resNames.set(this.page, perPage); }
    var refKey = String(fontObj.ref);
    if (perPage.has(refKey)) return perPage.get(refKey);
    var key = this.page.node.newFontDictionary('PEF', fontObj.ref);
    var nm = key.asString().replace(/^\//, '');
    perPage.set(refKey, nm);
    return nm;
  };

  function reuseAdapter(fi, resName, spaceGapEm) {
    var hasSpace = fi.fromUni.has(' ');
    var gap = spaceGapEm || 0.25;
    return {
      mode: 'reuse',
      resName: resName,
      label: (fi.baseFont || 'embedded font').replace(/^[A-Z]{6}\+/, ''),
      spaceWidth: function (size) {
        if (hasSpace) return (fi.widthOf(fi.fromUni.get(' ')) / 1000) * size;
        return gap * size;
      },
      parts: function (str) {
        if (str === '') return [];
        if (hasSpace) {
          var codes = fi.codesFor(str);
          if (!codes) return null;
          return [E.hexStr(codes, fi.bytesPerCode)];
        }
        // no space glyph in the subset: draw the gaps as TJ adjustments
        var out = [];
        var words = str.split(' ');
        for (var i = 0; i < words.length; i++) {
          if (words[i] !== '') {
            var c = fi.codesFor(words[i]);
            if (!c) return null;
            out.push(E.hexStr(c, fi.bytesPerCode));
          }
          if (i < words.length - 1) out.push(-1000 * gap);
        }
        return out;
      },
      width: function (str, size) {
        var total = 0;
        var words = str.split(' ');
        for (var i = 0; i < words.length; i++) {
          var c = fi.codesFor(words[i]);
          if (c) total += fi.stringWidth(c) * size;
          else total += size * 0.5 * words[i].length;
          if (i < words.length - 1) total += this.spaceWidth(size);
        }
        return total;
      },
      canDo: function (str) {
        var words = str.replace(/\n/g, ' ').split(' ');
        for (var i = 0; i < words.length; i++) {
          if (words[i] !== '' && !fi.codesFor(words[i])) return false;
        }
        return hasSpace ? fi.codesFor(' ') !== null || true : true;
      }
    };
  }

  function libFontAdapter(f, resName, label, mode) {
    return {
      mode: mode,
      resName: resName,
      label: label,
      spaceWidth: function (size) { return f.widthOfTextAtSize(' ', size); },
      parts: function (str) {
        if (str === '') return [];
        try { return [f.encodeText(str).toString()]; } catch (e) { return null; }
      },
      width: function (str, size) {
        try { return f.widthOfTextAtSize(str, size); } catch (e) { return size * 0.5 * str.length; }
      },
      canDo: function (str) {
        try { f.encodeText(str); return true; } catch (e) { return false; }
      }
    };
  }

  FontResolver.prototype.resolve = function (run, text, style) {
    var forced = style && style.font;
    var flat = String(text).replace(/\n/g, ' ');

    // 1. Reuse the original embedded font when it can spell the text.
    if ((!forced || forced === 'auto') && run && run.font) {
      var ad = reuseAdapter(run.font, run.fontKey, run.spaceGapEm);
      if (ad.canDo(flat)) return ad;
    }

    // 2. A font the user supplied.
    if (this.cache.custom && (forced === 'custom' || !forced || forced === 'auto')) {
      var ca = libFontAdapter(this.cache.custom, this.resNameFor(this.cache.custom),
        this.cache.customName || 'custom font', 'custom');
      if (forced === 'custom' || ca.canDo(flat)) return ca;
    }

    // 3. Standard 14, matched as closely as the original's name allows.
    var cls = run && run.font ? run.font.std : { family: 'Helvetica', bold: false, italic: false };
    if (style && style.family) cls = { family: style.family, bold: !!style.bold, italic: !!style.italic };
    var std = this.embedStandard(cls.family, cls.bold, cls.italic);
    var sa = libFontAdapter(std.font, this.resNameFor(std.font), std.label, 'standard');
    if (sa.canDo(flat)) return sa;

    // 4. Last resort: strip what WinAnsi can't express so the user still
    //    gets output rather than a silent failure.
    var stripped = {
      mode: 'standard-lossy',
      resName: sa.resName,
      label: std.label + ' (some characters unavailable)',
      spaceWidth: sa.spaceWidth,
      parts: function (str) {
        var clean = '';
        for (var i = 0; i < str.length; i++) {
          try { std.font.encodeText(str[i]); clean += str[i]; } catch (e) { clean += '?'; }
        }
        return sa.parts(clean);
      },
      width: function (str, size) {
        var clean = str.replace(/[^\x00-\xff]/g, '?');
        return sa.width(clean, size);
      },
      canDo: function () { return true; }
    };
    return stripped;
  };

  /* ---------------- line grouping & alignment ---------------- */

  function groupLines(runs) {
    var sorted = runs.slice().sort(function (a, b) {
      if (Math.abs(a.baseY - b.baseY) > 0.6) return b.baseY - a.baseY;
      return a.x0 - b.x0;
    });
    var lines = [];
    for (var i = 0; i < sorted.length; i++) {
      var r = sorted[i];
      var last = lines[lines.length - 1];
      if (last && Math.abs(last.baseY - r.baseY) <= Math.max(0.6, r.effSize * 0.3)) {
        last.runs.push(r);
        last.x0 = Math.min(last.x0, r.x0);
        last.x1 = Math.max(last.x1, r.x1);
      } else {
        lines.push({ baseY: r.baseY, x0: r.x0, x1: r.x1, runs: [r] });
      }
    }
    return lines;
  }

  function detectAlignment(lines) {
    if (lines.length < 2) return 'left';
    var x0 = Math.min.apply(null, lines.map(function (l) { return l.x0; }));
    var x1 = Math.max.apply(null, lines.map(function (l) { return l.x1; }));
    var tol = 1.5;
    var leftAligned = 0, rightAligned = 0, centered = 0, full = 0;
    var body = lines.slice(0, -1);
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (Math.abs(l.x0 - x0) <= tol) leftAligned++;
      if (Math.abs(l.x1 - x1) <= tol) rightAligned++;
      if (Math.abs((l.x0 + l.x1) / 2 - (x0 + x1) / 2) <= tol) centered++;
    }
    for (var j = 0; j < body.length; j++) {
      if (Math.abs(body[j].x0 - x0) <= tol && Math.abs(body[j].x1 - x1) <= tol) full++;
    }
    if (body.length > 1 && full === body.length) return 'justify';
    if (leftAligned === lines.length) return 'left';
    if (rightAligned === lines.length) return 'right';
    if (centered === lines.length) return 'center';
    return 'left';
  }

  function detectLeading(lines, fallback) {
    if (lines.length < 2) return fallback;
    var gaps = [];
    for (var i = 1; i < lines.length; i++) gaps.push(lines[i - 1].baseY - lines[i].baseY);
    gaps.sort(function (a, b) { return a - b; });
    var med = gaps[Math.floor(gaps.length / 2)];
    return med > 0 ? med : fallback;
  }

  /* ---------------- painting ---------------- */

  function unitMatrixFor(run) {
    var t = run.trm;
    var s = run.effSize || 1;
    return [t[0] / s, t[1] / s, t[2] / s, t[3] / s, t[4], t[5]];
  }

  function emitTJ(out, tokens) {
    if (!tokens || !tokens.length) return;
    var body = tokens.map(function (t) { return typeof t === 'number' ? fmt(t) : t; }).join(' ');
    out.push('[' + body + '] TJ');
  }

  function paintTextBlock(out, block, resolver) {
    var runs = block.runs;
    var anchor = block.anchorRun || runs[0];
    var lines = groupLines(runs);
    var align = block.style.align || block.detectedAlign || detectAlignment(lines);
    var boxX0 = Math.min.apply(null, lines.map(function (l) { return l.x0; }));
    var boxX1 = Math.max.apply(null, lines.map(function (l) { return l.x1; }));
    var width = Math.max(1, (block.style.width || (boxX1 - boxX0)));

    var size = block.style.size != null ? block.style.size : anchor.effSize;
    var leading = block.style.leading != null ? block.style.leading : detectLeading(lines, size * 1.18);

    var fr = resolver.resolve(anchor, block.text, block.style);
    if (!fr) return null;

    var fitter = { width: function (s) { return fr.width(s, size); } };
    var wrapped = E.wrapText(block.text, block.style.noWrap ? 0 : width, fitter);
    var color = block.style.color || anchor.fill;
    var baseTm = unitMatrixFor(anchor);
    var offsetFromAnchor = boxX0 - anchor.x0;

    out.push('BT');
    if (anchor.Tr === 3 || anchor.Tr === 7) out.push(fmt(anchor.Tr) + ' Tr');
    out.push('/' + fr.resName + ' ' + fmt(size) + ' Tf');
    out.push(fmt(color[0]) + ' ' + fmt(color[1]) + ' ' + fmt(color[2]) + ' rg');

    for (var i = 0; i < wrapped.length; i++) {
      var line = wrapped[i];
      if (line.text === '') continue;
      var lw = fr.width(line.text, size);
      var dx = 0;
      if (align === 'center') dx = (width - lw) / 2;
      else if (align === 'right') dx = width - lw;

      var lineTm = E.mul(E.translate(offsetFromAnchor + dx, -leading * i), baseTm);
      out.push(lineTm.map(fmt).join(' ') + ' Tm');

      var tokens;
      if (align === 'justify' && !line.hard && line.text.indexOf(' ') > 0) {
        var words = line.text.split(' ').filter(function (w) { return w !== ''; });
        var gapCount = words.length - 1;
        var natural = fr.spaceWidth(size);
        var wordsWidth = 0;
        for (var w = 0; w < words.length; w++) wordsWidth += fr.width(words[w], size);
        var per = gapCount > 0 ? (width - wordsWidth) / gapCount : natural;
        tokens = [];
        for (var q = 0; q < words.length; q++) {
          var wp = fr.parts(words[q]);
          if (!wp) return null;
          tokens = tokens.concat(wp);
          if (q < words.length - 1) tokens.push(-1000 * per / size);
        }
      } else {
        tokens = fr.parts(line.text);
        if (!tokens) return null;
      }
      emitTJ(out, tokens);
    }
    out.push('ET');
    return fr;
  }

  function paintNewText(out, item, resolver) {
    var style = item.style || {};
    var size = style.size || 12;
    var fr = resolver.resolve(null, item.text, {
      font: style.font,
      family: style.family || 'Helvetica',
      bold: style.bold, italic: style.italic
    });
    var color = style.color || [0, 0, 0];
    var fitter = { width: function (s) { return fr.width(s, size); } };
    var width = item.width || 0;
    var wrapped = E.wrapText(item.text, width, fitter);
    var leading = style.leading || size * 1.2;
    var rot = (style.rotate || 0) * Math.PI / 180;
    var c = Math.cos(rot), s2 = Math.sin(rot);
    var baseTm = [c, s2, -s2, c, item.x, item.y];

    out.push('BT');
    out.push('/' + fr.resName + ' ' + fmt(size) + ' Tf');
    out.push(fmt(color[0]) + ' ' + fmt(color[1]) + ' ' + fmt(color[2]) + ' rg');
    for (var i = 0; i < wrapped.length; i++) {
      if (wrapped[i].text === '') continue;
      var lw = fr.width(wrapped[i].text, size);
      var dx = 0;
      if (style.align === 'center' && width) dx = (width - lw) / 2;
      else if (style.align === 'right' && width) dx = width - lw;
      var tm = E.mul(E.translate(dx, -leading * i), baseTm);
      out.push(tm.map(fmt).join(' ') + ' Tm');
      emitTJ(out, fr.parts(wrapped[i].text));
    }
    out.push('ET');
  }

  function paintShape(out, item) {
    var lw = item.lineWidth != null ? item.lineWidth : 1;
    out.push('q');
    out.push(fmt(lw) + ' w 1 J 1 j');
    if (item.stroke) out.push(item.stroke.map(fmt).join(' ') + ' RG');
    if (item.fill) out.push(item.fill.map(fmt).join(' ') + ' rg');

    if (item.kind === 'rect') {
      out.push([fmt(item.x), fmt(item.y), fmt(item.w), fmt(item.h)].join(' ') + ' re');
    } else if (item.kind === 'line') {
      out.push(fmt(item.x1) + ' ' + fmt(item.y1) + ' m ' + fmt(item.x2) + ' ' + fmt(item.y2) + ' l');
    } else if (item.kind === 'ellipse') {
      var cx = item.x + item.w / 2, cy = item.y + item.h / 2;
      var rx = Math.abs(item.w / 2), ry = Math.abs(item.h / 2);
      var k = 0.5523;
      out.push(fmt(cx + rx) + ' ' + fmt(cy) + ' m');
      out.push([cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry].map(fmt).join(' ') + ' c');
      out.push([cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy].map(fmt).join(' ') + ' c');
      out.push([cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry].map(fmt).join(' ') + ' c');
      out.push([cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy].map(fmt).join(' ') + ' c');
    } else if (item.kind === 'path') {
      var pts = item.points || [];
      if (pts.length < 2) { out.push('Q'); return; }
      out.push(fmt(pts[0][0]) + ' ' + fmt(pts[0][1]) + ' m');
      for (var i = 1; i < pts.length; i++) out.push(fmt(pts[i][0]) + ' ' + fmt(pts[i][1]) + ' l');
    }

    var isOpen = item.kind === 'line' || item.kind === 'path';
    var hasFill = !!item.fill && !isOpen;
    var hasStroke = !!item.stroke;
    if (isOpen) out.push('S');
    else if (hasFill && hasStroke) out.push('B');
    else if (hasFill) out.push('f');
    else out.push('S');
    out.push('Q');
  }

  async function paintImage(out, item, pdfDoc, page, report) {
    try {
      var img = item.mime === 'image/jpeg'
        ? await pdfDoc.embedJpg(item.bytes)
        : await pdfDoc.embedPng(item.bytes);
      var key = page.node.newXObject('Img', img.ref);
      var nm = key.asString().replace(/^\//, '');
      out.push('q');
      out.push([fmt(item.w), '0', '0', fmt(item.h), fmt(item.x), fmt(item.y)].join(' ') + ' cm');
      out.push('/' + nm + ' Do');
      out.push('Q');
    } catch (e) {
      report.warnings.push('Image could not be embedded: ' + e.message);
    }
  }

  /* ---------------- the main apply ---------------- */

  async function applyEdits(pdfDoc, analyses, edits, opts) {
    opts = opts || {};
    var ctx = pdfDoc.context;
    var cache = { std: {}, custom: null, customName: null, resNames: new Map() };
    var report = { reused: 0, substituted: 0, removed: 0, painted: 0, warnings: [] };

    if (opts.customFontBytes && opts.fontkit) {
      try {
        pdfDoc.registerFontkit(opts.fontkit);
        cache.custom = await pdfDoc.embedFont(opts.customFontBytes, { subset: true });
        cache.customName = opts.customFontName || 'custom';
      } catch (e) {
        report.warnings.push('Could not embed the supplied font: ' + e.message);
      }
    }

    var pages = pdfDoc.getPages();
    var byPage = new Map();
    function bucket(pi) {
      if (!byPage.has(pi)) byPage.set(pi, { removedRunIds: new Set(), blocks: [], items: [] });
      return byPage.get(pi);
    }

    (edits.textBlocks || []).forEach(function (b) {
      var bk = bucket(b.page);
      (b.runIds || []).forEach(function (id) { bk.removedRunIds.add(id); });
      bk.blocks.push(b);
    });
    (edits.deletions || []).forEach(function (d) {
      var bk = bucket(d.page);
      (d.runIds || []).forEach(function (id) { bk.removedRunIds.add(id); });
    });
    (edits.newItems || []).forEach(function (it) { bucket(it.page).items.push(it); });

    var entries = Array.from(byPage.entries());
    for (var e0 = 0; e0 < entries.length; e0++) {
      var pi = entries[e0][0], work = entries[e0][1];
      var page = pages[pi];
      var analysis = analyses.get(pi);
      if (!page || !analysis) continue;

      var resolver = new FontResolver(pdfDoc, page, cache);
      var runById = new Map();
      analysis.runs.forEach(function (r) { runById.set(r.id, r); });

      /* ---- pass 1: splice out the removed drawing operators ---- */
      var cuts = [];
      work.removedRunIds.forEach(function (id) {
        var run = runById.get(id);
        if (!run) return;
        var replacement;
        if (E.needsCompensation(analysis, run, work.removedRunIds)) {
          replacement = E.compensationFor(run);
        } else if (run.op === "'") {
          replacement = 'T*\n';
        } else if (run.op === '"') {
          replacement = fmt(run.Tw) + ' Tw ' + fmt(run.Tc) + ' Tc T*\n';
        } else {
          replacement = '';
        }
        cuts.push({ start: run.start, end: run.end, text: replacement });
        report.removed++;
      });
      cuts.sort(function (a, b) { return a.start - b.start; });

      var pieces = [], cursor = 0;
      for (var c2 = 0; c2 < cuts.length; c2++) {
        if (cuts[c2].start < cursor) continue;
        pieces.push(E.latin1(analysis.buf.subarray(cursor, cuts[c2].start)));
        pieces.push(cuts[c2].text);
        cursor = cuts[c2].end;
      }
      pieces.push(E.latin1(analysis.buf.subarray(cursor)));
      var mainText = pieces.join('');

      /* ---- pass 2: paint replacements and new content ---- */
      var out = [];
      for (var b2 = 0; b2 < work.blocks.length; b2++) {
        var block = work.blocks[b2];
        block.runs = (block.runIds || []).map(function (id) { return runById.get(id); }).filter(Boolean);
        if (!block.runs.length || !block.text) continue;
        var fr = paintTextBlock(out, block, resolver);
        if (!fr) {
          report.warnings.push('Page ' + (pi + 1) + ': replacement text could not be encoded.');
        } else {
          report.painted++;
          if (fr.mode === 'reuse') report.reused++; else report.substituted++;
        }
      }

      for (var it = 0; it < work.items.length; it++) {
        var item = work.items[it];
        if (item.type === 'text') paintNewText(out, item, resolver);
        else if (item.type === 'shape') paintShape(out, item);
        else if (item.type === 'image') await paintImage(out, item, pdfDoc, page, report);
      }

      /* ---- write the stream back ---- */
      var finalText = 'q\n' + mainText + '\nQ\n';
      if (out.length) finalText += 'q\n' + out.join('\n') + '\nQ\n';

      var stream = ctx.flateStream(E.toBytes(finalText));
      var ref = ctx.register(stream);
      page.node.set(PDFName.of('Contents'), ref);
      page.contentStream = undefined;
      page.contentStreamRef = undefined;
    }

    /* ---- form fields ---- */
    if (edits.fields && Object.keys(edits.fields).length) {
      try {
        var form = pdfDoc.getForm();
        Object.keys(edits.fields).forEach(function (name) {
          var v = edits.fields[name];
          try {
            var f = form.getField(name);
            if (!f) return;
            if (typeof f.setText === 'function') f.setText(v == null ? '' : String(v));
            else if (typeof f.check === 'function') { if (v) f.check(); else f.uncheck(); }
            else if (typeof f.select === 'function' && v) f.select(String(v));
          } catch (err) { report.warnings.push('Field "' + name + '": ' + err.message); }
        });
        try { form.updateFieldAppearances(); } catch (err2) { /* keep existing appearances */ }
      } catch (e3) {
        report.warnings.push('No editable form found in this file.');
      }
    }

    if (edits.flatten) {
      try { pdfDoc.getForm().flatten(); } catch (e4) { /* nothing to flatten */ }
    }

    return report;
  }

  global.PDFWriter = {
    applyEdits: applyEdits,
    groupLines: groupLines,
    detectAlignment: detectAlignment,
    detectLeading: detectLeading,
    FontResolver: FontResolver
  };
})(window);
