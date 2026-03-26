# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Claude Sessions** — a VS Code extension for managing multiple Claude Code terminal sessions across different projects within a single VS Code window. Written in TypeScript, targets VS Code 1.99.0+, primarily for WSL/Linux users.

## Build & Development

```bash
npm run compile        # TypeScript → out/ (CommonJS, ES2020)
npm run watch          # Watch mode for development
npx vsce package       # Generate .vsix package
```

No webpack/esbuild — pure `tsc` compilation. No test framework is configured.

To debug: open the project in VS Code, press F5 to launch the Extension Development Host.

## Architecture

Hub-and-spoke pattern centered on `SessionManager`:

```
extension.ts          — Entry point: activate(), 100+ command registrations, event wiring
    ↓
SessionManager        — Core state machine: session lifecycle, persistence (globalState),
    │                    notifications (8s timeout), terminal color assignment, file scoping
    ├→ TreeProviders   — 4 tree views: Projects, Sessions, Espaces, Settings
    ├→ InputView       — Webview panel: message compose, history, snippets, file attach
    ├→ ClaudeWatcher   — FileSystemWatcher on ~/.claude/projects/ for activity detection
    ├→ GitDecoration   — FileDecorationProvider for git status badges
    └→ DragControllers — Drag & drop for files and session reorder
```

**Data flow:** Commands dispatch through `extension.ts` → `SessionManager` methods → `fireChanged()` → providers refresh tree views.

**Key concepts:**
- **Sessions** — each wraps a VS Code Terminal running `claude` CLI, tracked in a `Map<string, ClaudeSession>`
- **Espaces** — saved groups of project paths; can be active (multiple) or focused (single), used to scope which sessions are visible
- **NotifyMode** — per-session notification state: `muted | notify | sound | notifySound`
- **Smart resume** — reads `~/.claude/projects/<encoded-path>/` to detect previous session IDs, uses `claude -r <id>` to resume

**State persistence:** All settings, history, snippets, groups, and session state stored in VS Code `globalState` (not files). Settings use `setting:` key prefix. History is per-project (`commandHistory:<path>`), capped at 50 items.

## Key Source Files

| File | Lines | Role |
|------|-------|------|
| `src/extension.ts` | ~1250 | Command registration, activate/deactivate, event listeners |
| `src/session-manager.ts` | ~1070 | Session CRUD, notifications, state machine, persistence |
| `src/input-view.ts` | ~1070 | Webview HTML generation, message protocol (webview ↔ extension) |
| `src/tree-providers.ts` | ~230 | TreeDataProviders for Projects, Sessions, Espaces, Settings |
| `src/tree-items.ts` | ~210 | TreeItem subclasses with icons, context values, descriptions |
| `src/types.ts` | ~40 | Interfaces: ClaudeSession, SessionGroup, Snippet, type unions |
| `src/helpers.ts` | ~65 | Utilities: formatTimeAgo, getProjectsRoot, nameHash, getGitBranch |

## Conventions

- All UI text is in **French** (tree labels, settings descriptions, notifications, webview UI)
- The extension ID is `claudeSessions`; all commands are prefixed `claudeSessions.`
- Terminal colors are hash-assigned from 6 VS Code theme colors for visual consistency
- The webview communicates via `postMessage` with typed message objects (`{ type: string, ... }`)
- File exclusions in the project tree: `.*, node_modules, .git, dist, out, __pycache__`
- Sound playback auto-detects WSL (PowerShell) vs native Linux (paplay/aplay)
