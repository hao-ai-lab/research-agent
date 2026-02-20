"""Tests for PromptSkillManager CRUD, search, and internal skill protection."""

import os
import shutil
import tempfile
import pytest

# We need to import from server.server directly since server/ is not
# a Python package (no __init__.py).
import sys
import importlib.util
from unittest.mock import MagicMock

_repo = os.path.join(os.path.dirname(__file__), "..")
_server_dir = os.path.join(_repo, "server")
sys.path.insert(0, _repo)
sys.path.insert(0, _server_dir)

# Stub out heavy C-extension / optional deps that PromptSkillManager doesn't need.
for _mod_name in ["libtmux", "sse_starlette", "sse_starlette.sse", "dotenv"]:
    if _mod_name not in sys.modules:
        sys.modules[_mod_name] = MagicMock()

# Load server.py by filepath so we avoid the "server is not a package" problem.
_spec = importlib.util.spec_from_file_location("server_module", os.path.join(_server_dir, "server.py"))
_server_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_server_mod)

PromptSkillManager = _server_mod.PromptSkillManager
INTERNAL_SKILL_IDS = _server_mod.INTERNAL_SKILL_IDS
INTERNAL_SKILL_PREFIXES = _server_mod.INTERNAL_SKILL_PREFIXES

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def tmp_skills_dir(tmp_path):
    """Create a temp directory pre-populated with one internal + one user skill."""
    # Internal skill: ra_mode_plan
    internal = tmp_path / "ra_mode_plan"
    internal.mkdir()
    (internal / "SKILL.md").write_text(
        "---\nname: Research Agent — Plan Mode\ndescription: Plans research tasks\ncategory: skill\n---\nTemplate body for planning.\n"
    )

    # User skill: my_custom_skill
    custom = tmp_path / "my_custom_skill"
    custom.mkdir()
    (custom / "SKILL.md").write_text(
        "---\nname: My Custom Skill\ndescription: A user-created skill\ncategory: skill\n---\nCustom template body.\n"
    )

    return tmp_path


@pytest.fixture
def manager(tmp_skills_dir):
    """PromptSkillManager pointing at our temp directory."""
    return PromptSkillManager(skills_dir=str(tmp_skills_dir))


# ---------------------------------------------------------------------------
# Internal flag tests
# ---------------------------------------------------------------------------

class TestInternalFlag:
    def test_internal_flag_set_for_internal_skills(self, manager):
        """Internal skills should have internal=True."""
        skill = manager.get("ra_mode_plan")
        assert skill is not None
        assert skill["internal"] is True

    def test_internal_flag_not_set_for_user_skills(self, manager):
        """User-created skills should have internal=False."""
        skill = manager.get("my_custom_skill")
        assert skill is not None
        assert skill["internal"] is False

    def test_all_internal_ids_defined(self):
        """Smoke test that the expected internal IDs exist."""
        expected = {"ra_mode_plan"}
        assert INTERNAL_SKILL_IDS == expected

    def test_wild_v2_skills_are_internal(self, manager, tmp_skills_dir):
        """Skills with wild_v2_ prefix should be marked as internal."""
        wild_dir = tmp_skills_dir / "wild_v2_planning"
        wild_dir.mkdir()
        (wild_dir / "SKILL.md").write_text(
            "---\nname: Wild V2 Planning\ndescription: Planning skill\ncategory: prompt\n---\nTemplate body.\n"
        )
        manager.load_all()
        skill = manager.get("wild_v2_planning")
        assert skill is not None
        assert skill["internal"] is True

    def test_wild_v2_prefix_in_prefixes(self):
        """Ensure wild_v2_ is registered as an internal prefix."""
        assert "wild_v2_" in INTERNAL_SKILL_PREFIXES


# ---------------------------------------------------------------------------
# Create tests
# ---------------------------------------------------------------------------

class TestCreateSkill:
    def test_create_skill(self, manager, tmp_skills_dir):
        """Creating a skill should produce a folder with SKILL.md."""
        result = manager.create(name="Test Skill", description="A test")
        assert result["id"] == "test_skill"
        assert result["name"] == "Test Skill"
        assert result["description"] == "A test"
        assert result["internal"] is False

        # Folder + file exist on disk
        skill_md = tmp_skills_dir / "test_skill" / "SKILL.md"
        assert skill_md.exists()
        content = skill_md.read_text()
        assert "Test Skill" in content

    def test_create_duplicate_raises(self, manager):
        """Creating a skill with an existing ID should raise ValueError."""
        manager.create(name="Unique Skill")
        with pytest.raises(ValueError, match="already exists"):
            manager.create(name="Unique Skill")

    def test_create_appears_in_list(self, manager):
        """Newly created skill should appear in list()."""
        before = len(manager.list())
        manager.create(name="Listed Skill")
        after = len(manager.list())
        assert after == before + 1

    def test_create_with_template(self, manager):
        """Template content is written to disk."""
        result = manager.create(name="Templ Skill", template="Hello {{name}}")
        assert "Hello {{name}}" in result["template"]


# ---------------------------------------------------------------------------
# Delete tests
# ---------------------------------------------------------------------------

class TestDeleteSkill:
    def test_delete_user_skill(self, manager, tmp_skills_dir):
        """Deleting a user skill should remove folder and cache entry."""
        assert manager.get("my_custom_skill") is not None
        manager.delete("my_custom_skill")
        assert manager.get("my_custom_skill") is None
        assert not (tmp_skills_dir / "my_custom_skill").exists()

    def test_delete_internal_skill_blocked(self, manager):
        """Deleting an internal skill should raise ValueError."""
        with pytest.raises(ValueError, match="Cannot delete internal skill"):
            manager.delete("ra_mode_plan")
        # Skill still exists
        assert manager.get("ra_mode_plan") is not None

    def test_delete_nonexistent_raises(self, manager):
        """Deleting a skill that doesn't exist should raise KeyError."""
        with pytest.raises(KeyError, match="not found"):
            manager.delete("does_not_exist")

    def test_update_internal_skill_allowed(self, manager):
        """Internal skills CAN be updated even though they can't be deleted."""
        updated = manager.update("ra_mode_plan", "new template body")
        assert updated is not None
        assert "new template body" in updated["template"]


# ---------------------------------------------------------------------------
# Search tests
# ---------------------------------------------------------------------------

class TestSearch:
    def test_search_by_name(self, manager):
        """Search should find skills by name substring."""
        results = manager.search("plan")
        assert any(r["id"] == "ra_mode_plan" for r in results)

    def test_search_by_description(self, manager):
        """Search should find skills by description."""
        results = manager.search("user-created")
        assert any(r["id"] == "my_custom_skill" for r in results)

    def test_search_by_template(self, manager):
        """Search should find skills by template body content."""
        results = manager.search("planning")
        assert len(results) >= 1

    def test_search_empty_query_returns_all(self, manager):
        """Empty query should return all skills."""
        results = manager.search("")
        assert len(results) == len(manager.list())

    def test_search_no_match(self, manager):
        """Unmatched query returns empty list."""
        results = manager.search("zzzznonexistent_query_xyz")
        assert results == []

    def test_search_scoring_order(self, manager):
        """Exact name match should score higher than body match."""
        manager.create(name="alert finder", description="finds alerts",
                       template="nothing here")
        results = manager.search("alert finder")
        # Exact name match ("alert finder") should be first
        assert results[0]["id"] == "alert_finder"

    def test_search_limit(self, manager):
        """Results should respect the limit parameter."""
        for i in range(5):
            manager.create(name=f"bulk skill {i}")
        results = manager.search("bulk", limit=3)
        assert len(results) == 3

    def test_search_results_have_score(self, manager):
        """Search results should include a _score field."""
        results = manager.search("wild")
        assert all("_score" in r for r in results)


# ---------------------------------------------------------------------------
# Install from git (mocked)
# ---------------------------------------------------------------------------

class TestInstallFromGit:
    def test_install_from_git_success(self, manager, tmp_skills_dir, monkeypatch):
        """Successful git clone should parse SKILL.md and add to cache."""
        def mock_subprocess_run(cmd, **kwargs):
            # Simulate git clone by creating the directory + SKILL.md
            dest = cmd[-1]
            os.makedirs(dest, exist_ok=True)
            with open(os.path.join(dest, "SKILL.md"), "w") as f:
                f.write("---\nname: Cloned Skill\ndescription: From git\n---\nCloned content.\n")

            class Result:
                returncode = 0
                stderr = ""
            return Result()

        import subprocess
        monkeypatch.setattr(subprocess, "run", mock_subprocess_run)

        result = manager.install_from_git("https://github.com/user/my-skill.git")
        assert result["id"] == "my-skill"
        assert result["name"] == "Cloned Skill"
        assert manager.get("my-skill") is not None

    def test_install_duplicate_raises(self, manager, monkeypatch):
        """Installing to an existing ID should raise ValueError."""
        with pytest.raises(ValueError, match="already exists"):
            manager.install_from_git("https://github.com/user/ra_mode_plan.git",
                                     name="ra_mode_plan")

    def test_install_no_skill_md_raises(self, manager, tmp_skills_dir, monkeypatch):
        """If the cloned repo has no SKILL.md, raise FileNotFoundError."""
        def mock_subprocess_run(cmd, **kwargs):
            dest = cmd[-1]
            os.makedirs(dest, exist_ok=True)
            # No SKILL.md created

            class Result:
                returncode = 0
                stderr = ""
            return Result()

        import subprocess
        monkeypatch.setattr(subprocess, "run", mock_subprocess_run)

        with pytest.raises(FileNotFoundError, match="SKILL.md"):
            manager.install_from_git("https://github.com/user/no-skill.git")
        # Folder should be cleaned up
        assert not (tmp_skills_dir / "no-skill").exists()

    def test_install_git_failure_raises(self, manager, monkeypatch):
        """Git clone failure should raise RuntimeError."""
        def mock_subprocess_run(cmd, **kwargs):
            class Result:
                returncode = 128
                stderr = "fatal: repository not found"
            return Result()

        import subprocess
        monkeypatch.setattr(subprocess, "run", mock_subprocess_run)

        with pytest.raises(RuntimeError, match="git clone failed"):
            manager.install_from_git("https://github.com/user/bad-repo.git")
