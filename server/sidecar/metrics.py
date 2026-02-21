"""WandB metrics reading and posting for the job sidecar."""

import glob
import json
import logging
import os

import requests

logger = logging.getLogger("job-sidecar")


def read_recent_metrics(metrics_path: str, max_lines: int = 25, max_bytes: int = 24000) -> list[dict]:
    """Read recent metrics.jsonl lines, tolerating partial writes."""
    if not os.path.exists(metrics_path):
        return []

    try:
        size = os.path.getsize(metrics_path)
        start = max(0, size - max_bytes)
        with open(metrics_path, "r") as f:
            f.seek(start)
            chunk = f.read()
    except Exception as e:
        logger.warning("Failed to read metrics file %s: %s", metrics_path, e)
        return []

    lines = [ln for ln in chunk.splitlines() if ln.strip()]
    parsed: list[dict] = []
    for line in lines[-max_lines:]:
        try:
            data = json.loads(line)
            if isinstance(data, dict):
                parsed.append(data)
        except json.JSONDecodeError:
            continue
    return parsed


def find_wandb_dir_in_rundir(run_dir: str, job_id: str) -> str | None:
    """Scan the predictable WANDB_DIR location for a WandB run directory.

    When we set WANDB_DIR={run_dir}/wandb_data before the user command,
    WandB creates:
      Online:  {run_dir}/wandb_data/wandb/run-{timestamp}-{run_id}/files/
      Offline: {run_dir}/wandb_data/wandb/offline-run-{timestamp}-{run_id}/files/
    """
    wandb_base = os.path.join(run_dir, "wandb_data", "wandb")
    if not os.path.isdir(wandb_base):
        return None
    # Look for run dirs matching our job_id (both online and offline)
    for prefix in ("run", "offline-run"):
        pattern = os.path.join(wandb_base, f"{prefix}-*-{job_id}")
        matches = sorted(glob.glob(pattern))
        if matches:
            return matches[-1]  # latest
    # Fallback: any run dir at all (single-run case)
    for prefix in ("run", "offline-run"):
        pattern_any = os.path.join(wandb_base, f"{prefix}-*")
        matches_any = sorted(glob.glob(pattern_any))
        if matches_any:
            return matches_any[-1]
    return None


def _resolve_wandb_metrics_source(wandb_dir: str) -> tuple[str | None, str]:
    """Find the metrics source inside a wandb run directory.

    Returns (path, kind) where kind is "jsonl" or "wandb_binary".
    Prefers JSONL if available; falls back to the binary .wandb protobuf file.
    """
    # 1. Check for JSONL files (online runs, or custom setups)
    jsonl_candidates = [
        os.path.join(wandb_dir, "metrics.jsonl"),
        os.path.join(wandb_dir, "files", "metrics.jsonl"),
        os.path.join(wandb_dir, "wandb-history.jsonl"),
        os.path.join(wandb_dir, "files", "wandb-history.jsonl"),
    ]
    for path in jsonl_candidates:
        if os.path.isfile(path):
            logger.info(f"[metrics] Resolved JSONL metrics file: {path}")
            return path, "jsonl"

    # 2. Check for binary .wandb file (offline runs)
    #    The wandb_dir may point to the run dir or its files/ subdir,
    #    so also search the parent directory.
    search_dirs = [wandb_dir]
    parent = os.path.dirname(wandb_dir)
    if parent and parent != wandb_dir:
        search_dirs.append(parent)
    for d in search_dirs:
        wandb_files = sorted(glob.glob(os.path.join(d, "*.wandb")))
        if wandb_files:
            path = wandb_files[-1]  # latest
            logger.info(f"[metrics] Resolved binary .wandb file: {path}")
            return path, "wandb_binary"

    logger.debug(f"[metrics] No metrics source found in {wandb_dir}")
    return None, ""


def _read_wandb_binary_history(
    wandb_file: str, records_read: int
) -> tuple[list[dict], int]:
    """Read history rows from a binary .wandb protobuf file.

    Uses the wandb SDK DataStore to scan records incrementally.
    ``records_read`` is the total number of records already consumed;
    we skip that many on each call so only new rows are returned.

    Returns (rows, new_records_read).
    """
    try:
        from wandb.proto import wandb_internal_pb2 as wandb_pb
        from wandb.sdk.internal import datastore
    except ImportError:
        logger.warning("[metrics] wandb SDK not importable — cannot read binary .wandb file")
        return [], records_read

    ds = datastore.DataStore()
    try:
        ds.open_for_scan(wandb_file)
    except Exception as e:
        logger.warning(f"[metrics] Failed to open .wandb file for scan: {e}")
        return [], records_read

    total_scanned = 0
    rows: list[dict] = []

    try:
        while True:
            data = ds.scan_data()
            if data is None:
                break
            total_scanned += 1

            # Skip records we've already processed
            if total_scanned <= records_read:
                continue

            rec = wandb_pb.Record()
            try:
                rec.ParseFromString(data)
            except Exception:
                continue

            if rec.WhichOneof("record_type") != "history":
                continue

            row: dict = {}
            for item in rec.history.item:
                # WandB stores metric names in nested_key (e.g. ['train/loss'])
                if item.nested_key:
                    key = "/".join(item.nested_key)
                elif item.key:
                    key = item.key
                else:
                    continue
                try:
                    row[key] = json.loads(item.value_json)
                except (json.JSONDecodeError, ValueError):
                    row[key] = item.value_json
            if row:
                rows.append(row)
    except Exception as e:
        logger.warning(f"[metrics] Error scanning .wandb file: {e}")

    return rows, total_scanned


def post_metrics_delta(
    server_url: str,
    job_id: str,
    wandb_dir: str,
    lines_posted: int,
    auth_token: str | None = None,
) -> int:
    """Read new metrics rows from wandb files and POST them to the server.

    ``lines_posted`` tracks progress: for JSONL files it is the line count;
    for binary .wandb files it is the record count.

    Returns the updated lines_posted count.
    """
    logger.info(f"[metrics] post_metrics_delta called: job_id={job_id}, wandb_dir={wandb_dir}, lines_posted={lines_posted}")

    metrics_path, kind = _resolve_wandb_metrics_source(wandb_dir)
    if not metrics_path:
        logger.info("[metrics] No metrics source found — skipping POST")
        return lines_posted

    rows: list[dict] = []
    new_total: int = lines_posted

    if kind == "jsonl":
        # --- JSONL text file path (online runs / custom setups) ---
        try:
            with open(metrics_path, "r") as f:
                all_lines = f.readlines()
        except OSError as e:
            logger.error(f"[metrics] Failed to read metrics file {metrics_path}: {e}")
            return lines_posted

        new_lines = all_lines[lines_posted:]
        if not new_lines:
            return lines_posted

        parse_errors = 0
        for line in new_lines:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                parse_errors += 1
        new_total = len(all_lines)
        logger.info(f"[metrics] JSONL: {len(rows)} valid rows from {len(new_lines)} new lines ({parse_errors} parse errors)")

    elif kind == "wandb_binary":
        # --- Binary .wandb protobuf path (offline runs) ---
        rows, new_total = _read_wandb_binary_history(metrics_path, lines_posted)
        logger.info(f"[metrics] Binary: {len(rows)} history rows (records_read {lines_posted} → {new_total})")

    if not rows:
        logger.info("[metrics] No new rows — skipping POST")
        return new_total if new_total > lines_posted else lines_posted

    if rows:
        sample_keys = list(rows[0].keys())[:8]
        logger.info(f"[metrics] Sample row keys: {sample_keys}")

    url = f"{server_url}/runs/{job_id}/metrics"
    headers = {"Content-Type": "application/json"}
    if auth_token:
        headers["X-Auth-Token"] = auth_token
    logger.info(f"[metrics] POSTing {len(rows)} rows to {url}")
    try:
        resp = requests.post(url, json={"rows": rows}, headers=headers, timeout=10)
        if resp.status_code == 200:
            logger.info(f"[metrics] ✅ POST succeeded — posted {len(rows)} rows, lines_posted now={new_total}")
            return new_total
        else:
            logger.warning(f"[metrics] ❌ POST failed: status={resp.status_code} body={resp.text[:300]}")
    except Exception as e:
        logger.warning(f"[metrics] ❌ POST exception: {e}")

    return lines_posted
