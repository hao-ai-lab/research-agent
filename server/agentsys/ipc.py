"""IPC message types and class path utilities for multiprocess agents."""

from __future__ import annotations

import importlib
from dataclasses import dataclass, field
from enum import Enum


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class CmdType(str, Enum):
    """Commands sent from supervisor -> worker."""
    STOP = "stop"
    PAUSE = "pause"
    RESUME = "resume"
    STEER = "steer"
    SPAWN_RESPONSE = "spawn_response"


class EventType(str, Enum):
    """Events sent from worker -> supervisor."""
    STARTED = "started"
    DONE = "done"
    FAILED = "failed"
    SPAWN_REQUEST = "spawn_request"
    STOP_REQUEST = "stop_request"
    ITERATION = "iteration"       # agent completed an iteration
    LOG_ENTRY = "log_entry"       # agent wrote a log/status entry


# ---------------------------------------------------------------------------
# Picklable message dataclasses
# ---------------------------------------------------------------------------

@dataclass
class Command:
    """Message from supervisor to worker process."""
    type: CmdType
    payload: dict = field(default_factory=dict)


@dataclass
class Event:
    """Message from worker process to supervisor."""
    type: EventType
    agent_id: str
    payload: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Class path utilities
# ---------------------------------------------------------------------------

def cls_to_path(cls: type) -> str:
    """Convert a class to a fully-qualified import path string."""
    return f"{cls.__module__}.{cls.__qualname__}"


def path_to_cls(path: str) -> type:
    """Import and return a class from a fully-qualified path string."""
    module_path, _, class_name = path.rpartition(".")
    module = importlib.import_module(module_path)
    return getattr(module, class_name)
