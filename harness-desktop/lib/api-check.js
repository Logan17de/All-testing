async function testApiConnection(config, options = {}) {
  const baseUrl = String(config?.baseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = String(config?.apiKey || '').trim();
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

  try {
    const response = await (options.fetch || fetch)(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
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
    return {
      ok: response.ok,
      status: response.status,
      models,
      preview: text.slice(0, 500),
      error: response.ok ? null : (payload?.error?.message || payload?.message || `API returned HTTP ${response.status}`),
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = { testApiConnection };
