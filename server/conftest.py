"""Root conftest for server tests — ensures server/ is on sys.path."""

import sys
import os

# Add the server directory to sys.path so 'agentsys' and other server
# packages are importable regardless of where pytest is invoked from.
_server_dir = os.path.dirname(os.path.abspath(__file__))
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)
