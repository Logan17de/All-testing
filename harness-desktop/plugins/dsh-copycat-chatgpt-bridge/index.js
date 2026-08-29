import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

export const name = 'dsh-copycat-chatgpt-bridge'
export const inject = ['apiProxy']

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 43119
const MAX_BODY_BYTES = 2 * 1024 * 1024
const KEEPALIVE_MS = 20_000
const API_PREFIX = '/api/bridge'

function positivePort(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : fallback
}

function bridgeHome() {
  const dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'copycat-bridge')
}

function readOrCreateToken(root) {
  const fromEnv = process.env.COPYCAT_BRIDGE_TOKEN?.trim()
  if (fromEnv) return fromEnv

  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const tokenPath = path.join(root, 'token')
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim()
    if (existing) return existing
  } catch {}

  const token = randomBytes(32).toString('base64url')
  fs.writeFileSync(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  return token
}

function writeDiscovery(root, value) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const target = path.join(root, 'bridge.json')
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, target)
  return target
}

function sameSecret(expected, supplied) {
  const a = Buffer.from(String(expected || ''))
  const b = Buffer.from(String(supplied || ''))
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

function bearerToken(req) {
  const auth = String(req.headers.authorization || '')
  const match = /^Bearer\s+(.+)$/i.exec(auth)
  if (match) return match[1].trim()
  return String(req.headers['x-copycat-token'] || '').trim()
}

function safeOrigin(origin) {
  if (!origin) return null
  const value = String(origin)
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(value)) return value
  if (/^(chrome|moz)-extension:\/\//i.test(value)) return value
  return false
}

function setCors(req, res) {
  const origin = safeOrigin(req.headers.origin)
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Copycat-Token')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
}

function sendJson(res, statusCode, body) {
  const encoded = Buffer.from(JSON.stringify(body))
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(encoded.length),
    'Cache-Control': 'no-store',
  })
  res.end(encoded)
}

function apiError(res, statusCode, code, message, details = {}) {
  sendJson(res, statusCode, {
    ok: false,
    error: { code, message, details },
  })
}

async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 })
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 })
  }
}

function pathSegments(url) {
  return new URL(url, 'http://127.0.0.1').pathname.split('/').filter(Boolean)
}

function extractSessionId(value) {
  if (!value || typeof value !== 'object') return null
  const candidate = value.sessionId || value.id || value.session?.sessionId || value.session?.id
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null
}

function attachmentLines(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return ''
  const lines = []
  for (const item of attachments) {
    const rawPath = typeof item === 'string' ? item : item?.path
    if (typeof rawPath !== 'string' || !rawPath.trim()) continue
    const resolved = path.resolve(rawPath)
    let status = 'available'
    try {
      if (!fs.statSync(resolved).isFile()) status = 'not-a-file'
    } catch {
      status = 'missing'
    }
    lines.push(`- ${resolved} (${status})`)
  }
  if (!lines.length) return ''
  return `\n\n[Copycat local attachments]\n${lines.join('\n')}\nUse Harness file/image tools to inspect these paths when needed.`
}

function eventEnvelope(stream, frame) {
  return {
    type: 'harness.event',
    stream,
    at: new Date().toISOString(),
    rpcId: frame?.rpcId ?? null,
    payload: frame?.payload ?? frame ?? null,
  }
}

async function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve(server.address())
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

export async function apply(ctx) {
  const root = bridgeHome()
  const token = readOrCreateToken(root)
  const requestedHost = process.env.COPYCAT_BRIDGE_HOST?.trim() || DEFAULT_HOST
  const host = requestedHost === 'localhost' ? DEFAULT_HOST : requestedHost
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('COPYCAT_BRIDGE_HOST must be a loopback address (127.0.0.1 or ::1).')
  }
  const configuredPort = positivePort(process.env.COPYCAT_BRIDGE_PORT, DEFAULT_PORT)
  const abort = new AbortController()
  const clients = new Set()
  const startedAt = new Date().toISOString()
  let discoveryPath = null
  let address = null

  const rpc = async (domain, method, payload = {}) => {
    const target = ctx.apiProxy?.[domain]?.[method]
    if (typeof target !== 'function') throw new Error(`Harness API ${domain}.${method} is unavailable.`)
    const rpcId = `copycat-${randomUUID()}`
    const response = await target({ rpcId, payload }, abort.signal)
    if (!response?.result?.ok) {
      const error = new Error(response?.result?.error?.message || `Harness API ${domain}.${method} failed.`)
      error.code = response?.result?.error?.code || 'harness-error'
      error.details = response?.result?.error?.details || {}
      throw error
    }
    return response.result.value
  }

  const broadcast = data => {
    const text = `event: harness\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of [...clients]) {
      try { res.write(text) } catch { clients.delete(res) }
    }
  }

  const createSession = async body => {
    const payload = {}
    if (typeof body?.workspace_id === 'string' && body.workspace_id.trim()) payload.workspaceId = body.workspace_id.trim()
    else payload.cwd = typeof body?.cwd === 'string' && body.cwd.trim() ? path.resolve(body.cwd) : process.cwd()
    const created = await rpc('sessions', 'create', payload)
    const sessionId = extractSessionId(created)
    if (!sessionId) throw new Error('Harness created a session but did not return a session id.')
    return { sessionId, created }
  }

  const server = http.createServer(async (req, res) => {
    setCors(req, res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const origin = safeOrigin(req.headers.origin)
    if (origin === false) {
      apiError(res, 403, 'origin-denied', 'This bridge only accepts local or extension origins.')
      return
    }
    if (!sameSecret(token, bearerToken(req))) {
      apiError(res, 401, 'unauthorized', 'A valid Copycat bridge token is required.')
      return
    }

    const segments = pathSegments(req.url || '/')
    const relative = segments.slice(segments[0] === 'api' && segments[1] === 'bridge' ? 2 : 0)

    try {
      if (req.method === 'GET' && relative.length === 1 && relative[0] === 'status') {
        sendJson(res, 200, {
          ok: true,
          bridge: {
            name,
            version: 1,
            host,
            port: address?.port || null,
            startedAt,
            clients: clients.size,
            cwd: process.cwd(),
          },
          harness: { ready: true },
        })
        return
      }

      if (req.method === 'GET' && relative.length === 1 && relative[0] === 'events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        res.write(`event: bridge\ndata: ${JSON.stringify({ type: 'bridge.connected', at: new Date().toISOString() })}\n\n`)
        clients.add(res)
        const keepalive = setInterval(() => {
          try { res.write(`: keepalive ${Date.now()}\n\n`) } catch {}
        }, KEEPALIVE_MS)
        req.on('close', () => {
          clearInterval(keepalive)
          clients.delete(res)
        })
        return
      }

      if (req.method === 'GET' && relative.length === 1 && relative[0] === 'sessions') {
        const value = await rpc('sessions', 'list', {})
        sendJson(res, 200, { ok: true, value })
        return
      }

      if (req.method === 'POST' && relative.length === 1 && relative[0] === 'session') {
        const body = await readJson(req)
        const created = await createSession(body)
        broadcast({ type: 'bridge.session.created', at: new Date().toISOString(), sessionId: created.sessionId })
        sendJson(res, 201, { ok: true, session_id: created.sessionId, value: created.created })
        return
      }

      if (req.method === 'GET' && relative.length === 2 && relative[0] === 'session') {
        const sessionId = decodeURIComponent(relative[1])
        const value = await rpc('sessions', 'history', { sessionId, maxMessages: 100 })
        sendJson(res, 200, { ok: true, session_id: sessionId, value })
        return
      }

      if (req.method === 'POST' && relative.length === 1 && relative[0] === 'message') {
        const body = await readJson(req)
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (!text) {
          apiError(res, 400, 'invalid-message', 'text must be a non-empty string.')
          return
        }

        let sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : ''
        let created = null
        if (!sessionId) {
          created = await createSession(body)
          sessionId = created.sessionId
        }

        const content = `${text}${attachmentLines(body.attachments)}`
        const value = await rpc('sessions', 'prompt', {
          sessionId,
          mode: body.mode === 'replace' ? 'replace' : 'queue',
          content: [{ type: 'text', text: content }],
          clientTimeZone: typeof body.client_time_zone === 'string' && body.client_time_zone.trim()
            ? body.client_time_zone.trim()
            : Intl.DateTimeFormat().resolvedOptions().timeZone,
        })

        broadcast({
          type: 'bridge.message.accepted',
          at: new Date().toISOString(),
          sessionId,
          createdSession: Boolean(created),
        })
        sendJson(res, 202, {
          ok: true,
          accepted: true,
          session_id: sessionId,
          created_session: Boolean(created),
          value,
        })
        return
      }

      if (req.method === 'POST' && relative.length === 1 && relative[0] === 'cancel') {
        const body = await readJson(req)
        const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : ''
        if (!sessionId) {
          apiError(res, 400, 'invalid-session', 'session_id must be supplied.')
          return
        }
        const value = await rpc('sessions', 'cancel', { sessionId })
        sendJson(res, 200, { ok: true, session_id: sessionId, value })
        return
      }

      apiError(res, 404, 'not-found', `No Copycat bridge route matches ${req.method} ${req.url}.`)
    } catch (error) {
      ctx.logger?.warn?.(`copycat bridge request failed: ${error?.stack || error}`)
      apiError(
        res,
        Number(error?.statusCode) || 500,
        error?.code || 'bridge-error',
        error?.message || String(error),
        error?.details || {},
      )
    }
  })

  try {
    address = await listen(server, host, configuredPort)
  } catch (error) {
    if (error?.code !== 'EADDRINUSE' || process.env.COPYCAT_BRIDGE_PORT) throw error
    ctx.logger?.warn?.(`Copycat bridge port ${configuredPort} is busy; choosing a free loopback port.`)
    address = await listen(server, host, 0)
  }

  const actualPort = typeof address === 'object' && address ? address.port : configuredPort
  const baseUrl = `http://${host === '::1' ? '[::1]' : host}:${actualPort}${API_PREFIX}`
  discoveryPath = writeDiscovery(root, {
    version: 1,
    baseUrl,
    host,
    port: actualPort,
    token,
    pid: process.pid,
    startedAt,
  })

  ctx.logger?.info?.(`Copycat bridge listening on ${baseUrl}. Discovery: ${discoveryPath}`)

  const relay = async (streamName, opener) => {
    try {
      for await (const frame of opener()) broadcast(eventEnvelope(streamName, frame))
    } catch (error) {
      if (!abort.signal.aborted) {
        ctx.logger?.warn?.(`Copycat bridge ${streamName} stream stopped: ${error?.stack || error}`)
        broadcast({ type: 'bridge.stream.error', stream: streamName, message: error?.message || String(error) })
      }
    }
  }

  if (typeof ctx.apiProxy?.events?.mux === 'function') {
    void relay('mux', () => ctx.apiProxy.events.mux({ rpcId: 'copycat-mux', payload: {} }, abort.signal))
  }
  if (typeof ctx.apiProxy?.events?.host === 'function') {
    void relay('host', () => ctx.apiProxy.events.host({ rpcId: 'copycat-host', payload: {} }, abort.signal))
  }

  ctx.on('dispose', () => {
    abort.abort(new Error('Copycat bridge stopped.'))
    for (const client of clients) {
      try { client.end() } catch {}
    }
    clients.clear()
    try { server.close() } catch {}
    if (discoveryPath) {
      try {
        const current = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'))
        if (current?.pid === process.pid) fs.unlinkSync(discoveryPath)
      } catch {}
    }
  })
}

export default { name, inject, apply }
