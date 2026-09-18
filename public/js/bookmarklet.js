/**
 * 「抓取书签」生成器。
 *
 * 单独成模块是为了**可测试**：书签脚本是一段以字符串形式嵌进 URL 的 JS，
 * 一旦里面有转义错误，浏览器点下去只会静默失败（连报错都没有），极难排查。
 * 因此这里用 String.raw 彻底避免转义被提前处理，并在测试里做语法校验。
 *
 * 【为什么书签要往多个地址发】
 * 应用可能通过 `127.0.0.1:8787` 打开，也可能通过 WSL 的 IP（如 `172.23.x.x:8787`）打开。
 * 如果书签只写死其中一个，一旦访问方式变了（换了服务、WSL 重启导致 IP 变化，
 * 或者同时存在 Windows / WSL 两份服务），书签就会"点了没反应"。
 * 所以这里把候选地址**都**打进去，点一次同时投递，哪个在跑哪个就收到。
 */

/** 整理出所有值得一试的目标地址（去重、只保留合法 origin） */
export function resolveTargets(origin, extraOrigins = []) {
  const out = []
  const add = (u) => {
    try {
      const n = new URL(u).origin
      if (n && n !== 'null' && !out.includes(n)) out.push(n)
    } catch {
      /* 忽略非法地址 */
    }
  }

  add(origin)

  // 同一端口的 127.0.0.1：无论页面是从哪个地址打开的，本机回环地址都值得一试
  try {
    const u = new URL(origin)
    const port = u.port || (u.protocol === 'https:' ? '443' : '80')
    add(`http://127.0.0.1:${port}`)
  } catch {
    /* origin 非法时跳过 */
  }

  for (const e of extraOrigins ?? []) add(e)

  // 兜底：万一一个都没解析出来（origin 非法等），也至少留一个默认地址，
  // 否则书签会变成"点了什么都不做"——那是最难排查的失败形态。
  if (out.length === 0) out.push('http://127.0.0.1:8787')
  return out
}

/**
 * 生成书签地址。
 *
 * 关键设计：
 *  - 用 `document.body.innerText`（渲染后的可见文本）而不是 HTML ——
 *    SPA、登录态、懒加载全都天然解决。
 *  - `mode: 'no-cors'` + `Content-Type: text/plain` 构成「简单请求」，不触发 CORS 预检。
 *  - 用 String.raw 包裹：里面的 `\n` 必须原样传给浏览器解释，
 *    不能被模板字符串先吃掉（这正是一个曾经导致书签完全失效的坑）。
 *
 * @param {string} origin 当前页面地址，如 http://127.0.0.1:8787
 * @param {string[]} [extraOrigins] 额外候选地址
 * @returns {string} 以 javascript: 开头、已编码的书签地址
 */
export function buildBookmarklet(origin, extraOrigins = []) {
  const targets = resolveTargets(origin, extraOrigins)

  const script = String.raw`(function(){
  try{
    var t=document.title||'';
    var u=location.href;
    var s=window.getSelection?window.getSelection().toString():'';
    var b=(s&&s.length>300)?s:((document.body&&document.body.innerText)||'');
    b=b.replace(/\n{3,}/g,'\n\n').trim();
    if(!b||b.length<50){alert('没有取到页面内容。请确认页面已加载完成，或先手动选中协议正文再点书签。');return}
    if(b.length>300000){b=b.slice(0,300000)}
    var targets=${JSON.stringify(targets)};
    var body=JSON.stringify({title:t,url:u,text:b});
    var reqs=targets.map(function(base){
      return fetch(base+'/api/ingest',{method:'POST',mode:'no-cors',headers:{'Content-Type':'text/plain'},body:body});
    });
    Promise.allSettled(reqs).then(function(rs){
      var ok=rs.filter(function(r){return r.status==='fulfilled'}).length;
      if(ok>0){
        alert('已发送到「协议阅读器」：'+b.length+' 字。\n回到应用页面即可载入（若没自动出现，点「手动检查新内容」）。');
      }else{
        alert('发送失败：所有候选地址都不可达。\n\n请确认应用正在运行，并检查应用地址是否为下面之一：\n'+targets.join('\n')+'\n\n也可以直接 Ctrl+A / Ctrl+C 复制正文，回到应用里粘贴。');
      }
    });
  }catch(e){alert('发送失败：'+e.message)}
})()`

  return 'javascript:' + encodeURIComponent(script)
}

/** 供测试与界面提示使用：返回未编码的脚本本体 */
export function bookmarkletSource(origin, extraOrigins = []) {
  return decodeURIComponent(buildBookmarklet(origin, extraOrigins).replace(/^javascript:/, ''))
}
