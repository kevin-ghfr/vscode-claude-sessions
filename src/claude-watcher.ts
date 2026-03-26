import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { SessionManager } from './session-manager';

export function setupClaudeWatcher(
  context: vscode.ExtensionContext,
  mgr: SessionManager,
): void {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');

  try {
    if (!fs.existsSync(claudeDir)) return;

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(claudeDir), '**/*'),
    );

    const handleChange = (uri: vscode.Uri) => {
      const relative = path.relative(claudeDir, uri.fsPath);

      // Ignore subagent files — they shouldn't trigger notifications
      if (relative.includes(`${path.sep}subagents${path.sep}`) || relative.includes('/subagents/')) {
        return;
      }

      const encodedProject = relative.split(path.sep)[0];

      for (const s of mgr.all()) {
        const encoded = s.projectPath.replace(/\//g, '-');
        if (encodedProject === encoded) {
          mgr.onClaudeActivity(s.projectName);
          break;
        }
      }
    };

    watcher.onDidChange(handleChange);
    watcher.onDidCreate(handleChange);
    context.subscriptions.push(watcher);
  } catch {
    // Claude dir doesn't exist yet
  }
}
