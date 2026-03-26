import * as vscode from 'vscode';
import * as path from 'path';
import { ClaudeSession, NotifyMode, SessionGroup } from './types';
import { formatTimeAgo } from './helpers';

export type ProjectTreeItem = ProjectFolder | ProjectFile;

export class ProjectFolder extends vscode.TreeItem {
  public readonly folderPath: string;

  constructor(
    folderPath: string,
    isActive: boolean,
    isRoot: boolean,
    collapsibleState?: vscode.TreeItemCollapsibleState,
  ) {
    const name = path.basename(folderPath);
    super(name, collapsibleState ?? vscode.TreeItemCollapsibleState.Collapsed);
    this.folderPath = folderPath;
    this.id = `folder:${folderPath}`;
    this.iconPath = new vscode.ThemeIcon(
      isActive ? 'sparkle' : 'folder',
      isActive ? new vscode.ThemeColor('charts.green') : undefined,
    );
    this.description = isActive ? '\u25CF actif' : '';
    this.contextValue = isRoot ? 'project' : 'projectDir';
  }
}

export class ProjectFile extends vscode.TreeItem {
  constructor(filePath: string) {
    super(path.basename(filePath), vscode.TreeItemCollapsibleState.None);
    this.iconPath = vscode.ThemeIcon.File;
    this.resourceUri = vscode.Uri.file(filePath);
    this.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [vscode.Uri.file(filePath)],
    };
    this.contextValue = 'projectFile';
  }
}

export class SessionItem extends vscode.TreeItem {
  constructor(
    public readonly session: ClaudeSession,
    isActive: boolean,
  ) {
    super(session.projectName, vscode.TreeItemCollapsibleState.None);

    const timeAgo = formatTimeAgo(session.lastActivity);

    // No highlight on active session name — sparkle icon is enough

    // Description — clean, no duplicate status info
    this.description = isActive && session.status === 'working'
      ? `\u25CF en cours \u00B7 ${timeAgo}`
      : isActive
        ? `\u25CF actif \u00B7 ${timeAgo}`
        : `${timeAgo}`;

    // Left icon — active+working gets sparkle in blue, active+done gets green sparkle
    if (isActive && session.status === 'working') {
      this.iconPath = new vscode.ThemeIcon('sparkle', new vscode.ThemeColor('charts.blue'));
    } else if (isActive) {
      this.iconPath = new vscode.ThemeIcon('sparkle', new vscode.ThemeColor('charts.green'));
    } else if (session.status === 'working') {
      this.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
    } else if (session.unread) {
      this.iconPath = new vscode.ThemeIcon('mail', new vscode.ThemeColor('charts.orange'));
    } else {
      this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
    }

    // Notification mode tooltips
    const modeLabels: Record<NotifyMode, string> = {
      muted: 'Muet',
      notify: 'Notif popup',
      sound: 'Son',
      notifySound: 'Notif + son',
    };
    const statusLabel = session.status === 'working' ? 'En cours' : session.unread ? 'Non lu' : 'Lu';
    this.tooltip = `${session.projectName}\n${statusLabel} \u00B7 ${timeAgo}\nNotifications: ${modeLabels[session.notifyMode]}`;

    this.command = {
      command: 'claudeSessions.switchSession',
      title: 'Switch',
      arguments: [this],
    };

    const modeStr = session.notifyMode.charAt(0).toUpperCase() + session.notifyMode.slice(1);
    this.contextValue = isActive ? `sessionActive${modeStr}` : `session${modeStr}`;
  }
}

export class SettingItem extends vscode.TreeItem {
  constructor(
    public readonly key: string,
    label: string,
    description: string,
    icon: string,
    tip?: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = { command: `claudeSessions.setting.${key}`, title: label };
    if (tip) this.tooltip = tip;
  }
}

export class GroupItem extends vscode.TreeItem {
  constructor(
    public readonly group: SessionGroup,
    activeCount: number,
    totalCount: number,
    isFocused: boolean,
    isActive: boolean,
    workingCount: number,
    unreadCount: number,
    lastActivity?: Date,
  ) {
    super(group.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `group:${group.id}`;

    // Description avec statut + date — only show session states for active espaces
    const parts: string[] = [];
    if (isActive || isFocused) {
      if (activeCount > 0) parts.push(`${activeCount}/${totalCount} actif(s)`);
      else parts.push(`${totalCount} projet(s)`);
      if (workingCount > 0) parts.push(`${workingCount} en cours`);
      if (unreadCount > 0) parts.push(`${unreadCount} non lu(s)`);
      if (lastActivity) parts.push(formatTimeAgo(lastActivity));
    } else {
      parts.push(`${group.paths.length} projet(s)`);
    }
    const invalid = group.paths.length - totalCount;
    if (invalid > 0) parts.push(`${invalid} introuvable(s)`);
    this.description = isFocused
      ? `${parts.join(' \u00B7 ')} \u25CF focus`
      : parts.join(' \u00B7 ');

    // Icone — only show active states for espaces explicitly in activeGroupIds
    if (isFocused && workingCount > 0) {
      this.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
    } else if (isFocused && unreadCount > 0) {
      this.iconPath = new vscode.ThemeIcon('mail', new vscode.ThemeColor('charts.orange'));
    } else if (isFocused) {
      this.iconPath = new vscode.ThemeIcon('target', new vscode.ThemeColor('charts.green'));
    } else if (isActive && workingCount > 0) {
      this.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
    } else if (isActive && unreadCount > 0) {
      this.iconPath = new vscode.ThemeIcon('mail', new vscode.ThemeColor('charts.orange'));
    } else if (isActive) {
      this.iconPath = new vscode.ThemeIcon('folder-opened');
    } else {
      this.iconPath = new vscode.ThemeIcon('folder-library');
    }

    // contextValue : sessionGroup{Focus}{SessionState}
    const focusStr = isFocused ? 'Focused' : (isActive ? 'Active' : 'Inactive');
    const sessStr = (activeCount === totalCount && totalCount > 0) ? 'AllActive'
      : (activeCount > 0 ? 'Partial' : 'None');
    this.contextValue = `sessionGroup${focusStr}${sessStr}`;

    // Clic = focus
    this.command = {
      command: 'claudeSessions.espaces.focus',
      title: 'Focus',
      arguments: [this],
    };

    this.tooltip = `${group.name}${isFocused ? ' (espace focus)' : isActive ? ' (actif)' : ''}
${group.paths.length} projet(s)${lastActivity ? '\nDerniere activite: ' + formatTimeAgo(lastActivity) : ''}
Cree le ${new Date(group.createdAt).toLocaleDateString('fr-FR')}`;
  }
}

export class GroupSessionItem extends vscode.TreeItem {
  constructor(
    public readonly projectPath: string,
    public readonly groupId: string,
    isActive: boolean,
    exists: boolean,
    status?: 'working' | 'done',
    unread?: boolean,
    lastActivity?: Date,
  ) {
    super(path.basename(projectPath), vscode.TreeItemCollapsibleState.None);
    this.id = `groupSession:${groupId}:${projectPath}`;
    this.contextValue = 'groupSession';
    this.tooltip = projectPath;
    if (!exists) {
      this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.red'));
      this.description = 'introuvable';
    } else if (!isActive) {
      this.iconPath = new vscode.ThemeIcon('circle-outline');
    } else if (status === 'working') {
      this.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.blue'));
      this.description = lastActivity ? `en cours \u00B7 ${formatTimeAgo(lastActivity)}` : 'en cours';
    } else if (unread) {
      this.iconPath = new vscode.ThemeIcon('mail', new vscode.ThemeColor('charts.orange'));
      this.description = lastActivity ? `non lu \u00B7 ${formatTimeAgo(lastActivity)}` : 'non lu';
    } else {
      this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
      this.description = lastActivity ? formatTimeAgo(lastActivity) : 'actif';
    }
  }
}

export function getItemPath(item: ProjectTreeItem): string {
  if (item instanceof ProjectFolder) return item.folderPath;
  return item.resourceUri!.fsPath;
}
