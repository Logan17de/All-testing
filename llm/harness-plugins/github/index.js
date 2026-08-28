import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'llm-harness-github'
export const inject = ['tools']

const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

function token() {
  const value = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (!value) throw new Error('GITHUB_TOKEN (or GH_TOKEN) is required')
  return value
}

function assertWriteEnabled() {
  if (process.env.HARNESS_GITHUB_ALLOW_WRITE !== '1') {
    throw new Error('GitHub write tools are disabled. Set HARNESS_GITHUB_ALLOW_WRITE=1 to enable them.')
  }
}

async function github(path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token()}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-harness-github-plugin',
      ...(init.headers || {}),
    },
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${data?.message || text}`)
  return data
}

function repoPath(owner, repo) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'github_repo_info',
    description: 'Get metadata for a GitHub repository.',
    parameters: {
      owner: { type: 'string', required: true },
      repo: { type: 'string', required: true },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute({ owner, repo }) {
      const data = await github(repoPath(owner, repo))
      return {
        full_name: data.full_name,
        description: data.description,
        private: data.private,
        default_branch: data.default_branch,
        language: data.language,
        stars: data.stargazers_count,
        forks: data.forks_count,
        open_issues: data.open_issues_count,
        html_url: data.html_url,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'github_read_file',
    description: 'Read a UTF-8 text file from a GitHub repository.',
    parameters: {
      owner: { type: 'string', required: true },
      repo: { type: 'string', required: true },
      path: { type: 'string', required: true },
      ref: { type: 'string' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute({ owner, repo, path, ref }) {
      const query = ref ? `?ref=${encodeURIComponent(ref)}` : ''
      const data = await github(`${repoPath(owner, repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}${query}`)
      if (data.type !== 'file') throw new Error(`Path is not a file: ${path}`)
      const content = Buffer.from((data.content || '').replace(/\n/g, ''), data.encoding || 'base64').toString('utf8')
      return { path: data.path, sha: data.sha, size: data.size, content, html_url: data.html_url }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'github_search_code',
    description: 'Search code on GitHub. Optionally restrict to one repository.',
    parameters: {
      query: { type: 'string', required: true },
      owner: { type: 'string' },
      repo: { type: 'string' },
      limit: { type: 'integer' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute({ query, owner, repo, limit }) {
      const scoped = owner && repo ? `${query} repo:${owner}/${repo}` : query
      const perPage = Math.max(1, Math.min(limit || 10, 100))
      const data = await github(`/search/code?q=${encodeURIComponent(scoped)}&per_page=${perPage}`)
      return {
        total_count: data.total_count,
        items: data.items.map(item => ({
          name: item.name,
          path: item.path,
          repository: item.repository.full_name,
          sha: item.sha,
          html_url: item.html_url,
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'github_create_issue',
    description: 'Create a GitHub issue. Disabled unless HARNESS_GITHUB_ALLOW_WRITE=1.',
    parameters: {
      owner: { type: 'string', required: true },
      repo: { type: 'string', required: true },
      title: { type: 'string', required: true },
      body: { type: 'string' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute({ owner, repo, title, body }) {
      assertWriteEnabled()
      const data = await github(`${repoPath(owner, repo)}/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body: body || '' }),
      })
      return { number: data.number, title: data.title, state: data.state, html_url: data.html_url }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'github_put_file',
    description: 'Create or replace a UTF-8 file in a GitHub repository. Disabled unless HARNESS_GITHUB_ALLOW_WRITE=1.',
    parameters: {
      owner: { type: 'string', required: true },
      repo: { type: 'string', required: true },
      path: { type: 'string', required: true },
      content: { type: 'string', required: true },
      message: { type: 'string', required: true },
      branch: { type: 'string' },
      sha: { type: 'string', description: 'Current blob SHA when replacing an existing file.' },
    },
    output: { schema: { type: 'json' }, render: renderJson },
    async execute({ owner, repo, path, content, message, branch, sha }) {
      assertWriteEnabled()
      const body = { message, content: Buffer.from(content, 'utf8').toString('base64') }
      if (branch) body.branch = branch
      if (sha) body.sha = sha
      const data = await github(`${repoPath(owner, repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return {
        commit_sha: data.commit?.sha,
        content_sha: data.content?.sha,
        path: data.content?.path,
        html_url: data.content?.html_url,
      }
    },
  }))
}
