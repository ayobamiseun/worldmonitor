/**
 * #7276 — the POST→GET compatibility path silently dropped non-scalar body
 * fields.
 *
 * Scalars and scalar-array members became query parameters, but object
 * values and non-scalar array members were skipped without any signal — a
 * stale client could send `{filter: {region: 'eu'}}`, get a 200, and believe
 * its filter was applied while the endpoint returned the unfiltered dataset.
 *
 * The gateway now validates the whole parsed body before applying anything:
 * any unsupported value rejects the request with 400 and NO query parameter
 * from that body is applied (a mixed body must not be partially applied).
 * Non-JSON (including empty) bodies keep the legacy parameterless-GET
 * fallback, and the #3550 byte / array-count caps are unchanged.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { createDomainGateway } from '../server/gateway.ts';
import type { RouteDescriptor } from '../server/router.ts';

const originalValidKeys = process.env.WORLDMONITOR_VALID_KEYS;
const TEST_KEY = 'post-to-get-body-test-key';
// Fictional path on purpose: nothing in ENDPOINT_RATE_POLICIES matches it,
// so the gateway pipeline runs without a Redis stub.
const LIST_PATH = '/api/testdomain/v1/list-things';

afterEach(() => {
  if (originalValidKeys == null) delete process.env.WORLDMONITOR_VALID_KEYS;
  else process.env.WORLDMONITOR_VALID_KEYS = originalValidKeys;
});

function createGateway(seenQueries: string[]) {
  const routes: RouteDescriptor[] = [
    {
      method: 'GET',
      path: LIST_PATH,
      handler: async (req) => {
        seenQueries.push(new URL(req.url).search);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    },
  ];
  return createDomainGateway(routes);
}

function makePost(body: string): Request {
  process.env.WORLDMONITOR_VALID_KEYS = TEST_KEY;
  return new Request(`https://worldmonitor.app${LIST_PATH}`, {
    method: 'POST',
    body,
    headers: {
      Origin: 'https://worldmonitor.app',
      'X-WorldMonitor-Key': TEST_KEY,
      // undici does not auto-attach Content-Length on constructed Requests,
      // and isPostToGetCompatibleBodySize gates the compat path on it.
      'Content-Length': String(new TextEncoder().encode(body).byteLength),
    },
  });
}

describe('gateway POST→GET compatibility body handling (#7276)', () => {
  it('still converts a scalar-only body to query parameters', async () => {
    const seen: string[] = [];
    const gateway = createGateway(seen);

    const res = await gateway(makePost(JSON.stringify({ a: 1, b: 'x', c: true })));

    assert.equal(res.status, 200);
    assert.deepEqual(seen, ['?a=1&b=x&c=true']);
  });

  it('still converts scalar array members to repeated query parameters', async () => {
    const seen: string[] = [];
    const gateway = createGateway(seen);

    const res = await gateway(makePost(JSON.stringify({ ids: ['1', '2'], q: 'oil' })));

    assert.equal(res.status, 200);
    assert.deepEqual(seen, ['?ids=1&ids=2&q=oil']);
  });

  it('rejects an object value with 400 instead of silently dropping it', async () => {
    const seen: string[] = [];
    const gateway = createGateway(seen);

    const res = await gateway(
      makePost(JSON.stringify({ filter: { region: 'eu' } })),
    );

    assert.equal(res.status, 400, 'a dropped filter must not masquerade as an applied one');
    const payload = (await res.json()) as { error: string; parameter?: string };
    assert.match(payload.error, /unsupported/i);
    assert.equal(payload.parameter, 'filter');
    assert.deepEqual(seen, [], 'the handler must not run for a rejected body');
  });

  it('does not partially apply a mixed body (scalars before the offending key)', async () => {
    const seen: string[] = [];
    const gateway = createGateway(seen);

    const res = await gateway(
      makePost(JSON.stringify({ q: 'oil', filter: { region: 'eu' }, limit: 5 })),
    );

    assert.equal(res.status, 400);
    assert.deepEqual(seen, [], 'no parameter from a rejected body may reach the handler');
  });

  it('rejects a non-scalar array member with 400', async () => {
    const seen: string[] = [];
    const gateway = createGateway(seen);

    const res = await gateway(
      makePost(JSON.stringify({ ids: ['1', { nested: true }] })),
    );

    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { parameter?: string }).parameter, 'ids');
    assert.deepEqual(seen, []);
  });

  it('rejects a null value with 400 (null is not representable as a query scalar)', async () => {
    const seen: string[] = [];
    const gateway = createGateway(seen);

    const res = await gateway(makePost(JSON.stringify({ region: null })));

    assert.equal(res.status, 400);
    assert.deepEqual(seen, []);
  });

  it('rejects a valid-JSON body that is not an object (top-level array)', async () => {
    const seen: string[] = [];
    const gateway = createGateway(seen);

    const res = await gateway(makePost(JSON.stringify(['1', '2'])));

    assert.equal(res.status, 400);
    assert.deepEqual(seen, []);
  });

  it('rejects a valid-JSON body that is not an object (top-level string)', async () => {
    const seen: string[] = [];
    const gateway = createGateway(seen);

    // Pre-#7276 this leaked index→character pairs into the query string.
    const res = await gateway(makePost(JSON.stringify('abc')));

    assert.equal(res.status, 400);
    assert.deepEqual(seen, []);
  });

  it('keeps the legacy parameterless-GET fallback for a malformed-JSON body', async () => {
    const seen: string[] = [];
    const gateway = createGateway(seen);

    const res = await gateway(makePost('{oops'));

    assert.equal(res.status, 200);
    assert.deepEqual(seen, [''], 'malformed JSON converts to a GET with no parameters');
  });

  it('keeps the legacy parameterless-GET fallback for an empty body', async () => {
    const seen: string[] = [];
    const gateway = createGateway(seen);

    const res = await gateway(makePost(''));

    assert.equal(res.status, 200);
    assert.deepEqual(seen, ['']);
  });

  it('keeps the #3550 array-count cap with its existing response shape', async () => {
    const seen: string[] = [];
    const gateway = createGateway(seen);

    const res = await gateway(
      makePost(JSON.stringify({ ids: Array.from({ length: 201 }, (_, i) => String(i)) })),
    );

    assert.equal(res.status, 400);
    const payload = (await res.json()) as { parameter?: string; maxValues?: number };
    assert.equal(payload.parameter, 'ids');
    assert.equal(payload.maxValues, 200);
    assert.deepEqual(seen, []);
  });

  it('keeps the #3550 byte cap when Content-Length understates the body', async () => {
    const seen: string[] = [];
    const gateway = createGateway(seen);

    process.env.WORLDMONITOR_VALID_KEYS = TEST_KEY;
    const body = JSON.stringify({ a: 'x'.repeat(1_048_576) });
    const res = await gateway(
      new Request(`https://worldmonitor.app${LIST_PATH}`, {
        method: 'POST',
        body,
        headers: {
          Origin: 'https://worldmonitor.app',
          'X-WorldMonitor-Key': TEST_KEY,
          'Content-Length': '64',
        },
      }),
    );

    assert.equal(res.status, 400);
    assert.deepEqual(seen, []);
  });
});
