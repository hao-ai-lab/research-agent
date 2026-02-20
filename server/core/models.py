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
    thinking: str | None = None
    timestamp: float | None = None


class ChatRequest(BaseModel):
    session_id: str
    message: str
    mode: str = "agent"  # "agent" | "wild" | "plan" | "sweep"
    # When provided, this is used for LLM prompt construction instead of message.
    # `message` is still stored as the user-visible content in the session history.
    prompt_override: str | None = None
    # Backward compat: accept old boolean fields and convert
    wild_mode: bool = False
    plan_mode: bool = False


class CreateSessionRequest(BaseModel):
    title: str | None = None
    model_provider: str | None = None
    model_id: str | None = None


class UpdateSessionRequest(BaseModel):
    title: str


class SystemPromptUpdate(BaseModel):
    system_prompt: str = ""


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
    enabled: bool | None = None
    retries: int | None = Field(default=None, ge=0, le=20)
    retry_delay_seconds: float | None = Field(default=None, gt=0, le=600)
    max_memory_used_mb: int | None = Field(default=None, ge=0, le=10_000_000)
    max_utilization: int | None = Field(default=None, ge=0, le=100)


class RunCreate(BaseModel):
    name: str
    command: str
    workdir: str | None = None
    sweep_id: str | None = None  # If part of a sweep
    parent_run_id: str | None = None
    origin_alert_id: str | None = None
    chat_session_id: str | None = None  # Originating chat session for traceability
    auto_start: bool = False  # If True, skip ready and go straight to queued
    gpuwrap_config: GpuwrapConfig | None = None


class RunStatusUpdate(BaseModel):
    status: str  # launching, running, finished, failed, stopped
    exit_code: int | None = None
    error: str | None = None
    tmux_pane: str | None = None
    wandb_dir: str | None = None


class RunUpdate(BaseModel):
    name: str | None = None
    command: str | None = None
    workdir: str | None = None


# =============================================================================
# Sweep Models
# =============================================================================


class SweepCreate(BaseModel):
    name: str
    base_command: str
    workdir: str | None = None
    parameters: dict  # e.g., {"lr": [0.001, 0.01], "batch_size": [32, 64]}
    max_runs: int = 10
    auto_start: bool = False
    goal: str | None = None
    status: str | None = None  # draft, pending, running
    ui_config: dict | None = None
    chat_session_id: str | None = None  # Originating chat session for traceability


class SweepUpdate(BaseModel):
    name: str | None = None
    base_command: str | None = None
    workdir: str | None = None
    parameters: dict | None = None
    max_runs: int | None = None
    goal: str | None = None
    status: str | None = None  # draft, pending, running, completed, failed, canceled
    ui_config: dict | None = None


# =============================================================================
# Alert Models
# =============================================================================


class AlertRecord(BaseModel):
    id: str
    run_id: str
    timestamp: float
    severity: str = "warning"
    message: str
    choices: list[str]
    status: str = "pending"  # pending, resolved
    response: str | None = None
    responded_at: float | None = None
    session_id: str | None = None
    auto_session: bool = False


class CreateAlertRequest(BaseModel):
    message: str
    choices: list[str]
    severity: str = "warning"


class RespondAlertRequest(BaseModel):
    choice: str


class RunRerunRequest(BaseModel):
    command: str | None = None
    auto_start: bool = False
    origin_alert_id: str | None = None
    gpuwrap_config: GpuwrapConfig | None = None


class WildModeRequest(BaseModel):
    enabled: bool


# =============================================================================
# Plan Models
# =============================================================================

PLAN_STATUSES = {"draft", "approved", "executing", "completed", "archived"}


class PlanCreate(BaseModel):
    title: str
    goal: str
    session_id: str | None = None
    sections: dict | None = None  # structured sections parsed from LLM output
    raw_markdown: str = ""  # full LLM response markdown


class PlanUpdate(BaseModel):
    title: str | None = None
    status: str | None = None  # draft, approved, executing, completed, archived
    sections: dict | None = None
    raw_markdown: str | None = None


# =============================================================================
# Cluster Models
# =============================================================================


class ClusterUpdateRequest(BaseModel):
    type: str | None = None
    status: str | None = None
    source: str | None = None
    head_node: str | None = None
    node_count: int | None = None
    gpu_count: int | None = None
    notes: str | None = None
    details: dict | None = None


class ClusterDetectRequest(BaseModel):
    preferred_type: str | None = None


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
    session_id: str | None = None
    run_id: str | None = None
    chart_id: str | None = None
    recommendation_id: str | None = None
    decision_id: str | None = None
    note: str | None = None
    metadata: dict | None = None
    timestamp: float | None = None


class JourneyRecommendationCreate(BaseModel):
    title: str
    action: str
    rationale: str | None = None
    source: str = "agent"
    priority: str = "medium"
    confidence: float | None = Field(default=None, ge=0, le=1)
    session_id: str | None = None
    run_id: str | None = None
    chart_id: str | None = None
    evidence_refs: list[str] = Field(default_factory=list)


class JourneyRecommendationRespondRequest(BaseModel):
    status: str
    user_note: str | None = None
    modified_action: str | None = None


class JourneyDecisionCreate(BaseModel):
    title: str
    chosen_action: str
    rationale: str | None = None
    outcome: str | None = None
    status: str = "recorded"
    recommendation_id: str | None = None
    session_id: str | None = None
    run_id: str | None = None
    chart_id: str | None = None


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
    title: str | None = None
    content: str | None = None
    is_active: bool | None = None
    tags: list | None = None
