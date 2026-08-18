# Mermaid Canvas — static site (MVP)

A visual, point-and-click editor for Mermaid diagrams. The Mermaid source stays the
source of truth; clicking rendered nodes/edges opens an inspector that writes edits
back into the code and re-renders.

- `index.html` — landing page (hero, pain→features, how it works, pricing preview, waitlist)
- `editor.html` — the editor app (code pane ⇄ live canvas, click-to-edit inspector,
  add-node/add-edge palette, theme/direction, import, export PNG (free) / SVG+PDF (Pro), autosave)
- `pricing.html` — pricing page (Free / Pro $8/mo launch pricing) + waitlist
- `css/style.css` — shared styles
- `js/lead.js` — waitlist capture (localStorage + JSON export + mailto; no backend)
- `js/mermaid-app.js` — editor application (vanilla JS, no build step)
- `vendor/mermaid.min.js` — vendored Mermaid v11.16.1 (MIT), pinned locally, no CDN dependency

## Run locally

    cd site && python3 -m http.server 8000
    # open http://localhost:8000/editor.html

(No build step, no Node needed at runtime. Opening `editor.html` via `file://` may work
but a local server is recommended.)

## Deploy to GitHub Pages

    cd site
    git init -b main && git add -A && git commit -m "Mermaid Canvas MVP"
    gh repo create mermaid-visual-editor --public --source . --push
    gh api repos/tek123168/mermaid-visual-editor/pages \
      -f source[branch]=main -f source[path]=/ -X POST
    # live at https://tek123168.github.io/mermaid-visual-editor/
    curl -s -o /dev/null -w "%{http_code}\n" https://tek123168.github.io/mermaid-visual-editor/

## Lead capture (honest)

No backend: signups are stored in the visitor's browser localStorage under
`mercanvas:waitlist`. Landing/pricing/editor all expose "export signups (.json)"
and a prefilled mailto fallback. At launch handoff, the founder exports this list.
One-line switch to a real capture service is documented in PROGRESS.md.

## Honest scope notes

- Click-to-edit (labels + colors + edge width) is implemented and covered by an
  automated jsdom integration test (`scripts/test-mvp.js`). Drag-to-reposition is
  roadmap (kept Mermaid's auto-layout; nudging nodes requires coordinates).
- Edge styling writes back as `linkStyle <index>` where index follows edge
  definition order — re-check after reordering edges in code.
- PNG export is Free; SVG/PDF are Pro-gated (waitlist unlock, local only).
- Unofficial tool, not affiliated with the Mermaid project; mermaid is MIT-licensed.