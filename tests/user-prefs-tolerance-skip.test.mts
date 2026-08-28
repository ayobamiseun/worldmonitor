/**
 * #7140 — the acceptedWithinClockTolerance capture skip is a documented
 * invariant (CONCEPTS.md "Two-Verifier Seam", #7097) with no test.
 *
 * A token the edge accepted only inside its bounded clockTolerance can age
 * past Convex's own leeway and be refused there. That 401 must stay OUT of
 * the WORLDMONITOR-QK (convex_auth_drift) Sentry bucket: QK's warning-level
 * downgrade and until_escalating archive are calibrated to genuine drift, and
 * refilling it with by-design near-expiry traffic is exactly the May–July
 * 2026 13.6x ramp shape. Deleting either branch's skip breaks the documented
 * invariant with no test going red — this file closes that.
 *
 * Asserts on the CAPTURE, not the skip's console.warn: deleting the early
 * return while keeping the log would still pass a log-based test. The capture
 * fn is injected through the same __setUserPrefsDepsForTests seam the other
 * user-prefs suites drive (mock.module() would need the experimental
 * module-mocks flag, which the test:data runner does not pass).
 *
 * Both call sites are covered on purpose — GET has never fired in production,
 * but "the sign-in GET uses a just-fetched token" is now a claim the QK
 * diagnosis doc makes, and testing only POST institutionalizes the exact
 * one-half drift #7097 found in clerk.ts.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import handler, { __setUserPrefsDepsForTests } from '../api/user-prefs.ts';

const originalConvexUrl = process.env.CONVEX_URL;
const TEST_USER_ID = 'user_tolerance_test';

afterEach(() => {
  __setUserPrefsDepsForTests(null);
  if (originalConvexUrl === undefined) delete process.env.CONVEX_URL;
  else process.env.CONVEX_URL = originalConvexUrl;
});

/** Convex refusing the token its own way — classified UNAUTHENTICATED. */
function convexUnauthenticated(): Error {
  return new Error('[CONVEX Q(userPreferences:getPreferences)] Unauthenticated: UNAUTHENTICATED');
}

function installDeps({ withinTolerance }: { withinTolerance: boolean }): { captures: unknown[][] } {
  process.env.CONVEX_URL = 'https://convex.test';
  const captures: unknown[][] = [];
  __setUserPrefsDepsForTests({
    validateBearerToken: (async () => ({
      valid: true,
      userId: TEST_USER_ID,
      ...(withinTolerance ? { acceptedWithinClockTolerance: true as const } : {}),
    })) as never,
    checkScopedRateLimit: (async () => ({
      allowed: true,
      limit: 60,
      reset: Date.now() + 60_000,
      degraded: false,
    })) as never,
    createConvexClient: () => ({
      setAuth(): void {},
      async query(): Promise<unknown> {
        throw convexUnauthenticated();
      },
      async mutation(): Promise<unknown> {
        throw convexUnauthenticated();
      },
    }),
    captureSilentError: ((...args: unknown[]) => {
      captures.push(args);
    }) as never,
  });
  return { captures };
}

function makeGet(): Request {
  return new Request('https://worldmonitor.app/api/user-prefs?variant=full', {
    method: 'GET',
    headers: {
      Origin: 'https://worldmonitor.app',
      Authorization: 'Bearer test-token',
    },
  });
}

function makePost(): Request {
  return new Request('https://worldmonitor.app/api/user-prefs', {
    method: 'POST',
    headers: {
      Origin: 'https://worldmonitor.app',
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ variant: 'full', data: { theme: 'dark' }, expectedSyncVersion: 1 }),
  });
}

describe('acceptedWithinClockTolerance keeps near-expiry 401s out of the drift bucket (#7140)', () => {
  for (const [method, makeRequest] of [
    ['GET', makeGet],
    ['POST', makePost],
  ] as const) {
    it(`${method}: a tolerance-accepted Convex Unauthenticated returns 401 with NO drift capture`, async () => {
      const { captures } = installDeps({ withinTolerance: true });
      const res = await handler(makeRequest());
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: 'UNAUTHENTICATED' });
      assert.equal(captures.length, 0, 'near-expiry traffic must not refill WORLDMONITOR-QK');
    });

    it(`${method}: an ordinary Convex Unauthenticated still captures drift at warning level`, async () => {
      const { captures } = installDeps({ withinTolerance: false });
      const res = await handler(makeRequest());
      assert.equal(res.status, 401);
      assert.equal(captures.length, 1, 'genuine drift must keep reaching the capture');
      const context = captures[0]?.[1] as { level?: string; tags?: Record<string, unknown> } | undefined;
      assert.equal(context?.level, 'warning');
    });
  }
});
