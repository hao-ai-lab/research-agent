"""Tests for per-chat session working directory support."""

import os
import sys

# Ensure server/ is on the path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

from core.config import resolve_session_workdir, WORKDIR
from core.models import CreateSessionRequest, SessionWorkdirUpdate


# ---------------------------------------------------------------------------
# resolve_session_workdir
# ---------------------------------------------------------------------------

class TestResolveSessionWorkdir:
    def test_with_session_workdir(self):
        session = {"workdir": "/custom/path"}
        assert resolve_session_workdir(session) == "/custom/path"

    def test_without_session_workdir(self):
        session = {}
        result = resolve_session_workdir(session)
        assert result == WORKDIR

    def test_none_workdir_fallback(self):
        session = {"workdir": None}
        result = resolve_session_workdir(session)
        assert result == WORKDIR

    def test_empty_string_fallback(self):
        session = {"workdir": ""}
        result = resolve_session_workdir(session)
        assert result == WORKDIR

    def test_whitespace_only_fallback(self):
        session = {"workdir": "   "}
        result = resolve_session_workdir(session)
        assert result == WORKDIR

    def test_strips_whitespace(self):
        session = {"workdir": "  /trimmed/path  "}
        assert resolve_session_workdir(session) == "/trimmed/path"

    def test_empty_dict_returns_global(self):
        result = resolve_session_workdir({})
        assert result == WORKDIR


# ---------------------------------------------------------------------------
# Model validation
# ---------------------------------------------------------------------------

class TestCreateSessionRequestWorkdir:
    def test_workdir_optional_absent(self):
        req = CreateSessionRequest()
        assert req.workdir is None

    def test_workdir_provided(self):
        req = CreateSessionRequest(workdir="/my/project")
        assert req.workdir == "/my/project"

    def test_workdir_empty_string(self):
        req = CreateSessionRequest(workdir="")
        assert req.workdir == ""


class TestSessionWorkdirUpdate:
    def test_requires_workdir(self):
        req = SessionWorkdirUpdate(workdir="/some/path")
        assert req.workdir == "/some/path"
