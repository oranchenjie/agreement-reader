/**
 * 纯 JavaScript PDF 文本提取器。
 *
 * 设计目标：在真实世界的用户协议 / 隐私政策 / 服务条款 PDF（Word、LaTeX、浏览器打印导出）
 * 上尽量稳健地抽取可读文本，遇到损坏或未知结构时降级而不是抛异常。
 *
 * 仅使用 Node.js 内置模块（node:zlib、node:buffer），零第三方依赖。
 *
 * 支持：
 *  - 经典 xref 表与 xref 流（/Type /XRef，PDF 1.5+），含 /Prev 链与 /XRefStm
 *  - 对象流 /Type /ObjStm
 *  - FlateDecode / ASCIIHexDecode / ASCII85Decode / LZWDecode / RunLengthDecode
 *  - /DecodeParms /Predictor（PNG 10-15 与 TIFF 2）
 *  - ToUnicode CMap（bfchar / bfrange，含数组形式）、/Encoding 与 /Differences、
 *    Type0 + Identity-H 双字节 CID 字体、内嵌 CMap 的 codespacerange
 *  - 文本算子（BT/ET/Tj/TJ/引号算子、Td/TD/T 星号/TL/Tm/Tz/Tc/Tw）、表单 XObject、内联图像跳过
 */

import zlib from './zlib-compat.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const MAX_FORM_DEPTH = 8;
const MAX_PAGES_DEFAULT = 2000;
const MAX_CHUNKS = 400000;
const MAX_TEXT_LENGTH = 20 * 1024 * 1024;
const MAX_SCAN_CANDIDATES = 8;
const MAX_OBJECTS_FOR_SCAN = 60000;
const MAX_FALLBACK_STREAMS = 4000;

const WARN_NO_HEADER = '未检测到 PDF 文件头（%PDF-），文件可能已损坏或不是 PDF';
const WARN_ENCRYPTED = 'PDF 已加密，无法提取文本';
const WARN_SCANNED = '检测到扫描版 PDF：未找到可提取文本层';
const WARN_NO_Tounicode = '字体缺少 ToUnicode 映射，部分字符可能不准';
const WARN_XREF_FALLBACK = '交叉引用表解析失败，已改用线性扫描恢复对象';
const WARN_NO_PAGES = '未能通过页面树定位页面，已尝试按内容流顺序提取';

// ---------------------------------------------------------------------------
// 基础 PDF 对象
// ---------------------------------------------------------------------------

class PdfName {
  constructor(name) {
    this.name = name;
  }
  toString() {
    return '/' + this.name;
  }
}

class PdfRef {
  constructor(num, gen) {
    this.num = num;
    this.gen = gen;
  }
  toString() {
    return `${this.num} ${this.gen} R`;
  }
}

class PdfString {
  constructor(bytes) {
    this.bytes = bytes;
    this._latin1 = null;
  }
  get latin1() {
    if (this._latin1 === null) this._latin1 = this.bytes.toString('latin1');
    return this._latin1;
  }
}

class PdfStream {
  constructor(dict, rawBytes, doc) {
    this.dict = dict;
    this.rawBytes = rawBytes;
    this.doc = doc;
  }
}

function nameOf(v) {
  return v instanceof PdfName ? v.name : null;
}

function isDict(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof PdfName) && !(v instanceof PdfRef) && !(v instanceof PdfString) && !(v instanceof PdfStream);
}

// ---------------------------------------------------------------------------
// 词法分析器（工作在 latin1 字符串上：字符码 === 字节值）
// ---------------------------------------------------------------------------

function isWhiteCode(c) {
  return c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
}

function isDelimCode(c) {
  return (
    c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b ||
    c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25
  );
}

function parseNumberToken(tok) {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) return null;
  const v = Number(tok);
  return Number.isFinite(v) ? v : null;
}

class Lexer {
  constructor(doc, pos = 0) {
    this.doc = doc;
    this.s = doc && doc.str ? doc.str : '';
    this.pos = pos;
  }

  get length() {
    return this.s.length;
  }

  skipWs() {
    const s = this.s;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (isWhiteCode(c)) {
        this.pos++;
        continue;
      }
      if (c === 0x25) {
        // '%' 注释：直到行尾
        while (this.pos < s.length) {
          const d = s.charCodeAt(this.pos);
          if (d === 10 || d === 13) break;
          this.pos++;
        }
        continue;
      }
      break;
    }
  }

  /** 读取一段连续的正规字符；调用方需保证当前不是空白/分隔符 */
  readRegularToken() {
    const s = this.s;
    const start = this.pos;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (isWhiteCode(c) || isDelimCode(c)) break;
      this.pos++;
    }
    return s.slice(start, this.pos);
  }

  parseName() {
    this.pos++; // 跳过 '/'
    const s = this.s;
    let out = '';
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (isWhiteCode(c) || isDelimCode(c)) break;
      if (c === 0x23 && this.pos + 2 < s.length) {
        const v = parseInt(s.substr(this.pos + 1, 2), 16);
        if (!Number.isNaN(v)) {
          out += String.fromCharCode(v);
          this.pos += 3;
          continue;
        }
      }
      out += s[this.pos];
      this.pos++;
    }
    return new PdfName(out);
  }

  parseLiteralString() {
    this.pos++; // 跳过 '('
    const s = this.s;
    const bytes = [];
    let depth = 1;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (c === 0x5c) {
        this.pos++;
        if (this.pos >= s.length) break;
        const e = s.charCodeAt(this.pos);
        switch (e) {
          case 0x6e: bytes.push(10); this.pos++; break; // \n
          case 0x72: bytes.push(13); this.pos++; break; // \r
          case 0x74: bytes.push(9); this.pos++; break;  // \t
          case 0x62: bytes.push(8); this.pos++; break;  // \b
          case 0x66: bytes.push(12); this.pos++; break; // \f
          case 0x28: bytes.push(40); this.pos++; break;
          case 0x29: bytes.push(41); this.pos++; break;
          case 0x5c: bytes.push(92); this.pos++; break;
          case 0x0d:
            this.pos++;
            if (s.charCodeAt(this.pos) === 10) this.pos++;
            break;
          case 0x0a:
            this.pos++;
            break;
          default:
            if (e >= 0x30 && e <= 0x37) {
              let oct = '';
              for (let k = 0; k < 3 && this.pos < s.length; k++) {
                const d = s.charCodeAt(this.pos);
                if (d < 0x30 || d > 0x37) break;
                oct += s[this.pos];
                this.pos++;
              }
              bytes.push(parseInt(oct, 8) & 0xff);
            } else {
              bytes.push(e & 0xff);
              this.pos++;
            }
        }
        continue;
      }
      if (c === 0x28) {
        depth++;
        bytes.push(40);
        this.pos++;
        continue;
      }
      if (c === 0x29) {
        depth--;
        this.pos++;
        if (depth === 0) break;
        bytes.push(41);
        continue;
      }
      if (c === 0x0d) {
        // 字符串内的裸 CR 视为 LF
        bytes.push(10);
        this.pos++;
        if (s.charCodeAt(this.pos) === 10) this.pos++;
        continue;
      }
      bytes.push(c & 0xff);
      this.pos++;
    }
    return new PdfString(Buffer.from(bytes));
  }

  parseHexString() {
    this.pos++; // 跳过 '<'
    const s = this.s;
    let hex = '';
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (c === 0x3e) {
        this.pos++;
        break;
      }
      const ch = s[this.pos];
      if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)) {
        hex += ch;
      }
      this.pos++;
    }
    if (hex.length % 2) hex += '0';
    return new PdfString(Buffer.from(hex, 'hex'));
  }

  parseArray(resolve) {
    this.pos++; // '['
    const arr = [];
    const s = this.s;
    while (this.pos < s.length && arr.length < 1000000) {
      this.skipWs();
      if (this.pos >= s.length) break;
      if (s.charCodeAt(this.pos) === 0x5d) {
        this.pos++;
        break;
      }
      const before = this.pos;
      const v = this.parseValue(resolve);
      if (v !== undefined) arr.push(v);
      if (this.pos === before) this.pos++;
    }
    return arr;
  }

  parseDict(resolve) {
    this.pos += 2; // '<<'
    const dict = {};
    const s = this.s;
    while (this.pos < s.length) {
      this.skipWs();
      if (this.pos >= s.length) break;
      if (s.charCodeAt(this.pos) === 0x3e && s.charCodeAt(this.pos + 1) === 0x3e) {
        this.pos += 2;
        break;
      }
      const before = this.pos;
      const key = this.parseValue(false);
      if (!(key instanceof PdfName)) {
        if (this.pos === before) this.pos++;
        continue;
      }
      const val = this.parseValue(resolve);
      dict[key.name] = val === undefined ? null : val;
      if (this.pos === before) this.pos++;
    }
    return dict;
  }

  parseValue(resolve = false) {
    this.skipWs();
    const s = this.s;
    if (this.pos >= s.length) return undefined;
    const c = s.charCodeAt(this.pos);

    if (c === 0x2f) return this.parseName();
    if (c === 0x28) return this.parseLiteralString();
    if (c === 0x3c) {
      if (s.charCodeAt(this.pos + 1) === 0x3c) return this.parseDict(resolve);
      return this.parseHexString();
    }
    if (c === 0x5b) return this.parseArray(resolve);
    if (c === 0x5d || c === 0x3e || c === 0x29 || c === 0x7b || c === 0x7d) {
      this.pos++;
      return null;
    }
    if (c === 0x2b || c === 0x2d || c === 0x2e || (c >= 0x30 && c <= 0x39)) {
      return this.parseNumberOrRef(resolve);
    }

    const tok = this.readRegularToken();
    if (tok === '') {
      this.pos++;
      return null;
    }
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    return { keyword: tok };
  }

  parseNumberOrRef(resolve) {
    const tok = this.readRegularToken();
    const val = parseNumberToken(tok);
    if (val === null) return { keyword: tok };
    // 始终识别 "N G R" 间接引用；是否立即解引用由 resolve 决定
    if (Number.isInteger(val) && val >= 0) {
      const save = this.pos;
      this.skipWs();
      const tok2 = this.readRegularToken();
      if (/^\d+$/.test(tok2)) {
        this.skipWs();
        const tok3 = this.readRegularToken();
        if (tok3 === 'R') {
          const ref = new PdfRef(val, parseInt(tok2, 10));
          return resolve ? this.doc.resolve(ref) : ref;
        }
      }
      this.pos = save;
    }
    return val;
  }

  matchKeyword(word) {
    return this.s.startsWith(word, this.pos);
  }
}

// ---------------------------------------------------------------------------
// 流过滤器
// ---------------------------------------------------------------------------

/** Flate 解码：依次尝试 zlib 头、截断容忍（Z_SYNC_FLUSH）、raw deflate */
function inflateBytes(data) {
  const attempts = [
    () => zlib.inflateSync(data),
    () => zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }),
    () => zlib.inflateRawSync(data),
    () => zlib.inflateRawSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }),
  ];
  for (const fn of attempts) {
    try {
      const out = fn();
      if (out && out.length >= 0) return out;
    } catch {
      /* 继续尝试 */
    }
  }
  return null;
}

function asciiHexDecode(data) {
  let hex = '';
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b === 0x3e) break; // '>'
    if ((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66)) {
      hex += String.fromCharCode(b);
    }
  }
  if (hex.length % 2) hex += '0';
  return Buffer.from(hex, 'hex');
}

function ascii85Decode(data) {
  const out = [];
  let tuple = 0;
  let count = 0;
  let i = 0;
  if (data.length >= 2 && data[0] === 0x3c && data[1] === 0x7e) i = 2; // '<~'
  for (; i < data.length; i++) {
    const c = data[i];
    if (c === 0x7e) break; // '~'
    if (isWhiteCode(c)) continue;
    if (c === 0x7a && count === 0) {
      out.push(Buffer.from([0, 0, 0, 0]));
      continue;
    }
    if (c < 0x21 || c > 0x75) continue;
    tuple = (tuple * 85 + (c - 33)) % 4294967296;
    count++;
    if (count === 5) {
      out.push(
        Buffer.from([
          Math.floor(tuple / 0x1000000) & 0xff,
          Math.floor(tuple / 0x10000) & 0xff,
          Math.floor(tuple / 0x100) & 0xff,
          tuple & 0xff,
        ])
      );
      tuple = 0;
      count = 0;
    }
  }
  if (count > 0) {
    const n = count;
    for (let k = n; k < 5; k++) tuple = (tuple * 85 + 84) % 4294967296;
    const bytes = [
      Math.floor(tuple / 0x1000000) & 0xff,
      Math.floor(tuple / 0x10000) & 0xff,
      Math.floor(tuple / 0x100) & 0xff,
      tuple & 0xff,
    ];
    out.push(Buffer.from(bytes.slice(0, n - 1)));
  }
  return Buffer.concat(out);
}

function runLengthDecode(data) {
  const chunks = [];
  let i = 0;
  while (i < data.length) {
    const l = data[i++];
    if (l === 128) break;
    if (l < 128) {
      const n = l + 1;
      chunks.push(data.subarray(i, Math.min(i + n, data.length)));
      i += n;
    } else {
      const n = 257 - l;
      const b = i < data.length ? data[i++] : 0;
      chunks.push(Buffer.alloc(n, b));
    }
  }
  return Buffer.concat(chunks);
}

/** PDF 变体 LZW（MSB first，EarlyChange 默认 1） */
function lzwDecode(input, earlyChange = 1) {
  const chunks = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < 256; i++) dict.push([i]);
    dict.push(null, null); // 256=ClearTable, 257=EOD
  };
  let dict = [];
  reset();
  let codeLen = 9;
  let prev = null;
  let bitBuf = 0;
  let bitCnt = 0;
  let pos = 0;

  const nextCode = () => {
    while (bitCnt < codeLen && pos < input.length) {
      bitBuf = ((bitBuf << 8) | input[pos++]) >>> 0;
      bitCnt += 8;
    }
    if (bitCnt < codeLen) return -1;
    const code = (bitBuf >>> (bitCnt - codeLen)) & ((1 << codeLen) - 1);
    bitCnt -= codeLen;
    return code;
  };

  for (;;) {
    const code = nextCode();
    if (code < 0) break;
    if (code === 256) {
      reset();
      codeLen = 9;
      prev = null;
      continue;
    }
    if (code === 257) break;
    let entry;
    if (code < dict.length && dict[code]) entry = dict[code];
    else if (prev) entry = prev.concat([prev[0]]);
    else break;

    chunks.push(Buffer.from(entry));
    if (prev) dict.push(prev.concat([entry[0]]));
    prev = entry;
    if (codeLen < 12 && dict.length >= (1 << codeLen) - earlyChange) codeLen++;
  }
  return Buffer.concat(chunks);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function tiffPredictor(data, colors, bpc, columns) {
  if (bpc !== 8) return data; // 仅实现最常见的 8 位
  const rowLen = colors * columns;
  if (rowLen <= 0) return data;
  const out = Buffer.from(data);
  const rows = Math.floor(out.length / rowLen);
  for (let r = 0; r < rows; r++) {
    const base = r * rowLen;
    for (let x = colors; x < rowLen; x++) {
      out[base + x] = (out[base + x] + out[base + x - colors]) & 0xff;
    }
  }
  return out;
}

function applyPredictor(data, parms) {
  if (!parms || typeof parms !== 'object') return data;
  const pred = Number(parms.Predictor) || 1;
  if (pred <= 1) return data;
  const colors = Math.max(1, Number(parms.Colors) || 1);
  const bpc = Math.max(1, Number(parms.BitsPerComponent) || 8);
  const columns = Math.max(1, Number(parms.Columns) || 1);
  if (pred === 2) return tiffPredictor(data, colors, bpc, columns);

  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (rowLen <= 0) return data;

  // 标准 PNG 预测器：每行开头 1 字节过滤器类型（0-4）。
  // 少数生成器（不合规）省略该字节，此时按 predictor-10 固定过滤器处理。
  // 注意：当数据长度同时能被 rowLen 与 rowLen+1 整除时不能只看整除性，
  // 必须校验每行首字节是否为合法过滤器类型（真实文件中很常见：Columns=5 且行数为 5 的倍数）。
  let withFilterByte = false;
  let rows = 0;
  if (rowLen > 0 && data.length % (rowLen + 1) === 0) {
    const candidates = data.length / (rowLen + 1);
    let ok = true;
    for (let r = 0; r < candidates; r++) {
      if (data[r * (rowLen + 1)] > 4) {
        ok = false;
        break;
      }
    }
    if (ok) {
      withFilterByte = true;
      rows = candidates;
    }
  }
  if (!withFilterByte) {
    if (data.length % rowLen !== 0) return data;
    rows = data.length / rowLen;
  }
  const stride = withFilterByte ? rowLen + 1 : rowLen;
  const fixed = pred === 15 ? 2 : pred - 10;
  if (rows <= 0) return data;

  const out = Buffer.alloc(rows * rowLen);
  let prev = Buffer.alloc(rowLen);
  for (let r = 0; r < rows; r++) {
    const off = r * stride;
    const ft = withFilterByte ? data[off] : fixed;
    const srcStart = withFilterByte ? off + 1 : off;
    const cur = Buffer.alloc(rowLen);
    for (let x = 0; x < rowLen; x++) {
      const raw = data[srcStart + x] || 0;
      const left = x >= bpp ? cur[x - bpp] : 0;
      const up = prev[x];
      const upLeft = x >= bpp ? prev[x - bpp] : 0;
      let v;
      switch (ft) {
        case 1: v = raw + left; break;
        case 2: v = raw + up; break;
        case 3: v = raw + ((left + up) >> 1); break;
        case 4: v = raw + paethPredictor(left, up, upLeft); break;
        default: v = raw; break;
      }
      cur[x] = v & 0xff;
    }
    cur.copy(out, r * rowLen);
    prev = cur;
  }
  return out;
}

function applyFilter(name, data, parms, doc) {
  switch (name) {
    case 'FlateDecode':
    case 'Fl': {
      const raw = inflateBytes(data);
      if (raw === null) {
        // 解压失败时返回空数据：宁可少一段文本，也不能把压缩后的二进制当作正文
        doc.warn('部分内容流 FlateDecode 解压失败，该段文本可能缺失');
        return Buffer.alloc(0);
      }
      return applyPredictor(raw, parms);
    }
    case 'LZWDecode':
    case 'LZW': {
      const early = parms && typeof parms === 'object' && parms.EarlyChange !== undefined ? Number(parms.EarlyChange) : 1;
      return applyPredictor(lzwDecode(data, Number.isFinite(early) ? early : 1), parms);
    }
    case 'ASCIIHexDecode':
    case 'AHx':
      return asciiHexDecode(data);
    case 'ASCII85Decode':
    case 'A85':
      return ascii85Decode(data);
    case 'RunLengthDecode':
    case 'RL':
      return runLengthDecode(data);
    case 'Crypt':
      return data;
    case 'DCTDecode':
    case 'DCT':
    case 'JPXDecode':
    case 'CCITTFaxDecode':
    case 'CCF':
    case 'JBIG2Decode':
      // 图像编码，不含文本层
      return data;
    default:
      doc.warn(`遇到不支持的流过滤器 ${name}，已按原始字节处理`);
      return data;
  }
}

function decodePdfStream(stream) {
  const doc = stream.doc;
  const dict = stream.dict || {};
  let data = stream.rawBytes;
  try {
    const fRaw = doc.resolve(dict.Filter);
    const pRaw = doc.resolve(dict.DecodeParms !== undefined ? dict.DecodeParms : dict.DP);
    const filters = fRaw == null ? [] : Array.isArray(fRaw) ? fRaw : [fRaw];
    const parmsArr = pRaw == null ? [] : Array.isArray(pRaw) ? pRaw : [pRaw];
    for (let i = 0; i < filters.length; i++) {
      const nm = nameOf(filters[i]) || String(filters[i]);
      const parms = doc.resolve(parmsArr[i]);
      data = applyFilter(nm, data, parms, doc);
    }
  } catch {
    doc.warn('内容流解码异常，该段文本可能缺失');
  }
  return data;
}

// ---------------------------------------------------------------------------
// 字符编码表
// ---------------------------------------------------------------------------

function makeLatin1Table() {
  const t = new Array(256);
  for (let i = 0; i < 256; i++) {
    if (i < 32 || (i >= 0x7f && i < 0xa0)) t[i] = null;
    else t[i] = String.fromCharCode(i);
  }
  return t;
}

const WIN_ANSI_OVERRIDES = {
  0x80: 0x20ac, 0x81: null, 0x82: 0x201a, 0x83: 0x192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x2c6, 0x89: 0x2030, 0x8a: 0x160, 0x8b: 0x2039,
  0x8c: 0x152, 0x8d: null, 0x8e: 0x17d, 0x8f: null, 0x90: null, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013,
  0x97: 0x2014, 0x98: 0x2dc, 0x99: 0x2122, 0x9a: 0x161, 0x9b: 0x203a,
  0x9c: 0x153, 0x9d: null, 0x9e: 0x17e, 0x9f: 0x178,
};

const MAC_ROMAN_HIGH = [
  0xc4, 0xc5, 0xc7, 0xc9, 0xd1, 0xd6, 0xdc, 0xe1, 0xe0, 0xe2, 0xe4, 0xe3, 0xe5, 0xe7, 0xe9, 0xe8,
  0xea, 0xeb, 0xed, 0xec, 0xee, 0xef, 0xf1, 0xf3, 0xf2, 0xf4, 0xf6, 0xf5, 0xfa, 0xf9, 0xfb, 0xfc,
  0x2020, 0xb0, 0xa2, 0xa3, 0xa7, 0x2022, 0xb6, 0xdf, 0xae, 0xa9, 0x2122, 0xb4, 0xa8, 0x2260, 0xc6, 0xd8,
  0x221e, 0xb1, 0x2264, 0x2265, 0xa5, 0xb5, 0x2202, 0x2211, 0x220f, 0x3c0, 0x222b, 0xaa, 0xba, 0x3a9, 0xe6, 0xf8,
  0xbf, 0xa1, 0xac, 0x221a, 0x192, 0x2248, 0x2206, 0xab, 0xbb, 0x2026, 0xa0, 0xc0, 0xc3, 0xd5, 0x152, 0x153,
  0x2013, 0x2014, 0x201c, 0x201d, 0x2018, 0x2019, 0xf7, 0x25ca, 0xff, 0x178, 0x2044, 0x20ac, 0x2039, 0x203a, 0xfb01, 0xfb02,
  0x2021, 0xb7, 0x201a, 0x201e, 0x2030, 0xc2, 0xca, 0xc1, 0xcb, 0xc8, 0xcd, 0xce, 0xcf, 0xcc, 0xd3, 0xd4,
  0xf8ff, 0xd2, 0xda, 0xdb, 0xd9, 0x131, 0x2c6, 0x2dc, 0xaf, 0x2d8, 0x2d9, 0x2da, 0xb8, 0x2dd, 0x2db, 0x2c7,
];

const STANDARD_OVERRIDES = {
  0x27: 0x2019, 0x60: 0x2018, 0xa0: null, 0xa1: 0xa1, 0xa2: 0xa2, 0xa3: 0xa3,
  0xa4: 0x2044, 0xa5: 0xa5, 0xa6: 0x192, 0xa7: 0xa7, 0xa8: 0xa4, 0xa9: 0x27,
  0xaa: 0x201c, 0xab: 0xab, 0xac: 0x2039, 0xad: 0x203a, 0xae: 0xfb01, 0xaf: 0xfb02,
  0xb0: null, 0xb1: 0x2013, 0xb2: 0x2020, 0xb3: 0x2021, 0xb4: 0xb7, 0xb5: null,
  0xb6: 0xb6, 0xb7: 0x2022, 0xb8: 0x201a, 0xb9: 0x201e, 0xba: 0x201d, 0xbb: 0xbb,
  0xbc: 0x2026, 0xbd: 0x2030, 0xbe: null, 0xbf: 0xbf, 0xc0: null, 0xc1: 0x60,
  0xc2: 0xb4, 0xc3: 0x2c6, 0xc4: 0x2dc, 0xc5: 0xaf, 0xc6: 0x2d8, 0xc7: 0x2d9,
  0xc8: 0xa8, 0xc9: null, 0xca: 0x2da, 0xcb: 0xb8, 0xcc: null, 0xcd: 0x2dd,
  0xce: 0x2db, 0xcf: 0x2c7, 0xd0: 0x2014, 0xe1: 0xc6, 0xe3: 0xaa, 0xf1: 0x141,
  0xf2: 0xd8, 0xf3: 0x152, 0xf4: 0xba,
};

function buildEncodingTable(overrides, undefinedCodes, highTable) {
  const t = makeLatin1Table();
  if (highTable) {
    for (let i = 0; i < 128; i++) {
      const cp = highTable[i];
      t[0x80 + i] = cp ? String.fromCharCode(cp) : null;
    }
  }
  if (undefinedCodes) for (const c of undefinedCodes) t[c] = null;
  if (overrides) {
    for (const k of Object.keys(overrides)) {
      const cp = overrides[k];
      t[Number(k)] = cp ? String.fromCharCode(cp) : null;
    }
  }
  return t;
}

const ENCODING_TABLES = {
  WinAnsiEncoding: buildEncodingTable(WIN_ANSI_OVERRIDES, [0x7f, 0xa0, 0xad]),
  MacRomanEncoding: buildEncodingTable(null, [0x7f], MAC_ROMAN_HIGH),
  StandardEncoding: buildEncodingTable(
    STANDARD_OVERRIDES,
    [0xb0, 0xb5, 0xbe, 0xc0, 0xc9, 0xcc, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9,
      0xda, 0xdb, 0xdc, 0xdd, 0xde, 0xdf, 0xe0, 0xe2, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
      0xeb, 0xec, 0xed, 0xee, 0xef, 0xf0, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff]
  ),
  // PDFDocEncoding 在高位与 WinAnsi 不同，但对文本抽取影响有限，这里退化为 Latin-1
  PDFDocEncoding: buildEncodingTable(null, [0x7f, 0xad]),
  MacExpertEncoding: buildEncodingTable(null, [0x7f]),
  SymbolEncoding: null,
  ZapfDingbatsEncoding: null,
};

const GLYPH_NAMES = {
  space: 0x20, exclam: 0x21, quotedbl: 0x22, numbersign: 0x23, dollar: 0x24,
  percent: 0x25, ampersand: 0x26, quotesingle: 0x27, quoteright: 0x2019,
  quoteleft: 0x2018, quotedblleft: 0x201c, quotedblright: 0x201d,
  quotesinglbase: 0x201a, quotedblbase: 0x201e, parenleft: 0x28, parenright: 0x29,
  asterisk: 0x2a, plus: 0x2b, comma: 0x2c, hyphen: 0x2d, minus: 0x2212,
  period: 0x2e, slash: 0x2f, colon: 0x3a, semicolon: 0x3b, less: 0x3c,
  equal: 0x3d, greater: 0x3e, question: 0x3f, at: 0x40, bracketleft: 0x5b,
  backslash: 0x5c, bracketright: 0x5d, asciicircum: 0x5e, underscore: 0x5f,
  grave: 0x60, braceleft: 0x7b, bar: 0x7c, braceright: 0x7d, asciitilde: 0x7e,
  exclamdown: 0xa1, cent: 0xa2, sterling: 0xa3, currency: 0xa4, yen: 0xa5,
  brokenbar: 0xa6, section: 0xa7, dieresis: 0xa8, copyright: 0xa9,
  ordfeminine: 0xaa, guillemotleft: 0xab, logicalnot: 0xac, registered: 0xae,
  macron: 0xaf, degree: 0xb0, plusminus: 0xb1, twosuperior: 0xb2,
  threesuperior: 0xb3, acute: 0xb4, mu: 0xb5, paragraph: 0xb6,
  periodcentered: 0xb7, cedilla: 0xb8, onesuperior: 0xb9, ordmasculine: 0xba,
  guillemotright: 0xbb, onequarter: 0xbc, onehalf: 0xbd, threequarters: 0xbe,
  questiondown: 0xbf, multiply: 0xd7, divide: 0xf7,
  endash: 0x2013, emdash: 0x2014, bullet: 0x2022, dagger: 0x2020,
  daggerdbl: 0x2021, ellipsis: 0x2026, perthousand: 0x2030,
  guilsinglleft: 0x2039, guilsinglright: 0x203a, fraction: 0x2044,
  florin: 0x192, fi: 0xfb01, fl: 0xfb02, Euro: 0x20ac, trademark: 0x2122,
  dotlessi: 0x131, circumflex: 0x2c6, tilde: 0x2dc, caron: 0x2c7,
  breve: 0x2d8, dotaccent: 0x2d9, ring: 0x2da, ogonek: 0x2db,
  hungarumlaut: 0x2dd, nbspace: 0x20, nonbreakingspace: 0x20,
  apple: 0xf8ff, Omega: 0x3a9, omega: 0x3c9, pi: 0x3c0, infinity: 0x221e,
  lessequal: 0x2264, greaterequal: 0x2265, notequal: 0x2260,
  radical: 0x221a, summation: 0x2211, product: 0x220f, integral: 0x222b,
  partialdiff: 0x2202, Delta: 0x2206, lozenge: 0x25ca, arrowright: 0x2192,
  arrowleft: 0x2190, arrowup: 0x2191, arrowdown: 0x2193,
};

const LATIN1_NAMES = {
  Agrave: 0xc0, Aacute: 0xc1, Acircumflex: 0xc2, Atilde: 0xc3, Adieresis: 0xc4,
  Aring: 0xc5, AE: 0xc6, Ccedilla: 0xc7, Egrave: 0xc8, Eacute: 0xc9,
  Ecircumflex: 0xca, Edieresis: 0xcb, Igrave: 0xcc, Iacute: 0xcd,
  Icircumflex: 0xce, Idieresis: 0xcf, Eth: 0xd0, Ntilde: 0xd1, Ograve: 0xd2,
  Oacute: 0xd3, Ocircumflex: 0xd4, Otilde: 0xd5, Odieresis: 0xd6,
  Oslash: 0xd8, Ugrave: 0xd9, Uacute: 0xda, Ucircumflex: 0xdb,
  Udieresis: 0xdc, Yacute: 0xdd, Thorn: 0xde, germandbls: 0xdf,
  agrave: 0xe0, aacute: 0xe1, acircumflex: 0xe2, atilde: 0xe3,
  adieresis: 0xe4, aring: 0xe5, ae: 0xe6, ccedilla: 0xe7, egrave: 0xe8,
  eacute: 0xe9, ecircumflex: 0xea, edieresis: 0xeb, igrave: 0xec,
  iacute: 0xed, icircumflex: 0xee, idieresis: 0xef, eth: 0xf0, ntilde: 0xf1,
  ograve: 0xf2, oacute: 0xf3, ocircumflex: 0xf4, otilde: 0xf5,
  odieresis: 0xf6, oslash: 0xf8, ugrave: 0xf9, uacute: 0xfa,
  ucircumflex: 0xfb, udieresis: 0xfc, yacute: 0xfd, thorn: 0xfe,
  ydieresis: 0xff, Lslash: 0x141, lslash: 0x142, OE: 0x152, oe: 0x153,
  Scaron: 0x160, scaron: 0x161, Zcaron: 0x17d, zcaron: 0x17e,
  Ydieresis: 0x178,
};

function glyphToUnicode(name) {
  if (!name) return null;
  if (GLYPH_NAMES[name] !== undefined) return String.fromCharCode(GLYPH_NAMES[name]);
  if (LATIN1_NAMES[name] !== undefined) return String.fromCharCode(LATIN1_NAMES[name]);
  if (name.length === 1) return name;
  let m = /^uni((?:[0-9A-Fa-f]{4})+)$/.exec(name);
  if (m) {
    const hex = m[1];
    let out = '';
    for (let i = 0; i + 3 < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
    return out;
  }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) {
    const cp = parseInt(m[1], 16);
    if (cp >= 0 && cp <= 0x10ffff) return String.fromCodePoint(cp);
  }
  m = /^(?:g|cid|glyph|index)(\d+)$/i.exec(name);
  if (m) return null; // 纯字形编号无法映射
  return null;
}

// ---------------------------------------------------------------------------
// ToUnicode CMap
// ---------------------------------------------------------------------------

function bytesToInt(buf) {
  let v = 0;
  for (let i = 0; i < buf.length && i < 4; i++) v = (v << 8) | buf[i];
  return v >>> 0;
}

function utf16beToString(buf) {
  if (!buf || buf.length === 0) return '';
  if (buf.length % 2 !== 0) {
    // 奇数长度：按 Latin-1 兜底
    let out = '';
    for (const b of buf) out += String.fromCharCode(b);
    return out;
  }
  let start = 0;
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) start = 2;
  let out = '';
  for (let i = start; i + 1 < buf.length; i += 2) {
    out += String.fromCharCode((buf[i] << 8) | buf[i + 1]);
  }
  return out;
}

function incrementBytes(buf, delta) {
  const out = Buffer.from(buf);
  if (out.length === 0 || delta === 0) return out;
  if (out.length >= 4) {
    const hi = (out[0] << 8) | out[1];
    if (hi >= 0xd800 && hi <= 0xdbff) {
      // 代理对：只自增低 16 位，避免破坏高位
      const low = (((out[2] << 8) | out[3]) + delta) & 0xffff;
      out[2] = (low >> 8) & 0xff;
      out[3] = low & 0xff;
      return out;
    }
  }
  let v = 0n;
  for (const b of out) v = (v << 8n) | BigInt(b);
  v += BigInt(delta);
  const mask = (1n << BigInt(out.length * 8)) - 1n;
  v &= mask;
  for (let i = out.length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** 将 CMap 文本切成记号：hex / name / num / kw / arr */
function tokenizeCMap(str) {
  const out = [];
  const stack = [{ items: out }];
  const cur = () => stack[stack.length - 1].items;
  let i = 0;
  while (i < str.length) {
    const c = str[i];
    if (isWhiteCode(str.charCodeAt(i))) {
      i++;
      continue;
    }
    if (c === '%') {
      while (i < str.length && str[i] !== '\n' && str[i] !== '\r') i++;
      continue;
    }
    if (c === '<') {
      if (str[i + 1] === '<') {
        cur().push({ type: 'kw', value: '<<' });
        i += 2;
        continue;
      }
      let j = str.indexOf('>', i + 1);
      if (j < 0) j = str.length;
      const hex = str.slice(i + 1, j).replace(/[^0-9A-Fa-f]/g, '');
      cur().push({ type: 'hex', value: Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex') });
      i = j + 1;
      continue;
    }
    if (c === '>') {
      if (str[i + 1] === '>') cur().push({ type: 'kw', value: '>>' });
      i += str[i + 1] === '>' ? 2 : 1;
      continue;
    }
    if (c === '[') {
      const arr = { type: 'arr', items: [] };
      cur().push(arr);
      stack.push(arr);
      i++;
      continue;
    }
    if (c === ']') {
      if (stack.length > 1) stack.pop();
      i++;
      continue;
    }
    if (c === '{' || c === '}') {
      i++;
      continue;
    }
    if (c === '/') {
      let j = i + 1;
      let name = '';
      while (j < str.length && !isWhiteCode(str.charCodeAt(j)) && !isDelimCode(str.charCodeAt(j))) {
        name += str[j];
        j++;
      }
      cur().push({ type: 'name', value: name });
      i = j;
      continue;
    }
    // 普通记号
    let j = i;
    while (j < str.length && !isWhiteCode(str.charCodeAt(j)) && !isDelimCode(str.charCodeAt(j))) j++;
    const tok = str.slice(i, j);
    if (tok.length === 0) {
      i++;
      continue;
    }
    const n = Number(tok);
    if (Number.isFinite(n) && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) cur().push({ type: 'num', value: n });
    else cur().push({ type: 'kw', value: tok });
    i = j;
  }
  return out;
}

/**
 * 解析 ToUnicode CMap。
 * @returns {{map: Map<number,string>, codespaces: Array<[number,number,number]>}}
 */
function parseCMap(str) {
  const map = new Map();
  const codespaces = [];
  if (!str || typeof str !== 'string') return { map, codespaces };
  let toks;
  try {
    toks = tokenizeCMap(str);
  } catch {
    return { map, codespaces };
  }
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t.type === 'kw' && t.value === 'begincodespacerange') {
      i++;
      while (i < toks.length && !(toks[i].type === 'kw' && toks[i].value === 'endcodespacerange')) {
        const lo = toks[i];
        const hi = toks[i + 1];
        if (lo && lo.type === 'hex') {
          const len = Math.max(1, lo.value.length);
          const loV = bytesToInt(lo.value);
          const hiV = hi && hi.type === 'hex' ? bytesToInt(hi.value) : loV;
          codespaces.push([len, loV, hiV]);
          i += hi && hi.type === 'hex' ? 2 : 1;
        } else i++;
      }
      i++;
      continue;
    }
    if (t.type === 'kw' && t.value === 'beginbfchar') {
      i++;
      while (i < toks.length && !(toks[i].type === 'kw' && toks[i].value === 'endbfchar')) {
        const src = toks[i];
        const dst = toks[i + 1];
        if (src && src.type === 'hex' && dst && dst.type === 'hex') {
          map.set(bytesToInt(src.value), utf16beToString(dst.value));
          i += 2;
        } else i++;
      }
      i++;
      continue;
    }
    if (t.type === 'kw' && t.value === 'beginbfrange') {
      i++;
      while (i < toks.length && !(toks[i].type === 'kw' && toks[i].value === 'endbfrange')) {
        const lo = toks[i];
        const hi = toks[i + 1];
        const dst = toks[i + 2];
        if (lo && lo.type === 'hex' && hi && hi.type === 'hex' && dst) {
          const l = bytesToInt(lo.value);
          const h = bytesToInt(hi.value);
          if (dst.type === 'hex') {
            for (let c = l; c <= h && c - l < 100000; c++) {
              map.set(c, utf16beToString(incrementBytes(dst.value, c - l)));
            }
            i += 3;
          } else if (dst.type === 'arr') {
            for (let k = 0; k < dst.items.length && l + k <= h; k++) {
              const it = dst.items[k];
              if (it && it.type === 'hex') map.set(l + k, utf16beToString(it.value));
            }
            i += 3;
          } else i++;
        } else i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return { map, codespaces };
}

// ---------------------------------------------------------------------------
// 字体
// ---------------------------------------------------------------------------

function buildFont(doc, fd) {
  const subtype = nameOf(doc.resolve(fd.Subtype)) || '';
  const isType0 = subtype === 'Type0';
  let codespaces = null;
  let toUnicode = null;

  const candidates = [fd];
  if (isType0) {
    const desc = doc.resolve(fd.DescendantFonts);
    if (Array.isArray(desc) && desc.length) {
      const d0 = doc.resolve(desc[0]);
      if (isDict(d0)) candidates.push(d0);
    }
  }
  for (const c of candidates) {
    const tuRef = doc.resolve(c.ToUnicode);
    if (tuRef instanceof PdfStream) {
      const cmapStr = decodePdfStream(tuRef).toString('latin1');
      const parsed = parseCMap(cmapStr);
      if (parsed.map.size) toUnicode = parsed.map;
      if (parsed.codespaces.length && !codespaces) codespaces = parsed.codespaces;
      break;
    }
  }

  let encodingMap = null;
  let hasExplicitEncoding = false;

  if (isType0) {
    const enc = doc.resolve(fd.Encoding);
    if (enc instanceof PdfStream) {
      // 内嵌 CMap：用其 codespacerange 决定字节宽度
      try {
        const parsed = parseCMap(decodePdfStream(enc).toString('latin1'));
        if (parsed.codespaces.length) codespaces = parsed.codespaces;
      } catch {
        /* 忽略 */
      }
      hasExplicitEncoding = true;
    } else if (enc instanceof PdfName) {
      hasExplicitEncoding = true;
    }
    if (!codespaces) codespaces = [[2, 0, 0xffff]];
  } else {
    const enc = doc.resolve(fd.Encoding);
    let baseName = null;
    let differences = null;
    if (enc instanceof PdfName) {
      baseName = enc.name;
      hasExplicitEncoding = true;
    } else if (isDict(enc)) {
      baseName = nameOf(doc.resolve(enc.BaseEncoding));
      differences = doc.resolve(enc.Differences);
      hasExplicitEncoding = true;
    }
    const table = baseName ? ENCODING_TABLES[baseName] : null;
    if (table) encodingMap = table.slice();
    if (Array.isArray(differences)) {
      if (!encodingMap) encodingMap = new Array(256).fill(null);
      let code = 0;
      for (const item of differences) {
        const v = doc.resolve(item);
        if (typeof v === 'number') {
          code = v;
        } else if (v instanceof PdfName) {
          const u = glyphToUnicode(v.name);
          if (u !== null && code >= 0 && code < 256) encodingMap[code] = u;
          code++;
        }
      }
    }
    codespaces = [[1, 0, 255]];
  }

  // 无法可靠映射的标记：真正的告警在解码到可疑字符时才发出，
  // 避免纯 ASCII 文档被无意义地告警。
  const needsWarn = !toUnicode && (!hasExplicitEncoding || isType0);

  return {
    subtype,
    isType0,
    toUnicode,
    encodingMap,
    codespaces,
    needsWarn,
  };
}

function decodeFontString(bytes, fi, doc) {
  if (!fi) {
    // 没有字体信息：按 Latin-1 兜底
    let out = '';
    for (const b of bytes) out += b >= 32 ? String.fromCharCode(b) : '';
    return out;
  }
  const spaces = fi.codespaces && fi.codespaces.length ? fi.codespaces : fi.isType0 ? [[2, 0, 0xffff]] : [[1, 0, 255]];
  let warned = false;
  const noteUncertain = (code) => {
    if (!fi.needsWarn || warned) return;
    // 单字节字体只在遇到非 ASCII 码位时才真正存在风险
    if (!fi.isType0 && code < 0x80) return;
    warned = true;
    doc.warn(WARN_NO_Tounicode);
  };
  const lookup = (code) => {
    if (fi.toUnicode) {
      const v = fi.toUnicode.get(code);
      if (v !== undefined) return v;
    }
    if (fi.encodingMap && code < 256) {
      const v = fi.encodingMap[code];
      if (v !== undefined && v !== null) return v;
    }
    noteUncertain(code);
    if (fi.isType0 || code > 255) {
      if (code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return '';
        }
      }
      return '';
    }
    return code >= 32 ? String.fromCharCode(code) : '';
  };

  let out = '';
  let i = 0;
  let guard = 0;
  while (i < bytes.length && guard++ < 1000000) {
    let matched = false;
    for (const sp of spaces) {
      const len = sp[0];
      if (len < 1 || len > 4 || i + len > bytes.length) continue;
      let v = 0;
      for (let k = 0; k < len; k++) v = (v << 8) | bytes[i + k];
      if (v >= sp[1] && v <= sp[2]) {
        out += lookup(v);
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += lookup(bytes[i]);
      i++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 内容流文本抽取
// ---------------------------------------------------------------------------

function mulMatrix(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

function createTextState(doc) {
  return {
    doc,
    chunks: [],
    total: 0,
    fonts: new Map(),
    tm: [1, 0, 0, 1, 0, 0],
    tlm: [1, 0, 0, 1, 0, 0],
    leading: 0,
    fontSize: 0,
    font: null,
    charSpacing: 0,
    wordSpacing: 0,
    hScale: 100,
    lineY: null,
    penX: 0,
    pendingNL: false,
    pendingSpace: false,
    gstack: [],
  };
}

function isWideCodePoint(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function estimateWidth(state, text) {
  let units = 0;
  let spaces = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 32) spaces++;
    units += isWideCodePoint(cp) ? 1 : 0.5;
  }
  const fs = state.fontSize || 0;
  return units * fs * (state.hScale / 100) + text.length * state.charSpacing + spaces * state.wordSpacing;
}

function onTextPosition(state) {
  const x = state.tm[4];
  const y = state.tm[5];
  const fs = Math.max(state.fontSize || 12, 1);
  const dy = Math.max(0.8, fs * 0.3);
  if (state.lineY === null) {
    state.lineY = y;
    state.penX = x;
    return;
  }
  if (Math.abs(y - state.lineY) > dy) {
    if (state.chunks.length) state.pendingNL = true;
    state.pendingSpace = false;
    state.lineY = y;
    state.penX = x;
    return;
  }
  if (x > state.penX + dy) state.pendingSpace = true;
  if (x > state.penX) state.penX = x;
}

function flushPending(state) {
  if (state.pendingNL) {
    const last = state.chunks.length ? state.chunks[state.chunks.length - 1] : '';
    if (last && !last.endsWith('\n')) state.chunks.push('\n');
    state.pendingNL = false;
    state.pendingSpace = false;
    return;
  }
  if (state.pendingSpace) {
    const last = state.chunks.length ? state.chunks[state.chunks.length - 1] : '';
    if (last && !/\s$/.test(last)) state.chunks.push(' ');
    state.pendingSpace = false;
  }
}

function pushChunk(state, text) {
  if (!text) return;
  if (state.total + text.length > MAX_TEXT_LENGTH) return;
  if (state.chunks.length >= MAX_CHUNKS) {
    // 合并已有分片，避免分片数组无限增长
    state.chunks = [state.chunks.join('')];
  }
  state.chunks.push(text);
  state.total += text.length;
}

function showText(state, value) {
  if (!(value instanceof PdfString)) return;
  if (state.total > MAX_TEXT_LENGTH) return;
  const text = decodeFontString(value.bytes, state.font, state.doc);
  if (!text) return;
  flushPending(state);
  pushChunk(state, text);
  state.penX += estimateWidth(state, text);
}

function showArray(state, arr) {
  if (!Array.isArray(arr)) return;
  for (const item of arr) {
    if (item instanceof PdfString) {
      showText(state, item);
    } else if (typeof item === 'number' && Number.isFinite(item)) {
      // TJ 中的数值以千分之一文本空间为单位，负值表示向右移动（词间距）
      if (item < -100) state.pendingSpace = true;
      state.penX += (-item / 1000) * (state.fontSize || 0) * (state.hScale / 100);
    }
  }
}

function translateLine(state, tx, ty) {
  state.tlm = mulMatrix([1, 0, 0, 1, tx, ty], state.tlm);
  state.tm = state.tlm.slice();
  onTextPosition(state);
}

/** 跳过内联图像 BI ... ID <二进制> EI */
function skipInlineImage(content, from) {
  const window = content.slice(from, from + 8192);
  const m = /\bID[\x00\t\n\f\r ]/.exec(window);
  if (!m) return Math.min(content.length, from + 2);
  let q = from + m.index + m[0].length;
  for (let guard = 0; guard < 100000; guard++) {
    const e = content.indexOf('EI', q);
    if (e < 0) return content.length;
    const before = e > 0 ? content.charCodeAt(e - 1) : 32;
    const after = e + 2 < content.length ? content.charCodeAt(e + 2) : 32;
    if (isWhiteCode(before) && isWhiteCode(after)) return e + 2;
    q = e + 2;
  }
  return content.length;
}

function getFont(doc, resources, name, state) {
  if (state.fonts.has(name)) return state.fonts.get(name);
  let fi = null;
  try {
    const fonts = doc.resolve(resources ? resources.Font : null);
    const fd = isDict(fonts) ? doc.resolve(fonts[name]) : null;
    if (isDict(fd)) fi = buildFont(doc, fd);
  } catch {
    fi = null;
  }
  state.fonts.set(name, fi);
  return fi;
}

function runContent(doc, content, resources, state, depth) {
  if (depth > MAX_FORM_DEPTH || !content) return;
  const lex = new Lexer({ str: content }, 0);
  const stack = [];
  let guard = 0;
  while (guard++ < 5000000) {
    lex.skipWs();
    if (lex.pos >= content.length) break;
    const before = lex.pos;
    const tok = lex.parseValue(false);
    if (lex.pos === before) lex.pos++;

    if (!tok || typeof tok !== 'object' || tok instanceof PdfString || tok instanceof PdfName || Array.isArray(tok)) {
      if (tok !== undefined && tok !== null) stack.push(tok);
      if (stack.length > 256) stack.splice(0, stack.length - 64);
      continue;
    }
    const op = tok.keyword;
    if (op === undefined) {
      stack.push(tok);
      continue;
    }

    try {
      switch (op) {
        case 'BT':
          state.tm = [1, 0, 0, 1, 0, 0];
          state.tlm = [1, 0, 0, 1, 0, 0];
          break;
        case 'ET':
          break;
        case 'q':
          state.gstack.push({
            font: state.font,
            fontSize: state.fontSize,
            charSpacing: state.charSpacing,
            wordSpacing: state.wordSpacing,
            hScale: state.hScale,
            leading: state.leading,
          });
          if (state.gstack.length > 64) state.gstack.shift();
          break;
        case 'Q': {
          const saved = state.gstack.pop();
          if (saved) Object.assign(state, saved);
          break;
        }
        case 'Tf': {
          const size = typeof stack[stack.length - 1] === 'number' ? stack[stack.length - 1] : 0;
          const nm = stack[stack.length - 2];
          state.fontSize = size;
          if (nm instanceof PdfName) state.font = getFont(doc, resources, nm.name, state);
          break;
        }
        case 'Td': {
          const ty = typeof stack[stack.length - 1] === 'number' ? stack[stack.length - 1] : 0;
          const tx = typeof stack[stack.length - 2] === 'number' ? stack[stack.length - 2] : 0;
          translateLine(state, tx, ty);
          break;
        }
        case 'TD': {
          const ty = typeof stack[stack.length - 1] === 'number' ? stack[stack.length - 1] : 0;
          const tx = typeof stack[stack.length - 2] === 'number' ? stack[stack.length - 2] : 0;
          state.leading = -ty;
          translateLine(state, tx, ty);
          break;
        }
        case 'Tm': {
          const v = stack.slice(-6);
          if (v.length === 6 && v.every((x) => typeof x === 'number')) {
            state.tm = v.slice();
            state.tlm = v.slice();
            onTextPosition(state);
          }
          break;
        }
        case 'T*':
          translateLine(state, 0, -state.leading);
          break;
        case 'TL':
          if (typeof stack[stack.length - 1] === 'number') state.leading = stack[stack.length - 1];
          break;
        case 'Tc':
          if (typeof stack[stack.length - 1] === 'number') state.charSpacing = stack[stack.length - 1];
          break;
        case 'Tw':
          if (typeof stack[stack.length - 1] === 'number') state.wordSpacing = stack[stack.length - 1];
          break;
        case 'Tz':
          if (typeof stack[stack.length - 1] === 'number') state.hScale = stack[stack.length - 1];
          break;
        case 'Ts':
        case 'Tr':
          break;
        case 'Tj':
          showText(state, stack[stack.length - 1]);
          break;
        case 'TJ':
          showArray(state, stack[stack.length - 1]);
          break;
        case "'":
          translateLine(state, 0, -state.leading);
          showText(state, stack[stack.length - 1]);
          break;
        case '"': {
          const str = stack[stack.length - 1];
          const ac = stack[stack.length - 2];
          const aw = stack[stack.length - 3];
          if (typeof aw === 'number') state.wordSpacing = aw;
          if (typeof ac === 'number') state.charSpacing = ac;
          translateLine(state, 0, -state.leading);
          showText(state, str);
          break;
        }
        case 'Do': {
          const nm = stack[stack.length - 1];
          if (nm instanceof PdfName && resources) {
            const xobjects = doc.resolve(resources.XObject);
            const ref = isDict(xobjects) ? xobjects[nm.name] : null;
            const form = doc.resolve(ref);
            if (form instanceof PdfStream && nameOf(doc.resolve(form.dict.Subtype)) === 'Form') {
              const subRes = doc.resolve(form.dict.Resources) || resources;
              const data = decodePdfStream(form);
              runContent(doc, data.toString('latin1'), subRes, state, depth + 1);
            }
          }
          break;
        }
        case 'BI':
          lex.pos = skipInlineImage(content, lex.pos);
          break;
        default:
          break;
      }
    } catch {
      // 单个算子出错不应影响整体
    }
    stack.length = 0;
  }
}

// ---------------------------------------------------------------------------
// 文本后处理
// ---------------------------------------------------------------------------

function normalizeCharacters(s) {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === 0x0a) {
      out += '\n';
      continue;
    }
    if (cp === 0x0d) continue;
    if (cp === 0x09) {
      out += ' ';
      continue;
    }
    if (cp < 0x20) continue;
    if (cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) continue;
    if (cp === 0xad || cp === 0xfeff || cp === 0x200b || cp === 0x200c || cp === 0x200d) continue;
    if (cp === 0xfffd) continue;
    if (cp === 0x00a0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x202f || cp === 0x205f || cp === 0x3000) {
      out += ' ';
      continue;
    }
    if (cp >= 0xff01 && cp <= 0xff5e) {
      // 全角 ASCII 归一化为半角（安全：不涉及中文标点区 U+3000-U+303F）
      out += String.fromCharCode(cp - 0xfee0);
      continue;
    }
    out += ch;
  }
  return out;
}

const MARKER_RE = /^([\u2022\u2023\u25cf\u25cb\u25a0\u25a1\u25aa\u25ab\u00b7\u2027\u2043\u25e6\u27a4\u2794\u00bb\u2013\u2014]|[-*+]\s|\(\w{1,4}\)|（\w{1,4}）|\d{1,3}[.)、]|第[一二三四五六七八九十百千零〇\d]+[条章节款项部分]|[一二三四五六七八九十]+[、.．)]|[A-Za-z][.)]\s)/;

function isMarkerLine(line) {
  return MARKER_RE.test(line);
}

function isCJKChar(ch) {
  if (!ch) return false;
  const cp = ch.codePointAt(0);
  return (
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

const TERMINAL_RE = /[.!?。！？；;:："'”’」』】）)】]$/;

function joinSeparator(prev, cur) {
  const a = prev[prev.length - 1];
  const b = cur[0];
  if (isCJKChar(a) && isCJKChar(b)) return '';
  return ' ';
}

function shouldJoinLines(prev, cur, maxLen) {
  if (!prev || !cur) return false;
  if (TERMINAL_RE.test(prev)) return false;
  if (isMarkerLine(cur)) return false;
  // 英文小写开头：几乎一定是换行续写
  if (/^[a-z]/.test(cur)) return true;
  // 中文：上一行足够长且不以句末标点结尾
  if (isCJKChar(prev[prev.length - 1]) && isCJKChar(cur[0])) {
    if (prev.length >= 12 && prev.length >= Math.min(40, maxLen * 0.5)) return true;
  }
  // 上一行接近版心宽度（已满行）且当前行不是短标题
  if (maxLen >= 30 && prev.length >= maxLen - 1 && cur.length >= Math.max(12, maxLen * 0.6)) return true;
  return false;
}

function cleanupText(raw) {
  if (!raw) return '';
  let s = normalizeCharacters(raw);
  s = s.replace(/[ \t]+$/gm, '');
  s = s.replace(/^[ \t]+/gm, '');
  // 连字符断行合并：仅当连字符位于行尾且后接小写字母
  s = s.replace(/[-\u2010\u00ad]\n[ \t]*(?=[a-z])/g, '');
  s = s.replace(/\u00ad/g, '');

  const lines = s.split('\n');
  let maxLen = 0;
  for (const l of lines) if (l.length > maxLen) maxLen = l.length;

  const out = [];
  for (const line of lines) {
    if (line === '') {
      out.push('');
      continue;
    }
    const prev = out.length ? out[out.length - 1] : '';
    if (prev && prev !== '' && shouldJoinLines(prev, line, maxLen)) {
      out[out.length - 1] = prev + joinSeparator(prev, line) + line;
    } else {
      out.push(line);
    }
  }
  s = out.join('\n');
  s = s.replace(/[ \t]{2,}/g, ' ');
  s = s.replace(/[ \t]*\n[ \t]*/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// ---------------------------------------------------------------------------
// PDF 文档
// ---------------------------------------------------------------------------

class PDFDocument {
  constructor(input) {
    if (Buffer.isBuffer(input)) this.buf = input;
    else if (input instanceof Uint8Array) this.buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    else if (typeof input === 'string') this.buf = Buffer.from(input, 'latin1');
    else throw new Error('unsupported input type');
    this.str = this.buf.toString('latin1');
    this.xref = new Map();
    this.cache = new Map();
    this.objStmCache = new Map();
    this.resolving = new Set();
    this.warnings = [];
    this.trailer = null;
    this.encrypted = false;
    this._scanMap = null;
    this._loaded = false;
  }

  warn(msg) {
    if (!msg) return;
    if (this.warnings.length > 60) return;
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }

  // --- 间接对象解析 -------------------------------------------------------

  parseIndirectAt(offset) {
    try {
      if (!Number.isFinite(offset) || offset < 0 || offset >= this.str.length) return null;
      const lex = new Lexer(this, offset);
      const n = lex.parseValue(false);
      const g = lex.parseValue(false);
      const kw = lex.parseValue(false);
      if (typeof n !== 'number' || typeof g !== 'number') return null;
      if (!kw || kw.keyword !== 'obj') return null;
      const val = lex.parseValue(false);

      lex.skipWs();
      if (lex.matchKeyword('stream')) {
        lex.pos += 6;
        let ds = lex.pos;
        const c1 = this.str.charCodeAt(ds);
        if (c1 === 13) ds++;
        if (this.str.charCodeAt(ds) === 10) ds++;
        let len = -1;
        const dict = isDict(val) ? val : {};
        const L = this.resolve(dict.Length);
        if (typeof L === 'number' && L >= 0 && ds + L <= this.buf.length) {
          const after = this.str.substr(ds + L, 24);
          if (/^[\x00\t\n\f\r ]*endstream/.test(after)) len = L;
        }
        if (len < 0) {
          let end = this.str.indexOf('endstream', ds);
          if (end < 0) end = this.buf.length;
          len = end - ds;
          if (len > 0 && this.str.charCodeAt(ds + len - 1) === 10) len--;
          if (len > 0 && this.str.charCodeAt(ds + len - 1) === 13) len--;
          if (typeof L === 'number' && L >= 0 && L !== len) {
            this.warn('部分内容流长度信息不正确，已按实际字节恢复');
          }
        }
        const raw = this.buf.subarray(ds, ds + Math.max(0, len));
        return new PdfStream(dict, raw, this);
      }
      return val === undefined ? null : val;
    } catch {
      return null;
    }
  }

  getScanMap() {
    if (this._scanMap) return this._scanMap;
    const map = new Map();
    const re = /(?:^|[^0-9])(\d{1,10})[\x00\t\n\f\r ]+(\d{1,5})[\x00\t\n\f\r ]+obj\b/g;
    let m;
    let count = 0;
    while ((m = re.exec(this.str)) !== null && count < MAX_OBJECTS_FOR_SCAN) {
      const num = parseInt(m[1], 10);
      const at = m.index + m[0].indexOf(m[1]);
      let list = map.get(num);
      if (!list) {
        list = [];
        map.set(num, list);
        count++;
      }
      if (list.length < MAX_SCAN_CANDIDATES) list.push(at);
    }
    this._scanMap = map;
    return map;
  }

  resolve(v) {
    if (!(v instanceof PdfRef)) return v;
    return this.getObject(v.num);
  }

  getObject(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    if (this.resolving.has(num)) return null;
    this.resolving.add(num);
    let val = null;
    try {
      const entry = this.xref.get(num);
      if (entry && entry.type === 'n') val = this.parseIndirectAt(entry.offset);
      else if (entry && entry.type === 'c') val = this.getFromObjStm(entry.objStm, num);
      if (val === null || val === undefined) {
        const cands = this.getScanMap().get(num) || [];
        for (const off of cands) {
          const r = this.parseIndirectAt(off);
          if (r !== null && r !== undefined) {
            val = r;
            break;
          }
        }
      }
      if (val === undefined) val = null;
      this.cache.set(num, val);
      return val;
    } catch {
      this.cache.set(num, null);
      return null;
    } finally {
      this.resolving.delete(num);
    }
  }

  /** 从对象流（/Type /ObjStm）中取出编号为 wantNum 的对象 */
  getFromObjStm(objStmNum, wantNum) {
    let map = this.objStmCache.get(objStmNum);
    if (!map) {
      map = new Map();
      this.objStmCache.set(objStmNum, map);
      try {
        const st = this.getObject(objStmNum);
        if (st instanceof PdfStream) {
          const data = decodePdfStream(st);
          const s2 = data.toString('latin1');
          const n = Number(this.resolve(st.dict.N)) || 0;
          const first = Number(this.resolve(st.dict.First)) || 0;
          const head = s2.slice(0, Math.max(0, first));
          const nums = [];
          const re = /(\d+)[\x00\t\n\f\r ]+(\d+)/g;
          let m;
          while ((m = re.exec(head)) !== null && nums.length < n * 2) {
            nums.push(parseInt(m[1], 10), parseInt(m[2], 10));
          }
          for (let i = 0; i < n; i++) {
            const onum = nums[i * 2];
            const ooff = nums[i * 2 + 1];
            if (onum === undefined || ooff === undefined) break;
            try {
              const lex = new Lexer({ str: s2 }, first + ooff);
              const val = lex.parseValue(false);
              map.set(onum, val === undefined ? null : val);
              if (!this.cache.has(onum)) this.cache.set(onum, val === undefined ? null : val);
            } catch {
              /* 单个对象失败忽略 */
            }
          }
        }
      } catch {
        this.warn('对象流解析失败，部分文本可能缺失');
      }
    }
    return map.has(wantNum) ? map.get(wantNum) : null;
  }

  // --- xref ---------------------------------------------------------------

  findStartXref() {
    const idx = this.str.lastIndexOf('startxref');
    if (idx >= 0) {
      const m = /startxref[\x00\t\n\f\r ]+(\d+)/.exec(this.str.slice(idx, idx + 80));
      if (m) {
        const off = parseInt(m[1], 10);
        if (Number.isFinite(off)) return off;
      }
    }
    // 回退：直接找 xref 关键字
    const x = this.str.lastIndexOf('\nxref');
    if (x >= 0) return x + 1;
    return -1;
  }

  load() {
    if (this._loaded) return;
    this._loaded = true;
    try {
      let offset = this.findStartXref();
      const seen = new Set();
      while (offset >= 0 && offset < this.str.length && !seen.has(offset) && seen.size < 64) {
        seen.add(offset);
        let next;
        try {
          next = this.parseXrefSection(offset);
        } catch {
          next = null;
        }
        if (next === null || next === undefined || next === offset) break;
        offset = next;
      }
    } catch {
      this.warn(WARN_XREF_FALLBACK);
    }
    if (this.xref.size === 0) this.warn(WARN_XREF_FALLBACK);
    try {
      this.ensureTrailer();
    } catch {
      /* 忽略 */
    }
    const enc = this.trailer ? this.trailer.Encrypt : null;
    if (enc !== null && enc !== undefined) this.encrypted = true;
  }

  parseXrefSection(offset) {
    let p = offset;
    while (p < this.str.length && isWhiteCode(this.str.charCodeAt(p))) p++;
    if (this.str.startsWith('xref', p)) {
      p += 4;
      // 子节
      let guard = 0;
      while (guard++ < 100000) {
        while (p < this.str.length && isWhiteCode(this.str.charCodeAt(p))) p++;
        const m = /^(\d+)[\x00\t\n\f\r ]+(\d+)/.exec(this.str.slice(p, p + 40));
        if (!m) break;
        const start = parseInt(m[1], 10);
        const count = parseInt(m[2], 10);
        p += m[0].length;
        for (let i = 0; i < count; i++) {
          while (p < this.str.length && (this.str.charCodeAt(p) === 10 || this.str.charCodeAt(p) === 13 || this.str.charCodeAt(p) === 32)) p++;
          const e = /^(\d{1,10})[\x00\t\n\f\r ]+(\d{1,5})[\x00\t\n\f\r ]*([nf])/.exec(this.str.slice(p, p + 40));
          if (!e) break;
          const off = parseInt(e[1], 10);
          const gen = parseInt(e[2], 10);
          const type = e[3];
          // 先出现的（更新的）交叉引用段优先，避免 /Prev 旧数据覆盖新数据
          if (type === 'n' && off > 0 && !this.xref.has(start + i)) {
            this.xref.set(start + i, { type: 'n', offset: off, gen });
          }
          p += e[0].length;
        }
      }
      const ti = this.str.indexOf('trailer', p);
      if (ti >= 0 && ti < p + 4096) {
        const lex = new Lexer(this, ti + 7);
        const dict = lex.parseValue(false);
        if (isDict(dict)) {
          this.trailer = Object.assign({}, dict, this.trailer || {});
          const xrefStm = this.resolve(dict.XRefStm);
          if (typeof xrefStm === 'number') {
            try {
              this.parseXrefStreamAt(xrefStm);
            } catch {
              /* 忽略 */
            }
          }
          const prev = this.resolve(dict.Prev);
          if (typeof prev === 'number' && prev > 0) return prev;
        }
      }
      return null;
    }
    return this.parseXrefStreamAt(p);
  }

  parseXrefStreamAt(offset) {
    const obj = this.parseIndirectAt(offset);
    if (!(obj instanceof PdfStream)) return null;
    const dict = obj.dict;
    if (nameOf(this.resolve(dict.Type)) !== 'XRef') {
      // 有些文件省略 /Type，只要具备 /W 就按 xref 流处理
      if (this.resolve(dict.W) === undefined || this.resolve(dict.W) === null) return null;
    }
    this.trailer = Object.assign({}, dict, this.trailer || {});
    const data = decodePdfStream(obj);
    const W = this.resolve(dict.W);
    if (!Array.isArray(W) || !W.length) return null;
    const widths = W.map((x) => {
      const n = Number(this.resolve(x));
      return Number.isFinite(n) && n > 0 ? n : 0;
    });
    const entryLen = widths.reduce((a, b) => a + b, 0);
    if (entryLen <= 0) return null;
    let index = this.resolve(dict.Index);
    if (!Array.isArray(index) || index.length < 2) {
      index = [0, Number(this.resolve(dict.Size)) || 0];
    }
    let row = 0;
    for (let seg = 0; seg + 1 < index.length; seg += 2) {
      const start = Number(this.resolve(index[seg])) || 0;
      const count = Number(this.resolve(index[seg + 1])) || 0;
      for (let i = 0; i < count; i++) {
        const off = row * entryLen;
        row++;
        if (off + entryLen > data.length) break;
        const fields = [];
        let q = off;
        for (const w of widths) {
          let v = 0;
          for (let k = 0; k < w; k++) v = v * 256 + data[q + k];
          fields.push(v);
          q += w;
        }
        const type = widths[0] === 0 ? 1 : fields[0];
        const f2 = fields[1] || 0;
        const f3 = widths.length > 2 ? fields[2] || 0 : 0;
        // 先出现的（更新的）交叉引用段优先，避免 /Prev 旧数据覆盖新数据
        if (this.xref.has(start + i)) continue;
        if (type === 1) this.xref.set(start + i, { type: 'n', offset: f2, gen: f3 });
        else if (type === 2) this.xref.set(start + i, { type: 'c', objStm: f2, idx: f3 });
      }
    }
    const prev = this.resolve(dict.Prev);
    if (typeof prev === 'number' && prev > 0) return prev;
    return null;
  }

  ensureTrailer() {
    if (this.trailer && (this.trailer.Root || this.trailer.Encrypt)) return;
    let idx = this.str.lastIndexOf('trailer');
    let guard = 0;
    while (idx >= 0 && guard++ < 12) {
      try {
        const lex = new Lexer(this, idx + 7);
        const dict = lex.parseValue(false);
        if (isDict(dict)) {
          this.trailer = Object.assign({}, dict, this.trailer || {});
          if (dict.Root || dict.Encrypt) break;
        }
      } catch {
        /* 继续 */
      }
      idx = this.str.lastIndexOf('trailer', idx - 1);
    }
    if (!this.trailer || !this.trailer.Root) {
      const root = this.findCatalogByScan();
      if (root) {
        this.trailer = this.trailer || {};
        this.trailer.Root = root;
      }
    }
  }

  findCatalogByScan() {
    const re = /\/Type[\x00\t\n\f\r ]*\/Catalog/g;
    let m;
    let guard = 0;
    while ((m = re.exec(this.str)) !== null && guard++ < 64) {
      const before = this.str.slice(Math.max(0, m.index - 200), m.index);
      const om = /(\d{1,10})[\x00\t\n\f\r ]+(\d{1,5})[\x00\t\n\f\r ]+obj[\x00\t\n\f\r ][^]*$/.exec(before);
      if (om) return new PdfRef(parseInt(om[1], 10), parseInt(om[2], 10));
    }
    return null;
  }

  findPagesByScan(maxPages) {
    const pages = [];
    const re = /\/Type[\x00\t\n\f\r ]*\/Page(?![a-zA-Z])/g;
    let m;
    let guard = 0;
    const seen = new Set();
    while ((m = re.exec(this.str)) !== null && guard++ < 200000 && pages.length < maxPages) {
      const before = this.str.slice(Math.max(0, m.index - 4000), m.index);
      const om = /(\d{1,10})[\x00\t\n\f\r ]+(\d{1,5})[\x00\t\n\f\r ]+obj[\x00\t\n\f\r ][^]*$/.exec(before);
      if (!om) continue;
      const num = parseInt(om[1], 10);
      if (seen.has(num)) continue;
      seen.add(num);
      const dict = this.getObject(num);
      if (isDict(dict) && nameOf(this.resolve(dict.Type)) === 'Page') {
        pages.push({ ref: new PdfRef(num, 0), dict, inherited: this.inheritFor(dict) });
      }
    }
    pages.sort((a, b) => a.ref.num - b.ref.num);
    return pages;
  }

  /** 页面上溯收集继承属性（/Resources 等） */
  inheritFor(dict) {
    const inh = {};
    if (dict.Resources !== undefined) inh.Resources = dict.Resources;
    if (dict.MediaBox !== undefined) inh.MediaBox = dict.MediaBox;
    let node = dict;
    let depth = 0;
    while (node && depth++ < 32) {
      const parent = this.resolve(node.Parent);
      if (!isDict(parent)) break;
      if (inh.Resources === undefined && parent.Resources !== undefined) inh.Resources = parent.Resources;
      if (inh.MediaBox === undefined && parent.MediaBox !== undefined) inh.MediaBox = parent.MediaBox;
      node = parent;
    }
    return inh;
  }

  // --- 页面 ---------------------------------------------------------------

  collectPages(maxPages) {
    const pages = [];
    const visited = new Set();
    const root = this.trailer ? this.resolve(this.trailer.Root) : null;
    const rootRef = this.trailer ? this.trailer.Root : null;
    const walk = (nodeRef, inherited, depth) => {
      if (pages.length >= maxPages || depth > 64) return;
      let key = null;
      if (nodeRef instanceof PdfRef) key = nodeRef.num;
      if (key !== null) {
        if (visited.has(key)) return;
        visited.add(key);
      }
      const node = this.resolve(nodeRef);
      if (!isDict(node)) return;
      const inh = {};
      if (inherited) Object.assign(inh, inherited);
      if (node.Resources !== undefined) inh.Resources = node.Resources;
      if (node.MediaBox !== undefined) inh.MediaBox = node.MediaBox;
      if (node.Rotate !== undefined) inh.Rotate = node.Rotate;

      const type = nameOf(this.resolve(node.Type));
      const kids = this.resolve(node.Kids);
      const isLeaf = type === 'Page' || (!Array.isArray(kids) && type !== 'Pages');
      if (!isLeaf && Array.isArray(kids) && kids.length) {
        const count = this.resolve(node.Count);
        if (typeof count === 'number' && count === 0) return;
        for (const kid of kids) walk(kid, inh, depth + 1);
        return;
      }
      if (type === 'Page' || (isDict(node) && node.Contents !== undefined)) {
        pages.push({ ref: nodeRef, dict: node, inherited: inh });
      }
    };
    if (isDict(root)) {
      const pagesNode = this.resolve(root.Pages);
      walk(root.Pages, {}, 0);
      if (!pages.length && isDict(this.resolve(pagesNode))) {
        walk(root.Pages, {}, 0);
      }
      if (!pages.length) {
        // 有些文件 /Pages 指向错误，直接遍历 Catalog 的 Kids
        const direct = this.resolve(root.Kids);
        if (Array.isArray(direct)) for (const k of direct) walk(k, {}, 0);
      }
    }
    if (!pages.length) {
      const scanned = this.findPagesByScan(Math.max(maxPages, 100));
      for (const p of scanned) pages.push(p);
    }
    if (!pages.length) return { pages: [], fromTree: false };
    return { pages, fromTree: pages.length > 0 };
  }

  getPageContent(page) {
    const parts = [];
    try {
      const c = this.resolve(page.dict.Contents);
      const list = Array.isArray(c) ? c : [c];
      for (const item of list) {
        const st = this.resolve(item);
        if (st instanceof PdfStream) {
          parts.push(decodePdfStream(st));
          parts.push(Buffer.from('\n', 'latin1'));
        }
      }
    } catch {
      this.warn('页面内容流读取失败，该页文本可能缺失');
    }
    return Buffer.concat(parts);
  }

  extractPageText(page) {
    try {
      const resources = this.resolve(page.inherited ? page.inherited.Resources : null) || {};
      const content = this.getPageContent(page);
      if (!content.length) return '';
      const state = createTextState(this);
      runContent(this, content.toString('latin1'), isDict(resources) ? resources : {}, state, 0);
      return state.chunks.join('');
    } catch {
      this.warn('部分页面内容解析失败，已跳过该页');
      return '';
    }
  }

  /** 页面树完全不可用时的兜底：直接扫描看起来像内容流的对象 */
  fallbackContentText() {
    const nums = new Set();
    for (const k of this.xref.keys()) nums.add(k);
    for (const k of this.getScanMap().keys()) nums.add(k);
    const sorted = Array.from(nums).sort((a, b) => a - b).slice(0, MAX_FALLBACK_STREAMS);
    const state = createTextState(this);
    let found = 0;
    for (const n of sorted) {
      let obj;
      try {
        obj = this.getObject(n);
      } catch {
        continue;
      }
      if (!(obj instanceof PdfStream)) continue;
      if (nameOf(this.resolve(obj.dict.Subtype)) === 'Form') continue;
      let data;
      try {
        data = decodePdfStream(obj);
      } catch {
        continue;
      }
      if (data.length < 8 || data.length > 40 * 1024 * 1024) continue;
      const s = data.toString('latin1');
      if (!/\bBT\b/.test(s) || !(/Tj|TJ/.test(s))) continue;
      found++;
      if (found > 500) break;
      try {
        const resources = this.resolve(obj.dict.Resources) || {};
        runContent(this, s, isDict(resources) ? resources : {}, state, 0);
      } catch {
        /* 忽略单个流 */
      }
    }
    return state.chunks.join('');
  }
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

function failure(warnings, extractor = 'pdf') {
  return {
    text: '',
    meta: { pageCount: 0, pages: [], extractor, warnings: warnings.slice() },
  };
}

/**
 * 从 PDF 字节流中提取文本。
 *
 * @param {Buffer|Uint8Array} buffer 原始 PDF 字节
 * @param {{ maxPages?: number }} [opts]
 * @returns {Promise<{ text: string, meta: { pageCount: number, pages: string[], extractor: string, warnings: string[] } }>}
 */
export async function extractPdfText(buffer, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const warnings = [];
  const maxPages =
    Number.isFinite(options.maxPages) && options.maxPages > 0
      ? Math.min(Math.floor(options.maxPages), 100000)
      : MAX_PAGES_DEFAULT;

  let doc;
  try {
    if (buffer === null || buffer === undefined) {
      return failure(['未提供 PDF 数据，无法提取文本']);
    }
    doc = new PDFDocument(buffer);
  } catch {
    return failure(['PDF 数据格式不正确，无法读取']);
  }

  if (doc.buf.length === 0) {
    return failure(['PDF 内容为空，无法提取文本']);
  }

  const headerIdx = doc.str.indexOf('%PDF-');
  const hasHeader = headerIdx >= 0 && headerIdx < 1024;
  if (!hasHeader) {
    warnings.push(WARN_NO_HEADER);
  }

  try {
    doc.load();

    if (doc.encrypted) {
      return failure([WARN_ENCRYPTED, ...doc.warnings]);
    }

    const collected = doc.collectPages(maxPages);
    let pages = collected.pages;

    if (!pages.length) {
      // 页面树不可用：直接扫描内容流
      warnings.push(WARN_NO_PAGES);
      let raw = '';
      try {
        raw = doc.fallbackContentText();
      } catch {
        raw = '';
      }
      const cleaned = cleanupText(raw);
      const allWarnings = [...warnings, ...doc.warnings];
      if (!cleaned) {
        if (!hasHeader) return failure(allWarnings.length ? allWarnings : [WARN_NO_HEADER]);
        allWarnings.push(WARN_SCANNED);
        return failure(allWarnings);
      }
      return {
        text: cleaned,
        meta: { pageCount: 1, pages: [cleaned], extractor: 'pdf', warnings: dedupe(allWarnings) },
      };
    }

    if (pages.length > maxPages) pages = pages.slice(0, maxPages);

    const pageTexts = [];
    let okCount = 0;
    for (let i = 0; i < pages.length; i++) {
      let t = '';
      try {
        t = cleanupText(doc.extractPageText(pages[i]));
      } catch {
        doc.warn(`第 ${i + 1} 页解析失败，已跳过`);
        t = '';
      }
      if (t) okCount++;
      pageTexts.push(t);
    }

    let text = pageTexts.join('\n\n');
    text = text.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

    const allWarnings = [...warnings, ...doc.warnings];
    if (okCount === 0 && !text) {
      allWarnings.push(WARN_SCANNED);
    }

    return {
      text,
      meta: {
        pageCount: pages.length,
        pages: pageTexts,
        extractor: 'pdf',
        warnings: dedupe(allWarnings),
      },
    };
  } catch (err) {
    const msg = err && err.message ? String(err.message).slice(0, 120) : '未知错误';
    return failure(dedupe([...warnings, ...doc.warnings, `PDF 解析失败：${msg}`]));
  }
}

function dedupe(arr) {
  const out = [];
  for (const x of arr) {
    if (typeof x === 'string' && x && !out.includes(x)) out.push(x);
  }
  return out;
}

export default extractPdfText;
