import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const PREFIX = '\u001eHARNESS_DESKTOP_IPC ';

const methods = new Map([
  ['session.list', ['sessions', 'list']],
  ['session.search', ['sessions', 'search']],
  ['session.create', ['sessions', 'create']],
  ['session.history', ['sessions', 'history']],
  ['session.models', ['sessions', 'models']],
  ['session.selectModel', ['sessions', 'selectModel']],
  ['session.rename', ['sessions', 'rename']],
  ['session.fork', ['sessions', 'fork']],
  ['session.prompt', ['sessions', 'prompt']],
  ['session.cancel', ['sessions', 'cancel']],
  ['workspace.list', ['workspace', 'list']],
  ['workspace.create', ['workspace', 'create']],
  ['workspace.rename', ['workspace', 'rename']],
  ['workspace.delete', ['workspace', 'delete']],
  ['workspace.archiveSession', ['workspace', 'archiveSession']],
  ['llm.providers', ['llm', 'providers']],
  ['llm.models', ['llm', 'models']],
  ['llm.discoverModels', ['llm', 'discoverModels']],
  ['settings.describe', ['settings', 'describe']],
  ['settings.update', ['settings', 'update']],
  ['settings.replace', ['settings', 'replace']],
  ['settings.mutate', ['settings', 'mutate']],
  ['credentials.describe', ['credentials', 'describe']],
  ['credentials.set', ['credentials', 'set']],
  ['credentials.unset', ['credentials', 'unset']],
  ['host.describe', ['host', 'describe']],
  ['host.openPath', ['host', 'openPath']],
  ['skills.list', ['skills', 'list']],
  ['agentPresets.list', ['agentPresets', 'list']],
  ['agentPresets.select', ['agentPresets', 'select']],
]);

function write(message) {
  process.stdout.write(`${PREFIX}${JSON.stringify(message)}\n`);
}

function errorMessage(error) {
  return error instanceof Error
    ? { message: error.message, stack: error.stack }
    : { message: String(error) };
}

async function apply(ctx) {
  const abort = new AbortController();
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const authorizationPrompts = new Map();

  ctx.on('dispose', () => {
    abort.abort(new Error('Harness Desktop engine stopped'));
    for (const pending of authorizationPrompts.values()) pending.reject(new Error('Authorization was interrupted.'));
    authorizationPrompts.clear();
    input.close();
  });

  input.on('line', async (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      write({ type: 'protocol-error', error: { message: 'Malformed JSON request rejected.' } });
      return;
    }

    if (!request || typeof request.id !== 'string' || typeof request.method !== 'string') {
      write({ type: 'protocol-error', error: { message: 'Malformed IPC request rejected.' } });
      return;
    }

    const target = methods.get(request.method);
    const authorizationMethod = request.method.startsWith('authorization.');
    if (!target && !authorizationMethod) {
      write({ type: 'response', id: request.id, result: { ok: false, error: { code: 'bad-request', message: `Method ${request.method} is not available to the desktop client.`, details: {} } } });
      return;
    }

    try {
      if (request.method === 'authorization.list') {
        write({ type: 'response', id: request.id, result: { ok: true, value: { items: ctx.authorization.list() } } });
        return;
      }
      if (request.method === 'authorization.answer') {
        const pending = authorizationPrompts.get(request.payload?.promptId);
        if (!pending) throw new Error('That authorization question is no longer active.');
        authorizationPrompts.delete(request.payload.promptId);
        pending.resolve(String(request.payload.answer ?? ''));
        write({ type: 'response', id: request.id, result: { ok: true, value: { ok: true } } });
        return;
      }
      if (request.method === 'authorization.cancel') {
        const key = String(request.payload?.key || '');
        ctx.authorization.cancel(key);
        for (const [promptId, pending] of authorizationPrompts) {
          if (pending.key !== key) continue;
          authorizationPrompts.delete(promptId);
          pending.reject(new Error('Authorization was cancelled.'));
        }
        write({ type: 'response', id: request.id, result: { ok: true, value: { ok: true } } });
        return;
      }
      if (request.method === 'authorization.begin') {
        const key = String(request.payload?.key || '');
        const attemptId = request.id;
        const result = await ctx.authorization.begin({
          key,
          method: request.payload?.method || undefined,
          signal: abort.signal,
          interaction: {
            notify(notice) {
              write({ type: 'event', stream: 'authorization', rpcId: attemptId, payload: { type: 'notice', attemptId, key, notice } });
            },
            prompt(prompt) {
              const promptId = randomUUID();
              const safePrompt = { ...prompt };
              delete safePrompt.signal;
              return new Promise((resolve, reject) => {
                const finish = () => authorizationPrompts.delete(promptId);
                authorizationPrompts.set(promptId, {
                  key,
                  resolve: (answer) => { finish(); resolve(answer); },
                  reject: (error) => { finish(); reject(error); },
                });
                if (prompt.signal) {
                  prompt.signal.addEventListener('abort', () => {
                    const pending = authorizationPrompts.get(promptId);
                    if (pending) pending.reject(new Error('Authorization question was withdrawn.'));
                  }, { once: true });
                }
                write({ type: 'event', stream: 'authorization', rpcId: attemptId, payload: { type: 'prompt', attemptId, promptId, key, prompt: safePrompt } });
              });
            },
          },
        });
        write({ type: 'response', id: request.id, result: { ok: true, value: result } });
        return;
      }
      const [domain, method] = target;
      const response = await ctx.apiProxy[domain][method]({
        rpcId: request.id,
        payload: request.payload ?? {},
      }, abort.signal);
      write({ type: 'response', id: request.id, result: response.result });
    } catch (error) {
      write({ type: 'response', id: request.id, result: { ok: false, error: { code: 'internal', ...errorMessage(error), details: {} } } });
    }
  });

  const stream = async (name, open) => {
    try {
      for await (const frame of open()) {
        write({ type: 'event', stream: name, rpcId: frame.rpcId, payload: frame.payload });
      }
    } catch (error) {
      if (!abort.signal.aborted) write({ type: 'stream-error', stream: name, error: errorMessage(error) });
    }
  };

  void stream('host', () => ctx.apiProxy.events.host({ rpcId: 'desktop-host-stream', payload: {} }, abort.signal));
  void stream('mux', () => ctx.apiProxy.events.mux({ rpcId: 'desktop-mux-stream', payload: {} }, abort.signal));
  write({ type: 'ready' });
}

export const inject = ['apiProxy', 'authorization'];
export default { name: 'harness-desktop-engine-bridge', inject, apply };
