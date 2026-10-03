# n8n-nodes-miro-template-board

An [n8n](https://n8n.io) community node that copies a Miro board as a template and fills its frames with data from your workflow.

Design a board once, with frames like **Call Summary**, **Pain Points**, and **Next Steps**. Every time your workflow runs, the node makes a fresh copy of that board and puts your data into the matching frames. The template itself is never changed.

> This is a community node. It is not an official Miro or n8n product.

## How it works

1. You pick a **template board**. The node reads its frames and shows one field per frame title in the n8n editor.
2. You map workflow data into those fields (for example, a form answer or a spreadsheet column).
3. When the workflow runs, the node copies the whole board (layout, colours, shapes and all), finds each frame on the copy by its **title**, and adds your text inside it.
4. It outputs the new board's link, so later steps can send it to Slack, email, a CRM, and so on.

Each input item creates one board. A spreadsheet with 10 rows makes 10 boards.

## Installation

In n8n, go to **Settings → Community Nodes → Install** and enter:

```
n8n-nodes-miro-template-board
```

See n8n's guide to [installing community nodes](https://docs.n8n.io/integrations/community-nodes/installation/) for details.

## Connecting to Miro

The node supports two ways to sign in. Both need a Miro app with these scopes:

- `boards:read`
- `boards:write`

### Step 1: Create a Miro app

1. In Miro, click your profile picture (top right), choose **Profile**, open **Your apps**, then click **Create new app**.
2. Give it a name (for example, "n8n") and choose the team it belongs to.
3. Under **Permissions**, select `boards:read` and `boards:write`.
4. Keep this page open. You'll need the **Client ID** and **Client secret** for OAuth2.

### Option A: Access token (quickest)

1. On your Miro app page, click **Install app and get OAuth token** and pick a team.
2. Copy the token.
3. In n8n, open the node, set **Authentication** to **Access Token**, and create a **Miro API** credential with that token.

### Option B: OAuth2 (recommended)

1. In n8n, open the node, set **Authentication** to **OAuth2**, and create a **Miro OAuth2 API** credential.
2. Copy the **OAuth Redirect URL** shown in n8n (it ends in `/rest/oauth2-credential/callback`).
3. On your Miro app page, add that URL under **Redirect URI for OAuth2.0** and save.
4. Back in n8n, paste your app's **Client ID** and **Client secret**, then click **Connect my account** and approve access in Miro.

If your Miro app uses expiring tokens, n8n refreshes them automatically.

## Preparing your template board

The node matches frames by **title**, so:

- Every frame you want to fill needs a **title**.
- Every title must be **unique** on the board.

If a frame is untitled or two frames share a title, the editor shows the problem in place of the fields, and runs stop before anything is copied.

Changed the template in Miro? When n8n notices the frame list is out of date, it shows a ⚠ next to **Frame Content**. Click ↻ to reload.

## Settings

| Setting | What it does |
|---|---|
| **Authentication** | Access Token or OAuth2. |
| **Source Board** | Link to (or ID of) the template board. It is never changed. |
| **Destination Team ID** | The Miro team where new boards are created. Leave empty to use the template's team. |
| **New Board Name** | Name for each new board (max 60 characters). Supports expressions, e.g. `Call with {{ $json.customer }}`. Leave empty for "Copy of" plus the template name. |
| **Frame Content** | One field per frame. Every frame must get content. |
| **Customize Sharing** | Optional. Set link access, team and