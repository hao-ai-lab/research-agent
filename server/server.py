#!/usr/bin/env python3
"""
Research Agent Server

Provides:
- Multi-session chat management with OpenCode integration
- Tmux-based job scheduling and monitoring
- Real-time log streaming

Run with: python server.py --workdir /path/to/project
"""

import argparse
import glob
from dataclasses import dataclass
import json
import math
import os
import re
import shlex
import sys
import time
import uuid
import logging
import asyncio
import shutil
import socket
import subprocess
from typing import Any, Callable, Dict, Optional, AsyncIterator, List

from wild_loop import (
    WildModeRequest, WildLoopConfigRequest, WildEvent, EnqueueEventRequest,
    BuildPromptRequest, BuildPromptResponse,
    WildEventQueue, wild_event_queue,
    wild_loop_state,
    get_wild_mode_state, set_wild_mode_state,
    get_loop_status, update_loop_status, configure_loop,
    enqueue_event, dequeue_event, get_queue_state, resolve_event, get_all_events,
    auto_enqueue_alert, auto_enqueue_run_terminal, record_created_entity,
    build_experiment_context, build_wild_prompt, build_prompt_for_frontend,
    get_serializable_state as get_wild_serializable_state,
    load_from_saved as load_wild_from_saved,
    # Backend-driven engine (v5)
    WildStartRequest, WildResponseCompleteRequest, WildSteerRequest, WildNextPrompt,
    engine as wild_engine,
)
import wild_loop as wild_loop_mod
from wild_loop_v2 import WildV2Engine
from memory_store import MemoryStore

import httpx
import uvicorn
import libtmux
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Configure logging — explicit handlers so uvicorn.run() can't override them
_log_formatter = logging.Formatter("%(asctime)s [%(name)s] %(levelname)s: %(message)s", datefmt="%H:%M:%S")
_log_handler = logging.StreamHandler()
_log_handler.setFormatter(_log_formatter)

# App logger
logger = logging.getLogger("research-agent-server")
logger.setLevel(logging.DEBUG)
logger.addHandler(_log_handler)
logger.propagate = False  # Don't depend on root logger (uvicorn resets it)

# Wild loop logger
_wild_logger = logging.getLogger("wild_loop")
_wild_logger.setLevel(logging.DEBUG)
_wild_logger.addHandler(_log_handler)
_wild_logger.propagate = False

# =============================================================================
# Configuration
# =============================================================================

# OpenCode configuration
_SERVER_FILE_DIR = os.path.dirname(os.path.abspath(__file__))


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

# Model configuration - uses research-agent provider from opencode.json
# This connects to the Anthropic gateway at Modal
# MODEL_PROVIDER = os.environ.get("MODEL_PROVIDER", "research-agent")
# MODEL_ID = os.environ.get("MODEL_ID", "claude-3-5-haiku-latest")
# MODEL_PROVIDER = os.environ.get("MODEL_PROVIDER", "research-agent")
# MODEL_ID = os.environ.get("MODEL_ID", "claude-sonnet-4-20250514")
MODEL_PROVIDER = os.environ.get("MODEL_PROVIDER", "opencode")
MODEL_ID = os.environ.get("MODEL_ID", "kimi-k2.5-free")

# User authentication token - if set, all API requests must include X-Auth-Token header
USER_AUTH_TOKEN = os.environ.get("RESEARCH_AGENT_USER_AUTH_TOKEN")

# Will be set by CLI args
WORKDIR = os.getcwd()
DATA_DIR = ""
CHAT_DATA_FILE = ""
JOBS_DATA_FILE = ""
ALERTS_DATA_FILE = ""
SETTINGS_DATA_FILE = ""
PLANS_DATA_FILE = ""
TMUX_SESSION_NAME = os.environ.get("RESEARCH_AGENT_TMUX_SESSION", "research-agent")
SERVER_CALLBACK_URL = "http://127.0.0.1:10000"
FRONTEND_STATIC_DIR = os.environ.get("RESEARCH_AGENT_FRONTEND_DIR", "").strip()

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
)


def requires_api_auth(path: str) -> bool:
    """Only enforce auth token on API routes."""
    for prefix in AUTH_PROTECTED_PREFIXES:
        if path == prefix or path.startswith(prefix + "/"):
            return True
    return False


def init_paths(workdir: str):
    """Initialize all paths based on workdir."""
    global WORKDIR, DATA_DIR, CHAT_DATA_FILE, JOBS_DATA_FILE, ALERTS_DATA_FILE, SETTINGS_DATA_FILE, PLANS_DATA_FILE
    WORKDIR = os.path.abspath(workdir)
    DATA_DIR = os.path.join(WORKDIR, ".agents")
    CHAT_DATA_FILE = os.path.join(DATA_DIR, "chat_data.json")
    JOBS_DATA_FILE = os.path.join(DATA_DIR, "jobs.json")
    ALERTS_DATA_FILE = os.path.join(DATA_DIR, "alerts.json")
    SETTINGS_DATA_FILE = os.path.join(DATA_DIR, "settings.json")
    PLANS_DATA_FILE = os.path.join(DATA_DIR, "plans.json")
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(os.path.join(DATA_DIR, "runs"), exist_ok=True)
    logger.info(f"Initialized with workdir: {WORKDIR}")
    # Change the current working directory to the workdir
    os.chdir(WORKDIR)


def get_auth() -> Optional[httpx.BasicAuth]:
    """Get HTTP basic auth if password is configured."""
    return httpx.BasicAuth(OPENCODE_USERNAME, OPENCODE_PASSWORD) if OPENCODE_PASSWORD else None


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
        for model_id, model_cfg in models.items():
            add_entry(str(provider_id), str(model_id), model_cfg)

    # Ensure currently configured model is always selectable.
    add_entry(MODEL_PROVIDER, MODEL_ID)

    entries.sort(key=lambda item: (str(item.get("provider_id", "")), str(item.get("model_id", ""))))
    return entries


def get_session_model(session: dict[str, Any]) -> tuple[str, str]:
    """Resolve provider/model from session, falling back to global defaults."""
    provider = str(session.get("model_provider") or MODEL_PROVIDER).strip() or MODEL_PROVIDER
    model = str(session.get("model_id") or MODEL_ID).strip() or MODEL_ID
    return provider, model


# =============================================================================
# FastAPI App
# =============================================================================

app = FastAPI(title="Research Agent Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """Validate X-Auth-Token header if USER_AUTH_TOKEN is configured."""
    # Skip auth for CORS preflight
    if request.method == "OPTIONS":
        return await call_next(request)
    
    # If no auth token configured, allow all requests
    if not USER_AUTH_TOKEN:
        return await call_next(request)

    # Static frontend routes should be public
    if not requires_api_auth(request.url.path):
        return await call_next(request)
    
    # Validate token
    provided_token = request.headers.get("X-Auth-Token")
    if provided_token != USER_AUTH_TOKEN:
        logger.warning(f"Unauthorized request to {request.url.path}")
        return JSONResponse(
            status_code=401,
            content={"detail": "Unauthorized - invalid or missing X-Auth-Token"}
        )
    
    return await call_next(request)

# =============================================================================
# Models
# =============================================================================

# Chat Models
class ChatMessage(BaseModel):
    role: str
    content: str
    thinking: Optional[str] = None
    timestamp: Optional[float] = None


class ChatRequest(BaseModel):
    session_id: str
    message: str
    mode: str = "agent"  # "agent" | "wild" | "plan" | "sweep"
    # When provided, this is used for LLM prompt construction instead of message.
    # `message` is still stored as the user-visible content in the session history.
    prompt_override: Optional[str] = None
    # Backward compat: accept old boolean fields and convert
    wild_mode: bool = False
    plan_mode: bool = False


class CreateSessionRequest(BaseModel):
    title: Optional[str] = None
    model_provider: Optional[str] = None
    model_id: Optional[str] = None


class UpdateSessionRequest(BaseModel):
    title: str


class SystemPromptUpdate(BaseModel):
    system_prompt: str = ""


class SessionModelUpdate(BaseModel):
    provider_id: str
    model_id: str


# Run Models
# Run State Machine: ready -> queued -> launching -> running -> finished/failed/stopped
# - ready: Created but not submitted for execution
# - queued: Submitted, waiting to be picked up
# - launching: Tmux window being created
# - running: Command actively executing
# - finished/failed/stopped: Terminal states

class RunCreate(BaseModel):
    name: str
    command: str
    workdir: Optional[str] = None
    sweep_id: Optional[str] = None  # If part of a sweep
    parent_run_id: Optional[str] = None
    origin_alert_id: Optional[str] = None
    chat_session_id: Optional[str] = None  # Originating chat session for traceability
    auto_start: bool = False  # If True, skip ready and go straight to queued


class RunStatusUpdate(BaseModel):
    status: str  # launching, running, finished, failed, stopped
    exit_code: Optional[int] = None
    error: Optional[str] = None
    tmux_pane: Optional[str] = None
    wandb_dir: Optional[str] = None


class RunUpdate(BaseModel):
    name: Optional[str] = None
    command: Optional[str] = None
    workdir: Optional[str] = None


class SweepCreate(BaseModel):
    name: str
    base_command: str
    workdir: Optional[str] = None
    parameters: dict  # e.g., {"lr": [0.001, 0.01], "batch_size": [32, 64]}
    max_runs: int = 10
    auto_start: bool = False
    goal: Optional[str] = None
    status: Optional[str] = None  # draft, pending, running
    ui_config: Optional[dict] = None
    chat_session_id: Optional[str] = None  # Originating chat session for traceability


class SweepUpdate(BaseModel):
    name: Optional[str] = None
    base_command: Optional[str] = None
    workdir: Optional[str] = None
    parameters: Optional[dict] = None
    max_runs: Optional[int] = None
    goal: Optional[str] = None
    status: Optional[str] = None  # draft, pending, running, completed, failed, canceled
    ui_config: Optional[dict] = None


class AlertRecord(BaseModel):
    id: str
    run_id: str
    timestamp: float
    severity: str = "warning"
    message: str
    choices: List[str]
    status: str = "pending"  # pending, resolved
    response: Optional[str] = None
    responded_at: Optional[float] = None
    session_id: Optional[str] = None
    auto_session: bool = False


class CreateAlertRequest(BaseModel):
    message: str
    choices: List[str]
    severity: str = "warning"


class RespondAlertRequest(BaseModel):
    choice: str


class RunRerunRequest(BaseModel):
    command: Optional[str] = None
    auto_start: bool = False
    origin_alert_id: Optional[str] = None


# WildModeRequest, WildLoopConfigRequest, WildEvent, EnqueueEventRequest
# → imported from wild_loop module


# Plan Models
PLAN_STATUSES = {"draft", "approved", "executing", "completed", "archived"}


class PlanCreate(BaseModel):
    title: str
    goal: str
    session_id: Optional[str] = None
    sections: Optional[dict] = None  # structured sections parsed from LLM output
    raw_markdown: str = ""  # full LLM response markdown


class PlanUpdate(BaseModel):
    title: Optional[str] = None
    status: Optional[str] = None  # draft, approved, executing, completed, archived
    sections: Optional[dict] = None
    raw_markdown: Optional[str] = None


class ClusterUpdateRequest(BaseModel):
    type: Optional[str] = None
    status: Optional[str] = None
    source: Optional[str] = None
    head_node: Optional[str] = None
    node_count: Optional[int] = None
    gpu_count: Optional[int] = None
    notes: Optional[str] = None
    details: Optional[dict] = None


class ClusterDetectRequest(BaseModel):
    preferred_type: Optional[str] = None


# =============================================================================
# Prompt Skill Manager
# =============================================================================

import yaml
import shutil
import subprocess

# Skills that ship with the server and cannot be deleted.
# Keep explicit IDs for one-offs and reserve prefixes for families of
# system-managed skills.
INTERNAL_SKILL_IDS = {
    "ra_mode_plan",
}
INTERNAL_SKILL_PREFIXES = ("wild_", "ra_mode_")


def _is_internal_skill(skill_id: str) -> bool:
    return skill_id in INTERNAL_SKILL_IDS or skill_id.startswith(INTERNAL_SKILL_PREFIXES)

class PromptSkillManager:
    """Manages prompt template files (markdown with YAML frontmatter).
    
    Skills are Codex-standard folders: prompt_skills/<name>/SKILL.md
    with YAML frontmatter and {{variable}} placeholders.
    """

    def __init__(self, skills_dir: Optional[str] = None):
        self.skills_dir = skills_dir or os.path.join(_SERVER_FILE_DIR, "prompt_skills")
        self._skills: Dict[str, dict] = {}
        self.load_all()

    def load_all(self) -> None:
        """Load all SKILL.md files from skill subdirectories."""
        self._skills.clear()
        if not os.path.isdir(self.skills_dir):
            logger.warning(f"Prompt skills directory not found: {self.skills_dir}")
            return
        for entry in sorted(os.listdir(self.skills_dir)):
            skill_dir = os.path.join(self.skills_dir, entry)
            if not os.path.isdir(skill_dir):
                continue
            skill_md = os.path.join(skill_dir, "SKILL.md")
            if not os.path.isfile(skill_md):
                continue
            try:
                skill = self._parse_file(skill_md, entry)
                self._skills[skill["id"]] = skill
            except Exception as e:
                logger.error(f"Failed to parse prompt skill {entry}: {e}")

    def _parse_file(self, filepath: str, folder_name: str) -> dict:
        """Parse a SKILL.md file with YAML frontmatter."""
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()

        # Split YAML frontmatter from body
        if content.startswith("---"):
            parts = content.split("---", 2)
            if len(parts) >= 3:
                frontmatter = yaml.safe_load(parts[1]) or {}
                template = parts[2].strip()
            else:
                frontmatter = {}
                template = content
        else:
            frontmatter = {}
            template = content

        skill_id = folder_name
        return {
            "id": skill_id,
            "name": frontmatter.get("name", skill_id),
            "description": frontmatter.get("description", ""),
            "template": template,
            "variables": frontmatter.get("variables", []),
            "category": frontmatter.get("category", "prompt"),  # "prompt" | "skill"
            "built_in": True,
            "internal": _is_internal_skill(skill_id),
            "filepath": filepath,
            "folder": os.path.dirname(filepath),
        }

    def list(self) -> list:
        """Return all skills (without internal paths)."""
        exclude = {"filepath", "folder"}
        return [
            {k: v for k, v in skill.items() if k not in exclude}
            for skill in self._skills.values()
        ]

    def create(
        self,
        name: str,
        description: str = "",
        template: str = "",
        category: str = "skill",
        variables: Optional[list] = None,
    ) -> dict:
        """Create a new skill folder with SKILL.md.

        Returns the new skill dict.  Raises ValueError if the ID already exists.
        """
        import re as _re
        skill_id = _re.sub(r"[^a-zA-Z0-9_-]", "_", name.strip().lower().replace(" ", "_"))
        if skill_id in self._skills:
            raise ValueError(f"Skill '{skill_id}' already exists")

        folder = os.path.join(self.skills_dir, skill_id)
        os.makedirs(folder, exist_ok=True)

        frontmatter = {
            "name": name,
            "description": description,
            "category": category,
        }
        if variables:
            frontmatter["variables"] = variables

        fm_text = yaml.dump(frontmatter, default_flow_style=False).strip()
        file_content = f"---\n{fm_text}\n---\n{template}\n"

        filepath = os.path.join(folder, "SKILL.md")
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(file_content)

        skill = self._parse_file(filepath, skill_id)
        self._skills[skill_id] = skill
        exclude = {"filepath", "folder"}
        return {k: v for k, v in skill.items() if k not in exclude}

    def delete(self, skill_id: str) -> bool:
        """Delete a user-created skill.

        Raises ValueError for internal skills.  Returns True on success.
        """
        skill = self._skills.get(skill_id)
        if skill is None:
            raise KeyError(f"Skill '{skill_id}' not found")
        if skill.get("internal"):
            raise ValueError(f"Cannot delete internal skill '{skill_id}'")

        folder = skill["folder"]
        if os.path.isdir(folder):
            shutil.rmtree(folder)
        del self._skills[skill_id]
        return True

    def install_from_git(self, url: str, name: Optional[str] = None) -> dict:
        """Clone a skill from a git URL.

        If *name* is not provided, derive it from the repo name.
        Returns the parsed skill dict.
        """
        if not name:
            # Derive from URL: https://github.com/user/my-skill.git -> my-skill
            name = url.rstrip("/").rstrip(".git").rsplit("/", 1)[-1]
        import re as _re
        skill_id = _re.sub(r"[^a-zA-Z0-9_-]", "_", name.strip().lower().replace(" ", "_"))
        if skill_id in self._skills:
            raise ValueError(f"Skill '{skill_id}' already exists")

        dest = os.path.join(self.skills_dir, skill_id)
        result = subprocess.run(
            ["git", "clone", "--depth", "1", url, dest],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode != 0:
            raise RuntimeError(f"git clone failed: {result.stderr.strip()}")

        skill_md = os.path.join(dest, "SKILL.md")
        if not os.path.isfile(skill_md):
            shutil.rmtree(dest)
            raise FileNotFoundError("Repository does not contain a SKILL.md file")

        skill = self._parse_file(skill_md, skill_id)
        self._skills[skill_id] = skill
        exclude = {"filepath", "folder"}
        return {k: v for k, v in skill.items() if k not in exclude}

    def search(self, query: str, limit: int = 20) -> list:
        """Search skills by name, description, and template content.

        Returns a list of skill dicts sorted by relevance score.
        """
        if not query or not query.strip():
            return self.list()[:limit]

        q = query.strip().lower()
        scored: list[tuple[float, dict]] = []
        exclude = {"filepath", "folder"}

        for skill in self._skills.values():
            score = 0.0
            name = skill.get("name", "").lower()
            desc = skill.get("description", "").lower()
            tmpl = skill.get("template", "").lower()

            # Exact name match is strongest signal
            if q == name:
                score += 100
            elif q in name:
                score += 60

            # Description match
            if q in desc:
                score += 30

            # Template body match (weakest signal)
            if q in tmpl:
                score += 10

            if score > 0:
                clean = {k: v for k, v in skill.items() if k not in exclude}
                clean["_score"] = score
                scored.append((score, clean))

        scored.sort(key=lambda t: t[0], reverse=True)
        return [s[1] for s in scored[:limit]]

    def get(self, skill_id: str) -> Optional[dict]:
        """Get a single skill by ID."""
        skill = self._skills.get(skill_id)
        if skill is None:
            return None
        exclude = {"filepath", "folder"}
        return {k: v for k, v in skill.items() if k not in exclude}

    def update(self, skill_id: str, template: str) -> Optional[dict]:
        """Update a skill's template and write back to disk."""
        skill = self._skills.get(skill_id)
        if skill is None:
            return None

        # Rebuild the file content with original frontmatter + new template
        filepath = skill["filepath"]
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()

        # Extract original frontmatter
        if content.startswith("---"):
            parts = content.split("---", 2)
            if len(parts) >= 3:
                frontmatter_text = parts[1]
            else:
                frontmatter_text = ""
        else:
            frontmatter_text = ""

        # Write back
        new_content = f"---{frontmatter_text}---\n{template}\n"
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(new_content)

        # Update in-memory cache
        skill["template"] = template
        exclude = {"filepath", "folder"}
        return {k: v for k, v in skill.items() if k not in exclude}

    def list_files(self, skill_id: str) -> Optional[list]:
        """List all files in a skill's folder."""
        skill = self._skills.get(skill_id)
        if skill is None:
            return None
        folder = skill["folder"]
        entries = []
        for root, dirs, files in os.walk(folder):
            rel_root = os.path.relpath(root, folder)
            if rel_root == ".":
                rel_root = ""
            for d in sorted(dirs):
                entries.append({
                    "name": d,
                    "path": os.path.join(rel_root, d) if rel_root else d,
                    "type": "directory",
                })
            for fname in sorted(files):
                fpath = os.path.join(root, fname)
                entries.append({
                    "name": fname,
                    "path": os.path.join(rel_root, fname) if rel_root else fname,
                    "type": "file",
                    "size": os.path.getsize(fpath),
                })
        return entries

    def read_file(self, skill_id: str, file_path: str) -> Optional[str]:
        """Read a file from a skill's folder."""
        skill = self._skills.get(skill_id)
        if skill is None:
            return None
        full_path = os.path.join(skill["folder"], file_path)
        # Security: ensure path doesn't escape skill folder
        real_folder = os.path.realpath(skill["folder"])
        real_path = os.path.realpath(full_path)
        if not real_path.startswith(real_folder):
            return None
        if not os.path.isfile(real_path):
            return None
        with open(real_path, "r", encoding="utf-8") as f:
            return f.read()

    def write_file(self, skill_id: str, file_path: str, content: str) -> Optional[bool]:
        """Write a file in a skill's folder."""
        skill = self._skills.get(skill_id)
        if skill is None:
            return None
        full_path = os.path.join(skill["folder"], file_path)
        # Security: ensure path doesn't escape skill folder
        real_folder = os.path.realpath(skill["folder"])
        real_path = os.path.realpath(full_path)
        if not real_path.startswith(real_folder):
            return None
        os.makedirs(os.path.dirname(real_path), exist_ok=True)
        with open(real_path, "w", encoding="utf-8") as f:
            f.write(content)
        # Re-parse if SKILL.md was updated
        if os.path.basename(file_path) == "SKILL.md":
            try:
                updated = self._parse_file(real_path, skill_id)
                self._skills[skill_id] = updated
            except Exception as e:
                logger.error(f"Failed to re-parse SKILL.md for {skill_id}: {e}")
        return True

    def render(self, skill_id: str, variables: Dict[str, str]) -> Optional[str]:
        """Render a skill template with the given variables.
        
        Replaces {{variable_name}} with the provided value.
        Missing variables are left as empty strings.
        """
        skill = self._skills.get(skill_id)
        if skill is None:
            return None
        result = skill["template"]
        for var_name, value in variables.items():
            result = result.replace("{{" + var_name + "}}", str(value))
        # Clean up any remaining unreplaced variables
        import re as _re
        result = _re.sub(r"\{\{[a-zA-Z_]+\}\}", "", result)
        return result


# Initialize the prompt skill manager
prompt_skill_manager = PromptSkillManager()


# =============================================================================
# State
# =============================================================================

chat_sessions: Dict[str, dict] = {}
runs: Dict[str, dict] = {}
sweeps: Dict[str, dict] = {}
active_alerts: Dict[str, dict] = {}
plans: Dict[str, dict] = {}
# wild_mode_enabled, wild_loop_state → imported from wild_loop module
# Access via wild_loop_mod.wild_mode_enabled / wild_loop_state (imported ref)
session_stop_flags: Dict[str, bool] = {}
active_chat_tasks: Dict[str, asyncio.Task] = {}


# WildEventQueue class + wild_event_queue instance → imported from wild_loop module


def _get_run_log_content(run_id: str) -> str:
    """Return log tail for a run as plain text (for engine callbacks)."""
    run = runs.get(run_id)
    if not run:
        return "Run not found"
    run_dir = run.get("run_dir")
    if not run_dir:
        return "No run directory"
    log_file = os.path.join(run_dir, "run.log")
    if not os.path.exists(log_file):
        return "No log file"
    try:
        with open(log_file, "r") as f:
            content = f.read()
        return content[-5000:] if len(content) > 5000 else content
    except Exception as e:
        return f"Error reading log: {e}"


def _create_sweep_sync(spec: dict) -> dict:
    """Synchronous sweep creation wrapper for engine callbacks."""
    sweep_id = uuid.uuid4().hex[:12]
    created_at = time.time()
    sweep_data = {
        "name": spec.get("name", f"sweep-{sweep_id}"),
        "base_command": spec.get("base_command", ""),
        "workdir": spec.get("workdir"),
        "parameters": spec.get("parameters", {}),
        "max_runs": spec.get("max_runs"),
        "status": "pending",
        "run_ids": [],
        "created_at": created_at,
    }
    sweeps[sweep_id] = sweep_data
    return {"id": sweep_id, **sweep_data}


def _start_sweep_sync(sweep_id: str, parallel: int = 1):
    """Synchronous sweep start wrapper for engine callbacks."""
    if sweep_id not in sweeps:
        return
    sweep = sweeps[sweep_id]
    sweep["status"] = "running"
    sweep["parallel"] = parallel


def _respond_to_alert_sync(alert_id: str, choice: str):
    """Synchronous alert response for engine callbacks."""
    alert = active_alerts.get(alert_id)
    if not alert:
        return
    alert["status"] = "responded"
    alert["choice"] = choice
    response_file = alert.get("response_file")
    if response_file:
        try:
            with open(response_file, "w") as f:
                f.write(choice)
        except Exception as e:
            logger.error(f"Engine: Failed writing alert response for {alert_id}: {e}")

# Wire up the WildLoopEngine callbacks (dependency injection to avoid circular imports)
wild_engine.set_callbacks(
    get_runs=lambda: runs,
    get_sweeps=lambda: sweeps,
    get_alerts=lambda: active_alerts,
    get_run_logs=_get_run_log_content,
    create_sweep=_create_sweep_sync,
    start_sweep=_start_sweep_sync,
    respond_to_alert=_respond_to_alert_sync,
    recompute_sweep_state=lambda sid: recompute_sweep_state(sid) if 'recompute_sweep_state' in dir() else None,
    skill_get_fn=lambda skill_id: prompt_skill_manager.get(skill_id),
    save_settings=lambda: save_settings_state(),
    server_url=SERVER_CALLBACK_URL,
    auth_token=USER_AUTH_TOKEN or "",
)

# Wild Loop V2 engine (ralph-style)
wild_v2_engine = WildV2Engine(
    opencode_url=OPENCODE_URL,
    model_provider=MODEL_PROVIDER,
    model_id=MODEL_ID,
    get_workdir=lambda: WORKDIR,
    server_url=SERVER_CALLBACK_URL,
    auth_token=USER_AUTH_TOKEN,
    get_auth=get_auth,
    render_fn=prompt_skill_manager.render,
    save_chat_state=lambda: save_chat_state(),
    chat_sessions=chat_sessions,
)

# Memory store (persistent lessons / context)
memory_store = MemoryStore(get_workdir=lambda: WORKDIR)
memory_store.load()

# Inject memory store into V2 engine so reflections can write memories
wild_v2_engine.memory_store = memory_store

active_chat_streams: Dict[str, "ChatStreamRuntime"] = {}

STREAM_SNAPSHOT_SAVE_INTERVAL_SECONDS = 0.75
STREAM_SNAPSHOT_SAVE_INTERVAL_EVENTS = 20
STREAM_RUNTIME_RETENTION_SECONDS = 120.0

_wandb_metrics_cache: Dict[str, dict] = {}

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


CLUSTER_TYPE_VALUES = {
    "unknown",
    "slurm",
    "local_gpu",
    "kubernetes",
    "ray",
    "shared_head_node",
}
CLUSTER_STATUS_VALUES = {"unknown", "healthy", "degraded", "offline"}
CLUSTER_SOURCE_VALUES = {"unset", "manual", "detected"}


def _default_cluster_state() -> dict:
    now = time.time()
    return {
        "type": "unknown",
        "status": "unknown",
        "source": "unset",
        "label": "Unknown",
        "description": "Cluster has not been configured yet.",
        "head_node": None,
        "node_count": None,
        "gpu_count": None,
        "notes": None,
        "confidence": None,
        "details": {},
        "last_detected_at": None,
        "updated_at": now,
    }


cluster_state: dict = _default_cluster_state()


def save_chat_state():
    """Persist chat sessions to disk."""
    try:
        with open(CHAT_DATA_FILE, "w") as f:
            json.dump({"chat_sessions": chat_sessions}, f, indent=2, default=str)
    except Exception as e:
        logger.error(f"Error saving chat state: {e}")


def load_chat_state():
    """Load chat sessions from disk."""
    global chat_sessions
    if os.path.exists(CHAT_DATA_FILE):
        try:
            with open(CHAT_DATA_FILE, "r") as f:
                data = json.load(f)
                chat_sessions = data.get("chat_sessions", {})
                for session in chat_sessions.values():
                    if not isinstance(session, dict):
                        continue
                    active_stream = session.get("active_stream")
                    if isinstance(active_stream, dict) and active_stream.get("status") == "running":
                        # Streaming workers are in-memory only; mark stale snapshots as interrupted on restart.
                        active_stream["status"] = "interrupted"
        except Exception as e:
            logger.error(f"Error loading chat state: {e}")


def save_runs_state():
    """Persist runs and sweeps to disk."""
    try:
        with open(JOBS_DATA_FILE, "w") as f:
            json.dump({"runs": runs, "sweeps": sweeps}, f, indent=2, default=str)
    except Exception as e:
        logger.error(f"Error saving runs state: {e}")


def load_runs_state():
    """Load runs and sweeps from disk."""
    global runs, sweeps
    if os.path.exists(JOBS_DATA_FILE):
        try:
            with open(JOBS_DATA_FILE, "r") as f:
                data = json.load(f)
                runs = data.get("runs", {})
                sweeps = data.get("sweeps", {})
                sweeps_backfilled = False
                for sweep in sweeps.values():
                    sweep["status"] = _normalize_sweep_status(sweep.get("status"))
                    if _ensure_sweep_creation_context(sweep):
                        sweeps_backfilled = True
                recompute_all_sweep_states()
                if sweeps_backfilled:
                    save_runs_state()
        except Exception as e:
            logger.error(f"Error loading runs state: {e}")


def save_alerts_state():
    """Persist active alerts to disk."""
    try:
        with open(ALERTS_DATA_FILE, "w") as f:
            json.dump({"alerts": list(active_alerts.values())}, f, indent=2, default=str)
    except Exception as e:
        logger.error(f"Error saving alerts state: {e}")


def load_alerts_state():
    """Load active alerts from disk."""
    global active_alerts
    if os.path.exists(ALERTS_DATA_FILE):
        try:
            with open(ALERTS_DATA_FILE, "r") as f:
                data = json.load(f)
                loaded = data.get("alerts", [])
                active_alerts = {
                    alert["id"]: alert
                    for alert in loaded
                    if isinstance(alert, dict) and alert.get("id")
                }
        except Exception as e:
            logger.error(f"Error loading alerts state: {e}")


def save_plans_state():
    """Persist plans to disk."""
    try:
        with open(PLANS_DATA_FILE, "w") as f:
            json.dump({"plans": list(plans.values())}, f, indent=2, default=str)
    except Exception as e:
        logger.error(f"Error saving plans state: {e}")


def load_plans_state():
    """Load plans from disk."""
    global plans
    if os.path.exists(PLANS_DATA_FILE):
        try:
            with open(PLANS_DATA_FILE, "r") as f:
                data = json.load(f)
                loaded = data.get("plans", [])
                plans = {
                    plan["id"]: plan
                    for plan in loaded
                    if isinstance(plan, dict) and plan.get("id")
                }
        except Exception as e:
            logger.error(f"Error loading plans state: {e}")


def _cluster_type_label(cluster_type: str) -> str:
    mapping = {
        "unknown": "Unknown",
        "slurm": "Slurm",
        "local_gpu": "Local GPU",
        "kubernetes": "Kubernetes",
        "ray": "Ray",
        "shared_head_node": "Shared GPU Head Node",
    }
    return mapping.get(cluster_type, "Unknown")


def _cluster_type_description(cluster_type: str) -> str:
    mapping = {
        "unknown": "Cluster has not been configured yet.",
        "slurm": "Slurm-managed cluster scheduler detected.",
        "local_gpu": "Single-host GPU workstation/cluster detected.",
        "kubernetes": "Kubernetes cluster control plane detected.",
        "ray": "Ray cluster runtime detected.",
        "shared_head_node": "Head node with SSH fan-out to worker nodes.",
    }
    return mapping.get(cluster_type, "Cluster has not been configured yet.")


def _normalize_cluster_type(raw_type: Optional[str]) -> str:
    if not raw_type:
        return "unknown"
    value = raw_type.strip().lower().replace("-", "_")
    aliases = {
        "localgpu": "local_gpu",
        "local_gpu_cluster": "local_gpu",
        "shared_gpu_head_node": "shared_head_node",
        "shared_gpu": "shared_head_node",
        "head_node": "shared_head_node",
        "k8s": "kubernetes",
    }
    value = aliases.get(value, value)
    return value if value in CLUSTER_TYPE_VALUES else "unknown"


def _normalize_cluster_status(raw_status: Optional[str]) -> str:
    if not raw_status:
        return "unknown"
    value = raw_status.strip().lower()
    return value if value in CLUSTER_STATUS_VALUES else "unknown"


def _normalize_cluster_source(raw_source: Optional[str]) -> str:
    if not raw_source:
        return "unset"
    value = raw_source.strip().lower()
    return value if value in CLUSTER_SOURCE_VALUES else "unset"


def _normalize_cluster_state(raw_state: Any) -> dict:
    normalized = _default_cluster_state()
    if not isinstance(raw_state, dict):
        return normalized

    cluster_type = _normalize_cluster_type(raw_state.get("type"))
    normalized.update(
        {
            "type": cluster_type,
            "status": _normalize_cluster_status(raw_state.get("status")),
            "source": _normalize_cluster_source(raw_state.get("source")),
            "label": _cluster_type_label(cluster_type),
            "description": _cluster_type_description(cluster_type),
            "head_node": raw_state.get("head_node"),
            "node_count": raw_state.get("node_count"),
            "gpu_count": raw_state.get("gpu_count"),
            "notes": raw_state.get("notes"),
            "confidence": raw_state.get("confidence"),
            "details": raw_state.get("details") if isinstance(raw_state.get("details"), dict) else {},
            "last_detected_at": raw_state.get("last_detected_at"),
            "updated_at": raw_state.get("updated_at") or time.time(),
        }
    )
    return normalized


def save_settings_state():
    """Persist settings to disk."""
    try:
        wild_state = get_wild_serializable_state()
        with open(SETTINGS_DATA_FILE, "w") as f:
            json.dump(
                {
                    **wild_state,
                    "cluster": cluster_state,
                },
                f,
                indent=2,
                default=str,
            )
    except Exception as e:
        logger.error(f"Error saving settings state: {e}")


def load_settings_state():
    """Load settings from disk."""
    global cluster_state
    if os.path.exists(SETTINGS_DATA_FILE):
        try:
            with open(SETTINGS_DATA_FILE, "r") as f:
                data = json.load(f)
                load_wild_from_saved(data)
                cluster_state = _normalize_cluster_state(data.get("cluster"))
        except Exception as e:
            logger.error(f"Error loading settings state: {e}")


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
    # W&B internal metadata keys are usually underscore-prefixed.
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


def _resolve_metrics_file(wandb_dir: Optional[str]) -> Optional[str]:
    """Resolve likely metrics file paths from a wandb run directory."""
    if not wandb_dir:
        return None

    base_path = wandb_dir
    if not os.path.isabs(base_path):
        base_path = os.path.join(WORKDIR, base_path)

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
        # Keep payload bounded for very high-dimensional logs.
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


def _get_wandb_curve_data(wandb_dir: Optional[str]) -> Optional[dict]:
    metrics_file = _resolve_metrics_file(wandb_dir)
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


def _run_response_payload(run_id: str, run: dict) -> dict:
    """Build run response payload enriched with metrics.

    Metrics come from two sources, in priority order:
    1. Stored metrics POSTed by the sidecar (agent_metrics.jsonl)
    2. WandB files discovered via wandb_dir or run_dir
    """
    payload = {"id": run_id, **run}

    # Source 1: stored metrics from sidecar POSTs
    parsed = _load_run_metrics(run.get("run_dir"))

    # Source 2: wandb files (fallback)
    if not parsed or not parsed.get("metricSeries"):
        wandb_dir = run.get("wandb_dir")
        if not wandb_dir:
            wandb_dir = _find_wandb_dir_from_run_dir(run.get("run_dir"))
            if wandb_dir:
                run["wandb_dir"] = wandb_dir
                payload["wandb_dir"] = wandb_dir
        wandb_parsed = _get_wandb_curve_data(wandb_dir)
        if wandb_parsed:
            parsed = wandb_parsed

    if not parsed:
        return payload

    parsed_metric_series = parsed.get("metricSeries")
    if parsed_metric_series:
        payload["metricSeries"] = parsed_metric_series
        payload["metricKeys"] = parsed.get("metricKeys", list(parsed_metric_series.keys()))

    # Also provide lossHistory for backward compat with components that still use it
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


# =============================================================================
# Run/Sweep State Helpers
# =============================================================================

RUN_STATUS_ACTIVE = {"launching", "running"}
RUN_STATUS_PENDING = {"ready", "queued"}
RUN_STATUS_TERMINAL = {"finished", "failed", "stopped"}

SWEEP_STATUS_TERMINAL = {"completed", "failed", "canceled"}
SWEEP_STATUS_EDITABLE = {"draft", "pending"}


def _coerce_exit_code(raw_value: object) -> Optional[int]:
    if raw_value is None:
        return None
    if isinstance(raw_value, bool):
        return int(raw_value)
    if isinstance(raw_value, int):
        return raw_value
    if isinstance(raw_value, float) and raw_value.is_integer():
        return int(raw_value)
    if isinstance(raw_value, str):
        stripped = raw_value.strip()
        if not stripped:
            return None
        try:
            return int(stripped)
        except ValueError:
            return None
    return None


def _terminal_status_from_exit_code(exit_code: Optional[int]) -> Optional[str]:
    if exit_code is None:
        return None
    return "finished" if exit_code == 0 else "failed"


def _reconcile_run_terminal_state(run_id: str, run: dict) -> bool:
    changed = False

    normalized_exit_code = _coerce_exit_code(run.get("exit_code"))
    if run.get("exit_code") != normalized_exit_code:
        run["exit_code"] = normalized_exit_code
        changed = True

    completion_file = None
    run_dir = run.get("run_dir")
    if run_dir:
        completion_candidate = os.path.join(run_dir, "job.done")
        if os.path.exists(completion_candidate):
            completion_file = completion_candidate

    if completion_file:
        completion_exit_code: Optional[int] = None
        try:
            with open(completion_file, "r", encoding="utf-8", errors="replace") as f:
                completion_exit_code = _coerce_exit_code(f.read())
        except Exception as e:
            logger.warning("Failed to read completion file for %s: %s", run_id, e)

        if completion_exit_code is not None and run.get("exit_code") != completion_exit_code:
            run["exit_code"] = completion_exit_code
            normalized_exit_code = completion_exit_code
            changed = True

        completion_status = _terminal_status_from_exit_code(completion_exit_code)
        current_status = run.get("status")
        if completion_status and current_status not in RUN_STATUS_TERMINAL:
            run["status"] = completion_status
            changed = True
        elif not completion_status and current_status not in RUN_STATUS_TERMINAL:
            run["status"] = "failed"
            changed = True
            if not run.get("error"):
                run["error"] = "Run ended but exit code could not be parsed"
                changed = True

        if completion_status == "failed" and completion_exit_code not in (None, 0) and not run.get("error"):
            run["error"] = f"Process exited with code {completion_exit_code}"
            changed = True

        if not run.get("ended_at"):
            try:
                run["ended_at"] = os.path.getmtime(completion_file)
            except OSError:
                run["ended_at"] = time.time()
            changed = True
    elif run.get("status") in RUN_STATUS_TERMINAL and not run.get("ended_at"):
        run["ended_at"] = time.time()
        changed = True

    return changed


def _reconcile_all_run_terminal_states() -> bool:
    changed = False
    affected_sweeps: set[str] = set()

    for run_id, run in runs.items():
        if _reconcile_run_terminal_state(run_id, run):
            changed = True
            sweep_id = run.get("sweep_id")
            if sweep_id:
                affected_sweeps.add(sweep_id)

    for sweep_id in affected_sweeps:
        recompute_sweep_state(sweep_id)

    if changed:
        save_runs_state()

    return changed


def _normalize_sweep_status(raw_status: Optional[str]) -> str:
    if not raw_status:
        return "pending"
    normalized = raw_status.strip().lower()
    if normalized == "ready":
        return "pending"
    if normalized in {"draft", "pending", "running", "completed", "failed", "canceled"}:
        return normalized
    return "pending"


def _coerce_optional_text(value: object) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    stripped = str(value).strip()
    return stripped or None


def _coerce_optional_int(value: object) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            return int(stripped)
        except ValueError:
            return None
    return None


def _coerce_optional_bool(value: object) -> Optional[bool]:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes", "y", "on"}:
            return True
        if lowered in {"false", "0", "no", "n", "off"}:
            return False
    return None


def _json_clone(value: object) -> Optional[dict]:
    if not isinstance(value, dict):
        return None
    try:
        return json.loads(json.dumps(value))
    except Exception:
        return None


def _derive_sweep_creation_context(
    *,
    name: Optional[str],
    base_command: Optional[str],
    goal: Optional[str],
    max_runs: Optional[int],
    ui_config: Optional[dict],
    parameters: Optional[dict],
    created_at: float,
) -> dict:
    ui = ui_config if isinstance(ui_config, dict) else {}
    parameter_grid = parameters if isinstance(parameters, dict) else {}

    ui_hyperparameters = ui.get("hyperparameters")
    ui_metrics = ui.get("metrics")
    ui_insights = ui.get("insights")

    max_runs_from_ui = _coerce_optional_int(ui.get("maxRuns"))
    parallel_runs = _coerce_optional_int(ui.get("parallelRuns"))

    hyperparameter_count = (
        len(ui_hyperparameters)
        if isinstance(ui_hyperparameters, list)
        else len(parameter_grid)
    )
    metric_count = len(ui_metrics) if isinstance(ui_metrics, list) else None
    insight_count = len(ui_insights) if isinstance(ui_insights, list) else None

    return {
        "name": _coerce_optional_text(ui.get("name")) or _coerce_optional_text(name),
        "goal": _coerce_optional_text(ui.get("goal")) or _coerce_optional_text(goal),
        "description": _coerce_optional_text(ui.get("description")),
        "command": _coerce_optional_text(ui.get("command")) or _coerce_optional_text(base_command),
        "notes": _coerce_optional_text(ui.get("notes")),
        "max_runs": max_runs_from_ui if max_runs_from_ui is not None else _coerce_optional_int(max_runs),
        "parallel_runs": parallel_runs,
        "early_stopping_enabled": _coerce_optional_bool(ui.get("earlyStoppingEnabled")),
        "early_stopping_patience": _coerce_optional_int(ui.get("earlyStoppingPatience")),
        "hyperparameter_count": hyperparameter_count,
        "metric_count": metric_count,
        "insight_count": insight_count,
        "created_at": created_at,
        "ui_config_snapshot": _json_clone(ui),
    }


def _ensure_sweep_creation_context(sweep: dict) -> bool:
    existing = sweep.get("creation_context")
    if isinstance(existing, dict):
        return False

    sweep["creation_context"] = _derive_sweep_creation_context(
        name=_coerce_optional_text(sweep.get("name")),
        base_command=_coerce_optional_text(sweep.get("base_command")),
        goal=_coerce_optional_text(sweep.get("goal")),
        max_runs=_coerce_optional_int(sweep.get("max_runs")),
        ui_config=sweep.get("ui_config") if isinstance(sweep.get("ui_config"), dict) else None,
        parameters=sweep.get("parameters") if isinstance(sweep.get("parameters"), dict) else None,
        created_at=float(sweep.get("created_at") or time.time()),
    )
    return True


def _compute_sweep_progress(sweep: dict) -> dict:
    """Compute progress counts for a sweep from current run statuses."""
    run_ids = sweep.get("run_ids", []) or []
    sweep_runs = [runs[rid] for rid in run_ids if rid in runs]

    return {
        "total": len(sweep_runs),
        "completed": sum(1 for r in sweep_runs if r.get("status") == "finished"),
        "failed": sum(1 for r in sweep_runs if r.get("status") == "failed"),
        "running": sum(1 for r in sweep_runs if r.get("status") == "running"),
        "launching": sum(1 for r in sweep_runs if r.get("status") == "launching"),
        "ready": sum(1 for r in sweep_runs if r.get("status") == "ready"),
        "queued": sum(1 for r in sweep_runs if r.get("status") == "queued"),
        "canceled": sum(1 for r in sweep_runs if r.get("status") == "stopped"),
    }


def _infer_sweep_status(previous_status: str, progress: dict) -> str:
    """Derive a sweep status from run state counts."""
    total = progress.get("total", 0)
    running = progress.get("running", 0) + progress.get("launching", 0)
    queued = progress.get("queued", 0)
    ready = progress.get("ready", 0)
    completed = progress.get("completed", 0)
    failed = progress.get("failed", 0)
    canceled = progress.get("canceled", 0)
    terminal = completed + failed + canceled

    if previous_status == "draft" and total == 0:
        return "draft"
    if total == 0:
        return "pending"
    if running > 0:
        return "running"
    if queued > 0:
        return "pending"
    if ready > 0:
        return "pending"
    if terminal < total:
        return "running"
    if failed > 0:
        return "failed"
    if completed > 0:
        return "completed"
    return "canceled"


def recompute_sweep_state(sweep_id: str) -> Optional[dict]:
    """Refresh a single sweep's progress and derived status."""
    sweep = sweeps.get(sweep_id)
    if not sweep:
        return None

    previous_status = _normalize_sweep_status(sweep.get("status"))
    progress = _compute_sweep_progress(sweep)
    next_status = _infer_sweep_status(previous_status, progress)

    sweep["status"] = next_status
    sweep["progress"] = progress

    if next_status == "running":
        if not sweep.get("started_at"):
            sweep["started_at"] = time.time()
        sweep.pop("completed_at", None)
    elif next_status in SWEEP_STATUS_TERMINAL:
        sweep["completed_at"] = sweep.get("completed_at") or time.time()
    else:
        sweep.pop("completed_at", None)

    return sweep


def recompute_all_sweep_states() -> None:
    for sweep_id in list(sweeps.keys()):
        recompute_sweep_state(sweep_id)


def _sync_run_membership_with_sweep(run_id: str, sweep_id: Optional[str]) -> None:
    if not sweep_id:
        return
    if sweep_id not in sweeps:
        raise HTTPException(status_code=404, detail=f"Sweep not found: {sweep_id}")
    run_ids = sweeps[sweep_id].setdefault("run_ids", [])
    if run_id not in run_ids:
        run_ids.append(run_id)
    recompute_sweep_state(sweep_id)


def _run_command_capture(args: list[str], timeout: float = 2.0) -> tuple[bool, str]:
    try:
        proc = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
        )
        output = (proc.stdout or proc.stderr or "").strip()
        return proc.returncode == 0, output
    except Exception:
        return False, ""


def _count_gpu_devices() -> Optional[int]:
    if not shutil.which("nvidia-smi"):
        return None
    ok, output = _run_command_capture(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], timeout=2.5)
    if not ok:
        return None
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    return len(lines) if lines else 0


def _count_slurm_nodes() -> Optional[int]:
    if not shutil.which("sinfo"):
        return None
    ok, output = _run_command_capture(["sinfo", "-h", "-N"], timeout=2.0)
    if not ok:
        return None
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    return len(lines) if lines else 0


def _count_kubernetes_nodes() -> Optional[int]:
    if not shutil.which("kubectl"):
        return None
    ok, output = _run_command_capture(["kubectl", "get", "nodes", "--no-headers"], timeout=2.5)
    if not ok:
        return None
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    return len(lines) if lines else 0


def _count_ssh_hosts() -> int:
    ssh_config = os.path.expanduser("~/.ssh/config")
    if not os.path.exists(ssh_config):
        return 0
    try:
        count = 0
        with open(ssh_config, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line.lower().startswith("host "):
                    continue
                host_targets = [segment for segment in line[5:].split(" ") if segment]
                has_real_target = any(
                    target not in {"*", "?"} and "*" not in target and "?" not in target
                    for target in host_targets
                )
                if has_real_target:
                    count += 1
        return count
    except Exception:
        return 0


def _infer_cluster_from_environment() -> dict:
    now = time.time()
    type_hint = _normalize_cluster_type(os.environ.get("RESEARCH_AGENT_CLUSTER_TYPE"))
    gpu_count = _count_gpu_devices()
    slurm_nodes = _count_slurm_nodes()
    kube_nodes = _count_kubernetes_nodes()
    ssh_hosts = _count_ssh_hosts()

    has_slurm_env = any(key.startswith("SLURM_") for key in os.environ.keys())
    has_kube_env = bool(os.environ.get("KUBERNETES_SERVICE_HOST")) or os.path.exists(
        "/var/run/secrets/kubernetes.io/serviceaccount/token"
    )
    has_ray_env = bool(os.environ.get("RAY_ADDRESS"))
    has_ray_cli = bool(shutil.which("ray"))

    detected_type = "unknown"
    confidence = 0.35
    details: dict[str, Any] = {
        "signals": [],
        "slurm_nodes": slurm_nodes,
        "kubernetes_nodes": kube_nodes,
        "ssh_hosts": ssh_hosts,
    }

    if type_hint != "unknown":
        detected_type = type_hint
        confidence = 0.98
        details["signals"].append("RESEARCH_AGENT_CLUSTER_TYPE")
    elif has_kube_env or (kube_nodes or 0) > 0:
        detected_type = "kubernetes"
        confidence = 0.93 if has_kube_env else 0.82
        details["signals"].append("kubernetes")
    elif has_slurm_env or (slurm_nodes or 0) > 0:
        detected_type = "slurm"
        confidence = 0.9 if has_slurm_env else 0.8
        details["signals"].append("slurm")
    elif has_ray_env or has_ray_cli:
        detected_type = "ray"
        confidence = 0.85 if has_ray_env else 0.65
        details["signals"].append("ray")
    elif ssh_hosts >= 3:
        detected_type = "shared_head_node"
        confidence = 0.64
        details["signals"].append("ssh-host-fanout")
    elif gpu_count is not None and gpu_count > 0:
        detected_type = "local_gpu"
        confidence = 0.78 if gpu_count > 1 else 0.68
        details["signals"].append("nvidia-smi")

    if detected_type == "slurm":
        node_count = slurm_nodes
    elif detected_type == "kubernetes":
        node_count = kube_nodes
    elif detected_type == "shared_head_node":
        node_count = ssh_hosts if ssh_hosts > 0 else None
    elif detected_type == "local_gpu":
        node_count = 1
    else:
        node_count = None

    host = socket.gethostname() if detected_type in {"local_gpu", "shared_head_node"} else None
    status = "healthy" if detected_type != "unknown" else "unknown"

    return {
        "type": detected_type,
        "status": status,
        "source": "detected",
        "label": _cluster_type_label(detected_type),
        "description": _cluster_type_description(detected_type),
        "head_node": host,
        "node_count": node_count,
        "gpu_count": gpu_count,
        "notes": None,
        "confidence": round(confidence, 2),
        "details": details,
        "last_detected_at": now,
        "updated_at": now,
    }


def _current_run_summary() -> dict:
    _reconcile_all_run_terminal_states()
    active_runs = [run for run in runs.values() if not run.get("is_archived", False)]
    return {
        "total": len(active_runs),
        "running": sum(1 for run in active_runs if run.get("status") == "running"),
        "launching": sum(1 for run in active_runs if run.get("status") == "launching"),
        "queued": sum(1 for run in active_runs if run.get("status") == "queued"),
        "ready": sum(1 for run in active_runs if run.get("status") == "ready"),
        "failed": sum(1 for run in active_runs if run.get("status") == "failed"),
        "finished": sum(1 for run in active_runs if run.get("status") == "finished"),
    }


# =============================================================================
# Tmux Helpers
# =============================================================================

def get_tmux_server():
    """Get or create tmux server connection."""
    try:
        return libtmux.Server()
    except Exception as e:
        logger.error(f"Failed to connect to tmux server: {e}")
        return None


def get_or_create_session(session_name: Optional[str] = None):
    """Get or create the research-agent tmux session."""
    if session_name is None:
        session_name = TMUX_SESSION_NAME
    server = get_tmux_server()
    if not server:
        return None
    
    try:
        session = server.sessions.get(session_name=session_name, default=None)
        if not session:
            logger.info(f"Creating new tmux session: {session_name}")
            session = server.new_session(session_name=session_name)
        return session
    except Exception as e:
        logger.error(f"Error getting/creating tmux session: {e}")
        return None


def launch_run_in_tmux(run_id: str, run_data: dict) -> Optional[str]:
    """Launch a run in a new tmux window with sidecar."""
    session = get_or_create_session()
    if not session:
        raise Exception("Tmux session not available. Start tmux first.")
    
    # Create window name
    run_name = run_data.get("name", run_id)[:20].replace(" ", "-")
    tmux_window_name = f"ra-{run_id[:8]}"
    
    logger.info(f"Launching run {run_id} in window {tmux_window_name}")
    
    # Create window
    window = session.new_window(window_name=tmux_window_name, attach=False)
    pane = window.active_pane
    
    # Setup run directory
    run_dir = os.path.join(DATA_DIR, "runs", run_id)
    os.makedirs(run_dir, exist_ok=True)
    
    # Write command to file
    command_file = os.path.join(run_dir, "command.txt")
    with open(command_file, "w") as f:
        f.write(run_data["command"])
    
    # Get sidecar path
    server_dir = os.path.dirname(os.path.abspath(__file__))
    sidecar_path = os.path.join(server_dir, "job_sidecar.py")
    
    # Build sidecar command
    server_url = SERVER_CALLBACK_URL
    run_workdir = run_data.get("workdir") or WORKDIR
    
    if getattr(sys, "frozen", False):
        sidecar_cmd = (
            f"{shlex.quote(sys.executable)} --run-sidecar "
            f"--job_id {shlex.quote(run_id)} "
            f"--server_url {shlex.quote(server_url)} "
            f"--command_file {shlex.quote(command_file)} "
            f"--agent_run_dir {shlex.quote(run_dir)} "
            f"--workdir {shlex.quote(run_workdir)}"
        )
    else:
        sidecar_cmd = (
            f'{shlex.quote(sys.executable)} "{sidecar_path}" '
            f'--job_id {shlex.quote(run_id)} '
            f'--server_url {shlex.quote(server_url)} '
            f'--command_file {shlex.quote(command_file)} '
            f'--agent_run_dir {shlex.quote(run_dir)} '
            f'--workdir {shlex.quote(run_workdir)}'
        )
    if USER_AUTH_TOKEN:
        sidecar_cmd += f" --auth_token {shlex.quote(USER_AUTH_TOKEN)}"
    
    logger.info(f"Executing sidecar: {sidecar_cmd}")
    pane.send_keys(sidecar_cmd)
    
    # Update run data
    run_data["status"] = "launching"
    run_data["tmux_window"] = tmux_window_name
    run_data["run_dir"] = run_dir
    run_data["launched_at"] = time.time()
    
    return tmux_window_name


# =============================================================================
# OpenCode Integration
# =============================================================================

async def get_opencode_session_for_chat(chat_session_id: str) -> str:
    """Get or create an OpenCode session for a specific chat session."""
    if chat_session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Chat session not found")
    
    session = chat_sessions[chat_session_id]
    if session.get("opencode_session_id"):
        return session["opencode_session_id"]
    
    async with httpx.AsyncClient() as client:
        resp = await client.post(f"{OPENCODE_URL}/session", json={}, auth=get_auth())
        resp.raise_for_status()
        opencode_id = resp.json().get("id")
        session["opencode_session_id"] = opencode_id
        save_chat_state()
        logger.info(f"Created new OpenCode session {opencode_id} for chat {chat_session_id}")
        return opencode_id


async def fetch_opencode_session_title(opencode_session_id: str) -> Optional[str]:
    """Fetch the auto-generated title from an OpenCode session."""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
            resp = await client.get(
                f"{OPENCODE_URL}/session/{opencode_session_id}",
                auth=get_auth(),
            )
            resp.raise_for_status()
            data = resp.json()
            title = data.get("title")
            if title and isinstance(title, str) and title.strip():
                return title.strip()
    except Exception as e:
        logger.warning("Failed to fetch OpenCode session title for %s: %s", opencode_session_id, e)
    return None


async def send_prompt_to_opencode(
    client: httpx.AsyncClient,
    session_id: str,
    content: str,
    model_provider: str,
    model_id: str,
):
    """Send a prompt to an OpenCode session using an explicit model."""
    prompt_payload = {
        "model": {"providerID": model_provider, "modelID": model_id},
        "parts": [{"type": "text", "text": content}]
    }
    resp = await client.post(
        f"{OPENCODE_URL}/session/{session_id}/prompt_async",
        json=prompt_payload,
        auth=get_auth()
    )
    resp.raise_for_status()


def should_stop_session(session_id: str) -> bool:
    """Check if a session is flagged to stop streaming."""
    return session_stop_flags.get(session_id, False)


def _extract_tool_name(part: dict) -> Optional[str]:
    """Best-effort extraction for tool part names across OpenCode versions."""
    state = part.get("state") if isinstance(part, dict) else {}
    if not isinstance(state, dict):
        state = {}
    state_input = state.get("input")
    if not isinstance(state_input, dict):
        state_input = {}

    for candidate in (
        part.get("name"),
        part.get("tool"),
        state.get("title"),
        state_input.get("description"),
    ):
        if isinstance(candidate, str) and candidate.strip():
            return candidate
    return None


def _coerce_tool_text(value: Any) -> Optional[str]:
    """Convert tool input/output payloads to readable text."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, indent=2)
    except Exception:
        return str(value)


def _extract_tool_data(part: dict) -> dict[str, Any]:
    """Extract normalized tool fields used for streaming and persistence."""
    state = part.get("state")
    if not isinstance(state, dict):
        state = {}

    state_input = state.get("input")
    if not isinstance(state_input, dict):
        state_input = {}

    metadata = state.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}

    time_data = state.get("time")
    if not isinstance(time_data, dict):
        time_data = {}

    status = state.get("status")
    if not isinstance(status, str):
        status = None

    tool_input = _coerce_tool_text(state_input) if state_input else None
    output_value = state.get("output")
    if output_value is None:
        output_value = metadata.get("output")
    tool_output = _coerce_tool_text(output_value)

    started_at = time_data.get("start") if isinstance(time_data.get("start"), (int, float)) else None
    ended_at = time_data.get("end") if isinstance(time_data.get("end"), (int, float)) else None
    duration_ms = None
    if isinstance(started_at, (int, float)) and isinstance(ended_at, (int, float)) and ended_at >= started_at:
        duration_ms = int(ended_at - started_at)

    return {
        "tool_status": status,
        "tool_input": tool_input,
        "tool_output": tool_output,
        "tool_started_at": started_at,
        "tool_ended_at": ended_at,
        "tool_duration_ms": duration_ms,
    }


class StreamPartsAccumulator:
    """
    Collect ordered message parts while preserving type transitions.

    Text/reasoning are buffered and flushed whenever we switch type/part ID or
    encounter a tool event. Tool parts are keyed by ID so state updates amend
    the original tool part.
    """

    def __init__(self):
        self._parts: list[dict[str, Any]] = []
        self._text_buffer: Optional[dict[str, Any]] = None
        self._tool_index_by_id: dict[str, int] = {}
        self._text_segment_counts: dict[str, int] = {}

    def consume(self, event: dict):
        ptype = event.get("ptype")
        if ptype in ("text", "reasoning"):
            self._consume_text_or_reasoning(event)
            return
        if ptype == "tool":
            self._flush_text_buffer()
            self._consume_tool_update(event)
            return
        if event.get("type") == "session_status":
            self._flush_text_buffer()

    def snapshot(self) -> list[dict[str, Any]]:
        parts = list(self._parts)
        if self._text_buffer and self._text_buffer.get("content"):
            parts.append({k: v for k, v in self._text_buffer.items() if k != "source_id"})
        return parts

    def finalize(self) -> list[dict[str, Any]]:
        self._flush_text_buffer()
        return list(self._parts)

    def _consume_text_or_reasoning(self, event: dict):
        delta = event.get("delta")
        if not isinstance(delta, str) or delta == "":
            return

        part_id = event.get("id")
        part_type = "thinking" if event.get("ptype") == "reasoning" else "text"
        if self._text_buffer and self._text_buffer.get("source_id") == part_id and self._text_buffer.get("type") == part_type:
            self._text_buffer["content"] += delta
            return

        self._flush_text_buffer()
        base_id = part_id if isinstance(part_id, str) and part_id else f"part_{uuid.uuid4().hex[:12]}"
        segment_index = self._text_segment_counts.get(base_id, 0)
        self._text_segment_counts[base_id] = segment_index + 1
        stored_id = base_id if segment_index == 0 else f"{base_id}#{segment_index}"
        self._text_buffer = {
            "id": stored_id,
            "source_id": base_id,
            "type": part_type,
            "content": delta,
        }

    def _consume_tool_update(self, event: dict):
        part_id = event.get("id")
        if not isinstance(part_id, str) or not part_id:
            return

        existing_index = self._tool_index_by_id.get(part_id)
        tool_name = event.get("name")
        if existing_index is None:
            self._parts.append(
                {
                    "id": part_id,
                    "type": "tool",
                    "content": "",
                    "tool_name": tool_name,
                    "tool_state": event.get("tool_status"),
                    "tool_state_raw": event.get("state"),
                    "tool_input": event.get("tool_input"),
                    "tool_output": event.get("tool_output"),
                    "tool_started_at": event.get("tool_started_at"),
                    "tool_ended_at": event.get("tool_ended_at"),
                    "tool_duration_ms": event.get("tool_duration_ms"),
                }
            )
            self._tool_index_by_id[part_id] = len(self._parts) - 1
            return

        existing_part = self._parts[existing_index]
        existing_part["tool_state"] = event.get("tool_status")
        existing_part["tool_state_raw"] = event.get("state")
        existing_part["tool_input"] = event.get("tool_input")
        existing_part["tool_output"] = event.get("tool_output")
        existing_part["tool_started_at"] = event.get("tool_started_at")
        existing_part["tool_ended_at"] = event.get("tool_ended_at")
        existing_part["tool_duration_ms"] = event.get("tool_duration_ms")
        if tool_name:
            existing_part["tool_name"] = tool_name

    def _flush_text_buffer(self):
        if not self._text_buffer:
            return
        if self._text_buffer.get("content"):
            flushed_part = {k: v for k, v in self._text_buffer.items() if k != "source_id"}
            self._parts.append(flushed_part)
        self._text_buffer = None


class ChatStreamRuntime:
    """In-memory runtime state for a single in-flight assistant response."""

    def __init__(self, session_id: str):
        self.session_id = session_id
        self.run_id = uuid.uuid4().hex[:12]
        self.status = "running"
        self.error: Optional[str] = None
        self.started_at = time.time()
        self.updated_at = self.started_at
        self.full_text = ""
        self.full_thinking = ""
        self.parts_accumulator = StreamPartsAccumulator()
        self.events: list[dict[str, Any]] = []
        self.next_sequence = 1
        self.last_persist_at = 0.0
        self.last_persist_sequence = 0
        self.subscribers: set[asyncio.Queue] = set()
        self.lock = asyncio.Lock()
        self.cleanup_task: Optional[asyncio.Task] = None

    def snapshot(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "status": self.status,
            "sequence": max(0, self.next_sequence - 1),
            "text": self.full_text,
            "thinking": self.full_thinking,
            "parts": self.parts_accumulator.snapshot(),
            "error": self.error,
            "started_at": self.started_at,
            "updated_at": self.updated_at,
        }


def _public_stream_event(event: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in event.items() if not str(k).startswith("_")}


def _persist_active_stream_snapshot(
    session_id: str,
    runtime: ChatStreamRuntime,
    *,
    force: bool = False,
) -> None:
    session = chat_sessions.get(session_id)
    if not isinstance(session, dict):
        return

    now = time.time()
    current_sequence = max(0, runtime.next_sequence - 1)
    if not force:
        if current_sequence == runtime.last_persist_sequence:
            return
        if (
            current_sequence - runtime.last_persist_sequence < STREAM_SNAPSHOT_SAVE_INTERVAL_EVENTS
            and now - runtime.last_persist_at < STREAM_SNAPSHOT_SAVE_INTERVAL_SECONDS
        ):
            return

    session["active_stream"] = runtime.snapshot()
    save_chat_state()
    runtime.last_persist_at = now
    runtime.last_persist_sequence = current_sequence


async def _append_runtime_event(runtime: ChatStreamRuntime, event: dict[str, Any]) -> dict[str, Any]:
    public_event = _public_stream_event(event)
    runtime.parts_accumulator.consume(public_event)

    if public_event.get("type") == "part_delta":
        delta = public_event.get("delta")
        if isinstance(delta, str):
            if public_event.get("ptype") == "text":
                runtime.full_text += delta
            elif public_event.get("ptype") == "reasoning":
                runtime.full_thinking += delta
    elif public_event.get("type") == "error":
        runtime.error = public_event.get("message") or "Unknown chat stream error"
        runtime.status = "failed"
    elif public_event.get("type") == "session_status" and public_event.get("status") == "idle":
        if runtime.status == "running":
            runtime.status = "completed"

    runtime.updated_at = time.time()
    async with runtime.lock:
        seq_event = {"seq": runtime.next_sequence, **public_event}
        runtime.next_sequence += 1
        runtime.events.append(seq_event)
        subscribers = list(runtime.subscribers)

    for queue in subscribers:
        try:
            queue.put_nowait(seq_event)
        except asyncio.QueueFull:
            logger.warning("Dropping chat stream event for session %s due to full subscriber queue", runtime.session_id)

    return seq_event


async def _close_runtime_subscribers(runtime: ChatStreamRuntime) -> None:
    async with runtime.lock:
        subscribers = list(runtime.subscribers)
        runtime.subscribers.clear()

    for queue in subscribers:
        try:
            queue.put_nowait(None)
        except asyncio.QueueFull:
            pass


async def _expire_runtime_after(session_id: str, runtime: ChatStreamRuntime, delay_seconds: float) -> None:
    try:
        await asyncio.sleep(delay_seconds)
    except asyncio.CancelledError:
        return

    if active_chat_streams.get(session_id) is runtime:
        active_chat_streams.pop(session_id, None)


async def _finalize_runtime(session_id: str, runtime: ChatStreamRuntime, *, retain: bool = True) -> None:
    await _close_runtime_subscribers(runtime)
    if runtime.cleanup_task and not runtime.cleanup_task.done():
        runtime.cleanup_task.cancel()
        runtime.cleanup_task = None

    if not retain:
        if active_chat_streams.get(session_id) is runtime:
            active_chat_streams.pop(session_id, None)
        return

    runtime.cleanup_task = asyncio.create_task(
        _expire_runtime_after(session_id, runtime, STREAM_RUNTIME_RETENTION_SECONDS)
    )


async def _stream_runtime_events(
    session_id: str,
    *,
    from_seq: int = 1,
    run_id: Optional[str] = None,
) -> AsyncIterator[str]:
    runtime = active_chat_streams.get(session_id)
    if runtime is None:
        yield json.dumps({"type": "session_status", "status": "idle"}) + "\n"
        return

    if run_id and runtime.run_id != run_id:
        yield json.dumps({"type": "session_status", "status": "idle"}) + "\n"
        return

    from_seq = max(1, from_seq)
    queue: asyncio.Queue = asyncio.Queue()
    subscribed = False

    async with runtime.lock:
        backlog = [event for event in runtime.events if int(event.get("seq", 0)) >= from_seq]
        done = runtime.status != "running"
        if not done:
            runtime.subscribers.add(queue)
            subscribed = True

    try:
        for event in backlog:
            yield json.dumps(event) + "\n"
            if event.get("type") == "session_status" and event.get("status") == "idle":
                return

        if done:
            return

        while True:
            item = await queue.get()
            if item is None:
                break
            if int(item.get("seq", 0)) < from_seq:
                continue
            yield json.dumps(item) + "\n"
            if item.get("type") == "session_status" and item.get("status") == "idle":
                break
    finally:
        if subscribed:
            async with runtime.lock:
                runtime.subscribers.discard(queue)


async def run_opencode_session(chat_session_id: str, opencode_session_id: str, content: str) -> tuple[str, str, list]:
    """Run a prompt and return full text, thinking, and ordered parts."""
    session = chat_sessions.get(chat_session_id)
    session_model_provider = MODEL_PROVIDER
    session_model_id = MODEL_ID
    if isinstance(session, dict):
        session_model_provider, session_model_id = get_session_model(session)

    full_text = ""
    full_thinking = ""
    parts_accumulator = StreamPartsAccumulator()
    async with httpx.AsyncClient(timeout=None) as client:
        await send_prompt_to_opencode(
            client,
            opencode_session_id,
            content,
            session_model_provider,
            session_model_id,
        )
        async for event, text_delta, thinking_delta, _tool_update in stream_opencode_events(client, opencode_session_id):
            if should_stop_session(chat_session_id):
                break
            full_text += text_delta
            full_thinking += thinking_delta
            parts_accumulator.consume(event)

    return full_text, full_thinking, parts_accumulator.finalize()


def parse_opencode_event(event_data: dict, target_session_id: str) -> Optional[dict]:
    """Parse an OpenCode SSE event and translate it to our protocol."""
    payload = event_data.get("payload", {})
    if not isinstance(payload, dict):
        return None

    etype = payload.get("type", "")
    props = payload.get("properties", {})
    if not isinstance(props, dict):
        return None
    part = props.get("part", {})
    if not isinstance(part, dict):
        part = {}
    
    session_props = props.get("session")
    if not isinstance(session_props, dict):
        session_props = {}

    event_sid = props.get("sessionID") or part.get("sessionID") or session_props.get("id")
    if event_sid != target_session_id:
        return None
    
    if etype == "message.part.updated":
        ptype = part.get("type")
        part_id = part.get("id")

        if ptype == "text":
            delta = props.get("delta")
            if not isinstance(delta, str) or delta == "":
                return None
            return {"type": "part_delta", "id": part_id, "ptype": "text", "delta": delta}
        elif ptype == "reasoning":
            delta = props.get("delta")
            if not isinstance(delta, str) or delta == "":
                return None
            return {"type": "part_delta", "id": part_id, "ptype": "reasoning", "delta": delta}
        elif ptype == "tool":
            tool_data = _extract_tool_data(part)
            return {
                "type": "part_update",
                "id": part_id,
                "ptype": "tool",
                "state": part.get("state"),
                "name": _extract_tool_name(part),
                **tool_data,
            }
    
    elif etype == "session.status":
        if props.get("status", {}).get("type") == "idle":
            return {"type": "session_status", "status": "idle", "_done": True}
    
    return None


async def stream_opencode_events(
    client: httpx.AsyncClient, session_id: str
) -> AsyncIterator[tuple[dict, str, str, Optional[dict]]]:
    """Stream parsed OpenCode events with text/thinking deltas and tool updates."""
    url = f"{OPENCODE_URL}/global/event"
    headers = {"Accept": "text/event-stream"}
    
    async with client.stream("GET", url, headers=headers, auth=get_auth()) as response:
        async for line in response.aiter_lines():
            if not line.startswith("data: "):
                continue
            
            try:
                event_data = json.loads(line[6:])
                
                # Check for error responses from OpenCode
                if "error" in event_data:
                    error_msg = event_data.get("error", "Unknown OpenCode error")
                    logger.error(f"OpenCode returned error: {error_msg}")
                    raise RuntimeError(f"OpenCode error: {error_msg}")
                
                translated = parse_opencode_event(event_data, session_id)
                if translated is None:
                    continue
                
                text_delta = ""
                thinking_delta = ""
                tool_update = None
                ptype = translated.get("ptype")
                if ptype == "text":
                    text_delta = translated.get("delta", "")
                elif ptype == "reasoning":
                    thinking_delta = translated.get("delta", "")
                elif ptype == "tool":
                    tool_update = translated
                
                yield translated, text_delta, thinking_delta, tool_update
                
                if translated.get("_done"):
                    break
            except RuntimeError:
                # Re-raise OpenCode errors
                raise
            except Exception as e:
                logger.error(f"Error parsing event line: {e}")
                continue


# =============================================================================
# Chat Endpoints
# =============================================================================

@app.get("/")
async def health():
    """Health check endpoint, or frontend index if static bundle is configured."""
    if FRONTEND_STATIC_DIR:
        index_file = os.path.join(FRONTEND_STATIC_DIR, "index.html")
        if os.path.exists(index_file):
            return FileResponse(index_file)
    return {"status": "ok", "service": "research-agent-server", "workdir": WORKDIR}


@app.get("/health")
async def health_json():
    """JSON health endpoint."""
    return {"status": "ok", "service": "research-agent-server", "workdir": WORKDIR}


# =============================================================================
# Git Diff Endpoints
# =============================================================================

GIT_DIFF_MAX_LINES_PER_FILE = 400
GIT_DIFF_DEFAULT_FILE_LIMIT = 200
GIT_FILES_DEFAULT_LIMIT = 5000
GIT_FILE_MAX_BYTES = 120000
_HUNK_HEADER_RE = re.compile(r"^@@ -(?P<old>\d+)(?:,\d+)? \+(?P<new>\d+)(?:,\d+)? @@")


def _run_git_command(args: List[str], timeout_seconds: int = 10) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", WORKDIR, *args],
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )


def _is_git_repo() -> bool:
    try:
        result = _run_git_command(["rev-parse", "--is-inside-work-tree"], timeout_seconds=5)
    except Exception:
        return False
    return result.returncode == 0 and result.stdout.strip() == "true"


def _collect_changed_files(limit: int) -> List[Dict[str, str]]:
    files_by_path: Dict[str, str] = {}

    diff_names = _run_git_command(["diff", "--name-status", "-z", "HEAD", "--"], timeout_seconds=15)
    if diff_names.returncode != 0:
        raise RuntimeError(diff_names.stderr.strip() or "Failed to list git diff files")

    tokens = [token for token in diff_names.stdout.split("\x00") if token]
    index = 0
    while index < len(tokens):
        status_token = tokens[index]
        status_code = status_token[:1] if status_token else "M"
        index += 1

        path = ""
        if status_code in {"R", "C"}:
            if index + 1 >= len(tokens):
                break
            index += 1  # Skip old path
            path = tokens[index]
            index += 1
            status_code = "M"
        else:
            if index >= len(tokens):
                break
            path = tokens[index]
            index += 1

        if not path:
            continue

        status = "modified"
        if status_code == "A":
            status = "added"
        elif status_code == "D":
            status = "deleted"
        files_by_path[path] = status

    untracked = _run_git_command(["ls-files", "--others", "--exclude-standard", "-z"], timeout_seconds=10)
    if untracked.returncode == 0:
        for path in untracked.stdout.split("\x00"):
            if path:
                files_by_path[path] = "added"

    changed = [
        {"path": path, "status": files_by_path[path]}
        for path in sorted(files_by_path.keys())
    ]
    return changed[:limit]


def _parse_unified_diff(diff_text: str, max_lines: int = GIT_DIFF_MAX_LINES_PER_FILE) -> List[Dict[str, Any]]:
    parsed: List[Dict[str, Any]] = []
    old_line: Optional[int] = None
    new_line: Optional[int] = None

    for raw_line in diff_text.splitlines():
        if raw_line.startswith(("diff --git ", "index ", "--- ", "+++ ")):
            continue

        if raw_line.startswith("Binary files "):
            parsed.append(
                {"type": "hunk", "text": "Binary file changed.", "oldLine": None, "newLine": None}
            )
            break

        if raw_line.startswith("\\ No newline at end of file"):
            continue

        if raw_line.startswith("@@"):
            match = _HUNK_HEADER_RE.match(raw_line)
            if match:
                old_line = int(match.group("old"))
                new_line = int(match.group("new"))
            else:
                old_line = None
                new_line = None

            parsed.append({"type": "hunk", "text": raw_line, "oldLine": None, "newLine": None})

        elif raw_line.startswith("+"):
            parsed.append({"type": "add", "text": raw_line[1:], "oldLine": None, "newLine": new_line})
            if new_line is not None:
                new_line += 1

        elif raw_line.startswith("-"):
            parsed.append({"type": "remove", "text": raw_line[1:], "oldLine": old_line, "newLine": None})
            if old_line is not None:
                old_line += 1

        elif raw_line.startswith(" "):
            parsed.append({"type": "context", "text": raw_line[1:], "oldLine": old_line, "newLine": new_line})
            if old_line is not None:
                old_line += 1
            if new_line is not None:
                new_line += 1

        if len(parsed) >= max_lines:
            parsed.append(
                {
                    "type": "hunk",
                    "text": f"... diff truncated to {max_lines} lines ...",
                    "oldLine": None,
                    "newLine": None,
                }
            )
            break

    return parsed


def _build_untracked_file_lines(path: str, max_lines: int = GIT_DIFF_MAX_LINES_PER_FILE) -> List[Dict[str, Any]]:
    workdir_real = os.path.realpath(WORKDIR)
    file_path = os.path.realpath(os.path.join(WORKDIR, path))

    if not (file_path == workdir_real or file_path.startswith(workdir_real + os.sep)):
        return [{"type": "hunk", "text": "Invalid path outside repository.", "oldLine": None, "newLine": None}]

    if not os.path.exists(file_path):
        return [{"type": "hunk", "text": "File not found in working tree.", "oldLine": None, "newLine": None}]

    try:
        with open(file_path, "rb") as handle:
            content = handle.read()
    except Exception as exc:
        return [{"type": "hunk", "text": f"Unable to read file: {exc}", "oldLine": None, "newLine": None}]

    if b"\x00" in content:
        return [{"type": "hunk", "text": "Binary file added.", "oldLine": None, "newLine": None}]

    lines = content.decode("utf-8", errors="replace").splitlines()
    parsed: List[Dict[str, Any]] = [
        {"type": "hunk", "text": f"@@ -0,0 +1,{len(lines)} @@", "oldLine": None, "newLine": None}
    ]

    if not lines:
        parsed.append({"type": "add", "text": "", "oldLine": None, "newLine": 1})
        return parsed

    for line_number, line_text in enumerate(lines[:max_lines], start=1):
        parsed.append({"type": "add", "text": line_text, "oldLine": None, "newLine": line_number})

    if len(lines) > max_lines:
        parsed.append(
            {
                "type": "hunk",
                "text": f"... file truncated to {max_lines} lines ...",
                "oldLine": None,
                "newLine": None,
            }
        )

    return parsed


def _build_file_diff(path: str, status: str, unified: int) -> Dict[str, Any]:
    lines: List[Dict[str, Any]] = []

    if status == "added":
        tracked_check = _run_git_command(["ls-files", "--error-unmatch", "--", path], timeout_seconds=5)
        if tracked_check.returncode == 0:
            diff_result = _run_git_command(
                ["diff", "--no-color", f"--unified={unified}", "HEAD", "--", path],
                timeout_seconds=20,
            )
            if diff_result.returncode == 0:
                lines = _parse_unified_diff(diff_result.stdout)
            else:
                lines = [{"type": "hunk", "text": "Unable to render file diff.", "oldLine": None, "newLine": None}]
        else:
            lines = _build_untracked_file_lines(path)
    else:
        diff_result = _run_git_command(
            ["diff", "--no-color", f"--unified={unified}", "HEAD", "--", path],
            timeout_seconds=20,
        )
        if diff_result.returncode == 0:
            lines = _parse_unified_diff(diff_result.stdout)
        else:
            lines = [{"type": "hunk", "text": "Unable to render file diff.", "oldLine": None, "newLine": None}]

    if not lines:
        if status == "deleted":
            lines = [{"type": "hunk", "text": "File deleted with no textual hunks.", "oldLine": None, "newLine": None}]
        elif status == "added":
            lines = [{"type": "hunk", "text": "New file with no textual content.", "oldLine": None, "newLine": None}]
        else:
            lines = [{"type": "hunk", "text": "No textual diff available.", "oldLine": None, "newLine": None}]

    additions = sum(1 for line in lines if line.get("type") == "add")
    deletions = sum(1 for line in lines if line.get("type") == "remove")

    return {
        "path": path,
        "status": status,
        "additions": additions,
        "deletions": deletions,
        "lines": lines,
    }


def _resolve_repo_path(relative_path: str) -> Optional[str]:
    """Resolve repository-relative file path and block traversal outside WORKDIR."""
    if not relative_path:
        return None

    normalized = relative_path.strip().replace("\\", "/")
    if normalized.startswith("/") or normalized.startswith("../") or "/../" in normalized:
        return None

    repo_root = os.path.realpath(WORKDIR)
    target = os.path.realpath(os.path.join(WORKDIR, normalized))

    if target == repo_root or target.startswith(repo_root + os.sep):
        return target
    return None


@app.get("/git/diff")
async def get_repo_diff(
    unified: int = Query(3, ge=0, le=12, description="Unified context lines per diff hunk"),
    limit: int = Query(GIT_DIFF_DEFAULT_FILE_LIMIT, ge=1, le=500, description="Maximum number of files to return"),
):
    """Return the repository diff for changed files in the current workdir."""
    if not _is_git_repo():
        return {"repo_path": WORKDIR, "head": None, "files": []}

    head_result = _run_git_command(["rev-parse", "--short", "HEAD"], timeout_seconds=5)
    head = head_result.stdout.strip() if head_result.returncode == 0 else None

    try:
        changed_files = _collect_changed_files(limit)
    except Exception as exc:
        logger.error(f"Failed to collect git diff files: {exc}")
        raise HTTPException(status_code=500, detail="Failed to load repository diff")

    files = [_build_file_diff(item["path"], item["status"], unified) for item in changed_files]
    return {"repo_path": WORKDIR, "head": head, "files": files}


@app.get("/git/files")
async def get_repo_files(
    limit: int = Query(GIT_FILES_DEFAULT_LIMIT, ge=1, le=20000, description="Maximum number of files to return"),
):
    """Return repository files for file explorer mode."""
    if not _is_git_repo():
        return {"repo_path": WORKDIR, "files": []}

    files_result = _run_git_command(
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        timeout_seconds=20,
    )
    if files_result.returncode != 0:
        logger.error(f"Failed to list git files: {files_result.stderr.strip()}")
        raise HTTPException(status_code=500, detail="Failed to list repository files")

    files = sorted({path for path in files_result.stdout.split("\x00") if path})
    return {"repo_path": WORKDIR, "files": files[:limit]}


@app.get("/git/file")
async def get_repo_file(
    path: str = Query(..., description="Repository-relative file path"),
    max_bytes: int = Query(
        GIT_FILE_MAX_BYTES,
        ge=1024,
        le=500000,
        description="Maximum bytes to read",
    ),
):
    """Return text content for a repository file."""
    if not _is_git_repo():
        raise HTTPException(status_code=404, detail="Not a git repository")

    resolved = _resolve_repo_path(path)
    if not resolved:
        raise HTTPException(status_code=400, detail="Invalid file path")

    if not os.path.exists(resolved):
        raise HTTPException(status_code=404, detail="File not found")
    if os.path.isdir(resolved):
        raise HTTPException(status_code=400, detail="Path is a directory")

    try:
        with open(resolved, "rb") as handle:
            data = handle.read(max_bytes + 1)
    except Exception as exc:
        logger.error(f"Failed to read file {path}: {exc}")
        raise HTTPException(status_code=500, detail="Failed to read file")

    truncated = len(data) > max_bytes
    if truncated:
        data = data[:max_bytes]

    if b"\x00" in data:
        return {"path": path, "content": "", "binary": True, "truncated": truncated}

    return {
        "path": path,
        "content": data.decode("utf-8", errors="replace"),
        "binary": False,
        "truncated": truncated,
    }


@app.get("/sessions")
async def list_sessions():
    """List all chat sessions."""
    def resolve_session_status(session_id: str, session: dict[str, Any]) -> str:
        has_pending_human_input = any(
            alert.get("status") == "pending" and alert.get("session_id") == session_id
            for alert in active_alerts.values()
        )
        if has_pending_human_input:
            return "awaiting_human"

        runtime = active_chat_streams.get(session_id)
        if runtime and runtime.status == "running":
            return "running"

        raw_status = (runtime.status if runtime else None) or session.get("last_status")
        if raw_status in {"failed", "error"}:
            return "failed"
        if raw_status in {"stopped", "interrupted"}:
            return "questionable"
        if session.get("messages"):
            return "completed"
        return "idle"

    sessions = []
    for sid, session in chat_sessions.items():
        if not isinstance(session, dict):
            continue
        session_model_provider, session_model_id = get_session_model(session)
        sessions.append({
            "id": sid,
            "title": session.get("title", "New Chat"),
            "created_at": session.get("created_at"),
            "message_count": len(session.get("messages", [])),
            "model_provider": session_model_provider,
            "model_id": session_model_id,
            "status": resolve_session_status(sid, session),
        })
    sessions.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return sessions


@app.get("/models")
async def list_models():
    """List available model options from opencode config."""
    return load_available_opencode_models()


@app.post("/sessions")
async def create_session(req: Optional[CreateSessionRequest] = None):
    """Create a new chat session."""
    requested_provider = req.model_provider if req else None
    requested_model_id = req.model_id if req else None
    session_model_provider = str(requested_provider or MODEL_PROVIDER).strip() or MODEL_PROVIDER
    session_model_id = str(requested_model_id or MODEL_ID).strip() or MODEL_ID
    session_id = uuid.uuid4().hex[:12]
    title = req.title if req and req.title else "New Chat"
    chat_sessions[session_id] = {
        "title": title,
        "created_at": time.time(),
        "messages": [],
        "opencode_session_id": None,
        "system_prompt": "",
        "model_provider": session_model_provider,
        "model_id": session_model_id,
        "last_status": "idle",
    }
    save_chat_state()
    return {
        "id": session_id,
        "title": title,
        "created_at": chat_sessions[session_id]["created_at"],
        "message_count": 0,
        "model_provider": session_model_provider,
        "model_id": session_model_id,
        "status": "idle",
    }


@app.get("/sessions/{session_id}")
async def get_session(session_id: str):
    """Get a chat session with all messages."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    session = chat_sessions[session_id]
    session_model_provider, session_model_id = get_session_model(session)
    runtime = active_chat_streams.get(session_id)
    active_stream = runtime.snapshot() if runtime and runtime.status == "running" else session.get("active_stream")
    return {
        "id": session_id,
        "title": session.get("title", "New Chat"),
        "created_at": session.get("created_at"),
        "messages": session.get("messages", []),
        "system_prompt": session.get("system_prompt", ""),
        "model_provider": session_model_provider,
        "model_id": session_model_id,
        "active_stream": active_stream,
    }


@app.patch("/sessions/{session_id}")
async def update_session(session_id: str, req: UpdateSessionRequest):
    """Update a chat session (e.g. rename)."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    chat_sessions[session_id]["title"] = req.title
    save_chat_state()
    session = chat_sessions[session_id]
    session_model_provider, session_model_id = get_session_model(session)
    return {
        "id": session_id,
        "title": session.get("title", "New Chat"),
        "created_at": session.get("created_at"),
        "message_count": len(session.get("messages", [])),
        "model_provider": session_model_provider,
        "model_id": session_model_id,
    }


@app.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    """Delete a chat session."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    del chat_sessions[session_id]
    save_chat_state()
    return {"message": "Session deleted"}


@app.get("/sessions/{session_id}/system-prompt")
async def get_system_prompt(session_id: str):
    """Get the system prompt for a chat session."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"system_prompt": chat_sessions[session_id].get("system_prompt", "")}


@app.get("/sessions/{session_id}/model")
async def get_session_model_endpoint(session_id: str):
    """Get the provider/model configured for this session."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    session = chat_sessions[session_id]
    if not isinstance(session, dict):
        raise HTTPException(status_code=500, detail="Session data is invalid")
    provider_id, model_id = get_session_model(session)
    return {"provider_id": provider_id, "model_id": model_id}


@app.put("/sessions/{session_id}/model")
async def update_session_model(session_id: str, req: SessionModelUpdate):
    """Update provider/model for subsequent prompts in a chat session."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    provider_id = str(req.provider_id or "").strip()
    model_id = str(req.model_id or "").strip()
    if not provider_id or not model_id:
        raise HTTPException(status_code=400, detail="provider_id and model_id are required")

    session = chat_sessions[session_id]
    if not isinstance(session, dict):
        raise HTTPException(status_code=500, detail="Session data is invalid")
    session["model_provider"] = provider_id
    session["model_id"] = model_id
    save_chat_state()
    return {"provider_id": provider_id, "model_id": model_id}


@app.put("/sessions/{session_id}/system-prompt")
async def update_system_prompt(session_id: str, req: SystemPromptUpdate):
    """Update the system prompt for a chat session."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    chat_sessions[session_id]["system_prompt"] = req.system_prompt
    save_chat_state()
    return {"system_prompt": req.system_prompt}


# ---------------------------------------------------------------------------
# Mode Registry: data-driven prompt builder
# ---------------------------------------------------------------------------

@dataclass
class ModeConfig:
    """Declares how to build a mode-specific prompt preamble."""
    skill_id: str
    build_state: Callable[[str], dict]  # (message) -> template variables


def _build_plan_state(message: str) -> dict:
    """Build template variables for plan mode."""
    # Summarize existing plans for context
    existing_plans_summary = "No existing plans."
    if plans:
        lines = []
        for p in sorted(plans.values(), key=lambda x: x.get("created_at", 0), reverse=True)[:5]:
            lines.append(f"- **{p.get('title', 'Untitled')}** ({p.get('status', 'draft')}): {p.get('goal', '')[:100]}")
        existing_plans_summary = "\n".join(lines)
    return {
        "goal": message,
        "experiment_context": _build_experiment_context(),
        "existing_plans": existing_plans_summary,
        "server_url": SERVER_CALLBACK_URL,
        "auth_token": USER_AUTH_TOKEN or "",
    }


# NOTE: wild mode uses build_wild_prompt() from wild_loop module directly,
# because it has its own iteration/sweep/condition logic. We register it
# with a special sentinel so the generic path delegates correctly.
_WILD_SENTINEL = "__wild__"

MODE_REGISTRY: Dict[str, ModeConfig] = {
    "plan": ModeConfig(skill_id="ra_mode_plan", build_state=_build_plan_state),
    "wild": ModeConfig(skill_id=_WILD_SENTINEL, build_state=lambda _msg: {}),
}


def _build_chat_prompt(session: dict, message: str, mode: str = "agent") -> tuple:
    """Build the full prompt for a chat turn, prepending mode-specific preamble.

    Returns (content: str, provenance: dict | None).
    provenance follows the PromptProvenance shape used by the frontend.
    """
    mode_note = ""
    provenance = None

    config = MODE_REGISTRY.get(mode)
    if config:
        if config.skill_id == _WILD_SENTINEL:
            # Delegate to wild_loop module
            experiment_context = _build_experiment_context()
            mode_note = build_wild_prompt(prompt_skill_manager.render, experiment_context, server_url=SERVER_CALLBACK_URL, auth_token=USER_AUTH_TOKEN or "")
            # Wild mode provenance is handled by the frontend's wild loop
        else:
            variables = config.build_state(message)
            skill = prompt_skill_manager.get(config.skill_id)
            rendered = prompt_skill_manager.render(config.skill_id, variables)
            if rendered:
                mode_note = rendered + "\n\n"
                provenance = {
                    "rendered": rendered,
                    "user_input": message,
                    "skill_id": config.skill_id,
                    "skill_name": skill.get("name", config.skill_id) if skill else config.skill_id,
                    "template": skill.get("template") if skill else None,
                    "variables": variables,
                    "prompt_type": mode,
                }
            else:
                logger.warning(f"{config.skill_id} prompt skill not found — sending raw message")

    # For agent mode (no config / no skill), build a simple provenance
    if provenance is None and mode != "wild":
        provenance = {
            "rendered": message,
            "user_input": message,
            "skill_id": None,
            "skill_name": None,
            "template": None,
            "variables": {},
            "prompt_type": mode,
        }

    content = f"{mode_note}[USER] {message}"
    session_system_prompt = str(session.get("system_prompt", "")).strip()
    if session_system_prompt:
        content = f"[SYSTEM INSTRUCTIONS]\n{session_system_prompt}\n[/SYSTEM INSTRUCTIONS]\n\n{content}"
    return content, provenance


def _log_background_chat_task(task: asyncio.Task) -> None:
    try:
        exc = task.exception()
    except asyncio.CancelledError:
        return
    except Exception:
        logger.exception("Failed to inspect background chat task")
        return

    if exc:
        logger.error("Background chat worker failed: %s", exc, exc_info=(type(exc), exc, exc.__traceback__))



async def _chat_worker(session_id: str, content: str, runtime: ChatStreamRuntime, *, mode: str = "agent") -> None:
    """Run the OpenCode stream for a chat session independent of HTTP clients."""
    session_stop_flags.pop(session_id, None)
    logger.debug("Starting background chat worker for session %s run %s (mode=%s)", session_id, runtime.run_id, mode)

    try:
        session = chat_sessions.get(session_id)
        session_model_provider = MODEL_PROVIDER
        session_model_id = MODEL_ID
        if isinstance(session, dict):
            session_model_provider, session_model_id = get_session_model(session)

        opencode_session_id = await get_opencode_session_for_chat(session_id)
        async with httpx.AsyncClient(timeout=None) as client:
            logger.debug("Sending prompt to OpenCode session %s", opencode_session_id)
            logger.debug("Content: %s", content)
            await send_prompt_to_opencode(
                client,
                opencode_session_id,
                content,
                session_model_provider,
                session_model_id,
            )
            logger.debug("Sent prompt to OpenCode session %s", opencode_session_id)

            async for event, _text_delta, _thinking_delta, _tool_update in stream_opencode_events(client, opencode_session_id):
                if should_stop_session(session_id):
                    runtime.status = "stopped"
                    break

                await _append_runtime_event(runtime, event)
                _persist_active_stream_snapshot(session_id, runtime)

        if should_stop_session(session_id):
            runtime.status = "stopped"
    except asyncio.CancelledError:
        runtime.status = "stopped"
        logger.info("Background chat worker cancelled for session %s", session_id)
    except Exception as e:
        runtime.status = "failed"
        runtime.error = str(e)
        logger.error("Chat worker failed for session %s: %s", session_id, e, exc_info=True)
        await _append_runtime_event(runtime, {"type": "error", "message": str(e)})
    finally:
        parts = runtime.parts_accumulator.finalize()
        if runtime.full_text or runtime.full_thinking or parts:
            session = chat_sessions.get(session_id)
            if isinstance(session, dict):
                # Keep ALL parts (including text) to preserve the interleaved
                # order of text, thinking, and tool outputs.  The 'content'
                # and 'thinking' fields are convenience aggregates.
                assistant_msg = {
                    "role": "assistant",
                    "content": runtime.full_text.strip(),
                    "thinking": runtime.full_thinking.strip() if runtime.full_thinking else None,
                    "parts": parts if parts else None,
                    "timestamp": time.time(),
                }
                session.setdefault("messages", []).append(assistant_msg)


        # Auto-name: fetch title from OpenCode only once (after the first exchange)
        session = chat_sessions.get(session_id)
        if isinstance(session, dict) and not session.get("title"):
            opencode_sid = session.get("opencode_session_id")
            if opencode_sid:
                oc_title = await fetch_opencode_session_title(opencode_sid)
                if oc_title:
                    session["title"] = oc_title
                    logger.info("Auto-named chat %s from OpenCode: %s", session_id, oc_title)

        session = chat_sessions.get(session_id)
        if isinstance(session, dict):
            session["last_status"] = runtime.status
            session["last_error"] = runtime.error
            session.pop("active_stream", None)
        save_chat_state()

        await _append_runtime_event(runtime, {"type": "session_status", "status": "idle"})
        await _finalize_runtime(session_id, runtime)

        active_chat_tasks.pop(session_id, None)
        session_stop_flags.pop(session_id, None)
        logger.debug("Background chat worker finished for session %s run %s", session_id, runtime.run_id)


async def _start_chat_worker(session_id: str, content: str, mode: str = "agent") -> ChatStreamRuntime:
    existing = active_chat_streams.get(session_id)
    if existing and existing.status == "running":
        raise HTTPException(status_code=409, detail="Session already has an active response")
    if existing:
        await _finalize_runtime(session_id, existing, retain=False)

    runtime = ChatStreamRuntime(session_id)
    active_chat_streams[session_id] = runtime
    _persist_active_stream_snapshot(session_id, runtime, force=True)

    task = asyncio.create_task(_chat_worker(session_id, content, runtime, mode=mode))
    active_chat_tasks[session_id] = task
    task.add_done_callback(_log_background_chat_task)
    return runtime


async def _send_chat_for_v2(chat_session_id: str, prompt: str, display_message: str) -> str:
    """Route a V2 iteration through the frontend's chat session for live streaming.

    1. Adds a user message to the chat session (so the frontend shows the iteration)
    2. Starts the chat worker (which streams the response via SSE)
    3. Waits for completion
    4. Returns the full response text

    This is the callback passed to WildV2Engine.send_chat_message.
    """
    logger.info("[wild-v2-chat] _send_chat_for_v2 called: session=%s, prompt_len=%d, display=%s",
                chat_session_id, len(prompt), display_message)

    if chat_session_id not in chat_sessions:
        logger.error("[wild-v2-chat] Chat session %s not found!", chat_session_id)
        raise ValueError(f"Chat session {chat_session_id} not found")

    session = chat_sessions[chat_session_id]

    # Check if there's already an active stream on this session
    existing_runtime = active_chat_streams.get(chat_session_id)
    if existing_runtime and existing_runtime.status == "running":
        logger.warning("[wild-v2-chat] Session %s already has an active stream (run=%s), waiting for it to finish...",
                       chat_session_id, existing_runtime.run_id)
        # Wait for the existing task to complete before starting a new one
        existing_task = active_chat_tasks.get(chat_session_id)
        if existing_task:
            try:
                await existing_task
                logger.info("[wild-v2-chat] Previous task finished, proceeding")
            except Exception:
                logger.warning("[wild-v2-chat] Previous task failed, proceeding anyway")

    # Add user message showing the iteration context
    user_msg = {
        "role": "user",
        "content": display_message,
        "timestamp": time.time(),
        "wild_v2": True,
    }
    session.setdefault("messages", []).append(user_msg)
    save_chat_state()
    logger.debug("[wild-v2-chat] Added user message to chat session")

    # Start the chat worker — this sends the full prompt to OpenCode and streams
    # the response via SSE, so the frontend picks it up live
    logger.info("[wild-v2-chat] Starting chat worker for session %s", chat_session_id)
    runtime = await _start_chat_worker(chat_session_id, prompt, mode="agent")
    logger.info("[wild-v2-chat] Chat worker started: run_id=%s", runtime.run_id)

    # Wait for the background task to finish
    task = active_chat_tasks.get(chat_session_id)
    if task:
        logger.info("[wild-v2-chat] Waiting for chat worker task to complete...")
        try:
            await task
            logger.info("[wild-v2-chat] Chat worker task completed successfully")
        except Exception as err:
            logger.error("[wild-v2-chat] Chat worker task failed: %s", err, exc_info=True)
    else:
        logger.warning("[wild-v2-chat] No task found in active_chat_tasks for session %s", chat_session_id)

    full_text = runtime.full_text or ""
    logger.info("[wild-v2-chat] Got %d chars from chat session %s (status=%s)",
                len(full_text), chat_session_id, runtime.status)
    return full_text


# Wire the chat streaming callback into the V2 engine
wild_v2_engine._send_chat_message = _send_chat_for_v2


@app.get("/sessions/{session_id}/stream")
async def stream_session(session_id: str, from_seq: int = Query(1, ge=1), run_id: Optional[str] = Query(None)):
    """Attach/re-attach to an in-flight chat stream with catch-up replay."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    return StreamingResponse(
        _stream_runtime_events(session_id, from_seq=from_seq, run_id=run_id),
        media_type="application/x-ndjson",
    )


@app.post("/chat")
async def chat_endpoint(req: ChatRequest):
    """Send a message, start background generation, and attach to the stream."""
    session_id = req.session_id

    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    existing_runtime = active_chat_streams.get(session_id)
    if existing_runtime and existing_runtime.status == "running":
        raise HTTPException(status_code=409, detail="Session already has an active response")

    session = chat_sessions[session_id]
    messages = session.get("messages", [])

    user_msg = {"role": "user", "content": req.message, "timestamp": time.time()}
    messages.append(user_msg)
    session["messages"] = messages

    if session.get("title") == "New Chat" and len(messages) == 1:
        session["title"] = req.message[:50] + ("..." if len(req.message) > 50 else "")

    save_chat_state()

    # Resolve mode: prefer explicit mode field, fall back to legacy booleans
    effective_mode = req.mode
    if effective_mode == "agent":
        if req.wild_mode:
            effective_mode = "wild"
        elif req.plan_mode:
            effective_mode = "plan"
    llm_input = req.prompt_override if req.prompt_override else req.message
    content, provenance = _build_chat_prompt(session, llm_input, effective_mode)
    runtime = await _start_chat_worker(session_id, content, mode=effective_mode)

    # Emit provenance as the first SSE event so the frontend can attach it
    if provenance:
        await _append_runtime_event(runtime, {"type": "provenance", **provenance})

    return StreamingResponse(
        _stream_runtime_events(session_id, from_seq=1, run_id=runtime.run_id),
        media_type="application/x-ndjson",
    )


@app.post("/sessions/{session_id}/stop")
async def stop_session(session_id: str):
    """Stop streaming for a session (including auto-alert tasks)."""
    if session_id not in chat_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session_stop_flags[session_id] = True
    runtime = active_chat_streams.get(session_id)
    if runtime and runtime.status == "running":
        runtime.status = "stopped"
        _persist_active_stream_snapshot(session_id, runtime, force=True)

    task = active_chat_tasks.get(session_id)
    # For legacy/auto-alert tasks we still cancel directly. Chat workers stop via flag + abort call below.
    if task and not task.done() and runtime is None:
        task.cancel()

    # Also abort the OpenCode session so the model actually stops generating
    opencode_session_id = chat_sessions[session_id].get("opencode_session_id")
    if opencode_session_id:
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.post(
                    f"{OPENCODE_URL}/session/{opencode_session_id}/abort",
                    auth=get_auth()
                )
                logger.info(f"Aborted OpenCode session {opencode_session_id}: {resp.status_code}")
        except Exception as e:
            logger.warning(f"Failed to abort OpenCode session {opencode_session_id}: {e}")

    return {"message": "Stop signal sent"}


# =============================================================================
# Run Endpoints
# =============================================================================

@app.get("/runs")
async def list_runs(
    archived: bool = Query(False, description="Include archived runs"),
    limit: int = Query(100, description="Max runs to return")
):
    """List all runs."""
    _reconcile_all_run_terminal_states()
    result = []
    for run_id, run in runs.items():
        if not archived and run.get("is_archived", False):
            continue
        result.append(_run_response_payload(run_id, run))
    
    # Sort by created_at descending
    result.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return result[:limit]


@app.post("/runs")
async def create_run(req: RunCreate):
    """Create a new run. Starts in 'ready' state unless auto_start=True."""
    run_id = uuid.uuid4().hex[:12]

    if req.sweep_id and req.sweep_id not in sweeps:
        raise HTTPException(status_code=404, detail=f"Sweep not found: {req.sweep_id}")
    
    initial_status = "queued" if req.auto_start else "ready"
    
    run_data = {
        "name": req.name,
        "command": req.command,
        "workdir": req.workdir or WORKDIR,
        "status": initial_status,
        "created_at": time.time(),
        "is_archived": False,
        "sweep_id": req.sweep_id,
        "parent_run_id": req.parent_run_id,
        "origin_alert_id": req.origin_alert_id,
        "chat_session_id": req.chat_session_id,
        "tmux_window": None,
        "run_dir": None,
        "exit_code": None,
        "error": None,
        "wandb_dir": None,
    }
    
    runs[run_id] = run_data
    _sync_run_membership_with_sweep(run_id, req.sweep_id)
    save_runs_state()
    
    record_created_entity("run", run_id, chat_session_id=req.chat_session_id)
    logger.info(f"Created run {run_id}: {req.name} (status: {initial_status})")

    # If auto_start is requested, actually launch the run in tmux
    if initial_status == "queued":
        try:
            launch_run_in_tmux(run_id, run_data)
            if run_data.get("sweep_id"):
                recompute_sweep_state(run_data["sweep_id"])
            save_runs_state()
        except Exception as e:
            logger.error(f"Failed to auto-start run {run_id}: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    return _run_response_payload(run_id, run_data)


@app.get("/runs/{run_id}")
async def get_run(run_id: str):
    """Get run details."""
    _reconcile_all_run_terminal_states()
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    return _run_response_payload(run_id, runs[run_id])


@app.put("/runs/{run_id}")
async def update_run(run_id: str, req: RunUpdate):
    """Update mutable run fields."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")

    run = runs[run_id]
    current_status = str(run.get("status", "")).strip().lower()

    if req.command is not None:
        next_command = req.command.strip()
        if not next_command:
            raise HTTPException(status_code=400, detail="Run command cannot be empty")
        if current_status in {"launching", "running"} and next_command != str(run.get("command", "")).strip():
            raise HTTPException(
                status_code=409,
                detail="Cannot edit command while run is active. Stop the run first.",
            )
        run["command"] = next_command

    if req.name is not None:
        next_name = req.name.strip()
        if not next_name:
            raise HTTPException(status_code=400, detail="Run name cannot be empty")
        run["name"] = next_name

    if req.workdir is not None:
        next_workdir = req.workdir.strip()
        if not next_workdir:
            raise HTTPException(status_code=400, detail="Run workdir cannot be empty")
        run["workdir"] = next_workdir

    save_runs_state()
    return _run_response_payload(run_id, run)


@app.post("/runs/{run_id}/queue")
async def queue_run(run_id: str):
    """Queue a ready run for execution."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    
    run = runs[run_id]
    if run["status"] != "ready":
        raise HTTPException(status_code=400, detail=f"Run is not ready (status: {run['status']})")
    
    run["status"] = "queued"
    run["queued_at"] = time.time()
    if run.get("sweep_id"):
        recompute_sweep_state(run["sweep_id"])
    save_runs_state()
    
    return {"message": "Run queued", "id": run_id, **run}


@app.post("/runs/{run_id}/start")
async def start_run(run_id: str):
    """Start a queued run."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    
    run = runs[run_id]
    if run["status"] not in ["queued", "ready"]:
        raise HTTPException(status_code=400, detail=f"Run cannot be started (status: {run['status']})")
    
    # If ready, move to queued first
    if run["status"] == "ready":
        run["status"] = "queued"
        run["queued_at"] = time.time()
    
    try:
        tmux_window = launch_run_in_tmux(run_id, run)
        if run.get("sweep_id"):
            recompute_sweep_state(run["sweep_id"])
        save_runs_state()
        return {"message": "Run started", "tmux_window": tmux_window}
    except Exception as e:
        logger.error(f"Failed to start run {run_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/runs/{run_id}/stop")
async def stop_run(run_id: str):
    """Stop a running job."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    
    run = runs[run_id]
    if run["status"] not in ["launching", "running"]:
        raise HTTPException(status_code=400, detail=f"Run is not active (status: {run['status']})")
    
    # Kill tmux window
    tmux_window = run.get("tmux_window")
    if tmux_window:
        session = get_or_create_session()
        if session:
            window = session.windows.get(window_name=tmux_window, default=None)
            if window:
                window.kill()
                logger.info(f"Killed tmux window {tmux_window}")
    
    run["status"] = "stopped"
    run["stopped_at"] = time.time()
    if run.get("sweep_id"):
        recompute_sweep_state(run["sweep_id"])
    save_runs_state()
    
    return {"message": "Run stopped"}


@app.post("/runs/{run_id}/rerun")
async def rerun_run(run_id: str, req: Optional[RunRerunRequest] = None):
    """Create a new run based on an existing run."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")

    source_run = runs[run_id]
    new_command = req.command if req and req.command else source_run.get("command")
    if not new_command:
        raise HTTPException(status_code=400, detail="Command is required for rerun")

    new_run_id = uuid.uuid4().hex[:12]
    initial_status = "queued" if req and req.auto_start else "ready"

    new_run = {
        "name": f"{source_run.get('name', 'Run')} (Rerun)",
        "command": new_command,
        "workdir": source_run.get("workdir") or WORKDIR,
        "status": initial_status,
        "created_at": time.time(),
        "is_archived": False,
        "sweep_id": source_run.get("sweep_id"),
        "parent_run_id": run_id,
        "origin_alert_id": req.origin_alert_id if req else None,
        "tmux_window": None,
        "run_dir": None,
        "exit_code": None,
        "error": None,
        "wandb_dir": None,
    }

    runs[new_run_id] = new_run
    _sync_run_membership_with_sweep(new_run_id, new_run.get("sweep_id"))
    save_runs_state()

    if initial_status == "queued":
        try:
            launch_run_in_tmux(new_run_id, new_run)
            if new_run.get("sweep_id"):
                recompute_sweep_state(new_run["sweep_id"])
            save_runs_state()
        except Exception as e:
            logger.error(f"Failed to launch rerun {new_run_id}: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    return {"id": new_run_id, **new_run}


@app.post("/runs/{run_id}/archive")
async def archive_run(run_id: str):
    """Archive a run."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    
    runs[run_id]["is_archived"] = True
    runs[run_id]["archived_at"] = time.time()
    save_runs_state()
    return {"message": "Run archived", "run": {"id": run_id, **runs[run_id]}}


@app.post("/runs/{run_id}/unarchive")
async def unarchive_run(run_id: str):
    """Unarchive a run."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    
    runs[run_id]["is_archived"] = False
    runs[run_id].pop("archived_at", None)
    save_runs_state()
    return {"message": "Run unarchived", "run": {"id": run_id, **runs[run_id]}}


@app.post("/runs/{run_id}/status")
async def update_run_status(run_id: str, update: RunStatusUpdate):
    """Update run status (called by sidecar)."""
    logger.info(f"Status update for {run_id}: {update.status}")
    
    if run_id not in runs:
        # Create minimal entry if doesn't exist
        runs[run_id] = {"created_at": time.time()}
    
    run = runs[run_id]
    
    # Update fields
    next_status = update.status.strip().lower()
    if update.exit_code is not None:
        run["exit_code"] = _coerce_exit_code(update.exit_code)
    if update.error:
        run["error"] = update.error
    if update.tmux_pane:
        run["tmux_pane"] = update.tmux_pane
    if update.wandb_dir:
        run["wandb_dir"] = update.wandb_dir

    effective_exit_code = _coerce_exit_code(run.get("exit_code"))
    if run.get("exit_code") != effective_exit_code:
        run["exit_code"] = effective_exit_code

    if next_status == "finished" and effective_exit_code not in (None, 0):
        next_status = "failed"
        if not run.get("error"):
            run["error"] = f"Process exited with code {effective_exit_code}"

    run["status"] = next_status
    
    # Track timestamps
    if next_status == "running" and not run.get("started_at"):
        run["started_at"] = time.time()
    elif next_status in RUN_STATUS_TERMINAL:
        run["ended_at"] = time.time()

    # Auto-enqueue wild event on terminal run status (delegated to wild_loop module)
    auto_enqueue_run_terminal(
        run_id=run_id, run_name=run.get("name", run_id),
        status=next_status, exit_code=run.get("exit_code"), error=run.get("error"),
    )

    if run.get("sweep_id"):
        recompute_sweep_state(run["sweep_id"])
    save_runs_state()
    return {"message": "Status updated"}


@app.post("/runs/{run_id}/alerts")
async def create_alert(run_id: str, req: CreateAlertRequest):
    """Create a new alert for a run (called by sidecar)."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")

    if not req.choices:
        raise HTTPException(status_code=400, detail="At least one choice is required")

    severity = (req.severity or "warning").strip().lower()
    if severity not in ["info", "warning", "critical"]:
        severity = "warning"

    alert_id = uuid.uuid4().hex
    alert = AlertRecord(
        id=alert_id,
        run_id=run_id,
        timestamp=time.time(),
        severity=severity,
        message=req.message,
        choices=req.choices,
        status="pending",
    )

    alert_payload = alert.model_dump()

    # Auto-enqueue wild event for this alert (delegated to wild_loop module)
    auto_enqueue_alert(
        alert_id=alert_id, run_id=run_id,
        run_name=runs[run_id].get("name", run_id),
        severity=severity, message=req.message, choices=req.choices,
    )

    if wild_loop_mod.wild_mode_enabled:
        session_id = uuid.uuid4().hex[:12]
        chat_sessions[session_id] = {
            "title": f"Alert: {runs[run_id].get('name', run_id)}",
            "created_at": time.time(),
            "messages": [],
            "opencode_session_id": None,
            "system_prompt": "",
            "model_provider": MODEL_PROVIDER,
            "model_id": MODEL_ID,
        }
        alert_payload["session_id"] = session_id
        alert_payload["auto_session"] = True
        save_chat_state()

        async def auto_alert_chat():
            active_chat_tasks[session_id] = asyncio.current_task()
            session_stop_flags.pop(session_id, None)
            try:
                run_data = runs.get(run_id, {})
                user_visible_message = (
                    f"Resolve alert {alert_id} for {run_data.get('name', run_id)}. "
                    f"Severity: {severity}. Message: {req.message}"
                )
                prompt = (
                    "[SYSTEM] Wild mode is ON. Be proactive and resolve the alert if safe.\n"
                    "You are handling an experiment alert. Provide a concise diagnosis, "
                    "suggest actions, and propose a response from the allowed choices.\n\n"
                    f"[USER] Alert ID: {alert_id}\n"
                    f"Run: {run_data.get('name', run_id)}\n"
                    f"Command: {run_data.get('command', '')}\n"
                    f"Severity: {severity}\n"
                    f"Message: {req.message}\n"
                    f"Choices: {', '.join(req.choices)}\n"
                    "If a rerun is needed, explain why and what you would change."
                )

                user_msg = {"role": "user", "content": user_visible_message, "timestamp": time.time()}
                chat_sessions[session_id]["messages"].append(user_msg)
                save_chat_state()

                opencode_session_id = await get_opencode_session_for_chat(session_id)
                full_text, full_thinking, parts = await run_opencode_session(session_id, opencode_session_id, prompt)
                if full_text or full_thinking or parts:
                    assistant_msg = {
                        "role": "assistant",
                        "content": full_text.strip(),
                        "thinking": full_thinking.strip() if full_thinking else None,
                        "parts": parts if parts else None,
                        "timestamp": time.time()
                    }
                    chat_sessions[session_id]["messages"].append(assistant_msg)
                    save_chat_state()
            except asyncio.CancelledError:
                logger.info("Auto alert chat cancelled for session %s", session_id)
            except Exception as e:
                # Log error and store an error message in the session so users can see what went wrong
                logger.error(f"Auto alert chat failed for session {session_id}: {e}", exc_info=True)
                error_msg = {
                    "role": "assistant",
                    "content": f"[Error] Failed to process alert automatically: {str(e)}",
                    "timestamp": time.time()
                }
                chat_sessions[session_id]["messages"].append(error_msg)
                save_chat_state()
            finally:
                active_chat_tasks.pop(session_id, None)
                session_stop_flags.pop(session_id, None)

        asyncio.create_task(auto_alert_chat())

    active_alerts[alert_id] = alert_payload
    save_alerts_state()
    logger.info(f"Created alert {alert_id} for run {run_id}: {req.message}")
    return {"alert_id": alert_id}


# ---- Metrics Endpoints (sidecar-pushed) ----

@app.post("/runs/{run_id}/metrics")
async def post_run_metrics(run_id: str, request: Request):
    """Accept metrics rows from the sidecar and append to stored metrics file.

    Body should be JSON with a 'rows' array of metric dictionaries, e.g.:
    {"rows": [{"step": 1, "train/loss": 0.5, "accuracy": 0.6}, ...]}
    """
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")

    body = await request.json()
    rows = body.get("rows", [])
    if not isinstance(rows, list) or len(rows) == 0:
        raise HTTPException(status_code=400, detail="'rows' must be a non-empty array")

    run = runs[run_id]
    run_dir = run.get("run_dir") or os.path.join(DATA_DIR, "runs", run_id)
    os.makedirs(run_dir, exist_ok=True)
    metrics_file = os.path.join(run_dir, "agent_metrics.jsonl")

    try:
        with open(metrics_file, "a") as f:
            for row in rows:
                if isinstance(row, dict):
                    f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except OSError as e:
        logger.error(f"Failed to write metrics for run {run_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to write metrics")

    # Invalidate cache for this file
    _wandb_metrics_cache.pop(metrics_file, None)

    logger.debug(f"Received {len(rows)} metric rows for run {run_id}")
    return {"appended": len(rows)}


@app.get("/runs/{run_id}/metrics")
async def get_run_metrics(run_id: str):
    """Return parsed metrics for a run from stored metrics file."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")

    run = runs[run_id]
    run_dir = run.get("run_dir") or os.path.join(DATA_DIR, "runs", run_id)
    parsed = _load_run_metrics(run_dir)

    # Fallback to wandb files if no stored metrics
    if not parsed or not parsed.get("metricSeries"):
        wandb_dir = run.get("wandb_dir") or _find_wandb_dir_from_run_dir(run_dir)
        wandb_parsed = _get_wandb_curve_data(wandb_dir)
        if wandb_parsed:
            parsed = wandb_parsed

    return parsed or {}


@app.get("/alerts")
async def list_alerts():
    """List alerts ordered by newest first."""
    alerts = list(active_alerts.values())
    alerts.sort(key=lambda a: a.get("timestamp", 0), reverse=True)
    return alerts


@app.post("/alerts/{alert_id}/respond")
async def respond_to_alert(alert_id: str, req: RespondAlertRequest):
    """Resolve an alert and persist the response for sidecar consumption."""
    if alert_id not in active_alerts:
        raise HTTPException(status_code=404, detail="Alert not found")

    alert = active_alerts[alert_id]
    if req.choice not in alert.get("choices", []):
        raise HTTPException(status_code=400, detail="Invalid choice")

    alert["status"] = "resolved"
    alert["response"] = req.choice
    alert["responded_at"] = time.time()

    run_id = alert.get("run_id")
    run = runs.get(run_id) if run_id else None

    if not run:
        save_alerts_state()
        return {"message": "Response recorded, run not found"}

    run_dir = run.get("run_dir") or os.path.join(DATA_DIR, "runs", run_id)
    alerts_dir = os.path.join(run_dir, "alerts")
    os.makedirs(alerts_dir, exist_ok=True)
    response_file = os.path.join(alerts_dir, f"{alert_id}.response")

    try:
        with open(response_file, "w") as f:
            f.write(req.choice)
    except Exception as e:
        logger.error(f"Failed writing alert response file for {alert_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to write response file: {e}")

    save_alerts_state()
    logger.info(f"Recorded alert response for {alert_id}: {req.choice}")
    return {"message": "Response recorded"}


@app.get("/wild-mode")
async def get_wild_mode():
    """Get current wild mode state."""
    return get_wild_mode_state()


@app.post("/wild-mode")
async def set_wild_mode(req: WildModeRequest):
    """Enable or disable wild mode."""
    result = set_wild_mode_state(req.enabled)
    save_settings_state()
    return result


# =============================================================================
# Wild Event Queue Endpoints (delegated to wild_loop module)
# =============================================================================

@app.post("/wild/events/enqueue")
async def enqueue_wild_event(req: EnqueueEventRequest):
    """Push an event into the wild event queue with priority."""
    return enqueue_event(req)


@app.get("/wild/events/next")
async def dequeue_wild_event():
    """Pop and return the highest-priority event from the queue."""
    return dequeue_event()


@app.get("/wild/events/queue")
async def get_wild_event_queue_endpoint():
    """Inspect the current queue state (for debugging/UI)."""
    return get_queue_state()


@app.post("/wild/events/{event_id}/resolve")
async def resolve_wild_event(event_id: str):
    """Resolve (consume) a specific event by ID, out of normal queue order."""
    return resolve_event(event_id)


@app.get("/wild/events/all")
async def get_all_wild_events():
    """Return all events including resolved (history view)."""
    return get_all_events()


@app.get("/wild/events/{event_id}")
async def peek_wild_event(event_id: str):
    """Peek at a specific event by ID without consuming it."""
    event = wild_event_queue.get_event(event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not found")
    return event


@app.get("/wild/status")
async def get_wild_status():
    """Get the current wild loop state (enriched with queue/run stats)."""
    return wild_engine.get_full_status()


@app.post("/wild/status")
async def update_wild_status(phase: str = None, iteration: int = None,
                             goal: str = None, session_id: str = None,
                             is_paused: bool = None, is_active: bool = None,
                             stage: str = None):
    """Update wild loop state from frontend."""
    result = update_loop_status(phase=phase, iteration=iteration, goal=goal,
                                session_id=session_id, is_paused=is_paused,
                                is_active=is_active, stage=stage)
    save_settings_state()
    return result


@app.post("/wild/configure")
async def configure_wild_loop_endpoint(req: WildLoopConfigRequest):
    """Configure wild loop termination conditions and goal."""
    result = configure_loop(req)
    save_settings_state()
    return result


@app.post("/wild/build-prompt")
async def build_wild_loop_prompt(req: BuildPromptRequest):
    """Build a wild loop prompt server-side and return full provenance metadata.

    Returns the rendered prompt, the skill template used, the variables applied,
    and the user's original input — giving the frontend full transparency.
    """
    result = build_prompt_for_frontend(
        req, prompt_skill_manager.get,
        server_url=SERVER_CALLBACK_URL,
        auth_token=USER_AUTH_TOKEN or "",
    )
    return result


# =============================================================================
# Backend-Driven Wild Loop Endpoints (v5 Engine)
# =============================================================================

@app.post("/wild/start")
async def wild_start(req: WildStartRequest):
    """Start the wild loop with a goal and session."""
    result = wild_engine.start(req)
    save_settings_state()
    return result


@app.post("/wild/stop")
async def wild_stop():
    """Stop the wild loop."""
    result = wild_engine.stop()
    save_settings_state()
    return result


@app.post("/wild/pause")
async def wild_pause():
    """Pause the wild loop."""
    result = wild_engine.pause()
    save_settings_state()
    return result


@app.post("/wild/resume")
async def wild_resume():
    """Resume the wild loop."""
    result = wild_engine.resume()
    save_settings_state()
    return result


@app.post("/wild/response-complete")
async def wild_response_complete(req: WildResponseCompleteRequest):
    """Frontend tells backend the agent finished responding."""
    result = wild_engine.on_response_complete(req.response_text)
    save_settings_state()
    return result


@app.get("/wild/next-prompt")
async def wild_next_prompt():
    """Get the next prompt the frontend should send to the agent."""
    return wild_engine.get_next_prompt()


@app.post("/wild/next-prompt/consume")
async def wild_consume_prompt():
    """Mark the current pending prompt as consumed/sent."""
    return wild_engine.consume_prompt()


@app.post("/wild/steer")
async def wild_steer(req: WildSteerRequest):
    """Insert a user steer message into the wild loop queue."""
    return wild_engine.steer(req)


# =============================================================================
# Wild Loop V2 Endpoints (Ralph-style)
# =============================================================================

class WildV2StartRequest(BaseModel):
    goal: str
    chat_session_id: Optional[str] = None
    max_iterations: int = 25
    wait_seconds: float = 30.0

class WildV2SteerRequest(BaseModel):
    context: str

class WildV2ResolveRequest(BaseModel):
    event_ids: list


@app.post("/wild/v2/start")
async def wild_v2_start(req: WildV2StartRequest):
    """Start a new V2 wild session (ralph-style loop)."""
    result = wild_v2_engine.start(
        goal=req.goal,
        chat_session_id=req.chat_session_id,
        max_iterations=req.max_iterations,
        wait_seconds=req.wait_seconds,
    )
    return result


@app.post("/wild/v2/stop")
async def wild_v2_stop():
    """Stop the active V2 wild session."""
    return wild_v2_engine.stop()


@app.post("/wild/v2/pause")
async def wild_v2_pause():
    """Pause the V2 wild session."""
    return wild_v2_engine.pause()


@app.post("/wild/v2/resume")
async def wild_v2_resume():
    """Resume the V2 wild session."""
    return wild_v2_engine.resume()


@app.get("/wild/v2/status")
async def wild_v2_status():
    """Get current V2 session state, plan, and history."""
    return wild_v2_engine.get_status()


@app.get("/wild/v2/events/{session_id}")
async def wild_v2_events(session_id: str):
    """Get pending events for a V2 session (agent calls this).
    
    Events are now managed server-side in active_alerts and runs dicts.
    """
    events = []
    # Collect pending alerts
    for alert_id, alert in active_alerts.items():
        if alert.get("status") == "pending":
            events.append({
                "id": alert_id,
                "type": "alert",
                "title": f"Alert: {alert.get('type', 'unknown')}",
                "detail": alert.get("message", ""),
                "run_id": alert.get("run_id"),
                "created_at": alert.get("created_at", time.time()),
            })
    # Collect completed/failed runs
    for rid, run in runs.items():
        if run.get("status") in ("finished", "failed"):
            events.append({
                "id": f"run-{rid}-{run.get('status')}",
                "type": "run_complete",
                "title": f"Run {run.get('status')}: {run.get('name', rid)}",
                "detail": f"Status: {run.get('status')}",
                "run_id": rid,
                "created_at": time.time(),
            })
    return events


@app.post("/wild/v2/events/{session_id}/resolve")
async def wild_v2_resolve_events(session_id: str, req: WildV2ResolveRequest):
    """Mark events as resolved (agent calls this after handling)."""
    resolved = 0
    ids_to_resolve = set(req.event_ids)
    for alert_id in list(active_alerts.keys()):
        if alert_id in ids_to_resolve:
            active_alerts[alert_id]["status"] = "resolved"
            resolved += 1
    return {"resolved": resolved}


@app.get("/wild/v2/system-health")
async def wild_v2_system_health():
    """Get system utilization (agent calls this to check resources)."""
    return WildV2Engine.get_system_health_from_runs(runs)


@app.get("/wild/v2/plan/{session_id}")
async def wild_v2_plan(session_id: str):
    """Get the current tasks/plan markdown (reads tasks.md from disk)."""
    return {"plan": wild_v2_engine.get_plan()}


@app.get("/wild/v2/iteration-log/{session_id}")
async def wild_v2_iteration_log(session_id: str):
    """Get the iteration log markdown."""
    return {"log": wild_v2_engine.get_iteration_log()}


@app.post("/wild/v2/steer")
async def wild_v2_steer(req: WildV2SteerRequest):
    """Inject user context for the next iteration."""
    return wild_v2_engine.steer(req.context)


# =============================================================================
# Memory Bank Endpoints
# =============================================================================

class MemoryCreateRequest(BaseModel):
    title: str
    content: str
    source: str = "user"  # "user" | "agent" | "reflection"
    tags: list = []
    session_id: str = ""

class MemoryUpdateRequest(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    is_active: Optional[bool] = None
    tags: Optional[list] = None


@app.get("/memories")
async def list_memories(active_only: bool = False, source: Optional[str] = None):
    """List all memories, optionally filtered."""
    entries = memory_store.list(active_only=active_only, source=source)
    return [{"id": m.id, "title": m.title, "content": m.content,
             "source": m.source, "tags": m.tags, "session_id": m.session_id,
             "created_at": m.created_at, "is_active": m.is_active}
            for m in entries]


@app.post("/memories")
async def create_memory(req: MemoryCreateRequest):
    """Create a new memory entry."""
    entry = memory_store.add(
        title=req.title,
        content=req.content,
        source=req.source,
        tags=req.tags,
        session_id=req.session_id,
    )
    return entry.to_dict()


@app.patch("/memories/{memory_id}")
async def update_memory(memory_id: str, req: MemoryUpdateRequest):
    """Update a memory (toggle, edit title/content)."""
    updates = {k: v for k, v in req.dict().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    entry = memory_store.update(memory_id, **updates)
    if not entry:
        raise HTTPException(status_code=404, detail="Memory not found")
    return entry.to_dict()


@app.delete("/memories/{memory_id}")
async def delete_memory(memory_id: str):
    """Delete a memory."""
    deleted = memory_store.delete(memory_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Memory not found")
    return {"deleted": True, "id": memory_id}


@app.get("/cluster")
async def get_cluster_state():
    """Get the persisted cluster state and current run summary."""
    return {"cluster": cluster_state, "run_summary": _current_run_summary()}


@app.post("/cluster/detect")
async def detect_cluster(req: Optional[ClusterDetectRequest] = None):
    """Auto-detect cluster setup, or apply a user-specified preferred type."""
    global cluster_state

    detected = _infer_cluster_from_environment()
    preferred_type = _normalize_cluster_type(req.preferred_type) if req else "unknown"

    if preferred_type != "unknown":
        now = time.time()
        detected["type"] = preferred_type
        detected["source"] = "manual"
        detected["status"] = "healthy"
        detected["label"] = _cluster_type_label(preferred_type)
        detected["description"] = _cluster_type_description(preferred_type)
        detected["confidence"] = 1.0
        detected["updated_at"] = now
        detected["last_detected_at"] = now

    cluster_state = _normalize_cluster_state(detected)
    save_settings_state()
    return {"cluster": cluster_state, "run_summary": _current_run_summary()}


@app.post("/cluster")
async def update_cluster_state(req: ClusterUpdateRequest):
    """Update persisted cluster metadata with user-provided values."""
    global cluster_state

    now = time.time()
    payload = req.model_dump(exclude_unset=True)
    next_state = dict(cluster_state)

    if "type" in payload:
        raw_type = payload.get("type")
        normalized_type = _normalize_cluster_type(raw_type)
        if raw_type and normalized_type == "unknown" and raw_type.strip().lower() not in {"unknown", "unset"}:
            raise HTTPException(status_code=400, detail=f"Unsupported cluster type: {raw_type}")
        next_state["type"] = normalized_type
        next_state["label"] = _cluster_type_label(normalized_type)
        next_state["description"] = _cluster_type_description(normalized_type)

    if "status" in payload:
        raw_status = payload.get("status")
        normalized_status = _normalize_cluster_status(raw_status)
        if raw_status and normalized_status == "unknown" and raw_status.strip().lower() != "unknown":
            raise HTTPException(status_code=400, detail=f"Unsupported cluster status: {raw_status}")
        next_state["status"] = normalized_status

    if "source" in payload:
        raw_source = payload.get("source")
        normalized_source = _normalize_cluster_source(raw_source)
        if raw_source and normalized_source == "unset" and raw_source.strip().lower() != "unset":
            raise HTTPException(status_code=400, detail=f"Unsupported cluster source: {raw_source}")
        next_state["source"] = normalized_source
    else:
        next_state["source"] = "manual"

    if "head_node" in payload:
        next_state["head_node"] = payload.get("head_node")
    if "node_count" in payload:
        next_state["node_count"] = payload.get("node_count")
    if "gpu_count" in payload:
        next_state["gpu_count"] = payload.get("gpu_count")
    if "notes" in payload:
        next_state["notes"] = payload.get("notes")
    if "details" in payload:
        next_state["details"] = payload.get("details") if isinstance(payload.get("details"), dict) else {}

    next_state["updated_at"] = now
    cluster_state = _normalize_cluster_state(next_state)
    save_settings_state()
    return {"cluster": cluster_state, "run_summary": _current_run_summary()}


def _build_experiment_context() -> str:
    """Build a summary of current experiment state for the wild mode prompt."""
    return build_experiment_context(runs, sweeps, active_alerts, recompute_all_sweep_states)


# =============================================================================
# Prompt Skill Endpoints
# =============================================================================

class PromptSkillUpdate(BaseModel):
    template: str


class PromptSkillCreate(BaseModel):
    name: str
    description: str = ""
    template: str = ""
    category: str = "skill"
    variables: Optional[List[str]] = None


class PromptSkillInstall(BaseModel):
    source: str = "git"  # "git" for now; "zip" later
    url: str
    name: Optional[str] = None


@app.get("/prompt-skills")
async def list_prompt_skills():
    """List all available prompt skills."""
    return prompt_skill_manager.list()


@app.get("/prompt-skills/search")
async def search_prompt_skills(q: str = "", limit: int = 20):
    """Search prompt skills by name, description, or template content.

    Agents can call this endpoint to discover available skills.
    Results are sorted by relevance score (_score field).
    """
    return prompt_skill_manager.search(q, limit)


@app.post("/prompt-skills")
async def create_prompt_skill(req: PromptSkillCreate):
    """Create a new prompt skill.

    Creates a new skill directory with SKILL.md under prompt_skills/.
    """
    try:
        skill = prompt_skill_manager.create(
            name=req.name,
            description=req.description,
            template=req.template,
            category=req.category,
            variables=req.variables,
        )
        return skill
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


@app.post("/prompt-skills/reload")
async def reload_prompt_skills():
    """Reload all prompt skills from disk."""
    prompt_skill_manager.load_all()
    return {"message": "Prompt skills reloaded", "count": len(prompt_skill_manager.list())}


@app.post("/prompt-skills/install")
async def install_prompt_skill(req: PromptSkillInstall):
    """Install a skill from an external source (git clone).

    Clones the repository into prompt_skills/<name>/ and parses SKILL.md.
    """
    if req.source != "git":
        raise HTTPException(status_code=400, detail=f"Unsupported install source: {req.source}")
    try:
        skill = prompt_skill_manager.install_from_git(req.url, req.name)
        return skill
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/prompt-skills/{skill_id}")
async def get_prompt_skill(skill_id: str):
    """Get a single prompt skill by ID."""
    skill = prompt_skill_manager.get(skill_id)
    if skill is None:
        raise HTTPException(status_code=404, detail=f"Prompt skill '{skill_id}' not found")
    return skill


@app.put("/prompt-skills/{skill_id}")
async def update_prompt_skill(skill_id: str, req: PromptSkillUpdate):
    """Update a prompt skill's template."""
    updated = prompt_skill_manager.update(skill_id, req.template)
    if updated is None:
        raise HTTPException(status_code=404, detail=f"Prompt skill '{skill_id}' not found")
    return updated


@app.delete("/prompt-skills/{skill_id}")
async def delete_prompt_skill(skill_id: str):
    """Delete a user-created skill.

    Internal skills (wild_*, ra_mode_plan) cannot be deleted (403).
    """
    try:
        prompt_skill_manager.delete(skill_id)
        return {"message": f"Skill '{skill_id}' deleted"}
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Prompt skill '{skill_id}' not found")
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))


@app.post("/prompt-skills/{skill_id}/render")
async def render_prompt_skill(skill_id: str, variables: Dict[str, str]):
    """Render a prompt skill template with the given variables."""
    rendered = prompt_skill_manager.render(skill_id, variables)
    if rendered is None:
        raise HTTPException(status_code=404, detail=f"Prompt skill '{skill_id}' not found")
    return {"rendered": rendered}


class SkillFileWrite(BaseModel):
    content: str


@app.get("/prompt-skills/{skill_id}/files")
async def list_skill_files(skill_id: str):
    """List all files in a skill's folder."""
    files = prompt_skill_manager.list_files(skill_id)
    if files is None:
        raise HTTPException(status_code=404, detail=f"Prompt skill '{skill_id}' not found")
    return files


@app.get("/prompt-skills/{skill_id}/files/{file_path:path}")
async def read_skill_file(skill_id: str, file_path: str):
    """Read a file from a skill's folder."""
    content = prompt_skill_manager.read_file(skill_id, file_path)
    if content is None:
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")
    return {"path": file_path, "content": content}


@app.put("/prompt-skills/{skill_id}/files/{file_path:path}")
async def write_skill_file(skill_id: str, file_path: str, req: SkillFileWrite):
    """Write a file in a skill's folder."""
    result = prompt_skill_manager.write_file(skill_id, file_path, req.content)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Skill or path not found: {skill_id}/{file_path}")
    return {"message": "File saved", "path": file_path}


# =============================================================================
# Sweep Endpoints
# =============================================================================

def expand_parameter_grid(parameters: dict, max_runs: int) -> list:
    """Expand parameter dict into list of parameter combinations."""
    import itertools
    
    keys = list(parameters.keys())
    values = [parameters[k] if isinstance(parameters[k], list) else [parameters[k]] for k in keys]
    
    combinations = list(itertools.product(*values))[:max_runs]
    
    return [dict(zip(keys, combo)) for combo in combinations]


def build_command_with_params(base_command: str, params: dict) -> str:
    """Insert parameters into command string."""
    # Simple approach: append as CLI args
    param_str = " ".join([f"--{k}={v}" for k, v in params.items()])
    return f"{base_command} {param_str}".strip()


@app.get("/sweeps")
async def list_sweeps(
    limit: int = Query(50, description="Max sweeps to return")
):
    """List all sweeps."""
    recompute_all_sweep_states()
    backfilled = False
    result = []
    for sweep_id, sweep in sweeps.items():
        if _ensure_sweep_creation_context(sweep):
            backfilled = True
        result.append({"id": sweep_id, **sweep})

    if backfilled:
        save_runs_state()
    
    result.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return result[:limit]


class WildSweepCreate(BaseModel):
    name: str = "Wild Loop Sweep"
    goal: str = ""
    chat_session_id: Optional[str] = None  # Originating chat session

@app.post("/sweeps/wild")
async def create_wild_sweep(req: WildSweepCreate):
    """Create an empty sweep container for wild loop tracking.
    
    Unlike the regular /sweeps endpoint, this doesn't require parameter grids.
    Runs are added to this sweep via sweep_id when the agent creates them.
    """
    sweep_id = uuid.uuid4().hex[:12]
    
    created_at = time.time()
    sweep_data = {
        "name": req.name,
        "base_command": "",
        "workdir": WORKDIR,
        "parameters": {},
        "run_ids": [],
        "status": "pending",
        "created_at": created_at,
        "goal": req.goal,
        "is_wild": True,
        "chat_session_id": req.chat_session_id,
        "ui_config": None,
        "creation_context": _derive_sweep_creation_context(
            name=req.name,
            base_command="",
            goal=req.goal,
            max_runs=None,
            ui_config=None,
            parameters={},
            created_at=created_at,
        ),
        "progress": {
            "total": 0,
            "completed": 0,
            "failed": 0,
            "running": 0,
            "launching": 0,
            "ready": 0,
            "queued": 0,
            "canceled": 0,
        },
    }
    
    sweeps[sweep_id] = sweep_data
    recompute_sweep_state(sweep_id)
    wild_loop_state["sweep_id"] = sweep_id
    save_runs_state()
    
    logger.info(f"Created wild sweep {sweep_id}: {req.name} (goal: {req.goal[:80]})")
    return {"id": sweep_id, **sweep_data}


@app.post("/sweeps")
async def create_sweep(req: SweepCreate):
    """Create a sweep in draft/pending/running mode, optionally with generated runs."""
    sweep_id = uuid.uuid4().hex[:12]
    requested_status = _normalize_sweep_status(req.status)
    if req.auto_start and requested_status == "pending":
        # auto_start implies immediate queue/launch intent
        requested_status = "running"

    if requested_status not in {"draft", "pending", "running"}:
        raise HTTPException(status_code=400, detail=f"Unsupported sweep status: {requested_status}")

    created_at = time.time()
    creation_context = _derive_sweep_creation_context(
        name=req.name,
        base_command=req.base_command,
        goal=req.goal,
        max_runs=req.max_runs,
        ui_config=req.ui_config,
        parameters=req.parameters,
        created_at=created_at,
    )

    # Create draft sweep without materializing runs
    if requested_status == "draft":
        sweep_data = {
            "name": req.name,
            "base_command": req.base_command,
            "workdir": req.workdir or WORKDIR,
            "parameters": req.parameters or {},
            "run_ids": [],
            "status": "draft",
            "created_at": created_at,
            "goal": req.goal,
            "max_runs": req.max_runs,
            "ui_config": req.ui_config,
            "chat_session_id": req.chat_session_id,
            "creation_context": creation_context,
            "progress": {
                "total": 0,
                "completed": 0,
                "failed": 0,
                "running": 0,
                "launching": 0,
                "ready": 0,
                "queued": 0,
                "canceled": 0,
            },
        }
        sweeps[sweep_id] = sweep_data
        save_runs_state()
        record_created_entity("sweep", sweep_id, chat_session_id=req.chat_session_id)
        logger.info(f"Created draft sweep {sweep_id}: {req.name}")
        return {"id": sweep_id, **sweep_data}
    
    # Expand parameters into run configurations
    param_combinations = expand_parameter_grid(req.parameters or {}, req.max_runs)
    
    # Create runs for each combination
    run_ids = []
    for i, params in enumerate(param_combinations):
        run_id = uuid.uuid4().hex[:12]
        command = build_command_with_params(req.base_command, params)
        
        run_data = {
            "name": f"{req.name} #{i+1}",
            "command": command,
            "workdir": req.workdir or WORKDIR,
            "status": "queued" if requested_status == "running" else "ready",
            "created_at": time.time(),
            "is_archived": False,
            "sweep_id": sweep_id,
            "sweep_params": params,
            "tmux_window": None,
            "run_dir": None,
            "exit_code": None,
            "error": None,
            "wandb_dir": None,
        }
        
        runs[run_id] = run_data
        run_ids.append(run_id)
    
    # Create sweep record
    sweep_data = {
        "name": req.name,
        "base_command": req.base_command,
        "workdir": req.workdir or WORKDIR,
        "parameters": req.parameters,
        "run_ids": run_ids,
        "status": "running" if requested_status == "running" else "pending",
        "created_at": created_at,
        "goal": req.goal,
        "max_runs": req.max_runs,
        "ui_config": req.ui_config,
        "chat_session_id": req.chat_session_id,
        "creation_context": creation_context,
        "progress": {
            "total": len(run_ids),
            "completed": 0,
            "failed": 0,
            "running": 0,
            "launching": 0,
            "ready": len(run_ids) if requested_status != "running" else 0,
            "queued": len(run_ids) if requested_status == "running" else 0,
            "canceled": 0,
        },
    }
    
    sweeps[sweep_id] = sweep_data
    recompute_sweep_state(sweep_id)
    save_runs_state()
    
    record_created_entity("sweep", sweep_id, chat_session_id=req.chat_session_id)
    for rid in run_ids:
        record_created_entity("run", rid, chat_session_id=req.chat_session_id)
    logger.info(f"Created sweep {sweep_id}: {req.name} with {len(run_ids)} runs (status={requested_status})")
    return {"id": sweep_id, **sweep_data}


@app.put("/sweeps/{sweep_id}")
async def update_sweep(sweep_id: str, req: SweepUpdate):
    """Update an existing sweep configuration/state."""
    if sweep_id not in sweeps:
        raise HTTPException(status_code=404, detail="Sweep not found")

    sweep = sweeps[sweep_id]
    current_status = _normalize_sweep_status(sweep.get("status"))
    base_command_update_requested = req.base_command is not None
    non_command_structural_update_requested = any(
        field is not None
        for field in [req.parameters, req.max_runs]
    )
    structural_update_requested = base_command_update_requested or non_command_structural_update_requested

    # Keep running sweeps immutable to avoid mutating active experiments in place.
    if current_status == "running" and structural_update_requested:
        raise HTTPException(
            status_code=409,
            detail=(
                "Cannot modify base command/parameters/max_runs while sweep is running. "
                "Create a draft revision and launch it as a new sweep."
            ),
        )

    if sweep.get("run_ids") and non_command_structural_update_requested:
        raise HTTPException(
            status_code=409,
            detail=(
                "Cannot mutate structure for a sweep that already has runs. "
                "Create a draft revision instead."
            ),
        )

    if req.status is not None:
        next_status = _normalize_sweep_status(req.status)
        if next_status == "draft" and sweep.get("run_ids"):
            raise HTTPException(
                status_code=409,
                detail="Cannot move a sweep with existing runs back to draft.",
            )
        sweep["status"] = next_status

    if req.name is not None:
        sweep["name"] = req.name
    if req.base_command is not None:
        next_base_command = req.base_command.strip()
        if not next_base_command:
            raise HTTPException(status_code=400, detail="Sweep base command cannot be empty")
        sweep["base_command"] = next_base_command

        ui_config = sweep.get("ui_config")
        if isinstance(ui_config, dict):
            ui_config["command"] = next_base_command
            ui_config["updatedAt"] = int(time.time())

        creation_context = sweep.get("creation_context")
        if isinstance(creation_context, dict):
            creation_context["command"] = next_base_command

        run_ids = sweep.get("run_ids") or []
        for run_id in run_ids:
            run = runs.get(run_id)
            if not run:
                continue
            params = run.get("sweep_params")
            if not isinstance(params, dict):
                params = {}
            run["command"] = build_command_with_params(next_base_command, params)
    if req.workdir is not None:
        sweep["workdir"] = req.workdir
    if req.parameters is not None:
        sweep["parameters"] = req.parameters
    if req.goal is not None:
        sweep["goal"] = req.goal
    if req.ui_config is not None:
        sweep["ui_config"] = req.ui_config

    if req.max_runs is not None and req.max_runs > 0:
        sweep["max_runs"] = req.max_runs

    recompute_sweep_state(sweep_id)
    save_runs_state()
    return {"id": sweep_id, **sweep}


@app.get("/sweeps/{sweep_id}")
async def get_sweep(sweep_id: str):
    """Get sweep details with run status summary."""
    if sweep_id not in sweeps:
        raise HTTPException(status_code=404, detail="Sweep not found")

    sweep = recompute_sweep_state(sweep_id) or sweeps[sweep_id]
    if _ensure_sweep_creation_context(sweep):
        save_runs_state()
    return {"id": sweep_id, **sweep}


@app.post("/sweeps/{sweep_id}/start")
async def start_sweep(sweep_id: str, parallel: int = Query(1, description="Max parallel runs")):
    """Start all ready/queued runs in a sweep."""
    if sweep_id not in sweeps:
        raise HTTPException(status_code=404, detail="Sweep not found")
    
    sweep = sweeps[sweep_id]
    if _normalize_sweep_status(sweep.get("status")) == "draft":
        raise HTTPException(status_code=400, detail="Draft sweep has no runnable jobs yet")
    started = 0
    attempted = 0
    
    for run_id in sweep.get("run_ids", []):
        if run_id in runs:
            run = runs[run_id]
            if run["status"] in ["ready", "queued"] and started < parallel:
                attempted += 1
                try:
                    # Queue if ready
                    if run["status"] == "ready":
                        run["status"] = "queued"
                        run["queued_at"] = time.time()
                    
                    launch_run_in_tmux(run_id, run)
                    started += 1
                except Exception as e:
                    logger.error(f"Failed to start run {run_id}: {e}")

    recompute_sweep_state(sweep_id)
    save_runs_state()
    
    return {"message": f"Started {started}/{attempted} runs", "sweep_id": sweep_id}


@app.post("/sweeps/{sweep_id}/runs")
async def add_run_to_sweep_directly(sweep_id: str, req: RunCreate):
    """Create a new run and attach it to a sweep in one call.

    This allows adding runs to a sweep even if they are outside the original
    parameter/hyperparameter grid (e.g. a one-off baseline, a manual rerun
    with custom flags, etc.).
    """
    if sweep_id not in sweeps:
        raise HTTPException(status_code=404, detail="Sweep not found")

    # Force sweep_id on the run regardless of what was provided
    req.sweep_id = sweep_id

    run_id = uuid.uuid4().hex[:12]
    initial_status = "queued" if req.auto_start else "ready"

    run_data = {
        "name": req.name,
        "command": req.command,
        "workdir": req.workdir or WORKDIR,
        "status": initial_status,
        "created_at": time.time(),
        "is_archived": False,
        "sweep_id": sweep_id,
        "parent_run_id": req.parent_run_id,
        "origin_alert_id": req.origin_alert_id,
        "tmux_window": None,
        "run_dir": None,
        "exit_code": None,
        "error": None,
        "wandb_dir": None,
    }

    runs[run_id] = run_data
    sweeps[sweep_id].setdefault("run_ids", []).append(run_id)
    recompute_sweep_state(sweep_id)
    save_runs_state()

    record_created_entity("run", run_id, chat_session_id=getattr(req, 'chat_session_id', None))
    logger.info(f"Created run {run_id} and attached to sweep {sweep_id}: {req.name} (status: {initial_status})")
    return {"id": run_id, **run_data}


@app.post("/runs/{run_id}/add-to-sweep")
async def add_run_to_sweep(run_id: str, sweep_id: str = Query(..., description="Sweep ID to add the run to")):
    """Add an existing standalone run to a sweep."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    if sweep_id not in sweeps:
        raise HTTPException(status_code=404, detail="Sweep not found")

    run = runs[run_id]
    old_sweep_id = run.get("sweep_id")
    if old_sweep_id == sweep_id:
        return {"message": f"Run {run_id} is already in sweep {sweep_id}"}

    if old_sweep_id and old_sweep_id in sweeps and run.get("status") in RUN_STATUS_ACTIVE.union({"queued"}):
        raise HTTPException(
            status_code=409,
            detail=(
                "Cannot move an active/queued run between sweeps. "
                "Stop it first or rerun into a new sweep."
            ),
        )

    if old_sweep_id and old_sweep_id in sweeps:
        old_ids = sweeps[old_sweep_id].get("run_ids", [])
        sweeps[old_sweep_id]["run_ids"] = [rid for rid in old_ids if rid != run_id]
        recompute_sweep_state(old_sweep_id)

    run["sweep_id"] = sweep_id
    if run_id not in sweeps[sweep_id].get("run_ids", []):
        sweeps[sweep_id].setdefault("run_ids", []).append(run_id)
    recompute_sweep_state(sweep_id)
    save_runs_state()
    return {"message": f"Run {run_id} added to sweep {sweep_id}"}


# =============================================================================
# Log Endpoints
# =============================================================================

@app.get("/runs/{run_id}/logs")
async def get_run_logs(
    run_id: str,
    offset: int = Query(-10000, description="Byte offset. Negative = from end."),
    limit: int = Query(10000, description="Max bytes to return (max 100KB)")
):
    """Get run logs with byte-offset pagination."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    
    run = runs[run_id]
    run_dir = run.get("run_dir")
    
    if not run_dir:
        return {"content": "", "offset": 0, "total_size": 0, "has_more_before": False, "has_more_after": False}
    
    log_file = os.path.join(run_dir, "run.log")
    if not os.path.exists(log_file):
        return {"content": "", "offset": 0, "total_size": 0, "has_more_before": False, "has_more_after": False}
    
    # Cap limit at 100KB
    limit = min(limit, 100 * 1024)
    
    try:
        total_size = os.path.getsize(log_file)
        
        # Calculate actual offset
        if offset < 0:
            actual_offset = max(0, total_size + offset)
        else:
            actual_offset = min(offset, total_size)
        
        with open(log_file, "r", errors="replace") as f:
            f.seek(actual_offset)
            content = f.read(limit)
        
        bytes_read = len(content.encode('utf-8'))
        end_offset = actual_offset + bytes_read
        
        return {
            "content": content,
            "offset": actual_offset,
            "total_size": total_size,
            "has_more_before": actual_offset > 0,
            "has_more_after": end_offset < total_size
        }
    except Exception as e:
        logger.error(f"Error reading logs for {run_id}: {e}")
        return {"content": f"Error reading logs: {e}", "offset": 0, "total_size": 0, "has_more_before": False, "has_more_after": False}


@app.get("/runs/{run_id}/logs/stream")
async def stream_run_logs(run_id: str):
    """Stream run logs via SSE."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    
    run = runs[run_id]
    run_dir = run.get("run_dir")
    
    async def log_generator():
        if not run_dir:
            yield f"data: {json.dumps({'error': 'No run directory'})}\n\n"
            return
        
        log_file = os.path.join(run_dir, "run.log")
        last_size = 0
        
        # Send initial content
        if os.path.exists(log_file):
            with open(log_file, "r", errors="replace") as f:
                content = f.read()
                last_size = len(content.encode('utf-8'))
                yield f"data: {json.dumps({'type': 'initial', 'content': content})}\n\n"
        
        # Stream updates
        while True:
            await asyncio.sleep(0.5)
            
            # Check if run is still active
            current_run = runs.get(run_id, {})
            if current_run.get("status") in ["finished", "failed", "stopped"]:
                # Send final content and close
                if os.path.exists(log_file):
                    with open(log_file, "r", errors="replace") as f:
                        f.seek(last_size)
                        new_content = f.read()
                        if new_content:
                            yield f"data: {json.dumps({'type': 'delta', 'content': new_content})}\n\n"
                yield f"data: {json.dumps({'type': 'done', 'status': current_run.get('status')})}\n\n"
                break
            
            # Check for new content
            if os.path.exists(log_file):
                current_size = os.path.getsize(log_file)
                if current_size > last_size:
                    with open(log_file, "r", errors="replace") as f:
                        f.seek(last_size)
                        new_content = f.read()
                        last_size = current_size
                        yield f"data: {json.dumps({'type': 'delta', 'content': new_content})}\n\n"
    
    return StreamingResponse(log_generator(), media_type="text/event-stream")


@app.get("/runs/{run_id}/sidecar-logs")
async def get_sidecar_logs(
    run_id: str,
    offset: int = Query(-10000, description="Byte offset. Negative = from end."),
    limit: int = Query(10000, description="Max bytes to return (max 100KB)")
):
    """Get sidecar logs with byte-offset pagination."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")

    run = runs[run_id]
    run_dir = run.get("run_dir")

    if not run_dir:
        return {"content": "", "offset": 0, "total_size": 0, "has_more_before": False, "has_more_after": False}

    log_file = os.path.join(run_dir, "sidecar.log")
    if not os.path.exists(log_file):
        return {"content": "", "offset": 0, "total_size": 0, "has_more_before": False, "has_more_after": False}

    limit = min(limit, 100 * 1024)

    try:
        total_size = os.path.getsize(log_file)

        if offset < 0:
            actual_offset = max(0, total_size + offset)
        else:
            actual_offset = min(offset, total_size)

        with open(log_file, "r", errors="replace") as f:
            f.seek(actual_offset)
            content = f.read(limit)

        bytes_read = len(content.encode('utf-8'))
        end_offset = actual_offset + bytes_read

        return {
            "content": content,
            "offset": actual_offset,
            "total_size": total_size,
            "has_more_before": actual_offset > 0,
            "has_more_after": end_offset < total_size
        }
    except Exception as e:
        logger.error(f"Error reading sidecar logs for {run_id}: {e}")
        return {"content": f"Error reading logs: {e}", "offset": 0, "total_size": 0, "has_more_before": False, "has_more_after": False}


@app.get("/runs/{run_id}/sidecar-logs/stream")
async def stream_sidecar_logs(run_id: str):
    """Stream sidecar logs via SSE."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")

    run = runs[run_id]
    run_dir = run.get("run_dir")

    async def log_generator():
        if not run_dir:
            yield f"data: {json.dumps({'error': 'No run directory'})}\n\n"
            return

        log_file = os.path.join(run_dir, "sidecar.log")
        last_size = 0

        # Send initial content
        if os.path.exists(log_file):
            with open(log_file, "r", errors="replace") as f:
                content = f.read()
                last_size = len(content.encode('utf-8'))
                yield f"data: {json.dumps({'type': 'initial', 'content': content})}\n\n"

        # Stream updates
        while True:
            await asyncio.sleep(0.5)

            current_run = runs.get(run_id, {})
            if current_run.get("status") in ["finished", "failed", "stopped"]:
                if os.path.exists(log_file):
                    with open(log_file, "r", errors="replace") as f:
                        f.seek(last_size)
                        new_content = f.read()
                        if new_content:
                            yield f"data: {json.dumps({'type': 'delta', 'content': new_content})}\n\n"
                yield f"data: {json.dumps({'type': 'done', 'status': current_run.get('status')})}\n\n"
                break

            if os.path.exists(log_file):
                current_size = os.path.getsize(log_file)
                if current_size > last_size:
                    with open(log_file, "r", errors="replace") as f:
                        f.seek(last_size)
                        new_content = f.read()
                        last_size = current_size
                        yield f"data: {json.dumps({'type': 'delta', 'content': new_content})}\n\n"

    return StreamingResponse(log_generator(), media_type="text/event-stream")


# =============================================================================
# Artifact Endpoints
# =============================================================================

@app.get("/runs/{run_id}/artifacts")
async def list_artifacts(run_id: str):
    """List artifacts for a run."""
    if run_id not in runs:
        raise HTTPException(status_code=404, detail="Run not found")
    
    run = runs[run_id]
    run_dir = run.get("run_dir")
    artifacts = []
    
    if run_dir:
        artifacts_dir = os.path.join(run_dir, "artifacts")
        if os.path.exists(artifacts_dir):
            for name in os.listdir(artifacts_dir):
                path = os.path.join(artifacts_dir, name)
                # Resolve symlinks to get actual path
                actual_path = os.path.realpath(path) if os.path.islink(path) else path
                artifacts.append({
                    "name": name,
                    "path": actual_path,
                    "type": "other"  # TODO: detect type
                })
    
    # Add wandb_dir if present
    if run.get("wandb_dir"):
        artifacts.append({
            "name": "wandb",
            "path": run["wandb_dir"],
            "type": "wandb"
        })
    
    return artifacts


# =============================================================================
# Main
# =============================================================================

def start_opencode_server_subprocess(args):
    # Start OpenCode server subprocess
    opencode_process = subprocess.Popen(
        ["opencode", "serve"],
        cwd=args.workdir,
        # TODO: Open up logging
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    logger.info(f"Started OpenCode server (PID: {opencode_process.pid}) in {args.workdir}")
    return


# =============================================================================
# Plan Endpoints
# =============================================================================

@app.get("/plans")
async def list_plans(status: Optional[str] = None, session_id: Optional[str] = None):
    """List all plans, optionally filtered by status or session."""
    result = list(plans.values())
    if status:
        result = [p for p in result if p.get("status") == status]
    if session_id:
        result = [p for p in result if p.get("session_id") == session_id]
    # Sort by created_at descending (newest first)
    result.sort(key=lambda p: p.get("created_at", 0), reverse=True)
    return result


@app.get("/plans/{plan_id}")
async def get_plan(plan_id: str):
    """Get a single plan by ID."""
    plan = plans.get(plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    return plan


@app.post("/plans")
async def create_plan(req: PlanCreate):
    """Create a new plan."""
    now = time.time()
    plan_id = str(uuid.uuid4())[:8]
    plan = {
        "id": plan_id,
        "title": req.title,
        "goal": req.goal,
        "session_id": req.session_id,
        "status": "draft",
        "sections": req.sections or {},
        "raw_markdown": req.raw_markdown,
        "created_at": now,
        "updated_at": now,
    }
    plans[plan_id] = plan
    save_plans_state()
    return plan


@app.patch("/plans/{plan_id}")
async def update_plan(plan_id: str, req: PlanUpdate):
    """Update a plan's fields."""
    plan = plans.get(plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")

    if req.title is not None:
        plan["title"] = req.title
    if req.status is not None:
        if req.status not in PLAN_STATUSES:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid status '{req.status}'. Must be one of: {', '.join(sorted(PLAN_STATUSES))}"
            )
        plan["status"] = req.status
    if req.sections is not None:
        plan["sections"] = req.sections
    if req.raw_markdown is not None:
        plan["raw_markdown"] = req.raw_markdown

    plan["updated_at"] = time.time()
    save_plans_state()
    return plan


@app.post("/plans/{plan_id}/approve")
async def approve_plan(plan_id: str):
    """Approve a plan, setting its status to 'approved'."""
    plan = plans.get(plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    if plan["status"] not in ("draft",):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot approve a plan with status '{plan['status']}'. Only draft plans can be approved."
        )
    plan["status"] = "approved"
    plan["updated_at"] = time.time()
    save_plans_state()
    return plan


@app.post("/plans/{plan_id}/execute")
async def execute_plan(plan_id: str):
    """Mark a plan as 'executing'. Frontend should transition to agent/wild mode."""
    plan = plans.get(plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="Plan not found")
    if plan["status"] not in ("approved",):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot execute a plan with status '{plan['status']}'. Only approved plans can be executed."
        )
    plan["status"] = "executing"
    plan["updated_at"] = time.time()
    save_plans_state()
    return plan


@app.delete("/plans/{plan_id}")
async def delete_plan(plan_id: str):
    """Delete a plan."""
    if plan_id not in plans:
        raise HTTPException(status_code=404, detail="Plan not found")
    del plans[plan_id]
    save_plans_state()
    return {"deleted": True, "id": plan_id}


def maybe_mount_frontend_static():
    """Serve packaged frontend static files if available."""
    if not FRONTEND_STATIC_DIR:
        return
    if not os.path.isdir(FRONTEND_STATIC_DIR):
        logger.warning("Configured RESEARCH_AGENT_FRONTEND_DIR does not exist: %s", FRONTEND_STATIC_DIR)
        return
    logger.info("Serving frontend static files from %s", FRONTEND_STATIC_DIR)
    app.mount("/", StaticFiles(directory=FRONTEND_STATIC_DIR, html=True), name="frontend-static")

def main():
    global SERVER_CALLBACK_URL
    global TMUX_SESSION_NAME

    if "--run-sidecar" in sys.argv:
        sidecar_index = sys.argv.index("--run-sidecar")
        sidecar_argv = sys.argv[sidecar_index + 1 :]
        import job_sidecar

        job_sidecar.main(sidecar_argv)
        return

    parser = argparse.ArgumentParser(description="Research Agent Server")
    parser.add_argument("--workdir", default=os.getcwd(), help="Working directory for runs and data")
    parser.add_argument("--port", type=int, default=10000, help="Server port")
    parser.add_argument("--host", default="0.0.0.0", help="Server host")
    parser.add_argument(
        "--tmux-session",
        default=TMUX_SESSION_NAME,
        help="Tmux session name for background jobs"
    )
    args = parser.parse_args()
    
    # Initialize paths
    init_paths(args.workdir)
    SERVER_CALLBACK_URL = f"http://127.0.0.1:{args.port}"
    TMUX_SESSION_NAME = args.tmux_session
    
    # Check required environment variables
    if not os.environ.get("RESEARCH_AGENT_KEY"):
        logger.warning("⚠️  RESEARCH_AGENT_KEY environment variable is not set!")
        logger.warning("   The Anthropic gateway requires this for authentication.")
        logger.warning("   Set it with: export RESEARCH_AGENT_KEY=your-gateway-token")
    
    if not USER_AUTH_TOKEN:
        logger.info("RESEARCH_AGENT_USER_AUTH_TOKEN is not set — running without server-side auth.")
        logger.info("   You can set your auth token in the GUI Settings page, or export the env var for remote access.")
    
    # Start OpenCode server subprocess
    # start_opencode_server_subprocess(args)
    
    # Load state
    load_chat_state()
    load_runs_state()
    load_alerts_state()
    load_plans_state()
    load_settings_state()
    if cluster_state.get("source") == "unset":
        inferred = _infer_cluster_from_environment()
        cluster_state.update(_normalize_cluster_state(inferred))
        save_settings_state()
    maybe_mount_frontend_static()
    
    logger.info(f"Starting Research Agent Server on {args.host}:{args.port}")
    logger.info(f"Working directory: {WORKDIR}")
    
    uvicorn.run(app, host=args.host, port=args.port, log_config=None)


if __name__ == "__main__":
    main()
