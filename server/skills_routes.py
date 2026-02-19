"""
Prompt Skill API Routes — extracted from server.py

Provides all /prompt-skills/* endpoints as a FastAPI APIRouter.
"""

from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from skills_manager import PromptSkillManager

router = APIRouter()

# Module-level reference set by server.py during app startup
_manager: Optional[PromptSkillManager] = None


def init(manager: PromptSkillManager) -> None:
    """Wire the shared PromptSkillManager instance."""
    global _manager
    _manager = manager


def _get_manager() -> PromptSkillManager:
    assert _manager is not None, "skills_routes.init() must be called before using routes"
    return _manager


# ---------------------------------------------------------------------------
# Request / Response Models
# ---------------------------------------------------------------------------

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


class SkillFileWrite(BaseModel):
    content: str


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/prompt-skills")
async def list_prompt_skills():
    """List all available prompt skills."""
    return _get_manager().list()


@router.get("/prompt-skills/search")
async def search_prompt_skills(q: str = "", limit: int = 20):
    """Search prompt skills by name, description, or template content."""
    return _get_manager().search(q, limit)


@router.post("/prompt-skills")
async def create_prompt_skill(req: PromptSkillCreate):
    """Create a new prompt skill."""
    try:
        skill = _get_manager().create(
            name=req.name,
            description=req.description,
            template=req.template,
            category=req.category,
            variables=req.variables,
        )
        return skill
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.post("/prompt-skills/reload")
async def reload_prompt_skills():
    """Reload all prompt skills from disk."""
    mgr = _get_manager()
    mgr.load_all()
    return {"message": "Prompt skills reloaded", "count": len(mgr.list())}


@router.post("/prompt-skills/install")
async def install_prompt_skill(req: PromptSkillInstall):
    """Install a skill from an external source (git clone)."""
    if req.source != "git":
        raise HTTPException(status_code=400, detail=f"Unsupported install source: {req.source}")
    try:
        skill = _get_manager().install_from_git(req.url, req.name)
        return skill
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/prompt-skills/{skill_id}")
async def get_prompt_skill(skill_id: str):
    """Get a single prompt skill by ID."""
    skill = _get_manager().get(skill_id)
    if skill is None:
        raise HTTPException(status_code=404, detail=f"Prompt skill '{skill_id}' not found")
    return skill


@router.put("/prompt-skills/{skill_id}")
async def update_prompt_skill(skill_id: str, req: PromptSkillUpdate):
    """Update a prompt skill's template."""
    updated = _get_manager().update(skill_id, req.template)
    if updated is None:
        raise HTTPException(status_code=404, detail=f"Prompt skill '{skill_id}' not found")
    return updated


@router.delete("/prompt-skills/{skill_id}")
async def delete_prompt_skill(skill_id: str):
    """Delete a user-created skill.

    Internal skills (wild_*, ra_mode_plan) cannot be deleted (403).
    """
    try:
        _get_manager().delete(skill_id)
        return {"message": f"Skill '{skill_id}' deleted"}
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Prompt skill '{skill_id}' not found")
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))


@router.post("/prompt-skills/{skill_id}/render")
async def render_prompt_skill(skill_id: str, variables: Dict[str, str]):
    """Render a prompt skill template with the given variables."""
    rendered = _get_manager().render(skill_id, variables)
    if rendered is None:
        raise HTTPException(status_code=404, detail=f"Prompt skill '{skill_id}' not found")
    return {"rendered": rendered}


@router.get("/prompt-skills/{skill_id}/files")
async def list_skill_files(skill_id: str):
    """List all files in a skill's folder."""
    files = _get_manager().list_files(skill_id)
    if files is None:
        raise HTTPException(status_code=404, detail=f"Prompt skill '{skill_id}' not found")
    return files


@router.get("/prompt-skills/{skill_id}/files/{file_path:path}")
async def read_skill_file(skill_id: str, file_path: str):
    """Read a file from a skill's folder."""
    content = _get_manager().read_file(skill_id, file_path)
    if content is None:
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")
    return {"path": file_path, "content": content}


@router.put("/prompt-skills/{skill_id}/files/{file_path:path}")
async def write_skill_file(skill_id: str, file_path: str, req: SkillFileWrite):
    """Write a file in a skill's folder."""
    result = _get_manager().write_file(skill_id, file_path, req.content)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Skill or path not found: {skill_id}/{file_path}")
    return {"message": "File saved", "path": file_path}
