import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { exec, execSync } from 'child_process';
import { FilterMode, NotifyMode, SessionFilter, EspaceFilter, SessionScopeFilter, Snippet } from './types';
import { getProjectsRoot, formatTimeAgo } from './helpers';
import { SessionManager } from './session-manager';
import { ProjectFolder, SessionItem, GroupItem, GroupSessionItem, getItemPath, ProjectTreeItem } from './tree-items';
import { ProjectsProvider, SessionsProvider, SettingsProvider, EspacesProvider } from './tree-providers';
import { ProjectDragController, SessionDragController, EspaceDragController } from './drag-controllers';
import { GitDecorationProvider } from './git-decoration';
import { setupClaudeWatcher } from './claude-watcher';
import { InputViewProvider } from './input-view';

// --- Activation ---

export async function activate(context: vscode.ExtensionContext) {
  const mgr = new SessionManager(context);
  _mgr = mgr;
  const projectsProvider = new ProjectsProvider(mgr);
  const sessionsProvider = new SessionsProvider(mgr);
  const gitDecProvider = new GitDecorationProvider();
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(gitDecProvider));

  const inputProvider = new InputViewProvider(mgr);
  const settingsProvider = new SettingsProvider(mgr);
  vscode.window.createTreeView('claudeSessions.settings', { treeDataProvider: settingsProvider });
  const espacesProvider = new EspacesProvider(mgr);
  const espacesTree = vscode.window.createTreeView('claudeSessions.espaces', {
    treeDataProvider: espacesProvider,
    dragAndDropController: new EspaceDragController(mgr),
  });
  let clipboard: { paths: string[]; cut: boolean } | undefined;

  projectsProvider.filterMode = mgr.filterMode;
  await vscode.commands.executeCommand(
    'setContext',
    'claudeSessions.filterMode',
    mgr.filterMode,
  );
  await vscode.commands.executeCommand(
    'setContext',
    'claudeSessions.globalNotifyMode',
    mgr.globalNotifyMode,
  );
  await vscode.commands.executeCommand(
    'setContext',
    'claudeSessions.sessionFilter',
    mgr.sessionFilter,
  );
  await vscode.commands.executeCommand(
    'setContext',
    'claudeSessions.tmateEnabled',
    mgr.tmateEnabled,
  );
  await vscode.commands.executeCommand('setContext', 'claudeSessions.espaceFilter', mgr.espaceFilter);
  await vscode.commands.executeCommand('setContext', 'claudeSessions.sessionScopeFilter', mgr.sessionScopeFilter);

  const projectsTree = vscode.window.createTreeView('claudeSessions.projects', {
    treeDataProvider: projectsProvider,
    dragAndDropController: new ProjectDragController(projectsProvider),
  });

  projectsTree.onDidExpandElement(e => {
    if (e.element instanceof ProjectFolder) projectsProvider.trackExpand(e.element);
  });
  projectsTree.onDidCollapseElement(e => {
    if (e.element instanceof ProjectFolder) projectsProvider.trackCollapse(e.element);
  });

  const sessionsTree = vscode.window.createTreeView('claudeSessions.active', {
    treeDataProvider: sessionsProvider,
    dragAndDropController: new SessionDragController(mgr),
  });
  const webviewRegistration = vscode.window.registerWebviewViewProvider(
    InputViewProvider.viewType,
    inputProvider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );

  context.subscriptions.push(
    projectsTree, sessionsTree, espacesTree, webviewRegistration, mgr, inputProvider,
  );

  let revealTimer: ReturnType<typeof setTimeout> | undefined;
  let lastRevealedPath: string | undefined;
  context.subscriptions.push(mgr.onChanged(() => {
    projectsProvider.refresh();
    sessionsProvider.refresh();
    espacesProvider.refresh();

    // Auto-switch to 'all' when no sessions remain
    if (mgr.all().length === 0 && projectsProvider.filterMode !== 'all') {
      projectsProvider.filterMode = 'all';
      mgr.filterMode = 'all';
      mgr.persistSetting('filterMode', 'all');
      vscode.commands.executeCommand('setContext', 'claudeSessions.filterMode', 'all');
    }

    const activePath = mgr.activeProjectPath;
    if (activePath) {
      gitDecProvider.refresh(activePath);
      // Only reveal when active project actually changed — prevents stealing focus
      if (activePath !== lastRevealedPath) {
        lastRevealedPath = activePath;
        if (revealTimer) clearTimeout(revealTimer);
        revealTimer = setTimeout(() => {
          revealTimer = undefined;
          // Only reveal if our sidebar is visible
          if (projectsTree.visible) {
            const folder = new ProjectFolder(activePath, true, true);
            projectsTree
              .reveal(folder, { select: true, focus: false })
              .then(undefined, () => {});
          }
        }, 300);
      }
    }
  }));

  setupClaudeWatcher(context, mgr);
  mgr.cleanupDeadTerminals();
  mgr.migrateHistory();
  mgr.migrateSnippets();

  // Close leftover editors when scopeEditors is enabled and no session is running
  if (mgr.scopeEditors && mgr.all().length === 0) {
    vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }

  // Apply fullView on activation if sessions are active
  if (mgr.fullView && mgr.all().length > 0) {
    setTimeout(() => mgr.ensurePanelMaximized(), 500);
  }

  // Refresh projects when projectsRoot changes via VS Code settings
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudeSessions.projectsRoot')) {
        projectsProvider.refresh();
        settingsProvider.refresh();
      }
    }),
  );

  // --- Helpers: pre-command & init message popups ---
  async function showPreCommandPicker(): Promise<string | undefined> {
    if (!mgr.preCommandEnabled) return undefined;
    const snippets: Snippet[] = mgr.context.globalState.get('snippets', []);
    const commands = snippets.filter(s => s.type === 'command');
    if (commands.length === 0) return undefined;
    const answer = await vscode.window.showInformationMessage(
      'Injecter une commande avant Claude ?', 'Oui', 'Non');
    if (answer !== 'Oui') return undefined;
    const items = commands.map(c => ({
      label: c.name,
      description: c.tags.map((t: string) => `#${t}`).join(' '),
      detail: c.command.length > 80 ? c.command.substring(0, 80) + '...' : c.command,
      text: c.command,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Commande a injecter...',
      matchOnDetail: true,
    });
    return (picked as any)?.text;
  }

  async function showInitMessagePicker(): Promise<void> {
    if (!mgr.initMessageEnabled) return;
    const snippets: Snippet[] = mgr.context.globalState.get('snippets', []);
    if (snippets.length === 0) return;
    await new Promise(r => setTimeout(r, 10000));
    const items = snippets.map(s => ({
      label: s.type === 'command' ? `$(terminal) ${s.name}` : `$(comment) ${s.name}`,
      description: s.tags.map((t: string) => `#${t}`).join(' '),
      detail: s.command.length > 80 ? s.command.substring(0, 80) + '...' : s.command,
      text: s.command,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Message ou commande initial(e) pour Claude...',
      matchOnDetail: true,
      matchOnDescription: true,
    });
    if (picked) {
      mgr.sendToActive((picked as any).text);
    }
  }

  context.subscriptions.push(
    // Play button -> launch Claude (from project item or from toolbar)
    vscode.commands.registerCommand(
      'claudeSessions.newSession',
      async (item?: ProjectFolder) => {
        let projectPath: string | undefined;
        if (item instanceof ProjectFolder) {
          projectPath = item.folderPath;
        } else {
          // From toolbar — show QuickPick
          const choice = await vscode.window.showQuickPick([
            { label: '$(folder-opened) Projet existant', value: 'existing' },
            { label: '$(new-folder) Nouveau projet', value: 'new' },
          ], { placeHolder: 'Demarrer une session Claude' });
          if (!choice) return;
          if (choice.value === 'new') {
            const root = getProjectsRoot();
            const name = await vscode.window.showInputBox({
              prompt: 'Nom du nouveau projet',
              placeHolder: 'mon-nouveau-projet',
            });
            if (!name) return;
            projectPath = path.join(root, name);
            if (!fs.existsSync(projectPath)) {
              fs.mkdirSync(projectPath, { recursive: true });
            }
            projectsProvider.refresh();
          } else {
            pickProject(mgr);
            return;
          }
        }
        if (!projectPath) return;
        const preCommand = await showPreCommandPicker();
        const result = await mgr.createSession(projectPath, { preCommand });
        projectsProvider.refresh();
        sessionsProvider.refresh();
        if (result.isNew) {
          showInitMessagePicker(); // fire & forget
        }
      },
    ),

    // Search projects
    vscode.commands.registerCommand('claudeSessions.searchProject', () => {
      pickProject(mgr);
    }),

    // Search sessions
    vscode.commands.registerCommand('claudeSessions.searchSession', () => {
      const sessions = mgr.all();
      if (sessions.length === 0) {
        vscode.window.showInformationMessage('Aucune session active');
        return;
      }
      const items = sessions.map(s => ({
        label:
          s.projectName === mgr.activeProject
            ? `$(sparkle) ${s.projectName}`
            : s.projectName,
        description: `${s.status} · ${formatTimeAgo(s.lastActivity)}`,
        name: s.projectName,
      }));
      vscode.window
        .showQuickPick(items, { placeHolder: 'Rechercher une session...' })
        .then(picked => {
          if (picked) mgr.switchTo(picked.name).catch(() => {});
        });
    }),

    // + button -> add or create project
    vscode.commands.registerCommand('claudeSessions.addProject', async () => {
      const choice = await vscode.window.showQuickPick([
        { label: '$(folder-opened) Ajouter un projet existant', value: 'add' },
        { label: '$(new-folder) Nouveau projet', value: 'new' },
      ], { placeHolder: 'Que voulez-vous faire ?' });
      if (!choice) return;

      const root = getProjectsRoot();

      if (choice.value === 'new') {
        const name = await vscode.window.showInputBox({
          prompt: 'Nom du nouveau projet',
          placeHolder: 'mon-nouveau-projet',
        });
        if (!name) return;
        const projectPath = path.join(root, name);
        if (fs.existsSync(projectPath)) {
          vscode.window.showWarningMessage(`Le dossier "${name}" existe deja`);
        } else {
          fs.mkdirSync(projectPath, { recursive: true });
        }
        projectsProvider.refresh();
        // Launch Claude in the new project
        await mgr.createSession(projectPath);
      } else {
        const uris = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Ajouter comme projet',
          defaultUri: vscode.Uri.file(root),
        });
        if (!uris || uris.length === 0) return;

        const folderPath = uris[0].fsPath;
        const folderName = path.basename(folderPath);
        const target = path.join(root, folderName);

        if (folderPath !== target && !fs.existsSync(target)) {
          try {
            fs.symlinkSync(folderPath, target);
          } catch {
            vscode.window.showErrorMessage(
              `Impossible de creer le lien vers ${folderPath}`,
            );
            return;
          }
        }
        projectsProvider.refresh();
        // Launch Claude in the added project
        const actualPath = fs.existsSync(target) ? fs.realpathSync(target) : folderPath;
        await mgr.createSession(actualPath);
      }
    }),

    // Click session -> switch
    vscode.commands.registerCommand(
      'claudeSessions.switchSession',
      (item: SessionItem) => {
        if (!item?.session) return;
        mgr.switchTo(item.session.projectName).catch(() => {});
      },
    ),

    // Close session
    vscode.commands.registerCommand(
      'claudeSessions.stopSession',
      (item: SessionItem) => {
        if (!item?.session) return;
        mgr.stopSession(item.session.projectName);
      },
    ),

    // Refresh
    vscode.commands.registerCommand('claudeSessions.refreshProjects', () => {
      projectsProvider.refresh();
    }),

    // Filter cycle: all -> active -> focused -> all
    ...['filterAll', 'filterActive', 'filterFocused'].map(cmd =>
      vscode.commands.registerCommand(`claudeSessions.${cmd}`, async () => {
        const modes: FilterMode[] = ['all', 'active', 'focused'];
        const idx = modes.indexOf(projectsProvider.filterMode);
        projectsProvider.filterMode = modes[(idx + 1) % modes.length];
        mgr.filterMode = projectsProvider.filterMode;
        mgr.persistSetting('filterMode', projectsProvider.filterMode);
        const labels = {
          all: 'Tous les projets',
          active: 'Sessions actives',
          focused: 'Projet en cours',
        };
        vscode.window.setStatusBarMessage(
          labels[projectsProvider.filterMode],
          2000,
        );
        await vscode.commands.executeCommand(
          'setContext',
          'claudeSessions.filterMode',
          projectsProvider.filterMode,
        );
        projectsProvider.refresh();
      }),
    ),

    // Full view toggle
    vscode.commands.registerCommand(
      'claudeSessions.toggleFullView',
      async () => {
        mgr.fullView = !mgr.fullView;
        mgr.persistSetting('fullView', mgr.fullView);
        if (mgr.fullView) {
          mgr.ensurePanelMaximized();
        } else {
          mgr.ensurePanelRestored();
          await mgr.restoreActiveFiles();
        }
      },
    ),

    // --- Sort picker ---
    vscode.commands.registerCommand('claudeSessions.toggleSort', () => {
      mgr.showSortPicker();
    }),

    // --- Session status filter (cycle: all → working → unread → read → all) ---
    ...['filterSessionAll', 'filterSessionWorking', 'filterSessionUnread', 'filterSessionRead'].map(cmd =>
      vscode.commands.registerCommand(`claudeSessions.${cmd}`, async () => {
        const modes: SessionFilter[] = ['all', 'working', 'unread', 'read'];
        const idx = modes.indexOf(mgr.sessionFilter);
        mgr.sessionFilter = modes[(idx + 1) % modes.length];
        mgr.persistSetting('sessionFilter', mgr.sessionFilter);
        const labels: Record<SessionFilter, string> = {
          all: 'Toutes les sessions',
          working: 'En cours uniquement',
          unread: 'Non lus uniquement',
          read: 'Lus uniquement',
        };
        await vscode.commands.executeCommand('setContext', 'claudeSessions.sessionFilter', mgr.sessionFilter);
        vscode.window.setStatusBarMessage(labels[mgr.sessionFilter], 2000);
        sessionsProvider.refresh();
      }),
    ),

    // --- Global notification mode cycle (4 states, applies to all sessions) ---
    ...['globalNotifMuted', 'globalNotifNotify', 'globalNotifSound', 'globalNotifNotifySound'].map(cmd =>
      vscode.commands.registerCommand(`claudeSessions.${cmd}`, async () => {
        const modes: NotifyMode[] = ['muted', 'notify', 'sound', 'notifySound'];
        const idx = modes.indexOf(mgr.globalNotifyMode);
        mgr.globalNotifyMode = modes[(idx + 1) % modes.length];
        mgr.persistSetting('globalNotifyMode', mgr.globalNotifyMode);
        // Apply to all existing sessions
        for (const s of mgr.all()) {
          s.notifyMode = mgr.globalNotifyMode;
        }
        await vscode.commands.executeCommand('setContext', 'claudeSessions.globalNotifyMode', mgr.globalNotifyMode);
        const labels: Record<NotifyMode, string> = {
          muted: 'Toutes les sessions: Muet',
          notify: 'Toutes les sessions: Notif popup',
          sound: 'Toutes les sessions: Son',
          notifySound: 'Toutes les sessions: Notif + son',
        };
        vscode.window.setStatusBarMessage(labels[mgr.globalNotifyMode], 2000);
        sessionsProvider.refresh();
      }),
    ),

    // --- Per-session notify cycle (generic + mode-specific inline variants) ---
    ...['cycleNotify', 'cycleNotifyMuted', 'cycleNotifyNotify', 'cycleNotifySound', 'cycleNotifyNotifySound'].map(cmd =>
      vscode.commands.registerCommand(`claudeSessions.${cmd}`, (item: SessionItem) => {
        if (!item?.session) return;
        mgr.cycleNotifyMode(item.session.projectName);
      }),
    ),

    // --- Test notification sound ---
    vscode.commands.registerCommand('claudeSessions.testSound', () => {
      mgr.playNotificationSound(true);
      vscode.window.showInformationMessage('Son de notification joue');
    }),

    // --- Configure notification sound ---
    vscode.commands.registerCommand('claudeSessions.configureSound', async () => {
      const wavFiles = [
        { label: 'Windows Exclamation (defaut)', value: 'auto' },
        { label: 'Chimes', value: `(New-Object Media.SoundPlayer 'C:/Windows/Media/chimes.wav').PlaySync()` },
        { label: 'Notify', value: `(New-Object Media.SoundPlayer 'C:/Windows/Media/notify.wav').PlaySync()` },
        { label: 'Tada', value: `(New-Object Media.SoundPlayer 'C:/Windows/Media/tada.wav').PlaySync()` },
        { label: 'Ding', value: `(New-Object Media.SoundPlayer 'C:/Windows/Media/ding.wav').PlaySync()` },
        { label: 'Alarm (ringout)', value: `(New-Object Media.SoundPlayer 'C:/Windows/Media/ringout.wav').PlaySync()` },
        { label: 'Desactiver le son', value: 'off' },
        { label: 'Commande personnalisee...', value: 'custom' },
      ];
      const picked = await vscode.window.showQuickPick(wavFiles, {
        placeHolder: 'Choisir le son de notification',
      });
      if (!picked) return;
      const config = vscode.workspace.getConfiguration('claudeSessions');
      if (picked.value === 'auto') {
        await config.update('notificationSound', 'auto', vscode.ConfigurationTarget.Global);
        await config.update('notificationSoundCommand', '', vscode.ConfigurationTarget.Global);
      } else if (picked.value === 'off') {
        await config.update('notificationSound', 'off', vscode.ConfigurationTarget.Global);
      } else if (picked.value === 'custom') {
        const cmd = await vscode.window.showInputBox({
          prompt: 'Commande shell pour jouer un son',
          placeHolder: 'paplay /chemin/vers/son.oga',
          value: config.get<string>('notificationSoundCommand', ''),
        });
        if (cmd !== undefined) {
          await config.update('notificationSound', 'custom', vscode.ConfigurationTarget.Global);
          await config.update('notificationSoundCommand', cmd, vscode.ConfigurationTarget.Global);
        }
      } else {
        // PowerShell WAV command
        const fullCmd = `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command "${picked.value}"`;
        await config.update('notificationSound', 'custom', vscode.ConfigurationTarget.Global);
        await config.update('notificationSoundCommand', fullCmd, vscode.ConfigurationTarget.Global);
        // Test the sound
        exec(fullCmd, { timeout: 10000 }).on('error', () => {});
      }
      vscode.window.showInformationMessage('Son de notification configure');
      settingsProvider.refresh();
    }),

    // --- Settings panel commands ---
    vscode.commands.registerCommand('claudeSessions.setting.sound', () => {
      vscode.commands.executeCommand('claudeSessions.configureSound');
    }),
    vscode.commands.registerCommand('claudeSessions.setting.volume', async () => {
      const levels = [
        { label: 'Faible (0.3)', value: 0.3 },
        { label: 'Moyen (0.5)', value: 0.5 },
        { label: 'Normal (1.0)', value: 1.0 },
        { label: 'Fort (1.5)', value: 1.5 },
        { label: 'Tres fort (2.0)', value: 2.0 },
        { label: 'Maximum (3.0)', value: 3.0 },
      ];
      const current = vscode.workspace.getConfiguration('claudeSessions').get<number>('notificationVolume', 1.0);
      const items = levels.map(l => ({
        label: l.value === current ? `$(check) ${l.label}` : `     ${l.label}`,
        value: l.value,
      }));
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Volume de notification' });
      if (!picked) return;
      await vscode.workspace.getConfiguration('claudeSessions').update('notificationVolume', (picked as any).value, vscode.ConfigurationTarget.Global);
      settingsProvider.refresh();
      mgr.playNotificationSound(true); // test the volume
    }),
    vscode.commands.registerCommand('claudeSessions.setting.resume', () => {
      mgr.resumeConversation = !mgr.resumeConversation;
      mgr.persistSetting('resumeConversation', mgr.resumeConversation);
      settingsProvider.refresh();
      vscode.window.setStatusBarMessage(`Reprise auto: ${mgr.resumeConversation ? 'Oui (claude -r)' : 'Non (nouveau)'}`, 2000);
    }),
    vscode.commands.registerCommand('claudeSessions.setting.effort', async () => {
      const levels = ['auto', 'low', 'medium', 'high', 'max'] as const;
      const labels: Record<string, string> = { auto: 'Auto (par defaut)', low: 'Low', medium: 'Medium', high: 'High', max: 'Max (Opus uniquement)' };
      const current = vscode.workspace.getConfiguration('claudeSessions').get<string>('effortLevel', 'auto');
      const items = levels.map(l => ({ label: labels[l], value: l, description: l === current ? '(actuel)' : undefined }));
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Niveau d\'effort de raisonnement Claude' });
      if (!picked) return;
      await vscode.workspace.getConfiguration('claudeSessions').update('effortLevel', picked.value, true);
      settingsProvider.refresh();
      vscode.window.setStatusBarMessage(`Effort Claude: ${labels[picked.value]}`, 2000);
    }),
    vscode.commands.registerCommand('claudeSessions.setting.fullView', async () => {
      mgr.fullView = !mgr.fullView;
      mgr.persistSetting('fullView', mgr.fullView);
      if (mgr.fullView) {
        mgr.ensurePanelMaximized();
      } else {
        mgr.ensurePanelRestored();
        await mgr.restoreActiveFiles();
      }
      settingsProvider.refresh();
      vscode.window.setStatusBarMessage(`Plein ecran: ${mgr.fullView ? 'Oui' : 'Non'}`, 2000);
    }),
    vscode.commands.registerCommand('claudeSessions.setting.scopeEditors', () => {
      mgr.scopeEditors = !mgr.scopeEditors;
      mgr.persistSetting('scopeEditors', mgr.scopeEditors);
      settingsProvider.refresh();
      vscode.window.setStatusBarMessage(`Editeurs par session: ${mgr.scopeEditors ? 'Session active uniquement' : 'Garder tous'}`, 2000);
    }),
    vscode.commands.registerCommand('claudeSessions.setting.tmate', async () => {
      if (!mgr.tmateEnabled) {
        try {
          execSync('which tmate', { stdio: 'ignore' });
        } catch {
          const action = await vscode.window.showWarningMessage(
            'tmate n\'est pas installe. Installer maintenant ?',
            'Installer', 'Annuler',
          );
          if (action === 'Installer') {
            const term = vscode.window.createTerminal({ name: 'Install tmate' });
            term.sendText('sudo apt install tmate -y');
            term.show();
          }
          return;
        }
      }
      mgr.tmateEnabled = !mgr.tmateEnabled;
      mgr.persistSetting('tmateEnabled', mgr.tmateEnabled);
      await vscode.commands.executeCommand('setContext', 'claudeSessions.tmateEnabled', mgr.tmateEnabled);
      settingsProvider.refresh();
      vscode.window.setStatusBarMessage(`tmate: ${mgr.tmateEnabled ? 'Active' : 'Desactive'}`, 2000);
    }),

    vscode.commands.registerCommand('claudeSessions.setting.projectsRoot', async () => {
      const config = vscode.workspace.getConfiguration('claudeSessions');
      const current = config.get<string>('projectsRoot', '~/github');
      const uris = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Choisir le dossier racine',
        defaultUri: vscode.Uri.file(current.replace(/^~/, os.homedir())),
      });
      if (!uris || uris.length === 0) return;
      const newRoot = uris[0].fsPath.replace(os.homedir(), '~');
      await config.update('projectsRoot', newRoot, vscode.ConfigurationTarget.Global);
      settingsProvider.refresh();
      projectsProvider.refresh();
      vscode.window.setStatusBarMessage(`Dossier racine: ${newRoot}`, 2000);
    }),

    // --- Explorer context menu commands ---
    vscode.commands.registerCommand(
      'claudeSessions.newFile',
      async (item: ProjectFolder) => {
        const name = await vscode.window.showInputBox({
          prompt: 'Nom du fichier',
          placeHolder: 'fichier.ts',
        });
        if (!name) return;
        const filePath = path.join(item.folderPath, name);
        fs.writeFileSync(filePath, '');
        projectsProvider.refresh();
        await vscode.commands.executeCommand(
          'vscode.open',
          vscode.Uri.file(filePath),
        );
      },
    ),

    vscode.commands.registerCommand(
      'claudeSessions.newFolder',
      async (item: ProjectFolder) => {
        const name = await vscode.window.showInputBox({
          prompt: 'Nom du dossier',
          placeHolder: 'nouveau-dossier',
        });
        if (!name) return;
        fs.mkdirSync(path.join(item.folderPath, name), { recursive: true });
        projectsProvider.refresh();
      },
    ),

    vscode.commands.registerCommand(
      'claudeSessions.renameItem',
      async (item: ProjectTreeItem) => {
        const oldPath = getItemPath(item);
        const oldName = path.basename(oldPath);
        const name = await vscode.window.showInputBox({
          prompt: 'Nouveau nom',
          value: oldName,
        });
        if (!name || name === oldName) return;
        const newPath = path.join(path.dirname(oldPath), name);
        fs.renameSync(oldPath, newPath);
        projectsProvider.refresh();
      },
    ),

    vscode.commands.registerCommand(
      'claudeSessions.deleteItem',
      async (item: ProjectTreeItem) => {
        const itemPath = getItemPath(item);
        const name = path.basename(itemPath);
        const answer = await vscode.window.showWarningMessage(
          `Supprimer "${name}" ?`,
          { modal: true },
          'Supprimer',
        );
        if (answer !== 'Supprimer') return;
        fs.rmSync(itemPath, { recursive: true, force: true });
        projectsProvider.refresh();
      },
    ),

    vscode.commands.registerCommand(
      'claudeSessions.copyPath',
      (item: ProjectTreeItem) => {
        vscode.env.clipboard.writeText(getItemPath(item));
      },
    ),

    vscode.commands.registerCommand(
      'claudeSessions.copyRelativePath',
      (item: ProjectTreeItem) => {
        const fullPath = getItemPath(item);
        const root = getProjectsRoot();
        vscode.env.clipboard.writeText(path.relative(root, fullPath));
      },
    ),

    vscode.commands.registerCommand(
      'claudeSessions.revealInExplorer',
      (item: ProjectTreeItem) => {
        const uri = vscode.Uri.file(getItemPath(item));
        vscode.commands.executeCommand('revealInExplorer', uri);
      },
    ),

    vscode.commands.registerCommand(
      'claudeSessions.revealInOS',
      (item: ProjectTreeItem) => {
        const uri = vscode.Uri.file(getItemPath(item));
        vscode.commands.executeCommand('revealFileInOS', uri);
      },
    ),

    vscode.commands.registerCommand(
      'claudeSessions.openInTerminal',
      (item: ProjectFolder) => {
        const terminal = vscode.window.createTerminal({
          cwd: item.folderPath,
        });
        terminal.show();
      },
    ),

    // --- Open to side ---
    vscode.commands.registerCommand(
      'claudeSessions.openToSide',
      (item: ProjectTreeItem) => {
        const uri = vscode.Uri.file(getItemPath(item));
        vscode.commands.executeCommand('vscode.open', uri, { viewColumn: vscode.ViewColumn.Beside });
      },
    ),

    // --- Cut / Copy / Paste ---
    vscode.commands.registerCommand(
      'claudeSessions.copyItem',
      (item: ProjectTreeItem) => {
        clipboard = { paths: [getItemPath(item)], cut: false };
        vscode.window.setStatusBarMessage('Copie dans le presse-papier', 2000);
      },
    ),

    vscode.commands.registerCommand(
      'claudeSessions.cutItem',
      (item: ProjectTreeItem) => {
        clipboard = { paths: [getItemPath(item)], cut: true };
        vscode.window.setStatusBarMessage('Coupe dans le presse-papier', 2000);
      },
    ),

    vscode.commands.registerCommand(
      'claudeSessions.pasteItem',
      (item: ProjectFolder) => {
        if (!clipboard) {
          vscode.window.showInformationMessage('Rien a coller');
          return;
        }
        for (const src of clipboard.paths) {
          const dest = path.join(item.folderPath, path.basename(src));
          try {
            if (clipboard.cut) {
              try {
                fs.renameSync(src, dest);
              } catch (renameErr: any) {
                if (renameErr.code === 'EXDEV') {
                  const stat = fs.statSync(src);
                  if (stat.isDirectory()) {
                    fs.cpSync(src, dest, { recursive: true });
                  } else {
                    fs.copyFileSync(src, dest);
                  }
                  fs.rmSync(src, { recursive: true, force: true });
                } else {
                  throw renameErr;
                }
              }
            } else {
              const stat = fs.statSync(src);
              if (stat.isDirectory()) {
                fs.cpSync(src, dest, { recursive: true });
              } else {
                fs.copyFileSync(src, dest);
              }
            }
          } catch (e: any) {
            vscode.window.showErrorMessage(`Erreur: ${e.message}`);
          }
        }
        if (clipboard.cut) clipboard = undefined;
        projectsProvider.refresh();
      },
    ),

    // --- Find in folder ---
    vscode.commands.registerCommand(
      'claudeSessions.findInFolder',
      (item: ProjectFolder) => {
        vscode.commands.executeCommand('workbench.action.findInFiles', {
          filesToInclude: item.folderPath + '/**',
        });
      },
    ),

    // --- Collapse all ---
    vscode.commands.registerCommand('claudeSessions.collapseAll', async () => {
      projectsProvider.expandedFolders.clear();
      await vscode.commands.executeCommand('workbench.actions.treeView.claudeSessions.projects.collapseAll');
    }),

    // --- Apply recommended layout ---
    vscode.commands.registerCommand('claudeSessions.applyLayout', async () => {
      const config = vscode.workspace.getConfiguration();
      await config.update('terminal.integrated.tabs.enabled', false, vscode.ConfigurationTarget.Global);
      await config.update('accessibility.signals.terminalBell', { sound: 'on' }, vscode.ConfigurationTarget.Global);
      await config.update('terminal.integrated.enableVisualBell', true, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Disposition Claude Sessions appliquee (parametres globaux)');
    }),

    // --- Show message panel ---
    vscode.commands.registerCommand('claudeSessions.showMessagePanel', async () => {
      await vscode.commands.executeCommand('claudeSessions.input.focus');
    }),

    // --- Export config to global (user) settings ---
    vscode.commands.registerCommand('claudeSessions.exportConfig', async () => {
      const config = vscode.workspace.getConfiguration();
      await config.update('terminal.integrated.tabs.enabled', false, vscode.ConfigurationTarget.Global);
      await config.update('accessibility.signals.terminalBell', { sound: 'on' }, vscode.ConfigurationTarget.Global);
      await config.update('terminal.integrated.enableVisualBell', true, vscode.ConfigurationTarget.Global);
      // Also export claudeSessions-specific settings
      const csConfig = vscode.workspace.getConfiguration('claudeSessions');
      const root = csConfig.get<string>('projectsRoot');
      if (root) {
        await csConfig.update('projectsRoot', root, vscode.ConfigurationTarget.Global);
      }
      const sound = csConfig.get<string>('notificationSound');
      if (sound) {
        await csConfig.update('notificationSound', sound, vscode.ConfigurationTarget.Global);
      }
      const soundCmd = csConfig.get<string>('notificationSoundCommand');
      if (soundCmd) {
        await csConfig.update('notificationSoundCommand', soundCmd, vscode.ConfigurationTarget.Global);
      }
      vscode.window.showInformationMessage('Configuration Claude Sessions exportee dans les parametres globaux (utilisateur)');
    }),

    // --- Insert path into message box ---
    vscode.commands.registerCommand(
      'claudeSessions.insertPathToMessage',
      (item: ProjectTreeItem) => {
        inputProvider.insertText(getItemPath(item));
      },
    ),

    // --- Send path to terminal (mention file) ---
    vscode.commands.registerCommand(
      'claudeSessions.sendPathToTerminal',
      (item: ProjectTreeItem) => {
        const itemPath = getItemPath(item);
        const terminal = vscode.window.activeTerminal;
        if (terminal) {
          terminal.sendText(itemPath, false);
          terminal.show();
        } else {
          vscode.env.clipboard.writeText(itemPath);
          vscode.window.showInformationMessage('Chemin copie (aucun terminal actif)');
        }
      },
    ),

    // --- Download / Save as ---
    vscode.commands.registerCommand(
      'claudeSessions.downloadFile',
      async (item: ProjectTreeItem) => {
        const sourceUri = vscode.Uri.file(getItemPath(item));
        const defaultUri = vscode.Uri.file(
          path.join(os.homedir(), 'Downloads', path.basename(sourceUri.fsPath)),
        );
        const targetUri = await vscode.window.showSaveDialog({
          defaultUri,
          title: 'Enregistrer le fichier sous...',
        });
        if (!targetUri) return;
        try {
          await vscode.workspace.fs.copy(sourceUri, targetUri, { overwrite: true });
          vscode.window.showInformationMessage(`Fichier enregistre: ${targetUri.fsPath}`);
        } catch (e: any) {
          vscode.window.showErrorMessage(`Erreur: ${e.message}`);
        }
      },
    ),

    // --- Download folder as ZIP ---
    vscode.commands.registerCommand(
      'claudeSessions.downloadFolder',
      async (item: ProjectFolder) => {
        const folderPath = item.folderPath;
        const folderName = path.basename(folderPath);
        const defaultUri = vscode.Uri.file(
          path.join(os.homedir(), 'Downloads', `${folderName}.zip`),
        );
        const targetUri = await vscode.window.showSaveDialog({
          defaultUri,
          title: 'Enregistrer le dossier en ZIP...',
          filters: { 'Archives ZIP': ['zip'] },
        });
        if (!targetUri) return;
        const safeSrc = folderPath.replace(/'/g, "'\\''");
        const safeDst = targetUri.fsPath.replace(/'/g, "'\\''");
        const safeName = folderName.replace(/'/g, "'\\''");
        // Use zip CLI (available on most Linux/WSL systems)
        exec(
          `cd '${path.dirname(safeSrc)}' && zip -r '${safeDst}' '${safeName}' -x '*/node_modules/*' '*/.git/*' '*/out/*' '*/dist/*' '*/__pycache__/*'`,
          { timeout: 60000 },
          (err) => {
            if (err) {
              // Fallback to tar.gz if zip not available
              exec(
                `tar -czf '${safeDst.replace(/\.zip$/, '.tar.gz')}' -C '${path.dirname(safeSrc)}' '${safeName}' --exclude='node_modules' --exclude='.git' --exclude='out' --exclude='dist'`,
                { timeout: 60000 },
                (err2) => {
                  if (err2) {
                    vscode.window.showErrorMessage(`Erreur ZIP: ${err2.message}`);
                  } else {
                    vscode.window.showInformationMessage(`Archive creee: ${safeDst.replace(/\.zip$/, '.tar.gz')}`);
                  }
                },
              );
            } else {
              vscode.window.showInformationMessage(`ZIP cree: ${targetUri.fsPath}`);
            }
          },
        );
      },
    ),

    // --- Move to... ---
    vscode.commands.registerCommand(
      'claudeSessions.moveItem',
      async (item: ProjectTreeItem) => {
        const sourcePath = getItemPath(item);
        const sourceName = path.basename(sourcePath);
        const uris = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Deplacer ici',
          defaultUri: vscode.Uri.file(path.dirname(sourcePath)),
        });
        if (!uris || uris.length === 0) return;
        const destPath = path.join(uris[0].fsPath, sourceName);
        try {
          fs.renameSync(sourcePath, destPath);
        } catch (renameErr: any) {
          if (renameErr.code === 'EXDEV') {
            const stat = fs.statSync(sourcePath);
            if (stat.isDirectory()) {
              fs.cpSync(sourcePath, destPath, { recursive: true });
            } else {
              fs.copyFileSync(sourcePath, destPath);
            }
            fs.rmSync(sourcePath, { recursive: true, force: true });
          } else {
            vscode.window.showErrorMessage(`Erreur: ${renameErr.message}`);
            return;
          }
        }
        projectsProvider.refresh();
      },
    ),

    // --- Espaces (session groups) commands ---
    vscode.commands.registerCommand('claudeSessions.espaces.save', async () => {
      const sessions = mgr.filteredByScope();
      if (sessions.length === 0) {
        vscode.window.showInformationMessage('Aucune session visible a sauvegarder');
        return;
      }

      const items: { label: string; value: string }[] = [];
      if (mgr.focusedGroupId) {
        const group = mgr.getGroups().find(g => g.id === mgr.focusedGroupId);
        if (group) {
          items.push({ label: `$(sync) Mettre a jour "${group.name}"`, value: 'update' });
        }
      }
      items.push({ label: '$(add) Sauvegarder comme nouvel espace...', value: 'new' });

      let action = 'new';
      if (items.length > 1) {
        const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Sauvegarder les sessions' });
        if (!picked) return;
        action = picked.value;
      }

      if (action === 'update') {
        const paths = sessions.map(s => s.projectPath);
        mgr.updateGroupPaths(mgr.focusedGroupId!, paths);
        espacesProvider.refresh();
        const group = mgr.getGroups().find(g => g.id === mgr.focusedGroupId);
        vscode.window.setStatusBarMessage(`Espace "${group?.name}" mis a jour`, 2000);
      } else {
        const name = await vscode.window.showInputBox({
          prompt: 'Nom de l\'espace',
          placeHolder: 'Mon espace de travail',
        });
        if (!name) return;
        const paths = sessions.map(s => s.projectPath);
        mgr.createGroup(name, paths);
        espacesProvider.refresh();
        vscode.window.setStatusBarMessage(`Espace "${name}" sauvegarde`, 2000);
      }
    }),

    // --- Espace focus (auto-restore if no active sessions) ---
    vscode.commands.registerCommand('claudeSessions.espaces.focus', async (item: GroupItem) => {
      const restored = await mgr.focusOrRestoreGroup(item.group.id);
      if (restored) {
        setTimeout(() => {
          sessionsProvider.refresh();
          projectsProvider.refresh();
          settingsProvider.refresh();
          espacesProvider.refresh();
          vscode.commands.executeCommand('workbench.view.extension.claude-sessions');
          mgr.ensurePanelMaximized();
        }, 1000);
      } else {
        espacesProvider.refresh();
        sessionsProvider.refresh();
      }
    }),

    // --- Espace search ---
    vscode.commands.registerCommand('claudeSessions.espaces.search', async () => {
      const group = await mgr.searchEspace();
      if (group) {
        mgr.focusGroup(group.id);
        espacesProvider.refresh();
        sessionsProvider.refresh();
      }
    }),

    // --- Nouvel espace (vide) ---
    vscode.commands.registerCommand('claudeSessions.espaces.new', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Nom du nouvel espace',
        placeHolder: 'Mon espace de travail',
      });
      if (!name) return;
      mgr.createEmptyGroup(name);
      espacesProvider.refresh();
      vscode.window.setStatusBarMessage(`Espace "${name}" cree (vide)`, 2000);
    }),

    // --- Espace filter cycle (all/active) ---
    ...['espaces.filterAll', 'espaces.filterActive'].map(cmd =>
      vscode.commands.registerCommand(`claudeSessions.${cmd}`, async () => {
        const modes: EspaceFilter[] = ['all', 'active'];
        const idx = modes.indexOf(mgr.espaceFilter);
        mgr.espaceFilter = modes[(idx + 1) % modes.length];
        mgr.persistSetting('espaceFilter', mgr.espaceFilter);
        await vscode.commands.executeCommand('setContext', 'claudeSessions.espaceFilter', mgr.espaceFilter);
        espacesProvider.refresh();
        settingsProvider.refresh();
      }),
    ),

    // --- Espace sort ---
    vscode.commands.registerCommand('claudeSessions.espaces.sort', async () => {
      await mgr.showEspaceSortPicker();
      espacesProvider.refresh();
    }),

    // --- Session scope filter (all/espaceFocus/espaceActive) ---
    ...['sessionScopeAll', 'sessionScopeFocus', 'sessionScopeActive'].map(cmd =>
      vscode.commands.registerCommand(`claudeSessions.${cmd}`, async () => {
        const modes: SessionScopeFilter[] = ['all', 'espaceFocus', 'espaceActive'];
        const idx = modes.indexOf(mgr.sessionScopeFilter);
        mgr.sessionScopeFilter = modes[(idx + 1) % modes.length];
        mgr.persistSetting('sessionScopeFilter', mgr.sessionScopeFilter);
        await vscode.commands.executeCommand('setContext', 'claudeSessions.sessionScopeFilter', mgr.sessionScopeFilter);
        sessionsProvider.refresh();
        settingsProvider.refresh();
      }),
    ),

    // --- Settings for espace filter and session scope ---
    vscode.commands.registerCommand('claudeSessions.setting.espaceFilter', async () => {
      const modes: EspaceFilter[] = ['all', 'active'];
      const idx = modes.indexOf(mgr.espaceFilter);
      mgr.espaceFilter = modes[(idx + 1) % modes.length];
      mgr.persistSetting('espaceFilter', mgr.espaceFilter);
      await vscode.commands.executeCommand('setContext', 'claudeSessions.espaceFilter', mgr.espaceFilter);
      espacesProvider.refresh();
      settingsProvider.refresh();
    }),

    vscode.commands.registerCommand('claudeSessions.setting.sessionScope', async () => {
      const modes: SessionScopeFilter[] = ['all', 'espaceFocus', 'espaceActive'];
      const idx = modes.indexOf(mgr.sessionScopeFilter);
      mgr.sessionScopeFilter = modes[(idx + 1) % modes.length];
      mgr.persistSetting('sessionScopeFilter', mgr.sessionScopeFilter);
      await vscode.commands.executeCommand('setContext', 'claudeSessions.sessionScopeFilter', mgr.sessionScopeFilter);
      sessionsProvider.refresh();
      settingsProvider.refresh();
    }),

    vscode.commands.registerCommand('claudeSessions.setting.preCommand', () => {
      mgr.preCommandEnabled = !mgr.preCommandEnabled;
      mgr.persistSetting('preCommandEnabled', mgr.preCommandEnabled);
      settingsProvider.refresh();
      vscode.window.setStatusBarMessage(`Pre-commande: ${mgr.preCommandEnabled ? 'Active' : 'Desactive'}`, 2000);
    }),

    vscode.commands.registerCommand('claudeSessions.setting.initMessage', () => {
      mgr.initMessageEnabled = !mgr.initMessageEnabled;
      mgr.persistSetting('initMessageEnabled', mgr.initMessageEnabled);
      settingsProvider.refresh();
      vscode.window.setStatusBarMessage(`Message init: ${mgr.initMessageEnabled ? 'Active' : 'Desactive'}`, 2000);
    }),

    vscode.commands.registerCommand('claudeSessions.setting.autoInitMessage', async () => {
      const snippets: Snippet[] = mgr.context.globalState.get('snippets', []);
      const items: { label: string; description?: string; value: string }[] = [
        { label: '$(edit) Saisir un message...', value: 'custom' },
        { label: '$(close) Desactiver', value: '' },
        ...snippets.map(s => ({
          label: s.type === 'command' ? `$(terminal) ${s.name}` : `$(comment) ${s.name}`,
          description: s.command.length > 60 ? s.command.substring(0, 60) + '...' : s.command,
          value: s.command,
        })),
      ];
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Message auto au lancement' });
      if (!picked) return;
      let msg = picked.value;
      if (msg === 'custom') {
        msg = await vscode.window.showInputBox({ prompt: 'Message auto', placeHolder: '/effort max' }) || '';
      }
      mgr.autoInitMessage = msg;
      mgr.persistSetting('autoInitMessage', msg);
      settingsProvider.refresh();
    }),

    vscode.commands.registerCommand('claudeSessions.setting.autoPreCommand', async () => {
      const snippets: Snippet[] = mgr.context.globalState.get('snippets', []);
      const commands = snippets.filter(s => s.type === 'command');
      const items: { label: string; description?: string; value: string }[] = [
        { label: '$(edit) Saisir une commande...', value: 'custom' },
        { label: '$(close) Desactiver', value: '' },
        ...commands.map(c => ({
          label: `$(terminal) ${c.name}`,
          description: c.command.length > 60 ? c.command.substring(0, 60) + '...' : c.command,
          value: c.command,
        })),
      ];
      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Pre-commande auto avant Claude' });
      if (!picked) return;
      let cmd = picked.value;
      if (cmd === 'custom') {
        cmd = await vscode.window.showInputBox({ prompt: 'Commande auto', placeHolder: 'source venv/bin/activate' }) || '';
      }
      mgr.autoPreCommand = cmd;
      mgr.persistSetting('autoPreCommand', cmd);
      settingsProvider.refresh();
    }),

    vscode.commands.registerCommand('claudeSessions.setting.filterMode', () => {
      const modes: FilterMode[] = ['all', 'active', 'focused'];
      const idx = modes.indexOf(mgr.filterMode);
      const next = modes[(idx + 1) % modes.length];
      mgr.filterMode = next;
      projectsProvider.filterMode = next;
      mgr.persistSetting('filterMode', next);
      vscode.commands.executeCommand('setContext', 'claudeSessions.filterMode', next);
      projectsProvider.refresh();
      settingsProvider.refresh();
    }),

    vscode.commands.registerCommand('claudeSessions.addToGroup', (item: SessionItem) => {
      mgr.addSessionToGroup(item.session.projectPath);
    }),

    // Right-click actions on sessions: pre-command + init message
    vscode.commands.registerCommand('claudeSessions.session.preCommand', async (item: SessionItem) => {
      if (!item?.session?.terminal) return;
      // Don't use showPreCommandPicker() — it checks preCommandEnabled global toggle.
      // Right-click should always work regardless of global setting.
      const snippets: Snippet[] = mgr.context.globalState.get('snippets', []);
      const commands = snippets.filter(s => s.type === 'command');
      if (commands.length === 0) {
        vscode.window.showInformationMessage('Aucun snippet de type "commande" enregistre');
        return;
      }
      const items = commands.map(c => ({
        label: c.name,
        description: c.tags.map((t: string) => `#${t}`).join(' '),
        detail: c.command.length > 80 ? c.command.substring(0, 80) + '...' : c.command,
        text: c.command,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Commande a injecter...',
        matchOnDetail: true,
      });
      if (picked) {
        inputProvider.insertText((picked as any).text);
      }
    }),
    vscode.commands.registerCommand('claudeSessions.session.initMessage', async (item: SessionItem) => {
      if (!item?.session?.terminal) return;
      const snippets: Snippet[] = mgr.context.globalState.get('snippets', []);
      const messages = snippets.filter(s => s.type === 'message');
      if (messages.length === 0) {
        vscode.window.showInformationMessage('Aucun snippet de type "message" enregistre');
        return;
      }
      const items = messages.map(m => ({
        label: m.name,
        description: m.tags.map((t: string) => `#${t}`).join(' '),
        detail: m.command.length > 80 ? m.command.substring(0, 80) + '...' : m.command,
        text: m.command,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Message a envoyer...',
        matchOnDetail: true,
      });
      if (picked) {
        inputProvider.insertText((picked as any).text);
      }
    }),

    // --- Delete conversation (explicit, with confirmation) ---
    vscode.commands.registerCommand('claudeSessions.deleteConversation', async (item: SessionItem) => {
      if (!item?.session) return;
      const answer = await vscode.window.showWarningMessage(
        `Supprimer la conversation de "${item.session.projectName}" ? La prochaine session ne reprendra pas.`,
        { modal: true },
        'Supprimer',
      );
      if (answer !== 'Supprimer') return;
      mgr.deleteConversation(item.session.projectName);
    }),

    // --- Launch single session from espace ---
    vscode.commands.registerCommand('claudeSessions.espaces.launchSession', async (item: GroupSessionItem) => {
      if (!item?.projectPath) return;
      if (mgr.hasPath(item.projectPath)) {
        const sessions = mgr.all();
        const s = sessions.find(s => s.projectPath === item.projectPath);
        if (s) mgr.switchTo(s.projectName);
      } else {
        await mgr.createSession(item.projectPath);
        mgr.activeGroupIds.add(item.groupId);
        mgr.persistGroupState();
      }
      espacesProvider.refresh();
    }),

    vscode.commands.registerCommand('claudeSessions.espaces.restore', async (item: GroupItem) => {
      const preCommand = await showPreCommandPicker();
      await mgr.restoreGroup(item.group.id, { preCommand });
      setTimeout(() => {
        sessionsProvider.refresh();
        projectsProvider.refresh();
        settingsProvider.refresh();
        espacesProvider.refresh();
        vscode.commands.executeCommand('workbench.view.extension.claude-sessions');
        mgr.ensurePanelMaximized();
      }, 1000);
      showInitMessagePicker(); // fire & forget — propose init message after espace restore
    }),

    vscode.commands.registerCommand('claudeSessions.espaces.stop', async (item: GroupItem) => {
      const answer = await vscode.window.showWarningMessage(
        `Arreter toutes les sessions de "${item.group.name}" ?`,
        { modal: true },
        'Arreter',
      );
      if (answer !== 'Arreter') return;
      mgr.stopGroup(item.group.id);
      sessionsProvider.refresh();
      projectsProvider.refresh();
      espacesProvider.refresh();
    }),

    vscode.commands.registerCommand('claudeSessions.espaces.rename', async (item: GroupItem) => {
      const newName = await vscode.window.showInputBox({
        prompt: 'Nouveau nom',
        value: item.group.name,
      });
      if (!newName || newName === item.group.name) return;
      mgr.renameGroup(item.group.id, newName);
      espacesProvider.refresh();
    }),

    vscode.commands.registerCommand('claudeSessions.espaces.delete', async (item: GroupItem) => {
      const answer = await vscode.window.showWarningMessage(
        `Supprimer l'espace "${item.group.name}" ?`,
        { modal: true },
        'Supprimer',
      );
      if (answer !== 'Supprimer') return;
      mgr.deleteGroup(item.group.id);
      espacesProvider.refresh();
    }),

    // --- Remove session from espace ---
    vscode.commands.registerCommand('claudeSessions.espaces.removeSession', (item: GroupSessionItem) => {
      if (!item?.groupId || !item?.projectPath) return;
      mgr.removeFromGroup(item.groupId, item.projectPath);
      espacesProvider.refresh();
      vscode.window.setStatusBarMessage('Session retiree de l\'espace', 2000);
    }),

    // --- tmate info ---
    vscode.commands.registerCommand('claudeSessions.session.tmateInfo', async (item?: SessionItem) => {
      const info = await mgr.getTmateInfo(item?.session?.projectName);
      if (!info) {
        vscode.window.showWarningMessage('Aucune session tmate active');
        return;
      }
      const action = await vscode.window.showInformationMessage(
        `tmate SSH: ${info}`,
        'Copier',
      );
      if (action === 'Copier') {
        vscode.env.clipboard.writeText(info);
        vscode.window.setStatusBarMessage('Lien tmate copie', 2000);
      }
    }),

    // Terminal closed
    vscode.window.onDidCloseTerminal(terminal => {
      const session = mgr.removeByTerminal(terminal);
      if (session) {
        vscode.window.showInformationMessage(
          `Session "${session.projectName}" terminee`,
        );
      }
    }),

    // Terminal switch -> sync
    vscode.window.onDidChangeActiveTerminal(terminal => {
      if (!terminal) return;
      const session = mgr.findByTerminal(terminal);
      if (session && session.projectName !== mgr.activeProject) {
        mgr.switchTo(session.projectName).catch(() => {});
      }
    }),
  );
}

function pickProject(mgr: SessionManager): void {
  const root = getProjectsRoot();

  let dirs: { label: string; description: string; path: string }[];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => {
        const fullPath = path.join(root, e.name);
        const active = mgr.hasPath(fullPath);
        return {
          label: active ? `$(sparkle) ${e.name}` : e.name,
          description: active ? 'actif' : '',
          path: fullPath,
        };
      });
  } catch {
    vscode.window.showErrorMessage(`Impossible de lire ${root}`);
    return;
  }

  vscode.window
    .showQuickPick(dirs, { placeHolder: 'Rechercher un projet...' })
    .then(async picked => {
      if (picked) await mgr.createSession(picked.path);
    });
}

let _mgr: SessionManager | undefined;

export function deactivate() {
}
