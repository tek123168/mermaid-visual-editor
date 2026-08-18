/* Mermaid Canvas — editor application (vanilla JS, no build step).
 * Source of truth: the Mermaid code in the textarea. Clicking a rendered node/edge
 * opens an inspector; edits are written back into the code and re-rendered.
 * Exposes window.MermaidCanvasApp for headless testing.
 */
(function () {
  'use strict';

  var AUTOSAVE_KEY = 'mercanvas:autosave';
  var TIMER_KEY = 'mercanvas:autosave:ts';

  var SEED = [
    'flowchart TD',
    '  A[Visitor] --> B[Landing page]',
    '  B -- clicks Editor --> C[Mermaid Canvas]',
    '  C --> D{Like what you drew?}',
    '  D -->|Yes| E[Join the waitlist]',
    '  D -->|No| F[Import your own .mmd]',
    '  E --> G[Early access + Pro]',
    '  F --> G',
    ''
  ].join('\n');

  var DEFAULT_FILL = '#e1ecff';
  var DEFAULT_STROKE = '#1f3a93';
  var DEFAULT_COLOR = '#0b1020';
  var DEFAULT_EDGE_STROKE = '#1f3a93';

  var state = {
    code: '',
    selection: null,
    theme: 'default',
    renderSeq: 0,
    restoring: false
  };

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function cleanLabel(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  function quotedLabel(label) {
    label = String(label == null ? '' : label);
    if (/^[\w\s.,!?&\/+%:@()-]+$/.test(label)) return label;
    return JSON.stringify(label);
  }

  /* ---- code scanning / write-back ---- */

  function findClosing(code, startPos, closeChars) {
    var inQ = false;
    for (var j = startPos; j <= code.length - closeChars.length; j++) {
      var c = code[j];
      if (inQ) {
        if (c === '\\') { j++; } else if (c === '"') { inQ = false; }
        continue;
      }
      if (c === '"') { inQ = true; continue; }
      if (code.startsWith(closeChars, j)) return j;
    }
    return -1;
  }

  function nodeShapeAt(code, i) {
    var two = code.substr(i, 2);
    if (two === '((') return { shape: 'CIRCLE', openLen: 2, closeChars: '))' };
    if (two === '{{') return { shape: 'HEX', openLen: 2, closeChars: '}}' };
    if (two === '([') return { shape: 'STADIUM', openLen: 2, closeChars: '])' };
    if (two === '[[') return { shape: 'SUBROUTINE', openLen: 2, closeChars: ']]' };
    var ch = code[i];
    if (ch === '[') return { shape: 'RECT', openLen: 1, closeChars: ']' };
    if (ch === '{') return { shape: 'DIAMOND', openLen: 1, closeChars: '}' };
    if (ch === '(') return { shape: 'ROUND', openLen: 1, closeChars: ')' };
    if (ch === '>') return { shape: 'ASYMM', openLen: 1, closeChars: ']' };
    return null;
  }

  // Find the definition of a node id in the code. Returns {start,idStart,idEnd,contentStart,contentEnd,shape,label} or null.
  function findNodeDef(code, id) {
    var rx = new RegExp('\\b' + escRe(id) + '\\b', 'g');
    var m;
    while ((m = rx.exec(code))) {
      var idStart = m.index, idEnd = m.index + m[0].length;
      var i = idEnd;
      while (i < code.length && /\s/.test(code[i])) i++;
      var shape = nodeShapeAt(code, i);
      if (shape) {
        var contentStart = i + shape.openLen;
        var closeAt = findClosing(code, contentStart, shape.closeChars);
        if (closeAt < 0) continue; // malformed; try next occurrence
        return {
          start: idStart, idStart: idStart, idEnd: idEnd,
          contentStart: contentStart, contentEnd: closeAt,
          shape: shape.shape, label: code.slice(contentStart, closeAt)
        };
      }
      var ch = code[i];
      if (ch === undefined || ch === '\n' || ch === '\r' || '-=;:&,/'.indexOf(ch) >= 0) {
        return { start: idStart, idStart: idStart, idEnd: idEnd, contentStart: idEnd, contentEnd: idEnd, shape: 'BARE', label: '' };
      }
    }
    return null;
  }

  function replaceNodeLabel(code, id, newLabel) {
    var def = findNodeDef(code, id);
    if (!def) return { ok: false, error: 'Could not locate node "' + id + '" in the code.' };
    if (def.shape === 'SUBROUTINE') return { ok: false, error: 'Label editing for [[subroutine]] shapes is not supported yet — edit the code directly.' };
    var replacement = quotedLabel(newLabel);
    if (def.shape === 'BARE') {
      return { ok: true, code: code.slice(0, def.idEnd) + '[' + replacement + ']' + code.slice(def.idEnd) };
    }
    return { ok: true, code: code.slice(0, def.contentStart) + replacement + code.slice(def.contentEnd) };
  }

  function mergeStyleLine(code, identifier, props) {
    // props: {fill?, stroke?, color?, width?} -> writes `style <id> k:v,...` (nodes) — caller supplies verb
    var lineRe = new RegExp('^\\s*' + escRe(identifier) + '[^\\n]*$', 'm');
    var existing = code.match(lineRe);
    var kv = {};
    if (existing) {
      var body = existing[0].replace(new RegExp('^\\s*' + escRe(identifier) + '\\s+', ''), '');
      body.split(',').forEach(function (pair) {
        var bits = pair.split(':');
        if (bits.length === 2) kv[bits[0].trim()] = bits[1].trim();
      });
    }
    Object.keys(props).forEach(function (k) { if (props[k] != null) kv[k] = String(props[k]); });
    var newLine = identifier + ' ' + Object.keys(kv).map(function (k) { return k + ':' + kv[k]; }).join(',');
    if (existing) {
      return code.slice(0, existing.index) + newLine + code.slice(existing.index + existing[0].length);
    }
    var sep = code.endsWith('\n') ? '' : '\n';
    return code + sep + newLine + '\n';
  }

  function upsertNodeStyle(code, id, props) {
    return mergeStyleLine(code, 'style ' + id, props);
  }
  function upsertEdgeStyle(code, index, props) {
    return mergeStyleLine(code, 'linkStyle ' + index, props);
  }

  var ARROW_RE = /-->|---|-.->|==>|--o|--x/g;

  function countEdges(code) {
    var count = 0, m;
    ARROW_RE.lastIndex = 0;
    while ((m = ARROW_RE.exec(code))) count++;
    return count;
  }

  // Find the nth link definition (0-based). Supports `A -->|text| B` and `A-- text -->B`.
  function findEdgeDef(code, n) {
    ARROW_RE.lastIndex = 0;
    var idx = 0, m;
    while ((m = ARROW_RE.exec(code))) {
      if (idx === n) {
        var arrowStart = m.index, arrow = m[0];
        var pre = code.slice(Math.max(0, arrowStart - 120), arrowStart);
        var pm = pre.match(/(--|==)\s*([^>\-=]*?)\s*$/);
        var fromEnd = arrowStart, textBefore = null;
        if (pm) {
          textBefore = pm[2];
          fromEnd = arrowStart - pm[0].length; // start of '--'/'==' prefix
        }
        var after = code.slice(arrowStart + arrow.length);
        var am = after.match(/^(\s*)\|([^|]*)\|\s*([^\s;][^\n;]*)?/);
        var pipeText = null, pipeStart = -1, pipeEnd = -1;
        if (am) {
          pipeText = am[2];
          pipeStart = arrowStart + arrow.length + am[1].length + 1;
          pipeEnd = pipeStart + am[2].length;
        }
        var def = { arrow: arrow, fromEnd: fromEnd, textBefore: textBefore, pipeText: pipeText, pipeStart: pipeStart, pipeEnd: pipeEnd, hasText: !!(pipeText != null || (textBefore != null && textBefore.trim() !== '')) };
        return def;
      }
      idx++;
    }
    return null;
  }

  function replaceEdgeLabel(code, n, newLabel) {
    var def = findEdgeDef(code, n);
    if (!def) return { ok: false, error: 'Could not locate edge #' + n + ' in the code.' };
    if (def.pipeText != null) {
      if (/[|"]/ .test(newLabel)) {
        // quote it: mermaid accepts A -->|"text"| B if the text contains specials
        newLabel = JSON.stringify(newLabel);
      }
      return { ok: true, code: code.slice(0, def.pipeStart) + newLabel + code.slice(def.pipeEnd) };
    }
    if (def.textBefore != null) {
      newLabel = quotedLabel(newLabel);
      // textBefore occupies code between fromEnd+2 and arrowStart; replace with the new label
      var textStart = def.fromEnd + 2; // after '--' or '=='
      var oldLen = code.slice(textStart, def.arrowStart).length;
      if (oldLen !== 0 || def.hasText) {
        return { ok: true, code: code.slice(0, textStart) + newLabel + code.slice(def.arrowStart) };
      }
    }
    if (!def.hasText) {
      // edge has no label yet: inject pipe-form text onto the arrow, e.g. --> becomes -->|text|
      var fresh = quotedLabel(newLabel);
      return { ok: true, code: code.slice(0, def.arrowStart) + def.arrow + '|' + fresh + '|' + code.slice(def.arrowStart + def.arrow.length) };
    }
    return { ok: false, error: 'This edge has no editable text span (unusual syntax) — edit the code directly.' };
  }

  // Extract direction token from header, e.g. flowchart TD -> 'TD'
  function currentDirection(code) {
    var m = code.match(/^\s*(flowchart|graph)\s+(TB|TD|LR|RL|BT)\b/);
    return m ? m[2] : null;
  }
  function setDirection(code, dir) {
    var m = code.match(/^(\s*(?:flowchart|graph)\s+)(TB|TD|LR|RL|BT)\b/);
    if (m) return code.slice(0, m.index + m[1].length) + dir + code.slice(m.index + m[1].length + m[2].length);
    if (/^\s*(?:flowchart|graph)\b/.test(code)) {
      return code.replace(/^(\s*(?:flowchart|graph))(\s|$)/, '$1 ' + dir + '$2');
    }
    return null; // not a flowchart/graph diagram
  }

  /* ---- rendering ---- */

  function parseLineFromError(e) {
    var msg = String((e && e.message) || e || '');
    var m = msg.match(/line\s+(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
  }

  function snippetForLine(code, line) {
    if (!line) return '';
    var lines = code.split('\n');
    var i = line - 1;
    if (i < 0 || i >= lines.length) return '';
    var start = Math.max(0, i - 1), end = Math.min(lines.length, i + 2);
    var out = [];
    for (var j = start; j < end; j++) {
      out.push((j + 1) + ' | ' + lines[j]);
      if (j === i) out.push('  > ' + '^'.repeat(Math.max(6, lines[j].length)));
    }
    return out.join('\n');
  }

  function showError(e) {
    var errbar = $('#errbar');
    if (!errbar) return;
    var msg = String((e && e.message) || e || 'Unknown error').split('\n')[0];
    var line = (e && e.line) ? e.line : parseLineFromError(e);
    var snippet = snippetForLine(state.code, line);
    errbar.textContent = (line ? 'Line ' + line + ': ' : '') + msg + (snippet ? '\n\n' + snippet : '');
    errbar.className = 'errbar err';
  }
  function clearError() {
    var errbar = $('#errbar');
    if (errbar) { errbar.textContent = ''; errbar.className = 'errbar'; }
  }

  function status(msg, ok) {
    var el = $('#status');
    if (!el) return;
    var dot = ok ? '●' : (ok === false ? '●' : '○');
    el.innerHTML = '<span class="' + (ok === false ? 'err-dot' : 'ok-dot') + '">' + dot + '</span> ' + String(msg).replace(/</g, '&lt;');
  }

  function nodeIdFromEl(g) {
    var idAttr = g.getAttribute('id') || '';
    // mermaid >=11.16: mermaid-render-flowchart-A-0 ; older: flowchart-A-0
    var m = idAttr.match(/^(?:mermaid-render-)?flowchart-(.+)-(\d+)$/);
    return m ? m[1] : null;
  }
  function nodeLabelFromEl(g) {
    var labelEl = g.querySelector('.nodeLabel, foreignObject div, .label, text');
    return cleanLabel(labelEl ? labelEl.textContent : g.textContent);
  }
  function edgeLabelFromEl(p) {
    // legacy helper: labels may live inside old-style g.edgePath groups
    var el = p.querySelector('.edgeLabel, .label, text');
    return cleanLabel(el ? el.textContent : '');
  }
  function edgePaths(wrap) {
    // mermaid >=11.16: edges are path.flowchart-link inside g.edgePaths; older: g.edgePath
    var paths = wrap.querySelectorAll('path.flowchart-link, g.edgePath');
    return Array.prototype.slice.call(paths);
  }
  function edgeLabels(wrap) {
    return Array.prototype.slice.call(wrap.querySelectorAll('g.edgeLabel'));
  }
  function edgeLabelFromIndex(wrap, idx) {
    var labels = edgeLabels(wrap);
    var el = labels[idx];
    return el ? cleanLabel(el.textContent) : '';
  }
  function edgeIndexFromLabelEl(lbl) {
    return edgeLabels($('.svg-wrap')).indexOf(lbl);
  }

  function attachInteractions() {
    var wrap = $('.svg-wrap');
    if (!wrap) return;
    $$('g.node', wrap).forEach(function (g) {
      g.addEventListener('click', function (ev) {
        ev.stopPropagation();
        selectNode(g);
      });
    });
    $$('path.flowchart-link', wrap).forEach(function (p) {
      p.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var idx = Array.prototype.indexOf.call(wrap.querySelectorAll('path.flowchart-link'), p);
        selectEdge(idx);
      });
    });
    $$('g.edgeLabel', wrap).forEach(function (lbl) {
      lbl.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var idx = edgeIndexFromLabelEl(lbl);
        if (idx >= 0 && idx < edgePaths(wrap).length) selectEdge(idx);
      });
    });
  }

  function clearSelectionHighlight() {
    $$('.svg-wrap g.selected').forEach(function (g) { g.classList.remove('selected'); });
  }

  function selectNode(g) {
    clearSelectionHighlight();
    g.classList.add('selected');
    var id = nodeIdFromEl(g);
    var label = nodeLabelFromEl(g);
    var rect = g.querySelector('rect, polygon, path.shape');
    var fill = rect ? rect.getAttribute('fill') : null;
    var stroke = rect ? rect.getAttribute('stroke') : null;
    state.selection = {
      kind: 'node', id: id, label: label,
      fill: fill || DEFAULT_FILL, stroke: stroke || DEFAULT_STROKE, color: DEFAULT_COLOR,
      edges: countEdges(state.code)
    };
    openInspector();
    if (!id) {
      $('#ins-label').value = label;
      $('#ins-hint').textContent = 'This node has an unusual id — label edits here will not write back; use the code pane.';
    }
  }

  function selectEdge(idx) {
    clearSelectionHighlight();
    var wrap = $('.svg-wrap');
    var paths = edgePaths(wrap);
    var p = paths[idx];
    if (!p) return;
    p.classList.add('selected');
    var label = edgeLabelFromIndex(wrap, idx);
    var stroke = p.getAttribute('stroke');
    state.selection = { kind: 'edge', index: idx, label: label, stroke: stroke || DEFAULT_EDGE_STROKE, edges: countEdges(state.code) };
    openInspector();
  }

  /* ---- inspector ---- */

  function openInspector() {
    var ins = $('#inspector');
    var sel = state.selection;
    var isEdge = sel && sel.kind === 'edge';
    ins.classList.add('open');
    $('#ins-type').textContent = isEdge ? 'Edge #' + sel.index : 'Node';
    $('#ins-title').textContent = isEdge ? 'Edge ' + sel.index : (sel.id || '(unmapped id)');
    $('#ins-label').value = sel.label;
    $('#ins-fill-row').style.display = isEdge ? 'none' : 'flex';
    $('#ins-color-row').style.display = isEdge ? 'none' : 'flex';
    $('#ins-width-row').style.display = isEdge ? 'block' : 'none';
    $('#ins-stroke').value = sel.stroke;
    if (!isEdge) $('#ins-fill').value = sel.fill;
    if (!isEdge) $('#ins-color').value = sel.color;
    if (isEdge) $('#ins-width').value = (sel.strokeWidth || 2);
    ['fill', 'stroke', 'color'].forEach(function (k) {
      var sp = $('#ins-' + k + '-hex');
      if (sp && $('#ins-' + k).value) sp.textContent = $('#ins-' + k).value;
    });
    $('#ins-hint').textContent = isEdge
      ? 'Edge edits write back as linkStyle ' + sel.index + ' + inline label text. linkStyle indexes follow edge definition order.'
      : 'Edits write back into the Mermaid source (node definition + a style line) and re-render.';
    $('#apply-btn').disabled = false;
  }

  function closeInspector() {
    var ins = $('#inspector');
    if (ins) ins.classList.remove('open');
    clearSelectionHighlight();
    state.selection = null;
  }

  function applyInspector() {
    var sel = state.selection;
    if (!sel) return;
    var code = $('#code').value;
    var changed = false;

    if (sel.kind === 'node') {
      var newLabel = $('#ins-label').value;
      if (newLabel !== sel.label) {
        var r = replaceNodeLabel(code, sel.id, newLabel);
        if (!r.ok) { status(r.error, false); return; }
        code = r.code; changed = true; sel.label = newLabel;
      }
      var props = {};
      var fill = $('#ins-fill').value, stroke = $('#ins-stroke').value, color = $('#ins-color').value;
      if (fill !== sel.fill) props.fill = fill;
      if (stroke !== sel.stroke) props.stroke = stroke;
      if (color !== sel.color) props.color = color;
      if (Object.keys(props).length) { code = upsertNodeStyle(code, sel.id, props); changed = true; }
    } else {
      var newEdgeLabel = $('#ins-label').value;
      if (newEdgeLabel !== sel.label) {
        if (newEdgeLabel.indexOf('\n') >= 0) { status('Edge labels cannot contain newlines', false); return; }
        var er = replaceEdgeLabel(code, sel.index, newEdgeLabel);
        if (!er.ok) { status(er.error, false); return; }
        code = er.code; changed = true; sel.label = newEdgeLabel;
      }
      var stroke2 = $('#ins-stroke').value;
      var width = parseInt($('#ins-width').value, 10) || 2;
      var edgeProps = {};
      if (stroke2 !== sel.stroke) edgeProps.stroke = stroke2;
      if (width !== (sel.strokeWidth || 2)) edgeProps['stroke-width'] = width + 'px';
      if (Object.keys(edgeProps).length) { code = upsertEdgeStyle(code, sel.index, edgeProps); changed = true; }
    }

    if (changed) {
      setCode(code, true); // re-render; inspector re-opens via post-render hook
    } else {
      status('No changes to apply', true);
      closeInspector();
    }
  }

  /* ---- code editing hooks ---- */

  function setCode(code, keepSelection) {
    var ta = $('#code');
    ta.value = code;
    state.code = code;
    clearError();
    renderFlow().then(function () {
      if (keepSelection && state.selection) {
        if (state.selection.kind === 'node' && state.selection.id) {
          var found = $$('g.node', $('.svg-wrap')).find(function (el) { return nodeIdFromEl(el) === state.selection.id; });
          if (found) { selectNode(found); return; }
        }
        if (state.selection.kind === 'edge' && state.selection.index != null) {
          selectEdge(state.selection.index);
        }
      }
    });
  }

  function setSelectionDataAttrs() {
    $$('g.node', $('.svg-wrap')).forEach(function (g) {
      var id = nodeIdFromEl(g);
      if (id) g.setAttribute('data-canvas-id', id);
    });
  }

  async function renderFlow() {
    var ta = $('#code');
    var code = ta.value;
    state.code = code;
    var seq = ++state.renderSeq;
    clearError();
    try {
      await window.mermaid.parse(code);
    } catch (e) {
      if (seq !== state.renderSeq) return;
      showError(e);
      status('parse error — fix the code to render', false);
      return;
    }
    try {
      var res = await window.mermaid.render('mermaid-render', code);
      if (seq !== state.renderSeq) return;
      var wrap = $('.svg-wrap');
      wrap.innerHTML = res.svg;
      setSelectionDataAttrs();
      attachInteractions();
      status('parsed + rendered OK (' + countEdges(code) + ' edges)', true);
    } catch (e) {
      if (seq !== state.renderSeq) return;
      showError(e);
      status('render error', false);
    }
    scheduleAutosave();
  }

  /* ---- autosave ---- */

  function scheduleAutosave() {
    clearTimeout(scheduleAutosave._t);
    scheduleAutosave._t = setTimeout(function () {
      try {
        localStorage.setItem(AUTOSAVE_KEY, state.code);
        localStorage.setItem(TIMER_KEY, String(Date.now()));
      } catch (e) { /* private mode */ }
      var b = $('#autosave-badge');
      if (b) { b.textContent = 'autosaved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); b.style.display = 'inline-block'; }
    }, 500);
  }

  /* ---- import / export ---- */

  function svgStringForExport() {
    var svgEl = $('.svg-wrap svg');
    if (!svgEl) return null;
    var clone = svgEl.cloneNode(true);
    var vb = clone.getAttribute('viewBox') || '0 0 800 600';
    var parts = vb.split(/[\s,]+/).map(Number);
    var w = parts[2] || 800, h = parts[3] || 600;
    clone.setAttribute('width', String(w * 2));
    clone.setAttribute('height', String(h * 2));
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    return new XMLSerializer().serializeToString(clone);
  }

  function downloadBlob(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  }

  function exportPNG() {
    var svgStr = svgStringForExport();
    if (!svgStr) { status('Nothing rendered to export', false); return; }
    status('exporting PNG…', true);
    var img = new Image();
    img.onload = function () {
      var canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(function (blob) { if (blob) downloadBlob(blob, 'mermaid-canvas.png'); }, 'image/png');
    };
    img.onerror = function () { status('PNG export failed — SVG could not be rasterized', false); };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);
  }

  function exportSVG() {
    var svgStr = svgStringForExport();
    if (!svgStr) { status('Nothing rendered to export', false); return; }
    downloadBlob(new Blob([svgStr], { type: 'image/svg+xml' }), 'mermaid-canvas.svg');
    status('SVG downloaded', true);
  }

  function exportPDF() {
    var svgStr = svgStringForExport();
    if (!svgStr) { status('Nothing rendered to export', false); return; }
    var html = '<!doctype html><html><head><meta charset="utf-8"><title>Mermaid Canvas</title>' +
      '<style>@page{margin:12mm}body{margin:0;font-family:-apple-system,Segoe UI,sans-serif;color:#111}h1{font-size:16px;color:#555}' +
      '.note{font-size:11px;color:#888;margin:10px 0 16px}svg{max-width:100%;height:auto}</style></head><body>' +
      '<h1>Mermaid Canvas diagram</h1><div class="note">Exported ' + new Date().toISOString().slice(0, 10) +
      ' · generated with Mermaid — unofficial, not affiliated with the Mermaid project.</div>' + svgStr + '</body></html>';
    var iframe = document.createElement('iframe');
    iframe.style.position = 'fixed'; iframe.style.right = '0'; iframe.style.bottom = '0';
    iframe.style.width = '0'; iframe.style.height = '0'; iframe.style.border = '0';
    document.body.appendChild(iframe);
    var doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
    setTimeout(function () {
      try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch (e) { /* blocked */ }
      setTimeout(function () { iframe.remove(); }, 60 * 1000);
    }, 350);
    status('PDF: use "Save as PDF" in the print dialog', true);
  }

  function copyCode() {
    var text = $('#code').value;
    var done = function (okMsg) { status(okMsg, true); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done('Mermaid code copied to clipboard'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done('Mermaid code copied to clipboard'); } catch (e) { status('Copy failed — select and copy manually', false); }
      ta.remove();
    }
  }

  function requirePro(action, label) {
    if (window.LeadHub && window.LeadHub.isProUnlocked()) { action(); return; }
    var done = function () {
      if (window.LeadHub) window.LeadHub.unlockPro();
      action();
    };
    window.LeadHub.openModal({
      title: label + ' is a Pro feature',
      body: 'Join the waitlist to unlock ' + label.toLowerCase() + ' right now in this browser. Launch pricing: Pro $8/mo.',
      source: 'editor-pro-' + label.toLowerCase().replace(/\s+/g, '-'),
      onSuccess: done
    });
  }

  /* ---- palette ---- */

  function openPalette(kind) {
    var modal = $('#palette-modal');
    modal.classList.add('open');
    $('#palette-kind').textContent = kind === 'node' ? 'Add node' : 'Add edge';
    $('.palette-node-fields', modal).style.display = kind === 'node' ? 'block' : 'none';
    $('.palette-edge-fields', modal).style.display = kind === 'edge' ? 'block' : 'none';
    modal._kind = kind;
    $('#palette-from').value = '';
    $('#palette-to').value = '';
    $('#palette-text').value = '';
    $('#palette-id').focus();
  }

  function insertAtCursor(text) {
    var ta = $('#code');
    var start = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
    var end = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
    // If the caret is still at the very start (user never clicked into the editor),
    // append at the end instead of corrupting the flowchart header.
    if (start === 0 && end === 0 && ta.value.trim() !== '') {
      start = end = ta.value.length;
    }
    var before = ta.value.slice(0, start), after = ta.value.slice(end);
    var insert = text;
    if (before && !/\n$/.test(before)) insert = '\n' + insert;
    if (after && !/^\n/.test(after)) insert = insert + '\n';
    var newVal = before + insert + after;
    ta.value = newVal;
    var pos = Math.min(before.length + insert.length, newVal.length);
    ta.focus();
    ta.setSelectionRange(pos, pos);
    renderFlow();
  }

  function paletteSubmit() {
    var modal = $('#palette-modal');
    var kind = modal._kind;
    if (kind === 'node') {
      var id = cleanLabel($('#palette-id').value);
      var label = $('#palette-label').value || id;
      var shape = $('#palette-shape').value; // value is the wrapper
      if (!id) { status('Node id is required', false); return; }
      if (findNodeDef(state.code, id)) { status('Node id "' + id + '" already exists', false); return; }
      var snippet = id + SHAPE_MAP[shape].open + quotedLabel(label) + SHAPE_MAP[shape].close;
      insertAtCursor(snippet);
      modal.classList.remove('open');
      status('Inserted node ' + id, true);
    } else {
      var from = cleanLabel($('#palette-from').value);
      var to = cleanLabel($('#palette-to').value);
      var text = $('#palette-text').value;
      if (!from || !to) { status('Both From and To node ids are required', false); return; }
      if (!findNodeDef(state.code, from)) { status('From node "' + from + '" not defined yet', false); return; }
      if (!findNodeDef(state.code, to)) { status('To node "' + to + '" not defined yet', false); return; }
      var link = from + ' -->' + (text ? '|' + text + '|' : '') + ' ' + to;
      insertAtCursor(link);
      modal.classList.remove('open');
      status('Inserted edge ' + from + ' → ' + to, true);
    }
  }

  var SHAPE_MAP = {
    rect: { open: '[', close: ']' },
    round: { open: '(', close: ')' },
    stadium: { open: '([', close: '])' },
    circle: { open: '((', close: '))' },
    diamond: { open: '{', close: '}' },
    hex: { open: '{{', close: '}}' }
  };

  /* ---- init ---- */

  function wireToolbar() {
    $('#theme').addEventListener('change', function (e) {
      state.theme = e.target.value;
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: state.theme, flowchart: { htmlLabels: true, curve: 'basis' } });
      renderFlow();
    });
    $('#direction').addEventListener('change', function (e) {
      var code = setDirection($('#code').value, e.target.value);
      if (code == null) {
        status('Direction applies to flowchart/graph diagrams only', false);
        $('#direction').value = currentDirection(state.code) || 'TD';
        return;
      }
      setCode(code, true);
    });
    $('#export-png').addEventListener('click', exportPNG);
    $('#export-svg').addEventListener('click', function () { requirePro(exportSVG, 'SVG export'); });
    $('#export-pdf').addEventListener('click', function () { requirePro(exportPDF, 'PDF export'); });
    $('#export-copy').addEventListener('click', copyCode);
    $('#reset-btn').addEventListener('click', function () {
      try { localStorage.removeItem(AUTOSAVE_KEY); localStorage.removeItem(TIMER_KEY); } catch (e) {}
      setCode(SEED, false);
      status('Reset to demo diagram', true);
    });
    $('#import-file').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () { setCode(String(reader.result), false); status('Imported ' + f.name, true); };
      reader.readAsText(f);
      e.target.value = '';
    });
    $('#import-btn').addEventListener('click', function () { $('#import-file').click(); });
    $('#clear-autosave').addEventListener('click', function () {
      try { localStorage.removeItem(AUTOSAVE_KEY); localStorage.removeItem(TIMER_KEY); } catch (e) {}
      $('#restore-banner').style.display = 'none';
      setCode(SEED, false);
      status('Autosave cleared; demo reset', true);
    });
    $('#palette-add-node').addEventListener('click', function () { openPalette('node'); });
    $('#palette-add-edge').addEventListener('click', function () { openPalette('edge'); });
    $('#palette-submit').addEventListener('click', paletteSubmit);
    $('#palette-close').addEventListener('click', function () { $('#palette-modal').classList.remove('open'); });
    $('#code').addEventListener('input', function () {
      clearTimeout(renderFlow._deb);
      renderFlow._deb = setTimeout(renderFlow, 250);
    });
    $('#apply-btn').addEventListener('click', applyInspector);
    $('#ins-close').addEventListener('click', closeInspector);
    ['ins-fill', 'ins-stroke', 'ins-color'].forEach(function (id) {
      $('#' + id).addEventListener('input', function () {
        var sp = $('#' + id + '-hex');
        if (sp) sp.textContent = $('#' + id).value;
      });
    });
    $('#inspector').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.target.id === 'ins-label' || e.target.id === 'ins-width')) { e.preventDefault(); applyInspector(); }
    });
  }

  function syncDirectionSelect() {
    var d = currentDirection(state.code);
    $('#direction').value = d || 'TD';
  }

  function restoreAutosaveBanner() {
    try {
      var ts = parseInt(localStorage.getItem(TIMER_KEY) || '0', 10);
      if (ts) {
        var when = new Date(ts);
        $('#restore-banner').style.display = 'flex';
        $('#restore-when').textContent = when.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      }
    } catch (e) {}
  }

  async function init() {
    if (!window.mermaid) {
      status('Mermaid library failed to load — is vendor/mermaid.min.js present?', false);
      return;
    }
    window.mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: state.theme, flowchart: { htmlLabels: true, curve: 'basis' } });
    wireToolbar();
    restoreAutosaveBanner();
    var saved = null;
    try { saved = localStorage.getItem(AUTOSAVE_KEY); } catch (e) {}
    if (saved) {
      $('#code').value = saved;
      state.restoring = true;
    } else {
      $('#code').value = SEED;
    }
    syncDirectionSelect();
    await renderFlow();
    if (state.restoring) status('Restored your last autosaved diagram — edit or import freely', true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.MermaidCanvasApp = {
    init: init,
    renderFlow: renderFlow,
    applyInspector: applyInspector,
    selectNode: selectNode,
    selectEdge: selectEdge,
    setCode: setCode,
    setDirection: setDirection,
    findNodeDef: findNodeDef,
    replaceNodeLabel: replaceNodeLabel,
    replaceEdgeLabel: replaceEdgeLabel,
    upsertNodeStyle: upsertNodeStyle,
    upsertEdgeStyle: upsertEdgeStyle,
    countEdges: countEdges,
    currentDirection: currentDirection,
    exportPNG: exportPNG,
    exportSVG: exportSVG,
    exportPDF: exportPDF,
    copyCode: copyCode,
    SEED: SEED,
    state: state,
    constants: { AUTOSAVE_KEY: AUTOSAVE_KEY }
  };
})();