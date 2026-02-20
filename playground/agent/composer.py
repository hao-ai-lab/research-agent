"""PromptComposer — assembles prompts from composable markdown fragments.

Replaces the monolithic SKILL.md templates with a fragment-based composition
system. Each prompt mode defines an ordered list of fragments to include.
Variables are substituted using {{variable_name}} syntax.
"""

import os
import re
from pathlib import Path
from typing import Dict, List, Optional


# ---------------------------------------------------------------------------
# Fragment composition configs
# ---------------------------------------------------------------------------

# Each mode maps to an ordered list of fragment paths (relative to prompts/)
MODE_FRAGMENTS: Dict[str, List[str]] = {
    "planning": [
        "fragments/identity.md",
        "fragments/context.md",
        "fragments/preflight.md",
        "fragments/api_catalog.md",
        "fragments/experiment_tracking.md",
        "fragments/gpu_scheduling.md",
        "fragments/environment_setup.md",
        "fragments/history_patterns.md",
        "fragments/evo_sweep.md",
        "fragments/output_contracts/planning.md",
    ],
    "iteration": [
        "fragments/identity.md",
        "fragments/context.md",
        "fragments/preflight.md",
        "fragments/api_catalog.md",
        "fragments/experiment_tracking.md",
        "fragments/gpu_scheduling.md",
        "fragments/environment_setup.md",
        "fragments/history_patterns.md",
        "fragments/evo_sweep.md",
        "fragments/output_contracts/iteration.md",
    ],
    "reflection": [
        "fragments/output_contracts/reflection.md",
    ],
    "agent": [
        "modes/agent.md",
    ],
    "idea": [
        "modes/idea.md",
    ],
}


class PromptComposer:
    """Assembles prompts from composable markdown fragments.

    Usage:
        composer = PromptComposer("/path/to/playground/prompts")
        prompt = composer.compose("planning", {"goal": "Train MNIST", ...})
    """

    def __init__(self, prompts_dir: Optional[str] = None):
        if prompts_dir is None:
            prompts_dir = os.path.join(os.path.dirname(__file__), "..", "prompts")
        self.prompts_dir = Path(prompts_dir).resolve()

    def load_fragment(self, relative_path: str) -> str:
        """Load a single fragment file and return its contents."""
        full_path = self.prompts_dir / relative_path
        if not full_path.exists():
            raise FileNotFoundError(f"Fragment not found: {full_path}")
        return full_path.read_text()

    def substitute(self, template: str, variables: Dict[str, str]) -> str:
        """Replace {{variable_name}} placeholders with values.

        - Known variables are substituted with their value.
        - Unknown variables are replaced with empty string.
        - Jinja-style {% if var %}...{% endif %} blocks are evaluated.
        """
        # Handle {% if var %} ... {% endif %} conditionals
        def _eval_conditional(match: re.Match) -> str:
            var_name = match.group(1).strip()
            content = match.group(2)
            if variables.get(var_name):
                return content
            return ""

        result = re.sub(
            r"\{%\s*if\s+(\w+)\s*%\}([\s\S]*?)\{%\s*endif\s*%\}",
            _eval_conditional,
            template,
        )

        # Handle {{variable}} substitution
        def _sub_var(match: re.Match) -> str:
            var_name = match.group(1).strip()
            return variables.get(var_name, "")

        result = re.sub(r"\{\{(\s*\w+\s*)\}\}", _sub_var, result)
        return result

    def compose(self, mode: str, variables: Optional[Dict[str, str]] = None) -> str:
        """Assemble a complete prompt from fragments for the given mode.

        Args:
            mode: One of 'planning', 'iteration', 'reflection', 'agent', 'idea'
            variables: Template variables to substitute

        Returns:
            Fully assembled and substituted prompt string
        """
        if mode not in MODE_FRAGMENTS:
            raise ValueError(
                f"Unknown mode '{mode}'. Available: {list(MODE_FRAGMENTS.keys())}"
            )

        variables = variables or {}
        fragments = MODE_FRAGMENTS[mode]

        sections: List[str] = []
        for frag_path in fragments:
            raw = self.load_fragment(frag_path)
            rendered = self.substitute(raw, variables)
            # Skip fragments that are effectively empty after substitution
            stripped = rendered.strip()
            if stripped and stripped != f"# {Path(frag_path).stem.replace('_', ' ').title()}":
                sections.append(rendered.strip())

        return "\n\n---\n\n".join(sections)

    def list_modes(self) -> List[str]:
        """Return available composition modes."""
        return list(MODE_FRAGMENTS.keys())

    def list_fragments(self, mode: str) -> List[str]:
        """Return fragment paths for a given mode."""
        if mode not in MODE_FRAGMENTS:
            raise ValueError(f"Unknown mode '{mode}'")
        return MODE_FRAGMENTS[mode]

    def save_assembled(self, mode: str, variables: Dict[str, str]) -> Path:
        """Compose a prompt and save it to assembled/ directory."""
        prompt = self.compose(mode, variables)
        out_dir = self.prompts_dir / "assembled"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{mode}.md"
        out_path.write_text(prompt)
        return out_path


# ---------------------------------------------------------------------------
# Convenience
# ---------------------------------------------------------------------------

def create_composer(prompts_dir: Optional[str] = None) -> PromptComposer:
    """Factory function for creating a PromptComposer."""
    return PromptComposer(prompts_dir)
