# Best Model Report

## Executive Summary

After comprehensive experimentation comparing multiple configurations, **6 models achieved the optimal loss of 1.05**.

## Winning Configurations

All of the following configurations achieved the best possible loss (1.05):

| Rank | Run Name | Profile | Steps | Learning Rate | Final Loss | Efficiency |
|------|----------|---------|-------|---------------|------------|------------|
| 1 | stable-20steps | stable | 20 | 0.0003 | 1.05 | Optimal |
| 1 | baseline-stable-20steps | stable | 20 | 0.0003 | 1.05 | Optimal |
| 1 | stable-30steps | stable | 30 | 0.0003 | 1.05 | Good |
| 1 | stable-50steps | stable | 50 | 0.0003 | 1.05 | Good |
| 1 | stable-100steps | stable | 100 | 0.0003 | 1.05 | Overkill |
| 1 | stable-50steps-lr1e-4 | stable | 50 | 0.0001 | 1.05 | Good |
| 1 | stable-50steps-lr1e-3 | stable | 50 | 0.001 | 1.05 | Good |
| 1 | baseline-spiky-20steps | spiky | 20 | 0.0003 | 1.05 | *Suboptimal* |

## Best Overall Model

**Configuration**: `stable-20steps` (or `baseline-stable-20steps`)

**Why this is best**:
1. Achieves floor loss (1.05)
2. Uses minimum necessary steps (20)
3. Stable profile (no training spikes)
4. Efficient - no wasted computation

## Evidence

### Loss Convergence
All winning configurations converge to the theoretical floor of 1.05 by step 18.

### Profile Comparison
- **Stable profile**: Clean monotonic decrease
- **Spiky profile**: Same final loss, but transient spikes at steps 4-5 (9.7, 9.5)

### Learning Rate Ablation
Learning rates tested: 1e-4, 3e-4, 1e-3
**Result**: No effect on loss (expected - synthetic function ignores LR)

## Statistical Confidence
- **Deterministic**: 100% confidence (identical results across identical configs)
- **Reproducible**: Same config always produces same loss curve
- **Verified**: 8 runs confirm floor loss is achievable

## Conclusion

The **stable profile with 20 steps** is the most efficient configuration to achieve the best loss of **1.05**.

## Recommendation

For future experiments with this synthetic loss function:
- Use **stable profile** (avoids transient spikes)
- Use **20 steps** (sufficient margin above 18-step threshold)
- Learning rate **does not matter** (use default 3e-4)
