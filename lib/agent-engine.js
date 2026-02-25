// ── Agent Engine — factory for configured pi-agent-core Agents ──

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { Agent } from '@mariozechner/pi-agent-core'
import { getModel, streamSimple, getEnvApiKey } from '@mariozechner/pi-ai'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')

// ── Soul loader ──

/**
 * Load a soul (system prompt) template and interpolate {{variables}}.
 * Searches: 1) .agents/souls/{name}.md  2) lib/souls/{name}.md
 */
export function loadSoul(name, vars = {}) {
    const overridePath = path.join(process.cwd(), '.agents', 'souls', `${name}.md`)
    const builtinPath = path.join(__dirname, 'souls', `${name}.md`)
    const soulPath = fs.existsSync(overridePath) ? overridePath : builtinPath

    if (!fs.existsSync(soulPath)) {
        throw new Error(`Soul not found: ${name} (tried ${overridePath} and ${builtinPath})`)
    }

    let content = fs.readFileSync(soulPath, 'utf-8')
    for (const [key, value] of Object.entries(vars)) {
        const val = Array.isArray(value) ? value.join(', ') : String(value ?? '')
        content = content.replaceAll(`{{${key}}}`, val)
    }
    content = content.replace(/\{\{[^}]+\}\}/g, '')
    return content
}

// ── Seed loader ──

/**
 * Load an agent seed (persona template folder).
 * Seed folder structure: soul.md, tools.json, defaults.json
 * Searches: 1) .agents/seeds/{name}/  2) agent-seeds/{name}/
 */
export function loadSeed(seedName) {
    const overrideDir = path.join(process.cwd(), '.agents', 'seeds', seedName)
    const builtinDir = path.join(PROJECT_ROOT, 'agent-seeds', seedName)
    const seedDir = fs.existsSync(overrideDir) ? overrideDir : builtinDir

    if (!fs.existsSync(seedDir)) {
        throw new Error(`Agent seed not found: ${seedName} (tried ${overrideDir} and ${builtinDir})`)
    }

    const soulPath = path.join(seedDir, 'soul.md')
    const toolsPath = path.join(seedDir, 'tools.json')
    const defaultsPath = path.join(seedDir, 'defaults.json')

    const soul = fs.existsSync(soulPath) ? fs.readFileSync(soulPath, 'utf-8') : ''
    const tools = fs.existsSync(toolsPath) ? JSON.parse(fs.readFileSync(toolsPath, 'utf-8')) : []
    const defaults = fs.existsSync(defaultsPath) ? JSON.parse(fs.readFileSync(defaultsPath, 'utf-8')) : {}

    return { soul, tools, defaults, seedDir }
}

// ── Factory functions ──

/**
 * Create an agent from a seed (persona template).
 */
export function createAgentFromSeed(seedName, config = {}) {
    const seed = loadSeed(seedName)
    const {
        provider = seed.defaults.provider || 'anthropic',
        modelId = seed.defaults.model || 'claude-sonnet-4-6',
        apiKey,
        agentId = seedName,
        context = '',
        mailboxBase,
        extraTools = [],
    } = config

    // Interpolate soul with config vars
    let soul = seed.soul
    for (const [key, value] of Object.entries(config)) {
        if (typeof value === 'string') {
            soul = soul.replaceAll(`{{${key}}}`, value)
        }
    }
    soul = soul.replace(/\{\{[^}]+\}\}/g, '')

    if (context) {
        soul += `\n\n## Current Context\n${context}`
    }

    const model = getModel(provider, modelId)
    const agent = new Agent({
        streamFn: streamSimple,
        getApiKey: apiKey ? () => apiKey : (p) => getEnvApiKey(p),
    })

    agent.setModel(model)
    agent.setSystemPrompt(soul)
    // Tools are composed separately and set by the caller or route handler
    if (extraTools.length > 0) agent.setTools(extraTools)

    return { agent, seed, agentId }
}

/**
 * Create a master agent with orchestration + coding tools.
 */
export function createMasterAgent(config = {}) {
    const {
        provider = 'anthropic',
        modelId = 'claude-sonnet-4-6',
        apiKey,
        mailboxBase,
        agentId = 'master',
        systemPrompt,
    } = config

    const model = getModel(provider, modelId)
    const soul = systemPrompt || loadSoul('master', { agentId })

    const agent = new Agent({
        streamFn: streamSimple,
        getApiKey: apiKey ? () => apiKey : (p) => getEnvApiKey(p),
    })

    agent.setModel(model)
    agent.setSystemPrompt(soul)

    return agent
}

/**
 * Create a worker agent for subprocess execution.
 */
export function createWorkerAgent(config = {}) {
    const {
        provider = 'anthropic',
        modelId = 'claude-sonnet-4-6',
        apiKey,
        agentId,
        task = '',
        type = 'general',
    } = config

    const model = getModel(provider, modelId)
    const promptName = type === 'code' ? 'code-agent' : 'worker'

    let sysPrompt
    try { sysPrompt = loadSoul(promptName, { agentId, task }) }
    catch { sysPrompt = `You are agent ${agentId}. Complete the following task.` }

    const agent = new Agent({
        streamFn: streamSimple,
        getApiKey: apiKey ? () => apiKey : (p) => getEnvApiKey(p),
    })

    agent.setModel(model)
    agent.setSystemPrompt(`${sysPrompt}\n\n## Your Task\n${task}`)

    return agent
}

// ── List available seeds ──

export function listSeeds() {
    const builtinDir = path.join(PROJECT_ROOT, 'agent-seeds')
    const overrideDir = path.join(process.cwd(), '.agents', 'seeds')

    const seeds = new Set()
    for (const dir of [builtinDir, overrideDir]) {
        if (fs.existsSync(dir)) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory()) seeds.add(entry.name)
            }
        }
    }
    return [...seeds].map(name => {
        const seed = loadSeed(name)
        return { name, tools: seed.tools, defaults: seed.defaults }
    })
}
