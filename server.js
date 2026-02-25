// ── Research Agent v2 — Server ──
// Lean Express app. All logic lives in lib/ and routes/.

import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import chatRoutes from './routes/chat.js'
import agentRoutes from './routes/agents.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
app.use(express.json())

// Serve frontend
app.use(express.static(path.join(__dirname, 'frontend')))

// Mount routes
chatRoutes(app)
agentRoutes(app)

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '2.0.0', uptime: process.uptime() })
})

// ── Start ──
const PORT = parseInt(process.env.PORT || '3001', 10)

app.listen(PORT, () => {
    console.log(`🔬 Research Agent v2 running at http://localhost:${PORT}`)
    console.log(`   LLM: ${process.env.LLM_PROVIDER || 'anthropic'} / ${process.env.LLM_MODEL || 'claude-sonnet-4-6'}`)
    console.log(`   API Key: ${process.env.ANTHROPIC_API_KEY ? '✅ set' : '❌ missing (set ANTHROPIC_API_KEY)'}`)
})
