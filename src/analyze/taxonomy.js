/**
 * 风险条款分类体系（Taxonomy）
 *
 * 这是本产品的领域知识核心：把「用户协议里的坑」结构化成可枚举的类别，
 * 让模型输出稳定的 category id，从而支持统计、过滤、着色与跨协议对比。
 *
 * signals 字段用于本地确定性预扫描（prescan）：不依赖模型即可发现明显的红旗措辞，
 * 既能把线索喂给模型提高召回，也能在模型不可用时提供基础降级结果。
 */

/** @typedef {'critical'|'high'|'medium'|'low'|'info'} Severity */

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']

export const SEVERITY_LABEL = {
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
  info: '提示',
}

/** 用于计算整体风险分的权重（0-100 量表） */
export const SEVERITY_WEIGHT = {
  critical: 26,
  high: 14,
  medium: 7,
  low: 3,
  info: 1,
}

/**
 * @type {Array<{
 *   id: string,
 *   label: string,
 *   group: string,
 *   baseline: Severity,
 *   what: string,
 *   why: string,
 *   signals: RegExp[]
 * }>}
 */
export const CATEGORIES = [
  {
    id: 'unilateral_change',
    label: '单方变更权',
    group: '控制权不对等',
    baseline: 'high',
    what: '平台可随时修改协议，且通常「继续使用即视为同意」，用户没有协商或拒绝的实际机会。',
    why: '你同意的其实是一份平台可以随时改写的合同，今天看到的条款不保证明天还有效。',
    signals: [
      /(有权|可以|保留).{0,12}(随时|单方面|单方|不经通知|无需通知|不另行通知).{0,12}(修改|变更|更新|调整|修订)/,
      /(修改|变更|更新).{0,10}(本协议|本条款|服务条款).{0,20}(无需|不需|不再|无须).{0,6}(另行)?通知/,
      /继续使用.{0,16}(视为|即表示|即构成).{0,10}(接受|同意|认可).{0,10}(修改|变更|更新)?/,
      /sole discretion to (modify|change|amend|update)/i,
      // 英文条款语序多变，两侧都放宽窗口，并覆盖 "this/these/the" 与 "from time to time"
      /(modify|amend|change|revise|update).{0,60}(terms|agreement|policy|conditions)/i,
      /(at any time|without notice|from time to time|sole discretion).{0,50}(modify|amend|change|revise|update)/i,
      /continued use.{0,40}(constitutes|means|shall constitute).{0,20}(accept|agree)/i,
    ],
  },
  {
    id: 'arbitration',
    label: '强制仲裁 / 管辖约定',
    group: '争议解决',
    baseline: 'high',
    what: '约定争议通过特定仲裁机构解决，或约定由平台所在地法院管辖，通常排除用户所在地法院。',
    why: '维权成本被显著抬高：你需要去外地、按仲裁规则预缴费用，且仲裁一裁终局、基本无法上诉。',
    signals: [
      /(仲裁委员会|仲裁机构).{0,20}(仲裁|解决)/,
      /(排他性|专属).{0,6}管辖/,
      /(由|提交).{0,16}(被告|原告)?(所在地|住所地)?(人民)?法院管辖/,
      /(一裁终局|终局裁决)/,
      /binding arbitration/i,
      /(exclusive|sole) jurisdiction/i,
      /waive.{0,20}(right to|jury trial)/i,
    ],
  },
  {
    id: 'class_action_waiver',
    label: '集体诉讼 / 集体维权放弃',
    group: '争议解决',
    baseline: 'high',
    what: '要求用户放弃以集体诉讼、集团仲裁方式维权的权利，只能单独主张。',
    why: '小额损害本来靠集体诉讼才有维权可能，放弃后个体几乎不可能单独起诉。',
    signals: [/集体诉讼/, /团体诉讼/, /class action/i, /(集团|集体).{0,6}仲裁/, /class-wide/i],
  },
  {
    id: 'data_sharing',
    label: '数据收集与第三方共享',
    group: '隐私与数据',
    baseline: 'high',
    what: '收集范围宽泛（如设备信息、位置、通讯录、使用行为），且可向「合作伙伴」「关联方」共享或出售。',
    why: '你的数据可能被用于精准营销、用户画像，甚至流转到你从未听说过的第三方。',
    signals: [
      /(共享|提供|披露|转让|出售|交易).{0,16}(第三方|关联方|合作伙伴|合作方|广告主)/,
      /(可能|将会|有权).{0,10}(收集|获取|采集).{0,20}(位置|通讯录|设备|行为|浏览|搜索|剪贴板)/,
      /(个性化|精准).{0,6}(广告|推荐|营销)/,
      /(share|sell|disclose|transfer|provide|disclose).{0,70}(third part|affiliat|partner|advertis|vendor|contractor|subsidiar)/i,
    ],
  },
  {
    id: 'liability_disclaimer',
    label: '免责条款 / 责任限制',
    group: '责任分配',
    baseline: 'high',
    what: '平台对服务中断、数据丢失、内容错误等不承担责任，或将赔偿上限压到极低。',
    why: '服务出问题时你很难追责；「按现状提供」意味着风险基本由你承担。',
    signals: [
      /(不承担|不负|免于|免除).{0,12}(任何|一切|全部)?(责任|赔偿责任)/,
      /(按|以).{0,6}(现状|现有).{0,4}(提供|状态)/,
      /(责任|赔偿).{0,8}(上限|限额|总额).{0,12}(不超过|以.{0,10}为限)/,
      /(indemnif|hold harmless)/i,
      /(as is|as available).{0,20}(without warrant|no warrant)/i,
      /(shall not be liable|disclaim).{0,40}(liabilit|warrant)/i,
    ],
  },
  {
    id: 'indemnity',
    label: '用户赔偿义务',
    group: '责任分配',
    baseline: 'medium',
    what: '要求用户因使用行为给平台造成的损失进行赔偿，包括第三方索赔与律师费。',
    why: '这是单向义务：你赔平台，平台未必赔你，且范围常常写得很宽。',
    signals: [/您(同意|应当|须).{0,12}(赔偿|补偿).{0,16}(损失|费用|律师费)/, /indemnify and hold harmless/i],
  },
  {
    id: 'auto_renewal',
    label: '自动续费 / 扣费',
    group: '费用与付费',
    baseline: 'high',
    what: '订阅到期自动扣费续期，或免费试用结束后自动转为付费，取消入口往往不明显。',
    why: '容易在不知情的情况下被持续扣款，且取消流程可能被刻意设计得很麻烦。',
    signals: [
      /自动(续费|续订|展期|延期)/,
      /(到期|期满).{0,8}自动.{0,6}(续|扣|展期)/,
      /(免费试用|试用期).{0,20}(结束|届满).{0,16}自动/,
      /自动扣(款|费|划)/,
      /(automatically renew|auto-renew)/i,
    ],
  },
  {
    id: 'refund',
    label: '退款与费用规则',
    group: '费用与付费',
    baseline: 'medium',
    what: '费用一经支付不予退还，或退款条件苛刻、需扣除手续费。',
    why: '误购、服务不达预期时难以挽回损失。',
    signals: [/(不(予|可|支持)|概不).{0,6}退(款|费|还)/, /(费用|款项).{0,10}(一经|一旦).{0,6}(支付|缴纳).{0,10}(不退|不予退还)/, /non-?refundable/i],
  },
  {
    id: 'content_license',
    label: '内容授权范围过宽',
    group: '知识产权',
    baseline: 'high',
    what: '你发布的内容被授予「全球、永久、免费、可转授权、可商用」的许可。',
    why: '你创作的内容可能被平台无偿商用、改编甚至再授权给他人，且难以撤回。',
    signals: [
      /(永久|无期限|不可撤销).{0,20}(许可|授权)/,
      /(全球|全世界).{0,10}(范围)?(内)?(的)?(免费|无偿|非独占|排他)?(许可|授权)/,
      /(可|有权).{0,8}(转授权|再许可|sublicense)/,
      /(免费|无偿).{0,10}(使用|商业)?(使用)?(您|用户).{0,6}(上传|发布|提供).{0,6}(内容|作品|素材)/,
      /perpetual,? irrevocable,? (worldwide|royalty-free)/i,
      /(sublicens|transferable).{0,20}licen[cs]e/i,
    ],
  },
  {
    id: 'ip_ownership',
    label: '知识产权归属',
    group: '知识产权',
    baseline: 'medium',
    what: '约定用户创作内容的权利归属平台，或对平台标识、内容的使用施加限制。',
    why: '你的创作成果可能不再属于你。',
    signals: [/(知识产权|著作权|所有权).{0,16}(归|属于).{0,10}(平台|本公司|我们|公司)/, /work made for hire/i],
  },
  {
    id: 'feedback_license',
    label: '反馈/建议的无偿授权',
    group: '知识产权',
    baseline: 'low',
    what: '你提交的建议、反馈可被平台自由使用且无需补偿。',
    why: '单独看影响有限，但常与内容授权条款叠加形成过度授权。',
    signals: [/(反馈|建议|意见).{0,20}(免费|无偿|无需).{0,10}(使用|采纳|许可)/, /feedback.{0,30}(without (obligation|compensation))/i],
  },
  {
    id: 'account_termination',
    label: '账号封禁与终止',
    group: '控制权不对等',
    baseline: 'high',
    what: '平台可自行判断是否违规并单方封禁、删除账号及数据，无需事先通知或说明理由。',
    why: '账号内的内容、余额、虚拟财产可能一并消失，且申诉渠道有限。',
    signals: [
      /(有权|可以).{0,12}(随时|立即|无需通知).{0,12}(暂停|终止|封禁|注销|删除).{0,10}(账号|账户|服务)/,
      /(自行|单方|全权).{0,6}(判断|认定).{0,16}(违规|违约|不当)/,
      /(不予|概不).{0,8}(退还|返还).{0,14}(余额|虚拟|费用|数据)/,
      /(terminate|suspend).{0,20}(account|access).{0,20}(at any time|without notice|sole discretion)/i,
    ],
  },
  {
    id: 'service_change',
    label: '服务变更与中止',
    group: '控制权不对等',
    baseline: 'medium',
    what: '服务可随时新增、修改、中止或下线，且不承担由此产生的损失。',
    why: '你依赖的服务可能消失，迁移成本由你承担。',
    signals: [/(有权|可以).{0,10}(随时|自行).{0,10}(中止|终止|中断|下线|停止).{0,10}(服务|全部|部分)/, /(discontinue|suspend).{0,20}service/i],
  },
  {
    id: 'unilateral_interpretation',
    label: '最终解释权 / 单方认定',
    group: '控制权不对等',
    baseline: 'high',
    what: '约定协议的解释权归平台，或由平台单方认定用户是否违约。',
    why: '规则的解释者是对方，争议时你处于天然劣势。注：此类格式条款在国内消费者合同中常被认定无效。',
    signals: [/(最终|唯一).{0,6}解释权/, /本(协议|条款).{0,10}的解释权.{0,8}归/, /final (interpretation|say)/i],
  },
  {
    id: 'privacy_tracking',
    label: '追踪与画像',
    group: '隐私与数据',
    baseline: 'medium',
    what: '使用 Cookie、SDK、设备指纹等跨站追踪技术进行行为分析。',
    why: '你的浏览行为可能被长期记录并与第三方数据合并。',
    signals: [/(Cookie|Cookies|SDK|设备标识|IMEI|OAID|IDFA).{0,24}(追踪|跟踪|识别|分析)/, /(跨(站|设备)|行为).{0,8}(追踪|跟踪)/, /(track|fingerprint).{0,20}(across|behaviou?r)/i],
  },
  {
    id: 'data_retention',
    label: '数据保留与删除',
    group: '隐私与数据',
    baseline: 'medium',
    what: '数据保留期限模糊，或注销后仍保留、无法彻底删除。',
    why: '你行使「删除权」时可能被以「法律法规要求」为由长期保留。',
    signals: [/(保留|存储).{0,16}(期限|期间).{0,10}(不明确|必要|法律)/, /(注销|删除).{0,20}(仍|继续).{0,10}(保留|保存)/, /(retain|retention).{0,20}(as required|necessary)/i],
  },
  {
    id: 'sensitive_data',
    label: '敏感个人信息',
    group: '隐私与数据',
    baseline: 'high',
    what: '涉及生物识别、医疗健康、金融账户、行踪轨迹、未成年人信息等敏感个人信息处理。',
    why: '敏感信息一旦泄露后果严重，且处理需单独同意。',
    signals: [/(人脸|面部识别|指纹|声纹|虹膜|生物识别)/, /(健康|医疗|病历)/, /(身份证|银行卡|金融账户|征信)/, /(行踪轨迹|精确定位)/, /biometric|health data/i],
  },
  {
    id: 'minor_consent',
    label: '未成年人保护',
    group: '特殊主体',
    baseline: 'medium',
    what: '对未成年人使用的年龄门槛与监护人同意的处理方式。',
    why: '若产品面向未成年人却未设置有效同意机制，家长权利与孩子信息都存在风险。',
    signals: [/(未满|不满).{0,4}(14|18|十六|十八).{0,4}(周岁|岁)/, /(监护人|法定代理人).{0,8}(同意|陪同)/, /(children|minor).{0,20}(under|consent)/i],
  },
  {
    id: 'user_content_responsibility',
    label: '用户内容担保责任',
    group: '责任分配',
    baseline: 'medium',
    what: '用户需保证上传内容合法且不侵权，并独自承担由此产生的全部责任。',
    why: '平台把内容合规风险全部转移给你。',
    signals: [/(保证|承诺).{0,16}(不(会)?(侵犯|违反)|合法).{0,16}(权利|法律)/, /(因此|由此).{0,10}产生.{0,10}(全部|一切).{0,6}责任.{0,6}(由您|由用户)/, /represent and warrant/i],
  },
  {
    id: 'notice_method',
    label: '通知方式与送达',
    group: '程序性条款',
    baseline: 'low',
    what: '平台通过站内信、注册邮箱或公告即可视为有效送达，用户有义务自行关注。',
    why: '你可能因未看到通知而被认定「已知悉」，从而丧失抗辩空间。',
    signals: [/(视为|即视为).{0,10}(送达|收到|知悉)/, /(站内信|站内通知|公告|注册邮箱).{0,16}(视为|即).{0,8}(通知|送达)/, /(deemed|constitute).{0,16}(notice|received)/i],
  },
  {
    id: 'assignment',
    label: '协议转让',
    group: '程序性条款',
    baseline: 'low',
    what: '平台可将协议权利义务转让给第三方（如被收购时），用户无权反对。',
    why: '你签的合同可能在没有你同意的情况下换了相对方。',
    signals: [/(有权|可以).{0,10}(转让|转移).{0,12}(本协议|权利义务).{0,12}(无需|不需|不必).{0,8}(同意|通知)/, /assign.{0,20}(without|at its).{0,20}(consent|discretion)/i],
  },
  {
    id: 'third_party_service',
    label: '第三方服务与链接',
    group: '外部依赖',
    baseline: 'low',
    what: '服务包含第三方内容或链接，平台不对第三方行为负责。',
    why: '风险被转嫁给用户自行判断。',
    signals: [/(第三方|外部)(网站|链接|服务|内容).{0,20}(不(承担|负责)|免责)/, /not responsible for.{0,20}third.?part/i],
  },
  {
    id: 'governing_law',
    label: '法律适用',
    group: '争议解决',
    baseline: 'low',
    what: '约定适用特定国家/地区的法律。',
    why: '与管辖条款叠加时，可能使你适用完全陌生的法律体系。',
    signals: [/(适用|依据).{0,8}(中华人民共和国|中国|香港|新加坡|美国|加州).{0,6}法律/, /governed by the laws of/i],
  },
  {
    id: 'service_availability',
    label: '服务可用性承诺缺失',
    group: '责任分配',
    baseline: 'medium',
    what: '未承诺可用性指标（SLA），或明确不保证服务不中断、无错误。',
    why: '付费服务若频繁故障，你缺少合同依据主张补偿。',
    signals: [/(不保证|无法保证).{0,16}(不中断|无错误|及时|安全|可靠)/, /(no warrant|does not warrant).{0,30}(uninterrupted|error-free)/i],
  },
  {
    id: 'export_control',
    label: '出口管制与合规',
    group: '合规义务',
    baseline: 'info',
    what: '用户需自行遵守出口管制、制裁等合规要求。',
    why: '常规条款，但跨国使用时值得留意。',
    signals: [/(出口管制|制裁|禁运)/, /export control|sanction/i],
  },
  {
    id: 'force_majeure',
    label: '不可抗力免责',
    group: '责任分配',
    baseline: 'info',
    what: '因不可抗力导致的服务中断不承担责任，但范围可能被写得过宽。',
    why: '常规条款；若把「第三方原因」「设备故障」也算作不可抗力则偏宽。',
    signals: [/(不可抗力|情势变更)/, /force majeure/i],
  },
  {
    id: 'other',
    label: '其他值得注意',
    group: '其他',
    baseline: 'low',
    what: '不属于上述类别、但依然可能对用户不利的条款。',
    why: '分类兜底项。',
    signals: [],
  },
]

/**
 * 「字眼」清单：措辞上常被用来悄悄转移权利或义务的词语。
 *
 * 注意：**出现这些词不等于就是坑**。它们只是提示模型「这里要停下来想一想」。
 * 真正的判断必须结合上下文 —— 因此这份清单只进提示词，不直接产生结论，
 * 避免犯下"见到『可能』就报风险"这种误报。
 */
export const WORDING_FLAGS = [
  // 单方裁量与不确定性
  '有权', '保留权利', '自行决定', '自行判断', '单方', '单方面', '酌情', '必要时', '适当', '合理判断',
  '商业上合理', '尽量', '原则上', '可能', '视情况',
  // 时间与程序
  '随时', '立即', '无需通知', '不另行通知', '无需另行通知', '无需事先通知', '不经通知',
  // 视为同意
  '视为', '即表示', '即构成', '推定', '默认同意',
  // 范围模糊
  '包括但不限于', '等', '其他类似', '相关', '必要范围',
  // 免责与保证
  '不保证', '不承担', '免于', '免除', '按现状', '不作出任何承诺',
  // 权利归属与授权
  '最终解释权', '不可撤销', '永久', '无期限', '全球范围', '全世界范围', '免费', '无偿', '可转授权', '再许可',
  // 主体范围
  '关联方', '关联公司', '合作伙伴', '合作方', '第三方', '服务提供商',
  // 英文对应
  'may', 'at our sole discretion', 'at any time', 'without notice', 'deemed', 'constitutes acceptance',
  'including but not limited to', 'as is', 'as available', 'disclaim', 'perpetual', 'irrevocable',
  'worldwide', 'royalty-free', 'sublicensable', 'affiliates', 'partners', 'sole discretion',
]

/** 给提示词用的紧凑字眼清单 */
export function wordingFlagsForPrompt() {
  return WORDING_FLAGS.join(' / ')
}

export const CATEGORY_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]))

export function categoryLabel(id) {
  return CATEGORY_BY_ID.get(id)?.label ?? id
}

/** 给提示词用的紧凑分类清单文本 */
export function categoryCatalogForPrompt() {
  return CATEGORIES.map((c) => `- ${c.id}（${c.label}）：${c.what}`).join('\n')
}

/**
 * 本地确定性预扫描：用正则找出可能的红旗条款，作为给模型的线索 + 模型不可用时的降级结果。
 * 纯本地、零成本、可解释。
 * @param {Array<{id:string,text:string,heading?:string}>} clauses
 * @returns {Array<{clauseId:string,category:string,severity:Severity,matches:string[]}>}
 */
export function prescan(clauses) {
  const hits = []
  for (const clause of clauses) {
    const text = clause.text || ''
    if (!text) continue
    for (const cat of CATEGORIES) {
      const matches = []
      const matchIndexes = []
      for (const re of cat.signals) {
        const m = re.exec(text)
        if (m) {
          matches.push(m[0].slice(0, 60))
          matchIndexes.push(m.index)
        }
      }
      if (matches.length) {
        hits.push({
          clauseId: clause.id,
          category: cat.id,
          severity: cat.baseline,
          matches: matches.slice(0, 3),
          matchIndexes: matchIndexes.slice(0, 3),
        })
      }
    }
  }
  return hits
}
