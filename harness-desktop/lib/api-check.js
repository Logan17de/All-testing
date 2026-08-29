async function testApiConnection(config, options = {}) {
  const baseUrl = String(config?.baseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = String(config?.apiKey || '').trim();
  const provider = String(config?.provider || '').trim().toLowerCase();
  const protocol = String(config?.api || '').trim().toLowerCase();
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { ok: false, error: 'Enter a valid http(s) API base URL.' };
  }

  let url;
  try {
    url = new URL(`${baseUrl}/models`);
  } catch {
    return { ok: false, error: 'Enter a valid http(s) API base URL.' };
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return { ok: false, error: 'Enter a valid http(s) API base URL without embedded credentials.' };
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    return { ok: false, error: 'API keys require HTTPS. Plain HTTP is allowed only for a provider running on this computer.' };
  }

  const headers = {};
  if (apiKey) {
    if (protocol === 'anthropic-messages' || provider === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  }

  try {
    const response = await (options.fetch || fetch)(url, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs || 10_000),
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = null; }
    const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
    const models = rows.map((model) => typeof model === 'string'
      ? { id: model, name: model }
      : { id: model?.id || model?.name, name: model?.display_name || model?.displayName || model?.name || model?.id })
      .filter((model) => model.id);

    // Some valid provider protocols do not expose an OpenAI-style /models
    // endpoint. Treat only the explicit "endpoint not supported" statuses as a
    // soft probe result so the engine's own llm.discoverModels implementation
    // still gets a chance. Authentication and other provider errors remain hard
    // failures and are surfaced immediately.
    const probeUnsupported = [404, 405, 501].includes(response.status);
    return {
      ok: response.ok || probeUnsupported,
      status: response.status,
      models,
      probeUnsupported,
      preview: text.slice(0, 500),
      error: response.ok || probeUnsupported ? null : (payload?.error?.message || payload?.message || `API returned HTTP ${response.status}`),
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = { testApiConnection };
