"""Sidecar — decomposed job monitoring modules.

Extracted from the monolithic tools/job_sidecar.py into focused modules:
  - tmux_manager: tmux pane lifecycle
  - server_api:   HTTP callbacks to the research-agent server
  - alerts:       rule-based + LLM alert detection
  - metrics:      WandB metrics reading & posting
  - gpu:          GPU detection, conflict patterns, retry logic
"""
