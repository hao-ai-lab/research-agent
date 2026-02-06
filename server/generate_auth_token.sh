#!/bin/bash
# Generate a secure auth token for RESEARCH_AGENT_USER_AUTH_TOKEN
#
# Usage:
#   ./generate_auth_token.sh           # Generate and display token
#   ./generate_auth_token.sh --export  # Generate and export as env var
#   source generate_auth_token.sh --export  # Export to current shell

set -e

# Generate a 32-character hex token (128 bits of entropy)
TOKEN=$(openssl rand -hex 16)

if [[ "$1" == "--export" ]]; then
    export RESEARCH_AGENT_USER_AUTH_TOKEN="$TOKEN"
    echo "export RESEARCH_AGENT_USER_AUTH_TOKEN=\"$TOKEN\""
    echo ""
    echo "✅ Token exported to RESEARCH_AGENT_USER_AUTH_TOKEN"
    echo "   Run with: source generate_auth_token.sh --export"
else
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🔐 Generated Auth Token:"
    echo ""
    echo "   $TOKEN"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "To use:"
    echo "  1. Start server with:"
    echo "     export RESEARCH_AGENT_USER_AUTH_TOKEN=\"$TOKEN\""
    echo "     python server.py --workdir /path/to/project"
    echo ""
    echo "  2. In the app, go to Settings → API Configuration"
    echo "     and paste this token in the Auth Token field."
fi
