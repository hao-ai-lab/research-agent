# Wild loop: Human-on-the-loop Agent

## Concept

- wild = ralph + human intervention

```python
priority_queue = PriorityQueue()
while True:
    event = priority_queue.wait_for_next_event()
    if event is None:
        continue
    # event handle is a very generic logic as we will describe below.
    event.handle()
```

# Prompt

In the wildloop playground, first let's design another event-driven-but-forkable loop for agent. Specifically this looks like this: the agent is seed with a human input, and then into this event loop. In this scenario, when the human submit something, the agent will insert a plan event - which the agent will start planning things. The plan event is eveutally expected to return a plan for the next step. In our very specific case, a plan is expected to return a sweep event. The sweep event contains the sweep spec, and a pause where we require a human to approve the plan - or that it just automatically proceed with approval (I will ignore this whether we need human input or auto proceed for now becuase it looks like there is some logic to decide if an human input should be needed for the event). 

Then, once we determine a sweep plan and strategy, the agent starts the sweep plan. When the sweep plan launched, it kicks of the scheduler event. When the event is the scheduler's turn, the scheduler decide what are the runs to run. The scheudler obviously has some scheduling strategy to decide the order of the runs to run: priority, etc. Whatever, the scheduler does something, and these runs are running. At this time, the queue may be empty - it means the agent is idle and waiting for the next event, but doesn't mean the loop is terminated yet. 

The reason that the wildloop (master loop) is running in event driven is becuase there may be some other events coming in while it waits for the sweep to finish. For example, when a run finishes up, there should be some logic that sends an event (with prompt) to the wildloop to let it know that the run is finished and that the wild loop should start to inspect the results and do something. For example, if a run produces an alert, like maybe the run's manager figured out that there are some spike happening, then the alert should be sent to the wildloop and get handled - handled meaning (a) the wildloop think it is normal and ignores it, (b) the wildloop think it is an issue but it can sovle it or it can delegate an agent to solve it, (c) it thinks it need a human in the loop to decide what to do. 

When every run finishes, the run will send an event about run finishes together with the prompt to the wildloop to let the agent inspect the result and do the chores to incoperate this finished run. 

I also kinda realize - waiting for human input itself can be an event when we want to block the entire pipeline (like a real `wait()` function until the human comes in), but it doesn't have to. Sometimes, the system will notify the human by sending a notification, and then turns idle. 

The usual event that happens after a sweep is running (run is running) are this:
- run finished: there amy be some subagent we preset or some code we written to post process the run results, and the master agent should do (or delegate) a final review of this run being finished. The agent may also order some data analysis (this may be an event as well) to ensure things are good, or produce intermediate summary of the current state of the sweep. If the agent think this run is suspicious or anyhting, it may do some tagging, add some notes, etc.
- run alert: the run encounteres some issue that possibly indicate the run is problematic and needs to be inspected. the agent has the decision to resolve it by the agent or by the human, depending on its inteligence, how many time it has interact with this run, how much time it has spent on this run, priority, etc. By resolve, it means the agent may need to debug what happened (say delegate to another code agent to debug, or it itself debugs it), and choose to fix the code + rerun, or just stop the run and report ultimate failure. 
- run failed: same procedure as alert

Alert can actually be something more general than a warning or a failure. For example, in some cases, when training a DiT model, human may want to compare the 0th step generated video vs the 5th step generated video, and see if the 5th step is better or at least not worse. Since there is no good validator, it may need human to verify the videos are good (by sending the relevant context to the human), but it does not necessarily need to block the training. 

The interesting part here: human may set a level of interruption tolerance. (a) For example, sometimes human may need to sleep for a night (6 hours), where we just want the agent to maximize the utilization of the GPU cluster to try out different things without any human input. This is why the mode is called wild mode: human can have no intervention at all, and the agent can just run the loop and do the best it can. (b) Sometimes, human may want to have some control over the loop. If the agent can solve it by itself, then don't hand off to the human, or just send a simple message to human telling the human what it's doing and it's confidence of solving it (by making a plan of solving it, etc.) . (c) Sometiems, human want if the alert signal is sent by a run, human want to immediately know it and decide what to do, so this is omre similar to a paging system where a sev0 alert triggers the human on board. (d) Sometimes, human needs to step away from the screen for 1 hour, but still want some notification if something really went wrong. The agent is better off telling the human what's wrong, and propose something they want to try, and don't wait for the human to respond and try thigns out, but if human respond with something interesting, it should probably change code etc. and maybe steer the strategy. etc etc etc you get what I'm saying.


Human input for resolving the alert is also an event, but it can be of higher priority. For example, a human suddently think about something serious and want the agent to replan it. oops! the agent may need to stop / deprioritize some runs, and add new runs to the scheduler. Agent, of course, will be able to contact the scheduler (since it is an agent itself!), rewrite the plan, and even rewrite the events to do. 

Essentially, we are building a priority event queue.


(Future optimization) There are definitely some opportunity for the agent to decide something should run in parallel or delegate to subagent, just like some functions can run with `map` or `fork` in formal programming, and some are sequential. To make it simple, let's just say the master loop agent has the final say on what should be doing. 

In the future, at facing the event queue, the master agent has the say to rewrite the order of the events, or decide the actual execution, depending on the structure of the current horizon. The horizon is the current view of the events + maybe some speculation of the queue state of the agent. The agent can opportunistically replan this horizon to explore or exploit the situation of course. We will do this optimziation later.

The "human input" can be skipped by something that the agent can decide to do something without human input, or something that with such a threshold.


UI: Visualization of the priority event queue.
- Above the chat input box, we show a collapseable panel that is this priority event queue for the wild loop.
- the priority queue should have subsections like 
    - steer: the highest level priority to execute next even when the model is running - when the model finishes up a section (say it finishes one thinking or tool calling), the human input inserts into the loop and steer the execution of the loop. This can be considered as the highest priority.
    - queued: the second highest level priority. Essentially a normal chat input, but queued after the whole one-whole-round of chat output is finished.
- The priority can change - by drag and drop the items in or across queues. 
- By default, the queue should be structured in this following order:
    - user steer
    - agent steer
    - user queued
    - agent queued
- There should be something like a separation point between these items. Since in the backend, it is just a priority queue (a list of queues), and new events are inserted into the back of the queue anyways. 
- You can make the events of different kind to have different colors, and maybe some icon/indicator on the right of the item to show the type of the event, maybe a tooltip on hover to show the detail, etc. 
- You design it for me...


UI: Visualization of the event sequence and lineage
- Show a lineage diagram (like a git tree) of how these events are generated (from whom) and how they get resolved / merged. 
- It also should reflect the logical order - the execution order of the event, say the sweep event is handled, then the run event is handled, then a human input event is handled, etc. 




Some potential problems for the future:
- alert flooding in the system - there may be some batch alert resolution in the queue.


Plan event:
- input: a human input, or a modified input
- procedure
- output: a plan, or a clarification from human
- note: if "wild mode" is turned on, if the event asks human for help, then an automated human prompt will tell it "human is away, you should make your own judgement" kinda prompt.  
- we can set a max tolerate of N iterations that a plan event does not produce a plan - eventually it should.

Sweep spec:
- The sweep spec is expected to define a valid sweep that the agent should run.
- The spec includes:
    - sweepid: the id of the sweep
    - name: a name for the sweep
    - goal: the goal of the sweep
    - primary metrics: the primary metrics to track
    - secondary metrics: the secondary metrics to track
    - other metrics: the other metrics to track (can just say `wandb` or something)
    - workdir: the workdir to run the sweep (optional, default to the current workdir)
    - command: the command or the description to run the sweep.
    - parameters: the parameters to run the sweep
    - max_runs: the max number of runs to run
- note: sweep does not define the actual command to run. That is a particular `run` that should decide the eventual command to run.

Run spec
- Run spec
    - runid: the id of the run
    - name: a name for the run
    - sweep: the sweep id to run or manages the run
    - goal: the goal of the run (optional, default inherit from sweep spec)
    - command: the concrete command to run the run
    - workdir: the workdir to run the run (optional, default inherit from sweep spec)
    - parameters: the parameters to run the run
- note: run does not define the actual command to run. That is a particular `run` that should decide the eventual command to run.


Insight



