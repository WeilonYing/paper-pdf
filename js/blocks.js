/* ------------------------------------------------------------------
 * blocks.js — assemble raw runs into things a person would click on.
 *
 * A PDF has no paragraphs, so we reconstruct them. Runs become lines;
 * lines split at column gaps so table cells stay individually editable;
 * lines then merge into paragraphs when they align, sit a consistent
 * leading apart, share a font size, and — crucially — the line above
 * actually reached the column edge, meaning it wrapped rather than
 * ended on purpose.
 *
 * Where a document is tagged, marked-content IDs are trusted over
 * geometry: runs sharing an MCID belong to the same logical element by
 * construction, which beats any heuristic.
 * ------------------------------------------------------------------ */
(function (global) {
  'use strict';

  function angleBucket(run) {
    return Math.round(Math.atan2(run.trm[1], run.trm[0]) * 180 / Math.PI);
  }

  /* ---- runs -> lines (split at column gaps) ---- */

  function buildLines(runs) {
    var byAngle = new Map();
    runs.forEach(function (r) {
      var k = angleBucket(r);
      if (!byAngle.has(k)) byAngle.set(k, []);
      byAngle.get(k).push(r);
    });

    var rows = [];
    byAngle.forEach(function (group, angle) {
      var sorted = group.slice().sort(function (a, b) {
        if (Math.abs(a.baseY - b.baseY) > 0.5) return b.baseY - a.baseY;
        return a.x0 - b.x0;
      });
      var cur = null;
      for (var i = 0; i < sorted.length; i++) {
        var r = sorted[i];
        var tol = Math.max(0.5, r.effSize * 0.32);
        var sameRow = cur && Math.abs(cur.baseY - r.baseY) <= tol;
        // superscripts, drop caps and inline maths sit off the baseline
        // but continue the line horizontally
        if (!sameRow && cur && Math.abs(cur.baseY - r.baseY) <= r.effSize * 0.9) {
          var g = r.x0 - cur.x1;
          if (g > -r.effSize * 0.5 && g < r.effSize * 1.2) sameRow = true;
        }
        if (sameRow) {
          cur.runs.push(r);
          cur.x1 = Math.max(cur.x1, r.x1);
          cur.size = Math.max(cur.size, r.effSize);
          cur.top = Math.max(cur.top, r.top);
          cur.bottom = Math.min(cur.bottom, r.bottom);
        } else {
          cur = { angle: angle, baseY: r.baseY, x0: r.x0, x1: r.x1,
                  size: r.effSize, top: r.top, bottom: r.bottom, runs: [r] };
          rows.push(cur);
        }
      }
    });

    // split each row where a gap is wide enough to be a column break
    var lines = [];
    rows.forEach(function (row) {
      row.runs.sort(function (a, b) { return a.x0 - b.x0; });
      var seg = null;
      for (var i = 0; i < row.runs.length; i++) {
        var r = row.runs[i];
        if (seg) {
          var prev = seg.runs[seg.runs.length - 1];
          var gap = r.x0 - prev.x1;
          if (gap > Math.max(2.2 * Math.max(prev.effSize, r.effSize), 10)) seg = null;
        }
        if (!seg) {
          seg = { angle: row.angle, baseY: row.baseY, x0: r.x0, x1: r.x1,
                  size: r.effSize, top: r.top, bottom: r.bottom, runs: [r] };
          lines.push(seg);
        } else {
          seg.runs.push(r);
          seg.x1 = Math.max(seg.x1, r.x1);
          seg.size = Math.max(seg.size, r.effSize);
          seg.top = Math.max(seg.top, r.top);
          seg.bottom = Math.min(seg.bottom, r.bottom);
        }
      }
    });

    lines.forEach(function (l) {
      var t = '';
      for (var i = 0; i < l.runs.length; i++) {
        var r = l.runs[i];
        if (i > 0) {
          var gap = r.x0 - l.runs[i - 1].x1;
          var threshold = Math.max(0.16 * r.effSize, 0.6);
          if (gap > threshold && t && t[t.length - 1] !== ' ' && r.text[0] !== ' ') t += ' ';
        }
        t += r.text;
      }
      l.text = t;
      l.mcids = new Set(l.runs.map(function (r) { return r.mcid; })
        .filter(function (m) { return m != null; }));
    });

    lines.sort(function (a, b) {
      if (Math.abs(a.baseY - b.baseY) > 0.5) return b.baseY - a.baseY;
      return a.x0 - b.x0;
    });
    return lines;
  }

  /* ---- page-level context: where do columns actually end? ---- */

  function pageContext(lines, box) {
    var counts = new Map();
    lines.forEach(function (l) {
      var k = Math.round(l.x1 / 4) * 4;
      counts.set(k, (counts.get(k) || 0) + 1);
    });
    var edges = [];
    counts.forEach(function (n, k) { if (n >= 3) edges.push(k); });
    if (!edges.length && lines.length) {
      edges = [Math.max.apply(null, lines.map(function (l) { return l.x1; }))];
    }
    edges.sort(function (a, b) { return a - b; });

    var gaps = [];
    for (var i = 1; i < lines.length; i++) {
      var g = lines[i - 1].baseY - lines[i].baseY;
      if (g > 0.5 && g < 80) gaps.push(Math.round(g * 2) / 2);
    }
    var tally = new Map(), modal = 0, best = 0;
    gaps.forEach(function (g) {
      var n = (tally.get(g) || 0) + 1;
      tally.set(g, n);
      if (n > best) { best = n; modal = g; }
    });

    return {
      edges: edges,
      modalLeading: modal || 0,
      centerX: box ? box.x + box.width / 2 : 306
    };
  }

  /* Sits flush against one of the page's repeated right edges — the
   * signature of justified text. */
  function atKnownEdge(line, ctx) {
    var tol = Math.max(3, line.size * 1.1);
    for (var i = 0; i < ctx.edges.length; i++) {
      if (Math.abs(line.x1 - ctx.edges[i]) <= tol) return true;
    }
    return false;
  }

  /* How far right does this line's column actually run? Measured from
   * the lines that share its horizontal band, so multi-column layouts
   * and side-by-side tables don't contaminate each other. */
  function columnRight(lines, idx) {
    var me = lines[idx];
    var maxX1 = me.x1;
    for (var j = 0; j < lines.length; j++) {
      var o = lines[j];
      if (o === me) continue;
      var overlap = Math.min(me.x1, o.x1) - Math.max(me.x0, o.x0);
      var shorter = Math.min(me.x1 - me.x0, o.x1 - o.x0);
      if (shorter > 0 && overlap > shorter * 0.5) maxX1 = Math.max(maxX1, o.x1);
    }
    return maxX1;
  }

  /* The real question isn't "is this line long?" — ragged-right text is
   * never flush. It's "did the next word fail to fit?". If the first
   * word of the following line would have overflowed the column, the
   * line above wrapped; otherwise it ended deliberately. */
  function wrappedInto(prev, next, colRight, ctx) {
    if (atKnownEdge(prev, ctx)) return true;
    var chars = Math.max(1, next.text.length);
    var avgChar = (next.x1 - next.x0) / chars;
    if (!isFinite(avgChar) || avgChar <= 0) avgChar = next.size * 0.5;
    var firstWord = (next.text.match(/^\S+/) || [''])[0];
    var needed = (firstWord.length + 1) * avgChar;
    return prev.x1 + needed > colRight - 1;
  }

  function sharesMCID(a, b) {
    if (!a.mcids.size || !b.mcids.size) return false;
    var found = false;
    a.mcids.forEach(function (m) { if (b.mcids.has(m)) found = true; });
    return found;
  }

  /* ---- lines -> paragraphs ---- */

  function buildBlocks(lines, ctx, pageIndex, tag) {
    var blocks = [];
    var cur = null;

    function flush() {
      if (!cur) return;
      finishBlock(cur, ctx);
      blocks.push(cur);
      cur = null;
    }

    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (!cur) { cur = newBlock(l, pageIndex, blocks.length, tag); continue; }

      var prev = cur.lines[cur.lines.length - 1];
      var gap = prev.baseY - l.baseY;
      var maxSize = Math.max(prev.size, l.size);
      var sizeRatio = Math.min(prev.size, l.size) / (maxSize || 1);
      var leadingOk = ctx.modalLeading
        ? gap > 0 && gap <= ctx.modalLeading * 1.35
        : gap > 0 && gap < maxSize * 1.9;
      var sameFont = prev.runs[prev.runs.length - 1].fontKey === l.runs[0].fontKey;
      var wrapped = wrappedInto(prev, l, columnRight(lines, i - 1), ctx);

      var merge = false, joinWithSpace = true;
      if (sharesMCID(prev, l) && gap >= -0.2) {
        merge = true;                       // tagged: the file says so
        joinWithSpace = wrapped;
      } else if (
        l.angle === prev.angle &&
        leadingOk &&
        sizeRatio > 0.82 &&
        sameFont &&
        Math.min(prev.x1, l.x1) - Math.max(prev.x0, l.x0) > 0 &&
        (Math.abs(l.x0 - cur.x0) < maxSize * 0.6 ||
         (l.x0 - cur.x0 > 0 && l.x0 - cur.x0 < maxSize * 3)) &&
        wrapped
      ) {
        merge = true;
      }

      if (merge) { l.joinWithSpace = joinWithSpace; addLine(cur, l); }
      else { flush(); cur = newBlock(l, pageIndex, blocks.length, tag); }
    }
    flush();
    return blocks;
  }

  function newBlock(line, pageIndex, seq, tag) {
    return {
      id: pageIndex + tag + seq,
      page: pageIndex,
      lines: [line],
      x0: line.x0, x1: line.x1, maxX1: line.x1,
      top: line.top, bottom: line.bottom,
      size: line.size, angle: line.angle
    };
  }

  function addLine(block, line) {
    block.lines.push(line);
    block.x0 = Math.min(block.x0, line.x0);
    block.x1 = Math.max(block.x1, line.x1);
    block.maxX1 = Math.max(block.maxX1, line.x1);
    block.top = Math.max(block.top, line.top);
    block.bottom = Math.min(block.bottom, line.bottom);
    block.size = Math.max(block.size, line.size);
  }

  function finishBlock(block, ctx) {
    var parts = [];
    for (var i = 0; i < block.lines.length; i++) {
      var l = block.lines[i];
      if (i > 0) {
        var wrapped = l.joinWithSpace !== false;
        var joiner = wrapped ? ' ' : '\n';
        if (wrapped && /[‐-]$/.test(parts[parts.length - 1] || '')) {
          parts[parts.length - 1] = parts[parts.length - 1].replace(/[‐-]$/, '');
          joiner = '';
        }
        parts.push(joiner);
      }
      parts.push(l.text);
    }
    block.text = parts.join('');
    block.runs = [];
    block.lines.forEach(function (l) { block.runs = block.runs.concat(l.runs); });
    block.runIds = block.runs.map(function (r) { return r.id; });
    block.anchorRun = block.lines[0].runs[0];
    block.invisible = block.runs.every(function (r) { return r.invisible; });
    block.fill = block.anchorRun.fill;
    block.leading = global.PDFWriter.detectLeading(block.lines, block.size * 1.18);
    block.fontLabel = block.anchorRun.font
      ? (block.anchorRun.font.baseFont || 'unnamed').replace(/^[A-Z]{6}\+/, '')
      : 'unknown';
    block.embedded = !!(block.anchorRun.font && block.anchorRun.font.embedded);

    // A single line carries no alignment evidence of its own. Fall back
    // to where it sits on the page: dead-centre almost always means it
    // was centred on purpose.
    if (block.lines.length > 1) {
      block.align = global.PDFWriter.detectAlignment(
        block.lines.map(function (l) { return { x0: l.x0, x1: l.x1 }; })
      );
      block.noWrap = false;
    } else {
      var mid = (block.x0 + block.x1) / 2;
      block.align = Math.abs(mid - ctx.centerX) <= Math.max(3, block.size * 0.25) ? 'center' : 'left';
      // A lone line has no column to wrap inside — let it grow instead.
      block.noWrap = true;
    }
  }

  function build(analysis) {
    var usable = analysis.runs.filter(function (r) {
      return r.text && r.text.trim() !== '' && isFinite(r.x0) && isFinite(r.baseY);
    });
    var visible = usable.filter(function (r) { return !r.invisible; });
    var hidden = usable.filter(function (r) { return r.invisible; });

    var vLines = buildLines(visible);
    var vCtx = pageContext(vLines, analysis.box);
    var blocks = buildBlocks(vLines, vCtx, analysis.pageIndex, '#');

    var hLines = buildLines(hidden);
    var hCtx = pageContext(hLines, analysis.box);
    var hiddenBlocks = buildBlocks(hLines, hCtx, analysis.pageIndex, '~');
    hiddenBlocks.forEach(function (b) { b.invisible = true; });

    return { blocks: blocks, hiddenBlocks: hiddenBlocks, ctx: vCtx };
  }

  global.PDFBlocks = { build: build, buildLines: buildLines, pageContext: pageContext };
})(window);
