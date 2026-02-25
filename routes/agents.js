// ── Agent Routes — spawn, steer, queue, monitor ──

import { createAgentFromSeed, listSeeds } from '../lib/agent-engine.js'
import {
    createMailbox, registerAgent, unregisterAgent,
    sendSteer, queueTask, readOutbox, getStatus,
    loadRegistry,
} from '../lib/agent-mailbox.js'
import { createCodingTools, createMasterTools, createWorkerTools } from '../lib/tools/index.js'
import path from 'path'
import os from 'os'

const AGENT_MAILBOX_BASE = path.join(process.cwd(), '.agents', 'mailbox')

export default function agentRoutes(app) {
    // List available seeds
    app.get('/agents/seeds', (req, res) => {
        try {
            const seeds = listSeeds()
            res.json(seeds)
        } catch (err) {
            res.status(500).json({ error: err.message })
        }
    })

    // Spawn an agent from a seed
    app.post('/agents/spawn', async (req, res) => {
        const { seedName, agentId, task, context, workspace } = req.body
        if (!seedName || !agentId) {
            return res.status(400).json({ error: 'seedName and agentId required' })
        }

        try {
            createMailbox(agentId, AGENT_MAILBOX_BASE)
            registerAgent(agentId, {
                seedName, task, workspace, context,
                status: 'created',
            }, AGENT_MAILBOX_BASE)

            const { agent, seed } = createAgentFromSeed(seedName, {
                agentId,
                context: context || '',
                workspace: workspace || '',
                mailboxBase: AGENT_MAILBOX_BASE,
                apiKey: req.headers['x-api-key'] || process.env.ANTHROPIC_API_KEY,
            })

            // Set up tools based on seed config
            const codingTools = createCodingTools({ workspaceDir: process.cwd() })
            const masterTools = createMasterTools({ mailboxBase: AGENT_MAILBOX_BASE })
            agent.setTools([...codingTools, ...masterTools])

            res.json({
                agentId,
                seedName,
                status: 'created',
                tools: seed.tools,
                message: `Agent ${agentId} created from seed "${seedName}". Send a task to start it.`,
            })
        } catch (err) {
            res.status(500).json({ error: err.message })
        }
    })

    // List all agents
    app.get('/agents', (req, res) => {
        const registry = loadRegistry(AGENT_MAILBOX_BASE)
        const agents = Object.entries(registry.agents).map(([id, info]) => {
            const status = getStatus(id, AGENT_MAILBOX_BASE)
            return { agentId: id, ...info, ...status }
        })
        res.json(agents)
    })

    // Get agent output
    app.get('/agents/:id/output', (req, res) => {
        const afterLine = parseInt(req.query.after || '0')
        const { messages, totalLines } = readOutbox(req.params.id, afterLine, AGENT_MAILBOX_BASE)
        res.json({ messages, cursor: totalLines })
    })

    // Get agent status
    app.get('/agents/:id/status', (req, res) => {
        const status = getStatus(req.params.id, AGENT_MAILBOX_BASE)
        if (!status) return res.status(404).json({ error: 'Agent not found' })
        res.json(status)
    })

    // Steer an agent (urgent course correction)
    app.post('/agents/:id/steer', (req, res) => {
        const { message } = req.body
        if (!message) return res.status(400).json({ error: 'message required' })
        const msg = sendSteer(req.params.id, message, AGENT_MAILBOX_BASE)
        res.json({ sent: true, ...msg })
    })

    // Queue a task for an agent
    app.post('/agents/:id/queue', (req, res) => {
        const { task } = req.body
        if (!task) return res.status(400).json({ error: 'task required' })
        const msg = queueTask(req.params.id, task, AGENT_MAILBOX_BASE)
        res.json({ queued: true, ...msg })
    })

    // Stop an agent
    app.delete('/agents/:id', (req, res) => {
        unregisterAgent(req.params.id, AGENT_MAILBOX_BASE)
        res.json({ deleted: true })
    })
}
