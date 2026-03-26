import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SessionManager } from './session-manager';
import { ProjectTreeItem, ProjectFolder, SessionItem, GroupItem, GroupSessionItem } from './tree-items';
import { ProjectsProvider } from './tree-providers';

const PROJECT_MIME = 'application/vnd.code.tree.claudesessions.projects';

export class ProjectDragController
  implements vscode.TreeDragAndDropController<ProjectTreeItem>
{
  readonly dropMimeTypes: readonly string[] = [PROJECT_MIME, 'text/uri-list'];
  readonly dragMimeTypes: readonly string[] = ['text/uri-list', PROJECT_MIME];

  constructor(private projectsProvider: ProjectsProvider) {}

  handleDrag(
    source: readonly ProjectTreeItem[],
    dataTransfer: vscode.DataTransfer,
  ): void {
    const uris = source.map(s =>
      s instanceof ProjectFolder
        ? vscode.Uri.file(s.folderPath).toString()
        : s.resourceUri!.toString(),
    );
    dataTransfer.set(
      'text/uri-list',
      new vscode.DataTransferItem(uris.join('\r\n')),
    );
    const paths = source.map(s =>
      s instanceof ProjectFolder ? s.folderPath : s.resourceUri!.fsPath,
    );
    dataTransfer.set(PROJECT_MIME, new vscode.DataTransferItem(paths));
  }

  handleDrop(
    target: ProjectTreeItem | undefined,
    dataTransfer: vscode.DataTransfer,
  ): void | Thenable<void> {
    if (!target || !(target instanceof ProjectFolder)) return;
    // Internal project drag
    const data = dataTransfer.get(PROJECT_MIME);
    if (data) {
    const sourcePaths: string[] = data.value;
    if (!Array.isArray(sourcePaths)) return;
    const destDir = target.folderPath;
    for (const src of sourcePaths) {
      if (src === destDir) continue;
      // Don't move into self
      if (destDir.startsWith(src + '/')) continue;
      const dest = path.join(destDir, path.basename(src));
      if (fs.existsSync(dest)) continue;
      try {
        fs.renameSync(src, dest);
      } catch (e: any) {
        if (e.code === 'EXDEV') {
          const stat = fs.statSync(src);
          if (stat.isDirectory()) {
            fs.cpSync(src, dest, { recursive: true });
          } else {
            fs.copyFileSync(src, dest);
          }
          fs.rmSync(src, { recursive: true, force: true });
        }
      }
    }
    this.projectsProvider.refresh();
    return;
    }

    // External file drop (from Windows explorer, etc.)
    const uriData = dataTransfer.get('text/uri-list');
    if (uriData) {
      const destDir = target.folderPath;
      const uris = String(uriData.value).split(/\r?\n/).filter(u => u.trim());
      for (const uri of uris) {
        try {
          const filePath = vscode.Uri.parse(uri).fsPath;
          if (!filePath || !fs.existsSync(filePath)) continue;
          const dest = path.join(destDir, path.basename(filePath));
          if (fs.existsSync(dest)) continue;
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            fs.cpSync(filePath, dest, { recursive: true });
          } else {
            fs.copyFileSync(filePath, dest);
          }
        } catch { /* skip failed copies */ }
      }
      this.projectsProvider.refresh();
    }
  }
}

const SESSION_MIME = 'application/vnd.code.tree.claudesessions.active';

export class SessionDragController
  implements vscode.TreeDragAndDropController<SessionItem>
{
  readonly dropMimeTypes: readonly string[] = [SESSION_MIME];
  readonly dragMimeTypes: readonly string[] = [SESSION_MIME];

  constructor(private mgr: SessionManager) {}

  handleDrag(
    source: readonly SessionItem[],
    dataTransfer: vscode.DataTransfer,
  ): void {
    if (source.length !== 1) return;
    dataTransfer.set(
      SESSION_MIME,
      new vscode.DataTransferItem(source[0].session.projectName),
    );
  }

  handleDrop(
    target: SessionItem | undefined,
    dataTransfer: vscode.DataTransfer,
  ): void {
    if (!target) return;
    const data = dataTransfer.get(SESSION_MIME);
    if (!data) return;
    const fromName: string = data.value;
    if (typeof fromName !== 'string') return;
    this.mgr.reorderSession(fromName, target.session.projectName);
  }
}

const ESPACE_MIME = 'application/vnd.code.tree.claudesessions.espaces';
const ESPACE_SESSION_MIME = 'application/vnd.code.tree.claudesessions.espaces.session';

export class EspaceDragController
  implements vscode.TreeDragAndDropController<GroupItem | GroupSessionItem>
{
  readonly dropMimeTypes: readonly string[] = [ESPACE_MIME, ESPACE_SESSION_MIME];
  readonly dragMimeTypes: readonly string[] = [ESPACE_MIME, ESPACE_SESSION_MIME];

  constructor(private mgr: SessionManager) {}

  handleDrag(
    source: readonly (GroupItem | GroupSessionItem)[],
    dataTransfer: vscode.DataTransfer,
  ): void {
    if (source.length !== 1) return;
    if (source[0] instanceof GroupItem) {
      dataTransfer.set(
        ESPACE_MIME,
        new vscode.DataTransferItem(source[0].group.id),
      );
    } else if (source[0] instanceof GroupSessionItem) {
      dataTransfer.set(
        ESPACE_SESSION_MIME,
        new vscode.DataTransferItem(JSON.stringify({
          groupId: source[0].groupId,
          projectPath: source[0].projectPath,
        })),
      );
    }
  }

  handleDrop(
    target: GroupItem | GroupSessionItem | undefined,
    dataTransfer: vscode.DataTransfer,
  ): void {
    if (!target) return;

    // Drop a session onto a group → move session to that group
    const sessionData = dataTransfer.get(ESPACE_SESSION_MIME);
    if (sessionData && target instanceof GroupItem) {
      let parsed: { groupId: string; projectPath: string };
      try { parsed = typeof sessionData.value === 'string' ? JSON.parse(sessionData.value) : sessionData.value; }
      catch { return; }
      if (parsed.groupId === target.group.id) return; // same group, no-op
      // Remove from source group, add to target group
      this.mgr.removeFromGroup(parsed.groupId, parsed.projectPath);
      const groups = this.mgr.getGroups();
      const targetGroup = groups.find(g => g.id === target.group.id);
      if (targetGroup && !targetGroup.paths.includes(parsed.projectPath)) {
        targetGroup.paths.push(parsed.projectPath);
        this.mgr.updateGroupPaths(target.group.id, targetGroup.paths);
      }
      return;
    }

    // Drop a group onto a group → reorder
    const groupData = dataTransfer.get(ESPACE_MIME);
    if (groupData && target instanceof GroupItem) {
      const fromId: string = groupData.value;
      if (typeof fromId !== 'string') return;
      this.mgr.reorderEspace(fromId, target.group.id);
    }
  }
}
