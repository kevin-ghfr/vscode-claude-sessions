# Claude Sessions — VS Code Extension

**One VS Code window. All your projects. All your Claude sessions.**

A VS Code extension to manage multiple Claude Code terminal sessions across projects from a single window. Built for power users who run Claude on 5-15 projects simultaneously.

---

## The Problem

When using Claude Code on multiple projects, you end up with 10-15 VS Code windows. You lose track of which Claude is doing what, whether it's finished, and which terminal belongs to which project.

## The Solution

Claude Sessions consolidates everything into a single VS Code window with a dedicated sidebar. Each project gets its own Claude session — switch in one click, always know where you stand.

---

## Features

### Multi-Project Management

- **Integrated file tree** — file explorer with rename, delete, copy, move, drag & drop, git decorations
- **One-click launch** — start Claude on any project from the tree
- **Auto-resume** — automatically resumes the last conversation (`claude -r`) unless the session was killed
- **Quick filters** — view all projects, active sessions only, or current project only

### Sessions

- **Instant switch** — switch between sessions in one click, terminal follows
- **Per-session editors** — open files are saved/restored per session (each session has its own tabs)
- **Smart notifications** — per-session: sound + popup / popup only / muted — know when Claude finishes without checking every 30 seconds
- **JSONL-based detection** — notifications use deterministic `end_turn` / `stop_sequence` detection from Claude's JSONL output, not timers
- **Plan mode notifications** — detects `ExitPlanMode` and `AskUserQuestion` tool calls for immediate notification when Claude is waiting for your input
- **Full-screen terminal** — automatically maximizes the terminal panel when a session is active
- **Per-session drafts** — message box text is saved/restored per session when switching

### Espaces (Session Groups)

- **Workspaces** — group multiple projects into "espaces" to launch/stop them together
- **Multi-active** — multiple espaces active simultaneously with one in focus
- **Session scope** — filter sessions by espace (focus or active)
- **Group launch** — one click to launch all sessions in an espace
- **Drag & drop** — reorder espaces or move sessions between them
- **Fixed order** — optional fixed sort mode with drag & drop reordering

### Integrated Message Panel

- **Message Panel** — send messages to Claude from a dedicated panel (no need to find the right terminal)
- **"Send to" selector** — send to active session, a specific session, or all sessions in an espace
- **History** — per-session or global prompt history, reusable in one click with full preview on hover
- **Smart paste** — long pasted prompts are auto-collapsed with expand/collapse toggle
- **File attachments** — drag & drop or button to attach files to prompts
- **Image paste** — paste images directly, click thumbnail to enlarge
- **Snippets** — saved commands and messages, insertable at cursor position

### Snippets (Saved Commands & Messages)

- **Terminal commands** — inject pre-registered commands (deploy scripts, git commands, etc.)
- **Claude messages** — insert pre-registered messages into the message box
- **Right-click** — inject a command or send a message directly from session context menu
- **Tags & search** — organize snippets with tags, instant search
- **Auto init** — automatically send a command or message when launching new sessions

### Effort Level

Configure Claude's reasoning level for all launched sessions:

- **Auto** — default Claude behavior
- **Low / Medium / High** — progressive reasoning levels
- **Max** — maximum reasoning (Opus 4.6 only, slower but more precise)

The setting adds the `--effort` flag to the Claude command:

```bash
claude --dangerously-skip-permissions --effort max
```

### tmate Integration

- **Remote access** — tmate sessions launched automatically with each Claude session
- **Deterministic sockets** — one socket per project (`/tmp/tmate-{uid}/project-{hash}`)
- **Preserved across restarts** — existing tmate sessions are reused, not killed
- **Right-click info** — get SSH connection string with one click

### Notification System

The notification system detects Claude's completion state by reading the JSONL conversation files:

| Signal | Meaning | Action |
|--------|---------|--------|
| `end_turn` | Claude finished responding | Sound + unread badge |
| `stop_sequence` | Claude finished (plan mode) | Sound + unread badge |
| `ExitPlanMode` tool | Claude is waiting for plan approval | Sound + unread badge |
| `AskUserQuestion` tool | Claude is asking a question | Sound + unread badge |
| `tool_use` (active) | Claude is using tools | Keep checking |
| `tool_use` (10s+ old) | Claude might be idle | Force done |

- **Per-session notification modes**: muted / popup only / sound only / both
- **No false positives**: timestamp-based deduplication prevents duplicate notifications
- **Subagent filtering**: agent activity doesn't trigger notifications
- **Cross-platform sound**: auto-detects WSL (PowerShell) vs native Linux (paplay/aplay)

### Settings

Everything is configurable from the Settings panel in the sidebar:

| Setting | Description |
|---------|-------------|
| Projects root | Folder containing all your projects |
| Project filter | All / Active / Focused |
| Per-session editors | Isolate tabs per session |
| Session scope | All / Focused espace / Active espaces |
| Auto-resume | Resume last conversation (`claude -r`) |
| Claude effort | Reasoning level: Auto / Low / Medium / High / Max |
| Pre-command | Inject a command before Claude launches |
| Auto pre-command | Command run automatically before every session |
| Init message | Propose a saved message after Claude launches |
| Auto init message | Message sent automatically to every new session |
| Full screen | Maximize terminal automatically |
| Espace filter | All / Active |
| Notification sound | Auto / Off / Custom |
| tmate | Remote terminal access |

---

## Installation

### Prerequisites

- VS Code 1.99+
- Claude Code CLI installed (`claude` in PATH)
- Windows: WSL recommended

### From VSIX (recommended)

```bash
# WSL terminal
code --install-extension claude-sessions-0.7.7.vsix

# Reload VS Code
# Ctrl+Shift+P → "Reload Window"
```

Or from VS Code: `Ctrl+Shift+P` → "Extensions: Install from VSIX..."

### Disable per window

Extensions → Claude Sessions → right-click → "Disable (Workspace)"

### From source

```bash
git clone https://github.com/kevin-ghfr/vscode-claude-sessions.git
cd vscode-claude-sessions
npm install
npm run compile

# Debug: F5 in VS Code
# Package: npx vsce package
```

---

## Architecture

```
src/
  extension.ts        — Entry point, 100+ command registrations
  session-manager.ts  — Session lifecycle, espaces, notifications, JSONL detection
  input-view.ts       — Webview panel (message box, history, snippets, image paste)
  tree-providers.ts   — Tree data providers (projects, sessions, espaces, settings)
  tree-items.ts       — Tree item classes (ProjectFolder, SessionItem, GroupItem...)
  helpers.ts          — Utilities (projectsRoot, formatTimeAgo, nameHash...)
  claude-watcher.ts   — FileSystemWatcher on ~/.claude/projects/ for activity detection
  git-decoration.ts   — Git status decorations in file tree
  drag-controllers.ts — Drag & drop for sessions, espaces, and files
  types.ts            — TypeScript interfaces and types
```

**Key concepts:**
- **Sessions** — each wraps a VS Code Terminal running `claude` CLI
- **Espaces** — saved groups of project paths, can be active (multiple) or focused (single)
- **Notifications** — JSONL-based `end_turn` detection with timestamp deduplication
- **State** — all persisted in VS Code `globalState` (not files)

---

## Build

```bash
npm run compile        # TypeScript → out/
npm run watch          # Watch mode
npx vsce package       # Generate .vsix
```

No webpack/esbuild — pure `tsc` compilation.

---

## License

MIT
