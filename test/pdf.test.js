/**
 * PDF 文本提取器的测试。
 *
 * 所有 PDF 都由代码现场构造（不依赖任何外部样本文件），覆盖：
 *  - 经典 xref 表的未压缩 PDF
 *  - FlateDecode 压缩内容流、过滤器链（ASCII85 + Flate）
 *  - ASCIIHexDecode / RunLengthDecode / LZWDecode
 *  - Type0 + Identity-H 双字节字体与 ToUnicode（bfchar / bfrange / bfrange 数组形式）
 *  - xref 流 + Predictor 12
 *  - 对象流 /Type /ObjStm
 *  - 文本重建（连字符断行、软换行合并、条款编号保留）
 *  - 垃圾输入、加密 PDF、meta 字段形状
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { extractPdfText } from '../src/extract/pdf.js';

// ---------------------------------------------------------------------------
// 构造 PDF 的小工具
// ---------------------------------------------------------------------------

function bin(s) {
  return Buffer.from(s, 'latin1');
}

function streamBody(dictStr, data) {
  return Buffer.concat([
    bin(`<< ${dictStr} /Length ${data.length} >>\nstream\n`),
    data,
    bin('\nendstream'),
  ]);
}

/** 经典 xref 表 PDF；objects 为对象 1..N 的正文（Buffer） */
function classicPdf(objects, opts = {}) {
  const { root = 1, version = '1.4', trailerExtra = '' } = opts;
  const chunks = [];
  let offset = 0;
  const header = bin(`%PDF-${version}\n%\u00e2\u00e3\u00cf\u00d3\n`);
  chunks.push(header);
  offset += header.length;
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const b = Buffer.concat([bin(`${i + 1} 0 obj\n`), body, bin('\nendobj\n')]);
    chunks.push(b);
    offset += b.length;
  });
  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += String(off).padStart(10, '0') + ' 00000 n \n';
  chunks.push(bin(xref));
  chunks.push(
    bin(
      `trailer\n<< /Size ${objects.length + 1} /Root ${root} 0 R ${trailerExtra} >>\n` +
        `startxref\n${xrefOffset}\n%%EOF\n`
    )
  );
  return Buffer.concat(chunks);
}

function simpleFontObj() {
  return bin('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
}

/** 生成一个单页 PDF；content 为内容流原始字节，filterDict 可加过滤器 */
function onePagePdf(content, opts = {}) {
  const filterDict = opts.filterDict || '';
  const fontObj = opts.fontObj || simpleFontObj();
  return classicPdf([
    bin('<< /Type /Catalog /Pages 2 0 R >>'),
    bin('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    bin(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
    ),
    streamBody(filterDict, content),
    fontObj,
  ]);
}

/** 生成一个多页 PDF；pages 为内容流原始字节数组 */
function multiPagePdf(pages) {
  const objects = [
    bin('<< /Type /Catalog /Pages 2 0 R >>'),
    bin(`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`),
  ];
  pages.forEach((page, i) => {
    const content = Buffer.isBuffer(page) ? page : page.data;
    const filter = Buffer.isBuffer(page) ? '' : page.filter || '';
    const pageNum = 3 + i * 2;
    const contentNum = pageNum + 1;
    objects.push(
      bin(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
          `/Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> /Contents ${contentNum} 0 R >>`
      )
    );
    objects.push(streamBody(filter, content));
  });
  objects.push(simpleFontObj());
  return classicPdf(objects);
}

// --- 各种过滤器的编码器（仅测试用） ---------------------------------------

function asciiHexEncode(data) {
  return bin(data.toString('hex').toUpperCase() + '>');
}

function ascii85Encode(data) {
  let out = '';
  for (let i = 0; i < data.length; i += 4) {
    const chunk = data.subarray(i, Math.min(i + 4, data.length));
    let tuple = 0;
    for (let k = 0; k < 4; k++) tuple = tuple * 256 + (k < chunk.length ? chunk[k] : 0);
    if (chunk.length === 4 && tuple === 0) {
      out += 'z';
      continue;
    }
    const chars = new Array(5);
    for (let k = 4; k >= 0; k--) {
      chars[k] = String.fromCharCode((tuple % 85) + 33);
      tuple = Math.floor(tuple / 85);
    }
    out += chars.join('').slice(0, chunk.length + 1);
  }
  return bin('<~' + out + '~>');
}

function runLengthEncode(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const n = Math.min(128, data.length - i);
    out.push(n - 1);
    for (let k = 0; k < n; k++) out.push(data[i + k]);
    i += n;
  }
  out.push(128);
  return Buffer.from(out);
}

/** 只输出字面量码，每 150 字节插入 ClearTable，保证码宽恒为 9 位 */
function lzwEncodeLiterals(data) {
  const codes = [];
  for (let i = 0; i < data.length; i++) {
    if (i > 0 && i % 150 === 0) codes.push(256);
    codes.push(data[i]);
  }
  codes.push(257);
  const bits = [];
  for (const c of codes) for (let b = 8; b >= 0; b--) bits.push((c >> b) & 1);
  const out = Buffer.alloc(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
  return out;
}

/** PNG Up 预测器编码（每行前置过滤器字节 2） */
function pngUpEncode(rows, rowLen) {
  const out = Buffer.alloc(rows.length * (rowLen + 1));
  let prev = Buffer.alloc(rowLen);
  rows.forEach((row, r) => {
    out[r * (rowLen + 1)] = 2;
    for (let x = 0; x < rowLen; x++) {
      out[r * (rowLen + 1) + 1 + x] = (row[x] - prev[x]) & 0xff;
    }
    prev = row;
  });
  return out;
}

// ---------------------------------------------------------------------------
// 1. 最基本的未压缩 PDF
// ---------------------------------------------------------------------------

test('未压缩 PDF：按顺序提取多行文本', async () => {
  const content = bin(
    [
      'BT',
      '/F1 12 Tf',
      '72 720 Td',
      '(This is the first clause of the agreement.) Tj',
      '0 -18 Td',
      '(This is the second clause of the agreement.) Tj',
      'ET',
    ].join('\n')
  );
  const res = await extractPdfText(onePagePdf(content));

  assert.equal(res.meta.extractor, 'pdf');
  assert.equal(res.meta.pageCount, 1);
  assert.equal(res.meta.pages.length, 1);
  assert.ok(res.text.includes('This is the first clause of the agreement.'));
  assert.ok(res.text.includes('This is the second clause of the agreement.'));
  assert.ok(
    res.text.indexOf('first clause') < res.text.indexOf('second clause'),
    '文本顺序应与内容流一致'
  );
  // 两行之间应保留换行
  assert.ok(/\n/.test(res.text));
});

test('TJ 数组中的大负值字距被识别为词间距', async () => {
  const content = bin('BT /F1 12 Tf 72 700 Td [(Hello) -350 (World)] TJ ET');
  const res = await extractPdfText(onePagePdf(content));
  assert.ok(res.text.includes('Hello World'), `实际输出: ${JSON.stringify(res.text)}`);
});

test('TJ 中的小字距不应插入空格', async () => {
  const content = bin('BT /F1 12 Tf 72 700 Td [(Hello) -20 (World)] TJ ET');
  const res = await extractPdfText(onePagePdf(content));
  assert.ok(res.text.includes('HelloWorld'), `实际输出: ${JSON.stringify(res.text)}`);
});

test('TL/T* 与引号算子产生换行', async () => {
  const content = bin(
    [
      'BT',
      '/F1 12 Tf',
      '16 TL',
      '72 700 Td',
      '(First quoted line) Tj',
      'T*',
      '(Second quoted line) Tj',
      'T*',
      "(Third quoted line) '",
      "(Fourth quoted line) '",
      'ET',
    ].join('\n')
  );
  const res = await extractPdfText(onePagePdf(content));
  assert.ok(res.text.includes('First quoted line'));
  assert.ok(res.text.includes('Second quoted line'));
  assert.ok(res.text.includes('Third quoted line'));
  assert.ok(res.text.includes('Fourth quoted line'));
  const idx = res.text.indexOf('Third quoted line');
  assert.ok(res.text.indexOf('Fourth quoted line') > idx);
  assert.ok(res.text.slice(idx).includes('\n'), 'T* / 引号算子应换行');
});

test('Tc / Tw / Tz 不会破坏文本提取', async () => {
  const content = bin(
    'BT /F1 12 Tf 1.5 Tc 2 Tw 90 Tz 72 700 Td (Spacing options still work fine.) Tj ET'
  );
  const res = await extractPdfText(onePagePdf(content));
  assert.ok(res.text.includes('Spacing options still work fine.'));
});

// ---------------------------------------------------------------------------
// 2. 压缩内容流
// ---------------------------------------------------------------------------

test('FlateDecode 压缩内容流仍可提取', async () => {
  const content = bin('BT /F1 12 Tf 72 700 Td (Compressed content stream works.) Tj ET');
  const compressed = zlib.deflateSync(content);
  const pdf = classicPdf([
    bin('<< /Type /Catalog /Pages 2 0 R >>'),
    bin('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    bin(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
    ),
    streamBody('/Filter /FlateDecode', compressed),
    simpleFontObj(),
  ]);
  const res = await extractPdfText(pdf);
  assert.ok(res.text.includes('Compressed content stream works.'), `实际输出: ${JSON.stringify(res.text)}`);
  assert.deepEqual(res.meta.warnings, []);
});

test('过滤器链 [/ASCII85Decode /FlateDecode] 按顺序解码', async () => {
  const content = bin('BT /F1 12 Tf 72 700 Td (Chained filters decode in order.) Tj ET');
  const encoded = ascii85Encode(zlib.deflateSync(content));
  const pdf = classicPdf([
    bin('<< /Type /Catalog /Pages 2 0 R >>'),
    bin('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    bin(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
    ),
    streamBody('/Filter [/ASCII85Decode /FlateDecode] /DecodeParms [null null]', encoded),
    simpleFontObj(),
  ]);
  const res = await extractPdfText(pdf);
  assert.ok(res.text.includes('Chained filters decode in order.'), `实际输出: ${JSON.stringify(res.text)}`);
});

test('ASCIIHexDecode / RunLengthDecode / LZWDecode 均可解码', async () => {
  const texts = [
    'ASCIIHex encoded page text.',
    'RunLength encoded page text.',
    'LZW encoded page text.',
  ];
  const contents = texts.map((t) => bin(`BT /F1 12 Tf 72 700 Td (${t}) Tj ET`));

  const objects = [
    bin('<< /Type /Catalog /Pages 2 0 R >>'),
    bin('<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>'),
    bin(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 9 0 R >> >> /Contents 4 0 R >>'
    ),
    streamBody('/Filter /ASCIIHexDecode', asciiHexEncode(contents[0])),
    bin(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 9 0 R >> >> /Contents 6 0 R >>'
    ),
    streamBody('/Filter /RunLengthDecode', runLengthEncode(contents[1])),
    bin(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 9 0 R >> >> /Contents 8 0 R >>'
    ),
    streamBody('/Filter /LZWDecode', lzwEncodeLiterals(contents[2])),
    simpleFontObj(),
  ];
  const res = await extractPdfText(classicPdf(objects));
  assert.equal(res.meta.pageCount, 3);
  assert.ok(res.meta.pages[0].includes('ASCIIHex encoded page text.'), `p0=${JSON.stringify(res.meta.pages[0])}`);
  assert.ok(res.meta.pages[1].includes('RunLength encoded page text.'), `p1=${JSON.stringify(res.meta.pages[1])}`);
  assert.ok(res.meta.pages[2].includes('LZW encoded page text.'), `p2=${JSON.stringify(res.meta.pages[2])}`);
});

test('maxPages 限制提取页数', async () => {
  const pages = [1, 2, 3].map((i) => bin(`BT /F1 12 Tf 72 700 Td (Page number ${i} content.) Tj ET`));
  const res = await extractPdfText(multiPagePdf(pages), { maxPages: 1 });
  assert.equal(res.meta.pageCount, 1);
  assert.equal(res.meta.pages.length, 1);
  assert.ok(res.meta.pages[0].includes('Page number 1 content.'));
  assert.ok(!res.text.includes('Page number 2 content.'));
});

// ---------------------------------------------------------------------------
// 3. ToUnicode / Identity-H 中文字体
// ---------------------------------------------------------------------------

function buildChineseFontObjects() {
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    '5 beginbfchar',
    '<0001> <4E2D>',
    '<0002> <6587>',
    '<0003> <6570>',
    '<0004> <636E>',
    '<0020> <4FE1>',
    'endbfchar',
    '2 beginbfrange',
    '<0010> <0012> <65E5>',
    '<0021> <0022> [<606F> <0021>]',
    'endbfrange',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
  return {
    cmap,
    objects: [
      bin('<< /Type /Font /Subtype /Type0 /BaseFont /TestCJK /Encoding /Identity-H ' +
        '/DescendantFonts [6 0 R] /ToUnicode 8 0 R >>'),
      bin(
        '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TestCJK ' +
          '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ' +
          '/FontDescriptor 7 0 R /DW 1000 >>'
      ),
      bin(
        '<< /Type /FontDescriptor /FontName /TestCJK /Flags 4 /FontBBox [0 0 1000 1000] ' +
          '/ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>'
      ),
    ],
  };
}

function chinesePdf(contentStreams) {
  const { cmap, objects: fontObjects } = buildChineseFontObjects();
  const cmapBytes = bin(cmap);
  const objects = [
    bin('<< /Type /Catalog /Pages 2 0 R >>'),
    bin(`<< /Type /Pages /Kids [${contentStreams.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${contentStreams.length} >>`),
  ];
  const fontResNum = 5;
  contentStreams.forEach((content, i) => {
    const pageNum = 3 + i * 2;
    const contentNum = pageNum + 1;
    objects.push(
      bin(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
          `/Resources << /Font << /F1 ${fontResNum} 0 R >> >> /Contents ${contentNum} 0 R >>`
      )
    );
    objects.push(streamBody('', content));
  });
  objects.push(...fontObjects); // 5,6,7
  objects.push(streamBody('', cmapBytes)); // 8
  return classicPdf(objects);
}

test('ToUnicode bfchar 能正确还原中文（Identity-H 双字节）', async () => {
  const content = bin('BT /F1 24 Tf 72 700 Td <0001> Tj <0002> Tj ET');
  const res = await extractPdfText(chinesePdf([content]));
  assert.ok(res.text.includes('中文'), `实际输出: ${JSON.stringify(res.text)}`);
  assert.deepEqual(res.meta.warnings, []);
});

test('ToUnicode bfrange（简单形式）按序自增还原中文', async () => {
  // U+65E5..U+65E7 => 日 旦 旧，用于验证范围逐个自增
  const content = bin('BT /F1 24 Tf 72 700 Td <0010> Tj <0011> Tj <0012> Tj ET');
  const res = await extractPdfText(chinesePdf([content]));
  assert.ok(res.text.includes('日旦旧'), `实际输出: ${JSON.stringify(res.text)}`);
});

test('ToUnicode bfrange 数组形式逐个映射', async () => {
  const content = bin('BT /F1 24 Tf 72 700 Td <0021> Tj <0022> Tj ET');
  const res = await extractPdfText(chinesePdf([content]));
  assert.ok(res.text.includes('息!'), `实际输出: ${JSON.stringify(res.text)}`);
});

test('中文整句往返（混合 bfchar 与 bfrange）', async () => {
  // 单个十六进制字符串承载整句（PDF 中连续的多个字符串不会自动拼接）
  const content = bin('BT /F1 24 Tf 72 700 Td <0001000200030004002000210022> Tj ET');
  const res = await extractPdfText(chinesePdf([content]));
  assert.equal(res.text.trim(), '中文数据信息!');
});

// ---------------------------------------------------------------------------
// 4. xref 流 + Predictor 12
// ---------------------------------------------------------------------------

function xrefStreamPdf() {
  const content = bin('BT /F1 12 Tf 72 700 Td (Cross reference stream page text.) Tj ET');
  const header = bin('%PDF-1.5\n%\u00e2\u00e3\u00cf\u00d3\n');
  const chunks = [header];
  let offset = header.length;

  const offsets = new Map();
  const pushObj = (num, body) => {
    offsets.set(num, offset);
    const b = Buffer.concat([bin(`${num} 0 obj\n`), body, bin('\nendobj\n')]);
    chunks.push(b);
    offset += b.length;
  };

  pushObj(1, bin('<< /Type /Catalog /Pages 2 0 R >>'));
  pushObj(2, bin('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
  pushObj(
    3,
    bin(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
    )
  );
  pushObj(4, streamBody('', content));
  pushObj(5, simpleFontObj());

  // 对象 6..7 留空（空闲项）
  const xrefOffset = offset;
  const rows = [];
  const w = [1, 2, 1];
  const row = (type, f2, f3) => Buffer.from([type & 0xff, (f2 >> 8) & 0xff, f2 & 0xff, f3 & 0xff]);
  rows.push(row(0, 0, 255)); // 0：空闲
  for (const n of [1, 2, 3, 4, 5]) rows.push(row(1, offsets.get(n), 0));
  rows.push(row(0, 0, 0)); // 6
  rows.push(row(0, 0, 0)); // 7
  rows.push(row(1, xrefOffset, 0)); // 8（xref 流自身）
  const predicted = pngUpEncode(rows, 4);
  const xrefData = zlib.deflateSync(predicted);
  const xrefBody = streamBody(
    '/Type /XRef /Size 9 /W [1 2 1] /Index [0 9] /Root 1 0 R ' +
      '/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 4 >>',
    xrefData
  );
  const xrefObj = Buffer.concat([bin('8 0 obj\n'), xrefBody, bin('\nendobj\n')]);
  chunks.push(xrefObj);
  offset += xrefObj.length;

  chunks.push(bin(`startxref\n${xrefOffset}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

test('交叉引用流（/Type /XRef + Predictor 12）可定位对象', async () => {
  const res = await extractPdfText(xrefStreamPdf());
  assert.ok(
    res.text.includes('Cross reference stream page text.'),
    `实际输出: ${JSON.stringify(res.text)} warnings=${JSON.stringify(res.meta.warnings)}`
  );
  assert.equal(res.meta.pageCount, 1);
});

// ---------------------------------------------------------------------------
// 5. 对象流 /Type /ObjStm
// ---------------------------------------------------------------------------

function objectStreamPdf() {
  const content = bin('BT /F1 12 Tf 72 700 Td (Text inside an object stream document.) Tj ET');
  const header = bin('%PDF-1.5\n%\u00e2\u00e3\u00cf\u00d3\n');
  const chunks = [header];
  let offset = header.length;

  // 对象 4：内容流（未压缩，独立对象）
  const contentOffset = offset;
  const contentObj = Buffer.concat([
    bin('4 0 obj\n'),
    streamBody('', content),
    bin('\nendobj\n'),
  ]);
  chunks.push(contentObj);
  offset += contentObj.length;

  // 对象 9：对象流，内含对象 1、2、3、5
  const inners = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [
      3,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    ],
    [5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'],
  ];
  let body = '';
  const pairs = [];
  for (const [num, src] of inners) {
    pairs.push(`${num} ${body.length}`);
    body += src + '\n';
  }
  const head = pairs.join(' ') + '\n';
  const first = head.length;
  const objStmData = zlib.deflateSync(bin(head + body));
  const objStmOffset = offset;
  const objStmObj = Buffer.concat([
    bin('9 0 obj\n'),
    streamBody(`/Type /ObjStm /N ${inners.length} /First ${first} /Filter /FlateDecode`, objStmData),
    bin('\nendobj\n'),
  ]);
  chunks.push(objStmObj);
  offset += objStmObj.length;

  // 对象 8：xref 流
  const xrefOffset = offset;
  const row = (type, f2, f3) => Buffer.from([type & 0xff, (f2 >> 8) & 0xff, f2 & 0xff, f3 & 0xff]);
  const rows = [];
  rows.push(row(0, 0, 255)); // 0
  rows.push(row(2, 9, 0)); // 1 -> ObjStm 9, idx 0
  rows.push(row(2, 9, 1)); // 2 -> idx 1
  rows.push(row(2, 9, 2)); // 3 -> idx 2
  rows.push(row(1, contentOffset, 0)); // 4
  rows.push(row(2, 9, 3)); // 5 -> idx 3
  rows.push(row(0, 0, 0)); // 6
  rows.push(row(0, 0, 0)); // 7
  rows.push(row(1, xrefOffset, 0)); // 8
  rows.push(row(1, objStmOffset, 0)); // 9
  const xrefData = zlib.deflateSync(pngUpEncode(rows, 4));
  const xrefBody = streamBody(
    '/Type /XRef /Size 10 /W [1 2 1] /Index [0 10] /Root 1 0 R ' +
      '/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 4 >>',
    xrefData
  );
  const xrefObj = Buffer.concat([bin('8 0 obj\n'), xrefBody, bin('\nendobj\n')]);
  chunks.push(xrefObj);
  offset += xrefObj.length;

  chunks.push(bin(`startxref\n${xrefOffset}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

test('对象流（/Type /ObjStm）中的对象可以解析', async () => {
  const res = await extractPdfText(objectStreamPdf());
  assert.ok(
    res.text.includes('Text inside an object stream document.'),
    `实际输出: ${JSON.stringify(res.text)} warnings=${JSON.stringify(res.meta.warnings)}`
  );
});

// ---------------------------------------------------------------------------
// 6. 文本重建
// ---------------------------------------------------------------------------

test('重建：连字符断行合并、软换行合并、条款编号保留', async () => {
  const content = bin(
    [
      'BT',
      '/F1 12 Tf',
      '72 720 Td',
      '(The quick brown fox jumps over the) Tj',
      '0 -16 Td',
      '(lazy dog and then continues on.) Tj',
      '0 -16 Td',
      '(inter-) Tj',
      '0 -16 Td',
      '(national cooperation is required.) Tj',
      '0 -16 Td',
      '(The following obligations apply to all parties under this) Tj',
      '0 -16 Td',
      '(3.2 The processor shall implement appropriate measures.) Tj',
      'ET',
    ].join('\n')
  );
  const res = await extractPdfText(onePagePdf(content));
  const t = res.text;
  assert.ok(t.includes('The quick brown fox jumps over the lazy dog and then continues on.'), `实际: ${JSON.stringify(t)}`);
  assert.ok(t.includes('international cooperation is required.'), `实际: ${JSON.stringify(t)}`);
  assert.ok(t.includes('\n3.2 The processor shall implement appropriate measures.'), `实际: ${JSON.stringify(t)}`);
  assert.ok(!/-\n/.test(t), '不应残留连字符换行');
});

test('重建：中文软换行合并但保留"第X条"标题', async () => {
  const line1 = '我们非常重视您的个人信息保护并严格遵守相关法律法规的要求';
  const line2 = '在处理您的个人信息时我们会遵循最小必要原则。';
  const heading = '第一条 定义';
  const clause = '本协议中的术语具有如下含义。';
  // 构造 UTF-16BE 的 Identity-H 内容
  const hex = (s) =>
    Array.from(s)
      .map((ch) => ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'))
      .join('');
  // 为每个用到的字符生成 bfchar 映射
  const chars = Array.from(new Set(Array.from(line1 + line2 + heading + clause)));
  const bfcharLines = chars
    .map((ch, i) => `<${(0x100 + i).toString(16).toUpperCase().padStart(4, '0')}> <${hex(ch)}>`)
    .join('\n');
  const codeOf = (ch) => (0x100 + chars.indexOf(ch)).toString(16).toUpperCase().padStart(4, '0');
  const enc = (s) => Array.from(s).map((ch) => codeOf(ch)).join('');

  const cmap = [
    'begincmap',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    `${chars.length} beginbfchar`,
    bfcharLines,
    'endbfchar',
    'endcmap',
  ].join('\n');

  const fontObjects = buildChineseFontObjects().objects;
  const content = bin(
    [
      'BT',
      '/F1 24 Tf',
      '72 720 Td',
      `<${enc(line1)}> Tj`,
      '0 -30 Td',
      `<${enc(line2)}> Tj`,
      '0 -30 Td',
      `<${enc('第一条 定义')}> Tj`,
      '0 -30 Td',
      `<${enc('本协议中的术语具有如下含义。')}> Tj`,
      'ET',
    ].join('\n')
  );

  const objects = [
    bin('<< /Type /Catalog /Pages 2 0 R >>'),
    bin('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    bin(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
    ),
    streamBody('', content),
    ...fontObjects,
    streamBody('', bin(cmap)),
  ];
  const res = await extractPdfText(classicPdf(objects));
  const t = res.text;
  assert.ok(t.includes(line1 + line2), `中文软换行应合并，实际: ${JSON.stringify(t)}`);
  assert.ok(t.includes('第一条 定义\n本协议中的术语具有如下含义。'), `标题不应被合并，实际: ${JSON.stringify(t)}`);
});

test('重建：多余空行压缩为最多一个空行，控制字符被清理', async () => {
  const content = bin(
    'BT /F1 12 Tf 72 700 Td (Alpha paragraph text here.) Tj 0 -16 Td 0 -16 Td (Beta paragraph text here.) Tj ET'
  );
  const res = await extractPdfText(onePagePdf(content));
  assert.ok(!/\n{3,}/.test(res.text), '不应出现 3 个以上连续换行');
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(res.text), '不应残留控制字符');
});

// ---------------------------------------------------------------------------
// 7. 异常与降级
// ---------------------------------------------------------------------------

test('垃圾输入返回空字符串与中文警告而不是抛异常', async () => {
  const res = await extractPdfText(Buffer.from('not a pdf at all'));
  assert.equal(typeof res.text, 'string');
  assert.equal(res.text, '');
  assert.equal(res.meta.pageCount, 0);
  assert.deepEqual(res.meta.pages, []);
  assert.equal(res.meta.extractor, 'pdf');
  assert.ok(Array.isArray(res.meta.warnings));
  assert.ok(res.meta.warnings.length > 0);
  assert.ok(res.meta.warnings.some((w) => /PDF/.test(w)));
});

test('空缓冲区与非法输入不会抛异常', async () => {
  for (const input of [Buffer.alloc(0), Buffer.from([0x00, 0x01, 0x02]), 'no pdf']) {
    const res = await extractPdfText(input);
    assert.equal(res.text, '');
    assert.ok(res.meta.warnings.length > 0);
  }
  const res = await extractPdfText(undefined);
  assert.equal(res.text, '');
  assert.ok(res.meta.warnings.length > 0);
});

test('加密 PDF 返回空文本与中文加密提示', async () => {
  const content = bin('BT /F1 12 Tf 72 700 Td (This should not be extracted.) Tj ET');
  const pdf = classicPdf(
    [
      bin('<< /Type /Catalog /Pages 2 0 R >>'),
      bin('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
      bin(
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
          '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
      ),
      streamBody('', content),
      simpleFontObj(),
      bin('<< /Filter /Standard /V 1 /R 2 /O (abcd) /U (abcd) /P -44 >>'),
    ],
    { trailerExtra: '/Encrypt 6 0 R' }
  );
  const res = await extractPdfText(pdf);
  assert.equal(res.text, '');
  assert.equal(res.meta.pageCount, 0);
  assert.ok(res.meta.warnings.some((w) => w.includes('加密')), JSON.stringify(res.meta.warnings));
});

test('损坏的 xref 偏移时仍能通过线性扫描恢复对象', async () => {
  const content = bin('BT /F1 12 Tf 72 700 Td (Recovered despite broken xref.) Tj ET');
  const pdf = onePagePdf(content);
  const broken = Buffer.from(pdf);
  // 破坏 startxref 指向的位置
  const idx = broken.lastIndexOf(bin('startxref'));
  const bad = Buffer.from('startxref\n999999\n%%EOF\n', 'latin1');
  bad.copy(broken, idx);
  const res = await extractPdfText(broken);
  assert.ok(res.text.includes('Recovered despite broken xref.'), `实际输出: ${JSON.stringify(res.text)}`);
});

test('缺失页面树时给出中文降级提示', async () => {
  // 只有 Catalog 指向一个空的 Pages 节点，没有任何页面
  const pdf = classicPdf([
    bin('<< /Type /Catalog /Pages 2 0 R >>'),
    bin('<< /Type /Pages /Kids [] /Count 0 >>'),
  ]);
  const res = await extractPdfText(pdf);
  assert.ok(Array.isArray(res.meta.warnings));
  assert.ok(res.meta.warnings.length > 0);
  assert.ok(res.meta.warnings.some((w) => w.includes('页面') || w.includes('扫描')), JSON.stringify(res.meta.warnings));
});

test('meta 字段形状正确', async () => {
  const content = bin('BT /F1 12 Tf 72 700 Td (Shape check for meta fields.) Tj ET');
  const res = await extractPdfText(onePagePdf(content));
  assert.equal(typeof res.text, 'string');
  assert.ok(Array.isArray(res.meta.warnings));
  assert.ok(Array.isArray(res.meta.pages));
  assert.equal(typeof res.meta.pageCount, 'number');
  assert.equal(res.meta.extractor, 'pdf');
  assert.equal(res.meta.pageCount, res.meta.pages.length);
  assert.ok(res.meta.pages.every((p) => typeof p === 'string'));
  for (const w of res.meta.warnings) assert.equal(typeof w, 'string');
});

test('text 等于各页文本以空行连接', async () => {
  const pages = [1, 2].map((i) => bin(`BT /F1 12 Tf 72 700 Td (Paragraph number ${i} body.) Tj ET`));
  const res = await extractPdfText(multiPagePdf(pages));
  assert.equal(res.text, res.meta.pages.join('\n\n'));
});

test('Uint8Array 输入同样可用', async () => {
  const content = bin('BT /F1 12 Tf 72 700 Td (Uint8Array input works too.) Tj ET');
  const pdf = onePagePdf(content);
  const res = await extractPdfText(new Uint8Array(pdf));
  assert.ok(res.text.includes('Uint8Array input works too.'));
});

// ---------------------------------------------------------------------------
// 8. 字体降级
// ---------------------------------------------------------------------------

test('缺少 ToUnicode 与 Encoding 时降级为 Latin-1 并给出中文警告', async () => {
  // 含高位字节（\351 = é），会触发"映射不可靠"告警
  const content = bin('BT /F1 12 Tf 72 700 Td (Caf\\351 latin1 fallback text.) Tj ET');
  const pdf = classicPdf([
    bin('<< /Type /Catalog /Pages 2 0 R >>'),
    bin('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    bin(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
    ),
    streamBody('', content),
    bin('<< /Type /Font /Subtype /TrueType /BaseFont /Mystery >>'),
  ]);
  const res = await extractPdfText(pdf);
  assert.ok(res.text.includes('Café latin1 fallback text.'), `实际: ${JSON.stringify(res.text)}`);
  assert.ok(
    res.meta.warnings.some((w) => w.includes('ToUnicode')),
    JSON.stringify(res.meta.warnings)
  );
});

test('缺少 ToUnicode 但只用到 ASCII 时不产生噪音告警', async () => {
  const content = bin('BT /F1 12 Tf 72 700 Td (Plain ascii needs no warning.) Tj ET');
  const pdf = classicPdf([
    bin('<< /Type /Catalog /Pages 2 0 R >>'),
    bin('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    bin(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
    ),
    streamBody('', content),
    bin('<< /Type /Font /Subtype /TrueType /BaseFont /Mystery >>'),
  ]);
  const res = await extractPdfText(pdf);
  assert.ok(res.text.includes('Plain ascii needs no warning.'));
  assert.deepEqual(res.meta.warnings, []);
});

test('Differences 数组中的自定义编码被识别', async () => {
  const content = bin('BT /F1 12 Tf 72 700 Td <414243> Tj ET');
  const pdf = classicPdf([
    bin('<< /Type /Catalog /Pages 2 0 R >>'),
    bin('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    bin(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
    ),
    streamBody('', content),
    bin(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Custom ' +
        '/Encoding << /BaseEncoding /WinAnsiEncoding /Differences [ 65 /uni4E2D 66 /uni6587 67 /A ] >> >>'
    ),
  ]);
  const res = await extractPdfText(pdf);
  assert.ok(res.text.includes('中文A'), `实际: ${JSON.stringify(res.text)}`);
});

test('忽略内联图像中的二进制数据', async () => {
  const inline =
    'BT /F1 12 Tf 72 700 Td (Before inline image.) Tj ET\n' +
    'q 100 0 0 100 72 500 cm\nBI /W 4 /H 4 /CS /G /BPC 8 /F /AHx ID\n' +
    '00112233445566778899AABBCCDDEEFF>\nEI Q\n' +
    'BT /F1 12 Tf 72 400 Td (After inline image.) Tj ET';
  const res = await extractPdfText(onePagePdf(bin(inline)));
  assert.ok(res.text.includes('Before inline image.'), JSON.stringify(res.text));
  assert.ok(res.text.includes('After inline image.'), JSON.stringify(res.text));
  assert.ok(!/00112233/.test(res.text));
});

test('表单 XObject 中的文本也会被提取', async () => {
  const formContent = bin('BT /F1 12 Tf 72 700 Td (Text inside a Form XObject.) Tj ET');
  const objects = [
    bin('<< /Type /Catalog /Pages 2 0 R >>'),
    bin('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    bin(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 5 0 R >> /XObject << /Fm1 6 0 R >> >> /Contents 4 0 R >>'
    ),
    streamBody('', bin('q 1 0 0 1 0 0 cm /Fm1 Do Q')),
    simpleFontObj(),
    streamBody('/Type /XObject /Subtype /Form /BBox [0 0 612 792]', formContent),
  ];
  const res = await extractPdfText(classicPdf(objects));
  assert.ok(res.text.includes('Text inside a Form XObject.'), `实际: ${JSON.stringify(res.text)}`);
});

// ---------------------------------------------------------------------------
// 9. 增量更新、损坏长度、局部损坏页
// ---------------------------------------------------------------------------

test('增量更新（/Prev）时以最新修订的内容为准', async () => {
  const original = bin('BT /F1 12 Tf 72 700 Td (Original text of the base revision.) Tj ET');
  const updated = bin('BT /F1 12 Tf 72 700 Td (Updated text of the incremental revision.) Tj ET');

  const chunks = [];
  let offset = 0;
  const header = bin('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n');
  chunks.push(header);
  offset += header.length;
  const offsets = [];
  const bodies = [
    bin('<< /Type /Catalog /Pages 2 0 R >>'),
    bin('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    bin(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
    ),
    streamBody('', original),
    simpleFontObj(),
  ];
  bodies.forEach((body, i) => {
    offsets.push(offset);
    const b = Buffer.concat([bin(`${i + 1} 0 obj\n`), body, bin('\nendobj\n')]);
    chunks.push(b);
    offset += b.length;
  });
  const baseXref = offset;
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  for (const off of offsets) xref += String(off).padStart(10, '0') + ' 00000 n \n';
  chunks.push(bin(xref));
  chunks.push(bin(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${baseXref}\n%%EOF\n`));
  offset = chunks.reduce((a, b) => a + b.length, 0);

  // 追加修订：对象 4 被替换
  const newOffset = offset;
  const newObj = Buffer.concat([bin('4 0 obj\n'), streamBody('', updated), bin('\nendobj\n')]);
  chunks.push(newObj);
  offset += newObj.length;
  const newXref = offset;
  const delta = `xref\n0 1\n0000000000 65535 f \n4 1\n${String(newOffset).padStart(10, '0')} 00000 n \n`;
  chunks.push(bin(delta));
  chunks.push(
    bin(`trailer\n<< /Size 6 /Root 1 0 R /Prev ${baseXref} >>\nstartxref\n${newXref}\n%%EOF\n`)
  );

  const res = await extractPdfText(Buffer.concat(chunks));
  assert.ok(res.text.includes('Updated text of the incremental revision.'), `实际: ${JSON.stringify(res.text)}`);
  assert.ok(!res.text.includes('Original text of the base revision.'), `不应保留旧修订: ${JSON.stringify(res.text)}`);
});

test('内容流缺少 /Length 时按 endstream 恢复', async () => {
  const content = bin('BT /F1 12 Tf 72 700 Td (Content stream without a length entry.) Tj ET');
  const body = Buffer.concat([bin('<< >>\nstream\n'), content, bin('\nendstream')]);
  const pdf = classicPdf([
    bin('<< /Type /Catalog /Pages 2 0 R >>'),
    bin('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    bin(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
    ),
    body,
    simpleFontObj(),
  ]);
  const res = await extractPdfText(pdf);
  assert.ok(res.text.includes('Content stream without a length entry.'), `实际: ${JSON.stringify(res.text)}`);
});

test('单个对象 xref 偏移错误时通过线性扫描恢复', async () => {
  const content = bin('BT /F1 12 Tf 72 700 Td (Recovered object offset via scan.) Tj ET');
  const pdf = onePagePdf(content);
  const broken = Buffer.from(pdf);
  const good = broken.indexOf(bin('4 0 obj'));
  // 把对象 4 的 xref 条目指向一个无效位置（保持 10 位宽度）
  const entry = bin(`${String(good).padStart(10, '0')} 00000 n`);
  const at = broken.indexOf(entry);
  assert.ok(at > 0, '应能找到对象 4 的 xref 条目');
  bin('0000000001 00000 n').copy(broken, at);
  const res = await extractPdfText(broken);
  assert.ok(res.text.includes('Recovered object offset via scan.'), `实际: ${JSON.stringify(res.text)}`);
});

test('单页内容流解压失败不会中断整篇文档，也不输出二进制垃圾', async () => {
  const good = bin('BT /F1 12 Tf 72 700 Td (Second page is still readable.) Tj ET');
  const garbage = Buffer.from([0x78, 0x9c, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99]);
  const pdf = multiPagePdf([
    { data: garbage, filter: '/Filter /FlateDecode' },
    { data: good, filter: '' },
  ]);
  const res = await extractPdfText(pdf);
  assert.equal(res.meta.pageCount, 2);
  assert.ok(res.text.includes('Second page is still readable.'), `实际: ${JSON.stringify(res.text)}`);
  assert.ok(res.meta.warnings.some((w) => w.includes('解压')), JSON.stringify(res.meta.warnings));
  // 不应出现明显的二进制控制字符
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(res.text));
});

test('内容流上的 Predictor 12 也能正确还原', async () => {
  const content = bin('BT /F1 12 Tf 72 700 Td (Predictor on a content stream works.) Tj ET');
  // 人为把内容流按 PNG Up 预测器编码后压缩
  const rowLen = content.length;
  const rows = [content];
  // 每行长度需一致，这里只有一行，直接按 Up 预测器编码（首行等价于 None）
  const predicted = Buffer.concat([Buffer.from([2]), Buffer.from(rows[0])]);
  const packed = zlib.deflateSync(predicted);
  const pdf = classicPdf([
    bin('<< /Type /Catalog /Pages 2 0 R >>'),
    bin('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    bin(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
    ),
    streamBody(
      `/Filter /FlateDecode /DecodeParms << /Predictor 12 /Colors 1 /BitsPerComponent 8 /Columns ${rowLen} >>`,
      packed
    ),
    simpleFontObj(),
  ]);
  const res = await extractPdfText(pdf);
  assert.ok(res.text.includes('Predictor on a content stream works.'), `实际: ${JSON.stringify(res.text)}`);
});

// ---------------------------------------------------------------------------
// 10. 真实排版中常见的其它结构
// ---------------------------------------------------------------------------

test('翻转的 CTM（1 0 0 -1 0 H cm）不影响分行', async () => {
  const content = bin(
    [
      'q 1 0 0 -1 0 792 cm',
      'BT /F1 12 Tf',
      '72 -120 Td',
      '(Flipped matrix first line.) Tj',
      '0 20 Td',
      '(Flipped matrix second line.) Tj',
      'ET Q',
    ].join('\n')
  );
  const res = await extractPdfText(onePagePdf(content));
  assert.ok(res.text.includes('Flipped matrix first line.'), JSON.stringify(res.text));
  assert.ok(res.text.includes('Flipped matrix second line.'), JSON.stringify(res.text));
  assert.ok(
    res.text.indexOf('Flipped matrix second line.') >
      res.text.indexOf('Flipped matrix first line.'),
    '顺序应保持内容流顺序'
  );
});

test('双引号算子（aw ac string "）产生换行', async () => {
  const content = bin(
    [
      'BT /F1 12 Tf',
      '16 TL',
      '72 700 Td',
      '1.5 0.5 (First double quoted line) "',
      '1.5 0.5 (Second double quoted line) "',
      'ET',
    ].join('\n')
  );
  const res = await extractPdfText(onePagePdf(content));
  assert.ok(res.text.includes('First double quoted line'));
  assert.ok(res.text.includes('Second double quoted line'));
  assert.ok(res.text.includes('First double quoted line\n'), `应有换行: ${JSON.stringify(res.text)}`);
});

test('/Contents 为数组时按顺序拼接', async () => {
  const pdf = classicPdf([
    bin('<< /Type /Catalog /Pages 2 0 R >>'),
    bin('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    bin(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents [4 0 R 6 0 R] >>'
    ),
    streamBody('', bin('BT /F1 12 Tf 72 700 Td (First content stream part.) Tj ET')),
    bin('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    streamBody('', bin('BT /F1 12 Tf 72 680 Td (Second content stream part.) Tj ET')),
  ]);
  const res = await extractPdfText(pdf);
  assert.ok(res.text.includes('First content stream part.'), JSON.stringify(res.text));
  assert.ok(res.text.includes('Second content stream part.'), JSON.stringify(res.text));
});

test('/Resources 从祖先 /Pages 节点继承', async () => {
  const pdf = classicPdf([
    bin('<< /Type /Catalog /Pages 2 0 R >>'),
    bin(
      '<< /Type /Pages /Kids [3 0 R] /Count 1 ' +
        '/Resources << /Font << /F1 5 0 R >> >> >>'
    ),
    bin('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>'),
    streamBody('', bin('BT /F1 12 Tf 72 700 Td (Inherited resources work.) Tj ET')),
    simpleFontObj(),
  ]);
  const res = await extractPdfText(pdf);
  assert.ok(res.text.includes('Inherited resources work.'), `实际: ${JSON.stringify(res.text)}`);
});

test('内嵌 CMap 的 codespacerange 决定字节宽度（1 字节码位）', async () => {
  // 自定义 1 字节 CMap：把 0x41..0x43 映射到 中 文 测
  const cmap = [
    'begincmap',
    '1 begincodespacerange',
    '<00> <FF>',
    'endcodespacerange',
    '3 beginbfchar',
    '<41> <4E2D>',
    '<42> <6587>',
    '<43> <6D4B>',
    'endbfchar',
    'endcmap',
  ].join('\n');
  // 注意：ToUnicode 的 codespacerange 故意声明为 2 字节，
  // 真正决定内容流字节切分的是 /Encoding 指向的内嵌 CMap（1 字节）
  const toUnicode = [
    'begincmap',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    '3 beginbfchar',
    '<41> <4E2D>',
    '<42> <6587>',
    '<43> <6D4B>',
    'endbfchar',
    'endcmap',
  ].join('\n');
  const objects = [
    bin('<< /Type /Catalog /Pages 2 0 R >>'),
    bin('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    bin(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
    ),
    streamBody('', bin('BT /F1 12 Tf 72 700 Td (ABC) Tj ET')),
    bin(
      '<< /Type /Font /Subtype /Type0 /BaseFont /OneByte /Encoding 6 0 R ' +
        '/DescendantFonts [7 0 R] /ToUnicode 9 0 R >>'
    ),
    streamBody('', bin(cmap)),
    bin(
      '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /OneByte ' +
        '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ' +
        '/FontDescriptor 8 0 R /DW 1000 /W [65 [1000 1000 1000]] >>'
    ),
    bin(
      '<< /Type /FontDescriptor /FontName /OneByte /Flags 4 /FontBBox [0 0 1000 1000] ' +
        '/ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>'
    ),
    streamBody('', bin(toUnicode)),
  ];
  const res = await extractPdfText(classicPdf(objects));
  assert.ok(res.text.includes('中文测'), `实际: ${JSON.stringify(res.text)}`);
});
