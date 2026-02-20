import json

import matplotlib
import matplotlib.pyplot as plt

matplotlib.use("Agg")

# Read baseline results
fig, axes = plt.subplots(1, 2, figsize=(14, 5))

# Collect data from wandb files
import glob
import os

wandb_dirs = sorted(glob.glob(".mock_wandb/run-20260217-01*"))

# Separate by type
baseline_data = {}
main_data = {}

for wandb_dir in wandb_dirs:
    metrics_file = os.path.join(wandb_dir, "metrics.jsonl")
    if not os.path.exists(metrics_file):
        continue

    run_name = os.path.basename(wandb_dir)
    steps = []
    losses = []

    with open(metrics_file) as f:
        for line in f:
            data = json.loads(line)
            steps.append(data["step"])
            losses.append(data["loss"])

    if "013022" in run_name or "013024" in run_name:
        # Baseline runs
        profile = "spiky" if "013022" in run_name else "stable"
        baseline_data[profile] = (steps, losses)
    else:
        # Main runs - extract steps from the data
        step_count = max(steps)
        main_data[step_count] = (steps, losses)

# Plot 1: Baseline comparison
ax1 = axes[0]
if "spiky" in baseline_data:
    ax1.plot(
        baseline_data["spiky"][0],
        baseline_data["spiky"][1],
        "r-o",
        label="Spiky Profile",
        markersize=4,
    )
if "stable" in baseline_data:
    ax1.plot(
        baseline_data["stable"][0],
        baseline_data["stable"][1],
        "b-s",
        label="Stable Profile",
        markersize=4,
    )
ax1.axhline(y=1.05, color="g", linestyle="--", label="Floor (1.05)")
ax1.set_xlabel("Step")
ax1.set_ylabel("Loss")
ax1.set_title("Baseline: Spiky vs Stable Profile (20 steps)")
ax1.legend()
ax1.grid(True, alpha=0.3)

# Plot 2: Steps sensitivity
ax2 = axes[1]
colors = {10: "purple", 30: "blue", 50: "green", 100: "orange"}
for step_count in sorted(main_data.keys()):
    steps, losses = main_data[step_count]
    label = f"{int(step_count)} steps"
    color = colors.get(step_count, "gray")
    ax2.plot(steps, losses, label=label, color=color, marker="o", markersize=3, alpha=0.7)

ax2.axhline(y=1.05, color="r", linestyle="--", label="Floor (1.05)")
ax2.axvline(x=18, color="gray", linestyle=":", label="Convergence (step 18)")
ax2.set_xlabel("Step")
ax2.set_ylabel("Loss")
ax2.set_title("Steps Sensitivity Analysis (Stable Profile)")
ax2.legend()
ax2.grid(True, alpha=0.3)

plt.tight_layout()
plt.savefig("exp/analysis/loss_curves.png", dpi=150, bbox_inches="tight")
print("Saved: exp/analysis/loss_curves.png")
