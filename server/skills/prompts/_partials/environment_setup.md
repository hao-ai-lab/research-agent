## Environment Setup

Before running experiments, ensure the correct Python environment is active.

### Detection

Check for environment files in the project root:
- `pyproject.toml` → use `uv` or `pip install -e .`
- `requirements.txt` → use `uv pip install -r requirements.txt` or `pip install -r requirements.txt`
- `environment.yml` → use `micromamba` or `conda`
- `setup.py` → use `pip install -e .`

### Setup preference order

1. `uv` — `uv venv .venv && source .venv/bin/activate && uv pip install -r requirements.txt`
2. `micromamba` / `conda`
3. Slurm module loading if on cluster
4. System `pip` (least preferred)

### Important

- **Always include environment activation in run commands.** The `command` field in `POST /runs` runs in a fresh shell, so activation must be explicit:
  ```
  "command": "source .venv/bin/activate && cd /path/to/workdir && python train.py --lr 0.001"
  ```
- Check for existing virtual environments before creating new ones (`ls .venv/`, `conda env list`).
