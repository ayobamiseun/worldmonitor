import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BILLING_RETRY_MAX_DELAY_MS,
  billingRetryDelayMs,
  fetchWithBillingRetry,
} from '../src/services/billing-retry.ts';

// Guards the client half of the #5447/#5622 billing-verification contract:
// the server's retryable 503 (Retry-After + X-Billing-Verification) is inert
// unless the client retries at least once before surfacing a failure.

function res(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

describe('billingRetryDelayMs', () => {
  it('returns null for non-503 statuses (200, 403, 429, 500)', () => {
    for (const status of [200, 403, 429, 500]) {
      assert.equal(billingRetryDelayMs(res(status, { 'Retry-After': '5' })), null, `status ${status}`);
    }
  });

  it('honors Retry-After seconds on a 503', () => {
    assert.equal(billingRetryDelayMs(res(503, { 'Retry-After': '1' })), 1_000);
  });

  it('caps the honored Retry-After below the activation mutation budget', () => {
    // Server default for entitlement_verification_unavailable is 5s; the
    // wizard bounds each mutation to 5s total, so the delay must clamp.
    assert.equal(billingRetryDelayMs(res(503, { 'Retry-After': '5' })), BILLING_RETRY_MAX_DELAY_MS);
    assert.equal(billingRetryDelayMs(res(503, { 'Retry-After': '60' })), BILLING_RETRY_MAX_DELAY_MS);
  });

  it('falls back to a bounded default when Retry-After is missing or malformed', () => {
    const bare = billingRetryDelayMs(res(503));
    assert.ok(bare !== null && bare > 0 && bare <= BILLING_RETRY_MAX_DELAY_MS);
    const junk = billingRetryDelayMs(res(503, { 'Retry-After': 'soon' }));
    assert.equal(junk, bare);
    const negative = billingRetryDelayMs(res(503, { 'Retry-After': '-3' }));
    assert.equal(negative, bare);
  });
});

describe('fetchWithBillingRetry', () => {
  it('returns the first response untouched when it is not a retryable 503', async () => {
    let calls = 0;
    const ok = res(200);
    const out = await fetchWithBillingRetry(async () => { calls++; return ok; });
    assert.equal(out, ok);
    assert.equal(calls, 1);
  });

  it('retries exactly once on 503, honoring Retry-After', async () => {
    let calls = 0;
    const start = Date.now();
    const out = await fetchWithBillingRetry(async () => {
      calls++;
      return calls === 1 ? res(503, { 'Retry-After': '1' }) : res(200);
    });
    assert.equal(out.status, 200);
    assert.equal(calls, 2);
    assert.ok(Date.now() - start >= 950, 'must actually wait out the Retry-After delay');
  });

  it('a still-failing retry surfaces to the caller — no second retry', async () => {
    let calls = 0;
    const out = await fetchWithBillingRetry(async () => {
      calls++;
      return res(503, { 'Retry-After': '1' });
    });
    assert.equal(out.status, 503);
    assert.equal(calls, 2);
  });

  it('does not retry the provider-confirmed 403 (subscription_lapsed is terminal by design)', async () => {
    let calls = 0;
    const out = await fetchWithBillingRetry(async () => {
      calls++;
      return res(403, { 'X-Billing-Verification': 'subscription_lapsed' });
    });
    assert.equal(out.status, 403);
    assert.equal(calls, 1);
  });
});
