"""Dump raw SSE event types from OpenCode. Requires opencode serve on :4096."""
import asyncio, httpx, json

OPENCODE_URL = "http://127.0.0.1:4096"

async def main():
    async with httpx.AsyncClient(timeout=None) as client:
        sid = (await client.post(f"{OPENCODE_URL}/session", json={})).json()["id"]

        # Connect SSE first, then send prompt
        async with client.stream(
            "GET", f"{OPENCODE_URL}/global/event",
            headers={"Accept": "text/event-stream"},
        ) as sse:
            await client.post(
                f"{OPENCODE_URL}/session/{sid}/prompt_async",
                json={
                    "model": {"providerID": "opencode", "modelID": "kimi-k2.5-free"},
                    "parts": [{"type": "text", "text": "Say hello in one word."}],
                },
            )
            async for line in sse.aiter_lines():
                if not line.startswith("data: "):
                    continue
                payload = json.loads(line[6:]).get("payload", {})
                etype = payload.get("type", "")
                props = payload.get("properties", {})
                part = props.get("part", {}) if isinstance(props.get("part"), dict) else {}
                event_sid = props.get("sessionID") or part.get("sessionID", "")
                if event_sid != sid:
                    continue
                ptype = part.get("type", "")
                field = props.get("field", "")
                delta = repr(props.get("delta", ""))[:40]
                print(f"etype={etype:30s} ptype={ptype:12s} field={field:10s} delta={delta}")
                if etype == "session.status":
                    status = props.get("status", {})
                    if isinstance(status, dict) and status.get("type") == "idle":
                        break

asyncio.run(main())