# RL Training Report

Best clip strategy: 0.28 (avg reward 0.770)
Best offpoliciness: bs64_mbs32 (avg reward 0.760)

## Run Table
- rl-fn-std | finished | model=qwen2.5-7b-base | clip=0.2 | bs64_mbs64 | reward=0.62
- rl-py-highclip | finished | model=qwen2.5-7b-base | clip=0.28 | bs64_mbs32 | reward=0.78
- rl-sh-highclip | finished | model=qwen2.5-7b-math-base | clip=0.28 | bs64_mbs32 | reward=0.76
- rl-fallback-playbook | finished | model=qwen2.5-7b-math-base | clip=0.2 | bs64_mbs32 | reward=0.74
- rl-fail-alert | failed | model=qwen2.5-7b-base | clip=0.2 | bs64_mbs16 | reward=0.2

Fallback runs used: ['rl-fallback-playbook']
Alert count: 1