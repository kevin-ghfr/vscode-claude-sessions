import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FilterMode } from './types';
import { getProjectsRoot } from './helpers';
import { SessionManager } from './session-manager';
import { ProjectTreeItem, ProjectFolder, ProjectFile, SessionItem, SettingItem, GroupItem, GroupSessionItem } from './tree-items';

export class ProjectsProvider implements vscode.TreeDataProvider<ProjectTreeItem> {
  private _onDidChange = new vscode.EventEmitter<
    ProjectTreeItem | undefined
  >();
  onDidChangeTreeData = this._onDidChange.event;
  filterMode: FilterMode = 'focused';
  expandedFolders = new Set<string>();

  constructor(private mgr: SessionManager) {}

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  trackExpand(item: ProjectFolder): void {
    this.expandedFolders.add(item.id!);
  }

  trackCollapse(item: ProjectFolder): void {
    this.expandedFolders.delete(item.id!);
  }

  getTreeItem(el: ProjectTreeItem): vscode.TreeItem {
    return el;
  }

  getParent(element: ProjectTreeItem): ProjectTreeItem | undefined {
    if (element instanceof ProjectFolder && element.contextValue === 'project') {
      return undefined;
    }
    const folderPath =
      element instanceof ProjectFolder
        ? element.folderPath
        : (element as ProjectFile).resourceUri!.fsPath;
    const parentDir = path.dirname(folderPath);
    const root = getProjectsRoot();
    if (parentDir === root) {
      return new ProjectFolder(parentDir, false, true);
    }
    return new ProjectFolder(parentDir, false, false);
  }

  getChildren(element?: ProjectTreeItem): ProjectTreeItem[] {
    if (!element) {
      const projects = this.getRootProjects();
      // Set context so viewsWelcome can show guidance when empty
      vscode.commands.executeCommand('setContext', 'claudeSessions.emptyProjects', projects.length === 0);
      vscode.commands.executeCommand('setContext', 'claudeSessions.hasActiveSessions', this.mgr.all().length > 0);
      return projects;
    }
    if (element instanceof ProjectFolder) {
      return this.readDir(element.folderPath);
    }
    return [];
  }

  private getRootProjects(): ProjectFolder[] {
    const root = getProjectsRoot();
    try {
      const activePath = this.mgr.activeProjectPath;
      return fs
        .readdirSync(root, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .filter(e => {
          if (this.filterMode === 'all') return true;
          const fullPath = path.join(root, e.name);
          if (this.filterMode === 'active') return this.mgr.hasPath(fullPath);
          return fullPath === activePath;
        })
        .sort((a, b) => {
          const aActive = this.mgr.hasPath(path.join(root, a.name));
          const bActive = this.mgr.hasPath(path.join(root, b.name));
          if (aActive !== bActive) return aActive ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map(e => {
          const fullPath = path.join(root, e.name);
          const isActive = fullPath === activePath;
          const shouldExpand = this.expandedFolders.has(`folder:${fullPath}`) ||
            this.filterMode === 'focused';
          const state = shouldExpand
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed;
          return new ProjectFolder(fullPath, isActive, true, state);
        });
    } catch {
      return [];
    }
  }

  private readDir(dirPath: string): ProjectTreeItem[] {
    try {
      return fs
        .readdirSync(dirPath, { withFileTypes: true })
        .filter(
          e =>
            !e.name.startsWith('.') &&
            !['node_modules', 'out', 'dist', '__pycache__', '.git'].includes(
              e.name,
            ),
        )
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory())
            return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map(e => {
          const full = path.join(dirPath, e.name);
          if (e.isDirectory()) {
            const state = this.expandedFolders.has(`folder:${full}`)
              ? vscode.TreeItemCollapsibleState.Expanded
              : vscode.TreeItemCollapsibleState.Collapsed;
            return new ProjectFolder(full, false, false, state);
          }
          return new ProjectFile(full);
        });
    } catch {
      return [];
    }
  }
}

export class SessionsProvider implements vscode.TreeDataProvider<SessionItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  onDidChangeTreeData = this._onDidChange.event;

  constructor(private mgr: SessionManager) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(el: SessionItem): vscode.TreeItem {
    return el;
  }

  getChildren(): SessionItem[] {
    return this.mgr
      .filteredByScope()
      .map(s => new SessionItem(s, s.projectName === this.mgr.activeProject));
  }
}

export class SettingsProvider implements vscode.TreeDataProvider<SettingItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  onDidChangeTreeData = this._onDidChange.event;
  constructor(private mgr: SessionManager) {}
  refresh(): void { this._onDidChange.fire(); }
  getTreeItem(el: SettingItem): vscode.TreeItem { return el; }

  getChildren(): SettingItem[] {
    const config = vscode.workspace.getConfiguration('claudeSessions');
    const soundMode = config.get<string>('notificationSound', 'auto');
    const soundLabel = soundMode === 'off' ? 'Desactive' : soundMode === 'custom' ? 'Personnalise' : 'Auto (Windows)';

    return [
      // --- Projets ---
      new SettingItem('projectsRoot', 'Dossier racine', config.get<string>('projectsRoot', '~/github'), 'home',
        'Le dossier contenant tous vos projets. Cliquer pour changer'),
      new SettingItem('filterMode', 'Filtre projets',
        ({ all: 'Tous', active: 'Actifs', focused: 'Focus' } as Record<string, string>)[this.mgr.filterMode], 'filter',
        'Mode de filtrage des projets: Tous, Actifs, ou Focus'),
      // --- Sessions ---
      new SettingItem('scopeEditors', 'Editeurs par session', this.mgr.scopeEditors ? 'Session active' : 'Garder tous', 'files',
        'Session active: ne montre que les fichiers ouverts dans la session en cours'),
      new SettingItem('sessionScope', 'Scope sessions', ({ all: 'Toutes', espaceFocus: 'Espace focus', espaceActive: 'Espaces actifs' } as Record<string, string>)[this.mgr.sessionScopeFilter], 'layers',
        'Filtrer les sessions par portee d\'espace'),
      new SettingItem('resume', 'Reprise auto', this.mgr.resumeConversation ? 'Oui (claude -r)' : 'Non (nouveau)', 'debug-restart',
        'Reprendre la derniere conversation Claude (claude -r)'),
      new SettingItem('effort', 'Effort Claude', ({ auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High', max: 'Max' } as Record<string, string>)[vscode.workspace.getConfiguration('claudeSessions').get<string>('effortLevel', 'auto')] || 'Auto', 'zap',
        'Niveau de raisonnement: auto, low, medium, high, max (Opus)'),
      new SettingItem('preCommand', 'Pre-commande', this.mgr.preCommandEnabled ? 'Active' : 'Desactive', 'terminal',
        'Popup pour injecter une commande avant Claude (nouvelles sessions)'),
      new SettingItem('autoPreCommand', 'Pre-commande auto',
        this.mgr.autoPreCommand || 'Desactive', 'terminal-bash',
        'Commande executee automatiquement avant Claude (chaque session)'),
      new SettingItem('initMessage', 'Message init', this.mgr.initMessageEnabled ? 'Active' : 'Desactive', 'comment',
        'Proposer un message pre-enregistre apres lancement Claude'),
      new SettingItem('autoInitMessage', 'Message auto init',
        this.mgr.autoInitMessage || 'Desactive', 'rocket',
        'Message envoye automatiquement a chaque nouvelle session'),
      new SettingItem('fullView', 'Plein ecran', this.mgr.fullView ? 'Oui' : 'Non', 'screen-full',
        'Agrandir le terminal automatiquement'),
      // --- Espaces ---
      new SettingItem('espaceFilter', 'Filtre espaces', this.mgr.espaceFilter === 'all' ? 'Tous' : 'Actifs', 'filter',
        'Filtrer les espaces: Tous ou seulement les actifs'),
      // --- Divers ---
      new SettingItem('sound', 'Son de notification', soundLabel, 'unmute',
        'Son quand Claude termine une tache en arriere-plan'),
      new SettingItem('tmate', 'tmate (acces distant)', this.mgr.tmateEnabled ? 'Active' : 'Desactive', 'remote',
        'Lancer tmate automatiquement dans chaque session'),
    ];
  }
}

export class EspacesProvider implements vscode.TreeDataProvider<GroupItem | GroupSessionItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  onDidChangeTreeData = this._onDidChange.event;
  constructor(private mgr: SessionManager) {}
  refresh(): void { this._onDidChange.fire(); }
  getTreeItem(el: GroupItem | GroupSessionItem): vscode.TreeItem { return el; }

  getChildren(element?: GroupItem | GroupSessionItem): (GroupItem | GroupSessionItem)[] {
    if (!element) {
      const groups = this.mgr.getFilteredGroups();
      vscode.commands.executeCommand('setContext', 'claudeSessions.hasGroups', this.mgr.getGroups().length > 0);
      return groups.map(g => {
        const valid = g.paths.filter(p => fs.existsSync(p));
        const active = g.paths.filter(p => this.mgr.hasPath(p));
        const status = this.mgr.getGroupStatus(g.id);
        return new GroupItem(
          g, active.length, valid.length,
          g.id === this.mgr.focusedGroupId,
          this.mgr.activeGroupIds.has(g.id),
          status.working, status.unread, status.lastActivity,
        );
      });
    }
    if (element instanceof GroupItem) {
      const allSessions = this.mgr.all();
      return element.group.paths.map(p => {
        const session = allSessions.find(s => s.projectPath === p);
        return new GroupSessionItem(
          p, element.group.id, this.mgr.hasPath(p), fs.existsSync(p),
          session?.status, session?.unread, session?.lastActivity,
        );
      });
    }
    return [];
  }
}
