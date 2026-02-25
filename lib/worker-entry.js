#!/usr/bin/env node
// ── Worker Entry Point ──
// Standalone script spawned by the master agent.
// Usage: node worker-entry.js --id <id> --mailbox <path> --task <task> --type <general|code>

import { createWorkerAgent } from './agent-engine.js'
import { updateStatus } from './agent-mailbox.js'
import { createCodingTools } from './tools/index.js'

function parseArgs() {
    const args = process.argv.slice(2)
    const parsed = {}
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--id') parsed.id = args[++i]
        else if (args[i] === '--mailbox') parsed.mailbox = args[++i]
        else if (args[i] === '--task') parsed.task = args[++i]
        else if (args[i] === '--type') parsed.type = args[++i]
    }
    return parsed
}

async function main() {
    const { id, mailbox, task, type = 'general' } = parseArgs()
    if (!id || !mailbox || !task) {
        console.error('Usage: node worker-entry.js --id <id> --mailbox <path> --task <task>')
        process.exit(1)
    }

    console.log(`[Worker ${id}] Starting (type=${type})`)
    updateStatus(id, { status: 'running', pid: process.pid, startedAt: Date.now() }, mailbox)

    const agent = createWorkerAgent({
        agentId: id,
        mailboxBase: mailbox,
        type,
        task,
        apiKey: process.env.ANTHROPIC_API_KEY || process.env.LLM_API_KEY,
        provider: process.env.LLM_PROVIDER || 'anthropic',
        modelId: process.env.LLM_MODEL || 'claude-sonnet-4-6',
    })

    // Give worker coding tools
    const tools = createCodingTools({ workspaceDir: process.cwd() })
    agent.setTools(tools)

    let toolCalls = 0
    let turns = 0

    agent.subscribe(event => {
        switch (event.type) {
            case 'turn_start':
                turns++
                updateStatus(id, { turns, lastActivity: Date.now() }, mailbox)
                break
            case 'tool_execution_start':
                toolCalls++
                updateStatus(id, { toolCalls, lastToolName: event.toolName, lastActivity: Date.now() }, mailbox)
                console.log(`[Worker ${id}] Tool: ${event.toolName}`)
                break
            case 'agent_end':
                console.log(`[Worker ${id}] Agent finished`)
                break
        }
    })

    try {
        await agent.prompt(task)
        const { getStatus } = await import('./agent-mailbox.js')
        const status = getStatus(id, mailbox)
        if (status?.status === 'running') {
            updateStatus(id, { status: 'complete', result: 'Done', exitCode: 0 }, mailbox)
        }
        console.log(`[Worker ${id}] Done`)
        process.exit(0)
    } catch (err) {
        console.error(`[Worker ${id}] Error: ${err.message}`)
        updateStatus(id, { status: 'error', result: err.message, exitCode: 1 }, mailbox)
        process.exit(1)
    }
}

main()
