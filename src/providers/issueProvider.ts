import * as vscode from 'vscode';
import { JiraIssue, SprintInfo } from '../models/jiraTypes';
import { JiraService } from '../services/jiraService';

export class JiraIssueProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'jiraIssues';

  private _view?: vscode.WebviewView;

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

    if (!this.jiraService.isConfigured()) {
      this._view.webview.html = this.getNotConfiguredHtml();
      return;
    }

    try {
      const { issues, sprint } = await this.jiraService.getSprintData();
      this._view.webview.html = this.getHtml(issues, issues.length > 0 ? sprint : null);
    } catch (error) {
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
    const pct = sprint.pointsTotal > 0 ? Math.round((sprint.pointsCompleted / sprint.pointsTotal) * 100) : 0;

    let metaParts: string[] = [];
    if (sprint.daysLeft >= 0) {
      metaParts.push(`<span class="sprint-days">${sprint.daysLeft === 1 ? '1 day left' : `${sprint.daysLeft} days left`}</span>`);
    }
    if (sprint.endDate) {
      metaParts.push(`<span class="sprint-end">ends ${new Date(sprint.endDate).toLocaleDateString()}</span>`);
    }
    const metaHtml = metaParts.join('<span class="sprint-sep">·</span>');

    return `
      <div class="sprint-header">
        <div class="sprint-name">${this.escapeHtml(sprint.name)}</div>
        ${metaHtml ? `<div class="sprint-meta">${metaHtml}</div>` : ''}
        <div class="sprint-progress">
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${pct}%;"></div>
          </div>
          <div class="progress-label">${sprint.pointsCompleted} / ${sprint.pointsTotal} pts completed</div>
        </div>
      </div>`;
  }

  private getHtml(issues: JiraIssue[], sprint: SprintInfo | null): string {
    const cards = issues.map((issue) => {
      const status = this.getStatusIcon(issue.fields.status.name);
      const priority = this.getPriorityIcon(issue.fields.priority.name);
      const pts = this.jiraService.getStoryPoints(issue);
      const ptsLabel = pts > 0 ? `<span class="pts">${pts} pts</span>` : '';
      return `
        <div class="card" onclick="openIssue('${issue.key}')">
          <div class="card-icon" style="color: ${status.color};">${status.icon}</div>
          <div class="card-content">
            <div class="card-title">${this.escapeHtml(issue.fields.summary)}</div>
            <div class="card-subtitle">
              <span class="key">${issue.key}</span>
              <span class="sep">·</span>
              <span class="type">${issue.fields.issuetype.name}</span>
              <span class="sep">·</span>
              <span class="priority">${priority} ${issue.fields.priority.name}</span>
              <span class="sep">·</span>
              <span class="status">${issue.fields.status.name}</span>
              ${ptsLabel}
            </div>
          </div>
        </div>`;
    }).join('');

    const headerHtml = sprint ? this.getSprintHeaderHtml(sprint) : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
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
    .card {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 12px;
      margin-bottom: 6px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border, transparent);
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.1s;
    }
    .card:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .card-icon {
      font-size: 18px;
      line-height: 1;
      flex-shrink: 0;
      margin-top: 2px;
    }
    .card-content {
      flex: 1;
      min-width: 0;
    }
    .card-title {
      font-weight: 600;
      font-size: 13px;
      line-height: 1.3;
      margin-bottom: 3px;
      color: var(--vscode-foreground);
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }
    .card-subtitle {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
    }
    .card-subtitle .key {
      font-weight: 600;
      color: var(--vscode-textLink-foreground);
    }
    .card-subtitle .sep {
      margin: 0 4px;
      opacity: 0.5;
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
    .sprint-progress { }
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
    .card-subtitle .pts {
      margin-left: 6px;
      padding: 1px 5px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 8px;
      font-size: 10px;
      font-weight: 600;
    }
  </style>
</head>
<body>
  ${headerHtml}
  ${issues.length > 0 ? cards : '<div class="empty"><p>No issues found</p><p>Issues assigned to you will appear here</p></div>'}
  <script>
    const vscode = acquireVsCodeApi();
    function openIssue(key) {
      vscode.postMessage({ command: 'openIssue', issueKey: key });
    }
  </script>
</body>
</html>`;
  }

  private getNotConfiguredHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
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

  <button class="configure-btn" onclick="configure()">Configure Jira Connection</button>
  <div class="hint">Or run <code>Jira: Configure Jira Connection</code> from the Command Palette</div>

  <script>
    const vscode = acquireVsCodeApi();
    function configure() {
      vscode.postMessage({ command: 'configure' });
    }
  </script>
</body>
</html>`;
  }

  private getErrorHtml(message: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
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
  <p class="error">${this.escapeHtml(message)}</p>
  <button onclick="vscode.postMessage({command:'refresh'})">Retry</button>
  <script>const vscode = acquireVsCodeApi();</script>
</body>
</html>`;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
