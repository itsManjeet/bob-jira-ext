import * as vscode from 'vscode';
import { JiraIssue, SprintInfo } from '../models/jiraTypes';
import { JiraService } from '../services/jiraService';
import { escapeAttribute, escapeHtml, getNonce, getWebviewCsp } from '../utils/webview';

export class JiraIssueProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'jiraIssues';

  private _view?: vscode.WebviewView;
  private refreshVersion = 0;

  constructor(private jiraService: JiraService) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case 'openIssue':
          vscode.commands.executeCommand('jira.openIssue', message.issueKey);
          break;
        case 'refresh':
          this.refresh();
          break;
        case 'configure':
          vscode.commands.executeCommand('jira.configure');
          break;
      }
    });

    this.refresh();
  }

  async refresh() {
    if (!this._view) { return; }

    const refreshVersion = ++this.refreshVersion;

    if (!this.jiraService.isConfigured()) {
      this._view.webview.html = this.getNotConfiguredHtml();
      return;
    }

    this._view.webview.html = this.getLoadingHtml();

    try {
      const { issues, sprint } = await this.jiraService.getSprintData();
      if (refreshVersion !== this.refreshVersion || !this._view) { return; }
      this._view.webview.html = this.getHtml(issues, issues.length > 0 ? sprint : null);
    } catch (error) {
      if (refreshVersion !== this.refreshVersion || !this._view) { return; }
      const message = error instanceof Error ? error.message : 'Unknown error';
      this._view.webview.html = this.getErrorHtml(message);
    }
  }

  private getStatusIcon(status: string): { icon: string; color: string } {
    const lower = status.toLowerCase();
    if (lower.includes('done') || lower.includes('closed') || lower.includes('resolved')) {
      return { icon: '✓', color: '#4caf50' };
    }
    if (lower.includes('progress')) {
      return { icon: '◉', color: '#ff9800' };
    }
    if (lower.includes('review')) {
      return { icon: '◎', color: '#9c27b0' };
    }
    return { icon: '○', color: '#2196f3' };
  }

  private getPriorityIcon(priority: string): string {
    const lower = priority.toLowerCase();
    if (lower.includes('highest') || lower.includes('critical')) { return '⬆⬆'; }
    if (lower.includes('high')) { return '⬆'; }
    if (lower.includes('medium')) { return '—'; }
    if (lower.includes('low')) { return '⬇'; }
    if (lower.includes('lowest')) { return '⬇⬇'; }
    return '—';
  }

  private getSprintHeaderHtml(sprint: SprintInfo): string {
    const pct = sprint.pointsTotal > 0
      ? Math.min(100, Math.round((sprint.pointsCompleted / sprint.pointsTotal) * 100))
      : 0;

    const metaParts: string[] = [];
    if (sprint.daysLeft >= 0) {
      metaParts.push(`<span class="sprint-days">${sprint.daysLeft === 1 ? '1 day left' : `${sprint.daysLeft} days left`}</span>`);
    }
    if (sprint.endDate) {
      metaParts.push(`<span class="sprint-end">ends ${escapeHtml(new Date(sprint.endDate).toLocaleDateString())}</span>`);
    }
    const metaHtml = metaParts.join('<span class="sprint-sep">·</span>');

    return `
      <div class="sprint-header">
        <div class="sprint-name">${escapeHtml(sprint.name)}</div>
        ${metaHtml ? `<div class="sprint-meta">${metaHtml}</div>` : ''}
        <div class="sprint-progress">
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${pct}%;"></div>
          </div>
          <div class="progress-label">
            ${escapeHtml(sprint.pointsCompleted)} / ${escapeHtml(sprint.pointsTotal)} pts completed (${escapeHtml(pct)}%)
            <span class="sprint-sep">·</span>
            ${escapeHtml(sprint.pointsTotal)} pts assigned
          </div>
        </div>
      </div>`;
  }

  private getHtml(issues: JiraIssue[], sprint: SprintInfo | null): string {
    if (!this._view) { return ''; }

    const nonce = getNonce();
    const csp = getWebviewCsp(this._view.webview, nonce);
    const cards = issues.map((issue) => {
      const status = this.getStatusIcon(issue.fields.status.name);
      const priority = this.getPriorityIcon(issue.fields.priority.name);
      const pts = this.jiraService.getStoryPoints(issue);
      return `
        <div class="card" role="button" tabindex="0" data-command="openIssue" data-issue-key="${escapeAttribute(issue.key)}">
          <div class="card-head">
            <span class="issue-key">${escapeHtml(issue.key)}</span>
            <span class="issue-type">${escapeHtml(issue.fields.issuetype.name)}</span>
          </div>
          <div class="card-title">${escapeHtml(issue.fields.summary)}</div>
          <div class="card-footer">
            <div class="card-meta">
              <span class="meta-pill priority-pill">${escapeHtml(priority)} ${escapeHtml(issue.fields.priority.name)}</span>
              <span class="meta-pill status-pill">
                <span class="status-dot" style="background:${status.color};"></span>
                ${escapeHtml(issue.fields.status.name)}
              </span>
            </div>
            <span class="pts-badge" title="Sprint points assigned">${escapeHtml(pts)} pts</span>
          </div>
        </div>`;
    }).join('');

    const headerHtml = sprint && sprint.issueCount > 0 ? this.getSprintHeaderHtml(sprint) : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      padding: 8px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }
    * { box-sizing: border-box; }
    .card {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
      padding: 12px;
      margin-bottom: 8px;
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 90%, transparent);
      border: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.2));
      border-radius: 10px;
      color: inherit;
      cursor: pointer;
      font: inherit;
      text-align: left;
      transition: border-color 0.12s ease, background 0.12s ease, transform 0.12s ease;
      overflow: hidden;
    }
    .card:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: var(--vscode-focusBorder);
      transform: translateY(-1px);
    }
    .card:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    .card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    .issue-key {
      display: inline-flex;
      align-items: center;
      min-width: 0;
      max-width: 55%;
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.02em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .issue-type {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .card-title {
      display: -webkit-box;
      font-weight: 600;
      font-size: 13px;
      line-height: 1.35;
      color: var(--vscode-foreground);
      overflow: hidden;
      text-overflow: ellipsis;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      min-height: calc(1.35em * 2);
    }
    .card-footer {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
      flex-wrap: wrap;
    }
    .card-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
      flex: 1;
    }
    .meta-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      max-width: 100%;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.2));
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 60%, transparent);
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      line-height: 1.5;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .status-pill {
      color: var(--vscode-foreground);
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .pts-badge {
      min-width: 54px;
      height: 24px;
      padding: 0 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      margin-left: auto;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      white-space: nowrap;
    }
    .empty {
      text-align: center;
      padding: 24px 12px;
      color: var(--vscode-descriptionForeground);
    }
    .empty p { margin: 8px 0; }
    .sprint-header {
      padding: 12px;
      margin-bottom: 8px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border, transparent);
      border-radius: 6px;
      border-left: 3px solid var(--vscode-textLink-foreground);
    }
    .sprint-name {
      font-weight: 700;
      font-size: 13px;
      margin-bottom: 4px;
    }
    .sprint-meta {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }
    .sprint-sep { margin: 0 4px; opacity: 0.5; }
    .sprint-days { font-weight: 600; }
    .progress-bar {
      height: 6px;
      background: var(--vscode-progressBar-background, #333);
      border-radius: 3px;
      overflow: hidden;
      margin-bottom: 4px;
    }
    .progress-fill {
      height: 100%;
      background: var(--vscode-textLink-foreground);
      border-radius: 3px;
      transition: width 0.3s;
    }
    .progress-label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  ${headerHtml}
  ${issues.length > 0 ? cards : '<div class="empty"><p>No issues found</p><p>Issues assigned to you will appear here</p></div>'}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', (event) => {
      const target = event.target.closest('[data-command]');
      if (!target) { return; }
      const command = target.dataset.command;
      if (command === 'openIssue') {
        vscode.postMessage({ command: 'openIssue', issueKey: target.dataset.issueKey });
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') { return; }
      const target = event.target.closest('[data-command="openIssue"]');
      if (!target || event.target.closest('button')) { return; }
      event.preventDefault();
      vscode.postMessage({ command: 'openIssue', issueKey: target.dataset.issueKey });
    });
  </script>
</body>
</html>`;
  }

  private getLoadingHtml(): string {
    if (!this._view) { return ''; }

    const nonce = getNonce();
    const csp = getWebviewCsp(this._view.webview, nonce);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      padding: 16px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-sideBar-background);
    }
    .loading-card {
      padding: 12px;
      border-radius: 6px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border, transparent);
    }
  </style>
</head>
<body>
  <div class="loading-card">Loading Jira issues…</div>
</body>
</html>`;
  }

  private getNotConfiguredHtml(): string {
    if (!this._view) { return ''; }

    const nonce = getNonce();
    const csp = getWebviewCsp(this._view.webview, nonce);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px 16px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }
    .welcome-logo {
      text-align: center;
      font-size: 40px;
      margin-bottom: 16px;
      line-height: 1;
    }
    .welcome-title {
      text-align: center;
      font-size: 15px;
      font-weight: 700;
      margin-bottom: 6px;
    }
    .welcome-sub {
      text-align: center;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 24px;
      line-height: 1.5;
    }
    .steps {
      list-style: none;
      padding: 0;
      margin: 0 0 24px 0;
    }
    .step {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 12px;
      margin-bottom: 6px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border, transparent);
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.4;
    }
    .step-num {
      flex-shrink: 0;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: var(--vscode-textLink-foreground);
      color: var(--vscode-editor-background);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 700;
    }
    .step-text { color: var(--vscode-foreground); }
    .step-text strong { display: block; margin-bottom: 2px; }
    .step-text span { color: var(--vscode-descriptionForeground); }
    .configure-btn {
      display: block;
      width: 100%;
      padding: 8px 16px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
    }
    .configure-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .hint {
      margin-top: 14px;
      text-align: center;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    code {
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 11px;
    }
  </style>
</head>
<body>
  <div class="welcome-logo">&#x1F4CB;</div>
  <div class="welcome-title">Jira Manager</div>
  <div class="welcome-sub">Connect your Jira workspace to manage<br>issues without leaving VS Code.</div>

  <ul class="steps">
    <li class="step">
      <div class="step-num">1</div>
      <div class="step-text">
        <strong>Set your Jira URL</strong>
        <span>e.g. https://your-domain.atlassian.net</span>
      </div>
    </li>
    <li class="step">
      <div class="step-num">2</div>
      <div class="step-text">
        <strong>Add your username &amp; API token</strong>
        <span>Generate at id.atlassian.com/manage-profile/security/api-tokens</span>
      </div>
    </li>
    <li class="step">
      <div class="step-num">3</div>
      <div class="step-text">
        <strong>Set your default project key</strong>
        <span>e.g. MYPROJ — issues assigned to you will appear here</span>
      </div>
    </li>
  </ul>

  <button class="configure-btn" type="button" data-command="configure">Configure Jira Connection</button>
  <div class="hint">Or run <code>Jira: Configure Jira Connection</code> from the Command Palette</div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelector('[data-command="configure"]').addEventListener('click', () => {
      vscode.postMessage({ command: 'configure' });
    });
  </script>
</body>
</html>`;
  }

  private getErrorHtml(message: string): string {
    if (!this._view) { return ''; }

    const nonce = getNonce();
    const csp = getWebviewCsp(this._view.webview, nonce);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
  <style>
    body {
      margin: 0; padding: 24px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      text-align: center;
    }
    .error { color: var(--vscode-errorForeground); }
    button {
      margin-top: 12px; padding: 6px 14px; border: none; border-radius: 4px; cursor: pointer;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    }
  </style>
</head>
<body>
  <p class="error">${escapeHtml(message)}</p>
  <button type="button" data-command="refresh">Retry</button>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelector('[data-command="refresh"]').addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });
  </script>
</body>
</html>`;
  }
}
