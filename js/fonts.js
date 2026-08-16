/* ------------------------------------------------------------------
 * fonts.js — read the font dictionaries a page actually uses.
 *
 * For every font resource (/F1, /TT3, ...) we work out:
 *   - how many bytes make up one character code
 *   - the advance width of each code (needed to keep surrounding text
 *     from shifting when we remove a run)
 *   - code -> Unicode, so we can show the user real text
 *   - Unicode -> code, so we can repaint using the *original* font and
 *     get a pixel-identical result
 *
 * The Unicode -> code direction is the interesting one. Embedded fonts
 * are almost always subsetted, so a font may simply not contain the
 * glyph the user just typed. canEncode() is how we find out before
 * committing to that path.
 * ------------------------------------------------------------------ */
(function (global) {
  'use strict';

  var PDFLib = global.PDFLib;

  function N(s) { return PDFLib.PDFName.of(s); }

  function look(dict, key) {
    if (!dict || typeof dict.lookup !== 'function') return undefined;
    try { return dict.lookup(N(key)); } catch (e) { return undefined; }
  }

  function numOf(v, dflt) {
    return v && typeof v.asNumber === 'function' ? v.asNumber() : dflt;
  }

  function nameOf(v) {
    if (!v) return null;
    if (typeof v.asString === 'function') { var s = v.asString(); return s[0] === '/' ? s.slice(1) : s; }
    return null;
  }

  function streamBytes(ctx, stream) {
    if (!stream) return null;
    try {
      if (stream instanceof PDFLib.PDFRawStream) return PDFLib.decodePDFRawStream(stream).decode();
      if (typeof stream.getContents === 'function') return stream.getContents();
    } catch (e) { /* corrupt or unsupported filter */ }
    return null;
  }

  /* ---------------- ToUnicode CMap ---------------- */

  function hexVal(bytes) {
    var v = 0;
    for (var i = 0; i < bytes.length; i++) v = (v << 8) | bytes[i];
    return v >>> 0;
  }

  function utf16beToStr(bytes) {
    var s = '';
    for (var i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    if (bytes.length === 1) s = String.fromCharCode(bytes[0]);
    return s;
  }

  function parseToUnicode(buf) {
    var toks;
    try { toks = global.PDFLex.tokenize(buf); } catch (e) { return null; }
    var map = new Map();
    var codeBytes = 0;

    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (t.t !== 'op') continue;

      if (t.v === 'begincodespacerange') {
        for (var j = i + 1; j < toks.length; j++) {
          if (toks[j].t === 'op') { i = j; break; }
          if (toks[j].t === 'str' && !codeBytes) codeBytes = toks[j].bytes.length;
        }
        continue;
      }

      if (t.v === 'beginbfchar') {
        var k = i + 1;
        while (k + 1 < toks.length && toks[k].t !== 'op') {
          var src = toks[k], dst = toks[k + 1];
          if (src.t === 'str' && dst.t === 'str') {
            if (!codeBytes) codeBytes = src.bytes.length;
            map.set(hexVal(src.bytes), utf16beToStr(dst.bytes));
          }
          k += 2;
        }
        i = k;
        continue;
      }

      if (t.v === 'beginbfrange') {
        var m = i + 1;
        while (m + 2 < toks.length && toks[m].t !== 'op') {
          var lo = toks[m], hi = toks[m + 1], to = toks[m + 2];
          if (lo.t === 'str' && hi.t === 'str') {
            if (!codeBytes) codeBytes = lo.bytes.length;
            var a = hexVal(lo.bytes), b = hexVal(hi.bytes);
            if (b - a > 65535) b = a + 65535; // sanity clamp
            if (to.t === 'str') {
              var base = utf16beToStr(to.bytes);
              var lastCp = base.length ? base.charCodeAt(base.length - 1) : 0;
              var prefix = base.slice(0, -1);
              for (var c = a; c <= b; c++) {
                map.set(c, prefix + String.fromCharCode(lastCp + (c - a)));
              }
            } else if (to.t === 'arr') {
              for (var q = 0; q < to.v.length && a + q <= b; q++) {
                if (to.v[q].t === 'str') map.set(a + q, utf16beToStr(to.v[q].bytes));
              }
            }
          }
          m += 3;
        }
        i = m;
        continue;
      }
    }
    return { map: map, codeBytes: codeBytes || 0 };
  }

  /* ---------------- widths ---------------- */

  function parseCIDWidths(wArr) {
    // W := [ c [w1 ... wn]  |  cFirst cLast w ]*
    var widths = new Map();
    if (!wArr || typeof wArr.size !== 'function') return widths;
    var i = 0, n = wArr.size();
    while (i < n) {
      var first = wArr.lookup(i);
      if (!first || typeof first.asNumber !== 'function') { i++; continue; }
      var c = first.asNumber();
      var second = wArr.lookup(i + 1);
      if (second && typeof second.size === 'function') {
        for (var j = 0; j < second.size(); j++) {
          var w = second.lookup(j);
          if (w && typeof w.asNumber === 'function') widths.set(c + j, w.asNumber());
        }
        i += 2;
      } else if (second && typeof second.asNumber === 'function') {
        var last = second.asNumber();
        var third = wArr.lookup(i + 2);
        var wv = third && typeof third.asNumber === 'function' ? third.asNumber() : 0;
        if (last - c > 65535) last = c + 65535;
        for (var cc = c; cc <= last; cc++) widths.set(cc, wv);
        i += 3;
      } else {
        i++;
      }
    }
    return widths;
  }

  /* Rough metrics for the 14 standard fonts, used only when a font
   * carries no Widths array at all. Values are per-1000 units. */
  var STD_W = {
    Courier: null, // monospaced: handled by constant below
    Helvetica: [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584],
    Times: [250,333,408,500,500,833,778,180,333,333,500,564,250,333,250,278,500,500,500,500,500,500,500,500,500,500,278,278,564,564,564,444,921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,333,444,500,444,500,444,333,500,500,278,278,500,278,778,500,500,500,500,333,389,278,500,500,722,500,500,444,480,200,480,541]
  };

  function stdWidthFor(family, code) {
    if (family === 'Courier') return 600;
    var tbl = STD_W[family] || STD_W.Helvetica;
    if (code >= 32 && code <= 126) return tbl[code - 32];
    if (code === 160) return tbl[0];
    return family === 'Times' ? 500 : 556;
  }

  function classifyStandard(baseFont) {
    var b = (baseFont || '').replace(/^[A-Z]{6}\+/, '');
    var lower = b.toLowerCase();
    var bold = /bold|black|heavy|semibold|[-,]bd\b/.test(lower);
    var italic = /italic|oblique|[-,]it\b/.test(lower);
    var family = 'Helvetica';
    if (/times|serif|roman|georgia|garamond|book|minion|cambria|constantia/.test(lower) &&
        !/sans/.test(lower)) family = 'Times';
    if (/courier|mono|consol/.test(lower)) family = 'Courier';
    return { family: family, bold: bold, italic: italic };
  }

  /* ---------------- main entry ---------------- */

  function buildFontInfo(ctx, fontDict, resName) {
    var info = {
      key: resName,
      dict: fontDict,
      subtype: nameOf(look(fontDict, 'Subtype')) || 'Type1',
      baseFont: nameOf(look(fontDict, 'BaseFont')) || '',
      bytesPerCode: 1,
      widths: new Map(),
      defaultWidth: 500,
      toUni: null,
      fromUni: null,
      embedded: false,
      type0: false,
      type3: false,
      fontMatrix: null,
      identityCID: false,
      encodingTable: null
    };

    info.std = classifyStandard(info.baseFont);
    info.type0 = info.subtype === 'Type0';
    info.type3 = info.subtype === 'Type3';

    var descendant = null;
    if (info.type0) {
      info.bytesPerCode = 2;
      var df = look(fontDict, 'DescendantFonts');
      if (df && typeof df.lookup === 'function' && df.size && df.size() > 0) descendant = df.lookup(0);
      var encName = nameOf(look(fontDict, 'Encoding'));
      info.identityCID = encName === 'Identity-H' || encName === 'Identity-V';
      info.cmapName = encName;
    }

    /* --- widths --- */
    if (info.type0 && descendant) {
      info.widths = parseCIDWidths(look(descendant, 'W'));
      info.defaultWidth = numOf(look(descendant, 'DW'), 1000);
    } else {
      var firstChar = numOf(look(fontDict, 'FirstChar'), null);
      var wArr = look(fontDict, 'Widths');
      if (wArr && typeof wArr.size === 'function' && firstChar !== null) {
        for (var i = 0; i < wArr.size(); i++) {
          var w = wArr.lookup(i);
          if (w && typeof w.asNumber === 'function') info.widths.set(firstChar + i, w.asNumber());
        }
      }
    }

    /* --- descriptor / embedded font program --- */
    var fd = look(descendant || fontDict, 'FontDescriptor');
    if (fd) {
      info.missingWidth = numOf(look(fd, 'MissingWidth'), 0);
      info.flags = numOf(look(fd, 'Flags'), 0);
      info.italicAngle = numOf(look(fd, 'ItalicAngle'), 0);
      info.embedded = !!(look(fd, 'FontFile') || look(fd, 'FontFile2') || look(fd, 'FontFile3'));
      if (info.widths.size === 0 && info.missingWidth) info.defaultWidth = info.missingWidth;
    }
    /* Widths are per-1000 for every font type except Type 3, where the
     * font's own FontMatrix defines glyph space. TeX bitmap fonts land
     * here, and getting this wrong makes every advance nonsense. */
    info.unitScale = 0.001;
    if (info.type3) {
      var fm = look(fontDict, 'FontMatrix');
      if (fm && typeof fm.size === 'function' && fm.size() === 6) {
        info.fontMatrix = [];
        for (var f = 0; f < 6; f++) info.fontMatrix.push(numOf(fm.lookup(f), 0));
        if (info.fontMatrix[0]) info.unitScale = info.fontMatrix[0];
      }
    }

    /* --- simple-font encoding table (code -> unicode) --- */
    if (!info.type0) {
      var base = global.PDFEnc.StandardEncoding;
      var enc = look(fontDict, 'Encoding');
      var encName2 = nameOf(enc);
      var symbolic = (info.flags & 4) && !(info.flags & 32);
      if (!encName2 && enc && typeof enc.lookup === 'function') encName2 = nameOf(look(enc, 'BaseEncoding'));
      if (encName2 === 'WinAnsiEncoding') base = global.PDFEnc.WinAnsiEncoding;
      else if (encName2 === 'MacRomanEncoding') base = global.PDFEnc.MacRomanEncoding;
      else if (!symbolic) base = global.PDFEnc.WinAnsiEncoding; // most common in practice
      info.encodingTable = base.slice();

      if (enc && typeof enc.lookup === 'function') {
        var diffs = look(enc, 'Differences');
        if (diffs && typeof diffs.size === 'function') {
          var cur = 0;
          for (var d = 0; d < diffs.size(); d++) {
            var it = diffs.lookup(d);
            if (it && typeof it.asNumber === 'function') { cur = it.asNumber(); continue; }
            var gname = nameOf(it);
            if (gname != null) { info.encodingTable[cur & 0xff] = glyphNameToUnicode(gname); cur++; }
          }
        }
      }
    }

    /* --- ToUnicode --- */
    var tu = look(fontDict, 'ToUnicode');
    var tuBytes = streamBytes(ctx, tu);
    if (tuBytes) {
      var parsed = parseToUnicode(tuBytes);
      if (parsed && parsed.map.size) {
        info.toUni = parsed.map;
        // The ToUnicode codespace tells us how many bytes make a code —
        // including for Type0 fonts that use a single-byte custom CMap,
        // which is what ReportLab and several other generators emit.
        if (parsed.codeBytes === 1 || parsed.codeBytes === 2) info.bytesPerCode = parsed.codeBytes;
      }
    }

    /* --- reverse map: unicode -> code --- */
    var rev = new Map();
    if (info.toUni) {
      info.toUni.forEach(function (str, code) {
        if (str && str.length && !rev.has(str)) rev.set(str, code);
      });
    }
    if (info.encodingTable) {
      for (var c2 = 0; c2 < 256; c2++) {
        var u = info.encodingTable[c2];
        if (u) {
          var ch = String.fromCharCode(u);
          if (!rev.has(ch)) rev.set(ch, c2);
        }
      }
    }
    info.fromUni = rev;

    info.widthOf = function (code) {
      if (this.widths.has(code)) return this.widths.get(code);
      if (this.type0) return this.defaultWidth;
      if (this.widths.size === 0) return stdWidthFor(this.std.family, code);
      return this.missingWidth || this.defaultWidth;
    };

    info.decode = function (bytes) {
      var out = '';
      if (this.bytesPerCode === 2) {
        for (var i = 0; i + 1 < bytes.length; i += 2) {
          var code = (bytes[i] << 8) | bytes[i + 1];
          out += this.toUni && this.toUni.has(code) ? this.toUni.get(code) : '�';
        }
      } else {
        for (var j = 0; j < bytes.length; j++) {
          var c = bytes[j];
          if (this.toUni && this.toUni.has(c)) { out += this.toUni.get(c); continue; }
          var u = this.encodingTable ? this.encodingTable[c] : 0;
          out += u ? String.fromCharCode(u) : (c >= 32 && c < 127 ? String.fromCharCode(c) : '�');
        }
      }
      return out;
    };

    /* Codes for a decoded string, or null if any character is missing
     * from this font. This is the gate for pixel-perfect font reuse. */
    info.codesFor = function (str) {
      if (this.type3) return null;
      // A composite font is safe to reuse as long as we know the exact
      // code -> character mapping, whichever CMap it uses: writing the
      // same codes back reproduces the same glyphs.
      if (this.type0 && !this.identityCID && !this.toUni) return null;
      var codes = [];
      for (var i = 0; i < str.length; i++) {
        var ch = str[i];
        // surrogate pair
        if (ch >= '\uD800' && ch <= '\uDBFF' && i + 1 < str.length) ch = str.substr(i, 2);
        var code = this.fromUni.get(ch);
        if (code === undefined) {
          if (ch === ' ' && this.fromUni.has(' ')) code = this.fromUni.get(' ');
          else return null;
        }
        if (this.bytesPerCode === 1 && code > 255) return null;
        codes.push(code);
        if (ch.length === 2) i++;
      }
      return codes;
    };

    info.canEncode = function (str) { return this.codesFor(str) !== null; };

    /* Advance width of a string in unscaled text-space units (per 1.0 em). */
    info.stringWidth = function (codes) {
      var total = 0;
      for (var i = 0; i < codes.length; i++) total += this.widthOf(codes[i]);
      return total * this.unitScale;
    };

    return info;
  }

  /* Small glyph-name table — enough to interpret the /Differences arrays
   * that real-world PDFs actually emit. Falls back to uniXXXX parsing. */
  var GLYPHS = {
    space: 32, exclam: 33, quotedbl: 34, numbersign: 35, dollar: 36, percent: 37,
    ampersand: 38, quotesingle: 39, quoteright: 0x2019, parenleft: 40, parenright: 41,
    asterisk: 42, plus: 43, comma: 44, hyphen: 45, period: 46, slash: 47,
    zero: 48, one: 49, two: 50, three: 51, four: 52, five: 53, six: 54, seven: 55,
    eight: 56, nine: 57, colon: 58, semicolon: 59, less: 60, equal: 61, greater: 62,
    question: 63, at: 64, bracketleft: 91, backslash: 92, bracketright: 93,
    asciicircum: 94, underscore: 95, grave: 96, quoteleft: 0x2018, braceleft: 123,
    bar: 124, braceright: 125, asciitilde: 126, bullet: 0x2022, Euro: 0x20AC,
    quotedblleft: 0x201C, quotedblright: 0x201D, quotedblbase: 0x201E,
    quotesinglbase: 0x201A, endash: 0x2013, emdash: 0x2014, dagger: 0x2020,
    daggerdbl: 0x2021, ellipsis: 0x2026, perthousand: 0x2030, fi: 0xFB01, fl: 0xFB02,
    ff: 0xFB00, ffi: 0xFB03, ffl: 0xFB04, minus: 0x2212, degree: 0xB0,
    trademark: 0x2122, copyright: 0xA9, registered: 0xAE, sterling: 0xA3, yen: 0xA5,
    cent: 0xA2, currency: 0xA4, section: 0xA7, paragraph: 0xB6, periodcentered: 0xB7,
    guillemotleft: 0xAB, guillemotright: 0xBB, guilsinglleft: 0x2039,
    guilsinglright: 0x203A, exclamdown: 0xA1, questiondown: 0xBF, germandbls: 0xDF,
    ae: 0xE6, AE: 0xC6, oe: 0x153, OE: 0x152, oslash: 0xF8, Oslash: 0xD8,
    dotlessi: 0x131, lslash: 0x142, Lslash: 0x141, fraction: 0x2044, florin: 0x192,
    onehalf: 0xBD, onequarter: 0xBC, threequarters: 0xBE, plusminus: 0xB1,
    multiply: 0xD7, divide: 0xF7, nbspace: 0xA0, uni00A0: 0xA0
  };

  var ACCENTED = 'agrave:E0 aacute:E1 acircumflex:E2 atilde:E3 adieresis:E4 aring:E5 ccedilla:E7 egrave:E8 eacute:E9 ecircumflex:EA edieresis:EB igrave:EC iacute:ED icircumflex:EE idieresis:EF ntilde:F1 ograve:F2 oacute:F3 ocircumflex:F4 otilde:F5 odieresis:F6 ugrave:F9 uacute:FA ucircumflex:FB udieresis:FC yacute:FD ydieresis:FF Agrave:C0 Aacute:C1 Acircumflex:C2 Atilde:C3 Adieresis:C4 Aring:C5 Ccedilla:C7 Egrave:C8 Eacute:C9 Ecircumflex:CA Edieresis:CB Igrave:CC Iacute:CD Icircumflex:CE Idieresis:CF Ntilde:D1 Ograve:D2 Oacute:D3 Ocircumflex:D4 Otilde:D5 Odieresis:D6 Ugrave:D9 Uacute:DA Ucircumflex:DB Udieresis:DC Yacute:DD';
  ACCENTED.split(' ').forEach(function (p) {
    var kv = p.split(':');
    GLYPHS[kv[0]] = parseInt(kv[1], 16);
  });

  function glyphNameToUnicode(name) {
    if (GLYPHS[name] !== undefined) return GLYPHS[name];
    var m = /^uni([0-9A-Fa-f]{4})/.exec(name);
    if (m) return parseInt(m[1], 16);
    m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
    if (m) return parseInt(m[1], 16);
    if (name.length === 1) return name.charCodeAt(0);
    // Names like "g123" / "cid123" / "index42" carry no Unicode meaning.
    return 0;
  }

  /**
   * Build a map of resource name -> FontInfo for one page's Resources.
   */
  function loadFonts(ctx, resources) {
    var out = {};
    if (!resources) return out;
    var fontsDict = look(resources, 'Font');
    if (!fontsDict || typeof fontsDict.keys !== 'function') return out;
    var keys = fontsDict.keys();
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i].asString().replace(/^\//, '');
      var fd;
      try { fd = fontsDict.lookup(keys[i]); } catch (e) { continue; }
      if (!fd || typeof fd.lookup !== 'function') continue;
      try { out[k] = buildFontInfo(ctx, fd, k); }
      catch (e) { console.warn('font parse failed for /' + k, e); }
    }
    return out;
  }

  global.PDFFonts = {
    loadFonts: loadFonts,
    classifyStandard: classifyStandard,
    glyphNameToUnicode: glyphNameToUnicode,
    look: look
  };
})(window);
