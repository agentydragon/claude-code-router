# Local log analytics on macOS with DuckDB + Parquet

This guide shows how to take rotated compressed JSONL logs, compact them to Parquet incrementally, and run fast local SQL queries — all offline and free.

## Overview
- Store raw logs as compressed JSONL (.zst preferred, .gz fine)
- Partition logs by day/hour on disk (dt=YYYY-MM-DD/hour=HH)
- Hourly (or nightly) compact just the latest partitions to Parquet
- Query either raw JSONL on-demand or Parquet for speed/cost

DuckDB is a single-binary, in-process OLAP SQL engine. It reads/writes Parquet natively and can read compressed JSONL directly. No server required.

## Prerequisites (macOS)
- Install DuckDB CLI: `brew install duckdb`
- Optional (handy utils): `brew install coreutils` (you can use BSD `date` and `jot` already on macOS)

## On-disk layout and compression
- Recommended raw layout (created by your rotator):
  - `/var/log/ccr/jsonl/dt=YYYY-MM-DD/hour=HH/part-XXXXXXXX.jsonl.zst`
- Tips
  - Include a timestamp field `ts` per record (ISO8601 or epoch millis)
  - Compress with zstd level 3–6 (fast, small). Use gzip if a tool needs it
  - Aim for 64–256MB compressed part sizes to avoid small-file overhead
  - Keep raw JSONL as the source of truth; Parquet is the optimized copy

## One-shot compaction for a single hour
Replace only one partition atomically. Variables D (YYYY-MM-DD) and H (HH 00–23):

```bash
D=2025-08-09
H=14
RAW_DIR=/var/log/ccr/jsonl
OUT_DIR=/var/data/ccr/parquet
TMP_DIR=/var/data/ccr/parquet_tmp

duckdb -c "PRAGMA threads=8;\nCOPY (\n  SELECT *, date(CAST(ts AS TIMESTAMP)) AS dt, strftime(CAST(ts AS TIMESTAMP),'%H') AS hour\n  FROM read_json_auto('${RAW_DIR}/dt=${D}/hour=${H}/*.jsonl.{zst,gz}', filename=true)\n)\nTO '${TMP_DIR}' (FORMAT PARQUET, COMPRESSION ZSTD, PARTITION_BY (dt, hour));"

rm -rf "${OUT_DIR}/dt=${D}/hour=${H}"
mkdir -p "${OUT_DIR}/dt=${D}"
mv "${TMP_DIR}/dt=${D}/hour=${H}" "${OUT_DIR}/dt=${D}/"
```

- Why this is incremental: you target a single `dt/hour` and replace only that directory.
- If no files match for that hour, DuckDB will emit nothing; the mv will fail — guard as needed.

## Rolling compaction for last N hours (handles late arrivals)
Rerun the most recent hours so late files get included. Example for last 3 hours, UTC:

```bash
N=3
RAW_DIR=/var/log/ccr/jsonl
OUT_DIR=/var/data/ccr/parquet
TMP_DIR=/var/data/ccr/parquet_tmp

for i in $(jot ${N} 0); do
  D=$(date -u -v-"${i}"H +%F)
  H=$(date -u -v-"${i}"H +%H)

  duckdb -c "PRAGMA threads=8;\nCOPY (\n    SELECT *, date(CAST(ts AS TIMESTAMP)) AS dt, strftime(CAST(ts AS TIMESTAMP),'%H') AS hour\n    FROM read_json_auto('${RAW_DIR}/dt=${D}/hour=${H}/*.jsonl.{zst,gz}', filename=true)\n  ) TO '${TMP_DIR}' (FORMAT PARQUET, COMPRESSION ZSTD, PARTITION_BY (dt, hour));"

  if [ -d "${TMP_DIR}/dt=${D}/hour=${H}" ]; then
    rm -rf "${OUT_DIR}/dt=${D}/hour=${H}"
    mkdir -p "${OUT_DIR}/dt=${D}"
    mv "${TMP_DIR}/dt=${D}/hour=${H}" "${OUT_DIR}/dt=${D}/"
  fi

done
```

Notes
- This is not a full reindex; it only rewrites the targeted hours
- Adjust N (e.g., 6–24) based on how late your logs can arrive
- Use local time by removing `-u` or customize to your TZ

## Scheduling
- Cron (simplest): run the rolling script hourly
- launchd (macOS-native): create a plist to run the script hourly or at :05

Minimal launchd example (replace paths/user). Save as `~/Library/LaunchAgents/com.ccr.compact.plist` and load with `launchctl load`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.ccr.compact</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>/usr/local/bin/compact_ccr_logs.sh</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
      <key>Minute</key><integer>5</integer>
    </dict>
    <key>StandardOutPath</key><string>/tmp/compact_ccr_logs.out</string>
    <key>StandardErrorPath</key><string>/tmp/compact_ccr_logs.err</string>
    <key>RunAtLoad</key><true/>
  </dict>
</plist>
```

## Querying data

Query raw JSONL on demand (no ETL):
```bash
duckdb -c "SELECT\n  date_trunc('hour', CAST(ts AS TIMESTAMP)) AS hour,\n  level,\n  count(*) AS c\nFROM read_json_auto('/var/log/ccr/jsonl/dt=*/hour=*/*.jsonl.{zst,gz}')\nGROUP BY 1,2\nORDER BY 1,2"
```

Query Parquet (fast, columnar). `hive_partitioning=true` projects dt/hour from directory names:
```bash
duckdb -c "SELECT dt, hour, level, count(*) AS c\nFROM read_parquet('/var/data/ccr/parquet/dt=*/hour=*/*.parquet', hive_partitioning=true)\nGROUP BY 1,2,3\nORDER BY 1,2,3"
```

Ad-hoc filters/examples:
```bash
# Errors in the last 2 hours from a specific service
SINCE=$(date -u -v-2H -Iseconds)

duckdb -c "SELECT ts, service, message\nFROM read_parquet('/var/data/ccr/parquet/dt=*/hour=*/*.parquet', hive_partitioning=true)\nWHERE service = 'router' AND CAST(ts AS TIMESTAMP) >= TIMESTAMP '${SINCE}'\nORDER BY ts DESC\nLIMIT 200"
```

## Performance and reliability tips
- Use `PRAGMA threads=8` and, for heavy jobs, `PRAGMA memory_limit='8GB'` (adjust to your RAM)
- Keep JSON schema stable; `read_json_auto` infers types but you can provide a schema if needed
- Avoid tiny files; fewer, larger Parquet files scan faster and compress better
- For late-arriving data, prefer “replace whole partition” over “append” to avoid duplicates
- Consider a small “quarantine” window (e.g., rerun last 6 hours) to catch stragglers
- Encrypt sensitive logs at rest if stored outside your home dir

## Optional: simple log search UI (local)
- Grafana Loki single-node with filesystem storage + Promtail tailing your JSONL files gives a nice tail/search/dashboards experience locally. Keep DuckDB/Parquet for SQL analytics.

## Summary
- Rotate compressed JSONL locally, partitioned by day/hour
- Compact incrementally to Parquet by replacing only recent partitions
- Query either raw JSONL or Parquet via DuckDB — no servers, no cost
