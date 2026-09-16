# README

My personal configuration for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent). Not a source project — this directory controls how pi behaves globally.

## What's here

| Path | Purpose |
|---|---|
| `AGENTS.md` | Instructions pi reads when working in this repo |
| `agent/settings.json` | Main config: provider, model, theme, skills, packages, extensions |
| `agent/keybindings.json` | Custom TUI keybindings |
| `agent/extensions/vim-mode.ts` | Custom vim-mode extension for the pi TUI (~400 lines of TypeScript) |

Everything else (`auth.json`, `models-store.json`, `sessions/`, `npm/`, `bin/`, `context-mode/`) is runtime data managed by pi — don't touch it.

## Setup highlights

- **Provider/model:** OpenRouter, defaulting to `openrouter/free`
- **Theme:** `ansi-dark` (via `pi-ansi-themes`)
- **Vim mode:** enabled, backed by a custom extension with motions, operators, visual mode, registers, marks, search, and undo
- **Skills:** loaded from `~/dev/agent-skills/`
- **Packages:** ansi themes, status line, web access, fancy loader, ask user question

## Notes

- Validate JSON after editing: `jq . agent/settings.json`
- Type-check the extension: `cd agent/extensions && npx tsc --noEmit vim-mode.ts`
