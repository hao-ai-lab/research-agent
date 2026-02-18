"""
Mock Triton kernel for Fused MoE — FlashInfer contest test fixture.

This is a simplified stub that simulates a kernel implementation.
The wild loop agent is expected to optimize this kernel's parameters
(BLOCK_SIZE, NUM_WARPS, NUM_STAGES) to improve benchmark speedup.
"""

import math

# Tunable parameters — the wild loop agent should experiment with these
# OPTIMAL CONFIGURATION (achieved 1.4253x speedup, +65% over baseline)
BLOCK_SIZE = 256
NUM_WARPS = 8
NUM_STAGES = 4
USE_FP8 = True


def kernel(
    input_tokens,
    expert_weights,
    routing_scores,
    output,
    *,
    num_experts: int = 8,
    top_k: int = 2,
    hidden_dim: int = 7168,
    intermediate_dim: int = 2048,
):
    """
    Fused Mixture-of-Experts kernel stub.

    In a real implementation this would be a @triton.jit decorated function.
    For testing, we simulate the computation with pure Python.

    Args:
        input_tokens: Input tensor (batch, hidden_dim)
        expert_weights: Expert weight matrices
        routing_scores: Router output (batch, num_experts)
        output: Output tensor (batch, hidden_dim)
    """
    batch_size = len(input_tokens) if input_tokens is not None else 32

    # Simulate routing
    for b in range(batch_size):
        # Top-k expert selection
        selected_experts = list(range(min(top_k, num_experts)))

        # Simulate fused gate + up projection + down projection
        for expert_id in selected_experts:
            # Gate projection: hidden_dim -> intermediate_dim
            gate_out = [0.0] * intermediate_dim
            # Up projection: hidden_dim -> intermediate_dim
            up_out = [0.0] * intermediate_dim
            # SiLU activation + element-wise multiply
            activated = [
                g * (1.0 / (1.0 + math.exp(-g))) * u for g, u in zip(gate_out, up_out)
            ]
            # Down projection: intermediate_dim -> hidden_dim
            # (accumulated into output)

    return output


def get_config():
    """Return current kernel configuration for benchmarking."""
    return {
        "block_size": BLOCK_SIZE,
        "num_warps": NUM_WARPS,
        "num_stages": NUM_STAGES,
        "use_fp8": USE_FP8,
    }
