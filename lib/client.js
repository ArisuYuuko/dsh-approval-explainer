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

/* ── 插件体检：侧边栏入口 + 弹出面板 ─────────────────────────────────────
   只允许主题令牌（--dsw-alias-* / --ds-font-*）：插件的样式必须跟着明暗主题走，
   写死颜色或自造变量会让面板在另一半主题里变成一块看不清的色块。 */
.dshxd-layer{position:relative;flex:0 1 auto;min-width:0;display:flex;align-items:center;height:36px}
.dshxd-layer[data-wide=false]{width:36px;height:36px}
.dshxd-badge{display:inline-flex;align-items:center;gap:6px;max-width:100%;height:36px;margin:0;padding:0 10px 0 8px;border:none;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:18px;cursor:pointer;overflow:hidden}
.dshxd-badge:hover,.dshxd-badge[data-open=true]{background:var(--dsw-alias-interactive-bg-hover)}
.dshxd-layer[data-wide=false] .dshxd-badge{width:36px;height:36px;padding:0;justify-content:center;gap:0;border-radius:50%}
.dshxd-layer[data-wide=false] .dshxd-badgeLabel{display:none}
.dshxd-badgeIcon{flex:none;font-size:15px;line-height:1}
.dshxd-badgeLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshxd-dot{flex:none;width:7px;height:7px;margin-left:2px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.dshxd-layer[data-wide=false] .dshxd-dot{position:absolute;top:7px;right:7px;margin-left:0}
.dshxd-dot[data-state=ok]{background:var(--dsw-alias-state-success-primary)}
.dshxd-dot[data-state=warn]{background:var(--dsw-alias-state-warn-primary)}
.dshxd-dot[data-state=fail]{background:var(--dsw-alias-state-error-primary)}
.dshxd-dot[data-state=info]{background:var(--dsw-alias-label-tertiary)}
.dshxd-panel{position:fixed;z-index:30;display:flex;flex-direction:column;max-height:min(70vh,640px);overflow:hidden;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 24px 48px -24px var(--dsw-alias-label-tertiary);font-family:inherit;font-size:13px;line-height:20px}
.dshxd-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.dshxd-headIcon{flex:none;font-size:15px;line-height:1}
.dshxd-headTitle{font-weight:600;white-space:nowrap}
.dshxd-headVersion{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;font-family:var(--ds-font-family-code)}
.dshxd-pill{flex:none;white-space:nowrap;border-radius:999px;padding:1px 8px;font-size:11px;line-height:16px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dshxd-pill[data-state=ok]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dshxd-pill[data-state=warn]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dshxd-pill[data-state=fail]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dshxd-flex{flex:1}
.dshxd-iconBtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:15px;line-height:1;cursor:pointer;text-decoration:none}
.dshxd-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshxd-meta{display:flex;flex-wrap:wrap;gap:4px 12px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshxd-mono{font-family:var(--ds-font-family-code);font-size:11px}
.dshxd-body{display:flex;flex-direction:column;gap:12px;padding:12px;overflow:auto}
.dshxd-section{display:flex;flex-direction:column;gap:6px}
.dshxd-sectionTitle{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.dshxd-check{display:flex;flex-direction:column;gap:3px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base)}
.dshxd-check[data-state=ok]{border-left-color:var(--dsw-alias-state-success-primary)}
.dshxd-check[data-state=warn]{border-left-color:var(--dsw-alias-state-warn-primary)}
.dshxd-check[data-state=fail]{border-left-color:var(--dsw-alias-state-error-primary)}
.dshxd-check[data-state=info]{border-left-color:var(--dsw-alias-label-tertiary)}
.dshxd-checkHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.dshxd-checkIcon{flex:none;font-weight:700}
.dshxd-checkIcon[data-state=ok]{color:var(--dsw-alias-state-success-primary)}
.dshxd-checkIcon[data-state=warn]{color:var(--dsw-alias-state-warn-primary)}
.dshxd-checkIcon[data-state=fail]{color:var(--dsw-alias-state-error-primary)}
.dshxd-checkIcon[data-state=info]{color:var(--dsw-alias-label-tertiary)}
.dshxd-checkTitle{font-weight:600;min-width:0}
.dshxd-checkState{margin-left:auto;flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dshxd-checkState[data-state=ok]{color:var(--dsw-alias-state-success-primary)}
.dshxd-checkState[data-state=warn]{color:var(--dsw-alias-state-warn-primary)}
.dshxd-checkState[data-state=fail]{color:var(--dsw-alias-state-error-primary)}
.dshxd-checkDetail{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;word-break:break-word}
.dshxd-checkAction{color:var(--dsw-alias-brand-primary);font-size:12px;line-height:18px;word-break:break-word}
.dshxd-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
.dshxd-cell{padding:7px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);text-align:center}
.dshxd-cellValue{font-size:16px;font-weight:600;font-variant-numeric:tabular-nums}
.dshxd-cellValue[data-hot=true]{color:var(--dsw-alias-state-error-primary)}
.dshxd-cellLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dshxd-row{display:flex;gap:8px;align-items:baseline;font-size:12px;line-height:18px}
.dshxd-rowLabel{flex:none;min-width:72px;color:var(--dsw-alias-label-tertiary)}
.dshxd-rowValue{min-width:0;color:var(--dsw-alias-label-primary);word-break:break-word}
.dshxd-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;word-break:break-word}
.dshxd-error{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-left:3px solid var(--dsw-alias-state-error-primary);border-radius:6px;background:var(--dsw-alias-bg-layer-2)}
.dshxd-errorTitle{color:var(--dsw-alias-state-error-primary);font-weight:600;word-break:break-word}
.dshxd-actions{display:flex;gap:8px;flex-wrap:wrap}
.dshxd-action{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer;text-decoration:none}
.dshxd-action:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshxd-chips{display:flex;flex-wrap:wrap;gap:4px}
.dshxd-chip{padding:0 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;font-family:var(--ds-font-family-code);word-break:break-all}
.dshxd-route{padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-brand-primary);font-family:inherit;font-size:11px;line-height:18px;text-decoration:none;white-space:nowrap;cursor:pointer}
.dshxd-route:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshxd-details{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);overflow:hidden}
.dshxd-summaryToggle{padding:6px 10px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer;list-style:none;user-select:none}
.dshxd-summaryToggle::-webkit-details-marker{display:none}
.dshxd-summaryToggle::before{content:'▸';display:inline-block;margin-right:6px;color:var(--dsw-alias-label-tertiary);transition:transform .12s ease}
.dshxd-details[open] .dshxd-summaryToggle::before{transform:rotate(90deg)}
.dshxd-detailsBody{display:flex;flex-direction:column;gap:6px;padding:0 10px 10px}
.dshxd-pre{margin:0;padding:8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto}
.dshxd-failure{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.dshxd-foot{padding:7px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}

/* ── 审批历史：会话头部入口 ─────────────────────────────────────────────
   尺寸/字号/颜色照原生头部动作（ui-jobs 的 trigger）抄：12px、三级文字色、
   hover 升二级、无边框、28px 命中高度、8px 圆角（= 平台 --dsw-radius-sm）。
   ⚠ 这一行同时挂着别的插件的条目（后台任务 / 定时任务 / Agent 团队…）：
   只给自身定尺寸，不设宽度、不绝对定位、不撑高行、不假设左右邻居。 */
.dshxh-trigger{border-radius:var(--dsw-radius-sm);min-height:28px;display:inline-flex;align-items:center;gap:4px;padding:3px 5px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}
.dshxh-trigger:hover,.dshxh-trigger:focus-visible{color:var(--dsw-alias-label-secondary)}
.dshxh-icon{flex:none;display:block;width:14px;height:14px}
.dshxh-label{min-width:0}

/* ── 审批历史：浮层面板（与「插件体检」面板同一套语言）────────────────────
   浮层固定在头部入口按钮下方，不导航、不弹浏览器。 */
.dshxh-root{flex:none;display:flex;align-items:center;position:relative}
.dshxi-wrap{position:fixed;z-index:30}
.dshxi-panel{display:flex;flex-direction:column;max-height:min(72vh,640px);overflow:hidden;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 24px 48px -24px var(--dsw-alias-label-tertiary);font-family:inherit;font-size:13px;line-height:20px}
.dshxi-head{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.dshxi-headIcon{flex:none;font-size:14px;line-height:1}
.dshxi-title{font-weight:600;white-space:nowrap}
.dshxi-count{font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dshxi-filters{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshxi-input{flex:1;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;padding:4px 8px}
.dshxi-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dshxi-select{flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;padding:4px 6px}
.dshxi-body{display:flex;flex-direction:column;gap:8px;padding:10px 12px;overflow:auto}
.dshxi-list{display:flex;flex-direction:column;gap:6px}
.dshxi-row{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);overflow:hidden}
.dshxi-rowHead{display:flex;align-items:center;gap:8px;padding:6px 9px;cursor:pointer;list-style:none;user-select:none;font-size:12px;line-height:18px}
.dshxi-rowHead::-webkit-details-marker{display:none}
.dshxi-rowHead::before{content:'▸';display:inline-block;color:var(--dsw-alias-label-tertiary);transition:transform .12s ease}
.dshxi-row[open] .dshxi-rowHead::before{transform:rotate(90deg)}
.dshxi-time{flex:none;font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dshxi-tool{font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshxi-session{margin-left:auto;flex:none;font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dshxi-badge{flex:none;border-radius:999px;padding:1px 7px;font-size:11px;line-height:16px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dshxi-badge[data-tone=ok]{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dshxi-badge[data-tone=warn]{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dshxi-badge[data-tone=fail]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dshxi-badge[data-tone=info]{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}
.dshxi-rowBody{display:flex;flex-direction:column;gap:6px;padding:0 9px 9px}
.dshxi-reason{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.dshxi-meta{font-family:var(--ds-font-family-code);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);word-break:break-word}
.dshxi-field{display:flex;flex-direction:column;gap:2px}
.dshxi-fieldLabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dshxi-fieldValue{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}
.dshxi-hazards{margin:0;padding-left:18px}
.dshxi-hazards li{font-size:12px;line-height:18px}
.dshxi-pre{margin:0;max-height:200px;overflow:auto;padding:7px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-word}
.dshxi-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshxi-error{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-left:3px solid var(--dsw-alias-state-error-primary);border-radius:6px;background:var(--dsw-alias-bg-layer-2)}
.dshxi-errorTitle{font-weight:600;color:var(--dsw-alias-state-error-primary);word-break:break-word}
.dshxi-actions{display:flex;gap:8px;flex-wrap:wrap}
.dshxi-action{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dshxi-action:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshxi-foot{display:flex;align-items:center;gap:8px;padding:7px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.dshxi-footNote{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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

    // ══════════════════════════════════════════════════════════════════════
    // 插件体检面板 —— 宿主 GET /dsh-approval/diag 的前端
    //
    // 宿主半区早就有这个诊断总台，但唯一的入口是「自己往地址栏敲 URL」。
    // 排障时这恰恰是最不该有摩擦的一步，所以这里把它做成一键可达：
    // 侧边栏底部多一个「插件体检」按钮，点开就是完整报告。
    //
    // 三条纪律（与审批注释区一致）：
    //   ① **判定只在宿主算一次**，这里只负责展示 —— 两边各算一遍迟早会口径漂移；
    //   ② 任何失败都只降级成「面板里显示读不到」，绝不外抛、绝不连累启动；
    //   ③ 不新增任何路由、不注入脚本 —— 客户端半区只由启动图加载（铁律）。
    // ══════════════════════════════════════════════════════════════════════

    /** 给人看的体检页；「完整页面」按钮直接开它。 */
    const DIAG_ROUTE = '/dsh-approval/diag'
    /** 结构化快照；面板只读这一条（同源、回环栅栏之内）。 */
    const DIAG_JSON_ROUTE = '/dsh-approval/diag?raw=1'
    /** 面板打开时的自动刷新节奏：够快能看到计数器变化，又不至于让宿主动不动扫盘。 */
    const DIAG_REFRESH_MS = 10000
    const DIAG_PANEL_WIDTH = 560

    const DIAG_TEXT = {
      entry: '插件体检',
      title: '插件体检',
      refresh: '重新检查',
      openFull: '完整页面',
      close: '关闭',
      loading: '正在读取宿主诊断…',
      failed: '读不到宿主诊断',
      failedHint: '宿主半区没加载，或 /dsh-approval/diag 被本机栅栏挡住了。先点「完整页面」直连试试；仍然不通就重启 DSH。',
      retry: '重试',
      checks: '检查项',
      counters: '计数器',
      clientHalf: '浏览器半区',
      crashes: '崩溃与自愈',
      profile: 'profile 配置',
      routes: '相关页面',
      logs: '日志',
      raw: '原始数据',
      copy: '复制 JSON',
      copied: '已复制',
      copyFailed: '复制失败，请从下方原文里手动选',
      checkedAt: '检查于',
      uptime: '进程已运行',
      fingerprint: '源码指纹',
      busy: '刷新中…',
      stale: '刷新失败'
    }

    /** 严重程度排序：决定入口圆点和标题胶囊的颜色。 */
    const DIAG_STATE_RANK = { info: 0, ok: 1, warn: 2, fail: 3 }
    const DIAG_STATE_ICON = { ok: '✓', warn: '!', fail: '×', info: '·' }
    const DIAG_STATE_LABEL = { ok: '正常', warn: '注意', fail: '问题', info: '参考' }

    /** 计数器字段 → 人话标签。顺序即展示顺序。 */
    const DIAG_COUNTERS = [
      ['approvalSeen', '看过审批'],
      ['preExecuteSeen', '看过工具调用'],
      ['generated', '生成成功'],
      ['failed', '生成失败'],
      ['skipped', '跳过'],
      ['timeouts', '超时'],
      ['cacheEntries', '缓存条目'],
      ['inFlight', '进行中']
    ]

    const h = react.createElement

    function diagStateOf(value) {
      return Object.prototype.hasOwnProperty.call(DIAG_STATE_RANK, value) ? value : 'info'
    }

    /** 整份报告里最严重的状态；空列表按 info 处理。 */
    function diagWorstState(checks) {
      let worst = 'info'
      if (!Array.isArray(checks)) return worst
      for (const check of checks) {
        const state = check !== null && typeof check === 'object' ? diagStateOf(String(check.state ?? 'info')) : 'info'
        if (DIAG_STATE_RANK[state] > DIAG_STATE_RANK[worst]) worst = state
      }
      return worst
    }

    /** 一句话结论：先报问题数，再报注意数，最后才是"全部正常"。 */
    function diagVerdict(checks) {
      const counts = { fail: 0, warn: 0, ok: 0, info: 0 }
      if (Array.isArray(checks)) {
        for (const check of checks) {
          const state = check !== null && typeof check === 'object' ? diagStateOf(String(check.state ?? 'info')) : 'info'
          counts[state] += 1
        }
      }
      if (counts.fail > 0) {
        return { state: 'fail', text: counts.warn > 0 ? `${counts.fail} 项问题 · ${counts.warn} 项注意` : `${counts.fail} 项问题` }
      }
      if (counts.warn > 0) return { state: 'warn', text: `${counts.warn} 项需要注意` }
      if (counts.ok > 0) return { state: 'ok', text: '全部正常' }
      return { state: 'info', text: '暂无可判定项' }
    }

    /** 毫秒 → 「1 小时 3 分」/「2 分 5 秒」/「37 秒」。 */
    function diagFormatDuration(ms) {
      const seconds = Math.max(0, Math.round(Number(ms) / 1000))
      if (!Number.isFinite(seconds)) return ''
      const hours = Math.floor(seconds / 3600)
      const minutes = Math.floor((seconds % 3600) / 60)
      const rest = seconds % 60
      if (hours > 0) return `${hours} 小时 ${minutes} 分`
      if (minutes > 0) return `${minutes} 分 ${rest} 秒`
      return `${rest} 秒`
    }

    /** ISO → 本地「MM-DD HH:mm:ss」；解析不了就返回空串（宁可不显示也不显示 NaN）。 */
    function diagFormatClock(iso) {
      if (typeof iso !== 'string' || iso === '') return ''
      const at = new Date(iso)
      if (Number.isNaN(at.getTime())) return ''
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
    }

    function diagText(value) {
      return typeof value === 'string' ? value : ''
    }

    /**
     * 读一次宿主诊断快照。
     *
     * 刻意不缓存：排障要的就是"现在这一刻"。宿主那边一次调用只做几次读目录/读文件，
     * 10 秒一次的节奏不构成负担。
     *
     * @returns 宿主返回的完整 model（ok === true 才认）。
     */
    async function readDiagReport() {
      const response = await fetch(DIAG_JSON_ROUTE, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' }
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      if (payload === null || typeof payload !== 'object' || payload.ok !== true) throw new Error('返回体不是诊断快照')
      return payload
    }

    // ── 渲染零件 ─────────────────────────────────────────────────────────────

    function diagField(label, value, mono) {
      if (value === undefined || value === null || value === '') return null
      return h(
        'div',
        { className: 'dshxd-row', key: `field-${label}` },
        h('span', { className: 'dshxd-rowLabel' }, label),
        h('span', { className: mono === true ? 'dshxd-rowValue dshxd-mono' : 'dshxd-rowValue' }, String(value))
      )
    }

    function diagSection(title, children) {
      const list = (Array.isArray(children) ? children : [children]).filter((child) => child !== null && child !== undefined)
      if (list.length === 0) return null
      return h(
        'section',
        { className: 'dshxd-section', key: `section-${title}` },
        h('div', { className: 'dshxd-sectionTitle' }, title),
        ...list
      )
    }

    function diagDetails(summary, children, key) {
      const list = (Array.isArray(children) ? children : [children]).filter((child) => child !== null && child !== undefined)
      if (list.length === 0) return null
      return h(
        'details',
        { className: 'dshxd-details', key },
        h('summary', { className: 'dshxd-summaryToggle' }, summary),
        h('div', { className: 'dshxd-detailsBody' }, ...list)
      )
    }

    function diagChips(values) {
      const list = Array.isArray(values) ? values.filter((item) => typeof item === 'string' && item.trim() !== '') : []
      if (list.length === 0) return null
      return h(
        'div',
        { className: 'dshxd-chips' },
        ...list.map((item, index) => h('span', { className: 'dshxd-chip', key: `chip-${index}` }, item))
      )
    }

    function diagCheckCard(check, index) {
      const state = check !== null && typeof check === 'object' ? diagStateOf(String(check.state ?? 'info')) : 'info'
      const title = check !== null && typeof check === 'object' ? diagText(check.title) : ''
      const detail = check !== null && typeof check === 'object' ? diagText(check.detail) : ''
      const action = check !== null && typeof check === 'object' ? diagText(check.action) : ''
      return h(
        'div',
        { className: 'dshxd-check', 'data-state': state, key: `check-${index}` },
        h(
          'div',
          { className: 'dshxd-checkHead' },
          h('span', { className: 'dshxd-checkIcon', 'data-state': state, 'aria-hidden': 'true' }, DIAG_STATE_ICON[state]),
          h('span', { className: 'dshxd-checkTitle' }, title === '' ? '(这一项没有标题)' : title),
          h('span', { className: 'dshxd-checkState', 'data-state': state }, DIAG_STATE_LABEL[state])
        ),
        detail === '' ? null : h('div', { className: 'dshxd-checkDetail' }, detail),
        action === '' ? null : h('div', { className: 'dshxd-checkAction' }, `→ ${action}`)
      )
    }

    function diagCountersGrid(instrumentation) {
      if (instrumentation === null || typeof instrumentation !== 'object') return null
      const cells = []
      for (const [key, label] of DIAG_COUNTERS) {
        const value = instrumentation[key]
        if (typeof value !== 'number') continue
        const hot = (key === 'failed' || key === 'timeouts') && value > 0
        cells.push(
          h(
            'div',
            { className: 'dshxd-cell', key: `cell-${key}` },
            h('div', { className: 'dshxd-cellValue', 'data-hot': hot ? 'true' : 'false' }, String(value)),
            h('div', { className: 'dshxd-cellLabel' }, label)
          )
        )
      }
      if (cells.length === 0) return null
      return h('div', { className: 'dshxd-grid' }, ...cells)
    }

    /** 「相关页面」：宿主把路由表一起送来了，这里做成可点按钮，**在应用内打开**。 */
    function diagRouteLinks(routes, openInApp) {
      if (routes === null || typeof routes !== 'object') return null
      const chips = []
      for (const [label, href] of Object.entries(routes)) {
        if (typeof href !== 'string' || href === '') continue
        chips.push(
          h(
            'button',
            { type: 'button', className: 'dshxd-route', key: `route-${label}`, title: href, onClick: () => openInApp(href) },
            label
          )
        )
      }
      if (chips.length === 0) return null
      return h('div', { className: 'dshxd-chips' }, ...chips)
    }

    // ── 面板 ─────────────────────────────────────────────────────────────────

    /**
     * 体检报告面板本体。
     *
     * @param props.report - { status, data?, message?, busy?, staleError? }
     * @param props.anchor - 由入口按钮量出来的定位 { left, bottom, width }
     * @param props.onRefresh - 重新检查
     * @param props.onClose - 关闭
     * @param props.openInApp - 在 DSH 内部打开一条站内路由（内置窗口优先）
     */
    function DiagPanel({ report, anchor, onRefresh, onClose, openInApp }) {
      const openRoute = typeof openInApp === 'function' ? openInApp : () => false
      const [copyState, setCopyState] = react.useState('idle')

      react.useEffect(() => {
        if (copyState === 'idle') return undefined
        const timer = setTimeout(() => setCopyState('idle'), 2400)
        return () => clearTimeout(timer)
      }, [copyState])

      const data = report.status === 'ready' && report.data !== null && typeof report.data === 'object' ? report.data : null
      const checks = data !== null && Array.isArray(data.checks) ? data.checks : []
      const verdict = diagVerdict(checks)
      const state = data !== null ? verdict.state : report.status === 'error' ? 'fail' : 'info'
      const version = data !== null ? diagText(data.version) : ''

      const copyRaw = () => {
        if (data === null) return
        let text = ''
        try {
          text = JSON.stringify(data, null, 2)
        } catch {
          setCopyState('failed')
          return
        }
        const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
        if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
          setCopyState('failed')
          return
        }
        clipboard.writeText(text).then(
          () => setCopyState('done'),
          () => setCopyState('failed')
        )
      }

      const body = []
      if (report.status === 'loading') {
        body.push(h('div', { className: 'dshxd-note', key: 'loading' }, DIAG_TEXT.loading))
      }
      if (report.status === 'error') {
        const message = diagText(report.message)
        body.push(
          h(
            'div',
            { className: 'dshxd-error', key: 'error' },
            h('div', { className: 'dshxd-errorTitle' }, `${DIAG_TEXT.failed}：${message === '' ? '未知原因' : message}`),
            h('div', { className: 'dshxd-note' }, DIAG_TEXT.failedHint),
            h(
              'div',
              { className: 'dshxd-actions' },
              h('button', { type: 'button', className: 'dshxd-action', onClick: onRefresh }, DIAG_TEXT.retry),
              h('button', { type: 'button', className: 'dshxd-action', onClick: () => openRoute(DIAG_ROUTE) }, DIAG_TEXT.openFull)
            )
          )
        )
      }

      if (data !== null) {
        // ① 检查项：宿主已经写成「状态 + 标题 + 说明 + 该做什么」四段，原样呈现。
        body.push(
          diagSection(
            `${DIAG_TEXT.checks} · ${checks.length}`,
            checks.map((check, index) => diagCheckCard(check, index))
          )
        )

        // ② 计数器：插件到底有没有真的执行过，看这里。
        const grid = diagCountersGrid(data.instrumentation)
        if (grid !== null) body.push(diagSection(DIAG_TEXT.counters, [grid]))

        // ③ 浏览器半区：启动图有没有它、版本对不对、页面侧有没有报过错。
        const halfRows = []
        const half = data.clientHalf
        if (half === null || half === undefined) {
          halfRows.push(
            h(
              'div',
              { className: 'dshxd-note', key: 'half-none' },
              data.clientDeclared === true ? '清单声明了 dsh.client，但启动图里取不到这一条。' : '清单没有声明 dsh.client，浏览器半区不会被加载。'
            )
          )
        } else {
          halfRows.push(diagField('启动图', typeof half.inGraph === 'boolean' ? (half.inGraph ? '已加载' : '未加载') : '未知'))
          halfRows.push(diagField('版本', half.rev === null || half.rev === undefined ? '' : String(half.rev), true))
          halfRows.push(diagField('入口', half.url === null || half.url === undefined ? '' : String(half.url), true))
          if (half.error !== undefined && half.error !== null) halfRows.push(diagField('读取错误', String(half.error)))
        }
        const clientErrors = data.clientErrors
        if (clientErrors !== null && typeof clientErrors === 'object') {
          const lines = Number(clientErrors.totalLines)
          const sessions = Number(clientErrors.sessions)
          halfRows.push(
            diagField('上报日志', `${Number.isFinite(lines) ? lines : 0} 行 · ${Number.isFinite(sessions) ? sessions : 0} 个会话`)
          )
          halfRows.push(diagField('最近一条', diagFormatClock(clientErrors.lastAt)))
          const failures = Array.isArray(clientErrors.failures)
            ? clientErrors.failures.filter((failure) => failure !== null && typeof failure === 'object')
            : []
          for (let index = 0; index < Math.min(failures.length, 3); index += 1) {
            const failure = failures[index]
            halfRows.push(
              h(
                'div',
                { className: 'dshxd-failure', key: `failure-${index}` },
                h('span', { className: 'dshxd-mono' }, `[${diagText(failure.phase)}] `),
                diagText(failure.message)
              )
            )
          }
          const phases = diagChips(clientErrors.phases)
          if (phases !== null) halfRows.push(diagDetails('阶段路标', [phases], 'phases'))
        }
        body.push(diagSection(DIAG_TEXT.clientHalf, halfRows))

        // ④ 崩溃与自愈：这两项是判定「有没有出过事」的决定性信号。
        const crashRows = []
        const crashes = data.crashes
        if (crashes !== null && typeof crashes === 'object') {
          crashRows.push(diagField('崩溃报告', `${Number(crashes.count) || 0} 份`))
          crashRows.push(diagField('最新一份', diagText(crashes.newest), true))
          crashRows.push(diagField('写于', diagFormatClock(crashes.newestTime)))
          const signals = Array.isArray(crashes.signals) ? crashes.signals.filter((item) => typeof item === 'string' && item.trim() !== '') : []
          const signalBlock =
            signals.length === 0
              ? null
              : diagDetails('失败条目', [h('pre', { className: 'dshxd-pre', key: 'signals' }, signals.slice(0, 3).join('\n\n'))], 'signals')
          if (signalBlock !== null) crashRows.push(signalBlock)
          if (crashes.error !== undefined && crashes.error !== null) crashRows.push(diagField('读取错误', String(crashes.error)))
        }
        const selfHeal = data.selfHeal
        if (selfHeal !== null && typeof selfHeal === 'object') {
          crashRows.push(diagField('自愈遗迹', `${Number(selfHeal.count) || 0} 次`))
          crashRows.push(diagField('最近一次', diagText(selfHeal.newest), true))
          crashRows.push(diagField('发生于', diagFormatClock(selfHeal.newestTime)))
        }
        body.push(diagSection(DIAG_TEXT.crashes, crashRows))

        // ⑤ profile 配置：被自愈削过的痕迹全长在这里。
        const profileRows = []
        const profile = data.profile
        if (profile !== null && typeof profile === 'object') {
          profileRows.push(diagField('目录', diagText(profile.profileDir), true))
          profileRows.push(diagField('补丁块', `${Number(profile.patchEntries) || 0} 个`))
          profileRows.push(diagField('模型选择', profile.patchHasModelConfig === true ? '在位' : '缺失'))
          const bundles = diagChips(profile.bundles)
          if (bundles !== null) profileRows.push(bundles)
          if (profile.error !== undefined && profile.error !== null) profileRows.push(diagField('读取错误', String(profile.error)))
        }
        body.push(diagSection(DIAG_TEXT.profile, profileRows))

        // ⑥ 注释缓存：只在这一轮真的生成过注释时才有内容。
        const annotations = Array.isArray(data.annotations) ? data.annotations : []
        if (annotations.length > 0) {
          body.push(
            diagSection(
              `注释缓存 · ${annotations.length}`,
              annotations.slice(0, 20).map((row, index) => {
                const item = row !== null && typeof row === 'object' ? row : {}
                return h(
                  'div',
                  { className: 'dshxd-failure', key: `annotation-${index}` },
                  `${diagText(item.时间)} · ${diagText(item.工具)} · 风险 ${diagText(item.风险) || '—'} · ${diagText(item.结论)}`
                )
              })
            )
          )
        }

        // ⑦ 相关页面：路由表由宿主给，点一下就能直接看到对应页面。
        const links = diagRouteLinks(data.routes, openRoute)
        if (links !== null) body.push(diagSection(DIAG_TEXT.routes, [links]))

        // ⑧ 日志尾部：失败的原始现场。
        const logBlocks = []
        const pluginErrors = Array.isArray(data.pluginErrors) ? data.pluginErrors.filter((line) => typeof line === 'string') : []
        if (pluginErrors.length > 0) {
          logBlocks.push(diagDetails('插件错误日志', [h('pre', { className: 'dshxd-pre', key: 'plugin-errors' }, pluginErrors.join('\n'))], 'plugin-errors'))
        }
        const activityTail = Array.isArray(data.activityTail) ? data.activityTail.filter((line) => typeof line === 'string') : []
        if (activityTail.length > 0) {
          logBlocks.push(diagDetails('活动日志尾部', [h('pre', { className: 'dshxd-pre', key: 'activity' }, activityTail.join('\n'))], 'activity'))
        }
        body.push(diagSection(DIAG_TEXT.logs, logBlocks))

        // ⑨ 原始数据：面板展示不全（或展示错了）时的最终依据。
        let rawJson = ''
        try {
          rawJson = JSON.stringify(data, null, 2)
        } catch {
          rawJson = ''
        }
        const copyLabel = copyState === 'done' ? DIAG_TEXT.copied : copyState === 'failed' ? DIAG_TEXT.copyFailed : DIAG_TEXT.copy
        body.push(
          diagSection(DIAG_TEXT.raw, [
            h(
              'div',
              { className: 'dshxd-actions', key: 'raw-actions' },
              h('button', { type: 'button', className: 'dshxd-action', onClick: copyRaw }, copyLabel),
              h('button', { type: 'button', className: 'dshxd-action', onClick: () => openRoute(DIAG_JSON_ROUTE) }, '在应用内打开 JSON')
            ),
            diagDetails('完整 JSON', [h('pre', { className: 'dshxd-pre', key: 'raw' }, rawJson)], 'raw')
          ])
        )
      }

      const metaItems = []
      if (data !== null) {
        metaItems.push(h('span', { className: 'dshxd-metaItem', key: 'checked' }, `${DIAG_TEXT.checkedAt} ${diagFormatClock(data.checkedAt)}`))
        metaItems.push(h('span', { className: 'dshxd-metaItem', key: 'uptime' }, `${DIAG_TEXT.uptime} ${diagFormatDuration(data.uptimeMs)}`))
        const fingerprint = diagText(data.moduleFingerprint)
        if (fingerprint !== '') {
          metaItems.push(h('span', { className: 'dshxd-metaItem dshxd-mono', key: 'fingerprint' }, `${DIAG_TEXT.fingerprint} ${fingerprint.slice(0, 12)}`))
        }
      }
      if (report.busy === true) metaItems.push(h('span', { className: 'dshxd-metaItem', key: 'busy' }, DIAG_TEXT.busy))
      if (report.staleError !== undefined && report.staleError !== null) {
        metaItems.push(h('span', { className: 'dshxd-metaItem', key: 'stale' }, `${DIAG_TEXT.stale}：${String(report.staleError)}`))
      }

      const style =
        anchor === null || anchor === undefined
          ? { left: '12px', bottom: '8px', width: `${DIAG_PANEL_WIDTH}px` }
          : { left: `${anchor.left}px`, bottom: `${anchor.bottom}px`, width: `${anchor.width}px` }

      return h(
        'div',
        {
          className: 'dshxd-panel',
          style,
          role: 'dialog',
          'aria-label': DIAG_TEXT.title,
          'data-approval-diag': 'panel'
        },
        h(
          'div',
          { className: 'dshxd-head' },
          h('span', { className: 'dshxd-headIcon', 'aria-hidden': 'true' }, '🩺'),
          h('span', { className: 'dshxd-headTitle' }, DIAG_TEXT.title),
          version === '' ? null : h('span', { className: 'dshxd-headVersion' }, `v${version}`),
          h(
            'span',
            { className: 'dshxd-pill', 'data-state': state },
            data === null ? (report.status === 'error' ? '读不到' : '读取中') : verdict.text
          ),
          h('span', { className: 'dshxd-flex' }),
          h('button', { type: 'button', className: 'dshxd-iconBtn', title: DIAG_TEXT.refresh, 'aria-label': DIAG_TEXT.refresh, onClick: onRefresh }, '↻'),
          h(
            'button',
            { type: 'button', className: 'dshxd-iconBtn', title: DIAG_TEXT.openFull, 'aria-label': DIAG_TEXT.openFull, onClick: () => openRoute(DIAG_ROUTE) },
            '↗'
          ),
          h('button', { type: 'button', className: 'dshxd-iconBtn', title: DIAG_TEXT.close, 'aria-label': DIAG_TEXT.close, onClick: onClose }, '×')
        ),
        metaItems.length === 0 ? null : h('div', { className: 'dshxd-meta' }, ...metaItems),
        h('div', { className: 'dshxd-body', 'data-approval-diag': 'body' }, ...body),
        h('div', { className: 'dshxd-foot' }, `打开时每 ${DIAG_REFRESH_MS / 1000} 秒自动刷新；判定只在宿主算一次，这里只负责展示。宿主半区改动需重启 DSH，浏览器半区刷新页面即可。`)
      )
    }

    // ── 入口按钮（侧边栏底，和 Cordis 面板同一个座位）─────────────────────────

    /**
     * 侧边栏底的「插件体检」按钮。
     *
     * 座位 `sidebar.footer.action` 是 list 类型，所以是「加一个」而不是「顶掉谁」；
     * 同一座位上的 Cordis 面板不受影响。
     *
     * 注意：面板用 position:fixed 挂在按钮上（Cordis 面板也是这么做的），
     * 因为侧边栏列是 overflow:hidden —— 用 absolute 会被裁掉一半。
     */
    function DiagFooterAction({ wide, openInApp }) {
      const [open, setOpen] = react.useState(false)
      const [report, setReport] = react.useState({ status: 'idle' })
      const [anchor, setAnchor] = react.useState(null)
      const rootRef = react.useRef(null)
      // 请求序号 + 存活标记：关闭/重开/卸载后，迟到的响应不许再写状态。
      const requestRef = react.useRef(0)
      const liveRef = react.useRef(true)

      react.useEffect(() => {
        liveRef.current = true
        return () => {
          liveRef.current = false
        }
      }, [])

      const load = react.useCallback((quiet) => {
        const ticket = requestRef.current + 1
        requestRef.current = ticket
        if (quiet !== true) {
          setReport((current) => (current.status === 'ready' ? { ...current, busy: true, staleError: null } : { status: 'loading' }))
        }
        readDiagReport().then(
          (data) => {
            if (!liveRef.current || requestRef.current !== ticket) return
            setReport({ status: 'ready', data, busy: false })
          },
          (error) => {
            if (!liveRef.current || requestRef.current !== ticket) return
            const message = String((error && error.message) || error)
            setReport((current) =>
              current.status === 'ready' ? { ...current, busy: false, staleError: message } : { status: 'error', message }
            )
          }
        )
      }, [])

      // 平时也静默读一次：只为给入口按钮上那个小圆点上色（健康状态一眼可见）。
      react.useEffect(() => {
        load(true)
      }, [load])

      // 打开时立刻读一次，随后按节奏自动刷新；关掉就停。
      react.useEffect(() => {
        if (!open) return undefined
        load(false)
        const timer = setInterval(() => load(true), DIAG_REFRESH_MS)
        return () => clearInterval(timer)
      }, [open, load])

      // 定位：贴着入口按钮往上弹；左边界夹在视口里，避免窄窗口下溢出。
      react.useLayoutEffect(() => {
        if (!open) return undefined
        const place = () => {
          const node = rootRef.current
          if (node === null) return
          const rect = node.getBoundingClientRect()
          if (rect.width === 0 && rect.height === 0) return
          const width = Math.max(320, Math.min(DIAG_PANEL_WIDTH, window.innerWidth - 24))
          const maxLeft = Math.max(8, window.innerWidth - width - 8)
          setAnchor({
            left: Math.min(Math.max(8, rect.left), maxLeft),
            bottom: Math.max(8, window.innerHeight - rect.top + 8),
            width
          })
        }
        place()
        window.addEventListener('resize', place)
        return () => window.removeEventListener('resize', place)
      }, [open])

      // Esc 关闭 + 点外面关闭。用捕获阶段，免得被面板内部元素吞掉。
      react.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onPointer = (event) => {
          const node = rootRef.current
          if (node === null || node.contains(event.target)) return
          setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('pointerdown', onPointer, true)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('pointerdown', onPointer, true)
        }
      }, [open])

      const state = report.status === 'ready' ? diagWorstState(report.data?.checks) : report.status === 'error' ? 'fail' : 'info'
      const isWide = wide !== false

      return h(
        'div',
        { className: 'dshxd-layer', ref: rootRef, 'data-wide': isWide ? 'true' : 'false', 'data-approval-diag': 'entry' },
        h(
          'button',
          {
            type: 'button',
            className: 'dshxd-badge',
            'data-open': open ? 'true' : 'false',
            'aria-expanded': open ? 'true' : 'false',
            'aria-haspopup': 'dialog',
            title: DIAG_TEXT.entry,
            onClick: () => setOpen((value) => !value)
          },
          h('span', { className: 'dshxd-badgeIcon', 'aria-hidden': 'true' }, '🩺'),
          h('span', { className: 'dshxd-badgeLabel' }, DIAG_TEXT.entry),
          h('span', { className: 'dshxd-dot', 'data-state': state, 'aria-hidden': 'true' })
        ),
        open
          ? h(DiagPanel, {
              key: 'panel',
              report,
              anchor,
              openInApp,
              onRefresh: () => load(false),
              onClose: () => setOpen(false)
            })
          : null
      )
    }

    /**
     * 把体检入口装到侧边栏底。
     *
     * 和审批详情渲染器同一条纪律：**绝不许抛**。入口装不上最多是"少一个按钮"，
     * 绝不能让 web boot 失败（那会连累别人、还会触发崩溃自愈）。
     */
    function installDiagEntry(ctx) {
      try {
        const slots = ctx === undefined || ctx === null ? undefined : ctx.slots
        if (slots === undefined || slots === null || typeof slots.inject !== 'function') {
          console.warn(`${LOG_PREFIX} sidebar.footer.action 不可用，跳过体检入口`)
          return undefined
        }
        return slots.inject('sidebar.footer.action', () => {
          try {
            if (typeof slots.register !== 'function') {
              console.warn(`${LOG_PREFIX} ctx.slots.register 不可用，跳过体检入口`)
              return undefined
            }
            return slots.register(
              {
                name: 'sidebar.footer.action',
                id: 'approval-diag',
                order: -1,
                inject: () => ({ openInApp: (route) => openInAppPage(ctx, route, 'diag') })
              },
              DiagFooterAction
            )
          } catch (error) {
            console.error(`${LOG_PREFIX} 注册体检入口失败:`, error)
            return undefined
          }
        })
      } catch (error) {
        console.error(`${LOG_PREFIX} 注入体检入口插槽失败:`, error)
        return undefined
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // 历史授权入口 —— 宿主 GET /dsh-approval/history 的**浮层面板**
    //
    // 宿主半区从 0.7.0 就有历史记录与查询页，但入口只有"自己敲 URL"。
    // 这里在「对话 / 轨迹」那一带的会话头部动作行加一个原生风格小按钮，
    // 点一下在**对话上方浮出面板**（与「插件体检」面板同一套交互与样式），
    // 数据走 /dsh-approval/history?raw=1，全在应用内，不导航、不弹浏览器。
    //
    // ── 兼容性（这一行被多个插件共用）──────────────────────────────────────
    //   · 座位 conversation.session.header.actions 是 **list**，所以是"加一个"；
    //     日志中已有的占用者：agent-preset / job-list / schedule-catalog / agent-team
    //   · 必须带自己的 id（approval-history），**不设 priority**（那是 single
    //     座位的概念，在这里写只会让人误以为要抢渲染权）
    //   · 只用 order 排在原生条目之后，不抢首位
    //   · 尺寸/字号/颜色向原生头部动作看齐；不设宽度、不绝对定位、不撑高行
    //   · 宿主半区不在（老版本）或座位不存在 → 注册失败只降级，绝不外抛
    //   · **fetch 用相对路径走代理**（桌面壳里 dsh-app://app/ 由主进程转发到宿主），
    //     但**切到浏览器侧打开时必须用绝对 URL**（见 hostOrigin() 的注释：
    //     相对路径在桌面壳里会变成 dsh-app://，主进程一律 deny）
    // ══════════════════════════════════════════════════════════════════════

    /** 历史页路径（站内路由；面板里的「完整页面」按钮用 absoluteUrl() 补宿主 origin）。 */
    const HISTORY_ROUTE = '/dsh-approval/history'

    /** 面板一次取多少条；服务端过滤另外支持，这里筛选在本地做（切换即时）。 */
    const HISTORY_JSON_ROUTE = '/dsh-approval/history?raw=1&limit=200'
    const HISTORY_MAX_ROWS = 200

    const HISTORY_TEXT = {
      label: '审批历史',
      open: '打开历史授权面板',
      title: '历史授权',
      refresh: '重新读取',
      close: '关闭',
      loading: '正在读取历史记录…',
      failed: '读不到历史记录',
      failedHint: '宿主半区没加载，或 /dsh-approval/history 被本机栅栏挡住了。先点「完整页面」直连试试；仍然不通就重启 DSH。',
      retry: '重试',
      empty: '还没有历史记录。',
      noMatch: '没有匹配的记录。',
      search: '搜索工具 / 路径 / 理由…',
      allDecisions: '全部决策',
      allRisks: '全部风险',
      fullPage: '完整页面',
      footer: '数据来自 profile 下的 annotations.jsonl 与 DSH 会话日志'
    }

    /**
     * 宿主的绝对 origin；拿不到就返回空串。
     *
     * ⚠ 这是 2026-10-19「按钮点不动」的根因所在。
     *
     * 桌面壳里页面跑在自定义协议 `dsh-app://app/` 上（主进程把请求代理到宿主
     * HTTP 服务），所以：
     *   · `fetch('/dsh-approval/...')` 走代理，**没问题**；
     *   · 用相对地址开新窗口（无论锚点还是脚本 API）都会把相对路径
     *     解析成 `dsh-app://app/dsh-approval/history` —— 这不是 http(s)，
     *     主进程的 `setWindowOpenHandler` 只把 http(s) 交给系统浏览器，
     *     其余一律 `{action:"deny"}`，**静默拒绝**。表现就是"点了没反应"。
     *
     * 宿主 origin 本来就注入在渲染进程里：桌面启动时前端把
     * `__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl: new URL(hostUrl).origin }`。
     * 浏览器模式下没有这个值 —— 那时页面 origin 就是宿主 origin，用相对路径即可。
     *
     * @returns 形如 `http://127.0.0.1:50302` 的 origin，或 ""。
     */
    function hostOrigin() {
      try {
        const base = globalThis === undefined ? undefined : globalThis.__DSH_TRANSPORT__
        const value = base === null || base === undefined ? undefined : base.streamBaseUrl
        if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value.replace(/\/+$/, '')
      } catch {
        /* 拿不到就走相对路径 */
      }
      return ''
    }

    /**
     * 站内路由 → 可在新标签/外部浏览器打开的 URL。
     *
     * @param route - 以 `/` 开头的站内路由。
     * @returns 绝对 URL（拿不到宿主 origin 时退化为相对路径）。
     */
    function absoluteUrl(route) {
      const origin = hostOrigin()
      return origin === '' ? route : origin + route
    }

    /** 把一次打开尝试写进宿主的 client-errors.log（诊断用，失败静默）。 */
    function reportHistoryEvent(phase, detail) {
      try {
        if (typeof fetch !== 'function') return
        fetch('/dsh-approval/report-error', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ phase, detail, at: new Date().toISOString() }),
          keepalive: true
        }).catch(() => {})
      } catch {
        /* 诊断失败不影响功能 */
      }
    }

    /** 从任意值里取一段可读的错误文本。 */
    function errorText(error) {
      return String((error && error.message) || error)
    }

    /**
     * 在 DSH **内部**打开一个站内页面：内置窗口优先，绝不外跳。
     *
     * ```
     * ① 应用内右侧浏览器标签（内置窗口）：`sidebarRight.openTab('browser', { params: { url } })`
     *    —— 和 DSH 自己 `linkOpening=sidebar` 时打开链接走的是同一个 API。
     *    桌面壳里它是原生 view；宿主 http URL 与文档 origin（dsh-app://app）不同源，
     *    因此不会被内置浏览器的"禁止打开自身 origin"规则挡住。
     * ② 同窗口内导航：用**当前页面协议**拼 URL（桌面壳 → `dsh-app://app/...`，
     *    浏览器模式 → 同源 http）。两者都还在 DSH 窗口里。
     * ```
     *
     * **刻意不调用 `window.open`**：桌面壳的主进程只把 http(s) 交给系统浏览器，
     * 那正是用户不要的"弹到软件外面"。相对路径更不行 —— 会被解析成
     * `dsh-app://app/...` 后静默 deny（0.9.0 的"点不动"就是这么来的）。
     *
     * @param ctx - 客户端上下文（用于取 sidebarRight / sidebarRightTabs 服务）。
     * @param route - 站内路由（以 / 开头）。
     * @param tag - 诊断前缀（history / diag …）。
     * @returns 是否至少触发了某条路径。
     */
    function openInAppPage(ctx, route, tag) {
      const url = absoluteUrl(route)
      const desktopShell = (() => {
        try {
          return globalThis !== undefined && globalThis.dshDesktop !== undefined
        } catch {
          return false
        }
      })()
      reportHistoryEvent(`${tag}-open-attempt`, `desktop=${desktopShell} url=${url}`)

      // ① 应用内右侧浏览器标签（"内置窗口"）
      if (desktopShell) {
        const readService = (name) => {
          try {
            return ctx !== undefined && ctx !== null && typeof ctx.get === 'function' ? ctx.get(name) : undefined
          } catch {
            return undefined
          }
        }
        const right = readService('sidebarRight')
        const tabs = readService('sidebarRightTabs')
        let browserTab = false
        try {
          browserTab = tabs !== undefined && tabs !== null && typeof tabs.get === 'function' && tabs.get('browser') !== undefined
        } catch {
          browserTab = false
        }
        if (right !== undefined && right !== null && typeof right.openTab === 'function' && browserTab) {
          try {
            right.openTab('browser', { params: { url } })
            reportHistoryEvent(`${tag}-open`, 'path=sidebar-browser')
            return true
          } catch (error) {
            reportHistoryEvent(`${tag}-open-error`, `sidebar-browser: ${errorText(error)}`)
          }
        } else {
          reportHistoryEvent(`${tag}-open-skip`, `sidebarRight=${typeof right} browserTab=${browserTab}`)
        }
      }

      // ② 同窗口内导航：用当前页面协议拼，保证仍然在 DSH 窗口里
      try {
        if (typeof window !== 'undefined' && window.location !== undefined) {
          const inAppUrl = new URL(route, window.location.href).href
          if (typeof window.location.assign === 'function') {
            reportHistoryEvent(`${tag}-open`, 'path=same-window')
            window.location.assign(inAppUrl)
            return true
          }
        }
      } catch (error) {
        reportHistoryEvent(`${tag}-open-error`, `same-window: ${errorText(error)}`)
      }

      reportHistoryEvent(`${tag}-open-failed`, 'no in-app path available')
      return false
    }

    /**
     * 在**默认浏览器**里打开一个站内页面（「完整页面」这类高级操作用）。
     *
     * 用户明确要求：面板本身留在 DSH 里，但"完整历史"要跳到默认浏览器。
     * 桌面壳里 `window.open(http 绝对 URL)` 会被主进程交给 `shell.openExternal`
     * —— 这正是"默认浏览器"。**相对路径不行**：会变成 `dsh-app://...` 被 deny
     * （0.9.0 的"点不动"就是这么来的），所以统一先 `absoluteUrl()`。
     *
     * @param route - 站内路由（以 / 开头）。
     * @param tag - 诊断前缀（history / diag …）。
     * @returns 是否触发了打开。
     */
    function openInBrowser(route, tag) {
      const url = absoluteUrl(route)
      reportHistoryEvent(`${tag}-browser-attempt`, `url=${url}`)
      try {
        if (typeof window !== 'undefined' && typeof window.open === 'function') {
          window.open(url, '_blank', 'noopener,noreferrer')
          reportHistoryEvent(`${tag}-browser-open`, 'path=default-browser')
          return true
        }
      } catch (error) {
        reportHistoryEvent(`${tag}-browser-error`, errorText(error))
      }
      reportHistoryEvent(`${tag}-browser-failed`, 'window.open unavailable')
      return false
    }

    // ── 历史面板：数据、格式化、过滤 ─────────────────────────────────────────

    const HISTORY_OUTCOME_LABEL = {
      'allowed-once': '允许一次',
      rejected: '已拒绝',
      cancelled: '已取消',
      pending: '待定',
      unavailable: '未知'
    }

    const HISTORY_OUTCOME_TONE = {
      'allowed-once': 'ok',
      rejected: 'fail',
      cancelled: 'info',
      pending: 'warn',
      unavailable: 'info'
    }

    const HISTORY_RISK_LABEL = { low: '低风险', medium: '中风险', high: '高风险' }
    const HISTORY_RISK_TONE = { low: 'ok', medium: 'warn', high: 'fail' }

    /** outcome → 人话；未知值不抛，统一显示"未知"。 */
    function historyOutcomeLabel(outcome) {
      return HISTORY_OUTCOME_LABEL[String(outcome === null || outcome === undefined ? '' : outcome)] ?? '未知'
    }

    function historyOutcomeTone(outcome) {
      return HISTORY_OUTCOME_TONE[String(outcome === null || outcome === undefined ? '' : outcome)] ?? 'info'
    }

    function historyRiskLabel(risk) {
      return HISTORY_RISK_LABEL[String(risk === null || risk === undefined ? '' : risk)] ?? ''
    }

    function historyRiskTone(risk) {
      return HISTORY_RISK_TONE[String(risk === null || risk === undefined ? '' : risk)] ?? 'info'
    }

    /** 长 id 截短，保留可辨认的头尾。 */
    function shortId(value) {
      const text = typeof value === 'string' ? value : ''
      if (text.length <= 14) return text
      return text.slice(0, 6) + '…' + text.slice(-4)
    }

    /**
     * 一条历史记录是否命中筛选。纯函数，便于离线断言。
     *
     * @param item - /dsh-approval/history?raw=1 的一条 items。
     * @param filters - { q, decision, risk }；空值表示不过滤。
     * @returns 是否命中。
     */
    function historyMatches(item, filters) {
      if (item === null || typeof item !== 'object') return false
      const f = filters === null || typeof filters !== 'object' ? {} : filters
      const q = typeof f.q === 'string' ? f.q.trim().toLowerCase() : ''
      if (q !== '') {
        const haystack = [
          item.tool,
          item.reason,
          item.sessionId,
          item.callId,
          item.approvalId,
          item.annotation?.what,
          item.annotation?.intent,
          item.annotation?.risk_reason,
          item.annotation?.recommend
        ]
          .filter((value) => typeof value === 'string')
          .join('\n')
          .toLowerCase()
        if (!haystack.includes(q)) return false
      }
      if (typeof f.decision === 'string' && f.decision !== '' && String(item.outcome ?? '') !== f.decision) return false
      if (typeof f.risk === 'string' && f.risk !== '' && String(item.risk ?? '') !== f.risk) return false
      return true
    }

    /** 读历史快照。失败抛错，由调用方降级成面板里的错误态。 */
    async function readHistoryReport() {
      const response = await fetch(HISTORY_JSON_ROUTE, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' }
      })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const payload = await response.json()
      if (payload === null || typeof payload !== 'object' || payload.ok !== true) throw new Error('返回体不是历史快照')
      return payload
    }

    // ── 历史面板 ─────────────────────────────────────────────────────────────

    function historyBadge(label, tone) {
      return h('span', { className: 'dshxi-badge', 'data-tone': tone }, label)
    }

    /** 一条记录：头部一行摘要，展开看注释与实参。 */
    function historyRow(item, index) {
      const safeItem = item !== null && typeof item === 'object' ? item : {}
      const annotation = safeItem.annotation !== null && typeof safeItem.annotation === 'object' ? safeItem.annotation : null
      const argsDigest = safeItem.argsDigest !== null && typeof safeItem.argsDigest === 'object' ? safeItem.argsDigest : null
      let argsText = ''
      if (argsDigest !== null) {
        try {
          argsText = JSON.stringify(argsDigest, null, 2)
        } catch {
          argsText = String(argsDigest)
        }
      }

      const fields = []
      const pushField = (label, value) => {
        if (typeof value !== 'string' || value.trim() === '') return
        fields.push(
          h(
            'div',
            { className: 'dshxi-field', key: 'field-' + label },
            h('div', { className: 'dshxi-fieldLabel' }, label),
            h('div', { className: 'dshxi-fieldValue' }, value)
          )
        )
      }
      if (annotation !== null) {
        pushField('这段代码在做什么', annotation.what)
        pushField('模型想达成什么', annotation.intent)
        pushField('风险判断理由', annotation.risk_reason)
        pushField('建议', annotation.recommend)
        pushField('点「允许一次」意味着', annotation.approve_meaning)
        pushField('点「拒绝」意味着', annotation.reject_meaning)
        const hazards = Array.isArray(annotation.hazards)
          ? annotation.hazards.filter((hazard) => typeof hazard === 'string' && hazard.trim() !== '')
          : []
        if (hazards.length > 0) {
          fields.push(
            h(
              'div',
              { className: 'dshxi-field', key: 'hazards' },
              h('div', { className: 'dshxi-fieldLabel' }, '风险点'),
              h('ul', { className: 'dshxi-hazards' }, ...hazards.map((hazard, hazardIndex) => h('li', { key: 'hz-' + hazardIndex }, hazard)))
            )
          )
        }
      }

      const meta = []
      if (typeof safeItem.callId === 'string' && safeItem.callId !== '') meta.push('callId ' + shortId(safeItem.callId))
      if (typeof safeItem.tookMs === 'number' && Number.isFinite(safeItem.tookMs)) meta.push((safeItem.tookMs / 1000).toFixed(1) + 's')
      if (typeof safeItem.confidence === 'string' && safeItem.confidence !== '') meta.push('置信度 ' + safeItem.confidence)
      if (safeItem.annotationUnlinked === true) meta.push('注释未关联')

      const summary = [
        h('span', { className: 'dshxi-time', key: 'time' }, diagFormatClock(safeItem.at)),
        h('span', { className: 'dshxi-tool', key: 'tool' }, typeof safeItem.tool === 'string' && safeItem.tool !== '' ? safeItem.tool : '(未知工具)')
      ]
      const riskLabel = historyRiskLabel(safeItem.risk)
      if (riskLabel !== '') summary.push(historyBadge(riskLabel, historyRiskTone(safeItem.risk)))
      summary.push(historyBadge(historyOutcomeLabel(safeItem.outcome), historyOutcomeTone(safeItem.outcome)))
      summary.push(h('span', { className: 'dshxi-session', key: 'session' }, shortId(safeItem.sessionId)))

      return h(
        'details',
        { className: 'dshxi-row', key: 'row-' + index },
        h('summary', { className: 'dshxi-rowHead' }, ...summary),
        h(
          'div',
          { className: 'dshxi-rowBody' },
          typeof safeItem.reason === 'string' && safeItem.reason !== '' ? h('div', { className: 'dshxi-reason', key: 'reason' }, safeItem.reason) : null,
          meta.length > 0 ? h('div', { className: 'dshxi-meta', key: 'meta' }, meta.join(' · ')) : null,
          ...fields,
          argsText === ''
            ? null
            : h(
                'div',
                { className: 'dshxi-field', key: 'args' },
                h('div', { className: 'dshxi-fieldLabel' }, '实参摘要'),
                h('pre', { className: 'dshxi-pre' }, argsText)
              )
        )
      )
    }

    /**
     * 历史浮层面板（对话上方，固定在入口按钮下方）。
     *
     * 「完整页面」按钮**跳默认浏览器**（用户 0.9.4 的明确要求）：
     * 面板负责日常查看，完整页面负责清空历史等高级操作。
     *
     * @param props.report - { status, data?, message?, busy? }
     * @param props.filters - { q, decision, risk }
     * @param props.onFilter - 更新筛选
     * @param props.onRefresh - 重新读取
     * @param props.onClose - 关闭
     * @returns 面板元素。
     */
    function HistoryPanel({ report, filters, onFilter, onRefresh, onClose }) {
      const data = report.status === 'ready' && report.data !== null && typeof report.data === 'object' ? report.data : null
      const items = data !== null && Array.isArray(data.items) ? data.items : []
      const visible = items.filter((item) => historyMatches(item, filters))
      const active = filters !== null && typeof filters === 'object' ? filters : {}

      const body = []
      if (report.status === 'loading') body.push(h('div', { className: 'dshxi-note', key: 'loading' }, HISTORY_TEXT.loading))
      if (report.status === 'error') {
        const message = typeof report.message === 'string' && report.message !== '' ? report.message : '未知原因'
        body.push(
          h(
            'div',
            { className: 'dshxi-error', key: 'error' },
            h('div', { className: 'dshxi-errorTitle' }, HISTORY_TEXT.failed + '：' + message),
            h('div', { className: 'dshxi-note' }, HISTORY_TEXT.failedHint),
            h(
              'div',
              { className: 'dshxi-actions' },
              h('button', { type: 'button', className: 'dshxi-action', onClick: onRefresh }, HISTORY_TEXT.retry),
              h('button', { type: 'button', className: 'dshxi-action', onClick: () => openInBrowser(HISTORY_ROUTE, 'history'), title: '在默认浏览器打开完整历史' }, HISTORY_TEXT.fullPage)
            )
          )
        )
      }
      if (data !== null) {
        if (items.length === 0) {
          body.push(h('div', { className: 'dshxi-note', key: 'empty' }, HISTORY_TEXT.empty))
        } else if (visible.length === 0) {
          body.push(h('div', { className: 'dshxi-note', key: 'nomatch' }, HISTORY_TEXT.noMatch))
        } else {
          body.push(h('div', { className: 'dshxi-list', key: 'list' }, ...visible.map((item, index) => historyRow(item, index))))
        }
      }

      const total = data !== null && typeof data.total === 'number' ? data.total : items.length
      const countText = data === null ? '读取中' : visible.length === items.length ? total + ' 条' : visible.length + ' / ' + items.length + ' 条'

      return h(
        'div',
        { className: 'dshxi-panel', role: 'dialog', 'aria-label': HISTORY_TEXT.title, 'data-approval-history': 'panel' },
        h(
          'div',
          { className: 'dshxi-head' },
          h('span', { className: 'dshxi-headIcon', 'aria-hidden': 'true' }, '🕘'),
          h('span', { className: 'dshxi-title' }, HISTORY_TEXT.title),
          h('span', { className: 'dshxi-count' }, countText),
          h('span', { className: 'dshxd-flex' }),
          report.busy === true ? h('span', { className: 'dshxi-count', key: 'busy' }, '刷新中…') : null,
          h('button', { type: 'button', className: 'dshxd-iconBtn', title: HISTORY_TEXT.refresh, 'aria-label': HISTORY_TEXT.refresh, onClick: onRefresh }, '↻'),
          h('button', { type: 'button', className: 'dshxd-iconBtn', title: HISTORY_TEXT.close, 'aria-label': HISTORY_TEXT.close, onClick: onClose }, '×')
        ),
        h(
          'div',
          { className: 'dshxi-filters' },
          h('input', {
            className: 'dshxi-input',
            type: 'search',
            value: typeof active.q === 'string' ? active.q : '',
            placeholder: HISTORY_TEXT.search,
            'aria-label': HISTORY_TEXT.search,
            onChange: (event) => onFilter({ ...active, q: event.target.value })
          }),
          h(
            'select',
            {
              className: 'dshxi-select',
              value: typeof active.decision === 'string' ? active.decision : '',
              'aria-label': '按决策筛选',
              onChange: (event) => onFilter({ ...active, decision: event.target.value })
            },
            h('option', { value: '' }, HISTORY_TEXT.allDecisions),
            h('option', { value: 'allowed-once' }, '允许一次'),
            h('option', { value: 'rejected' }, '已拒绝'),
            h('option', { value: 'cancelled' }, '已取消'),
            h('option', { value: 'pending' }, '待定')
          ),
          h(
            'select',
            {
              className: 'dshxi-select',
              value: typeof active.risk === 'string' ? active.risk : '',
              'aria-label': '按风险筛选',
              onChange: (event) => onFilter({ ...active, risk: event.target.value })
            },
            h('option', { value: '' }, HISTORY_TEXT.allRisks),
            h('option', { value: 'low' }, '低风险'),
            h('option', { value: 'medium' }, '中风险'),
            h('option', { value: 'high' }, '高风险')
          )
        ),
        h('div', { className: 'dshxi-body', 'data-approval-history': 'body' }, ...body),
        h(
          'div',
          { className: 'dshxi-foot' },
          h('span', { className: 'dshxi-footNote' }, '最多显示 ' + HISTORY_MAX_ROWS + ' 条 · ' + HISTORY_TEXT.footer),
          h('span', { className: 'dshxd-flex' }),
          h('button', { type: 'button', className: 'dshxi-action', onClick: () => openInBrowser(HISTORY_ROUTE, 'history'), title: '在默认浏览器打开完整历史' }, HISTORY_TEXT.fullPage)
        )
      )
    }

    /**
     * 历史图标：内联 SVG。
     *
     * 不引入图标包 —— 本插件 bundle 只允许 require('react')（启动图约定），
     * 内联一份 14×14、1.4px 描边、currentColor 的时钟最省事，也和原生图标同色。
     *
     * @returns 时钟图标元素。
     */
    function historyIcon() {
      return h(
        'svg',
        {
          className: 'dshxh-icon',
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false'
        },
        h('circle', { cx: 8, cy: 8, r: 5.4, key: 'dial' }),
        h('path', { d: 'M8 4.9v3.4l2.2 1.35', key: 'hands' })
      )
    }

    /**
     * 会话头部动作行里的「审批历史」按钮 + 浮层面板。
     *
     * 座位是 session 作用域，标准 props 会带 sessionId 等；本组件不需要会话数据，
     * 面板自己 fetch、完整页面跳默认浏览器，所以不需要 inject。
     *
     * @returns 原生风格按钮；面板展开时是按钮 + 浮层。
     */
    function HistoryHeaderAction() {
      const [open, setOpen] = react.useState(false)
      const [report, setReport] = react.useState({ status: 'idle' })
      const [filters, setFilters] = react.useState({ q: '', decision: '', risk: '' })
      const [anchor, setAnchor] = react.useState(null)
      const rootRef = react.useRef(null)
      const requestRef = react.useRef(0)
      const liveRef = react.useRef(true)

      react.useEffect(() => {
        liveRef.current = true
        return () => {
          liveRef.current = false
        }
      }, [])

      const load = react.useCallback((quiet) => {
        const ticket = requestRef.current + 1
        requestRef.current = ticket
        if (quiet !== true) {
          setReport((current) => (current.status === 'ready' ? { ...current, busy: true } : { status: 'loading' }))
        }
        readHistoryReport().then(
          (data) => {
            if (!liveRef.current || requestRef.current !== ticket) return
            setReport({ status: 'ready', data, busy: false })
          },
          (error) => {
            if (!liveRef.current || requestRef.current !== ticket) return
            const message = String((error && error.message) || error)
            setReport((current) =>
              current.status === 'ready' ? { ...current, busy: false, staleError: message } : { status: 'error', message }
            )
          }
        )
      }, [])

      react.useEffect(() => {
        if (!open) return undefined
        load(false)
        return undefined
      }, [open, load])

      // 面板挂在按钮下方：宽度自适应视口，右边界对齐按钮右缘
      react.useLayoutEffect(() => {
        if (!open) return undefined
        const place = () => {
          const node = rootRef.current
          if (node === null) return
          const rect = node.getBoundingClientRect()
          if (rect.width === 0 && rect.height === 0) return
          const width = Math.max(360, Math.min(680, window.innerWidth - 24))
          const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
          setAnchor({ left, top: Math.max(8, rect.bottom + 8), width })
        }
        place()
        window.addEventListener('resize', place)
        return () => window.removeEventListener('resize', place)
      }, [open])

      react.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onPointer = (event) => {
          const node = rootRef.current
          if (node === null || node.contains(event.target)) return
          setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('pointerdown', onPointer, true)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('pointerdown', onPointer, true)
        }
      }, [open])

      const style =
        anchor === null || anchor === undefined
          ? { right: '12px', top: '56px', width: '560px' }
          : { left: anchor.left + 'px', top: anchor.top + 'px', width: anchor.width + 'px' }

      const panel = open
        ? h(
            'div',
            { className: 'dshxi-wrap', style, key: 'panel' },
            h(HistoryPanel, {
              report,
              filters,
              onFilter: setFilters,
              onRefresh: () => load(false),
              onClose: () => setOpen(false)
            })
          )
        : null

      return h(
        'div',
        { className: 'dshxh-root', ref: rootRef, 'data-approval-history': 'entry' },
        h(
          'button',
          {
            type: 'button',
            className: 'dshxh-trigger',
            title: HISTORY_TEXT.open,
            'aria-label': HISTORY_TEXT.open,
            'aria-expanded': open ? 'true' : 'false',
            'aria-haspopup': 'dialog',
            'data-open': open ? 'true' : 'false',
            onClick: () => setOpen((value) => !value)
          },
          historyIcon(),
          h('span', { className: 'dshxh-label' }, HISTORY_TEXT.label)
        ),
        panel
      )
    }

    /**
     * 把历史入口装到会话头部动作行。
     *
     * 与另两个座位同一条纪律：**绝不许抛**。装不上最多"少一个按钮"，
     * 绝不能让 web boot 失败（那会连累别人、还会触发崩溃自愈）。
     */
    function installHistoryEntry(ctx) {
      try {
        const slots = ctx === undefined || ctx === null ? undefined : ctx.slots
        if (slots === undefined || slots === null || typeof slots.inject !== 'function') {
          console.warn(`${LOG_PREFIX} conversation.session.header.actions 不可用，跳过历史入口`)
          return undefined
        }
        return slots.inject('conversation.session.header.actions', () => {
          try {
            if (typeof slots.register !== 'function') {
              console.warn(`${LOG_PREFIX} ctx.slots.register 不可用，跳过历史入口`)
              return undefined
            }
            // order 30：排在原生条目（job-list 用 20）之后，不抢首位。
            // 面板数据走 fetch、「完整页面」跳默认浏览器，都不需要 ctx —— 不传 inject。
            return slots.register(
              { name: 'conversation.session.header.actions', id: 'approval-history', order: 30 },
              HistoryHeaderAction
            )
          } catch (error) {
            console.error(`${LOG_PREFIX} 注册历史入口失败:`, error)
            return undefined
          }
        })
      } catch (error) {
        console.error(`${LOG_PREFIX} 注入历史入口插槽失败:`, error)
        return undefined
      }
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
        // 体检入口单独装、单独兜底：它装不上不影响审批注释。
        ctx.effect(() => installDiagEntry(ctx), 'approval-explainer: diag entry')
        // 历史入口同理：三个座位各自独立兜底，任何一个失败都不牵连其它两个。
        ctx.effect(() => installHistoryEntry(ctx), 'approval-explainer: history entry')
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
      clipCode,
      /** 体检面板里的纯函数：不碰 DOM / 网络，方便在浏览器之外断言。 */
      diag: {
        worstState: diagWorstState,
        verdict: diagVerdict,
        formatDuration: diagFormatDuration,
        formatClock: diagFormatClock,
        stateOf: diagStateOf
      },
      /**
       * 体检面板组件本身。
       *
       * 导出不是为了线上用，而是为了能在浏览器之外**真的渲染一遍**：
       * 「面板能画出来」这件事只有真渲染才能证明（语法检查查不出未定义变量、
       * 漏传 props 这类错）。线上路径只经 slots.register 使用它们。
       */
      diagComponents: {
        DiagPanel,
        DiagFooterAction,
        diagRouteLinks
      },
      /** 历史入口：按钮 + 浮层面板 + 纯函数，同样只供离线验证。 */
      historyEntry: {
        component: HistoryHeaderAction,
        panel: HistoryPanel,
        row: historyRow,
        route: HISTORY_ROUTE,
        jsonRoute: HISTORY_JSON_ROUTE,
        text: HISTORY_TEXT,
        hostOrigin,
        absoluteUrl,
        openInAppPage,
        openInBrowser,
        matches: historyMatches,
        outcomeLabel: historyOutcomeLabel,
        outcomeTone: historyOutcomeTone,
        riskLabel: historyRiskLabel,
        riskTone: historyRiskTone,
        shortId
      }
    }
    return module.exports
  }
})
