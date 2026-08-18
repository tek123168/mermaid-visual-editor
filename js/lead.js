/* Mermaid Canvas — lead capture (waitlist) shared module.
 * Honest MVP: no backend. Signups are stored in the visitor's browser localStorage
 * and can be exported/downloaded; the UI says exactly that. No fake signups.
 */
(function () {
  'use strict';

  var LS_KEY = 'mercanvas:waitlist';
  var PRO_KEY = 'mercanvas:proUnlocked';
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function readList() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function writeList(arr) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(arr)); } catch (e) { /* private mode */ }
  }

  var LeadHub = {
    key: LS_KEY,

    list: readList,

    add: function (email, source) {
      email = String(email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return { ok: false, error: 'Please enter a valid email address.' };
      var arr = readList();
      if (arr.some(function (l) { return l.email === email; })) {
        return { ok: true, duplicate: true, email: email };
      }
      arr.push({ email: email, source: source || 'landing', at: new Date().toISOString() });
      writeList(arr);
      return { ok: true, email: email };
    },

    exportFile: function () {
      var arr = readList();
      var payload = {
        note: 'Mermaid Canvas waitlist — exported from visitor browser (MVP has no backend). ' +
              'Import these into your launch email list.',
        exported_at: new Date().toISOString(),
        count: arr.length,
        leads: arr
      };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'mermaid-canvas-waitlist.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
    },

    mailtoLink: function () {
      var arr = readList();
      var body = arr.map(function (l) { return l.email + ' (' + (l.source || '') + ', ' + l.at + ')'; }).join('\n');
      var subject = 'Mermaid Canvas waitlist — ' + arr.length + ' signup(s) exported';
      return 'mailto:?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body || 'No signups yet.');
    },

    isProUnlocked: function () { return !!localStorage.getItem(PRO_KEY); },
    unlockPro: function () {
      if (!localStorage.getItem(PRO_KEY)) localStorage.setItem(PRO_KEY, new Date().toISOString());
    },

    /* Open the waitlist modal. opts: { title, body, source, onSuccess } */
    openModal: function (opts) {
      opts = opts || {};
      var backdrop = document.getElementById('wl-modal-backdrop');
      if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.id = 'wl-modal-backdrop';
        backdrop.className = 'modal-backdrop';
        backdrop.innerHTML =
          '<div class="modal" role="dialog" aria-label="Join the waitlist">' +
            '<h3 id="wl-modal-title"></h3>' +
            '<p id="wl-modal-body"></p>' +
            '<form id="wl-modal-form" class="wl-form">' +
              '<input type="email" id="wl-modal-email" placeholder="you@company.com" required autocomplete="email">' +
              '<button type="submit" class="btn primary" id="wl-modal-submit">Join waitlist</button>' +
            '</form>' +
            '<div class="wl-msg" id="wl-modal-msg"></div>' +
            '<div class="modal-actions">' +
              '<button type="button" class="btn ghost small" id="wl-modal-export">Export signups (.json)</button>' +
              '<button type="button" class="btn ghost small" id="wl-modal-close">Close</button>' +
            '</div>' +
            '<small>MVP note: signups are saved in this browser (localStorage) and exported at launch handoff — no server yet.</small>' +
          '</div>';
        document.body.appendChild(backdrop);
        backdrop.querySelector('#wl-modal-close').addEventListener('click', function () { backdrop.classList.remove('open'); });
        backdrop.querySelector('#wl-modal-export').addEventListener('click', function () { LeadHub.exportFile(); });
        backdrop.addEventListener('click', function (e) { if (e.target === backdrop) backdrop.classList.remove('open'); });
        backdrop.querySelector('#wl-modal-form').addEventListener('submit', function (e) {
          e.preventDefault();
          var input = backdrop.querySelector('#wl-modal-email');
          var msg = backdrop.querySelector('#wl-modal-msg');
          var res = LeadHub.add(input.value, (opts.source || 'modal'));
          if (!res.ok) { msg.className = 'wl-msg err'; msg.textContent = res.error; return; }
          input.value = '';
          msg.className = 'wl-msg ok';
          msg.textContent = res.duplicate
            ? 'You are already on the waitlist — thank you!'
            : 'You are on the waitlist — we will email you at launch. Saved locally' + (LeadHub.list().length === 1 ? '' : ' (' + LeadHub.list().length + ' total)') + '.';
          if (opts.onSuccess) opts.onSuccess();
        });
      }
      backdrop.querySelector('#wl-modal-title').textContent = opts.title || 'Get early access';
      backdrop.querySelector('#wl-modal-body').textContent = opts.body || 'Join the Mermaid Canvas waitlist for early access and launch pricing.';
      backdrop.querySelector('#wl-modal-msg').textContent = '';
      backdrop.querySelector('#wl-modal-msg').className = 'wl-msg';
      backdrop.querySelector('#wl-modal-email').value = '';
      backdrop.classList.add('open');
      setTimeout(function () { backdrop.querySelector('#wl-modal-email').focus(); }, 50);
      return backdrop;
    }
  };

  window.LeadHub = LeadHub;
})();