/**
 * browser-shim.js — 浏览器端 Node 兼容垫片（零第三方依赖，纯 ESM）
 *
 * 目标：让原本依赖 Node 专有能力的 PDF / DOCX / ZIP 解析代码可以在浏览器里直接跑。
 *
 * 提供两样东西：
 *   1. ShimBuffer —— 对齐 node:buffer 的 Buffer 子集（含共享内存的 slice/subarray 语义）
 *   2. inflateSync / inflateRawSync —— 纯 JS 的 **同步** DEFLATE 解码器
 *      （浏览器自带的 DecompressionStream 是异步的，而 PDF 解析是同步流程，无法使用）
 *
 * 设计要点：
 *   - 本文件不 import 任何东西，只使用 Uint8Array / TextEncoder / TextDecoder 等
 *     浏览器与 Node 都有的标准能力，因此同一份代码在浏览器和 Node（跑测试）里都能运行。
 *   - DEFLATE 用「预计算 Huffman 查表」解码，不做逐位遍历树，几 MB 压缩流也能接受。
 *   - 所有错误信息均为可读中文，绝不静默返回残缺数据、绝不死循环。
 */

/* ================================================================== *
 * 一、通用小工具
 * ================================================================== */

const UTF8_ENCODER = new TextEncoder();
/** Node 的 Buffer.toString('utf8') 会保留 BOM，所以 ignoreBOM 必须为 true */
const UTF8_DECODER = new TextDecoder('utf-8', { ignoreBOM: true });

const HEX_DIGITS = '0123456789abcdef';

/** 输出体积上限（防御损坏数据 / 压缩炸弹导致的内存失控） */
const MAX_OUTPUT_BYTES = 1 << 30; // 1 GiB

function rangeError(message, code = 'ERR_OUT_OF_RANGE') {
  const err = new RangeError(message);
  err.code = code;
  return err;
}

/** 与 node:buffer 类似：负数/小数按 ToIndex 规则处理（负数抛错） */
function toLength(value, name = 'size') {
  const n = Number(value);
  if (!Number.isFinite(n)) throw rangeError(`参数 ${name} 必须是有限数字，收到 ${value}`);
  if (n < 0) throw rangeError(`参数 ${name} 必须 >= 0，收到 ${value}`);
  return Math.floor(n);
}

/** slice/subarray 的负索引归一化（越界则夹紧） */
function relativeIndex(index, length) {
  if (index === undefined) return undefined;
  let i = Math.trunc(Number(index));
  if (!Number.isFinite(i)) i = 0;
  if (i < 0) {
    i += length;
    if (i < 0) i = 0;
  } else if (i > length) {
    i = length;
  }
  return i;
}

/** copy 用的偏移夹紧（Node 的 copy 对越界是夹紧而非抛错） */
function clampOffset(index, length) {
  if (index === undefined) return 0;
  let i = Math.trunc(Number(index));
  if (!Number.isFinite(i) || i < 0) i = 0;
  if (i > length) i = length;
  return i;
}

function isSharedArrayBuffer(value) {
  return typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer;
}

function isArrayBuffer(value) {
  return value instanceof ArrayBuffer || isSharedArrayBuffer(value);
}

/* ------------------------------ 编码 ------------------------------ */

function normalizeEncoding(encoding) {
  const enc = String(encoding ?? 'utf8').toLowerCase().replace(/[-_]/g, '');
  switch (enc) {
    case 'utf8':
    case 'utf':
      return 'utf8';
    case 'hex':
      return 'hex';
    case 'base64':
    case 'base64url':
      return 'base64';
    case 'latin1':
    case 'binary':
      return 'latin1';
    case 'ascii':
      return 'ascii';
    default:
      throw new TypeError(`不支持的编码：${encoding}（支持 utf8 / utf-8 / hex / base64 / base64url / latin1 / binary / ascii）`);
  }
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 只建一次查表：非法字符为 -1，'=' 为 -2，空白等忽略字符为 -1 */
const B64_LOOKUP = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < 64; i++) table[B64_ALPHABET.charCodeAt(i)] = i;
  table[45] = 62; // '-' base64url
  table[95] = 63; // '_' base64url
  table[61] = -2; // '='
  return table;
})();

function bytesToBase64(bytes, start, end) {
  let out = '';
  const rem = (end - start) % 3;
  const mainEnd = end - rem;
  for (let i = start; i < mainEnd; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      B64_ALPHABET[(n >>> 18) & 63] +
      B64_ALPHABET[(n >>> 12) & 63] +
      B64_ALPHABET[(n >>> 6) & 63] +
      B64_ALPHABET[n & 63];
  }
  if (rem === 1) {
    const n = bytes[mainEnd];
    out += B64_ALPHABET[n >> 2] + B64_ALPHABET[(n & 3) << 4] + '==';
  } else if (rem === 2) {
    const n = (bytes[mainEnd] << 8) | bytes[mainEnd + 1];
    out += B64_ALPHABET[n >> 10] + B64_ALPHABET[(n >> 4) & 63] + B64_ALPHABET[(n & 15) << 2] + '=';
  }
  return out;
}

/** 与 Node 一致：忽略非法字符，遇到 '=' 停止；base64url 的 - _ 也接受 */
function base64ToBytes(str) {
  const out = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < str.length; i++) {
    const v = B64_LOOKUP[str.charCodeAt(i) & 0xff];
    if (v === -2) break; // '='
    if (v < 0) continue; // 空白 / 非法字符
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}

function bytesToHex(bytes, start, end) {
  let out = '';
  for (let i = start; i < end; i++) {
    const b = bytes[i];
    out += HEX_DIGITS[b >> 4] + HEX_DIGITS[b & 15];
  }
  return out;
}

function bytesToLatin1(bytes, start, end) {
  const CHUNK = 0x8000;
  let out = '';
  for (let i = start; i < end; i += CHUNK) {
    const stop = Math.min(i + CHUNK, end);
    out += String.fromCharCode.apply(null, bytes.subarray(i, stop));
  }
  return out;
}

/* ================================================================== *
 * 二、ShimBuffer —— node:buffer 的 Buffer 兼容子集
 * ================================================================== */

/**
 * 继承 Uint8Array，因此天然是「ArrayBuffer 上的视图」：
 * slice / subarray 返回共享内存的视图，这一点与 Node 的 Buffer 完全一致。
 *
 * 注意：这里刻意不做全局污染，消费方需要显式
 *   import { Buffer } from './browser-shim.js'
 * 或把 ShimBuffer 注入到解析模块里。
 */
export class ShimBuffer extends Uint8Array {
  /* ----------------------------- 静态方法 ----------------------------- */

  /**
   * Buffer.from(value[, encodingOrOffset[, length]])
   * 支持：字符串（utf8/hex/base64/latin1/ascii）、数组/类数组、
   *       ArrayBuffer（共享内存）、TypedArray/DataView（按 Node 语义复制）。
   */
  static from(value, encodingOrOffset, length) {
    if (typeof value === 'string') return fromString(value, encodingOrOffset);

    if (isArrayBuffer(value)) {
      const offset = encodingOrOffset === undefined ? 0 : toLength(encodingOrOffset, 'byteOffset');
      const len = length === undefined ? value.byteLength - offset : toLength(length, 'length');
      if (offset + len > value.byteLength) {
        throw rangeError(
          `Buffer.from(arrayBuffer, byteOffset, length) 越界：byteOffset=${offset} length=${len} bufferLength=${value.byteLength}`,
          'ERR_BUFFER_OUT_OF_BOUNDS'
        );
      }
      return new ShimBuffer(value, offset, len); // 共享内存
    }

    if (ArrayBuffer.isView(value)) {
      // Node 对 TypedArray / DataView 是复制语义（避免误改源数据）
      const view = value instanceof Uint8Array
        ? value
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const out = new ShimBuffer(view.length);
      out.set(view);
      return out;
    }

    if (value === null || value === undefined) {
      throw new TypeError('Buffer.from 的第一个参数必须是字符串、数组、ArrayBuffer 或 TypedArray');
    }

    // 类数组：[1,2,3] / { length: n }，字节值按 & 0xff 截断（与 Node 一致）
    const len = value.length === undefined ? 0 : toLength(value.length, 'length');
    const out = new ShimBuffer(len);
    for (let i = 0; i < len; i++) out[i] = Number(value[i]) & 0xff;
    return out;
  }

  /** 零填充分配；fill 可为数字 / 字符串 / Buffer / Uint8Array */
  static alloc(size, fill, encoding) {
    const len = toLength(size, 'size');
    const out = new ShimBuffer(len); // TypedArray 默认就是 0
    if (fill !== undefined) out.fill(fill, 0, len, encoding);
    return out;
  }

  /** 拼接多段；chunk 可以是 ShimBuffer、Node Buffer 或普通 Uint8Array */
  static concat(list, totalLength) {
    if (!Array.isArray(list)) throw new TypeError('Buffer.concat 的第一个参数必须是数组');
    let sum = 0;
    for (const chunk of list) {
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError('Buffer.concat 的列表元素必须是 Uint8Array / Buffer');
      }
      sum += chunk.length;
    }
    const len = totalLength === undefined ? sum : toLength(totalLength, 'totalLength');
    const out = new ShimBuffer(len);
    let offset = 0;
    for (const chunk of list) {
      if (offset >= len) break;
      const n = Math.min(chunk.length, len - offset);
      out.set(chunk.subarray(0, n), offset);
      offset += n;
    }
    return out;
  }

  /** 同时兼容本垫片的 ShimBuffer 与 Node 原生 Buffer */
  static isBuffer(value) {
    return value instanceof ShimBuffer || (value instanceof Uint8Array && typeof value.readUInt32LE === 'function');
  }

  /* -------------------------- 实例属性 / 方法 -------------------------- */

  /** 共享内存的区间视图（与 Node 的 Buffer.subarray 一致） */
  subarray(begin, end) {
    const len = this.length;
    const start = relativeIndex(begin, len) ?? 0;
    let stop = relativeIndex(end, len);
    if (stop === undefined) stop = len;
    if (stop < start) stop = start;
    return new ShimBuffer(this.buffer, this.byteOffset + start, stop - start);
  }

  /** Node 的 Buffer.slice 是 subarray 的别名：共享内存，不是拷贝 */
  slice(begin, end) {
    return this.subarray(begin, end);
  }

  /**
   * toString([encoding[, start[, end]]])
   * 支持 utf8 / latin1(binary) / hex / base64 / ascii
   */
  toString(encoding = 'utf8', start = 0, end = this.length) {
    // 兼容 Node 的 toString(encoding) 之外，也允许省略参数
    if (typeof encoding !== 'string') {
      start = 0;
      end = this.length;
      encoding = 'utf8';
    }
    const len = this.length;
    const s = relativeIndex(start, len) ?? 0;
    const e = relativeIndex(end, len);
    const stop = e === undefined ? len : Math.max(s, e);
    switch (normalizeEncoding(encoding)) {
      case 'utf8':
        return UTF8_DECODER.decode(this.subarray(s, stop));
      case 'latin1':
        return bytesToLatin1(this, s, stop);
      case 'hex':
        return bytesToHex(this, s, stop);
      case 'base64':
        return bytesToBase64(this, s, stop);
      case 'ascii': {
        let out = '';
        for (let i = s; i < stop; i++) out += String.fromCharCode(this[i] & 0x7f);
        return out;
      }
      /* c8 ignore next */
      default:
        throw new TypeError(`不支持的编码：${encoding}`);
    }
  }

  /* ----------------------------- 读取 ----------------------------- */

  #checkRead(offset, bytes, name) {
    if (!Number.isInteger(offset) || offset < 0 || offset + bytes > this.length) {
      throw rangeError(
        `Buffer.${name} 越界读取：offset=${offset} 需要 ${bytes} 字节，length=${this.length}`,
        offset < 0 || !Number.isInteger(offset) ? 'ERR_OUT_OF_RANGE' : 'ERR_BUFFER_OUT_OF_BOUNDS'
      );
    }
  }

  readUInt8(offset = 0) {
    this.#checkRead(offset, 1, 'readUInt8');
    return this[offset];
  }

  readUInt16LE(offset = 0) {
    this.#checkRead(offset, 2, 'readUInt16LE');
    return this[offset] | (this[offset + 1] << 8);
  }

  readUInt16BE(offset = 0) {
    this.#checkRead(offset, 2, 'readUInt16BE');
    return (this[offset] << 8) | this[offset + 1];
  }

  readUInt32LE(offset = 0) {
    this.#checkRead(offset, 4, 'readUInt32LE');
    return (this[offset] | (this[offset + 1] << 8) | (this[offset + 2] << 16) | (this[offset + 3] << 24)) >>> 0;
  }

  readUInt32BE(offset = 0) {
    this.#checkRead(offset, 4, 'readUInt32BE');
    return ((this[offset] << 24) | (this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3]) >>> 0;
  }

  readInt8(offset = 0) {
    this.#checkRead(offset, 1, 'readInt8');
    return (this[offset] << 24) >> 24;
  }

  readInt16LE(offset = 0) {
    this.#checkRead(offset, 2, 'readInt16LE');
    return ((this[offset] | (this[offset + 1] << 8)) << 16) >> 16;
  }

  readInt32LE(offset = 0) {
    this.#checkRead(offset, 4, 'readInt32LE');
    return this[offset] | (this[offset + 1] << 8) | (this[offset + 2] << 16) | (this[offset + 3] << 24);
  }

  readBigUInt64LE(offset = 0) {
    this.#checkRead(offset, 8, 'readBigUInt64LE');
    let value = 0n;
    for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(this[offset + i]);
    return value;
  }

  readBigUInt64BE(offset = 0) {
    this.#checkRead(offset, 8, 'readBigUInt64BE');
    let value = 0n;
    for (let i = 0; i < 8; i++) value = (value << 8n) | BigInt(this[offset + i]);
    return value;
  }

  /* ----------------------------- 查找 ----------------------------- */

  #needleBytes(value, encoding) {
    if (typeof value === 'number') return value & 0xff;
    if (typeof value === 'string') return fromString(value, encoding);
    if (value instanceof Uint8Array) return value;
    throw new TypeError('indexOf / includes 的 value 必须是数字、字符串或 Uint8Array/Buffer');
  }

  /**
   * indexOf(value[, byteOffset])
   * value 可为数字、字符串或 Uint8Array/Buffer；返回首次出现的下标，找不到返回 -1。
   */
  indexOf(value, byteOffset = 0) {
    const len = this.length;
    let start = Math.trunc(Number(byteOffset));
    if (!Number.isFinite(start)) start = 0;
    if (start < 0) start = Math.max(0, len + start);
    if (start > len) start = len;

    const needle = this.#needleBytes(value);
    if (typeof needle === 'number') {
      for (let i = start; i < len; i++) if (this[i] === needle) return i;
      return -1;
    }
    if (needle.length === 0) return start;
    const first = needle[0];
    const last = len - needle.length;
    outer: for (let i = start; i <= last; i++) {
      if (this[i] !== first) continue;
      for (let j = 1; j < needle.length; j++) {
        if (this[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  includes(value, byteOffset = 0) {
    return this.indexOf(value, byteOffset) !== -1;
  }

  /* ----------------------------- 写入 ----------------------------- */

  /** fill(value[, start[, end]][, encoding]) —— 返回 this */
  fill(value, start, end, encoding) {
    const len = this.length;
    const s = start === undefined ? 0 : normalizeFillOffset(start, len, 'start');
    const e = end === undefined ? len : normalizeFillOffset(end, len, 'end');
    const stop = Math.max(s, e);

    if (typeof value === 'number') {
      const byte = value & 0xff;
      for (let i = s; i < stop; i++) this[i] = byte;
      return this;
    }
    const bytes = value instanceof Uint8Array ? value : fromString(String(value), encoding);
    if (bytes.length === 0) return this;
    for (let i = s; i < stop; i++) this[i] = bytes[(i - s) % bytes.length];
    return this;
  }

  /** copy(target[, targetStart[, sourceStart[, sourceEnd]]]) —— 返回复制的字节数 */
  copy(target, targetStart, sourceStart, sourceEnd) {
    if (!(target instanceof Uint8Array)) {
      throw new TypeError('Buffer.copy 的目标必须是 Uint8Array / Buffer');
    }
    const tLen = target.length;
    const sLen = this.length;
    const ts = clampOffset(targetStart, tLen);
    const ss = clampOffset(sourceStart, sLen);
    const se = sourceEnd === undefined ? sLen : Math.max(ss, clampOffset(sourceEnd, sLen));
    const n = Math.min(se - ss, tLen - ts);
    if (n <= 0) return 0;
    // TypedArray.set 对同一底层 buffer 的重叠区域等价于 memmove，行为与 Node 一致
    target.set(this.subarray(ss, ss + n), ts);
    return n;
  }

  equals(other) {
    if (!(other instanceof Uint8Array)) return false;
    if (other.length !== this.length) return false;
    for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
    return true;
  }
}

function normalizeFillOffset(value, length, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > length) {
    throw rangeError(`Buffer.fill 的 ${name} 超出范围：收到 ${value}（length=${length}）`);
  }
  return n;
}

function fromString(str, encoding) {
  switch (normalizeEncoding(encoding)) {
    case 'utf8': {
      const encoded = UTF8_ENCODER.encode(str);
      const out = new ShimBuffer(encoded.length);
      out.set(encoded);
      return out;
    }
    case 'latin1': {
      const out = new ShimBuffer(str.length);
      for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
      return out;
    }
    case 'ascii': {
      const out = new ShimBuffer(str.length);
      for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0x7f;
      return out;
    }
    case 'hex': {
      const out = new ShimBuffer(str.length >> 1);
      let o = 0;
      for (let i = 0; i + 1 < str.length; i += 2) {
        const hi = hexValue(str.charCodeAt(i));
        const lo = hexValue(str.charCodeAt(i + 1));
        if (hi < 0 || lo < 0) break; // 与 Node 一致：遇到非法字符即停止
        out[o++] = (hi << 4) | lo;
      }
      return o === out.length ? out : new ShimBuffer(out.buffer, 0, o);
    }
    case 'base64': {
      const bytes = base64ToBytes(str);
      const out = new ShimBuffer(bytes.length);
      out.set(bytes);
      return out;
    }
    /* c8 ignore next */
    default:
      throw new TypeError(`不支持的编码：${encoding}`);
  }
}

function hexValue(code) {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 102) return code - 87;
  if (code >= 65 && code <= 70) return code - 55;
  return -1;
}

/* ================================================================== *
 * 三、同步 DEFLATE 解码器（RFC 1951）
 * ================================================================== */

/* --------------------------- 码表常量 --------------------------- */

/** 长度码 257–285 的基准值与额外位数（下标 0..28 对应符号 257..285） */
const LENGTH_BASE = new Uint16Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59,
  67, 83, 99, 115, 131, 163, 195, 227, 258,
]);
const LENGTH_EXTRA = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
  4, 4, 4, 4, 5, 5, 5, 5, 0,
]);

/** 距离码 0–29 的基准值与额外位数 */
const DIST_BASE = new Uint16Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
  1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
]);
const DIST_EXTRA = new Uint8Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8,
  9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]);

/** 动态块中「码长码长」的读取顺序 */
const CL_ORDER = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);

/* --------------------------- Huffman 查表 --------------------------- */

function reverseBits(value, bits) {
  let out = 0;
  for (let i = 0; i < bits; i++) {
    out = (out << 1) | (value & 1);
    value >>= 1;
  }
  return out;
}

/**
 * 建「一级全展开」查表：表长 2^maxBits。
 *
 * 这是性能关键：解码一个符号 = 一次数组索引，不需要沿树逐位走。
 * 因为 DEFLATE 的位序是 LSB-first，所以把规范码（MSB-first）反转后，
 * 再以 2^len 为步长填满整张表，就能直接用「低 maxBits 位」当索引。
 *
 * 表项 lens[i] === 0 表示该索引不对应任何合法码（残缺/非法码表）。
 */
function buildFastTable(lengths, numSymbols, label) {
  let maxBits = 0;
  for (let i = 0; i < numSymbols; i++) if (lengths[i] > maxBits) maxBits = lengths[i];
  if (maxBits === 0) {
    // 例如「没有距离码」的动态块：给一张空表，真用到时会报错
    return { table: new Uint16Array(1), lens: new Uint8Array(1), mask: 0, maxBits: 0 };
  }
  if (maxBits > 15) throw new Error(`DEFLATE ${label} Huffman 码长 ${maxBits} 超过上限 15（数据损坏）`);

  const counts = new Uint16Array(maxBits + 1);
  for (let i = 0; i < numSymbols; i++) counts[lengths[i]]++;
  counts[0] = 0;

  // Kraft 不等式检查：过满的码表一定是损坏数据
  let left = 1;
  for (let bits = 1; bits <= maxBits; bits++) {
    left = (left << 1) - counts[bits];
    if (left < 0) throw new Error(`DEFLATE ${label} Huffman 码表过满（无效码表，数据损坏）`);
  }

  // 规范 Huffman 码：每个长度上的起始码
  const nextCode = new Uint16Array(maxBits + 2);
  let code = 0;
  for (let bits = 1; bits <= maxBits; bits++) {
    code = (code + counts[bits - 1]) << 1;
    nextCode[bits] = code;
  }

  const size = 1 << maxBits;
  const table = new Uint16Array(size);
  const lens = new Uint8Array(size);
  for (let sym = 0; sym < numSymbols; sym++) {
    const len = lengths[sym];
    if (len === 0) continue;
    const reversed = reverseBits(nextCode[len]++, len);
    const step = 1 << len;
    for (let j = reversed; j < size; j += step) {
      table[j] = sym;
      lens[j] = len;
    }
  }
  return { table, lens, mask: size - 1, maxBits };
}

/** 码长码用的规范表（只在动态块头部使用，逐位慢速解码即可） */
function buildCanonical(lengths, numSymbols) {
  let maxBits = 0;
  for (let i = 0; i < numSymbols; i++) if (lengths[i] > maxBits) maxBits = lengths[i];
  const counts = new Uint16Array(maxBits + 1);
  for (let i = 0; i < numSymbols; i++) counts[lengths[i]]++;
  if (maxBits > 0) counts[0] = 0;
  const offsets = new Uint32Array(maxBits + 1);
  let sum = 0;
  for (let bits = 1; bits <= maxBits; bits++) {
    offsets[bits] = sum;
    sum += counts[bits];
  }
  const symbols = new Uint16Array(sum);
  for (let sym = 0; sym < numSymbols; sym++) {
    const len = lengths[sym];
    if (len) symbols[offsets[len]++] = sym;
  }
  return { counts, symbols, maxBits };
}

/* --------------------------- 固定 Huffman 表 --------------------------- */

let FIXED_TABLES = null;

function getFixedTables() {
  if (FIXED_TABLES) return FIXED_TABLES;
  const litLengths = new Uint8Array(288);
  for (let i = 0; i < 144; i++) litLengths[i] = 8;
  for (let i = 144; i < 256; i++) litLengths[i] = 9;
  for (let i = 256; i < 280; i++) litLengths[i] = 7;
  for (let i = 280; i < 288; i++) litLengths[i] = 8;
  const distLengths = new Uint8Array(32).fill(5);
  FIXED_TABLES = {
    lit: buildFastTable(litLengths, 288, 'fixed literal/length'),
    dist: buildFastTable(distLengths, 32, 'fixed distance'),
  };
  return FIXED_TABLES;
}

/* --------------------------- 核心 inflate --------------------------- */

/**
 * 裸 DEFLATE 解码。
 * @returns {{ bytes: ShimBuffer, adlerStart: number }}
 *   adlerStart 是「流结束后的第一个字节边界」在输入中的下标，供 zlib 容器读 Adler-32。
 * 抛出的截断错误带 .truncated / .partial（部分结果），便于 Z_SYNC_FLUSH 容错。
 */
function inflateRawCore(data, dictHint) {
  const dataLen = data.length;
  let pos = 0;
  let bitbuf = 0;
  let bitcnt = 0;

  let out = new Uint8Array(Math.max(256, Math.min(dataLen * 4 + 64, 1 << 22)));
  let outLen = 0;

  const partialView = () => new ShimBuffer(out.buffer, out.byteOffset, outLen);
  const fail = (message) => new Error(`DEFLATE 解码失败：${message}`);
  const truncated = (message) => {
    const err = new Error(`DEFLATE 数据被截断：${message}`);
    err.truncated = true;
    err.partial = partialView();
    return err;
  };

  function ensure(extra) {
    const need = outLen + extra;
    if (need <= out.length) return;
    let cap = out.length || 256;
    while (cap < need) {
      cap = cap < 1 << 20 ? cap * 2 : Math.floor(cap * 1.5);
      if (cap > MAX_OUTPUT_BYTES) {
        cap = MAX_OUTPUT_BYTES;
        break;
      }
    }
    if (cap < need) throw fail('输出体积超过 1GiB 上限（数据损坏或压缩炸弹）');
    const next = new Uint8Array(cap);
    next.set(out.subarray(0, outLen));
    out = next;
  }

  /** 读 n 位（LSB-first），不足则视为截断 */
  function readBits(n) {
    while (bitcnt < n) {
      if (pos >= dataLen) throw truncated('读取比特时已到输入末尾');
      bitbuf |= data[pos++] << bitcnt;
      bitcnt += 8;
    }
    const value = bitbuf & ((1 << n) - 1);
    bitbuf >>>= n;
    bitcnt -= n;
    return value;
  }

  /** 动态块头部：码长码的逐位规范解码 */
  function readCodeSlow(canonical) {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let bits = 1; bits <= canonical.maxBits; bits++) {
      code |= readBits(1);
      const count = canonical.counts[bits];
      if (code - first < count) return canonical.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw fail('动态头中的码长编码无效');
  }

  let isFinal = 0;
  do {
    isFinal = readBits(1);
    const blockType = readBits(2);

    /* -------- BTYPE=0：stored（未压缩） -------- */
    if (blockType === 0) {
      // 丢弃当前字节里的剩余填充位，并把预读的整字节「退回」
      pos -= bitcnt >>> 3;
      bitbuf = 0;
      bitcnt = 0;
      if (pos + 4 > dataLen) throw truncated('stored 块缺少 LEN/NLEN');
      const len = data[pos] | (data[pos + 1] << 8);
      const nlen = data[pos + 2] | (data[pos + 3] << 8);
      pos += 4;
      if ((len ^ 0xffff) !== nlen) throw fail('stored 块的 LEN/NLEN 校验不匹配');
      if (pos + len > dataLen) throw truncated(`stored 块声明 ${len} 字节但输入不足`);
      ensure(len);
      out.set(data.subarray(pos, pos + len), outLen);
      outLen += len;
      pos += len;
      continue;
    }

    if (blockType === 3) throw fail('遇到保留的块类型 BTYPE=3');

    /* -------- 选择 Huffman 表 -------- */
    let litTable;
    let distTable;
    if (blockType === 1) {
      const fixed = getFixedTables();
      litTable = fixed.lit;
      distTable = fixed.dist;
    } else {
      // -------- BTYPE=2：dynamic（动态 Huffman） --------
      const hlit = readBits(5) + 257;
      const hdist = readBits(5) + 1;
      const hclen = readBits(4) + 4;
      const clLengths = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) clLengths[CL_ORDER[i]] = readBits(3);
      const clCanonical = buildCanonical(clLengths, 19);

      const total = hlit + hdist;
      const allLengths = new Uint8Array(total);
      let i = 0;
      while (i < total) {
        const sym = readCodeSlow(clCanonical);
        if (sym < 16) {
          allLengths[i++] = sym;
        } else if (sym === 16) {
          if (i === 0) throw fail('动态头用 16 号符号重复码长，但前面没有可重复的码长');
          const prev = allLengths[i - 1];
          const repeat = 3 + readBits(2);
          if (i + repeat > total) throw fail('动态头重复码长超出声明长度');
          for (let k = 0; k < repeat; k++) allLengths[i++] = prev;
        } else if (sym === 17) {
          const repeat = 3 + readBits(3);
          if (i + repeat > total) throw fail('动态头零重复（17）超出声明长度');
          i += repeat; // 默认 0，无需写入
        } else if (sym === 18) {
          const repeat = 11 + readBits(7);
          if (i + repeat > total) throw fail('动态头零重复（18）超出声明长度');
          i += repeat;
        } else {
          throw fail(`动态头出现非法码长符号 ${sym}`);
        }
      }
      litTable = buildFastTable(allLengths.subarray(0, hlit), hlit, 'literal/length');
      distTable = buildFastTable(allLengths.subarray(hlit, total), hdist, 'distance');
    }

    /* -------- 解码块内的符号（查表快路径） -------- */
    const litLens = litTable.lens;
    const litMask = litTable.mask;
    const litMax = litTable.maxBits;
    const litSymbols = litTable.table;
    const distLens = distTable.lens;
    const distMask = distTable.mask;
    const distMax = distTable.maxBits;
    const distSymbols = distTable.table;

    for (;;) {
      // 一次预留 258 字节（最长匹配长度），避免每个符号都调用 ensure
      if (out.length - outLen < 258) ensure(258);

      while (bitcnt < litMax && pos < dataLen) {
        bitbuf |= data[pos++] << bitcnt;
        bitcnt += 8;
      }
      let index = bitbuf & litMask;
      let codeLen = litLens[index];
      if (codeLen === 0 || codeLen > bitcnt) {
        // 输入已耗尽（最多只剩位缓冲里的 2 字节）时归入「截断」，让 Z_SYNC_FLUSH 容错路径能救回部分数据
        if (pos >= dataLen - 2) throw truncated('literal/length 码在输入末尾被切断');
        throw fail('literal/length Huffman 码无效（数据损坏）');
      }
      bitbuf >>>= codeLen;
      bitcnt -= codeLen;
      const symbol = litSymbols[index];

      if (symbol < 256) {
        out[outLen++] = symbol;
        continue;
      }
      if (symbol === 256) break; // 块结束

      const lengthIndex = symbol - 257;
      if (lengthIndex >= 29) throw fail(`出现非法长度符号 ${symbol}`);
      let length = LENGTH_BASE[lengthIndex];
      const lengthExtra = LENGTH_EXTRA[lengthIndex];
      if (lengthExtra) length += readBits(lengthExtra);

      while (bitcnt < distMax && pos < dataLen) {
        bitbuf |= data[pos++] << bitcnt;
        bitcnt += 8;
      }
      index = bitbuf & distMask;
      codeLen = distLens[index];
      if (codeLen === 0 || codeLen > bitcnt) {
        if (pos >= dataLen - 2) throw truncated('distance 码在输入末尾被切断');
        throw fail('distance Huffman 码无效（数据损坏）');
      }
      bitbuf >>>= codeLen;
      bitcnt -= codeLen;
      const distSymbol = distSymbols[index];
      if (distSymbol >= 30) throw fail(`出现非法距离符号 ${distSymbol}`);
      let distance = DIST_BASE[distSymbol];
      const distExtra = DIST_EXTRA[distSymbol];
      if (distExtra) distance += readBits(distExtra);

      if (distance > outLen) {
        if (pos >= dataLen - 2) throw truncated(`回溯距离 ${distance} 超出已输出数据（输入末尾）`);
        throw fail(
          dictHint
            ? `回溯距离 ${distance} 超出已输出数据 ${outLen} 字节（该流使用预设字典 FDICT，本垫片不支持预设字典）`
            : `回溯距离 ${distance} 超出已输出数据 ${outLen} 字节（数据损坏）`
        );
      }

      if (out.length - outLen < length) ensure(length);
      const src = outLen - distance;
      if (distance >= length) {
        out.copyWithin(outLen, src, src + length);
      } else {
        // 重叠复制：距离 < 长度时必须逐段「加倍」复制，等价于逐字节复制
        out.copyWithin(outLen, src, src + distance);
        let copied = distance;
        while (copied < length) {
          const n = Math.min(copied, length - copied);
          out.copyWithin(outLen + copied, outLen, outLen + n);
          copied += n;
        }
      }
      outLen += length;
    }
  } while (!isFinal);

  // 流结束后，未消费的整字节属于后续数据（zlib 的 Adler-32）
  const adlerStart = pos - (bitcnt >>> 3);
  return { bytes: partialView(), adlerStart };
}

/* --------------------------- zlib 容器 --------------------------- */

const ADLER_MOD = 65521;

/** 计算 Adler-32 校验和 */
export function adler32(bytes, length = bytes.length) {
  let a = 1;
  let b = 0;
  let i = 0;
  while (i < length) {
    const stop = Math.min(i + 5552, length);
    for (; i < stop; i++) {
      a += bytes[i];
      b += a;
    }
    a %= ADLER_MOD;
    b %= ADLER_MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (isArrayBuffer(input)) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input === 'string') return fromString(input, 'utf8');
  throw new TypeError('inflateSync / inflateRawSync 需要 Uint8Array / Buffer / ArrayBuffer 输入');
}

/** finishFlush=Z_SYNC_FLUSH 时容忍被截断的流（PDF 里很常见），返回已解出的部分数据 */
function isTolerant(options) {
  return Boolean(options) && options.finishFlush === 2 /* Z_SYNC_FLUSH */;
}

function decodeRaw(data, tolerant, dictHint) {
  try {
    return inflateRawCore(data, dictHint);
  } catch (err) {
    if (tolerant && err && err.truncated && err.partial) {
      return { bytes: err.partial, adlerStart: -1, truncated: true };
    }
    throw err;
  }
}

/**
 * 裸 DEFLATE 解压（无 zlib 头，ZIP 条目 / PDF 无头流用的就是这种）。
 * @param {Uint8Array} data
 * @param {{finishFlush?:number}} [options]
 * @returns {ShimBuffer}
 */
export function inflateRawSync(data, options) {
  const bytes = toBytes(data);
  return decodeRaw(bytes, isTolerant(options), false).bytes;
}

/**
 * zlib 容器格式解压（RFC 1950）：
 *   校验并跳过 2 字节 CMF/FLG 头（FDICT 时再跳过 4 字节字典 ID），
 *   解 DEFLATE，然后校验 4 字节大端 Adler-32。
 * @param {Uint8Array} data
 * @param {{finishFlush?:number}} [options] finishFlush=Z_SYNC_FLUSH 时容忍截断
 * @returns {ShimBuffer}
 */
export function inflateSync(data, options) {
  const bytes = toBytes(data);
  const tolerant = isTolerant(options);
  if (bytes.length < 2) throw new Error('zlib 数据太短：至少需要 2 字节的 CMF/FLG 头');

  const cmf = bytes[0];
  const flg = bytes[1];
  if ((cmf & 0x0f) !== 8) {
    throw new Error(`zlib 头不支持：CM=${cmf & 0x0f}（仅支持 8=deflate）`);
  }
  if (cmf >> 4 > 7) {
    throw new Error(`zlib 头 CINFO=${cmf >> 4} 超出范围（窗口大小最大 32K）`);
  }
  if (((cmf << 8) + flg) % 31 !== 0) {
    throw new Error('zlib 头校验失败：CMF/FLG 组合不合法（数据可能损坏）');
  }

  const hasDict = (flg & 0x20) !== 0;
  let headerLen = 2;
  if (hasDict) {
    if (bytes.length < 6) throw new Error('zlib 流声明了预设字典（FDICT）但缺少 4 字节字典 ID');
    headerLen = 6; // 跳过 DICTID；本垫片不支持真正的预设字典
  }

  const result = decodeRaw(bytes.subarray(headerLen), tolerant, hasDict);
  if (result.truncated) return result.bytes;

  const adlerStart = headerLen + result.adlerStart;
  if (adlerStart + 4 <= bytes.length) {
    const expected =
      ((bytes[adlerStart] << 24) |
        (bytes[adlerStart + 1] << 16) |
        (bytes[adlerStart + 2] << 8) |
        bytes[adlerStart + 3]) >>>
      0;
    const actual = adler32(result.bytes, result.bytes.length);
    if (expected !== actual) {
      if (tolerant) return result.bytes;
      throw new Error(
        `zlib Adler-32 校验失败：流中为 0x${expected.toString(16)}，实际计算为 0x${actual.toString(16)}（数据被篡改或截断）`
      );
    }
  } else if (!tolerant) {
    throw new Error('zlib 流缺少 4 字节 Adler-32 校验值（数据被截断）');
  }

  return result.bytes;
}

/* ================================================================== *
 * 四、zlib 常量与命名空间
 * ================================================================== */

/** 与 node:zlib 的 constants 取值一致（消费方常用 Z_SYNC_FLUSH / Z_FIXED 等） */
export const zlibConstants = Object.freeze({
  // flush 模式
  Z_NO_FLUSH: 0,
  Z_PARTIAL_FLUSH: 1,
  Z_SYNC_FLUSH: 2,
  Z_FULL_FLUSH: 3,
  Z_FINISH: 4,
  Z_BLOCK: 5,
  Z_TREES: 6,
  // 返回码
  Z_OK: 0,
  Z_STREAM_END: 1,
  Z_NEED_DICT: 2,
  Z_ERRNO: -1,
  Z_STREAM_ERROR: -2,
  Z_DATA_ERROR: -3,
  Z_MEM_ERROR: -4,
  Z_BUF_ERROR: -5,
  Z_VERSION_ERROR: -6,
  // 压缩级别
  Z_NO_COMPRESSION: 0,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1,
  // 策略
  Z_FILTERED: 1,
  Z_HUFFMAN_ONLY: 2,
  Z_RLE: 3,
  Z_FIXED: 4,
  Z_DEFAULT_STRATEGY: 0,
  // 数据类型
  Z_BINARY: 0,
  Z_TEXT: 1,
  Z_ASCII: 1,
  Z_UNKNOWN: 2,
  // 压缩方法
  Z_DEFLATED: 8,
});

/** `import { zlib } from './browser-shim.js'` 后即可像用 node:zlib 一样使用 */
export const zlib = {
  inflateSync,
  inflateRawSync,
  constants: zlibConstants,
};

/** 同时把 Buffer 作为命名导出（`import { Buffer } from './browser-shim.js'`） */
export { ShimBuffer as Buffer };

export default {
  Buffer: ShimBuffer,
  ShimBuffer,
  zlib,
  inflateSync,
  inflateRawSync,
  constants: zlibConstants,
};
