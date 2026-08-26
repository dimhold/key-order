# Results — 2026-08-26

Postgres 16.14, `fsync=on`, `synchronous_commit=on`, `full_page_writes=on`,
`shared_buffers=256MB`, `max_wal_size=4GB`, `checkpoint_timeout=30min`,
`work_mem=64MB`, `maintenance_work_mem=256MB`. Server settings are recorded
inside every row of `out/measurements-pass*.ndjson`, not just here.

Three passes. Passes 1 and 2 run three million rows in opposite strategy orders.
Pass 3 runs twenty million, where the random index (762 MB) no longer fits in
`shared_buffers` (256 MB) — the regime the measurement was written for.

## Twenty million rows

| | total insert | first 5 batches | last 5 batches | WAL | index | leaf fragmentation | leaf density |
|---|---|---|---|---|---|---|---|
| **R** random uuid | **152.9 s** | 1026 ms | **2496 ms** | 5.23 GB | 762 MB | **49.8%** | 71.2% |
| **T** uuid v7 | 54.5 s | 681 ms | 665 ms | 3.97 GB | 602 MB | 0% | 90.0% |
| **B** bigint TSID | 51.2 s | 627 ms | 640 ms | 3.67 GB | 428 MB | 0% | 90.1% |

Random against time-ordered, same type, same width, same data: **2.8x on insert
time, 1.32x on WAL, 1.27x on index size.** The pre-registered threshold was
1.5x on any one of the three.

**The shape matters more than the ratio.** The random key does not start slow, it
*becomes* slow: 1026 ms for the first batches, 2496 ms for the last, a 2.4x
decay inside a single run. The time-ordered key is flat end to end — 681 ms at
the start, 665 ms at the end. Extrapolating from a small table understates the
cost, because at a small table there is barely a cost to see.

## Three million rows, both orders

| pass | order | | insert | WAL | index | fragmentation |
|---|---|---|---|---|---|---|
| 1 | R→T→B | R | 14.7 s | 0.53 GB | 122 MB | 49.82% |
| 1 | | T | 7.8 s | 0.46 GB | 90 MB | 0% |
| 1 | | B | 6.9 s | 0.40 GB | 64 MB | 0% |
| 2 | B→T→R | B | 6.6 s | 0.41 GB | 64 MB | 0% |
| 2 | | T | 7.6 s | 0.47 GB | 90 MB | 0% |
| 2 | | R | 13.4 s | 0.52 GB | 122 MB | 49.82% |

Reversing the order changes the numbers by a few percent and changes nothing
about the result. Index sizes and `pgstatindex` output are identical to the
decimal between passes, which is what deterministic keys are for.

The same three-million-row pass was also run on a second machine — Postgres 16
in Docker on Windows — where R took 25.9 s and 28.7 s against T's 13.1 s and
10.5 s. Different absolute numbers, same ratio band, identical index sizes and
identical fragmentation.

## The one number

**49.8% leaf fragmentation against 0%, on identical data.**

Everything above follows from it. A random key arrives in a leaf page that is
already full, the page splits, and half of each split page stays empty — hence
71.2% leaf density against 90.1%, hence an index a quarter larger, hence more
pages touched per insert, hence more full-page images in WAL. Ordered keys
always land at the right edge of the tree, so nothing splits in the middle and
nothing fragments.

## What did not come out as expected

The point-lookup measurement is **not usable as written** and no claim is built
on it. The probe joins 2,000 known keys against the table in one query, so
Postgres is free to plan it as a hash or merge join over a bulk scan rather than
as 2,000 independent index lookups. The numbers it produced (411 ms for R,
526 ms for T, 544 ms for B at twenty million rows) point the wrong way for the
fragmented index, which is itself a sign the probe measures something other
than what its name says.

They are left in the artifact rather than deleted, and flagged here. A real read
measurement needs individual lookups with a cold cache, and that is a separate
run.

## Caveats

The OS page cache is not cleared between strategies. The server is restarted,
which clears `shared_buffers`, but the host cache is warm for everyone equally.
Absolute times are therefore optimistic for all three strategies.

This is one Postgres version and one B-tree implementation. Page splits are how
*this* index works, not a property of random keys in general.

The random key hides the neighbouring record from anyone who can guess an id.
That is a real advantage and it is not assessed here at all.

## Raw data

`out/measurements-pass1.ndjson`, `pass2`, `pass3` — one JSON line per strategy,
carrying every batch timing, every WAL delta, the `pgstatindex` output, the
sizes and the full server settings. Pass 1 and 2 also exist from the second
machine in `out-docker/`.
