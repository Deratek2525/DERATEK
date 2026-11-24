// Dictée vocale DERATEK — bouton 🎤 sous les champs de texte du bon et du rapport
(function () {
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var CIBLES = '#fb-noteTexte, #fb-probleme, #bon-note-text, #iv-notes, textarea[id^="r-"], textarea[id^="diag-ta-"]';

  var css = document.createElement('style');
  css.textContent =
    '.dic-bar{display:flex;align-items:center;gap:10px;margin:6px 0 2px;min-height:40px}' +
    '.dic-btn{display:inline-flex;align-items:center;gap:8px;border:1.5px solid #2563eb;background:#eff6ff;color:#1d4ed8;' +
      'border-radius:999px;padding:8px 16px;font:600 14px/1 inherit;cursor:pointer;touch-action:manipulation}' +
    '.dic-btn svg{width:18px;height:18px}' +
    '.dic-btn.on{background:#dc2626;border-color:#dc2626;color:#fff;animation:dicPulse 1.4s ease-in-out infinite}' +
    '.dic-etat{font-size:13px;color:#64748b;font-style:italic;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    'textarea.dic-actif{outline:3px solid #fca5a5;outline-offset:1px}' +
    'html.tablette .dic-btn{padding:11px 20px;font-size:15px}' +
    '@keyframes dicPulse{0%,100%{box-shadow:0 0 0 0 rgba(220,38,38,.45)}50%{box-shadow:0 0 0 8px rgba(220,38,38,0)}}' +
    '@media (prefers-reduced-motion:reduce){.dic-btn.on{animation:none}}';
  document.head.appendChild(css);

  var MICRO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>';

  function dire(t) { try { toast(t); } catch (e) { alert(t); } }

  // Commandes dites à voix haute → ponctuation
  function ponctuer(t) {
    var r = ' ' + t + ' ';
    r = r.replace(/\s+point à la ligne\s+/gi, '.\n')
         .replace(/\s+(nouveau paragraphe)\s+/gi, '\n\n')
         .replace(/\s+(à la ligne|nouvelle ligne|retour à la ligne)\s+/gi, '\n')
         .replace(/\s+point d'interrogation\s+/gi, ' ? ')
         .replace(/\s+point d'exclamation\s+/gi, ' ! ')
         .replace(/\s+point final\s+/gi, '. ')
         .replace(/\s+point-virgule\s+/gi, ' ; ')
         .replace(/\s+deux points\s+/gi, ' : ')
         .replace(/\s+virgule\s+/gi, ', ')
         .replace(/\s+tiret\s+/gi, ' - ');
    return r.replace(/^ +| +$/g, '').replace(/ *\n */g, '\n');
  }

  var actif = null; // { ta, btn, etat, rec, stop }

  function inserer(ta, texte) {
    texte = ponctuer(texte.trim());
    if (!texte) return;
    var debut = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
    var fin = ta.selectionEnd != null ? ta.selectionEnd : debut;
    if (document.activeElement !== ta && ta.dataset.dicPos) { debut = fin = Math.min(+ta.dataset.dicPos, ta.value.length); }
    var avant = ta.value.slice(0, debut), apres = ta.value.slice(fin);
    var avantTrim = avant.replace(/[ \t]+$/, '');
    var nouvellePhrase = !avantTrim || /[.!?\n]$/.test(avantTrim);
    if (nouvellePhrase) texte = texte.charAt(0).toUpperCase() + texte.slice(1);
    if (avant && !/[\s\n]$/.test(avant) && !/^[.,;:!?\n]/.test(texte)) texte = ' ' + texte;
    if (apres && !/^[\s\n.,;:!?]/.test(apres)) texte = texte + ' ';
    var max = ta.maxLength > 0 ? ta.maxLength : 0;
    if (max && avant.length + texte.length + apres.length > max) { texte = texte.slice(0, Math.max(0, max - avant.length - apres.length)); dire('Le champ est plein'); }
    ta.value = avant + texte + apres;
    var pos = avant.length + texte.length;
    ta.dataset.dicPos = pos;
    try { ta.setSelectionRange(pos, pos); } catch (e) {}
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    ta.scrollTop = ta.scrollHeight;
  }

  function arreter() {
    if (!actif) return;
    var a = actif; actif = null;
    a.stop = true;
    try { a.rec.stop(); } catch (e) {}
    a.btn.classList.remove('on');
    a.btn.lastChild.textContent = 'Dicter';
    a.etat.textContent = '';
    a.ta.classList.remove('dic-actif');
  }
  window.dicteeArreter = arreter;

  function demarrer(ta, btn, etat) {
    if (actif && actif.ta === ta) { arreter(); return; }
    arreter();
    if (!SR) { dire('La dictée n\'est pas disponible dans ce navigateur. Utilisez Chrome, ou le micro du clavier Samsung.'); return; }
    var a = { ta: ta, btn: btn, etat: etat, stop: false };
    if (ta.dataset.dicPos == null || document.activeElement === ta) ta.dataset.dicPos = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
    if (document.activeElement !== ta) ta.dataset.dicPos = ta.value.length;
    function lancer() {
      var rec = new SR();
      rec.lang = 'fr-FR';
      rec.continuous = false;       // plus fiable sur Android : on relance après chaque phrase
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.onresult = function (ev) {
        var provisoire = '';
        for (var i = ev.resultIndex; i < ev.results.length; i++) {
          var r = ev.results[i];
          if (r.isFinal) inserer(ta, r[0].transcript);
          else provisoire += r[0].transcript;
        }
        etat.textContent = provisoire ? '« ' + provisoire + ' »' : 'Je vous écoute…';
      };
      rec.onerror = function (ev) {
        if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') { dire('Autorisez le micro pour l\'application (cadenas à côté de l\'adresse)'); arreter(); }
        else if (ev.error === 'network') { dire('Dictée impossible : pas de connexion internet'); arreter(); }
        else if (ev.error === 'audio-capture') { dire('Aucun micro trouvé'); arreter(); }
      };
      rec.onend = function () {
        if (a.stop || actif !== a) return;
        if (!document.body.contains(ta)) { arreter(); return; }
        setTimeout(function () { if (!a.stop && actif === a) lancer(); }, 150);
      };
      a.rec = rec;
      try { rec.start(); } catch (e) {}
    }
    actif = a;
    btn.classList.add('on');
    btn.lastChild.textContent = 'Arrêter';
    etat.textContent = 'Je vous écoute…';
    ta.classList.add('dic-actif');
    lancer();
  }

  function equiper(ta) {
    if (ta.dataset.dic) return;
    ta.dataset.dic = '1';
    var bar = document.createElement('div');
    bar.className = 'dic-bar';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dic-btn';
    btn.title = 'Dicter le texte à voix haute';
    btn.innerHTML = MICRO + '<span>Dicter</span>';
    var etat = document.createElement('span');
    etat.className = 'dic-etat';
    bar.appendChild(btn); bar.appendChild(etat);
    ta.insertAdjacentElement('afterend', bar);
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); }); // garde la position du curseur
    btn.addEventListener('click', function (e) { e.preventDefault(); demarrer(ta, btn, etat); });
    ta.addEventListener('blur', function () { if (ta.selectionEnd != null) ta.dataset.dicPos = ta.selectionEnd; });
  }

  function scanner() {
    var l = document.querySelectorAll(CIBLES);
    for (var i = 0; i < l.length; i++) {
      var ta = l[i];
      if (ta.tagName !== 'TEXTAREA' || ta.readOnly || ta.disabled) continue;
      equiper(ta);
    }
    if (actif && !document.body.contains(actif.ta)) arreter();
  }

  var attente = null;
  new MutationObserver(function () { if (attente) return; attente = setTimeout(function () { attente = null; scanner(); }, 200); })
    .observe(document.body, { childList: true, subtree: true });
  scanner();
  document.addEventListener('visibilitychange', function () { if (document.hidden) arreter(); });
})();
