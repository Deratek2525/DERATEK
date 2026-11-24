// ============================================================
// 📋 VERSION TERRAIN POUR TABLETTE (Samsung, paysage)
// - Menu réduit : Ma journée, Bons, Bons en cours, Rapports à transmettre,
//   Bons terminés, Agenda, Rapports, Tickets de caisse.
// - Écran « Ma journée » : le déroulement des interventions du jour, étape par étape.
// Rien ne change sur ordinateur. Bouton « Version complète » pour sortir du mode.
// Les étapes sont rangées dans la note du bon (chronologie), sans changer la base.
// ============================================================
(function () {
  var ICO = {"sun": "<circle cx=\"12\" cy=\"12\" r=\"4\" /> <path d=\"M12 2v2\" /> <path d=\"M12 20v2\" /> <path d=\"m4.93 4.93 1.41 1.41\" /> <path d=\"m17.66 17.66 1.41 1.41\" /> <path d=\"M2 12h2\" /> <path d=\"M20 12h2\" /> <path d=\"m6.34 17.66-1.41 1.41\" /> <path d=\"m19.07 4.93-1.41 1.41\" />", "receipt": "<path d=\"M12 17V7\" /> <path d=\"M16 8h-6a2 2 0 0 0 0 4h4a2 2 0 0 1 0 4H8\" /> <path d=\"M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z\" />", "check": "<path d=\"M20 6 9 17l-5-5\" />", "navigation": "<polygon points=\"3 11 22 2 13 21 11 13 3 11\" />", "map-pin": "<path d=\"M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0\" /> <circle cx=\"12\" cy=\"10\" r=\"3\" />", "phone": "<path d=\"M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384\" />", "clipboard-list": "<rect width=\"8\" height=\"4\" x=\"8\" y=\"2\" rx=\"1\" ry=\"1\" /> <path d=\"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2\" /> <path d=\"M12 11h4\" /> <path d=\"M12 16h4\" /> <path d=\"M8 11h.01\" /> <path d=\"M8 16h.01\" />", "send": "<path d=\"M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z\" /> <path d=\"m21.854 2.147-10.94 10.939\" />", "triangle-alert": "<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\" /> <path d=\"M12 9v4\" /> <path d=\"M12 17h.01\" />", "truck": "<path d=\"M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2\" /> <path d=\"M15 18H9\" /> <path d=\"M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14\" /> <circle cx=\"17\" cy=\"18\" r=\"2\" /> <circle cx=\"7\" cy=\"18\" r=\"2\" />", "calendar-days": "<path d=\"M8 2v3\" /> <path d=\"M16 2v3\" /> <rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\" /> <path d=\"M3 9h18\" /> <path d=\"M8 13h.01\" /> <path d=\"M12 13h.01\" /> <path d=\"M16 13h.01\" /> <path d=\"M8 17h.01\" /> <path d=\"M12 17h.01\" /> <path d=\"M16 17h.01\" />", "user": "<path d=\"M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2\" /> <circle cx=\"12\" cy=\"7\" r=\"4\" />", "laptop": "<path d=\"M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z\" /> <path d=\"M20.054 15.987H3.946\" />", "tablet": "<rect width=\"16\" height=\"20\" x=\"4\" y=\"2\" rx=\"2\" ry=\"2\" /> <line x1=\"12\" x2=\"12.01\" y1=\"18\" y2=\"18\" />"};
  function svg(n, c, s) {
    return '<svg viewBox="0 0 24 24" width="' + (s || 16) + '" height="' + (s || 16) + '" fill="none" stroke="' + (c || 'currentColor') +
      '" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICO[n] || '') + '</svg>';
  }
  var GARDER = ['nb-majournee', 'nb-bons', 'nb-bons-encours', 'nb-bons-atransmettre', 'nb-bons-termines', 'nb-agenda', 'nb-rapports', 'nb-tickets'];
  var CLE = 'deratek_tablette';   // 'auto' | 'on' | 'off'  (choix mémorisé sur l'appareil)

  function choix() { try { return localStorage.getItem(CLE) || 'auto'; } catch (e) { return 'auto'; } }
  function estTablette() {
    // Lien ?tablette=1 (forcer) ou ?tablette=0 (annuler) : mémorisé sur l'appareil
    try { var q = new URLSearchParams(location.search).get('tablette'); if (q === '1') localStorage.setItem(CLE, 'on'); else if (q === '0') localStorage.setItem(CLE, 'off'); else if (q === 'auto') localStorage.removeItem(CLE); } catch (e) {}
    var c = choix();
    if (c === 'off') return false;
    if (window.innerWidth <= 820) return false;            // en dessous : c'est le mode téléphone qui s'applique
    if (c === 'on') return true;
    // Écran tactile sans souris (les tablettes Samsung se présentent souvent comme un PC : on ne se fie pas au nom)
    var mm = window.matchMedia ? function (q) { return matchMedia(q).matches; } : function () { return false; };
    var sansSouris = mm('(hover: none)') && mm('(pointer: coarse)');
    var tactile = (navigator.maxTouchPoints || 0) > 1;
    var android = /Android|Linux x86_64|X11; Linux/i.test(navigator.userAgent || '') && !/Windows|CrOS/i.test(navigator.userAgent || '');
    return sansSouris || (tactile && android);
  }
  window.tabletteActive = function () { return document.documentElement.classList.contains('tablette'); };
  window.tabletteBasculer = function () {
    try { localStorage.setItem(CLE, tabletteActive() ? 'off' : 'on'); } catch (e) {}
    location.reload();
  };

  // ---------- styles ----------
  var css = document.createElement('style');
  css.textContent = [
    'html.tablette .nav-btn{display:none!important}',
    GARDER.map(function (i) { return 'html.tablette #' + i; }).join(',') + '{display:flex!important}',
    'html.tablette .nav-famille{display:none!important}',
    'html.tablette .nav-famille-t{display:block}',
    '.nav-famille-t{display:none;font-size:11px;font-weight:700;color:#8590ab;margin:12px 10px 4px;letter-spacing:.3px}',
    'html.tablette .nav-btn{font-size:15px!important;padding:11px 12px!important;min-height:44px}',
    'html.tablette .nav-right-btns .nav-action-btn{display:none!important}',
    'html.tablette .nav-right-btns #btn-options, html.tablette .nav-right-btns .tb-garde{display:inline-flex!important}',
    '#nb-majournee,#nb-tickets{display:none}',
    '.tb-mode{display:none}',
    'html.tablette .tb-mode{display:inline-flex!important}',
    /* écran Ma journée */
    '#screen-majournee .mj{padding:18px 22px;display:flex;flex-direction:column;gap:14px}',
    '.mj-h{display:flex;justify-content:space-between;align-items:flex-end;gap:16px}',
    '.mj-h h1{font-size:26px;color:#1a2744;margin:0}.mj-h p{color:#6b7280;margin:2px 0 0;font-size:14px}',
    '.mj-av{width:260px}.mj-av span{font-size:12px;color:#6b7280;font-weight:700}.mj-av small{font-size:11px;color:#9ca3af}',
    '.mj-bar{height:9px;border-radius:5px;background:#e5e7eb;margin:5px 0 3px;overflow:hidden}.mj-bar i{display:block;height:100%;background:#16a34a}',
    '.mj-g{display:grid;grid-template-columns:1fr 320px;gap:16px;align-items:start}',
    '.mj-l{display:flex;flex-direction:column;gap:10px}',
    '.mj-c{display:flex;gap:12px}',
    '.mj-t{width:54px;flex:none;text-align:right;padding-top:12px}.mj-t b{display:block;font-size:16px;color:#0d1b3e}.mj-t small{font-size:12px;color:#9ca3af}',
    '.mj-d{flex:1;background:#fff;border-radius:14px;border-left:6px solid #475569;padding:14px 16px;box-shadow:0 0 0 1px #e8eaf0;display:flex;flex-direction:column;gap:12px}',
    '.mj-hd{display:flex;justify-content:space-between;gap:10px}.mj-hd b{display:block;font-size:17px;color:#0d1b3e}.mj-hd span{display:block;font-size:14px;color:#1f2937;margin-top:2px}',
    '.mj-hd small{display:block;font-size:12px;color:#6b7280;margin-top:3px}.mj-hd small.na{color:#b45309;font-weight:700}',
    '.mj-st{font-size:12px;font-weight:800;border-radius:10px;padding:4px 11px;height:max-content;white-space:nowrap}',
    '.mj-flow{display:flex;align-items:flex-start}',
    '.mj-s{display:flex;flex-direction:column;align-items:center;gap:4px;width:70px;flex:none;text-align:center}',
    '.mj-s span{width:30px;height:30px;border-radius:50%;border:2px solid #d1d5db;background:#fff;font-size:13px;font-weight:800;color:#9ca3af;display:flex;align-items:center;justify-content:center}',
    '.mj-s small{font-size:11px;color:#9ca3af;font-weight:700}.mj-s em{font-style:normal;font-size:10px;color:#6b7280}',
    '.mj-s.ok span{background:#16a34a;border-color:#16a34a;color:#fff}.mj-s.ok small{color:#166534}',
    '.mj-s.on span{background:#2563eb;border-color:#2563eb;color:#fff;box-shadow:0 0 0 5px #dbe7ff}.mj-s.on small{color:#1d4ed8}',
    '.mj-fl{flex:1;height:3px;background:#e5e7eb;margin-top:14px;border-radius:2px}.mj-fl.ok{background:#16a34a}',
    '.mj-bs{display:flex;gap:8px;flex-wrap:wrap}',
    '.mj-b{display:inline-flex;align-items:center;gap:7px;font-size:14px;font-weight:700;color:#1a2744;background:#fff;border:1.5px solid #d4d8e1;border-radius:11px;padding:11px 16px;cursor:pointer;text-decoration:none}',
    '.mj-b.pr{background:#1a2744;color:#fff;border-color:#1a2744}.mj-b.vert{background:#16a34a;border-color:#16a34a;color:#fff}',
    '.mj-0{flex:1;display:flex;gap:9px;align-items:center;font-size:14px;color:#4b5563;background:#f7f8fb;border:1.5px dashed #cfd5e1;border-radius:12px;padding:12px 14px}',
    '.mj-w{margin-left:66px;display:flex;gap:10px;align-items:center;background:#fffbeb;border:1px solid #fcd34d;border-radius:12px;padding:11px 14px}',
    '.mj-w div{flex:1}.mj-w b{display:block;font-size:14px;color:#92400e}.mj-w span{font-size:13px;color:#78350f}',
    '.mj-r{background:#fff;border-radius:14px;box-shadow:0 0 0 1px #e5e7eb;padding:14px;display:flex;flex-direction:column;gap:10px;position:sticky;top:10px}',
    '.mj-r h3{font-size:16px;color:#0d1b3e;margin:0}',
    '.mj-box{border:1px solid #eceef3;border-radius:11px;padding:10px 12px}',
    '.mj-lb{font-size:12px;font-weight:800;color:#6b7280;margin-bottom:6px}',
    '.mj-kv{display:flex;justify-content:space-between;gap:8px;padding:7px 0;border-top:1px solid #f1f2f6;font-size:13px;cursor:pointer}.mj-kv:first-of-type{border-top:0}',
    '.mj-kv span{color:#374151}.mj-kv b{color:#0d1b3e;white-space:nowrap}',
    '.mj-vide{text-align:center;padding:36px 16px;color:#6b7280;font-size:15px;background:#fff;border-radius:14px;box-shadow:0 0 0 1px #e8eaf0}',
    '#screen-tickets .tk-z{padding:18px 22px}',
  ].join('\n');
  document.head.appendChild(css);

  // ---------- menu ----------
  function bouton(id, ico, couleur, label, action) {
    var b = document.createElement('button');
    b.id = id; b.className = 'nav-btn'; b.setAttribute('onclick', action);
    b.innerHTML = '<span class="nav-ico" style="color:' + couleur + ';display:inline-flex;width:17px;height:17px;margin-right:2px">' + svg(ico, couleur, 17) + '</span><span>' + label + '</span>';
    return b;
  }
  function famille(txt) { var d = document.createElement('div'); d.className = 'nav-famille-t'; d.textContent = txt; return d; }
  function construireMenu() {
    if (document.getElementById('nb-majournee')) return;
    var bons = document.getElementById('nb-bons'), rap = document.getElementById('nb-rapports');
    if (!bons || !rap) return;
    var p = bons.parentNode;
    p.insertBefore(famille("Aujourd'hui"), bons);
    p.insertBefore(bouton('nb-majournee', 'sun', '#fbbf24', 'Ma journée', "showScreen('majournee')"), bons);
    p.insertBefore(famille('Terrain'), bons);
    var t = bouton('nb-tickets', 'receipt', '#10b981', 'Tickets de caisse', "showScreen('tickets')");
    var f = famille('Dépenses');
    if (rap.nextSibling) { p.insertBefore(f, rap.nextSibling); p.insertBefore(t, f.nextSibling); } else { p.appendChild(f); p.appendChild(t); }
    // Bouton pour passer en version complète (et revenir)
    var zone = document.querySelector('.nav-right-btns');
    if (zone && !document.getElementById('btn-tablette')) {
      var m = document.createElement('button');
      m.id = 'btn-tablette'; m.className = 'nav-action-btn no-print tb-mode tb-garde';
      m.setAttribute('onclick', 'tabletteBasculer()');
      m.innerHTML = svg('laptop', 'currentColor', 15) + '&nbsp;Version complète';
      zone.insertBefore(m, zone.firstChild);
      var lo = Array.prototype.slice.call(zone.querySelectorAll('.nav-action-btn')).filter(function (x) { return /doLogout/.test(x.getAttribute('onclick') || ''); })[0];
      if (lo) lo.classList.add('tb-garde');
    }
  }
  function construireEcrans() {
    var ref = document.getElementById('screen-agenda');
    if (!ref) return;
    if (!document.getElementById('screen-majournee')) {
      var s = document.createElement('div'); s.id = 'screen-majournee'; s.className = 'screen';
      s.innerHTML = '<div class="mj" id="mj-corps"></div>';
      ref.parentNode.insertBefore(s, ref);
    }
    if (!document.getElementById('screen-tickets')) {
      var t = document.createElement('div'); t.id = 'screen-tickets'; t.className = 'screen';
      t.innerHTML = '<div class="tk-z"><h1 style="font-size:24px;color:#1a2744;margin:0 0 12px">Tickets de caisse</h1><div id="tk-tab-slot"></div></div>';
      ref.parentNode.insertBefore(t, ref);
    }
  }

  // ---------- étapes d'une intervention ----------
  var ETAPES = ['Planifié', 'En route', 'Sur place', 'Terminé', 'Rapport', 'Envoyé'];
  function hhmm() { var d = new Date(); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function chrono(b) { try { return (_bonNoteData(b).chrono) || {}; } catch (e) { return {}; } }
  function cleJour(k) { return 'etape-' + k + '-' + today(); }
  function etatBon(b) {
    var c = chrono(b), r = (typeof _bonRapEtat === 'function') ? _bonRapEtat(b).etat : 'aucun';
    var h = { route: c[cleJour('route')] || '', place: c[cleJour('place')] || '', fin: c[cleJour('fin')] || '' };
    var faits = [true, !!(h.route || h.place || h.fin), !!(h.place || h.fin), !!h.fin, r === 'fait' || r === 'transmis', r === 'transmis' || (b.statut || '') === 'termine'];
    if (faits[4]) { faits[1] = faits[2] = faits[3] = true; }
    var cur = faits.indexOf(false); if (cur < 0) cur = 6;
    return { faits: faits, cur: cur, heures: [ '', h.route, h.place, h.fin, '', '' ], rap: r };
  }
  window.mjEtape = function (bonId, k) {
    var bons = DB.bons, b = (bons || []).find(function (x) { return x.id === bonId; });
    if (!b) return;
    var d = _bonNoteData(b), c = Object.assign({}, d.chrono || {});
    c[cleJour(k)] = hhmm();
    _bonNoteSetCle(b, 'chrono', c);
    DB.bons = bons;
    if (k === 'fin' && typeof bonAddDateEffectuee === 'function' && _bonDatesInterv(b).indexOf(today()) < 0) {
      try { bonAddDateEffectuee(bonId); } catch (e) {}
    }
    toast(k === 'route' ? '🚐 En route' : k === 'place' ? '📍 Arrivé sur place' : '✓ Intervention terminée', '#2d9e6b');
    renderMaJournee();
  };
  window.mjRapport = function (bonId) {
    var b = (DB.bons || []).find(function (x) { return x.id === bonId; }); if (!b) return;
    var e = _bonRapEtat(b);
    if (e.rap && typeof openRapportDuBon === 'function') { try { openRapportDuBon(bonId); return; } catch (x) {} }
    if (e.rap && e.rap.id && typeof editRapport === 'function') { editRapport(e.rap.id); return; }
    var n = String(_bonNoteData(b).nuisible || '') + ' ' + _bonProblemeClean(b);
    var type = /punaise/i.test(n) ? 'punaises' : /rat|souris|rongeur/i.test(n) ? 'rongeurs' : /blatte|cafard/i.test(n) ? 'blattes' : /fourmi/i.test(n) ? 'fourmis' : 'general';
    createRapportTypeFromBon(bonId, type);
  };

  function esc(s) { return (typeof _escapeHtml === 'function') ? _escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s); }
  function minutes(h) { var m = String(h || '').match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; }

  window.renderMaJournee = function () {
    var box = document.getElementById('mj-corps'); if (!box) return;
    var j = today();
    var ivs = (DB.intervs || []).filter(function (iv) { return iv.date === j; })
      .slice().sort(function (a, b) { return String(a.heure || '').localeCompare(String(b.heure || '')); });
    var jours = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
    var mois = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    var d0 = new Date();
    var titreJour = jours[d0.getDay()] + ' ' + d0.getDate() + ' ' + mois[d0.getMonth()] + ' ' + d0.getFullYear();
    var total = 0, faits = 0, html = '';

    ivs.forEach(function (iv, i) {
      var b = _mobBonDeIv(iv);
      var col = iv.couleur || '#475569';
      var adr = (b && _bonAdresseInterv(b).adresse) || iv.adresse || '';
      var tech = (b && _bonAffecte(b)) || iv.tech || '';
      var lien = adr ? 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(adr) : '';
      var corps = '';
      if (b) {
        var e = etatBon(b);
        total += 6; faits += e.faits.filter(Boolean).length;
        var fl = '';
        ETAPES.forEach(function (nom, k) {
          var cls = e.faits[k] ? 'ok' : (k === e.cur ? 'on' : '');
          fl += '<div class="mj-s ' + cls + '"><span>' + (e.faits[k] ? '✓' : (k + 1)) + '</span><small>' + nom + '</small>' + (e.heures[k] ? '<em>' + e.heures[k] + '</em>' : '') + '</div>';
          if (k < 5) fl += '<i class="mj-fl' + (e.faits[k + 1] ? ' ok' : '') + '"></i>';
        });
        var tel = String(b.gerantTel || '').replace(/\s/g, '');
        var appel = tel ? '<a class="mj-b" href="tel:' + esc(tel) + '">' + svg('phone', '#10b981', 17) + 'Appeler ' + esc(b.gerantNom || 'la gérance') + '</a>' : '';
        var iti = lien ? '<a class="mj-b" href="' + lien + '" target="_blank" rel="noopener">' + svg('navigation', '#2563eb', 17) + 'Itinéraire</a>' : '';
        var voir = '<span class="mj-b" onclick="editBon(\'' + b.id + '\')">' + svg('clipboard-list', '#64748b', 17) + 'Voir le bon</span>';
        var act = '';
        if (e.cur === 1) act = '<span class="mj-b pr" onclick="mjEtape(\'' + b.id + '\',\'route\')">' + svg('truck', '#fff', 17) + 'Je pars</span>' + iti;
        else if (e.cur === 2) act = '<span class="mj-b pr" onclick="mjEtape(\'' + b.id + '\',\'place\')">' + svg('map-pin', '#fff', 17) + 'Je suis sur place</span>' + iti;
        else if (e.cur === 3) act = '<span class="mj-b vert" onclick="mjEtape(\'' + b.id + '\',\'fin\')">' + svg('check', '#fff', 17) + 'Intervention terminée</span>';
        else if (e.cur === 4) act = '<span class="mj-b pr" onclick="mjRapport(\'' + b.id + '\')">' + svg('clipboard-list', '#fff', 17) + (e.rap === 'brouillon' ? 'Finir le rapport' : 'Faire le rapport') + '</span>';
        else if (e.cur === 5) act = '<span class="mj-b pr" onclick="bonRapTransmis(\'' + b.id + '\', true); renderMaJournee()">' + svg('send', '#fff', 17) + 'Marquer transmis à la gérance</span>';
        else act = '<span class="mj-b" style="color:#166534;border-color:#bbf7d0;background:#f0fdf4">' + svg('check', '#16a34a', 17) + 'Tout est fait</span>';
        var etiq = ['', 'À faire', 'En route', 'Sur place', 'Rapport à faire', 'À transmettre', 'Terminé'][e.cur];
        var ec = { 'À faire': ['#f1f5f9', '#334155'], 'En route': ['#dbeafe', '#1d4ed8'], 'Sur place': ['#dcfce7', '#166534'], 'Rapport à faire': ['#ede9fe', '#6d28d9'], 'À transmettre': ['#fef3c7', '#92400e'], 'Terminé': ['#dcfce7', '#166534'] }[etiq] || ['#f1f5f9', '#334155'];
        corps = '<div class="mj-hd"><div><b>' + esc(iv.clientNom || b.geranceNom || '') + '</b><span>' + esc(adr) + (iv.nuisible ? ' · ' + esc(iv.nuisible) : '') + '</span>' +
          '<small class="' + (tech ? '' : 'na') + '">Bon ' + esc(b.numero || '') + ' · ' + (tech ? 'technicien : ' + esc(tech) : 'technicien non attribué') + '</small></div>' +
          '<span class="mj-st" style="background:' + ec[0] + ';color:' + ec[1] + '">' + etiq + '</span></div>' +
          '<div class="mj-flow">' + fl + '</div><div class="mj-bs">' + act + appel + voir + '</div>';
      } else {
        corps = '<div class="mj-hd"><div><b>' + esc(iv.clientNom || '') + '</b><span>' + esc(adr) + '</span><small class="na">Aucun bon lié à ce rendez-vous</small></div></div>' +
          (lien ? '<div class="mj-bs"><a class="mj-b" href="' + lien + '" target="_blank" rel="noopener">' + svg('navigation', '#2563eb', 17) + 'Itinéraire</a></div>' : '');
      }
      html += '<div class="mj-c"><div class="mj-t"><b>' + esc(iv.heure || '--:--') + '</b><small>' + esc(iv.heureFin || '') + '</small></div><div class="mj-d" style="border-left-color:' + col + '">' + corps + '</div></div>';
      // Chevauchement avec le rendez-vous suivant
      var nx = ivs[i + 1];
      if (nx) {
        var fin = minutes(iv.heureFin), deb = minutes(nx.heure);
        var bn = _mobBonDeIv(nx);
        var t1 = tech, t2 = (bn && _bonAffecte(bn)) || nx.tech || '';
        if (fin != null && deb != null && deb < fin && !(t1 && t2 && t1 !== t2)) {
          html += '<div class="mj-w">' + svg('triangle-alert', '#b45309', 20) + '<div><b>Ces deux interventions se chevauchent de ' + esc(nx.heure) + ' à ' + esc(iv.heureFin) + '</b>' +
            '<span>Attribuez chaque bon à un technicien différent, ou décalez l\'un des rendez-vous.</span></div>' +
            '<span class="mj-b" onclick="showScreen(\'agenda\')">' + svg('calendar-days', '#1a2744', 16) + 'Agenda</span></div>';
        }
      }
    });
    if (!ivs.length) html = '<div class="mj-vide">Aucune intervention planifiée aujourd\'hui.<br><br><span class="mj-b pr" onclick="showBonsActifs()">' + svg('calendar-days', '#fff', 17) + 'Planifier un bon</span></div>';
    else html = '<div class="mj-c"><div class="mj-t"><b>Début</b></div><div class="mj-0">' + svg('truck', '#64748b', 18) + 'Départ · vérifier le matériel pour ' + (ivs.length > 1 ? 'les ' + ivs.length + ' interventions' : 'l\'intervention') + ' du jour</div></div>' + html +
      '<div class="mj-c"><div class="mj-t"><b>Fin</b></div><div class="mj-0">' + svg('clipboard-list', '#8b5cf6', 18) + 'Faire les rapports du jour et les envoyer aux gérances</div></div>';

    // Colonne de droite
    var passes = (DB.bons || []).filter(function (b) {
      if ((b.statut || '') !== 'en-cours') return false;
      var d = b.dateIntervention || ''; if (!d || d >= j) return false;
      var e = _bonRapEtat(b).etat; return e === 'aucun' || e === 'brouillon';
    }).sort(function (a, b) { return String(b.dateIntervention).localeCompare(String(a.dateIntervention)); });
    var atr = (DB.bons || []).filter(function (b) { return (b.statut || '') === 'a-transmettre'; }).length;
    var dem = new Date(); dem.setDate(dem.getDate() + 1);
    var jd = (typeof localDateStr === 'function') ? localDateStr(dem) : dem.toISOString().slice(0, 10);
    var nDem = (DB.intervs || []).filter(function (iv) { return iv.date === jd; }).length;
    var aPlan = (DB.bons || []).filter(function (b) { return (b.statut || '') === '' || b.statut === 'urgent'; }).length;
    var droite = '<aside class="mj-r"><h3>Avant de finir la journée</h3>' +
      '<div class="mj-box"><div class="mj-lb">Rapports à faire · ' + passes.length + '</div>' +
      (passes.slice(0, 6).map(function (b) { return '<div class="mj-kv" onclick="mjRapport(\'' + b.id + '\')"><span>' + esc((b.geranceNom || '').slice(0, 26)) + ' · ' + esc(fmtDate(b.dateIntervention)) + '</span><b>' + esc(b.numero || '') + '</b></div>'; }).join('') || '<div style="font-size:13px;color:#6b7280">Rien en retard 👍</div>') + '</div>' +
      '<div class="mj-box"><div class="mj-kv" onclick="showBonsATransmettre()"><span>Rapports à transmettre</span><b>' + atr + '</b></div></div>' +
      '<div class="mj-box"><div class="mj-lb">Demain · ' + jours[dem.getDay()] + ' ' + dem.getDate() + '</div><div style="font-size:13px;color:#374151">' +
      (nDem ? nDem + ' intervention' + (nDem > 1 ? 's' : '') + ' planifiée' + (nDem > 1 ? 's' : '') : 'Aucune intervention planifiée.') + (aPlan ? ' ' + aPlan + ' bon' + (aPlan > 1 ? 's' : '') + ' attendent une date.' : '') + '</div></div>' +
      '<span class="mj-b pr" style="justify-content:center" onclick="showBonsActifs()">' + svg('calendar-days', '#fff', 17) + 'Planifier des bons</span></aside>';

    var pct = total ? Math.round(faits / total * 100) : 0;
    box.innerHTML = '<div class="mj-h"><div><h1>Ma journée</h1><p>' + titreJour.charAt(0).toUpperCase() + titreJour.slice(1) + ' · ' + ivs.length + ' intervention' + (ivs.length > 1 ? 's' : '') + '</p></div>' +
      (total ? '<div class="mj-av"><span>Avancement de la journée</span><div class="mj-bar"><i style="width:' + pct + '%"></i></div><small>' + faits + ' étapes sur ' + total + '</small></div>' : '') + '</div>' +
      '<div class="mj-g"><div class="mj-l">' + html + '</div>' + droite + '</div>';
  };

  // ---------- branchement sur la navigation ----------
  function brancher() {
    if (window._tbShowScreenOrig) return;
    window._tbShowScreenOrig = window.showScreen;
    window.showScreen = function (name) {
      if (name !== 'tickets' && typeof _tkRamener === 'function') { try { _tkRamener(); } catch (e) {} }
      var r = window._tbShowScreenOrig.apply(this, arguments);
      if (name === 'majournee') renderMaJournee();
      if (name === 'tickets') {
        var card = document.getElementById('tk-card'), slot = document.getElementById('tk-tab-slot');
        if (card && slot) { slot.appendChild(card); try { renderTickets(); } catch (e) {} }
      }
      return r;
    };
  }

  var fait = false;
  function demarrer() {
    if (fait) return;
    var app = document.getElementById('app');
    if (!app || app.style.display === 'none' || typeof DB === 'undefined' || !DB.bons) return;
    if (!estTablette()) { fait = true; return; }
    fait = true;
    document.documentElement.classList.add('tablette');
    if (typeof OPT !== 'undefined' && OPT.style !== 'cockpit') { OPT.style = 'cockpit'; try { optApply(); } catch (e) {} }   // menu sur le côté, sans enregistrer le choix
    construireMenu(); construireEcrans(); brancher();
    try { showScreen('majournee'); } catch (e) {}
  }
  var tick = setInterval(function () { demarrer(); if (fait) clearInterval(tick); }, 500);
  // Le menu est reconstruit par le style Cockpit : on remet nos boutons si besoin
  if (typeof window._cockpitFamilles === 'function') {
    var o = window._cockpitFamilles;
    window._cockpitFamilles = function () { var r = o.apply(this, arguments); if (document.documentElement.classList.contains('tablette')) { try { construireMenu(); } catch (e) {} } return r; };
  }
})();
