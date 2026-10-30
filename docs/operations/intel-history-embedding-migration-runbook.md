---
title: "Intel-history embedding migration runbook"
description: "Operator procedure for changing the embedding model or dimension behind the intelHistory vector index without mixing vector spaces. Public Mintlify docs never publish this procedure."
---

# Intel-history embedding migration runbook

Use this when the embedding model or its dimension behind `intelHistory`
has to change: a provider retires `text-embedding-3-small`, a better model is
adopted, or the dimension is tuned. **This is a table migration, not an edit
of a number.** Follow-up to #5694 / #5737; written for #5742.

Related: [Account deletion runbook](./account-deletion-runbook.md) for the
trusted-checkout conventions used below.

## The hazard, stated plainly

Every stored vector was produced by one model at one dimension. A vector
search ranks the query vector against stored vectors by cosine similarity,
and that number only means something when both come from the same space.
Mixing vectors from two models in one index is worse than a hard failure:
`search` keeps returning results, ranked against a scale that no longer
applies, and nothing errors.

A dimension change cannot even reach that state: Convex rejects a vector whose
length differs from the index's `dimensions`, so every insert fails after
deploy. A same-dimension model swap is the dangerous case, because every
insert succeeds.

## What pins the current space

Six places must agree. The parity suite `tests/intel-history-endpoints.test.mts`
pins the first four together; the last two are caches that self-invalidate.

| Literal | Where | Value today |
|---|---|---|
| `EMBED_MODEL`, `EMBED_DIMS` | `scripts/lib/brief-dedup-consts.mjs` | `openai/text-embedding-3-small`, `512` |
| `INTEL_HISTORY_EMBED_DIMS` | `convex/intelHistory.ts` | `512` |
| `INTEL_HISTORY_EMBED_MODEL` | `convex/intelHistory.ts` (#9885) | `openai/text-embedding-3-small@512`, stamped on every row |
| `dimensions` of `by_embedding` | `convex/schema.ts`, table `intelHistory` | `512` |
| `CACHE_VERSION` | `scripts/lib/brief-dedup-consts.mjs` | seeder-side embedding cache namespace; bump on any model or dimension change |
| `EMBED_CACHE_PREFIX` | `server/_shared/intel-history-embed.ts` | query-vector cache; derived from `EMBED_MODEL` and `EMBED_DIMS`, so it moves by itself |

Producers: `scripts/_seed-history.mjs` (`appendSeedHistory`, at most 150 rows
per run in chunks of 50) from `seed-conflict-intel`, `seed-energy-intelligence`
and `seed-cross-strait-activity`, through the secret-guarded relay route
`/relay/intel-history` in `convex/http.ts` into `internal.intelHistory.append`.
Readers: `search` (vector) and `timeline` (chronological), consumed by the
`get-similar-events`, `search-intel-history` and `get-intel-timeline` edge
handlers and the MCP tools that wrap them. Retention: `prune` ages rows out
180 days after `ingestedAt`, daily at 04:30 UTC.

## Read the inventory first

From a trusted checkout with the production deploy key:

```sh
npx convex run intelHistory:embeddingModelInventory '{"limit": 10000}'
```

It tallies the newest rows by their `embeddingModel` stamp and names the
current space. Expected in the steady state: one key equal to `current`,
plus `unstamped` for rows written before #9885 (those were produced by the
one model ever used and read as current). Any other key means a migration is
in progress or went wrong. `partial: true` means the limit cut the scan; raise
it or read `scripts/measure-intel-history.mjs` for the full row count, which
is also the re-embed cost basis.

## Decide the cutover mode

Record the choice in the PR that changes the constants. The decision for
World Monitor is:

- **Search serves the old space until the new one is complete, then flips in
  one deploy.** Never serve both in one ranked list, and do not go cold while
  the backfill runs: `timeline` does not depend on vectors and keeps working
  throughout, and `search` on the old space is correct, just about to be
  replaced.
- A **dimension change** needs a new table (`intelHistoryV2`, with its own
  `by_embedding` index at the new `dimensions`), dual-write during the
  backfill, a read flip, then retirement of the old table.
- A **same-dimension model change** may re-embed in place because the stamp
  (#9885) makes the old rows invisible to `search` the moment the constant
  changes: a row stamped with the old model is dropped from results, never
  ranked. History is then thin, not wrong, until the re-embed catches up.
  The module's "nothing is updated in place" rule has exactly this one
  exception, and only for the `embedding` and `embeddingModel` fields.

## Procedure: same-dimension model change

1. **Cost it.** Rows retained (`measure-intel-history.mjs`) times one
   embedding call each. A bumped `CACHE_VERSION` means zero cache hits by
   design, so budget the full count. At 50 rows per batch this is a few
   thousand OpenRouter calls for a full 180-day table.
2. **One deploy changes the constants together:** `EMBED_MODEL`,
   `CACHE_VERSION`, `INTEL_HISTORY_EMBED_MODEL`. The parity suite refuses a
   partial change. From this deploy on, new rows are stamped with the new
   space; `search` drops every old-stamped and unstamped row; the query
   cache namespace has moved by itself.
3. **Run the inventory.** Expect two keys: the new space (small, growing) and
   the old space plus `unstamped` (the backlog).
4. **Re-embed the backlog** with the helper described below. It is idempotent
   (rows already stamped with the current space are skipped) and resumable
   (it walks `by_ingestedAt` ascending from a saved cursor), so a crash or a
   budget stop can be re-run without re-spending.
5. **Run the inventory again.** Only the current key remains. Spot-check
   `search` through `search-intel-history` with a query that has a known
   answer in the old history.
6. **Rollback** at any point before step 5 completes: revert the constants
   deploy. Rows stamped with the new space become the foreign ones and are
   dropped; the old rows read as current again. Nothing is lost either way,
   because the re-embed rewrites a row's vector only after the new one is
   computed.

## Procedure: dimension change

1. Add `intelHistoryV2` to `convex/schema.ts`: the same fields, the same
   secondary indexes, a `by_embedding` index at the new `dimensions`. Keep
   the old table and index untouched.
2. Point `append` at both tables (dual-write) and `prune` at both. Reads stay
   on the old table. Deploy with the new `EMBED_MODEL`, `EMBED_DIMS`,
   `CACHE_VERSION`, `INTEL_HISTORY_EMBED_DIMS`, `INTEL_HISTORY_EMBED_MODEL`
   so the seeders embed at the new dimension; the relay rejects a vector of
   the old length, which is the intended guard.
3. Backfill: the same helper, reading the old table ascending by `ingestedAt`
   and inserting into the new one keyed by `dedupeKey` (idempotent through
   the existing dedupe lookup). Retractions (`intelHistoryRetractions`) apply
   by `dedupeKey` and need no copy.
4. When the new table's inventory count reaches the old table's retained
   count, flip `search`, `timeline` and `getByIds` to the new table in one
   deploy. Stop dual-write in the same deploy.
5. Retire the old table after one retention window (180 days), or sooner
   once the measure script confirms nothing reads it. Dropping a Convex table
   is a schema deploy; take a backup first.

## The re-embed helper (not yet written)

Acceptance item 2 of #5742 is still open. The helper should live in
`scripts/` so it ships with the seeders (Railway boundary rules: imports only
from `scripts/`, `node:*` and `scripts/package.json` packages), load
credentials through `loadEnvFile`, page the table the way
`scripts/measure-intel-history.mjs` does (`_system/cli/tableData` ascending by
`ingestedAt`, 500 rows a page), embed through `embedBatch` from
`scripts/lib/brief-embedding.mjs` in chunks of 50, and write through a new
secret-guarded relay route (`/relay/intel-history/reembed`) that patches only
`embedding` and `embeddingModel` on rows whose stamp is not current. It must
save its cursor after every committed chunk and skip already-current rows, so
a rerun is free. Until it exists, a same-dimension swap leaves history thin
for as long as it takes to write it; do not start a swap under pressure
without it.

## Drill

This procedure has not been exercised against a live deployment. The filter
semantics (foreign stamps dropped, unstamped rows current, inventory tallies)
are covered by `convex/__tests__/intelHistory.test.ts`. The first drill should
run the same-dimension procedure against a dev deployment seeded with a few
hundred rows, and record the elapsed time and OpenRouter spend here.
