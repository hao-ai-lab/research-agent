"""Tests for the PromptComposer and fragment system."""

import os
import sys

import pytest

# Add playground to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from agent.composer import PromptComposer, MODE_FRAGMENTS


PROMPTS_DIR = os.path.join(os.path.dirname(__file__), "..", "prompts")


@pytest.fixture
def composer():
    return PromptComposer(PROMPTS_DIR)


@pytest.fixture
def sample_variables():
    return {
        "goal": "Train a simple MNIST classifier",
        "workdir": "/home/user/project",
        "iteration": "1",
        "max_iterations": "25",
        "tasks_path": "/home/user/project/.agents/wild/tasks.md",
        "log_path": "/home/user/project/.agents/wild/iteration_log.md",
        "server_url": "http://127.0.0.1:10000",
        "session_id": "wild-abc123",
        "auth_header": '-H "X-Auth-Token: test-token"',
        "steer_section": "",
        "struggle_section": "",
        "api_catalog": "### API\n- POST /runs\n- GET /runs",
        "memories": "",
        "evo_sweep_section": "",
    }


# --- Fragment integrity tests ---

class TestFragmentFiles:
    """Verify all referenced fragment files exist and are non-empty."""

    def test_all_fragment_files_exist(self, composer):
        """Every fragment path referenced in MODE_FRAGMENTS must exist."""
        for mode, fragments in MODE_FRAGMENTS.items():
            for frag_path in fragments:
                full_path = composer.prompts_dir / frag_path
                assert full_path.exists(), (
                    f"Fragment '{frag_path}' referenced by mode '{mode}' does not exist"
                )

    def test_all_fragment_files_non_empty(self, composer):
        """Every fragment file must have content."""
        for mode, fragments in MODE_FRAGMENTS.items():
            for frag_path in fragments:
                content = composer.load_fragment(frag_path)
                assert len(content.strip()) > 0, (
                    f"Fragment '{frag_path}' is empty"
                )

    def test_mode_prompt_files_exist(self, composer):
        """Mode prompt files (agent.md, idea.md) must exist."""
        for mode_file in ["modes/agent.md", "modes/idea.md"]:
            full_path = composer.prompts_dir / mode_file
            assert full_path.exists(), f"Mode prompt '{mode_file}' does not exist"


# --- Composer basic tests ---

class TestComposer:
    """Test the PromptComposer composition logic."""

    def test_compose_planning(self, composer, sample_variables):
        result = composer.compose("planning", sample_variables)
        assert len(result) > 0
        assert "MNIST" in result  # goal is substituted
        assert "{{goal}}" not in result  # no raw variables remain

    def test_compose_iteration(self, composer, sample_variables):
        result = composer.compose("iteration", sample_variables)
        assert len(result) > 0
        assert "MNIST" in result

    def test_compose_reflection(self, composer, sample_variables):
        variables = {
            **sample_variables,
            "summary_of_work": "Trained 3 models",
            "plan": "- [x] Train baseline",
            "user_availability": "User is present",
        }
        result = composer.compose("reflection", variables)
        assert len(result) > 0
        assert "Trained 3 models" in result

    def test_compose_agent(self, composer, sample_variables):
        result = composer.compose("agent", {
            "experiment_context": "2 runs completed",
            "server_url": "http://localhost:10000",
            "auth_token": "test",
        })
        assert len(result) > 0
        assert "research assistant" in result.lower()

    def test_compose_idea(self, composer, sample_variables):
        result = composer.compose("idea", {
            "goal": "Improve training speed",
            "steer_section": "",
            "workdir": "/project",
        })
        assert len(result) > 0
        assert "Improve training speed" in result

    def test_unknown_mode_raises(self, composer):
        with pytest.raises(ValueError, match="Unknown mode"):
            composer.compose("nonexistent", {})

    def test_no_raw_variables_in_output(self, composer, sample_variables):
        """After substitution, no {{variable}} markers should remain."""
        for mode in ["planning", "iteration"]:
            result = composer.compose(mode, sample_variables)
            # Allow {{id}} in curl examples (those are literal, not template vars)
            # but {{goal}}, {{workdir}} etc should be substituted
            import re
            unsubstituted = re.findall(r"\{\{(\w+)\}\}", result)
            # Filter out known literal uses (like {id} in API URL patterns)
            actual_unsubstituted = [
                v for v in unsubstituted
                if v not in ("id",)
            ]
            assert len(actual_unsubstituted) == 0, (
                f"Mode '{mode}' has unsubstituted variables: {actual_unsubstituted}"
            )


# --- Variable substitution tests ---

class TestSubstitution:
    """Test {{variable}} substitution and {% if %} conditionals."""

    def test_simple_substitution(self, composer):
        result = composer.substitute("Hello {{name}}", {"name": "World"})
        assert result == "Hello World"

    def test_missing_variable_becomes_empty(self, composer):
        result = composer.substitute("Hello {{name}}", {})
        assert result == "Hello "

    def test_conditional_true(self, composer):
        template = "{% if memories %}Memories: {{memories}}{% endif %}"
        result = composer.substitute(template, {"memories": "some lesson"})
        assert "Memories: some lesson" in result

    def test_conditional_false(self, composer):
        template = "{% if memories %}Memories: {{memories}}{% endif %}"
        result = composer.substitute(template, {"memories": ""})
        assert "Memories" not in result

    def test_conditional_missing(self, composer):
        template = "{% if memories %}Memories: {{memories}}{% endif %}"
        result = composer.substitute(template, {})
        assert "Memories" not in result


# --- Content quality tests ---

class TestContentQuality:
    """Verify assembled prompts contain expected sections."""

    def test_planning_has_identity(self, composer, sample_variables):
        result = composer.compose("planning", sample_variables)
        assert "autonomous research engineer" in result.lower()

    def test_planning_has_preflight(self, composer, sample_variables):
        result = composer.compose("planning", sample_variables)
        assert "preflight" in result.lower()

    def test_planning_has_experiment_tracking(self, composer, sample_variables):
        result = composer.compose("planning", sample_variables)
        assert "NEVER run experiments directly" in result

    def test_planning_has_output_contract(self, composer, sample_variables):
        result = composer.compose("planning", sample_variables)
        assert "<plan>" in result

    def test_iteration_has_summary_tag(self, composer, sample_variables):
        result = composer.compose("iteration", sample_variables)
        assert "<summary>" in result

    def test_iteration_has_promise_tag(self, composer, sample_variables):
        result = composer.compose("iteration", sample_variables)
        assert "<promise>DONE</promise>" in result

    def test_reflection_has_continue_tag(self, composer, sample_variables):
        variables = {
            **sample_variables,
            "summary_of_work": "Done",
            "plan": "",
            "user_availability": "User is present",
        }
        result = composer.compose("reflection", variables)
        assert "<continue>" in result

    def test_reflection_has_memories_tag(self, composer, sample_variables):
        variables = {
            **sample_variables,
            "summary_of_work": "Done",
            "plan": "",
            "user_availability": "User is present",
        }
        result = composer.compose("reflection", variables)
        assert "<memories>" in result


# --- Structural comparison test ---

class TestStructuralComparison:
    """Compare the composed prompt structure against the original monolithic prompts."""

    def test_planning_fragment_count(self, composer):
        """Planning should compose from multiple fragments, not one monolith."""
        frags = composer.list_fragments("planning")
        assert len(frags) >= 8, (
            f"Planning uses only {len(frags)} fragments — should decompose more"
        )

    def test_iteration_fragment_count(self, composer):
        frags = composer.list_fragments("iteration")
        assert len(frags) >= 8

    def test_reflection_is_self_contained(self, composer):
        """Reflection is naturally compact — single fragment is fine."""
        frags = composer.list_fragments("reflection")
        assert len(frags) == 1

    def test_no_duplicate_fragments_in_mode(self, composer):
        """No mode should include the same fragment twice."""
        for mode in composer.list_modes():
            frags = composer.list_fragments(mode)
            assert len(frags) == len(set(frags)), (
                f"Mode '{mode}' has duplicate fragments"
            )
