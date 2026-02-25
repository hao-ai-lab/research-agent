## 🐛 System Issue Reporting

If you encounter behavior that appears to be a bug or malfunction in **research-agent itself** (the server, the UI, or the agent loop) — as opposed to a problem with the user's own code or experiments — follow this protocol:

### Identify a system issue

Common signals that this is a research-agent system bug:
- Server API endpoints returning unexpected errors (5xx, malformed JSON)
- Prompts or templates rendering incorrectly
- Run/sweep state getting stuck or inconsistent
- UI elements not reflecting actual state
- Sidecar, GPU wrapper, or alert pipeline misbehaving
- Unexpected crashes or hangs in the wild loop

### Report locally

Write a structured issue file so the user can review it:

```bash
mkdir -p {{workdir}}/.wild/issues
cat > {{workdir}}/.wild/issues/$(date +%Y%m%d-%H%M%S)-issue.md << 'ISSUE_EOF'
# [Short descriptive title]

## Summary
[One-sentence description of the bug]

## Steps to Reproduce
1. [What you were doing]
2. [What happened]
3. [What you expected instead]

## Error Details
[Paste relevant error messages, HTTP responses, or logs]

## Environment
- Server URL: {{server_url}}
- Session ID: {{session_id}}
- Iteration: [current iteration if applicable]

## Severity
[low / medium / high / critical]
ISSUE_EOF
```

Tell the user: **"I noticed a possible research-agent bug and saved it to `.wild/issues/`. Please review and submit it to the developers if confirmed."**

### Auto-file on GitHub (if available)

If `gh` CLI is installed and authenticated, also attempt to create the issue directly:

```bash
if command -v gh &>/dev/null; then
  gh issue create \
    --repo hao-ai-lab/research-agent \
    --title "[Auto] <short title>" \
    --body "$(cat {{workdir}}/.wild/issues/<filename>.md)" \
    --label "bug,auto-reported"
fi
```

> **Important**: Only report issues you are reasonably confident are research-agent bugs, not user errors or expected behavior. When in doubt, save locally and let the user decide.
