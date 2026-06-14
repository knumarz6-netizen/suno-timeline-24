# Local Environment

## Quick start

Double-click the project-root `start-local.cmd`, or run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-local.ps1
```

Default URL:

- `http://127.0.0.1:4173/`

## Alternate port

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-local.ps1 -Port 4189
```

## Notes

- This document lives in `docs/`, but the startup scripts stay in the project root.
- `node` is used if it exists on `PATH`.
- If `node` is not available, the script falls back to the bundled Codex runtime Node.js.
- Local data is stored in `.data/suno-timeline.sqlite`.
