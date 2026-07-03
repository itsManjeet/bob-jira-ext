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
            await this.handleAddSubtask(message.issueKey, message.summary, message.priority, message.assignee);
            break;
          case 'editSubtaskSummary':
            await this.handleEditSubtaskSummary(message.subtaskKey, message.summary);
            break;
          case 'deleteSubtask':
            await this.handleDeleteSubtask(message.subtaskKey);
            break;
          case 'openSubtask':
            vscode.commands.executeCommand('jira.openIssue', message.subtaskKey);
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

  private async handleAddSubtask(parentKey: string, summary: string, priority?: string, assignee?: string) {
    try {
      const issue = this.issue;
      const subtaskType = await this.jiraService.getSubtaskIssueType(issue.fields.project.key);
      const fields: any = {
        project: { key: issue.fields.project.key },
        summary,
        issuetype: { id: subtaskType.id },
        parent: { key: parentKey },
        assignee: { name: assignee || this.jiraService.getUsername() },
      };
      if (priority) {
        fields.priority = { name: priority };
      }
      await this.jiraService.createIssue({ fields } as any);
      vscode.window.showInformationMessage(`Subtask added to ${parentKey}`);
      this.issue = await this.jiraService.getIssue(parentKey);
      this.update();
      vscode.commands.executeCommand('jira.refresh');
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to create subtask: ${msg}`);
    }
  }

  private async handleEditSubtaskSummary(subtaskKey: string, summary: string) {
    try {
      await this.jiraService.updateIssue(subtaskKey, { summary } as any);
      this.issue = await this.jiraService.getIssue(this.issue.key);
      this.update();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to update subtask: ${msg}`);
    }
  }

  private async handleDeleteSubtask(subtaskKey: string) {
    const confirm = await vscode.window.showWarningMessage(
      `Delete subtask ${subtaskKey}? This cannot be undone.`,
      { modal: true },
      'Delete'
    );
    if (confirm !== 'Delete') { return; }
    try {
      await this.jiraService.deleteIssue(subtaskKey);
      vscode.window.showInformationMessage(`Subtask ${subtaskKey} deleted`);
      this.issue = await this.jiraService.getIssue(this.issue.key);
      this.update();
      vscode.commands.executeCommand('jira.refresh');
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      vscode.window.showErrorMessage(`Failed to delete subtask: ${msg}`);
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
      display: grid;
      grid-template-columns: 18px 1fr auto;
      align-items: start;
      gap: 8px;
      padding: 8px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 13px;
    }
    .subtask-item:last-child { border-bottom: none; }
    .subtask-item input[type="checkbox"] {
      width: 16px;
      height: 16px;
      cursor: pointer;
      accent-color: var(--vscode-textLink-foreground);
      margin-top: 2px;
    }
    .subtask-body { min-width: 0; }
    .subtask-summary-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .subtask-text {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .subtask-text.done {
      text-decoration: line-through;
      opacity: 0.55;
    }
    .subtask-edit-btn {
      opacity: 0;
      cursor: pointer;
      font-size: 13px;
      flex-shrink: 0;
      transition: opacity 0.1s;
    }
    .subtask-item:hover .subtask-edit-btn { opacity: 0.5; }
    .subtask-edit-btn:hover { opacity: 1 !important; }
    .subtask-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 3px;
      flex-wrap: wrap;
    }
    .subtask-key {
      font-size: 11px;
      color: var(--vscode-textLink-foreground);
      font-family: monospace;
      cursor: pointer;
      text-decoration: none;
    }
    .subtask-key:hover { text-decoration: underline; }
    .subtask-assignee {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .subtask-priority {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 8px;
      font-weight: 600;
    }
    .subtask-priority.High, .subtask-priority.Highest { background: #7a2020; color: #fdd; }
    .subtask-priority.Medium { background: #5c4d00; color: #ffe; }
    .subtask-priority.Low, .subtask-priority.Lowest { background: #1a3a5c; color: #ddf; }
    .subtask-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
    .delete-btn {
      opacity: 0;
      background: none;
      border: none;
      color: var(--vscode-errorForeground);
      font-size: 14px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
      transition: opacity 0.1s;
    }
    .subtask-item:hover .delete-btn { opacity: 0.5; }
    .delete-btn:hover { opacity: 1 !important; background: none; }
    .subtask-inline-edit { display: none; }
    .subtask-inline-edit input {
      width: 100%;
      padding: 4px 8px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      font-family: inherit;
      font-size: 12px;
    }
    .subtask-inline-edit-btns { margin-top: 4px; display: flex; gap: 4px; }
    .subtask-progress {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 8px;
    }
    .add-subtask-toggle {
      margin-top: 10px;
      font-size: 12px;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .add-subtask-toggle:hover { text-decoration: underline; }
    .add-subtask-form {
      display: none;
      flex-direction: column;
      gap: 6px;
      margin-top: 8px;
      padding: 10px 12px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border, transparent);
      border-radius: 6px;
    }
    .add-subtask-form input, .add-subtask-form select {
      padding: 6px 10px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      font-family: inherit;
      font-size: 12px;
      width: 100%;
    }
    .add-subtask-form select {
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
    }
    .add-subtask-form label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 2px;
      display: block;
    }
    .add-subtask-row { display: flex; gap: 6px; }
    .add-subtask-row > div { flex: 1; }
    .add-subtask-actions { display: flex; gap: 6px; margin-top: 2px; }

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

  <hr class="divider" />

  <!-- Subtasks -->
  <div class="section">
    <div class="section-header">
      <h2>Subtasks (${subtasks.length})</h2>
    </div>
    ${subtasks.length > 0 ? `
    <ul class="subtask-list">
      ${subtasks.map((st: any) => {
        const isDone = st.fields.status.name.toLowerCase().includes('done') ||
                       st.fields.status.name.toLowerCase().includes('closed') ||
                       st.fields.status.name.toLowerCase().includes('resolved');
        const priority: string = st.fields.priority?.name || 'Medium';
        const assigneeName: string = st.fields.assignee?.displayName || '';
        const priorityClass = priority.replace(/\s+/g, '');
        return `<li class="subtask-item" id="st-${st.key}">
          <input type="checkbox" ${isDone ? 'checked' : ''} onchange="toggleSubtask('${st.key}', this.checked)" />
          <div class="subtask-body">
            <div class="subtask-summary-row">
              <span class="subtask-text ${isDone ? 'done' : ''}" id="st-text-${st.key}">${this.escapeHtml(st.fields.summary)}</span>
              <span class="subtask-edit-btn" onclick="showSubtaskEdit('${st.key}')" title="Edit summary">✎</span>
            </div>
            <div class="subtask-inline-edit" id="st-edit-${st.key}">
              <input type="text" id="st-input-${st.key}" value="${this.escapeHtml(st.fields.summary)}" />
              <div class="subtask-inline-edit-btns">
                <button onclick="saveSubtaskEdit('${st.key}')">Save</button>
                <button class="secondary" onclick="cancelSubtaskEdit('${st.key}')">Cancel</button>
              </div>
            </div>
            <div class="subtask-meta">
              <span class="subtask-key" onclick="openSubtask('${st.key}')">${st.key}</span>
              ${priority !== 'Medium' ? `<span class="subtask-priority ${priorityClass}">${priority}</span>` : ''}
              ${assigneeName ? `<span class="subtask-assignee">@${this.escapeHtml(assigneeName)}</span>` : ''}
              <span style="font-size:11px;opacity:0.5;">${st.fields.status.name}</span>
            </div>
          </div>
          <div class="subtask-actions">
            <button class="delete-btn" onclick="deleteSubtask('${st.key}')" title="Delete subtask">✕</button>
          </div>
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
    }</div>` : `<div style="font-size:12px;color:var(--vscode-descriptionForeground);margin-bottom:4px;">No subtasks yet.</div>`}

    <span class="add-subtask-toggle" onclick="toggleAddSubtaskForm()">＋ Add subtask</span>
    <div class="add-subtask-form" id="addSubtaskForm">
      <div>
        <label>Summary *</label>
        <input type="text" id="newSubtaskSummary" placeholder="Subtask summary..." />
      </div>
      <div class="add-subtask-row">
        <div>
          <label>Priority</label>
          <select id="newSubtaskPriority">
            <option value="">— default —</option>
            <option value="Highest">Highest</option>
            <option value="High">High</option>
            <option value="Medium" selected>Medium</option>
            <option value="Low">Low</option>
            <option value="Lowest">Lowest</option>
          </select>
        </div>
        <div>
          <label>Assignee (username)</label>
          <input type="text" id="newSubtaskAssignee" placeholder="${this.escapeHtml(this.jiraService.getUsername())}" />
        </div>
      </div>
      <div class="add-subtask-actions">
        <button onclick="addSubtask()">Create Subtask</button>
        <button class="secondary" onclick="toggleAddSubtaskForm()">Cancel</button>
      </div>
    </div>
  </div>

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
    function toggleAddSubtaskForm() {
      const form = document.getElementById('addSubtaskForm');
      const visible = form.style.display === 'flex';
      form.style.display = visible ? 'none' : 'flex';
      if (!visible) {
        document.getElementById('newSubtaskSummary').focus();
      }
    }
    function addSubtask() {
      const summary = document.getElementById('newSubtaskSummary').value.trim();
      const priority = document.getElementById('newSubtaskPriority').value;
      const assignee = document.getElementById('newSubtaskAssignee').value.trim();
      if (!summary) {
        document.getElementById('newSubtaskSummary').focus();
        return;
      }
      vscode.postMessage({ command: 'addSubtask', issueKey, summary, priority: priority || undefined, assignee: assignee || undefined });
    }
    function showSubtaskEdit(key) {
      document.getElementById('st-edit-' + key).style.display = 'block';
      document.querySelector('#st-' + key + ' .subtask-summary-row').style.display = 'none';
      const input = document.getElementById('st-input-' + key);
      input.focus();
      input.select();
    }
    function cancelSubtaskEdit(key) {
      document.getElementById('st-edit-' + key).style.display = 'none';
      document.querySelector('#st-' + key + ' .subtask-summary-row').style.display = 'flex';
    }
    function saveSubtaskEdit(key) {
      const summary = document.getElementById('st-input-' + key).value.trim();
      if (summary) {
        vscode.postMessage({ command: 'editSubtaskSummary', subtaskKey: key, summary });
      }
    }
    function deleteSubtask(key) {
      vscode.postMessage({ command: 'deleteSubtask', subtaskKey: key });
    }
    function openSubtask(key) {
      vscode.postMessage({ command: 'openSubtask', subtaskKey: key });
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
