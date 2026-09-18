/**
 * test/html.test.js
 * 协议正文提取器的测试（node:test + node:assert/strict，零依赖）。
 * 运行：node --test test/html.test.js 或 node --test test/
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractMainText } from '../src/extract/html.js';

const VALID_STRATEGIES = new Set([
  'candidate-scoring', 'semantic', 'density', 'body-fallback', 'whole-document',
]);

/** 通用形状断言：meta.strategy / meta.candidates / meta.warnings */
function assertResultShape(result) {
  assert.equal(typeof result, 'object');
  assert.equal(typeof result.text, 'string');
  assert.equal(typeof result.title, 'string');
  assert.equal(typeof result.meta, 'object');
  assert.ok(VALID_STRATEGIES.has(result.meta.strategy), '未知策略: ' + result.meta.strategy);
  assert.ok(Array.isArray(result.meta.candidates), 'candidates 必须是数组');
  assert.ok(result.meta.candidates.length <= 10, 'candidates 最多 10 条');
  let prev = Infinity;
  for (const c of result.meta.candidates) {
    assert.equal(typeof c.label, 'string');
    assert.equal(typeof c.score, 'number');
    assert.equal(typeof c.chars, 'number');
    assert.ok(Number.isFinite(c.score) && Number.isFinite(c.chars));
    assert.ok(c.score <= prev + 1e-9, 'candidates 必须按 score 降序');
    prev = c.score;
  }
  assert.ok(Array.isArray(result.meta.warnings), 'warnings 必须是数组');
  for (const w of result.meta.warnings) assert.equal(typeof w, 'string');
}

// ---------------------------------------------------------------------------
// 1) 真实页面：导航 / 页眉 / Cookie 横幅 / 侧栏相关推荐 / 广告 / 页脚
// ---------------------------------------------------------------------------

const REALISTIC_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <title>示例网用户服务协议 - 示例网</title>
  <meta property="og:title" content="示例网用户服务协议">
  <meta name="twitter:title" content="示例网用户服务协议">
  <script>var a = 1 < 2; var s = "</div>";</script>
  <style>.nav { color: red; }</style>
</head>
<body>
  <nav class="main-nav">
    <ul>
      <li><a href="/">首页</a></li>
      <li><a href="/about">关于我们</a></li>
      <li><a href="/product">产品中心</a></li>
      <li><a href="/community">开源社区</a></li>
      <li><a href="/jobs">加入我们</a></li>
    </ul>
  </nav>
  <header class="site-header">
    <h1>示例网</h1>
    <div class="topbar"><a href="/login">登录入口</a> <a href="/signup">注册新账号</a></div>
  </header>
  <div class="cookie-consent-banner">本站使用 Cookie 以改善体验<button>同意</button></div>
  <div id="advertisement-top"><a href="/ad">立即抢购超值会员</a></div>
  <div class="container">
    <aside class="sidebar related-posts">
      <h3>相关推荐</h3>
      <ul>
        <li><a href="/a">如何注销账号</a></li>
        <li><a href="/b">如何修改绑定手机</a></li>
      </ul>
    </aside>
    <div class="content">
      <div class="terms-content">
        <h1>示例网用户服务协议</h1>
        <p>第一条 本协议是您与示例网之间就使用示例网各项服务所订立的协议。请您在注册、登录或使用本服务前，仔细阅读并充分理解本协议全部内容，特别是以粗体标注的免责条款、责任限制条款与争议解决条款。</p>
        <p>第二条 您确认，在您完成注册程序或以其他方式使用本服务时，您应当是具备完全民事权利能力和完全民事行为能力的自然人、法人或其他组织。若您不具备前述主体资格，请勿使用本服务，否则您及您的监护人应承担相应责任。</p>
        <p>3.1 本协议中的 content 一词指您通过本服务上传、发布或传输的任何文字、图片、音频、视频等信息。您应保证对上述内容享有合法权利，且不侵犯任何第三方的合法权益。</p>
        <table>
          <tbody>
            <tr><td>3.2</td><td>您理解并同意，本服务按“现状”提供，我们不对服务的及时性、安全性作出保证。</td></tr>
          </tbody>
        </table>
        <p>第四条 您承诺不利用本服务从事下列行为：</p>
        <ul>
          <li>（a）发布、传送、传播违法信息；</li>
          <li>（b）侵害他人合法权益；</li>
          <li>（c）干扰本服务的正常运行。</li>
        </ul>
        <p>第五条 我们非常重视用户信息的保护。您在使用本服务的过程中，可能需要提供一些必要的信息，例如您的手机号码、电子邮箱等。我们将按照法律法规的要求，采取加密等合理的安全措施保护您的个人信息。</p>
        <p>第六条 本协议适用中华人民共和国大陆地区法律。因本协议产生的争议，双方应友好协商解决；协商不成的，任何一方均可向被告住所地有管辖权的人民法院提起诉讼。</p>
      </div>
    </div>
  </div>
  <footer class="site-footer">
    <p>版权所有 © 2024 示例网</p>
    <div class="newsletter">订阅我们的新闻通讯</div>
    <a href="/privacy">隐私政策</a>
  </footer>
</body>
</html>`;

test('真实页面：抽出协议正文，剔除导航/横幅/相关推荐/页脚', () => {
  const r = extractMainText(REALISTIC_PAGE, { url: 'https://example.com/terms' });
  assertResultShape(r);

  // 命中正文
  assert.ok(r.text.includes('本协议是您与示例网之间'), '应包含第一条正文');
  assert.ok(r.text.includes('第二条'), '应包含第二条');
  assert.ok(r.text.includes('具备完全民事权利能力'), '应包含第二条正文');
  assert.ok(r.text.includes('content 一词指您通过本服务上传'), '不得因出现 content 就丢弃条款');

  // 条款编号与列表项
  assert.ok(r.text.includes('3.1 本协议中的 content'), '3.1 编号应保留在行首');
  assert.ok(r.text.includes('3.2 | 您理解并同意'), '表格单元格应以 | 连接');
  assert.ok(r.text.includes('（a）发布、传送、传播违法信息；\n（b）侵害他人合法权益；'), '列表项应以单个换行分隔');
  assert.ok(/\n\n/.test(r.text), '段落之间应以空行分隔');
  assert.ok(/第一条[^\n]*\n\n第二条/.test(r.text), '相邻段落应形成 \\n\\n 分隔');

  // 排除样板
  assert.ok(!r.text.includes('关于我们'), '应剔除导航');
  assert.ok(!r.text.includes('产品中心'), '应剔除导航');
  assert.ok(!r.text.includes('登录入口'), '应剔除页眉登录区');
  assert.ok(!r.text.includes('注册新账号'), '应剔除页眉注册区');
  assert.ok(r.text.includes('仔细阅读并充分理解'), '正文中的“登录/注册”等词不应导致条款被丢弃');
  assert.ok(!r.text.includes('本站使用 Cookie'), '应剔除 Cookie 横幅');
  assert.ok(!r.text.includes('立即抢购超值会员'), '应剔除广告');
  assert.ok(!r.text.includes('相关推荐'), '应剔除侧栏');
  assert.ok(!r.text.includes('如何注销账号'), '应剔除相关推荐链接');
  assert.ok(!r.text.includes('版权所有'), '应剔除页脚');
  assert.ok(!r.text.includes('订阅我们的新闻通讯'), '应剔除页脚订阅框');
  assert.ok(!r.text.includes('var a = 1'), '应剔除脚本');

  assert.equal(r.meta.strategy, 'candidate-scoring');
  assert.ok(r.meta.candidates.length > 0, '候选列表不应为空');
  assert.ok(r.title.includes('协议'), '标题应包含“协议”，实际: ' + r.title);
  assert.equal(r.title, '示例网用户服务协议');
});

// ---------------------------------------------------------------------------
// 2) 无任何有用类名：正文是一串兄弟 div，逼迫密度策略胜出
// ---------------------------------------------------------------------------

const CLAUSES = [
  '第一条 您在注册时应当提供真实、准确、完整的个人资料，并在资料变更时及时更新。若您提供的资料不真实、不准确或不完整，我们有权暂停或终止向您提供服务，由此产生的一切后果由您自行承担。',
  '第二条 您应妥善保管账号及密码，并对该账号下发生的一切行为负责。因您保管不善导致的损失，本平台不承担任何责任；如发现任何未经授权使用您账号的情形，请立即通知我们。',
  '第三条 您不得利用本服务制作、复制、发布、传播含有下列内容的信息：反对宪法所确定的基本原则的；危害国家安全、泄露国家秘密的；煽动民族仇恨、破坏民族团结的。',
  '第四条 我们可能根据业务需要修改本条款，并通过站内公告、站内信或电子邮件等方式通知您。若您在条款变更后继续使用本服务，即视为您已接受修改后的条款。',
  '第五条 我们将按照法律法规的要求收集、使用、存储和共享您的个人信息，并采取加密、访问控制等合理的安全措施，防止您的个人信息被未经授权地访问、披露或丢失。',
  '第六条 本服务可能包含第三方网站或资源的链接，我们对这些第三方网站的内容、隐私政策或行为不承担任何责任，请您自行判断并承担相应风险。',
  '第七条 因本条款引起的或与本条款有关的任何争议，双方应首先友好协商解决；协商不成的，任何一方均可向有管辖权的人民法院提起诉讼，本条款适用中华人民共和国法律。',
  '第八条 本条款自您点击同意或以其他方式使用本服务之日起生效，直至您停止使用本服务或我们终止向您提供本服务之日终止。',
];

const NO_CLASS_PAGE = `<html><head><title>平台服务条款</title></head>
<body>
  <div><a href="/">站点首页</a> <a href="/pricing">价格方案</a> <a href="/docs">开发文档</a> <a href="/blog">技术博客</a> <a href="/careers">招聘信息</a></div>
${CLAUSES.map((c) => '  <div>' + c + '</div>').join('\n')}
  <div><a href="/sitemap">网站地图</a> <a href="/contact">联系方式</a></div>
</body></html>`;

test('无有用类名：密度策略胜出并保持精度', () => {
  const r = extractMainText(NO_CLASS_PAGE);
  assertResultShape(r);

  assert.equal(r.meta.strategy, 'density');
  assert.ok(r.text.includes('第一条 您在注册时应当提供真实'));
  assert.ok(r.text.includes('第八条 本条款自您点击同意'));
  for (let i = 0; i < CLAUSES.length; i++) {
    assert.ok(r.text.includes(CLAUSES[i].slice(0, 24)), '应包含第 ' + (i + 1) + ' 条');
  }
  // 纯链接块必须被密度算法排除
  assert.ok(!r.text.includes('价格方案'), '应排除链接导航块');
  assert.ok(!r.text.includes('网站地图'), '应排除尾部链接块');
  // 每个候选块都不足 400 字，说明候选打分确实让位给密度策略
  assert.ok(r.meta.candidates.every((c) => c.chars < 400));
  assert.ok(r.meta.warnings.some((w) => w.includes('密度')));
});

// ---------------------------------------------------------------------------
// 3) 大量实体编码 + 嵌套行内标签
// ---------------------------------------------------------------------------

const ENTITY_PAGE = `<html><head><title>隐私政策 - 示例网</title></head>
<body>
  <div class="privacy-policy">
    <p>第一条&nbsp;本政策适用于&#x4e2d;&#25991;用户 &amp; 访客。我们收集的信息包括&hellip;&mdash;&ldquo;设备信息&rdquo;、IP &#39;地址&#39;、浏览器类型与操作系统版本等，用于保障服务的安全稳定运行与持续优化体验。</p>
    <p><strong>3.1</strong> 您可发送邮件至 <a href="mailto:privacy@example.com">privacy&#64;example.com</a> 以行使查阅、更正、删除个人信息的权利。我们将在收到您的请求后尽快处理，并在十五个工作日内向您反馈处理结果与相关说明。</p>
    <p>3.2 &lt;script&gt; 等标签中的内容不会被当作代码执行；我们使用 &middot; 分隔的列表记录处理目的与对应的信息类型，并仅在实现这些目的所必需的范围内使用您的个人信息。</p>
    <p>3.3 若您对我们的答复不满意，您还可以向&#x4e2d;&#x56fd;监管部门投诉，或依照法律规定向人民法院提起诉讼，以维护自身合法权益。我们尊重并保障您依法享有的每一项权利。</p>
    <p>3.4 我们会在实现处理目的所必需的最短期限内保存您的个人信息，超出保存期限后将予以删除或匿名化处理，法律法规另有规定的除外。若您注销账号，我们将在合理期限内完成删除或匿名化。</p>
  </div>
</body></html>`;

test('实体解码与嵌套行内标签', () => {
  const r = extractMainText(ENTITY_PAGE);
  assertResultShape(r);

  assert.equal(r.meta.strategy, 'candidate-scoring');
  assert.ok(r.text.includes('第一条 本政策适用于中文用户 & 访客'), '应解码实体并把 &nbsp; 变成普通空格，实际: ' + r.text.slice(0, 60));
  assert.ok(r.text.includes('…—“设备信息”、IP \'地址\'、浏览器类型'), '应解码 hellip/mdash/ldquo/rdquo/&#39;');
  assert.ok(r.text.includes('privacy@example.com'), '应解码 &#64;');
  assert.ok(r.text.includes('<script> 等标签中的内容不会被当作代码执行'), '应把 &lt;script&gt; 当普通文本');
  assert.ok(r.text.includes('·'), '应解码 middot');
  assert.ok(r.text.includes('向中国监管部门投诉'), '应解码十六进制实体（含中文）');
  assert.ok(r.text.startsWith('第一条'), '正文应以第一条开头');
  assert.equal(r.title, '隐私政策');
});

// ---------------------------------------------------------------------------
// 4) 畸形 / 未闭合标签：不抛错，仍能拿到内容
// ---------------------------------------------------------------------------

const MALFORMED_PAGE = `<html><head><title>未闭合协议</title></head><body>
<div class="terms-content"><h1>未闭合协议
<p>第一条 这是一个未闭合的段落，里面还有游离的 < 符号，以及未闭合的 <span>行内标签。
<div>第二条 这里有一个没有闭合的 div，后面跟着一些文字，用于验证容错解析不会丢掉后续内容，并且能够继续向下扫描。
<td>第三条<td>表格内容应当保持可读
<img src=x alt="未闭合属性" <div>
</body>
</article>
`;

test('畸形/未闭合标签不抛错且有合理输出', () => {
  let r;
  assert.doesNotThrow(() => { r = extractMainText(MALFORMED_PAGE); });
  assertResultShape(r);

  assert.ok(r.text.length > 0, '应至少拿到部分正文');
  assert.ok(r.text.includes('第一条 这是一个未闭合的段落'), '应保留第一条');
  assert.ok(r.text.includes('游离的 < 符号'), '游离的 < 应作为文本保留');
  assert.ok(r.text.includes('第二条'), '应保留第二条');
  assert.ok(r.text.includes('第三条'), '应保留表格中的第三条');
  assert.ok(r.meta.warnings.some((w) => w.includes('畸形')), '应给出畸形标签告警');
  assert.equal(r.title, '未闭合协议');
});

// ---------------------------------------------------------------------------
// 5) 纯文本 / Markdown 直通
// ---------------------------------------------------------------------------

test('纯文本直通', () => {
  const plain = '用户协议\n\n第一条 本协议是您与本站之间的约定。\n第二条 请遵守相关法律法规。\n';
  const r = extractMainText(plain);
  assertResultShape(r);
  assert.equal(r.meta.strategy, 'whole-document');
  assert.equal(r.meta.candidates.length, 0);
  assert.ok(r.text.includes('第一条 本协议是您与本站之间的约定。'));
  assert.ok(r.text.includes('第二条'));
  assert.ok(r.meta.warnings.some((w) => w.includes('纯文本')));
});

test('Markdown 直通并取标题', () => {
  const md = '# 隐私政策\n\n第一条 我们收集的必要信息包括账号与设备信息。\n\n第二条 您可以随时联系客服注销账号。';
  const r = extractMainText(md);
  assertResultShape(r);
  assert.equal(r.meta.strategy, 'whole-document');
  assert.equal(r.title, '隐私政策');
  assert.ok(r.text.includes('第一条 我们收集的必要信息'));
});

// ---------------------------------------------------------------------------
// 6) 重复尾部样板去重
// ---------------------------------------------------------------------------

test('重复尾部样板去重', () => {
  const repeated = '本协议自发布之日起生效。';
  const html = '<html><head><title>去重测试</title></head><body><div class="terms-content">'
    + '<p>第一条 本协议是您与本站之间的约定，请您仔细阅读并遵守相关约定内容，特别是免责条款与责任限制条款。</p>'
    + '<p>第二条 我们将按照法律法规的要求保护您的个人信息，并采取合理的安全措施防止信息被未经授权地访问。</p>'
    + '<p>' + repeated + '</p><p>' + repeated + '</p><p>' + repeated + '</p>'
    + '</div></body></html>';
  const r = extractMainText(html);
  assertResultShape(r);
  const occurrences = r.text.split(repeated).length - 1;
  assert.equal(occurrences, 1, '重复的尾部样板只应保留一次');
  assert.ok(r.meta.warnings.some((w) => w.includes('去重')));
});

// ---------------------------------------------------------------------------
// 7) 健壮性：空输入 / 非字符串 / 非法入参
// ---------------------------------------------------------------------------

test('空输入与非字符串输入不抛错', () => {
  for (const input of ['', '   ', null, undefined, 42, {}, []]) {
    let r;
    assert.doesNotThrow(() => { r = extractMainText(input); });
    assert.equal(r.text, '');
    assert.equal(r.title, '');
    assert.equal(r.meta.strategy, 'whole-document');
    assert.deepEqual(r.meta.candidates, []);
    assert.ok(r.meta.warnings.length > 0);
    for (const w of r.meta.warnings) assert.equal(typeof w, 'string');
  }
});

test('过短正文会给出中文降级告警', () => {
  const r = extractMainText('<html><body><div class="terms-content"><p>第一条 短协议。</p></div></body></html>');
  assertResultShape(r);
  assert.ok(r.meta.warnings.some((w) => w.includes('页面正文过短')), '应提示正文过短');
});

// ---------------------------------------------------------------------------
// 8) 标题优先级：正文区 h1 > 页眉 h1 / <title>
// ---------------------------------------------------------------------------

test('标题优先取正文区 h1', () => {
  const html = '<html><head><title>某某服务条款 - 某某网站首页</title></head><body>'
    + '<header class="site-header"><h1>某某网站首页</h1></header>'
    + '<main><h1>某某服务条款</h1><p>' + CLAUSES[0] + CLAUSES[1] + '</p></main>'
    + '<footer class="site-footer"><p>版权所有</p></footer></body></html>';
  const r = extractMainText(html);
  assertResultShape(r);
  assert.equal(r.title, '某某服务条款');
  assert.ok(r.text.includes('第一条 您在注册时应当提供真实'));
  assert.ok(!r.text.includes('某某网站首页'));
});

test('无 h1 时从 <title> 剥离站点后缀并识别协议语义', () => {
  const html = '<html><head><title>服务条款 | 某某开放平台</title></head><body>'
    + '<div class="legal-doc">' + CLAUSES.map((c) => '<p>' + c + '</p>').join('') + '</div>'
    + '</body></html>';
  const r = extractMainText(html);
  assertResultShape(r);
  assert.equal(r.title, '服务条款');
});

// ---------------------------------------------------------------------------
// 9) 候选项过多时截断为 10 条并保持降序
// ---------------------------------------------------------------------------

test('候选过多时截断为 10 条', () => {
  const sections = [];
  for (let i = 0; i < 15; i++) {
    sections.push('<div class="terms-section">第' + (i + 1) + '条 '
      + '本条用于测试候选块数量上限，包含足够多的中文标点，以便标点密度与段落文本比例能够被正确计算。'
      + '您理解并同意，本条款仅用于测试目的，不构成任何真实的法律约定或承诺。</div>');
  }
  const html = '<html><head><title>候选上限测试</title></head><body>' + sections.join('') + '</body></html>';
  const r = extractMainText(html);
  assertResultShape(r);
  assert.equal(r.meta.candidates.length, 10);
  assert.ok(r.meta.candidates.every((c) => c.label.startsWith('div.')));
  assert.equal(r.meta.strategy, 'density');
});

// ---------------------------------------------------------------------------
// 10) 密度策略的召回：夹在长条款之间的短小条款/标题块不能被丢弃
// ---------------------------------------------------------------------------

test('密度策略不丢短小条款块', () => {
  const html = '<html><head><title>短条款测试</title></head><body>'
    + '<div><a href="/">首页导航链接</a> <a href="/x">其他导航链接</a></div>'
    + '<div>第一条 定义</div>'
    + CLAUSES.slice(0, 5).map((c) => '<div>' + c + '</div>').join('')
    + '</body></html>';
  const r = extractMainText(html);
  assertResultShape(r);
  assert.equal(r.meta.strategy, 'density');
  assert.ok(r.text.includes('第一条 定义'), '短小条款块不应被密度阈值丢弃');
  assert.ok(r.text.includes('第二条 您应妥善保管账号及密码'));
  assert.ok(!r.text.includes('首页导航链接'), '纯链接块应被排除');
});
