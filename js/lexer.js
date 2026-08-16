/* ------------------------------------------------------------------
 * lexer.js — PDF content-stream tokenizer / parser
 *
 * Turns the raw bytes of a page content stream into a flat list of
 * instructions:  { op, operands, start, end }
 * where [start, end) is the exact byte range the instruction occupies
 * in the source buffer (operands included).  Keeping byte ranges is
 * what lets us splice individual drawing operators out of a page
 * without re-serialising anything we don't understand.
 * ------------------------------------------------------------------ */
(function (global) {
  'use strict';

  var WS = new Uint8Array(256);
  [0, 9, 10, 12, 13, 32].forEach(function (c) { WS[c] = 1; });

  var DELIM = new Uint8Array(256);
  '()<>[]{}/%'.split('').forEach(function (c) { DELIM[c.charCodeAt(0)] = 1; });

  function isWS(c) { return WS[c] === 1; }
  function isDelim(c) { return DELIM[c] === 1; }
  function isRegular(c) { return WS[c] !== 1 && DELIM[c] !== 1; }

  /* Operators that take no operands but matter to us, plus the full set
   * of text operators. Anything not listed is still parsed generically. */
  var SHOW_OPS = { Tj: 1, TJ: 1, "'": 1, '"': 1 };

  function Lexer(buf) {
    this.buf = buf;
    this.pos = 0;
    this.len = buf.length;
  }

  Lexer.prototype.skipWS = function () {
    var b = this.buf;
    while (this.pos < this.len) {
      var c = b[this.pos];
      if (WS[c]) { this.pos++; continue; }
      if (c === 0x25) { // '%' comment runs to EOL
        while (this.pos < this.len && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
        continue;
      }
      break;
    }
  };

  /* ---- literal string  ( ... ) with balanced parens and escapes ---- */
  Lexer.prototype.readLiteralString = function () {
    var b = this.buf, out = [], depth = 1;
    this.pos++; // consume '('
    while (this.pos < this.len) {
      var c = b[this.pos++];
      if (c === 0x5c) { // backslash
        var e = b[this.pos++];
        switch (e) {
          case 0x6e: out.push(10); break;          // \n
          case 0x72: out.push(13); break;          // \r
          case 0x74: out.push(9); break;           // \t
          case 0x62: out.push(8); break;           // \b
          case 0x66: out.push(12); break;          // \f
          case 0x28: out.push(0x28); break;        // \(
          case 0x29: out.push(0x29); break;        // \)
          case 0x5c: out.push(0x5c); break;        // \\
          case 13: if (b[this.pos] === 10) this.pos++; break; // line continuation
          case 10: break;
          default:
            if (e >= 0x30 && e <= 0x37) {          // octal, 1-3 digits
              var v = e - 0x30, n = 1;
              while (n < 3 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37) {
                v = v * 8 + (b[this.pos++] - 0x30); n++;
              }
              out.push(v & 0xff);
            } else {
              out.push(e);
            }
        }
        continue;
      }
      if (c === 0x28) { depth++; out.push(c); continue; }
      if (c === 0x29) { depth--; if (depth === 0) break; out.push(c); continue; }
      out.push(c);
    }
    return { t: 'str', hex: false, bytes: new Uint8Array(out) };
  };

  /* ---- hex string  < ... > ---- */
  Lexer.prototype.readHexString = function () {
    var b = this.buf, out = [], digits = [];
    this.pos++; // consume '<'
    while (this.pos < this.len) {
      var c = b[this.pos++];
      if (c === 0x3e) break; // '>'
      var d = -1;
      if (c >= 0x30 && c <= 0x39) d = c - 0x30;
      else if (c >= 0x41 && c <= 0x46) d = c - 0x37;
      else if (c >= 0x61 && c <= 0x66) d = c - 0x57;
      if (d >= 0) digits.push(d);
    }
    if (digits.length & 1) digits.push(0); // odd trailing digit is padded
    for (var i = 0; i < digits.length; i += 2) out.push((digits[i] << 4) | digits[i + 1]);
    return { t: 'str', hex: true, bytes: new Uint8Array(out) };
  };

  /* ---- name  /Foo  (with #xx escapes) ---- */
  Lexer.prototype.readName = function () {
    var b = this.buf, s = '';
    this.pos++; // consume '/'
    while (this.pos < this.len && isRegular(b[this.pos])) {
      var c = b[this.pos++];
      if (c === 0x23 && this.pos + 1 < this.len) { // '#'
        var hex = String.fromCharCode(b[this.pos], b[this.pos + 1]);
        var v = parseInt(hex, 16);
        if (!isNaN(v)) { s += String.fromCharCode(v); this.pos += 2; continue; }
      }
      s += String.fromCharCode(c);
    }
    return { t: 'name', v: s };
  };

  Lexer.prototype.readNumberOrOp = function () {
    var b = this.buf, start = this.pos, s = '';
    while (this.pos < this.len && isRegular(b[this.pos])) s += String.fromCharCode(b[this.pos++]);
    if (s.length === 0) { this.pos++; return null; } // stray delimiter, skip
    if (/^[+-]?(\d+\.?\d*|\.\d+|\.)$/.test(s)) {
      var n = parseFloat(s);
      return { t: 'num', v: isNaN(n) ? 0 : n };
    }
    return { t: 'op', v: s, start: start };
  };

  /* Parse one object (operand). Returns null at a token we can't use. */
  Lexer.prototype.readObject = function () {
    this.skipWS();
    if (this.pos >= this.len) return null;
    var b = this.buf, c = b[this.pos];

    if (c === 0x2f) return this.readName();
    if (c === 0x28) return this.readLiteralString();
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) { // '<<' dictionary
        this.pos += 2;
        var map = {};
        for (;;) {
          this.skipWS();
          if (this.pos >= this.len) break;
          if (b[this.pos] === 0x3e && b[this.pos + 1] === 0x3e) { this.pos += 2; break; }
          var k = this.readObject();
          if (!k) break;
          if (k.t !== 'name') continue;
          var v = this.readObject();
          if (!v) break;
          map[k.v] = v;
        }
        return { t: 'dict', v: map };
      }
      return this.readHexString();
    }
    if (c === 0x5b) { // '['
      this.pos++;
      var items = [];
      for (;;) {
        this.skipWS();
        if (this.pos >= this.len) break;
        if (b[this.pos] === 0x5d) { this.pos++; break; }
        var it = this.readObject();
        if (!it) break;
        if (it.t === 'op') continue; // shouldn't happen inside an array
        items.push(it);
      }
      return { t: 'arr', v: items };
    }
    if (c === 0x5d || c === 0x3e || c === 0x7b || c === 0x7d) { this.pos++; return this.readObject(); }

    return this.readNumberOrOp();
  };

  /* Skip an inline image (BI ... ID <binary> EI). We must not let the
   * binary payload be interpreted as operators. */
  Lexer.prototype.skipInlineImage = function (dict) {
    var b = this.buf;
    // We are positioned just after 'ID'. Exactly one whitespace byte follows.
    if (this.pos < this.len && isWS(b[this.pos])) this.pos++;
    // If the dict declares a length, trust it.
    var L = dict && (dict.L || dict.Length);
    if (L && L.t === 'num') {
      this.pos += L.v;
      // then scan forward to EI
    }
    while (this.pos < this.len - 1) {
      if (b[this.pos] === 0x45 && b[this.pos + 1] === 0x49) { // 'EI'
        var before = this.pos === 0 ? 32 : b[this.pos - 1];
        var after = this.pos + 2 >= this.len ? 32 : b[this.pos + 2];
        if (isWS(before) && (isWS(after) || isDelim(after) || this.pos + 2 >= this.len)) {
          this.pos += 2;
          return;
        }
      }
      this.pos++;
    }
    this.pos = this.len;
  };

  /**
   * Parse a whole content stream into instructions.
   * @param {Uint8Array} buf
   * @returns {Array<{op:string, operands:Array, start:number, end:number}>}
   */
  function parseContentStream(buf) {
    var lex = new Lexer(buf);
    var out = [];
    var operands = [];
    var instStart = -1;

    while (lex.pos < lex.len) {
      lex.skipWS();
      if (lex.pos >= lex.len) break;
      var opStart = lex.pos;
      if (instStart < 0) instStart = opStart;

      var obj = lex.readObject();
      if (!obj) break;

      if (obj.t !== 'op') {
        operands.push(obj);
        if (operands.length > 64) operands.shift(); // runaway guard
        continue;
      }

      var op = obj.v;

      if (op === 'BI') {
        // gather the inline-image dict until ID
        var idict = {};
        for (;;) {
          lex.skipWS();
          if (lex.pos >= lex.len) break;
          var save = lex.pos;
          var k = lex.readObject();
          if (!k) break;
          if (k.t === 'op' && k.v === 'ID') break;
          if (k.t !== 'name') { lex.pos = save; lex.pos++; continue; }
          var v = lex.readObject();
          if (!v) break;
          idict[k.v] = v;
        }
        lex.skipInlineImage(idict);
        out.push({ op: 'INLINE_IMAGE', operands: [], start: instStart, end: lex.pos });
        operands = [];
        instStart = -1;
        continue;
      }

      out.push({ op: op, operands: operands, start: instStart, end: lex.pos, opStart: opStart });
      operands = [];
      instStart = -1;
    }
    return out;
  }

  /** Flat token list — used for CMap parsing, where operands can run long. */
  function tokenize(buf) {
    var lex = new Lexer(buf);
    var out = [];
    while (lex.pos < lex.len) {
      lex.skipWS();
      if (lex.pos >= lex.len) break;
      var before = lex.pos;
      var obj = lex.readObject();
      if (!obj) break;
      if (lex.pos === before) { lex.pos++; continue; } // safety: never stall
      out.push(obj);
    }
    return out;
  }

  global.PDFLex = {
    parseContentStream: parseContentStream,
    tokenize: tokenize,
    SHOW_OPS: SHOW_OPS,
    isWS: isWS,
    isDelim: isDelim
  };
})(window);
