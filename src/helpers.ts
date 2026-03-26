import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export function getProjectsRoot(): string {
  const config = vscode.workspace.getConfiguration('claudeSessions');
  const root = config.get<string>('projectsRoot', '~/github');
  return root.replace(/^~/, os.homedir());
}

export function formatTimeAgo(date: Date): string {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'maintenant';
  if (mins < 60) return `${mins}min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}j`;
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

export function getLastActivityFromDisk(projectPath: string): Date {
  const encoded = projectPath.replace(/\//g, '-');
  const dir = path.join(os.homedir(), '.claude', 'projects', encoded);
  try {
    let latest = 0;
    for (const f of fs.readdirSync(dir)) {
      const mt = fs.statSync(path.join(dir, f)).mtimeMs;
      if (mt > latest) latest = mt;
    }
    return latest > 0 ? new Date(latest) : new Date();
  } catch {
    return new Date();
  }
}

export function nameHash(name: string): number {
  let h = 0;
  for (const c of name) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

export function getGitBranch(projectPath: string): string | undefined {
  try {
    const head = fs
      .readFileSync(path.join(projectPath, '.git', 'HEAD'), 'utf8')
      .trim();
    return head.startsWith('ref: refs/heads/')
      ? head.replace('ref: refs/heads/', '')
      : head.substring(0, 8);
  } catch {
    return undefined;
  }
}

export const TERMINAL_COLORS = [
  'terminal.ansiBlue',
  'terminal.ansiGreen',
  'terminal.ansiMagenta',
  'terminal.ansiRed',
  'terminal.ansiCyan',
  'terminal.ansiYellow',
];
