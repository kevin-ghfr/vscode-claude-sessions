import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { SessionManager } from './session-manager';
import { Snippet, SnippetType } from './types';

export class InputViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'claudeSessions.input';
  private _view?: vscode.WebviewView;
  private _webviewReady = false;
  private _pendingInput: string | undefined;
  private _drafts = new Map<string, string>();
  private _lastSessionName: string | undefined;
  private _onChangedListener: vscode.Disposable;

  constructor(private mgr: SessionManager) {
    this._onChangedListener = mgr.onChanged(() => {
      this.updateSession();
      this.updateHistory();
      this.updateConversation();
    });
  }

  dispose(): void {
    this._onChangedListener.dispose();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    this._webviewReady = false;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async msg => {
      if (msg.type === 'send') {
        let updatedHistory: string[] = [];
        if (msg.image) {
          const tmpDir = path.join(os.tmpdir(), 'claude-sessions');
          fs.mkdirSync(tmpDir, { recursive: true });
          const imgPath = path.join(tmpDir, `paste-${Date.now()}.png`);
          const base64Data = msg.image.replace(/^data:image\/\w+;base64,/, '');
          fs.writeFileSync(imgPath, Buffer.from(base64Data, 'base64'));
          const text = msg.text.trim() ? `${msg.text.trim()} ${imgPath}` : imgPath;
          if (msg.targetSession) {
            updatedHistory = this.mgr.sendToSession(msg.targetSession, text);
          } else {
            updatedHistory = this.mgr.sendToActive(text);
          }
        } else if (msg.text.trim()) {
          if (msg.targetSession) {
            updatedHistory = this.mgr.sendToSession(msg.targetSession, msg.text.trim());
          } else {
            updatedHistory = this.mgr.sendToActive(msg.text.trim());
          }
        }
        // Send the updated history directly to the webview (don't rely on async globalState)
        if (this._view && updatedHistory.length > 0) {
          this._view.webview.postMessage({
            type: 'history',
            items: updatedHistory,
            mode: 'session',
          });
        }
      } else if (msg.type === 'getSendTargets') {
        const sessions = this.mgr.all().map(s => ({
          name: s.projectName,
          active: s.projectName === this.mgr.activeProject,
          espaces: this.mgr.getSessionEspaces(s.projectPath),
        }));
        const groups = this.mgr.getGroups().filter(g => this.mgr.activeGroupIds.has(g.id));
        this._view?.webview.postMessage({
          type: 'sendTargets',
          items: sessions,
          groups: groups.map(g => ({ id: g.id, name: g.name, focused: g.id === this.mgr.focusedGroupId })),
        });
      } else if (msg.type === 'ready') {
        this._webviewReady = true;
        this.updateSession();
        this.updateHistory();
        this.updateConversation();
      } else if (msg.type === 'getSessions') {
        const sessions = this.mgr.all().map(s => ({
          name: s.projectName,
          path: s.projectPath,
          active: s.projectName === this.mgr.activeProject,
          espaces: this.mgr.getSessionEspaces(s.projectPath),
        }));
        const groups = this.mgr.getGroups().filter(g => this.mgr.activeGroupIds.has(g.id));
        this._view?.webview.postMessage({
          type: 'sessions',
          items: sessions,
          groups: groups.map(g => ({ id: g.id, name: g.name, focused: g.id === this.mgr.focusedGroupId })),
        });
      } else if (msg.type === 'getSessionHistory') {
        if (msg.mode === 'all') {
          const all = this.mgr.getAllHistory().reverse();
          this._view?.webview.postMessage({ type: 'history', items: all.map(h => h.text), tags: all.map(h => h.projectName), mode: 'all' });
        } else if (msg.mode === 'espace') {
          const group = this.mgr.getGroups().find(g => g.id === msg.groupId);
          if (group) {
            const allHistory: Array<{text: string; projectName: string}> = [];
            for (const p of group.paths) {
              const history = this.mgr.getHistory(p);
              const name = path.basename(p);
              history.forEach(h => allHistory.push({ text: h, projectName: name }));
            }
            this._view?.webview.postMessage({
              type: 'history',
              items: allHistory.map(h => h.text),
              tags: allHistory.map(h => h.projectName),
              mode: 'all',
            });
          }
        } else {
          const history = this.mgr.getHistory(msg.projectPath);
          this._view?.webview.postMessage({ type: 'history', items: history, mode: 'session' });
        }
      } else if (msg.type === 'attachFile') {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: true,
          openLabel: 'Joindre',
        });
        if (uris && uris.length > 0) {
          this._view?.webview.postMessage({ type: 'attachedFiles', paths: uris.map(u => u.fsPath) });
        }
      } else if (msg.type === 'openSnippets') {
        const snippets = this.getSnippets();
        if (snippets.length > 0) {
          await this.showSnippetsPicker(msg.text?.trim());
        } else {
          await this.saveSnippet(msg.text?.trim() || '');
        }
      } else if (msg.type === 'saveSnippet') {
        await this.saveSnippet(msg.text);
      } else if (msg.type === 'saveDraft') {
        if (msg.sessionName) {
          this._drafts.set(msg.sessionName, msg.text || '');
        }
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._webviewReady = true;
        this.updateSession();
        this.updateHistory();
        this.updateConversation();
        webviewView.webview.postMessage({ type: 'scrollToBottom' });
      } else {
        this._webviewReady = false;
      }
    });

    webviewView.onDidDispose(() => {
      this._view = undefined;
    });
  }

  private updateSession(): void {
    if (!this._view) return;
    const active = this.mgr.getActive();
    const newName = active?.projectName || null;
    const pending = this._pendingInput;
    if (pending) this._pendingInput = undefined;
    // Include draft for the new session (if switching)
    const draft = newName && this._lastSessionName && newName !== this._lastSessionName
      ? (this._drafts.get(newName) || '') : undefined;
    this._view.webview.postMessage({
      type: 'session',
      name: newName,
      previousSession: this._lastSessionName,
      pendingInput: pending,
      draft,
    });
    if (newName) this._lastSessionName = newName;
  }

  private updateHistory(): void {
    if (!this._view) return;
    this._view.webview.postMessage({
      type: 'history',
      items: this.mgr.getHistory(),
      mode: 'session',
    });
  }

  private updateConversation(): void {
    if (!this._view) return;
    const active = this.mgr.getActive();
    if (!active) return;
    const messages = this.getConversationHistory(active.projectPath);
    this._view.webview.postMessage({ type: 'conversation', messages });
  }

  private getConversationHistory(projectPath: string): Array<{role: string, text: string}> {
    const encoded = projectPath.replace(/\//g, '-');
    const dir = path.join(os.homedir(), '.claude', 'projects', encoded);
    try {
      if (!fs.existsSync(dir)) return [];
      const jsonlFiles = fs.readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (jsonlFiles.length === 0) return [];
      const content = fs.readFileSync(path.join(dir, jsonlFiles[0].name), 'utf8');
      const lines = content.trim().split('\n').filter(l => l.trim());
      const messages: Array<{role: string, text: string}> = [];
      for (const line of lines.slice(-50)) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'human' || obj.role === 'user') {
            const text = typeof obj.message === 'string' ? obj.message :
              (obj.message?.content ? (typeof obj.message.content === 'string' ? obj.message.content :
                obj.message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ')) : '');
            if (text) messages.push({ role: 'user', text });
          }
        } catch { /* skip malformed lines */ }
      }
      return messages.slice(-30);
    } catch {
      return [];
    }
  }

  public insertText(text: string): void {
    if (!this._view) return;
    this._view.show(true);
    this._view.webview.postMessage({ type: 'insertText', text });
  }

  private getSnippets(): Snippet[] {
    return this.mgr.context.globalState.get<Snippet[]>('snippets', []);
  }

  private saveSnippets(snippets: Snippet[]): void {
    this.mgr.context.globalState.update('snippets', snippets);
  }

  private async saveSnippet(text: string): Promise<void> {
    // Ask for content if not provided (e.g. "Nouveau snippet...")
    const content = await vscode.window.showInputBox({
      prompt: 'Contenu du snippet',
      value: text,
      placeHolder: 'ex: /effort max, npm run build, ...',
    });
    if (content === undefined) return; // cancelled
    const name = await vscode.window.showInputBox({ prompt: 'Nom du snippet', value: content.length > 40 ? content.substring(0, 40) + '...' : content, placeHolder: 'ex: deploy prod' });
    if (!name) return;
    const tagsStr = await vscode.window.showInputBox({ prompt: 'Tags (separes par virgule)', placeHolder: 'ex: deploy, prod, docker' });
    const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(Boolean) : [];
    const folder = await vscode.window.showInputBox({ prompt: 'Dossier (optionnel)', placeHolder: 'ex: DevOps' }) || '';
    const typeItems: (vscode.QuickPickItem & { value: SnippetType })[] = [
      { label: '$(terminal) Commande terminal', description: 'Commande shell a executer', value: 'command' },
      { label: '$(comment) Message Claude', description: 'Message a envoyer a Claude', value: 'message' },
    ];
    const typePick = await vscode.window.showQuickPick(typeItems, { placeHolder: 'Type de snippet' });
    if (!typePick) return;
    const snippets = this.getSnippets();
    snippets.push({ id: Date.now().toString(), name, command: content, tags, folder, type: typePick.value });
    this.saveSnippets(snippets);
    vscode.window.setStatusBarMessage('Snippet enregistre', 2000);
  }

  private async showSnippetsPicker(currentText?: string): Promise<void> {
    const snippets = this.getSnippets();
    const commands = snippets.filter(s => s.type === 'command');
    const messages = snippets.filter(s => s.type !== 'command');

    const items: (vscode.QuickPickItem & { action?: string })[] = [];

    if (commands.length > 0) {
      items.push({ label: `$(terminal) Commandes (${commands.length})`, action: 'commands' });
    }
    if (messages.length > 0) {
      items.push({ label: `$(comment) Messages (${messages.length})`, action: 'messages' });
    }

    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    if (currentText) {
      items.push({ label: '$(save) Enregistrer le texte actuel...', action: 'save' });
    }
    items.push({ label: '$(add) Nouveau snippet...', action: 'new' });
    items.push({ label: '$(trash) Supprimer un snippet...', action: 'delete' });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Snippets...',
    });
    if (!picked) return;

    if (picked.action === 'commands') {
      await this.showTypedSnippets('command', currentText);
    } else if (picked.action === 'messages') {
      await this.showTypedSnippets('message', currentText);
    } else if (picked.action === 'save') {
      await this.saveSnippet(currentText || '');
    } else if (picked.action === 'new') {
      await this.saveSnippet('');
    } else if (picked.action === 'delete') {
      const delItems = snippets.map(s => ({
        label: s.type === 'command' ? `$(terminal) ${s.name}` : `$(comment) ${s.name}`,
        description: s.tags.map(t => `#${t}`).join(' '),
        id: s.id,
      }));
      const toDel = await vscode.window.showQuickPick(delItems, { placeHolder: 'Supprimer quel snippet ?' });
      if (toDel) {
        this.saveSnippets(snippets.filter(s => s.id !== (toDel as any).id));
        vscode.window.setStatusBarMessage('Snippet supprime', 2000);
      }
    }
  }

  private async showTypedSnippets(type: 'command' | 'message', currentText?: string): Promise<void> {
    const snippets = this.getSnippets().filter(s => type === 'command' ? s.type === 'command' : s.type !== 'command');
    const icon = type === 'command' ? '$(terminal)' : '$(comment)';
    const label = type === 'command' ? 'Commandes' : 'Messages';

    const items: (vscode.QuickPickItem & { action?: string; snippet?: Snippet })[] = [];
    items.push({ label: '$(arrow-left) Retour', action: 'back' });

    for (const s of snippets) {
      items.push({
        label: `${icon} ${s.name}`,
        description: s.tags.length > 0 ? s.tags.map(t => `#${t}`).join(' ') : undefined,
        detail: s.command.length > 80 ? s.command.substring(0, 80) + '...' : s.command,
        snippet: s,
      });
    }

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `${label} — Rechercher...`,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked) return;

    if (picked.action === 'back') {
      return this.showSnippetsPicker(currentText);
    }
    if (picked.snippet) {
      this.insertText(picked.snippet.command);
    }
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
<style>
  * { box-sizing: border-box; }
  body { padding: 0; margin: 0; height: 100vh; display: flex; flex-direction: column;
    overflow: hidden; font-family: var(--vscode-font-family); font-size: 13px; }
  #session-label {
    padding: 6px 8px; flex-shrink: 0;
    font-size: 11px; color: var(--vscode-descriptionForeground);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
  }
  .session-selector { cursor: pointer; }
  .session-selector:hover { color: var(--vscode-foreground); }
  .session-selector .name { color: var(--vscode-foreground); font-weight: bold; }
  .session-selector .arrow { font-size: 10px; }
  #session-dropdown {
    position: absolute; z-index: 100; left: 8px; right: 8px; top: 28px;
    background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border);
    border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); max-height: 200px; overflow-y: auto;
  }
  .dd-item { padding: 4px 8px; cursor: pointer; font-size: 12px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dd-item:hover { background: var(--vscode-list-hoverBackground); }
  .dd-item.active { font-weight: bold; }
  .dd-sep { border-top: 1px solid var(--vscode-panel-border); margin: 2px 0; }
  #history { flex: 1; min-height: 25%; overflow-y: auto; padding: 4px 8px; }
  .msg-user, .msg-cmd {
    padding: 4px 8px; cursor: pointer; font-size: 12px; border-radius: 4px;
    margin: 2px 0; text-align: left;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    color: var(--vscode-foreground);
  }
  .msg-user {
    background: color-mix(in srgb, var(--vscode-button-background) 15%, transparent);
    border-left: 2px solid var(--vscode-button-background);
  }
  .msg-cmd {
    background: color-mix(in srgb, var(--vscode-input-background) 60%, transparent);
    border-left: 2px solid var(--vscode-panel-border, var(--vscode-input-border, #444));
  }
  .msg-user:hover, .msg-cmd:hover { background: var(--vscode-list-hoverBackground); }
  .msg-tag {
    font-size: 10px; color: var(--vscode-descriptionForeground);
    background: var(--vscode-badge-background); padding: 1px 4px; border-radius: 3px;
    margin-left: 4px;
  }
  .msg-wrap { clear: both; }
  #empty-state {
    padding: 16px 8px; text-align: center;
    color: var(--vscode-descriptionForeground); font-size: 12px; font-style: italic;
  }
  .input-area {
    flex-shrink: 0; display: flex; flex-direction: column;
    padding: 6px 8px; border-top: 1px solid var(--vscode-panel-border, transparent);
    position: relative;
  }
  #input-container { position: relative; }
  #input {
    width: 100%; resize: none; overflow-y: auto;
    padding: 6px 8px; font-size: 13px;
    background: var(--vscode-input-background);
    color: var(--vscode-editor-foreground, #000);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px; font-family: var(--vscode-editor-font-family);
  }
  #input:focus { outline: 1px solid var(--vscode-focusBorder); }
  #image-preview {
    display: none; align-items: center; gap: 4px; padding: 4px;
    background: var(--vscode-input-background); border-radius: 4px; margin-top: 4px;
    flex-shrink: 0;
  }
  #image-preview img { max-height: 50px; max-width: 80px; border-radius: 3px; cursor: pointer; }
  #image-preview img:hover { opacity: 0.8; }
  #image-overlay {
    display: none; position: fixed; inset: 0; z-index: 300;
    background: rgba(0,0,0,0.85); justify-content: center; align-items: center;
    cursor: pointer;
  }
  #image-overlay img {
    max-width: 95%; max-height: 95%; object-fit: contain; border-radius: 6px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.5);
  }
  #remove-img {
    background: none; border: none; color: var(--vscode-foreground);
    cursor: pointer; font-size: 12px; padding: 2px;
  }
  #attachments {
    display: flex; flex-wrap: wrap; gap: 3px; flex-shrink: 0;
  }
  #attachments:not(:empty) { padding-top: 3px; }
  .attachment {
    display: inline-flex; align-items: center; gap: 3px;
    padding: 1px 6px; background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground); border-radius: 3px; font-size: 11px;
    max-width: 100%; overflow: hidden;
  }
  .attachment .remove { cursor: pointer; opacity: 0.7; }
  .attachment .remove:hover { opacity: 1; }
  /* paste-toggle visibility controlled via JS inline style */
  .bottom-bar {
    display: flex; align-items: center; padding-top: 4px; flex-shrink: 0;
  }
  .bottom-bar .hint {
    font-size: 10px; color: var(--vscode-descriptionForeground);
  }
  .icon-btn {
    background: none; border: none; color: var(--vscode-descriptionForeground);
    cursor: pointer; padding: 3px 5px; border-radius: 3px;
    display: flex; align-items: center; justify-content: center;
  }
  .icon-btn:hover {
    color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground);
  }
  #drop-overlay {
    display: none; position: absolute; inset: 0; z-index: 50;
    background: color-mix(in srgb, var(--vscode-button-background) 10%, transparent);
    border: 2px dashed var(--vscode-button-background);
    border-radius: 4px; justify-content: center; align-items: center;
    font-size: 12px; color: var(--vscode-foreground); pointer-events: none;
  }
  .send-target {
    cursor: pointer; font-size: 10px; padding: 2px 6px; border-radius: 3px;
    color: var(--vscode-descriptionForeground); white-space: nowrap;
  }
  .send-target:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
  .send-target .target-name { font-weight: bold; color: var(--vscode-foreground); }
  #send-dropdown {
    position: absolute; z-index: 100; bottom: 30px; right: 8px;
    background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border);
    border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); max-height: 200px; overflow-y: auto;
    min-width: 120px;
  }
  #tooltip {
    display: none; position: fixed; z-index: 200;
    background: var(--vscode-editorHoverWidget-background, var(--vscode-dropdown-background));
    border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-dropdown-border));
    border-radius: 6px; padding: 10px 12px;
    width: 50%; max-height: 60vh; overflow-y: auto;
    font-size: 12px; color: var(--vscode-foreground);
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    pointer-events: auto; white-space: pre-wrap; word-wrap: break-word;
    line-height: 1.5;
  }
</style>
</head>
<body>
  <div id="session-label">
    <span class="session-selector" id="session-selector">
      Session: <span class="name" id="session-name">aucune</span> <span class="arrow">&#9662;</span>
    </span>
  </div>
  <div id="session-dropdown" style="display:none"></div>
  <div id="history">
    <div id="empty-state">Aucun historique pour cette session</div>
  </div>
  <div class="input-area">
    <div id="drop-overlay">Deposer des fichiers ici</div>
    <div id="input-container">
      <textarea id="input" placeholder="Message pour Claude..."></textarea>
    </div>
    <div id="image-preview">
      <img id="preview-img" />
      <button id="remove-img">&#10005;</button>
    </div>
    <div id="attachments"></div>
    <div class="bottom-bar">
      <button class="icon-btn" id="attach-btn" title="Joindre un fichier">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
      </button>
      <button class="icon-btn" id="snippets-btn" title="Commandes enregistrees">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>
      </button>
      <button class="icon-btn" id="paste-toggle" title="Voir le texte colle en entier" style="display:none">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
      </button>
      <span style="flex:1"></span>
      <span class="send-target" id="send-target" title="Changer la session cible">
        <span class="target-name" id="send-target-name">...</span> &#9662;
      </span>
      <span class="hint" style="margin-right:2px">Enter</span>
      <button class="icon-btn" id="send-btn" title="Envoyer (Enter)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>
      </button>
    </div>
    <div id="send-dropdown" style="display:none"></div>
  </div>
  <div id="tooltip"></div>
  <div id="image-overlay" style="display:none"><img id="overlay-img" /></div>
  <script>
    var vscode = acquireVsCodeApi();
    var input = document.getElementById('input');
    var sessionName = document.getElementById('session-name');
    var historyEl = document.getElementById('history');
    var sessionSelector = document.getElementById('session-selector');
    var dropdown = document.getElementById('session-dropdown');
    var imagePreview = document.getElementById('image-preview');
    var previewImg = document.getElementById('preview-img');
    var removeImgBtn = document.getElementById('remove-img');
    var tooltip = document.getElementById('tooltip');
    var attachmentsEl = document.getElementById('attachments');
    var dropOverlay = document.getElementById('drop-overlay');

    var sendTargetEl = document.getElementById('send-target');
    var sendTargetName = document.getElementById('send-target-name');
    var sendDropdown = document.getElementById('send-dropdown');
    var targetSessionName = null; // null means active session

    var pendingImage = null;
    var viewMode = 'active';
    var hoverTimer = null;
    var lastConvJson = '';
    var attachedFiles = [];
    var dragCounter = 0;
    var tooltipTarget = null;
    var pasteToggleBtn = document.getElementById('paste-toggle');
    var pasteCount = 0;
    var pastedTexts = {};
    var pasteExpanded = false;
    var PASTE_THRESHOLD = 300;

    function esc(s) { s = String(s || ''); return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

    function scrollToBottom() {
      requestAnimationFrame(function() { historyEl.scrollTop = historyEl.scrollHeight; });
    }

    function attachHistoryClicks() {
      historyEl.querySelectorAll('.msg-cmd, .msg-user').forEach(function(el) {
        el.addEventListener('click', function() {
          input.value = el.getAttribute('data-full') || el.textContent;
          input.focus();
        });
      });
    }

    function autoResize() {
      var sessionLabel = document.getElementById('session-label');
      var bottomBar = document.querySelector('.bottom-bar');
      var chrome = (sessionLabel ? sessionLabel.offsetHeight : 30)
        + (bottomBar ? bottomBar.offsetHeight : 28)
        + (imagePreview.style.display !== 'none' ? imagePreview.offsetHeight : 0)
        + (attachmentsEl.children.length > 0 ? attachmentsEl.offsetHeight : 0)
        + 24;
      var minH = Math.max(60, Math.floor(window.innerHeight * 0.5 - chrome));
      var maxH = Math.floor(window.innerHeight * 0.75 - chrome);
      input.style.height = '0';
      var contentH = input.scrollHeight;
      var h = Math.max(minH, Math.min(contentH, maxH));
      input.style.height = h + 'px';
      scrollToBottom();
    }
    // Set initial size after DOM renders
    requestAnimationFrame(autoResize);
    window.addEventListener('resize', autoResize);

    function updateEmptyState() {
      var existing = document.getElementById('empty-state');
      var hasItems = historyEl.querySelectorAll('.msg-user, .msg-cmd').length > 0;
      if (!hasItems) {
        if (!existing) {
          var el = document.createElement('div');
          el.id = 'empty-state';
          el.textContent = 'Aucun historique pour cette session';
          historyEl.appendChild(el);
        }
      } else if (existing) {
        existing.remove();
      }
    }

    function renderAttachments() {
      if (attachedFiles.length === 0) { attachmentsEl.innerHTML = ''; return; }
      attachmentsEl.innerHTML = attachedFiles.map(function(f, i) {
        var name = f.split('/').pop() || f;
        return '<span class="attachment">' + esc(name) +
          ' <span class="remove" data-idx="' + i + '">&#10005;</span></span>';
      }).join('');
      attachmentsEl.querySelectorAll('.remove').forEach(function(el) {
        el.addEventListener('click', function() {
          attachedFiles.splice(parseInt(el.dataset.idx), 1);
          renderAttachments();
        });
      });
    }

    function addAttachments(paths) {
      for (var i = 0; i < paths.length; i++) {
        if (attachedFiles.indexOf(paths[i]) === -1) attachedFiles.push(paths[i]);
      }
      renderAttachments();
    }

    function makePasteTag(num, text) {
      var lines = text.split('\\n').length;
      return '[Pasted text #' + num + ' +' + lines + 'lines]';
    }

    function updatePasteToggle() {
      var keys = Object.keys(pastedTexts);
      pasteToggleBtn.style.display = keys.length > 0 ? '' : 'none';
      if (keys.length === 0) { pasteExpanded = false; }
      pasteToggleBtn.title = pasteExpanded ? 'Remettre en extraits' : 'Voir le texte colle en entier';
    }

    function expandPastes() {
      var val = input.value;
      var keys = Object.keys(pastedTexts);
      for (var i = 0; i < keys.length; i++) {
        var num = parseInt(keys[i]);
        var tag = makePasteTag(num, pastedTexts[num]);
        val = val.replace(tag, pastedTexts[num]);
      }
      input.value = val;
      pasteExpanded = true;
      updatePasteToggle();
      autoResize();
    }

    function collapsePastes() {
      // Re-detect paste content in the text and rebuild tags
      var val = input.value.split(String.fromCharCode(13,10)).join(String.fromCharCode(10));
      var keys = Object.keys(pastedTexts);
      for (var i = 0; i < keys.length; i++) {
        var num = parseInt(keys[i]);
        var text = pastedTexts[num];
        var idx = val.indexOf(text);
        if (idx !== -1) {
          var tag = makePasteTag(num, text);
          val = val.substring(0, idx) + tag + val.substring(idx + text.length);
        }
      }
      input.value = val;
      pasteExpanded = false;
      updatePasteToggle();
      autoResize();
    }

    function send() {
      var text = input.value;
      // Replace paste tags with actual content
      text = text.replace(/\\[Pasted text #(\\d+) \\+\\d+lines\\]/g, function(match, num) {
        return pastedTexts[parseInt(num)] || match;
      });
      if (text.trim() || pendingImage || attachedFiles.length > 0) {
        var fullText = text.trim();
        if (attachedFiles.length > 0) {
          fullText = (fullText ? fullText + ' ' : '') + attachedFiles.join(' ');
        }
        var msg = { type: 'send', text: fullText, targetSession: targetSessionName };
        if (pendingImage) { msg.image = pendingImage; }
        vscode.postMessage(msg);
        input.value = '';
        input.placeholder = 'Message pour Claude...';
        pendingImage = null;
        pasteCount = 0;
        pastedTexts = {};
        pasteExpanded = false;
        pasteToggleBtn.style.display = 'none';
        attachedFiles = [];
        attachmentsEl.innerHTML = '';
        imagePreview.style.display = 'none';
        autoResize();
        input.focus();
        scrollToBottom();
      }
    }

    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      // Handle paste tag as atomic block — Backspace/Delete removes whole tag (collapsed mode only)
      if (!pasteExpanded && (e.key === 'Backspace' || e.key === 'Delete')) {
        var pos = e.key === 'Backspace' ? input.selectionStart : input.selectionEnd;
        var val = input.value;
        var tagPattern = /\\[Pasted text #(\\d+) \\+\\d+lines\\]/g;
        var m;
        while ((m = tagPattern.exec(val)) !== null) {
          var start = m.index;
          var end = start + m[0].length;
          if ((e.key === 'Backspace' && pos > start && pos <= end) ||
              (e.key === 'Delete' && pos >= start && pos < end)) {
            e.preventDefault();
            var num = parseInt(m[1]);
            input.value = val.substring(0, start) + val.substring(end);
            input.selectionStart = input.selectionEnd = start;
            delete pastedTexts[num];
            updatePasteToggle();
            autoResize();
            return;
          }
        }
      }
    });

    input.addEventListener('input', function() {
      autoResize();
      // Don't auto-delete pastedTexts entries — only atomic backspace/delete and send() clean up
      // This prevents the toggle button from disappearing when the user types
    });

    // Image + text paste
    input.addEventListener('paste', function(e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image/') === 0) {
          e.preventDefault();
          var blob = items[i].getAsFile();
          var reader = new FileReader();
          reader.onload = function() {
            pendingImage = reader.result;
            previewImg.src = pendingImage;
            imagePreview.style.display = 'flex';
          };
          reader.readAsDataURL(blob);
          return;
        }
      }
      // Text paste — check for file paths first, then collapse if long
      var clipText = e.clipboardData.getData('text');
      if (clipText) {
        // Detect pasted file paths (lines starting with /)
        var lines = clipText.trim().split('\\n');
        var allPaths = lines.length > 0 && lines.every(function(l) { return l.trim().match(/^\\/[^\\s]+$/); });
        if (allPaths && lines.length <= 20) {
          e.preventDefault();
          addAttachments(lines.map(function(l) { return l.trim(); }));
          return;
        }
        // Long text paste — insert tag, store content
        if (clipText.length > PASTE_THRESHOLD) {
          e.preventDefault();
          pasteCount++;
          var num = pasteCount;
          pastedTexts[num] = clipText.split(String.fromCharCode(13,10)).join(String.fromCharCode(10));
          var tag = makePasteTag(num, clipText);
          var start = input.selectionStart;
          var end = input.selectionEnd;
          var before = input.value.substring(0, start);
          var after = input.value.substring(end);
          input.value = before + tag + after;
          input.selectionStart = input.selectionEnd = start + tag.length;
          updatePasteToggle();
          autoResize();
        }
      }
    });

    removeImgBtn.addEventListener('click', function() {
      pendingImage = null; imagePreview.style.display = 'none';
    });

    // Click image to enlarge
    var overlay = document.getElementById('image-overlay');
    var overlayImg = document.getElementById('overlay-img');
    previewImg.addEventListener('click', function() {
      if (pendingImage) {
        overlayImg.src = pendingImage;
        overlay.style.display = 'flex';
      }
    });
    overlay.addEventListener('click', function() {
      overlay.style.display = 'none';
    });

    // Send & attach buttons
    document.getElementById('send-btn').addEventListener('click', send);
    document.getElementById('attach-btn').addEventListener('click', function() {
      vscode.postMessage({ type: 'attachFile' });
    });
    document.getElementById('snippets-btn').addEventListener('click', function() {
      vscode.postMessage({ type: 'openSnippets', text: input.value });
    });
    pasteToggleBtn.addEventListener('click', function() {
      if (pasteExpanded) { collapsePastes(); } else { expandPastes(); }
    });

    // Session selector dropdown
    sessionSelector.addEventListener('click', function() {
      if (dropdown.style.display === 'none') {
        vscode.postMessage({ type: 'getSessions' });
      } else { dropdown.style.display = 'none'; }
    });
    document.addEventListener('click', function(e) {
      if (!sessionSelector.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.style.display = 'none';
      }
    });

    // Send target selector
    sendTargetEl.addEventListener('click', function(e) {
      e.stopPropagation();
      if (sendDropdown.style.display === 'none') {
        vscode.postMessage({ type: 'getSendTargets' });
      } else {
        sendDropdown.style.display = 'none';
      }
    });
    document.addEventListener('click', function(e) {
      if (!sendTargetEl.contains(e.target) && !sendDropdown.contains(e.target)) {
        sendDropdown.style.display = 'none';
      }
    });

    // Hover preview — stays open when mouse enters tooltip
    historyEl.addEventListener('mouseover', function(e) {
      var item = e.target.closest('.msg-user, .msg-cmd');
      if (!item || !item.getAttribute('data-full')) return;
      if (tooltipTarget === item) return;
      tooltipTarget = item;
      if (hoverTimer) clearTimeout(hoverTimer);
      hoverTimer = setTimeout(function() {
        var full = item.getAttribute('data-full');
        if (!full || full.length < 30) return;
        tooltip.textContent = full;
        tooltip.style.display = 'block';
        var rect = item.getBoundingClientRect();
        var tooltipH = Math.min(tooltip.scrollHeight, window.innerHeight * 0.6);
        var top = rect.top + rect.height / 2 - tooltipH / 2;
        top = Math.max(4, Math.min(top, window.innerHeight - tooltipH - 4));
        tooltip.style.top = top + 'px';
        tooltip.style.left = '4px';
      }, 1250);
    });

    historyEl.addEventListener('mouseout', function(e) {
      if (tooltip.contains(e.relatedTarget)) return;
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
      tooltipTarget = null;
      tooltip.style.display = 'none';
    });

    tooltip.addEventListener('mouseleave', function() {
      tooltip.style.display = 'none';
      tooltipTarget = null;
    });

    // File drag and drop — listen on whole document body for maximum coverage
    document.body.addEventListener('dragenter', function(e) {
      e.preventDefault(); dragCounter++;
      dropOverlay.style.display = 'flex';
    });
    document.body.addEventListener('dragleave', function(e) {
      dragCounter--;
      if (dragCounter <= 0) { dragCounter = 0; dropOverlay.style.display = 'none'; }
    });
    document.body.addEventListener('dragover', function(e) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    document.body.addEventListener('drop', function(e) {
      e.preventDefault(); dragCounter = 0;
      dropOverlay.style.display = 'none';
      if (!e.dataTransfer) return;
      // Try all possible data formats
      var uriList = e.dataTransfer.getData('text/uri-list');
      if (!uriList) uriList = e.dataTransfer.getData('text/plain');
      if (uriList && (uriList.indexOf('file://') >= 0 || uriList.indexOf('/') === 0)) {
        var paths = uriList.split('\\n').filter(function(u) { return u.trim(); }).map(function(u) {
          u = u.trim();
          if (u.indexOf('file://') === 0) {
            try { return decodeURIComponent(new URL(u).pathname); } catch(ex) { return u; }
          }
          return u;
        }).filter(function(p) { return p.indexOf('/') === 0; });
        if (paths.length > 0) { addAttachments(paths); return; }
      }
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        var filePaths = [];
        for (var i = 0; i < e.dataTransfer.files.length; i++) {
          var f = e.dataTransfer.files[i];
          if (f.path) filePaths.push(f.path);
          else if (f.name) filePaths.push(f.name);
        }
        if (filePaths.length > 0) addAttachments(filePaths);
      }
    });

    // Auto-scroll observer — only scroll if user is already near the bottom
    function isNearBottom() {
      return historyEl.scrollHeight - historyEl.scrollTop - historyEl.clientHeight < 40;
    }
    var observer = new MutationObserver(function() {
      if (isNearBottom()) scrollToBottom();
    });
    observer.observe(historyEl, { childList: true, subtree: true });

    window.addEventListener('message', function(e) {
      var data = e.data;
      if (data.type === 'insertText' && data.text != null) {
        var iStart = input.selectionStart;
        var iEnd = input.selectionEnd;
        input.value = input.value.substring(0, iStart) + data.text + input.value.substring(iEnd);
        input.selectionStart = input.selectionEnd = iStart + data.text.length;
        input.focus();
        autoResize();
      } else if (data.type === 'session') {
        // Save draft of previous session before switching
        if (data.previousSession && data.draft !== undefined && data.previousSession !== data.name) {
          vscode.postMessage({ type: 'saveDraft', sessionName: data.previousSession, text: input.value });
          input.value = data.draft || '';
          autoResize();
        }
        sessionName.textContent = data.name || 'aucune';
        if (!targetSessionName) {
          sendTargetName.textContent = data.name || '...';
        }
        if (viewMode === 'active') {
          vscode.postMessage({ type: 'getSessionHistory', mode: 'active' });
        }
        // Piggyback: insert pending text into textarea
        if (data.pendingInput) {
          var pStart = input.selectionStart;
          var pEnd = input.selectionEnd;
          input.value = input.value.substring(0, pStart) + data.pendingInput + input.value.substring(pEnd);
          input.selectionStart = input.selectionEnd = pStart + data.pendingInput.length;
          input.focus();
          autoResize();
        }
      } else if (data.type === 'sessions') {
        dropdown.innerHTML = '';
        var allItem = document.createElement('div');
        allItem.className = 'dd-item' + (viewMode === 'all' ? ' active' : '');
        allItem.textContent = 'Toutes les sessions';
        allItem.addEventListener('click', function() {
          viewMode = 'all'; dropdown.style.display = 'none';
          sessionName.textContent = 'Toutes';
          vscode.postMessage({ type: 'getSessionHistory', mode: 'all' });
        });
        dropdown.appendChild(allItem);
        // Espaces actifs comme sections
        if (data.groups && data.groups.length > 0) {
          var espSep = document.createElement('div');
          espSep.className = 'dd-sep';
          dropdown.appendChild(espSep);
          data.groups.forEach(function(g) {
            var espItem = document.createElement('div');
            espItem.className = 'dd-item' + (g.focused ? ' active' : '');
            espItem.style.fontStyle = 'italic';
            espItem.textContent = g.name + (g.focused ? ' (focus)' : '');
            espItem.addEventListener('click', function() {
              viewMode = 'espace:' + g.id;
              sessionName.textContent = g.name;
              dropdown.style.display = 'none';
              vscode.postMessage({ type: 'getSessionHistory', mode: 'espace', groupId: g.id });
            });
            dropdown.appendChild(espItem);
          });
        }
        var sep = document.createElement('div');
        sep.className = 'dd-sep';
        dropdown.appendChild(sep);
        data.items.forEach(function(s) {
          var item = document.createElement('div');
          item.className = 'dd-item' + (s.active ? ' active' : '');
          var label = s.name + (s.active ? ' (actif)' : '');
          if (s.espaces && s.espaces.length > 0) label += ' [' + s.espaces.join(', ') + ']';
          item.textContent = label;
          item.addEventListener('click', function() {
            viewMode = s.active ? 'active' : s.path;
            sessionName.textContent = s.name;
            dropdown.style.display = 'none';
            if (s.active) {
              vscode.postMessage({ type: 'getSessionHistory', mode: 'active' });
            } else {
              vscode.postMessage({ type: 'getSessionHistory', mode: 'session', projectPath: s.path });
            }
          });
          dropdown.appendChild(item);
        });
        dropdown.style.display = 'block';
      } else if (data.type === 'history') {
        var isAll = data.mode === 'all';
        var raw = (data.items || []).slice(0, 20);
        var items = isAll ? raw : raw.reverse();
        var rawTags = data.tags ? data.tags.slice(0, 20) : null;
        var tags = isAll ? rawTags : (rawTags ? rawTags.reverse() : null);
        var cmdHtml = items.map(function(h, i) {
          var text = typeof h === 'object' ? h.text || h : h;
          var tag = tags ? '<span class="msg-tag">' + esc(tags[i] || '') + '</span>' : '';
          return '<div class="msg-wrap"><div class="msg-cmd" data-full="' + esc(text) + '">' +
            esc(text) + tag + '</div></div>';
        }).join('');
        var sepMark = '<!--cmd-history-->';
        var sepIdx = historyEl.innerHTML.indexOf(sepMark);
        var convHtml = sepIdx >= 0 ? historyEl.innerHTML.substring(0, sepIdx) : '';
        historyEl.innerHTML = convHtml + sepMark + cmdHtml;
        attachHistoryClicks();
        updateEmptyState();
        scrollToBottom();
      } else if (data.type === 'conversation') {
        var msgs = data.messages || [];
        var convJson = JSON.stringify(msgs);
        if (convJson === lastConvJson) return;
        lastConvJson = convJson;
        var convHtml = msgs.map(function(m) {
          return '<div class="msg-wrap"><div class="msg-user" data-full="' + esc(m.text) + '">' +
            esc(m.text) + '</div></div>';
        }).join('');
        var sepMark = '<!--cmd-history-->';
        var cmdIdx = historyEl.innerHTML.indexOf(sepMark);
        var cmdSection = cmdIdx >= 0 ? historyEl.innerHTML.substring(cmdIdx) : '';
        historyEl.innerHTML = convHtml + (cmdSection || sepMark);
        attachHistoryClicks();
        updateEmptyState();
        scrollToBottom();
      } else if (data.type === 'scrollToBottom') {
        scrollToBottom();
      } else if (data.type === 'attachedFiles') {
        addAttachments(data.paths);
      } else if (data.type === 'claudeSetInput') {
        // Legacy fallback — primary delivery is via 'session' pendingInput
        input.value = data.text;
        input.focus();
        autoResize();
      } else if (data.type === 'sendTargets') {
        sendDropdown.innerHTML = '';
        function addSessionItem(s) {
          var item = document.createElement('div');
          item.className = 'dd-item' + (s.active ? ' active' : '');
          item.textContent = s.name + (s.active ? ' (actif)' : '');
          item.addEventListener('click', function() {
            targetSessionName = s.active ? null : s.name;
            sendTargetName.textContent = s.name;
            sendDropdown.style.display = 'none';
          });
          sendDropdown.appendChild(item);
        }
        if (data.groups && data.groups.length > 0) {
          var shown = {};
          data.groups.forEach(function(g) {
            var espLabel = document.createElement('div');
            espLabel.className = 'dd-item';
            espLabel.style.fontWeight = 'bold';
            espLabel.style.fontSize = '10px';
            espLabel.style.color = 'var(--vscode-descriptionForeground)';
            espLabel.style.cursor = 'default';
            espLabel.textContent = g.name + (g.focused ? ' \\u25CF' : '');
            sendDropdown.appendChild(espLabel);
            data.items.filter(function(s) {
              return s.espaces && s.espaces.indexOf(g.name) >= 0;
            }).forEach(function(s) {
              shown[s.name] = true;
              addSessionItem(s);
            });
          });
          var orphans = data.items.filter(function(s) { return !shown[s.name]; });
          if (orphans.length > 0) {
            var sepEl = document.createElement('div');
            sepEl.className = 'dd-sep';
            sendDropdown.appendChild(sepEl);
            orphans.forEach(addSessionItem);
          }
        } else {
          data.items.forEach(addSessionItem);
        }
        sendDropdown.style.display = 'block';
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
