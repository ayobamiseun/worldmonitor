/**
 * Client-side handling of the retryable billing-verification contract
 * (#5447/#5622): gated endpoints answer 503 + Retry-After +
 * X-Billing-Verification while paid access is being re-confirmed with the
 * billing provider or the entitlement backend is briefly unreachable. A
 * single bounded retry makes that contract real on the client — without it
 * the activation wizard fails the step exactly as if the denial were
 * terminal. Kept dependency-free so it is unit-testable outside the
 * Vite/browser context.
 */

// The activation wizard bounds each mutation to ACTIVATION_MUTATION_TIMEOUT_MS
// (5s in src/components/ProActivationInterstitial.ts). One retry must leave
// room for two request round-trips inside that budget, so the honored
// Retry-After is capped well below it. The server's default Retry-After for
// entitlement_verification_unavailable is 5s — deliberately clamped here.
export const BILLING_RETRY_MAX_DELAY_MS = 2_000;
const BILLING_RETRY_DEFAULT_DELAY_MS = 1_000;

/**
 * Returns the delay (ms) to wait before the single retry, or null when the
 * response is not a retryable billing-verification denial. Honors Retry-After
 * (seconds) up to BILLING_RETRY_MAX_DELAY_MS.
 *
 * Only a 503 that carries the X-Billing-Verification marker is retryable:
 * the billing denial fires before the request body is read or any mutation
 * begins, so replaying it is safe. An UNMARKED 503 (relay outage, infra) may
 * have failed mid-mutation, and replaying an unkeyed POST there would run
 * delivery side effects twice. The subscription_lapsed 403 is a
 * provider-confirmed denial by design — never retried.
 */
export function billingRetryDelayMs(res: Pick<Response, 'status' | 'headers'>): number | null {
  if (res.status !== 503 || !res.headers.get('X-Billing-Verification')) return null;
  const retryAfter = Number(res.headers.get('Retry-After'));
  const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
    ? retryAfter * 1_000
    : BILLING_RETRY_DEFAULT_DELAY_MS;
  return Math.min(delayMs, BILLING_RETRY_MAX_DELAY_MS);
}

/**
 * Runs `doFetch` and, on a retryable 503, waits the bounded delay and runs it
 * exactly once more. The second response is returned as-is (a still-failing
 * retry surfaces to the caller's normal error path).
 */
export async function fetchWithBillingRetry(doFetch: () => Promise<Response>): Promise<Response> {
  const res = await doFetch();
  const delay = billingRetryDelayMs(res);
  if (delay === null) return res;
  await new Promise((resolve) => setTimeout(resolve, delay));
  return doFetch();
}
