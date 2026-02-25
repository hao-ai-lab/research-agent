# Learn from History

Before drafting run commands, inspect prior local patterns:

```bash
history | grep -i 'python.*train\|sbatch\|srun\|torchrun\|accelerate' | tail -20
find {{workdir}} -name '*.sbatch' -o -name '*.slurm' -o -name 'submit*.sh' | head -10
```

If on Slurm, extract correct partition/account/qos/gpu flags from prior submissions.

Also check `git log` to understand what previous iterations accomplished.
