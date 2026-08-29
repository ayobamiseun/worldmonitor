/**
 * #7315 — the settings billing card painted a paid-through cancellation in
 * the same red as a dead `expired` account.
 *
 * The colour ternary greened only `active` and yellowed `on_hold`; every
 * other status fell to red — so `cancelled` with weeks of paid access left
 * rendered a red dot and red plan name directly above copy saying
 * "Cancelled -- access until <date>". The colour wins; that contradiction is
 * a documented refund-request generator.
 *
 * The tone now comes from `derivePlanStatusTone`, which keys `cancelled`
 * (and any unrecognised status) on COVERAGE via `deriveBillingUxState` — the
 * same predicate billing-state.ts uses everywhere, so the card and the copy
 * cannot drift.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  derivePlanStatusTone,
  type BillingSubscriptionSnapshot,
  type BillingEntitlementSnapshot,
} from '@/services/billing-state';

const NOW = 1_800_000_000_000; // fixed epoch ms
const DAY = 86_400_000;

function sub(overrides: Partial<BillingSubscriptionSnapshot> = {}): BillingSubscriptionSnapshot {
  return {
    status: 'active',
    currentPeriodEnd: NOW + 30 * DAY,
    renewalVerificationState: null,
    ...overrides,
  };
}

function ent(overrides: Partial<BillingEntitlementSnapshot> = {}): BillingEntitlementSnapshot {
  return { planKey: 'pro', validUntil: NOW + 30 * DAY, ...overrides };
}

describe('derivePlanStatusTone (#7315)', () => {
  it('a paid-through cancellation is NOT the problem tone', () => {
    // The issue's reproduction: cancelled on 08-28 with validUntil 09-28
    // emailed support 13 minutes later because the card was red.
    const tone = derivePlanStatusTone(
      sub({ status: 'cancelled', currentPeriodEnd: NOW + 30 * DAY }),
      ent(),
      NOW,
    );
    assert.equal(tone, 'ok', 'a fully-entitled cancellation must not render in expired red');
  });

  it('a paid-through cancellation stays non-red even when the entitlement snapshot is late', () => {
    // billing-state.ts derives 'active' from the subscription row alone
    // (cancelled-but-paid-through) — the tone must follow the same predicate.
    const tone = derivePlanStatusTone(
      sub({ status: 'cancelled', currentPeriodEnd: NOW + 30 * DAY }),
      null,
      NOW,
    );
    assert.equal(tone, 'ok');
  });

  it('a cancellation past its paid window is the problem tone', () => {
    const tone = derivePlanStatusTone(
      sub({ status: 'cancelled', currentPeriodEnd: NOW - DAY }),
      ent({ validUntil: NOW - DAY }),
      NOW,
    );
    assert.equal(tone, 'problem');
  });

  it('expired is the problem tone, as today', () => {
    const tone = derivePlanStatusTone(
      sub({ status: 'expired', currentPeriodEnd: NOW - DAY }),
      ent({ validUntil: NOW - DAY }),
      NOW,
    );
    assert.equal(tone, 'problem');
  });

  it('active is ok and on_hold is attention, as today', () => {
    assert.equal(derivePlanStatusTone(sub(), ent(), NOW), 'ok');
    assert.equal(derivePlanStatusTone(sub({ status: 'on_hold' }), ent(), NOW), 'attention');
  });

  it('a Business invitee (no own subscription row) keeps the ok tone', () => {
    assert.equal(derivePlanStatusTone(null, ent(), NOW), 'ok');
  });

  it('an unrecognised status is explicit: coverage decides instead of silently falling to red', () => {
    const unknown = sub({ status: 'paused' as BillingSubscriptionSnapshot['status'] });
    assert.equal(
      derivePlanStatusTone(unknown, ent(), NOW),
      'ok',
      'an unknown status on a fully-entitled account must not paint the card dead',
    );
    assert.equal(
      derivePlanStatusTone(
        sub({ status: 'paused' as BillingSubscriptionSnapshot['status'], currentPeriodEnd: NOW - DAY }),
        ent({ validUntil: NOW - DAY }),
        NOW,
      ),
      'problem',
    );
  });
});

describe('UnifiedSettings billing-card wiring (#7315)', () => {
  // Source-text assertions, the same shape as billing-state-wiring.test.mts —
  // UnifiedSettings pulls in the whole settings UI graph, so the pure logic
  // lives in billing-state.ts and the component is pinned to consume it.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const settingsSrc = readFileSync(
    resolve(__dirname, '../src/components/UnifiedSettings.ts'),
    'utf8',
  );

  it('the status colour comes from derivePlanStatusTone, not a raw-status ternary', () => {
    assert.match(
      settingsSrc,
      /derivePlanStatusTone\(/,
      'the billing card must derive its tone from the shared coverage predicate',
    );
    assert.doesNotMatch(
      settingsSrc,
      /effectiveStatus === 'active' \? '#22c55e'/,
      'the raw-status colour ternary must be gone — it painted cancelled-but-covered in expired red',
    );
  });

  it('keeps the access-until copy for cancellations', () => {
    assert.match(settingsSrc, /Cancelled -- access until/);
  });
});
