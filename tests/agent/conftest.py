"""Shared test fixtures for agent framework tests."""

import asyncio
import os
import tempfile

import pytest

# Add server/ to path
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'server'))

from agent.core.agent import Agent, AgentStatus
from agent.core.bus import MessageBus
from agent.core.message import Message, MessageType
from agent.core.runtime import AgentRuntime


@pytest.fixture
def runtime():
    """Create a fresh AgentRuntime for each test."""
    return AgentRuntime()


@pytest.fixture
def bus():
    """Create a fresh MessageBus for each test."""
    return MessageBus()


@pytest.fixture
def tmpdir():
    """Create a temporary directory."""
    return tempfile.mkdtemp()


def mock_render(skill_id, variables):
    """Simple render function for tests."""
    return f"[{skill_id}] Goal: {variables.get('goal', '?')}"
