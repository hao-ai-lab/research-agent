# Loss Function Analysis

## Overview

The training script `train_gpt2.py` uses a **synthetic loss function** for demonstration purposes. The loss is computed deterministically based on the step number and profile choice.

## Loss Function Definition

```python
def synthetic_loss(step: int, profile: str) -> float:
    baseline = max(1.05, 2.25 - (0.07 * step))
    if profile == "spiky":
        if step == 4:
            return 9.7
        if step == 5:
            return 9.5
    return baseline
```

## Baseline Loss Calculation

The baseline follows a linear decay formula:
- **Formula**: `max(1.05, 2.25 - (0.07 * step))`
- **Initial loss (step 1)**: 2.18
- **Floor loss**: 1.05 (minimum achievable)
- **Decay rate**: 0.07 per step
- **Steps to reach floor**: ~17 steps (when 2.25 - 0.07*step <= 1.05)

### Step-by-Step Baseline Values

| Step | Baseline Loss |
|------|---------------|
| 1    | 2.18          |
| 2    | 2.11          |
| 3    | 2.04          |
| 4    | 1.97          |
| 5    | 1.90          |
| 10   | 1.55          |
| 15   | 1.20          |
| 17   | 1.06          |
| 18+  | 1.05 (floor)  |

## Profile Comparison

### Stable Profile
- Returns baseline loss at every step
- Smooth, monotonic decrease
- Predictable convergence to floor

### Spiky Profile
- Same as stable, except:
  - **Step 4**: Loss = 9.7 (spike)
  - **Step 5**: Loss = 9.5 (spike decay)
- Returns to baseline from step 6 onward
- Spikes represent artificial training instability

## Implications for "Best Model"

1. **Profile matters**: Stable profile achieves lower final loss because it avoids the step 4-5 spikes
2. **Steps matter**: More steps = closer to floor (1.05), up to ~18 steps
3. **Hyperparameters don't matter**: lr and batch_size are logged but don't affect loss calculation
4. **Deterministic**: Same config always produces identical loss curve

## Expected Best Configuration

Based on this analysis, the best model should be:
- **Profile**: stable (avoids spikes)
- **Steps**: ≥18 (reaches floor loss of 1.05)
- **Expected final loss**: 1.05

## Validation Test Results

Run on 2026-02-17 with command:
```bash
python train_gpt2.py --steps 5 --sleep-seconds 0.1 --profile stable
```

Observed outputs:
- Step 1: loss=2.18 ✓
- Step 2: loss=2.11 ✓
- Step 3: loss=2.04 ✓
- Step 4: loss=1.97 ✓
- Step 5: loss=1.90 ✓

Matches expected baseline values exactly.
