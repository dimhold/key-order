# What a random primary key costs on Postgres

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
