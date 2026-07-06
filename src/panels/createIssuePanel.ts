import * as vscode from 'vscode';
import { JiraService } from '../services/jiraService';
import { escapeAttribute, getNonce, getWebviewCsp } from '../utils/webview';

export class CreateIssuePanel {
  private static currentPanel: CreateIssuePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private jiraService: JiraService
  ) {
    this.panel = panel;
    this.update();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        if (message.command === 'create') {
          await this.handleCreate(message);
        }
      },
      null,
      this.disposables
    );
  }

  static show(extensionUri: vscode.Uri, jiraService: JiraService) {
    if (CreateIssuePanel.currentPanel) {
      CreateIssuePanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'jiraCreateIssue',
      'Create Jira Issue',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    CreateIssuePanel.currentPanel = new CreateIssuePanel(panel, jiraService);
  }

  private async handleCreate(message: { project?: string; summary?: string; description?: string; issueType?: string; priority?: string; labels?: string }) {
    const project = message.project?.trim();
    const summary = message.summary?.trim();
    const issueType = message.issueType?.trim();

    if (!project || !summary || !issueType) {
      vscode.window.showErrorMessage('Project, issue type, and summary are required.');
      return;
    }

    try {
      const result = await this.jiraService.createIssue({
        fields: {
          project: { key: project },
          summary,
          description: message.description?.trim() || undefined,
          issuetype: { name: issueType },
          priority: message.priority?.trim() ? { name: message.priority.trim() } : undefined,
          labels: message.labels ? message.labels.split(',').map((label: string) => label.trim()).filter(Boolean) : undefined,
        },
      });
      vscode.window.showInformationMessage(`Issue ${result.key} created successfully!`);
      vscode.commands.executeCommand('jira.refresh');
      this.panel.dispose();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to create issue: ${msg}`);
    }
  }

  private update() {
    const config = vscode.workspace.getConfiguration('jira');
    const defaultProject = config.get<string>('project', '');
    const nonce = getNonce();
    const csp = getWebviewCsp(this.panel.webview, nonce);

    this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 24px;
      max-width: 600px;
      margin: 0 auto;
    }
    h1 { font-size: 1.4em; margin-bottom: 20px; }
    .field { margin-bottom: 16px; }
    label {
      display: block;
      font-weight: 600;
      margin-bottom: 4px;
      font-size: 0.9em;
    }
    input, select, textarea {
      width: 100%;
      padding: 8px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      font-family: inherit;
      font-size: inherit;
      box-sizing: border-box;
    }
    textarea { min-height: 120px; resize: vertical; }
    button {
      padding: 8px 20px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 1em;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      margin-top: 8px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .required::after { content: ' *'; color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <h1>Create Jira Issue</h1>

  <div class="field">
    <label class="required">Project Key</label>
    <input type="text" id="project" value="${escapeAttribute(defaultProject)}" placeholder="e.g., PROJ" />
  </div>

  <div class="field">
    <label class="required">Issue Type</label>
    <select id="issueType">
      <option value="Task">Task</option>
      <option value="Bug">Bug</option>
      <option value="Story">Story</option>
      <option value="Epic">Epic</option>
      <option value="Sub-task">Sub-task</option>
    </select>
  </div>

  <div class="field">
    <label class="required">Summary</label>
    <input type="text" id="summary" placeholder="Brief issue summary" />
  </div>

  <div class="field">
    <label>Description</label>
    <textarea id="description" placeholder="Detailed description..."></textarea>
  </div>

  <div class="field">
    <label>Priority</label>
    <select id="priority">
      <option value="">Default</option>
      <option value="Highest">Highest</option>
      <option value="High">High</option>
      <option value="Medium">Medium</option>
      <option value="Low">Low</option>
      <option value="Lowest">Lowest</option>
    </select>
  </div>

  <div class="field">
    <label>Labels (comma-separated)</label>
    <input type="text" id="labels" placeholder="label1, label2" />
  </div>

  <button id="createIssueButton" type="button">Create Issue</button>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    function createIssue() {
      const project = document.getElementById('project').value.trim();
      const summary = document.getElementById('summary').value.trim();
      const description = document.getElementById('description').value.trim();
      const issueType = document.getElementById('issueType').value;
      const priority = document.getElementById('priority').value;
      const labels = document.getElementById('labels').value.trim();

      if (!project || !summary) {
        alert('Project and Summary are required.');
        return;
      }

      vscode.postMessage({
        command: 'create',
        project,
        summary,
        description,
        issueType,
        priority,
        labels
      });
    }

    document.getElementById('createIssueButton').addEventListener('click', createIssue);
  </script>
</body>
</html>`;
  }

  private dispose() {
    CreateIssuePanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
