# Steps Sensitivity Analysis

## Summary

Analysis of how training steps affect final loss for the stable profile.

## Data

| Steps | Final Loss | Reached Floor |
|-------|------------|---------------|
| 10    | 1.55       | No            |
| 20    | 1.05       | Yes           |
| 30    | 1.05       | Yes           |
| 50    | 1.05       | Yes           |
| 100   | 1.05       | Yes           |

## Key Findings

### Convergence Threshold
- **Minimum steps to reach floor**: 18 steps
- **Loss formula**: `max(1.05, 2.25 - 0.07*steps)`
- At step 17: loss = 1.06 (just above floor)
- At step 18: loss = 1.05 (floor reached)

### Diminishing Returns
- 10 steps: 1.55 (0.50 above floor)
- 20 steps: 1.05 (floor reached)
- 30+ steps: No improvement beyond floor

### Statistical Significance
- Convergence is deterministic (no variance)
- All runs with ≥18 steps achieve identical final loss (1.05)
- The relationship is perfectly linear until floor

## Conclusion

For this synthetic loss function:
1. **Optimal steps**: 18-20 (minimum to reach floor)
2. **No benefit**: Training beyond 18 steps provides no loss improvement
3. **Step efficiency**: The 10-step configuration is suboptimal (1.55 loss)
4. **Recommendation**: Use 20 steps as a safe margin above the 18-step threshold
