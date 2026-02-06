#!/usr/bin/env python3
"""
Backend-only test for the Wild Loop / Ralph Runner.
Tests the SSE event parsing and model call flow WITHOUT starting the full wild loop.

Prerequisites:
  - Server running on localhost:10000
  - OpenCode running on localhost:4096

Usage:
  python test_wild_loop.py                    # Run all tests
  python test_wild_loop.py --test sse         # Test SSE parsing only
  python test_wild_loop.py --test model       # Test a single model call
  python test_wild_loop.py --test full        # Test full single-iteration loop
"""
import asyncio
import argparse
import json
import logging
import os
import sys
import time
import httpx

# Reuse shared logic
from wild_loop import TerminationCondition, build_initial_prompt

logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("test-wild-loop")

# Config
SERVER_URL = os.environ.get("SERVER_URL", "http://localhost:10000")
OPENCODE_URL = os.environ.get("OPENCODE_URL", "http://127.0.0.1:4096")
MODEL_PROVIDER = os.environ.get("MODEL_PROVIDER", "research-agent")
MODEL_ID = os.environ.get("MODEL_ID", "claude-3-5-haiku-latest")
SERVER_AUTH_TOKEN = os.environ.get("RESEARCH_AGENT_USER_AUTH_TOKEN", "")


def get_auth():
    pw = os.environ.get("OPENCODE_SERVER_PASSWORD")
    if pw:
        return (os.environ.get("OPENCODE_SERVER_USERNAME", "opencode"), pw)
    return None


def get_server_headers():
    h = {}
    if SERVER_AUTH_TOKEN:
        h["X-Auth-Token"] = SERVER_AUTH_TOKEN
    return h


# ─── Test 1: Connectivity ─────────────────────────────────────────────────
async def test_connectivity():
    """Check that both the server and OpenCode are reachable."""
    print("\n" + "="*60)
    print("TEST: Connectivity")
    print("="*60)

    errors = []

    # Server
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{SERVER_URL}/", headers=get_server_headers())
            print(f"  ✅ Server: {resp.status_code} - {resp.json()}")
    except Exception as e:
        print(f"  ❌ Server ({SERVER_URL}): {e}")
        errors.append("server")

    # OpenCode
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{OPENCODE_URL}/session", auth=get_auth())
            print(f"  ✅ OpenCode: {resp.status_code}")
    except Exception as e:
        print(f"  ❌ OpenCode ({OPENCODE_URL}): {e}")
        errors.append("opencode")

    # Server /api/state
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{SERVER_URL}/api/state", headers=get_server_headers())
            data = resp.json()
            print(f"  ✅ /api/state: {len(data.get('runs', {}))} runs, {len(data.get('alerts', {}))} alerts")
    except Exception as e:
        print(f"  ❌ /api/state: {e}")
        errors.append("api/state")

    if errors:
        print(f"\n  ⚠️  Failed: {', '.join(errors)}")
        return False
    print("\n  All connectivity checks passed!")
    return True


# ─── Test 2: SSE Event Parsing ────────────────────────────────────────────
async def test_sse_parsing():
    """
    Create an OpenCode session, send a trivial prompt, and verify we can
    parse the SSE stream using the CORRECT nested format.
    """
    print("\n" + "="*60)
    print("TEST: SSE Event Parsing")
    print("="*60)

    auth = get_auth()

    # 1. Create session
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(f"{OPENCODE_URL}/session", json={}, auth=auth)
        resp.raise_for_status()
        session_id = resp.json()["id"]
        print(f"  Session created: {session_id}")

    # 2. Send a trivial prompt
    payload = {
        "model": {"providerID": MODEL_PROVIDER, "modelID": MODEL_ID},
        "parts": [{"type": "text", "text": "Say exactly: 'Hello from wild loop test'. Nothing else."}]
    }

    async with httpx.AsyncClient(timeout=300) as client:
        resp = await client.post(
            f"{OPENCODE_URL}/session/{session_id}/prompt_async",
            json=payload, auth=auth
        )
        print(f"  prompt_async: {resp.status_code}")
        if resp.status_code not in (200, 204):
            print(f"  ❌ Unexpected status: {resp.text}")
            return False

        # 3. Stream events and parse them
        event_url = f"{OPENCODE_URL}/global/event"
        headers = {"Accept": "text/event-stream"}

        full_text = ""
        events_received = 0
        events_matched = 0
        session_idle = False

        print(f"  Streaming events (filtering for session {session_id[:12]}...)...")

        async with client.stream("GET", event_url, headers=headers, auth=auth) as response:
            async for line in response.aiter_lines():
                
                print("[opencode]", line)

                if not line.startswith("data: "):
                    continue

                events_received += 1
                try:
                    raw = json.loads(line[6:])
                    # print("[raw] ", raw)

                    # ─── CORRECT nested parsing ───
                    payload_obj = raw.get("payload", {})
                    etype = payload_obj.get("type", "")
                    props = payload_obj.get("properties", {})
                    part = props.get("part", {})

                    event_sid = props.get("sessionID") or part.get("sessionID")

                    if event_sid != session_id:
                        continue

                    events_matched += 1

                    if etype == "message.part.updated":
                        ptype = part.get("type")
                        delta = props.get("delta", "")
                        if ptype == "text":
                            full_text += delta
                            print(f"    📝 text delta: {repr(delta[:80])}")
                        elif ptype == "reasoning":
                            print(f"    🧠 thinking delta: {len(delta)} chars")
                        elif ptype == "tool":
                            print(f"    🔧 tool: {part.get('name')} state={part.get('state')}")

                    elif etype == "session.status":
                        status_type = props.get("status", {}).get("type")
                        print(f"    📡 session status: {status_type}")
                        if status_type == "idle":
                            session_idle = True
                            break

                except json.JSONDecodeError as e:
                    print(f"    ⚠️  JSON parse error: {e}")
                except Exception as e:
                    print(f"    ⚠️  Error: {e}")

    print(f"\n  Events received (total): {events_received}")
    print(f"  Events matched (our session): {events_matched}")
    print(f"  Session reached idle: {session_idle}")
    print(f"  Full text ({len(full_text)} chars): {repr(full_text[:200])}")

    if not session_idle:
        print("\n  ❌ FAIL: Never received session.status=idle — SSE parsing may still be broken")
        return False
    if events_matched == 0:
        print("\n  ❌ FAIL: No events matched our session — session filter is wrong")
        return False
    if not full_text.strip():
        print("\n  ❌ FAIL: Got idle but no text — model may not have responded")
        return False

    print("\n  ✅ PASS: SSE event parsing works correctly!")
    return True


# ─── Test 3: Single Model Call via RalphRunner ────────────────────────────
async def test_model_call():
    """
    Test a single _call_model invocation from RalphRunner to verify 
    end-to-end: session creation → prompt → SSE stream → text extraction.
    """
    print("\n" + "="*60)
    print("TEST: RalphRunner._call_model (single call)")
    print("="*60)

    from ralph_runner import RalphRunner

    conditions = TerminationCondition(maxIterations=1)
    runner = RalphRunner(
        server_url=SERVER_URL,
        goal="test",
        conditions=conditions,
        auth_token=SERVER_AUTH_TOKEN,
    )
    # Override model config
    runner.opencode_url = OPENCODE_URL
    runner.model_provider = MODEL_PROVIDER
    runner.model_id = MODEL_ID

    prompt = "You are a test agent. Say exactly: 'Wild loop model call test successful'. Nothing else."

    print(f"  Calling model...")
    start = time.time()
    result = await runner._call_model(prompt)
    elapsed = time.time() - start

    print(f"  Elapsed: {elapsed:.1f}s")
    print(f"  Response ({len(result)} chars): {repr(result[:300])}")

    if not result.strip():
        print("\n  ❌ FAIL: Empty response from model call")
        return False

    print("\n  ✅ PASS: Model call returned text successfully!")
    return True


# ─── Test 4: Full Single Iteration ───────────────────────────────────────
async def test_full_iteration():
    """
    Run a single iteration of the wild loop logic:
    fetch state → build prompt → call model → parse signal.
    """
    print("\n" + "="*60)
    print("TEST: Full Single Iteration")
    print("="*60)

    from ralph_runner import RalphRunner

    conditions = TerminationCondition(maxIterations=1)
    runner = RalphRunner(
        server_url=SERVER_URL,
        goal="Say hello and signal COMPLETE immediately. This is just a test.",
        conditions=conditions,
        auth_token=SERVER_AUTH_TOKEN,
    )
    runner.opencode_url = OPENCODE_URL
    runner.model_provider = MODEL_PROVIDER
    runner.model_id = MODEL_ID

    # 1. Fetch state
    print("  1. Fetching server state...")
    try:
        runs_list, alerts_list = await runner._fetch_server_state()
        print(f"     Runs: {len(runs_list)}, Alerts: {len(alerts_list)}")
    except Exception as e:
        print(f"  ❌ Failed to fetch state: {e}")
        return False

    # 2. Build prompt
    print("  2. Building initial prompt...")
    prompt = build_initial_prompt(runner.goal, runner.conditions, runs_list, alerts_list)
    print(f"     Prompt length: {len(prompt)} chars")

    # 3. Call model
    print("  3. Calling model...")
    start = time.time()
    response = await runner._call_model(prompt)
    elapsed = time.time() - start
    print(f"     Elapsed: {elapsed:.1f}s")
    print(f"     Response ({len(response)} chars):")
    # Print first 500 chars
    for line in response[:500].split('\n'):
        print(f"       {line}")
    if len(response) > 500:
        print(f"       ... ({len(response) - 500} more chars)")

    # 4. Check signal
    print("  4. Checking signal...")
    if "<signal>COMPLETE</signal>" in response:
        print("     Signal: COMPLETE ✅")
    elif "<signal>CONTINUE</signal>" in response:
        print("     Signal: CONTINUE (agent wants to keep going)")
    elif "<signal>NEEDS_HUMAN</signal>" in response:
        print("     Signal: NEEDS_HUMAN")
    else:
        print("     Signal: NONE FOUND (agent didn't include a signal)")

    if not response.strip():
        print("\n  ❌ FAIL: Empty response")
        return False

    print("\n  ✅ PASS: Full iteration completed successfully!")
    return True


# ─── Main ─────────────────────────────────────────────────────────────────
async def main():
    parser = argparse.ArgumentParser(description="Test Wild Loop backend")
    parser.add_argument("--test", choices=["connectivity", "sse", "model", "full", "all"], 
                        default="all", help="Which test to run")
    args = parser.parse_args()

    print(f"Wild Loop Backend Test")
    print(f"  Server:   {SERVER_URL}")
    print(f"  OpenCode: {OPENCODE_URL}")
    print(f"  Model:    {MODEL_PROVIDER}/{MODEL_ID}")

    tests = {
        "connectivity": test_connectivity,
        "sse": test_sse_parsing,
        "model": test_model_call,
        "full": test_full_iteration,
    }

    if args.test == "all":
        results = {}
        for name, fn in tests.items():
            try:
                results[name] = await fn()
            except Exception as e:
                logger.error(f"Test {name} crashed: {e}", exc_info=True)
                results[name] = False

        print("\n" + "="*60)
        print("RESULTS")
        print("="*60)
        for name, passed in results.items():
            icon = "✅" if passed else "❌"
            print(f"  {icon} {name}")
        
        total = len(results)
        passed = sum(1 for v in results.values() if v)
        print(f"\n  {passed}/{total} tests passed")
    else:
        try:
            passed = await tests[args.test]()
        except Exception as e:
            logger.error(f"Test crashed: {e}", exc_info=True)
            passed = False
        print(f"\n{'✅ PASSED' if passed else '❌ FAILED'}")


if __name__ == "__main__":
    asyncio.run(main())
