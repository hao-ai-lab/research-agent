"""Tests for MemoryView -- scoped interface to FileStore."""

import tempfile

import pytest

from agentsys.filestore import FileStore
from agentsys.memory import MemoryView
from agentsys.types import Entry, EntryType


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

@pytest.fixture
def store(tmp_path):
    return FileStore(tmp_path, "test")


def _make_view(
    agent_id: str = "exec-1",
    store: FileStore | None = None,
    tmp_path=None,
    **scope_overrides,
) -> MemoryView:
    """Create a MemoryView with default scope, overridable."""
    if store is None:
        store = FileStore(tmp_path or tempfile.mkdtemp(), "test")
    scope = {
        "project": "proj",
        "session": "sess-A",
        "sweep": "sweep-1",
        "run": "run-1",
        "role": "executor",
    }
    scope.update(scope_overrides)
    return MemoryView(agent_id=agent_id, scope=scope, store=store)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestWrite:

    def test_write_auto_fills_scope(self, store):
        view = _make_view(store=store)

        key = view.write({"info": "test"}, type=EntryType.CONTEXT)
        entry = store.query()[0]

        assert entry.key == key
        assert entry.agent_id == "exec-1"
        assert entry.project == "proj"
        assert entry.session == "sess-A"
        assert entry.sweep == "sweep-1"
        assert entry.run == "run-1"
        assert entry.role == "executor"
        assert entry.type == EntryType.CONTEXT

    def test_write_with_tags(self, store):
        view = _make_view(store=store)
        view.write({"x": 1}, type=EntryType.METRICS, tags=["lr", "training"])

        entries = view.store.query(tags=["lr"])
        assert len(entries) == 1
        assert "lr" in entries[0].tags


class TestMsg:

    def test_msg_creates_message_entry_with_target(self, store):
        view = _make_view(agent_id="orch-1", store=store, role="orchestrator")

        key = view.msg("exec-1", {"suggestion": "try lr=1e-4"})
        entry = store.query(type=EntryType.MESSAGE)[0]

        assert entry.key == key
        assert entry.agent_id == "orch-1"
        assert entry.target_id == "exec-1"
        assert entry.type == EntryType.MESSAGE
        assert entry.data == {"suggestion": "try lr=1e-4"}

    def test_msg_with_tags(self, store):
        view = _make_view(store=store)
        view.msg("orch-1", {"note": "done"}, tags=["status"])

        entries = view.store.query(tags=["status"])
        assert len(entries) == 1


class TestReadSelf:

    def test_read_self_returns_own_entries(self, store):
        view_a = _make_view(agent_id="exec-1", store=store)
        view_b = _make_view(agent_id="exec-2", store=store)

        view_a.write({"a": 1}, type=EntryType.RESULT)
        view_b.write({"b": 2}, type=EntryType.RESULT)

        own = view_a.read_self()
        assert len(own) == 1
        assert own[0].data == {"a": 1}


class TestInbox:

    def test_read_inbox_returns_messages_for_me(self, store):
        exec_view = _make_view(agent_id="exec-1", store=store)
        orch_view = _make_view(agent_id="orch-1", store=store, role="orchestrator")

        orch_view.msg("exec-1", {"suggestion": "try lr=1e-4"})
        orch_view.msg("exec-2", {"suggestion": "try lr=1e-3"})

        inbox = exec_view.read_inbox()
        assert len(inbox) == 1
        assert inbox[0].data == {"suggestion": "try lr=1e-4"}

    def test_ack_deletes_message(self, store):
        exec_view = _make_view(agent_id="exec-1", store=store)
        orch_view = _make_view(agent_id="orch-1", store=store, role="orchestrator")

        orch_view.msg("exec-1", {"note": "hi"})
        inbox = exec_view.read_inbox()
        assert len(inbox) == 1

        assert exec_view.ack(inbox[0].key) is True
        assert exec_view.read_inbox() == []
        assert exec_view.ack(inbox[0].key) is False


class TestAssembleContext:

    def test_assemble_context_includes_own_entries(self, store):
        view = _make_view(store=store)
        view.write({"step": 1}, type=EntryType.CONTEXT)
        view.write({"step": 2}, type=EntryType.REFLECTION)

        ctx = view.assemble_context(token_budget=1000)
        assert "My Entries" in ctx
        assert "step" in ctx

    def test_assemble_context_includes_inbox(self, store):
        exec_view = _make_view(agent_id="exec-1", store=store)
        orch_view = _make_view(agent_id="orch-1", store=store, role="orchestrator")

        orch_view.msg("exec-1", {"suggestion": "try lr=1e-4"})

        ctx = exec_view.assemble_context(token_budget=1000)
        assert "Inbox" in ctx
        assert "lr=1e-4" in ctx

    def test_assemble_context_widens_by_scope(self, store):
        run_view = _make_view(
            agent_id="exec-1", store=store,
            sweep="sweep-1", run="run-1",
        )
        other_view = _make_view(
            agent_id="exec-2", store=store,
            sweep="sweep-1", run="run-2",
        )

        other_view.write(
            {"info": "sweep-level-context"},
            type=EntryType.CONTEXT,
        )

        ctx = run_view.assemble_context(token_budget=2000)
        assert "sweep-level-context" in ctx

    def test_assemble_context_respects_token_budget(self, store):
        view = _make_view(store=store)
        for i in range(50):
            view.write({"data": "x" * 200}, type=EntryType.CONTEXT)

        ctx = view.assemble_context(token_budget=100)
        assert len(ctx) <= 500
        assert "[truncated]" in ctx

    def test_assemble_context_excludes_raw_files(self, store):
        view = _make_view(store=store)
        view.write({"content": "raw stuff"}, type=EntryType.RAW_FILE)
        view.write({"content": "context stuff"}, type=EntryType.CONTEXT)

        ctx = view.assemble_context(token_budget=1000)
        assert "raw stuff" not in ctx
        assert "context stuff" in ctx
