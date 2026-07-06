# Jira Manager — VS Code Extension

A VS Code extension that provides a dedicated sidebar panel for managing Jira tickets, similar to the Explorer or Search panels.

## Features

- **Sidebar Panel** — Dedicated "Jira" activity bar icon with a tree view of all issues assigned to you
- **View Issues** — See all your unresolved Jira issues with status indicators
- **Create Issues** — Create new tickets with project, type, priority, labels
- **Update Status** — Transition issues through workflow states
- **Close Issues** — Quickly close/resolve tickets
- **Issue Details** — Rich webview showing full issue details, comments, and edit capabilities
- **Add Comments** — Comment on issues directly from VS Code
- **Sprint Progress** — Track assigned sprint points and completed sprint progress
- **Point Controls** — Increment or decrement story points from the sidebar or issue detail panel

## Setup

1. Install the extension
2. Open the Command Palette (`Cmd+Shift+P`) and run **Jira: Configure Jira Connection**
3. Enter your:
   - Jira Base URL (e.g., `https://your-domain.atlassian.net`)
   - Username (email for Jira Cloud)
   - Default project key
   - API Token ([Generate one here](https://id.atlassian.com/manage-profile/security/api-tokens))

## Configuration

Settings can also be configured in VS Code settings:

```json
{
  "jira.baseUrl": "https://your-domain.atlassian.net",
  "jira.username": "your-email@example.com",
  "jira.project": "PROJ",
  "jira.storyPointsField": ""
}
```

`jira.storyPointsField` can usually be left blank. The extension auto-detects common Jira fields like `Story Points` and `Story point estimate`. If your Jira instance uses a custom or renamed field, set it to the exact Jira field id, for example `customfield_10016`.

The API token is stored securely in VS Code's secret storage.

## Usage

- Click the **Jira** icon in the Activity Bar to open the sidebar
- Issues assigned to you appear in the tree view
- Click an issue to open its detail panel
- Use the **+** button in the view title to create a new issue
- Right-click issues for context menu actions (Update Status, Close)
- Use the **↻** button to refresh the issue list

## Development

```bash
npm install
npm run compile
# Press F5 in VS Code to launch Extension Development Host
```

## Requirements

- VS Code 1.85+
- Jira Cloud or Jira Server (REST API v2)
- API Token for authentication
