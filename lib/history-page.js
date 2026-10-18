/**
 * 历史授权页的 HTML 渲染。
 *
 * ── 为什么拆成独立文件 ──────────────────────────────────────────────────────
 * ① 设计 §10 就是这么定的："HTML 页面 → lib/history-page.js（新文件，与 client 分离）"
 * ② 页面是一大坨 HTML/CSS/JS 字符串，塞进 index.js 会让那个已经 118KB 的文件
 *    更难读，而且在"用脚本改 index.js"时每次都要处理多层引号转义 —— 已经翻车过。
 * ③ 独立文件可以单独测试：传进去一个 payload，检查输出里有没有该有的东西。
 *
 * ── 为什么服务端渲染、不引前端框架 ──────────────────────────────────────────
 * 插件刻意保持"纯 ESM 无构建"（`dsh plugin add` 不需要 allowBuilds）。
 * 而且这是**诊断类页面**：它的存在意义是"出问题时还能打开看看"，
 * 所以它必须比它诊断的东西更结实 —— 不依赖浏览器半区、不依赖 fetch、不依赖 React。
 * 唯一的客户端脚本是"清空"按钮，且失败也只是弹个提示。
 */

/** 决策词表 → 中文标签。 */
const OUTCOME_LABEL = {
  'allowed-once': '允许一次',
  rejected: '拒绝',
  cancelled: '取消',
  unavailable: '不可用',
  pending: '待决定'
}

const RISK_LABEL = { low: '低', medium: '中', high: '高' }

/** 把任意值转成安全的 HTML 文本。 */
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** 把 ISO 时间截成「月-日 时:分:秒」，读起来比完整 ISO 快。 */
function shortTime(value) {
  const ms = Date.parse(String(value ?? ''))
  if (!Number.isFinite(ms)) return String(value ?? '—')
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 注释字段 → 中文标题，按展示顺序。 */
const ANNOTATION_FIELDS = [
  ['what', '这段代码在做什么'],
  ['intent', '模型想达成什么'],
  ['risk_reason', '这样判断的理由'],
  ['recommend', '建议'],
  ['approve_meaning', '允许意味着'],
  ['reject_meaning', '拒绝意味着']
]

/** 渲染单条记录的注释详情。 */
function renderAnnotationDetail(item) {
  const annotation = item.annotation ?? {}
  const parts = []

  for (const [key, label] of ANNOTATION_FIELDS) {
    const value = annotation[key]
    if (typeof value === 'string' && value !== '') {
      parts.push(`<div><b>${escapeHtml(label)}</b><p>${escapeHtml(value)}</p></div>`)
    }
  }

  const hazards = Array.isArray(annotation.hazards)
    ? annotation.hazards.filter((x) => typeof x === 'string' && x !== '')
    : []
  if (hazards.length > 0) {
    parts.push(`<div><b>风险点</b><p>${escapeHtml(hazards.join('；'))}</p></div>`)
  }

  if (item.argsDigest !== null && item.argsDigest !== undefined) {
    parts.push(`<div><b>实参摘要</b><p><code>${escapeHtml(JSON.stringify(item.argsDigest))}</code></p></div>`)
  }

  const linkNote = item.annotationUnlinked ? '未关联到决策' : `按 ${item.linkedBy} 关联`
  parts.push(`<div><b>与决策的关联</b><p>${escapeHtml(linkNote)}</p></div>`)

  return `<div class="kv">${parts.join('')}</div>`
}

/** 渲染表格的一行。 */
function renderRow(item) {
  const annotation = item.annotation ?? {}
  const outcomeText = item.outcome === null ? '未关联' : OUTCOME_LABEL[item.outcome] ?? item.outcome
  const riskText = RISK_LABEL[item.risk] ?? (item.risk === '' ? '—' : item.risk)
  const summary = typeof annotation.what === 'string' && annotation.what !== ''
    ? annotation.what.slice(0, 40)
    : '（无注释）'

  return [
    '<tr>',
    `<td class="t">${escapeHtml(shortTime(item.at))}</td>`,
    `<td class="tool">${escapeHtml(item.tool === '' ? '—' : item.tool)}</td>`,
    `<td class="risk r-${escapeHtml(item.risk)}">${escapeHtml(riskText)}</td>`,
    `<td class="outcome o-${escapeHtml(item.outcome ?? 'none')}">${escapeHtml(outcomeText)}</td>`,
    `<td class="reason" title="${escapeHtml(item.reason ?? '')}">${escapeHtml(item.reason === '' || item.reason === undefined ? '—' : item.reason)}</td>`,
    `<td class="detail"><details><summary>${escapeHtml(summary)}</summary>${renderAnnotationDetail(item)}</details></td>`,
    '</tr>'
  ].join('')
}

/** 渲染筛选表单。 */
function renderForm(filters) {
  const decisionOptions = ['allow', 'deny', 'cancel', 'pending']
    .map((key) => {
      const outcome = { allow: 'allowed-once', deny: 'rejected', cancel: 'cancelled', pending: 'pending' }[key]
      const selected = filters.decision === outcome ? ' selected' : ''
      return `<option value="${escapeHtml(key)}"${selected}>${escapeHtml(OUTCOME_LABEL[outcome])}</option>`
    })
    .join('')

  const riskOptions = ['low', 'medium', 'high']
    .map((key) => {
      const selected = filters.risk === key ? ' selected' : ''
      return `<option value="${escapeHtml(key)}"${selected}>${escapeHtml(RISK_LABEL[key])}</option>`
    })
    .join('')

  const limitOptions = [100, 200, 500, 1000]
    .map((n) => {
      const selected = filters.limit === n ? ' selected' : ''
      return `<option value="${n}"${selected}>${n} 条</option>`
    })
    .join('')

  return [
    '<form method="get">',
    `<input type="text" name="q" placeholder="搜索工具 / 路径 / 注释 / 理由" value="${escapeHtml(filters.q ?? '')}">`,
    `<select name="decision"><option value="">全部决策</option>${decisionOptions}</select>`,
    `<select name="risk"><option value="">全部风险</option>${riskOptions}</select>`,
    `<select name="limit">${limitOptions}</select>`,
    '<button type="submit">筛选</button>',
    '<button type="button" id="clear" class="danger">清空历史</button>',
    '</form>'
  ].join('')
}

/** 渲染顶部统计与降级提示。 */
function renderHeader(payload) {
  const readErrors = Number(payload.hostStats?.readErrors ?? 0)
  const sub = [
    `共 ${payload.total} 条，显示 ${payload.returned} 条`,
    `宿主会话 ${payload.hostStats.sessions} 个（本次读取 ${payload.hostStats.reads}、命中缓存 ${payload.hostStats.cached}）`,
    escapeHtml(payload.generatedAt)
  ].join(' · ')

  const banners = []
  if (payload.hostAvailable === false) {
    banners.push(
      [
        '<div class="warn">',
        '<b>宿主未提供 <code>sessionPersistence</code> 服务</b>',
        `<p>注释仍可查看，但无法关联审批决策。原因：${escapeHtml(payload.hostReason ?? '未知')}</p>`,
        '</div>'
      ].join('')
    )
  } else if (readErrors > 0) {
    // 有会话读失败时**必须提示**：否则页面会把"没读到决策"渲染成"未关联"，
    // 与"宿主确实没有决策"无法区分 —— 用户会误以为那几次真的没有决策。
    banners.push(
      [
        '<div class="warn">',
        `<b>有 ${readErrors} 个会话读取失败</b>`,
        `<p>决策列可能缺失，相关条目会显示为"未关联"。原因：${escapeHtml(payload.readErrorReason ?? '未知')}</p>`,
        '</div>'
      ].join('')
    )
  }

  return `<h1>历史授权</h1><div class="sub">${sub}</div>${banners.join('')}`
}

/** 页面样式。刻意精简：诊断页不该依赖外部资源。 */
const STYLE = [
  ':root{color-scheme:dark}',
  'body{margin:0;padding:24px;background:#141315;color:#e1e1e2;font:14px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif}',
  'h1{margin:0 0 4px;font-size:18px;font-weight:600}',
  '.sub{color:#8a8a8c;font-size:12px;margin-bottom:16px}',
  'form{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:16px}',
  'input,select{background:#1d1c1f;color:#e1e1e2;border:1px solid #2e2d31;border-radius:6px;padding:6px 10px;font:inherit}',
  'input[type=text]{min-width:220px}',
  'button{background:#2b2a2e;color:#e1e1e2;border:1px solid #3a393e;border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit}',
  'button:hover{background:#343338}',
  'button.danger{border-color:#5a3232}',
  'table{border-collapse:collapse;width:100%}',
  'th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #262528;vertical-align:top}',
  'th{color:#8a8a8c;font-weight:500;font-size:12px}',
  'td.t{white-space:nowrap;color:#a9a9ab;font-variant-numeric:tabular-nums}',
  'td.tool{font-family:ui-monospace,Consolas,monospace;color:#cfcfd0}',
  '.risk.r-low{color:#7fb37f}.risk.r-medium{color:#d3a75c}.risk.r-high{color:#d97b7b}',
  '.outcome.o-allowed-once{color:#7fbf8f}.outcome.o-rejected{color:#d97b7b}.outcome.o-cancelled{color:#9a9a9c}',
  '.outcome.o-pending{color:#d3a75c}.outcome.o-none{color:#6f6f71}',
  'td.reason{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#b9b9ba}',
  'summary{cursor:pointer;color:#8fa8c8}',
  '.kv div{margin:8px 0}.kv b{display:block;color:#8a8a8c;font-size:12px;font-weight:500}',
  '.kv p{margin:2px 0;white-space:pre-wrap;word-break:break-word}',
  'code{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#b9b9ba;word-break:break-all}',
  '.empty{text-align:center;color:#6f6f71;padding:32px}',
  '.warn{background:#241d1d;border:1px solid #5a3232;border-radius:8px;padding:12px 14px;margin-bottom:16px}',
  '.warn b{color:#d97b7b}.warn p{margin:4px 0 0;color:#b9b9ba}'
].join('')

/** 清空按钮的客户端脚本。失败也只是 alert，不影响页面其余部分。 */
const CLIENT_SCRIPT = [
  '<script>',
  "document.getElementById('clear').addEventListener('click', async function () {",
  "  if (!confirm('清空插件自己记录的注释历史？（不会动宿主会话日志）')) return",
  "  var r = await fetch(location.pathname + '/clear', { method: 'POST' })",
  '  var j = await r.json().catch(function () { return {} })',
  "  alert(j.ok ? ('已清空 ' + j.removed + ' 条') : ('清空失败：' + (j.error || r.status)))",
  '  location.reload()',
  '})',
  '</script>'
].join('')

/**
 * 渲染历史授权页。
 * @param payload - handleHistory 组装好的数据。
 * @param filters - 当前筛选，用于回填表单。
 * @returns 完整 HTML 文本。
 */
export function renderHistoryPage(payload, filters) {
  const bodyRows = payload.items.map(renderRow).join('')
  const emptyRow = payload.items.length === 0
    ? `<tr><td colspan="6" class="empty">${
        payload.hostAvailable ? '还没有产生过注释记录' : '宿主未提供会话持久化服务，无法显示决策'
      }</td></tr>`
    : ''

  return [
    '<!doctype html>',
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>历史授权 · dsh-approval-explainer</title>',
    `<style>${STYLE}</style>`,
    '</head><body>',
    renderHeader(payload),
    renderForm(filters),
    '<table><thead><tr>',
    '<th>时间</th><th>工具</th><th>风险</th><th>决策</th><th>申请理由</th><th>AI 注释</th>',
    '</tr></thead><tbody>',
    bodyRows,
    emptyRow,
    '</tbody></table>',
    CLIENT_SCRIPT,
    '</body></html>'
  ].join('')
}

/** 供测试使用：暴露内部纯函数，避免测试靠文本断言。 */
export const __test__ = { escapeHtml, shortTime, renderRow, renderForm, OUTCOME_LABEL, RISK_LABEL }
