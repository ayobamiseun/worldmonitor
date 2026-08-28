/**
 * #7275 — HEAD was advertised for every GET route but could never match one.
 *
 * `allowedMethods()` appends HEAD whenever GET exists, but `match()` compared
 * methods exactly and the gateway had no HEAD→GET fallback — so a HEAD to any
 * generated RPC GET endpoint answered `405 Allow: GET, HEAD`, a response that
 * tells the client to retry a method the server will never serve.
 *
 * The gateway now re-enters itself with a GET twin and strips the body at the
 * boundary, so auth, rate limits, CORS, and cache headers are byte-identical
 * to the GET the HEAD stands in for.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { createDomainGateway } from '../server/gateway.ts';
import type { RouteDescriptor } from '../server/router.ts';

const originalValidKeys = process.env.WORLDMONITOR_VALID_KEYS;
const TEST_KEY = 'head-fallback-test-key';
// Fictional paths on purpose: nothing in ENDPOINT_RATE_POLICIES matches them,
// so the gateway pipeline runs without a Redis stub.
const STATIC_PATH = '/api/testdomain/v1/get-head-probe';
const DYNAMIC_PATH = '/api/testdomain/v1/things/{id}';
const POST_ONLY_PATH = '/api/testdomain/v1/create-thing';

afterEach(() => {
  if (originalValidKeys == null) delete process.env.WORLDMONITOR_VALID_KEYS;
  else process.env.WORLDMONITOR_VALID_KEYS = originalValidKeys;
});

function createGateway(hits: Map<string, number>) {
  const record = (path: string) => hits.set(path, (hits.get(path) ?? 0) + 1);
  const routes: RouteDescriptor[] = [
    {
      method: 'GET',
      path: STATIC_PATH,
      handler: async () => {
        record(STATIC_PATH);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Head-Probe': 'static' },
        });
      },
    },
    {
      method: 'GET',
      path: DYNAMIC_PATH,
      handler: async (req) => {
        record(DYNAMIC_PATH);
        const id = new URL(req.url).pathname.split('/').pop();
        return new Response(JSON.stringify({ id }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Head-Probe': 'dynamic' },
        });
      },
    },
    {
      method: 'POST',
      path: POST_ONLY_PATH,
      handler: async () => new Response(JSON.stringify({ created: true }), { status: 200 }),
    },
  ];
  return createDomainGateway(routes);
}

function makeRequest(pathname: string, method: string): Request {
  process.env.WORLDMONITOR_VALID_KEYS = TEST_KEY;
  return new Request(`https://worldmonitor.app${pathname}`, {
    method,
    headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': TEST_KEY },
  });
}

describe('gateway HEAD fallback (#7275)', () => {
  it('serves HEAD on a static GET route: GET status and headers, no body, handler executed', async () => {
    const hits = new Map<string, number>();
    const gateway = createGateway(hits);

    const getRes = await gateway(makeRequest(STATIC_PATH, 'GET'));
    const headRes = await gateway(makeRequest(STATIC_PATH, 'HEAD'));

    assert.equal(getRes.status, 200);
    assert.equal(headRes.status, 200, 'HEAD must not 405 on a route whose Allow advertises it');
    assert.equal(await headRes.text(), '', 'HEAD must not carry a body');
    assert.equal(hits.get(STATIC_PATH), 2, 'the GET handler executes under HEAD (auth/limits ran too)');

    // The headers the GET carries are the headers the HEAD carries.
    assert.equal(headRes.headers.get('X-Head-Probe'), 'static');
    assert.equal(headRes.headers.get('Content-Type'), getRes.headers.get('Content-Type'));
    assert.equal(
      headRes.headers.get('Cache-Control'),
      getRes.headers.get('Cache-Control'),
      'cache behavior must match the GET twin',
    );
    assert.equal(
      headRes.headers.get('Access-Control-Allow-Origin'),
      getRes.headers.get('Access-Control-Allow-Origin'),
      'CORS must match the GET twin',
    );
  });

  it('serves HEAD on a dynamic {param} GET route', async () => {
    const hits = new Map<string, number>();
    const gateway = createGateway(hits);

    const headRes = await gateway(makeRequest('/api/testdomain/v1/things/42', 'HEAD'));

    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get('X-Head-Probe'), 'dynamic');
    assert.equal(await headRes.text(), '');
    assert.equal(hits.get(DYNAMIC_PATH), 1);
  });

  it('a HEAD to a POST-only route still 405s, and Allow no longer lies about HEAD', async () => {
    const gateway = createGateway(new Map());

    const headRes = await gateway(makeRequest(POST_ONLY_PATH, 'HEAD'));

    assert.equal(headRes.status, 405);
    const allow = headRes.headers.get('Allow') ?? '';
    assert.match(allow, /POST/);
    assert.doesNotMatch(allow, /HEAD/, 'HEAD is only advertised where GET exists');
    assert.equal(await headRes.text(), '', 'even the 405 carries no body under HEAD');
  });

  it('a HEAD to an unknown path 404s like its GET twin', async () => {
    const gateway = createGateway(new Map());
    const headRes = await gateway(makeRequest('/api/testdomain/v1/no-such-route', 'HEAD'));
    assert.equal(headRes.status, 404);
    assert.equal(await headRes.text(), '');
  });

  it('an unauthenticated HEAD gets the same denial as its GET twin, bodiless', async () => {
    const gateway = createGateway(new Map());
    process.env.WORLDMONITOR_VALID_KEYS = TEST_KEY;
    const bare = (method: string) => new Request(`https://worldmonitor.app${STATIC_PATH}`, { method });

    const getRes = await gateway(bare('GET'));
    const headRes = await gateway(bare('HEAD'));

    assert.equal(headRes.status, getRes.status, 'auth behavior must match the GET twin');
    assert.equal(await headRes.text(), '');
  });
});
