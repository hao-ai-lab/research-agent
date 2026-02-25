// ── Chat Routes — SSE streaming chat with agent ──

import { getOrCreateSession, listSessions, destroySession } from '../lib/agent-sessions.js'
import { createCodingTools } from '../lib/tools/index.js'
import fs from 'fs'
import path from 'path'

const CHAT_DATA_DIR = path.join(process.cwd(), '.agents', 'chat')

function ensureChatDir() {
    fs.mkdirSync(CHAT_DATA_DIR, { recursive: true })
}

function saveChatHistory(sessionId, messages) {
    ensureChatDir()
    fs.writeFileSync(
        path.join(CHAT_DATA_DIR, `${sessionId}.json`),
        JSON.stringify(messages, null, 2)
    )
}

function loadChatHistory(sessionId) {
    const p = path.join(CHAT_DATA_DIR, `${sessionId}.json`)
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')) }
    catch { return [] }
}

export default function chatRoutes(app) {
    // Send a message — SSE streamed response
    app.post('/chat', async (req, res) => {
        const { message, sessionId = 'default' } = req.body
        if (!message) return res.status(400).json({ error: 'message required' })

        // SSE headers
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('Access-Control-Allow-Origin', '*')

        try {
            const session = getOrCreateSession(sessionId, {
                apiKey: req.headers['x-api-key'] || process.env.ANTHROPIC_API_KEY,
                provider: req.headers['x-provider'] || process.env.LLM_PROVIDER || 'anthropic',
                modelId: req.headers['x-model'] || process.env.LLM_MODEL || 'claude-sonnet-4-6',
            })

            const { agent } = session

            // Give agent coding tools if not already set
            if (!agent._toolsSet) {
                const tools = createCodingTools({ workspaceDir: process.cwd() })
                agent.setTools(tools)
                agent._toolsSet = true
            }

            // Save user message
            const history = loadChatHistory(sessionId)
            history.push({ role: 'user', content: message, timestamp: Date.now() })

            let fullResponse = ''

            // Subscribe to stream events
            agent.subscribe(event => {
                if (event.type === 'content_delta' && event.delta?.text) {
                    const chunk = event.delta.text
                    fullResponse += chunk
                    res.write(`data: ${JSON.stringify({ type: 'text', content: chunk })}\n\n`)
                }
                if (event.type === 'tool_execution_start') {
                    res.write(`data: ${JSON.stringify({ type: 'tool_start', name: event.toolName })}\n\n`)
                }
                if (event.type === 'tool_execution_end') {
                    res.write(`data: ${JSON.stringify({ type: 'tool_end', name: event.toolName, result: String(event.result).slice(0, 500) })}\n\n`)
                }
            })

            await agent.prompt(message)

            // Save assistant response
            history.push({ role: 'assistant', content: fullResponse, timestamp: Date.now() })
            saveChatHistory(sessionId, history)

            res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
            res.end()
        } catch (err) {
            res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`)
            res.end()
        }
    })

    // List sessions
    app.get('/chat/sessions', (req, res) => {
        res.json(listSessions())
    })

    // Get chat history
    app.get('/chat/history/:sessionId', (req, res) => {
        const history = loadChatHistory(req.params.sessionId)
        res.json(history)
    })

    // Delete session
    app.delete('/chat/sessions/:id', (req, res) => {
        const ok = destroySession(req.params.id)
        res.json({ deleted: ok })
    })
}
