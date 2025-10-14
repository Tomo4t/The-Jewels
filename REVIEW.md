# Review of SPA Behavior

## Issues observed

- **Reader navigation is never triggered by chapter links.** `initRouter` only routes when a click originates from an element that carries `data-page`, or when a `popstate` event fires. Regular chapter anchors such as `href="#reader?lang=..."` change the hash but neither condition applies, so `loadPage` is never called and the home/chapters view stays on screen.【F:js/router.js†L127-L150】
- **Query parameters for the reader view are dropped.** Even if `data-page="reader"` were used, the handler rewrites the URL to `#reader` (no query string) before calling `loadPage`, and `routes.reader.render()` is invoked without any of the requested chapter/page parameters. As a result the reader falls back to the last value stored in `localStorage`, not the link the user clicked.【F:js/router.js†L64-L144】
- **The router re-renders the reader twice and targets a missing container.** After inserting the HTML from the route, the code tries to render the reader again into `#app`, an element that does not exist, so the second render is a no-op while still incurring the network and processing cost of a full re-fetch.【F:js/router.js†L76-L114】
- **Reader mode buttons rely on the global `event` object.** The `mode` listeners call `event.currentTarget` inside arrow functions without receiving the event object; that pattern is not supported in ES modules and will raise a ReferenceError in strict mode browsers.【F:js/router.js†L116-L123】
- **Theme initialization uses two different roots.** The startup script applies the `dark` class to `<html>`, but the router toggles the class on `<body>`. Depending on which script runs last, the two elements can disagree and theme-specific CSS may fail to apply consistently.【F:index.html†L4-L19】【F:js/router.js†L45-L52】

## Suggestions

1. Add a `hashchange` listener (or inspect `location.hash` on every click) so that any in-app anchor using `#route?...` reliably triggers `loadPage`.
2. Pass the parsed query string down to `renderReaderPage` on the first render and preserve it when updating the address bar, so deep links open the expected language/chapter/page.
3. Remove the redundant `renderReaderPage` call against `#app` and update the existing `#page-content` node instead to avoid duplicate work and stale markup.
4. Bind the reader mode buttons with `(event) => { ... }` to keep the code strict-mode friendly.
5. Standardize theme toggling by applying the `dark` class to either `<html>` or `<body>` exclusively in both the bootstrap script and the router, then update the CSS selectors accordingly.
