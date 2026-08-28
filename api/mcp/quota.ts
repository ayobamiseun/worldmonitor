import {
  dailyCounterKey,
  PRO_DAILY_QUOTA_LIMIT,
  PRO_DAILY_QUOTA_TTL_SECONDS,
} from '../../server/_shared/pro-mcp-token';
import type { PipelineFn, QuotaRejected, QuotaReserved } from './types';

// ---------------------------------------------------------------------------
// Daily quota helpers (Pro-only). INCR-first reservation runs synchronously
// on the critical path BEFORE tool dispatch — never inside `waitUntil`.
// On pre-dispatch cap rejection we best-effort DECR. Once dispatch begins,
// callers keep the slot charged even if execution later errors or exceeds
// budget.
//
// The cap itself is plan-driven (plan 2026-07-25-001 U3): the caller passes the
// allowance resolved from the entitlement, and `PRO_DAILY_QUOTA_LIMIT` is the
// fallback for anyone who can't supply one.
// ---------------------------------------------------------------------------

/**
 * Normalise a plan-resolved allowance into the value this module enforces.
 *
 * `null` (unlimited) passes through; a finite non-negative number is honoured
 * verbatim — including `0`, which is a real "no allowance" and must not be
 * mistaken for a missing one. EVERYTHING else — undefined, a legacy row with no
 * `planLimits`, NaN/Infinity, a negative, a stringified number — resolves to
 * `PRO_DAILY_QUOTA_LIMIT`. That direction is deliberate: an unreadable limit
 * must never buy a caller a HIGHER cap than the plan default.
 *
 * Exported because the settings-UI reader (`api/user/mcp-quota.ts`) must DISPLAY
 * exactly the limit this module ENFORCES. A second copy of this normalisation
 * would be the drift the endpoint's whole reason for existing is to prevent.
 */
export function resolveDailyLimit(planDailyLimit?: number | null): number | null {
  if (planDailyLimit === null) return null;
  if (typeof planDailyLimit === 'number' && Number.isFinite(planDailyLimit) && planDailyLimit >= 0) {
    return planDailyLimit;
  }
  return PRO_DAILY_QUOTA_LIMIT;
}

/**
 * Plans whose catalog `mcpCallsPerDay` must NOT drive the daily cap on the
 * pro (OAuth) MCP context. The KTD6 boundary is a PLAN boundary, not a
 * credential boundary: API-tier subscribers can mint pro OAuth tokens too
 * (tier>=1 + mcpAccess), and without this gate their catalog allowance
 * (1000/10000) would leak through the OAuth door while their `user_key`
 * stays hardcoded at 50. Raising API-tier MCP allowances is a deliberate
 * follow-up; until then both credential classes must agree on the cap.
 */
const API_TIER_MCP_CAPPED_PLAN_KEYS = new Set([
  'api_starter',
  'api_starter_annual',
  'api_business',
  'api_business_annual',
]);

/**
 * Gate a plan-resolved MCP allowance on plan family: API-tier plans report
 * `undefined` (→ the 50/day default via `resolveDailyLimit`); every other
 * plan's allowance passes through verbatim — pro/pro_business plan-driven
 * numbers, enterprise's `null` (unlimited), free's `0`.
 *
 * Shared by the enforcement path (`checkMcpEntitlementGate`) and the
 * settings display (`api/user/mcp-quota.ts`) so the number a user reads is
 * the number the reservation applies.
 */
export function resolvePlanDrivenMcpAllowance(
  planKey: string | undefined,
  mcpCallsPerDay: number | null | undefined,
): number | null | undefined {
  if (planKey && API_TIER_MCP_CAPPED_PLAN_KEYS.has(planKey)) return undefined;
  return mcpCallsPerDay;
}

/**
 * Atomic floor-guarded rejection recovery (#7272). KEYS[1] = daily counter,
 * ARGV[1] = the resolved limit. Clamps the counter to the limit only while
 * it is above it, preserving the key's TTL; at or below the limit it changes
 * nothing. Returns the pre-clamp count (callers treat the reply as
 * best-effort). Same EVAL-through-pipeline idiom as the free-account
 * allowance reservation.
 */
const REJECTION_RECOVERY_SCRIPT = `
local c = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit = tonumber(ARGV[1])
if c > limit then
  redis.call('SET', KEYS[1], tostring(limit), 'KEEPTTL')
end
return {c}
`;

export async function reserveQuota(
  userId: string,
  pipeline: PipelineFn,
  planDailyLimit?: number | null,
): Promise<QuotaReserved | QuotaRejected> {
  // `null` = unlimited: the counter still moves (metering is not optional) but
  // the rejection branch below is skipped entirely.
  const limit = resolveDailyLimit(planDailyLimit);
  const key = dailyCounterKey(userId);
  if (!key) return { ok: false, reason: 'redis-unavailable' };

  let pipeResult: Array<{ result?: unknown; error?: unknown }> | null;
  try {
    pipeResult = await pipeline([
      ['INCR', key],
      ['EXPIRE', key, PRO_DAILY_QUOTA_TTL_SECONDS],
    ]);
  } catch {
    pipeResult = null;
  }

  if (!pipeResult || !Array.isArray(pipeResult) || pipeResult.length === 0) {
    // Hard cap correctness: NEVER dispatch on reservation failure.
    return { ok: false, reason: 'redis-unavailable' };
  }

  const incrRaw = pipeResult[0]?.result;
  const newCount = typeof incrRaw === 'number' ? incrRaw : Number(incrRaw);
  if (!Number.isFinite(newCount) || newCount < 1) {
    return { ok: false, reason: 'redis-unavailable' };
  }

  // Build idempotent rollback. `await rollback()` runs DECR once; subsequent
  // calls are no-ops.
  let rolledBack = false;
  const rollback = async (): Promise<void> => {
    if (rolledBack) return;
    rolledBack = true;
    try {
      await pipeline([['DECR', key]]);
    } catch {
      // Best-effort: a transient Redis failure means the counter overshoots
      // by 1, which is the cost-protection-correct direction.
    }
  };

  if (limit !== null && newCount > limit) {
    // Rejection recovery + counter-clamp (F4), atomically (#7272).
    //
    // The old recovery ran three separate best-effort steps — own DECR,
    // an INCR/DECR probe, then `overshoot` blind DECRs. The probe's
    // aggregate included OTHER requests' still-live increments, so one
    // rejection's clamp could absorb a concurrent rejection's increment;
    // when that request then ran its own DECR, the counter landed BELOW
    // the limit and admitted extra paid calls.
    //
    // The single EVAL below replaces all three steps: clamp to the
    // resolved limit only while the counter is above it. This both undoes
    // this request's own increment (it is part of the amount above the
    // limit) and heals any overshoot left by previously FAILED rollbacks
    // (a Redis hiccup can strand the counter at 2x the limit, which would
    // otherwise 429 the user until the 48h key TTL). Because the script
    // is atomic and floor-guarded, no interleaving of concurrent
    // rejections can take the counter below the limit — a request whose
    // increment was already absorbed by another rejection's clamp sees
    // `counter <= limit` and changes nothing.
    //
    // The clamp target is the RESOLVED limit, not the plan default —
    // clamping a 250/day caller down to 50 would hand them 200 free
    // calls on the next Redis hiccup. Admitted reservations are
    // untouched: their `rollback` stays an owner-owned single DECR, and
    // a charged counter at/below the limit is never modified here.
    try {
      // Best-effort: failure leaves the counter high, which is the
      // cost-protection-correct direction (user 429s, no free calls).
      await pipeline([[
        'EVAL',
        REJECTION_RECOVERY_SCRIPT,
        1,
        key,
        limit,
      ]]);
    } catch {
      // Recovery failed — leave counter as-is. Worst case the user 429s
      // until UTC midnight; never under-cap, never DoS exposure.
    }

    return { ok: false, reason: 'cap-exceeded', floor: limit };
  }

  return { ok: true, newCount, rollback };
}
