"""Core agent framework — re-exports from agentsys.

The canonical implementations now live in ``server/agentsys/``.
This module re-exports key types so existing ``from agent.core import …``
imports continue to work.

Kept here:
  - agent.core.event_relay  (EventRelay, used by server.py)
  - Backward-compat aliases (AgentRuntime = Runtime, ForkHandle = ChildHandle)
"""

# -- New canonical imports from agentsys ------------------------------------
from agentsys.types import AgentStatus, EntryType, SteerUrgency, Entry, Steer, Scope, AgentInfo
from agentsys.agent import Agent, ChildHandle
from agentsys.runtime import Runtime
from agentsys.filestore import FileStore
from agentsys.memory import MemoryView

# -- EventRelay (replaces MessageBus) ---------------------------------------
from agent.core.event_relay import EventRelay

# -- Backward-compat aliases ------------------------------------------------
# Old code that does ``from agent.core import AgentRuntime`` still works.
AgentRuntime = Runtime
ForkHandle = ChildHandle

__all__ = [
    # agentsys types
    "AgentStatus", "EntryType", "SteerUrgency", "Entry", "Steer", "Scope", "AgentInfo",
    "Agent", "ChildHandle", "ForkHandle",
    "Runtime", "AgentRuntime",
    "FileStore", "MemoryView",
    # EventRelay
    "EventRelay",
]
