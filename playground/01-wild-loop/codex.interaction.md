Read [README.md](playground/01-wild-loop/README.md) , and produce in the same directory PLAN.toy.md to design the toy feature just in this playground, and the PLAN.full.md to design the full end-to-end feature in the repo. The toy feature should be a backend loop that just show case every necessary component to build a wild loop, and a lot of prompts + test cases to validate our design is correct and functional under what circunstamces. For each user story, create a case `story/<case-name>/` that encapsuates everything to run that story. Make the main loop code outside of story, so story has to invoke the main loop code and run the story. When defining event, don't think of it as something super regid: all of these will be a user's one-off prompt, and that triggers everything we need. Instead, define the prompt in a way that it has clear instruction of input / output / procedure, and just expect that the event output and stuff, and that the main agent will handle these events. Events comes with specific prompt, so don't worry about the prompt being too long or too short. Just make sure the prompt is clear and complete. Sometimes, we do need to mock some events - say, if we are in the wild loop, we may want to ask the agent to always proceed (written in main loop), etc., or raise alert to human, that kind of stuff. 


Story:
1. RL training
    - User story: the user wants to train an RL model.
    - High level plan: 
        One such user story to fit your design:
        1. Setup `verl` codebase
        2. multiple yaml/param setting
            - model: `qwen2.5-7b-base` vs. `qwen2.5-7b-math-base`
            - clip strategy: clip higher (0.28) or PPO standard (0.2)
            - offpoliciness (bs vs. mbs {64, 64}, {64, 32}, {64, 16})
        3. read curves, find conclusion
            - which clip strategy works better? 
            - what offpoliciness works better?writing report
        我感觉 RL 的 user story 精髓在于：懂 rl theory/math 的老哥，提出对若干参数的若干种修改，然后 exp sweep，最后验证实验
2. Prompt Tuning
3. DiT training


