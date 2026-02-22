"""Tests for FileStore -- filesystem-backed store with query API."""

import json
import time

import pytest

from agentsys.filestore import FileStore
from agentsys.memory import MemoryView
from agentsys.types import AgentInfo, AgentStatus, Entry, EntryType


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_entry(**overrides) -> Entry:
    """Create an Entry with sensible defaults, overridable per-field."""
    defaults = dict(
        key="",
        agent_id="agent-1",
        target_id=None,
        type=EntryType.CONTEXT,
        project="proj",
        session="sess-A",
        sweep=None,
        run=None,
        role="executor",
        tags=[],
        data={"info": "test"},
        created_at=0.0,
    )
    defaults.update(overrides)
    return Entry(**defaults)


@pytest.fixture
def store(tmp_path):
    return FileStore(tmp_path, "test-proj")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestWriteAndQuery:

    def test_write_and_query_by_project(self, store):
        store.write(_make_entry(project="alpha"))
        store.write(_make_entry(project="beta"))

        results = store.query(project="alpha")
        assert len(results) == 1
        assert results[0].project == "alpha"

    def test_write_auto_generates_key_and_timestamp(self, store):
        entry = _make_entry()
        key = store.write(entry)

        assert len(key) == 12
        assert entry.key == key
        assert entry.created_at > 0

    def test_file_exists_on_disk(self, store, tmp_path):
        entry = _make_entry()
        store.write(entry)

        agent_dir = tmp_path / "test-proj" / "agent-1"
        json_files = list(agent_dir.glob("*.json"))
        assert len(json_files) == 1
        assert json_files[0].name.endswith(f"_{entry.key}.json")

    def test_no_tmp_files_persist(self, store, tmp_path):
        for i in range(5):
            store.write(_make_entry(data={"i": i}))

        agent_dir = tmp_path / "test-proj" / "agent-1"
        tmp_files = list(agent_dir.glob("*.tmp"))
        assert len(tmp_files) == 0


class TestScopeFilters:

    def test_query_scope_filters(self, store):
        store.write(_make_entry(session="A", sweep="1", run="r1"))
        store.write(_make_entry(session="A", sweep="1", run="r2"))
        store.write(_make_entry(session="A", sweep="2", run="r3"))
        store.write(_make_entry(session="B", sweep="1", run="r4"))

        results = store.query(project="proj", session="A", sweep="1")
        assert len(results) == 2

        results = store.query(project="proj", session="A")
        assert len(results) == 3

    def test_query_unspecified_field_is_unconstrained(self, store):
        store.write(_make_entry(sweep=None))
        store.write(_make_entry(sweep="1"))
        store.write(_make_entry(sweep="2"))

        results = store.query(project="proj", session="sess-A")
        assert len(results) == 3


class TestTypeFilters:

    def test_query_type_single(self, store):
        store.write(_make_entry(type=EntryType.ALERT))
        store.write(_make_entry(type=EntryType.METRICS))
        store.write(_make_entry(type=EntryType.CONTEXT))

        results = store.query(type=EntryType.ALERT)
        assert len(results) == 1
        assert results[0].type == EntryType.ALERT

    def test_query_type_list(self, store):
        store.write(_make_entry(type=EntryType.ALERT))
        store.write(_make_entry(type=EntryType.METRICS))
        store.write(_make_entry(type=EntryType.CONTEXT))

        results = store.query(type=[EntryType.ALERT, EntryType.METRICS])
        assert len(results) == 2

    def test_query_type_not_excludes(self, store):
        store.write(_make_entry(type=EntryType.RAW_FILE))
        store.write(_make_entry(type=EntryType.METRICS))
        store.write(_make_entry(type=EntryType.CONTEXT))

        results = store.query(type_not=EntryType.RAW_FILE)
        assert len(results) == 2
        assert all(e.type != EntryType.RAW_FILE for e in results)

    def test_query_type_not_list(self, store):
        store.write(_make_entry(type=EntryType.RAW_FILE))
        store.write(_make_entry(type=EntryType.METRICS))
        store.write(_make_entry(type=EntryType.CONTEXT))

        results = store.query(type_not=[EntryType.RAW_FILE, EntryType.METRICS])
        assert len(results) == 1
        assert results[0].type == EntryType.CONTEXT


class TestTagFilter:

    def test_query_tags_or_matching(self, store):
        store.write(_make_entry(tags=["lr", "training"]))
        store.write(_make_entry(tags=["reward"]))
        store.write(_make_entry(tags=["lr", "reward"]))
        store.write(_make_entry(tags=[]))

        results = store.query(tags=["lr"])
        assert len(results) == 2

        results = store.query(tags=["lr", "reward"])
        assert len(results) == 3


class TestTimeFilters:

    def test_query_since_and_before(self, store):
        e1 = _make_entry()
        e2 = _make_entry()
        e3 = _make_entry()

        store.write(e1)
        store.write(e2)
        store.write(e3)

        # Override timestamps for deterministic filtering
        # We need to update the files on disk too
        e1.created_at = 1000.0
        e2.created_at = 2000.0
        e3.created_at = 3000.0

        # Rewrite the files with patched timestamps
        for entry in [e1, e2, e3]:
            path = store._key_to_path[entry.key]
            data = json.loads(path.read_text())
            data["created_at"] = entry.created_at
            path.write_text(json.dumps(data))

        results = store.query(since=2000.0)
        assert len(results) == 2

        results = store.query(before=2000.0)
        assert len(results) == 1


class TestResultControl:

    def test_query_limit_and_order(self, store):
        for i in range(5):
            store.write(_make_entry(data={"i": i}))

        results = store.query(limit=2, order="desc")
        assert len(results) == 2
        assert results[0].created_at >= results[1].created_at

        results = store.query(limit=3, order="asc")
        assert len(results) == 3
        assert results[0].created_at <= results[1].created_at

    def test_latest_returns_most_recent(self, store):
        store.write(_make_entry(data={"v": "old"}))
        store.write(_make_entry(data={"v": "new"}))

        latest = store.latest(project="proj")
        assert latest is not None
        assert latest.data["v"] == "new"

    def test_latest_returns_none_when_empty(self, store):
        assert store.latest(project="nonexistent") is None


class TestDeleteAndListeners:

    def test_delete_removes_entry(self, store):
        key = store.write(_make_entry())

        assert store.delete(key) is True
        assert store.query() == []
        assert store.delete(key) is False

    def test_on_write_callback_fires(self, store):
        received: list[Entry] = []
        store.add_listener(lambda e: received.append(e))

        store.write(_make_entry())
        store.write(_make_entry())

        assert len(received) == 2


class TestIdentityFilters:

    def test_query_by_agent_id(self, store):
        store.write(_make_entry(agent_id="orch-1"))
        store.write(_make_entry(agent_id="exec-2"))

        results = store.query(agent_id="orch-1")
        assert len(results) == 1

    def test_query_by_target_id(self, store):
        store.write(_make_entry(target_id="exec-2", type=EntryType.MESSAGE))
        store.write(_make_entry(target_id=None))

        results = store.query(target_id="exec-2")
        assert len(results) == 1

    def test_query_by_role(self, store):
        store.write(_make_entry(role="orchestrator"))
        store.write(_make_entry(role="executor"))
        store.write(_make_entry(role="sidecar"))

        results = store.query(role="sidecar")
        assert len(results) == 1


class TestCrossAgentQuery:

    def test_cross_agent_directory_query(self, store):
        store.write(_make_entry(agent_id="agent-1", data={"from": "a1"}))
        store.write(_make_entry(agent_id="agent-2", data={"from": "a2"}))
        store.write(_make_entry(agent_id="agent-3", data={"from": "a3"}))

        # Query all agents
        results = store.query(project="proj")
        assert len(results) == 3

        # Query specific agent
        results = store.query(agent_id="agent-2")
        assert len(results) == 1
        assert results[0].data["from"] == "a2"


class TestCorruptFileHandling:

    def test_corrupt_json_skipped(self, store, tmp_path):
        # Write a valid entry first
        store.write(_make_entry(data={"valid": True}))

        # Create a corrupt JSON file
        agent_dir = tmp_path / "test-proj" / "agent-1"
        corrupt_file = agent_dir / "999999_context_badkey.json"
        corrupt_file.write_text("not valid json{{{")

        # Query should skip corrupt file and return valid entries
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            results = store.query()

        assert len(results) == 1
        assert results[0].data["valid"] is True


class TestMetadata:

    def test_write_and_read_meta(self, store):
        store.write_meta("agent-1", {"id": "agent-1", "status": "running"})
        meta = store.read_meta("agent-1")

        assert meta is not None
        assert meta["id"] == "agent-1"
        assert meta["status"] == "running"

    def test_read_meta_nonexistent(self, store):
        assert store.read_meta("nonexistent") is None

    def test_read_agent_info_roundtrip(self, store):
        meta = {
            "id": "exec-abc",
            "role": "executor",
            "status": "running",
            "goal": "test goal",
            "config": {"key": "val"},
            "parent_id": "orch-123",
            "children": ["sc-1"],
            "agent_cls_path": "agentsys.agents.executor.ExecutorAgent",
            "iteration": 5,
            "scope": {"project": "p", "session": "s"},
        }
        store.write_meta("exec-abc", meta)

        info = store.read_agent_info("exec-abc")
        assert info is not None
        assert isinstance(info, AgentInfo)
        assert info.id == "exec-abc"
        assert info.role == "executor"
        assert info.status == AgentStatus.RUNNING
        assert info.goal == "test goal"
        assert info.config == {"key": "val"}
        assert info.parent_id == "orch-123"
        assert info.children == ["sc-1"]
        assert info.iteration == 5


class TestMemoryViewCompat:

    def test_memoryview_works_with_filestore(self, store):
        view = MemoryView(
            agent_id="exec-1",
            scope={
                "project": "proj", "session": "s", "sweep": None,
                "run": None, "role": "executor",
            },
            store=store,
        )

        key = view.write({"step": 1}, type=EntryType.CONTEXT)
        assert len(key) == 12

        own = view.read_self()
        assert len(own) == 1

        view.msg("other-agent", {"hello": "world"})
        # Check message is stored
        msgs = store.query(type=EntryType.MESSAGE, target_id="other-agent")
        assert len(msgs) == 1


class TestLen:

    def test_len_counts_files(self, store):
        assert len(store) == 0
        store.write(_make_entry(agent_id="a1"))
        store.write(_make_entry(agent_id="a2"))
        assert len(store) == 2
