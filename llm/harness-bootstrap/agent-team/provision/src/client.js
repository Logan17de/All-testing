/**
 * Minimal RPC client for the Agent Team plugin's public web transport.
 *
 * Agent Team exposes no cordis service and its storage domain is single-owner
 * (`ctx.storageDomain.open` throws `already-open` for a second consumer), so
 * `POST /agent-team/api` is the only supported programmatic seam. This client
 * speaks that documented envelope and nothing else — no core patching, no
 * node_modules edits, no fork.
 *
 * The transport's `sameOrigin()` guard passes when no `Origin` header is sent,
 * which is how a CLI is expected to reach it. We therefore never set one.
 */

const API_PATH = '/agent-team/api';

export class AgentTeamRpcError extends Error {
  constructor(method, code, message, details) {
    super(`${method} failed: ${code}: ${message}`);
    this.name = 'AgentTeamRpcError';
    this.method = method;
    this.code = code;
    this.details = details;
  }
}

export class AgentTeamClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async call(method, payload = {}, { expectedRevision } = {}) {
    const requestId = `provision-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const body = { requestId, method, payload };
    if (expectedRevision !== undefined) body.expectedRevision = expectedRevision;

    let response;
    try {
      response = await fetch(`${this.baseUrl}${API_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new AgentTeamRpcError(
        method,
        'UNREACHABLE',
        `Cannot reach Harness at ${this.baseUrl}. Is it running (\`dsh web\`)?`,
        { cause: String(cause) },
      );
    }

    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AgentTeamRpcError(method, 'MALFORMED_RESPONSE', text.slice(0, 300));
    }

    if (!response.ok || parsed.ok !== true) {
      const error = parsed.error ?? {};
      throw new AgentTeamRpcError(
        method,
        error.code ?? `HTTP_${response.status}`,
        error.message ?? 'Unknown failure',
        error.details,
      );
    }
    return parsed.value;
  }

  // --- catalog -------------------------------------------------------------
  catalog() { return this.call('catalog.get'); }
  modelCapabilities(provider, model) { return this.call('catalog.model.get', { provider, model }); }

  // --- assistants ----------------------------------------------------------
  listAssistants() { return this.call('assistant.list'); }
  createAssistant(input) { return this.call('assistant.create', input); }
  updateAssistant(id, value, expectedRevision) {
    return this.call('assistant.update', { id, value }, { expectedRevision });
  }

  // --- teams ---------------------------------------------------------------
  listTeams() { return this.call('team.list'); }
  getTeam(id) { return this.call('team.get', { id }); }
  createTeamDraft(input) { return this.call('team.createDraft', input); }
  startTeam(id) { return this.call('team.start', { id }); }
  workbench(id) { return this.call('team.workbench.get', { id }); }
  sendMessage(teamId, content, targetSlotId) {
    const payload = { teamId, content };
    if (targetSlotId !== undefined) payload.targetSlotId = targetSlotId;
    return this.call('team.message.send', payload);
  }
}
