"""WandB / metrics parsing helpers extracted from server.py."""

import glob
import json
import math
import os
import logging
from typing import Dict, Optional

logger = logging.getLogger("research-agent-server")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

LOSS_KEYS = ("loss", "train/loss", "train_loss", "training_loss")
VAL_LOSS_KEYS = ("val/loss", "val_loss", "validation/loss", "eval/loss", "valid/loss")
ACCURACY_KEYS = ("accuracy", "val/accuracy", "eval/accuracy", "train/accuracy", "acc")
EPOCH_KEYS = ("epoch", "train/epoch")
STEP_KEYS = ("step", "_step", "global_step", "trainer/global_step")
MAX_HISTORY_POINTS = 400
MAX_METRIC_SERIES_KEYS = 200
IGNORED_METRIC_KEYS = set(STEP_KEYS) | {
    "_runtime",
    "_timestamp",
    "_wall_time",
    "_timestamp_step",
}

_wandb_metrics_cache: Dict[str, dict] = {}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _to_float(value: object) -> Optional[float]:
    """Convert primitive numeric values to float."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        converted = float(value)
        return converted if math.isfinite(converted) else None
    if isinstance(value, str):
        try:
            converted = float(value.strip())
            return converted if math.isfinite(converted) else None
        except ValueError:
            return None
    return None


def _first_numeric(row: dict, keys: tuple[str, ...]) -> Optional[float]:
    for key in keys:
        if key in row:
            value = _to_float(row.get(key))
            if value is not None:
                return value
    return None


def _extract_step(row: dict, fallback_step: int) -> int:
    step = _first_numeric(row, STEP_KEYS)
    if step is None:
        return fallback_step
    if step < 0:
        return fallback_step
    return int(step)


def _is_metric_key(key: object) -> bool:
    if not isinstance(key, str) or not key:
        return False
    if key in IGNORED_METRIC_KEYS:
        return False
    if key.startswith("_"):
        return False
    return True


def _find_wandb_dir_from_run_dir(run_dir: Optional[str]) -> Optional[str]:
    """Scan the predictable wandb_data/ path inside run_dir for a WandB run directory."""
    if not run_dir:
        return None
    wandb_base = os.path.join(run_dir, "wandb_data", "wandb")
    if not os.path.isdir(wandb_base):
        return None
    matches = sorted(glob.glob(os.path.join(wandb_base, "run-*")))
    return matches[-1] if matches else None


def _resolve_metrics_file(wandb_dir: Optional[str], workdir: str) -> Optional[str]:
    """Resolve likely metrics file paths from a wandb run directory."""
    if not wandb_dir:
        return None

    base_path = wandb_dir
    if not os.path.isabs(base_path):
        base_path = os.path.join(workdir, base_path)

    if os.path.isfile(base_path):
        return base_path if base_path.endswith(".jsonl") else None
    if not os.path.isdir(base_path):
        return None

    candidates = [
        os.path.join(base_path, "metrics.jsonl"),
        os.path.join(base_path, "files", "metrics.jsonl"),
        os.path.join(base_path, "wandb-history.jsonl"),
        os.path.join(base_path, "files", "wandb-history.jsonl"),
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path
    return None


def _downsample_history(history: list[dict], max_points: int = MAX_HISTORY_POINTS) -> list[dict]:
    if len(history) <= max_points:
        return history
    stride = max(1, math.ceil(len(history) / max_points))
    sampled = history[::stride]
    if sampled[-1] != history[-1]:
        sampled.append(history[-1])
    return sampled[:max_points]


def _parse_metrics_history(metrics_file: str) -> dict:
    """Parse a metrics JSONL file into chart-ready history and summary metrics."""
    loss_history: list[dict] = []
    metric_series: Dict[str, list[dict]] = {}
    latest_loss: Optional[float] = None
    latest_accuracy: Optional[float] = None
    latest_epoch: Optional[float] = None
    fallback_step = 0

    try:
        with open(metrics_file, "r", errors="replace") as f:
            for line in f:
                raw = line.strip()
                if not raw:
                    continue
                try:
                    row = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(row, dict):
                    continue

                fallback_step += 1
                step = _extract_step(row, fallback_step)
                train_loss = _first_numeric(row, LOSS_KEYS)
                val_loss = _first_numeric(row, VAL_LOSS_KEYS)
                accuracy = _first_numeric(row, ACCURACY_KEYS)
                epoch = _first_numeric(row, EPOCH_KEYS)

                if train_loss is not None:
                    point = {"step": step, "trainLoss": round(train_loss, 6)}
                    if val_loss is not None:
                        point["valLoss"] = round(val_loss, 6)
                    loss_history.append(point)
                    latest_loss = train_loss

                if accuracy is not None:
                    latest_accuracy = accuracy

                if epoch is not None:
                    latest_epoch = epoch

                for key, raw_value in row.items():
                    if not _is_metric_key(key):
                        continue
                    numeric_value = _to_float(raw_value)
                    if numeric_value is None:
                        continue
                    metric_series.setdefault(key, []).append(
                        {"step": step, "value": round(numeric_value, 6)}
                    )
    except OSError as e:
        logger.debug(f"Unable to read metrics file {metrics_file}: {e}")
        return {}

    if latest_accuracy is not None and latest_accuracy <= 1.5:
        latest_accuracy *= 100.0

    if latest_epoch is None and loss_history:
        latest_epoch = float(loss_history[-1]["step"])

    parsed: dict = {}
    if loss_history:
        parsed["lossHistory"] = _downsample_history(loss_history)

    if metric_series:
        ranked_metric_keys = sorted(
            metric_series.keys(),
            key=lambda key: (-len(metric_series[key]), key),
        )[:MAX_METRIC_SERIES_KEYS]
        parsed["metricSeries"] = {
            key: _downsample_history(metric_series[key])
            for key in ranked_metric_keys
        }
        parsed["metricKeys"] = ranked_metric_keys

    parsed["metrics"] = {
        "loss": latest_loss,
        "accuracy": latest_accuracy,
        "epoch": latest_epoch,
    }
    return parsed


def _get_wandb_curve_data(wandb_dir: Optional[str], workdir: str) -> Optional[dict]:
    metrics_file = _resolve_metrics_file(wandb_dir, workdir)
    if not metrics_file:
        return None

    try:
        stat = os.stat(metrics_file)
    except OSError:
        return None

    cached = _wandb_metrics_cache.get(metrics_file)
    if (
        cached
        and cached.get("size") == stat.st_size
        and cached.get("mtime") == stat.st_mtime
    ):
        return cached.get("payload")

    payload = _parse_metrics_history(metrics_file)
    _wandb_metrics_cache[metrics_file] = {
        "size": stat.st_size,
        "mtime": stat.st_mtime,
        "payload": payload,
    }
    return payload


def _load_run_metrics(run_dir: Optional[str]) -> dict:
    """Load stored metrics from agent_metrics.jsonl in the run directory."""
    if not run_dir:
        return {}
    metrics_file = os.path.join(run_dir, "agent_metrics.jsonl")
    if not os.path.isfile(metrics_file):
        return {}
    return _parse_metrics_history(metrics_file)


def _run_response_payload(run_id: str, run: dict, workdir: str) -> dict:
    """Build run response payload enriched with metrics."""
    payload = {"id": run_id, **run}

    parsed = _load_run_metrics(run.get("run_dir"))

    if not parsed or not parsed.get("metricSeries"):
        wandb_dir = run.get("wandb_dir")
        if not wandb_dir:
            wandb_dir = _find_wandb_dir_from_run_dir(run.get("run_dir"))
            if wandb_dir:
                run["wandb_dir"] = wandb_dir
                payload["wandb_dir"] = wandb_dir
        wandb_parsed = _get_wandb_curve_data(wandb_dir, workdir)
        if wandb_parsed:
            parsed = wandb_parsed

    if not parsed:
        return payload

    parsed_metric_series = parsed.get("metricSeries")
    if parsed_metric_series:
        payload["metricSeries"] = parsed_metric_series
        payload["metricKeys"] = parsed.get("metricKeys", list(parsed_metric_series.keys()))

    parsed_history = parsed.get("lossHistory")
    if parsed_history:
        payload["lossHistory"] = parsed_history

    parsed_metrics = parsed.get("metrics") if isinstance(parsed.get("metrics"), dict) else {}
    existing_metrics = payload.get("metrics") if isinstance(payload.get("metrics"), dict) else {}
    merged_metrics = {
        "loss": parsed_metrics.get("loss", existing_metrics.get("loss")),
        "accuracy": parsed_metrics.get("accuracy", existing_metrics.get("accuracy")),
        "epoch": parsed_metrics.get("epoch", existing_metrics.get("epoch")),
    }
    if any(isinstance(merged_metrics.get(key), (int, float)) for key in ("loss", "accuracy", "epoch")):
        payload["metrics"] = {
            k: float(v) for k, v in merged_metrics.items() if isinstance(v, (int, float))
        }

    return payload
