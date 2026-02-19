"""Tests for server/config.py — configuration extraction."""

import os
import sys

# Ensure server/ is on the path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

from config import (
    _parse_optional_int,
    requires_api_auth,
    get_session_model,
    get_default_opencode_config,
    _SERVER_FILE_DIR,
)


# ---------------------------------------------------------------------------
# _parse_optional_int
# ---------------------------------------------------------------------------

class TestParseOptionalInt:
    def test_int(self):
        assert _parse_optional_int(42) == 42

    def test_float(self):
        assert _parse_optional_int(3.14) == 3

    def test_str_digit(self):
        assert _parse_optional_int("100") == 100

    def test_str_non_digit(self):
        assert _parse_optional_int("abc") is None

    def test_bool(self):
        assert _parse_optional_int(True) is None
        assert _parse_optional_int(False) is None

    def test_none(self):
        assert _parse_optional_int(None) is None


# ---------------------------------------------------------------------------
# requires_api_auth
# ---------------------------------------------------------------------------

class TestRequiresApiAuth:
    def test_sessions_path(self):
        assert requires_api_auth("/sessions") is True

    def test_sessions_subpath(self):
        assert requires_api_auth("/sessions/123") is True

    def test_runs(self):
        assert requires_api_auth("/runs") is True

    def test_health_not_protected(self):
        assert requires_api_auth("/health") is False

    def test_root_not_protected(self):
        assert requires_api_auth("/") is False

    def test_partial_match_not_protected(self):
        # "/sessionsX" should NOT match "/sessions"
        assert requires_api_auth("/sessionsX") is False


# ---------------------------------------------------------------------------
# get_session_model
# ---------------------------------------------------------------------------

class TestGetSessionModel:
    def test_with_session_values(self):
        session = {"model_provider": "custom", "model_id": "gpt-4"}
        provider, model = get_session_model(session)
        assert provider == "custom"
        assert model == "gpt-4"

    def test_fallback_to_defaults(self):
        session = {}
        provider, model = get_session_model(session)
        # Should fall back to MODULE_PROVIDER / MODEL_ID defaults
        assert provider != ""
        assert model != ""

    def test_none_values_fallback(self):
        session = {"model_provider": None, "model_id": None}
        provider, model = get_session_model(session)
        assert provider != ""
        assert model != ""


# ---------------------------------------------------------------------------
# get_default_opencode_config
# ---------------------------------------------------------------------------

class TestGetDefaultOpenCodeConfig:
    def test_returns_string(self):
        result = get_default_opencode_config()
        assert isinstance(result, str)

    def test_ends_with_opencode_json(self):
        result = get_default_opencode_config()
        assert result.endswith("opencode.json")

    def test_server_file_dir_consistent(self):
        """_SERVER_FILE_DIR should point to the server/ directory."""
        assert os.path.basename(_SERVER_FILE_DIR) == "server"
