/**
 * dsh-prompt-optimizer — client half.
 *
 * One star in the composer's tool row: click toggles the rewrite on or off,
 * hover shows what the last rewrite actually did. Every bit of state comes from
 * the host route, so the two halves cannot disagree and a restart remembers the
 * switch.
 *
 * It lives in `conversation.input.right` because that slot is a list: every
 * entry renders beside the others, so the star cannot shadow the shipped model
 * selector or the mic. Nothing is drawn outside the component.
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt-optimizer',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'prompt-optimizer'
    const STATE_URL = '/prompt-optimizer/state'

    const zh = {
      'chip.on': '提示词优化：开 · 发送前会把你的话改写成结构化提示词，点击关闭',
      'chip.off': '提示词优化：关 · 点击开启，发送前自动改写成结构化提示词',
      'chip.busy': '提示词优化：正在改写…',
      'chip.error': '提示词优化：状态读取失败（点击重试）',
      'panel.title': '上一次改写',
      'panel.before': '你输入的',
      'panel.after': '模型收到的',
      'panel.empty': '还没有改写记录。开启后发出的下一条消息会出现在这里。',
      'label.on': '提示词优化已开启',
      'label.off': '提示词优化已关闭',
    }
    const en = {
      'chip.on': 'Prompt optimizer: on · your message is rewritten before it is sent; click to turn off',
      'chip.off': 'Prompt optimizer: off · click to rewrite your message before sending',
      'chip.busy': 'Prompt optimizer: rewriting…',
      'chip.error': 'Prompt optimizer: could not read the switch (click to retry)',
      'panel.title': 'Last rewrite',
      'panel.before': 'You typed',
      'panel.after': 'The model got',
      'panel.empty': 'No rewrite yet. Once this is on, the next message you send shows up here.',
      'label.on': 'Prompt optimizer is on',
      'label.off': 'Prompt optimizer is off',
    }

    const CSS = `
.po-root { position: relative; display: inline-flex; }
.po-chip {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0;
  border: none; border-radius: var(--dsw-radius-md, 8px);
  background: transparent; color: var(--dsw-alias-label-secondary);
  cursor: pointer; line-height: 0;
}
.po-chip:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.14)); color: var(--dsw-alias-label-primary); }
.po-chip[data-on="true"] { color: var(--dsw-alias-brand-primary); }
.po-chip[data-busy="true"] { opacity: 0.6; cursor: progress; }
.po-panel {
  position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 40;
  width: 460px; max-height: 60vh; overflow: auto;
  padding: 12px; display: flex; flex-direction: column; gap: 10px;
  border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg, 12px);
  background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
  font-size: 12px; line-height: 18px;
}
.po-row { display: flex; flex-direction: column; gap: 4px; }
.po-cap { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.po-text {
  margin: 0; padding: 8px; border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-2); white-space: pre-wrap; word-break: break-word;
  font-family: inherit; font-size: 12px; line-height: 18px;
}
.po-title { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
`

    /** Install the stylesheet once per page; removing it on unload keeps HMR clean. */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.querySelector('style[data-plugin="dsh-prompt-optimizer"]')
      if (existing !== null) {
        existing.textContent = CSS
        return () => {}
      }
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-prompt-optimizer'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    /*
     * The whale that is both the composer chip and the package icon.
     *
     * Two states, one silhouette: off is the bare outline with no fill at all,
     * on paints the same body and punches the eye out with
     * `fill-rule="evenodd"` rather than drawing a second circle. Keeping the
     * state in the artwork instead of in a color choice means it reads the same
     * on a light or dark host, and at 16px.
     *
     * No `color` is set here: the chip inherits `currentColor` from its button,
     * so the on state picks up the host brand token for free.
     */
    const WHALE_BODY = 'M2.9 13.3C2.9 10.2 5.8 8.4 9.1 8.4C11.5 8.4 13.5 9.4 14.8 11.0'
      + 'C16.1 9.4 17.9 8.2 20.1 8.0C21.2 7.9 21.7 8.4 21.4 9.4'
      + 'C21.0 10.8 19.8 11.9 18.4 12.6C20.1 12.9 21.4 13.7 21.8 14.9'
      + 'C22.1 15.9 21.5 16.5 20.4 16.3C18.2 16.0 16.4 14.9 15.0 13.2'
      + 'C13.6 15.7 11.4 17.6 8.6 17.6C5.6 17.6 2.9 16.4 2.9 13.3Z'
    /** Closed sub-path for the eye, so the filled state can subtract it. */
    const WHALE_EYE = 'M5.35 12.3a1.15 1.15 0 1 0 2.3 0a1.15 1.15 0 1 0 -2.3 0Z'
    const WHALE_SPOUT = 'M7.9 8.3C7.6 6.8 7.0 5.8 6.1 5.0M7.9 8.3C8.1 6.6 8.8 5.4 9.8 4.6'
    /** Tight viewBox around the drawn geometry, so the glyph fills its box. */
    const WHALE_VIEWBOX = '2.1 3.7 20.8 15.0'

    /** The whale chip: outlined and unfilled when off, filled when on. */
    function WhaleIcon({ filled }) {
      return h('svg', {
        viewBox: WHALE_VIEWBOX, width: 16, height: 16, 'aria-hidden': true, focusable: 'false',
        fill: 'none',
      },
      h('path', filled
        ? {
          d: `${WHALE_BODY}${WHALE_EYE}`,
          fill: 'currentColor',
          fillRule: 'evenodd',
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
        }
        : {
          d: WHALE_BODY,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
        }),
      filled ? null : h('circle', { cx: 6.5, cy: 12.3, r: 0.95, fill: 'currentColor' }),
      h('path', {
        d: WHALE_SPOUT,
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
      }))
    }

    /** The chip plus its hover panel. */
    function OptimizerChip({ chatId, t }) {
      const [phase, setPhase] = React.useState('loading')
      const [enabled, setEnabled] = React.useState(false)
      const [last, setLast] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const rootRef = React.useRef(null)

      const url = React.useMemo(() => {
        return typeof chatId === 'string' && chatId !== ''
          ? `${STATE_URL}?sessionId=${encodeURIComponent(chatId)}`
          : STATE_URL
      }, [chatId])

      const read = React.useCallback(async () => {
        try {
          const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const body = await response.json()
          setEnabled(body.enabled === true)
          setLast(body.last ?? null)
          setPhase('ready')
        } catch {
          setPhase('error')
        }
      }, [url])

      React.useEffect(() => {
        let live = true
        void (async () => {
          try {
            const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const body = await response.json()
            if (!live) return
            setEnabled(body.enabled === true)
            setLast(body.last ?? null)
            setPhase('ready')
          } catch {
            if (live) setPhase('error')
          }
        })()
        return () => { live = false }
      }, [url])

      const toggle = React.useCallback(async () => {
        if (phase === 'busy') return
        const wanted = !enabled
        setPhase('busy')
        setEnabled(wanted)
        try {
          const response = await fetch(STATE_URL, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: wanted }),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const body = await response.json()
          setEnabled(body.enabled === true)
          setPhase('ready')
        } catch {
          setEnabled(!wanted)
          setPhase('error')
        }
      }, [enabled, phase])

      React.useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          const root = rootRef.current
          if (root !== null && event.target instanceof Node && root.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open])

      const title = phase === 'error'
        ? t('chip.error')
        : enabled ? t('chip.on') : t('chip.off')

      return h('div', { className: 'po-root', ref: rootRef },
        h('button', {
          type: 'button',
          className: 'po-chip',
          'data-on': enabled ? 'true' : 'false',
          'data-busy': phase === 'busy' ? 'true' : 'false',
          'aria-label': phase === 'error' ? t('chip.error') : enabled ? t('label.on') : t('label.off'),
          'aria-pressed': enabled,
          title,
          onClick: phase === 'error' ? () => { void read() } : () => { void toggle() },
          onMouseEnter: () => setOpen(true),
          onMouseLeave: () => setOpen(false),
          onFocus: () => setOpen(true),
          onBlur: () => setOpen(false),
        }, h(WhaleIcon, { filled: enabled })),
        open ? h('div', { className: 'po-panel', role: 'dialog', 'aria-label': t('panel.title') },
          h('div', { className: 'po-title' }, t('panel.title')),
          last === null
            ? h('div', { className: 'po-cap' }, t('panel.empty'))
            : [
              h('div', { className: 'po-row', key: 'before' },
                h('div', { className: 'po-cap' }, t('panel.before')),
                h('pre', { className: 'po-text' }, last.original)),
              h('div', { className: 'po-row', key: 'after' },
                h('div', { className: 'po-cap' }, t('panel.after')),
                h('pre', { className: 'po-text' }, last.rewritten)),
            ],
        ) : null,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, 'zh-CN': zh, en }), 'prompt-optimizer: dictionaries')
        ctx.effect(installStyles, 'prompt-optimizer: stylesheet')
        const t = ctx.locale.bind(NS)
        const slot = 'conversation.input.right'
        ctx.slots.inject(slot, () => ctx.slots.register({
          name: slot,
          id: 'prompt-optimizer',
          order: 60,
          // Without this the framework injects no `t`, and the component would
          // throw on its first render ("slot entry crashed").
          locale: NS,
          // The scope kit calls this factory with the conversation id; the field
          // is named `chatId` so it cannot collide with a standard session prop.
          inject: (sessionId) => ({ chatId: typeof sessionId === 'string' ? sessionId : undefined }),
        }, OptimizerChip))
      },
    }
  },
})
