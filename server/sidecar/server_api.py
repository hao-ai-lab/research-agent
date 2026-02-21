"""Server callback helpers for the job sidecar."""

import logging
import os
import time

import requests

logger = logging.getLogger("job-sidecar")


def _auth_headers(auth_token: str | None) -> dict:
    if not auth_token:
        return {}
    return {"X-Auth-Token": auth_token}


def report_status(
    server_url: str,
    job_id: str,
    status: str,
    extra_data: dict = None,
    auth_token: str | None = None,
):
    """Report status update to server."""
    data = {"status": status}
    if extra_data:
        data.update(extra_data)

    try:
        logger.info(f"Reporting status: {status} with data: {extra_data}")
        requests.post(
            f"{server_url}/runs/{job_id}/status",
            json=data,
            headers=_auth_headers(auth_token),
            timeout=10,
        )
    except Exception as e:
        logger.warning(f"Failed to report status: {e}")


def trigger_alert(
    server_url: str,
    job_id: str,
    message: str,
    choices: list[str],
    severity: str = "warning",
    auth_token: str | None = None,
) -> str | None:
    """Create alert via server and return alert_id."""
    payload = {
        "message": message,
        "choices": choices,
        "severity": severity,
    }
    try:
        logger.info("Triggering alert: %s", message)
        res = requests.post(
            f"{server_url}/runs/{job_id}/alerts",
            json=payload,
            headers=_auth_headers(auth_token),
            timeout=5,
        )
        if res.status_code == 200:
            data = res.json()
            return data.get("alert_id")
        logger.warning("Alert creation failed (%s): %s", res.status_code, res.text)
    except Exception as e:
        logger.warning("Alert creation error: %s", e)
    return None


def wait_for_response(run_dir: str, alert_id: str, timeout_seconds: int = 600) -> str | None:
    """Wait for alert response file from server."""
    response_file = os.path.join(run_dir, "alerts", f"{alert_id}.response")
    deadline = time.time() + timeout_seconds
    logger.info("Waiting for response file: %s", response_file)

    while time.time() < deadline:
        if os.path.exists(response_file):
            try:
                with open(response_file, "r") as f:
                    return f.read().strip()
            except Exception:
                pass
        time.sleep(2)

    logger.info("Timed out waiting for alert response (%s)", alert_id)
    return None


def should_stop_from_choice(choice: str | None) -> bool:
    if not choice:
        return False
    lowered = choice.lower()
    return "stop" in lowered or "kill" in lowered or "terminate" in lowered
