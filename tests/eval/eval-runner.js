// ── Agent Eval Runner ──
// Runs integration test scenarios against a live LLM.
// Usage: ANTHROPIC_API_KEY=<key> node tests/eval/eval-runner.js

import { createAgentFromSeed, loadSoul } from '../../lib/agent-engine.js'
import { createCodingTools } from '../../lib/tools/index.js'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Set project root
process.chdir(path.resolve(__dirname, '../..'))

const SCENARIOS_DIR = path.join(__dirname, 'scenarios')
const RESULTS_DIR = path.join(__dirname, 'results')

// ── Scenario loader ──

function loadScenarios() {
    if (!fs.existsSync(SCENARIOS_DIR)) return []
    return fs.readdirSync(SCENARIOS_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => {
            const data = JSON.parse(fs.readFileSync(path.join(SCENARIOS_DIR, f), 'utf-8'))
            return { file: f, ...data }
        })
}

// ── Eval executor ──

async function runScenario(scenario) {
    const start = Date.now()
    const workDir = path.join(os.tmpdir(), `eval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
    fs.mkdirSync(workDir, { recursive: true })

    // Set up any fixture files
    if (scenario.fixtures) {
        for (const [filePath, content] of Object.entries(scenario.fixtures)) {
            const fullPath = path.join(workDir, filePath)
            fs.mkdirSync(path.dirname(fullPath), { recursive: true })
            fs.writeFileSync(fullPath, content)
        }
    }

    const result = {
        name: scenario.name,
        passed: false,
        error: null,
        duration: 0,
        toolCalls: 0,
        turns: 0,
        response: '',
    }

    try {
        const seedName = scenario.seed || 'researcher'
        const { agent } = createAgentFromSeed(seedName, {
            agentId: `eval-${scenario.name}`,
            apiKey: process.env.ANTHROPIC_API_KEY,
            provider: process.env.LLM_PROVIDER || 'anthropic',
            modelId: process.env.LLM_MODEL || 'claude-sonnet-4-6',
        })

        const tools = createCodingTools({ workspaceDir: workDir })
        agent.setTools(tools)

        // Track events
        agent.subscribe(event => {
            if (event.type === 'tool_execution_start') result.toolCalls++
            if (event.type === 'turn_start') result.turns++
            if (event.type === 'message_end' && event.message?.role === 'assistant') {
                const text = event.message.content
                    ?.filter(c => c.type === 'text')
                    ?.map(c => c.text)
                    ?.join('') || ''
                result.response += text
            }
        })

        // Run the prompt
        await agent.prompt(scenario.prompt)

        // Check assertions
        if (scenario.assertions) {
            for (const assertion of scenario.assertions) {
                if (assertion.type === 'file_exists') {
                    const exists = fs.existsSync(path.join(workDir, assertion.path))
                    if (!exists) throw new Error(`File not found: ${assertion.path}`)
                }
                if (assertion.type === 'file_contains') {
                    const content = fs.readFileSync(path.join(workDir, assertion.path), 'utf-8')
                    if (!content.includes(assertion.text)) {
                        throw new Error(`File ${assertion.path} missing text: "${assertion.text}"`)
                    }
                }
                if (assertion.type === 'response_contains') {
                    if (!result.response.toLowerCase().includes(assertion.text.toLowerCase())) {
                        throw new Error(`Response missing text: "${assertion.text}"`)
                    }
                }
                if (assertion.type === 'min_tool_calls') {
                    if (result.toolCalls < assertion.count) {
                        throw new Error(`Expected ≥${assertion.count} tool calls, got ${result.toolCalls}`)
                    }
                }
            }
        }

        result.passed = true
    } catch (err) {
        result.error = err.message
    } finally {
        result.duration = Date.now() - start
        // Cleanup
        try { fs.rmSync(workDir, { recursive: true, force: true }) } catch { }
    }

    return result
}

// ── Main ──

async function main() {
    if (!process.env.ANTHROPIC_API_KEY) {
        console.error('❌ ANTHROPIC_API_KEY required. Set it to run eval.')
        process.exit(1)
    }

    const scenarios = loadScenarios()
    if (scenarios.length === 0) {
        console.log('⚠️  No scenarios found in tests/eval/scenarios/')
        console.log('   Create .json files with {name, prompt, assertions} to test agent behavior.')
        process.exit(0)
    }

    console.log(`🧪 Running ${scenarios.length} eval scenarios...\n`)
    fs.mkdirSync(RESULTS_DIR, { recursive: true })

    const results = []
    for (const scenario of scenarios) {
        process.stdout.write(`  ${scenario.name}... `)
        const result = await runScenario(scenario)
        results.push(result)

        if (result.passed) {
            console.log(`✅ (${result.duration}ms, ${result.toolCalls} tools, ${result.turns} turns)`)
        } else {
            console.log(`❌ ${result.error}`)
        }
    }

    // Summary
    const passed = results.filter(r => r.passed).length
    const failed = results.filter(r => !r.passed).length
    console.log(`\n${'─'.repeat(60)}`)
    console.log(`Results: ${passed} passed, ${failed} failed out of ${results.length}`)

    // Save results
    const resultFile = path.join(RESULTS_DIR, `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    fs.writeFileSync(resultFile, JSON.stringify({ timestamp: Date.now(), results }, null, 2))
    console.log(`Results saved to ${resultFile}`)

    process.exit(failed > 0 ? 1 : 0)
}

main()
