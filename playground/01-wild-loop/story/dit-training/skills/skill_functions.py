"""Python function skills for toy run execution."""

from __future__ import annotations

from typing import Any, Dict


def run_variant(**kwargs: Any) -> Dict[str, Any]:
    payload: Dict[str, Any] = dict(kwargs)
    payload.setdefault("status", "success")
    alert_severity = payload.pop("alert_severity", None)
    alert_message = payload.pop("alert_message", None)
    if alert_severity:
        payload["alert"] = {
            "severity": str(alert_severity),
            "message": str(alert_message or "Function skill raised an alert."),
            "choices": ["continue_training", "raise_to_human"],
        }
    return payload
