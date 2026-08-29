import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const TODO_STATES = new Set(['pending', 'in_progress', 'completed', 'blocked', 'failed'])
const GOAL_STATES = new Set(['pending', 'in_progress', 'completed', 'blocked', 'failed'])

function now() {
  return new Date().toISOString()
}

function cleanText(value, label) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`${label} must be a non-empty string.`)
  return text
}

function freshState() {
  return {
    version: 1,
    goal: null,
    todos: [],
    currentJob: null,
    updatedAt: now(),
  }
}

function normalizeState(input) {
  const state = input && typeof input === 'object' ? input : {}
  return {
    version: 1,
    goal: state.goal && typeof state.goal === 'object' ? state.goal : null,
    todos: Array.isArray(state.todos) ? state.todos : [],
    currentJob: state.currentJob && typeof state.currentJob === 'object' ? state.currentJob : null,
    updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : now(),
  }
}

export class BridgeStateStore {
  constructor(workspace = process.cwd()) {
    this.workspace = path.resolve(workspace)
    this.root = path.join(this.workspace, '.dsh', 'copycat-bridge')
    this.file = path.join(this.root, 'state.json')
    this.state = this.#load()
  }

  #load() {
    try {
      return normalizeState(JSON.parse(fs.readFileSync(this.file, 'utf8')))
    } catch {
      return freshState()
    }
  }

  #save() {
    fs.mkdirSync(this.root, { recursive: true })
    this.state.updatedAt = now()
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, this.file)
    return this.snapshot()
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state))
  }

  goalCreate(title) {
    this.state.goal = {
      id: `goal_${randomUUID().slice(0, 8)}`,
      title: cleanText(title, 'Goal title'),
      status: 'in_progress',
      createdAt: now(),
      updatedAt: now(),
      evidence: '',
      blockedReason: '',
    }
    return this.#save().goal
  }

  goalGet() {
    return this.snapshot().goal
  }

  goalUpdate({ title, status, evidence, reason } = {}) {
    if (!this.state.goal) throw new Error('No active goal exists.')
    if (title !== undefined) this.state.goal.title = cleanText(title, 'Goal title')
    if (status !== undefined) {
      if (!GOAL_STATES.has(status)) throw new Error(`Unsupported goal status: ${status}`)
      this.state.goal.status = status
    }
    if (evidence !== undefined) this.state.goal.evidence = String(evidence)
    if (reason !== undefined) this.state.goal.blockedReason = String(reason)
    this.state.goal.updatedAt = now()
    return this.#save().goal
  }

  goalComplete(evidence = '') {
    if (!this.state.goal) throw new Error('No active goal exists.')
    const unfinished = this.state.todos.filter(todo => todo.status !== 'completed')
    if (unfinished.length) {
      throw new Error(`Goal cannot be completed while ${unfinished.length} todo(s) are unfinished.`)
    }
    this.state.goal.status = 'completed'
    this.state.goal.evidence = String(evidence || this.state.goal.evidence || '')
    this.state.goal.updatedAt = now()
    return this.#save().goal
  }

  todoCreate(title, acceptanceCriteria = []) {
    const criteria = Array.isArray(acceptanceCriteria)
      ? acceptanceCriteria.map(item => ({
        text: cleanText(item, 'Acceptance criterion'),
        verified: false,
        evidence: '',
        verifiedAt: null,
      }))
      : []
    const todo = {
      id: `todo_${randomUUID().slice(0, 8)}`,
      title: cleanText(title, 'Todo title'),
      status: 'pending',
      acceptanceCriteria: criteria,
      blockedReason: '',
      failureReason: '',
      createdAt: now(),
      updatedAt: now(),
      completedAt: null,
    }
    this.state.todos.push(todo)
    this.#save()
    return JSON.parse(JSON.stringify(todo))
  }

  todoList() {
    return this.snapshot().todos
  }

  #todo(id) {
    const todo = this.state.todos.find(item => item.id === id)
    if (!todo) throw new Error(`Todo not found: ${id}`)
    return todo
  }

  todoStart(id) {
    const todo = this.#todo(id)
    if (todo.status === 'completed') throw new Error('A completed todo cannot be started again.')
    todo.status = 'in_progress'
    todo.blockedReason = ''
    todo.failureReason = ''
    todo.updatedAt = now()
    this.#save()
    return JSON.parse(JSON.stringify(todo))
  }

  todoVerify(id, criterionIndex, evidence) {
    const todo = this.#todo(id)
    const index = Number(criterionIndex)
    if (!Number.isInteger(index) || index < 0 || index >= todo.acceptanceCriteria.length) {
      throw new Error(`Acceptance criterion index out of range for ${id}.`)
    }
    const criterion = todo.acceptanceCriteria[index]
    criterion.verified = true
    criterion.evidence = cleanText(evidence, 'Verification evidence')
    criterion.verifiedAt = now()
    todo.updatedAt = now()
    this.#save()
    return JSON.parse(JSON.stringify(todo))
  }

  todoComplete(id) {
    const todo = this.#todo(id)
    const unverified = todo.acceptanceCriteria.filter(item => !item.verified)
    if (unverified.length) {
      throw new Error(`Todo cannot be completed: ${unverified.length} acceptance criterion/criteria are not verified.`)
    }
    todo.status = 'completed'
    todo.completedAt = now()
    todo.updatedAt = now()
    todo.blockedReason = ''
    todo.failureReason = ''
    this.#save()
    return JSON.parse(JSON.stringify(todo))
  }

  todoBlock(id, reason) {
    const todo = this.#todo(id)
    todo.status = 'blocked'
    todo.blockedReason = cleanText(reason, 'Blocked reason')
    todo.updatedAt = now()
    this.#save()
    return JSON.parse(JSON.stringify(todo))
  }

  todoFail(id, reason) {
    const todo = this.#todo(id)
    todo.status = 'failed'
    todo.failureReason = cleanText(reason, 'Failure reason')
    todo.updatedAt = now()
    this.#save()
    return JSON.parse(JSON.stringify(todo))
  }

  setCurrentJob(job) {
    this.state.currentJob = job ? { ...job, updatedAt: now() } : null
    return this.#save().currentJob
  }

  clearCurrentJob() {
    this.state.currentJob = null
    return this.#save().currentJob
  }

  summary() {
    const todos = this.state.todos
    const counts = Object.fromEntries([...TODO_STATES].map(status => [status, todos.filter(item => item.status === status).length]))
    const current = todos.find(item => item.status === 'in_progress') || null
    const next = todos.find(item => item.status === 'pending') || null
    return {
      goal: this.state.goal ? {
        id: this.state.goal.id,
        title: this.state.goal.title,
        status: this.state.goal.status,
      } : null,
      todos: {
        total: todos.length,
        ...counts,
        allCompleted: todos.length > 0 && todos.every(item => item.status === 'completed'),
      },
      current: current ? { id: current.id, title: current.title } : null,
      next: next ? { id: next.id, title: next.title } : null,
      currentJob: this.state.currentJob,
      updatedAt: this.state.updatedAt,
    }
  }
}

export { TODO_STATES, GOAL_STATES }
