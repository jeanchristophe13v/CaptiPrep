# Repository Guidelines

## Project Structure & Module Organization
- `src/background.js`: MV3 service worker; routes `CC_*` messages, calls providers, manages storage.
- `src/content.js`: YouTube caption bridge; sends `CC_*`; triggers overlay UI.
- `src/page_inject.js`: Page‑world DOM/query helpers used by content/UI.
- `src/ui.js`: Overlay controller; injects `assets/ui.html`.
- `assets/`: UI markup (`ui.html`) and styles (`cc.css`).
- `options/`: Options UI (`index.html`, `options.js`).
- `manifest.json`: Extension config (permissions, scripts, icons).
- `icons/`, `icon.png`: Extension icons.

## Build, Test, and Development
- Run locally: Chrome → `chrome://extensions` → enable Developer Mode → Load Unpacked → repo root.
- Reload/inspect: click Reload; open Service Worker console for background logs; use Inspect for content/UI.
- Package zip:
  ```sh
  mkdir -p dist && zip -r dist/captiprep.zip . -x '*.git*' '*.DS_Store'
  ```
- Note: No build step or bundler; sources load directly as MV3.

## Coding Style & Naming Conventions
- JavaScript: 2-space indent, semicolons, single quotes; prefer trailing commas.
- Naming: `lowerCamelCase` for variables/functions; keep existing filenames.
- Messages/events: prefix with `CC_` (e.g., `CC_LLM_CALL`, `CC_TOGGLE_MODAL`).
- Structure: keep modules self‑contained; prefer small helpers over inlined logic.

## Testing Guidelines
- Automated tests: none; rely on manual verification.
- Manual flow: open a YouTube video with English captions → click the extension → verify overlay rendering, caption extraction, item selection, and card generation.
- DevTools: check Content script console (page) and Background Service Worker console.
- Options: set provider, model, and API key; click "Test" and confirm success.

## Commit & Pull Request Guidelines
- Commits: short, imperative subjects with optional scope (e.g., `ui: tighten selection`).
- PRs: add description, motivation, repro steps, risks; include before/after screenshots or a short GIF; link issues; justify any `manifest.json` or permission changes.

## Security & Configuration Tips
- Never commit API keys; store secrets via Options in `chrome.storage.local`.
- Supported providers: Gemini, OpenAI, Claude, OpenRouter; use provider‑specific base URLs when self‑hosting.
- Keep `manifest.json` minimal; request only required permissions and explain additions in PRs.

## output
output in chinese.