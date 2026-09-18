/**
 * src/extract/html.js
 *
 * 协议正文提取器：从原始 HTML 中抽取用户协议 / 服务条款 / 隐私政策的正文，
 * 剥离导航、页眉、页脚、Cookie 横幅、广告、侧栏、评论区、相关推荐、脚本样式等噪声。
 *
 * 设计目标：
 *   - 召回优先：宁可多留一点样板，也不能漏掉风险条款；
 *   - 精度同样重要：导航 / 相关推荐这类纯链接块必须被丢掉；
 *   - 零第三方依赖：只手写容错分词器，不使用任何 DOM / 解析库；
 *   - 绝不抛错：任何畸形输入都返回结构化结果（可能 text 为空）。
 *
 * 主要策略：readability 风格的候选块打分 + 语义标签 + 密度区块 + 兜底链。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 正文判定阈值：低于该字符数认为候选/回退结果不可靠，继续走下一级回退 */
const MIN_TEXT = 400;

/** 候选块数量上限 */
const MAX_CANDIDATES = 10;

/**
 * 这些元素整体丢弃（子树不参与打分与输出）。
 * 说明：head 一并丢弃，但 <title>/<meta>/<h1> 用作标题的信息在丢弃前已采集。
 */
const DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object',
  'embed', 'nav', 'header', 'footer', 'aside', 'form', 'button', 'select', 'input',
  'label', 'head', 'textarea', 'option', 'optgroup', 'map', 'audio', 'video',
  'source', 'track', 'picture', 'dialog', 'link', 'meta', 'base', 'title',
]);

/** 无子节点的空元素 */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

/** 内容按“原始文本”处理，内部不再识别标签（防止脚本里的 "<" 破坏文档结构） */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'title', 'textarea']);

/** 隐式闭合规则：遇到 key 时，若栈顶为其值中的标签则先弹出 */
const IMPLIED_CLOSE = {
  p: new Set(['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl',
    'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4',
    'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']),
  li: new Set(['li']),
  dt: new Set(['dt', 'dd']),
  dd: new Set(['dt', 'dd']),
  tr: new Set(['tr']),
  td: new Set(['td', 'th', 'tr']),
  th: new Set(['td', 'th', 'tr']),
  thead: new Set(['tbody', 'tfoot']),
  tbody: new Set(['tbody', 'tfoot']),
  option: new Set(['option', 'optgroup']),
  optgroup: new Set(['optgroup']),
};

/** 标题元素遇到块级元素应隐式闭合（真实浏览器行为，避免未闭合 h1 吞掉整篇文档） */
const HEADING_IMPLIED_CLOSE = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
]);
for (const h of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) IMPLIED_CLOSE[h] = HEADING_IMPLIED_CLOSE;

/** 段落类元素：其内部文本计入“段落文本比例” */
const PARA_TAGS = new Set(['p', 'li', 'dd', 'dt', 'blockquote']);

/** 候选容器元素 */
const CANDIDATE_TAGS = new Set(['article', 'main', 'div', 'section', 'td', 'th', 'body', 'root']);

/**
 * 用于密度切块的块级元素。
 * 注意：不把 td/th 当作切块单位，否则表格会被拆成一个个单元格、丢失行结构；
 * 让 tr 成为切块叶子，渲染时再用 " | " 连接单元格。
 */
const BLOCKY_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'center', 'dd', 'details',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1',
  'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p',
  'pre', 'section', 'summary', 'table', 'tbody', 'tfoot', 'thead', 'tr', 'ul',
]);

/** 输出时产生块级边界的元素 */
const BREAK_TAGS = new Set([
  'address', 'article', 'blockquote', 'caption', 'center', 'dd', 'details', 'div',
  'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'summary', 'table',
  'tbody', 'tfoot', 'thead', 'tr', 'ul',
]);

/** 默认丢弃的 ARIA role（明确的导航 / 页脚 / 搜索等语义） */
const DROP_ROLES = new Set([
  'navigation', 'banner', 'contentinfo', 'complementary', 'search', 'form',
  'menu', 'menubar', 'dialog', 'alertdialog', 'toolbar', 'tablist',
]);

/**
 * 样板类名 / ID 的正则（题目要求的清单）。
 * 采用“分隔符 + 单词 + 分隔符”的形式，避免 content 之类正常词被误伤。
 */
const BOILERPLATE_RE = new RegExp(
  '(?:^|[\\s_-])(?:' + [
    'nav', 'navigation', 'menu', 'sidebar', 'side-bar', 'footer', 'header',
    'masthead', 'cookie', 'consent', 'banner', 'gdpr', 'advert', 'ads?',
    'sponsor', 'promo', 'social', 'share', 'breadcrumb', 'pagination', 'pager',
    'comment', 'disqus', 'related', 'recommend', 'popup', 'modal', 'overlay',
    'subscribe', 'newsletter', 'skip-link', 'toolbar', 'site-header',
    'site-footer', 'topbar', 'legal-nav', 'lang', 'language-switch',
  ].join('|') + ')(?:$|[\\s_-])',
  'i',
);

/** 类名/ID 中的独立样板单词 */
const BOILERPLATE_WORDS = new Set([
  'nav', 'navigation', 'navbar', 'menu', 'megamenu', 'sidebar', 'footer', 'header',
  'masthead', 'cookie', 'cookies', 'consent', 'banner', 'gdpr', 'advert', 'ad',
  'ads', 'sponsor', 'sponsored', 'promo', 'social', 'share', 'breadcrumb',
  'breadcrumbs', 'pagination', 'pager', 'comment', 'comments', 'disqus',
  'related', 'recommend', 'recommended', 'popup', 'modal', 'overlay', 'subscribe',
  'newsletter', 'toolbar', 'topbar', 'sidebar', 'skip', 'lang', 'language',
]);

/** 类名/ID 中作为前缀出现的样板词（navbar / advertisement 之类） */
const BOILERPLATE_PREFIXES = [
  'nav', 'menu', 'footer', 'header', 'cookie', 'consent', 'banner', 'gdpr',
  'advert', 'sponsor', 'promo', 'social', 'share', 'breadcrumb', 'pagination',
  'pager', 'comment', 'disqus', 'related', 'recommend', 'popup', 'modal',
  'overlay', 'subscribe', 'newsletter', 'toolbar', 'topbar', 'sidebar',
  'masthead', 'lang',
];

/** 拆词后需要按“相邻两词组合”判断的样板（side-bar / site-header ...） */
const BOILERPLATE_COMPOUNDS = new Set([
  'side-bar', 'site-header', 'site-footer', 'legal-nav', 'skip-link',
  'language-switch', 'language-selector', 'language-select', 'language-nav',
  'lang-switch', 'lang-switcher', 'lang-select', 'top-bar', 'back-top',
  'back-to-top', 'main-nav', 'sub-nav', 'subnav', 'global-nav', 'page-header',
  'page-footer', 'related-links', 'related-posts', 'share-links', 'share-bar',
  'social-links', 'social-share', 'ad-slot', 'ad-box', 'cookie-notice',
  'cookie-bar', 'cookie-consent', 'consent-banner', 'nav-bar', 'nav-menu',
]);

/** 协议语义提示（命中则候选加分） */
const AGREEMENT_HINT_RE = /terms|tos|agreement|privacy|policy|legal|contract|eula|用户协议|服务协议|隐私政策|条款|协议/i;

/** 密度阈值：区块密度低于该值视为链接/样板，不计入正文连续段 */
const DENSITY_THRESHOLD = 0.3;

/** 标点：用于衡量“散文密度”（中英文都覆盖） */
const PUNCT_RE = /[,.;:!?，。；：！？、·]/g;

/** 零宽 / 方向控制字符 */
const ZERO_WIDTH_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** Unicode 空白 → 普通空格 */
const UNICODE_SPACE_RE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

/** 文本节点中的控制字符（保留 \n \t 交给后续折叠） */
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** 输出标记（不会出现在正常文本中） */
const MARK_BLOCK = '\u0000'; // 段落边界
const MARK_LINE = '\u0001';  // 软换行 / 列表项边界
const MARK_CELL = '\u0002';  // 表格单元格分隔

/** 命名实体表 */
const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  copy: '\u00A9', reg: '\u00AE', trade: '\u2122', deg: '\u00B0',
  plusmn: '\u00B1', times: '\u00D7', divide: '\u00F7', frac12: '\u00BD',
  frac14: '\u00BC', frac34: '\u00BE', sup2: '\u00B2', sup3: '\u00B3',
  micro: '\u00B5', para: '\u00B6', sect: '\u00A7', middot: '\u00B7',
  bull: '\u2022', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
  sbquo: '\u201A', bdquo: '\u201E', laquo: '\u00AB', raquo: '\u00BB',
  lsaquo: '\u2039', rsaquo: '\u203A', dagger: '\u2020', Dagger: '\u2021',
  permil: '\u2030', euro: '\u20AC', pound: '\u00A3', yen: '\u00A5',
  cent: '\u00A2', curren: '\u00A4', ensp: ' ', emsp: ' ', thinsp: ' ',
  zwnj: '', zwj: '', shy: '', lrm: '', rlm: '',
  oelig: '\u0153', aelig: '\u00E6', szlig: '\u00DF', auml: '\u00E4',
  ouml: '\u00F6', uuml: '\u00FC', eacute: '\u00E9', egrave: '\u00E8',
  agrave: '\u00E0', ccedil: '\u00E7', ntilde: '\u00F1',
  larr: '\u2190', rarr: '\u2192', uarr: '\u2191', darr: '\u2193',
  harr: '\u2194', crarr: '\u21B5', infin: '\u221E', ne: '\u2260',
  le: '\u2264', ge: '\u2265', radic: '\u221A', sum: '\u2211',
  hearts: '\u2665', star: '\u2606', check: '\u2713', cross: '\u2717',
};

// ---------------------------------------------------------------------------
// 实体解码与文本清洗
// ---------------------------------------------------------------------------

/**
 * 解码 HTML 实体：命名、十进制（&#123;）、十六进制（&#x4e2d;）。
 * 未知实体原样保留。
 * @param {string} str
 * @returns {string}
 */
function decodeEntities(str) {
  if (!str || str.indexOf('&') === -1) return str;
  return str.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body) => {
    if (body.charAt(0) === '#') {
      const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const cp = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10FFFF || cp === 0) return match;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return match;
      }
    }
    const key = body.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key)) return NAMED_ENTITIES[key];
    return match;
  });
}

/**
 * 清洗一段“行内文本”：解码实体、去掉零宽/控制字符、Unicode 空白与连续空白折叠。
 * @param {string} str
 * @returns {string}
 */
function normalizeInlineText(str) {
  if (!str) return '';
  let s = decodeEntities(str);
  s = s.replace(ZERO_WIDTH_RE, '').replace(CONTROL_RE, '').replace(UNICODE_SPACE_RE, ' ');
  return s.replace(/\s+/g, ' ');
}

/** 纯标点 / 纯符号行判定（数字与字母不算） */
function isPunctuationOnly(line) {
  if (!line) return true;
  return /^[\p{P}\p{S}\s]+$/u.test(line);
}

function countPunct(str) {
  if (!str) return 0;
  const m = str.match(PUNCT_RE);
  return m ? m.length : 0;
}

// ---------------------------------------------------------------------------
// 容错分词器 / 解析器
// ---------------------------------------------------------------------------

/**
 * 寻找标签结束的 '>'：跳过引号内的内容（容忍属性引号畸形）。
 * 找不到时退化为第一个 '>'（不超过 4KB），仍找不到返回 -1。
 */
function findTagEnd(html, from) {
  let quote = null;
  for (let i = from; i < html.length; i++) {
    const c = html.charAt(i);
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return i;
    if (c === '<') break; // 标签内又出现 '<' → 视为畸形
  }
  const gt = html.indexOf('>', from);
  if (gt !== -1 && gt - from <= 4096) return gt;
  return -1;
}

/** 宽松属性解析，容忍未加引号 / 未闭合的引号 */
function parseAttrs(body) {
  const attrs = {};
  if (!body) return attrs;
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const name = m[1].toLowerCase();
    const value = m[2] !== undefined ? m[2]
      : m[3] !== undefined ? m[3]
        : m[4] !== undefined ? m[4] : '';
    if (!Object.prototype.hasOwnProperty.call(attrs, name)) attrs[name] = value;
    if (re.lastIndex === m.index) re.lastIndex++; // 防死循环
  }
  return attrs;
}

/**
 * 容错解析 HTML 字符串为轻量语法树。
 * 能挺过：未闭合标签、游离的 '<'、注释、CDATA、畸形属性引号。
 * @param {string} html
 * @returns {{ root: object, malformed: boolean }}
 */
function parseHTML(html) {
  const root = { type: 'root', tag: 'root', attrs: {}, children: [], parent: null };
  const stack = [root];
  const n = html.length;
  let i = 0;
  let malformed = false;
  const top = () => stack[stack.length - 1];

  function addText(raw) {
    if (!raw) return;
    const parent = top();
    const last = parent.children[parent.children.length - 1];
    if (last && last.type === 'text') { last.value += raw; return; }
    parent.children.push({ type: 'text', value: raw, parent });
  }

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { addText(html.slice(i)); break; }
    if (lt > i) addText(html.slice(i, lt));

    // 注释
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end === -1) { malformed = true; break; }
      i = end + 3;
      continue;
    }
    // CDATA：内容按文本处理
    if (html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt + 9);
      if (end === -1) { addText(html.slice(lt + 9)); malformed = true; break; }
      addText(html.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    // DOCTYPE / 处理指令
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      if (end === -1) { malformed = true; break; }
      i = end + 1;
      continue;
    }

    const head = html.slice(lt, Math.min(n, lt + 256));
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:._-]*)/.exec(head);
    if (!m) {
      // 游离的 '<'，按普通文本处理
      addText('<');
      i = lt + 1;
      continue;
    }
    const isClose = m[1] === '/';
    const tag = m[2].toLowerCase();
    const nameEnd = lt + m[0].length;
    const end = findTagEnd(html, nameEnd);
    if (end === -1) { malformed = true; addText(html.slice(lt)); break; }
    const rawBody = html.slice(nameEnd, end);
    const selfClosing = /\/\s*$/.test(rawBody);
    i = end + 1;

    if (isClose) {
      let found = -1;
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k].tag === tag) { found = k; break; }
      }
      if (found === -1) { malformed = true; continue; } // 游离闭合标签
      stack.length = found; // 弹出匹配元素（连同其上方未闭合的子元素）
      continue;
    }

    // 隐式闭合
    while (stack.length > 1) {
      const t = top().tag;
      const rule = IMPLIED_CLOSE[t];
      if (rule && rule.has(tag)) stack.pop();
      else break;
    }

    const el = { type: 'element', tag, attrs: parseAttrs(rawBody), children: [], parent: top() };
    top().children.push(el);

    if (VOID_TAGS.has(tag) || selfClosing) continue;

    if (RAW_TEXT_TAGS.has(tag)) {
      const idx = html.toLowerCase().indexOf('</' + tag, i);
      if (idx === -1) {
        el.children.push({ type: 'text', value: html.slice(i), parent: el });
        i = n;
      } else {
        el.children.push({ type: 'text', value: html.slice(i, idx), parent: el });
        i = idx;
      }
      stack.push(el);
      continue;
    }

    stack.push(el);
  }

  return { root, malformed };
}

// ---------------------------------------------------------------------------
// 样板识别与移除
// ---------------------------------------------------------------------------

/** 把类名/ID 归一化为 '-' 分隔的小写串 */
function normalizeTokenString(raw) {
  return String(raw).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * 判断一个 class/id 值是否命中样板规则。
 * 例如：navbar / site-header / related-links / cookie-banner / advertisement。
 * 注意：不匹配 content、terms-content、agreement-body 这类正文类名。
 */
function isBoilerplateToken(raw) {
  if (!raw) return false;
  const s = normalizeTokenString(raw);
  if (!s) return false;
  if (BOILERPLATE_RE.test(s)) return true;
  const words = s.split('-').filter(Boolean);
  for (const w of words) {
    if (BOILERPLATE_WORDS.has(w)) return true;
    if (w.length > 3 && (w.endsWith('nav') || w.endsWith('menu') || w.endsWith('footer') || w.endsWith('header'))) return true;
    for (const p of BOILERPLATE_PREFIXES) {
      if (w === p) return true;
      if (w.length > p.length && w.startsWith(p)) return true;
    }
  }
  for (let i = 0; i + 1 < words.length; i++) {
    if (BOILERPLATE_COMPOUNDS.has(words[i] + '-' + words[i + 1])) return true;
  }
  return false;
}

/** 元素是否被 class/id/role/hidden 明确标为样板 */
function looksLikeBoilerplate(el) {
  const attrs = el.attrs || {};
  const role = String(attrs.role || '').toLowerCase().trim();
  if (role && DROP_ROLES.has(role)) return true;
  if (Object.prototype.hasOwnProperty.call(attrs, 'hidden')) return true;
  if (String(attrs['aria-hidden'] || '').toLowerCase() === 'true') return true;
  if (isBoilerplateToken(attrs.class)) return true;
  if (isBoilerplateToken(attrs.id)) return true;
  return false;
}

/** 快速统计子树文本长度（不做实体解码，用于安全阀判断） */
function quickTextLen(node) {
  let len = 0;
  const stack = [node];
  while (stack.length) {
    const nd = stack.pop();
    if (!nd) continue;
    if (nd.type === 'text') { if (nd.value) len += nd.value.length; continue; }
    for (const ch of nd.children || []) stack.push(ch);
  }
  return len;
}

/**
 * 移除阶段：整棵子树丢弃 script/style/nav/header/... 以及样板类名容器。
 * @param {object} root
 * @param {string[]} warnings
 */
function applyRemoval(root, warnings) {
  const stack = [root];
  let warnedKeep = false;
  while (stack.length) {
    const nd = stack.pop();
    if (!nd.children) continue;
    for (const ch of nd.children) {
      if (!ch || ch.type !== 'element') continue;
      const byTag = DROP_TAGS.has(ch.tag);
      let drop = byTag || looksLikeBoilerplate(ch);
      if (!drop) { stack.push(ch); continue; }
      if (ch.tag === 'body' || ch.tag === 'html' || ch.tag === 'root') { stack.push(ch); continue; }
      // 安全阀：仅因类名/ID 命中的容器若本身是超长正文，保留以防漏掉条款
      if (!byTag) {
        if (quickTextLen(ch) > 8000) {
          if (!warnedKeep) {
            warnings.push('部分容器类名命中样板规则但内容较长，已保留以防漏掉条款');
            warnedKeep = true;
          }
          stack.push(ch);
          continue;
        }
      }
      ch.dropped = true;
    }
  }
}

// ---------------------------------------------------------------------------
// 统计与打分
// ---------------------------------------------------------------------------

/**
 * 自底向上计算每个节点的小计：文本长度、标点、链接文本、段落文本、段落数。
 * @returns {Map<object, {textLen:number, punctCount:number, linkTextLen:number, paraTextLen:number, paraCount:number, directTextLen:number}>}
 */
function computeStats(root) {
  const order = [];
  const stack = [root];
  while (stack.length) {
    const nd = stack.pop();
    order.push(nd);
    if (nd.children) for (let k = nd.children.length - 1; k >= 0; k--) stack.push(nd.children[k]);
  }
  const stats = new Map();
  for (let idx = order.length - 1; idx >= 0; idx--) {
    const nd = order[idx];
    if (nd.type === 'text') {
      const len = nd.value ? nd.value.length : 0;
      stats.set(nd, {
        textLen: len,
        punctCount: countPunct(nd.value),
        linkTextLen: 0,
        paraTextLen: 0,
        paraCount: 0,
        directTextLen: len,
      });
      continue;
    }
    let textLen = 0;
    let punct = 0;
    let link = 0;
    let paraText = 0;
    let paraCount = 0;
    let direct = 0;
    for (const ch of nd.children || []) {
      if (ch.type === 'text') {
        const len = ch.value ? ch.value.length : 0;
        textLen += len;
        direct += len;
        punct += countPunct(ch.value);
        continue;
      }
      if (ch.dropped) continue;
      const s = stats.get(ch);
      if (!s) continue;
      textLen += s.textLen;
      punct += s.punctCount;
      link += s.linkTextLen;
      paraText += s.paraTextLen;
      paraCount += s.paraCount;
    }
    if (nd.tag === 'a') link = textLen; // 链接内的全部文本都算链接文本
    if (PARA_TAGS.has(nd.tag)) { paraText = textLen; paraCount += 1; }
    stats.set(nd, {
      textLen, punctCount: punct, linkTextLen: link, paraTextLen: paraText, paraCount,
      directTextLen: direct,
    });
  }
  return stats;
}

/** 生成候选标签，例如 div.terms-content / article#main / td（第 2 个） */
function labelOf(el, seen) {
  let label = el.tag || 'unknown';
  const attrs = el.attrs || {};
  if (attrs.id) label += '#' + String(attrs.id).trim().slice(0, 32);
  else if (attrs.class) {
    const first = String(attrs.class).trim().split(/\s+/)[0];
    if (first) label += '.' + first.slice(0, 32);
  }
  const count = (seen.get(label) || 0) + 1;
  seen.set(label, count);
  if (count > 1) label += '~' + count;
  return label;
}

/**
 * 候选块打分（readability 风格）：
 *   长度 + 段落数 + 标点密度 + 段落文本占比 + 协议语义加分 - 链接密度惩罚，
 *   再把子候选得分的一部分上浮给最近的候选祖先，最后取分最高者。
 */
function scoreCandidates(root, stats) {
  const raw = [];
  const stack = [root];
  while (stack.length) {
    const nd = stack.pop();
    if (!nd.children && nd.type !== 'root') continue;
    if (nd.dropped) continue;
    if ((nd.type === 'element' || nd.type === 'root') && CANDIDATE_TAGS.has(nd.tag)) {
      const s = stats.get(nd);
      if (s && s.textLen > 0) {
        const linkDensity = s.linkTextLen / s.textLen;
        const punctDensity = s.punctCount / s.textLen;
        const paraRatio = s.paraTextLen / s.textLen;
        let score = 0;
        score += Math.min(s.textLen, 40000) / 25;                       // 文本长度
        score += Math.min(s.paraCount, 300) * 12;                       // 段落数
        score += Math.min(punctDensity / 0.05, 1.5) * 200;              // 标点密度
        score += paraRatio * 250;                                       // 段落文本占比
        const hinted = AGREEMENT_HINT_RE.test(
          String((nd.attrs && nd.attrs.class) || '') + ' ' + String((nd.attrs && nd.attrs.id) || ''),
        );
        if (hinted) score += 400;
        const base = (score - linkDensity * 1200) * (1 - linkDensity);
        raw.push({
          node: nd,
          label: '',
          score: base,
          total: base,
          chars: s.textLen,
          linkDensity,
          paraRatio,
          punctDensity,
          hinted,
        });
      }
    }
    for (let k = (nd.children || []).length - 1; k >= 0; k--) stack.push(nd.children[k]);
  }

  const byNode = new Map();
  for (const c of raw) byNode.set(c.node, c);

  // 父级传播：子候选基础分的 40% 计入最近的候选祖先
  for (const c of raw) {
    let p = c.node.parent;
    while (p && !byNode.has(p)) p = p.parent;
    if (p && p !== c.node) {
      const pc = byNode.get(p);
      if (pc) pc.total += c.score * 0.4;
    }
  }

  const seen = new Map();
  for (const c of raw) c.label = labelOf(c.node, seen);
  raw.sort((a, b) => b.total - a.total || b.chars - a.chars);
  return { list: raw, byNode };
}

/** 在候选树里“向下收紧”：若某个候选后代几乎同样好且更精炼，则改选它 */
function refineWinner(byNode, start) {
  let cur = start;
  for (let depth = 0; depth < 6; depth++) {
    let best = null;
    const walk = [cur.node];
    const guard = new Set();
    while (walk.length) {
      const nd = walk.pop();
      if (guard.has(nd)) continue;
      guard.add(nd);
      for (const ch of nd.children || []) {
        if (!ch || ch.type !== 'element' || ch.dropped) continue;
        const c = byNode.get(ch);
        if (c && c.node.tag !== 'body' && c.node.tag !== 'root') {
          if (!best || c.total > best.total) best = c;
        } else if (!c) {
          walk.push(ch);
        }
      }
    }
    if (!best) break;
    const tightEnough = best.total >= cur.total * 0.6 && best.chars < cur.chars;
    const proseLike = best.paraRatio >= 0.4 || best.linkDensity <= 0.15;
    if (tightEnough && proseLike) cur = best;
    else break;
  }
  return cur;
}

// ---------------------------------------------------------------------------
// 文本渲染（块边界 / 换行 / 表格单元格）
// ---------------------------------------------------------------------------

/** 子树中是否存在非空白文本（用于跳过空单元格） */
function hasTextContent(node) {
  const stack = [node];
  while (stack.length) {
    const nd = stack.pop();
    if (!nd) continue;
    if (nd.type === 'text') { if (/\S/.test(nd.value || '')) return true; continue; }
    for (const ch of nd.children || []) stack.push(ch);
  }
  return false;
}

/**
 * 按块边界渲染节点为带标记的字符串。
 * @param {object|object[]} nodes
 * @returns {string}
 */
function renderText(nodes) {
  const list = Array.isArray(nodes) ? nodes : [nodes];
  const out = [];
  const ins = [];
  for (let k = list.length - 1; k >= 0; k--) ins.push({ t: 'node', n: list[k] });
  while (ins.length) {
    const it = ins.pop();
    if (it.t === 'str') { out.push(it.s); continue; }
    const nd = it.n;
    if (!nd) continue;
    if (nd.type === 'text') {
      const v = normalizeInlineText(nd.value);
      if (v) out.push(v);
      continue;
    }
    if (nd.dropped) continue;
    const tag = nd.tag;
    if (tag === 'head' || tag === 'title') continue;
    if (tag === 'br') { out.push(MARK_LINE); continue; }
    if (tag === 'hr') { out.push(MARK_BLOCK); continue; }

    if (tag === 'td' || tag === 'th') {
      // 空单元格/纯图片单元格不产生分隔符，避免行首出现多余的 " | "
      if (!hasTextContent(nd)) continue;
      // 单元格之间用 " | " 连接，保证表格化条款仍可读
      ins.push({ t: 'str', s: MARK_CELL });
      for (let k = nd.children.length - 1; k >= 0; k--) ins.push({ t: 'node', n: nd.children[k] });
      continue;
    }

    const isLi = tag === 'li';
    const isBlock = BREAK_TAGS.has(tag);
    if (isLi || isBlock) {
      const mark = isLi ? MARK_LINE : MARK_BLOCK;
      ins.push({ t: 'str', s: mark }); // 尾标记（最后弹出）
      for (let k = nd.children.length - 1; k >= 0; k--) ins.push({ t: 'node', n: nd.children[k] });
      ins.push({ t: 'str', s: mark }); // 首标记（最先弹出）
      continue;
    }
    for (let k = nd.children.length - 1; k >= 0; k--) ins.push({ t: 'node', n: nd.children[k] });
  }
  return out.join('');
}

/**
 * 输出文本归一化：合并标记、折叠空白、丢弃空行 / 纯标点行、保留段落与单换行。
 * @param {string} raw
 * @returns {string}
 */
function finalizeText(raw) {
  let s = raw || '';
  // 两遍：先吸收“标记之间的纯空白”（元素缩进），再合并相邻标记
  for (let pass = 0; pass < 2; pass++) {
    s = s.replace(/([\u0000\u0001\u0002])[^\S\n]+(?=[\u0000\u0001\u0002])/g, '$1');
    s = s.replace(/[\u0000\u0001\u0002]+/g, (run) => (
      run.indexOf(MARK_BLOCK) !== -1 ? MARK_BLOCK
        : run.indexOf(MARK_LINE) !== -1 ? MARK_LINE : MARK_CELL
    ));
  }
  s = s.replace(/^[\u0000\u0001\u0002]+/, '').replace(/[\u0000\u0001\u0002]+$/, '');
  s = s.replace(/\u0000/g, '\n\n').replace(/\u0001/g, '\n').replace(/\u0002/g, ' | ');
  s = s.replace(/\r\n?/g, '\n').replace(ZERO_WIDTH_RE, '').replace(UNICODE_SPACE_RE, ' ');
  s = s.replace(/[^\S\n]+/g, ' ');

  const lines = [];
  for (const rawLine of s.split('\n')) {
    let line = rawLine.replace(/[^\S\n]+/g, ' ').replace(/\s*\|\s*$/, '').trim();
    if (!line || isPunctuationOnly(line)) { lines.push(''); continue; }
    lines.push(line);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '');
}

/**
 * 去掉重复出现的尾部样板行（页脚版权、重复声明等）。
 * 只处理“尾部区域”且出现 2 次以上的行，保留首次出现。
 */
function dedupeTrailing(lines) {
  const counts = new Map();
  for (const l of lines) if (l) counts.set(l, (counts.get(l) || 0) + 1);
  const tailStart = Math.max(0, lines.length - Math.max(5, Math.ceil(lines.length * 0.25)));
  const seen = new Set();
  const out = [];
  let removed = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    const l = lines[idx];
    if (!l) { out.push(l); continue; }
    const c = counts.get(l) || 1;
    const repeated = c >= 2 && l.length >= 6;
    if (repeated) {
      if (idx >= tailStart && seen.has(l)) { removed++; continue; }
      seen.add(l);
    }
    out.push(l);
  }
  return { lines: out, removed };
}

// ---------------------------------------------------------------------------
// 回退策略
// ---------------------------------------------------------------------------

/** 深度优先查找第一个指定标签的元素 */
function findFirstTag(root, tag) {
  const stack = [root];
  while (stack.length) {
    const nd = stack.pop();
    if (nd.dropped) continue;
    if (nd.type === 'element' && nd.tag === tag) return nd;
    for (let k = (nd.children || []).length - 1; k >= 0; k--) stack.push(nd.children[k]);
  }
  return null;
}

/** 收集顶层语义容器（article / main / [role=main]），不重复收集嵌套项 */
function findSemantic(root) {
  const found = [];
  const stack = [root];
  while (stack.length) {
    const nd = stack.pop();
    if (nd.dropped || nd.type === 'text') continue;
    const role = String((nd.attrs && nd.attrs.role) || '').toLowerCase();
    const hit = nd.tag === 'article' || nd.tag === 'main' || role === 'main';
    if (hit && quickTextLen(nd) > 0) { found.push(nd); continue; }
    for (let k = nd.children.length - 1; k >= 0; k--) stack.push(nd.children[k]);
  }
  return found;
}

/**
 * 把 body 切成不重叠的块级区块：
 *   有“带文本的块级子元素”则下钻；否则自身就是一块。
 * 这样既避免重复计数，也避免丢失文本。使用显式栈以承受任意深度的嵌套。
 */
function collectChunks(root, stats, out) {
  const work = [root];
  while (work.length) {
    const el = work.pop();
    const s = stats.get(el);
    if (!s || s.textLen === 0) continue;
    const blockKids = [];
    let inlineLen = 0;
    for (const ch of el.children || []) {
      if (!ch) continue;
      if (ch.type === 'text') {
        // 仅缩进/换行等纯空白不算“有效行内文本”，否则 body 会被整体当成一块
        if (/\S/.test(ch.value || '')) inlineLen += ch.value.length;
        continue;
      }
      if (ch.type !== 'element' || ch.dropped) continue;
      const cs = stats.get(ch);
      if (!cs || cs.textLen === 0) continue;
      if (BLOCKY_TAGS.has(ch.tag)) blockKids.push(ch);
      else inlineLen += cs.textLen;
    }
    if (blockKids.length === 0 || inlineLen > 0) { out.push(el); continue; }
    // 逆序入栈，保证出栈顺序即文档顺序（密度连续段依赖顺序）
    for (let i = blockKids.length - 1; i >= 0; i--) work.push(blockKids[i]);
  }
}

/**
 * 密度策略：对块级区块按“散文密度”做最大连续子段和（Kadane），
 * 捞出一段最像正文的连续区块。适合正文就是一个大 div / 一长串兄弟 div 的单页协议。
 */
function densityExtract(body, stats) {
  const chunks = [];
  collectChunks(body, stats, chunks);
  if (!chunks.length) return '';
  const scored = [];
  for (const nd of chunks) {
    const s = stats.get(nd) || { textLen: 0, punctCount: 0, linkTextLen: 0, paraTextLen: 0 };
    const len = s.textLen;
    if (!len) continue;
    const linkDensity = s.linkTextLen / len;
    const punctDensity = s.punctCount / len;
    const paraRatio = s.paraTextLen / len;
    // 纯文本块（无标点、无 p/li）得 0.35，仍高于阈值；纯链接块（≈0.05~0.15）会被排除
    const d = (1 - linkDensity) * (0.35 + Math.min(punctDensity / 0.04, 1) * 0.35 + paraRatio * 0.5);
    scored.push({ nd, len, d, value: len * (d - DENSITY_THRESHOLD) });
  }
  if (!scored.length) return '';

  // 密度阈值之上取“净收益”最大的连续段
  let best = null;
  let cur = null;
  for (let i = 0; i < scored.length; i++) {
    if (!cur || cur.sum <= 0) cur = { sum: scored[i].value, start: i, end: i };
    else { cur.sum += scored[i].value; cur.end = i; }
    if (!best || cur.sum > best.sum) best = { sum: cur.sum, start: cur.start, end: cur.end };
  }

  let run;
  if (best && best.sum > 0) {
    run = scored.slice(best.start, best.end + 1);
  } else {
    // 全部区块密度都低：从最优块向两侧扩展到密度尚可的邻居
    let bi = 0;
    for (let i = 1; i < scored.length; i++) {
      if (scored[i].len * scored[i].d > scored[bi].len * scored[bi].d) bi = i;
    }
    let lo = bi;
    let hi = bi;
    while (lo - 1 >= 0 && scored[lo - 1].d >= 0.25) lo--;
    while (hi + 1 < scored.length && scored[hi + 1].d >= 0.25) hi++;
    run = scored.slice(lo, hi + 1);
  }
  return finalizeText(renderText(run.map((r) => r.nd)));
}

// ---------------------------------------------------------------------------
// 标题提取
// ---------------------------------------------------------------------------

/** 取元素子树里的纯文本（用于 title / h1） */
function rawTextOf(node) {
  let s = '';
  const stack = [node];
  while (stack.length) {
    const nd = stack.pop();
    if (!nd || nd.dropped) continue;
    if (nd.type === 'text') { s += nd.value || ''; continue; }
    for (let k = (nd.children || []).length - 1; k >= 0; k--) stack.push(nd.children[k]);
  }
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

/** 采集标题相关的原始信息 */
function collectTitleInfo(root) {
  const info = { titleTag: '', og: '', twitter: '', h1s: [] };
  const stack = [root];
  while (stack.length) {
    const nd = stack.pop();
    if (nd.type === 'text') continue;
    if (nd.tag === 'title') {
      if (!info.titleTag) info.titleTag = rawTextOf(nd);
      continue;
    }
    if (nd.tag === 'meta') {
      const p = String(nd.attrs.property || nd.attrs.name || '').toLowerCase();
      const c = decodeEntities(String(nd.attrs.content || '')).replace(/\s+/g, ' ').trim();
      if (p === 'og:title' && !info.og && c) info.og = c;
      if (p === 'twitter:title' && !info.twitter && c) info.twitter = c;
      continue;
    }
    if (nd.tag === 'h1') info.h1s.push(nd);
    for (let k = nd.children.length - 1; k >= 0; k--) stack.push(nd.children[k]);
  }
  return info;
}

function isAncestorOrSelf(maybeAncestor, node) {
  let cur = node;
  while (cur) {
    if (cur === maybeAncestor) return true;
    cur = cur.parent;
  }
  return false;
}

/** 从 <title> 中剥离站点后缀，优先取命中协议语义的那一段 */
function cleanTitleTag(title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const parts = t.split(/\s*[|\-–—_·»>]\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return t;
  const hit = parts.find((p) => AGREEMENT_HINT_RE.test(p));
  if (hit) return hit;
  return parts.reduce((a, b) => (b.length > a.length ? b : a), parts[0]);
}

/** 选标题：内容区 h1 > 命中协议语义的候选 > 任意 h1 > og:title > title */
function pickTitle(info, contentNode) {
  const h1s = info.h1s.filter((h) => !h.dropped);
  const h1Texts = h1s.map((h) => ({ node: h, text: rawTextOf(h) })).filter((x) => x.text);
  const inContent = contentNode
    ? h1Texts.find((x) => isAncestorOrSelf(contentNode, x.node) || isAncestorOrSelf(x.node, contentNode))
    : null;
  if (inContent && inContent.text.length >= 2 && inContent.text.length <= 300) return inContent.text;

  const order = [
    h1Texts.length ? h1Texts[0].text : '',
    info.og,
    info.twitter,
    cleanTitleTag(info.titleTag),
  ].filter((x) => x && x.length >= 2 && x.length <= 300);
  const hinted = order.find((x) => AGREEMENT_HINT_RE.test(x));
  if (hinted) return hinted;
  if (h1Texts.length && h1Texts[0].text.length <= 300) return h1Texts[0].text;
  return order[0] || '';
}

// ---------------------------------------------------------------------------
// 纯文本 / Markdown 直通
// ---------------------------------------------------------------------------

/** 判断输入是否不含任何 HTML 标签 */
function hasAnyTag(html) {
  return /<[a-zA-Z!/?][^>]*>/.test(html);
}

/** 纯文本（含 Markdown）直通处理：只做必要的清洗，尽量原样保留 */
function plainTextResult(html, warnings) {
  let s = decodeEntities(html);
  s = s.replace(ZERO_WIDTH_RE, '').replace(UNICODE_SPACE_RE, ' ').replace(/\r\n?/g, '\n');
  s = s.replace(/^\uFEFF/, '');
  s = s.split('\n').map((l) => l.replace(/[^\S\n]+/g, ' ').replace(/\s+$/, '')).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '');
  let title = '';
  const m = /^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/m.exec(s);
  if (m) title = m[1].trim();
  warnings.push('输入内容不含 HTML 标签，已按纯文本处理');
  if (s.length < MIN_TEXT) warnings.push('页面正文过短，可能由前端动态渲染，建议直接粘贴文本');
  return {
    text: s,
    title,
    meta: { strategy: 'whole-document', candidates: [], warnings },
  };
}

/** 失败 / 空输入时的结构化返回，保证永不抛错 */
function failureResult(reason) {
  return {
    text: '',
    title: '',
    meta: { strategy: 'whole-document', candidates: [], warnings: [reason] },
  };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 从 HTML 中提取协议正文。
 * @param {string} html 原始 HTML 源码
 * @param {{ url?: string, baseUrl?: string }} [opts] 预留：用于解析相对链接等（当前不影响正文提取）
 * @returns {{ text: string, title: string, meta: { strategy: string, candidates: Array<{label:string, score:number, chars:number}>, warnings: string[] } }}
 */
export function extractMainText(html, opts = {}) {
  try {
    if (typeof html !== 'string' || html.trim() === '') {
      return failureResult('输入为空或不是字符串，未提取到正文');
    }
    void opts; // 当前实现不依赖 URL；保留签名以兼容调用方

    const warnings = [];

    // 纯文本 / Markdown：无标签时直通
    if (!hasAnyTag(html)) return plainTextResult(html, warnings);

    const parsed = parseHTML(html);
    if (parsed.malformed) warnings.push('页面结构存在畸形或未闭合标签，已启用容错解析');
    const root = parsed.root;

    const titleInfo = collectTitleInfo(root); // 必须在移除前采集
    applyRemoval(root, warnings);

    const stats = computeStats(root);
    const { list, byNode } = scoreCandidates(root, stats);
    // 候选块打分：排除 body/root（它们留给兜底策略）
    const primary = list.filter((c) => c.node.tag !== 'body' && c.node.tag !== 'html' && c.node.tag !== 'root');
    const publicSource = primary.length ? primary : list;
    const publicCandidates = publicSource.slice(0, MAX_CANDIDATES).map((c) => ({
      label: c.label,
      score: Math.round(c.total * 10) / 10,
      chars: c.chars,
    }));

    let text = '';
    let strategy = 'whole-document';
    let contentNode = null;

    // 1) 候选块打分：从高分往下试，取第一个能渲染出足够正文的候选
    const eligible = primary.filter((c) => c.chars >= MIN_TEXT).slice(0, 5);
    for (const cand of eligible) {
      const winner = refineWinner(byNode, cand);
      const t = finalizeText(renderText(winner.node));
      if (t.length >= Math.min(MIN_TEXT, cand.chars * 0.5)) {
        text = t;
        strategy = 'candidate-scoring';
        contentNode = winner.node;
        break;
      }
    }

    // 2) 语义标签：article / main / [role=main]
    if (!text) {
      const semantic = findSemantic(root);
      if (semantic.length) {
        const t = finalizeText(renderText(semantic));
        if (t.length >= MIN_TEXT) {
          text = t;
          strategy = 'semantic';
          contentNode = semantic[0];
          warnings.push('未找到可靠的候选容器，已按 <article>/<main> 语义标签提取正文');
        }
      }
    }

    // 3) 密度策略（单页协议常见：正文是一堆兄弟 div）
    if (!text) {
      const body = findFirstTag(root, 'body') || root;
      const t = densityExtract(body, stats);
      if (t.length >= MIN_TEXT) {
        text = t;
        strategy = 'density';
        warnings.push('未匹配到协议类名/ID，已使用正文密度算法提取');
      }
    }

    // 4) body 兜底
    if (!text) {
      const body = findFirstTag(root, 'body');
      if (body) {
        const t = finalizeText(renderText(body));
        if (t) {
          text = t;
          strategy = 'body-fallback';
          warnings.push('候选打分与密度算法均未得到足够正文，已回退到 body 全文');
        }
      }
    }

    // 5) 整页兜底
    if (!text) {
      text = finalizeText(renderText(root));
      strategy = 'whole-document';
      warnings.push('未能定位正文容器，已返回整页文本');
    }

    // 尾部重复样板去重
    const dd = dedupeTrailing(text.split('\n'));
    if (dd.removed > 0) {
      text = dd.lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '');
      warnings.push('检测到重复的页脚/样板文本，已去重 ' + dd.removed + ' 行');
    }

    if (text.length < MIN_TEXT) {
      warnings.push('页面正文过短，可能由前端动态渲染，建议直接粘贴文本');
    }

    const title = pickTitle(titleInfo, contentNode);

    return {
      text,
      title,
      meta: { strategy, candidates: publicCandidates, warnings },
    };
  } catch (err) {
    const msg = err && err.message ? err.message : '未知错误';
    return failureResult('HTML 解析失败（' + msg + '），已返回空文本');
  }
}

export default extractMainText;
