/**
 * browser-shim 测试
 *
 * 核心思路：用 Node 的 node:zlib 生成压缩数据，用垫片解压，逐字节比对；
 * Buffer 部分则与 Node 原生 Buffer 逐操作对拍。
 *
 * 运行：node --test test/browser-shim.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, deflateRawSync, constants as nodeZlibConstants } from 'node:zlib';
import { Buffer as NodeBuffer } from 'node:buffer';

import {
  Buffer as ShimBuffer,
  ShimBuffer as ShimBufferClass,
  inflateSync,
  inflateRawSync,
  zlib,
  zlibConstants,
  adler32,
} from '../public/js/browser-shim.js';

/* ============================ 测试工具 ============================ */

/** 断言两个字节序列完全一致（以 node:buffer 的 Buffer.compare 作为参照） */
function sameBytes(actual, expected, message = 'bytes') {
  assert.ok(actual instanceof Uint8Array, `${message}：结果应为 Uint8Array`);
  assert.strictEqual(NodeBuffer.compare(actual, expected), 0, `${message}：字节内容不一致`);
  assert.strictEqual(actual.length, expected.length, `${message}：长度不一致`);
}

/** 断言回调抛出 Error，且信息是可读中文 */
function assertChineseError(fn, label) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, `${label}：应抛出 Error`);
    assert.ok(typeof err.message === 'string' && err.message.length > 0, `${label}：错误信息不能为空`);
    assert.ok(/[\u4e00-\u9fa5]/.test(err.message), `${label}：错误信息应为可读中文，实际是「${err.message}」`);
    return true;
  }, label);
}

/** mulberry32：固定种子的伪随机，保证测试可复现 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pseudoRandomBytes(size, seed) {
  const random = mulberry32(seed);
  const out = NodeBuffer.alloc(size);
  for (let i = 0; i < size; i++) out[i] = Math.floor(random() * 256) & 0xff;
  return out;
}

const PAYLOADS = {
  empty: NodeBuffer.alloc(0),
  single: NodeBuffer.from([0x42]),
  ascii: NodeBuffer.from('The quick brown fox jumps over the lazy dog. '.repeat(60), 'utf8'),
  chinese: NodeBuffer.from(
    '用户协议与隐私政策：我们可能会收集您的个人信息，包括设备标识符、位置信息与使用记录。'.repeat(40),
    'utf8'
  ),
  binary: pseudoRandomBytes(8192, 0xc0ffee),
};

/* ================================================================== *
 * 一、inflate：与 node:zlib 逐字节对拍
 * ================================================================== */

test('1. inflateSync：node:zlib deflateSync 的数据能逐字节还原', () => {
  for (const [name, payload] of Object.entries(PAYLOADS)) {
    const compressed = deflateSync(payload);
    sameBytes(inflateSync(compressed), payload, `inflateSync/${name}`);
  }
});

test('2. inflateRawSync：node:zlib deflateRawSync 的数据能逐字节还原', () => {
  for (const [name, payload] of Object.entries(PAYLOADS)) {
    const compressed = deflateRawSync(payload);
    sameBytes(inflateRawSync(compressed), payload, `inflateRawSync/${name}`);
  }
});

test('3. 空输入 / 单字节 / ASCII / 中文 UTF-8 / 固定种子随机二进制', () => {
  // 空输入
  sameBytes(inflateSync(deflateSync(NodeBuffer.alloc(0))), NodeBuffer.alloc(0), 'empty');
  sameBytes(inflateRawSync(deflateRawSync(NodeBuffer.alloc(0))), NodeBuffer.alloc(0), 'empty-raw');
  // 单字节（0x00 与 0xff 两个极端）
  for (const byte of [0x00, 0x01, 0x7f, 0x80, 0xff]) {
    const one = NodeBuffer.from([byte]);
    sameBytes(inflateSync(deflateSync(one)), one, `single-${byte}`);
    sameBytes(inflateRawSync(deflateRawSync(one)), one, `single-raw-${byte}`);
  }
  // 纯 ASCII
  sameBytes(inflateSync(deflateSync(PAYLOADS.ascii)), PAYLOADS.ascii, 'ascii');
  // 中文 UTF-8：验证多字节字符被完整还原
  const chineseOut = inflateSync(deflateSync(PAYLOADS.chinese));
  sameBytes(chineseOut, PAYLOADS.chinese, 'chinese');
  assert.strictEqual(chineseOut.toString('utf8'), PAYLOADS.chinese.toString('utf8'));
  // 固定种子随机二进制：两次生成必须一致（可复现），且能往返
  const randomA = pseudoRandomBytes(64 * 1024, 20240918);
  const randomB = pseudoRandomBytes(64 * 1024, 20240918);
  sameBytes(randomA, randomB, '随机数可复现');
  sameBytes(inflateSync(deflateSync(randomA)), randomA, 'random-binary');
});

test('4. 大数据（≥1MB 且可压缩）：不爆栈、耗时可接受', () => {
  const big = NodeBuffer.from(
    ('协议阅读器：' + '本条款适用于您对本服务的使用，请仔细阅读。'.repeat(4) + '\n').repeat(9000),
    'utf8'
  );
  assert.ok(big.length >= 1024 * 1024, `样本应 ≥1MB，实际 ${big.length}`);

  const compressed = deflateSync(big, { level: 9 });
  const started = Date.now();
  const out = inflateSync(compressed);
  const elapsed = Date.now() - started;

  sameBytes(out, big, 'large-1MB');
  assert.ok(elapsed < 20000, `解压 1MB 数据耗时过长：${elapsed}ms`);
});

test('5. 高压缩比与几乎不可压缩的数据都要过', () => {
  // 极高压缩比：30 万个相同字节
  const repetitive = NodeBuffer.alloc(300000, 0x61);
  const highRatio = deflateSync(repetitive, { level: 9 });
  assert.ok(highRatio.length < repetitive.length / 100, '重复数据的压缩比应极高');
  sameBytes(inflateSync(highRatio), repetitive, 'high-ratio');

  // 几乎不可压缩：固定种子随机数据
  const random = pseudoRandomBytes(300000, 0xbadc0de);
  const incompressible = deflateSync(random, { level: 6 });
  sameBytes(inflateSync(incompressible), random, 'incompressible');
  sameBytes(inflateRawSync(deflateRawSync(random, { level: 9 })), random, 'incompressible-raw');
});

test('6. 压缩级别 0–9 全部支持（level 0 走 stored 块 / BTYPE=0）', () => {
  const payload = NodeBuffer.from('Level test 中文 abcdefghijklmnopqrstuvwxyz '.repeat(4000), 'utf8');
  for (let level = 0; level <= 9; level++) {
    sameBytes(inflateSync(deflateSync(payload, { level })), payload, `zlib-level-${level}`);
    sameBytes(inflateRawSync(deflateRawSync(payload, { level })), payload, `raw-level-${level}`);
  }
  // level 0 不压缩，输出必然带 stored 块开销
  const stored = deflateSync(payload, { level: 0 });
  assert.ok(stored.length > payload.length, 'level 0 应产生未压缩的 stored 块');
  sameBytes(inflateSync(stored), payload, 'stored');
});

test('7. 不同 strategy 造出的块类型（默认 + Z_FIXED 等）都要能解', () => {
  const payload = NodeBuffer.from('The quick brown fox 中文 jumps over the lazy dog. '.repeat(3000), 'utf8');
  const strategies = [
    ['Z_DEFAULT_STRATEGY', nodeZlibConstants.Z_DEFAULT_STRATEGY],
    ['Z_FIXED', nodeZlibConstants.Z_FIXED], // 强制 fixed Huffman（BTYPE=1）
    ['Z_FILTERED', nodeZlibConstants.Z_FILTERED],
    ['Z_HUFFMAN_ONLY', nodeZlibConstants.Z_HUFFMAN_ONLY],
    ['Z_RLE', nodeZlibConstants.Z_RLE],
  ];
  for (const [name, strategy] of strategies) {
    sameBytes(inflateSync(deflateSync(payload, { strategy })), payload, `strategy/${name}`);
    sameBytes(inflateRawSync(deflateRawSync(payload, { strategy })), payload, `strategy-raw/${name}`);
  }
  // 小块 + Z_FIXED 是最容易被「固定码表」覆盖到的组合
  const tiny = NodeBuffer.from('fixed huffman block 中文', 'utf8');
  sameBytes(inflateSync(deflateSync(tiny, { strategy: nodeZlibConstants.Z_FIXED })), tiny, 'Z_FIXED-tiny');
});

test('8. zlib 头损坏 / 数据截断 / Adler-32 不匹配都抛可读中文 Error', () => {
  const payload = NodeBuffer.from('损坏测试 abcdefghijklmnopqrstuvwxyz '.repeat(2000), 'utf8');
  const good = deflateSync(payload, { level: 6 });

  // (a) 头太短
  assertChineseError(() => inflateSync(NodeBuffer.from([0x78])), 'zlib 头太短');
  // (b) CM 非 8
  assertChineseError(() => inflateSync(NodeBuffer.from([0x00, 0x00, 0x00, 0x00])), 'CM 非法');
  // (c) CMF/FLG 校验和不合法
  assertChineseError(() => inflateSync(NodeBuffer.from([0x78, 0x00])), '头校验失败');
  // (d) 中段截断（严格模式必须抛错，不能静默返回残缺数据）
  for (const fraction of [0.25, 0.5, 0.75]) {
    assertChineseError(() => inflateSync(good.subarray(0, Math.floor(good.length * fraction))), `截断@${fraction}`);
  }
  // (e) 恰好缺 Adler-32
  assertChineseError(() => inflateSync(good.subarray(0, good.length - 4)), '缺 Adler-32');
  // (f) Adler-32 被改坏
  const adlerBroken = NodeBuffer.from(good);
  adlerBroken[adlerBroken.length - 1] ^= 0xff;
  assertChineseError(() => inflateSync(adlerBroken), 'Adler-32 不匹配');
  // (g) 中段被翻位（数据损坏）
  const corrupted = NodeBuffer.from(good);
  for (let i = 4; i < Math.min(corrupted.length - 6, 40); i++) corrupted[i] ^= 0xa5;
  assertChineseError(() => inflateSync(corrupted), '数据损坏');
});

test('8b. finishFlush=Z_SYNC_FLUSH 时容忍截断（PDF 常见的残流场景）', () => {
  const payload = NodeBuffer.from('Sync flush 容错 中文 '.repeat(50000), 'utf8');
  const compressed = deflateSync(payload, { level: 6 });
  const options = { finishFlush: zlibConstants.Z_SYNC_FLUSH };

  // 只缺 Adler-32 时，容错模式应返回完整数据
  sameBytes(inflateSync(compressed.subarray(0, compressed.length - 4), options), payload, 'tolerant-missing-adler');

  // 压缩流被砍掉一部分时，容错模式应返回「正确的前缀」，而不是抛错
  for (const fraction of [0.3, 0.5, 0.7, 0.9]) {
    const partial = inflateSync(compressed.subarray(0, Math.floor(compressed.length * fraction)), options);
    assert.ok(partial.length > 0, `容错模式应返回部分数据（fraction=${fraction}）`);
    assert.ok(partial.length <= payload.length, '部分数据不应超过原始长度');
    sameBytes(partial, payload.subarray(0, partial.length), `tolerant-prefix@${fraction}`);
  }

  // 严格模式对照：同一个截断流必须抛错
  assertChineseError(() => inflateSync(compressed.subarray(0, Math.floor(compressed.length * 0.5))), '严格模式截断');
});

test('8c. zlib 命名空间与常量对齐 node:zlib', () => {
  assert.strictEqual(zlib.inflateSync, inflateSync);
  assert.strictEqual(zlib.inflateRawSync, inflateRawSync);
  assert.strictEqual(zlib.constants, zlibConstants);
  assert.strictEqual(zlibConstants.Z_SYNC_FLUSH, nodeZlibConstants.Z_SYNC_FLUSH);
  assert.strictEqual(zlibConstants.Z_FIXED, nodeZlibConstants.Z_FIXED);
  assert.strictEqual(zlibConstants.Z_DEFAULT_STRATEGY, nodeZlibConstants.Z_DEFAULT_STRATEGY);
  // node:zlib 不导出 Z_DEFLATED，但规范值是 8
  assert.strictEqual(zlibConstants.Z_DEFLATED, 8);
  // 可用 zlib.xxx 的调用风格
  const payload = NodeBuffer.from('namespace 调用风格', 'utf8');
  sameBytes(zlib.inflateSync(deflateSync(payload)), payload, 'zlib namespace');
});

/* ================================================================== *
 * 二、Buffer：与 Node 原生 Buffer 对拍
 * ================================================================== */

test('9. from/toString 的 utf8 往返（含中文）', () => {
  const text = '中文协议 reader – 隐私政策 & 条款';
  sameBytes(ShimBuffer.from(text), NodeBuffer.from(text, 'utf8'), 'from utf8');
  sameBytes(ShimBuffer.from(text, 'utf8'), NodeBuffer.from(text, 'utf8'), 'from utf8 explicit');
  assert.strictEqual(ShimBuffer.from(text).toString('utf8'), text);
  assert.strictEqual(ShimBuffer.from(text).toString(), text); // 默认 utf8
  assert.strictEqual(ShimBuffer.from(text).toString('utf-8'), text); // 别名
});

test('10. hex 编解码与 Node 一致', () => {
  for (const hex of ['', '00', 'deadbeef', '00ff10ab', '5Lit5paH']) {
    sameBytes(ShimBuffer.from(hex, 'hex'), NodeBuffer.from(hex, 'hex'), `from hex(${hex})`);
    const bytes = NodeBuffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
    assert.strictEqual(ShimBuffer.from(bytes).toString('hex'), bytes.toString('hex'), `to hex(${hex})`);
  }
  // 奇数长度 / 非法字符：与 Node 一样「截断」而不是抛错
  for (const weird of ['abc', '6162zz63', 'zz', 'a1b2c3']) {
    sameBytes(ShimBuffer.from(weird, 'hex'), NodeBuffer.from(weird, 'hex'), `from hex weird(${weird})`);
  }
});

test('11. base64 编解码与 Node 一致', () => {
  const payloads = [
    '',
    'aGVsbG8=',
    'aGVsbG8g5Lit5paH',
    'AAECAwQFBgcICQ==',
    '/w==',
    '5Lit5paH5rWL6K+V',
  ];
  for (const b64 of payloads) {
    sameBytes(ShimBuffer.from(b64, 'base64'), NodeBuffer.from(b64, 'base64'), `from base64(${b64})`);
    const bytes = NodeBuffer.from(b64, 'base64');
    assert.strictEqual(ShimBuffer.from(bytes).toString('base64'), bytes.toString('base64'), `to base64(${b64})`);
  }
  // 非法字符 / 空白 / base64url
  for (const b64 of ['aGVs bG8=!!', 'aGVsbG8', 'a-b_', 'aGVsbG8=']) {
    sameBytes(ShimBuffer.from(b64, 'base64'), NodeBuffer.from(b64, 'base64'), `from base64 weird(${b64})`);
  }
  // 与 Node 的 base64url 行为对齐
  sameBytes(ShimBuffer.from('a-b_', 'base64url'), NodeBuffer.from('a-b_', 'base64url'), 'base64url');
});

test('12. latin1 往返（>0x7F 的字节）', () => {
  const bytes = [0x00, 0x41, 0x7f, 0x80, 0x9f, 0xe9, 0xfe, 0xff];
  sameBytes(ShimBuffer.from(bytes), NodeBuffer.from(bytes), 'from array');
  assert.strictEqual(ShimBuffer.from(bytes).toString('latin1'), NodeBuffer.from(bytes).toString('latin1'));
  assert.strictEqual(ShimBuffer.from(bytes).toString('binary'), NodeBuffer.from(bytes).toString('binary'));
  const text = 'Aéÿ\u0080\u00ff';
  sameBytes(ShimBuffer.from(text, 'latin1'), NodeBuffer.from(text, 'latin1'), 'from latin1');
  assert.strictEqual(ShimBuffer.from(text, 'latin1').toString('latin1'), text);
});

test('13. readUInt8/16LE/32LE、readBigUInt64LE 与 Node 逐一对比', () => {
  const raw = NodeBuffer.from([
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
    0xff, 0xfe, 0xfd, 0xfc, 0x11, 0x22, 0x33, 0x44,
  ]);
  const node = NodeBuffer.from(raw);
  const shim = ShimBuffer.from(raw);
  const readers = [
    ['readUInt8', 1],
    ['readUInt16LE', 2],
    ['readUInt16BE', 2],
    ['readUInt32LE', 4],
    ['readUInt32BE', 4],
    ['readInt8', 1],
    ['readInt16LE', 2],
    ['readInt32LE', 4],
  ];
  for (const [method, width] of readers) {
    for (let offset = 0; offset + width <= raw.length; offset++) {
      assert.strictEqual(shim[method](offset), node[method](offset), `${method}@${offset}`);
    }
  }
  for (const offset of [0, 4, 8]) {
    assert.strictEqual(shim.readBigUInt64LE(offset), node.readBigUInt64LE(offset), `readBigUInt64LE@${offset}`);
    assert.strictEqual(typeof shim.readBigUInt64LE(offset), 'bigint');
  }
  assert.strictEqual(shim.readBigUInt64BE(0), node.readBigUInt64BE(0), 'readBigUInt64BE@0');
  // 真实 PDF 头部签名场景
  const pdfLike = ShimBuffer.from('%PDF-1.7\n%âãÏÓ\n', 'latin1');
  assert.strictEqual(pdfLike.readUInt32BE(0), NodeBuffer.from('%PDF-1.7\n').readUInt32BE(0));
});

test('14. alloc 零填充 / alloc(n, fill) 正确填充', () => {
  sameBytes(ShimBuffer.alloc(16), NodeBuffer.alloc(16), 'alloc-zero');
  assert.ok(ShimBuffer.alloc(64).every((b) => b === 0), 'alloc 必须零填充');
  sameBytes(ShimBuffer.alloc(6, 0xff), NodeBuffer.alloc(6, 0xff), 'alloc-fill-byte');
  sameBytes(ShimBuffer.alloc(7, 0), NodeBuffer.alloc(7, 0), 'alloc-fill-zero');
  sameBytes(ShimBuffer.alloc(7, 'ab'), NodeBuffer.alloc(7, 'ab'), 'alloc-fill-string');
  sameBytes(ShimBuffer.alloc(0), NodeBuffer.alloc(0), 'alloc-empty');
});

test('15. concat 多段拼接正确', () => {
  const chunks = [
    ShimBuffer.from([1, 2, 3]),
    ShimBuffer.from('中文'),
    new Uint8Array([9, 9]),
    NodeBuffer.from('tail'),
  ];
  const nodeChunks = chunks.map((c) => NodeBuffer.from(c));
  sameBytes(ShimBuffer.concat(chunks), NodeBuffer.concat(nodeChunks), 'concat');
  sameBytes(ShimBuffer.concat([]), NodeBuffer.concat([]), 'concat-empty');
  sameBytes(ShimBuffer.concat(chunks, 5), NodeBuffer.concat(nodeChunks, 5), 'concat-totalLength');
  sameBytes(ShimBuffer.concat([ShimBuffer.alloc(0), ShimBuffer.from([7])]), NodeBuffer.from([7]), 'concat-zero-chunk');
});

test('16. slice / subarray 是共享内存的视图（不是拷贝）', () => {
  const src = ShimBuffer.from([1, 2, 3, 4, 5]);
  const sub = src.subarray(1, 4);
  const sl = src.slice(1, 4);

  assert.strictEqual(sub.buffer, src.buffer, 'subarray 应共享底层 ArrayBuffer');
  assert.strictEqual(sl.buffer, src.buffer, 'slice 应共享底层 ArrayBuffer');
  assert.strictEqual(sub.byteOffset, src.byteOffset + 1);

  sub[0] = 99;
  assert.strictEqual(src[1], 99, 'subarray 的修改应反映到原 buffer');
  sl[1] = 77;
  assert.strictEqual(src[2], 77, 'slice 的修改应反映到原 buffer');
  src[3] = 55;
  assert.strictEqual(sub[2], 55, '原 buffer 的修改应反映到视图');

  // 与 Node 的切片结果对拍（含负索引）—— 用未被改动的副本，避免受上面的写入影响
  const parityNode = NodeBuffer.from([1, 2, 3, 4, 5]);
  const parityShim = ShimBuffer.from(parityNode);
  sameBytes(parityShim.slice(0, 2), parityNode.slice(0, 2), 'slice 0..2');
  sameBytes(parityShim.slice(-3, -1), parityNode.slice(-3, -1), 'slice 负索引');
  sameBytes(parityShim.subarray(-2), parityNode.subarray(-2), 'subarray 负索引');
  sameBytes(parityShim.slice(1, 99), parityNode.slice(1, 99), 'slice 越界夹紧');
  sameBytes(parityShim.subarray(3, 1), parityNode.subarray(3, 1), 'subarray 逆序区间');
});

test('17. indexOf 支持数字与子数组（Buffer）两种用法', () => {
  const node = NodeBuffer.from('abcabc中文abc');
  const shim = ShimBuffer.from(node);
  assert.strictEqual(shim.indexOf(0x61), node.indexOf(0x61), 'indexOf 数字');
  assert.strictEqual(shim.indexOf(0x7a), node.indexOf(0x7a), 'indexOf 不存在的数字');
  assert.strictEqual(shim.indexOf('bc'), node.indexOf('bc'), 'indexOf 字符串');
  assert.strictEqual(shim.indexOf('bc', 3), node.indexOf('bc', 3), 'indexOf 字符串 + offset');
  assert.strictEqual(shim.indexOf('bc', -5), node.indexOf('bc', -5), 'indexOf 字符串 + 负 offset');
  assert.strictEqual(shim.indexOf(''), node.indexOf(''), 'indexOf 空串');
  assert.strictEqual(shim.indexOf('', 99), node.indexOf('', 99), 'indexOf 空串越界 offset');
  sameBytesNeedle(shim, node, ShimBuffer.from('中文'), NodeBuffer.from('中文'));
  sameBytesNeedle(shim, node, ShimBuffer.from([0x61, 0x62, 0x63]), NodeBuffer.from([0x61, 0x62, 0x63]));

  const hay = ShimBuffer.from([1, 2, 3, 4, 5, 1, 2]);
  const nodeHay = NodeBuffer.from([1, 2, 3, 4, 5, 1, 2]);
  assert.strictEqual(hay.indexOf(ShimBuffer.from([1, 2])), nodeHay.indexOf(NodeBuffer.from([1, 2])));
  assert.strictEqual(hay.indexOf(ShimBuffer.from([1, 2]), 1), nodeHay.indexOf(NodeBuffer.from([1, 2]), 1));
  assert.strictEqual(hay.indexOf(ShimBuffer.from([9, 9])), nodeHay.indexOf(NodeBuffer.from([9, 9])));
});

function sameBytesNeedle(shim, node, shimNeedle, nodeNeedle) {
  assert.strictEqual(
    shim.indexOf(shimNeedle),
    node.indexOf(nodeNeedle),
    `indexOf 子数组(${Array.from(shimNeedle).join(',')})`
  );
}

test('18. includes / fill / copy / equals 与 Node 对拍', () => {
  // includes
  const node = NodeBuffer.from([1, 2, 3, 4, 5]);
  const shim = ShimBuffer.from(node);
  assert.strictEqual(shim.includes(3), node.includes(3));
  assert.strictEqual(shim.includes(9), node.includes(9));
  assert.strictEqual(shim.includes(1, 1), node.includes(1, 1));
  assert.strictEqual(shim.includes(ShimBuffer.from([4, 5])), node.includes(NodeBuffer.from([4, 5])));

  // fill（返回 this）
  const fillShim = ShimBuffer.alloc(8);
  assert.strictEqual(fillShim.fill(7, 2, 5), fillShim, 'fill 应返回 this');
  sameBytes(fillShim, NodeBuffer.alloc(8).fill(7, 2, 5), 'fill-number');
  sameBytes(ShimBuffer.alloc(5).fill('ab'), NodeBuffer.alloc(5).fill('ab'), 'fill-string');
  sameBytes(
    ShimBuffer.alloc(7).fill(ShimBuffer.from([1, 2])),
    NodeBuffer.alloc(7).fill(NodeBuffer.from([1, 2])),
    'fill-buffer'
  );
  sameBytes(ShimBuffer.alloc(4).fill(0), NodeBuffer.alloc(4).fill(0), 'fill-zero');

  // copy
  const targetShim = ShimBuffer.alloc(8);
  const targetNode = NodeBuffer.alloc(8);
  const sourceShim = ShimBuffer.from([10, 20, 30, 40, 50]);
  const sourceNode = NodeBuffer.from([10, 20, 30, 40, 50]);
  assert.strictEqual(
    sourceShim.copy(targetShim, 2, 1, 4),
    sourceNode.copy(targetNode, 2, 1, 4),
    'copy 返回值'
  );
  sameBytes(targetShim, targetNode, 'copy 结果');
  assert.strictEqual(sourceShim.copy(ShimBuffer.alloc(2), 0), sourceNode.copy(NodeBuffer.alloc(2), 0), 'copy 无 sourceEnd');
  // 重叠 copy（memmove 语义）
  const overlapShim = ShimBuffer.from([1, 2, 3, 4, 5]);
  const overlapNode = NodeBuffer.from([1, 2, 3, 4, 5]);
  overlapShim.copy(overlapShim, 1, 0, 4);
  overlapNode.copy(overlapNode, 1, 0, 4);
  sameBytes(overlapShim, overlapNode, 'copy 重叠');

  // equals
  assert.strictEqual(ShimBuffer.from([1, 2]).equals(ShimBuffer.from([1, 2])), true);
  assert.strictEqual(ShimBuffer.from([1, 2]).equals(ShimBuffer.from([1, 3])), false);
  assert.strictEqual(ShimBuffer.from([1, 2]).equals(NodeBuffer.from([1, 2])), true);
  assert.strictEqual(ShimBuffer.from([1, 2]).equals(new Uint8Array([1, 2])), true);
  assert.strictEqual(ShimBuffer.from([1, 2]).equals(ShimBuffer.from([1, 2, 3])), false);
  assert.strictEqual(ShimBuffer.from([1, 2]).equals('nope'), false);
});

test('19. 越界读取抛 Error，绝不静默返回 undefined/NaN', () => {
  const shim = ShimBuffer.from([0x01, 0x02, 0x03, 0x04]);
  const outOfRange = [
    () => shim.readUInt8(4),
    () => shim.readUInt8(-1),
    () => shim.readUInt16LE(3),
    () => shim.readUInt32LE(1),
    () => shim.readBigUInt64LE(0),
    () => shim.readUInt32LE(99),
  ];
  for (const fn of outOfRange) {
    assert.throws(fn, (err) => {
      assert.ok(err instanceof Error, '越界必须抛 Error');
      assert.ok(!Number.isNaN(err.message.length));
      return true;
    });
  }
  // 空 buffer 的默认读取也要抛
  assert.throws(() => ShimBuffer.alloc(0).readUInt8(0), Error);
  // 越界时不能返回 undefined / NaN
  try {
    const value = shim.readUInt32LE(99);
    assert.fail(`越界读取不应返回值，实际得到 ${value}`);
  } catch (err) {
    assert.ok(err instanceof Error);
    assert.ok(/[\u4e00-\u9fa5]/.test(err.message), '越界错误信息应为可读中文');
  }
});

test('20. isBuffer', () => {
  assert.strictEqual(ShimBuffer.isBuffer(ShimBuffer.from('x')), true);
  assert.strictEqual(ShimBuffer.isBuffer(ShimBuffer.alloc(0)), true);
  assert.strictEqual(ShimBuffer.isBuffer(new Uint8Array(2)), false);
  assert.strictEqual(ShimBuffer.isBuffer(new ArrayBuffer(2)), false);
  assert.strictEqual(ShimBuffer.isBuffer([]), false);
  assert.strictEqual(ShimBuffer.isBuffer('abc'), false);
  assert.strictEqual(ShimBuffer.isBuffer(null), false);
  // 与 Node 原生 Buffer 互操作
  assert.strictEqual(ShimBuffer.isBuffer(NodeBuffer.from('x')), true);
  assert.strictEqual(ShimBufferClass, ShimBuffer);
});

test('21. 与真实 Buffer 对拍：同一批二进制数据跑同一批操作', () => {
  const fixtures = [
    NodeBuffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]), // ZIP 本地头
    NodeBuffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1'),
    NodeBuffer.from('中文内容 mixed 12345', 'utf8'),
    pseudoRandomBytes(1024, 7),
  ];
  for (const [i, fixture] of fixtures.entries()) {
    const node = NodeBuffer.from(fixture);
    const shim = ShimBuffer.from(fixture);

    assert.strictEqual(shim.length, node.length, `fixture${i}: length`);
    assert.strictEqual(shim.readUInt8(0), node.readUInt8(0), `fixture${i}: readUInt8`);
    assert.strictEqual(shim.toString('hex'), node.toString('hex'), `fixture${i}: hex`);
    assert.strictEqual(shim.toString('base64'), node.toString('base64'), `fixture${i}: base64`);
    assert.strictEqual(shim.toString('latin1'), node.toString('latin1'), `fixture${i}: latin1`);
    assert.strictEqual(shim.toString('utf8'), node.toString('utf8'), `fixture${i}: utf8`);
    sameBytes(shim.subarray(1, -1), node.subarray(1, -1), `fixture${i}: subarray`);
    assert.strictEqual(shim.indexOf(shim[0]), node.indexOf(node[0]), `fixture${i}: indexOf`);
    assert.strictEqual(shim.includes(0x00), node.includes(0x00), `fixture${i}: includes`);

    // 二进制数据经 deflate 往返后仍完全一致（Buffer + zlib 联合对拍）
    sameBytes(inflateSync(deflateSync(fixture, { level: 6 })), node, `fixture${i}: zlib roundtrip`);

    // 用垫片 Buffer 做「整段复制」并确认与 Node 一致
    const copyShim = ShimBuffer.alloc(fixture.length).fill(0);
    shim.copy(copyShim);
    const copyNode = NodeBuffer.alloc(fixture.length).fill(0);
    node.copy(copyNode);
    sameBytes(copyShim, copyNode, `fixture${i}: copy full`);
  }

  // Buffer.from(arrayBuffer, offset, length) 共享内存，与 Node 行为一致
  const arrayBuffer = new ArrayBuffer(8);
  const view = ShimBuffer.from(arrayBuffer, 2, 4);
  view[0] = 0xab;
  assert.strictEqual(new Uint8Array(arrayBuffer)[2], 0xab, 'Buffer.from(ArrayBuffer) 应共享内存');
  assert.strictEqual(view.byteOffset, 2);
  // Buffer.from(Uint8Array) 是拷贝，与 Node 一致
  const source = new Uint8Array([1, 2, 3]);
  const copied = ShimBuffer.from(source);
  copied[0] = 9;
  assert.strictEqual(source[0], 1, 'Buffer.from(Uint8Array) 应为拷贝');

  // adler32 与 node:zlib 的校验值一致（用已知向量）
  assert.strictEqual(adler32(NodeBuffer.from('Wikipedia', 'utf8')), 0x11e60398);
});

/* ================================================================== *
 * 三、集成场景
 * ================================================================== */

test('22. 集成：模拟 ZIP 条目（deflateRaw + JSON）解压后 JSON.parse 成功', () => {
  const entry = {
    name: 'word/document.xml',
    chars: 12345,
    nested: { title: '用户隐私政策', tags: ['个人信息', '第三方共享', 'Cookie'] },
    body: '我们可能会将您的个人信息共享给关联公司。'.repeat(500),
    flags: [true, false, null],
  };
  const json = JSON.stringify(entry);
  const rawJson = NodeBuffer.from(json, 'utf8');

  // ZIP 里的条目是裸 DEFLATE（无 zlib 头）
  const compressed = deflateRawSync(rawJson, { level: 6 });
  const restored = inflateRawSync(compressed);

  sameBytes(restored, rawJson, 'zip-entry-bytes');
  assert.strictEqual(restored.toString('utf8'), json);
  assert.deepStrictEqual(JSON.parse(restored.toString('utf8')), entry);
  // 再用 zlib 容器格式走一遍，确保两个入口都能用于真实解析
  assert.deepStrictEqual(JSON.parse(inflateSync(deflateSync(rawJson)).toString('utf8')), entry);
});
