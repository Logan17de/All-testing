import path from 'node:path'

export const PROTOCOL = 'copycat-harness/1'

const WRAPPERS = [
  ['HARNESS_JOB', 'job'],
  ['HARNESS_CONTROL', 'control'],
  ['HARNESS_RESULT', 'result'],
]

export function taggedJson(tag, payload) {
  return `[[${tag}]]\n${JSON.stringify(payload, null, 2)}\n[[/${tag}]]`
}

export function parseTaggedJson(text) {
  const source = String(text ?? '')
  for (const [tag, kind] of WRAPPERS) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = new RegExp(`\\[\\[${escaped}\\]\\]\\s*([\\s\\S]*?)\\s*\\[\\[\\/${escaped}\\]\\]`, 'i').exec(source)
    if (!match) continue
    try {
      return { kind, tag, payload: JSON.parse(match[1]), raw: source }
    } catch (error) {
      return { kind: 'invalid', tag, error: `Invalid ${tag} JSON: ${error.message}`, raw: source }
    }
  }
  return { kind: 'text', text: source, raw: source }
}

function textFrom(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  for (const key of ['text', 'content', 'fullText', 'snapshot', 'response', 'message']) {
    const candidate = value[key]
    if (typeof candidate === 'string') return candidate
    if (candidate && typeof candidate === 'object') {
      const nested = textFrom(candidate)
      if (nested) return nested
    }
  }
  return ''
}

function completeFrom(value) {
  if (!value || typeof value !== 'object') return true
  if (typeof value.complete === 'boolean') return value.complete
  if (typeof value.done === 'boolean') return value.done
  if (typeof value.final === 'boolean') return value.final
  const phase = String(value.phase || value.state || value.mode || value.event || value.type || '').toLowerCase()
  if (/live|stream|partial|delta|typing/.test(phase)) return false
  if (/complete|completed|final|done|settled/.test(phase)) return true
  return true
}

function attachmentFrom(item) {
  if (typeof item === 'string') return { path: item }
  if (!item || typeof item !== 'object') return null
  const target = item.path || item.file || item.filePath
  if (!target) return null
  return {
    path: String(target),
    ...(item.mime ? { mime: String(item.mime) } : {}),
    ...(item.name ? { name: String(item.name) } : {}),
  }
}

export function normalizeInbound(raw) {
  let parsed = raw
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw) } catch { parsed = raw }
  }

  if (typeof parsed === 'string') {
    const text = parsed.trim()
    return text ? { type: 'chatgpt.message', text, complete: true, id: null, attachments: [] } : null
  }
  if (!parsed || typeof parsed !== 'object') return null

  if (parsed.protocol === PROTOCOL && parsed.source === 'harness') return null
  if (parsed.source === 'harness' || parsed.from === 'harness') return null

  const type = String(parsed.type || parsed.event || parsed.kind || '').toLowerCase()
  const looksChatGpt = !type
    || type.includes('chatgpt')
    || type.includes('assistant')
    || type.includes('response')
    || type.includes('snapshot')
    || type.includes('message')
  if (!looksChatGpt) return { type: 'control', payload: parsed }

  const text = textFrom(parsed).trim()
  if (!text) return null
  const attachments = (Array.isArray(parsed.attachments) ? parsed.attachments : [])
    .map(attachmentFrom)
    .filter(Boolean)
  return {
    type: 'chatgpt.message',
    text,
    complete: completeFrom(parsed),
    id: parsed.id || parsed.messageId || parsed.responseId || null,
    conversationId: parsed.conversationId || parsed.conversation_id || null,
    tabId: parsed.tabId || parsed.tab_id || null,
    attachments,
    raw: parsed,
  }
}

export function frame(type, payload = {}) {
  return {
    protocol: PROTOCOL,
    source: 'harness',
    type,
    at: new Date().toISOString(),
    ...payload,
  }
}

export function attachmentDescriptor(filePath, mime = '') {
  const target = path.resolve(String(filePath))
  return {
    type: 'attachment',
    path: target,
    name: path.basename(target),
    ...(mime ? { mime } : {}),
  }
}

export function stateSummaryText(summary) {
  const lines = []
  if (summary.goal) {
    lines.push(`Goal: ${summary.goal.title}`)
    lines.push(`Status: ${summary.goal.status}`)
  } else {
    lines.push('Goal: none')
  }
  lines.push('')
  lines.push('Todos:')
  lines.push(`${summary.todos.completed} completed`)
  lines.push(`${summary.todos.in_progress} in progress`)
  lines.push(`${summary.todos.pending} pending`)
  if (summary.todos.blocked) lines.push(`${summary.todos.blocked} blocked`)
  if (summary.todos.failed) lines.push(`${summary.todos.failed} failed`)
  if (summary.current) lines.push(`Current: ${summary.current.title}`)
  if (summary.next) lines.push(`Next: ${summary.next.title}`)
  return lines.join('\n')
}
