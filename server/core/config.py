"""
Research Agent Server — Configuration

All configuration constants, path management, and auth helpers live here.
Imported by server.py and domain modules.
"""

import asyncio
import json
import logging
import os
import sys
from typing import Any, Optional

import httpx

logger = logging.getLogger("research-agent-server")

# =============================================================================
# OpenCode / Model Configuration
# =============================================================================

_SERVER_FILE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def get_default_opencode_config() -> str:
    """Resolve opencode.json path for source and frozen-binary execution."""
    candidates: list[str] = []

    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", "")
        if meipass:
            candidates.append(os.path.join(meipass, "opencode.json"))
        candidates.append(os.path.join(os.path.dirname(sys.executable), "opencode.json"))

    candidates.append(os.path.join(_SERVER_FILE_DIR, "opencode.json"))

    for path in candidates:
        if path and os.path.exists(path):
            return path

    return candidates[-1]


OPENCODE_CONFIG = os.environ.get("OPENCODE_CONFIG", get_default_opencode_config())
OPENCODE_URL = os.environ.get("OPENCODE_URL", "http://127.0.0.1:4096")
OPENCODE_USERNAME = os.environ.get("OPENCODE_SERVER_USERNAME", "opencode")
OPENCODE_PASSWORD = os.environ.get("OPENCODE_SERVER_PASSWORD")

MODEL_PROVIDER = os.environ.get("MODEL_PROVIDER", "opencode")
MODEL_ID = os.environ.get("MODEL_ID", "minimax-m2.5-free")

# Runtime gateway key override from frontend (`X-Research-Agent-Key`).
RUNTIME_RESEARCH_AGENT_KEY = os.environ.get("RESEARCH_AGENT_KEY", "").strip()
RUNTIME_RESEARCH_AGENT_KEY_LAST_APPLIED = ""
RUNTIME_RESEARCH_AGENT_KEY_LOCK = asyncio.Lock()

# User authentication
USER_AUTH_TOKEN = os.environ.get("RESEARCH_AGENT_USER_AUTH_TOKEN")

# =============================================================================
# Paths — set by init_paths()
# =============================================================================

WORKDIR = os.getcwd()
DATA_DIR = ""
CHAT_DATA_FILE = ""
JOBS_DATA_FILE = ""
ALERTS_DATA_FILE = ""
SETTINGS_DATA_FILE = ""
PLANS_DATA_FILE = ""
JOURNEY_STATE_FILE = ""
TMUX_SESSION_NAME = os.environ.get("RESEARCH_AGENT_TMUX_SESSION", "research-agent")
SERVER_CALLBACK_URL = "http://127.0.0.1:10000"
FRONTEND_STATIC_DIR = os.environ.get("RESEARCH_AGENT_FRONTEND_DIR", "").strip()


def init_paths(workdir: str):
    """Initialize all paths based on workdir."""
    global WORKDIR, DATA_DIR, CHAT_DATA_FILE, JOBS_DATA_FILE, ALERTS_DATA_FILE, SETTINGS_DATA_FILE, PLANS_DATA_FILE, JOURNEY_STATE_FILE
    WORKDIR = os.path.abspath(workdir)
    DATA_DIR = os.path.join(WORKDIR, ".agents")
    CHAT_DATA_FILE = os.path.join(DATA_DIR, "chat_data.json")
    JOBS_DATA_FILE = os.path.join(DATA_DIR, "jobs.json")
    ALERTS_DATA_FILE = os.path.join(DATA_DIR, "alerts.json")
    SETTINGS_DATA_FILE = os.path.join(DATA_DIR, "settings.json")
    PLANS_DATA_FILE = os.path.join(DATA_DIR, "plans.json")
    JOURNEY_STATE_FILE = os.path.join(DATA_DIR, "journey_state.json")
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(os.path.join(DATA_DIR, "runs"), exist_ok=True)
    logger.info(f"Initialized with workdir: {WORKDIR}")
    os.chdir(WORKDIR)


def resolve_session_workdir(session: dict) -> str:
    """Resolve working directory for a chat session, falling back to global WORKDIR."""
    session_workdir = (session.get("workdir") or "").strip()
    return session_workdir if session_workdir else WORKDIR


# =============================================================================
# Auth Helpers
# =============================================================================

AUTH_PROTECTED_PREFIXES = (
    "/sessions",
    "/models",
    "/chat",
    "/runs",
    "/alerts",
    "/wild",
    "/sweeps",
    "/cluster",
    "/git",
    "/plans",
    "/integrations",
    "/journey",
)


def requires_api_auth(path: str) -> bool:
    """Only enforce auth token on API routes."""
    for prefix in AUTH_PROTECTED_PREFIXES:
        if path == prefix or path.startswith(prefix + "/"):
            return True
    return False


def get_auth() -> Optional[httpx.BasicAuth]:
    """Get HTTP basic auth if password is configured."""
    return httpx.BasicAuth(OPENCODE_USERNAME, OPENCODE_PASSWORD) if OPENCODE_PASSWORD else None


def set_runtime_research_agent_key(raw_key: Optional[str]) -> None:
    """Store a frontend-provided RESEARCH_AGENT_KEY for this backend process."""
    global RUNTIME_RESEARCH_AGENT_KEY
    normalized = str(raw_key or "").strip()
    if not normalized:
        return
    if normalized == RUNTIME_RESEARCH_AGENT_KEY:
        return
    RUNTIME_RESEARCH_AGENT_KEY = normalized
    os.environ["RESEARCH_AGENT_KEY"] = normalized


async def apply_runtime_research_agent_key(client: Optional[httpx.AsyncClient] = None) -> None:
    """Best-effort sync of runtime RESEARCH_AGENT_KEY into the running OpenCode config."""
    global RUNTIME_RESEARCH_AGENT_KEY_LAST_APPLIED

    key = str(RUNTIME_RESEARCH_AGENT_KEY or "").strip()
    if not key or key == RUNTIME_RESEARCH_AGENT_KEY_LAST_APPLIED:
        return

    async with RUNTIME_RESEARCH_AGENT_KEY_LOCK:
        key = str(RUNTIME_RESEARCH_AGENT_KEY or "").strip()
        if not key or key == RUNTIME_RESEARCH_AGENT_KEY_LAST_APPLIED:
            return

        close_client = False
        active_client = client
        if active_client is None:
            active_client = httpx.AsyncClient(timeout=httpx.Timeout(5.0))
            close_client = True

        try:
            patch_payloads = (
                {"provider": {"opencode": {"options": {"apiKey": key}}}},
                {"providers": {"opencode": {"options": {"apiKey": key}}}},
                {"provider": {"research-agent": {"options": {"apiKey": key}}}},
                {"providers": {"research-agent": {"options": {"apiKey": key}}}},
            )

            applied = False
            for payload in patch_payloads:
                try:
                    response = await active_client.patch(
                        f"{OPENCODE_URL}/config",
                        json=payload,
                        auth=get_auth(),
                    )
                    if response.is_success:
                        applied = True
                        break
                except Exception:
                    continue

            if not applied:
                auth_payloads = (
                    {"apiKey": key},
                    {"key": key},
                    {"token": key},
                )
                for provider_id in ("opencode", "research-agent"):
                    if applied:
                        break
                    for payload in auth_payloads:
                        try:
                            response = await active_client.put(
                                f"{OPENCODE_URL}/auth/{provider_id}",
                                json=payload,
                                auth=get_auth(),
                            )
                            if response.is_success:
                                applied = True
                                break
                        except Exception:
                            continue

            if applied:
                RUNTIME_RESEARCH_AGENT_KEY_LAST_APPLIED = key
                logger.info("Applied runtime RESEARCH_AGENT_KEY to OpenCode config.")
        finally:
            if close_client and active_client is not None:
                await active_client.aclose()


# =============================================================================
# Model Helpers
# =============================================================================

def _parse_optional_int(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        text = value.strip()
        if text.isdigit():
            return int(text)
    return None


def load_available_opencode_models() -> list[dict[str, Any]]:
    """Load model options from opencode.json providers and include current fallback."""
    entries: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    def add_entry(provider_id: str, model_id: str, data: Any = None) -> None:
        provider = str(provider_id or "").strip()
        model = str(model_id or "").strip()
        if not provider or not model:
            return
        key = (provider, model)
        if key in seen:
            return
        seen.add(key)

        model_data = data if isinstance(data, dict) else {}
        limit = model_data.get("limit") if isinstance(model_data.get("limit"), dict) else {}
        context_limit = _parse_optional_int(limit.get("context"))
        output_limit = _parse_optional_int(limit.get("output"))
        display_name = model_data.get("name")
        if not isinstance(display_name, str) or not display_name.strip():
            display_name = model

        entries.append({
            "provider_id": provider,
            "model_id": model,
            "name": display_name.strip(),
            "context_limit": context_limit,
            "output_limit": output_limit,
            "is_default": provider == MODEL_PROVIDER and model == MODEL_ID,
        })

    try:
        with open(OPENCODE_CONFIG, "r", encoding="utf-8") as fh:
            config = json.load(fh)
    except Exception as e:
        logger.warning("Failed to load OpenCode config %s: %s", OPENCODE_CONFIG, e)
        config = {}

    providers: dict[str, Any] = {}
    for key in ("provider", "providers"):
        section = config.get(key) if isinstance(config, dict) else None
        if isinstance(section, dict):
            providers.update(section)

    for provider_id, provider_cfg in providers.items():
        if not isinstance(provider_cfg, dict):
            continue
        models = provider_cfg.get("models")
        if not isinstance(models, dict):
            continue
        for model_id_key, model_cfg in models.items():
            add_entry(str(provider_id), str(model_id_key), model_cfg)

    # Ensure currently configured model is always selectable.
    add_entry(MODEL_PROVIDER, MODEL_ID)

    entries.sort(key=lambda item: (str(item.get("provider_id", "")), str(item.get("model_id", ""))))
    return entries


def get_session_model(session: dict[str, Any]) -> tuple[str, str]:
    """Resolve provider/model from session, falling back to global defaults."""
    provider = str(session.get("model_provider") or MODEL_PROVIDER).strip() or MODEL_PROVIDER
    model = str(session.get("model_id") or MODEL_ID).strip() or MODEL_ID
    return provider, model
