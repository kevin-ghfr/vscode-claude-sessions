import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { exec } from 'child_process';
import { ClaudeSession, FilterMode, NotifyMode, SortMode, SessionFilter, SessionGroup, EspaceFilter, SessionScopeFilter, EspaceSortMode } from './types';
import { getLastActivityFromDisk, nameHash, getGitBranch, TERMINAL_COLORS } from './helpers';

export class SessionManager {
  private sessions = new Map<string, ClaudeSession>();
  private _active: string | undefined;
  private _onChanged = new vscode.EventEmitter<void>();
  onChanged = this._onChanged.event;
  private _onSessionSwitched = new vscode.EventEmitter<string>();
  onSessionSwitched = this._onSessionSwitched.event;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private statusBar: vscode.StatusBarItem;
  fullView = true;
  tmateEnabled = false;
  globalNotifyMode: NotifyMode = 'notifySound';
  sortMode: SortMode = 'recent-desc';
  sessionFilter: SessionFilter = 'all';
  resumeConversation = true; // true = claude -r, false = claude
  scopeEditors = true; // true = only show files from active session, false = keep all
  filterMode: FilterMode = 'focused';
  private _sessionOrder: string[] = []; // for fixed sort mode
  private _restoring = false;
  private _restoredSessions = new Set<string>(); // per-session cooldown after restore
  private _killedSessionIds: Set<string>; // session IDs of explicitly killed sessions — persisted
  private _fireDebounceTimer?: ReturnType<typeof setTimeout>;
  private _restoreGeneration = 0;
  private _restoreInProgress = false;
  private _panelMaximized = false;
  activeGroupIds = new Set<string>();
  focusedGroupId: string | undefined;
  espaceFilter: EspaceFilter = 'all';
  sessionScopeFilter: SessionScopeFilter = 'all';
  espaceSortMode: EspaceSortMode = 'recent-desc';
  private _espaceOrder: string[] = []; // for fixed espace sort mode
  private _lastEndTurnTs = new Map<string, string>(); // timestamp of last processed end_turn per session
  preCommandEnabled = false;
  initMessageEnabled = false;
  autoInitMessage = '';
  autoPreCommand = '';

  /** Ensure panel is maximized if fullView is on. Only toggles when state needs to change. */
  ensurePanelMaximized(): void {
    if (this.fullView && !this._panelMaximized) {
      vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
      this._panelMaximized = true;
    }
  }

  /** Restore panel from maximized state. */
  ensurePanelRestored(): void {
    if (this._panelMaximized) {
      vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
      this._panelMaximized = false;
    }
  }

  private fireChanged(): void {
    if (this._restoring) return;
    if (this._fireDebounceTimer) clearTimeout(this._fireDebounceTimer);
    this._fireDebounceTimer = setTimeout(() => {
      this._fireDebounceTimer = undefined;
      this._onChanged.fire();
    }, 200);
  }

  constructor(public readonly context: vscode.ExtensionContext) {
    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    );
    context.subscriptions.push(this.statusBar);
    // Restore persisted settings
    this.tmateEnabled = context.globalState.get<boolean>('setting:tmateEnabled', false);
    this.globalNotifyMode = context.globalState.get<NotifyMode>('setting:globalNotifyMode', 'notifySound');
    this.sortMode = context.globalState.get<SortMode>('setting:sortMode', 'recent-desc');
    this.sessionFilter = context.globalState.get<SessionFilter>('setting:sessionFilter', 'all');
    this.fullView = context.globalState.get<boolean>('setting:fullView', true);
    this.resumeConversation = context.globalState.get<boolean>('setting:resumeConversation', true);
    this.scopeEditors = context.globalState.get<boolean>('setting:scopeEditors', true);
    this.filterMode = context.globalState.get<FilterMode>('setting:filterMode', 'focused');
    this._sessionOrder = context.globalState.get<string[]>('setting:sessionOrder', []);
    // No sessions exist at startup — clear stale activeGroupIds.
    // Espaces become active only when sessions are actually launched via restoreGroup().
    // Restore focusedGroupId so the user can quickly re-launch their last espace.
    this.activeGroupIds = new Set();
    this.focusedGroupId = context.globalState.get<string | undefined>('focusedGroupId');
    // Migration: clean up legacy single activeGroupId
    context.globalState.update('activeGroupId', undefined);
    this.persistGroupState();
    const savedEspaceFilter = context.globalState.get<string>('setting:espaceFilter', 'all');
    this.espaceFilter = (savedEspaceFilter === 'open' ? 'active' : savedEspaceFilter) as EspaceFilter;
    this.sessionScopeFilter = context.globalState.get<SessionScopeFilter>('setting:sessionScopeFilter', 'espaceFocus');
    this.espaceSortMode = context.globalState.get<EspaceSortMode>('setting:espaceSortMode', 'recent-desc');
    this._espaceOrder = context.globalState.get<string[]>('setting:espaceOrder', []);
    this.preCommandEnabled = context.globalState.get<boolean>('setting:preCommandEnabled', false);
    this.initMessageEnabled = context.globalState.get<boolean>('setting:initMessageEnabled', false);
    this.autoInitMessage = context.globalState.get<string>('setting:autoInitMessage', '');
    this.autoPreCommand = context.globalState.get<string>('setting:autoPreCommand', '');
    this._killedSessionIds = new Set(context.globalState.get<string[]>('killedSessionIds', []));
  }

  /** Persist a setting to globalState */
  persistSetting(key: string, value: unknown): void {
    this.context.globalState.update(`setting:${key}`, value);
  }

  private persistKilledPaths(): void {
    this.context.globalState.update('killedSessionIds', [...this._killedSessionIds]);
  }

  migrateSnippets(): void {
    const snippets = this.context.globalState.get<any[]>('snippets', []);
    let changed = false;
    for (const s of snippets) {
      if (!s.type) { s.type = 'message'; changed = true; }
    }
    if (changed) this.context.globalState.update('snippets', snippets);
  }

  /** Dispose dead claude terminals left over from previous VS Code sessions */
  cleanupDeadTerminals(): void {
    // Dispose ALL claude: terminals at startup — they'll be recreated by espace restore
    for (const terminal of vscode.window.terminals) {
      if (terminal.name.startsWith('claude: ')) {
        terminal.dispose();
      }
    }
    // Cleanup orphaned non-deterministic tmate sockets from old system
    const uid = os.userInfo().uid;
    const socketDir = `/tmp/tmate-${uid}`;
    exec(`ls "${socketDir}" 2>/dev/null | grep -v "^project-" | while read f; do tmate -S "${socketDir}/$f" kill-server 2>/dev/null; rm -f "${socketDir}/$f"; done`);
  }

  dispose(): void {
    if (this._fireDebounceTimer) clearTimeout(this._fireDebounceTimer);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this._onChanged.dispose();
    this._onSessionSwitched.dispose();
  }

  get activeProject() {
    return this._active;
  }

  getActive(): ClaudeSession | undefined {
    return this._active ? this.sessions.get(this._active) : undefined;
  }

  private sessionName(projectPath: string): string {
    const base = path.basename(projectPath);
    if (!this.sessions.has(base)) return base;
    const existing = this.sessions.get(base)!;
    if (existing.projectPath === projectPath) return base;
    const parent = path.basename(path.dirname(projectPath));
    let candidate = `${base} (${parent})`;
    if (!this.sessions.has(candidate)) return candidate;
    const existing2 = this.sessions.get(candidate)!;
    if (existing2.projectPath === projectPath) return candidate;
    let i = 2;
    while (this.sessions.has(`${candidate} ${i}`)) i++;
    return `${candidate} ${i}`;
  }

  async createSession(projectPath: string, options?: { preCommand?: string }): Promise<{ isNew: boolean }> {
    const name = this.sessionName(projectPath);
    if (this.sessions.has(name)) {
      this.switchTo(name);
      return { isNew: false };
    }

    const recentId = this.resumeConversation ? this.getRecentSessionId(projectPath) : undefined;
    let useResume = !!recentId;

    // If this session ID was explicitly killed, don't try to resume — start fresh
    if (recentId && this._killedSessionIds.has(recentId)) {
      useResume = false;
      this._killedSessionIds.delete(recentId);
      this.persistKilledPaths();
    }

    const effortLevel = vscode.workspace.getConfiguration('claudeSessions').get<string>('effortLevel', 'auto');
    const effortFlag = effortLevel !== 'auto' ? ` --effort ${effortLevel}` : '';
    const cmd = useResume && recentId
      ? `claude -r ${recentId} --dangerously-skip-permissions${effortFlag}`
      : `claude --dangerously-skip-permissions${effortFlag}`;

    // Cleanup any terminal with same name before creating new one
    for (const t of vscode.window.terminals) {
      if (t.name === `claude: ${name}`) {
        t.dispose();
      }
    }

    const colorIdx = nameHash(name);
    const terminal = vscode.window.createTerminal({
      name: `claude: ${name}`,
      cwd: projectPath,
      iconPath: new vscode.ThemeIcon('sparkle'),
      color: new vscode.ThemeColor(
        TERMINAL_COLORS[colorIdx % TERMINAL_COLORS.length],
      ),
    });

    const safePath = projectPath.replace(/'/g, "'\\''");
    const fullCmd = `cd '${safePath}' && ${cmd}`;
    const preCmd = options?.preCommand || (this._restoring ? undefined : this.autoPreCommand) || undefined;

    const guardedSend = (t: vscode.Terminal, text: string) => {
      if (this.sessions.has(name)) t.sendText(text);
    };

    // Auto-enter: send \n at intervals to accept Claude prompts (imports, conversation picker, etc.)
    const autoEnter = (baseDelay: number) => {
      const intervals = [3000, 6000, 9000];
      for (const t of intervals) {
        setTimeout(() => guardedSend(terminal, ''), baseDelay + t);
      }
    };

    // Effort is handled via CLI flag --effort only, no /effort message injection

    // Deterministic tmate socket per project — reuse if alive
    const uid = os.userInfo().uid;
    const tmateSocket = `/tmp/tmate-${uid}/project-${Math.abs(nameHash(projectPath))}`;
    let tmateCmd = '';
    if (this.tmateEnabled) {
      try {
        const alive = require('child_process').execSync(
          `tmate -S "${tmateSocket}" display -p '#{tmate_ssh}' 2>/dev/null`,
          { timeout: 2000, encoding: 'utf8' },
        ).trim();
        tmateCmd = alive.startsWith('ssh ') ? '' : `tmate -S "${tmateSocket}" new-session -d`;
      } catch {
        tmateCmd = `tmate -S "${tmateSocket}" new-session -d`;
      }
    }

    const sendClaudeCmd = (delay: number) => {
      setTimeout(() => {
        guardedSend(terminal, fullCmd);
        autoEnter(delay);
        // effort handled via CLI flag
      }, delay);
    };

    if (this._restoring) {
      if (this.tmateEnabled && preCmd) {
        setTimeout(() => { guardedSend(terminal, preCmd); }, 500);
        if (tmateCmd) setTimeout(() => { guardedSend(terminal, tmateCmd); }, 3500);
        sendClaudeCmd(tmateCmd ? 6500 : 3500);
      } else if (this.tmateEnabled) {
        if (tmateCmd) {
          setTimeout(() => { guardedSend(terminal, tmateCmd); sendClaudeCmd(3000); }, 500);
        } else {
          sendClaudeCmd(500);
        }
      } else if (preCmd) {
        setTimeout(() => { guardedSend(terminal, preCmd); }, 500);
        sendClaudeCmd(3500);
      } else {
        sendClaudeCmd(500);
      }
    } else {
      if (this.tmateEnabled && preCmd) {
        terminal.sendText(preCmd);
        if (tmateCmd) setTimeout(() => { guardedSend(terminal, tmateCmd); }, 3000);
        sendClaudeCmd(tmateCmd ? 6000 : 3000);
      } else if (this.tmateEnabled) {
        if (tmateCmd) terminal.sendText(tmateCmd);
        sendClaudeCmd(tmateCmd ? 3000 : 0);
      } else if (preCmd) {
        terminal.sendText(preCmd);
        sendClaudeCmd(3000);
      } else {
        terminal.sendText(fullCmd);
        autoEnter(0);
      }
      terminal.show();
      this.ensurePanelMaximized();
    }

    this.sessions.set(name, {
      projectName: name,
      projectPath,
      terminal,
      status: 'done',
      unread: false,
      notifyMode: this.globalNotifyMode,
      openFiles: [],
      lastActivity: getLastActivityFromDisk(projectPath),
      colorIndex: colorIdx,
      tmateSocketPath: this.tmateEnabled ? tmateSocket : undefined,
    });
    this._active = name;
    if (!this._restoring) {
      this._onSessionSwitched.fire(name);
    }
    this.updateStatusBar();
    this.saveState();
    // Auto-add to focused active espace
    if (!this._restoring && this.focusedGroupId && this.activeGroupIds.has(this.focusedGroupId)) {
      const groups = this.getGroups();
      const group = groups.find(g => g.id === this.focusedGroupId);
      if (group && !group.paths.includes(projectPath)) {
        group.paths.push(projectPath);
        this.saveGroups(groups);
      }
    }
    // Pre-load last end_turn timestamp to avoid false notifications on existing end_turns
    const initialResult = this.readLastStopReason(projectPath);
    if (initialResult?.stopReason === 'end_turn' || initialResult?.stopReason === 'stop_sequence') {
      this._lastEndTurnTs.set(name, initialResult.timestamp);
    }
    this.fireChanged();
    // Auto init message (global, sent automatically after Claude is ready)
    if (this.autoInitMessage && !this._restoring) {
      const autoName = name;
      const autoMsg = this.autoInitMessage;
      setTimeout(() => {
        if (this.sessions.has(autoName)) {
          const sess = this.sessions.get(autoName)!;
          sess.terminal.sendText(autoMsg);
          setTimeout(() => sess.terminal.sendText(''), 300);
        }
      }, 15000);
    }
    return { isNew: !recentId };
  }

  async switchTo(name: string): Promise<void> {
    const s = this.sessions.get(name);
    if (!s) return;

    if (name === this._active) {
      s.terminal.show();
      this.ensurePanelMaximized();
      return;
    }

    if (this.scopeEditors) {
      this.saveCurrentFiles();
    }
    s.terminal.show();
    this.ensurePanelMaximized();
    s.unread = false;
    // Notification state managed by _lastEndTurnTs timestamp check
    // Otherwise any file change would re-trigger the stale end_turn notification
    this._active = name;
    this._onSessionSwitched.fire(name);
    this.updateStatusBar();
    this.fireChanged();
    if (this.scopeEditors) {
      this._panelMaximized = false; // Reset so ensurePanelMaximized can re-maximize after restore
      this._restoreInProgress = true;
      try {
        await this.restoreFiles(s);
      } finally {
        this._restoreInProgress = false;
      }
      // Re-focus terminal if fullView is on (restoreFiles opens editors which steals focus)
      if (this.fullView) {
        setTimeout(() => {
          s.terminal.show();
          this.ensurePanelMaximized();
        }, 300);
      }
    }
    // Focus Source Control on this project's repository
    this.focusSCM(s.projectPath);
  }

  private focusSCM(_projectPath: string): void {
    // Removed — SCM panel not useful, AI works via git CLI in terminal
  }

  stopSession(name: string): void {
    const s = this.sessions.get(name);
    if (!s) return;
    // Kill tmate session if active
    if (s.tmateSocketPath) {
      exec(`tmate -S "${s.tmateSocketPath}" kill-server 2>/dev/null`);
    }
    // Don't mark as killed — close ≠ delete. Resume with -r by default.
    this.sessions.delete(name);
    this.clearTimer(name);
    this._lastEndTurnTs.delete(name);
    s.terminal.dispose();
    // Don't remove workspace folder here — removing index 0 causes VS Code window reload.
    // Cleanup happens at deactivate() and cleanupLeftoverFolders() on next activate.
    if (this._active === name) {
      this._active = [...this.sessions.keys()][0];
    }
    this.updateStatusBar();
    this.saveState();
    this.fireChanged();
  }

  deleteConversation(name: string): void {
    const s = this.sessions.get(name);
    const projectPath = s?.projectPath;
    if (s) this.stopSession(name);
    if (projectPath) {
      const killedId = this.getRecentSessionId(projectPath);
      if (killedId) {
        this._killedSessionIds.add(killedId);
        this.persistKilledPaths();
      }
    }
  }

  onClaudeActivity(projectName: string): void {
    if (this._restoredSessions.has(projectName)) return;
    const s = this.sessions.get(projectName);
    if (!s) return;

    s.lastActivity = new Date();

    // Immediate visual feedback: set working status for any detected activity
    if (s.status !== 'working') {
      s.status = 'working';
    }

    // Debounce: schedule JSONL check 3s after last activity
    // Each new activity resets the timer, so the check only runs when writes stop
    this.clearTimer(projectName);
    this.scheduleCompletionCheck(projectName);

    this.fireChanged();
  }

  /** Read last 500KB of JSONL, scan backwards for first assistant with stop_reason.
   *  Returns end_turn/stop_sequence if Claude finished, tool_use if still working (with toolName), undefined if can't read. */
  private readLastStopReason(projectPath: string): { stopReason: string; timestamp: string; toolName?: string } | undefined {
    try {
      const encoded = projectPath.replace(/\//g, '-');
      const dir = path.join(os.homedir(), '.claude', 'projects', encoded);
      if (!fs.existsSync(dir)) return undefined;
      const jsonlFiles = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
      if (jsonlFiles.length === 0) return undefined;
      let best: { name: string; mtime: number } | undefined;
      for (const f of jsonlFiles) {
        const stat = fs.statSync(path.join(dir, f));
        if (!best || stat.mtimeMs > best.mtime) best = { name: f, mtime: stat.mtimeMs };
      }
      if (!best) return undefined;

      const filePath = path.join(dir, best.name);
      const stat = fs.statSync(filePath);
      const readSize = Math.min(stat.size, 500000);
      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(readSize);
      fs.readSync(fd, buffer, 0, readSize, Math.max(0, stat.size - readSize));
      fs.closeSync(fd);

      const lines = buffer.toString('utf8').split('\n').filter(l => l.trim());
      // Scan backwards: return FIRST assistant with stop_reason found
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type === 'assistant' && entry.message?.stop_reason) {
            let toolName: string | undefined;
            if (entry.message.stop_reason === 'tool_use' && Array.isArray(entry.message.content)) {
              const tu = entry.message.content.find((c: any) => c.type === 'tool_use');
              if (tu) toolName = tu.name;
            }
            return { stopReason: entry.message.stop_reason, timestamp: entry.timestamp || '', toolName };
          }
        } catch { /* incomplete JSON at chunk boundary, skip */ }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private scheduleCompletionCheck(projectName: string, retryCount = 0): void {
    const s = this.sessions.get(projectName);
    if (!s) return;

    this.timers.set(
      projectName,
      setTimeout(() => {
        this.timers.delete(projectName);
        if (!s) return;

        // Deterministic check: read JSONL to see if Claude finished (end_turn)
        const result = this.readLastStopReason(s.projectPath);
        // Notification check based on JSONL stop_reason

        if (result?.stopReason === 'end_turn' || result?.stopReason === 'stop_sequence') {
          // Check if this is the SAME end_turn we already processed (stale)
          if (result.timestamp && result.timestamp === this._lastEndTurnTs.get(projectName)) {
            // Stale end_turn — already processed, just restore done status
            s.status = 'done';
            this.fireChanged();
            return;
          }
          // New end_turn — Claude has truly finished
          this._lastEndTurnTs.set(projectName, result.timestamp);
          s.status = 'done';
          const isBackground = s.projectName !== this._active;

          // Stale check above already prevents duplicates — notify directly
          const wantsSound = s.notifyMode === 'sound' || s.notifyMode === 'notifySound';
          const wantsNotif = s.notifyMode === 'notify' || s.notifyMode === 'notifySound';

          if (wantsSound) {
            console.log(`[CS-NOTIF] ${projectName}: PLAYING SOUND`);
            this.playNotificationSound();
          }
          if (isBackground) {
            console.log(`[CS-NOTIF] ${projectName}: setting UNREAD=true`);
            s.unread = true;
            if (wantsNotif) {
              vscode.window
                .showInformationMessage(
                  `Claude a termine dans "${s.projectName}"`,
                  'Voir',
                )
                .then(action => {
                  if (action === 'Voir') this.switchTo(s.projectName).catch(() => {});
                });
            }
          }
          this.fireChanged();
        } else if (result !== undefined) {
          // Check if this is a "waiting for user" tool (ExitPlanMode, AskUserQuestion)
          const WAITING_TOOLS = new Set(['ExitPlanMode', 'AskUserQuestion']);
          if (result.toolName && WAITING_TOOLS.has(result.toolName)) {
            // Claude is waiting for user input — treat like end_turn
            if (result.timestamp && result.timestamp === this._lastEndTurnTs.get(projectName)) {
              s.status = 'done';
              this.fireChanged();
              return;
            }
            this._lastEndTurnTs.set(projectName, result.timestamp);
            s.status = 'done';
            const isBackground = s.projectName !== this._active;
            const wantsSound = s.notifyMode === 'sound' || s.notifyMode === 'notifySound';
            const wantsNotif = s.notifyMode === 'notify' || s.notifyMode === 'notifySound';
            if (wantsSound) {
              console.log(`[CS-NOTIF] ${projectName}: PLAYING SOUND (waiting tool: ${result.toolName})`);
              this.playNotificationSound();
            }
            if (isBackground) {
              console.log(`[CS-NOTIF] ${projectName}: setting UNREAD=true (waiting tool: ${result.toolName})`);
              s.unread = true;
              if (wantsNotif) {
                vscode.window
                  .showInformationMessage(`Claude attend dans "${s.projectName}"`, 'Voir')
                  .then(action => { if (action === 'Voir') this.switchTo(s.projectName).catch(() => {}); });
              }
            }
            this.fireChanged();
          } else {
            // Normal tool_use — check age of last tool call
            const toolAge = Date.now() - new Date(result.timestamp).getTime();
            if (toolAge >= 10000) {
              // 10s+ since last tool call — Claude might be waiting
              s.status = 'done';
              this.fireChanged();
            } else {
              this.scheduleCompletionCheck(projectName);
            }
          }
        } else {
          // Can't read JSONL — retry up to 5 times then assume done
          if (retryCount < 5) {
            this.scheduleCompletionCheck(projectName, retryCount + 1);
          } else {
            s.status = 'done';
            this.fireChanged();
          }
        }
      }, 3000),
    );
  }

  playNotificationSound(force = false): void {
    const config = vscode.workspace.getConfiguration('claudeSessions');
    const soundMode = config.get<string>('notificationSound', 'auto');
    if (soundMode === 'off') return;
    const volume = config.get<number>('notificationVolume', 1.0);
    if (soundMode === 'custom') {
      const customCmd = config.get<string>('notificationSoundCommand', '');
      if (customCmd) exec(customCmd).on('error', () => {});
      return;
    }
    // paplay supports volume (65536 = 100%), try it first for volume control
    const paVolume = Math.round(65536 * volume);
    // MediaPlayer (WPF) supports Volume 0.0–1.0, cap at 1.0 for Windows
    const wpfVol = Math.min(volume, 1.0).toFixed(2);
    const psCmd = `Add-Type -AssemblyName presentationCore; $p = New-Object System.Windows.Media.MediaPlayer; $p.Volume = ${wpfVol}; $p.Open([Uri]'C:\\Windows\\Media\\notify.wav'); $p.Play(); Start-Sleep -Milliseconds 2000`;
    exec(
      `paplay --volume=${paVolume} /usr/share/sounds/freedesktop/stereo/bell.oga 2>/dev/null || /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command "${psCmd}" 2>/dev/null || powershell.exe -NoProfile -Command "${psCmd}" 2>/dev/null || aplay /usr/share/sounds/freedesktop/stereo/bell.oga 2>/dev/null || true`,
      { timeout: 10000 },
    ).on('error', () => {});
  }

  cycleNotifyMode(name: string): void {
    const s = this.sessions.get(name);
    if (!s) return;
    const modes: NotifyMode[] = ['muted', 'notify', 'sound', 'notifySound'];
    const idx = modes.indexOf(s.notifyMode);
    s.notifyMode = modes[(idx + 1) % modes.length];
    const labels: Record<NotifyMode, string> = {
      muted: 'Muet — aucune notification',
      notify: 'Notification popup uniquement',
      sound: 'Son uniquement',
      notifySound: 'Notification + son',
    };
    vscode.window.setStatusBarMessage(labels[s.notifyMode], 2000);
    this.fireChanged();
  }

  removeByTerminal(terminal: vscode.Terminal): ClaudeSession | undefined {
    for (const [name, s] of this.sessions) {
      if (s.terminal === terminal) {
        // Don't mark as killed — terminal close ≠ delete conversation
        this.sessions.delete(name);
        this.clearTimer(name);
        this._lastEndTurnTs.delete(name);
        if (this._active === name) {
          this._active = [...this.sessions.keys()][0];
        }
        this.updateStatusBar();
        this.saveState();
        this.fireChanged();
        return s;
      }
    }
    return undefined;
  }

  findByTerminal(terminal: vscode.Terminal): ClaudeSession | undefined {
    for (const s of this.sessions.values()) {
      if (s.terminal === terminal) return s;
    }
    return undefined;
  }

  all(): ClaudeSession[] {
    if (this.sortMode === 'fixed' && this._sessionOrder.length > 0) {
      const ordered: ClaudeSession[] = [];
      for (const name of this._sessionOrder) {
        const s = this.sessions.get(name);
        if (s) ordered.push(s);
      }
      for (const s of this.sessions.values()) {
        if (!this._sessionOrder.includes(s.projectName)) ordered.push(s);
      }
      return ordered;
    }
    const dir = this.sortMode === 'recent-asc' ? -1 : 1;
    return [...this.sessions.values()].sort(
      (a, b) => dir * (b.lastActivity.getTime() - a.lastActivity.getTime()),
    );
  }

  filtered(): ClaudeSession[] {
    const all = this.all();
    if (this.sessionFilter === 'all') return all;
    return all.filter(s => {
      if (this.sessionFilter === 'working') return s.status === 'working';
      if (this.sessionFilter === 'unread') return s.unread;
      return s.status === 'done' && !s.unread; // 'read'
    });
  }

  async showSortPicker(): Promise<void> {
    const labels: Record<SortMode, string> = {
      'recent-desc': 'Plus recent en premier',
      'recent-asc': 'Plus ancien en premier',
      'fixed': 'Ordre fige',
    };
    const items = (['recent-desc', 'recent-asc', 'fixed'] as SortMode[]).map(m => ({
      label: m === this.sortMode ? `$(check) ${labels[m]}` : `     ${labels[m]}`,
      value: m,
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Trier les sessions' });
    if (!picked) return;
    if (picked.value === 'fixed' && this.sortMode !== 'fixed') {
      this._sessionOrder = this.all().map(s => s.projectName);
    }
    this.sortMode = picked.value as SortMode;
    this.persistSetting('sortMode', this.sortMode);
    if (picked.value !== 'fixed') this._sessionOrder = [];
    this.persistSetting('sessionOrder', this._sessionOrder);
    this.fireChanged();
  }

  reorderSession(fromName: string, toName: string): void {
    if (this.sortMode !== 'fixed') return;
    if (this._sessionOrder.length === 0) {
      this._sessionOrder = this.all().map(s => s.projectName);
    }
    const fromIdx = this._sessionOrder.indexOf(fromName);
    const toIdx = this._sessionOrder.indexOf(toName);
    if (fromIdx < 0 || toIdx < 0) return;
    this._sessionOrder.splice(fromIdx, 1);
    this._sessionOrder.splice(toIdx, 0, fromName);
    this.persistSetting('sessionOrder', this._sessionOrder);
    this.fireChanged();
  }

  has(name: string): boolean {
    return this.sessions.has(name);
  }

  hasPath(projectPath: string): boolean {
    for (const s of this.sessions.values()) {
      if (s.projectPath === projectPath) return true;
    }
    return false;
  }

  get activeProjectPath(): string | undefined {
    const s = this.getActive();
    return s?.projectPath;
  }

  async restoreActiveFiles(): Promise<void> {
    const s = this._active ? this.sessions.get(this._active) : undefined;
    if (s) {
      await this.restoreFiles(s);
    }
  }

  restoreSaved(lastOnly = false): void {
    const paths = this.context.globalState.get<string[]>('activeSessions', []);
    const toRestore = lastOnly ? paths.slice(-1) : paths;
    this._restoring = true;
    try {
      for (const p of toRestore) {
        if (fs.existsSync(p)) {
          this.createSession(p);
        }
      }
    } finally {
      this._restoring = false;
    }
    // Batch-add all workspace folders in a single call to avoid
    // updateWorkspaceFolders race conditions when called repeatedly.
    this.batchAddWorkspaceFolders();
    const restoredNames = new Set<string>();
    for (const s of this.sessions.values()) {
      s.status = 'done';
      restoredNames.add(s.projectName);
    }
    this._restoredSessions = restoredNames;
    setTimeout(() => { this._restoredSessions.clear(); }, 5000);
    const active = this.getActive();
    if (active) active.terminal.show();
    this.updateStatusBar();
    this._onChanged.fire();
  }

  sendToActive(text: string): string[] {
    const s = this.getActive();
    if (!s) return [];
    this.clearTimer(s.projectName);
    s.terminal.sendText(text);
    // Extra Enters to confirm paste mode in Claude CLI (long text / images)
    setTimeout(() => s.terminal.sendText(''), 300);
    setTimeout(() => s.terminal.sendText(''), 800);
    const key = `commandHistory:${s.projectPath}`;
    const history = this.context.globalState.get<string[]>(key, []);
    const updated = [text, ...history.filter(h => h !== text)].slice(0, 50);
    this.context.globalState.update(key, updated);
    return updated;
  }

  sendToSession(name: string, text: string): string[] {
    const s = this.sessions.get(name);
    if (!s) return [];
    this.clearTimer(name);
    s.terminal.sendText(text);
    // Extra Enters to confirm paste mode in Claude CLI (long text / images)
    setTimeout(() => s.terminal.sendText(''), 300);
    setTimeout(() => s.terminal.sendText(''), 800);
    const key = `commandHistory:${s.projectPath}`;
    const history = this.context.globalState.get<string[]>(key, []);
    const updated = [text, ...history.filter(h => h !== text)].slice(0, 50);
    this.context.globalState.update(key, updated);
    return updated;
  }

  getHistory(projectPath?: string): string[] {
    const p = projectPath || this.getActive()?.projectPath;
    if (!p) return [];
    return this.context.globalState.get<string[]>(`commandHistory:${p}`, []);
  }

  getAllHistory(): Array<{ text: string; projectName: string }> {
    const result: Array<{ text: string; projectName: string }> = [];
    for (const s of this.sessions.values()) {
      const items = this.context.globalState.get<string[]>(`commandHistory:${s.projectPath}`, []);
      for (const text of items) {
        result.push({ text, projectName: s.projectName });
      }
    }
    return result;
  }

  migrateHistory(): void {
    const old = this.context.globalState.get<string[]>('commandHistory');
    if (!old || old.length === 0) return;
    const active = this.getActive();
    if (!active) return;
    const key = `commandHistory:${active.projectPath}`;
    const existing = this.context.globalState.get<string[]>(key, []);
    if (existing.length === 0) {
      this.context.globalState.update(key, old);
    }
    this.context.globalState.update('commandHistory', undefined);
  }

  private updateStatusBar(): void {
    const s = this.getActive();
    if (!s) {
      this.statusBar.hide();
      return;
    }
    const branch = getGitBranch(s.projectPath);
    if (branch) {
      this.statusBar.text = `$(git-branch) ${s.projectName}: ${branch}`;
      this.statusBar.tooltip = `Session: ${s.projectName} | Branche: ${branch}`;
    } else {
      this.statusBar.text = `$(terminal) ${s.projectName}`;
      this.statusBar.tooltip = `Session: ${s.projectName}`;
    }
    this.statusBar.show();
  }

  private saveState(): void {
    const paths = [...this.sessions.values()].map(s => s.projectPath);
    this.context.globalState.update('activeSessions', paths);
  }

  private saveCurrentFiles(): void {
    if (this._restoreInProgress) return;
    if (!this._active) return;
    const s = this.sessions.get(this._active);
    if (!s) return;
    s.openFiles = vscode.window.tabGroups.all
      .flatMap(g => g.tabs)
      .filter(t => t.input instanceof vscode.TabInputText)
      .map(t => (t.input as vscode.TabInputText).uri.fsPath)
      .filter(f => f.startsWith(s.projectPath));
  }

  private async restoreFiles(session: ClaudeSession): Promise<void> {
    const gen = ++this._restoreGeneration;
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const f of session.openFiles) {
      if (this._restoreGeneration !== gen) return;
      try {
        await vscode.commands.executeCommand(
          'vscode.open',
          vscode.Uri.file(f),
          { preview: false, preserveFocus: true },
        );
      } catch {
        /* file may have been deleted */
      }
    }
  }

  private addWorkspaceFolder(projectPath: string): void {
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.some(f => f.uri.fsPath === projectPath)) return;
    vscode.workspace.updateWorkspaceFolders(folders.length, 0, {
      uri: vscode.Uri.file(projectPath),
    });
    this.trackAddedFolder(projectPath);
  }

  private batchAddWorkspaceFolders(): void {
    const existing = vscode.workspace.workspaceFolders || [];
    const existingPaths = new Set(existing.map(f => f.uri.fsPath));
    const toAdd: { uri: vscode.Uri }[] = [];
    for (const s of this.sessions.values()) {
      if (!existingPaths.has(s.projectPath)) {
        toAdd.push({ uri: vscode.Uri.file(s.projectPath) });
        this.trackAddedFolder(s.projectPath);
      }
    }
    if (toAdd.length > 0) {
      vscode.workspace.updateWorkspaceFolders(existing.length, 0, ...toAdd);
    }
  }

  private removeWorkspaceFolder(projectPath: string): void {
    const folders = vscode.workspace.workspaceFolders || [];
    const idx = folders.findIndex(f => f.uri.fsPath === projectPath);
    if (idx >= 0) {
      vscode.workspace.updateWorkspaceFolders(idx, 1);
    }
    this.untrackAddedFolder(projectPath);
  }

  private trackAddedFolder(p: string): void {
    const tracked = this.context.globalState.get<string[]>('addedWorkspaceFolders', []);
    if (!tracked.includes(p)) {
      this.context.globalState.update('addedWorkspaceFolders', [...tracked, p]);
    }
  }

  private untrackAddedFolder(p: string): void {
    const tracked = this.context.globalState.get<string[]>('addedWorkspaceFolders', []);
    this.context.globalState.update('addedWorkspaceFolders', tracked.filter(f => f !== p));
  }

  /** Remove workspace folders left over from a previous session (crash-safe) */
  cleanupLeftoverFolders(): void {
    const tracked = this.context.globalState.get<string[]>('addedWorkspaceFolders', []);
    if (tracked.length === 0) return;
    const folders = vscode.workspace.workspaceFolders || [];
    // Remove in reverse order to keep indices stable
    for (let i = folders.length - 1; i >= 0; i--) {
      if (tracked.includes(folders[i].uri.fsPath)) {
        vscode.workspace.updateWorkspaceFolders(i, 1);
      }
    }
    this.context.globalState.update('addedWorkspaceFolders', []);
  }

  /** Remove all workspace folders added by Claude Sessions (for deactivate) */
  removeAllWorkspaceFolders(): void {
    const tracked = this.context.globalState.get<string[]>('addedWorkspaceFolders', []);
    if (tracked.length === 0) return;
    const folders = vscode.workspace.workspaceFolders || [];
    for (let i = folders.length - 1; i >= 0; i--) {
      if (tracked.includes(folders[i].uri.fsPath)) {
        vscode.workspace.updateWorkspaceFolders(i, 1);
      }
    }
    this.context.globalState.update('addedWorkspaceFolders', []);
  }

  // --- Session Groups (Espaces) ---

  getGroups(): SessionGroup[] {
    return this.context.globalState.get<SessionGroup[]>('sessionGroups', []);
  }

  private saveGroups(groups: SessionGroup[]): void {
    this.context.globalState.update('sessionGroups', groups);
  }

  createGroup(name: string, paths?: string[]): SessionGroup {
    const groups = this.getGroups();
    const group: SessionGroup = {
      id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`,
      name,
      paths: paths ?? [...this.sessions.values()].map(s => s.projectPath),
      createdAt: new Date().toISOString(),
    };
    groups.push(group);
    this.saveGroups(groups);
    this.activeGroupIds.add(group.id);
    this.focusedGroupId = group.id;
    this.persistGroupState();
    return group;
  }

  createEmptyGroup(name: string): SessionGroup {
    const groups = this.getGroups();
    const group: SessionGroup = {
      id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`,
      name,
      paths: [],
      createdAt: new Date().toISOString(),
    };
    groups.push(group);
    this.saveGroups(groups);
    return group;
  }

  updateGroupPaths(id: string, paths: string[]): void {
    const groups = this.getGroups();
    const group = groups.find(g => g.id === id);
    if (!group) return;
    group.paths = paths;
    this.saveGroups(groups);
  }

  deleteGroup(id: string): void {
    this.saveGroups(this.getGroups().filter(g => g.id !== id));
    this.activeGroupIds.delete(id);
    if (this.focusedGroupId === id) {
      this.focusedGroupId = this.activeGroupIds.size > 0
        ? [...this.activeGroupIds][0]
        : undefined;
    }
    this.persistGroupState();
  }

  renameGroup(id: string, newName: string): void {
    const groups = this.getGroups();
    const group = groups.find(g => g.id === id);
    if (group) {
      group.name = newName;
      this.saveGroups(groups);
    }
  }

  async restoreGroup(id: string, options?: { preCommand?: string }): Promise<void> {
    const group = this.getGroups().find(g => g.id === id);
    if (!group) return;
    const toCreate = group.paths.filter(p => fs.existsSync(p) && !this.hasPath(p));

    if (toCreate.length === 0) {
      // All sessions already active (from another espace) — don't activate this espace
      vscode.window.showInformationMessage('Toutes les sessions du groupe sont deja actives');
      this.fireChanged();
      return;
    }

    // Only activate/focus when actually launching sessions
    this.activeGroupIds.add(id);
    this.focusedGroupId = id;
    this.persistGroupState();
    this._restoring = true;
    try {
      for (const p of toCreate) await this.createSession(p, options);
    } finally {
      this._restoring = false;
    }
    // Only reset status for newly created sessions, track them for cooldown
    const restoredNames = new Set<string>();
    for (const s of this.sessions.values()) {
      if (toCreate.includes(s.projectPath)) {
        s.status = 'done';
        restoredNames.add(s.projectName);
      }
    }
    this._restoredSessions = restoredNames;
    setTimeout(() => { this._restoredSessions.clear(); }, 5000);
    const active = this.getActive();
    if (active) active.terminal.show();
    this.updateStatusBar();
    this._onChanged.fire();
  }

  async focusOrRestoreGroup(id: string, options?: { preCommand?: string }): Promise<boolean> {
    const group = this.getGroups().find(g => g.id === id);
    if (!group) return false;
    const hasActive = group.paths.some(p => this.hasPath(p));
    if (!hasActive) {
      await this.restoreGroup(id, options);
      return true;
    }
    this.focusGroup(id);
    return false;
  }

  stopGroup(id: string): void {
    const group = this.getGroups().find(g => g.id === id);
    if (!group) return;
    // Collect paths claimed by OTHER active espaces — don't kill shared sessions
    const otherPaths = new Set<string>();
    for (const gid of this.activeGroupIds) {
      if (gid === id) continue;
      const og = this.getGroups().find(g => g.id === gid);
      if (og) og.paths.forEach(p => otherPaths.add(p));
    }
    const toStop: string[] = [];
    for (const s of this.sessions.values()) {
      if (group.paths.includes(s.projectPath) && !otherPaths.has(s.projectPath)) {
        toStop.push(s.projectName);
      }
    }
    for (const name of toStop) this.stopSession(name);
    this.activeGroupIds.delete(id);
    if (this.focusedGroupId === id) {
      this.focusedGroupId = this.activeGroupIds.size > 0
        ? [...this.activeGroupIds][0]
        : undefined;
    }
    this.persistGroupState();
  }

  persistGroupState(): void {
    this.context.globalState.update('activeGroupIds', [...this.activeGroupIds]);
    this.context.globalState.update('focusedGroupId', this.focusedGroupId);
  }

  focusGroup(id: string): void {
    // Only set focus — don't add to activeGroupIds.
    // An espace becomes "active" only via restoreGroup() when sessions are actually launched.
    this.focusedGroupId = id;
    this.persistGroupState();
    this.fireChanged();
  }

  getGroupStatus(id: string): { working: number; unread: number; total: number; lastActivity: Date | undefined } {
    const group = this.getGroups().find(g => g.id === id);
    if (!group) return { working: 0, unread: 0, total: 0, lastActivity: undefined };
    let working = 0, unread = 0, total = 0;
    let lastActivity: Date | undefined;
    for (const s of this.sessions.values()) {
      if (group.paths.includes(s.projectPath)) {
        total++;
        if (s.status === 'working') working++;
        if (s.unread) unread++;
        if (!lastActivity || s.lastActivity > lastActivity) lastActivity = s.lastActivity;
      }
    }
    return { working, unread, total, lastActivity };
  }

  getFilteredGroups(): SessionGroup[] {
    let groups = this.getGroups();
    if (this.espaceFilter === 'active') {
      groups = groups.filter(g => this.activeGroupIds.has(g.id));
    }
    return this.sortGroups(groups);
  }

  private sortGroups(groups: SessionGroup[]): SessionGroup[] {
    if (this.espaceSortMode === 'fixed' && this._espaceOrder.length > 0) {
      const ordered: SessionGroup[] = [];
      for (const id of this._espaceOrder) {
        const g = groups.find(grp => grp.id === id);
        if (g) ordered.push(g);
      }
      for (const g of groups) {
        if (!this._espaceOrder.includes(g.id)) ordered.push(g);
      }
      return ordered;
    }
    const copy = [...groups];
    switch (this.espaceSortMode) {
      case 'name-asc': return copy.sort((a, b) => a.name.localeCompare(b.name));
      case 'name-desc': return copy.sort((a, b) => b.name.localeCompare(a.name));
      case 'created-desc': return copy.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      case 'created-asc': return copy.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      case 'recent-desc':
      case 'recent-asc': {
        const dir = this.espaceSortMode === 'recent-asc' ? -1 : 1;
        return copy.sort((a, b) => {
          const tA = this.getGroupStatus(a.id).lastActivity?.getTime() || new Date(a.createdAt).getTime();
          const tB = this.getGroupStatus(b.id).lastActivity?.getTime() || new Date(b.createdAt).getTime();
          return dir * (tB - tA);
        });
      }
      default: return copy;
    }
  }

  filteredByScope(): ClaudeSession[] {
    const sessions = this.filtered();
    if (this.sessionScopeFilter === 'all') return sessions;

    if (this.sessionScopeFilter === 'espaceFocus') {
      if (!this.focusedGroupId) return sessions;
      const group = this.getGroups().find(g => g.id === this.focusedGroupId);
      if (!group) return sessions;
      return sessions.filter(s => group.paths.includes(s.projectPath));
    }

    // 'espaceActive'
    const activePaths = new Set<string>();
    for (const gid of this.activeGroupIds) {
      const group = this.getGroups().find(g => g.id === gid);
      if (group) group.paths.forEach(p => activePaths.add(p));
    }
    return activePaths.size > 0 ? sessions.filter(s => activePaths.has(s.projectPath)) : sessions;
  }

  async showEspaceSortPicker(): Promise<void> {
    const labels: Record<EspaceSortMode, string> = {
      'name-asc': 'Nom (A-Z)',
      'name-desc': 'Nom (Z-A)',
      'recent-desc': 'Plus recent en premier',
      'recent-asc': 'Plus ancien en premier',
      'created-desc': 'Date creation (recent)',
      'created-asc': 'Date creation (ancien)',
      'fixed': 'Ordre fige',
    };
    const items = (['recent-desc', 'recent-asc', 'name-asc', 'name-desc', 'created-desc', 'created-asc', 'fixed'] as EspaceSortMode[]).map(m => ({
      label: m === this.espaceSortMode ? `$(check) ${labels[m]}` : `     ${labels[m]}`,
      value: m,
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Trier les espaces' });
    if (!picked) return;
    if (picked.value === 'fixed' && this.espaceSortMode !== 'fixed') {
      this._espaceOrder = this.getFilteredGroups().map(g => g.id);
    }
    this.espaceSortMode = picked.value as EspaceSortMode;
    this.persistSetting('espaceSortMode', this.espaceSortMode);
    if (picked.value !== 'fixed') this._espaceOrder = [];
    this.persistSetting('espaceOrder', this._espaceOrder);
    this.fireChanged();
  }

  async getTmateInfo(sessionName?: string): Promise<string | undefined> {
    // Use the session's known socket path
    const s = sessionName ? this.sessions.get(sessionName) : this.getActive();
    if (!s?.tmateSocketPath) return undefined;
    return new Promise<string | undefined>(resolve => {
      exec(
        `tmate -S "${s.tmateSocketPath}" display -p '#{tmate_ssh}' 2>/dev/null`,
        { timeout: 3000 },
        (_err, stdout) => {
          resolve(stdout?.trim() && !stdout.includes('error') && !stdout.includes('no server') ? stdout.trim() : undefined);
        },
      );
    });
  }

  async searchEspace(): Promise<SessionGroup | undefined> {
    const groups = this.getGroups();
    if (groups.length === 0) {
      vscode.window.showInformationMessage('Aucun espace sauvegarde');
      return;
    }
    const items = groups.map(g => {
      const status = this.getGroupStatus(g.id);
      const isFocused = g.id === this.focusedGroupId;
      const isActive = this.activeGroupIds.has(g.id);
      return {
        label: isFocused ? `$(target) ${g.name}` : (isActive ? `$(folder-opened) ${g.name}` : g.name),
        description: status.total > 0 ? `${status.total} actif(s)` : `${g.paths.length} projet(s)`,
        detail: g.paths.map(p => path.basename(p)).join(', '),
        id: g.id,
      };
    });
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Rechercher un espace...' });
    if (!picked) return;
    return groups.find(g => g.id === picked.id);
  }

  async addSessionToGroup(projectPath: string): Promise<void> {
    const groups = this.getGroups();
    if (groups.length === 0) {
      vscode.window.showInformationMessage('Aucun espace. Creez-en un d\'abord.');
      return;
    }
    const items = groups.map(g => ({
      label: g.id === this.focusedGroupId ? `$(target) ${g.name}` : g.name,
      description: `${g.paths.length} projet(s)`,
      id: g.id,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Ajouter à quel espace ?',
    });
    if (!picked) return;
    const group = groups.find(g => g.id === (picked as any).id);
    if (!group) return;
    if (!group.paths.includes(projectPath)) {
      group.paths.push(projectPath);
      this.saveGroups(groups);
    }
    this.fireChanged();
    vscode.window.setStatusBarMessage(`Ajouté à "${group.name}"`, 2000);
  }

  removeFromGroup(groupId: string, projectPath: string): void {
    const groups = this.getGroups();
    const group = groups.find(g => g.id === groupId);
    if (!group) return;
    group.paths = group.paths.filter(p => p !== projectPath);
    this.saveGroups(groups);
    this.fireChanged();
  }

  reorderEspace(fromId: string, toId: string): void {
    if (this.espaceSortMode !== 'fixed') return;
    if (this._espaceOrder.length === 0) {
      this._espaceOrder = this.getFilteredGroups().map(g => g.id);
    }
    const fromIdx = this._espaceOrder.indexOf(fromId);
    const toIdx = this._espaceOrder.indexOf(toId);
    if (fromIdx < 0 || toIdx < 0) return;
    this._espaceOrder.splice(fromIdx, 1);
    this._espaceOrder.splice(toIdx, 0, fromId);
    this.persistSetting('espaceOrder', this._espaceOrder);
    this.fireChanged();
  }

  getSessionEspaces(projectPath: string): string[] {
    return this.getGroups()
      .filter(g => g.paths.includes(projectPath) && this.activeGroupIds.has(g.id))
      .map(g => g.name);
  }

  private clearTimer(name: string): void {
    const t = this.timers.get(name);
    if (t) clearTimeout(t);
    this.timers.delete(name);
  }

  /** Return the most recent session ID for a project, or undefined if none. */
  private getRecentSessionId(projectPath: string): string | undefined {
    const encoded = projectPath.replace(/\//g, '-');
    const dir = path.join(os.homedir(), '.claude', 'projects', encoded);
    try {
      if (!fs.existsSync(dir)) return undefined;
      // Try sessions-index.json first (has sorted entries with timestamps)
      const indexPath = path.join(dir, 'sessions-index.json');
      if (fs.existsSync(indexPath)) {
        const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        if (data.entries && data.entries.length > 0) {
          // Sort by modified date descending, pick most recent
          const sorted = [...data.entries].sort(
            (a: any, b: any) => (b.fileMtime || 0) - (a.fileMtime || 0),
          );
          return sorted[0].sessionId;
        }
      }
      // Fallback: find most recent .jsonl file by mtime
      const jsonlFiles = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
      if (jsonlFiles.length === 0) return undefined;
      let best: { name: string; mtime: number } | undefined;
      for (const f of jsonlFiles) {
        const stat = fs.statSync(path.join(dir, f));
        if (!best || stat.mtimeMs > best.mtime) {
          best = { name: f, mtime: stat.mtimeMs };
        }
      }
      return best ? best.name.replace('.jsonl', '') : undefined;
    } catch {
      return undefined;
    }
  }
}
