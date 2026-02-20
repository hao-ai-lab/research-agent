"""
Research Agent Server — Pydantic Models

All request/response models and validation constants, extracted from server.py.
"""

from typing import List, Optional

from pydantic import BaseModel, Field


# =============================================================================
# Chat Models
# =============================================================================

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
    workdir: Optional[str] = None


class UpdateSessionRequest(BaseModel):
    title: str


class SystemPromptUpdate(BaseModel):
    system_prompt: str = ""


class SessionWorkdirUpdate(BaseModel):
    workdir: str


class SessionModelUpdate(BaseModel):
    provider_id: str
    model_id: str


# =============================================================================
# Run Models
# =============================================================================

# Run State Machine: ready -> queued -> launching -> running -> finished/failed/stopped
# - ready: Created but not submitted for execution
# - queued: Submitted, waiting to be picked up
# - launching: Tmux window being created
# - running: Command actively executing
# - finished/failed/stopped: Terminal states

class GpuwrapConfig(BaseModel):
    enabled: Optional[bool] = None
    retries: Optional[int] = Field(default=None, ge=-1)
    retry_delay_seconds: Optional[float] = Field(default=None, gt=0, le=600)


class RunCreate(BaseModel):
    name: str
    command: str
    workdir: Optional[str] = None
    sweep_id: Optional[str] = None  # If part of a sweep
    parent_run_id: Optional[str] = None
    origin_alert_id: Optional[str] = None
    chat_session_id: Optional[str] = None  # Originating chat session for traceability
    auto_start: bool = False  # If True, skip ready and go straight to queued
    gpuwrap_config: Optional[GpuwrapConfig] = None


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


# =============================================================================
# Sweep Models
# =============================================================================

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


# =============================================================================
# Alert Models
# =============================================================================

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
    gpuwrap_config: Optional[GpuwrapConfig] = None


class WildModeRequest(BaseModel):
    enabled: bool


# =============================================================================
# Plan Models
# =============================================================================

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


# =============================================================================
# Cluster Models
# =============================================================================

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
# Journey Models
# =============================================================================

class JourneyNextActionsRequest(BaseModel):
    journey: dict
    max_actions: int = Field(default=3, ge=1, le=8)

JOURNEY_ACTOR_VALUES = {"human", "agent", "system"}
JOURNEY_REC_STATUS_VALUES = {"pending", "accepted", "rejected", "modified", "executed", "dismissed"}
JOURNEY_PRIORITY_VALUES = {"low", "medium", "high", "critical"}
JOURNEY_DECISION_STATUS_VALUES = {"recorded", "executed", "superseded"}


class JourneyEventCreate(BaseModel):
    kind: str
    actor: str = "system"
    session_id: Optional[str] = None
    run_id: Optional[str] = None
    chart_id: Optional[str] = None
    recommendation_id: Optional[str] = None
    decision_id: Optional[str] = None
    note: Optional[str] = None
    metadata: Optional[dict] = None
    timestamp: Optional[float] = None


class JourneyRecommendationCreate(BaseModel):
    title: str
    action: str
    rationale: Optional[str] = None
    source: str = "agent"
    priority: str = "medium"
    confidence: Optional[float] = Field(default=None, ge=0, le=1)
    session_id: Optional[str] = None
    run_id: Optional[str] = None
    chart_id: Optional[str] = None
    evidence_refs: List[str] = Field(default_factory=list)


class JourneyRecommendationRespondRequest(BaseModel):
    status: str
    user_note: Optional[str] = None
    modified_action: Optional[str] = None


class JourneyDecisionCreate(BaseModel):
    title: str
    chosen_action: str
    rationale: Optional[str] = None
    outcome: Optional[str] = None
    status: str = "recorded"
    recommendation_id: Optional[str] = None
    session_id: Optional[str] = None
    run_id: Optional[str] = None
    chart_id: Optional[str] = None


# =============================================================================
# Memory Models
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

