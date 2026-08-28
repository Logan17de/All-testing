import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'llm-harness-deep-search'
export const inject = ['tools']

const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

function apiKey() {
  if (!process.env.EXA_API_KEY) throw new Error('EXA_API_KEY is required')
  return process.env.EXA_API_KEY
}

async function exa(path, body) {
  const response = await fetch(`https://api.exa.ai${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey(),
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(`Exa ${response.status}: ${data?.error || text}`)
  return data
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'deep_search',
    description: 'Deep web search using Exa. Returns ranked sources with text highlights/content when available.',
    parameters: {
      query: { type: 'string', required: true },
      numResults: { type: 'integer' },
      includeDomains: { type: 'array', items: { type: 'string' } },
      excludeDomains: { type: 'array', items: { type: 'string' } },
      category: { type: 'string' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute({ query, numResults, includeDomains, excludeDomains, category }) {
      const body = {
        query,
        type: 'auto',
        numResults: Math.max(1, Math.min(numResults || 10, 50)),
        contents: { text: { maxCharacters: 6000 }, highlights: { maxCharacters: 2000 } },
      }
      if (includeDomains?.length) body.includeDomains = includeDomains
      if (excludeDomains?.length) body.excludeDomains = excludeDomains
      if (category) body.category = category
      const data = await exa('/search', body)
      return {
        requestId: data.requestId,
        results: (data.results || []).map(result => ({
          title: result.title,
          url: result.url,
          publishedDate: result.publishedDate,
          author: result.author,
          score: result.score,
          highlights: result.highlights,
          text: result.text,
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'deep_fetch',
    description: 'Fetch cleaned page text from known URLs using Exa contents.',
    parameters: {
      urls: { type: 'array', required: true, items: { type: 'string' } },
      maxCharacters: { type: 'integer' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute({ urls, maxCharacters }) {
      if (!urls.length) return []
      const data = await exa('/contents', {
        urls: urls.slice(0, 20),
        text: { maxCharacters: Math.max(500, Math.min(maxCharacters || 12000, 50000)) },
      })
      return (data.results || []).map(result => ({
        title: result.title,
        url: result.url,
        publishedDate: result.publishedDate,
        author: result.author,
        text: result.text,
      }))
    },
  }))
}
