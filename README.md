# What a random primary key costs on Postgres — an independent replication

This is not a new finding. The UUIDv4-against-UUIDv7 result on Postgres is
published, and this run reproduces it on different hardware, at a different
scale, with a harness written from the criteria rather than from anyone's code.
The prior work and what is specific to this run are listed at the bottom, with
links.

**Replication is the point.** The published numbers come from single runs
reported as prose. This one fixes the disproof threshold before counting,
alternates the order of the strategies between passes, generates keys
deterministically so a rerun produces the same keys, separates cold reads from
warm ones, and ships every batch timing and buffer counter as machine-readable
data. Everything below can be recomputed from `out/`.

Three strategies, the same rows, the same machine. The only thing that changes
between the first two is whether the keys arrive in order.

- **R** — a random `uuid`, arriving in no order.
- **T** — a `uuid` v7, arriving strictly ascending.
- **B** — a `bigint` TSID, ascending and half the width.

R and T are the same column type, the same 16 bytes, the same index and the same
payload. Comparing a `uuid` against a `bigint` would measure key width; between
R and T the only variable is order. B is reported separately, because its
advantage is width and blending the two would flatter it.

## The number that explains the rest

After three million rows, the random-key index has **49.8% leaf fragmentation
and 66.7% leaf density**. The time-ordered index has **0% fragmentation and 90%
density** — on identical data.

Everything else follows from that: the random index is a third larger, the
inserts take about twice as long, and the gap grows as the table fills.

Full numbers, including a twenty-million-row run where the index no longer fits
in `shared_buffers`, are in `RESULTS.md`.

## And the part that costs nothing

Reads. A 762 MB index at 49.8% fragmentation answers a point lookup in 236 us
cold; a 602 MB index at zero fragmentation answers it in 236 us cold. Same
blocks read, same latency. Fragmentation is paid on the write path and on disk,
not on a lookup by key — a B-tree descends a fixed number of levels either way.

That measurement exists because the first attempt at it was wrong and was
published as a debt rather than quietly dropped. `read.mjs` is the debt paid,
against the same tables.

## What is deliberately not done

`fsync` stays on. Turning it off removes exactly the cost under discussion.

Keys are not generated inside the timed section. `gen_random_uuid()` and a v7
generator cost different amounts of CPU, and that difference would land in an
insert measurement that is about index behaviour. All keys are laid out ahead of
time into a source table identical for every strategy, generated
deterministically from the row number, so a rerun produces the same keys.

Strategy order alternates between passes. The first load on a cold database is
always faster, and a fixed order would measure run order.

The server is restarted between strategies, because `shared_buffers` is
instance-wide and one database per strategy does not separate the buffer cache.
The OS page cache is **not** cleared, and that is stated as a caveat rather than
claimed as controlled.

## Run it

```bash
# against a Postgres in Docker
docker run -d --name keybench-pg -e POSTGRES_PASSWORD=bench -e POSTGRES_DB=bench \
  -p 5442:5432 --shm-size=256m postgres:16-alpine \
  -c shared_buffers=256MB -c max_wal_size=4GB -c checkpoint_timeout=30min \
  -c work_mem=64MB -c maintenance_work_mem=256MB

node run.mjs --rows 3000000 --batch 100000 --pass 1 --out out
node run.mjs --rows 3000000 --batch 100000 --pass 2 --out out   # reversed order

# or against a local cluster
node run.mjs --mode local --port 5433 --cluster bench --rows 20000000 --batch 250000 --pass 3 --out out
```

Every pass appends one JSON line per strategy to `out/measurements-pass<N>.ndjson`,
carrying per-batch timings, WAL deltas, index sizes, `pgstatindex` output and the
full server settings that produced them.

## Reading the criteria first

`CRITERIA.md` was committed before any data existed. It carries the definitions,
the counting rules, the run conditions and — written in advance — what result
would have made this not worth publishing: **under 1.5x on all three metrics.**
Corrections are appended to it with dates, never edited in place. Two are
already there, and both were written before the numbers they affect.

## Prior work, and what is actually new here

This section was written **after** the measurement, on 2026-08-27, which is the
wrong order and is recorded as such. It is here because a repository that lets a
reader believe it is first, when it is not, is worth less than one that hands
over the map.

The UUIDv4-against-UUIDv7 question on Postgres is **well covered**, and the
central finding here has been published before:

- [credativ, *A deeper look at old UUIDv4 vs new UUIDv7 in PostgreSQL 18*](https://www.credativ.de/en/blog/postgresql-en/a-deeper-look-at-old-uuidv4-vs-new-uuidv7-in-postgresql-18/)
  reports a 26–27% smaller v7 index, fewer leaf pages, higher average leaf
  density, and v4 leaf pages "completely fragmented". That is this repository's
  headline, arrived at independently and published earlier.
- [*Benchmarking Random (v4) and Time-based (v7) UUIDs*](https://dev.to/umangsinha12/postgresql-uuid-performance-benchmarking-random-v4-and-time-based-v7-uuids-n9b)
  reports v7 inserting more than 5x faster at 100 million rows, and also reports
  **point-lookup latency as similar between the two** — the null result in
  `RESULTS.md` is likewise not new.
- [equenum/postgre_uuid_performance](https://github.com/equenum/postgre_uuid_performance)
  is an existing public harness for the same comparison.

**What is left that is ours** is execution, not discovery:

- keys are generated deterministically from the row number rather than by
  `gen_random_uuid()`, so a rerun produces the same keys and the key generator's
  CPU cost stays out of the timed section;
- buffer accounting (`idx_blks_read` against `idx_blks_hit`) alongside the
  clock, so a cache hit and a disk read are never averaged together;
- the cold series and the warm series are reported separately — a factor of 47
  apart — instead of a single number that hides which one was measured;
- strategy order alternates between passes, and the disproof threshold was
  written before counting.

If you want the finding, the links above have it. If you want a harness you can
rerun and audit, that is what this is.
