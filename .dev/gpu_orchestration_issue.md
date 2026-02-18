# GPU Resource Orchestration Agent

## Problem Statement

### Current Situation
Our team faces significant GPU resource coordination challenges:

- **Resources**: 2 GMI nodes hosting 16 H100 GPUs
- **Users**: 15+ team members sharing these resources
- **Current Approach**: Manual coordination using spreadsheets
- **Issues**: 
  - Inefficient resource allocation
  - No automated scheduling
  - Manual tracking overhead
  - Potential resource conflicts
  - Lack of visibility into GPU utilization

### Impact
- Wasted GPU cycles due to poor coordination
- Developer time spent on manual resource management
- Bottlenecks when multiple experiments need to run
- Difficulty prioritizing experiments
- No historical tracking of GPU usage

## Proposed Solution

### Overview
Develop an AI agent-based orchestration layer that automatically manages GPU resources across multiple team experiments. This system will eliminate manual coordination and provide intelligent scheduling.

### Key Components

#### 1. Ray Cluster Integration
- Deploy Ray cluster over GMI nodes for distributed computing
- Handle allocation and scheduling across nodes
- Provide unified resource management interface

#### 2. AI Orchestration Agent
- Pull cluster status automatically
- Launch jobs based on resource availability
- Coordinate multiple concurrent experiments
- Make intelligent scheduling decisions

#### 3. Job Queue Management
- Queue experiments when resources are unavailable
- Prioritize jobs based on configured policies
- Automatically launch jobs when resources free up
- Track job history and resource usage

#### 4. Resource Monitoring
- Real-time GPU utilization tracking
- Per-job resource allocation visibility
- Historical usage analytics
- Alerts for resource issues

### Success Criteria
- [ ] Eliminate manual GPU coordination spreadsheets
- [ ] Support concurrent experiments across 16 GPUs
- [ ] Automatic job scheduling based on resource availability
- [ ] <1 minute overhead for job submission
- [ ] Real-time visibility into GPU utilization
- [ ] AI agent can autonomously launch and coordinate jobs

## Technical Architecture

### System Design

```
┌─────────────────────────────────────────────────────────────┐
│                     Research Agent Frontend                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ GPU Dashboard│  │ Job Queue UI │  │ Cluster Monitor  │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
└────────────────────────────┬────────────────────────────────┘
                             │
                             │ HTTP/WebSocket
                             │
┌────────────────────────────▼────────────────────────────────┐
│              Research Agent Server (FastAPI)                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │        GPU Orchestration Agent                       │   │
│  │  • Resource monitoring                               │   │
│  │  • Job scheduling                                    │   │
│  │  • Queue management                                  │   │
│  └─────────────────────────────────────────────────────┘   │
│                             │                                │
│                             │                                │
│  ┌──────────────┐  ┌───────▼─────────┐  ┌──────────────┐  │
│  │   Cluster    │  │   Job Queue     │  │   tmux Job   │  │
│  │   Detector   │  │   Manager       │  │   Executor   │  │
│  └──────────────┘  └─────────────────┘  └──────────────┘  │
└────────────────────────────┬────────────────────────────────┘
                             │
                             │ Ray API / SSH
                             │
┌────────────────────────────▼────────────────────────────────┐
│                      Ray Cluster                             │
│  ┌──────────────────┐              ┌──────────────────┐     │
│  │   GMI Node 1     │              │   GMI Node 2     │     │
│  │   8x H100 GPUs   │              │   8x H100 GPUs   │     │
│  └──────────────────┘              └──────────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

### Implementation Phases

#### Phase 1: Foundation (Initial PR)
- [ ] Create issue and design documents
- [ ] Extend cluster detection to support Ray
- [ ] Add GPU resource tracking data structures
- [ ] Implement basic job queue system
- [ ] Create API endpoints for GPU orchestration

#### Phase 2: Ray Integration
- [ ] Integrate with Ray cluster API
- [ ] Implement resource allocation logic
- [ ] Add job submission to Ray
- [ ] Handle job lifecycle on Ray

#### Phase 3: AI Agent
- [ ] Develop orchestration agent logic
- [ ] Implement intelligent scheduling policies
- [ ] Add automatic job coordination
- [ ] Enable autonomous operation

#### Phase 4: UI & Monitoring
- [ ] Create GPU dashboard view
- [ ] Add job queue visualization
- [ ] Implement real-time monitoring
- [ ] Add historical analytics

## Timeline

- **Day 1 (Initial)**: Issue, design, and foundation code (this PR)
- **Day 2-3**: Ray integration and basic orchestration
- **Day 4-5**: AI agent development and testing
- **Week 2**: UI polish and production deployment

## Team

- **Project Lead**: Will Lin
- **Technical Lead**: Junda Chen
- **Developers**: 1-2 team members with agent coding experience (TBD)

## Action Items

From huddle notes (2/10/26):
- [x] Draft issue with problem statement and design
- [x] Create initial PR with foundation code
- [ ] Will Lin: Identify 1-2 team members with agent experience
- [ ] Will Lin: Discuss at 5:30 PM sync and share agent dev slides
- [ ] Complete initial GPU orchestration agent within one day

## References

- Huddle notes: 2/10/26 1:10-1:14 PM PST
- Existing cluster detection: `server/server.py` lines 3279-3400
- Job execution: `server/job_sidecar.py`
- Wild mode orchestration: `server/wild_loop.py`

## Success Metrics

After deployment, we should see:
- **95%+ GPU utilization** during peak hours (vs current ~60-70% estimated)
- **0 manual coordination** via spreadsheets
- **10+ concurrent experiments** running smoothly
- **<5 minute queue wait time** average
- **100% visibility** into resource allocation
