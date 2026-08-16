/* ------------------------------------------------------------------
 * engine.js — the part that actually understands the page.
 *
 * analyzePage() walks a page's content stream keeping full graphics and
 * text state, and produces one "run" per text-showing operator: what it
 * says, where it sits, what font and colour painted it, and the exact
 * byte range that drew it.
 *
 * applyEdits() then rewrites the stream: removed runs have their
 * drawing operator spliced out entirely — the glyphs are gone from the
 * file, not covered up — and replacement text is repainted in a second
 * pass, reusing the original font whenever it contains the characters
 * the user typed.
 * ------------------------------------------------------------------ */
(function (global) {
  'use strict';

  var PDFLib = global.PDFLib;
  var PDFName = PDFLib.PDFName;

  /* ---------------- matrix helpers (PDF row-vector convention) -------- */

  var IDENTITY = [1, 0, 0, 1, 0, 0];

  function mul(a, b) {
    return [
      a[0] * b[0] + a[1] * b[2],
      a[0] * b[1] + a[1] * b[3],
      a[2] * b[0] + a[3] * b[2],
      a[2] * b[1] + a[3] * b[3],
      a[4] * b[0] + a[5] * b[2] + b[4],
      a[4] * b[1] + a[5] * b[3] + b[5]
    ];
  }
  function translate(x, y) { return [1, 0, 0, 1, x, y]; }
  function applyPt(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
  function scaleOf(m) { return Math.hypot(m[0], m[1]) || Math.hypot(m[2], m[3]) || 1; }

  /* ---------------- stream access ---------------- */

  function decodeStream(s) {
    if (!s) return null;
    try {
      if (s instanceof PDFLib.PDFRawStream) return PDFLib.decodePDFRawStream(s).decode();
      if (typeof s.getContents === 'function') return s.getContents();
    } catch (e) { console.warn('stream decode failed', e); }
    return null;
  }

  function concatBytes(parts) {
    var total = 0, i;
    for (i = 0; i < parts.length; i++) total += parts[i].length + 1;
    var out = new Uint8Array(total), off = 0;
    for (i = 0; i < parts.length; i++) {
      out.set(parts[i], off); off += parts[i].length;
      out[off++] = 10; // newline between streams, per spec
    }
    return out;
  }

  function pageContentBytes(pdfDoc, page) {
    var ctx = pdfDoc.context;
    var node = page.node;
    var contents = node.get(PDFName.of('Contents'));
    if (contents) contents = ctx.lookup(contents);
    if (!contents) return new Uint8Array(0);
    var parts = [];
    if (contents instanceof PDFLib.PDFArray) {
      for (var i = 0; i < contents.size(); i++) {
        var s = ctx.lookup(contents.get(i));
        var d = decodeStream(s);
        if (d) parts.push(d);
      }
    } else {
      var d2 = decodeStream(contents);
      if (d2) parts.push(d2);
    }
    return concatBytes(parts);
  }

  /* ---------------- byte/string helpers ---------------- */

  function latin1(bytes) {
    var s = '', CH = 8192;
    for (var i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
    }
    return s;
  }
  function toBytes(str) {
    var b = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) b[i] = str.charCodeAt(i) & 0xff;
    return b;
  }
  function hexStr(codes, bytesPerCode) {
    var s = '<';
    for (var i = 0; i < codes.length; i++) {
      var c = codes[i];
      s += bytesPerCode === 2
        ? ('0000' + (c & 0xffff).toString(16)).slice(-4)
        : ('00' + (c & 0xff).toString(16)).slice(-2);
    }
    return s + '>';
  }
  function fmt(n) {
    if (!isFinite(n)) return '0';
    var r = Math.round(n * 1e5) / 1e5;
    return String(r);
  }

  /* ---------------- the analyser ---------------- */

  function analyzePage(pdfDoc, page, pageIndex) {
    var ctx = pdfDoc.context;
    var buf = pageContentBytes(pdfDoc, page);
    var resources = page.node.Resources();
    var fonts = global.PDFFonts.loadFonts(ctx, resources);

    var instrs;
    try { instrs = global.PDFLex.parseContentStream(buf); }
    catch (e) { console.error('content stream parse failed', e); instrs = []; }

    var runs = [];
    var gsStack = [];
    var gs = { ctm: IDENTITY.slice(), fill: [0, 0, 0], stroke: [0, 0, 0], fillCS: 'DeviceGray', alpha: 1 };
    var ts = { font: null, size: 0, Tc: 0, Tw: 0, Th: 100, TL: 0, Ts: 0, Tr: 0 };
    var tm = IDENTITY.slice(), tlm = IDENTITY.slice();
    var inText = false;
    var mcStack = [];
    var currentMCID = null;

    function num(op, i, d) {
      var o = op.operands[i];
      return o && o.t === 'num' ? o.v : d;
    }

    function fontInfo() { return ts.font ? fonts[ts.font] : null; }

    /* Advance produced by showing `codes`, in unscaled text space. */
    function advanceOf(fi, codes) {
      if (!fi) return 0;
      var total = 0;
      for (var i = 0; i < codes.length; i++) {
        var w0 = fi.widthOf(codes[i]) * fi.unitScale;
        var extra = ts.Tc + (fi.bytesPerCode === 1 && codes[i] === 32 ? ts.Tw : 0);
        total += (w0 * ts.size + extra) * (ts.Th / 100);
      }
      return total;
    }

    function decodeCodes(fi, bytes) {
      var codes = [];
      if (!fi) {
        for (var i = 0; i < bytes.length; i++) codes.push(bytes[i]);
        return codes;
      }
      if (fi.bytesPerCode === 2) {
        for (var j = 0; j + 1 < bytes.length; j += 2) codes.push((bytes[j] << 8) | bytes[j + 1]);
      } else {
        for (var k = 0; k < bytes.length; k++) codes.push(bytes[k]);
      }
      return codes;
    }

    function pushRun(instr, idx, pieces) {
      var fi = fontInfo();
      var startTm = tm.slice();
      var param = [ts.size * (ts.Th / 100), 0, 0, ts.size, 0, ts.Ts];
      var trm = mul(param, mul(tm, gs.ctm));

      var text = '', codes = [], advance = 0;
      var synthGaps = [];
      for (var p = 0; p < pieces.length; p++) {
        var piece = pieces[p];
        if (piece.kind === 'adj') {
          advance += (-piece.value / 1000) * ts.size * (ts.Th / 100);
          // A large negative adjustment is how many generators (TeX in
          // particular) draw a word space. Without this the extracted
          // text comes out as "Helloworld".
          var gapEm = -piece.value / 1000;
          if (gapEm > 0.13 && text.length && text[text.length - 1] !== ' ') {
            text += ' ';
            synthGaps.push(gapEm);
          }
          continue;
        }
        var c = decodeCodes(fi, piece.bytes);
        codes = codes.concat(c);
        text += fi ? fi.decode(piece.bytes) : latin1(piece.bytes);
        advance += advanceOf(fi, c);
      }
      var spaceGapEm = synthGaps.length
        ? synthGaps.reduce(function (a, b) { return a + b; }, 0) / synthGaps.length
        : 0;

      // advance the text matrix exactly as the viewer would
      tm = mul(translate(advance, 0), tm);

      var sc = scaleOf(trm);
      var asc = 0.78, desc = -0.22;
      var p0 = applyPt(trm, 0, desc);
      var p1 = applyPt(trm, advance / (ts.size || 1), asc);
      // advance is in Tm space; convert to trm-local units
      var endUser = applyPt(mul(translate(advance, 0), mul(startTm, gs.ctm)), 0, 0);
      var originUser = applyPt(mul(startTm, gs.ctm), 0, 0);

      runs.push({
        id: pageIndex + ':' + runs.length,
        page: pageIndex,
        seq: runs.length,
        instrIndex: idx,
        start: instr.start,
        end: instr.end,
        op: instr.op,
        fontKey: ts.font,
        font: fi,
        size: ts.size,
        Tc: ts.Tc, Tw: ts.Tw, Th: ts.Th, Ts: ts.Ts, Tr: ts.Tr, TL: ts.TL,
        tm: startTm,
        ctm: gs.ctm.slice(),
        trm: trm,
        fill: gs.fill.slice(),
        alpha: gs.alpha,
        text: text,
        codes: codes,
        advance: advance,
        spaceGapEm: spaceGapEm,
        mcid: currentMCID,
        invisible: ts.Tr === 3 || ts.Tr === 7 || gs.alpha === 0,
        effSize: sc,
        x0: Math.min(originUser[0], endUser[0]),
        x1: Math.max(originUser[0], endUser[0]),
        baseY: originUser[1],
        top: Math.max(p0[1], p1[1]),
        bottom: Math.min(p0[1], p1[1])
      });
    }

    for (var i = 0; i < instrs.length; i++) {
      var instr = instrs[i];
      var op = instr.op;

      switch (op) {
        case 'q':
          gsStack.push({ ctm: gs.ctm.slice(), fill: gs.fill.slice(), stroke: gs.stroke.slice(), fillCS: gs.fillCS, alpha: gs.alpha });
          break;
        case 'Q':
          if (gsStack.length) {
            var g = gsStack.pop();
            gs.ctm = g.ctm; gs.fill = g.fill; gs.stroke = g.stroke; gs.fillCS = g.fillCS; gs.alpha = g.alpha;
          }
          break;
        case 'cm':
          gs.ctm = mul([num(instr, 0, 1), num(instr, 1, 0), num(instr, 2, 0), num(instr, 3, 1), num(instr, 4, 0), num(instr, 5, 0)], gs.ctm);
          break;

        case 'g':  gs.fill = [num(instr, 0, 0), num(instr, 0, 0), num(instr, 0, 0)]; gs.fillCS = 'DeviceGray'; break;
        case 'rg': gs.fill = [num(instr, 0, 0), num(instr, 1, 0), num(instr, 2, 0)]; gs.fillCS = 'DeviceRGB'; break;
        case 'k': {
          var c0 = num(instr, 0, 0), m0 = num(instr, 1, 0), y0 = num(instr, 2, 0), k0 = num(instr, 3, 0);
          gs.fill = [(1 - c0) * (1 - k0), (1 - m0) * (1 - k0), (1 - y0) * (1 - k0)];
          gs.fillCS = 'DeviceCMYK';
          break;
        }
        case 'cs': gs.fillCS = instr.operands[0] && instr.operands[0].t === 'name' ? instr.operands[0].v : gs.fillCS; break;
        case 'sc':
        case 'scn': {
          var nums = instr.operands.filter(function (o) { return o.t === 'num'; }).map(function (o) { return o.v; });
          if (nums.length === 1) gs.fill = [nums[0], nums[0], nums[0]];
          else if (nums.length === 3) gs.fill = nums.slice(0, 3);
          else if (nums.length === 4) gs.fill = [(1 - nums[0]) * (1 - nums[3]), (1 - nums[1]) * (1 - nums[3]), (1 - nums[2]) * (1 - nums[3])];
          break;
        }
        case 'gs': {
          // external graphics state — pick up fill alpha so we can spot
          // fully transparent text
          var gname = instr.operands[0] && instr.operands[0].t === 'name' ? instr.operands[0].v : null;
          if (gname && resources) {
            var eg = global.PDFFonts.look(resources, 'ExtGState');
            var st = eg ? global.PDFFonts.look(eg, gname) : null;
            var ca = st ? global.PDFFonts.look(st, 'ca') : null;
            if (ca && typeof ca.asNumber === 'function') gs.alpha = ca.asNumber();
          }
          break;
        }

        case 'BDC': {
          var props = instr.operands[1];
          var mcid = null;
          if (props && props.t === 'dict' && props.v.MCID && props.v.MCID.t === 'num') mcid = props.v.MCID.v;
          mcStack.push(currentMCID);
          if (mcid !== null) currentMCID = mcid;
          break;
        }
        case 'BMC': mcStack.push(currentMCID); break;
        case 'EMC': currentMCID = mcStack.length ? mcStack.pop() : null; break;

        case 'BT': inText = true; tm = IDENTITY.slice(); tlm = IDENTITY.slice(); break;
        case 'ET': inText = false; break;

        case 'Tf':
          ts.font = instr.operands[0] && instr.operands[0].t === 'name' ? instr.operands[0].v : ts.font;
          ts.size = num(instr, 1, ts.size);
          break;
        case 'Tc': ts.Tc = num(instr, 0, 0); break;
        case 'Tw': ts.Tw = num(instr, 0, 0); break;
        case 'Tz': ts.Th = num(instr, 0, 100); break;
        case 'TL': ts.TL = num(instr, 0, 0); break;
        case 'Ts': ts.Ts = num(instr, 0, 0); break;
        case 'Tr': ts.Tr = num(instr, 0, 0); break;

        case 'Td':
          tlm = mul(translate(num(instr, 0, 0), num(instr, 1, 0)), tlm);
          tm = tlm.slice();
          break;
        case 'TD':
          ts.TL = -num(instr, 1, 0);
          tlm = mul(translate(num(instr, 0, 0), num(instr, 1, 0)), tlm);
          tm = tlm.slice();
          break;
        case 'Tm':
          tlm = [num(instr, 0, 1), num(instr, 1, 0), num(instr, 2, 0), num(instr, 3, 1), num(instr, 4, 0), num(instr, 5, 0)];
          tm = tlm.slice();
          break;
        case 'T*':
          tlm = mul(translate(0, -ts.TL), tlm);
          tm = tlm.slice();
          break;

        case 'Tj': {
          var s = instr.operands[instr.operands.length - 1];
          if (s && s.t === 'str') pushRun(instr, i, [{ kind: 'str', bytes: s.bytes }]);
          break;
        }
        case "'": {
          tlm = mul(translate(0, -ts.TL), tlm); tm = tlm.slice();
          var s2 = instr.operands[instr.operands.length - 1];
          if (s2 && s2.t === 'str') pushRun(instr, i, [{ kind: 'str', bytes: s2.bytes }]);
          break;
        }
        case '"': {
          ts.Tw = num(instr, 0, ts.Tw);
          ts.Tc = num(instr, 1, ts.Tc);
          tlm = mul(translate(0, -ts.TL), tlm); tm = tlm.slice();
          var s3 = instr.operands[instr.operands.length - 1];
          if (s3 && s3.t === 'str') pushRun(instr, i, [{ kind: 'str', bytes: s3.bytes }]);
          break;
        }
        case 'TJ': {
          var arr = instr.operands[instr.operands.length - 1];
          if (arr && arr.t === 'arr') {
            var pieces = [];
            for (var a = 0; a < arr.v.length; a++) {
              var el = arr.v[a];
              if (el.t === 'str') pieces.push({ kind: 'str', bytes: el.bytes });
              else if (el.t === 'num') pieces.push({ kind: 'adj', value: el.v });
            }
            if (pieces.length) pushRun(instr, i, pieces);
          }
          break;
        }
      }
    }

    var box;
    try { box = page.getMediaBox(); } catch (e) { box = { x: 0, y: 0, width: 612, height: 792 }; }

    return {
      pageIndex: pageIndex,
      buf: buf,
      instrs: instrs,
      runs: runs,
      fonts: fonts,
      resources: resources,
      box: box
    };
  }

  /* ------------------------------------------------------------------
   * Removal: does taking this run out shift anything after it?
   *
   * Only if a *kept* Tj/TJ follows it inside the same BT..ET block with
   * no repositioning operator in between. Anything that repositions
   * (Td/TD/Tm/T*) or ends the block makes compensation unnecessary.
   * ---------------------------------------------------------------- */
  function needsCompensation(analysis, run, removedSet) {
    var instrs = analysis.instrs;
    for (var i = run.instrIndex + 1; i < instrs.length; i++) {
      var op = instrs[i].op;
      if (op === 'Td' || op === 'TD' || op === 'Tm' || op === 'T*' || op === 'ET' ||
          op === 'BT' || op === "'" || op === '"') return false;
      if (op === 'Tj' || op === 'TJ') {
        // find the run that belongs to this instruction
        var other = null;
        for (var r = 0; r < analysis.runs.length; r++) {
          if (analysis.runs[r].instrIndex === i) { other = analysis.runs[r]; break; }
        }
        if (!other) return true;
        if (!removedSet.has(other.id)) return true; // a kept run depends on our advance
        // that one is going too — keep looking
      }
    }
    return false;
  }

  function compensationFor(run) {
    // `'` and `"` also perform a line feed; preserve it.
    var prefix = '';
    if (run.op === "'") prefix = 'T*\n';
    else if (run.op === '"') prefix = fmt(run.Tw) + ' Tw ' + fmt(run.Tc) + ' Tc T*\n';
    if (!run.advance || !run.size) return prefix;
    var N = -1000 * run.advance / (run.size * (run.Th / 100));
    if (!isFinite(N) || Math.abs(N) < 1e-6) return prefix;
    return prefix + '[' + fmt(N) + '] TJ\n';
  }

  /* ------------------------------------------------------------------
   * Text layout for repainted content.
   * ---------------------------------------------------------------- */

  function measure(fitter, text) { return fitter.width(text); }

  function wrapText(text, maxWidth, fitter) {
    var paragraphs = String(text).split('\n');
    var lines = [];
    for (var p = 0; p < paragraphs.length; p++) {
      var words = paragraphs[p].split(/(\s+)/).filter(function (w) { return w !== ''; });
      if (!words.length) { lines.push({ text: '', hard: true }); continue; }
      var cur = '';
      for (var w = 0; w < words.length; w++) {
        var candidate = cur + words[w];
        if (maxWidth > 0 && cur !== '' && measure(fitter, candidate.replace(/\s+$/, '')) > maxWidth) {
          lines.push({ text: cur.replace(/\s+$/, ''), hard: false });
          cur = /^\s+$/.test(words[w]) ? '' : words[w];
        } else {
          cur = candidate;
        }
      }
      lines.push({ text: cur.replace(/\s+$/, ''), hard: true });
    }
    return lines;
  }

  global.PDFEngine = {
    analyzePage: analyzePage,
    pageContentBytes: pageContentBytes,
    needsCompensation: needsCompensation,
    compensationFor: compensationFor,
    wrapText: wrapText,
    mul: mul,
    translate: translate,
    applyPt: applyPt,
    scaleOf: scaleOf,
    latin1: latin1,
    toBytes: toBytes,
    hexStr: hexStr,
    fmt: fmt,
    decodeStream: decodeStream,
    IDENTITY: IDENTITY
  };
})(window);
