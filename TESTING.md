# Website Smoke Test

This document records a quick smoke test of the static site as shipped in the `work` branch.

## Environment
- Python 3.11 `http.server`
- Playwright Chromium (headless)

## Procedure
1. Started a local static server with `python3 -m http.server 4173` from the repository root.
2. Opened `http://127.0.0.1:4173/index.html` in a headless Chromium instance.
3. Waited for the single-page application to finish loading its assets.
4. Captured a full-page screenshot of the rendered home view.

## Results
- The homepage rendered successfully without JavaScript errors.
- Static assets (CSS, JavaScript, images, audio, updates feed) responded with HTTP 200 status codes.
- The captured screenshot is saved at `artifacts/home.png` from the Playwright run.

No regressions were observed during this limited smoke test.
