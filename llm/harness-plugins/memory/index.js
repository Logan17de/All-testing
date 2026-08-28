import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'llm-harness-memory'
export const inject = ['tools']

const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
const memoryFile = () => process.env.DSH_MEMORY_FILE || join(homedir(), '.dsh', 'harness-memory.json')

async function loadStore() {
  try {
    return JSON.parse(await readFile(memoryFile(), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, entries: {} }
    throw error
  }
}

async function saveStore(store) {
  const file = memoryFile()
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temp, JSON.stringify(store, null, 2), 'utf8')
  await rename(temp, file)
}

function view(key, entry) {
  return { key, value: entry.value, tags: entry.tags || [], createdAt: entry.createdAt, updatedAt: entry.updatedAt }
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'memory_store',
    description: 'Store or replace durable memory by key.',
    parameters: {
      key: { type: 'string', required: true },
      value: { type: 'json', required: true },
      tags: { type: 'array', items: { type: 'string' } },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute({ key, value, tags }) {
      const store = await loadStore()
      const now = new Date().toISOString()
      const previous = store.entries[key]
      store.entries[key] = {
        value,
        tags: [...new Set(tags || [])],
        createdAt: previous?.createdAt || now,
        updatedAt: now,
      }
      await saveStore(store)
      return view(key, store.entries[key])
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_get',
    description: 'Get one durable memory entry by exact key.',
    parameters: { key: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute({ key }) {
      const store = await loadStore()
      return store.entries[key] ? view(key, store.entries[key]) : null
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: 'Search memory keys, tags, and JSON values using case-insensitive text matching.',
    parameters: {
      query: { type: 'string', required: true },
      limit: { type: 'integer' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute({ query, limit }) {
      const store = await loadStore()
      const needle = query.toLowerCase()
      const max = Math.max(1, Math.min(limit || 20, 100))
      return Object.entries(store.entries)
        .filter(([key, entry]) => `${key} ${(entry.tags || []).join(' ')} ${JSON.stringify(entry.value)}`.toLowerCase().includes(needle))
        .sort((a, b) => (b[1].updatedAt || '').localeCompare(a[1].updatedAt || ''))
        .slice(0, max)
        .map(([key, entry]) => view(key, entry))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_list',
    description: 'List recently updated durable memories.',
    parameters: { limit: { type: 'integer' } },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute({ limit }) {
      const store = await loadStore()
      const max = Math.max(1, Math.min(limit || 50, 200))
      return Object.entries(store.entries)
        .sort((a, b) => (b[1].updatedAt || '').localeCompare(a[1].updatedAt || ''))
        .slice(0, max)
        .map(([key, entry]) => view(key, entry))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Delete a durable memory entry by key.',
    parameters: { key: { type: 'string', required: true } },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute({ key }) {
      const store = await loadStore()
      const existed = Object.prototype.hasOwnProperty.call(store.entries, key)
      if (existed) {
        delete store.entries[key]
        await saveStore(store)
      }
      return { key, deleted: existed }
    },
  }))
}
