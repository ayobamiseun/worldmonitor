// #7272 — the rejection clamp could undercount concurrent rollbacks.
//
// The old recovery ran three separate best-effort steps (own DECR, an
// INCR/DECR probe, then `overshoot` blind DECRs). The probe's aggregate
// included OTHER requests' still-live increments, so one request's clamp
// could absorb a concurrent rejection's increment — and when that request
// then performed its own DECR rollback, the counter landed BELOW the limit
// and admitted extra paid MCP calls. Recovery is now a single atomic
// floor-guarded EVAL: clamp to the resolved limit only while the counter is
// above it, so no request can push the counter below the floor and no
// request ever removes another request's increment.

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { makePipelineMock } from './helpers/mcp-pro-deps.mjs';

const originalEnv = { ...process.env };

// Mirrors the hardcoded PRO_DAILY_QUOTA_LIMIT (see mcp-quota-concurrent
// header for why the literal is intentional).
const QUOTA_LIMIT = 50;

describe('api/mcp/quota.ts — rejection recovery never undercounts the floor (#7272)', () => {
  let reserveQuota;

  beforeEach(async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
    ({ reserveQuota } = await import(`../api/mcp/quota.ts?t=${Date.now()}-${Math.random()}`));
  });

  afterEach(() => {
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  it('two concurrent rejections on an overshot counter: floor never falls below the limit', async () => {
    // The issue's interleaving: counter stuck at 52 (prior failed rollbacks),
    // A and B both increment, and each performs its own recovery. The old
    // clamp counted B's still-live increment as overshoot, then B rolled its
    // own increment back — landing the counter below 50.
    const pipe = makePipelineMock({ initialCount: QUOTA_LIMIT + 2 });

    const [a, b] = await Promise.all([
      reserveQuota('user-a-and-b', pipe.pipeline),
      reserveQuota('user-a-and-b', pipe.pipeline),
    ]);

    assert.equal(a.ok, false);
    assert.equal(b.ok, false);
    assert.equal(a.reason, 'cap-exceeded');
    assert.equal(b.reason, 'cap-exceeded');
    assert.equal(
      pipe.count, QUOTA_LIMIT,
      `counter must land exactly at the limit, never below; observed ${pipe.count}`,
    );
  });

  it('ten concurrent rejections on an overshot counter converge on exactly the limit', async () => {
    const pipe = makePipelineMock({ initialCount: QUOTA_LIMIT + 7 });

    const results = await Promise.all(Array.from(
      { length: 10 },
      () => reserveQuota('user-burst', pipe.pipeline),
    ));

    for (const res of results) {
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'cap-exceeded');
    }
    assert.equal(pipe.count, QUOTA_LIMIT, `observed ${pipe.count}`);
  });

  it('clamp target is the resolved plan limit, not the 50/day default', async () => {
    const pipe = makePipelineMock({ initialCount: 280 });

    const res = await reserveQuota('user-pro-biz', pipe.pipeline, 250);

    assert.equal(res.ok, false);
    assert.equal(res.reason, 'cap-exceeded');
    assert.equal(res.floor, 250);
    assert.equal(pipe.count, 250, 'clamping a 250/day caller to 50 would hand out free calls');
  });

  it('a single rejection at exactly the limit leaves the counter at the limit', async () => {
    const pipe = makePipelineMock({ initialCount: QUOTA_LIMIT });

    const res = await reserveQuota('user-at-cap', pipe.pipeline);

    assert.equal(res.ok, false);
    assert.equal(res.reason, 'cap-exceeded');
    assert.equal(pipe.count, QUOTA_LIMIT);
  });

  it('recovery failure overshoots, never undershoots (fail-closed direction)', async () => {
    // Every recovery attempt fails: the increment stays charged and the
    // caller still gets a cap rejection. High counter = 429s, no free calls.
    const pipe = makePipelineMock({
      initialCount: QUOTA_LIMIT + 2,
      throwOnEval: true,
      decrFails: true,
    });

    const res = await reserveQuota('user-hiccup', pipe.pipeline);

    assert.equal(res.ok, false);
    assert.equal(res.reason, 'cap-exceeded');
    assert.ok(
      pipe.count >= QUOTA_LIMIT,
      `counter must not undershoot the floor on recovery failure; observed ${pipe.count}`,
    );
  });

  it('reservation failure stays fail-closed (redis-unavailable, nothing dispatched)', async () => {
    const pipe = makePipelineMock({ throwOnIncr: true });

    const res = await reserveQuota('user-down', pipe.pipeline);

    assert.equal(res.ok, false);
    assert.equal(res.reason, 'redis-unavailable');
    assert.equal(pipe.count, 0);
  });

  it('unlimited plans still meter without ever rejecting or clamping', async () => {
    const pipe = makePipelineMock({ initialCount: 100_000 });

    const res = await reserveQuota('user-enterprise', pipe.pipeline, null);

    assert.equal(res.ok, true);
    assert.equal(pipe.count, 100_001, 'metering is not optional on unlimited plans');
    const verbs = pipe.ops.flat().map((cmd) => cmd[0]);
    assert.ok(!verbs.includes('EVAL'), 'no recovery/clamp may run for an unlimited plan');
  });

  it('admitted reservations keep their own idempotent rollback', async () => {
    const pipe = makePipelineMock({ initialCount: 10 });

    const res = await reserveQuota('user-ok', pipe.pipeline);

    assert.equal(res.ok, true);
    assert.equal(pipe.count, 11);
    await res.rollback();
    await res.rollback();
    assert.equal(pipe.count, 10, 'rollback runs exactly once');
  });
});
