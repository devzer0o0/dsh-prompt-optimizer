/**
 * dsh-prompt-optimizer — host half.
 *
 * One job: right before a turn's user message would be logged and sent, run a
 * cheap side call on the session's own route that rewrites the typed line into
 * a well-formed prompt, then hand the rewritten message to the loop. The loop
 * logs exactly what the model receives, so the chat bubble and the model agree
 * on the text — nothing is hidden.
 *
 * Why `agent/pre-step` and not a request-side hook: `agent/request` cannot
 * change messages (the loop refuses), and a listener on the assembled request
 * would rewrite a message that is already in the durable log, so the transcript
 * would keep saying something the model never saw. `agent/pre-step` is the one
 * waterfall that decides which messages enter the step at all.
 *
 * Failure is always "send what the user typed": a timeout, a provider error, or
 * an empty rewrite returns the untouched decision.
 *
 * @module dsh-prompt-optimizer
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

/** Cordis entry id and package name; both must stay identical to the patch row. */
export const name = 'dsh-prompt-optimizer'

/** The side call goes through the mounted LLM service. */
export const inject = ['llm']

/** Where the toggle and the last-rewrite record live. */
const HOME_DIR = path.join(os.homedir(), '.dsh', 'prompt-optimizer')
const STATE_FILE = path.join(HOME_DIR, 'state.json')

/** HTTP surface consumed by the client half. */
const STATE_PATH = '/prompt-optimizer/state'

/** Defaults; the state file may override each one. */
const DEFAULTS = {
  enabled: false,
  provider: '',
  model: '',
  minChars: 8,
  maxInputChars: 6000,
  maxOutputTokens: 1200,
  timeoutMs: 12000,
  /** How many rewrites to keep for the chip's "last one" readout. */
  history: 20,
}

/** Instruction for the rewriting call. The output language follows the input. */
const SYSTEM_PROMPT = [
  'You rewrite a developer\'s rough message into a precise prompt for an AI coding agent.',
  '',
  'Rules:',
  '1. Keep the original intent, language, and every concrete detail (paths, names, numbers, error text). Never invent facts, files, or requirements.',
  '2. Make it unambiguous: state the goal first, then the constraints and any acceptance criteria that are already implied by the input. Drop chit-chat and filler.',
  '3. Keep it compact. Do not pad, do not add sections the input does not need, and do not explain what you did.',
  '4. If the input is already a clear prompt, return it unchanged.',
  '5. Output the rewritten prompt only — no preamble, no quotes, no Markdown code fence around the whole thing, no suffix.',
].join('\n')

/** Read the state document, tolerating absence and corruption. */
function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULTS }
    return { ...DEFAULTS, ...parsed }
  } catch {
    return { ...DEFAULTS }
  }
}

/** Write the state document atomically so a crash cannot leave half a file. */
function writeState(state) {
  fs.mkdirSync(HOME_DIR, { recursive: true })
  const tmp = `${STATE_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, STATE_FILE)
}

/** One-file mtime cache: the file is re-read only when something touched it. */
function createStateBox() {
  let cached = readState()
  let stamp = mtimeOf()
  function mtimeOf() {
    try {
      return fs.statSync(STATE_FILE).mtimeMs
    } catch {
      return 0
    }
  }
  return {
    get() {
      const current = mtimeOf()
      if (current !== stamp) {
        cached = readState()
        stamp = current
      }
      return cached
    },
    set(patch) {
      const next = { ...this.get(), ...patch }
      writeState(next)
      cached = next
      stamp = mtimeOf()
      return next
    },
  }
}

/** Strip the wrappers a model likes to add even when told not to. */
function unwrapRewrite(text) {
  let out = String(text).trim()
  const fence = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/u.exec(out)
  if (fence !== null) out = fence[1].trim()
  for (let round = 0; round < 2; round += 1) {
    const pair = /^(["'“”『「])([\s\S]*)(["'“”』」])$/u.exec(out)
    if (pair === null) break
    out = pair[2].trim()
  }
  // A model that ignores "no preamble" usually opens with one of these labels,
  // sometimes bolded and sometimes on its own line.
  const label = /^(?:\*\*|__)?\s*(?:优化后(?:的)?(?:提示词|prompt)|改写后(?:的)?(?:提示词|prompt)|optimized prompt|rewritten prompt|improved prompt)\s*(?:\*\*|__)?\s*[:：]?\s*/iu
  out = out.replace(label, '')
  return out.trim()
}

/** Text blocks of one message, joined the way the log renders them. */
function textOf(message) {
  return message.content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/** Whether this message is a human prompt the optimizer may touch. */
function isEligible(message, state) {
  if (message === null || typeof message !== 'object') return false
  const source = message.source
  if (source === null || typeof source !== 'object' || source.kind !== 'user') return false
  const text = textOf(message)
  const trimmed = text.trim()
  if (trimmed.length < state.minChars) return false
  if (text.length > state.maxInputChars) return false
  // Slash commands are executed by the harness, not sent as prose.
  if (trimmed.startsWith('/')) return false
  // Attachments-only messages carry no text worth rewriting.
  if (!message.content.some((block) => block?.type === 'text' && block.text.trim() !== '')) return false
  return true
}

/** Resolve the route for the side call without depending on a logged header. */
function resolveRoute(ctx, state, agent) {
  if (typeof state.provider === 'string' && state.provider !== ''
    && typeof state.model === 'string' && state.model !== '') {
    return { provider: state.provider, model: state.model }
  }
  const header = agent?.session?.requestHeader?.()
  const config = header?.config
  if (config !== undefined && typeof config.provider === 'string' && typeof config.model === 'string') {
    return { provider: config.provider, model: config.model }
  }
  const options = agent?.options
  if (typeof options?.provider === 'string' && typeof options?.model === 'string') {
    return { provider: options.provider, model: options.model }
  }
  try {
    const fallback = ctx.get('agentDefaultModel')?.currentSelection()
    if (fallback !== undefined && fallback !== null) {
      return { provider: fallback.provider, model: fallback.model }
    }
  } catch {
    // A profile without a default-model owner simply has no fallback route.
  }
  return undefined
}

/** Run one non-streaming rewrite call through the mounted LLM service. */
async function requestRewrite(ctx, state, route, text, signal) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(state.timeoutMs)])
  const stream = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    maxTokens: state.maxOutputTokens,
    system: SYSTEM_PROMPT,
    messages: [{
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }],
    signal: deadline,
  })
  let out = ''
  let failure
  for await (const chunk of stream) {
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
    if (chunk.type === 'finish') {
      const kind = chunk.reason?.kind
      if (kind === 'error' || kind === 'aborted') {
        failure = chunk.reason.failure?.message ?? kind
      }
    }
  }
  if (failure !== undefined) throw new Error(String(failure))
  return unwrapRewrite(out)
}

/**
 * Mount the optimizer.
 * @param ctx - Host Cordis context exposing the LLM service.
 */
export function apply(ctx) {
  const state = createStateBox()
  /**
   * Message ids already rewritten (or attempted while the switch was on), so a
   * re-claim inside one turn does not pay for a second call. `agent/inbox/
   * discarded` drops an id again: a discarded message that is resubmitted is a
   * fresh claim and deserves a fresh rewrite.
   */
  const handled = new Set()
  /** Newest-first ring of rewrites for the chip's readout. */
  const recent = []

  const warn = (what, error) => {
    try {
      const message = error !== undefined && error !== null && error.message !== undefined ? error.message : error
      ctx.logger?.warn?.(`${name}: ${what}: ${String(message)}`)
    } catch {
      // Logging must never affect the turn.
    }
  }

  const remember = (entry) => {
    recent.unshift(entry)
    const cap = Math.max(1, Number(state.get().history) || 20)
    if (recent.length > cap) recent.length = cap
  }

  ctx.effect(() => {
    const handler = async ({ agent, messages, signal }, next) => {
      const decision = await next()
      const current = state.get()
      if (current.enabled !== true) return decision
      if (decision.kind === 'reject' || signal.aborted) return decision

      const candidates = decision.messages.filter(
        (message) => isEligible(message, current) && !handled.has(message.id),
      )
      if (candidates.length === 0) return decision

      const route = resolveRoute(ctx, current, agent)
      if (route === undefined) {
        warn('no route available for the rewrite call; sending the text as typed')
        return decision
      }

      const replacements = new Map()
      for (const message of candidates) {
        handled.add(message.id)
        const original = textOf(message)
        try {
          const rewritten = await requestRewrite(ctx, current, route, original, signal)
          signal.throwIfAborted()
          if (rewritten === '' || rewritten === original.trim()) continue
          const textBlock = message.content.findIndex((block) => block?.type === 'text')
          const content = message.content.map((block, index) => (
            index === textBlock ? { ...block, text: rewritten } : block
          ))
          replacements.set(message.id, { ...message, content })
          remember({
            at: Date.now(),
            sessionId: agent?.session?.id ?? '',
            original,
            rewritten,
            provider: route.provider,
            model: route.model,
          })
        } catch (error) {
          if (signal.aborted) return decision
          warn('rewrite failed; sending the text as typed', error)
        }
      }

      if (replacements.size === 0) return decision
      // Spread first: fields such as `startsRequestSeries` belong to the loop,
      // and a later listener's appended notices must keep their place.
      return {
        ...decision,
        messages: decision.messages.map((message) => replacements.get(message.id) ?? message),
      }
    }
    // `global` makes the listener independent of the agent scope filter; the
    // handler itself decides per message whether the optimizer applies.
    return ctx.on('agent/pre-step', handler, { global: true, prepend: true })
  }, `${name}: pre-step rewrite`)

  ctx.effect(() => ctx.on('agent/inbox/discarded', ({ message }) => {
    // A discarded message that is submitted again is a new claim, so it must not
    // be skipped just because its id was seen once.
    if (message !== undefined && message !== null) handled.delete(message.id)
  }), `${name}: discard bookkeeping`)

  ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => {
    // Handled ids outlive their session only as dead weight; drop the session's
    // rewrites so a long-lived host does not accumulate them.
    for (let index = recent.length - 1; index >= 0; index -= 1) {
      if (recent[index].sessionId === agent?.id) recent.splice(index, 1)
    }
  }), `${name}: dispose bookkeeping`)

  // The HTTP surface is optional: a headless composition has no webServer, and
  // the plugin must stay active (the rewrite itself needs no route).
  ctx.inject(['webServer'], (child) => {
    const json = (res, status, body) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(JSON.stringify(body))
    }
    return child.webServer.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: (req, res) => {
        const current = state.get()
        if (req.method === 'POST' || req.method === 'PUT') {
          let raw = ''
          let tooBig = false
          req.on('data', (chunk) => {
            raw += chunk
            if (raw.length > 4096) {
              tooBig = true
              req.destroy()
            }
          })
          req.on('end', () => {
            if (tooBig) return json(res, 413, { ok: false, error: 'request body too large' })
            let payload
            try {
              payload = JSON.parse(raw === '' ? '{}' : raw)
            } catch {
              return json(res, 400, { ok: false, error: 'body must be JSON' })
            }
            if (payload === null || typeof payload !== 'object' || typeof payload.enabled !== 'boolean') {
              return json(res, 400, { ok: false, error: 'enabled must be a boolean' })
            }
            try {
              const next = state.set({ enabled: payload.enabled })
              return json(res, 200, { ok: true, enabled: next.enabled })
            } catch (error) {
              return json(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          })
          req.on('error', () => {})
          return
        }
        const sessionId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('sessionId') ?? ''
        const last = sessionId === ''
          ? recent[0] ?? null
          : recent.find((entry) => entry.sessionId === sessionId) ?? null
        return json(res, 200, {
          ok: true,
          enabled: current.enabled === true,
          minChars: current.minChars,
          route: current.provider !== '' && current.model !== '' ? { provider: current.provider, model: current.model } : null,
          last,
        })
      },
    })
  })
}
