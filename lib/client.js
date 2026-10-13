/**
 * dsh-approval-explainer —— 浏览器半区
 *
 * 占领 conversation.approval.detail 这个官方预留的座位，在审批弹窗里渲染：
 *   ① 待执行的那行命令 / 文件 diff —— **必须自己画**，因为占用这个单例座位
 *      会替换掉官方 client-ui-chat 的同名渲染器（它原本负责显示命令）。
 *   ② AI 注释：这段代码做什么 / 模型想干嘛 / 风险多大为什么 / 两个选项的后果。
 *   ③ 选项解读：让用户在点之前就知道每个按钮按下之后会发生什么。
 *
 * ── 素材从哪来 ─────────────────────────────────────────────────────────────
 * 实参与「模型当时的想法」由浏览器自己从会话快照里取（useChat），不占宿主带宽：
 *   · 工具实参：node.data.root.argsRaw（未结算）或 root.call.argsRaw（已结算）
 *   · 模型推理：同 turn/step 的 assistant-step 节点，data.blocks 里的 reasoning/text
 * 风险判定与选项后果则由宿主侧的模型调用产出（GET /dsh-approval/explain）。
 *
 * ── 热重载 ─────────────────────────────────────────────────────────────────
 * 本文件由宿主路由每次请求现读，所以改完**只要刷新页面**就生效。
 */
window.__ModuleLoader__.load({
  id: 'dsh-approval-explainer',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')

    const ROUTE = '/dsh-approval/explain'
    const POLL_INTERVAL_MS = 350
    // 轮询窗口必须 **≥ 宿主生成时限**，否则会出现下面这种最坏情况：
    //   宿主还在生成（时限内），面板已经放弃 → 注释白生成了，
    //   而用户看到的是"这句注释没能生成"。
    //
    // 名义窗口 120 × 350ms = 42 秒；但循环是先请求后等待，最后一次请求
    // 发生在 119 × 350ms ≈ 41.65 秒，之后空等一次才返回 —— 真实观察窗口
    // 约 41.65 秒，仍 ≥ 宿主 40 秒时限，余量 1.65 秒。
    //
    // 为什么让面板等这么久：注释生成不在审批关键路径上，用户随时可以
    // 点按钮决定。所以"面板多转一会儿"的代价，远小于"用户看到没能生成"。
    // （曾经是 15 秒时限 + 21 秒窗口，逐次实测成功耗时已达 9.0 秒，
    //   余量太薄；有一次 pwsh 审批真的在 15.0 秒被中断，见 errors.log。）
    const POLL_LIMIT = 120
    const MAX_CODE_CHARS = 8000
    const MAX_CODE_LINES = 120
    const MAX_REASONING_CHARS = 1200

    // ── 文案（面板文案中文优先；注释本身的语言由模型跟随素材语言决定）────────

    const TEXT = {
      command: '即将执行',
      annotation: 'AI 注释',
      analyzing: '正在分析这段代码的意图与风险…',
      failed: '这句注释没能生成',
      expand: '展开完整内容',
      expandHint: '实参与模型原话',
      what: '这段代码在做什么',
      intent: '模型想达成什么',
      risk: '风险',
      riskReason: '这样判断的理由',
      hazards: '风险点',
      recommend: '建议',
      approve: '允许一次',
      reject: '拒绝',
      options: '选项意味着什么',
      riskLow: '较低',
      riskMedium: '中等',
      riskHigh: '偏高',
      guess: '意图为推测',
      truncated: '内容已截断',
      empty: '这条授权请求没有携带可展示的调用详情。'
    }

    /** 工具实参 → 一行人话摘要，用于标题区。 */
    function summarizeToolCall(name, args) {
      if (args === null || typeof args !== 'object' || Array.isArray(args)) return ''
      const first = (...keys) => {
        for (const key of keys) {
          const value = args[key]
          if (typeof value === 'string' && value.trim() !== '') return value.trim()
        }
        return ''
      }
      const pick = (...keys) => first(...keys) || Object.keys(args).slice(0, 3).join(', ')
      const clipboard = (text) => (text.length > 160 ? `${text.slice(0, 160)}…` : text)
      switch (name) {
        case 'bash':
          return clipboard(first('command', 'cmd', 'script'))
        case 'write':
        case 'read':
        case 'read_image':
        case 'edit':
          return clipboard(pick('file_path', 'path', 'filePath', 'notebook_path'))
        case 'glob':
          return clipboard(pick('pattern', 'glob'))
        case 'grep':
          return clipboard(pick('pattern', 'query'))
        case 'web_fetch':
          return clipboard(pick('url'))
        case 'web_search':
          return clipboard(Array.isArray(args.queries) ? args.queries.join(' | ') : pick('query', 'queries'))
        case 'pwsh':
          return clipboard(pick('command', 'script'))
        case 'present':
          return clipboard(pick('files', 'path'))
        default: {
          const keys = Object.keys(args)
          if (keys.length === 0) return ''
          const probe = args[keys[0]]
          const value = typeof probe === 'string' || typeof probe === 'number' || typeof probe === 'boolean' ? String(probe) : keys.join(', ')
          return clipboard(value)
        }
      }
    }

    /** 把 unknown 实参渲染成可读文本：字符串直出，其余 pretty JSON。 */
    function renderArguments(value) {
      if (typeof value === 'string') return value
      try {
        const rendered = JSON.stringify(value, null, 2)
        return rendered === undefined ? String(value) : rendered
      } catch {
        return String(value)
      }
    }

    function clipCode(text) {
      const lines = text.split(/\r?\n/)
      let result = text
      let truncated = false
      if (lines.length > MAX_CODE_LINES) {
        result = lines.slice(0, MAX_CODE_LINES).join('\n')
        truncated = true
      }
      if (result.length > MAX_CODE_CHARS) {
        result = result.slice(0, MAX_CODE_CHARS)
        truncated = true
      }
      return { text: result, truncated }
    }

    /**
     * 从会话快照里定位这次调用，并取出实参与同一步的模型推理。
     *
     * 选择器必须返回稳定值（默认按 Object.is 比较），所以这里返回纯数据对象；
     * useChat 用 useSyncExternalStoreWithSelector 订阅，相等时不会重渲染。
     */
    function correlate(snapshot, callId) {
      if (snapshot === undefined || snapshot === null) return null
      const nodes = snapshot.nodes
      if (nodes === undefined || typeof nodes.values !== 'function') return null
      let name = ''
      let rawArguments = undefined
      let turn = undefined
      let step = undefined
      let found = false
      for (const node of nodes.values()) {
        if (node === undefined || node.kind !== 'tool-call') continue
        const root = node.data === undefined ? undefined : node.data.root
        if (root === undefined || root === null) continue
        if (String(root.callId) !== String(callId)) {
          // 嵌套调用（run_code 内部的子调用）也可能带着同一个父 callId。
          if (root.parentCallId === undefined || String(root.parentCallId) !== String(callId)) continue
        }
        found = true
        if (root.kind === 'tool-result') {
          name = String(root.call?.name ?? root.name ?? '')
          rawArguments = root.call?.argsRaw
        } else {
          name = String(root.name ?? '')
          rawArguments = root.argsRaw
        }
        turn = root.turn
        step = root.step
        break
      }
      if (!found) return null

      let reasoning = ''
      let text = ''
      if (turn !== undefined && step !== undefined) {
        for (const node of nodes.values()) {
          if (node === undefined || node.kind !== 'assistant-step') continue
          const data = node.data
          if (data === undefined || data.turn !== turn || data.step !== step) continue
          if (!Array.isArray(data.blocks)) continue
          const join = (kind) =>
            data.blocks
              .filter((block) => block !== undefined && block.kind === kind && typeof block.text === 'string')
              .map((block) => block.text)
              .join('\n')
          reasoning = join('reasoning').trim()
          text = join('text').trim()
          break
        }
      }

      let parsed = rawArguments
      if (typeof rawArguments === 'string') {
        try {
          parsed = JSON.parse(rawArguments)
        } catch {
          parsed = rawArguments
        }
      }

      // 直接把"要展示的文本"算成字符串。快照每次都会重建实参对象，
      // 引用比较必然判不等；字符串比较才能真正压住重渲染。
      const argumentsJson = parsed === undefined ? '' : renderArguments(parsed)

      return {
        name,
        argumentsJson,
        summary: summarizeToolCall(name, parsed),
        reasoning: reasoning.length > MAX_REASONING_CHARS ? `${reasoning.slice(0, MAX_REASONING_CHARS)}…` : reasoning,
        reasoningTruncated: reasoning.length > MAX_REASONING_CHARS,
        text
      }
    }

    /**
     * correlate 每次都会新建对象，而 useChat 默认按 Object.is 比较选择器结果；
     * 不带相等判断的话每一帧都判定为"变了"，会变成无限重渲染。
     * 这里逐字段比较：快照没变就复用上一份数据。
     */
    function sameCorrelation(a, b) {
      if (a === b) return true
      if (a === null || b === null || a === undefined || b === undefined) return false
      return (
        a.name === b.name &&
        a.summary === b.summary &&
        a.reasoning === b.reasoning &&
        a.reasoningTruncated === b.reasoningTruncated &&
        a.text === b.text &&
        a.argumentsJson === b.argumentsJson
      )
    }

    // ── 注释拉取 ─────────────────────────────────────────────────────────────

    /**
     * 按 callId 拉注释；宿主还在生成时按节奏轮询。
     *
     * @param sessionId - 会话身份，与 callId 一起构成缓存键。
     * @param callId - 待审批的工具调用。
     * @param signal - 面板卸载/切换时中止轮询。
     * @returns { status: 'ready'|'error'|'none', annotation?, message? }
     */
    async function fetchAnnotation(sessionId, callId, signal) {
      for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
        if (signal.aborted) return { status: 'none' }
        let payload = null
        try {
          const url = `${ROUTE}?session=${encodeURIComponent(sessionId)}&call=${encodeURIComponent(callId)}`
          const response = await fetch(url, { signal, credentials: 'same-origin', headers: { accept: 'application/json' } })
          if (!response.ok) return { status: 'none' }
          payload = await response.json()
        } catch (error) {
          if (signal.aborted) return { status: 'none' }
          return { status: 'none' }
        }
        if (payload === null || payload.ok !== true) return { status: 'none' }
        if (payload.status === 'ready') return { status: 'ready', annotation: payload.annotation }
        if (payload.status === 'error') return { status: 'error', message: String(payload.message ?? '') }
        // 注意：这里**刻意不显式匹配 'pending'**。
        // 宿主在"还没轮到生成"或"正在生成"时返回 { ok:true, status:'pending', inFlight }，
        // 它就该落到这一行等待后继续轮询。
        // （曾经有人给这个文件做静态审计，因为搜不到 'pending' 字面量而误报"客户端不认识 pending"——
        //  实际这里靠的是"其它情况一律继续等"这个兜底分支，写死成 if (status === 'pending') 反而更脆：
        //  宿主以后新增任何中间态都会掉出循环。）
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
      }
      return { status: 'none' }
    }

    /** 状态机：idle → ready / error / none。 */
    function useAnnotation(sessionId, callId) {
      const [state, setState] = react.useState({ status: 'idle' })
      react.useEffect(() => {
        if (sessionId === undefined || callId === undefined) {
          setState({ status: 'none' })
          return undefined
        }
        const controller = new AbortController()
        let live = true
        setState({ status: 'idle' })
        fetchAnnotation(String(sessionId), String(callId), controller.signal).then((result) => {
          if (!live || controller.signal.aborted) return
          setState(result)
        })
        return () => {
          live = false
          controller.abort()
        }
      }, [sessionId, callId])
      return state
    }

    // ── 样式：全部走主题令牌，明暗主题自动跟随 ────────────────────────────────

    const CSS = `
.dshx-root{word-break:normal;overflow-wrap:anywhere;white-space:normal;font-family:inherit;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:10px}
.dshx-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dshx-tool{font-weight:500;color:var(--dsw-alias-label-primary)}
.dshx-summary{min-width:0;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshx-badge{flex:none;white-space:nowrap;border-radius:999px;padding:1px 8px;font-size:11px;line-height:18px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dshx-badge[data-risk=high]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dshx-badge[data-risk=medium]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dshx-badge[data-risk=low]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dshx-code{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:8px 10px;font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;max-height:220px;overflow:auto;margin:0}
.dshx-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshx-details{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);overflow:hidden}
.dshx-summaryToggle{display:flex;align-items:center;gap:6px;padding:6px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;list-style:none;user-select:none}
.dshx-summaryToggle::-webkit-details-marker{display:none}
.dshx-summaryToggle::before{content:'▸';flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .12s ease}
.dshx-details[open] .dshx-summaryToggle::before{transform:rotate(90deg)}
.dshx-summaryToggle:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dshx-summaryHint{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dshx-detailsBody{display:flex;flex-direction:column;gap:8px;padding:0 10px 10px}
.dshx-card{border:1px solid var(--dsw-alias-border-l1);border-left:2px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:6px}
.dshx-cardTitle{white-space:nowrap;font-size:11px;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary);text-transform:uppercase}
.dshx-field{display:flex;flex-direction:column;gap:2px}
.dshx-label{white-space:nowrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshx-value{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}
.dshx-riskRow{display:flex;align-items:center;gap:8px;flex-wrap:nowrap}
.dshx-riskWord{flex:none;white-space:nowrap;font-size:13px;line-height:20px;font-weight:500}
.dshx-riskWord[data-risk=high]{color:var(--dsw-alias-state-error-primary)}
.dshx-riskWord[data-risk=medium]{color:var(--dsw-alias-state-warn-primary)}
.dshx-riskWord[data-risk=low]{color:var(--dsw-alias-state-success-primary)}
.dshx-hazards{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:2px}
.dshx-hazards li{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.dshx-recommend{border-left:2px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:6px 8px;font-size:13px;line-height:20px}
.dshx-options{display:flex;flex-direction:column;gap:6px}
.dshx-option{display:flex;gap:8px;align-items:flex-start}
.dshx-optionName{flex:none;white-space:nowrap;min-width:72px;font-size:12px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.dshx-optionBody{min-width:0;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary)}
`

    const CSS_TAG = 'dsh-approval-explainer/detail.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG)}]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-approval-explainer'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ── 渲染 ─────────────────────────────────────────────────────────────────

    function riskWord(risk) {
      if (risk === 'high') return TEXT.riskHigh
      if (risk === 'medium') return TEXT.riskMedium
      return TEXT.riskLow
    }

    function annotationCard(state) {
      if (state.status === 'idle') {
        return react.createElement('div', { className: 'dshx-note' }, TEXT.analyzing)
      }
      if (state.status === 'none') return null
      if (state.status === 'error') {
        return react.createElement(
          'div',
          { className: 'dshx-note' },
          `${TEXT.failed}：${state.message === '' ? '未知原因' : state.message}`
        )
      }
      const annotation = state.annotation
      if (annotation === null || typeof annotation !== 'object') return null
      const risk = annotation.risk === 'high' || annotation.risk === 'medium' || annotation.risk === 'low' ? annotation.risk : 'medium'
      const hazards = Array.isArray(annotation.hazards) ? annotation.hazards.filter((item) => typeof item === 'string' && item.trim() !== '') : []
      const fields = []
      const push = (label, value, className) => {
        if (typeof value !== 'string' || value.trim() === '') return
        fields.push(
          react.createElement(
            'div',
            { className: 'dshx-field', key: label },
            react.createElement('div', { className: 'dshx-label' }, label),
            react.createElement('div', { className: className ?? 'dshx-value' }, value)
          )
        )
      }
      push(TEXT.what, annotation.what)
      push(annotation.confidence === 'medium' ? `${TEXT.intent}（${TEXT.guess}）` : TEXT.intent, annotation.intent)
      fields.push(
        react.createElement(
          'div',
          { className: 'dshx-field', key: 'risk' },
          react.createElement('div', { className: 'dshx-label' }, TEXT.risk),
          react.createElement(
            'div',
            { className: 'dshx-riskRow' },
            react.createElement('span', { className: 'dshx-riskWord', 'data-risk': risk }, riskWord(risk)),
            react.createElement('span', { className: 'dshx-optionBody' }, annotation.risk_reason)
          )
        )
      )
      if (hazards.length > 0) {
        fields.push(
          react.createElement(
            'div',
            { className: 'dshx-field', key: 'hazards' },
            react.createElement('div', { className: 'dshx-label' }, TEXT.hazards),
            react.createElement(
              'ul',
              { className: 'dshx-hazards' },
              hazards.map((item, index) => react.createElement('li', { key: `h${index}` }, item))
            )
          )
        )
      }
      if (typeof annotation.recommend === 'string' && annotation.recommend.trim() !== '') {
        fields.push(react.createElement('div', { className: 'dshx-recommend', key: 'recommend' }, annotation.recommend))
      }
      const options = []
      if (typeof annotation.approve_meaning === 'string' && annotation.approve_meaning.trim() !== '') {
        options.push(
          react.createElement(
            'div',
            { className: 'dshx-option', key: 'approve' },
            react.createElement('span', { className: 'dshx-optionName' }, TEXT.approve),
            react.createElement('span', { className: 'dshx-optionBody' }, annotation.approve_meaning)
          )
        )
      }
      if (typeof annotation.reject_meaning === 'string' && annotation.reject_meaning.trim() !== '') {
        options.push(
          react.createElement(
            'div',
            { className: 'dshx-option', key: 'reject' },
            react.createElement('span', { className: 'dshx-optionName' }, TEXT.reject),
            react.createElement('span', { className: 'dshx-optionBody' }, annotation.reject_meaning)
          )
        )
      }
      if (options.length > 0) {
        fields.push(
          react.createElement(
            'div',
            { className: 'dshx-field', key: 'options' },
            react.createElement('div', { className: 'dshx-label' }, TEXT.options),
            react.createElement('div', { className: 'dshx-options' }, options)
          )
        )
      }
      return react.createElement(
        'div',
        { className: 'dshx-card', 'data-approval-explainer': 'annotation' },
        react.createElement('div', { className: 'dshx-cardTitle' }, `${TEXT.annotation} · ${riskWord(risk)}${TEXT.risk}`),
        ...fields
      )
    }

    /**
     * 审批详情区的完整内容：命令 + 模型原话 + AI 注释 + 选项解读。
     *
     * @param props - owner props `{ callId }` 加上 session 作用域的标准 props。
     * @returns 注释区的 React 元素。
     */
    function ApprovalExplainDetail({ callId, useChat, sessionId }) {
      const correlation = useChat((snapshot) => correlate(snapshot, callId), sameCorrelation) ?? null
      const state = useAnnotation(sessionId, callId)

      const children = []
      if (correlation !== null) {
        if (correlation.name !== '' || correlation.summary !== '') {
          children.push(
            react.createElement(
              'div',
              { className: 'dshx-head', key: 'head' },
              react.createElement('span', { className: 'dshx-tool' }, correlation.name === '' ? TEXT.command : `${TEXT.command} · ${correlation.name}`),
              correlation.summary === '' ? null : react.createElement('span', { className: 'dshx-summary' }, correlation.summary)
            )
          )
        }

        // 完整的实参与模型原话默认收起。
        // 理由：像 write 这种调用会带上整篇文件内容，全部铺开会把弹窗撑得很长，
        // 反而盖住了真正需要用户读的东西（风险与选项）。需要核对原文时一键展开。
        const collapsed = []
        const rendered = correlation.argumentsJson
        if (typeof rendered === 'string' && rendered.trim() !== '') {
          const clipped = clipCode(rendered)
          collapsed.push(react.createElement('pre', { className: 'dshx-code', key: 'code' }, clipped.text))
          if (clipped.truncated) {
            collapsed.push(react.createElement('div', { className: 'dshx-note', key: 'codeNote' }, TEXT.truncated))
          }
        }
        if (correlation.reasoning !== '') {
          collapsed.push(
            react.createElement(
              'div',
              { className: 'dshx-field', key: 'reasoning' },
              react.createElement('div', { className: 'dshx-label' }, '模型自己的说法'),
              react.createElement('div', { className: 'dshx-value' }, correlation.reasoning)
            )
          )
        }
        if (collapsed.length > 0) {
          children.push(
            react.createElement(
              'details',
              { className: 'dshx-details', key: 'details' },
              react.createElement(
                'summary',
                { className: 'dshx-summaryToggle' },
                TEXT.expand,
                react.createElement('span', { className: 'dshx-summaryHint' }, TEXT.expandHint)
              ),
              react.createElement('div', { className: 'dshx-detailsBody' }, ...collapsed)
            )
          )
        }
      }

      const card = annotationCard(state)
      if (card !== null) children.push(react.cloneElement(card, { key: 'annotation' }))

      // 单例座位：本组件是唯一占用者，返回 null 只会让详情区变空，
      // 所以哪怕一切都取不到也要给出一行说明，避免用户面对一个突兀的空白。
      if (children.length === 0) {
        children.push(react.createElement('div', { className: 'dshx-note', key: 'empty' }, TEXT.empty))
      }
      return react.createElement('div', { className: 'dshx-root', 'data-approval-explainer': 'root' }, ...children)
    }

    // ── 插件入口 ─────────────────────────────────────────────────────────────

    /** 只需要插槽注册表：其余数据经插槽标准 props 与宿主路由取得。 */
    const inject = ['slots']

    /** 诊断前缀，便于在页面控制台里过滤。 */
    const LOG_PREFIX = '[approval-explainer]'

    /**
     * 安装审批详情渲染器。
     *
     * ⚠ 这个函数**绝对不许抛**。
     *
     * 引导流程的判定是「loader 条目存在但 `fiber === undefined`」即 `failed`，
     * 而 `@deepseek-ai/dsh-client-ui-chat` 是**必需条目**——它一失败，
     * 整个 web boot 就失败，harness 随即触发崩溃自愈（删掉 profile 补丁层、
     * 停用所有第三方插件）。也就是说：本插件的一个疏忽会让**别人**的插件全部陪葬，
     * 用户的模型选择等配置也会被抹掉。
     *
     * 所以这里逐层兜底：本插件最坏的结局只能是"审批弹窗里没有注释"，
     * 绝不能是"harness 起不来"。
     *
     * @param ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
      try {
        if (ctx === undefined || ctx === null) {
          console.warn(`${LOG_PREFIX} 上下文为空，跳过安装`)
          return
        }
        if (typeof ctx.effect !== 'function') {
          console.warn(`${LOG_PREFIX} ctx.effect 不可用，跳过安装`)
          return
        }
        ctx.effect(() => installDetailRenderer(ctx), 'approval-explainer: detail renderer')
      } catch (error) {
        // 只要走到这里就说明装配环境与预期不符；如实报出来，但不外抛。
        console.error(`${LOG_PREFIX} 安装失败（已降级为无注释，不影响 harness）:`, error)
      }
    }

    /**
     * effect 体：等插槽出现再注册渲染器。
     *
     * @param ctx - 浏览器插件上下文。
     * @returns 释放函数，或 undefined。
     */
    function installDetailRenderer(ctx) {
      try {
        const slots = ctx.slots
        if (slots === undefined || slots === null || typeof slots.inject !== 'function') {
          console.warn(`${LOG_PREFIX} ctx.slots.inject 不可用，跳过注册`)
          return undefined
        }
        return slots.inject('conversation.approval.detail', () => {
          try {
            if (typeof slots.register !== 'function') {
              console.warn(`${LOG_PREFIX} ctx.slots.register 不可用，跳过注册`)
              return undefined
            }
            // ⚠ priority 是必需项，而且必须是**比官方更小**的值。
            //
            // `conversation.approval.detail` 是 **single** 座位，而
            // `@deepseek-ai/dsh-client-ui-chat` 已经以 priority 0 注册了
            // `ApprovalCommand`（它负责显示待执行的那行命令）。
            // single 座位每个优先级只允许一个 occupant，重复会直接抛：
            //
            //     single slot "conversation.approval.detail" already has a
            //     registration at priority 0 (registered by mf)
            //     — register at a different priority to shadow it (lowest renders)
            //
            // "lowest renders" 的含义（已在 SlotCore 源码里核实）：
            //   entriesOfSlot 把每个 cell 的 entries 按 **priority 升序** 削减为
            //   第一个存活者（"the first live entry of each cell in priority order"），
            //   而 single 座位只有**一个 cell**。
            //   所以 **priority 数值更小的那个渲染**，即用更小的值遮蔽。
            //
            // 因此这里用 -1：盖住官方的 priority 0。
            // （用 1 是错的 —— 那意味着永远排在官方后面、永远不渲染。）
            //
            // 代价：盖住官方渲染器后，"待执行的那行命令"必须由本组件自己重新渲染
            // （ApprovalExplainDetail 里已经做了，见展示命令的那一段）。
            //
            // 这个错误曾被 slots.inject 的 queueMicrotask 挪出调用栈、又随进程退出
            // 而消失，表现为"ui-chat 激活失败但本插件一声不响"。
            return slots.register({ name: 'conversation.approval.detail', priority: -1 }, ApprovalExplainDetail)
          } catch (error) {
            console.error(`${LOG_PREFIX} 注册渲染器失败:`, error)
            return undefined
          }
        })
      } catch (error) {
        console.error(`${LOG_PREFIX} 注入插槽失败:`, error)
        return undefined
      }
    }

    exports.apply = apply
    exports.inject = inject
    /**
     * 调试面：不参与 Cordis 装配，只为了让「快照遍历」这段最容易写错的逻辑
     * 能在浏览器之外被验证，也方便线上在控制台里手查。
     */
    exports.__debug = {
      correlate,
      sameCorrelation,
      summarizeToolCall,
      renderArguments,
      clipCode
    }
    return module.exports
  }
})
