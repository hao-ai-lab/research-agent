"""
Prompt Skill Manager — manages prompt template files.

Extracted from server.py. Skills are Codex-standard folders:
prompt_skills/<name>/SKILL.md with YAML frontmatter and {{variable}} placeholders.
"""

import logging
import os
import re
import shutil
import subprocess
from typing import Dict, Optional

import yaml

from core.config import _SERVER_FILE_DIR

logger = logging.getLogger("research-agent-server")

# Skills that ship with the server and cannot be deleted.
INTERNAL_SKILL_IDS = {
    "ra_mode_plan",
}
INTERNAL_SKILL_PREFIXES = ("ra_mode_",)


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
        skill_id = re.sub(r"[^a-zA-Z0-9_-]", "_", name.strip().lower().replace(" ", "_"))
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
        skill_id = re.sub(r"[^a-zA-Z0-9_-]", "_", name.strip().lower().replace(" ", "_"))
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
        result = re.sub(r"\{\{[a-zA-Z_]+\}\}", "", result)
        return result
