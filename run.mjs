/**
 * key-order — what a random primary key costs on Postgres.
 *
 *   node run.mjs --rows 3000000 --batch 100000 --pass 1 --out out
 *   node run.mjs --mode local --port 5433 --cluster bench --rows 20000000 --pass 3
 *
 * Definitions and caveats are in CRITERIA.md, written before the first number.
 * Zero model calls.
 *
 * Everything timed is timed by the server: the clock and the WAL position are
 * read inside plpgsql, so neither the container nor psql lands in the number.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ROWS = Number(flag("--rows", "3000000"));
const BATCH = Number(flag("--batch", "100000"));
const PASS = Number(flag("--pass", "1"));
const CONTAINER = flag("--container", "keybench-pg");
// Two run modes. `docker` talks to a container; `local` talks to a separate
// Postgres cluster on the same machine as this script.
const MODE = flag("--mode", "docker");
const PORT = flag("--port", "5433");
const CLUSTER = flag("--cluster", "bench");
const OUT = flag("--out", "out");
const BASE_MS = 1756200000000; // 2026-08-26T09:20:00Z, fixed

const STRATEGIES = {
  R: { db: "bench_r", col: "k_r", type: "uuid", what: "random uuid, arriving in no order" },
  T: { db: "bench_t", col: "k_t", type: "uuid", what: "uuid v7, arriving strictly ascending" },
  B: { db: "bench_b", col: "k_b", type: "bigint", what: "TSID bigint, 8 bytes, ascending" },
};
const ORDER = PASS % 2 === 1 ? ["R", "T", "B"] : ["B", "T", "R"];

mkdirSync(OUT, { recursive: true });
const NDJSON = join(OUT, `measurements-pass${PASS}.ndjson`);

function psql(db, sql, { quiet = true } = {}) {
  const tail = ["-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", ...(quiet ? ["-q", "-t", "-A"] : []), "-f", "-"];
  const [cmd, args] = MODE === "docker"
    ? ["docker", ["exec", "-i", CONTAINER, "psql", ...tail]]
    : ["psql", ["-h", "/var/run/postgresql", "-p", PORT, ...tail]];
  return execFileSync(cmd, args, { input: sql, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
const one = (db, sql) => psql(db, sql).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function restartServer() {
  // Restarting between strategies is what clears shared_buffers; separate
  // databases do not, because the buffer cache is instance-wide.
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

const serverSettings = one("postgres", `select json_agg(json_build_object('name',name,'setting',setting,'unit',unit))
  from pg_settings where name in ('shared_buffers','max_wal_size','checkpoint_timeout','work_mem','maintenance_work_mem','fsync','synchronous_commit','wal_level','full_page_writes','server_version');`);

for (const key of ORDER) {
  const s = STRATEGIES[key];
  console.log(`\n=== strategy ${key}: ${s.what} ===`);

  one("postgres", `DROP DATABASE IF EXISTS ${s.db} WITH (FORCE); CREATE DATABASE ${s.db};`);
  console.log("  building the source table src ...");
  const tSrc = Date.now();
  psql(s.db, `
    CREATE EXTENSION IF NOT EXISTS pgstattuple;
    CREATE UNLOGGED TABLE src (
      n int PRIMARY KEY,
      payload text NOT NULL,
      k_r uuid NOT NULL,
      k_t uuid NOT NULL,
      k_b bigint NOT NULL
    );
    -- Filled a million rows at a time: a single statement over 20M rows killed
    -- the backend on the first attempt and filled the disk with it.
    DO $$
    DECLARE lo bigint;
    BEGIN
      FOR lo IN 0 .. ${ROWS} - 1 BY 1000000 LOOP
        INSERT INTO src
        SELECT n,
               md5(n::text) || md5((n+1)::text) || md5((n+2)::text),
               md5(n::text || 'r')::uuid,
               (lpad(to_hex((${BASE_MS} + n/10)::bigint),12,'0') || '7' || substr(md5(n::text),1,3) || 'a' || substr(md5(n::text || 'x'),1,15))::uuid,
               (((${BASE_MS} + n/10)::bigint) << 22) | (n % 4194304)
        FROM generate_series(lo + 1, LEAST(lo + 1000000, ${ROWS})) n;
      END LOOP;
    END $$;
    ANALYZE src;
  `);
  console.log(`  src ready in ${((Date.now() - tSrc) / 1000).toFixed(1)} s`);

  psql(s.db, `
    CREATE TABLE tgt (id ${s.type} PRIMARY KEY, payload text NOT NULL);
    CREATE TABLE meas (
      batch int, lo int, hi int, ms double precision, wal_bytes bigint,
      table_bytes bigint, index_bytes bigint, at timestamptz DEFAULT now()
    );
    CREATE FUNCTION run_batch(p_batch int, p_lo int, p_hi int) RETURNS void AS $$
    DECLARE t0 timestamptz; t1 timestamptz; l0 pg_lsn; l1 pg_lsn;
    BEGIN
      t0 := clock_timestamp(); l0 := pg_current_wal_lsn();
      INSERT INTO tgt (id, payload) SELECT ${s.col}, payload FROM src WHERE n > p_lo AND n <= p_hi;
      t1 := clock_timestamp(); l1 := pg_current_wal_lsn();
      INSERT INTO meas (batch, lo, hi, ms, wal_bytes, table_bytes, index_bytes)
      VALUES (p_batch, p_lo, p_hi,
              extract(epoch from (t1 - t0)) * 1000,
              (l1 - l0)::bigint,
              pg_relation_size('tgt'),
              pg_relation_size('tgt_pkey'));
    END $$ LANGUAGE plpgsql;
  `);

  // Restart before the first batch: every strategy starts from a cold cache.
  await restartServer();
  await sleep(1500);
  one(s.db, "CHECKPOINT;");

  const nBatches = Math.ceil(ROWS / BATCH);
  const tRun = Date.now();
  for (let b = 1; b <= nBatches; b++) {
    const lo = (b - 1) * BATCH, hi = Math.min(b * BATCH, ROWS);
    one(s.db, `SELECT run_batch(${b}, ${lo}, ${hi});`);
    if (b % 5 === 0 || b === nBatches) {
      const row = one(s.db, `SELECT ms::int || ' ' || wal_bytes || ' ' || index_bytes FROM meas WHERE batch = ${b};`);
      const [ms, wal, idx] = row.split(" ");
      console.log(`  batch ${b}/${nBatches} (rows ${hi}): ${ms} ms, WAL ${(Number(wal) / 1024 / 1024).toFixed(1)} MB, index ${(Number(idx) / 1024 / 1024).toFixed(0)} MB`);
    }
  }
  console.log(`  inserted ${ROWS} rows in ${((Date.now() - tRun) / 1000).toFixed(1)} s`);

  one(s.db, "CHECKPOINT;");
  const stat = one(s.db, `SELECT row_to_json(x) FROM (SELECT * FROM pgstatindex('tgt_pkey')) x;`);
  const sizes = one(s.db, `SELECT json_build_object('table', pg_relation_size('tgt'), 'index', pg_relation_size('tgt_pkey'), 'total', pg_total_relation_size('tgt'), 'rows', (SELECT count(*) FROM tgt));`);

  // Read probe over existing keys, cold server. NOTE: as written this is one
  // join over 2000 keys, which the planner may execute as a bulk scan rather
  // than 2000 index lookups — see RESULTS.md, no claim is built on it.
  await restartServer();
  await sleep(1500);
  const lookup = one(s.db, `
    WITH keys AS (
      SELECT ${s.col} AS k FROM src WHERE n % 977 = 3 LIMIT 2000
    ), t AS (
      SELECT clock_timestamp() AS t0
    ), probe AS (
      SELECT count(*) AS found FROM keys JOIN tgt ON tgt.id = keys.k
    )
    SELECT json_build_object('found', probe.found, 'ms', extract(epoch from (clock_timestamp() - t.t0)) * 1000)
    FROM t, probe;
  `);

  const measurements = one(s.db, `SELECT json_agg(row_to_json(m) ORDER BY batch) FROM meas m;`);
  appendFileSync(NDJSON, JSON.stringify({
    pass: PASS, strategy: key, what: s.what, col: s.col, type: s.type,
    rows: ROWS, batch: BATCH, baseMs: BASE_MS,
    order: ORDER.join(">"),
    sizes: JSON.parse(sizes), pgstatindex: JSON.parse(stat), lookup: JSON.parse(lookup),
    settings: JSON.parse(serverSettings),
    measurements: JSON.parse(measurements),
  }) + "\n");
  console.log(`  written to ${NDJSON}`);
}
console.log("\npass complete");
