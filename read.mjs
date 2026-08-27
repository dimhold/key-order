/**
 * key-order, the read measurement — the debt named in RESULTS.md of 2026-08-26.
 *
 *   node read.mjs --mode local --port 5433 --lookups 5000 --pass 1 --out out
 *
 * The first run's "point lookup" was written wrong: 2,000 keys were joined in
 * ONE query, which the planner is free to execute as a bulk scan instead of
 * 2,000 index lookups. The numbers came out backwards and no claim was built on
 * them. This is the same thing done properly.
 *
 * What changed:
 *   - every key is looked up by its OWN query inside plpgsql, each one timed,
 *     and percentiles are reported rather than a mean;
 *   - the keys are chosen and materialised into a table BEFORE the timed
 *     section, so choosing them is not part of the measurement;
 *   - buffer work is counted, not just time: idx_blks_read against
 *     idx_blks_hit from pg_statio_user_indexes. Without that split the
 *     measurement is of memory, not of the index — a cache hit and a disk read
 *     differ by two orders of magnitude and cannot be averaged together;
 *   - the server is restarted before each strategy, which clears
 *     shared_buffers, and a COLD series is taken first, then a WARM series over
 *     the same keys. The difference between them is the price of a cache miss.
 *
 * The caveat that remains: the OS page cache is not cleared. It is equally warm
 * for all three strategies, but it depresses every absolute number.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const MODE = flag("--mode", "local");
const PORT = flag("--port", "5433");
const CLUSTER = flag("--cluster", "bench");
const CONTAINER = flag("--container", "keybench-pg");
const LOOKUPS = Number(flag("--lookups", "5000"));
const PASS = Number(flag("--pass", "1"));
const OUT = flag("--out", "out");

const STRATEGIES = {
  R: { db: "bench_r", col: "k_r", what: "random uuid, arriving in no order" },
  T: { db: "bench_t", col: "k_t", what: "uuid v7, arriving strictly ascending" },
  B: { db: "bench_b", col: "k_b", what: "TSID bigint, 8 bytes, ascending" },
};
const ORDER = PASS % 2 === 1 ? ["R", "T", "B"] : ["B", "T", "R"];

mkdirSync(OUT, { recursive: true });
const NDJSON = join(OUT, `reads-pass${PASS}.ndjson`);

function psql(db, sql) {
  const tail = ["-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A", "-f", "-"];
  const [cmd, args] = MODE === "docker"
    ? ["docker", ["exec", "-i", CONTAINER, "psql", ...tail]]
    : ["psql", ["-h", "/var/run/postgresql", "-p", PORT, ...tail]];
  return execFileSync(cmd, args, { input: sql, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function restartServer() {
  if (MODE === "docker") execFileSync("docker", ["restart", CONTAINER], { encoding: "utf8" });
  else execFileSync("pg_ctlcluster", ["16", CLUSTER, "restart"], { encoding: "utf8" });
  for (let i = 0; i < 60; i++) {
    try {
      if (MODE === "docker") execFileSync("docker", ["exec", CONTAINER, "pg_isready", "-U", "postgres"], { stdio: "ignore" });
      else execFileSync("pg_isready", ["-h", "/var/run/postgresql", "-p", PORT], { stdio: "ignore" });
      return;
    } catch { await sleep(1000); }
  }
  throw new Error("server did not come back after restart");
}

function installProbe(db, col, type) {
  psql(db, `
    DROP TABLE IF EXISTS probe_keys;
    DROP TABLE IF EXISTS probe_times;
    CREATE TABLE probe_keys (i int PRIMARY KEY, k ${type} NOT NULL);
    CREATE TABLE probe_times (phase text, i int, us double precision, found boolean);
    -- Keys are chosen once and stored: choosing them must not land in the timing.
    INSERT INTO probe_keys (i, k)
    SELECT row_number() OVER (ORDER BY n), ${col}
    FROM src
    WHERE n % 4001 = 17
    LIMIT ${LOOKUPS};

    CREATE OR REPLACE FUNCTION probe(p_phase text) RETURNS void AS $$
    DECLARE r record; t0 timestamptz; t1 timestamptz; hit boolean;
    BEGIN
      FOR r IN SELECT i, k FROM probe_keys ORDER BY i LOOP
        t0 := clock_timestamp();
        PERFORM 1 FROM tgt WHERE id = r.k;
        hit := FOUND;
        t1 := clock_timestamp();
        INSERT INTO probe_times VALUES (p_phase, r.i, extract(epoch from (t1 - t0)) * 1000000, hit);
      END LOOP;
    END $$ LANGUAGE plpgsql;
  `);
}

const stats = (db) => psql(db, `
  SELECT json_build_object(
    'idx_blks_read', COALESCE(sum(idx_blks_read), 0),
    'idx_blks_hit', COALESCE(sum(idx_blks_hit), 0)
  ) FROM pg_statio_user_indexes WHERE relname = 'tgt';`);

const heapStats = (db) => psql(db, `
  SELECT json_build_object(
    'heap_blks_read', COALESCE(heap_blks_read, 0),
    'heap_blks_hit', COALESCE(heap_blks_hit, 0)
  ) FROM pg_statio_user_tables WHERE relname = 'tgt';`);

function summary(db, phase) {
  return JSON.parse(psql(db, `
    SELECT json_build_object(
      'n', count(*), 'found', count(*) FILTER (WHERE found),
      'p50', percentile_cont(0.5) WITHIN GROUP (ORDER BY us),
      'p90', percentile_cont(0.9) WITHIN GROUP (ORDER BY us),
      'p99', percentile_cont(0.99) WITHIN GROUP (ORDER BY us),
      'mean', avg(us), 'max', max(us), 'total_ms', sum(us) / 1000
    ) FROM probe_times WHERE phase = '${phase}';`));
}

for (const key of ORDER) {
  const s = STRATEGIES[key];
  const type = key === "B" ? "bigint" : "uuid";
  console.log(`\n=== strategy ${key}: ${s.what} ===`);
  installProbe(s.db, s.col, type);
  const rows = Number(psql(s.db, "SELECT count(*) FROM probe_keys;"));
  console.log(`  keys ${rows}`);

  // Cold series: the server has just restarted, shared_buffers is empty.
  await restartServer();
  await sleep(1500);
  const io0 = JSON.parse(stats(s.db)), h0 = JSON.parse(heapStats(s.db));
  psql(s.db, "SELECT probe('cold');");
  const io1 = JSON.parse(stats(s.db)), h1 = JSON.parse(heapStats(s.db));
  const cold = summary(s.db, "cold");
  console.log(`  cold: p50 ${cold.p50.toFixed(0)} us, p90 ${cold.p90.toFixed(0)}, p99 ${cold.p99.toFixed(0)}, found ${cold.found}/${cold.n}`);

  // Warm series: the same keys again, over a warmed cache.
  psql(s.db, "SELECT probe('warm');");
  const io2 = JSON.parse(stats(s.db)), h2 = JSON.parse(heapStats(s.db));
  const warm = summary(s.db, "warm");
  console.log(`  warm: p50 ${warm.p50.toFixed(0)} us, p90 ${warm.p90.toFixed(0)}, p99 ${warm.p99.toFixed(0)}`);

  const idxRead = Number(io1.idx_blks_read) - Number(io0.idx_blks_read);
  const idxHit = Number(io1.idx_blks_hit) - Number(io0.idx_blks_hit);
  const heapRead = Number(h1.heap_blks_read) - Number(h0.heap_blks_read);
  console.log(`  cold buffers: index read ${idxRead}, hits ${idxHit}; heap read ${heapRead}`);

  appendFileSync(NDJSON, JSON.stringify({
    pass: PASS, strategy: key, what: s.what, lookups: rows, order: ORDER.join(">"),
    cold, warm,
    buffers: {
      coldIdxRead: idxRead, coldIdxHit: idxHit, coldHeapRead: heapRead,
      warmIdxRead: Number(io2.idx_blks_read) - Number(io1.idx_blks_read),
      warmIdxHit: Number(io2.idx_blks_hit) - Number(io1.idx_blks_hit),
      warmHeapRead: Number(h2.heap_blks_read) - Number(h1.heap_blks_read),
    },
    sizes: JSON.parse(psql(s.db, `SELECT json_build_object('table', pg_relation_size('tgt'), 'index', pg_relation_size('tgt_pkey'), 'rows', (SELECT count(*) FROM tgt));`)),
    pgstatindex: JSON.parse(psql(s.db, `SELECT row_to_json(x) FROM (SELECT * FROM pgstatindex('tgt_pkey')) x;`)),
  }) + "\n");
  console.log(`  written to ${NDJSON}`);
}
console.log("\npass complete");
