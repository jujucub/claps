# CLAPS

**C**laude **L**ink for **A**pproval-based **P**ersona **S**ervice

A Slack-integrated Claude automation service with approval-based permission control and customizable character personas.

> [Japanese README (日本語)](./README.ja.md)

## What is CLAPS?

CLAPS is a bot that automatically analyzes code, applies fixes, and creates PRs when triggered by a simple tag or mention.
The bot name defaults to `claps` but can be changed to any name via the `botName` field in `messages.json`.

- **GitHub Issue** with `[botName]` tag (e.g. `[claps]`) &rarr; Analyzes the issue, modifies code, and creates a PR
- **Slack** mention `@botName` (e.g. `@claps`) &rarr; Executes tasks based on your instructions
- **Dangerous operations** &rarr; Requests approval via Slack modal (with optional comments)
- **When judgment is needed** &rarr; Asks questions through Slack

## Key Features

| Feature | Description |
|---------|-------------|
| **Worktree isolation** | Each issue gets an independent worktree, keeping the main branch clean |
| **Auto PR creation** | Automatically commits, pushes, and creates PRs upon completion |
| **Headless execution** | Runs Claude CLI in headless mode (`-p`) with hook-based permission control |
| **Slack thread updates** | Real-time progress notifications in Slack threads |
| **Modal approval** | Approve/deny with optional comment input |
| **Session continuity** | Continues conversations within the same thread/issue |
| **Slash command management** | Manage whitelists, repos, and user mappings via `/botName` slash command |
| **Customizable persona** | Fully customizable character settings and message templates |

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment variables
cp .env.example .env
# Edit .env with your credentials

# Build
npm run build

# Start
npm start
```

## Verifying with curl

After starting the server, you can verify the HTTP channel is working using curl.

### Obtain the Bearer Token

A token is generated each time the server starts and saved to `~/.claps/auth-token`. Read it into a variable for convenience:

```bash
TOKEN=$(cat ~/.claps/auth-token)
```

Use `$TOKEN` in the examples below in place of `YOUR_BEARER_TOKEN`.

### Health Check

```bash
curl http://localhost:3000/api/v1/health
```

Expected response:
```json
{
  "status": "healthy",
  "channels": { "slack": "healthy", "line": "healthy", "http": "healthy" },
  "taskQueue": { "pending": 0, "running": 0 }
}
```

### Send a Message (Start a Task)

```bash
curl -X POST http://localhost:3000/api/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_BEARER_TOKEN" \
  -d '{
    "message": "Please update the README",
    "deviceId": "curl-test",
    "targetRepo": "owner/repo"
  }'
```

Expected response (202 Accepted):
```json
{
  "taskId": "abc-123",
  "status": "queued",
  "pollUrl": "/api/v1/tasks/abc-123"
}
```

### Poll Task Status

```bash
curl http://localhost:3000/api/v1/tasks/<taskId> \
  -H "Authorization: Bearer YOUR_BEARER_TOKEN"
```

Expected response (200 OK):
```json
{
  "taskId": "abc-123",
  "status": "completed",
  "result": {
    "success": true,
    "output": "README updated.",
    "prUrl": "https://github.com/owner/repo/pull/42"
  },
  "pending": null
}
```

### Respond to Approval Request

When the task status is `awaiting_approval`:

```bash
curl -X POST http://localhost:3000/api/v1/tasks/<taskId>/approve \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_BEARER_TOKEN" \
  -d '{
    "requestId": "req-456",
    "decision": "allow",
    "comment": "Looks good"
  }'
```

### Answer a Question

When the task status is `awaiting_answer`:

```bash
curl -X POST http://localhost:3000/api/v1/tasks/<taskId>/answer \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_BEARER_TOKEN" \
  -d '{
    "requestId": "q-789",
    "answer": "main"
  }'
```

## Requirements

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | >= 20.0.0 | Runtime |
| Claude CLI | Latest | AI execution engine |
| Git | >= 2.20 | Worktree support |
| GitHub CLI (gh) | Latest | PR creation |

## Environment Variables

### Required

| Variable | Format | Description |
|----------|--------|-------------|
| `SLACK_BOT_TOKEN` | `xoxb-...` | Slack Bot Token |
| `SLACK_APP_TOKEN` | `xapp-...` | Slack App Token (Socket Mode) |
| `SLACK_CHANNEL_ID` | `C0123456789` | Notification channel ID |
| `SLACK_TEAM_ID` | `T0123456789` | Slack workspace ID |
| `GITHUB_TOKEN` | `github_pat_...` | GitHub Personal Access Token |
| `GITHUB_REPOS` | `owner/repo1,owner/repo2` | Monitored repositories (comma-separated) |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | - | Anthropic API Key (not required with Max Plan) |
| `APPROVAL_SERVER_PORT` | `3001` | Approval server port |
| `GITHUB_POLL_INTERVAL` | `300000` | GitHub polling interval (ms) |
| `ADMIN_SLACK_USER` | - | Admin Slack user ID |
| `ALLOWED_GITHUB_USERS` | - | Allowed GitHub users (comma-separated, initial value) |
| `ALLOWED_SLACK_USERS` | - | Allowed Slack user IDs (comma-separated, initial value) |

## Usage

### Automatic handling from GitHub Issues

1. Create an issue
2. Include `[botName]` (e.g. `[claps]`) in the title or body
3. The bot auto-detects and starts processing
4. A PR is automatically created upon completion

```markdown
# Example issue title (with default botName "claps")
[claps] Fix login screen bug

# Example issue body
Please fix the issue where the login button is unresponsive.
```

### Instruct via Slack

```
@botName Write tests for this file
```

### Manage via Slack commands

The examples below use the default `botName` of `claps`. If you change `botName`, the command will be registered under that name.

```
/claps help                              Show help
/claps repos                             List monitored repos
/claps owner/repo message                Run Claude on specified repo
```

**Admin commands (only for `ADMIN_SLACK_USER`):**

```
/claps add-repo owner/repo               Add monitored repo
/claps remove-repo owner/repo            Remove monitored repo
/claps whitelist                         Show whitelist (including mappings)
/claps whitelist add @user               Add Slack user to whitelist
/claps whitelist add @user github-name   Register Slack + GitHub + mapping
/claps whitelist add-github username     Add GitHub user only
/claps whitelist remove @user            Remove Slack user (and related mappings)
/claps whitelist remove-github username  Remove GitHub user (and related mappings)
```

## Customization

### Character Persona

Create `~/.claps/character.md` to define a custom character prompt for Claude responses. If not present, the default persona (Claris) is used.

Sample character configurations are available in the `characters/` directory:
- `characters/sumomo.md` - Sumomo character (for character.md)
- `characters/sumomo-messages.json` - Sumomo character messages (for messages.json)

### Message Templates

Create `~/.claps/messages.json` to customize bot messages:

```json
{
  "emoji": "🤖",
  "slackEmoji": ":robot_face:",
  "name": "MyBot",
  "botName": "mybot",
  "messages": {
    "task.started": "{emoji} Roger! Starting: {description}",
    "task.completed": "{emoji} Done! {message}"
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `emoji` | `☕` | Emoji used in console and Slack messages |
| `slackEmoji` | `:coffee:` | Slack-specific emoji code |
| `name` | `クラリス` | Display name for the character |
| `botName` | `claris` | Used for slash command (`/botName`), mention (`@botName`), GitHub Issue tag (`[botName]`), and git branch prefix (`botName/issue-123`) |
| `messages` | `{}` | Message template overrides |

**Important:** When changing `botName`, also update the corresponding slash command name and bot display name in your Slack App settings.

See `src/messages.ts` for all available message keys.

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript |
| `npm start` | Start in production mode |
| `npm run dev` | Start in dev mode (hot reload) |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | TypeScript type checking |

## Documentation

- [Design Document](./docs/DESIGN.md) - System architecture, processing flow, implementation details
- [Contributing Guide](./docs/CONTRIB.md) - Development setup, coding conventions
- [Runbook](./docs/RUNBOOK.md) - Deployment, monitoring, troubleshooting

## License

MIT
