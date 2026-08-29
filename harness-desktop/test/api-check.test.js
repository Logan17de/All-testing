const assert = require('node:assert/strict');
const test = require('node:test');
const { testApiConnection } = require('../lib/api-check');

test('API check rejects malformed URLs and embedded credentials', async () => {
  assert.equal((await testApiConnection({ baseUrl: 'not-a-url' })).ok, false);
  const embedded = await testApiConnection({ baseUrl: 'https://user:secret@example.test/v1' });
  assert.equal(embedded.ok, false);
  assert.match(embedded.error, /without embedded credentials/);
});

test('API check sends a bearer token and accepts a successful models response', async () => {
  let observed;
  const result = await testApiConnection(
    { baseUrl: 'https://provider.example/v1/', apiKey: 'test-key' },
    { fetch: async (url, init) => {
      observed = { url: String(url), authorization: init.headers.Authorization };
      return new Response('{"data":[]}', { status: 200 });
    } },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(observed, {
    url: 'https://provider.example/v1/models',
    authorization: 'Bearer test-key',
  });
  assert.deepEqual(result.models, []);
});

test('API check returns the provider model catalogue and blocks remote plain HTTP', async () => {
  const result = await testApiConnection(
    { baseUrl: 'https://provider.example/v1', apiKey: 'test-key' },
    { fetch: async () => new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b', name: 'Model B' }] }), { status: 200 }) },
  );
  assert.deepEqual(result.models, [
    { id: 'model-a', name: 'model-a' },
    { id: 'model-b', name: 'Model B' },
  ]);
  const insecure = await testApiConnection({ baseUrl: 'http://provider.example/v1', apiKey: 'secret' });
  assert.equal(insecure.ok, false);
  assert.match(insecure.error, /require HTTPS/);
});

test('API check reports provider errors and network failures clearly', async () => {
  const denied = await testApiConnection(
    { baseUrl: 'https://provider.example/v1' },
    { fetch: async () => new Response('denied', { status: 401 }) },
  );
  assert.deepEqual({ ok: denied.ok, status: denied.status, error: denied.error }, {
    ok: false, status: 401, error: 'API returned HTTP 401',
  });

  const offline = await testApiConnection(
    { baseUrl: 'https://provider.example/v1' },
    { fetch: async () => { throw new Error('connection refused'); } },
  );
  assert.equal(offline.ok, false);
  assert.match(offline.error, /connection refused/);
});
