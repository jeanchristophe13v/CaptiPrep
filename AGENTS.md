# Repository Guidelines

## Project Structure & Module Organization
- `src/`: core scripts
  - `background.js`: MV3 service worker; routing, provider calls, storage.
  - `content.js`: YouTube caption bridge; sends `CC_*` messages; invokes UI.
  - `page_inject.js`: page‑world helpers for DOM/query utilities.
  - `ui.js`: overlay logic; integrates `assets/ui.html` into the page.
- `assets/`: UI assets (`ui.html`) and styles (`cc.css`).
- `options/`: options UI (`index.html`, `options.js`).
- `manifest.json`: extension config (permissions, scripts, icons).
- `icons/`, `icon.png`: extension icons.

## Build, Test, and Development Commands
- Run locally: Chrome → `chrome://extensions` → enable Developer Mode → Load Unpacked → repo root.
- Reload/inspect: use “Reload” and “Service Worker” / “Inspect views” for logs.
- Package zip: `mkdir -p dist && zip -r dist/captiprep.zip . -x "*.git*" "*.DS_Store"`.

## Coding Style & Naming Conventions
- JavaScript: 2‑space indent, semicolons, single quotes, trailing commas when helpful.
- Naming: `lowerCamelCase` for variables/functions; keep existing file names.
- Messages/events: prefix with `CC_` (e.g., `CC_LLM_CALL`, `CC_TOGGLE_MODAL`).
- Structure: keep modules self‑contained; favor small helpers over inlined logic.

## Testing Guidelines
- Automated tests: none. Rely on manual verification.
- Manual flow:
  - Open a YouTube video with English captions; click the extension icon.
  - Overlay from `assets/ui.html` should render; verify caption extraction, item selection, and card generation.
  - Use DevTools: Content script console (page) and background “Service Worker” console for API/logs.
  - Options page: load, save provider/model/API key, and confirm “Test” succeeds.

## Commit & Pull Request Guidelines
- Commits: short, imperative subjects with optional scope (e.g., `ui: tighten selection`, `options: fix save`).
- PRs: clear description, motivation, repro steps, risks; include before/after screenshots or a short GIF; link issues; justify any `manifest.json` or permission changes.

## Security & Configuration Tips
- Secrets: never commit API keys; store via Options in `chrome.storage.local`.
- Providers: Gemini, OpenAI, Claude, OpenRouter supported; use provider‑specific base URLs when self‑hosting.
- Permissions: keep `manifest.json` minimal; add only what you need and note reasoning in PRs.

