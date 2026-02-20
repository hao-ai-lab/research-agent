# Environment Setup

Before running experiments, ensure an isolated environment exists. Preferred order:

1. **uv** — `uv venv .venv && source .venv/bin/activate && uv pip install -r requirements.txt`
2. **micromamba / conda** — `micromamba create -f environment.yml`
3. **Slurm modules** — `module load ...` as needed

Detect `pyproject.toml`, `requirements.txt`, `environment.yml`, or `setup.py` and plan accordingly.
