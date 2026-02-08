# Wild Loop Tasks

- [ ] [P1] task-001: Preprocess training data
- [/] [P1] task-002: Launch training sweep (8 jobs)
  - dependsOn: task-001
- [ ] [P2] task-003: Analyze training results
  - dependsOn: task-002
  - blockedBy: barrier-training-complete
- [ ] [P2] task-004: Select best checkpoint
  - dependsOn: task-003
- [ ] [P3] task-005: Write final report
  - dependsOn: task-004
