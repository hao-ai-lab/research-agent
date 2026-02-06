#!/usr/bin/env python3
"""
Ralph Runner - Wild Mode Subprocess
Runs the autonomous loop as a separate process, communicating with the server via HTTP.
"""
import asyncio
import argparse
import json
import logging
import os
import sys
import time
import httpx

# reuse logic from wild_loop (assuming it is in the same directory)
from wild_loop import (
    TerminationCondition, WildLoopState, 
    build_initial_prompt, build_continuation_prompt
)

# Configure logging
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("ralph-runner")

class RalphRunner:
    def __init__(self, server_url: str, goal: str, conditions: TerminationCondition, auth_token: str = None):
        self.server_url = server_url.rstrip('/')
        self.goal = goal
        self.conditions = conditions
        self.auth_token = auth_token
        
        # We need the OpenCode URL to talk to the model directly
        # Inherit from environment or default
        self.opencode_url = os.environ.get("OPENCODE_URL", "http://127.0.0.1:4096")
        self.model_provider = os.environ.get("MODEL_PROVIDER", "research-agent")
        self.model_id = os.environ.get("MODEL_ID", "claude-3-5-haiku-latest")
        
        self.state = WildLoopState(
            phase="starting",
            goal=goal,
            iteration=0,
            startedAt=int(time.time() * 1000),
            conditions=conditions,
            estimatedTokens=0,
            isPaused=False
        )
        
        # We assume we work with a specific Opencode Session.
        # We will create one or find one via the server???
        # Actually, the runner can manage its own OpenCode session!
        # It just needs to inject messages into the SERVER's chat history for visibility.
        self.opencode_session_id = None

    def get_headers(self):
        h = {}
        if self.auth_token:
            h["X-Auth-Token"] = self.auth_token
        return h

    async def _fetch_server_state(self):
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{self.server_url}/api/state", headers=self.get_headers())
            resp.raise_for_status()
            data = resp.json()
            # Convert dicts to lists
            runs = list(data["runs"].values())
            alerts = list(data["alerts"].values())
            return runs, alerts

    async def _inject_chat(self, role: str, content: str, hidden: bool = False):
        async with httpx.AsyncClient() as client:
            payload = {"role": role, "content": content, "hidden": hidden}
            try:
                await client.post(f"{self.server_url}/api/chat/inject", json=payload, headers=self.get_headers())
            except Exception as e:
                logger.error(f"Failed to inject chat message: {e}")

    async def _get_opencode_session(self):
        # Create a fresh session for the agent's brain?
        # OR try to reuse one? 
        # Making a new one is safer for "Agent Thought Process" isolation.
        auth = None
        if os.environ.get("OPENCODE_SERVER_PASSWORD"):
            auth = (os.environ.get("OPENCODE_SERVER_USERNAME", "opencode"), os.environ.get("OPENCODE_SERVER_PASSWORD"))
            
        async with httpx.AsyncClient() as client:
            resp = await client.post(f"{self.opencode_url}/session", json={}, auth=auth)
            resp.raise_for_status()
            return resp.json()["id"]

    async def _call_model(self, prompt: str) -> str:
        if not self.opencode_session_id:
            self.opencode_session_id = await self._get_opencode_session()
            
        logger.info(f"Calling model on session {self.opencode_session_id}")
        
        # Prepare payload
        payload = {
            "model": {"providerID": self.model_provider, "modelID": self.model_id},
            "parts": [{"type": "text", "text": prompt}]
        }
        
        # Inject the prompt (hidden) so we can debug later
        await self._inject_chat("system", f"Ralph Logic:\n{prompt}", hidden=True)
        
        full_text = ""
        
        auth = None
        if os.environ.get("OPENCODE_SERVER_PASSWORD"):
            auth = (os.environ.get("OPENCODE_SERVER_USERNAME", "opencode"), os.environ.get("OPENCODE_SERVER_PASSWORD"))

        # Streaming call
        async with httpx.AsyncClient(timeout=300) as client:
            # We use prompt_async to start
            url = f"{self.opencode_url}/session/{self.opencode_session_id}/prompt_async"
            resp = await client.post(url, json=payload, auth=auth)
            resp.raise_for_status()
            
            # Now stream events
            event_url = f"{self.opencode_url}/global/event"
            headers = {"Accept": "text/event-stream"}
            
            logger.info("Streaming response...")
            
            async with client.stream("GET", event_url, headers=headers, auth=auth) as response:
                async for line in response.aiter_lines():
                    if not line.startswith("data: "): continue
                    
                    try:
                        raw = json.loads(line[6:])
                        
                        # --- Parse nested OpenCode SSE format ---
                        # OpenCode sends: {payload: {type, properties: {sessionID, part: {type, id, sessionID}, delta}}}
                        payload_obj = raw.get("payload", {})
                        etype = payload_obj.get("type", "")
                        props = payload_obj.get("properties", {})
                        part = props.get("part", {})
                        
                        # Filter for our session
                        event_sid = props.get("sessionID") or part.get("sessionID")
                        if event_sid != self.opencode_session_id:
                            continue
                        
                        logger.debug(f"Event: type={etype} part_type={part.get('type')} delta_len={len(props.get('delta', ''))}")
                        
                        if etype == "message.part.updated":
                            ptype = part.get("type")
                            delta = props.get("delta", "")
                            
                            if ptype == "text":
                                full_text += delta
                            elif ptype == "reasoning":
                                pass  # Skip thinking for now
                            elif ptype == "tool":
                                tool_state = part.get("state", "")
                                tool_name = part.get("name", "")
                                logger.debug(f"Tool event: {tool_name} state={tool_state}")
                        
                        elif etype == "session.status":
                            status_type = props.get("status", {}).get("type")
                            logger.info(f"Session status: {status_type}")
                            if status_type == "idle":
                                break
                            
                    except json.JSONDecodeError as e:
                        logger.error(f"Failed to parse SSE JSON: {e}")
                    except Exception as e:
                        logger.error(f"Error processing event: {e}")
        
        logger.info(f"Model response received: {len(full_text)} chars")
        
        # Inject the result into the chat
        if full_text.strip():
            await self._inject_chat("assistant", full_text)
        return full_text

    def _update_status_file(self):
        try:
            with open(".wild_state.json", "w") as f:
                f.write(self.state.model_dump_json())
        except Exception as e:
            logger.error(f"Failed to write status file: {e}")

    def _log(self, message: str):
        logger.info(message)
        timestamp = time.strftime("%H:%M:%S")
        self.state.logs.append(f"[{timestamp}] {message}")
        # Keep last 100 logs
        if len(self.state.logs) > 100:
            self.state.logs = self.state.logs[-100:]
        self._update_status_file()

    async def run(self):
        self._log(f"Ralph Runner started. Goal: {self.goal}")
        
        self.state.phase = "planning"
        self._update_status_file()
        
        change_log = []
        
        while True:
            # 1. Check termination
            if self.conditions.maxIterations and self.state.iteration >= self.conditions.maxIterations:
                self._log("Max iterations reached")
                break
                
            self.state.iteration += 1
            self._update_status_file()
            
            # 2. Get State
            try:
                runs, alerts = await self._fetch_server_state()
            except Exception as e:
                logger.error(f"Failed to fetch state: {e}")
                await asyncio.sleep(5)
                continue
                
            # 3. Build Prompt
            if self.state.iteration == 1:
                prompt = build_initial_prompt(self.goal, self.conditions, runs, alerts)
            else:
                prompt = build_continuation_prompt(self.goal, self.state.iteration, self.conditions.maxIterations, runs, alerts, change_log)
                
            # 4. Act
            self._log(f"Iteration {self.state.iteration}: Reasoning...")
            response = await self._call_model(prompt)
            
            # 5. Parse Signal
            if "<signal>COMPLETE</signal>" in response:
                self._log("Agent signaled COMPLETE")
                break
            if "<signal>NEEDS_HUMAN</signal>" in response:
                self._log("Agent signaled NEEDS_HUMAN")
                # We should probably stop or pause?
                self.state.phase = "waiting_for_human"
                self._update_status_file()
                while True: await asyncio.sleep(10) # Hang here until killed
                
            # 6. Sleep
            self._log("Sleeping before next iteration...")
            self.state.phase = "monitoring"
            self._update_status_file()
            await asyncio.sleep(5)
            self.state.phase = "reacting" 
            
        self._log("Ralph Runner Finished")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-url", required=True)
    parser.add_argument("--goal", required=True)
    parser.add_argument("--log-file", help="Path to persistent log file")
    args = parser.parse_args()
    
    # Configure file logging if requested
    if args.log_file:
        file_handler = logging.FileHandler(args.log_file)
        file_handler.setFormatter(logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s'))
        logging.getLogger().addHandler(file_handler)
        logging.info(f"Logging to file: {args.log_file}")
    
    # Parse conditions from env
    cond_json = os.environ.get("WILD_CONDITIONS", "{}")
    try:
        cond_dict = json.loads(cond_json)
        conditions = TerminationCondition(**cond_dict)
    except:
        conditions = TerminationCondition()
        
    auth_token = os.environ.get("RESEARCH_AGENT_USER_AUTH_TOKEN")
    
    runner = RalphRunner(args.api_url, args.goal, conditions, auth_token)
    
    try:
        asyncio.run(runner.run())
    except KeyboardInterrupt:
        pass
