import * as vscode from 'vscode';

export type Status = 'working' | 'done';
export type FilterMode = 'all' | 'active' | 'focused';
export type NotifyMode = 'muted' | 'notify' | 'sound' | 'notifySound';
export type SortMode = 'recent-desc' | 'recent-asc' | 'fixed';
export type SessionFilter = 'all' | 'working' | 'unread' | 'read';
export type EspaceFilter = 'all' | 'active';
export type SessionScopeFilter = 'all' | 'espaceFocus' | 'espaceActive';
export type EspaceSortMode = 'name-asc' | 'name-desc' | 'recent-desc' | 'recent-asc' | 'created-desc' | 'created-asc' | 'fixed';
export type SnippetType = 'command' | 'message';

export interface Snippet {
  id: string;
  name: string;
  command: string;
  tags: string[];
  folder: string;
  type: SnippetType;
}

export interface ClaudeSession {
  projectName: string;
  projectPath: string;
  terminal: vscode.Terminal;
  status: Status;
  unread: boolean;
  notifyMode: NotifyMode;
  openFiles: string[];
  lastActivity: Date;
  colorIndex: number;
  tmateSocketPath?: string;
}

export interface SessionGroup {
  id: string;
  name: string;
  paths: string[];
  createdAt: string;
}
