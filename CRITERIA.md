# Criteria and definitions

**Written 2026-08-26, before a single number was counted**, and committed
separately so the order is visible in git history.

Nothing in this file is rewritten after counting. Corrections are appended at
the end, with a date and a reason.

---

## Question

What a random primary key costs on Postgres compared to a time-ordered one, on
the same data and the same machine.

"UUIDs are more convenient and the difference is pennies" is checked with three
numbers rather than an opinion: insert time, index size, WAL volume.

## Three strategies

| | key | how it is produced |
|---|---|---|
| **R** (random) | `uuid` | 128 bits spread uniformly across the key space, arriving in random order |
| **T** (time-ordered) | `uuid` | RFC 9562 v7: the top 48 bits are milliseconds since epoch, so values arrive strictly ascending |
| **B** (bigint TSID) | `bigint` | `(epoch_ms << 22) | counter`, 8 bytes, ascending |

**R and T use the same column type, the same width, the same index and the same
data.** That is the point: comparing `uuid` against `bigint` would measure key
width, not key order. Between R and T the only variable that differs is
monotonicity.

TSID, the 64-bit identifier the original question was about, brings a second and
more flattering advantage — width. It is measured as strategy **B** and reported
separately rather than blended into the ordering result.

## What is measured

| metric | how it is taken |
|---|---|
| `insertMs` | time per batch, kept per batch so degradation as the table grows is visible, not just an average |
| `walBytes` | difference of `pg_current_wal_lsn()` around the batch |
| `indexBytes` | `pg_relation_size` of the primary key index |
| `tableBytes` | `pg_relation_size` of the table |
| index health | `avg_leaf_density` and `leaf_fragmentation` from `pgstatindex` (`pgstattuple`) |
| `lookupMs` | point lookups by key after loading, over existing keys, on a cold server |

## Counting rules, fixed in advance

1. **The data is identical.** The row payload is generated once and served to
   every strategy. Only the keys differ.
2. **Strategy order alternates between passes.** The first load on a cold
   database is always faster; if R always went first, the measurement would be
   of run order.
3. **Each strategy gets its own database**, not its own table in a shared one.
4. **`fsync` is not turned off.** Turning it off removes exactly the cost under
   discussion.
5. **A `CHECKPOINT` precedes each measurement**, so background writing from the
   previous strategy does not land inside the next one.
6. **Zero model calls.** SQL and code only.
7. **Postgres version, server settings and the image are written into the
   artifact.** Numbers without them are not reproducible.

## Run conditions

Postgres 16, server settings passed explicitly and recorded in `RESULTS.md`.
`shared_buffers = 256MB` was chosen **before counting** and deliberately smaller
than the final index size: the measurement is about what happens when the index
does not fit in cache, because that is the working regime of a live database. A
run where everything fits in cache measures memory, not the key.

## What would disprove the expectation

Expectation: the random key is worse on all three numbers, and the gap widens as
the table fills.

**Threshold of interest, fixed before counting: at least 1.5x on at least one of
the three** — insert time on the last batch, WAL on the last batch, index size
at the end.

If every gap came in under 1.5x, **that** is what gets published: at this table
size key order does not decide anything, and the advice to swap UUID for TSID
was sold for more than it is worth. A negative outcome here is as publishable as
a positive one, and this is written in advance.

## What this does not do

Does not compare UUID against auto-increment and does not recommend a schema.
Does not measure distributed generation, collisions, or privacy — a random key
hides the neighbouring record, which is its real advantage and is not assessed
here.

Does not generalise to other databases. The Postgres B-tree and its page splits
are one implementation, not a property of random keys in general.

---

## Addendum 2026-08-26, before the first number: two corrections to the method

**1. Keys are generated deterministically, not by `gen_random_uuid()`.**
`gen_random_uuid()` and a v7 generator cost different amounts of CPU, and that
difference would land inside an insert measurement that is about index
behaviour. Keys are laid out ahead of time into a source table `src`, identical
for every strategy, and the insert reads a ready value:

- `k_r` = `md5(n || 'r')::uuid` — 128 bits, uniformly spread, arriving in random
  order. The same property as v4, plus reproducibility.
- `k_t` = uuid v7 per RFC 9562, top 48 bits from `base_ms + n/10`, strictly
  ascending.
- `k_b` = `bigint`, `(base_ms + n/10) << 22 | (n % 2^22)` — a TSID.

`src` is built once per run; the insert reads from it. Read cost is identical
across strategies.

**2. Separate databases do not separate the cache, and this is named in
advance.** `shared_buffers` is instance-wide, so "one database per strategy"
isolates the catalog and not the buffer cache. Isolation comes from restarting
the server between strategies, which clears `shared_buffers`. **The operating
system page cache is not cleared**, and that is a caveat of the method rather
than an eliminated factor: it applies equally to all three strategies but
depresses all absolute numbers.

Strategy order alternates between passes (rule 2): pass 1 is R -> T -> B,
pass 2 is B -> T -> R.

---

## Addendum 2026-08-26, after the first run: `src` is built in chunks

Building `src` with a single `INSERT ... generate_series(1, 20000000)` crashed
the backend and, on the machine it first ran on, filled the disk. The source
table is now filled in one-million-row chunks inside a `DO` block. This changes
nothing about what is measured — `src` is not part of any timed section — and is
recorded because the first attempt at 20M rows produced no data at all.
