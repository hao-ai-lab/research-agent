"""Vulture whitelist — entries here suppress false-positive 'unused' warnings.

Vulture cannot see dynamic usage by FastAPI (route handlers, middleware),
Pydantic (model fields), pytest (fixtures), or type annotations using
`from typing import ...` style.
"""

# -- typing imports used in annotations throughout the codebase --
from typing import Any, Dict, List, Optional, Union  # noqa

# -- FastAPI route handlers are referenced by the framework, not by user code --
health  # noqa
health_json  # noqa

# -- server.py re-exports used by route modules --
ChatMessage  # noqa
_state  # noqa
run_opencode_session  # noqa
RUN_STATUS_PENDING  # noqa
SWEEP_STATUS_EDITABLE  # noqa

# -- tests --
timezone  # noqa

# -- CLI entry-points --
main  # noqa
