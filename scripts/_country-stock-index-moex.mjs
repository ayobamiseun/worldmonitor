// @ts-check
//
// Moscow Exchange ISS leg of the country stock-index seeder (#6153).
//
// Yahoo Finance stopped serving MOEX data after 2022, so the RU entry in the
// public country enum was flagged `unavailable` (#6240). ISS is the exchange's
// own API: keyless, no registration, 15-minute delayed, UTF-8 JSON. The
// history endpoint returns a columnar `{ columns, data }` table, so every cell
// is read by column NAME, never by position, and an upstream column insertion
// cannot shift a field silently.
//
// Deliberately free of filesystem reads, like _country-stock-index.mjs, and
// free of network calls: the seeder injects fetch so this stays unit-testable.

import { buildCountryStockIndexSnapshotFromCloses } from './_country-stock-index.mjs';

export const MOEX_SOURCE = 'moex-iss';
export const MOEX_CURRENCY = 'RUB';
export const MOEX_HISTORY_DAYS = 45; // enough trading days for the 6-close weekly window across holidays
export const MOEX_USER_AGENT = 'WorldMonitor country-index seeder (+https://worldmonitor.app)';
const MOEX_ISS_ORIGIN = 'https://iss.moex.com';
const MOEX_TIMEOUT_MS = 15_000;

/** @param {string} symbol @param {Date} [now] */
export function moexHistoryUrl(symbol, now = new Date()) {
  const from = new Date(now.getTime() - MOEX_HISTORY_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const till = now.toISOString().slice(0, 10);
  const params = new URLSearchParams({
    'iss.meta': 'off',
    'iss.only': 'history',
    'history.columns': 'TRADEDATE,CLOSE',
    from,
    till,
  });
  return `${MOEX_ISS_ORIGIN}/iss/history/engines/stock/markets/index/securities/${encodeURIComponent(symbol)}.json?${params.toString()}`;
}

/**
 * Daily closes in trade-date order from an ISS history response.
 * Rows without a finite CLOSE are dropped; an unexpected shape yields [].
 * @param {unknown} payload
 * @returns {number[]}
 */
export function parseMoexHistoryCloses(payload) {
  const history = /** @type {{ columns?: unknown, data?: unknown } | undefined} */ (
    payload && typeof payload === 'object' ? /** @type {any} */ (payload).history : undefined
  );
  if (!history || !Array.isArray(history.columns) || !Array.isArray(history.data)) return [];
  const dateAt = history.columns.indexOf('TRADEDATE');
  const closeAt = history.columns.indexOf('CLOSE');
  if (dateAt === -1 || closeAt === -1) return [];
  const finiteClose = (value) => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
    && Number.isFinite(Number(value));
  return history.data
    .filter((row) => Array.isArray(row) && typeof row[dateAt] === 'string' && finiteClose(row[closeAt]))
    .sort((a, b) => String(a[dateAt]).localeCompare(String(b[dateAt])))
    .map((row) => Number(row[closeAt]));
}

/**
 * The public RPC snapshot for a MOEX-served country, or null when fewer than
 * two closes came back (the same refusal the Yahoo leg applies).
 * @param {unknown} payload
 * @param {{ code: string, symbol: string, name: string }} index
 * @param {string} [fetchedAt]
 */
export function buildMoexCountryStockIndexSnapshot(payload, index, fetchedAt = new Date().toISOString()) {
  return buildCountryStockIndexSnapshotFromCloses(parseMoexHistoryCloses(payload), MOEX_CURRENCY, fetchedAt, index);
}

/**
 * Fetch the ISS history for one index. `fetchImpl` is injectable for tests.
 * @param {{ code: string, symbol: string, name: string }} index
 * @param {{ fetchImpl?: typeof fetch, now?: Date }} [options]
 */
export async function fetchMoexCountryStockIndexSnapshot(index, { fetchImpl = (...args) => globalThis.fetch(...args), now = new Date() } = {}) {
  const response = await fetchImpl(moexHistoryUrl(index.symbol, now), {
    headers: { 'User-Agent': MOEX_USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(MOEX_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`MOEX ISS HTTP ${response.status}`);
  const payload = await response.json();
  const snapshot = buildMoexCountryStockIndexSnapshot(payload, index, now.toISOString());
  if (!snapshot) throw new Error('insufficient closes');
  return snapshot;
}
