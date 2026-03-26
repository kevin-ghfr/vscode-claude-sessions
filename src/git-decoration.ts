import * as vscode from 'vscode';
import * as path from 'path';
import { execSync } from 'child_process';

export class GitDecorationProvider implements vscode.FileDecorationProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
  onDidChangeFileDecorations = this._onDidChange.event;
  private cache = new Map<string, string>();

  refresh(projectPath: string): void {
    try {
      const out = execSync('git status --porcelain', { cwd: projectPath, encoding: 'utf8', timeout: 5000 });
      this.cache.clear();
      const changedUris: vscode.Uri[] = [];
      for (const line of out.split('\n')) {
        if (line.length < 4) continue;
        const status = line[0] !== ' ' ? line[0] : line[1];
        const filePath = path.join(projectPath, line.substring(3).trim());
        this.cache.set(filePath, status);
        changedUris.push(vscode.Uri.file(filePath));
      }
      if (changedUris.length > 0) this._onDidChange.fire(changedUris);
    } catch {
      // git not available or not a repo
    }
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const status = this.cache.get(uri.fsPath);
    if (!status) return undefined;
    const badges: Record<string, { badge: string; color: vscode.ThemeColor }> = {
      M: { badge: 'M', color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground') },
      '?': { badge: 'U', color: new vscode.ThemeColor('gitDecoration.untrackedResourceForeground') },
      A: { badge: 'A', color: new vscode.ThemeColor('gitDecoration.addedResourceForeground') },
      D: { badge: 'D', color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground') },
      R: { badge: 'R', color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground') },
    };
    const dec = badges[status];
    return dec ? new vscode.FileDecoration(dec.badge, status, dec.color) : undefined;
  }
}
