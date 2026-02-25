// ── tmux Runner Extension — background job execution via tmux ──

import { execSync } from 'child_process'

/**
 * Create tmux tools for the agent.
 */
export function createTmuxTools(ctx = {}) {
    return [
        {
            name: 'tmux_spawn',
            description: 'Start a background process in a new tmux window. Returns the window name.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Window name (e.g. "train-exp1")' },
                    command: { type: 'string', description: 'Command to run' },
                },
                required: ['name', 'command'],
            },
            execute: async ({ name, command }) => {
                try {
                    // Ensure session exists
                    try { execSync('tmux has-session -t research 2>/dev/null') }
                    catch { execSync('tmux new-session -d -s research') }

                    execSync(`tmux new-window -t research -n "${name}" "${command}"`)
                    return `Started "${command}" in tmux window "research:${name}"`
                } catch (err) {
                    return `Error: ${err.message}`
                }
            },
        },
        {
            name: 'tmux_read',
            description: 'Read recent output from a tmux window.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Window name' },
                    lines: { type: 'number', description: 'Number of lines to read (default: 50)' },
                },
                required: ['name'],
            },
            execute: async ({ name, lines = 50 }) => {
                try {
                    const output = execSync(
                        `tmux capture-pane -t "research:${name}" -p -S -${lines}`,
                        { encoding: 'utf-8', timeout: 5000 }
                    )
                    return output.trim() || '(no output)'
                } catch (err) {
                    return `Error: ${err.message}`
                }
            },
        },
        {
            name: 'tmux_send',
            description: 'Send input/keystrokes to a tmux window.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Window name' },
                    keys: { type: 'string', description: 'Keys to send (e.g. "C-c" to interrupt)' },
                },
                required: ['name', 'keys'],
            },
            execute: async ({ name, keys }) => {
                try {
                    execSync(`tmux send-keys -t "research:${name}" "${keys}" Enter`)
                    return `Sent "${keys}" to research:${name}`
                } catch (err) {
                    return `Error: ${err.message}`
                }
            },
        },
        {
            name: 'tmux_list',
            description: 'List all tmux windows in the research session.',
            parameters: { type: 'object', properties: {} },
            execute: async () => {
                try {
                    const output = execSync(
                        'tmux list-windows -t research -F "#{window_name}: #{window_activity}"',
                        { encoding: 'utf-8', timeout: 5000 }
                    )
                    return output.trim() || '(no windows)'
                } catch (err) {
                    if (err.message.includes('no server') || err.message.includes('no session')) {
                        return '(no tmux session)'
                    }
                    return `Error: ${err.message}`
                }
            },
        },
        {
            name: 'tmux_kill',
            description: 'Kill a tmux window.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Window name to kill' },
                },
                required: ['name'],
            },
            execute: async ({ name }) => {
                try {
                    execSync(`tmux kill-window -t "research:${name}"`)
                    return `Killed window research:${name}`
                } catch (err) {
                    return `Error: ${err.message}`
                }
            },
        },
    ]
}
