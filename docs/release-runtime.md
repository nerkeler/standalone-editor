# Release and runtime guide

Standalone Editor can run in development mode with Vite, or serve the built frontend from the Express process. The production path uses one process and one origin; it does not need a separate frontend port.

## Build and smoke-check a release

Use Node.js 22.17.0 or newer in the 22.x line and install from the checked-in lockfiles. The supported range is `>=22.17.0 <23.0.0`; the launch script and direct backend entrypoint both enforce it. Node.js 22.17.0 includes libuv 1.51.0, which fixes Windows file-system volume-serial consistency used by path and file-handle identity checks.

This range describes the application runtime. GitHub Actions runs its own action runtime: CI uses `actions/checkout@v6`, `actions/setup-node@v6`, and `actions/upload-artifact@v6`, whose official action metadata declares Node.js 24. That does not change the Node.js version used by the app or its tests; `setup-node` still installs Node.js `22.22.3`. This distinction matters because [GitHub removed the Node.js 20 runtime from Actions on 2026-09-23](https://github.blog/changelog/2026-09-23-node-20-is-no-longer-available-in-github-actions/).

```bash
(cd frontend && npm ci && npm run build)
(cd backend && npm ci --omit=dev)
```

Confirm that `frontend/dist/index.html` exists. Then run the production browser smoke test from the frontend directory. It starts only the backend, opens the built UI in Chrome, waits for the three-second save, loads a relative image, and checks the bytes returned by an attachment download.

```bash
(cd frontend && npm run test:production-smoke)
```

The smoke test fails with a direct instruction if `frontend/dist/index.html` is missing. It does not silently fall back to Vite or an empty static page.

## Start the built app

On macOS or Linux, use production mode from the repository root:

```bash
EDITOR_MODE=production bash start.sh "$HOME/Documents/notes"
```

The command serves `frontend/dist` and the API from the same backend process. The default URL is `http://127.0.0.1:5557/`; port `5558` is used only by the development Vite server. Set `EDITOR_PORT` to choose another backend port. `start.sh` checks `/api/health` before reporting that startup completed and forwards Ctrl+C or termination to the backend.

For a service manager, the equivalent direct command is `node src/index.js` with the working directory set to `backend`. Build `frontend/dist` first and install the backend runtime dependencies with `npm ci --omit=dev`. On `SIGINT` or `SIGTERM`, the backend stops accepting new connections and allows active HTTP requests about five seconds to finish. It then forcefully closes any remaining HTTP connections. A manager such as systemd or launchd should own restart policy and log collection rather than wrapping this process in another long-running shell.

```ini
[Service]
Type=simple
User=standalone-editor
WorkingDirectory=/opt/standalone-editor/backend
Environment=HOST=127.0.0.1
Environment=PORT=5557
Environment=EDITOR_DEFAULT_WORKSPACE=/srv/notes
Environment=EDITOR_RECOVERY_DIR=/var/lib/standalone-editor/recovery
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=2
TimeoutStopSec=10
```

This is an example unit body; replace the account, installation path, Node path, workspace and recovery location with values for the host. Keep the workspace and recovery directory writable by the service account and keep recovery data outside the workspace.

On Windows, build `frontend/dist` and start the backend in PowerShell. The `start.sh` supervisor is for macOS and Linux.

```powershell
cd frontend
npm ci
npm run build
cd ..\backend
npm ci --omit=dev
$env:HOST = '127.0.0.1'
$env:PORT = '5557'
$env:EDITOR_DEFAULT_WORKSPACE = 'C:\Users\you\Documents\notes'
$env:EDITOR_RECOVERY_DIR = 'C:\Users\you\AppData\Local\StandaloneEditor\recovery'
node src\index.js
```

In production mode the backend serves `/` from `frontend/dist`. `/api/health` reports whether the process can answer HTTP requests; it remains healthy when a saved workspace disk is offline. `/api/workspace/check` reports workspace availability separately so the UI can explain the issue and let the user choose another directory.

## Data, logs, update and rollback

Run the process as a dedicated account with access only to the intended workspace and recovery directory. The default host is loopback (`127.0.0.1`), matching the app's no-login personal-use boundary. Any network exposure should remain inside a trusted network and be configured deliberately; the app does not provide user authentication.

Before publishing a saved Markdown file, the backend flushes the temporary file's contents with `FileHandle.sync()`. It does not sync the parent directory because that operation is not consistently supported across the target platforms; this improves file-data durability but does not claim protection against every sudden power loss or filesystem failure.

The process writes startup and shutdown messages to standard output and errors to standard error. Service managers should retain those logs with their normal rotation policy. Check `/api/health` for process readiness and `/api/workspace/check` for saved-workspace status.

To update, stop the old process, install the new checkout, run `npm ci` from both package directories, build the frontend, and then start the new backend. Keep the notes directory, workspace configuration file, and recovery directory in place. Verify `/api/health`, `/api/workspace/check`, opening a note, an autosave, and an attachment download before removing the old application tree.

To roll back, stop the new process and restore the previous application tree and its matching `frontend/dist` build. Leave the workspace and recovery directory untouched. The storage format is ordinary Markdown plus application recovery files; application rollback does not reverse edits already written to the workspace. Back up both the workspace and recovery directory before maintenance.

`EDITOR_MODE=development` (the default) retains the existing Vite workflow on ports `5558` and `5557`. The development supervisor stops both children if either service exits. On Windows, run Vite and the backend in separate PowerShell windows and stop each process with Ctrl+C.
