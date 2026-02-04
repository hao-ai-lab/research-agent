# Chat Server

Minimal chat server for the Research Agent with streaming support.

## Setup

```bash
cd server
pip install -r requirements.txt
```

## Running

```bash
python server.py
```

The server runs at `http://localhost:10000`.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Health check |
| `/sessions` | GET | List all chat sessions |
| `/sessions` | POST | Create a new chat session |
| `/sessions/{id}` | GET | Get session with messages |
| `/sessions/{id}` | DELETE | Delete a session |
| `/chat` | POST | Send message, receive streaming response |

## Streaming Protocol

The `/chat` endpoint returns NDJSON with these event types:

- `part_delta` - Text or reasoning content delta
- `part_update` - Tool call status update  
- `session_status` - Session state (e.g., "idle" when complete)
- `error` - Error message

## Environment Variables

- `OPENCODE_URL` - OpenCode API URL (default: `http://localhost:4096`)
