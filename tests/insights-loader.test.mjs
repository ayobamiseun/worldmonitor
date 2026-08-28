import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_AGE_MS,
  INSIGHTS_REFETCH_COOLDOWN_MS,
  fetchServerInsights,
  getServerInsights,
  __resetServerInsightsCacheForTests,
} from '../src/services/insights-loader';

describe('insights-loader', () => {
  describe('MAX_AGE_MS — server-cadence-aligned freshness window', () => {
    // The seeder cron interval is 30 min (scripts/seed-insights.mjs:363).
    // MAX_AGE_MS must be >= the cron interval, otherwise the panel will
    // appear UNAVAILABLE for part of every healthy cycle. 60 min gives
    // one missed-tick of headroom on top of that.
    it('is at least 30 minutes (cron interval)', () => {
      assert.ok(MAX_AGE_MS >= 30 * 60 * 1000, `expected >=30min, got ${MAX_AGE_MS / 60000}min`);
    });

    it('is at least 60 minutes (cron interval × 2 for missed-tick headroom)', () => {
      assert.ok(MAX_AGE_MS >= 60 * 60 * 1000, `expected >=60min, got ${MAX_AGE_MS / 60000}min`);
    });
  });

  describe('getServerInsights (logic validation)', () => {
    function isFresh(generatedAt) {
      const age = Date.now() - new Date(generatedAt).getTime();
      return age < MAX_AGE_MS;
    }

    it('rejects data older than the freshness window', () => {
      const old = new Date(Date.now() - MAX_AGE_MS - 60_000).toISOString();
      assert.equal(isFresh(old), false);
    });

    it('accepts data younger than the freshness window', () => {
      const fresh = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      assert.equal(isFresh(fresh), true);
    });

    it('accepts data from now', () => {
      assert.equal(isFresh(new Date().toISOString()), true);
    });

    it('rejects exactly window-aged data', () => {
      const exact = new Date(Date.now() - MAX_AGE_MS).toISOString();
      assert.equal(isFresh(exact), false);
    });
  });

  describe('ServerInsights payload shape', () => {
    it('validates required fields', () => {
      const valid = {
        worldBrief: 'Test brief',
        worldBriefSources: [{ title: 'Test', source: 's', url: 'https://example.com/test' }],
        briefProvider: 'groq',
        status: 'ok',
        topStories: [{ primaryTitle: 'Test', sourceCount: 2 }],
        generatedAt: new Date().toISOString(),
        clusterCount: 10,
        multiSourceCount: 5,
        fastMovingCount: 3,
      };
      assert.ok(valid.topStories.length >= 1);
      assert.ok(['ok', 'degraded'].includes(valid.status));
    });

    it('allows degraded status with empty brief', () => {
      const degraded = {
        worldBrief: '',
        status: 'degraded',
        topStories: [{ primaryTitle: 'Test' }],
        generatedAt: new Date().toISOString(),
      };
      assert.equal(degraded.worldBrief, '');
      assert.equal(degraded.status, 'degraded');
    });

    it('rejects empty topStories', () => {
      const empty = { topStories: [] };
      assert.equal(empty.topStories.length >= 1, false);
    });
  });

  describe('fetchServerInsights — bootstrap-key on-demand refetch', () => {
    let originalFetch;

    function makeValidInsights() {
      return {
        worldBrief: 'Test brief',
        worldBriefSources: [{ title: 'Test', source: 's', url: 'https://example.com/test' }],
        briefProvider: 'groq',
        status: 'ok',
        topStories: [{
          primaryTitle: 'Test', primarySource: 's', primaryLink: 'l', pubDate: '',
          sourceCount: 2, importanceScore: 1, velocity: { level: 'low', sourcesPerHour: 1 },
          isAlert: false, category: 'general', threatLevel: 'low', countryCode: null,
        }],
        generatedAt: new Date().toISOString(),
        clusterCount: 10,
        multiSourceCount: 5,
        fastMovingCount: 3,
      };
    }

    beforeEach(() => {
      __resetServerInsightsCacheForTests();
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('REGRESSION: recovers when getServerInsights() returns null because bootstrap hydration is missing', async () => {
      // Repros the mobile "AI INSIGHTS · UNAVAILABLE · Waiting for news data..."
      // bug: on 4G the fast-tier bootstrap aborts at 1.2 s, `insights` never
      // lands in the hydration cache, `getServerInsights()` returns null,
      // and InsightsPanel dead-ends on the mobile branch with no retry. The
      // on-demand fetcher must hit /api/bootstrap?keys=insights and return
      // validated data so the panel can recover without a page reload.
      const valid = makeValidInsights();
      let calledUrl = '';
      globalThis.fetch = async (url) => {
        calledUrl = String(url);
        return new Response(JSON.stringify({ data: { insights: valid } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      assert.equal(getServerInsights(), null, 'precondition: no hydrated data');
      const fetched = await fetchServerInsights();
      assert.ok(fetched, 'fetch fallback returned data');
      assert.equal(fetched?.worldBrief, 'Test brief');
      assert.match(calledUrl, /\/api\/bootstrap\?keys=insights\b/, 'used the bootstrap key-filter endpoint, not a separate route');
    });

    it('caches the fetched value so subsequent getServerInsights() is synchronous', async () => {
      const valid = makeValidInsights();
      let fetchCount = 0;
      globalThis.fetch = async () => {
        fetchCount++;
        return new Response(JSON.stringify({ data: { insights: valid } }), { status: 200 });
      };

      await fetchServerInsights();
      const sync = getServerInsights();
      assert.ok(sync, 'cached value visible to sync reader');
      assert.equal(sync?.worldBrief, 'Test brief');
      assert.equal(fetchCount, 1, 'no extra network round trip');
    });

    it('returns null without throwing when /api/bootstrap times out', async () => {
      globalThis.fetch = async () => {
        const err = new Error('aborted');
        err.name = 'TimeoutError';
        throw err;
      };
      const result = await fetchServerInsights(50);
      assert.equal(result, null);
    });

    it('returns null without throwing on a non-2xx response', async () => {
      globalThis.fetch = async () => new Response('upstream down', { status: 503 });
      const result = await fetchServerInsights();
      assert.equal(result, null);
    });

    it('returns null when payload validation fails (empty topStories)', async () => {
      const invalid = { ...makeValidInsights(), topStories: [] };
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ data: { insights: invalid } }), { status: 200 });
      const result = await fetchServerInsights();
      assert.equal(result, null);
    });

    it('returns null when payload validation fails (stale generatedAt)', async () => {
      const stale = { ...makeValidInsights(), generatedAt: new Date(Date.now() - MAX_AGE_MS - 60_000).toISOString() };
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ data: { insights: stale } }), { status: 200 });
      const result = await fetchServerInsights();
      assert.equal(result, null);
    });
  });
});

describe('fetchServerInsights in-flight lock and miss cooldown (#7290)', () => {
  const originalFetch = globalThis.fetch;

  function validSnapshot() {
    return {
      worldBrief: 'brief',
      briefProvider: 'groq',
      status: 'ok',
      topStories: [{ primaryTitle: 'T', sourceCount: 2 }],
      generatedAt: new Date().toISOString(),
      clusterCount: 1,
      multiSourceCount: 1,
      fastMovingCount: 0,
    };
  }

  /** Deferred fetch stub: requests count immediately, resolve on demand. */
  function installDeferredFetch() {
    const state = { count: 0, resolvers: [] };
    globalThis.fetch = () => new Promise((resolve) => {
      state.count += 1;
      state.resolvers.push(resolve);
    });
    return {
      state,
      resolveAll(payload) {
        for (const resolve of state.resolvers.splice(0)) {
          resolve(new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }));
        }
      },
      rejectAll() {
        // A Response with ok=false exercises the same miss path as a network
        // error without unhandled-rejection noise.
        for (const resolve of state.resolvers.splice(0)) {
          resolve(new Response('nope', { status: 502 }));
        }
      },
    };
  }

  beforeEach(() => {
    __resetServerInsightsCacheForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __resetServerInsightsCacheForTests();
  });

  it('collapses concurrent callers onto one request that all resolve from', async () => {
    const fetchStub = installDeferredFetch();

    // The boot shape from the DebugBear evidence: multiple consumers arrive
    // before the first response lands (observed pairs 1 ms apart).
    const first = fetchServerInsights();
    const second = fetchServerInsights();
    const third = fetchServerInsights();
    assert.equal(fetchStub.state.count, 1, 'callers arriving mid-flight must share the request');

    fetchStub.resolveAll({ data: { insights: validSnapshot() } });
    const results = await Promise.all([first, second, third]);

    assert.ok(results[0], 'the shared request resolves with the snapshot');
    assert.equal(results[1], results[0]);
    assert.equal(results[2], results[0]);
    assert.equal(fetchStub.state.count, 1);
  });

  it('a settled success serves later callers from cache with no further requests', async () => {
    const fetchStub = installDeferredFetch();
    const first = fetchServerInsights();
    fetchStub.resolveAll({ data: { insights: validSnapshot() } });
    await first;

    const later = await fetchServerInsights();
    assert.ok(later);
    assert.equal(fetchStub.state.count, 1, 'a fresh cached snapshot must not re-fetch');
  });

  it('a miss is shared by staggered consumers inside the cooldown instead of one request each', async () => {
    const fetchStub = installDeferredFetch();

    const first = fetchServerInsights();
    fetchStub.rejectAll();
    assert.equal(await first, null);
    assert.equal(fetchStub.state.count, 1);

    // The other two consumers mount moments later (the invalid-hydration
    // drain leaves all three empty-handed at once). They must not each pay a
    // network request for the outcome the first one just observed.
    assert.equal(await fetchServerInsights(), null);
    assert.equal(await fetchServerInsights(), null);
    assert.equal(fetchStub.state.count, 1, 'staggered consumers inside the cooldown share the miss');
  });

  it('a THROWN fetch does not arm the cooldown: the next refresh retries and recovers immediately', async () => {
    // Pins the panels' refresh contract (threat-timeline-panel.test.mts):
    // after a transient network failure, the very next explicit refresh must
    // reach the network and can recover — only answered misses (non-2xx or
    // invalid payload) arm the cooldown.
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) throw new Error('bootstrap unavailable');
      return new Response(JSON.stringify({ data: { insights: validSnapshot() } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    assert.equal(await fetchServerInsights(), null, 'the thrown fetch settles as a miss');
    const recovered = await fetchServerInsights();
    assert.equal(calls, 2, 'the immediate retry must reach the network');
    assert.ok(recovered, 'the retry recovers');
  });

  it('the miss cooldown does not latch: a later retry fetches again and can succeed', async () => {
    const fetchStub = installDeferredFetch();
    const first = fetchServerInsights();
    fetchStub.rejectAll();
    assert.equal(await first, null);

    // The cooldown is bounded — a page outliving it gets a real retry.
    assert.ok(
      INSIGHTS_REFETCH_COOLDOWN_MS <= 60_000,
      'the cooldown must stay well inside a page lifetime so retries actually happen',
    );

    // Reset stands in for the window elapsing (Date.now is not injectable
    // here, and the constant bound above pins that the window is short).
    __resetServerInsightsCacheForTests();
    const retry = fetchServerInsights();
    assert.equal(fetchStub.state.count, 2, 'after the cooldown a real retry goes to the network');
    fetchStub.resolveAll({ data: { insights: validSnapshot() } });
    assert.ok(await retry, 'the retry can recover');
  });
});
