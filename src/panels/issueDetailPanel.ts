import * as vscode from 'vscode';
import { JiraIssue } from '../models/jiraTypes';
import { JiraService } from '../services/jiraService';

export class IssueDetailPanel {
  public static currentPanel: IssueDetailPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private issue: JiraIssue,
    private jiraService: JiraService
  ) {
    this.panel = panel;
    this.update();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'updateStatus':
            await this.handleStatusUpdate(message.issueKey);
            break;
          case 'addComment':
            await this.handleAddComment(message.issueKey, message.body);
            break;
          case 'updateSummary':
            await this.handleUpdateSummary(message.issueKey, message.summary);
            break;
          case 'updateDescription':
            await this.handleUpdateDescription(message.issueKey, message.description);
            break;
          case 'toggleSubtask':
            await this.handleToggleSubtask(message.subtaskKey, message.done);
            break;
          case 'addSubtask':
            await this.handleAddSubtask(message.issueKey, message.summary);
            break;
          case 'close':
            await this.handleClose(message.issueKey);
            break;
        }
      },
      null,
      this.disposables
    );
  }

  static show(
    extensionUri: vscode.Uri,
    issue: JiraIssue,
    jiraService: JiraService
  ) {
    const column = vscode.ViewColumn.One;

    if (IssueDetailPanel.currentPanel) {
      IssueDetailPanel.currentPanel.issue = issue;
      IssueDetailPanel.currentPanel.panel.reveal(column);
      IssueDetailPanel.currentPanel.update();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'jiraIssueDetail',
      `Jira: ${issue.key}`,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    IssueDetailPanel.currentPanel = new IssueDetailPanel(panel, issue, jiraService);
  }

  private async handleStatusUpdate(issueKey: string) {
    try {
      const transitions = await this.jiraService.getTransitions(issueKey);
      const selected = await vscode.window.showQuickPick(
        transitions.map((t) => ({ label: t.name, id: t.id })),
        { placeHolder: 'Select new status' }
      );
      if (selected) {
        await this.jiraService.transitionIssue(issueKey, selected.id);
        vscode.window.showInformationMessage(`Issue ${issueKey} moved to "${selected.label}"`);
        this.issue = await this.jiraService.getIssue(issueKey);
        this.update();
        vscode.commands.executeCommand('jira.refresh');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to update status: ${msg}`);
    }
  }

  private async handleAddComment(issueKey: string, body: string) {
    try {
      await this.jiraService.addComment(issueKey, body);
      vscode.window.showInformationMessage(`Comment added to ${issueKey}`);
      this.issue = await this.jiraService.getIssue(issueKey);
      this.update();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to add comment: ${msg}`);
    }
  }

  private async handleUpdateSummary(issueKey: string, summary: string) {
    try {
      await this.jiraService.updateIssue(issueKey, { summary } as any);
      vscode.window.showInformationMessage(`Issue ${issueKey} updated`);
      this.issue = await this.jiraService.getIssue(issueKey);
      this.update();
      vscode.commands.executeCommand('jira.refresh');
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to update issue: ${msg}`);
    }
  }

  private async handleUpdateDescription(issueKey: string, description: string) {
    try {
      await this.jiraService.updateIssue(issueKey, { description } as any);
      vscode.window.showInformationMessage(`Description updated for ${issueKey}`);
      this.issue = await this.jiraService.getIssue(issueKey);
      this.update();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to update description: ${msg}`);
    }
  }

  private async handleAddSubtask(parentKey: string, summary: string) {
    try {
      const issue = this.issue;
      // Find the subtask issue type for this project
      const subtaskType = await this.jiraService.getSubtaskIssueType(issue.fields.project.key);
      await this.jiraService.createIssue({
        fields: {
          project: { key: issue.fields.project.key },
          summary,
          issuetype: { id: subtaskType.id },
          parent: { key: parentKey },
        },
      } as any);
      vscode.window.showInformationMessage(`Subtask added to ${parentKey}`);
      this.issue = await this.jiraService.getIssue(parentKey);
      this.update();
      vscode.commands.executeCommand('jira.refresh');
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to create subtask: ${msg}`);
    }
  }

  private async handleToggleSubtask(subtaskKey: string, done: boolean) {
    try {
      const transitions = await this.jiraService.getTransitions(subtaskKey);
      let target: any;
      if (done) {
        target = transitions.find(
          (t) => t.name.toLowerCase().includes('done') ||
                 t.name.toLowerCase().includes('close') ||
                 t.name.toLowerCase().includes('resolve')
        );
      } else {
        target = transitions.find(
          (t) => t.name.toLowerCase().includes('to do') ||
                 t.name.toLowerCase().includes('open') ||
                 t.name.toLowerCase().includes('reopen') ||
                 t.name.toLowerCase().includes('backlog')
        );
      }
      if (target) {
        await this.jiraService.transitionIssue(subtaskKey, target.id);
        this.issue = await this.jiraService.getIssue(this.issue.key);
        this.update();
        vscode.commands.executeCommand('jira.refresh');
      } else {
        vscode.window.showWarningMessage(`No suitable transition found for ${subtaskKey}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to update subtask: ${msg}`);
    }
  }

  private async handleClose(issueKey: string) {
    try {
      const transitions = await this.jiraService.getTransitions(issueKey);
      const closeTransition = transitions.find(
        (t) =>
          t.name.toLowerCase().includes('done') ||
          t.name.toLowerCase().includes('close') ||
          t.name.toLowerCase().includes('resolve')
      );
      if (closeTransition) {
        await this.jiraService.transitionIssue(issueKey, closeTransition.id);
        vscode.window.showInformationMessage(`Issue ${issueKey} closed`);
        this.issue = await this.jiraService.getIssue(issueKey);
        this.update();
        vscode.commands.executeCommand('jira.refresh');
      } else {
        vscode.window.showWarningMessage('No close/done transition available for this issue.');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to close issue: ${msg}`);
    }
  }

  private update() {
    this.panel.title = `Jira: ${this.issue.key}`;
    this.panel.webview.html = this.getHtml();
  }

  private getHtml(): string {
    const issue = this.issue;
    const comments = issue.fields.comment?.comments || [];
    const subtasks = issue.fields.subtasks || [];

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px 24px;
      line-height: 1.6;
      max-width: 800px;
      margin: 0 auto;
    }

    /* Summary row */
    .summary-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }
    .summary-row h1 {
      margin: 0;
      font-size: 1.3em;
      flex: 1;
      line-height: 1.3;
    }
    .summary-row .edit-btn {
      opacity: 0.5;
      cursor: pointer;
      font-size: 16px;
      flex-shrink: 0;
    }
    .summary-row .edit-btn:hover { opacity: 1; }
    .summary-input {
      display: none;
      flex: 1;
    }
    .summary-input input {
      width: 100%;
      padding: 6px 10px;
      font-size: 1.3em;
      font-weight: 700;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      font-family: inherit;
    }
    .summary-input button {
      margin-top: 6px;
      margin-right: 4px;
    }

    /* Pills bar */
    .pills-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      padding: 3px 10px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .pill.priority { background: #5c4d9a; color: #e8e0ff; }
    .pill.project { background: #1a6b47; color: #d4f5e6; }
    .pill.type { background: #4a4a4a; color: #ddd; }
    .status-select {
      padding: 3px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      cursor: pointer;
      appearance: none;
      -webkit-appearance: none;
      padding-right: 20px;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 6px center;
    }

    /* Description section */
    .section {
      margin-bottom: 20px;
    }
    .section-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .section-header h2 {
      margin: 0;
      font-size: 0.9em;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.7;
    }
    .section-header .edit-btn {
      opacity: 0.4;
      cursor: pointer;
      font-size: 14px;
    }
    .section-header .edit-btn:hover { opacity: 1; }
    .description {
      white-space: pre-wrap;
      padding: 12px;
      border-radius: 6px;
      background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textBlockQuote-border);
      font-size: 13px;
    }
    .desc-edit {
      display: none;
    }
    .desc-edit textarea {
      width: 100%;
      min-height: 120px;
      padding: 10px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      font-family: inherit;
      font-size: inherit;
      resize: vertical;
    }
    .desc-edit button { margin-top: 6px; margin-right: 4px; }

    /* Comments */
    .comment {
      margin-bottom: 10px;
      padding: 10px 12px;
      background: var(--vscode-editorWidget-background);
      border-radius: 6px;
      border: 1px solid var(--vscode-widget-border, transparent);
    }
    .comment-header {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 4px;
    }
    .comment-author { font-weight: 600; font-size: 12px; }
    .comment-date { font-size: 11px; opacity: 0.6; }
    .comment-body { font-size: 13px; white-space: pre-wrap; }
    .comment-form textarea {
      width: 100%;
      min-height: 70px;
      padding: 10px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      font-family: inherit;
      font-size: inherit;
      resize: vertical;
    }
    .comment-form button { margin-top: 6px; }

    /* Subtasks */
    .subtask-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .subtask-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 13px;
    }
    .subtask-item:last-child { border-bottom: none; }
    .subtask-item input[type="checkbox"] {
      width: 16px;
      height: 16px;
      cursor: pointer;
      accent-color: var(--vscode-textLink-foreground);
    }
    .subtask-item .subtask-text { flex: 1; }
    .subtask-item .subtask-text.done {
      text-decoration: line-through;
      opacity: 0.6;
    }
    .subtask-item .subtask-key {
      font-size: 11px;
      opacity: 0.5;
      font-family: monospace;
    }
    .subtask-progress {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 8px;
    }
    .add-subtask {
      display: flex;
      gap: 6px;
      margin-top: 10px;
    }
    .add-subtask input {
      flex: 1;
      padding: 6px 10px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      font-family: inherit;
      font-size: 12px;
    }

    /* Shared */
    button {
      padding: 5px 12px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .key-label {
      font-size: 12px;
      opacity: 0.6;
      margin-bottom: 4px;
    }
    .divider {
      border: none;
      border-top: 1px solid var(--vscode-panel-border);
      margin: 16px 0;
    }
  </style>
</head>
<body>
  <div class="key-label">${issue.key}</div>

  <!-- Summary -->
  <div class="summary-row" id="summaryDisplay">
    <h1 id="summaryText">${this.escapeHtml(issue.fields.summary)}</h1>
    <span class="edit-btn" onclick="showSummaryEdit()" title="Edit summary">✎</span>
  </div>
  <div class="summary-input" id="summaryEdit">
    <input type="text" id="summaryInput" value="${this.escapeHtml(issue.fields.summary)}" />
    <button onclick="saveSummary()">Save</button>
    <button class="secondary" onclick="cancelSummaryEdit()">Cancel</button>
  </div>

  <!-- Status & Pills -->
  <div class="pills-bar">
    <select class="status-select" onchange="changeStatus(this.value)" id="statusSelect">
      <option selected disabled>${issue.fields.status.name}</option>
    </select>
    <span class="pill priority"># ${issue.fields.priority.name}</span>
    <span class="pill project"># ${issue.fields.project.key}</span>
    <span class="pill type">${issue.fields.issuetype.name}</span>
  </div>

  <hr class="divider" />

  <!-- Description -->
  <div class="section">
    <div class="section-header">
      <h2>Description</h2>
      <span class="edit-btn" onclick="showDescEdit()" title="Edit description">✎</span>
    </div>
    <div class="description" id="descDisplay">${issue.fields.description ? this.escapeHtml(issue.fields.description) : '<em style="opacity:0.5;">No description</em>'}</div>
    <div class="desc-edit" id="descEdit">
      <textarea id="descInput">${issue.fields.description ? this.escapeHtml(issue.fields.description) : ''}</textarea>
      <button onclick="saveDescription()">Save</button>
      <button class="secondary" onclick="cancelDescEdit()">Cancel</button>
    </div>
  </div>

  ${subtasks.length > 0 ? `
  <hr class="divider" />

  <!-- Subtasks -->
  <div class="section">
    <div class="section-header">
      <h2>Subtasks</h2>
    </div>
    <ul class="subtask-list">
      ${subtasks.map((st: any) => {
        const isDone = st.fields.status.name.toLowerCase().includes('done') ||
                       st.fields.status.name.toLowerCase().includes('closed') ||
                       st.fields.status.name.toLowerCase().includes('resolved');
        return `<li class="subtask-item">
          <input type="checkbox" ${isDone ? 'checked' : ''} onchange="toggleSubtask('${st.key}', this.checked)" />
          <span class="subtask-text ${isDone ? 'done' : ''}">${this.escapeHtml(st.fields.summary)}</span>
          <span class="subtask-key">${st.key}</span>
        </li>`;
      }).join('')}
    </ul>
    <div class="subtask-progress">${
      (() => {
        const total = subtasks.length;
        const done = subtasks.filter((st: any) => {
          const s = st.fields.status.name.toLowerCase();
          return s.includes('done') || s.includes('closed') || s.includes('resolved');
        }).length;
        return `${done} / ${total} completed`;
      })()
    }</div>
    <div class="add-subtask">
      <input type="text" id="newSubtaskInput" placeholder="Add a subtask..." />
      <button onclick="addSubtask()">Add</button>
    </div>
  </div>
  ` : `
  <hr class="divider" />
  <div class="section">
    <div class="section-header">
      <h2>Subtasks</h2>
    </div>
    <div class="add-subtask">
      <input type="text" id="newSubtaskInput" placeholder="Add a subtask..." />
      <button onclick="addSubtask()">Add</button>
    </div>
  </div>
  `}

  <hr class="divider" />

  <!-- Comments -->
  <div class="section">
    <div class="section-header">
      <h2>Comments (${comments.length})</h2>
    </div>
    ${comments.map((c) => `
      <div class="comment">
        <div class="comment-header">
          <span class="comment-author">${c.author.displayName}</span>
          <span class="comment-date">${new Date(c.created).toLocaleString()}</span>
        </div>
        <div class="comment-body">${this.escapeHtml(c.body)}</div>
      </div>`).join('')}
    <div class="comment-form">
      <textarea id="commentBody" placeholder="Write a comment..."></textarea>
      <button onclick="addComment()">Add Comment</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const issueKey = '${issue.key}';

    // Summary edit
    function showSummaryEdit() {
      document.getElementById('summaryDisplay').style.display = 'none';
      document.getElementById('summaryEdit').style.display = 'block';
      document.getElementById('summaryInput').focus();
    }
    function cancelSummaryEdit() {
      document.getElementById('summaryDisplay').style.display = 'flex';
      document.getElementById('summaryEdit').style.display = 'none';
    }
    function saveSummary() {
      const summary = document.getElementById('summaryInput').value.trim();
      if (summary) {
        vscode.postMessage({ command: 'updateSummary', issueKey, summary });
      }
    }

    // Status
    function changeStatus() {
      vscode.postMessage({ command: 'updateStatus', issueKey });
    }
    document.getElementById('statusSelect').addEventListener('mousedown', function(e) {
      e.preventDefault();
      changeStatus();
    });

    // Description edit
    function showDescEdit() {
      document.getElementById('descDisplay').style.display = 'none';
      document.getElementById('descEdit').style.display = 'block';
      document.getElementById('descInput').focus();
    }
    function cancelDescEdit() {
      document.getElementById('descDisplay').style.display = 'block';
      document.getElementById('descEdit').style.display = 'none';
    }
    function saveDescription() {
      const description = document.getElementById('descInput').value;
      vscode.postMessage({ command: 'updateDescription', issueKey, description });
    }

    // Subtasks
    function toggleSubtask(subtaskKey, done) {
      vscode.postMessage({ command: 'toggleSubtask', subtaskKey, done });
    }
    function addSubtask() {
      const input = document.getElementById('newSubtaskInput');
      const summary = input.value.trim();
      if (summary) {
        vscode.postMessage({ command: 'addSubtask', issueKey, summary });
        input.value = '';
      }
    }

    // Comments
    function addComment() {
      const body = document.getElementById('commentBody').value.trim();
      if (body) {
        vscode.postMessage({ command: 'addComment', issueKey, body });
        document.getElementById('commentBody').value = '';
      }
    }
  </script>
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

  private dispose() {
    IssueDetailPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}
