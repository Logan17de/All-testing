import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'llm-harness-google-workspace'
export const inject = ['tools']

const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
let cached = null

async function accessToken() {
  if (process.env.GOOGLE_ACCESS_TOKEN) return process.env.GOOGLE_ACCESS_TOKEN
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token

  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Set GOOGLE_ACCESS_TOKEN or GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN')
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const data = await response.json()
  if (!response.ok) throw new Error(`Google OAuth ${response.status}: ${data.error_description || data.error}`)
  cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 }
  return cached.token
}

async function google(url) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}` } })
  const text = await response.text()
  const data = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(`Google API ${response.status}: ${data?.error?.message || text}`)
  return data
}

function gmailBody(payload) {
  const out = []
  const walk = part => {
    if (part?.body?.data && (part.mimeType === 'text/plain' || part.mimeType === 'text/html')) {
      const normalized = part.body.data.replace(/-/g, '+').replace(/_/g, '/')
      out.push({ mimeType: part.mimeType, text: Buffer.from(normalized, 'base64').toString('utf8') })
    }
    for (const child of part?.parts || []) walk(child)
  }
  walk(payload)
  return out
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'google_drive_search',
    description: 'Search files in Google Drive using Drive query syntax or fullText matching.',
    parameters: {
      query: { type: 'string', required: true, description: 'Text to search for.' },
      pageSize: { type: 'integer' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute({ query, pageSize }) {
      const size = Math.max(1, Math.min(pageSize || 20, 100))
      const q = `fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`
      const params = new URLSearchParams({ q, pageSize: String(size), fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink,owners(displayName,emailAddress))' })
      const data = await google(`https://www.googleapis.com/drive/v3/files?${params}`)
      return data.files || []
    },
  }))

  ctx.tools.register(defineTool({
    name: 'google_gmail_search',
    description: 'Search Gmail using Gmail search syntax.',
    parameters: {
      query: { type: 'string', required: true },
      maxResults: { type: 'integer' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute({ query, maxResults }) {
      const params = new URLSearchParams({ q: query, maxResults: String(Math.max(1, Math.min(maxResults || 20, 100))) })
      const data = await google(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`)
      return { resultSizeEstimate: data.resultSizeEstimate || 0, messages: data.messages || [] }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'google_gmail_read',
    description: 'Read a Gmail message by message ID, including headers and decoded text bodies.',
    parameters: { messageId: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute({ messageId }) {
      const data = await google(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`)
      const headers = Object.fromEntries((data.payload?.headers || []).map(h => [h.name, h.value]))
      return {
        id: data.id,
        threadId: data.threadId,
        labelIds: data.labelIds || [],
        snippet: data.snippet,
        headers,
        bodies: gmailBody(data.payload),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'google_calendar_events',
    description: 'List Google Calendar events in a time range.',
    parameters: {
      calendarId: { type: 'string' },
      timeMin: { type: 'string', description: 'RFC3339 lower bound.' },
      timeMax: { type: 'string', description: 'RFC3339 upper bound.' },
      maxResults: { type: 'integer' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute({ calendarId, timeMin, timeMax, maxResults }) {
      const params = new URLSearchParams({
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: String(Math.max(1, Math.min(maxResults || 50, 250))),
      })
      if (timeMin) params.set('timeMin', timeMin)
      if (timeMax) params.set('timeMax', timeMax)
      const id = encodeURIComponent(calendarId || 'primary')
      const data = await google(`https://www.googleapis.com/calendar/v3/calendars/${id}/events?${params}`)
      return (data.items || []).map(event => ({
        id: event.id,
        status: event.status,
        summary: event.summary,
        description: event.description,
        location: event.location,
        start: event.start,
        end: event.end,
        attendees: event.attendees,
        htmlLink: event.htmlLink,
      }))
    },
  }))
}
