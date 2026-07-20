/* ============================================================
   DERATEK — Application v3.0 (Supabase)
   ============================================================ */

// ============================================================
// SUPABASE CLIENT + COUCHE DB (cache mémoire + sync async)
// ============================================================
let sb = null;
function initSupabase() {
  if (!window.supabase || !window.supabase.createClient) {
    console.error('Lib Supabase non chargée');
    return false;
  }
  sb = window.supabase.createClient(
    DERATEK_CONFIG.supabase.url,
    DERATEK_CONFIG.supabase.anonKey,
    { auth: { persistSession: true, autoRefreshToken: true } }
  );
  return true;
}

// Génération d'ID (UUID v4 si dispo)
const newId = () => (window.crypto && crypto.randomUUID)
  ? crypto.randomUUID()
  : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);

// Mapping JS field → Supabase column (uniquement pour les champs qui diffèrent)
const TABLE_FIELDS = {
  clients:    { js2db: {} },
  locataires: { js2db: { clientId: 'client_id', createdAt: 'created_at' } },
  bons:       { js2db: {
    date: 'date_bon',
    geranceId: 'gerance_id', geranceNom: 'gerance_nom',
    locataireId: 'locataire_id', locataireNom: 'locataire_nom',
    gerantNom: 'gerant_nom', gerantTel: 'gerant_tel', gerantEmail: 'gerant_email',
    contactSurPlace: 'contact_sur_place',
    createdAt: 'created_at',
    pdfPath: 'pdf_path',
    dateIntervention: 'date_intervention',
    heureIntervention: 'heure_intervention',
  } },
  rapports:   { js2db: {
    clientId: 'client_id', clientNom: 'client_nom', clientEmail: 'client_email',
    bonCommande: 'bon_commande', rdvHeure: 'rdv_heure',
    locataireNom: 'locataire_nom', locataireTel: 'locataire_tel',
    locataireEmail: 'locataire_email', locataireAdresse: 'locataire_adresse',
    nbPassages: 'nb_passages', datesIntervention: 'dates_intervention', archive: 'archive',
  } },
  techs:      { js2db: {} },
  prestations:{ js2db: {} },
  diagnostics:{ js2db: {
    dateDoc: 'date_doc', clientId: 'client_id', clientNom: 'client_nom',
    locataireNom: 'locataire_nom', locataireAdresse: 'locataire_adresse',
    elementsTouches: 'elements_touches', bonId: 'bon_id',
  } },
  fournisseurs:{ js2db: { dateDoc: 'date_doc', pdfPath: 'pdf_path', montantHt: 'montant_ht' } },
  intervs:    { js2db: { clientId: 'client_id', clientNom: 'client_nom', bonId: 'bon_id', bonNumero: 'bon_numero' } },
  documents:  { js2db: {
    dateDoc: 'date_doc', clientId: 'client_id', clientNom: 'client_nom',
    clientAdresse: 'client_adresse', clientNpa: 'client_npa', clientVille: 'client_ville',
    locataireNom: 'locataire_nom', locataireAdresse: 'locataire_adresse', bonId: 'bon_id',
    sousTotal: 'sous_total', tvaTaux: 'tva_taux', tvaMontant: 'tva_montant',
    rabaisMontant: 'rabais_montant',
    devisId: 'devis_id',
  } },
};
const META_COLS = new Set(['user_id', 'created_at']);

// Colonnes de type DATE côté Supabase (par table) : une chaîne vide y est invalide → null
const DATE_COLS = {
  rapports:     new Set(['date', 'rdv']),
  intervs:      new Set(['date']),
  documents:    new Set(['date_doc']),
  fournisseurs: new Set(['date_doc']),
  bons:         new Set(['date', 'date_intervention']),
  diagnostics:  new Set(['date_doc']),
};

// Colonnes de type UUID côté Supabase (liens entre tables) : une chaîne vide y est invalide → null
const UUID_COLS = {
  bons:        new Set(['gerance_id', 'locataire_id']),
  documents:   new Set(['client_id', 'bon_id', 'devis_id']),
  rapports:    new Set(['client_id']),
  intervs:     new Set(['client_id', 'bon_id']),
  locataires:  new Set(['client_id']),
  diagnostics: new Set(['client_id', 'bon_id']),
};

function toDb(table, obj) {
  const map = TABLE_FIELDS[table].js2db;
  const dateCols = DATE_COLS[table];
  const out = {};
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined) continue;
    const col = map[k] || k;
    let val = obj[k];
    const vide = (val === '' || val === undefined || val === null);
    // Valeur vide → null pour : colonnes date, ET toute colonne UUID/FK
    // (nom finissant par "_id" ou égal à "id"), que Postgres refuse en "".
    if (vide && ((dateCols && dateCols.has(col)) || /(^|_)id$/.test(col))) {
      val = null;
    }
    out[col] = val;
  }
  return out;
}
function toJs(table, row) {
  const map = TABLE_FIELDS[table].js2db;
  const reverse = {};
  for (const k of Object.keys(map)) reverse[map[k]] = k;
  const out = {};
  for (const k of Object.keys(row)) {
    if (META_COLS.has(k) && k !== 'created_at') continue;
    if (k === 'created_at' && table !== 'locataires' && table !== 'bons') continue;
    out[reverse[k] || k] = row[k];
  }
  return out;
}

const DB = {
  _cache:      { techs: [], clients: [], rapports: [], intervs: [], locataires: [], bons: [], documents: [], prestations: [], diagnostics: [], fournisseurs: [] },
  _lastSync:   { techs: [], clients: [], rapports: [], intervs: [], locataires: [], bons: [], documents: [], prestations: [], diagnostics: [], fournisseurs: [] },
  _pending:    new Set(),
  _processing: false,
  _notifyOnSync: {},   // ex. { rapports: '✓ Rapport enregistré dans le cloud' } → toast vert après succès réel
  // Ordre IMPORTANT : tables sans dépendance FK d'abord, puis tables dépendantes
  // clients, locataires (qui dépendent de clients), rapports/intervs (qui dépendent de clients),
  // bons (qui dépendent de clients ET de locataires), documents (devis/factures)
  _syncOrder:  ['techs', 'prestations', 'clients', 'locataires', 'rapports', 'intervs', 'bons', 'documents', 'diagnostics', 'fournisseurs'],

  get techs()       { return this._cache.techs; },
  set techs(v)      { this._cache.techs = v;      this._queue('techs'); },
  get clients()     { return this._cache.clients; },
  set clients(v)    { this._cache.clients = v;    this._queue('clients'); },
  get rapports()    { return this._cache.rapports; },
  set rapports(v)   { this._cache.rapports = v;   this._queue('rapports'); },
  get intervs()     { return this._cache.intervs; },
  set intervs(v)    { this._cache.intervs = v;    this._queue('intervs'); },
  get locataires()  { return this._cache.locataires; },
  set locataires(v) { this._cache.locataires = v; this._queue('locataires'); },
  get bons()        { return this._cache.bons; },
  set bons(v)       { this._cache.bons = v;       this._queue('bons'); },
  get documents()   { return this._cache.documents; },
  set documents(v)  { this._cache.documents = v;  this._queue('documents'); },
  get prestations() { return this._cache.prestations; },
  set prestations(v){ this._cache.prestations = v; this._queue('prestations'); },
  get diagnostics() { return this._cache.diagnostics; },
  set diagnostics(v){ this._cache.diagnostics = v; this._queue('diagnostics'); },
  get fournisseurs() { return this._cache.fournisseurs; },
  set fournisseurs(v){ this._cache.fournisseurs = v; this._queue('fournisseurs'); },

  _queue(table) {
    this._pending.add(table);
    if (this._processing) return;
    this._processing = true;
    setTimeout(() => this._processQueue(), 80);
  },

  async _processQueue() {
    // Traite les tables EN SÉQUENCE selon l'ordre des dépendances FK
    for (const t of this._syncOrder) {
      if (this._pending.has(t)) {
        this._pending.delete(t);
        try { await this._sync(t); } catch (e) { console.warn('Sync', t, e); }
      }
    }
    this._processing = false;
    // Si des écritures sont arrivées pendant le traitement, on relance
    if (this._pending.size > 0) {
      this._processing = true;
      setTimeout(() => this._processQueue(), 80);
    }
  },

  async loadAll() {
    if (!sb) return;
    const tables = ['clients', 'locataires', 'bons', 'rapports', 'techs', 'intervs', 'documents', 'prestations', 'diagnostics', 'fournisseurs'];
    for (const t of tables) {
      try {
        const { data, error } = await sb.from(t).select('*');
        if (error) { console.warn('Load', t, error); continue; }
        if (t === 'techs') {
          this._cache.techs = (data || []).map(r => r.nom).filter(Boolean);
        } else {
          this._cache[t] = (data || []).map(r => toJs(t, r));
        }
        this._lastSync[t] = JSON.parse(JSON.stringify(this._cache[t]));
      } catch (err) { console.warn('Load error', t, err); }
    }
  },

  async _sync(table) {
    if (!sb) return;
    let _syncFailed = false;
    const oldArr = this._lastSync[table] || [];
    const newArr = this._cache[table] || [];

    if (table === 'techs') {
      const oldSet = new Set(oldArr);
      const newSet = new Set(newArr);
      const toAdd    = [...newSet].filter(x => !oldSet.has(x));
      const toRemove = [...oldSet].filter(x => !newSet.has(x));
      if (toRemove.length) {
        const { error } = await sb.from('techs').delete().in('nom', toRemove);
        if (error) console.warn('Techs delete', error);
      }
      if (toAdd.length) {
        const { error } = await sb.from('techs').insert(toAdd.map(nom => ({ id: newId(), nom })));
        if (error) console.warn('Techs insert', error);
      }
      this._lastSync.techs = newArr.slice();
      return;
    }

    const oldById = {};
    oldArr.forEach(x => { if (x && x.id) oldById[x.id] = x; });
    const oldIds = new Set(Object.keys(oldById));
    const newIds = new Set(newArr.filter(x => x && x.id).map(x => x.id));
    const toDelete = [...oldIds].filter(id => !newIds.has(id));
    const toUpsert = newArr.filter(x => {
      if (!x || !x.id) return false;
      if (!oldIds.has(x.id)) return true;
      return JSON.stringify(x) !== JSON.stringify(oldById[x.id]);
    });

    if (toDelete.length) {
      const { error } = await sb.from(table).delete().in('id', toDelete);
      if (error) console.warn(table, 'delete', error);
    }
    if (toUpsert.length) {
      // Colonnes déjà identifiées comme absentes côté Supabase pour cette table
      DB._dropCols = DB._dropCols || {};
      const dropSet = (DB._dropCols[table] = DB._dropCols[table] || new Set());
      const buildRows = () => toUpsert.map(o => {
        const row = toDb(table, o);
        dropSet.forEach(c => { delete row[c]; });
        return row;
      });
      let attempt = 0, ok = false, lastErr = null;
      // Jusqu'à 6 tentatives : à chaque colonne refusée, on la retire et on réessaie
      while (attempt < 6 && !ok) {
        attempt++;
        const { error } = await sb.from(table).upsert(buildRows());
        if (!error) { ok = true; break; }
        lastErr = error;
        // Détecte le nom de la colonne fautive dans le message d'erreur PostgREST
        const msg = String(error.message || '') + ' ' + String(error.details || '') + ' ' + String(error.hint || '');
        const m = msg.match(/'([^']+)' column/) || msg.match(/column "([^"]+)"/) || msg.match(/column [a-z0-9_]+\.([a-z0-9_]+)/i) || msg.match(/column ([a-z0-9_]+) /i);
        const col = m && m[1];
        if (col && !dropSet.has(col)) {
          console.warn(table, 'colonne ignorée (absente côté Supabase) :', col);
          dropSet.add(col);
          continue; // on retire la colonne et on réessaie
        }
        break; // erreur non liée à une colonne → on arrête
      }
      if (!ok && lastErr) {
        _syncFailed = true;
        console.warn(table, 'upsert', lastErr);
        if (typeof toast === 'function') toast('Erreur de sauvegarde Supabase : ' + lastErr.message, '#e63946');
      }
    }
    this._lastSync[table] = JSON.parse(JSON.stringify(newArr));
    // Confirmation « enregistré dans le cloud » : uniquement si l'envoi a réussi
    if (!_syncFailed && this._notifyOnSync && this._notifyOnSync[table]) {
      const _msg = this._notifyOnSync[table];
      delete this._notifyOnSync[table];
      if (typeof toast === 'function') toast(_msg, '#2d9e6b');
    }
  },

  _resetCache() {
    this._cache    = { techs: [], clients: [], rapports: [], intervs: [], locataires: [], bons: [], documents: [], prestations: [], diagnostics: [], fournisseurs: [] };
    this._lastSync = { techs: [], clients: [], rapports: [], intervs: [], locataires: [], bons: [], documents: [], prestations: [], diagnostics: [], fournisseurs: [] };
    this._pending  = new Set();
    this._processing = false;
  }
};

// Plus de seed (Supabase = compte vide au début, utilisateur ajoute ses propres données)
function seedData() { /* no-op en mode Supabase */ }

// ============================================================
// STATE
// ============================================================
let state = {
  anc: { queue: [], qIdx: 0, fileName: '' },
  docStatutFilter: 'tous',
  docGroupBy: 'gerance',
  editingRapportId: null,
  editingClientId:  null,
  editingIntervId:  null,
  editingLocataireId: null,
  rapportsFilter:   'Tous',
  clientsFilter:    'Tous',
  bonsFilter:       'actifs',   // 'actifs' (non terminés) ou 'termines'
  docsFilter:       'devis',    // 'devis' ou 'facture' (onglet Devis / Factures séparés)
  agendaView:       'google',
  agendaDate:       new Date(),
  photos:           [null, null, null, null, null, null],
  currentPhotoSlot: 0,
  produits:         [],
  selectedColor:    '#e63946',
  sigDrawing:       false,
};

// ============================================================
// UTILS
// ============================================================
const $ = id => document.getElementById(id);
const fmtDate = d => { if (!d) return '—'; try { const [y,m,dd] = d.split('-'); return `${dd}.${m}.${y}`; } catch { return d; } };
// Date locale au format YYYY-MM-DD (évite le décalage de fuseau de toISOString)
const localDateStr = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const today = () => localDateStr(new Date());
// Numéro de rapport = plus GRAND numéro existant + 1 (jamais le simple compte, qui
// provoquait des collisions/écrasements après suppression ou avec des brouillons).
const genId = () => {
  const year = new Date().getFullYear();
  const re = new RegExp('^R-' + year + '-(\\d+)$');
  let max = 420;
  (DB.rapports || []).forEach(r => { const m = re.exec(String(r && r.id || '')); if (m) max = Math.max(max, parseInt(m[1], 10)); });
  return `R-${year}-${String(max + 1).padStart(4, '0')}`;
};
const colorType = t => ({Gérance:'#f4a623',Particulier:'#7c3aed',PPE:'#2d9e6b',Commune:'#2563eb',Association:'#0ea5e9',Entreprise:'#e63946'}[t] || '#6b7280');
// Palette de 12 couleurs distinctes pour différencier visuellement les gérances entre elles
const GERANCE_PALETTE = [
  '#3b82f6', // bleu
  '#ef4444', // rouge
  '#10b981', // vert
  '#f59e0b', // ambre
  '#8b5cf6', // violet
  '#ec4899', // rose
  '#14b8a6', // teal
  '#f97316', // orange
  '#6366f1', // indigo
  '#84cc16', // lime
  '#0ea5e9', // ciel
  '#d946ef'  // magenta
];
// Couleur déterministe à partir d'un nom (hash FNV-1a 32-bit)
// Nom canonique d'une gérance : fusionne les variantes (ex "CPCN" et "Gérance CPCN").
// On retire le préfixe "Gérance/Régie/..." et on unifie la casse/les espaces.
function _geranceCanon(nom) {
  let s = String(nom || '').trim();
  if (!s) return '';
  const cle = s.toLowerCase()
    .replace(/^(g[ée]rance|r[ée]gie|immobili[èe]re?|agence)\s+/i, '')
    .replace(/\s+/g, ' ').trim();
  // Table d'équivalences connues (clé normalisée → libellé affiché unique)
  const ALIAS = {
    'cpcn': 'Gérance CPCN',
  };
  if (ALIAS[cle]) return ALIAS[cle];
  return s; // sinon on garde le nom tel quel
}
function colorForGeranceName(nom) {
  const key = String(_geranceCanon(nom) || '').toLowerCase().trim();
  if (!key) return '#6b7280';
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return GERANCE_PALETTE[hash % GERANCE_PALETTE.length];
}
// Version très pâle d'une couleur hex (#rrggbb) pour servir de fond léger.
// alpha 0..1 = quantité de couleur mélangée à du blanc.
function _hexTint(hex, alpha) {
  const m = String(hex || '').replace('#','').match(/^([0-9a-f]{6})$/i);
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const a = (alpha == null) ? 0.10 : alpha;
  const mix = c => Math.round(c * a + 255 * (1 - a));
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}
function colorForClient(c) {
  if (!c) return '#6b7280';
  // Les non-gérances gardent la couleur définie par leur type
  if (c.type !== 'Gérance') return colorType(c.type);
  // Pour les gérances : couleur déterministe basée sur le nom (chaque gérance a SA couleur)
  return colorForGeranceName(c.nom || c.id);
}
const badgeCls = s => ({Brouillon:'b-gray',Envoyé:'b-green',Finalisé:'b-blue',Terminée:'b-green','En cours':'b-blue',Planifiée:'b-gray',Urgent:'b-red',Annulée:'b-gray'}[s] || 'b-gray');
const initials = nom => nom.split(' ').filter(w => w.length > 1).slice(0,2).map(w => w[0].toUpperCase()).join('') || nom.slice(0,2).toUpperCase();

// Ouvre l'écran Devis/Factures filtré sur un type ('devis' ou 'facture')
function showDocsScreen(type) {
  state.docsFilter = (type === 'facture') ? 'facture' : 'devis';
  state.docStatutFilter = 'tous';   // réinitialise le filtre par statut à chaque changement d'onglet
  showScreen('devis');
  // Surligne le bon bouton du menu (devis ou factures)
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const nb = $(state.docsFilter === 'facture' ? 'nb-factures' : 'nb-devis');
  if (nb) nb.classList.add('active');
}
// Filtre la liste des factures/devis par statut (chips récap)
function docSetStatutFilter(v) {
  state.docStatutFilter = v || 'tous';
  renderDocuments();
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screen = $(`screen-${name}`);
  if (screen) screen.classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const nb = $(`nb-${name}`);
  if (nb) nb.classList.add('active');
  if (typeof updateBonsCounts === 'function') updateBonsCounts();
  if (name === 'anciennes' && typeof renderAnciennesList === 'function') renderAnciennesList();
  if (name === 'fact-archive' && typeof renderFactArchive === 'function') renderFactArchive();
  if (name === 'dashboard')    renderDashboard();
  if (name === 'clients')      renderClients();
  if (name === 'rapports')     { renderRapports(); renderDiagnostics(); }
  if (name === 'agenda')       renderAgenda();
  if (name === 'locataires')   renderLocataires();
  if (name === 'bons')         { renderBons(); setTimeout(adjustStickyOffsets, 0); }
  if (name === 'devis')        renderDocuments();
  if (name === 'fournisseurs') renderFournisseurs();
  if (name === 'tva')          renderTVA();
  if (name === 'stats')        renderStats();
  window.scrollTo(0, 0);
}

function toast(msg, color) {
  const t = $('toast');
  t.textContent = msg; t.style.background = color || '#1a2744';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}

function openModal(id)  {
  const bg = $(id); if (!bg) return;
  // Réinitialise la position : une modale rouverte revient toujours centrée
  const box = bg.querySelector('.modal'); if (box) box.style.transform = '';
  bg.classList.add('open');
}
function closeModal(id) { $(id).classList.remove('open'); }

// ============================================================
// MODALES DÉPLAÇABLES — glisser la fenêtre par son en-tête
// (double-clic sur l'en-tête = recentrer)
// ============================================================
(function () {
  let box = null, startX = 0, startY = 0, origX = 0, origY = 0;
  const posOf = el => {
    const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform || '');
    return m ? { x: parseFloat(m[1]), y: parseFloat(m[2]) } : { x: 0, y: 0 };
  };
  const start = (el, x, y) => {
    box = el;
    const p = posOf(el);
    origX = p.x; origY = p.y; startX = x; startY = y;
    el.style.transition = 'none';
    document.body.style.userSelect = 'none';
  };
  const move = (x, y) => {
    if (!box) return;
    // On garde toujours l'en-tête accessible à l'écran (pas de fenêtre perdue hors cadre)
    const r = box.getBoundingClientRect();
    let nx = origX + (x - startX), ny = origY + (y - startY);
    const maxX = window.innerWidth  - 80 - (r.left - posOf(box).x);
    const minX = -(r.left - posOf(box).x) - r.width + 120;
    const maxY = window.innerHeight - 60 - (r.top - posOf(box).y);
    const minY = -(r.top - posOf(box).y);
    nx = Math.max(minX, Math.min(maxX, nx));
    ny = Math.max(minY, Math.min(maxY, ny));
    box.style.transform = 'translate(' + nx + 'px, ' + ny + 'px)';
  };
  const end = () => { if (!box) return; box.style.transition = ''; box = null; document.body.style.userSelect = ''; };

  document.addEventListener('mousedown', function (e) {
    const hd = e.target.closest && e.target.closest('.modal-hd');
    if (!hd) return;
    // Pas de glisser depuis un bouton ou un champ de l'en-tête
    if (e.target.closest('button, a, input, select, textarea, label')) return;
    const el = hd.closest('.modal'); if (!el) return;
    start(el, e.clientX, e.clientY);
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => move(e.clientX, e.clientY));
  document.addEventListener('mouseup', end);

  // Tactile (iPad / écran tactile)
  document.addEventListener('touchstart', function (e) {
    const t = e.target;
    const hd = t.closest && t.closest('.modal-hd');
    if (!hd) return;
    if (t.closest('button, a, input, select, textarea, label')) return;
    const el = hd.closest('.modal'); if (!el) return;
    start(el, e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  document.addEventListener('touchmove', function (e) {
    if (!box) return;
    move(e.touches[0].clientX, e.touches[0].clientY);
    e.preventDefault();
  }, { passive: false });
  document.addEventListener('touchend', end);

  // Double-clic sur l'en-tête → recentrer la fenêtre
  document.addEventListener('dblclick', function (e) {
    const hd = e.target.closest && e.target.closest('.modal-hd');
    if (!hd) return;
    if (e.target.closest('button, a, input, select, textarea, label')) return;
    const el = hd.closest('.modal'); if (el) el.style.transform = '';
  });
})();

function setFilter(sc, val, el) {
  const map = { rapports: 'rapportsFilter', clients: 'clientsFilter', interventions: 'intervFilter' };
  state[map[sc]] = val;
  el.closest('.pills').querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  if (sc === 'rapports')     renderRapports();
  if (sc === 'clients')      renderClients();
  if (sc === 'interventions') renderInterventions();
}

// ============================================================
// LOGIN
// ============================================================
async function doLogin() {
  const emailEl = $('login-email');
  const pwdEl   = $('login-pwd');
  const errEl   = $('login-error');
  const btn     = $('login-btn');
  const email = emailEl ? emailEl.value.trim() : '';
  const pwd   = pwdEl ? pwdEl.value : '';
  if (!email || !pwd) {
    if (errEl) { errEl.textContent = 'Email et mot de passe requis'; errEl.style.display = 'block'; }
    return;
  }
  if (!sb && !initSupabase()) {
    if (errEl) { errEl.textContent = 'Impossible de se connecter à Supabase'; errEl.style.display = 'block'; }
    return;
  }
  const origLabel = btn ? btn.textContent : '';
  if (btn) { btn.textContent = 'Connexion…'; btn.disabled = true; }
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password: pwd });
    if (error) {
      if (errEl) {
        errEl.textContent = (/invalid|credentials/i).test(error.message) ? 'Email ou mot de passe incorrect' : ('Erreur : ' + error.message);
        errEl.style.display = 'block';
      }
      return;
    }
    if (btn) btn.textContent = 'Chargement des données…';
    await DB.loadAll();
    $('login-screen').style.display = 'none';
    $('app').style.display = 'block';
    if (typeof emailjs !== 'undefined' && emailjs.init) {
      try { emailjs.init(DERATEK_CONFIG.emailjs.publicKey); } catch (e) {}
    }
    renderDashboard();
    setTimeout(_autoBackupCheck, 1500);
  } catch (err) {
    if (errEl) { errEl.textContent = 'Erreur : ' + err.message; errEl.style.display = 'block'; }
  } finally {
    if (btn) { btn.textContent = origLabel || 'Se connecter'; btn.disabled = false; }
  }
}

async function doLogout() {
  try { if (sb) await sb.auth.signOut(); } catch (e) {}
  DB._resetCache();
  $('app').style.display = 'none';
  $('login-screen').style.display = 'flex';
  const e = $('login-email'); if (e) e.value = '';
  const p = $('login-pwd');   if (p) p.value = '';
  const er = $('login-error'); if (er) er.style.display = 'none';
}

// ============================================================
// DASHBOARD
// ============================================================
// ---- Blocs-notes du dashboard (1 par personne) — table Supabase notes_tableau, 1 ligne par clé ----
const _NOTE_KEYS = ['jessy', 'dany'];
const _NOTE_COLORS = ['#000000','#6b7280','#e63946','#ea580c','#ca8a04','#16a34a','#0d9488','#2563eb','#7c3aed','#db2777'];
let _noteTimers = {};
let _noteHL = { jessy: false, dany: false };

function _noteFocus(key){ const el = $('note-' + key); if (el) el.focus(); return el; }
function noteExec(key, cmd){ _noteFocus(key); try { document.execCommand(cmd, false, null); } catch (e) {} noteOnInput(key); }
function noteFont(key, val){ _noteFocus(key); try { document.execCommand('fontName', false, val); } catch (e) {} noteOnInput(key); }
function noteSize(key, val){ _noteFocus(key); try { document.execCommand('fontSize', false, val); } catch (e) {} noteOnInput(key); }
function noteColor(key, hex){ _noteFocus(key); try { document.execCommand(_noteHL[key] ? 'hiliteColor' : 'foreColor', false, hex); } catch (e) {} noteOnInput(key); }
// Bascule mode surlignement : quand actif, les pastilles de couleur s'appliquent en surlignement (fond) au lieu du texte
function noteToggleHL(key){
  _noteHL[key] = !_noteHL[key];
  const b = $('hl-' + key);
  if (b) { b.style.background = _noteHL[key] ? '#fde68a' : ''; b.style.color = _noteHL[key] ? '#7c2d12' : ''; b.style.borderColor = _noteHL[key] ? '#f59e0b' : ''; }
}
// Insère une case à cocher cliquable (tâche à valider) au curseur
function noteAddTask(key){
  const el = _noteFocus(key); if (!el) return;
  const sel = window.getSelection();
  let range;
  if (sel.rangeCount && el.contains(sel.anchorNode)) { range = sel.getRangeAt(0); }
  else { range = document.createRange(); range.selectNodeContents(el); range.collapse(false); }
  range.deleteContents();
  const sp = document.createElement('span'); sp.className = 'note-txt'; sp.innerHTML = '&nbsp;';
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'note-cb'; cb.setAttribute('contenteditable', 'false');
  range.insertNode(sp);
  range.insertNode(cb);
  const r2 = document.createRange(); r2.setStart(sp, 0); r2.collapse(true);
  sel.removeAllRanges(); sel.addRange(r2);
  noteOnInput(key);
}
// Délégation : cocher/décocher une case persiste l'état (attribut checked) et sauvegarde
function initNoteEditors(){
  _NOTE_KEYS.forEach(function(key){
    const el = $('note-' + key); if (!el || el.dataset.init) return;
    el.dataset.init = '1';
    el.addEventListener('change', function(e){
      const t = e.target;
      if (t && t.classList && t.classList.contains('note-cb')) {
        if (t.checked) t.setAttribute('checked', ''); else t.removeAttribute('checked');
        noteOnInput(key);
      }
    });
  });
}
function initNotePalettes(){
  _NOTE_KEYS.forEach(function(key){
    const pal = $('pal-' + key); if (!pal || pal.dataset.done) return;
    pal.dataset.done = '1';
    _NOTE_COLORS.forEach(function(hex){
      const d = document.createElement('button');
      d.type = 'button'; d.title = 'Couleur'; d.className = 'note-sw';
      d.style.background = hex;
      d.onmousedown = function(e){ e.preventDefault(); };
      d.onclick = function(){ noteColor(key, hex); };
      pal.appendChild(d);
    });
  });
}
async function loadDashNotes(){
  if (!sb) return;
  initNotePalettes();
  initNoteEditors();
  for (const key of _NOTE_KEYS) {
    const el = $('note-' + key); if (!el) continue;
    if (document.activeElement === el) continue;   // ne pas écraser pendant la frappe
    try {
      const { data, error } = await sb.from('notes_tableau').select('contenu,updated_at').eq('id', key).limit(1);
      if (error) continue;
      const row = data && data[0];
      el.innerHTML = (row && row.contenu) || '';
      const st = $('note-status-' + key);
      if (st) st.textContent = row && row.updated_at ? ('Synchronisé · ' + fmtDate(String(row.updated_at).slice(0,10))) : '';
    } catch (e) {}
  }
}
function noteOnInput(key){
  const st = $('note-status-' + key); if (st) { st.textContent = 'Modification…'; st.style.color = 'var(--g400)'; }
  clearTimeout(_noteTimers[key]);
  _noteTimers[key] = setTimeout(function(){ saveNote(key); }, 700);
}
async function saveNote(key){
  const el = $('note-' + key); if (!el || !sb) return;
  const st = $('note-status-' + key);
  try {
    const { error } = await sb.from('notes_tableau').upsert({ id: key, contenu: el.innerHTML, updated_at: new Date().toISOString() });
    if (error) { if (st) { st.textContent = '⚠️ non enregistré'; st.style.color = '#e63946'; } return; }
    if (st) { const h = new Date(); st.textContent = '✓ Enregistré ' + String(h.getHours()).padStart(2,'0') + ':' + String(h.getMinutes()).padStart(2,'0'); st.style.color = '#2d9e6b'; }
  } catch (e) { if (st) { st.textContent = '⚠️ non enregistré'; st.style.color = '#e63946'; } }
}

// ============================================================
// RECHERCHE GLOBALE (barre du haut) — cherche partout dans l'app
// ============================================================
let _gsTimer = null;
function _gsNorm(s) { return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
function _gsHide() { const b = $('global-search-results'); if (b) { b.style.display = 'none'; b.innerHTML = ''; } const inp = $('global-search'); if (inp) inp.value = ''; }
function globalSearch(q) { clearTimeout(_gsTimer); _gsTimer = setTimeout(function () { _globalSearchNow(q); }, 150); }
function _gsOpenBon(b) {
  showScreen('bons');
  const st = b.statut || '';
  const filt = st === 'termine' ? 'termines' : (st === 'en-cours' ? 'en-cours' : 'actifs');
  const s = $('bon-search'); if (s) s.value = b.numero || '';
  if (typeof setBonsFilter === 'function') setBonsFilter(filt); else if (typeof renderBons === 'function') renderBons();
  _gsHide();
}
// Badges d'un devis/facture dans les résultats de recherche :
// son STATUT (payée / pas payée…) et la RUBRIQUE où le retrouver.
function _gsDocMeta(d) {
  const chip = function (txt, bg, col, bd) {
    return '<span style="display:inline-block;font-size:10px;font-weight:800;color:' + col + ';background:' + bg
      + ';border:1px solid ' + bd + ';border-radius:8px;padding:1px 7px;margin-right:4px;">' + txt + '</span>';
  };
  const st = String(d.statut || 'brouillon');
  let statut;
  if (d.type === 'facture') {
    if (_isRappelDoc(d))        statut = chip('📄 Rappel', '#fef2f2', '#b91c1c', '#fecaca');
    else if (st === 'payee')    statut = chip('✅ Payée', '#dcfce7', '#166534', '#86efac');
    else if (st === 'impayee')  statut = chip('⏳ Pas payée', '#fef3c7', '#92400e', '#fcd34d');
    else if (st === 'envoyee')  statut = chip('📨 Envoyée — à encaisser', '#eff6ff', '#1d4ed8', '#bfdbfe');
    else if (st === 'pret')     statut = chip('📤 Prêt à envoyer', '#fff7ed', '#c2410c', '#fed7aa');
    else                        statut = chip('🕒 Brouillon', '#fffbeb', '#b45309', '#fde68a');
  } else {
    const L = { brouillon: ['🕒 Brouillon', '#fffbeb', '#b45309', '#fde68a'], envoye: ['📨 Envoyé', '#eff6ff', '#1d4ed8', '#bfdbfe'],
                accepte: ['✅ Accepté', '#dcfce7', '#166534', '#86efac'], refuse: ['❌ Refusé', '#fef2f2', '#b91c1c', '#fecaca'] };
    const v = L[st] || L.brouillon;
    statut = chip(v[0], v[1], v[2], v[3]);
  }
  // Rubrique où se trouve le document
  let rub;
  if (d.type === 'facture') rub = _factureRubrique(d);
  else rub = _isDevisArchivedWithFacture(d) ? '📦 Facturation archivée (avec sa facture)' : '📝 Devis';
  return statut + chip('→ ' + rub, '#f3f4f6', '#374151', '#e5e7eb');
}
// Va au RUBAN du client dans la liste Clients (au lieu d'ouvrir la fiche) :
// on filtre la liste sur son nom, puis on met sa carte en surbrillance.
function _gsOpenClient(c) {
  showScreen('clients');
  const s = $('cl-search'); if (s) s.value = c.nom || '';
  if (typeof renderClients === 'function') renderClients();
  _gsHide();
  _gsHighlight('clientrow-' + c.id);
}
// Met en surbrillance un ruban et le centre à l'écran
function _gsHighlight(rowId) {
  setTimeout(function () {
    const el = document.getElementById(rowId);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const prev = el.style.boxShadow;
    el.style.boxShadow = '0 0 0 3px #e63946';
    setTimeout(function () { el.style.boxShadow = prev; }, 2200);
  }, 220);
}
// Va au RUBAN d'un devis/facture, dans la RUBRIQUE où il se trouve réellement
// (Factures · Anciennes factures · Facturation archivée · Devis), au lieu d'ouvrir l'éditeur.
function _gsOpenDoc(d) {
  const isFact = d.type === 'facture';
  const num = d.numero || '';
  if (isFact && _isFactureFactArchived(d)) {
    showScreen('fact-archive');
    const s = $('fact-archive-search'); if (s) s.value = num;
    if (typeof renderFactArchive === 'function') renderFactArchive();
    _gsHighlight('factarch-' + d.id);
  } else if (isFact && _isAncienneFacture(d)) {
    showScreen('anciennes');
    state.ancSearch = num; state.ancFilter = 'tous';
    if (typeof renderAnciennesList === 'function') renderAnciennesList();
    _gsHighlight('ancrow-' + d.id);
  } else {
    showScreen('devis');
    state.docsFilter = isFact ? 'facture' : 'devis';
    state.docStatutFilter = 'tous';
    const s = $('doc-search'); if (s) s.value = num;
    if (typeof renderDocuments === 'function') renderDocuments();
    _gsHighlight('docrow-' + d.id);
  }
  _gsHide();
}
// Idem pour un locataire : on va à son ruban dans la liste Locataires.
function _gsOpenLocataire(l) {
  showScreen('locataires');
  const s = $('loc-search'); if (s) s.value = l.nom || '';
  if (typeof renderLocataires === 'function') renderLocataires();
  _gsHide();
  _gsHighlight('locrow-' + l.id);
}
function _globalSearchNow(q) {
  const box = $('global-search-results'); if (!box) return;
  const raw = (q || '').trim();
  if (raw.length < 2) { box.style.display = 'none'; box.innerHTML = ''; return; }
  const nq = _gsNorm(raw), nqns = nq.replace(/\s/g, '');
  const match = function () {
    const hay = _gsNorm(Array.prototype.filter.call(arguments, Boolean).join(' '));
    return hay.includes(nq) || hay.replace(/\s/g, '').includes(nqns);
  };
  const res = [];
  (DB.bons || []).forEach(function (b) {
    if (match(b.numero, b.geranceNom, b.gerantNom, b.locataireNom, b.immeuble, b.gerantTel, (typeof _bonProblemeClean === 'function' ? _bonProblemeClean(b) : b.probleme)))
      res.push({ icon: '📄', type: 'Bon', title: b.numero || '(sans n°)', sub: [b.geranceNom, b.locataireNom || b.immeuble].filter(Boolean).join(' · '), go: function () { _gsOpenBon(b); } });
  });
  (DB.documents || []).forEach(function (d) {
    const isFact = d.type === 'facture';
    const lignesTxt = Array.isArray(d.lignes) ? d.lignes.map(function (l) { return l.desc; }).join(' ') : '';
    // Numéro du BON LIÉ (via bonId) : taper un n° de bon doit aussi sortir sa facture / son devis.
    const _bd = d.bonId ? (DB.bons || []).find(function (b) { return b.id === d.bonId; }) : null;
    const _bdNum = (_bd && _bd.numero) || d.bonCommande || '';
    // Numéro du DEVIS SOURCE (via devisId) : taper un n° de devis doit aussi sortir sa facture.
    const _dv = d.devisId ? (DB.documents || []).find(function (x) { return x.id === d.devisId; }) : null;
    const _dvNum = (_dv && _dv.numero) || '';
    // …et inversement : pour un devis, le n° de la facture qui en découle.
    const _fc = (d.type === 'devis') ? (DB.documents || []).find(function (x) { return x.type === 'facture' && x.devisId === d.id; }) : null;
    const _fcNum = (_fc && _fc.numero) || '';
    if (match(d.numero, d.clientNom, d.locataireNom, d.proprietaire, d.notes, lignesTxt, _bdNum, _dvNum, _fcNum))
      res.push({
        icon: isFact ? '🧾' : '📝', type: isFact ? 'Facture' : 'Devis', title: d.numero || '(sans n°)',
        sub: [d.clientNom, _bdNum ? ('📄 Bon ' + _bdNum) : '', _dvNum ? ('📝 Devis ' + _dvNum) : '', _fcNum ? ('🧾 Facturé : ' + _fcNum) : '',
              (typeof _displayMontant === 'function' ? _displayMontant(d.total || 0) + ' CHF' : '')].filter(Boolean).join(' · '),
        meta: _gsDocMeta(d),   // payée / pas payée + rubrique où elle se trouve
        go: function () { _gsOpenDoc(d); }
      });
  });
  (DB.rapports || []).forEach(function (r) {
    if (match(r.id, r.clientNom, r.noint, (r.nuisibles || []).join(' '), r.adresse, r.tech, r.bonCommande))
      res.push({ icon: '📋', type: 'Rapport', title: r.id || '', sub: [r.clientNom, (r.nuisibles || []).join(', ')].filter(Boolean).join(' · '), go: function () { editRapport(r.id); _gsHide(); } });
  });
  (DB.diagnostics || []).forEach(function (dg) {
    const _dgB = dg.bonId ? (DB.bons || []).find(function (b) { return b.id === dg.bonId; }) : null;
    const _dgBNum = (_dgB && _dgB.numero) || '';
    if (match(dg.numero, dg.clientNom, dg.locataireNom, (dg.insectes || []).join(' '), dg.batiment, _dgBNum))
      res.push({ icon: '🔬', type: 'Diagnostic', title: dg.numero || '', sub: [dg.clientNom, _dgBNum ? ('📄 Bon ' + _dgBNum) : ''].filter(Boolean).join(' · '), go: function () { editDiag(dg.id); _gsHide(); } });
  });
  (DB.clients || []).forEach(function (c) {
    if (match(c.nom, c.contact, c.tel, c.email, c.adresse, c.ville, c.num))
      res.push({ icon: '👤', type: 'Client', title: c.nom || '', sub: [c.type, c.ville].filter(Boolean).join(' · '), go: function () { _gsOpenClient(c); } });
  });
  (DB.locataires || []).forEach(function (l) {
    if (match(l.nom, l.tel, l.email, l.adresse))
      res.push({ icon: '🏠', type: 'Locataire', title: l.nom || '', sub: [l.adresse].filter(Boolean).join(' · '), go: function () { _gsOpenLocataire(l); } });
  });
  (DB.fournisseurs || []).forEach(function (f) {
    if (match(f.nom, f.contact, f.tel, f.email, f.categorie))
      res.push({ icon: '📦', type: 'Fournisseur', title: f.nom || '', sub: [f.categorie, f.ville].filter(Boolean).join(' · '), go: function () { showScreen('fournisseurs'); const s = $('fourn-search'); if (s) { s.value = raw; if (typeof renderFournisseurs === 'function') renderFournisseurs(); } _gsHide(); } });
  });
  // Pertinence : une correspondance EXACTE sur le numéro/titre passe devant (ex. « 39326 »
  // doit proposer la facture 39326 avant un client dont le téléphone contient ces chiffres).
  res.forEach(function (r) { r._exact = _gsNorm(r.title || '').replace(/\s/g, '') === nqns ? 0 : 1; });
  res.sort(function (a, b) { return a._exact - b._exact; });
  const total = res.length, shown = res.slice(0, 40);
  if (!shown.length) { box.innerHTML = '<div style="padding:12px 14px;color:#6b7280;font-size:13px;">Aucun résultat pour « ' + raw.replace(/</g, '&lt;') + ' »</div>'; box.style.display = 'block'; return; }
  window._gsActions = shown.map(function (r) { return r.go; });
  // Résultats REGROUPÉS PAR TYPE : on voit tout ce qui a été trouvé et on choisit.
  const ORDER = ['Bon', 'Facture', 'Devis', 'Rapport', 'Diagnostic', 'Client', 'Locataire', 'Fournisseur'];
  const groups = {};
  shown.forEach(function (r, i) { (groups[r.type] = groups[r.type] || []).push({ r: r, i: i }); });
  const types = Object.keys(groups).sort(function (a, b) {
    const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const ligne = function (r, i) {
    return '<div onclick="(window._gsActions[' + i + ']||function(){})()" style="display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid #f1f3f7;cursor:pointer;" onmouseover="this.style.background=\'#f5f7fb\'" onmouseout="this.style.background=\'\'">'
      + '<span style="font-size:16px;">' + r.icon + '</span>'
      + '<div style="min-width:0;flex:1;"><div style="font-size:13px;font-weight:700;color:#0d1b3e;">' + (r.title || '').replace(/</g, '&lt;') + '</div>'
      + (r.sub ? '<div style="font-size:11px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + r.sub.replace(/</g, '&lt;') + '</div>' : '')
      + (r.meta ? '<div style="margin-top:3px;">' + r.meta + '</div>' : '')
      + '</div></div>';
  };
  box.innerHTML =
    '<div style="padding:7px 14px;background:#0d1b3e;color:#fff;font-size:11px;font-weight:800;letter-spacing:.3px;">'
      + total + ' résultat' + (total > 1 ? 's' : '') + ' pour « ' + raw.replace(/</g, '&lt;') + ' » — choisis ci-dessous</div>'
    + types.map(function (t) {
        const arr = groups[t];
        return '<div style="padding:5px 14px;background:#eef2f8;font-size:10.5px;font-weight:800;color:#0d1b3e;text-transform:uppercase;letter-spacing:.4px;">'
            + arr[0].r.icon + ' ' + t + ' (' + arr.length + ')</div>'
          + arr.map(function (o) { return ligne(o.r, o.i); }).join('');
      }).join('')
    + (total > shown.length ? '<div style="padding:6px 14px;font-size:11px;color:#9ca3af;">… ' + (total - shown.length) + ' autre(s) résultat(s), précise ta recherche.</div>' : '');
  box.style.display = 'block';
}
// Fermer les résultats en cliquant ailleurs
document.addEventListener('click', function (e) {
  const box = $('global-search-results'), inp = $('global-search');
  if (!box || box.style.display === 'none') return;
  if (e.target === inp || box.contains(e.target)) return;
  box.style.display = 'none';
});

function renderDashboard() {
  if (typeof updateBonsCounts === 'function') updateBonsCounts();
  const now = new Date();
  const days = ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];
  const months = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
  const dd = $('dash-date');
  if (dd) dd.textContent = `${days[now.getDay()]} ${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
  if (typeof loadDashNotes === 'function') loadDashNotes();

  const rapports = DB.rapports, clients = DB.clients;
  const brouillon = rapports.filter(r => r.statut === 'Brouillon').length;
  const bons = DB.bons || [];
  const docs = DB.documents || [];

  // --- Bornes de la semaine en cours (lundi → dimanche) ---
  const _monday = (() => { const d = new Date(now); const wd = (d.getDay() + 6) % 7; d.setHours(0,0,0,0); d.setDate(d.getDate() - wd); return d; })();
  const _sunday = (() => { const d = new Date(_monday); d.setDate(d.getDate() + 6); d.setHours(23,59,59,999); return d; })();
  const _ymd = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

  // --- Compteurs documents ---
  // On EXCLUT les documents de rappel : ils répètent le montant de leur facture d'origine
  // (sinon double comptage). Les vraies factures (ruban) + anciennes factures sont comptées.
  const facturesPayees   = docs.filter(d => d.type === 'facture' && d.statut === 'payee' && !_isRappelDoc(d));
  const facturesNonPayees= docs.filter(d => d.type === 'facture' && d.statut !== 'payee' && !_isRappelDoc(d));
  const devisAcceptes    = docs.filter(d => d.type === 'devis'   && d.statut === 'accepte');
  // Bons entrés cette semaine
  const bonsSemaine = bons.filter(b => { if (!b.createdAt) return false; const c = new Date(b.createdAt); return c >= _monday && c <= _sunday; });

  const ds = $('dash-stats');
  if (ds) ds.innerHTML = [
    { lbl: 'Bons cette semaine', val: bonsSemaine.length, accent: '#2563eb',
      sub: 'depuis lundi', icon: '📄', onclick: "showScreen('bons')" },
    { lbl: 'Factures payées', val: facturesPayees.length, accent: '#2d9e6b',
      sub: facturesPayees.reduce((a,d)=>a+(parseFloat(d.total)||0),0).toFixed(0) + ' CHF', icon: '✅', onclick: "showDocsScreen('facture')" },
    { lbl: 'Factures non payées', val: facturesNonPayees.length, accent: '#e63946',
      sub: facturesNonPayees.reduce((a,d)=>a+(parseFloat(d.total)||0),0).toFixed(0) + ' CHF en attente', icon: '⏳', onclick: "showDocsScreen('facture')" },
    { lbl: 'Devis acceptés', val: devisAcceptes.length, accent: '#7c3aed',
      sub: 'à transformer en facture', icon: '📝', onclick: "showDocsScreen('devis')" },
  ].map(s => `<div class="stat-card" style="border-left:0;cursor:pointer;" onclick="${s.onclick}">
      <div style="position:absolute;top:0;left:0;width:4px;height:100%;background:${s.accent};"></div>
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div class="stat-lbl">${s.lbl}</div><span style="font-size:14px;">${s.icon}</span>
      </div>
      <div class="stat-val" style="color:${s.accent};">${s.val}</div>
      <div class="stat-sub">${s.sub}</div>
    </div>`).join('');

  // --- Interventions de la semaine, jour par jour ---
  const dw = $('dash-week');
  if (dw) {
    const jours = ['Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi','Dimanche'];
    const moisAbr = ['janv.','févr.','mars','avr.','mai','juin','juil.','août','sept.','oct.','nov.','déc.'];
    const allIv = DB.intervs || [];
    const todayStr = today();
    let html = '';
    for (let i = 0; i < 7; i++) {
      const d = new Date(_monday); d.setDate(d.getDate() + i);
      const ds2 = _ymd(d);
      const isToday = ds2 === todayStr;
      const ivs = allIv.filter(iv => iv.date === ds2).sort((a,b)=>(a.heure||'').localeCompare(b.heure||''));
      html += `<div style="padding:8px 16px;border-bottom:1px solid var(--g100);${isToday?'background:#eef4ff;':''}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:${ivs.length?'6px':'0'};">
          <span style="font-size:12px;font-weight:800;color:${isToday?'#2563eb':'var(--navy)'};min-width:118px;">${jours[i]} ${d.getDate()} ${moisAbr[d.getMonth()]}${isToday?" • auj.":''}</span>
          ${ivs.length ? `<span style="font-size:10px;color:var(--g400);">${ivs.length} interv.</span>` : `<span style="font-size:11px;color:var(--g300);">—</span>`}
        </div>
        ${ivs.map(iv => `<div onclick="openEditInterv('${iv.id}')" style="display:flex;align-items:center;gap:8px;padding:4px 0 4px 8px;margin-left:6px;border-left:3px solid ${iv.couleur||'#e63946'};cursor:pointer;">
          <span style="font-size:11px;font-weight:700;color:var(--navy);min-width:38px;">${iv.heure||'--:--'}</span>
          <span style="font-size:11px;color:var(--g600);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${iv.nuisible?iv.nuisible+' — ':''}${iv.clientNom||'—'}${iv.adresse?' · '+iv.adresse:''}</span>
          <span class="badge ${badgeCls(iv.statut)}" style="font-size:9px;">${iv.statut||''}</span>
        </div>`).join('')}
      </div>`;
    }
    dw.innerHTML = html;
    const wt = $('dash-week-title');
    if (wt) wt.textContent = `📅 Semaine du ${_monday.getDate()} ${moisAbr[_monday.getMonth()]} au ${_sunday.getDate()} ${moisAbr[_sunday.getMonth()]}`;
  }

  // --- Bons entrés cette semaine (liste) ---
  const dbs = $('dash-bons-semaine');
  if (dbs) {
    const list = bonsSemaine.slice().sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).slice(0,6);
    dbs.innerHTML = list.length ? list.map(b => `
      <div onclick="showScreen('bons')" style="display:flex;align-items:center;gap:10px;padding:9px 16px;border-bottom:1px solid var(--g100);cursor:pointer;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:12px;font-weight:700;color:var(--navy);">Bon ${b.numero||'(s. n°)'}</div>
          <div style="font-size:11px;color:var(--g400);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${b.geranceNom||'—'} · ${_nuisibleInfo(_bonProblemeClean(b)).label}</div>
        </div>
        <span style="font-size:10px;color:var(--g400);">${b.createdAt?fmtDate(_ymd(new Date(b.createdAt))):''}</span>
      </div>`).join('')
    : '<div class="empty" style="padding:18px;"><div class="empty-icon">📄</div><div class="empty-text">Aucun bon entré cette semaine</div></div>';
  }

  // --- Graphique répartition nuisibles (depuis bons + rapports) ---
  const nuisChart = $('dash-nuisibles-chart');
  if (nuisChart) {
    const counts = {};
    bons.forEach(b => { const info = _nuisibleInfo(_bonProblemeClean(b)); counts[info.label] = counts[info.label] || { n: 0, color: info.color }; counts[info.label].n++; });
    (rapports || []).forEach(r => (r.nuisibles || []).forEach(n => { counts[n] = counts[n] || { n: 0, color: '#888780' }; counts[n].n++; }));
    const entries = Object.entries(counts).map(([k, v]) => ({ label: k, n: v.n, color: v.color }))
      .sort((a, b) => b.n - a.n).slice(0, 5);
    const totalN = entries.reduce((a, e) => a + e.n, 0) || 1;
    if (!entries.length) {
      nuisChart.innerHTML = '<div style="font-size:12px;color:var(--g400);padding:8px 0;">Aucune donnée pour le moment.</div>';
    } else {
      nuisChart.innerHTML = entries.map(e => {
        const pct = Math.round((e.n / totalN) * 100);
        return `<div style="margin-bottom:9px;">
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">
            <span style="color:var(--navy);">${e.label}</span><span style="color:var(--g400);">${pct}%</span>
          </div>
          <div style="height:6px;background:var(--g100);border-radius:3px;overflow:hidden;">
            <div style="width:${pct}%;height:6px;background:${e.color};border-radius:3px;"></div>
          </div>
        </div>`;
      }).join('');
    }
  }

  // --- Alerte : factures impayées dont l'échéance (30 jours net) est dépassée ---
  const impCard = $('impayes-card'), impList = $('impayes-list'), impCount = $('impayes-count');
  if (impList) {
    const ECHEANCE = 30; // jours
    const impayes = facturesNonPayees.map(f => {
      const base = f.dateDoc ? new Date(f.dateDoc) : null;
      if (!base) return null;
      const joursEcoules = Math.floor((now - base) / 86400000);
      const retard = joursEcoules - ECHEANCE;
      return retard > 0 ? { f, retard, joursEcoules } : null;
    }).filter(Boolean).sort((a, b) => b.retard - a.retard);

    if (impCard) impCard.style.display = impayes.length ? 'block' : 'none';
    if (impCount) impCount.textContent = impayes.length ? (impayes.length + ' facture(s) · ' + impayes.reduce((a,x)=>a+(parseFloat(x.f.total)||0),0).toFixed(0) + ' CHF') : '';
    impList.innerHTML = impayes.map(({ f, retard }) => `
      <div onclick="showDocsScreen('facture')" style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--g100);cursor:pointer;">
        <div style="width:8px;height:8px;border-radius:50%;background:#e63946;flex-shrink:0;"></div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:12px;font-weight:700;color:var(--navy);">${f.numero || '—'} — ${f.clientNom || '—'}</div>
          <div style="font-size:11px;color:var(--g400);">Émise le ${fmtDate(f.dateDoc)} · ${_displayMontant(f.total||0)} CHF</div>
        </div>
        <span class="badge b-red" style="font-size:10px;">+${retard}j de retard</span>
      </div>`).join('');
  }

  // Retards
  const retards = rapports.filter(r => {
    if (r.statut === 'Envoyé') return false;
    return (new Date() - new Date(r.date)) / 86400000 > 7;
  });
  const rc = $('retards-card'), rl = $('retards-list');
  if (rl) {
    rc.style.display = retards.length ? 'block' : 'none';
    rl.innerHTML = retards.map(r => {
      const diff = Math.floor((new Date() - new Date(r.date)) / 86400000);
      return `<div class="retard-item" onclick="editRapport('${r.id}')">
        <div class="retard-dot"></div>
        <div class="retard-info">
          <div class="retard-title">${r.id} — ${r.clientNom || '—'}</div>
          <div class="retard-sub">${(r.nuisibles||[]).join(', ')} · ${fmtDate(r.date)}</div>
        </div>
        <span class="badge b-red">${diff}j de retard</span>
      </div>`;
    }).join('');
  }

  // Recent rapports
  const dr = $('dash-rapports');
  if (dr) {
    const rec = rapports.slice().reverse().slice(0,6);
    dr.innerHTML = rec.length ? rec.map(r => `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--g100);cursor:pointer;" onclick="editRapport('${r.id}')">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:12px;color:var(--navy);">${r.id}</div>
          <div style="font-size:11px;color:var(--g400);">${(r.nuisibles||[]).join(', ')||'—'} · ${r.clientNom||'—'}</div>
        </div>
        <span class="badge ${badgeCls(r.statut)}">${r.statut}</span>
      </div>`).join('')
    : '<div class="empty"><div class="empty-icon">📋</div><div class="empty-text">Aucun rapport</div></div>';
  }

  // Upcoming intervs
  const di = $('dash-intervs');
  if (di) {
    const upcoming = DB.intervs.filter(iv => iv.date >= today()).sort((a,b) => (a.date+a.heure).localeCompare(b.date+b.heure)).slice(0,5);
    di.innerHTML = upcoming.length ? upcoming.map(iv => `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--g100);cursor:pointer;" onclick="openEditInterv('${iv.id}')">
        <div style="width:10px;height:10px;border-radius:50%;background:${iv.couleur};flex-shrink:0;"></div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:12px;">${iv.clientNom||'—'}</div>
          <div style="font-size:11px;color:var(--g400);">${fmtDate(iv.date)} à ${iv.heure} · ${iv.nuisible}</div>
        </div>
        <span class="badge ${badgeCls(iv.statut)}">${iv.statut}</span>
      </div>`).join('')
    : '<div class="empty"><div class="empty-icon">📅</div><div class="empty-text">Aucune intervention prévue</div></div>';
  }

  // Badge
  const badge = $('nb-badge');
  if (badge) { badge.textContent = brouillon; badge.style.display = brouillon > 0 ? 'inline' : 'none'; }
}

// ============================================================
// AGENDA
// ============================================================
function setAgendaView(v, el) {
  state.agendaView = v;
  el.closest('.pills').querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  renderAgenda();
}
function agendaNav(dir) {
  if (state.agendaView === 'semaine')
    state.agendaDate = new Date(state.agendaDate.getTime() + dir * 7 * 86400000);
  else {
    state.agendaDate.setMonth(state.agendaDate.getMonth() + dir);
    state.agendaDate = new Date(state.agendaDate);
  }
  renderAgenda();
}
function agendaToday() { state.agendaDate = new Date(); renderAgenda(); }
// Agendas Google affichés dans l'écran Agenda (intégration en lecture), avec leur couleur.
// color = couleur d'affichage des événements de cet agenda dans l'app.
const GOOGLE_CALS = [
  { id: 'deratekswiss@gmail.com', color: '#039BE5' },                                                             // Dany — bleu
  { id: '1bdab5f890b0785f068ac6f711beaead294a8db487852a8286e02bfa128044d5@group.calendar.google.com', color: '#F6BF26' } // Planning Dany Jessy — jaune
];
function renderAgenda() {
  if (state.agendaView === 'google') renderGoogleAgenda();
  else if (state.agendaView === 'semaine') renderSemaine();
  else renderMois();
}
// Ouvre Google Agenda pour créer un nouvel événement (nouvel onglet)
function googleNewEvent() {
  window.open('https://calendar.google.com/calendar/render?action=TEMPLATE', '_blank');
}
// Ouvre Google Agenda en grand pour consulter / modifier librement
function googleOpenAgenda() {
  window.open('https://calendar.google.com/calendar/u/0/r', '_blank');
}
// Affiche l'agenda Google intégré (iframe) dans l'écran Agenda
function renderGoogleAgenda() {
  const sv = $('agenda-semaine-view'), mv = $('agenda-mois-view'), gg = $('agenda-google-view');
  if (sv) sv.style.display = 'none';
  if (mv) mv.style.display = 'none';
  if (!gg) return;
  gg.style.display = 'block';
  const per = $('agenda-period'); if (per) per.textContent = 'Mon agenda Google';
  if (!gg.dataset.loaded) {
    let params = ['ctz=Europe/Zurich', 'wkst=2', 'mode=WEEK', 'showTitle=0', 'showPrint=0', 'showTabs=1', 'showCalendars=1', 'showTz=0'];
    // src + color s'enchaînent dans le même ordre (chaque couleur s'applique à l'agenda qui précède)
    GOOGLE_CALS.forEach(c => {
      params.push('src=' + encodeURIComponent(c.id));
      if (c.color) params.push('color=' + encodeURIComponent(c.color));
    });
    const url = 'https://calendar.google.com/calendar/embed?' + params.join('&');
    gg.innerHTML =
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">' +
        '<button class="btn btn-green btn-sm" onclick="googleNewEvent()" title="Créer un nouvel événement dans Google Agenda">➕ Nouvel événement</button>' +
        '<button class="btn btn-navy btn-sm" onclick="googleOpenAgenda()" title="Ouvrir / modifier dans Google Agenda">✏️ Ouvrir Google Agenda</button>' +
        '<span style="font-size:11px;color:var(--g600);">Crée ou modifie dans Google, ça réapparaît ici aussitôt.</span>' +
      '</div>' +
      '<iframe src="' + url + '" style="border:0;width:100%;height:72vh;min-height:560px;border-radius:10px;background:#fff;" frameborder="0" scrolling="no"></iframe>' +
      '<div style="font-size:11px;color:var(--g600);margin-top:6px;">🟡 Planning Dany Jessy (jaune) · 🔵 Agenda Dany (bleu). Si rien ne s\'affiche, connecte-toi à ce compte Google dans ce navigateur.</div>';
    gg.dataset.loaded = '1';
  }
}
function getWeekStart(d) {
  const dt = new Date(d); const day = dt.getDay();
  dt.setDate(dt.getDate() - (day === 0 ? 6 : day - 1));
  dt.setHours(0,0,0,0); return dt;
}
function renderSemaine() {
  const sv = $('agenda-semaine-view'), mv = $('agenda-mois-view'), gg = $('agenda-google-view');
  sv.style.display = 'block'; mv.style.display = 'none'; if (gg) gg.style.display = 'none';
  const ws = getWeekStart(state.agendaDate);
  const dayNames = ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'];
  const monthNames = ['jan','fév','mar','avr','mai','jun','jul','aoû','sep','oct','nov','déc'];
  const weekDates = Array.from({length:7}, (_,i) => new Date(ws.getTime() + i*86400000));
  $('agenda-period').textContent = `${fmtDate(localDateStr(weekDates[0]))} — ${fmtDate(localDateStr(weekDates[6]))}`;
  const hours = ['07:00','08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00'];
  let html = '<div class="agenda-wrap">';
  html += '<div class="ag-header-row"><div class="ag-header-cell"></div>';
  weekDates.forEach((d,i) => {
    const isToday = d.toDateString() === new Date().toDateString();
    html += `<div class="ag-header-cell${isToday?' today-col':''}">${dayNames[i]}<br><strong style="font-size:16px;">${d.getDate()}</strong><br><span style="font-size:9px;opacity:.7;">${monthNames[d.getMonth()]}</span></div>`;
  });
  html += '</div>';
  hours.forEach(h => {
    html += '<div class="ag-body-row">';
    html += `<div class="ag-time-cell">${h}</div>`;
    weekDates.forEach(d => {
      const dateStr = localDateStr(d);
      const cellIvs = DB.intervs.filter(iv => iv.date === dateStr && iv.heure && iv.heure.substring(0,2) === h.substring(0,2));
      html += `<div class="ag-day-cell" data-date="${dateStr}" data-heure="${h}" onclick="handleAgCell(this)">`;
      cellIvs.forEach(iv => {
        html += `<div class="ag-event" style="background:${iv.couleur};cursor:pointer;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:100%;box-sizing:border-box;" data-id="${iv.id}" onclick="event.stopPropagation();handleAgEvent(this)" title="Cliquer pour modifier — ${iv.nuisible} — ${iv.clientNom}${iv.bonNumero?' — Bon '+iv.bonNumero:''}">${iv.heure} ${iv.nuisible?iv.nuisible+' — ':''}${iv.clientNom}</div>`;
      });
      html += '</div>';
    });
    html += '</div>';
  });
  html += '</div>';
  sv.innerHTML = html;
}
function renderMois() {
  const sv = $('agenda-semaine-view'), mv = $('agenda-mois-view'), gg = $('agenda-google-view');
  sv.style.display = 'none'; mv.style.display = 'block'; if (gg) gg.style.display = 'none';
  const year = state.agendaDate.getFullYear(), month = state.agendaDate.getMonth();
  const monthNames = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
  $('agenda-period').textContent = `${monthNames[month]} ${year}`;
  let firstDay = new Date(year, month, 1).getDay(); firstDay = firstDay === 0 ? 6 : firstDay - 1;
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const daysInPrev  = new Date(year, month, 0).getDate();
  const todayStr = today();
  let html = '<div class="cal-header">';
  ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'].forEach(d => html += `<div class="cal-day-hd">${d}</div>`);
  html += '</div><div class="cal-grid">';
  for (let i = firstDay-1; i >= 0; i--)
    html += `<div class="cal-day other-month"><div class="cal-day-num">${daysInPrev-i}</div></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const isToday = dateStr === todayStr;
    const dayIvs = DB.intervs.filter(iv => iv.date === dateStr);
    html += `<div class="cal-day${isToday?' today':''}" data-date="${dateStr}" data-heure="09:00" onclick="handleAgCell(this)">`;
    html += `<div class="cal-day-num">${day}</div>`;
    dayIvs.slice(0,3).forEach(iv => {
      html += `<div class="cal-ev" style="background:${iv.couleur};cursor:pointer;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:100%;box-sizing:border-box;" data-id="${iv.id}" onclick="event.stopPropagation();handleAgEvent(this)" title="Cliquer pour modifier — ${iv.nuisible} — ${iv.clientNom}">${iv.heure} ${iv.nuisible?iv.nuisible+' — ':''}${iv.clientNom}</div>`;
    });
    if (dayIvs.length > 3) html += `<div style="font-size:9px;color:var(--g400);">+${dayIvs.length-3} autres</div>`;
    html += '</div>';
  }
  const total = firstDay + daysInMonth;
  const rem = total % 7 === 0 ? 0 : 7 - (total % 7);
  for (let j = 1; j <= rem; j++)
    html += `<div class="cal-day other-month"><div class="cal-day-num">${j}</div></div>`;
  html += '</div>';
  mv.innerHTML = html;
}
function handleAgCell(el) { openNewIntervDate(el.dataset.date || today(), el.dataset.heure || '08:00'); }
function handleAgEvent(el) {
  const id = el.dataset.id; if (!id) return;
  // Clic = toujours ouvrir la modale pour modifier l'intervention.
  // (L'accès au bon lié reste possible via le champ « N° de bon » de la modale.)
  openEditInterv(id);
}
// Va à l'onglet Bons et met en évidence le bon ciblé
function goToBon(bonId) {
  showScreen('bons');
  setTimeout(() => {
    const el = document.getElementById('bonrow-' + bonId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const prev = el.style.boxShadow;
      el.style.boxShadow = '0 0 0 3px #e63946';
      setTimeout(() => { el.style.boxShadow = prev; }, 2200);
    }
  }, 200);
}

// ============================================================
// INTERVENTIONS
// ============================================================
function selectColor(el) {
  el.closest('.color-options').querySelectorAll('.color-opt').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  state.selectedColor = el.dataset.color;
}
function openNewInterv()              { openNewIntervDate(today(), '08:00'); }
function openNewIntervDate(date, heure) {
  state.editingIntervId = null;
  $('modal-interv-title').textContent = 'Nouvelle intervention';
  $('iv-date').value = date; $('iv-heure').value = heure || '08:00';
  ['iv-adresse','iv-nuisible','iv-notes'].forEach(id => $(id).value = '');
  if ($('iv-bon-numero')) $('iv-bon-numero').value = '';
  state._ivBon = null;
  $('iv-statut').value = 'Planifiée';
  $('iv-delete-btn').style.display = 'none';
  state.selectedColor = '#e63946';
  document.querySelectorAll('#iv-colors .color-opt').forEach(c => c.classList.remove('selected'));
  const defColor = document.querySelector('#iv-colors .color-opt[data-color="#e63946"]');
  if (defColor) defColor.classList.add('selected');
  populateClientSelectInterv('');
  populateLocataireSelectInterv('');
  openModal('modal-interv');
}
function openEditInterv(id) {
  const iv = DB.intervs.find(x => x.id === id);
  if (!iv) return;
  state.editingIntervId = id;
  $('modal-interv-title').textContent = 'Modifier intervention';
  $('iv-date').value = iv.date; $('iv-heure').value = iv.heure || '08:00';
  $('iv-adresse').value = iv.adresse || ''; $('iv-nuisible').value = iv.nuisible || '';
  $('iv-notes').value = iv.notes || ''; $('iv-statut').value = iv.statut || 'Planifiée';
  $('iv-tech').value = iv.tech || '';
  if ($('iv-bon-numero')) $('iv-bon-numero').value = iv.bonNumero || '';
  state._ivBon = (iv.bonId || iv.bonNumero) ? { id: iv.bonId || '', numero: iv.bonNumero || '' } : null;
  $('iv-delete-btn').style.display = 'inline-flex';
  state.selectedColor = iv.couleur || '#e63946';
  document.querySelectorAll('#iv-colors .color-opt').forEach(c => {
    c.classList.toggle('selected', c.dataset.color === state.selectedColor);
  });
  populateClientSelectInterv(iv.clientId);
  populateLocataireSelectInterv(iv.clientId, '');
  openModal('modal-interv');
}
function populateClientSelectInterv(selectedId) {
  $('iv-client').innerHTML = '<option value="">-- Sélectionner --</option>' +
    DB.clients.map(c => `<option value="${c.id}"${c.id === selectedId ? ' selected' : ''}>${_clientOptionLabel(c).replace(/</g, '&lt;')}</option>`).join('');
}
// Remplit le select Locataire selon la gérance choisie (et garde un éventuel locataire pré-sélectionné)
function populateLocataireSelectInterv(clientId, selectedLocNom) {
  const sel = $('iv-locataire'); if (!sel) return;
  const list = (DB.locataires || []).filter(l => !clientId || l.clientId === clientId || !l.clientId);
  sel.innerHTML = '<option value="">-- Aucun locataire --</option>' +
    list.map(l => `<option value="${(l.nom||'').replace(/"/g,'&quot;')}"${(selectedLocNom && l.nom === selectedLocNom) ? ' selected' : ''}>${l.nom||''}</option>`).join('');
}
// Quand on change de gérance dans la modale intervention : recharge la liste des locataires
function onIvClientChange() {
  const c = (DB.clients || []).find(x => x.id === $('iv-client').value);
  populateLocataireSelectInterv(c ? c.id : '');
}
// Remplit automatiquement la modale intervention à partir d'un n° de bon de travaux
function autoFillIntervFromBon(numero) {
  if (!numero) return;
  const norm = s => String(s||'').replace(/\s+/g,'').toLowerCase();
  const bon = (DB.bons || []).find(b => norm(b.numero) === norm(numero));
  if (!bon) { toast('Aucun bon trouvé avec ce numéro', '#e63946'); return; }
  // Gérance / client
  const cli = (bon.geranceId ? (DB.clients||[]).find(c => c.id === bon.geranceId) : null)
           || (bon.geranceNom ? (DB.clients||[]).find(c => (c.nom||'').toLowerCase() === bon.geranceNom.toLowerCase()) : null);
  populateClientSelectInterv(cli ? cli.id : '');
  // Locataire
  populateLocataireSelectInterv(cli ? cli.id : '', bon.locataireNom || '');
  const loc = (bon.locataireId ? (DB.locataires||[]).find(l => l.id === bon.locataireId) : null)
           || (bon.locataireNom ? (DB.locataires||[]).find(l => (l.nom||'').toLowerCase() === bon.locataireNom.toLowerCase()) : null);
  // Adresse d'intervention + nuisible
  const adr = (loc ? loc.adresse : '') || bon.immeuble || '';
  if ($('iv-adresse') && adr) $('iv-adresse').value = adr;
  if ($('iv-nuisible') && _bonProblemeClean(bon) && !$('iv-nuisible').value.trim()) $('iv-nuisible').value = _bonProblemeClean(bon);
  // Mémorise la liaison au bon pour l'enregistrement
  state._ivBon = { id: bon.id, numero: bon.numero || numero };
  toast('Champs remplis depuis le bon ' + (bon.numero || ''), '#2d9e6b');
}
// Construit un lien "Ajouter à Google Agenda" (événement pré-rempli)
function _googleCalUrl({ titre, date, heure, dureeMin, details, lieu }) {
  // Format des dates Google : YYYYMMDDTHHMMSS (heure locale)
  const pad = n => String(n).padStart(2, '0');
  const [Y, M, D] = (date || today()).split('-').map(x => parseInt(x, 10));
  let [h, mi] = (heure || '08:00').split(':').map(x => parseInt(x, 10));
  if (isNaN(h)) h = 8; if (isNaN(mi)) mi = 0;
  const start = new Date(Y, (M || 1) - 1, D || 1, h, mi);
  const end = new Date(start.getTime() + (dureeMin || 60) * 60000);
  const fmt = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: titre || 'Intervention DERATEK',
    dates: `${fmt(start)}/${fmt(end)}`,
    details: details || '',
    location: lieu || ''
  });
  return 'https://calendar.google.com/calendar/render?' + params.toString();
}
// Ouvre Google Agenda pré-rempli depuis les champs de la modale intervention
function addCurrentIntervToGoogle() {
  const v = id => { const el = $(id); return el ? el.value : ''; };
  const clientNom = (() => { const c = (DB.clients||[]).find(x => x.id === v('iv-client')); return c ? c.nom : ''; })();
  const nuisible = v('iv-nuisible');
  const titre = 'DERATEK' + (nuisible ? ' — ' + nuisible : '') + (clientNom ? ' (' + clientNom + ')' : '');
  const details = [
    clientNom ? 'Client : ' + clientNom : '',
    nuisible ? 'Nuisible : ' + nuisible : '',
    v('iv-tech') ? 'Technicien : ' + v('iv-tech') : '',
    v('iv-notes') ? 'Notes : ' + v('iv-notes') : ''
  ].filter(Boolean).join('\n');
  const url = _googleCalUrl({ titre, date: v('iv-date'), heure: v('iv-heure'), dureeMin: 60, details, lieu: v('iv-adresse') });
  window.open(url, '_blank');
}

function saveInterv() {
  const clientId = $('iv-client').value;
  const client = DB.clients.find(c => c.id === clientId);
  const bonNumSaisi = ($('iv-bon-numero') ? $('iv-bon-numero').value.trim() : '');
  const ivBon = state._ivBon || {};
  const iv = {
    id: state.editingIntervId || newId(),
    date: $('iv-date').value, heure: $('iv-heure').value,
    clientId, clientNom: client ? client.nom : '',
    adresse: $('iv-adresse').value, nuisible: $('iv-nuisible').value,
    tech: $('iv-tech').value, statut: $('iv-statut').value,
    couleur: state.selectedColor, notes: $('iv-notes').value,
    bonNumero: bonNumSaisi || ivBon.numero || '',
    bonId: ivBon.id || '',
  };
  const list = DB.intervs;
  const i = list.findIndex(x => x.id === state.editingIntervId);
  if (i >= 0) list[i] = iv; else list.push(iv);
  DB.intervs = list;
  closeModal('modal-interv');
  toast('Intervention enregistrée ✓', '#2d9e6b');
  renderAgenda(); renderDashboard();
}
function deleteInterv() {
  if (!state.editingIntervId) return;
  DB.intervs = DB.intervs.filter(x => x.id !== state.editingIntervId);
  closeModal('modal-interv');
  toast('Intervention supprimée', '#e63946');
  renderAgenda(); renderDashboard();
}

// ============================================================
// CLIENTS
// ============================================================
function renderClients() {
  updateNavCounts();
  const q = ($('cl-search') || {}).value || '';
  const list = DB.clients.filter(c => {
    const hay = ((c.nom||'') + ' ' + (c.ville||'') + ' ' + (c.npa||'') + ' ' + (c.adresse||'') + ' ' + (c.num||'') + ' ' + (c.tel||'') + ' ' + (c.email||'') + ' ' + _rapContactNom(c.contact||'') + ' ' + (c.type||'')).toLowerCase();
    const match = hay.includes(q.toLowerCase());
    return match && (state.clientsFilter === 'Tous' || c.type === state.clientsFilter);
  });
  const cc = $('clients-count');
  if (cc) cc.textContent = `${list.length} client${list.length !== 1 ? 's' : ''}`;
  const grid = $('clients-grid');
  if (!grid) return;
  if (!list.length) {
    grid.innerHTML = '<div class="empty"><div class="empty-icon">👥</div><div class="empty-text">Aucun client trouvé</div></div>';
    return;
  }
  const rapports = DB.rapports;
  // L'élément #clients-grid a la classe CSS .clients-grid : on l'annule pour empiler les rubans
  grid.style.display = 'block';
  const _normNom = s => String(s||'').trim().toLowerCase();
  grid.innerHTML = list.map(c => {
    const nbDiag = (DB.diagnostics || []).filter(dg => (dg.clientId && dg.clientId === c.id) || (!dg.clientId && _normNom(dg.clientNom) === _normNom(c.nom))).length;
    const nb = rapports.filter(r => r.clientId === c.id).length + nbDiag;
    // Signaux ruban : bons et factures liés à ce client
    const nbBons = (DB.bons || []).filter(b => (b.geranceId && b.geranceId === c.id) || (!b.geranceId && b.geranceNom && _normNom(b.geranceNom) === _normNom(c.nom))).length;
    const nbFact = (DB.documents || []).filter(d => d.type === 'facture' && !_isRappelDoc(d) && ((d.clientId && d.clientId === c.id) || (!d.clientId && d.clientNom && _normNom(d.clientNom) === _normNom(c.nom)))).length;
    // CHF facturés = anciens rapports "Envoyé" + toutes les factures émises (hors brouillon et hors rappel) liées au client
    const caRapports = rapports.filter(r => r.clientId === c.id && r.statut === 'Envoyé').reduce((a,r) => a + (parseFloat(r.montant)||0), 0);
    const caFactures = (DB.documents || []).filter(d =>
        d.type === 'facture' && (d.statut || '') !== 'brouillon' && !_isRappelDoc(d) &&
        ((d.clientId && d.clientId === c.id) || (!d.clientId && _normNom(d.clientNom) === _normNom(c.nom)))
      ).reduce((a,d) => a + (parseFloat(d.total)||0), 0);
    const totalCA = caRapports + caFactures;
    const typeColor = colorForClient(c);
    const adresseFmt = [c.adresse, [c.npa, c.ville].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    return `
    <div id="clientrow-${c.id}" style="display:flex;align-items:stretch;gap:14px;background:#fff;border:1px solid #e5e7eb;border-left:4px solid ${typeColor};border-radius:8px;padding:10px 14px;margin-bottom:6px;box-shadow:0 1px 2px rgba(0,0,0,.04);flex-wrap:wrap;transition:box-shadow .3s;">
      <div style="display:flex;align-items:center;gap:10px;min-width:200px;flex:1.5;">
        <div style="width:34px;height:34px;border-radius:50%;background:${typeColor};color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">${initials(c.nom)}</div>
        <div>
          <div style="font-size:13px;font-weight:800;color:var(--navy);line-height:1.2;">${c.nom}</div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:2px;">
            <span class="badge b-gray" style="background:${typeColor}22;color:${typeColor};">${c.type}</span>
            ${nbBons ? `<span title="${nbBons} bon(s) lié(s)" style="font-size:10px;font-weight:800;color:#1d4ed8;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:1px 7px;">📄 ${nbBons} bon${nbBons > 1 ? 's' : ''}</span>` : ''}
            ${nbFact ? `<span title="${nbFact} facture(s) liée(s)" style="font-size:10px;font-weight:800;color:#166534;background:#ecfdf5;border:1px solid #bbf7d0;border-radius:8px;padding:1px 7px;">🧾 ${nbFact} facture${nbFact > 1 ? 's' : ''}</span>` : ''}
            ${c.num ? `<span style="font-size:10px;color:var(--g400);">${c.num}</span>` : ''}
          </div>
        </div>
      </div>
      <div style="flex:1.2;min-width:140px;">
        <div style="font-size:10px;color:var(--g400);text-transform:uppercase;font-weight:700;letter-spacing:.3px;">👤 ${_rapContactRole(c.contact) || 'Contact'}</div>
        <div style="font-size:12px;font-weight:600;color:var(--navy);">${_rapContactNom(c.contact) || '—'}</div>
        ${c.tel ? `<div style="font-size:11px;color:var(--g600);">📞 ${c.tel}</div>` : ''}
      </div>
      <div style="flex:1.2;min-width:170px;">
        <div style="font-size:10px;color:var(--g400);text-transform:uppercase;font-weight:700;letter-spacing:.3px;">✉️ Email</div>
        <div style="font-size:12px;color:var(--g600);word-break:break-all;">${c.email || '—'}</div>
      </div>
      <div style="flex:1.5;min-width:180px;">
        <div style="font-size:10px;color:var(--g400);text-transform:uppercase;font-weight:700;letter-spacing:.3px;">📍 Adresse</div>
        <div style="font-size:12px;color:var(--g600);">${adresseFmt || '—'}</div>
      </div>
      ${(() => { const m = _clientMeta(c); return `
      <div style="flex:1.1;min-width:165px;">
        <div style="font-size:10px;color:var(--g400);text-transform:uppercase;font-weight:700;letter-spacing:.3px;">🐛 Nuisible / dates d'interv.</div>
        ${m.nuisible ? `<div style="font-size:12px;font-weight:600;color:var(--navy);margin-bottom:3px;">${m.nuisible}</div>` : ''}
        <div style="display:flex;flex-direction:column;gap:3px;">
          ${m.dates.map((d, i) => `<div style="display:flex;gap:3px;align-items:center;">
            <input type="date" value="${d}" onchange="clientSetDate('${c.id}',${i},this.value)" style="font-size:11px;font-weight:bold;color:#166534;padding:2px 5px;border-radius:6px;border:1.5px solid #22c55e;">
            <button class="btn btn-ghost btn-xs" style="color:#b00;padding:1px 5px;" onclick="clientSetDate('${c.id}',${i},'')" title="Retirer cette date">✕</button>
          </div>`).join('')}
          ${m.dates.length < 5 ? `<button class="btn btn-ghost btn-xs" style="color:#166534;" onclick="clientAddDate('${c.id}')" title="Ajouter une date d'intervention">+ Ajouter (${m.dates.length}/5)</button>` : `<div style="font-size:10px;color:var(--g400);">5/5 (max)</div>`}
        </div>
      </div>`; })()}
      <div style="display:flex;gap:14px;align-items:center;min-width:170px;border-left:1px solid #f0f0f0;padding-left:12px;">
        <div style="text-align:center;">
          <div style="font-size:16px;font-weight:800;color:var(--navy);line-height:1;">${nb}</div>
          <div style="font-size:9px;color:var(--g400);text-transform:uppercase;letter-spacing:.3px;">Rapports</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:14px;font-weight:800;color:#2d9e6b;line-height:1;">${totalCA.toFixed(0)}</div>
          <div style="font-size:9px;color:var(--g400);text-transform:uppercase;letter-spacing:.3px;">CHF facturés</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:14px;font-weight:800;color:var(--navy);line-height:1;">${c.tarif||'—'}</div>
          <div style="font-size:9px;color:var(--g400);text-transform:uppercase;letter-spacing:.3px;">CHF/h</div>
        </div>
      </div>
      <div style="display:flex;gap:4px;align-items:center;flex-shrink:0;flex-wrap:wrap;">
        <button class="btn btn-ghost btn-sm" onclick="editClient('${c.id}')" title="Modifier">✏️</button>
        <select onchange="clientCreate('${c.id}', this.value); this.selectedIndex=0;" title="Créer un document ou un rapport pour ce client" style="font-weight:700;font-size:12px;border:1.5px solid #2563eb;background:#eff6ff;color:#1d4ed8;border-radius:6px;padding:5.5px 6px;cursor:pointer;max-width:155px;">
          <option value="">➕ Créer ▾</option>
          <option value="bon">📄 Bon manuel</option>
          <option value="rapport">📋 Rapport d'intervention</option>
          ${CLIENT_TYPES_DOC.includes(c.type) ? `<option value="devis">📝 Devis</option><option value="facture">🧾 Facture</option>` : ''}
          <option value="bois">🪵 Diagnostic bois</option>
          <option value="rongeurs">🐀 Rapport rongeurs</option>
          <option value="blattes">🪳 Rapport blattes</option>
          <option value="fourmis">🐜 Rapport fourmis</option>
          <option value="punaises">🛏️ Rapport punaises de lit</option>
          <option value="planifier">📅 Planifier (agenda)</option>
        </select>
        <button class="btn btn-red btn-sm btn-xs" onclick="confirmDeleteClient('${c.id}','${c.nom.replace(/'/g,"\\'")}')" title="Supprimer">🗑</button>
      </div>
    </div>`;
  }).join('');
}
// Nuisible + date d'intervention sont stockés dans le champ "notes" du client
// via des marqueurs (compatibles Supabase sans nouvelle colonne).
function _clientMeta(c) {
  const notes = String((c && c.notes) || '');
  const nuis = (notes.match(/\[NUISIBLE:([^\]]*)\]/) || [])[1] || '';
  const di   = (notes.match(/\[DATEINT:([^\]]*)\]/) || [])[1] || '';
  const clean = notes.replace(/\s*\[NUISIBLE:[^\]]*\]/g, '').replace(/\s*\[DATEINT:[^\]]*\]/g, '').trim();
  // Plusieurs dates possibles, séparées par des virgules dans le marqueur
  const dates = di.split(',').map(s => s.trim()).filter(Boolean).sort();
  return { nuisible: nuis.trim(), dates: dates, dateInterv: dates[0] || '', notesClean: clean };
}
function _composeClientNotes(notesClean, nuisible, dates) {
  let out = (notesClean || '').trim();
  if (nuisible) out += (out ? '\n' : '') + '[NUISIBLE:' + nuisible.trim() + ']';
  const arr = Array.isArray(dates) ? dates.map(s => String(s||'').trim()).filter(Boolean) : (dates ? [String(dates).trim()] : []);
  if (arr.length) out += (out ? '\n' : '') + '[DATEINT:' + arr.join(',') + ']';
  return out;
}
// --- Gestion de la liste des dates d'intervention dans la modale client ---
function _clDateRow(val) {
  const div = document.createElement('div');
  div.style.cssText = 'display:flex;gap:6px;align-items:center;';
  div.innerHTML = `<input class="form-input" type="date" data-cl-date value="${val||''}" style="flex:1;">
    <button type="button" class="btn btn-ghost btn-xs" style="color:#b00;" onclick="this.parentElement.remove()" title="Retirer cette date">✕</button>`;
  return div;
}
function clAddDate(val) {
  const wrap = $('cl-dates-wrap'); if (!wrap) return;
  wrap.appendChild(_clDateRow(val || ''));
}
function clSetDates(dates) {
  const wrap = $('cl-dates-wrap'); if (!wrap) return;
  wrap.innerHTML = '';
  const arr = (dates && dates.length) ? dates : [];
  arr.forEach(d => wrap.appendChild(_clDateRow(d)));
  if (!arr.length) wrap.appendChild(_clDateRow('')); // une ligne vide par défaut
}
function clReadDates() {
  const wrap = $('cl-dates-wrap'); if (!wrap) return [];
  return Array.from(wrap.querySelectorAll('[data-cl-date]'))
    .map(i => i.value.trim()).filter(Boolean)
    .sort();
}
// Dates d'intervention éditables directement sur la carte client (comme sur les bons, max 5)
function clientAddDate(id) {
  const c = (DB.clients || []).find(x => x.id === id); if (!c) return;
  const m = _clientMeta(c); const dates = m.dates.slice();
  if (dates.length >= 5) { toast('Maximum 5 dates d\'intervention', '#e63946'); return; }
  dates.push(today());
  const list = DB.clients; const i = list.findIndex(x => x.id === id);
  if (i >= 0) { list[i] = { ...list[i], notes: _composeClientNotes(m.notesClean, m.nuisible, dates) }; DB.clients = list; }
  renderClients();
}
function clientSetDate(id, index, value) {
  const c = (DB.clients || []).find(x => x.id === id); if (!c) return;
  const m = _clientMeta(c); const dates = m.dates.slice();
  if (value) dates[index] = value; else dates.splice(index, 1);
  const list = DB.clients; const i = list.findIndex(x => x.id === id);
  if (i >= 0) { list[i] = { ...list[i], notes: _composeClientNotes(m.notesClean, m.nuisible, dates.slice().sort()) }; DB.clients = list; }
  renderClients();
}
// Action choisie dans la liste déroulante « Créer » d'une fiche client
function clientCreate(id, what) {
  if (!what) return;
  const c = (DB.clients || []).find(x => x.id === id); if (!c) { toast('Client introuvable', '#e63946'); return; }
  if (what === 'bon') { openManualBonForClient(id); return; }
  if (what === 'rapport') { openNewRapportForClient(id); return; }
  if (what === 'devis')   { createDevisFromClient(id);   return; }
  if (what === 'facture') { createFactureFromClient(id); return; }
  if (what === 'planifier') { planifyClient(id); return; }
  // Diagnostics / rapports spéciaux : on ouvre puis on pré-remplit le client
  if (what === 'bois') openNewDiagnostic();
  else if (what === 'rongeurs') openNewRongeurs();
  else if (what === 'blattes') openNewBlattes();
  else if (what === 'fourmis') openNewFourmis();
  else if (what === 'punaises') openNewPunaises();
  else return;
  if (_editingDiag) {
    _editingDiag.clientId = c.id;
    _editingDiag.clientNom = c.nom || '';
    if (!_editingDiag.locataireAdresse) _editingDiag.locataireAdresse = [c.adresse, [c.npa, c.ville].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    if (typeof renderDiagEditor === 'function') renderDiagEditor();
  }
}
// Ouvre un bon manuel pré-rempli depuis une fiche client
function openManualBonForClient(id) {
  const c = (DB.clients || []).find(x => x.id === id); if (!c) return;
  // Dates d'intervention déjà saisies sur la fiche client → transmises AVANT l'ouverture
  // pour qu'elles soient affichées d'emblée dans le formulaire du bon manuel.
  const _cm = (typeof _clientMeta === 'function') ? _clientMeta(c) : { dates: [] };
  if (typeof openManualBon === 'function') openManualBon((_cm.dates || []).slice());
  const set = (k, v) => { const el = $('bonf-' + k); if (el) el.value = v || ''; };
  const gerant = String(c.contact || '').replace(/^\[ROLE:[^\]]*\]/, '').trim();
  set('gerance_nom', c.nom);
  set('gerant_nom', gerant);
  set('gerant_tel', c.tel);
  set('gerant_email', c.email);
  set('gerance_adresse', c.adresse);
  set('gerance_npa', c.npa);
  set('gerance_ville', c.ville);
  // Nuisible de la fiche client → problème signalé du bon (s'il est vide)
  const _pb = $('bonf-probleme');
  if (_pb && !_pb.value && _cm.nuisible) _pb.value = _cm.nuisible;
}
// Planifie une intervention dans l'agenda depuis une fiche client (modale pré-remplie)
function planifyClient(id) {
  const c = (DB.clients || []).find(x => x.id === id); if (!c) { toast('Client introuvable', '#e63946'); return; }
  const meta = _clientMeta(c);
  const fut = (meta.dates || []).filter(d => d >= today()).sort();
  const date = fut[0] || (meta.dates && meta.dates[0]) || today();
  openNewIntervDate(date, '08:00');
  populateClientSelectInterv(c.id);
  populateLocataireSelectInterv(c.id, '');
  const adr = [c.adresse, [c.npa, c.ville].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  if ($('iv-adresse') && adr) $('iv-adresse').value = adr;
  if ($('iv-nuisible') && meta.nuisible) $('iv-nuisible').value = meta.nuisible;
}
function openNewClient() {
  state.editingClientId = null;
  $('modal-client-title').textContent = 'Nouveau client';
  ['cl-nom','cl-contact','cl-tel','cl-email','cl-web','cl-adresse','cl-npa','cl-ville','cl-num','cl-tarif','cl-notes','cl-nuisible'].forEach(id => { const el = $(id); if (el) el.value = ''; });
  clSetDates([]);
  if ($('cl-contact-role')) $('cl-contact-role').value = 'Gérant';
  $('cl-type').value = 'Gérance';
  $('cl-delete-btn').style.display = 'none';
  openModal('modal-client');
}
function editClient(id) {
  state.editingClientId = id;
  const c = DB.clients.find(x => x.id === id); if (!c) return;
  $('modal-client-title').textContent = 'Modifier le client';
  $('cl-nom').value = c.nom; $('cl-type').value = c.type;
  $('cl-contact').value = _rapContactNom(c.contact); $('cl-tel').value = c.tel||'';
  if ($('cl-contact-role')) $('cl-contact-role').value = _rapContactRole(c.contact) || 'Gérant';
  $('cl-email').value = c.email||''; $('cl-web').value = c.web||'';
  $('cl-adresse').value = c.adresse||''; $('cl-npa').value = c.npa||'';
  $('cl-ville').value = c.ville||''; $('cl-num').value = c.num||'';
  $('cl-tarif').value = c.tarif||'';
  const meta = _clientMeta(c);
  $('cl-notes').value = meta.notesClean;
  if ($('cl-nuisible')) $('cl-nuisible').value = meta.nuisible;
  clSetDates(meta.dates);
  $('cl-delete-btn').style.display = 'inline-flex';
  openModal('modal-client');
}
function saveClient() {
  const nom = $('cl-nom').value.trim();
  if (!nom) { toast('Le nom est obligatoire', '#e63946'); return; }
  const data = {
    nom, type: $('cl-type').value, contact: _composeRapContact(($('cl-contact-role')||{}).value || '', $('cl-contact').value),
    tel: $('cl-tel').value, email: $('cl-email').value, web: $('cl-web').value,
    adresse: $('cl-adresse').value, npa: $('cl-npa').value, ville: $('cl-ville').value,
    num: $('cl-num').value, tarif: $('cl-tarif').value,
    notes: _composeClientNotes($('cl-notes').value, ($('cl-nuisible')||{}).value || '', clReadDates()),
  };
  const list = DB.clients;
  if (state.editingClientId) {
    const i = list.findIndex(c => c.id === state.editingClientId);
    if (i >= 0) list[i] = { ...list[i], ...data };
    toast('Client mis à jour ✓', '#2d9e6b');
  } else {
    data.id = newId();
    list.push(data);
    toast('Client ajouté ✓', '#2d9e6b');
  }
  DB.clients = list;
  closeModal('modal-client'); renderClients(); renderDashboard();
}
function confirmDeleteClient(id, nom) {
  $('confirm-msg').textContent = `Supprimer "${nom}" ? Cette action est irréversible.`;
  $('confirm-btn').onclick = () => { DB.clients = DB.clients.filter(c => c.id !== id); closeModal('modal-confirm'); renderClients(); toast('Client supprimé', '#e63946'); };
  openModal('modal-confirm');
}

// ============================================================
// RAPPORTS LIST
// ============================================================
function renderRapports() {
  updateNavCounts();
  // Section "Reprendre plus tard" : tous les rapports en brouillon, accès direct
  const draftsBox = $('rapports-drafts');
  if (draftsBox) {
    const drafts = (DB.rapports || []).filter(r => r.statut === 'Brouillon' && !_isRapportFactArchived(r))
      .slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (drafts.length) {
      draftsBox.innerHTML = `
        <div style="border:1.5px solid #f59e0b;border-radius:10px;padding:12px 14px;background:#fffbeb;">
          <div style="font-size:13px;font-weight:800;color:#b45309;margin-bottom:10px;">🕒 Reprendre plus tard (${drafts.length}) — brouillons non finalisés</div>
          <div style="display:flex;flex-direction:column;gap:6px;">
            ${drafts.map(r => {
              const loc = _rapLoc(r);
              const _bon = r.bonCommande ? (DB.bons || []).find(b => _factNorm(b.numero) === _factNorm(r.bonCommande)) : null;
              // Adresse D'INTERVENTION (locataire / immeuble du bon) — jamais celle de la gérance
              const adr = loc.adresse || (_bon && _bon.immeuble) || '';
              const locNom = loc.nom || (_bon && _bon.locataireNom) || '';
              const nuis = (r.nuisibles && r.nuisibles.length) ? r.nuisibles.join(', ') : '';
              const sousLigne = [locNom ? '🏠 ' + locNom : '', adr ? '📍 ' + adr : '', r.tech ? '👷 ' + r.tech : ''].filter(Boolean).join(' &nbsp;·&nbsp; ');
              return `
              <div style="display:flex;align-items:center;gap:12px;background:#fff;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;flex-wrap:wrap;">
                <div style="min-width:120px;">
                  <div style="font-size:12px;font-weight:800;color:var(--navy);">📋 ${r.id}</div>
                  <div style="font-size:11px;color:var(--g600);">📅 ${fmtDate(r.date) || '—'}</div>
                </div>
                <div style="flex:1;min-width:180px;font-size:12px;color:var(--g600);">
                  <div style="font-weight:600;color:var(--navy);">${r.clientNom || '— Sans client —'}${nuis ? ' · 🐛 ' + nuis : ''}</div>
                  ${sousLigne ? `<div style="font-size:11px;margin-top:2px;">${sousLigne}</div>` : ''}
                </div>
                <div style="display:flex;gap:5px;flex-shrink:0;">
                  <button class="btn btn-navy btn-sm" onclick="editRapport('${r.id}')" title="Reprendre ce rapport">▶ Reprendre</button>
                  <button class="btn btn-red btn-sm btn-xs" onclick="event.stopPropagation();confirmDeleteRapport('${r.id}')" title="Supprimer ce brouillon">🗑</button>
                </div>
              </div>`;
            }).join('')}
          </div>
        </div>`;
    } else {
      draftsBox.innerHTML = '';
    }
  }
  const q = ($('rapp-search') || {}).value || '';
  const list = DB.rapports.filter(r => {
    if (_isRapportFactArchived(r)) return false; // parti dans « Facturation archivée »
    const _l = _rapLoc(r);
    const hay = ((r.id||'') + ' ' + (r.clientNom||'') + ' ' + (r.nuisibles||[]).join(' ') + ' ' + (r.bonCommande||'') + ' ' + (r.noint||'') + ' ' + (r.tech||'') + ' ' + (r.ville||'') + ' ' + (r.contact||'') + ' ' + (_l.nom||'') + ' ' + (_l.adresse||'')).toLowerCase();
    const m = hay.includes(q.toLowerCase());
    return m && (state.rapportsFilter === 'Tous' || r.statut === state.rapportsFilter);
  });
  const tb = $('rapports-tbody');
  if (!tb) return;

  // Regroupe les rapports par gérance (client)
  const groupes = {};
  list.forEach(r => {
    const cle = r.clientNom || '— Sans client —';
    (groupes[cle] = groupes[cle] || []).push(r);
  });
  // Rapports spéciaux (diagnostics FM / RG / BL / DG) intégrés SOUS les mêmes rubans gérance.
  // Affichés en filtre « Tous » (leur statut Brouillon/Finalisé diffère des rapports classiques).
  const diagGroupes = {};
  if ((state.rapportsFilter || 'Tous') === 'Tous') {
    (DB.diagnostics || []).forEach(d => {
      const hay = ((d.numero||'') + ' ' + (d.clientNom||'') + ' ' + (d.locataireNom||'') + ' ' + (d.insectes||[]).join(' ') + ' ' + (d.tech||'')).toLowerCase();
      if (q && !hay.includes(q.toLowerCase())) return;
      const cle = (d.clientNom||'').trim() || '— Sans client —';
      (diagGroupes[cle] = diagGroupes[cle] || []).push(d);
    });
  }
  // Union des gérances (rapports classiques + spéciaux), triées alphabétiquement
  const noms = [...new Set([...Object.keys(groupes), ...Object.keys(diagGroupes)])].sort((a, b) => {
    if (a === '— Sans client —') return 1;
    if (b === '— Sans client —') return -1;
    return a.localeCompare(b, 'fr');
  });

  if (!noms.length) {
    tb.innerHTML = '<tr><td colspan="9"><div class="empty"><div class="empty-icon">📋</div><div class="empty-text">Aucun rapport</div></div></td></tr>';
    return;
  }

  const ligneRapport = r => {
    const loc = _rapLoc(r);
    const _bon = r.bonCommande ? (DB.bons || []).find(b => _factNorm(b.numero) === _factNorm(r.bonCommande)) : null;
    // Adresse d'intervention : locataire/immeuble du bon (jamais la gérance)
    const locNom = loc.nom || (_bon && _bon.locataireNom) || '';
    const locAdr = loc.adresse || (_bon && _bon.immeuble) || '';
    const locTxt = [locNom, locAdr].filter(Boolean).join(' · ');
    const locLigne = locTxt
      ? `<div style="font-size:11.5px;color:#1e3a8a;margin-top:2px;">🏠 ${locTxt}</div>`
      : '';
    return `
    <tr onclick="editRapport('${r.id}')">
      <td style="font-weight:700;color:var(--navy);">${r.id}</td>
      <td>${r.clientNom||'—'}${locLigne}</td>
      <td>${r.bonCommande || '—'}</td>
      <td>${(r.nuisibles||[]).join(', ')||'—'}</td>
      <td>${fmtDate(r.date)}</td>
      <td>${r.tech||'—'}</td>
      <td>${r.montant ? r.montant+' CHF' : '—'}</td>
      <td><span class="badge ${badgeCls(r.statut)}">${r.statut}</span></td>
      <td style="white-space:nowrap;">
        <button class="btn btn-ghost btn-xs" title="Envoyer dans « Facturation archivée » (même sans facture)" onclick="event.stopPropagation();archiveRapport('${r.id}')">📦</button>
        <button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();confirmDeleteRapport('${r.id}')">🗑</button>
      </td>
    </tr>`;
  };

  // Ligne d'un rapport spécial (diagnostic) — mêmes colonnes que le tableau des rapports
  const ligneDiag = d => {
    const _dt = _diagType(d); const rg = _dt==='rongeurs', bl = _dt==='blattes', fm = _dt==='fourmis', pl = _dt==='punaises';
    const ico = pl?'🛏️':(fm?'🐜':(bl?'🪳':(rg?'🐀':'🪵')));
    const stm = String(d.diagnostic||'').match(/\[STATUT:([^\]]*)\]/); const st = stm ? _decNote(stm[1]) : '';
    const stBadge = st==='Brouillon'
      ? '<span class="badge" style="background:#fffbeb;color:#b45309;border:1px solid #fcd34d;">🕒 Brouillon</span>'
      : (st==='Finalisé' ? '<span class="badge" style="background:#dcfce7;color:#166534;border:1px solid #86efac;">✓ Finalisé</span>' : '—');
    const locLigne = d.locataireNom ? `<div style="font-size:11.5px;color:#1e3a8a;margin-top:2px;">🏠 ${d.locataireNom}</div>` : '';
    return `
    <tr onclick="editDiag('${d.id}')">
      <td style="font-weight:700;color:var(--navy);">${ico} ${d.numero||'—'}</td>
      <td>${d.clientNom||'—'}${locLigne}</td>
      <td>—</td>
      <td>${(d.insectes||[]).join(', ')||'—'}</td>
      <td>${fmtDate(d.dateDoc)||'—'}</td>
      <td>${d.tech||'—'}</td>
      <td>—</td>
      <td>${stBadge}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();downloadDiagPDF('${d.id}')" title="Télécharger le PDF">📥</button>
        <button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();confirmDeleteDiag('${d.id}','${(d.numero||'').replace(/'/g,"\\'")}')" title="Supprimer">🗑</button>
      </td>
    </tr>`;
  };

  tb.innerHTML = noms.map(nom => {
    // Rapports de la gérance, du plus récent au plus ancien
    const rapps = (groupes[nom] || []).slice().reverse();
    const diags = (diagGroupes[nom] || []).slice().sort((a, b) => (b.dateDoc||'').localeCompare(a.dateDoc||''));
    const nb = rapps.length + diags.length;
    const techs = [...new Set(rapps.map(r => r.tech).filter(Boolean))];
    const techTxt = techs.length ? `<span class="rapport-groupe-tech">👷 ${techs.join(', ')}</span>` : '';
    const entete = `
      <tr class="rapport-groupe">
        <td colspan="9">🏢 ${nom} <span class="rapport-groupe-nb">${nb} rapport${nb > 1 ? 's' : ''}</span>${techTxt}</td>
      </tr>`;
    return entete + rapps.map(ligneRapport).join('') + diags.map(ligneDiag).join('');
  }).join('');
}
function confirmDeleteRapport(id) {
  $('confirm-msg').textContent = `Supprimer le rapport "${id}" ? Cette action est irréversible.`;
  $('confirm-btn').onclick = () => { DB.rapports = DB.rapports.filter(r => r.id !== id); closeModal('modal-confirm'); renderRapports(); renderDashboard(); toast('Rapport supprimé', '#e63946'); };
  openModal('modal-confirm');
}

// ============================================================
// RAPPORT EDITOR
// ============================================================
function populateTechSelect(sel, selected) {
  if (!sel) return;
  const selNom = _techNom(selected);
  sel.innerHTML = DB.techs.map(t => {
    const nom = _techNom(t), titre = _techTitre(t);
    const label = titre ? `${nom} — ${titre}` : nom;
    return `<option value="${nom.replace(/"/g, '&quot;')}"${nom === selNom ? ' selected' : ''}>${label}</option>`;
  }).join('');
}
function populateClientSelectRapport(selectedId) {
  $('r-client').innerHTML = '<option value="">-- Sélectionner un client --</option>' +
    DB.clients.map(c => {
      const contact = _rapContactNom(c.contact || '');
      const label = contact ? `${c.nom} — ${contact} (${c.type})` : `${c.nom} (${c.type})`;
      return `<option value="${c.id}"${c.id === selectedId ? ' selected' : ''}>${label}</option>`;
    }).join('');
}
function resetRapportForm() {
  state.produits = []; state.photos = [null,null,null,null,null,null];
  const newId = genId();
  $('r-id').value = newId; $('r-date').value = today();
  populateTechSelect($('r-tech'), DB.techs[0] || '');
  populateClientSelectRapport('');
  ['r-contact','r-tel','r-email','r-adresse','r-npa','r-ville','r-localisation',
   'r-description','r-origine','r-contraintes','r-produits','r-precautions',
   'r-recommandations','r-rdv','r-noint','r-superficie','r-pieces','r-zones',
   'r-duree','r-montant'].forEach(id => { const el = $(id); if (el) el.value = ''; });
  ['r-niveau','r-resultat','r-batiment','r-garantie'].forEach(id => { const el = $(id); if (el) el.value = ''; });
  if ($('r-rdv-heure')) $('r-rdv-heure').value = '';
  if ($('r-bon-commande')) $('r-bon-commande').value = '';
  if ($('r-nb-passages')) $('r-nb-passages').value = '';
  rSetDates([]);
  document.querySelectorAll('#tab-nuisibles input[type=checkbox]').forEach(c => c.checked = false);
  ['t-pulv','t-vapeur','t-thermique','t-injection','t-appats','t-monitoring','t-desinfect','t-flocage','t-gel','t-poudre','t-fumigation','t-pose','t-appatage','t-rodenticide','t-racumin','t-talonwax','t-gel-fl','t-gel-fe','t-gel-ff','t-gel-fp','t-gel-bg','t-gel-ba','t-gel-bo','t-gel-br'].forEach(id => { const el = $(id); if (el) el.checked = false; });
  renderProduits(); resetPhotoGrid(); clearSig();
  $('edit-id').textContent = newId;
  $('edit-status').className = 'badge b-gray'; $('edit-status').textContent = 'Brouillon';
  $('edit-meta').textContent = '';
  // Par défaut, on garde le bloc Locataire ouvert (l'utilisateur peut le fermer manuellement)
  if ($('r-avec-locataire')) $('r-avec-locataire').checked = true;
  clearLocataireSelection();
  if ($('bloc-locataire')) $('bloc-locataire').style.display = 'block';
  const d = $('r-locataire-details'); if (d) d.style.display = 'block';
  // Bloc « Adresse d'intervention » fermé par défaut
  if ($('r-avec-adresse')) $('r-avec-adresse').checked = false;
  if (typeof toggleAdresse === 'function') toggleAdresse();
  showTab('infos'); updatePDF();
}
function openNewRapport() { state.editingRapportId = null; resetRapportForm(); showScreen('rapport-edit'); }
function openNewRapportForClient(clientId) {
  state.editingRapportId = null; resetRapportForm();
  populateClientSelectRapport(clientId); onClientChange();
  showScreen('rapport-edit');
}
function editRapport(id) {
  const r = DB.rapports.find(x => x.id === id); if (!r) return;
  state.editingRapportId = id;
  state.produits = r.produits ? JSON.parse(JSON.stringify(r.produits)) : [];
  state.photos = r.photos || [null,null,null,null,null,null];
  while (state.photos.length < 6) state.photos.push(null);
  $('r-id').value = r.id; $('r-date').value = r.date || today();
  populateTechSelect($('r-tech'), r.tech || '');
  populateClientSelectRapport(r.clientId);
  ['r-contact','r-tel','r-email','r-adresse','r-npa','r-ville','r-localisation','r-batiment','r-noint','r-description','r-origine','r-contraintes','r-zones','r-precautions','r-duree','r-montant','r-recommandations','r-rdv'].forEach(id => {
    const el = $(id); const key = id.replace('r-','');
    if (el) el.value = r[key] || '';
  });
  ['r-niveau','r-resultat','r-garantie','r-superficie','r-pieces'].forEach(id => {
    const el = $(id); const key = id.replace('r-','');
    if (el) el.value = r[key] || '';
  });
  // Passages + dates : colonnes Supabase d'abord, sinon anciens marqueurs
  const rMeta = _rapMeta(r.description);
  if ($('r-description')) $('r-description').value = rMeta.descClean;
  if ($('r-nb-passages')) $('r-nb-passages').value = _rapNbPassages(r);
  rSetDates(_rapDates(r));
  // Décode le rôle + nom du contact (gérant…)
  if ($('r-contact')) $('r-contact').value = _rapContactNom(r.contact);
  if ($('r-contact-role')) $('r-contact-role').value = _rapContactRole(r.contact) || 'Gérant';
  document.querySelectorAll('#tab-nuisibles input[type=checkbox]').forEach(c => c.checked = (r.nuisibles||[]).includes(c.value));
  ['t-pulv','t-vapeur','t-thermique','t-injection','t-appats','t-monitoring','t-desinfect','t-flocage','t-gel','t-poudre','t-fumigation','t-pose','t-appatage','t-rodenticide','t-racumin','t-talonwax','t-gel-fl','t-gel-fe','t-gel-ff','t-gel-fp','t-gel-bg','t-gel-ba','t-gel-bo','t-gel-br'].forEach(id => { const el = $(id); if (el) el.checked = (r.traitement||[]).includes(id); });
  if ($('r-rdv-heure')) $('r-rdv-heure').value = r.rdvHeure || '';
  if ($('r-bon-commande')) $('r-bon-commande').value = r.bonCommande || '';
  // Restaurer le locataire : colonnes Supabase d'abord, sinon ancien marqueur [LOC:...]
  const lc = _rapLoc(r);
  const locNom = lc.nom || r.locataire || '';
  const locTel = lc.tel || '';
  const locEmail = lc.email || '';
  const locAdr = lc.adresse || '';
  const setL = (id, v) => { const el = $(id); if (el) el.value = v || ''; };
  setL('r-locataire', locNom); setL('r-locataire-tel', locTel);
  setL('r-locataire-email', locEmail); setL('r-locataire-adresse', locAdr);
  const hasLoc = !!(locNom || locTel || locEmail || locAdr);
  if ($('r-avec-locataire')) $('r-avec-locataire').checked = hasLoc;
  toggleLocataire();
  // Ouvre le bloc « Adresse d'intervention » si une adresse est enregistrée
  const hasAdr = !!((r.adresse || '') || (r.npa || '') || (r.ville || ''));
  if ($('r-avec-adresse')) $('r-avec-adresse').checked = hasAdr;
  if (typeof toggleAdresse === 'function') toggleAdresse();
  // Correction : sur d'anciens rapports, l'adresse d'intervention enregistrée était en fait
  // l'adresse de la GÉRANCE (ancien remplissage auto). On la remplace par la vraie adresse
  // d'intervention = l'immeuble du bon lié (ou on la vide si aucun bon).
  const _cliRec = r.clientId ? (DB.clients || []).find(c => c.id === r.clientId) : null;
  const _adrIsGerance = !!(_cliRec && _cliRec.adresse && _factNorm((r.adresse || '') + (r.ville || '')) === _factNorm((_cliRec.adresse || '') + (_cliRec.ville || '')));
  const _b = r.bonCommande ? (DB.bons || []).find(b => _factNorm(b.numero) === _factNorm(r.bonCommande)) : null;
  if (_adrIsGerance) {
    ['r-adresse', 'r-npa', 'r-ville'].forEach(id => { const e = $(id); if (e) e.value = ''; });
    if (_b && _b.immeuble && typeof _setAdresseInter === 'function') _setAdresseInter(_b.immeuble);
    else { if ($('r-avec-adresse')) $('r-avec-adresse').checked = false; if (typeof toggleAdresse === 'function') toggleAdresse(); }
  } else if (!hasAdr && _b && _b.immeuble && typeof _setAdresseInter === 'function') {
    _setAdresseInter(_b.immeuble);
  }
  $('edit-id').textContent = r.id;
  $('edit-status').className = 'badge ' + badgeCls(r.statut); $('edit-status').textContent = r.statut;
  $('edit-meta').textContent = (r.clientNom || '') + (r.date ? ' · ' + fmtDate(r.date) : '');
  renderProduits(); resetPhotoGrid(); clearSig(); showTab('infos'); updatePDF();
  showScreen('rapport-edit');
}
function onClientChange() {
  const id = $('r-client').value;
  const c = DB.clients.find(x => x.id === id);
  if (c) {
    // Sélection d'un client → on (re)remplit systématiquement les coordonnées du contact
    $('r-tel').value     = c.tel || '';
    $('r-email').value   = c.email || '';
    $('r-contact').value = _rapContactNom(c.contact) || '';
    const role = _rapContactRole(c.contact);
    if ($('r-contact-role')) $('r-contact-role').value = role || 'Gérant';
    // --- Adresse d'intervention ---
    // Particulier / Entreprise : l'intervention a lieu CHEZ le client → on pré-remplit
    //   l'adresse d'intervention avec SA propre adresse.
    // Gérance (et autres) : l'adresse d'intervention est celle du locataire / immeuble (du bon),
    //   PAS celle du client → on VIDE le champ pour ne jamais afficher l'adresse d'un autre client.
    const estSite = (c.type === 'Particulier' || c.type === 'Entreprise');
    if (estSite && (c.adresse || c.npa || c.ville)) {
      if ($('r-adresse')) $('r-adresse').value = (c.adresse || '').trim();
      if ($('r-npa'))     $('r-npa').value     = (c.npa || '').trim();
      if ($('r-ville'))   $('r-ville').value   = (c.ville || '').trim();
      if ($('r-avec-adresse')) $('r-avec-adresse').checked = true;
    } else {
      ['r-adresse', 'r-npa', 'r-ville'].forEach(fid => { const e = $(fid); if (e) e.value = ''; });
      if ($('r-avec-adresse')) $('r-avec-adresse').checked = false;
    }
    if (typeof toggleAdresse === 'function') toggleAdresse();
  }
  updatePDF();
}
// Affiche/masque le bloc « Adresse d'intervention » selon la case à cocher
function toggleAdresse() {
  const on = !!($('r-avec-adresse') && $('r-avec-adresse').checked);
  const d = $('bloc-adresse-details');
  if (d) d.style.display = on ? 'block' : 'none';
  if (typeof updatePDF === 'function') updatePDF();
}
// Découpe une adresse "Rue 12, 2000 Ville" en {adresse, npa, ville}
function _parseAdresseInter(s) {
  s = String(s || '').trim();
  const m = s.match(/^(.*?)[,\s]+(\d{4})\s+(.+)$/);
  if (m) return { adresse: m[1].replace(/[,\s]+$/, '').trim(), npa: m[2], ville: m[3].trim() };
  return { adresse: s, npa: '', ville: '' };
}
// Renseigne le bloc « Adresse d'intervention » et l'ouvre
function _setAdresseInter(adrStr) {
  const p = _parseAdresseInter(adrStr || '');
  if (!p.adresse && !p.npa && !p.ville) return;
  if ($('r-adresse')) $('r-adresse').value = p.adresse;
  if ($('r-npa'))     $('r-npa').value     = p.npa;
  if ($('r-ville'))   $('r-ville').value   = p.ville;
  if ($('r-avec-adresse')) $('r-avec-adresse').checked = true;
  toggleAdresse();
}

// ============================================================
// LOCATAIRE (saisie directe sur le rapport)
// ============================================================
function _lv(id) { const el = $(id); return el ? el.value.trim() : ''; }

function toggleLocataire() {
  const on = !!($('r-avec-locataire') && $('r-avec-locataire').checked);
  const bloc = $('bloc-locataire');
  const details = $('r-locataire-details');
  if (bloc)    bloc.style.display    = on ? 'block' : 'none';
  if (details) details.style.display = on ? 'block' : 'none'; // saisie directe
  if (!on) clearLocataireSelection();
  if (typeof updatePDF === 'function') updatePDF();
}

function clearLocataireSelection() {
  ['r-locataire','r-locataire-tel','r-locataire-email','r-locataire-adresse']
    .forEach(id => { const el = $(id); if (el) el.value = ''; });
  const hid = $('r-locataire-id'); if (hid) hid.value = '';
  const res = $('r-locataire-results'); if (res) { res.style.display = 'none'; res.innerHTML = ''; }
  if (typeof updatePDF === 'function') updatePDF();
}

function searchLocataire(q) {
  const details = $('r-locataire-details');
  if (details) details.style.display = 'block'; // on laisse toujours écrire à la main
  const box = $('r-locataire-results'); if (!box) return;
  q = (q || '').trim().toLowerCase();
  const all = DB.locataires || [];
  if (!q || !all.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
  const hits = all.filter(l => ((l.nom||'') + ' ' + (l.ville||'')).toLowerCase().includes(q)).slice(0, 8);
  if (!hits.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.innerHTML = hits.map(l =>
    `<div style="padding:8px 10px;cursor:pointer;border-bottom:1px solid #eee;" onclick="pickLocataire('${l.id}')">${l.nom}${l.ville ? ' — ' + l.ville : ''}</div>`
  ).join('');
  box.style.display = 'block';
}

function pickLocataire(id) {
  const l = (DB.locataires || []).find(x => x.id === id); if (!l) return;
  const set = (fid, v) => { const el = $(fid); if (el) el.value = v || ''; };
  set('r-locataire', l.nom); set('r-locataire-tel', l.tel);
  set('r-locataire-email', l.email); set('r-locataire-adresse', l.adresse);
  const hid = $('r-locataire-id'); if (hid) hid.value = l.id;
  const res = $('r-locataire-results'); if (res) { res.style.display = 'none'; res.innerHTML = ''; }
  const details = $('r-locataire-details'); if (details) details.style.display = 'block';
  if (typeof updatePDF === 'function') updatePDF();
}

// Remplit le menu déroulant des gérances dans la modale locataire
function _refreshLocClientDropdown(selectedId) {
  const sel = $('loc-client');
  if (!sel) return;
  const opts = ['<option value="">-- Aucune gérance --</option>']
    .concat(DB.clients
      .filter(c => c.type === 'Gérance')
      .map(c => `<option value="${c.id}"${c.id === selectedId ? ' selected' : ''}>${_clientOptionLabel(c).replace(/</g, '&lt;')}</option>`));
  sel.innerHTML = opts.join('');
}

// "+ Nouveau" : si on est sur l'écran Locataires, ouvre la modale ;
// sinon (depuis le formulaire de rapport), révèle les champs inline.
function openNewLocataire() {
  const screenLoc = $('screen-locataires');
  if (screenLoc && screenLoc.classList.contains('active')) {
    state.editingLocataireId = null;
    const setVal = (id, v) => { const el = $(id); if (el) el.value = v || ''; };
    ['loc-prenom','loc-nom','loc-tel','loc-email','loc-adresse','loc-npa','loc-ville','loc-notes']
      .forEach(id => setVal(id, ''));
    _refreshLocClientDropdown('');
    const t = $('modal-locataire-title'); if (t) t.textContent = 'Nouveau locataire';
    const d = $('loc-delete-btn'); if (d) d.style.display = 'none';
    openModal('modal-locataire');
    return;
  }
  // Comportement d'origine (formulaire de rapport)
  const cb = $('r-avec-locataire'); if (cb && !cb.checked) cb.checked = true;
  if (typeof toggleLocataire === 'function') toggleLocataire();
  const details = $('r-locataire-details'); if (details) details.style.display = 'block';
  const first = $('r-locataire'); if (first) first.focus();
}

// Ouvre la modale en mode édition, pré-remplie avec les données du locataire
function editLocataire(id) {
  const l = (DB.locataires || []).find(x => x.id === id);
  if (!l) return;
  state.editingLocataireId = id;
  const setVal = (fid, v) => { const el = $(fid); if (el) el.value = v || ''; };
  setVal('loc-prenom', l.prenom || '');
  setVal('loc-nom', l.nom || '');
  setVal('loc-tel', l.tel || '');
  setVal('loc-email', l.email || '');
  setVal('loc-adresse', l.adresse || '');
  setVal('loc-npa', l.npa || '');
  setVal('loc-ville', l.ville || '');
  setVal('loc-notes', l.notes || '');
  _refreshLocClientDropdown(l.clientId || '');
  const t = $('modal-locataire-title'); if (t) t.textContent = 'Modifier le locataire';
  const d = $('loc-delete-btn'); if (d) d.style.display = 'inline-flex';
  openModal('modal-locataire');
}

// Stub conservé (utilisé par le formulaire d'intervention)
function onIvLocataireChange() {}

// Enregistre un locataire (création ou mise à jour)
function saveLocataire() {
  const get = (id) => { const el = $(id); return el ? el.value.trim() : ''; };
  const prenom = get('loc-prenom');
  const nomChamp = get('loc-nom');
  // Le modèle stocke un nom unique : on combine prénom + nom si les deux sont remplis
  const nomComplet = (prenom && nomChamp) ? (prenom + ' ' + nomChamp) : (nomChamp || prenom);
  if (!nomComplet) { toast('Le nom du locataire est obligatoire', '#e63946'); return; }
  const data = {
    nom: nomComplet,
    prenom: prenom,
    tel: get('loc-tel'),
    email: get('loc-email'),
    adresse: get('loc-adresse'),
    npa: get('loc-npa'),
    ville: get('loc-ville'),
    clientId: get('loc-client'),
    notes: get('loc-notes')
  };
  const list = DB.locataires;
  if (state.editingLocataireId) {
    const i = list.findIndex(l => l.id === state.editingLocataireId);
    if (i >= 0) list[i] = { ...list[i], ...data };
    toast('Locataire mis à jour ✓', '#2d9e6b');
  } else {
    data.id = newId();
    list.push(data);
    toast('Locataire ajouté ✓', '#2d9e6b');
  }
  DB.locataires = list;
  state.editingLocataireId = null;
  closeModal('modal-locataire');
  renderLocataires();
  if (typeof renderBons === 'function') renderBons();
  if (typeof renderDashboard === 'function') renderDashboard();
}

// ============================================================
// PASSAGES / DATES D'INTERVENTION DU RAPPORT
// Stockés via marqueurs dans "description" (pas de nouvelle colonne Supabase).
// Rôle du contact (gérant, concierge…) encodé dans le champ "contact" : "[ROLE:Gérant]Nom"
function _rapContactRole(contact) {
  const m = String(contact || '').match(/^\[ROLE:([^\]]*)\]/);
  return m ? m[1] : '';
}
function _rapContactNom(contact) {
  return String(contact || '').replace(/^\[ROLE:[^\]]*\]/, '').trim();
}
// Libellé d'un client dans une liste déroulante : « Gérance — Gérant (Type) ».
// Indispensable car il y a UNE CARTE PAR GÉRANT : sans le nom du gérant, plusieurs
// cartes de la même gérance sont impossibles à distinguer dans la liste.
function _clientOptionLabel(c) {
  if (!c) return '';
  const nom = String(c.nom || '');
  const contact = _rapContactNom(c.contact);
  const type = c.type ? ' (' + c.type + ')' : '';
  return (contact ? nom + ' — ' + contact : nom) + type;
}
// Normalise un nom de personne pour comparaison (ignore M./Mme/Monsieur…, ponctuation,
// accents et espaces multiples) → évite les doublons de fiches gérant.
function _normPerson(s) {
  return String(s || '')
    .replace(/\[ROLE:[^\]]*\]/g, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // enlève les accents
    .replace(/\b(m|mme|mr|mlle|monsieur|madame|mademoiselle)\b\.?/gi, ' ')
    .replace(/[.,;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().toLowerCase();
}
function _composeRapContact(role, nom) {
  const n = String(nom || '').trim();
  const r = String(role || '').trim();
  return (r && r !== 'Contact') ? '[ROLE:' + r + ']' + n : n;
}
// ============================================================
function _rapMeta(desc) {
  const s = String(desc || '');
  const np = (s.match(/\[NBPASS:([^\]]*)\]/) || [])[1] || '';
  const di = (s.match(/\[DATESINT:([^\]]*)\]/) || [])[1] || '';
  // Locataire stocké en marqueur (colonnes absentes côté Supabase) : nom|tel|email|adresse
  const lc = (s.match(/\[LOC:([^\]]*)\]/) || [])[1] || '';
  const lcParts = lc.split('|');
  const clean = s
    .replace(/\s*\[NBPASS:[^\]]*\]/g, '')
    .replace(/\s*\[DATESINT:[^\]]*\]/g, '')
    .replace(/\s*\[LOC:[^\]]*\]/g, '')
    .replace(/\s*\[ARCHIVE\]/g, '')
    .trim();
  const dates = di.split(',').map(x => x.trim()).filter(Boolean).sort();
  return {
    archived: /\[ARCHIVE\]/.test(s),
    nbPassages: np.trim(), dates: dates, descClean: clean,
    loc: lc ? {
      nom:     (lcParts[0] || '').replace(/¦/g, '|'),
      tel:     (lcParts[1] || '').replace(/¦/g, '|'),
      email:   (lcParts[2] || '').replace(/¦/g, '|'),
      adresse: (lcParts[3] || '').replace(/¦/g, '|'),
    } : null
  };
}
function _composeRapDesc(descClean, nbPassages, dates, loc, archived) {
  let out = (descClean || '').trim();
  const arr = Array.isArray(dates) ? dates.map(x => String(x||'').trim()).filter(Boolean) : [];
  if (nbPassages) out += (out ? '\n' : '') + '[NBPASS:' + String(nbPassages).trim() + ']';
  if (arr.length) out += (out ? '\n' : '') + '[DATESINT:' + arr.join(',') + ']';
  // Locataire : encodé "nom|tel|email|adresse" (| échappé en ¦ dans les valeurs)
  if (loc && (loc.nom || loc.tel || loc.email || loc.adresse)) {
    const esc = v => String(v || '').replace(/\|/g, '¦');
    out += (out ? '\n' : '') + '[LOC:' + [esc(loc.nom), esc(loc.tel), esc(loc.email), esc(loc.adresse)].join('|') + ']';
  }
  if (archived) out += (out ? '\n' : '') + '[ARCHIVE]';
  return out;
}
// Locataire d'un rapport : on lit en PRIORITÉ les vraies colonnes Supabase
// (locataire_nom/tel/email/adresse) et, à défaut (anciens rapports), l'ancien marqueur [LOC:].
function _rapLoc(r) {
  if (!r) return { nom: '', tel: '', email: '', adresse: '' };
  const m = (_rapMeta(r.description).loc) || {};
  return {
    nom:     r.locataireNom     || m.nom     || '',
    tel:     r.locataireTel     || m.tel     || '',
    email:   r.locataireEmail   || m.email   || '',
    adresse: r.locataireAdresse || m.adresse || '',
  };
}
// Nombre de passages / dates d'intervention : colonnes Supabase d'abord, sinon marqueurs.
function _rapNbPassages(r) {
  if (r && r.nbPassages) return String(r.nbPassages);
  return _rapMeta(r && r.description).nbPassages || '';
}
function _rapDates(r) {
  if (r && r.datesIntervention) return String(r.datesIntervention).split(',').map(x => x.trim()).filter(Boolean).sort();
  return _rapMeta(r && r.description).dates || [];
}
// Rapport archivé manuellement : colonne booléenne d'abord, sinon ancien marqueur [ARCHIVE].
function _rapManualArchived(r) { return !!r && (r.archive === true || /\[ARCHIVE\]/.test(String(r.description || ''))); }
function _setRapArchive(rid, on) {
  const list = DB.rapports;
  const r = list.find(x => x.id === rid);
  if (!r) return;
  r.archive = !!on;                         // vraie colonne Supabase
  let d = String(r.description || '').replace(/\s*\[ARCHIVE\]/g, '');
  if (on) d += (d ? '\n' : '') + '[ARCHIVE]';   // double écriture de sécurité (marqueur)
  r.description = d;
  DB.rapports = list;
}
function archiveRapport(rid) {
  _setRapArchive(rid, true);
  renderRapports(); renderFactArchive(); renderBons && renderBons(); updateNavCounts();
  toast('📦 Rapport classé dans « Facturation archivée »', '#0f766e');
}
function _rDateRow(val) {
  const div = document.createElement('div');
  div.style.cssText = 'display:flex;gap:6px;align-items:center;';
  div.innerHTML = `<input class="form-input" type="date" data-r-date value="${val||''}" style="flex:1;" oninput="updatePDF()">
    <button type="button" class="btn btn-ghost btn-xs" style="color:#b00;" onclick="this.parentElement.remove();updatePDF()" title="Retirer cette date">✕</button>`;
  return div;
}
function rAddDate(val) { const w = $('r-dates-wrap'); if (w) { w.appendChild(_rDateRow(val||'')); } }
function rSetDates(dates) {
  const w = $('r-dates-wrap'); if (!w) return;
  w.innerHTML = '';
  (dates && dates.length ? dates : []).forEach(d => w.appendChild(_rDateRow(d)));
}
function rReadDates() {
  const w = $('r-dates-wrap'); if (!w) return [];
  return Array.from(w.querySelectorAll('[data-r-date]')).map(i => i.value.trim()).filter(Boolean).sort();
}

// ============================================================
// SAVE RAPPORT
// ============================================================
// Sécurité : avertit si on ferme/recharge l'app alors qu'un enregistrement vers
// Supabase n'est pas terminé (évite de perdre un rapport tout juste créé).
window.addEventListener('beforeunload', function (e) {
  if (DB._processing || (DB._pending && DB._pending.size > 0)) {
    e.preventDefault();
    e.returnValue = 'Une sauvegarde est en cours. Patiente une seconde avant de fermer pour ne rien perdre.';
    return e.returnValue;
  }
});

function saveRapport(statut) {
  const nuisibles = [];
  document.querySelectorAll('#tab-nuisibles input[type=checkbox]:checked').forEach(c => nuisibles.push(c.value));
  const traitement = [], traitementLabels = [];
  const tLabels = {'t-pulv':'Pulvérisation','t-vapeur':'Vapeur','t-thermique':'Thermique','t-injection':'Injection','t-appats':'Appâts/pièges','t-monitoring':'Monitoring','t-desinfect':'Désinfection','t-flocage':'Flocage','t-gel':'Gel','t-poudre':'Poudre','t-fumigation':'Fumigation','t-pose':'Pièges mécaniques','t-appatage':'Boîtes d\'appâtage sécurisées','t-rodenticide':'Rodenticides professionnels','t-racumin':'Racumin','t-talonwax':'Talonwax injection','t-gel-fl':"Application de gels professionnels — Fourmis Lasius",'t-gel-fe':"Application de gels professionnels — Fourmis emarginatus",'t-gel-ff':"Application de gels professionnels — Fourmis flavus",'t-gel-fp':"Application de gels professionnels — Fourmis pharaon",'t-gel-bg':"Application de gels professionnels — Blattes germanique",'t-gel-ba':"Application de gels professionnels — Blattes américaine",'t-gel-bo':"Application de gels professionnels — Blattes orientale",'t-gel-br':"Application de gels professionnels — Blattes rayées"};
  ['t-pulv','t-vapeur','t-thermique','t-injection','t-appats','t-monitoring','t-desinfect','t-flocage','t-gel','t-poudre','t-fumigation','t-pose','t-appatage','t-rodenticide','t-racumin','t-talonwax','t-gel-fl','t-gel-fe','t-gel-ff','t-gel-fp','t-gel-bg','t-gel-ba','t-gel-bo','t-gel-br'].forEach(id => { const el = $(id); if (el && el.checked) { traitement.push(id); traitementLabels.push(tLabels[id]); } });

  const clientId  = $('r-client').value;
  const client    = DB.clients.find(c => c.id === clientId);
  const clientNom = client ? client.nom : '';
  const r = {
    id: $('r-id').value, clientId, clientNom, clientEmail: $('r-email').value,
    date: $('r-date').value, tech: $('r-tech').value,
    contact: _composeRapContact(($('r-contact-role')||{}).value || '', $('r-contact').value), tel: $('r-tel').value, email: $('r-email').value,
    adresse: $('r-adresse').value, npa: $('r-npa').value, ville: $('r-ville').value,
    localisation: $('r-localisation').value, batiment: $('r-batiment').value, noint: $('r-noint').value,
    bonCommande: ($('r-bon-commande') ? $('r-bon-commande').value : ''),
    nuisibles, niveau: $('r-niveau').value,
    superficie: $('r-superficie').value, pieces: $('r-pieces').value, zones: $('r-zones').value,
    origine: $('r-origine').value, contraintes: $('r-contraintes').value,
    traitement, produits: JSON.parse(JSON.stringify(state.produits)),
    precautions: $('r-precautions').value, duree: $('r-duree').value, montant: $('r-montant').value,
    resultat: $('r-resultat').value, recommandations: $('r-recommandations').value,
    rdv: $('r-rdv').value, rdvHeure: ($('r-rdv-heure') ? $('r-rdv-heure').value : ''), garantie: $('r-garantie').value, statut,
  };
  // Locataire : on écrit dans les VRAIES colonnes Supabase (locataire_nom/tel/email/adresse)…
  const _loc = {
    nom: _lv('r-locataire'), tel: _lv('r-locataire-tel'),
    email: _lv('r-locataire-email'), adresse: _lv('r-locataire-adresse')
  };
  r.locataireNom = _loc.nom; r.locataireTel = _loc.tel;
  r.locataireEmail = _loc.email; r.locataireAdresse = _loc.adresse;
  // Passages + dates d'intervention → vraies colonnes Supabase
  r.nbPassages = ($('r-nb-passages') || {}).value || '';
  r.datesIntervention = rReadDates().join(',');
  // On conserve l'état « archivé » si le rapport l'était déjà
  const _prev = (DB.rapports || []).find(x => x.id === state.editingRapportId);
  const _wasArchived = _prev ? _rapManualArchived(_prev) : false;
  r.archive = _wasArchived;                  // vraie colonne booléenne
  // …et on conserve aussi le marqueur [LOC:] dans la description (double écriture de sécurité
  // pendant la transition — il est ignoré à l'affichage et dans le PDF).
  r.description = _composeRapDesc($('r-description').value, ($('r-nb-passages')||{}).value || '', rReadDates(), _loc, _wasArchived);
  const list = DB.rapports;
  const i = list.findIndex(x => x.id === state.editingRapportId);
  if (i >= 0) list[i] = r; else list.push(r);
  DB.rapports = list; state.editingRapportId = r.id;
  DB._notifyOnSync = DB._notifyOnSync || {};
  DB._notifyOnSync.rapports = '✓ Rapport enregistré dans le cloud';
  $('edit-id').textContent = r.id;

  // Rapport finalisé → le bon de commande lié passe automatiquement à « ✅ Terminé »
  // et est marqué « rapport fait ». Ainsi la chaîne bon → facture → facturation archivée
  // se reconnaît toute seule au moment d'archiver la facture payée.
  if (statut === 'Finalisé' && r.bonCommande) {
    const bons = DB.bons;
    const bon = bons.find(b => _factNorm(b.numero) === _factNorm(r.bonCommande));
    if (bon) {
      const stPrev = bon.statut || '';
      // On ne rétrograde pas un bon déjà « à facturer » ou déjà terminé.
      if (stPrev !== 'a-facturer' && stPrev !== 'termine') bon.statut = 'termine';
      bon.probleme = _bonAssembleProbleme(_bonProblemeClean(bon), _bonDatesInterv(bon), _bonAffecte(bon), _bonNote(bon), true, '', _bonColor(bon));
      DB.bons = bons;
    }
  }

  // Synchronise le prochain rendez-vous du rapport vers le planning/agenda.
  // Chaque rapport possède au plus une intervention liée (id stable "rdv-<idRapport>"),
  // ainsi un nouvel enregistrement met à jour la même entrée au lieu d'en créer une autre.
  const rdvIvId = 'rdv-' + r.id;
  let ivs = DB.intervs.filter(x => x.id !== rdvIvId);
  if (r.rdv) {
    ivs.push({
      id: rdvIvId,
      date: r.rdv,
      heure: r.rdvHeure || '08:00',
      clientId: r.clientId,
      clientNom: r.clientNom,
      adresse: (r.adresse || '') + (r.npa ? ' ' + r.npa : '') + (r.ville ? ' ' + r.ville : ''),
      nuisible: r.nuisibles.join(', '),
      tech: r.tech,
      statut: 'Planifiée',
      couleur: '#f4a623',
      notes: 'RDV rapport ' + r.id,
    });
  }
  DB.intervs = ivs;
  $('edit-status').className = 'badge ' + badgeCls(statut); $('edit-status').textContent = statut;

  if (statut === 'Envoyé') {
    toast('Envoi en cours...', '#f4a623');
    const produitsStr = state.produits.map(p => `${p.nom}${p.dosage ? ' — '+p.dosage : ''}${p.zone ? ' ('+p.zone+')' : ''}`).join(', ');
    const params = {
      rapport_id: r.id, client_nom: clientNom || '—', date: fmtDate(r.date),
      technicien: r.tech || '—',
      adresse: (r.adresse||'') + (r.npa?' '+r.npa:'') + (r.ville?' '+r.ville:''),
      superficie: (r.superficie ? r.superficie+' m²' : '—') + (r.pieces ? ' / '+r.pieces+' pièce(s)' : ''),
      noint: r.noint || '—', nuisibles: nuisibles.join(', ') || '—', niveau: r.niveau || '—',
      description: (r.description || '—').replace(/\*\*/g, ''), traitement: traitementLabels.join(', ') || '—',
      produits: produitsStr || '—', precautions: r.precautions || '—',
      resultat: r.resultat || '—', recommandations: (r.recommandations || '—').replace(/\*\*/g, ''),
      montant: r.montant ? r.montant + ' CHF' : '—',
      rdv: r.rdv ? fmtDate(r.rdv) : '—', garantie: r.garantie || '—',
      email: DERATEK_CONFIG.email.deratek, name: r.tech || 'DERATEK',
    };
    // ENVOI INTERNE UNIQUEMENT : on force le destinataire sur info@deratek.ch.
    // Aucun envoi au client / gérant pour le moment (désactivé volontairement).
    params.email = DERATEK_CONFIG.email.deratek;
    emailjs.send(DERATEK_CONFIG.emailjs.serviceId, DERATEK_CONFIG.emailjs.templateId, params)
      .then(() => {
        toast('Rapport envoyé à ' + DERATEK_CONFIG.email.deratek + ' ✓', '#2d9e6b');
        setTimeout(() => showScreen('rapports'), 1200);
      })
      .catch(err => {
        console.error('EmailJS error:', err);
        toast('Rapport sauvegardé — email échoué', '#f4a623');
        setTimeout(() => showScreen('rapports'), 1200);
      });
  } else {
    toast(statut === 'Brouillon' ? 'Brouillon sauvegardé ✓' : 'Rapport finalisé ✓', '#2d9e6b');
    if (statut === 'Finalisé') setTimeout(() => showScreen('rapports'), 800);
  }
}
// Enregistre le rapport en brouillon ET revient à la liste : on pourra le reprendre
// plus tard depuis la section "Reprendre plus tard". Sauvegardé dans Supabase + l'appli.
function saveRapportReprendre() {
  saveRapport('Brouillon');
  toast('Enregistré — à reprendre dans « Reprendre plus tard »', '#2d9e6b');
  setTimeout(() => showScreen('rapports'), 700);
}

// ============================================================
// PDF LIVE PREVIEW
// ============================================================
function updatePDF() {
  const clientId = $('r-client').value;
  const client = DB.clients.find(c => c.id === clientId);
  const clientNom = client ? client.nom : '—';
  const nuisibles = [];
  document.querySelectorAll('#tab-nuisibles input[type=checkbox]:checked').forEach(c => nuisibles.push(c.value));
  const traitement = [];
  const tL = {'t-pulv':'Pulvérisation','t-vapeur':'Vapeur','t-thermique':'Thermique','t-injection':'Injection','t-appats':'Appâts','t-monitoring':'Monitoring','t-desinfect':'Désinfection','t-flocage':'Flocage','t-gel':'Gel','t-poudre':'Poudre','t-fumigation':'Fumigation','t-pose':'Pièges','t-appatage':'Boîtes d\'appâtage sécurisées','t-rodenticide':'Rodenticides professionnels','t-racumin':'Racumin','t-talonwax':'Talonwax injection','t-gel-fl':"Application de gels professionnels — Fourmis Lasius",'t-gel-fe':"Application de gels professionnels — Fourmis emarginatus",'t-gel-ff':"Application de gels professionnels — Fourmis flavus",'t-gel-fp':"Application de gels professionnels — Fourmis pharaon",'t-gel-bg':"Application de gels professionnels — Blattes germanique",'t-gel-ba':"Application de gels professionnels — Blattes américaine",'t-gel-bo':"Application de gels professionnels — Blattes orientale",'t-gel-br':"Application de gels professionnels — Blattes rayées"};
  ['t-pulv','t-vapeur','t-thermique','t-injection','t-appats','t-monitoring','t-desinfect','t-flocage','t-gel','t-poudre','t-fumigation','t-pose','t-appatage','t-rodenticide','t-racumin','t-talonwax','t-gel-fl','t-gel-fe','t-gel-ff','t-gel-fp','t-gel-bg','t-gel-ba','t-gel-bo','t-gel-br'].forEach(id => { const el = $(id); if (el && el.checked) traitement.push(tL[id]); });
  const st = (id, val) => { const el = $(id); if (el) el.textContent = val || '—'; };
  st('pdf-id',    $('r-id').value);
  st('pdf-date',  fmtDate($('r-date').value));
  st('pdf-tech',  $('r-tech').value);
  st('pdf-client', clientNom === '-- Sélectionner un client --' ? '—' : clientNom);
  const adr = $('r-adresse').value, npa = $('r-npa').value, ville = $('r-ville').value;
  st('pdf-adresse', adr ? adr + (npa?' '+npa:'') + (ville?' '+ville:'') : '—');
  const pn = $('pdf-nuisibles');
  if (pn) pn.innerHTML = nuisibles.length
    ? nuisibles.map(n => `<span style="background:var(--red);color:#fff;font-size:8px;padding:1px 6px;border-radius:3px;display:inline-block;margin:1px;">${n}</span>`).join('')
    : '<span style="color:var(--g400);font-size:10px;">Aucun</span>';
  const sup = $('r-superficie').value, pie = $('r-pieces').value;
  st('pdf-superficie', (sup ? sup+'m²' : '—') + (pie ? ' / '+pie+' pièce(s)' : ''));
  st('pdf-niveau',      $('r-niveau').value);
  const desc = ($('r-description').value || '—').replace(/\*\*/g, '');
  st('pdf-description', desc.substring(0,260) + (desc.length > 260 ? '…' : ''));
  st('pdf-traitement',  traitement.join(', ') || '—');
  const montant = $('r-montant').value;
  st('pdf-montant', montant ? montant+' CHF' : '—');
  st('pdf-resultat', $('r-resultat').value);
}

// ============================================================
// GRAS (texte enrichi simple via marqueurs **…**)
// Le gras est stocké dans le texte sous forme **gras** (compatible Supabase,
// aucune colonne ajoutée) et rendu en gras dans le PDF du rapport.
// ============================================================
function toggleBold(fieldId) {
  const el = $(fieldId); if (!el) return;
  const s = el.selectionStart, e = el.selectionEnd, v = el.value;
  if (s === e) {
    // Pas de sélection : insère **​** et place le curseur au milieu
    el.value = v.slice(0, s) + '****' + v.slice(e);
    el.selectionStart = el.selectionEnd = s + 2;
  } else {
    let sel = v.slice(s, e);
    if (/^\*\*[\s\S]*\*\*$/.test(sel)) {
      // Déjà en gras → on retire le gras
      sel = sel.slice(2, -2);
      el.value = v.slice(0, s) + sel + v.slice(e);
      el.selectionStart = s; el.selectionEnd = s + sel.length;
    } else {
      el.value = v.slice(0, s) + '**' + sel + '**' + v.slice(e);
      el.selectionStart = s + 2; el.selectionEnd = e + 2;
    }
  }
  el.focus();
  el.dispatchEvent(new Event('input'));
}
function boldShortcut(ev, el) {
  if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'b' || ev.key === 'B')) {
    ev.preventDefault();
    toggleBold(el.id);
  }
}
// Convertit du HTML collé (Word, web, …) en texte avec marqueurs **gras**
function _htmlToBoldText(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  let out = "";
  const isBold = node => {
    const tag = (node.tagName || "").toLowerCase();
    if (tag === "b" || tag === "strong") return true;
    const fw = (node.style && node.style.fontWeight) || "";
    if (fw === "bold" || fw === "bolder") return true;
    const n = parseInt(fw, 10);
    return !isNaN(n) && n >= 600;
  };
  // Balises dont le CONTENU ne doit jamais devenir du texte (sinon le CSS du presse-papiers
  // macOS — p.p1{...}, span.s1{...} — se retrouve collé dans la description).
  const SKIP = /^(style|script|head|title|meta|link|noscript|colgroup|col)$/;
  const walk = (node, bold) => {
    node.childNodes.forEach(ch => {
      if (ch.nodeType === 3) {
        const t = ch.nodeValue.replace(/\s+/g, " ");
        if (!t) return;
        if (bold) {
          // On garde les espaces de début/fin À L'EXTÉRIEUR des marqueurs **…**
          const lead = (t.match(/^\s*/) || [""])[0];
          const trail = (t.match(/\s*$/) || [""])[0];
          const core = t.slice(lead.length, t.length - trail.length);
          out += core ? (lead + "**" + core + "**" + trail) : t;
        } else out += t;
      } else if (ch.nodeType === 1) {
        const tag = ch.tagName.toLowerCase();
        if (SKIP.test(tag)) return;
        const b = bold || isBold(ch);
        walk(ch, b);
        if (/^(p|div|br|li|tr|h[1-6])$/.test(tag)) out += "\n";
      }
    });
  };
  walk(tpl.content, false);
  out = out
    .replace(/\*\*(\s*)\*\*/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out;
}
function pasteKeepBold(ev, el) {
  const cd = ev.clipboardData || window.clipboardData;
  if (!cd) return;
  const html = cd.getData('text/html');
  if (!html) return; // collage texte simple : comportement par défaut
  ev.preventDefault();
  const md = _htmlToBoldText(html);
  const s = el.selectionStart, e = el.selectionEnd, v = el.value;
  el.value = v.slice(0, s) + md + v.slice(e);
  el.selectionStart = el.selectionEnd = s + md.length;
  el.dispatchEvent(new Event('input'));
}

// ============================================================
// TABS
// ============================================================
function showTab(name) {
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const content = $(`tab-${name}`); if (content) content.classList.add('active');
  const names = ['infos','nuisibles','observations','traitement','photos','conclusion'];
  const idx = names.indexOf(name);
  const tabs = document.querySelectorAll('.tab');
  if (tabs[idx]) tabs[idx].classList.add('active');
}

// ============================================================
// PRODUITS
// ============================================================
function renderProduits() {
  const el = $('produits-list'); if (!el) return;
  el.innerHTML = state.produits.length
    ? state.produits.map((p,i) => `
      <div style="display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:8px;margin-bottom:8px;align-items:center;">
        <input class="form-input" value="${p.nom||''}" placeholder="Produit" oninput="state.produits[${i}].nom=this.value"/>
        <input class="form-input" value="${p.dosage||''}" placeholder="Dosage" oninput="state.produits[${i}].dosage=this.value"/>
        <input class="form-input" value="${p.zone||''}" placeholder="Zone" oninput="state.produits[${i}].zone=this.value"/>
        <button class="btn btn-ghost btn-xs" data-idx="${i}" onclick="deleteProduit(this)">✕</button>
      </div>`).join('')
    : '<div style="font-size:12px;color:var(--g400);padding:8px 0;">Aucun produit ajouté</div>';
}
function addProduit() {
  state.produits.push({ nom:'', dosage:'', zone:'' });
  renderProduits();
}
function deleteProduit(el) {
  state.produits.splice(parseInt(el.dataset.idx), 1);
  renderProduits();
}

// ============================================================
// PHOTOS
// ============================================================
function resetPhotoGrid() {
  const labels = ['Avant 1','Avant 2','Pendant','Après 1','Après 2','Autre'];
  for (let i = 0; i < 6; i++) {
    const slot = $(`photo-${i}`); if (!slot) continue;
    if (state.photos[i]) {
      slot.innerHTML = `<img src="${state.photos[i]}" alt="Photo ${i+1}"><div class="photo-del" data-idx="${i}" onclick="event.stopPropagation();deletePhoto(this)">✕</div>`;
    } else {
      slot.innerHTML = `<div class="photo-slot-icon">📷</div><span>${labels[i]}</span>`;
    }
  }
}
function addPhoto(slot)   { state.currentPhotoSlot = slot; $('photo-input').click(); }
function deletePhoto(el)  { state.photos[parseInt(el.dataset.idx)] = null; resetPhotoGrid(); }
function onPhotoSelected(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => { state.photos[state.currentPhotoSlot] = ev.target.result; resetPhotoGrid(); e.target.value = ''; };
  reader.readAsDataURL(file);
}

// ============================================================
// SIGNATURE
// ============================================================
function initSig() {
  const canvas = $('sig-locataire'); if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#1a2744'; ctx.lineWidth = 2; ctx.lineCap = 'round';
  const gp = e => { const r = canvas.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return { x: (t.clientX-r.left)*(canvas.width/r.width), y: (t.clientY-r.top)*(canvas.height/r.height) }; };
  canvas.addEventListener('mousedown',  e => { state.sigDrawing = true; const p = gp(e); ctx.beginPath(); ctx.moveTo(p.x,p.y); });
  canvas.addEventListener('mousemove',  e => { if (!state.sigDrawing) return; const p = gp(e); ctx.lineTo(p.x,p.y); ctx.stroke(); });
  canvas.addEventListener('mouseup',    () => state.sigDrawing = false);
  canvas.addEventListener('mouseleave', () => state.sigDrawing = false);
  canvas.addEventListener('touchstart', e => { e.preventDefault(); state.sigDrawing = true; const p = gp(e); ctx.beginPath(); ctx.moveTo(p.x,p.y); }, { passive:false });
  canvas.addEventListener('touchmove',  e => { e.preventDefault(); if (!state.sigDrawing) return; const p = gp(e); ctx.lineTo(p.x,p.y); ctx.stroke(); }, { passive:false });
  canvas.addEventListener('touchend',   () => state.sigDrawing = false);
}
function clearSig() { const c = $('sig-locataire'); if (c) c.getContext('2d').clearRect(0,0,c.width,c.height); }

// ============================================================
// PRINT PDF
// ============================================================
function printRapport() {
  window.print();
}

// ============================================================
// TECHNICIENS
// ============================================================
// --- Titres des techniciens (stockés dans le nom via marqueur [TITRE:…]) ---
const TECH_TITRES = ['Technicien', 'Responsable', "Chef d'équipe", 'Manager', 'Gérant', 'Directeur'];
function _techNom(t)   { return String(t || '').replace(/\s*\[TITRE:[^\]]*\]/, '').trim(); }
function _techTitre(t) { const m = String(t || '').match(/\[TITRE:([^\]]*)\]/); return m ? m[1] : ''; }
function _composeTech(nom, titre) { const n = String(nom || '').trim(); return (titre && titre.trim()) ? n + '[TITRE:' + titre.trim() + ']' : n; }
// Titre d'un technicien à partir de son nom (recherche dans DB.techs)
function _techTitreOf(name) { const n = _techNom(name).toLowerCase(); const t = (DB.techs || []).find(x => _techNom(x).toLowerCase() === n); return t ? _techTitre(t) : ''; }
function setTechTitre(i, titre) {
  const list = DB.techs; if (!list[i]) return;
  list[i] = _composeTech(_techNom(list[i]), titre);
  DB.techs = list;
  renderTechList();
  if ($('r-tech')) populateTechSelect($('r-tech'), $('r-tech').value);
  if (typeof updatePDF === 'function') updatePDF();
}
function renderTechList() {
  const el = $('tech-list'); if (!el) return;
  const techs = DB.techs;
  el.innerHTML = techs.length ? techs.map((t,i) => {
    const nom = _techNom(t), titre = _techTitre(t);
    const opts = '<option value="">— Titre —</option>' + TECH_TITRES.map(x => `<option value="${x}" ${x === titre ? 'selected' : ''}>${x}</option>`).join('');
    return `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--g50);border-radius:7px;margin-bottom:6px;">
      <div class="av av-sm" style="background:var(--navy);">${initials(nom)}</div>
      <span style="flex:1;font-size:13px;font-weight:500;">${nom}</span>
      <select onchange="setTechTitre(${i}, this.value)" title="Titre / fonction" style="font-size:12px;padding:4px 6px;border-radius:6px;border:1px solid #d1d5db;background:#fff;">${opts}</select>
      <button class="btn btn-ghost btn-xs" data-idx="${i}" onclick="deleteTech(this)">🗑</button>
    </div>`;
  }).join('')
  : '<div style="color:var(--g400);font-size:12px;">Aucun technicien.</div>';
}
function openTechModal() { renderTechList(); openModal('modal-tech'); }
function addTech() {
  const inp = $('tech-new-name'); const name = inp.value.trim();
  if (!name) { toast('Saisissez un nom', '#e63946'); return; }
  const list = DB.techs;
  if (list.some(x => _techNom(x).toLowerCase() === name.toLowerCase())) { toast('Existe déjà', '#f4a623'); return; }
  list.push(name); DB.techs = list; inp.value = '';
  renderTechList();
  if ($('r-tech')) populateTechSelect($('r-tech'), $('r-tech').value);
  toast('Technicien ajouté ✓', '#2d9e6b');
}
function deleteTech(el) {
  const list = DB.techs; list.splice(parseInt(el.dataset.idx), 1); DB.techs = list;
  renderTechList();
  if ($('r-tech')) populateTechSelect($('r-tech'), $('r-tech').value);
  toast('Technicien supprimé', '#e63946');
}

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  initSig();

  // Logo de connexion en version foncée (le PNG blanc d'origine est invisible sur fond blanc)
  if (typeof LOGO_B64 !== 'undefined') {
    const loginLogo = $('login-logo-img');
    if (loginLogo) loginLogo.src = LOGO_B64;
  }

  // Init Supabase (lib chargée via CDN)
  initSupabase();

  // Touche Entrée sur les champs de login
  ['login-email', 'login-pwd'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  });

  // Auto-login si une session Supabase existe déjà
  if (sb) {
    try {
      const { data } = await sb.auth.getSession();
      if (data && data.session) {
        await DB.loadAll();
        $('login-screen').style.display = 'none';
        $('app').style.display = 'block';
        if (typeof emailjs !== 'undefined' && emailjs.init) {
          try { emailjs.init(DERATEK_CONFIG.emailjs.publicKey); } catch (e) {}
        }
        renderDashboard();
        setTimeout(_autoBackupCheck, 1500);
      }
    } catch (err) { console.warn('Auto-login', err); }
  }
});

// ============================================================
// CORRECTION IA DES TEXTES
// ============================================================
async function correctWithAI(fieldId, type) {
  const el = document.getElementById(fieldId);
  if (!el) return;
  const text = el.value.trim();
  if (!text) { toast('Écrivez quelque chose d\'abord !', '#f4a623'); return; }

  const btn = document.getElementById('ai-btn-' + type);
  if (btn) { btn.textContent = '⏳ Correction...'; btn.disabled = true; }

  const basePrompt = `Tu es un correcteur expert de la langue française. Tu travailles pour DERATEK, une entreprise suisse de lutte anti-nuisibles. Tu reçois des textes saisis rapidement par des techniciens sur le terrain — ils contiennent des fautes, des espaces mal placés, des mots mal écrits, des majuscules partout, des phrases cassées.

TON RÔLE : réécrire entièrement le texte en français parfait, professionnel et fluide.

CORRECTIONS OBLIGATOIRES — tu ne peux en manquer aucune :
1. ORTHOGRAPHE : corrige chaque mot mal orthographié (ex: "trouvées" au lieu de "trouvé", "avons" au lieu de "avont")
2. ACCENTS : ajoute tous les accents manquants sans exception (é, è, ê, ë, à, â, ù, û, î, ï, ô, ç)
3. ESPACES : supprime les espaces avant virgule/point (ex: "lit ," → "lit,"), ajoute les espaces manquants après ponctuation
4. MAJUSCULES : une seule majuscule en début de phrase et après un point. Tout le reste en minuscules.
5. PONCTUATION : ajoute les virgules, points-virgules et points là où ils manquent. Termine toujours par un point.
6. GRAMMAIRE : corrige les accords (genre, nombre), les conjugaisons, les temps verbaux
7. SYNTAXE : reformule les phrases maladroites ou incomplètes pour qu'elles soient claires et naturelles
8. RÉPÉTITIONS : supprime les mots ou tournures répétés inutilement
9. STYLE : utilise un vocabulaire professionnel et technique du secteur dératisation / désinsectisation

EXEMPLES de corrections attendues :
- "a la suite de ce traitements contre les punaises de lit , nous avons remarqué que nous avons trouvées des centaines de punaises de lit dans le cadre du lit" → "À la suite de ce traitement contre les punaises de lit, nous avons constaté la présence de plusieurs centaines de punaises dans le cadre du lit."
- "gupe trouver dans grenier" → "Des guêpes ont été découvertes dans les combles."
- "pas de probleme acces facile traitement effectuer" → "Pas de contrainte particulière. L'accès est facile et le traitement a été effectué sans difficulté."

ABSOLUMENT INTERDIT :
- Ajouter une introduction, explication ou commentaire
- Mettre des guillemets autour du texte
- Écrire "Voici le texte corrigé :" ou toute phrase similaire
- Inventer des informations non présentes dans le texte original

Réponds UNIQUEMENT avec le texte réécrit et corrigé, rien d'autre.`;

  const prompts = {
    description:     basePrompt + "\n\nContexte : description d'une intervention anti-nuisibles sur site.",
    origine:         basePrompt + "\n\nContexte : origine probable de l'infestation.",
    contraintes:     basePrompt + "\n\nContexte : contraintes et informations utiles pour l'intervention.",
    precautions:     basePrompt + "\n\nContexte : précautions post-traitement à communiquer au client.",
    recommandations: basePrompt + "\n\nContexte : recommandations et suivi après intervention.",
  };
  const systemPrompt = prompts[type] || basePrompt;

  try {
    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + DERATEK_CONFIG.mistral.apiKey
      },
      body: JSON.stringify({
        model: DERATEK_CONFIG.mistral.model,
        max_tokens: 600,
        temperature: 0.1,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error && err.error.message || 'API ' + response.status);
    }
    const data = await response.json();
    const corrected = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;

    if (corrected) {
      showAIModal(fieldId, type, text, corrected.trim());
    } else {
      toast('Réponse IA vide', '#e63946');
    }
  } catch(e) {
    console.error('AI error:', e);
    toast('Erreur IA : ' + e.message, '#e63946');
    const correctedLocal = localCorrect(text);
    showAIModal(fieldId, type, text, correctedLocal);
  } finally {
    if (btn) { btn.textContent = '✨ Corriger'; btn.disabled = false; }
  }
}

// Correction locale de base si l'IA n'est pas disponible
function localCorrect(text) {
  let t = text.trim();
  // Majuscule en début
  t = t.charAt(0).toUpperCase() + t.slice(1);
  // Point final
  if (t.length > 0 && !'.!?'.includes(t.slice(-1))) t += '.';
  // Corrections communes
  const fixes = [
    [/il\s+ont/gi, 'ils ont'], [/ca/gi, 'cela'], [/pas de/gi, 'aucun'],
    [/gupe/gi, 'guêpe'], [/gu[eè]pe/gi, 'guêpe'], [/frelon/gi, 'frelon'],
    [/punaiss/gi, 'punaises'], [/caisson/gi, 'caisson'], [/intervenion/gi, 'intervention'],
    [/professionel/gi, 'professionnel'], [/appartement/gi, 'appartement'],
    [/([a-zA-Z]+)  +([a-zA-Z]+)/g, '$1 $2'], // double espaces
  ];
  fixes.forEach(([pattern, replacement]) => { t = t.replace(pattern, replacement); });
  return t;
}

function showAIModal(fieldId, type, original, corrected) {
  // Créer modal dynamique
  let modal = document.getElementById('modal-ai');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-ai';
    modal.className = 'modal-bg';
    modal.innerHTML = `
      <div class="modal" style="max-width:640px;">
        <div class="modal-hd">
          <span class="modal-title">✨ Correction IA</span>
          <button class="btn btn-ghost btn-sm" onclick="closeModal('modal-ai')">✕</button>
        </div>
        <div class="modal-body" id="ai-modal-body"></div>
        <div class="modal-ft">
          <button class="btn btn-ghost" onclick="closeModal('modal-ai')">Annuler</button>
          <button class="btn btn-navy" id="ai-apply-btn">✓ Appliquer la correction</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }

  document.getElementById('ai-modal-body').innerHTML = `
    <div style="margin-bottom:14px;">
      <div style="font-size:11px;font-weight:700;color:var(--g400);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Texte original</div>
      <div style="background:#fff0f0;border:1px solid #fecaca;border-radius:8px;padding:12px;font-size:13px;color:#4b5563;line-height:1.6;">${original}</div>
    </div>
    <div>
      <div style="font-size:11px;font-weight:700;color:var(--g400);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">✨ Texte corrigé par l'IA</div>
      <div style="background:#e8f7f0;border:1px solid #6ee7b7;border-radius:8px;padding:12px;font-size:13px;color:#065f46;line-height:1.6;">${corrected}</div>
    </div>`;

  document.getElementById('ai-apply-btn').onclick = () => {
    const el = document.getElementById(fieldId);
    if (el) {
      el.value = corrected;
      if (fieldId === 'r-description' || fieldId === 'r-recommandations') updatePDF();
    }
    closeModal('modal-ai');
    toast('Correction appliquée ✓', '#2d9e6b');
  };

  openModal('modal-ai');
}

// ============================================================
// Ajustement automatique des barres fixes (header + actions + étapes)
// Calcule les positions réelles pour que la barre d'étapes du rapport
// reste collée juste sous le header, quelle que soit sa hauteur.
// ============================================================
function adjustStickyOffsets() {
  const nav = document.querySelector('.topnav');
  const navH = nav ? nav.getBoundingClientRect().height : 220;
  // Barre d'actions du rapport (Retour / PDF / Sauvegarder...)
  const pageHd = document.querySelector('#screen-rapport-edit .page-hd, .rapport-shell');
  const actionBar = document.querySelector('.page-hd[style*="sticky"]');
  if (actionBar) actionBar.style.top = navH + 'px';
  const actionH = actionBar ? actionBar.getBoundingClientRect().height : 60;
  const tabs = document.querySelector('.tabs');
  if (tabs) tabs.style.top = (navH + actionH) + 'px';
  // Écran Bons : on borne sa hauteur sous la barre de nav pour que SEULE la liste
  // défile à l'intérieur (.page-body) et que l'en-tête (boutons Actifs/Terminés)
  // reste figé au-dessus.
  const screenBons = document.getElementById('screen-bons');
  if (screenBons) {
    screenBons.style.height = (window.innerHeight - navH) + 'px';
    screenBons.style.minHeight = '0';
  }
}
window.addEventListener('load', adjustStickyOffsets);
window.addEventListener('resize', adjustStickyOffsets);
// Réajuste aussi quand on ouvre l'éditeur de rapport
document.addEventListener('click', () => setTimeout(adjustStickyOffsets, 50));

// ============================================================
// ONGLET BONS DE TRAVAUX — lecture PDF + extraction IA (Mistral)
// Livraison 1 : lire le PDF, extraire les infos, afficher un récap.
// ============================================================

// Charge pdf.js (Mozilla) depuis le CDN, une seule fois.
let _pdfjsLoading = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (_pdfjsLoading) return _pdfjsLoading;
  _pdfjsLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload = () => {
      try {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      } catch (e) {}
      resolve(window.pdfjsLib);
    };
    s.onerror = () => reject(new Error('Impossible de charger le lecteur PDF (vérifiez votre connexion Internet).'));
    document.head.appendChild(s);
  });
  return _pdfjsLoading;
}

// Extrait tout le texte d'un PDF (objet File).
async function bonExtractText(file) {
  const pdfjsLib = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let texte = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    texte += content.items.map(i => i.str).join(' ') + '\n';
  }
  return texte.trim();
}

// Rend les pages d'un PDF (objet File) en images JPEG (pour les PDF scannés → OCR)
async function bonRenderToImages(file) {
  const pdfjsLib = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const imgs = [];
  const n = Math.min(pdf.numPages, 3);
  for (let p = 1; p <= n; p++) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 2 });
    const cv = document.createElement('canvas');
    cv.width = vp.width; cv.height = vp.height;
    await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    imgs.push(cv.toDataURL('image/jpeg', 0.85));
  }
  return imgs;
}
// OCR par l'IA (Mistral vision) : transcrit le texte d'un bon scanné depuis ses images
async function bonOcrImages(images) {
  if (!(DERATEK_CONFIG && DERATEK_CONFIG.mistral && DERATEK_CONFIG.mistral.apiKey)) throw new Error('Clé Mistral non configurée');
  const content = [{ type: 'text', text: 'Transcris INTÉGRALEMENT et fidèlement tout le texte visible de ce bon de travaux scanné (toutes les pages fournies), en conservant les libellés et leurs valeurs (gérance, n° de bon, immeuble/adresse, locataire, téléphones, problème…). Réponds uniquement par le texte brut, sans commentaire.' }];
  images.forEach(d => content.push({ type: 'image_url', image_url: d }));
  const resp = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DERATEK_CONFIG.mistral.apiKey },
    body: JSON.stringify({ model: 'pixtral-12b-2409', temperature: 0, max_tokens: 2000, messages: [{ role: 'user', content }] })
  });
  if (!resp.ok) { let m = 'API ' + resp.status; try { const e = await resp.json(); m = (e.error && e.error.message) || m; } catch (e) {} throw new Error('OCR : ' + m); }
  const data = await resp.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

// Gestion du glisser-déposer
function bonHandleDrop(e) {
  e.preventDefault();
  const dz = document.getElementById('bon-dropzone');
  if (dz) dz.classList.remove('drag');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) bonProcessFile(f);
}
function bonHandleInput(e) {
  const f = e.target.files && e.target.files[0];
  if (f) bonProcessFile(f);
}

// Référence au fichier PDF en cours de traitement (pour l'uploader à la validation)
let _pendingBonPdf = null;
let _pendingBonDates = null;   // dates d'intervention à reporter dans un bon manuel (ex. depuis une fiche client)

// Traite le PDF : extraction texte -> IA -> récap
async function bonProcessFile(file) {
  const status = $('bon-status');
  const confirm = $('bon-confirm');
  if (confirm) { confirm.style.display = 'none'; confirm.innerHTML = ''; }
  if (file.type !== 'application/pdf') { toast('Merci de déposer un fichier PDF', '#e63946'); return; }

  // Mémorise le fichier pour l'upload à la validation
  _pendingBonPdf = file;
  _pendingBonDates = null;

  const setStatus = (msg) => { if (status) { status.style.display = 'block'; status.innerHTML = msg; } };
  try {
    setStatus('⏳ Lecture du PDF en cours…');
    let texte = await bonExtractText(file);
    if (!texte || texte.length < 20) {
      // PDF scanné (sans texte) → OCR par l'IA depuis les images des pages
      setStatus('🔍 PDF scanné — lecture OCR par l\'IA…');
      let ocrTexte = '';
      try {
        const imgs = await bonRenderToImages(file);
        ocrTexte = await bonOcrImages(imgs);
      } catch (e) { console.warn('OCR bon', e); }
      if (!ocrTexte || ocrTexte.trim().length < 20) {
        setStatus('');
        toast('PDF scanné illisible par l\'OCR. Réessaie avec un scan plus net, ou saisis le bon à la main (« + Bon manuel »).', '#e63946');
        return;
      }
      texte = ocrTexte;
    }
    setStatus('🤖 Analyse intelligente du bon par l\'IA…');
    const infos = _normalizeBonInfos(await bonExtractInfosIA(texte));
    setStatus('');
    bonShowConfirm(infos, file.name);
  } catch (err) {
    setStatus('');
    console.error('Bon error:', err);
    toast('Erreur : ' + err.message, '#e63946');
  }
}

// Normalise les infos extraites d'un bon : sur les bons (Naef, etc.), la ligne « Immeuble »
// est l'ADRESSE D'INTERVENTION (= adresse du client/locataire, rue + NPA + ville).
// La ligne « Chez : … / Appartement … étage … » est le nom du locataire + une description
// du logement, qui ne doit JAMAIS servir d'adresse postale.
function _normalizeBonInfos(infos) {
  if (!infos) return infos;
  const isLogement = s => {
    s = String(s || '');
    if (!s.trim()) return false;
    const hasNpa = /\b\d{4}\b/.test(s);                       // un vrai NPA suisse
    const looksRoom = /appart|appt|étage|etage|pi[eè]ces?|\bpces?\b|studio|\brez\b|comble|^\s*n[°o]|\sn[°o]/i.test(s);
    return looksRoom && !hasNpa;
  };
  const imm = String(infos.immeuble || '').trim();
  // L'adresse du locataire = l'adresse de l'immeuble (rue d'intervention).
  if (imm && (!String(infos.locataire_adresse || '').trim() || isLogement(infos.locataire_adresse))) {
    infos.locataire_adresse = imm;
  }
  return infos;
}

// Upload du PDF dans Supabase Storage. Retourne le chemin stocké (ou '' en cas d'échec)
async function _uploadBonPdf(bonId, file) {
  if (!sb || !file) return '';
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return '';
    const userId = session.user.id;
    const safeName = file.name.replace(/[^\w.-]+/g, '_');
    const path = `${userId}/${bonId}-${safeName}`;
    const { error } = await sb.storage.from('bons-pdfs').upload(path, file, {
      contentType: 'application/pdf',
      upsert: true
    });
    if (error) { console.warn('Upload PDF', error); toast('PDF non uploadé : ' + error.message, '#e63946'); return ''; }
    return path;
  } catch (e) {
    console.warn('Upload PDF exception', e);
    return '';
  }
}

// Génère une URL signée (1h) et ouvre le PDF dans un nouvel onglet
async function viewBonPdf(bonId) {
  const bon = (DB.bons || []).find(b => b.id === bonId);
  if (!bon || !bon.pdfPath) { toast('Aucun PDF associé à ce bon', '#e63946'); return; }
  if (!sb) { toast('Connexion Supabase indisponible', '#e63946'); return; }
  try {
    const { data, error } = await sb.storage.from('bons-pdfs').createSignedUrl(bon.pdfPath, 3600);
    if (error || !data || !data.signedUrl) { toast('Erreur génération du lien : ' + (error?.message||'?'), '#e63946'); return; }
    window.open(data.signedUrl, '_blank');
  } catch (e) {
    toast('Erreur : ' + e.message, '#e63946');
  }
}

// --- Aperçu du PDF d'un bon au survol (sans cliquer) ---
let _bonPdfUrlCache = {};
let _bonPdfHoverTimer = null;
async function bonPdfPreview(bonId, el) {
  clearTimeout(_bonPdfHoverTimer);
  _bonPdfHoverTimer = setTimeout(async () => {
    const bon = (DB.bons || []).find(b => b.id === bonId);
    if (!bon || !bon.pdfPath || !sb) return;
    let url = _bonPdfUrlCache[bonId];
    if (!url) {
      try {
        const { data, error } = await sb.storage.from('bons-pdfs').createSignedUrl(bon.pdfPath, 3600);
        if (error || !data || !data.signedUrl) return;
        url = data.signedUrl; _bonPdfUrlCache[bonId] = url;
      } catch (e) { return; }
    }
    _showPdfHoverPreview(url, el);
  }, 250);
}
// Aperçu au survol de la FACTURE (générée à la volée en PDF, mise en cache par id)
let _factPdfUrlCache = {};
function factPdfPreview(id, el) {
  clearTimeout(_bonPdfHoverTimer);
  _bonPdfHoverTimer = setTimeout(() => {
    let url = _factPdfUrlCache[id];
    if (!url) {
      try { url = downloadDocPDF(id, 'blob'); } catch (e) { return; }
      if (!url) return;
      _factPdfUrlCache[id] = url;
    }
    _showPdfHoverPreview(url, el);
  }, 250);
}
// Aperçu au survol du RAPPORT (reconstruit depuis l'enregistrement puis généré en PDF)
let _rapPdfUrlCache = {};
function _rapportObjForPdf(r) {
  const meta = _rapMeta(r.description || '');
  const loc = _rapLoc(r);
  return {
    id: r.id, clientNom: r.clientNom || '', clientEmail: r.email || '',
    clientAdresse: (() => { const c = r.clientId ? (DB.clients||[]).find(x => x.id === r.clientId) : null; return c ? ((c.adresse||'') + (c.npa?' '+c.npa:'') + (c.ville?' '+c.ville:'')).trim() : ''; })(),
    date: r.date || '', tech: r.tech || '',
    contact: _rapContactNom(r.contact || ''), contactRole: _rapContactRole(r.contact || '') || '',
    tel: r.tel || '', email: r.email || '',
    adresse: r.adresse || '', npa: r.npa || '', ville: r.ville || '',
    localisation: r.localisation || '', batiment: r.batiment || '', noint: r.noint || '',
    bonCommande: r.bonCommande || '',
    locataire: loc.nom || '', locataireTel: loc.tel || '', locataireEmail: loc.email || '', locataireAdresse: loc.adresse || '',
    showPrix: true, showDuree: true, showRdv: true, showGarantie: true, showGarantieNote: true, showPrecautions: true,
    volume: '', photoComments: ['', '', '', '', '', ''], materiels: [], materielComment: '',
    garantieNote: '', showSigClient: false, sigLocataire: '',
    nuisibles: r.nuisibles || [], description: meta.descClean || r.description || '',
    nbPassages: _rapNbPassages(r), datesInterv: _rapDates(r),
    niveau: r.niveau || '', superficie: r.superficie || '', pieces: r.pieces || '', zones: r.zones || '',
    origine: r.origine || '', contraintes: r.contraintes || '',
    traitement: r.traitement || [], produits: r.produits || [],
    precautions: r.precautions || '', duree: r.duree || '', montant: r.montant || '',
    resultat: r.resultat || '', recommandations: r.recommandations || '',
    rdv: r.rdv || '', rdvHeure: r.rdvHeure || '', garantie: r.garantie || '',
    photos: r.photos || [],
  };
}
function rapPdfPreview(rid, el) {
  clearTimeout(_bonPdfHoverTimer);
  _bonPdfHoverTimer = setTimeout(() => {
    let url = _rapPdfUrlCache[rid];
    if (!url) {
      try {
        const r = (DB.rapports || []).find(x => x.id === rid);
        if (!r || typeof generatePDF !== 'function') return;
        const doc = generatePDF(_rapportObjForPdf(r));
        if (!doc) return;
        url = doc.output('bloburl');
      } catch (e) { return; }
      _rapPdfUrlCache[rid] = url;
    }
    _showPdfHoverPreview(url, el);
  }, 250);
}
function bonPdfPreviewHide() {
  clearTimeout(_bonPdfHoverTimer);
  // petit délai pour permettre de déplacer la souris sur l'aperçu
  setTimeout(() => {
    const p = document.getElementById('pdf-hover-preview');
    if (p && !p.matches(':hover')) p.style.display = 'none';
  }, 180);
}
function _showPdfHoverPreview(url, el) {
  let p = document.getElementById('pdf-hover-preview');
  if (!p) {
    p = document.createElement('div');
    p.id = 'pdf-hover-preview';
    p.style.cssText = 'position:fixed;z-index:99999;width:540px;height:720px;max-height:88vh;background:#fff;border:2px solid #0d1b3e;border-radius:8px;box-shadow:0 10px 34px rgba(0,0,0,.35);overflow:hidden;display:none;';
    p.innerHTML = '<div style="font-size:11px;font-weight:700;color:#0d1b3e;padding:4px 8px;background:#eef2f8;">📎 Aperçu du PDF</div><iframe style="width:100%;height:calc(100% - 22px);border:0;"></iframe>';
    document.body.appendChild(p);
    p.addEventListener('mouseenter', () => { p.style.display = 'block'; });
    p.addEventListener('mouseleave', () => { p.style.display = 'none'; });
  }
  const ifr = p.querySelector('iframe');
  const full = url + '#toolbar=0&navpanes=0&view=FitH';
  if (ifr.getAttribute('src') !== full) ifr.setAttribute('src', full);
  const r = el.getBoundingClientRect();
  const W = 540, H = Math.min(720, Math.round(window.innerHeight * 0.88));
  let left = r.left - 280; if (left < 8) left = 8;
  if (left + W > window.innerWidth - 8) left = window.innerWidth - W - 8;
  let top = r.bottom + 6;
  if (top + H > window.innerHeight - 8) top = Math.max(8, window.innerHeight - H - 8);
  p.style.left = left + 'px';
  p.style.top = top + 'px';
  p.style.display = 'block';
}

// Supprime le PDF du Storage (en silence si échec — la suppression du bon prime)
async function _deleteBonPdf(pdfPath) {
  if (!sb || !pdfPath) return;
  try { await sb.storage.from('bons-pdfs').remove([pdfPath]); }
  catch (e) { console.warn('Delete PDF', e); }
}

// Appelle Mistral pour extraire les infos structurées du bon
async function bonExtractInfosIA(texte) {
  const systemPrompt =
    'Tu es un assistant qui extrait des informations depuis un BON DE TRAVAUX suisse ' +
    '(régie immobilière / gérance). Analyse le texte et renvoie UNIQUEMENT un objet JSON valide, ' +
    'sans aucun texte autour, sans balises Markdown.\n' +
    'ATTENTION DESTINATAIRE = DERATEK (le prestataire qui reçoit le bon, à NE PAS confondre avec la gérance) : ' +
    'le bloc d\'adresse du destinataire contient "DERATEK" / "PRINCE DERATEK" / "Maillefer 25" / "2000 Neuchâtel" / "Pyramides 7 Lausanne". ' +
    'N\'utilise JAMAIS cette adresse comme gerance_adresse. La gérance est l\'émetteur du bon (ex "Régie ... SA", "Jouval SA"), souvent en bas du document.\n' +
    'Utilise exactement ces clés (chaîne vide si absent) :\n' +
    '{\n' +
    '"gerance_nom": "nom de la régie/gérance (l\'émetteur du bon, ex Jouval SA). JAMAIS DERATEK.",\n' +
    '"gerant_nom": "nom du gérant ou gérante technique / contact (ex le nom après \\"Aff. traitée par\\")",\n' +
    '"gerant_tel": "téléphone du gérant",\n' +
    '"gerant_email": "email du gérant",\n' +
    '"gerance_adresse": "adresse de la gérance UNIQUEMENT si elle est clairement indiquée comme telle. NE METS RIEN (chaîne vide) si la seule adresse visible est celle du destinataire DERATEK / Maillefer 25 / Pyramides 7.",\n' +
    '"gerance_npa": "code postal gérance (vide si inconnu)",\n' +
    '"gerance_ville": "ville gérance (vide si inconnue)",\n' +
    '"numero_bon": "numéro du bon de travaux. ATTENTION : recopie-le INTÉGRALEMENT, sans jamais omettre le premier chiffre. Les bons de la Gérance CPCN / Caisse de pensions de la fonction publique du canton de Neuchâtel portent un numéro à 7 CHIFFRES commençant TOUJOURS par 1 (ex. \\"1 768 235\\", \\"1 892 795\\") : si tu ne lis que 6 chiffres (ex. \\"768 235\\"), c\'est que le 1 initial a été manqué — remets-le.",\n' +
    '"date_bon": "date du bon au format AAAA-MM-JJ",\n' +
    '"immeuble": "ADRESSE D\'INTERVENTION = l\'adresse écrite en face de \\"Immeuble\\" sur le bon (rue + numéro + NPA + ville, ex \\"Matthias Hipp 1A, 2000 Neuchâtel\\"). C\'est le lieu où DERATEK doit intervenir, PAS l\'adresse de la gérance ni de DERATEK.",\n' +
    '"proprietaire": "nom du propriétaire",\n' +
    '"locataire_nom": "nom complet du/des locataire(s)",\n' +
    '"locataire_tel": "téléphone du locataire",\n' +
    '"locataire_email": "email du locataire",\n' +
    '"locataire_adresse": "adresse postale du locataire = LA MÊME que le champ Immeuble (rue + numéro + NPA + ville). Si seule une référence/objet du type \\"A88000105\\" ou \\"APPARTEMENT 4.5 PCES REZ\\" est écrite près du locataire, NE la mets PAS ici : recopie plutôt l\'adresse de l\'Immeuble. Laisse vide si aucune rue n\'est trouvable.",\n' +
    '"probleme": "description du problème ou des travaux demandés",\n' +
    '"contact_sur_place": "personne et téléphone de contact sur place",\n' +
    '"concierge": "nom et téléphone du concierge"\n' +
    '}';

  const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + DERATEK_CONFIG.mistral.apiKey
    },
    body: JSON.stringify({
      model: DERATEK_CONFIG.mistral.model,
      max_tokens: 900,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: texte }
      ]
    })
  });
  if (!response.ok) {
    let m = 'API ' + response.status;
    try { const e = await response.json(); m = (e.error && e.error.message) || m; } catch (e) {}
    throw new Error(m);
  }
  const data = await response.json();
  const raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!raw) throw new Error('Réponse IA vide');
  // Nettoyage au cas où l'IA ajoute des balises
  const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  return JSON.parse(clean);
}

// Affiche le récap de confirmation (champs éditables avant validation)
// Numéro pour un bon créé à la main (gérance sans PDF) : format « BCM 10-101 », « BCM 10-102 »…
// On reprend la suite après le plus grand n° BCM 10-NNN existant (sinon on démarre à 101).
function _nextBonManuelNumero() {
  let max = 100;
  (DB.bons || []).forEach(b => {
    const m = String(b.numero || '').trim().match(/^BCM\s*10-(\d+)$/i);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return 'BCM 10-' + (max + 1);
}
// Ouvre le formulaire de bon VIDE (sans PDF) — pour les gérances qui n'envoient pas de bon
// dates : tableau optionnel de dates d'intervention à pré-remplir dans le bon manuel.
// Il DOIT être fourni ici : le formulaire construit la liste des dates au moment du rendu.
function openManualBon(dates) {
  if (typeof showScreen === 'function') showScreen('bons');
  _pendingBonPdf = null;
  _pendingBonDates = (dates && dates.length) ? dates.slice(0, 5) : null;
  const fi = $('bon-file-input'); if (fi) fi.value = '';
  bonShowConfirm({ numero_bon: _nextBonManuelNumero(), date_bon: (typeof today === 'function' ? today() : '') }, '', true);
}
// Remplit les champs du bon manuel depuis un client (gérance) existant
function onManualBonClientSelect(id) {
  if (!id) return;
  const c = (DB.clients || []).find(x => x.id === id);
  if (!c) return;
  const setv = (k, v) => { const el = $('bonf-' + k); if (el) el.value = v || ''; };
  const gerant = String(c.contact || '').replace(/^\[ROLE:[^\]]*\]/, '').trim();
  setv('gerance_nom', c.nom);
  setv('gerant_nom', gerant);
  setv('gerant_tel', c.tel);
  setv('gerant_email', c.email);
  setv('gerance_adresse', c.adresse);
  setv('gerance_npa', c.npa);
  setv('gerance_ville', c.ville);
}
// Les bons de la Gérance CPCN portent TOUJOURS un numéro à 7 chiffres commençant par 1
// (ex. « 1 768 235 »). L'OCR/IA perd régulièrement le « 1 » de tête et renvoie « 768 235 ».
// On le rétablit automatiquement pour que le n° soit correct dès le formulaire.
function _fixNumeroBonCPCN(numero, geranceNom) {
  const num = String(numero || '').trim();
  if (!num) return num;
  if (!/cpcn/i.test(String(geranceNom || ''))) return num;
  const digits = num.replace(/\D/g, '');
  // Uniquement les numéros à 6 chiffres commençant par 7, 8 ou 9 (série CPCN : 1 7xx xxx → 1 9xx xxx)
  if (!/^[789]\d{5}$/.test(digits)) return num;
  const d = '1' + digits;
  return d.slice(0, 1) + ' ' + d.slice(1, 4) + ' ' + d.slice(4);
}
function bonShowConfirm(infos, fileName, manual) {
  const box = $('bon-confirm');
  if (!box) return;
  // Rétablit le « 1 » de tête oublié par l'IA sur les bons CPCN
  infos = infos || {};
  if (!manual && infos.numero_bon) {
    infos.numero_bon = _fixNumeroBonCPCN(infos.numero_bon, infos.gerance_nom);
  }
  const champ = (label, key, val) =>
    `<div style="margin-bottom:8px;">
       <label style="display:block;font-size:11px;font-weight:700;color:var(--g600);text-transform:uppercase;margin-bottom:3px;">${label}</label>
       <input class="form-input" id="bonf-${key}" value="${(val||'').replace(/"/g,'&quot;')}" style="font-size:13px;">
     </div>`;
  const _clientOpts = (DB.clients || []).slice().sort((a,b)=>(a.nom||'').localeCompare(b.nom||''))
    .map(c => {
      const gerant = String(c.contact || '').replace(/^\[ROLE:[^\]]*\]/, '').trim();
      const label = (c.nom || '') + (gerant ? ' — ' + gerant : '') + (c.type ? ' (' + c.type + ')' : '');
      return `<option value="${c.id}">${label.replace(/</g,'&lt;')}</option>`;
    }).join('');

  box.innerHTML = `
    <div style="background:#fff;border:2px solid var(--navy);border-radius:12px;padding:18px;box-shadow:0 4px 18px rgba(13,27,62,.12);">
      <div style="font-size:15px;font-weight:800;color:var(--navy);margin-bottom:4px;">${manual ? '📝 Nouveau bon manuel (sans PDF)' : '✅ Voici ce que l\'IA a trouvé'}</div>
      <div style="font-size:12px;color:var(--g600);margin-bottom:14px;">${manual ? 'Remplis les champs (au minimum la gérance ou le locataire), puis valide. Le n° est attribué automatiquement (BCM 10-101, BCM 10-102…), tu peux le changer.' : ('Vérifiez et corrigez si besoin, puis validez. Fichier : <b>' + (fileName||'') + '</b>')}</div>

      <div style="font-size:12px;font-weight:800;color:var(--red);text-transform:uppercase;letter-spacing:.5px;margin:6px 0 8px;">🏢 Gérance &amp; gérant (→ Clients)</div>
      <div style="margin-bottom:10px;">
        <label style="display:block;font-size:11px;font-weight:700;color:var(--g600);text-transform:uppercase;margin-bottom:3px;">📇 Reprendre une gérance / un client existant</label>
        <select class="form-input" style="font-size:13px;" onchange="onManualBonClientSelect(this.value)">
          <option value="">— Choisir dans mes clients (remplit les champs ci-dessous) —</option>
          ${_clientOpts}
        </select>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 14px;">
        ${champ('Gérance', 'gerance_nom', infos.gerance_nom)}
        ${champ('Gérant(e)', 'gerant_nom', infos.gerant_nom)}
        ${champ('Tél. gérant', 'gerant_tel', infos.gerant_tel)}
        ${champ('Email gérant', 'gerant_email', infos.gerant_email)}
        ${champ('Adresse facturation', 'gerance_adresse', infos.gerance_adresse)}
        ${champ('NPA', 'gerance_npa', infos.gerance_npa)}
        ${champ('Ville', 'gerance_ville', infos.gerance_ville)}
      </div>

      <div style="font-size:12px;font-weight:800;color:var(--red);text-transform:uppercase;letter-spacing:.5px;margin:14px 0 8px;">🏠 Locataire (→ Locataires)</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 14px;">
        ${champ('Locataire', 'locataire_nom', infos.locataire_nom)}
        ${champ('Tél. locataire', 'locataire_tel', infos.locataire_tel)}
        ${champ('Email locataire', 'locataire_email', infos.locataire_email)}
        ${champ('Adresse locataire', 'locataire_adresse', infos.immeuble || infos.locataire_adresse)}
      </div>

      <div style="font-size:12px;font-weight:800;color:var(--red);text-transform:uppercase;letter-spacing:.5px;margin:14px 0 8px;">📄 Bon de travaux (→ onglet Bons)</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 14px;">
        ${champ('N° du bon', 'numero_bon', infos.numero_bon)}
        ${champ('Date', 'date_bon', infos.date_bon)}
        ${champ('Immeuble', 'immeuble', infos.immeuble)}
        ${champ('Propriétaire', 'proprietaire', infos.proprietaire)}
        ${champ('Concierge', 'concierge', infos.concierge)}
        ${champ('Contact sur place', 'contact_sur_place', infos.contact_sur_place)}
      </div>

      <div style="font-size:12px;font-weight:800;color:var(--red);text-transform:uppercase;letter-spacing:.5px;margin:14px 0 6px;">📅 Dates d'intervention (→ bon)</div>
      <div id="bonf-dates" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
        ${((_pendingBonDates || []).slice(0, 5)).map(d => `<input type="date" class="form-input" data-bonf-date value="${d}" style="width:auto;font-size:13px;">`).join('')}
        <button type="button" class="btn btn-ghost btn-sm" onclick="bonfAddDate()" title="Ajouter une date d'intervention">+ Ajouter une date</button>
      </div>

      <div style="margin-top:8px;">
        <label style="display:block;font-size:11px;font-weight:700;color:var(--g600);text-transform:uppercase;margin-bottom:3px;">Problème / travaux</label>
        <textarea class="form-input" id="bonf-probleme" rows="2" style="font-size:13px;">${(infos.probleme||'')}</textarea>
      </div>

      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
        <button class="btn btn-ghost" onclick="bonCancel()">Annuler</button>
        <button class="btn btn-navy" onclick="bonConfirmSave()">✓ Valider et enregistrer</button>
      </div>
      <div style="font-size:11px;color:var(--g400);text-align:right;margin-top:6px;">
        (La création automatique des fiches sera activée à la prochaine étape.)
      </div>
    </div>`;
  box.style.display = 'block';
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Ajoute un champ date vide dans la section « Dates d'intervention » du formulaire de bon
function bonfAddDate() {
  const wrap = $('bonf-dates'); if (!wrap) return;
  const inp = document.createElement('input');
  inp.type = 'date'; inp.className = 'form-input'; inp.setAttribute('data-bonf-date', '');
  inp.style.cssText = 'width:auto;font-size:13px;';
  const btn = wrap.querySelector('button');
  wrap.insertBefore(inp, btn);
  inp.focus();
}
function bonCancel() {
  const box = $('bon-confirm');
  if (box) { box.style.display = 'none'; box.innerHTML = ''; }
  const fi = $('bon-file-input'); if (fi) fi.value = '';
  _pendingBonPdf = null;
  _pendingBonDates = null;
}

// Récupère la valeur d'un input du récap (ou chaîne vide)
function _bonVal(key) { const el = $('bonf-' + key); return el ? el.value.trim() : ''; }

// Trouve une gérance existante par nom (insensible à la casse) ou en crée une nouvelle
function _findOrCreateGerance(infos) {
  const nom = (infos.gerance_nom || '').trim();
  if (!nom) return null;
  const gerant = (infos.gerant_nom || '').trim();
  const clients = DB.clients;
  // UNE CARTE PAR PERSONNE : on cherche la fiche de CETTE gérance ET de CE gérant.
  // Si le gérant est différent, on crée une NOUVELLE carte (même gérance, autre personne).
  const gN = _normPerson(gerant);
  const existing = clients.find(c =>
    (c.nom || '').toLowerCase() === nom.toLowerCase() &&
    (!gN || _normPerson(c.contact || '') === gN)
  );
  if (existing) {
    const updates = {};
    if (!_rapContactNom(existing.contact) && gerant)  updates.contact = gerant;
    if (!existing.tel     && infos.gerant_tel)        updates.tel     = infos.gerant_tel;
    if (!existing.email   && infos.gerant_email)      updates.email   = infos.gerant_email;
    if (!existing.adresse && infos.gerance_adresse)   updates.adresse = infos.gerance_adresse;
    if (!existing.npa     && infos.gerance_npa)       updates.npa     = infos.gerance_npa;
    if (!existing.ville   && infos.gerance_ville)     updates.ville   = infos.gerance_ville;
    if (Object.keys(updates).length) { Object.assign(existing, updates); DB.clients = clients; }
    return existing;
  }
  // Nouvelle carte dédiée à ce gérant (séparée automatiquement à l'import du bon)
  const newClient = {
    id: newId(),
    nom: nom,
    type: 'Gérance',
    contact: gerant,
    tel:     infos.gerant_tel || '',
    email:   infos.gerant_email || '',
    web: '',
    adresse: infos.gerance_adresse || '',
    npa:     infos.gerance_npa || '',
    ville:   infos.gerance_ville || '',
    num: '', tarif: '',
    notes: 'Créé automatiquement depuis un bon de travaux.'
  };
  clients.push(newClient);
  DB.clients = clients;
  return newClient;
}

// Trouve un locataire existant ou en crée un nouveau (en mémorisant la gérance et la date)
function _findOrCreateLocataire(infos, geranceId) {
  const nom = (infos.locataire_nom || '').trim();
  if (!nom) return null;
  // Adresse du locataire = adresse d'intervention = l'"Immeuble" du bon en priorité
  // (l'IA met parfois une référence/objet dans locataire_adresse, donc l'immeuble prime).
  const adrLoc = (infos.immeuble || '').trim() || (infos.locataire_adresse || '').trim();
  const locs = DB.locataires;
  const existing = locs.find(l => (l.nom || '').toLowerCase() === nom.toLowerCase());
  if (existing) {
    const updates = {};
    if (!existing.tel       && infos.locataire_tel)     updates.tel       = infos.locataire_tel;
    if (!existing.email     && infos.locataire_email)   updates.email     = infos.locataire_email;
    if (!existing.adresse   && adrLoc)                  updates.adresse   = adrLoc;
    if (!existing.clientId  && geranceId)               updates.clientId  = geranceId;
    if (!existing.createdAt)                            updates.createdAt = new Date().toISOString();
    if (Object.keys(updates).length) {
      Object.assign(existing, updates);
      DB.locataires = locs;
    }
    return existing;
  }
  const newLoc = {
    id: newId(),
    nom: nom,
    tel:     infos.locataire_tel || '',
    email:   infos.locataire_email || '',
    adresse: adrLoc,
    clientId: geranceId || '',
    createdAt: new Date().toISOString(),
    notes: 'Créé automatiquement depuis un bon de travaux.'
  };
  locs.push(newLoc);
  DB.locataires = locs;
  return newLoc;
}

// Validation : crée la Gérance (Client), le Locataire et le Bon, uploade le PDF, rafraîchit l'UI
async function bonConfirmSave() {
  const infos = {
    gerance_nom:       _bonVal('gerance_nom'),
    gerant_nom:        _bonVal('gerant_nom'),
    gerant_tel:        _bonVal('gerant_tel'),
    gerant_email:      _bonVal('gerant_email'),
    gerance_adresse:   _bonVal('gerance_adresse'),
    gerance_npa:       _bonVal('gerance_npa'),
    gerance_ville:     _bonVal('gerance_ville'),
    numero_bon:        _bonVal('numero_bon'),
    date_bon:          _bonVal('date_bon'),
    immeuble:          _bonVal('immeuble'),
    proprietaire:      _bonVal('proprietaire'),
    locataire_nom:     _bonVal('locataire_nom'),
    locataire_tel:     _bonVal('locataire_tel'),
    locataire_email:   _bonVal('locataire_email'),
    locataire_adresse: _bonVal('locataire_adresse'),
    probleme:          (($('bonf-probleme') && $('bonf-probleme').value) || '').trim(),
    contact_sur_place: _bonVal('contact_sur_place'),
    concierge:         _bonVal('concierge'),
  };

  if (!infos.gerance_nom && !infos.locataire_nom && !infos.numero_bon) {
    toast('Rien à enregistrer (gérance, locataire et numéro de bon vides)', '#e63946');
    return;
  }

  // Détection de doublon : un bon portant le même numéro existe-t-il déjà ?
  if (infos.numero_bon) {
    const dup = (DB.bons || []).find(b => b.numero && _factNorm(b.numero) === _factNorm(infos.numero_bon));
    if (dup) {
      const ger = dup.geranceNom ? (' — ' + dup.geranceNom) : '';
      const dt = dup.date ? (' du ' + fmtDate(dup.date)) : '';
      if (!confirm('⚠️ Doublon possible\n\nUn bon portant le numéro « ' + infos.numero_bon + ' » existe déjà' + ger + dt + '.\n\nVoulez-vous quand même l\'enregistrer (créer un 2ᵉ bon avec ce numéro) ?')) {
        toast('Import annulé — ce bon existe déjà', '#f4a623');
        return;
      }
    }
  }

  const gerance   = _findOrCreateGerance(infos);
  const locataire = _findOrCreateLocataire(infos, gerance ? gerance.id : '');

  // 1. Upload du PDF d'abord (si présent) — on attend la fin pour récupérer le chemin
  const bonId = newId();
  let pdfPath = '';
  const pdfFile = _pendingBonPdf;
  if (pdfFile) {
    toast('Upload du PDF en cours…', '#1a2744');
    pdfPath = await _uploadBonPdf(bonId, pdfFile);
  }

  // 2. Création du bon avec le chemin du PDF
  const bons = DB.bons;
  const bon = {
    id: bonId,
    numero:       infos.numero_bon,
    date:         infos.date_bon,
    geranceId:    gerance   ? gerance.id   : '',
    geranceNom:   gerance   ? gerance.nom  : infos.gerance_nom,
    gerantNom:    infos.gerant_nom   || '',
    gerantTel:    infos.gerant_tel   || '',
    gerantEmail:  infos.gerant_email || '',
    locataireId:  locataire ? locataire.id : '',
    locataireNom: locataire ? locataire.nom : infos.locataire_nom,
    immeuble:        infos.immeuble,
    proprietaire:    infos.proprietaire,
    probleme:        infos.probleme,
    contactSurPlace: infos.contact_sur_place,
    concierge:       infos.concierge,
    pdfPath:         pdfPath,
    createdAt: new Date().toISOString()
  };
  // Dates d'intervention : on lit celles saisies/pré-remplies dans le formulaire du bon
  const _formDates = Array.prototype.slice.call(document.querySelectorAll('#bonf-dates [data-bonf-date]')).map(function (i) { return (i.value || '').trim(); }).filter(Boolean);
  const _datesToApply = _formDates.length ? _formDates : (_pendingBonDates || []);
  if (_datesToApply.length) { _setBonDatesInterv(bon, _datesToApply); }
  _pendingBonDates = null;
  bons.push(bon);
  DB.bons = bons;

  const parts = [];
  if (gerance)   parts.push('Gérance');
  if (locataire) parts.push('Locataire');
  parts.push('Bon');
  if (pdfPath)   parts.push('PDF');
  toast('✓ Enregistré : ' + parts.join(' + '), '#2d9e6b');

  _pendingBonPdf = null;
  bonCancel();
  if (typeof renderClients === 'function')    renderClients();
  if (typeof renderLocataires === 'function') renderLocataires();
  if (typeof renderBons === 'function')       renderBons();
  if (typeof renderDashboard === 'function')  renderDashboard();
}

// Liste des locataires, regroupés par gérance
function renderLocataires() {
  updateNavCounts();
  const q = (($('loc-search') || {}).value || '').toLowerCase();
  const all = DB.locataires || [];
  const _clById = {}; (DB.clients || []).forEach(c => { if (c && c.id) _clById[c.id] = c; });
  const list = q
    ? all.filter(l => {
        const ger = (l.clientId && _clById[l.clientId]) ? _clById[l.clientId].nom : '';
        return ((l.prenom||'') + ' ' + (l.nom||'') + ' ' + (l.adresse||'') + ' ' + (l.ville||'') + ' ' + (l.npa||'') + ' ' + (l.tel||'') + ' ' + (l.email||'') + ' ' + ger).toLowerCase().includes(q);
      })
    : all;
  const count = $('locataires-count');
  if (count) count.textContent = `${list.length} locataire${list.length !== 1 ? 's' : ''}`;
  const grid = $('locataires-grid');
  if (!grid) return;
  // L'élément a la classe CSS .clients-grid (grid layout) : on l'annule pour avoir des sections empilées
  grid.style.display = 'block';
  if (!list.length) {
    grid.innerHTML = '<div class="empty"><div class="empty-icon">🏠</div><div class="empty-text">Aucun locataire pour le moment.<br>Les locataires sont créés automatiquement depuis les bons de travaux.</div></div>';
    return;
  }
  const allBons = DB.bons || [];

  // 1ʳᵉ passe : enrichir chaque locataire avec sa gérance et sa date (résolues via fallback)
  const enriched = list.map(l => {
    let gerance = l.clientId ? DB.clients.find(c => c.id === l.clientId) : null;
    let geranceNom = gerance ? gerance.nom : '';
    let dateEnreg = l.createdAt || '';
    if (!geranceNom || !dateEnreg) {
      const bonsLies = allBons
        .filter(b => b.locataireId === l.id || (l.nom && b.locataireNom && b.locataireNom.toLowerCase() === l.nom.toLowerCase()))
        .sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||''));
      if (!geranceNom && bonsLies.length) geranceNom = bonsLies[0].geranceNom || '';
      if (!dateEnreg && bonsLies.length)  dateEnreg  = bonsLies[0].createdAt || '';
    }
    let dateFmt = '';
    if (dateEnreg) {
      try {
        const d = new Date(dateEnreg);
        if (!isNaN(d)) {
          dateFmt = String(d.getDate()).padStart(2,'0') + '.' +
                    String(d.getMonth()+1).padStart(2,'0') + '.' + d.getFullYear();
        }
      } catch(e) {}
    }
    return { l, geranceNom, dateFmt, dateEnreg };
  });

  // 2ᵉ passe : regrouper par gérance
  const groups = {};
  enriched.forEach(item => {
    const key = item.geranceNom || '(Sans gérance)';
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  });

  // 3ᵉ passe : rendu HTML avec une section par gérance (les "(Sans gérance)" en dernier)
  const keys = Object.keys(groups).sort((a, b) => {
    if (a === '(Sans gérance)') return 1;
    if (b === '(Sans gérance)') return -1;
    return a.localeCompare(b, 'fr');
  });

  grid.innerHTML = keys.map(g => {
    const items = groups[g].sort((a, b) => (b.dateEnreg || '').localeCompare(a.dateEnreg || ''));
    const gColorL = colorForGeranceName(g);
    return `
      <div style="margin-top:14px;">
        <div style="font-size:13px;font-weight:800;color:${gColorL};text-transform:uppercase;letter-spacing:.4px;margin-bottom:10px;border-bottom:2px solid ${gColorL};padding-bottom:5px;">
          🏢 ${g} <span style="font-weight:500;color:var(--g600);">(${items.length} locataire${items.length !== 1 ? 's' : ''})</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${items.map(({ l, dateFmt }) => `
            <div id="locrow-${l.id}" style="display:flex;align-items:stretch;gap:14px;background:#fff;border:1px solid #e5e7eb;border-left:4px solid ${gColorL};border-radius:8px;padding:10px 14px;box-shadow:0 1px 2px rgba(0,0,0,.04);flex-wrap:wrap;transition:box-shadow .3s;">
              <div style="display:flex;align-items:center;gap:10px;min-width:200px;flex:1.5;">
                <div style="width:34px;height:34px;border-radius:50%;background:${gColorL};color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">${initials(l.nom||'')}</div>
                <div>
                  <div style="font-size:13px;font-weight:800;color:var(--navy);line-height:1.2;">${l.nom||'—'}</div>
                  ${dateFmt ? `<div style="font-size:11px;color:var(--g600);">📅 ${dateFmt}</div>` : ''}
                </div>
              </div>
              <div style="flex:1;min-width:140px;">
                <div style="font-size:10px;color:var(--g400);text-transform:uppercase;font-weight:700;letter-spacing:.3px;">📞 Téléphone</div>
                <div style="font-size:12px;">${l.tel || '—'}</div>
              </div>
              <div style="flex:1.2;min-width:170px;">
                <div style="font-size:10px;color:var(--g400);text-transform:uppercase;font-weight:700;letter-spacing:.3px;">✉️ Email</div>
                <div style="font-size:12px;color:var(--g600);word-break:break-all;">${l.email || '—'}</div>
              </div>
              <div style="flex:1.8;min-width:200px;">
                <div style="font-size:10px;color:var(--g400);text-transform:uppercase;font-weight:700;letter-spacing:.3px;">📍 Adresse</div>
                <div style="font-size:12px;color:var(--g600);">${l.adresse || '—'}${(l.npa || l.ville) ? `, ${l.npa||''} ${l.ville||''}` : ''}</div>
              </div>
              <div style="display:flex;gap:4px;align-items:center;flex-shrink:0;">
                <button class="btn btn-ghost btn-sm" onclick="editLocataire('${l.id}')" title="Modifier">✏️ Modifier</button>
                <button class="btn btn-red btn-sm btn-xs" onclick="confirmDeleteLocataire('${l.id}')" title="Supprimer">🗑</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function confirmDeleteLocataire(id, nom) {
  // Permet l'appel depuis la modale d'édition (sans nom) ou depuis la carte (avec nom)
  if (!nom) {
    const l = (DB.locataires || []).find(x => x.id === id);
    nom = l ? (l.nom || '') : '';
  }
  $('confirm-msg').textContent = `Supprimer le locataire "${nom}" ? Cette action est irréversible.`;
  $('confirm-btn').onclick = () => {
    DB.locataires = DB.locataires.filter(l => l.id !== id);
    closeModal('modal-confirm');
    closeModal('modal-locataire');
    state.editingLocataireId = null;
    renderLocataires();
    toast('Locataire supprimé', '#e63946');
  };
  openModal('modal-confirm');
}

// Liste des bons enregistrés, regroupés par gérance
// Bascule entre les bons actifs / en cours / terminés
function setBonsFilter(f) {
  state.bonsFilter = (f === 'termines') ? 'termines' : (f === 'en-cours' ? 'en-cours' : 'actifs');
  const ba = $('bons-filter-actifs'), bt = $('bons-filter-termines');
  if (ba) ba.className = 'btn ' + (state.bonsFilter === 'actifs' ? 'btn-navy' : 'btn-ghost') + ' btn-sm';
  if (bt) bt.className = 'btn ' + (state.bonsFilter === 'termines' ? 'btn-green' : 'btn-ghost') + ' btn-sm';
  renderBons();
}
// Boutons de navigation du haut : Bons (actifs), Bons en cours, Bons terminés
function showBonsActifs() {
  showScreen('bons');
  setBonsFilter('actifs');
}
function _highlightNav(id) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const nb = $(id); if (nb) nb.classList.add('active');
}
function showBonsEnCours() {
  showScreen('bons');
  setBonsFilter('en-cours');
  _highlightNav('nb-bons-encours');
}
function showBonsTermines() {
  showScreen('bons');
  setBonsFilter('termines');
  _highlightNav('nb-bons-termines');
}

// Dates d'intervention EFFECTUÉES d'un bon (jusqu'à 5), stockées dans "probleme"
// via un marqueur invisible (la table bons n'a pas de colonne dédiée côté Supabase).
function _bonDatesInterv(b) {
  const m = String((b && b.probleme) || '').match(/\[INTERV:([^\]]*)\]/);
  return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
}
// Technicien affecté au bon (stocké dans probleme via marqueur)
function _bonAffecte(b) {
  const m = String((b && b.probleme) || '').match(/\[AFFECTE:([^\]]*)\]/);
  return m ? m[1].trim() : '';
}
// Note interne d'un bon (prix, type de traitement… pour la facturation),
// stockée dans "probleme" via un marqueur invisible [NOTE:<base64>].
// Le base64 (UTF-8) évite tout souci avec les retours à la ligne et les crochets.
function _encNote(text) {
  try { return btoa(unescape(encodeURIComponent(String(text || '')))); }
  catch (e) { return ''; }
}
function _decNote(b64) {
  try { return decodeURIComponent(escape(atob(String(b64 || '')))); }
  catch (e) { return ''; }
}
function _bonNote(b) {
  const m = String((b && b.probleme) || '').match(/\[NOTE:([^\]]*)\]/);
  return m ? _decNote(m[1]) : '';
}
// Statuts de rendez-vous proposés dans la note
const BON_NOTE_STATUTS = [
  'Rendez-vous confirmé', 'Rendez-vous reporté', 'Rendez-vous annulé',
  'Locataire absent', 'Propriétaire absent', 'En attente de confirmation',
  'Intervention réalisée', 'Intervention à reprogrammer'
];
// Nuisibles concernés, regroupés par catégorie (pour les <optgroup>)
const BON_NOTE_NUISIBLES = [
  { groupe: 'Nuisibles rampants', items: ['Blattes', 'Cafards', 'Blattes germaniques', 'Blattes orientales', 'Fourmis', 'Punaises de lit', 'Puces', 'Poissons d\'argent', 'Araignées'] },
  { groupe: 'Nuisibles volants', items: ['Guêpes', 'Frelons', 'Frelons asiatiques', 'Abeilles (relocalisation)', 'Mouches', 'Moustiques', 'Mites alimentaires', 'Mites textiles'] },
  { groupe: 'Rongeurs', items: ['Souris', 'Rats', 'Mulots', 'Loirs'] },
  { groupe: 'Autres animaux nuisibles', items: ['Fouines', 'Martres', 'Taupes', 'Pigeons', 'Corbeaux', 'Étourneaux'] }
];
// Prestations types à insérer dans les remarques de la note (libellé court + description complète)
const BON_NOTE_PRESTATIONS = [
  { groupe: 'Guêpes — nid', nuisibles: ['Guêpes'], items: [
    { label: 'Nid de guêpes — caisson de store', desc: "Traitement contre un nid de guêpes situé dans un caisson de store, effectué par injection d’une poudre insecticide professionnelle." },
    { label: 'Nid de guêpes — sous toiture', desc: "Traitement contre un nid de guêpes situé sous toiture, effectué par injection d’une poudre insecticide professionnelle." },
    { label: 'Nid de guêpes — jardin', desc: "Traitement contre un nid de guêpes situé dans un jardin, effectué par injection d’une poudre insecticide professionnelle." },
    { label: 'Nid de guêpes — terrasse', desc: "Traitement contre un nid de guêpes situé sur une terrasse, effectué par injection d’une poudre insecticide professionnelle." },
    { label: 'Nid de guêpes — chambre', desc: "Traitement contre un nid de guêpes situé dans une chambre, effectué par injection d’une poudre insecticide professionnelle." },
    { label: 'Nid de guêpes — cuisine', desc: "Traitement contre un nid de guêpes situé dans une cuisine, effectué par injection d’une poudre insecticide professionnelle." },
    { label: 'Nid de guêpes — séjour', desc: "Traitement contre un nid de guêpes situé dans un séjour, effectué par injection d’une poudre insecticide professionnelle." },
    { label: 'Nid de guêpes — cheminée', desc: "Traitement contre un nid de guêpes situé dans une cheminée, effectué par injection d’une poudre insecticide professionnelle." },
    { label: 'Nid de guêpes — canne télescopique 3 m', desc: "Traitement contre un nid de guêpes à l’aide d’une canne télescopique de 3 mètres, avec application d’une poudre insecticide professionnelle." },
    { label: 'Nid de guêpes — canne télescopique 5 m', desc: "Traitement contre un nid de guêpes à l’aide d’une canne télescopique de 5 mètres, avec application d’une poudre insecticide professionnelle." },
    { label: 'Nid de guêpes — canne télescopique 6 m', desc: "Traitement contre un nid de guêpes à l’aide d’une canne télescopique de 6 mètres, avec application d’une poudre insecticide professionnelle." },
    { label: 'Nid de guêpes — canne télescopique 7 m', desc: "Traitement contre un nid de guêpes à l’aide d’une canne télescopique de 7 mètres, avec application d’une poudre insecticide professionnelle." },
    { label: 'Nid de guêpes — canne télescopique 8 m', desc: "Traitement contre un nid de guêpes à l’aide d’une canne télescopique de 8 mètres, avec application d’une poudre insecticide professionnelle." },
    { label: 'Nid de guêpes — canne télescopique 9 m', desc: "Traitement contre un nid de guêpes à l’aide d’une canne télescopique de 9 mètres, avec application d’une poudre insecticide professionnelle." },
    { label: 'Nid de guêpes — canne télescopique 10 m', desc: "Traitement contre un nid de guêpes à l’aide d’une canne télescopique de 10 mètres, avec application d’une poudre insecticide professionnelle." }
  ] },
  { groupe: 'Rongeurs — rats & souris', nuisibles: ['Souris', 'Rats', 'Mulots', 'Loirs'], items: [
    { label: 'Boîtes d\'appâtage sécurisées', desc: "Mise en place de boîtes d’appâtage sécurisées contre les rongeurs." },
    { label: 'Dératisation — postes sécurisés', desc: "Traitement de dératisation par mise en place de postes d’appâtage sécurisés." },
    { label: 'Rodenticides — boîtes sécurisées', desc: "Mise en place de rodenticides professionnels dans des boîtes sécurisées." },
    { label: 'Souris — postes sécurisés', desc: "Traitement contre les souris avec mise en place de postes d’appâtage sécurisés." },
    { label: 'Rats — postes sécurisés', desc: "Traitement contre les rats avec mise en place de postes d’appâtage sécurisés." },
    { label: 'Boîtes — caves', desc: "Mise en place de boîtes d’appâtage sécurisées dans les caves." },
    { label: 'Boîtes — local poubelles', desc: "Mise en place de boîtes d’appâtage sécurisées dans le local poubelles." },
    { label: 'Boîtes — zones de passage', desc: "Mise en place de boîtes d’appâtage sécurisées dans les zones de passage des rongeurs." },
    { label: 'Dératisation — appartement', desc: "Traitement de dératisation dans un appartement avec pose de postes d’appâtage sécurisés." },
    { label: 'Dératisation — cuisine', desc: "Traitement de dératisation dans une cuisine avec pose de postes d’appâtage sécurisés." },
    { label: 'Dératisation — sous-sol', desc: "Traitement de dératisation dans un sous-sol avec pose de postes d’appâtage sécurisés." },
    { label: 'Dératisation — combles', desc: "Traitement de dératisation dans des combles avec pose de postes d’appâtage sécurisés." },
    { label: 'Dératisation — local technique', desc: "Traitement de dératisation dans un local technique avec pose de postes d’appâtage sécurisés." },
    { label: 'Dératisation — jardin', desc: "Traitement de dératisation dans un jardin avec pose de postes d’appâtage sécurisés." },
    { label: 'Contrôle et recharge des boîtes', desc: "Contrôle et recharge des boîtes d’appâtage sécurisées contre les rongeurs." },
    { label: 'Contrôle consommation des appâts', desc: "Contrôle de consommation des appâts rodenticides dans les postes sécurisés." },
    { label: 'Renforcement du dispositif', desc: "Renforcement du dispositif de dératisation avec ajout de boîtes d’appâtage sécurisées." },
    { label: 'Monitoring rongeurs', desc: "Mise en place d’un dispositif de monitoring contre les rongeurs." },
    { label: 'Contrôle traces / indices', desc: "Contrôle des traces de passage, consommations et indices de présence de rongeurs." },
    { label: 'Traitement curatif rongeurs', desc: "Traitement curatif contre les rongeurs avec produits professionnels homologués." },
    { label: 'Injection Racumin — cloisons', desc: "Traitement de dératisation par injection de Racumin dans les cloisons." },
    { label: 'Injection rodenticide — cloisons', desc: "Traitement de dératisation par injection de produit rodenticide professionnel dans les cloisons." },
    { label: 'Injection ciblée derrière cloisons', desc: "Traitement contre les rongeurs par injection ciblée de produit professionnel derrière les cloisons." },
    { label: 'Talon Wax Blocks — derrière lambris', desc: "Traitement de dératisation par injection de Talon Wax Blocks derrière le lambris." },
    { label: 'Blocs rodenticides — derrière lambris', desc: "Mise en place de blocs rodenticides professionnels derrière le lambris." },
    { label: 'Souris — injection derrière cloisons', desc: "Traitement contre les souris par injection de produit spécial derrière les cloisons." },
    { label: 'Rats — injection derrière cloisons', desc: "Traitement contre les rats par injection de produit spécial derrière les cloisons." },
    { label: 'Vides techniques / doublages', desc: "Traitement ciblé contre les rongeurs dans les vides techniques, cloisons et doublages." },
    { label: 'Dératisation — derrière cloisons', desc: "Traitement de dératisation derrière les cloisons avec produit professionnel adapté." },
    { label: 'Injection — zones de passage', desc: "Injection de produit rodenticide professionnel dans les zones de passage suspectées des rongeurs." },
    { label: 'Curatif — cloisons / doublages', desc: "Traitement curatif contre les rongeurs dans les cloisons, doublages et zones non accessibles." },
    { label: 'Application — lambris & cloisons', desc: "Application ciblée de produits professionnels contre les rongeurs derrière les lambris et cloisons." },
    { label: 'Zones creuses', desc: "Traitement de dératisation dans les zones creuses avec application de produits rodenticides professionnels." },
    { label: 'Passages dissimulés', desc: "Mise en place de produits rodenticides professionnels dans les passages dissimulés des rongeurs." },
    { label: 'Cavités murales / zones techniques', desc: "Traitement contre les rongeurs avec injection ciblée dans les cavités murales et zones techniques." }
  ] },
  { groupe: 'Punaises de lit', nuisibles: ['Punaises de lit'], items: [
    { label: 'Chimique micro-encapsulé', desc: "Traitement professionnel chimique contre les punaises de lit avec application d’un insecticide micro-encapsulé." },
    { label: 'Curatif — pulvérisation micro-encapsulé', desc: "Traitement curatif contre les punaises de lit par pulvérisation ciblée d’un insecticide professionnel micro-encapsulé." },
    { label: 'Zones de refuge — micro-encapsulé', desc: "Application d’un insecticide professionnel micro-encapsulé dans les zones de refuge des punaises de lit." },
    { label: 'Micro-encapsulé rémanent', desc: "Traitement contre les punaises de lit avec produit insecticide micro-encapsulé à effet rémanent." },
    { label: 'Vapeur sèche + insecticide', desc: "Traitement contre les punaises de lit par vapeur sèche et insecticide professionnel." },
    { label: 'Lit, sommier, plinthes', desc: "Traitement contre les punaises de lit avec traitement du lit, du sommier et des plinthes." },
    { label: 'Fissures, plinthes, refuges', desc: "Traitement contre les punaises de lit avec application dans les fissures, plinthes et zones de refuge." },
    { label: 'Prises, interrupteurs, gaines', desc: "Traitement contre les punaises de lit avec traitement des prises, interrupteurs et gaines techniques." },
    { label: 'Chambres à coucher', desc: "Traitement contre les punaises de lit dans les chambres à coucher." },
    { label: 'Séjour', desc: "Traitement contre les punaises de lit dans le séjour." },
    { label: 'Canapés et fauteuils', desc: "Traitement contre les punaises de lit dans les canapés et fauteuils." },
    { label: 'Matelas, sommiers, cadres de lit', desc: "Traitement contre les punaises de lit dans les matelas, sommiers et cadres de lit." },
    { label: 'Poudre insecticide', desc: "Traitement contre les punaises de lit avec application de poudre insecticide professionnelle." },
    { label: 'Injection poudre — zones creuses', desc: "Traitement contre les punaises de lit par injection de poudre insecticide dans les zones creuses." },
    { label: 'Plinthes, parquets, interstices', desc: "Traitement contre les punaises de lit dans les plinthes, parquets et interstices." },
    { label: 'Démontage partiel des éléments', desc: "Traitement contre les punaises de lit avec démontage partiel des éléments accessibles." },
    { label: 'Contrôle zones de repos / couchage', desc: "Traitement contre les punaises de lit avec contrôle des zones de repos et de couchage." },
    { label: 'Recommandations préventives', desc: "Traitement contre les punaises de lit avec mise en place de recommandations préventives." },
    { label: 'Deuxième passage', desc: "Deuxième passage de traitement contre les punaises de lit." },
    { label: 'Troisième passage', desc: "Troisième passage de traitement contre les punaises de lit." },
    { label: 'Complémentaire (activité persistante)', desc: "Traitement complémentaire contre les punaises de lit à la suite d’une activité persistante." },
    { label: 'Préventif — appartement voisin', desc: "Traitement préventif contre les punaises de lit dans un appartement voisin." },
    { label: 'Préventif — pièces à risque', desc: "Traitement préventif contre les punaises de lit dans les pièces à risque." },
    { label: 'Intervention de contrôle (présence)', desc: "Intervention de contrôle concernant la présence de punaises de lit." },
    { label: 'Contrôle visuel matelas / plinthes', desc: "Contrôle visuel des matelas, sommiers, plinthes et zones de refuge." },
    { label: 'Infestation légère', desc: "Traitement contre une infestation légère de punaises de lit." },
    { label: 'Infestation moyenne', desc: "Traitement contre une infestation moyenne de punaises de lit." },
    { label: 'Infestation sévère', desc: "Traitement contre une infestation sévère de punaises de lit." },
    { label: 'Complet — vapeur + pulvé + poudre', desc: "Traitement complet contre les punaises de lit avec application de vapeur sèche, pulvérisation professionnelle et poudre insecticide." },
    { label: 'Démontage / remontage plinthes', desc: "Démontage et remontage des plinthes dans le cadre du traitement contre les punaises de lit." },
    { label: 'Vapeur sèche 180 °C derrière plinthes', desc: "Traitement à la vapeur sèche à 180 °C derrière les plinthes." },
    { label: 'Poudre terre de diatomée — plinthes', desc: "Mise en place d’une poudre insecticide professionnelle à base de terre de diatomée derrière les plinthes." },
    { label: 'Poudre silice amorphe — plinthes', desc: "Application professionnelle d’une poudre insecticide à base de silice amorphe, sous forme de cristallisation, à l’arrière et sous les plinthes." },
    { label: 'Démontage prises & interrupteurs', desc: "Démontage et remontage des prises et interrupteurs électriques dans le cadre du traitement contre les punaises de lit." },
    { label: 'Poudre diatomée — prises / interrupteurs', desc: "Mise en place d’une poudre insecticide professionnelle à base de terre de diatomée dans les prises et interrupteurs électriques." },
    { label: 'Rebouchage gaines (silicone / enduit)', desc: "Rebouchage des gaines électriques au silicone et/ou à l’enduit de rebouchage afin de limiter les passages et les refuges des punaises de lit." },
    { label: 'Injection gaines — Ficam + diatomée', desc: "Injection dans les gaines électriques d’un mélange composé de Ficam et de poudre insecticide professionnelle à base de terre de diatomée." },
    { label: 'Traitement des gaines électriques', desc: "Traitement des gaines électriques afin de limiter les zones de passage et de refuge des punaises de lit." },
    { label: 'Zones techniques, gaines, plinthes', desc: "Traitement ciblé des zones techniques, gaines électriques, plinthes et interstices contre les punaises de lit." },
    { label: 'Renforcé — plinthes/vapeur/poudre/gaines', desc: "Traitement renforcé contre les punaises de lit avec démontage des plinthes, vapeur sèche, poudre insecticide et rebouchage des gaines." },
    { label: 'Complet zones de refuge', desc: "Traitement complet des zones de refuge des punaises de lit comprenant les plinthes, prises, interrupteurs, gaines électriques et fissures." },
    { label: 'Combiné — vapeur + micro-encapsulé + poudre', desc: "Traitement professionnel contre les punaises de lit avec application combinée de vapeur sèche, insecticide micro-encapsulé et poudre insecticide professionnelle." }
  ] },
  { groupe: 'Fouines', nuisibles: ['Fouines', 'Martres'], items: [
    { label: 'Inspection zones de passage', desc: "Inspection des zones de passage suspectées d’une fouine." },
    { label: 'Recherche points d\'entrée', desc: "Recherche des points d’entrée utilisés par la fouine." },
    { label: 'Contrôle combles / toiture / façade', desc: "Contrôle des combles, toiture, façade et isolation concernant une présence possible de fouine." },
    { label: 'Recherche d\'indices de présence', desc: "Recherche d’indices de présence de fouine : odeurs, déjections, bruits, traces et dégâts." },
    { label: 'Traitement répulsif professionnel', desc: "Mise en place d’un traitement répulsif professionnel contre les fouines." },
    { label: 'Répulsif — zones de passage', desc: "Application d’un répulsif professionnel dans les zones de passage de la fouine." },
    { label: 'Répulsif — combles', desc: "Traitement répulsif contre les fouines dans les combles." },
    { label: 'Répulsif — sous toiture', desc: "Traitement répulsif contre les fouines sous toiture." },
    { label: 'Répulsif — isolation', desc: "Traitement répulsif contre les fouines dans l’isolation." },
    { label: 'Répulsif — caisson de store', desc: "Traitement répulsif contre les fouines dans un caisson de store." },
    { label: 'Répulsif — vides techniques', desc: "Traitement répulsif contre les fouines dans les vides techniques." },
    { label: 'Répulsif — façade / isolation', desc: "Traitement répulsif contre les fouines entre la façade et l’isolation." },
    { label: 'Dispositif répulsif', desc: "Mise en place d’un dispositif répulsif afin de limiter la présence de fouines." },
    { label: 'Répulsif ciblé — zones sensibles', desc: "Application ciblée d’un produit répulsif professionnel dans les zones sensibles." },
    { label: 'Nettoyage zones souillées', desc: "Nettoyage des zones souillées par la présence de fouine." },
    { label: 'Retrait déjections / matériaux souillés', desc: "Retrait des déjections et matériaux souillés par la fouine." },
    { label: 'Désinfection zones contaminées', desc: "Désinfection des zones contaminées par les déjections de fouine." },
    { label: 'Retrait matériaux de nidification', desc: "Retrait d’anciens matériaux de nidification liés à la présence de fouine." },
    { label: 'Contrôle dégâts — isolation', desc: "Contrôle des dégâts causés par une fouine dans l’isolation." },
    { label: 'Contrôle dégâts — combles', desc: "Contrôle des dégâts causés par une fouine dans les combles." },
    { label: 'Recommandation fermeture des accès', desc: "Recommandation de fermeture des accès après confirmation du départ de la fouine." },
    { label: 'Obturation points d\'entrée', desc: "Obturation des points d’entrée après traitement et contrôle d’absence de fouine." },
    { label: 'Pose grilles / protections', desc: "Pose de grilles ou protections afin d’empêcher le retour de la fouine." },
    { label: 'Mise en sécurité des accès', desc: "Mise en sécurité des accès afin de limiter les risques de réinfestation." },
    { label: 'Intervention préventive (retour)', desc: "Intervention préventive contre le retour d’une fouine." },
    { label: 'Répulsif + fermeture des accès', desc: "Traitement répulsif et recommandations de fermeture des accès contre les fouines." },
    { label: 'Expertise — toiture', desc: "Expertise concernant une suspicion de présence de fouine dans la toiture." },
    { label: 'Expertise — combles', desc: "Expertise concernant une suspicion de présence de fouine dans les combles." },
    { label: 'Nuisances sonores', desc: "Intervention contre les nuisances sonores liées à la présence probable d’une fouine." },
    { label: 'Éloignement sans capture', desc: "Traitement professionnel visant à éloigner les fouines sans capture ni destruction de l’animal." }
  ] },
  { groupe: 'Blattes / cafards', nuisibles: ['Blattes', 'Cafards', 'Blattes germaniques', 'Blattes orientales', 'Blattes rayées'], items: [
    { label: 'Curatif — cuisine', desc: "Traitement curatif contre les blattes dans une cuisine." },
    { label: 'Curatif — appartement', desc: "Traitement curatif contre les blattes dans un appartement." },
    { label: 'Curatif — immeuble', desc: "Traitement curatif contre les blattes dans un immeuble." },
    { label: 'Cafards — gels professionnels', desc: "Traitement contre les cafards avec application de gels insecticides professionnels." },
    { label: 'Gel — zones de passage', desc: "Mise en place de gel professionnel contre les blattes dans les zones de passage." },
    { label: 'Gel — cuisines / plinthes / fissures', desc: "Application de gel insecticide professionnel dans les cuisines, plinthes, fissures et zones techniques." },
    { label: 'Rotation de gels (anti-résistance)', desc: "Traitement contre les blattes avec application de plusieurs gels professionnels afin de limiter les risques de résistance." },
    { label: 'Blattes germaniques — gel', desc: "Traitement contre les blattes germaniques avec gel insecticide professionnel." },
    { label: 'Blattes rayées — gel', desc: "Traitement contre les blattes rayées avec gel insecticide professionnel." },
    { label: 'Blattes orientales — gel', desc: "Traitement contre les blattes orientales avec gel insecticide professionnel." },
    { label: 'Monitoring blattes', desc: "Mise en place de dispositifs de monitoring contre les blattes." },
    { label: 'Pièges de contrôle', desc: "Pose de pièges de contrôle afin de suivre l’activité des blattes." },
    { label: 'Contrôle zones sensibles', desc: "Contrôle des zones sensibles : cuisine, salle de bain, local technique et gaines." },
    { label: 'Plinthes, fissures, meubles cuisine', desc: "Traitement des plinthes, fissures, meubles de cuisine et zones de refuge des blattes." },
    { label: 'Derrière les électroménagers', desc: "Traitement ciblé derrière les appareils électroménagers." },
    { label: 'Sous l\'évier / arrivées d\'eau', desc: "Traitement contre les blattes sous l’évier et autour des arrivées d’eau." },
    { label: 'Gaines techniques', desc: "Traitement contre les blattes dans les gaines techniques." },
    { label: 'Local poubelles', desc: "Traitement contre les blattes dans le local poubelles." },
    { label: 'Caves et sous-sols', desc: "Traitement contre les blattes dans les caves et sous-sols." },
    { label: 'Restaurant / local alimentaire', desc: "Traitement contre les blattes dans un restaurant ou local alimentaire." },
    { label: 'Vestiaires / locaux personnel', desc: "Traitement contre les blattes dans les vestiaires et locaux du personnel." },
    { label: 'Pulvérisation ciblée', desc: "Traitement contre les blattes avec pulvérisation ciblée d’un insecticide professionnel." },
    { label: 'Complémentaire (activité persistante)', desc: "Traitement complémentaire contre les blattes à la suite d’une activité persistante." },
    { label: 'Deuxième passage', desc: "Deuxième passage de traitement contre les blattes." },
    { label: 'Troisième passage', desc: "Troisième passage de traitement contre les blattes." },
    { label: 'Préventif — appartements voisins', desc: "Traitement préventif contre les blattes dans les appartements voisins." },
    { label: 'Préventif — parties communes', desc: "Traitement préventif contre les blattes dans les parties communes." },
    { label: 'Préventif — gaines immeuble', desc: "Traitement préventif contre les blattes dans les gaines techniques de l’immeuble." },
    { label: 'Contrôle activité (monitoring)', desc: "Contrôle de l’activité des blattes à l’aide de pièges de monitoring." },
    { label: 'Renforcement — ajout de gel', desc: "Renforcement du traitement contre les blattes avec ajout de gel professionnel." },
    { label: 'Complet — gel + monitoring + hygiène', desc: "Traitement complet contre les blattes avec gel insecticide, monitoring et recommandations d’hygiène." },
    { label: 'Cafards — gel + contrôle + suivi', desc: "Traitement professionnel contre les cafards avec application de gel, contrôle des zones infestées et suivi de l’activité." },
    { label: 'Infestation légère', desc: "Intervention contre une infestation légère de blattes." },
    { label: 'Infestation moyenne', desc: "Intervention contre une infestation moyenne de blattes." },
    { label: 'Infestation sévère', desc: "Intervention contre une infestation sévère de blattes." },
    { label: 'Curatif + préventif (zones à risque)', desc: "Traitement curatif et préventif contre les blattes dans l’ensemble des zones à risque." },
    { label: 'Inspection points d\'eau / zones chaudes', desc: "Traitement contre les blattes avec inspection des points d’eau, zones chaudes et zones sombres." },
    { label: 'Gel ciblé — refuge & passage', desc: "Application ciblée de gel professionnel dans les zones de refuge et de passage des blattes." },
    { label: 'Traitement pro (limiter développement)', desc: "Mise en place d’un traitement professionnel contre les blattes afin de limiter leur développement." },
    { label: 'Cafards — gels + monitoring + zones sensibles', desc: "Traitement contre les cafards comprenant application de gels professionnels, monitoring et contrôle des zones sensibles." }
  ] },
  { groupe: 'Fourmis charpentières', nuisibles: ['Fourmis', 'Fourmis charpentières'], items: [
    { label: 'Curatif — fourmis charpentières', desc: "Traitement curatif contre les fourmis charpentières." },
    { label: 'Inspection zones suspectées', desc: "Inspection des zones suspectées de présence de fourmis charpentières." },
    { label: 'Recherche nid principal & satellites', desc: "Recherche du nid principal et des colonies satellites de fourmis charpentières." },
    { label: 'Contrôle boiseries / poutres / zones humides', desc: "Contrôle des boiseries, poutres, plinthes et zones humides." },
    { label: 'Boiseries', desc: "Traitement contre les fourmis charpentières dans les boiseries." },
    { label: 'Poutres', desc: "Traitement contre les fourmis charpentières dans les poutres." },
    { label: 'Cloisons', desc: "Traitement contre les fourmis charpentières dans les cloisons." },
    { label: 'Plinthes et interstices', desc: "Traitement contre les fourmis charpentières dans les plinthes et interstices." },
    { label: 'Zones humides du bâtiment', desc: "Traitement contre les fourmis charpentières dans les zones humides du bâtiment." },
    { label: 'Zones de passage', desc: "Traitement ciblé des zones de passage des fourmis charpentières." },
    { label: 'Gel insecticide professionnel', desc: "Application d’un gel insecticide professionnel contre les fourmis charpentières." },
    { label: 'Appât insecticide professionnel', desc: "Mise en place d’un appât insecticide professionnel contre les fourmis charpentières." },
    { label: 'Appâtage — atteindre la colonie', desc: "Traitement par appâtage afin d’atteindre la colonie de fourmis charpentières." },
    { label: 'Élimination de la colonie', desc: "Traitement professionnel visant à éliminer la colonie de fourmis charpentières." },
    { label: 'Insecticide ciblé — zones de refuge', desc: "Application ciblée d’un insecticide professionnel dans les zones de refuge." },
    { label: 'Injection — cavités suspectées', desc: "Injection d’un produit insecticide professionnel dans les cavités suspectées." },
    { label: 'Injection — fissures / cloisons / zones creuses', desc: "Traitement par injection dans les fissures, cloisons et zones creuses." },
    { label: 'Passages dissimulés', desc: "Traitement des passages dissimulés utilisés par les fourmis charpentières." },
    { label: 'Zones boisées actives', desc: "Traitement des zones boisées présentant une activité de fourmis charpentières." },
    { label: 'Zones de nidification suspectées', desc: "Traitement des zones de nidification suspectées des fourmis charpentières." },
    { label: 'Complémentaire (activité persistante)', desc: "Traitement complémentaire contre les fourmis charpentières à la suite d’une activité persistante." },
    { label: 'Deuxième passage', desc: "Deuxième passage de traitement contre les fourmis charpentières." },
    { label: 'Troisième passage', desc: "Troisième passage de traitement contre les fourmis charpentières." },
    { label: 'Contrôle après traitement', desc: "Contrôle de l’activité après traitement contre les fourmis charpentières." },
    { label: 'Préventif — zones sensibles', desc: "Traitement préventif des zones sensibles contre les fourmis charpentières." },
    { label: 'Reco — suppression sources d\'humidité', desc: "Recommandation de suppression des sources d’humidité favorisant les fourmis charpentières." },
    { label: 'Reco — remplacement bois dégradés', desc: "Recommandation de remplacement des bois fortement dégradés ou humides." },
    { label: 'Pro — inspection + appâtage + ciblé', desc: "Traitement professionnel contre les fourmis charpentières avec inspection, appâtage et application ciblée." },
    { label: 'Infestation légère', desc: "Intervention contre une infestation légère de fourmis charpentières." },
    { label: 'Infestation moyenne', desc: "Intervention contre une infestation moyenne de fourmis charpentières." },
    { label: 'Infestation sévère', desc: "Intervention contre une infestation sévère de fourmis charpentières." },
    { label: 'Limiter progression dans la structure', desc: "Traitement des zones infestées afin de limiter la progression des fourmis charpentières dans la structure." },
    { label: 'Recherche sciures / galeries / indices', desc: "Recherche des sciures, galeries et indices de présence liés aux fourmis charpentières." },
    { label: 'Autour fenêtres / portes / plinthes / bois', desc: "Traitement ciblé autour des fenêtres, portes, plinthes et éléments boisés." },
    { label: 'Complet — inspection + nid + reco', desc: "Traitement complet contre les fourmis charpentières comprenant inspection, recherche du nid, application professionnelle et recommandations techniques." }
  ] },
  { groupe: 'Fourmis', nuisibles: ['Fourmis'], items: [
    { label: 'Curatif — fourmis', desc: "Traitement curatif contre les fourmis." },
    { label: 'Cuisine', desc: "Traitement contre les fourmis dans une cuisine." },
    { label: 'Appartement', desc: "Traitement contre les fourmis dans un appartement." },
    { label: 'Maison', desc: "Traitement contre les fourmis dans une maison." },
    { label: 'Salle de bain', desc: "Traitement contre les fourmis dans une salle de bain." },
    { label: 'Séjour', desc: "Traitement contre les fourmis dans un séjour." },
    { label: 'Chambres', desc: "Traitement contre les fourmis dans les chambres." },
    { label: 'Plinthes et fissures', desc: "Traitement contre les fourmis dans les plinthes et fissures." },
    { label: 'Autour portes et fenêtres', desc: "Traitement contre les fourmis autour des portes et fenêtres." },
    { label: 'Terrasse', desc: "Traitement contre les fourmis sur une terrasse." },
    { label: 'Jardin', desc: "Traitement contre les fourmis dans un jardin." },
    { label: 'Le long d\'une façade', desc: "Traitement contre les fourmis le long d’une façade." },
    { label: 'Intérieur et extérieur', desc: "Traitement contre les fourmis à l’intérieur et à l’extérieur du logement." },
    { label: 'Gel insecticide professionnel', desc: "Application d’un gel insecticide professionnel contre les fourmis." },
    { label: 'Appât insecticide professionnel', desc: "Mise en place d’un appât insecticide professionnel contre les fourmis." },
    { label: 'Appâtage — atteindre la colonie', desc: "Traitement par appâtage afin d’atteindre la colonie de fourmis." },
    { label: 'Zones de passage', desc: "Traitement ciblé des zones de passage des fourmis." },
    { label: 'Fissures / plinthes / seuils', desc: "Traitement des fissures, plinthes, seuils de porte et zones de passage." },
    { label: 'Pulvérisation ciblée', desc: "Pulvérisation ciblée d’un insecticide professionnel contre les fourmis." },
    { label: 'Injection — fissures / interstices', desc: "Injection d’un produit insecticide professionnel dans les fissures et interstices." },
    { label: 'Murs et cloisons', desc: "Traitement des fourmis dans les murs et cloisons." },
    { label: 'Sous parquet / derrière plinthes', desc: "Traitement des fourmis sous le parquet et derrière les plinthes." },
    { label: 'Fourmis noires (Lasius)', desc: "Traitement contre les fourmis noires de la famille des Lasius." },
    { label: 'Fourmis pharaon (appâtage spécifique)', desc: "Traitement contre les fourmis pharaon avec appâtage professionnel spécifique." },
    { label: 'Zones humides du bâtiment', desc: "Traitement contre les fourmis dans les zones humides du bâtiment." },
    { label: 'Préventif — zones sensibles', desc: "Traitement préventif contre les fourmis dans les zones sensibles." },
    { label: 'Complémentaire (activité persistante)', desc: "Traitement complémentaire contre les fourmis à la suite d’une activité persistante." },
    { label: 'Deuxième passage', desc: "Deuxième passage de traitement contre les fourmis." },
    { label: 'Troisième passage', desc: "Troisième passage de traitement contre les fourmis." },
    { label: 'Contrôle après traitement', desc: "Contrôle de l’activité des fourmis après traitement." },
    { label: 'Recherche points d\'entrée', desc: "Recherche des points d’entrée utilisés par les fourmis." },
    { label: 'Recherche fourmilière / nidification', desc: "Recherche de la fourmilière et des zones de nidification." },
    { label: 'Accès extérieurs', desc: "Traitement des accès extérieurs afin de limiter l’entrée des fourmis dans le logement." },
    { label: 'Pro — ciblé + recommandations', desc: "Traitement professionnel contre les fourmis avec application ciblée et recommandations préventives." },
    { label: 'Complet — inspection + appâtage + ciblé', desc: "Traitement complet contre les fourmis comprenant inspection, appâtage, pulvérisation ciblée et contrôle des zones de passage." }
  ] },
  { groupe: 'Frelons', nuisibles: ['Frelons', 'Frelons asiatiques'], items: [
    { label: 'Curatif — nid de frelons', desc: "Traitement curatif contre un nid de frelons." },
    { label: 'Destruction nid actif', desc: "Destruction d’un nid de frelons actif." },
    { label: 'Neutralisation — insecticide pro', desc: "Neutralisation d’un nid de frelons avec produit insecticide professionnel." },
    { label: 'Sous toiture', desc: "Traitement contre un nid de frelons situé sous toiture." },
    { label: 'Caisson de store', desc: "Traitement contre un nid de frelons situé dans un caisson de store." },
    { label: 'Façade', desc: "Traitement contre un nid de frelons situé dans une façade." },
    { label: 'Mur', desc: "Traitement contre un nid de frelons situé dans un mur." },
    { label: 'Cheminée', desc: "Traitement contre un nid de frelons situé dans une cheminée." },
    { label: 'Grenier', desc: "Traitement contre un nid de frelons situé dans un grenier." },
    { label: 'Combles', desc: "Traitement contre un nid de frelons situé dans des combles." },
    { label: 'Terrasse', desc: "Traitement contre un nid de frelons situé sur une terrasse." },
    { label: 'Jardin', desc: "Traitement contre un nid de frelons situé dans un jardin." },
    { label: 'Arbre', desc: "Traitement contre un nid de frelons situé dans un arbre." },
    { label: 'Haie', desc: "Traitement contre un nid de frelons situé dans une haie." },
    { label: 'Abri de jardin', desc: "Traitement contre un nid de frelons situé dans un abri de jardin." },
    { label: 'Cabanon', desc: "Traitement contre un nid de frelons situé dans un cabanon." },
    { label: 'Cavité', desc: "Traitement contre un nid de frelons situé dans une cavité." },
    { label: 'Faux plafond', desc: "Traitement contre un nid de frelons situé dans un faux plafond." },
    { label: 'Injection poudre insecticide', desc: "Traitement contre un nid de frelons par injection d’une poudre insecticide professionnelle." },
    { label: 'Pulvérisation insecticide', desc: "Traitement contre un nid de frelons par pulvérisation d’un insecticide professionnel." },
    { label: 'Application ciblée', desc: "Traitement contre un nid de frelons avec application ciblée d’un insecticide professionnel." },
    { label: 'Canne télescopique', desc: "Traitement d’un nid de frelons à l’aide d’une canne télescopique." },
    { label: 'Canne télescopique 3 m', desc: "Traitement d’un nid de frelons à l’aide d’une canne télescopique de 3 mètres." },
    { label: 'Canne télescopique 5 m', desc: "Traitement d’un nid de frelons à l’aide d’une canne télescopique de 5 mètres." },
    { label: 'Canne télescopique 7 m', desc: "Traitement d’un nid de frelons à l’aide d’une canne télescopique de 7 mètres." },
    { label: 'Canne télescopique 10 m', desc: "Traitement d’un nid de frelons à l’aide d’une canne télescopique de 10 mètres." },
    { label: 'Difficile d\'accès (sécurisé)', desc: "Intervention sécurisée contre un nid de frelons difficile d’accès." },
    { label: 'Frelons européens', desc: "Traitement contre un nid de frelons européens." },
    { label: 'Frelons asiatiques', desc: "Traitement contre un nid de frelons asiatiques." },
    { label: 'Nid primaire', desc: "Destruction d’un nid primaire de frelons." },
    { label: 'Nid secondaire', desc: "Destruction d’un nid secondaire de frelons." },
    { label: 'Avec équipement de protection', desc: "Traitement d’un nid de frelons avec équipement de protection professionnel." },
    { label: 'Contrôle après traitement', desc: "Contrôle de l’activité après traitement du nid de frelons." },
    { label: 'Retrait du nid après neutralisation', desc: "Retrait du nid de frelons après neutralisation, lorsque l’accès le permet." },
    { label: 'Pro — inspection + neutralisation + contrôle', desc: "Traitement professionnel contre les frelons comprenant inspection, neutralisation du nid et contrôle de l’activité." }
  ] }
];
// Construit les <optgroup> du sélecteur d'insertion de prestation.
// Si un nuisible est passé, on n'affiche QUE les groupes liés à ce nuisible
// (s'il en existe ; sinon on affiche tout pour rester utilisable).
// Groupes de prestations correspondant à une liste de nuisibles (1 ou 2)
function _prestaMatchGroups(nuisibles) {
  const sel = (Array.isArray(nuisibles) ? nuisibles : [nuisibles]).map(s => String(s || '').trim().toLowerCase()).filter(Boolean);
  if (!sel.length) return [];
  return BON_NOTE_PRESTATIONS.filter(g => (g.nuisibles || []).some(n => {
    const nn = String(n).toLowerCase();
    return sel.some(sn => nn === sn || sn.includes(nn) || nn.includes(sn));
  }));
}
function _bonNotePrestaOptions(nuisibles) {
  const m = _prestaMatchGroups(nuisibles);
  let groups = m.length ? m : BON_NOTE_PRESTATIONS;
  let html = '<option value="">➕ Insérer une prestation type…</option>';
  groups.forEach(g => {
    const realGi = BON_NOTE_PRESTATIONS.indexOf(g);   // index dans le tableau complet (pour l'insertion)
    html += `<optgroup label="${g.groupe}">` +
      g.items.map((it, ii) => `<option value="${realGi}-${ii}">${it.label}</option>`).join('') +
      '</optgroup>';
  });
  return html;
}
// Quand on change le nuisible concerné, on re-filtre la liste des prestations
function bonNoteNuisibleChanged() {
  const n1 = (($('bon-note-nuisible') || {}).value) || '';
  const n2 = (($('bon-note-nuisible2') || {}).value) || '';
  const selP = $('bon-note-presta');
  if (selP) selP.innerHTML = _bonNotePrestaOptions([n1, n2]);
}
// Insère la description complète de la prestation choisie dans la zone Remarques
function bonNoteInsertPresta(val, sel) {
  if (sel) sel.value = '';
  if (!val) return;
  const [gi, ii] = val.split('-').map(Number);
  const item = BON_NOTE_PRESTATIONS[gi] && BON_NOTE_PRESTATIONS[gi].items[ii];
  if (!item) return;
  const ta = $('bon-note-text'); if (!ta) return;
  const cur = (ta.value || '').trim();
  ta.value = (cur ? cur + '\n' : '') + item.desc;
  ta.focus();
}
// Types d'intervention
const BON_NOTE_TYPES_INTERV = [
  'Traitement guêpes',
  'Traitement frelons',
  'Traitement blattes',
  'Traitement punaises de lit',
  'Traitement mites alimentaires',
  'Traitement mites textiles',
  'Traitement poissons d\'argent',
  'Traitement fourmis',
  'Traitement rongeurs',
  'Dératisation',
  'Traitement souris',
  'Traitement rats',
  'Traitement fouines',
  'Traitement pigeons',
  'Traitement mouches',
  'Traitement insectes du bois',
  'Traitement capricornes',
  'Traitement vrillettes',
  'Traitement désinfection',
  'Inspection / diagnostic',
  'Contrôle après traitement',
  'Monitoring nuisibles'
];
// Liste à plat de tous les nuisibles (pour vérifier la présence)
function _bonNoteAllNuisibles() {
  return BON_NOTE_NUISIBLES.reduce((acc, g) => acc.concat(g.items), []);
}
// Construit les <optgroup> pour le sélecteur de nuisible
function _bonNoteNuisibleOptions(selected) {
  let html = '<option value="">— Aucun —</option>';
  BON_NOTE_NUISIBLES.forEach(g => {
    html += `<optgroup label="${g.groupe}">` +
      g.items.map(it => `<option value="${it.replace(/"/g,'&quot;')}" ${selected === it ? 'selected' : ''}>${it}</option>`).join('') +
      '</optgroup>';
  });
  // Conserve une ancienne valeur hors liste
  if (selected && _bonNoteAllNuisibles().indexOf(selected) === -1) {
    html += `<option value="${selected.replace(/"/g,'&quot;')}" selected>${selected}</option>`;
  }
  return html;
}
// La note est désormais un objet structuré {statut, prixHT, rabais, tva, texte}
// sérialisé en JSON dans le marqueur [NOTE:...]. Rétro-compatible : une ancienne
// note en texte brut est lue comme { texte: "..." }.
function _bonNoteData(b) {
  const raw = (typeof b === 'string') ? b : _bonNote(b);
  const base = { statut: '', nuisible: '', nuisible2: '', typeInterv: '', prixHT: '', rabais: '', tva: '', texte: '' };
  if (!raw) return base;
  const s = raw.trim();
  if (s.charAt(0) === '{') {
    try {
      const o = JSON.parse(s);
      return {
        statut: o.statut || '', nuisible: o.nuisible || '', nuisible2: o.nuisible2 || '', typeInterv: o.typeInterv || '',
        prixHT: (o.prixHT != null ? o.prixHT : ''),
        rabais: (o.rabais != null ? o.rabais : ''), tva: (o.tva != null ? o.tva : ''),
        texte: o.texte || ''
      };
    } catch (e) { /* pas du JSON → texte brut */ }
  }
  base.texte = raw;
  return base;
}
function _bonNoteHasData(d) {
  return !!(d && (d.statut || d.nuisible || d.nuisible2 || d.typeInterv || (d.prixHT !== '' && d.prixHT != null) || (d.texte || '').trim()));
}
// Calcule les montants dérivés (rabais, HT net, TVA, TTC) à partir des champs saisis
function _bonNoteCalc(d) {
  const ht = parseFloat(d.prixHT) || 0;
  const rab = parseFloat(d.rabais) || 0;
  const tva = parseFloat(d.tva) || 0;
  const montantRabais = ht * rab / 100;
  const htNet = ht - montantRabais;
  const montantTVA = htNet * tva / 100;
  const ttc = htNet + montantTVA;
  return { ht, rab, tva, montantRabais, htNet, montantTVA, ttc };
}
// Rendu lisible (multi-lignes) de la note pour affichage carte / bandeau devis
function _bonNoteText(d) {
  let datesInterv = [];
  if (typeof d === 'string' || (d && d.probleme !== undefined)) {
    if (d && d.probleme !== undefined) datesInterv = _bonDatesInterv(d);
    d = _bonNoteData(d);
  }
  if (!d) return '';
  const lines = [];
  if (d.statut) lines.push('Statut : ' + d.statut);
  if (d.nuisible) lines.push('Nuisible : ' + d.nuisible + (d.nuisible2 ? ' + ' + d.nuisible2 : ''));
  if (d.typeInterv) lines.push('Type d\'intervention : ' + d.typeInterv);
  if (datesInterv.length) lines.push('Dates d\'intervention : ' + datesInterv.map(fmtDate).join(', '));
  if (d.prixHT !== '' && d.prixHT != null) {
    const c = _bonNoteCalc(d);
    lines.push('Prix HT : ' + _displayMontant(c.ht) + ' CHF');
    if (c.rab) lines.push('Rabais : ' + c.rab + ' % (− ' + _displayMontant(c.montantRabais) + ' CHF)');
    if (c.rab) lines.push('Prix HT après rabais : ' + _displayMontant(c.htNet) + ' CHF');
    lines.push('TVA : ' + c.tva + ' % (' + _displayMontant(c.montantTVA) + ' CHF)');
    lines.push('Prix TTC : ' + _displayMontant(c.ttc) + ' CHF');
  }
  if ((d.texte || '').trim()) {
    if (lines.length) lines.push('');
    lines.push(d.texte.trim());
  }
  return lines.join('\n');
}
// Indique si le rapport de ce bon a été marqué "fait" (coche verte)
function _bonRapFait(b) {
  return /\[RAPFAIT:1\]/.test(String((b && b.probleme) || ''));
}
// Bon MANUEL (« BM ») : créé à la main pour une gérance qui ne fournit aucun bon.
// Reconnaissable à son numéro « BCM 10-NNN » et/ou à l'absence de PDF scanné.
function _isBonManuel(b) {
  if (!b) return false;
  return /^BCM\s*10-/i.test(String(b.numero || '')) || !b.pdfPath;
}
// Horodatage de mise en statut "À contacter / Urgent" (pour l'alerte 48 h), stocké via marqueur
function _bonAlerte(b) {
  const m = String((b && b.probleme) || '').match(/\[ALERTE:([^\]]*)\]/);
  return m ? m[1].trim() : '';
}
// Heures écoulées depuis l'horodatage d'alerte (ou null si pas d'alerte)
function _bonAlerteHeures(b) {
  const t = _bonAlerte(b); if (!t) return null;
  const d = new Date(t); if (isNaN(d.getTime())) return null;
  return (Date.now() - d.getTime()) / 3600000;
}
function _bonProblemeClean(b) {
  return String((b && b.probleme) || '')
    .replace(/\s*\[INTERV:[^\]]*\]/g, '')
    .replace(/\s*\[AFFECTE:[^\]]*\]/g, '')
    .replace(/\s*\[NOTE:[^\]]*\]/g, '')
    .replace(/\s*\[RAPFAIT:[^\]]*\]/g, '')
    .replace(/\s*\[ALERTE:[^\]]*\]/g, '')
    .replace(/\s*\[COLOR:[^\]]*\]/g, '')
    .trim();
}
// Couleur de fond personnalisée du bon (marqueur [COLOR:#hex] dans probleme). Vide = couleur auto (gérance).
function _bonColor(b) {
  const m = String((b && b.probleme) || '').match(/\[COLOR:(#[0-9a-fA-F]{3,8})\]/);
  return m ? m[1] : '';
}
// Réassemble la chaîne "probleme" : texte propre + marqueurs (dates, affecté, note, rapport fait, alerte).
// Source unique de vérité pour ne jamais perdre un marqueur lors d'une modif.
function _bonAssembleProbleme(clean, dates, aff, note, rapFait, alerte, color) {
  let out = String(clean || '').trim();
  const arr = (dates || []).map(s => String(s || '').trim()).filter(Boolean);
  if (arr.length) out += (out ? '\n' : '') + '[INTERV:' + arr.join(',') + ']';
  if (aff) out += (out ? '\n' : '') + '[AFFECTE:' + aff + ']';
  if (note && String(note).trim()) out += (out ? '\n' : '') + '[NOTE:' + _encNote(note) + ']';
  if (rapFait) out += (out ? '\n' : '') + '[RAPFAIT:1]';
  if (alerte) out += (out ? '\n' : '') + '[ALERTE:' + alerte + ']';
  if (color) out += (out ? '\n' : '') + '[COLOR:' + color + ']';
  return out;
}
// Réécrit probleme propre + tous les marqueurs existants
function _bonComposeProbleme(b) {
  return _bonAssembleProbleme(_bonProblemeClean(b), _bonDatesInterv(b), _bonAffecte(b), _bonNote(b), _bonRapFait(b), _bonAlerte(b), _bonColor(b));
}
function _setBonDatesInterv(b, dates) {
  const arr = (dates || []).map(s => String(s||'').trim()).filter(Boolean).slice(0, 5).sort();
  b.probleme = _bonAssembleProbleme(_bonProblemeClean(b), arr, _bonAffecte(b), _bonNote(b), _bonRapFait(b), _bonAlerte(b), _bonColor(b));
}
// Affecte un technicien à un bon
function bonSetAffecte(id, value) {
  const b = (DB.bons || []).find(x => x.id === id); if (!b) return;
  b.probleme = _bonAssembleProbleme(_bonProblemeClean(b), _bonDatesInterv(b), value, _bonNote(b), _bonRapFait(b), _bonAlerte(b), _bonColor(b));
  const bons = DB.bons; DB.bons = bons;
  renderBons();
  toast(value ? ('Affecté à ' + value) : 'Affectation retirée', '#2d9e6b');
}
// Enregistre/efface la note interne d'un bon
function bonSetNote(id, text) {
  const b = (DB.bons || []).find(x => x.id === id); if (!b) return;
  b.probleme = _bonAssembleProbleme(_bonProblemeClean(b), _bonDatesInterv(b), _bonAffecte(b), text, _bonRapFait(b), _bonAlerte(b), _bonColor(b));
  const bons = DB.bons; DB.bons = bons;
}
// Coche/décoche "rapport fait" pour un bon (suivi visuel, sans toucher au statut)
function bonToggleRapFait(id) {
  const b = (DB.bons || []).find(x => x.id === id); if (!b) return;
  const nv = !_bonRapFait(b);
  b.probleme = _bonAssembleProbleme(_bonProblemeClean(b), _bonDatesInterv(b), _bonAffecte(b), _bonNote(b), nv, _bonAlerte(b), _bonColor(b));
  const bons = DB.bons; DB.bons = bons;
  renderBons();
  toast(nv ? '✓ Rapport marqué comme fait' : 'Coche retirée', '#2d9e6b');
}
// Couleur de fond personnalisée de la carte du bon (vide = couleur auto de la gérance)
function bonSetColor(id, color) {
  const b = (DB.bons || []).find(x => x.id === id); if (!b) return;
  b.probleme = _bonAssembleProbleme(_bonProblemeClean(b), _bonDatesInterv(b), _bonAffecte(b), _bonNote(b), _bonRapFait(b), _bonAlerte(b), color || '');
  const bons = DB.bons; DB.bons = bons;
  renderBons();
  toast(color ? '🎨 Couleur du bon modifiée' : '↺ Couleur automatique (gérance) rétablie', '#2d9e6b');
}

// --- Modale Note interne d'un bon ---
let _bonNoteEditingId = null;
function openBonNote(id) {
  const b = (DB.bons || []).find(x => x.id === id); if (!b) { toast('Bon introuvable', '#e63946'); return; }
  _bonNoteEditingId = id;
  const d = _bonNoteData(b);
  // Remplit le sélecteur de statut
  const sel = $('bon-note-statut');
  if (sel) {
    sel.innerHTML = '<option value="">— Aucun —</option>' +
      BON_NOTE_STATUTS.map(s => `<option value="${s}" ${d.statut === s ? 'selected' : ''}>${s}</option>`).join('') +
      // Conserve un ancien statut qui ne serait plus dans la liste
      ((d.statut && BON_NOTE_STATUTS.indexOf(d.statut) === -1) ? `<option value="${(d.statut||'').replace(/"/g,'&quot;')}" selected>${d.statut}</option>` : '');
  }
  // Nuisible (avec optgroups par catégorie) — deux sélecteurs possibles
  const selN = $('bon-note-nuisible');
  if (selN) selN.innerHTML = _bonNoteNuisibleOptions(d.nuisible);
  const selN2 = $('bon-note-nuisible2');
  if (selN2) selN2.innerHTML = _bonNoteNuisibleOptions(d.nuisible2);
  // Type d'intervention
  const selT = $('bon-note-type');
  if (selT) {
    selT.innerHTML = '<option value="">— Aucun —</option>' +
      BON_NOTE_TYPES_INTERV.map(t => `<option value="${t}" ${d.typeInterv === t ? 'selected' : ''}>${t}</option>`).join('') +
      ((d.typeInterv && BON_NOTE_TYPES_INTERV.indexOf(d.typeInterv) === -1) ? `<option value="${(d.typeInterv||'').replace(/"/g,'&quot;')}" selected>${d.typeInterv}</option>` : '');
  }
  // Champs de calcul (rabais 5 % et TVA 8.1 % par défaut si vides)
  const dfltTva = (DERATEK_CONFIG && DERATEK_CONFIG.company && DERATEK_CONFIG.company.tvaTaux) || 8.1;
  const setF = (eid, v) => { const el = $(eid); if (el) el.value = (v === '' || v == null) ? '' : v; };
  setF('bon-note-ht', d.prixHT);
  setF('bon-note-rabais', (d.prixHT !== '' && (d.rabais === '' || d.rabais == null)) ? 5 : (d.rabais === '' ? '' : d.rabais));
  setF('bon-note-tva', (d.prixHT !== '' && (d.tva === '' || d.tva == null)) ? dfltTva : (d.tva === '' ? '' : d.tva));
  // Si rien encore saisi, on pré-remplit rabais/TVA par défaut pour faciliter
  if (d.prixHT === '' || d.prixHT == null) {
    if ($('bon-note-rabais') && !$('bon-note-rabais').value) $('bon-note-rabais').value = 5;
    if ($('bon-note-tva') && !$('bon-note-tva').value) $('bon-note-tva').value = dfltTva;
  }
  const ta = $('bon-note-text'); if (ta) ta.value = d.texte || '';
  const selP = $('bon-note-presta'); if (selP) selP.innerHTML = _bonNotePrestaOptions([d.nuisible, d.nuisible2]);
  const titre = $('bon-note-bon'); if (titre) titre.textContent = b.numero || '';
  const st = $('bon-note-status'); if (st) st.textContent = '';
  bonNoteRecalc();
  openModal('modal-bon-note');
  if (sel) setTimeout(() => sel.focus(), 50);
}
// Recalcule et affiche montant du rabais, HT après rabais, TVA et TTC en direct
function bonNoteRecalc() {
  const ht = parseFloat(($('bon-note-ht') || {}).value) || 0;
  const rab = parseFloat(($('bon-note-rabais') || {}).value) || 0;
  const tva = parseFloat(($('bon-note-tva') || {}).value) || 0;
  const montantRabais = ht * rab / 100;
  const htNet = ht - montantRabais;
  const montantTVA = htNet * tva / 100;
  const ttc = htNet + montantTVA;
  const put = (eid, v) => { const el = $(eid); if (el) el.textContent = _displayMontant(v) + ' CHF'; };
  put('bon-note-rabais-montant', montantRabais);
  put('bon-note-htnet', htNet);
  put('bon-note-tva-montant', montantTVA);
  put('bon-note-ttc', ttc);
}
function saveBonNote() {
  if (!_bonNoteEditingId) { closeModal('modal-bon-note'); return; }
  const val = eid => { const el = $(eid); return el ? el.value : ''; };
  const htRaw = (val('bon-note-ht') || '').trim();
  const data = {
    statut: val('bon-note-statut') || '',
    nuisible: val('bon-note-nuisible') || '',
    nuisible2: val('bon-note-nuisible2') || '',
    typeInterv: val('bon-note-type') || '',
    prixHT: htRaw === '' ? '' : (parseFloat(htRaw) || 0),
    rabais: htRaw === '' ? '' : (parseFloat(val('bon-note-rabais')) || 0),
    tva: htRaw === '' ? '' : (parseFloat(val('bon-note-tva')) || 0),
    texte: (val('bon-note-text') || '').trim()
  };
  const payload = _bonNoteHasData(data) ? JSON.stringify(data) : '';
  bonSetNote(_bonNoteEditingId, payload);
  renderBons();
  closeModal('modal-bon-note');
  toast(payload ? '✓ Note enregistrée' : 'Note effacée', '#2d9e6b');
  _bonNoteEditingId = null;
}
// Corrige et structure la note via Mistral (orthographe + mise en forme prix/traitement)
async function bonNoteAICorrect() {
  const ta = $('bon-note-text'); if (!ta) return;
  const txt = (ta.value || '').trim();
  const st = $('bon-note-status');
  const btn = $('bon-note-ai-btn');
  if (!txt) { if (st) st.textContent = '✍️ Écris d\'abord quelques mots à corriger.'; return; }
  if (!(DERATEK_CONFIG && DERATEK_CONFIG.mistral && DERATEK_CONFIG.mistral.apiKey)) {
    if (st) st.textContent = '⚠️ Clé Mistral non configurée.'; return;
  }
  if (btn) btn.disabled = true;
  if (st) st.textContent = '🤖 Correction en cours…';
  try {
    const systemPrompt =
      "Tu es l'assistant d'une entreprise suisse d'antinuisibles (DERATEK). " +
      "On te donne une note interne brute servant à préparer une facture. " +
      "Corrige l'orthographe et la grammaire, et structure proprement le contenu. " +
      "CONSERVE toutes les informations chiffrées telles quelles : prix en CHF, quantités, dates, type de traitement, produits. " +
      "N'invente AUCUN prix ni information absente. N'ajoute pas de TVA ni de total si non fournis. " +
      "Reste concis et factuel. Réponds UNIQUEMENT par la note corrigée (texte simple, sans Markdown, sans préambule ni commentaire).";
    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DERATEK_CONFIG.mistral.apiKey },
      body: JSON.stringify({
        model: DERATEK_CONFIG.mistral.model, max_tokens: 800, temperature: 0,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: txt }]
      })
    });
    if (!response.ok) { let m = 'API ' + response.status; try { const e = await response.json(); m = (e.error && e.error.message) || m; } catch (e) {} throw new Error(m); }
    const data = await response.json();
    let raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!raw) throw new Error('Réponse IA vide');
    raw = raw.replace(/```[a-z]*/gi, '').replace(/```/g, '').trim();
    ta.value = raw;
    if (st) st.textContent = '✓ Corrigé par l\'IA. Vérifie puis enregistre.';
  } catch (err) {
    console.error('Note IA error:', err);
    if (st) st.textContent = '⚠️ Erreur IA : ' + err.message;
  } finally {
    if (btn) btn.disabled = false;
  }
}
// Ajoute/retire une date d'intervention effectuée sur un bon (max 5)
function bonAddDateEffectuee(id) {
  const b = (DB.bons || []).find(x => x.id === id); if (!b) return;
  const dates = _bonDatesInterv(b);
  if (dates.length >= 5) { toast('Maximum 5 dates d\'intervention', '#e63946'); return; }
  dates.push(today());
  const bons = DB.bons; _setBonDatesInterv(b, dates); DB.bons = bons;
  renderBons();
}
function bonSetDateEffectuee(id, index, value) {
  const b = (DB.bons || []).find(x => x.id === id); if (!b) return;
  const dates = _bonDatesInterv(b);
  if (value) dates[index] = value; else dates.splice(index, 1);
  const bons = DB.bons; _setBonDatesInterv(b, dates); DB.bons = bons;
  renderBons();
}

// Met à jour les compteurs de TOUS les boutons de navigation
function updateBonsCounts() { updateNavCounts(); }
function updateNavCounts() {
  let nA = 0, nE = 0, nT = 0;
  (DB.bons || []).forEach(b => {
    if (_isBonFactArchived(b)) return; // parti dans facturation archivée
    const s = b.statut || '';
    if (s === 'termine') nT++;
    else if (s === 'en-cours') nE++;
    else if (s === 'demande-devis') { /* comptés dans le bouton Devis (« à deviser »), pas dans Bons actifs — cohérent avec la liste */ }
    else nA++;
  });
  const docs = DB.documents || [];
  const nDevisDocs = docs.filter(d => (d.type || 'devis') === 'devis' && !_docIsArchive(d)).length;
  // Bons en demande de devis (en attente) sans devis encore créé
  const nDevisAttente = (DB.bons || []).filter(b =>
    (b.statut || '') === 'demande-devis' &&
    !docs.some(x => ((x.type || 'devis') === 'devis') && x.bonId === b.id)
  ).length;
  const nDevis = nDevisDocs + nDevisAttente;
  const nFact  = docs.filter(d => d.type === 'facture' && !_docIsArchive(d) && !_isFactureFactArchived(d) && !_isRappelDoc(d) && !_isAncienneFacture(d)).length;
  const nAnc   = docs.filter(d => _isAncienneFacture(d) && d.statut !== 'payee').length;   // anciennes factures à encaisser
  const nRapports = (DB.rapports || []).filter(r => !_isRapportFactArchived(r)).length;
  const nFactArchive = _factArchiveSets().length;
  const set = (id, n) => { const el = $(id); if (el) el.textContent = n; };
  set('nb-bons-count', nA);
  set('nb-bons-encours-count', nE);
  set('nb-bons-termines-count', nT);
  set('nb-devis-count', nDevis);
  set('nb-factures-count', nFact);
  set('nb-anciennes-count', nAnc);
  set('nb-fact-archive-count', nFactArchive);
  set('nb-rapports-count', nRapports);
  set('nb-clients-count', (DB.clients || []).length);
  set('nb-locataires-count', (DB.locataires || []).length);
  set('nb-fournisseurs-count', (DB.fournisseurs || []).length);
}

// Carte complète d'un bon (réutilisée dans l'écran Bons ET dans la section
// "Bons en demande de devis" de l'écran Devis) — source unique de vérité.
function renderBonCard(b, solid) {
  const g = _geranceCanon(b.geranceNom) || '(Sans gérance)';
  const customColor = _bonColor(b);                 // couleur choisie manuellement (ou vide)
  const gerColor = colorForGeranceName(g);          // couleur de la gérance
  const gColor = customColor || gerColor;
  const fillSolid = (solid === true);               // fond plein (onglet « Bons ») ou clair (en cours, terminés…)
  // Dans les autres onglets (En cours, Terminés…), on reprend la couleur de la GÉRANCE (pas la couleur perso).
  const displayColor = fillSolid ? gColor : gerColor;
  const loc = (b.locataireId && (DB.locataires||[]).find(l => l.id === b.locataireId))
           || (b.locataireNom && (DB.locataires||[]).find(l => (l.nom||'').toLowerCase() === (b.locataireNom||'').toLowerCase()))
           || null;
  const locTel     = loc ? (loc.tel || '')     : '';
  const locAdresse = loc ? (loc.adresse || '') : (b.immeuble || '');
  const cli = (b.geranceId && (DB.clients||[]).find(c => c.id === b.geranceId))
           || (b.geranceNom && (DB.clients||[]).find(c => (c.nom||'').toLowerCase() === (b.geranceNom||'').toLowerCase()))
           || null;
  const gerantNom = b.gerantNom || (cli ? _rapContactNom(cli.contact) : '');
  const gerantTel = b.gerantTel || (cli ? (cli.tel || '') : '');
  const statut = b.statut || '';
  const statutStyles = {
    '':              { bg: '#f3f4f6', color: '#6b7280', border: '#d1d5db' },
    'urgent':        { bg: '#dc2626', color: '#ffffff', border: '#b91c1c' }, // rouge PLEIN (toujours)
    'a-contacter':   { bg: '#cffafe', color: '#0e7490', border: '#06b6d4' }, // cyan
    'a-transmettre': { bg: '#fca5a5', color: '#7f1d1d', border: '#dc2626' },
    'transmis':      { bg: '#dbeafe', color: '#1d4ed8', border: '#3b82f6' },
    'demande-devis': { bg: '#e0e7ff', color: '#3730a3', border: '#6366f1' },
    'attente-devis': { bg: '#ede9fe', color: '#6d28d9', border: '#8b5cf6' },
    'devis-valide':  { bg: '#ccfbf1', color: '#0f766e', border: '#14b8a6' },
    'en-cours':      { bg: '#fed7aa', color: '#9a3412', border: '#f97316' },
    'termine':       { bg: '#bbf7d0', color: '#166534', border: '#22c55e' },
    'a-facturer':    { bg: '#fecaca', color: '#991b1b', border: '#ef4444' },
  };
  const stStyle = statutStyles[statut] || statutStyles[''];
  // Fond PLEIN (onglet « Bons ») → texte auto-contrasté ; sinon fond CLAIR → texte foncé normal.
  const _lum = (h => { const m = String(h||'').replace('#','').match(/^([0-9a-f]{6})$/i); if(!m) return 1; const n=parseInt(m[1],16); return 0.2126*((n>>16&255)/255)+0.7152*((n>>8&255)/255)+0.0722*((n&255)/255); })(displayColor);
  const _dark = _lum < 0.62;
  const bg         = fillSolid ? displayColor : _hexTint(displayColor, 0.12);
  const borderCard = fillSolid ? 'rgba(0,0,0,.12)' : _hexTint(displayColor, 0.30);
  const borderLeft = fillSolid ? (_dark ? 'rgba(255,255,255,.55)' : 'rgba(0,0,0,.28)') : displayColor;
  const T  = fillSolid ? (_dark ? '#ffffff' : '#0d1b3e') : '#0d1b3e';
  const TL = fillSolid ? (_dark ? 'rgba(255,255,255,.72)' : '#475569') : '#64748b';
  const T2 = fillSolid ? (_dark ? 'rgba(255,255,255,.9)' : '#334155') : '#475569';
  const dateCol  = fillSolid ? (_dark ? '#ffdada' : '#b91c1c') : '#e63946';
  const iconBg   = fillSolid ? (_dark ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.08)') : displayColor;
  const iconCol  = fillSolid ? T : '#ffffff';
  return `
            <div id="bonrow-${b.id}" style="display:flex;align-items:stretch;gap:14px;background:${bg};color:${T};border:1px solid ${borderCard};border-left:6px solid ${borderLeft};border-radius:8px;padding:10px 14px;box-shadow:0 1px 2px rgba(0,0,0,.04);flex-wrap:wrap;transition:box-shadow .3s;">
              <div style="display:flex;align-items:center;gap:10px;min-width:130px;">
                <div style="width:34px;height:34px;border-radius:50%;background:${iconBg};color:${iconCol};display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;">📄</div>
                <div>
                  <div style="font-size:13px;font-weight:800;color:${T};line-height:1.2;">Bon ${b.numero || '(s. n°)'}</div>
                  <div style="font-size:12px;color:${dateCol};font-weight:600;">📅 ${fmtDate(b.date) || '—'}</div>
                </div>
              </div>
              <div style="flex:1;min-width:130px;">
                <div style="font-size:10px;color:${TL};text-transform:uppercase;font-weight:700;letter-spacing:.3px;">🏢 Gérance</div>
                <div style="font-size:12px;font-weight:600;color:${T};">${g}</div>
              </div>
              <div style="flex:1;min-width:130px;">
                <div style="font-size:10px;color:${TL};text-transform:uppercase;font-weight:700;letter-spacing:.3px;">👤 Gérant</div>
                <div style="font-size:12px;">${gerantNom || '—'}</div>
                ${gerantTel ? `<div style="font-size:11px;color:${T2};">📞 ${gerantTel}</div>` : ''}
              </div>
              <div style="flex:1.2;min-width:150px;">
                <div style="font-size:10px;color:${TL};text-transform:uppercase;font-weight:700;letter-spacing:.3px;">🏠 Locataire</div>
                <div style="font-size:12px;">${b.locataireNom || '—'}</div>
                ${locTel ? `<div style="font-size:11px;color:${T2};">📞 ${locTel}</div>` : ''}
              </div>
              <div style="flex:1.4;min-width:170px;">
                <div style="font-size:10px;color:${TL};text-transform:uppercase;font-weight:700;letter-spacing:.3px;">📍 Adresse</div>
                <div style="font-size:12px;color:${T2};">${locAdresse || '—'}</div>
              </div>
              <div style="flex:1.6;min-width:180px;">
                <div style="font-size:10px;color:${TL};text-transform:uppercase;font-weight:700;letter-spacing:.3px;">🐛 Nuisible / problème</div>
                <div style="font-size:12px;color:${T2};">${_bonProblemeClean(b) || '—'}</div>
              </div>
              <div style="display:flex;flex-direction:column;gap:3px;align-items:flex-start;flex-shrink:0;min-width:170px;">
                <div style="font-size:10px;color:${TL};text-transform:uppercase;font-weight:700;">📅 Prochaine interv.</div>
                <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">
                  <input type="date" value="${b.dateIntervention||''}" onchange="updateBonDateInterv('${b.id}', this.value)" style="font-family:Arial;font-size:12px;font-weight:bold;color:#e63946;padding:4px 6px;border-radius:6px;border:1.5px solid #e63946;">
                  <input type="time" value="${b.heureIntervention||''}" onchange="updateBonHeureInterv('${b.id}', this.value)" style="font-family:Arial;font-size:12px;font-weight:bold;color:#e63946;padding:4px 6px;border-radius:6px;border:1.5px solid #e63946;width:78px;">
                  <button class="btn btn-ghost btn-xs" onclick="addBonToGoogle('${b.id}')" title="Ajouter à Google Agenda">📅</button>
                </div>
              </div>
              <div style="display:flex;flex-direction:column;gap:3px;align-items:flex-start;flex-shrink:0;min-width:155px;">
                <div style="font-size:10px;color:${TL};text-transform:uppercase;font-weight:700;">✅ Interventions effectuées</div>
                <div style="display:flex;flex-direction:column;gap:3px;">
                  ${(() => {
                    const ds = _bonDatesInterv(b);
                    let html = ds.map((d, i) => `<div style="display:flex;gap:3px;align-items:center;">
                      <input type="date" value="${d}" onchange="bonSetDateEffectuee('${b.id}', ${i}, this.value)" style="font-family:Arial;font-size:11px;font-weight:bold;color:#166534;padding:3px 5px;border-radius:6px;border:1.5px solid #22c55e;">
                      <button class="btn btn-ghost btn-xs" style="color:#b00;padding:1px 5px;" onclick="bonSetDateEffectuee('${b.id}', ${i}, '')" title="Retirer">✕</button>
                    </div>`).join('');
                    if (ds.length < 5) html += `<button class="btn btn-ghost btn-xs" style="color:#166534;" onclick="bonAddDateEffectuee('${b.id}')" title="Ajouter une date d'intervention effectuée">+ Ajouter (${ds.length}/5)</button>`;
                    else html += `<div style="font-size:10px;color:${TL};">5/5 (max)</div>`;
                    return html;
                  })()}
                </div>
              </div>
              <div style="display:flex;flex-direction:column;gap:3px;align-items:flex-start;flex-shrink:0;min-width:140px;">
                <div style="font-size:10px;color:${TL};text-transform:uppercase;font-weight:700;">👷 Affecté à</div>
                ${(() => {
                  const aff = _bonAffecte(b);
                  const techs = (DB.techs || []);
                  const opts = ['<option value="">— Personne —</option>']
                    .concat(techs.map(t => `<option value="${(t||'').replace(/"/g,'&quot;')}" ${aff===t?'selected':''}>${t}</option>`));
                  if (aff && !techs.includes(aff)) opts.push(`<option value="${aff.replace(/"/g,'&quot;')}" selected>${aff}</option>`);
                  return `<select onchange="bonSetAffecte('${b.id}', this.value)" title="Technicien / responsable affecté" style="font-size:11px;font-weight:700;padding:5px 7px;border-radius:6px;border:1.5px solid ${aff?'#2563eb':'#d1d5db'};background:${aff?'#eff6ff':'#fff'};color:${aff?'#1d4ed8':'#6b7280'};cursor:pointer;max-width:135px;">${opts.join('')}</select>`;
                })()}
              </div>
              <div style="display:flex;gap:6px;align-items:center;flex-shrink:0;flex-wrap:wrap;">
                ${(() => {
                  const h = _bonAlerteHeures(b);
                  if ((statut === 'a-contacter' || statut === 'urgent') && h !== null && h >= 48) {
                    const lbl = statut === 'urgent' ? '🚨 URGENT' : '📞 À CONTACTER';
                    const retard = Math.floor((h - 48) / 24);   // jours de retard au-delà du délai de 48 h
                    const suffix = retard >= 1 ? ('+' + retard + ' jour' + (retard > 1 ? 's' : '') + ' de retard') : '+48 h';
                    return `<span title="En statut « ${lbl} » depuis plus de 48 h${retard >= 1 ? (' — ' + retard + ' jour(s) de retard au-delà du délai') : ''}" style="font-size:11px;font-weight:800;color:#fff;background:#dc2626;border-radius:6px;padding:4px 9px;">⚠️ ${lbl} · ${suffix}</span>`;
                  }
                  return '';
                })()}
                <select onchange="updateBonStatut('${b.id}', this.value)" title="Statut du bon" style="font-size:11px;font-weight:700;padding:6px 8px;border-radius:6px;border:1.5px solid ${stStyle.border};background:${stStyle.bg};color:${stStyle.color};cursor:pointer;">
                  <option value="">— Statut —</option>
                  <option value="urgent"        ${statut === 'urgent'        ? 'selected' : ''}>🚨 Urgent (alerte 48 h)</option>
                  <option value="a-contacter"   ${statut === 'a-contacter'   ? 'selected' : ''}>📞 À contacter (alerte 48 h)</option>
                  <option value="a-transmettre" ${statut === 'a-transmettre' ? 'selected' : ''}>📕 Rapport à transmettre</option>
                  <option value="transmis"      ${statut === 'transmis'      ? 'selected' : ''}>📨 Rapport transmis</option>
                  <option value="demande-devis" ${statut === 'demande-devis' ? 'selected' : ''}>📝 Demande de devis</option>
                  <option value="attente-devis" ${statut === 'attente-devis' ? 'selected' : ''}>⏸️ Attente de devis</option>
                  <option value="devis-valide"  ${statut === 'devis-valide'  ? 'selected' : ''}>✍️ Devis validé</option>
                  <option value="en-cours"      ${statut === 'en-cours'      ? 'selected' : ''}>⏳ En cours de traitement</option>
                  <option value="termine"       ${statut === 'termine'       ? 'selected' : ''}>✅ Travail terminé</option>
                  <option value="a-facturer"    ${statut === 'a-facturer'    ? 'selected' : ''}>🧾 À facturer</option>
                </select>
                ${b.pdfPath ? `<button class="btn btn-ghost btn-sm" onclick="viewBonPdf('${b.id}')" onmouseenter="bonPdfPreview('${b.id}', this)" onmouseleave="bonPdfPreviewHide()" title="Survol = aperçu · Clic = ouvrir dans un nouvel onglet">📎 PDF</button>`
                  : `<button class="btn btn-ghost btn-sm" onclick="generateBonPDF('${b.id}')" title="Générer un PDF imprimable de ce bon manuel">🖨 PDF</button>`}
                ${(() => {
                  const hasNote = _bonNoteHasData(_bonNoteData(b));
                  return `<button class="btn btn-sm" onclick="openBonNote('${b.id}')" title="${hasNote ? 'Note interne (statut, prix, traitement…) — cliquer pour modifier' : 'Ajouter une note interne (statut, calcul de prix, remarques…) pour la facturation'}" style="font-weight:700;border:1.5px solid ${hasNote ? '#d97706' : '#d1d5db'};background:${hasNote ? '#fffbeb' : '#fff'};color:${hasNote ? '#b45309' : '#6b7280'};">📝 Note${hasNote ? ' •' : ''}</button>`;
                })()}
                ${(() => {
                  const fait = _bonRapFait(b);
                  const rapStyle = fait
                    ? 'border:1.5px solid #16a34a;background:#16a34a;color:#fff;'
                    : 'border:1.5px solid #d1d5db;background:#fff;color:#374151;';
                  return `<select onchange="createRapportTypeFromBon('${b.id}', this.value); this.selectedIndex=0;" title="Créer un rapport depuis ce bon — choisir le type" style="font-weight:700;font-size:12px;${rapStyle}border-radius:6px;padding:5.5px 4px;cursor:pointer;max-width:118px;">
                  <option value="" selected>📋 Rapport ▾</option>
                  <option value="general">📋 Rapport général</option>
                  <option value="bois">🪵 Insectes du bois</option>
                  <option value="rongeurs">🐀 Rongeurs</option>
                  <option value="blattes">🪳 Blattes</option>
                  <option value="fourmis">🐜 Fourmis</option>
                  <option value="punaises">🛏️ Punaises de lit</option>
                </select>
                <button class="btn btn-sm" onclick="bonToggleRapFait('${b.id}')" title="${fait ? 'Rapport fait — cliquer pour décocher' : 'Marquer le rapport comme fait'}" style="font-weight:700;padding:6px 9px;border:1.5px solid ${fait ? '#16a34a' : '#d1d5db'};background:${fait ? '#dcfce7' : '#fff'};color:${fait ? '#166534' : '#9ca3af'};">${fait ? '✅' : '☐'}</button>`;
                })()}
                <button class="btn ${statut==='a-facturer'?'btn-navy':'btn-ghost'} btn-sm" onclick="createDevisFromBon('${b.id}')" title="Créer un devis depuis ce bon">📝 Devis</button>
                <button class="btn ${statut==='a-facturer'?'btn-green':'btn-ghost'} btn-sm" onclick="createFactureFromBon('${b.id}')" title="Créer une facture depuis ce bon">🧾 Facture</button>
                <input type="color" value="${customColor || gColor}" onchange="bonSetColor('${b.id}', this.value)" title="🎨 Choisir la couleur de fond de ce bon" style="width:30px;height:30px;padding:0;border:1.5px solid #d1d5db;border-radius:6px;cursor:pointer;background:#fff;flex-shrink:0;">
                ${customColor ? `<button class="btn btn-ghost btn-xs" onclick="bonSetColor('${b.id}','')" title="Revenir à la couleur automatique (gérance)">↺</button>` : ''}
                <button class="btn btn-red btn-sm btn-xs" onclick="confirmDeleteBon('${b.id}','${(b.numero||b.id).replace(/'/g,"\\'")}')" title="Supprimer">🗑</button>
              </div>
            </div>
          `;
}

function renderBons() {
  updateBonsCounts();
  const list = $('bons-list');
  const count = $('bons-count');
  const q = (($('bon-search') || {}).value || '').toLowerCase();
  // Les bons dont la facture est payée partent dans « Facturation archivée »
  let bons = (DB.bons || []).filter(b => !_isBonFactArchived(b));
  // Filtre actifs / en cours / terminés (un bon "terminé" = statut 'termine')
  const isTermine = b => (b.statut || '') === 'termine';
  if (state.bonsFilter === 'termines') {
    bons = bons.filter(isTermine);
  } else if (state.bonsFilter === 'en-cours') {
    bons = bons.filter(b => (b.statut || '') === 'en-cours');
  } else {
    // Actifs = ni terminés, ni en cours, ni en demande de devis
    // (en cours → onglet dédié ; demande de devis → écran Devis)
    bons = bons.filter(b => !isTermine(b) && (b.statut || '') !== 'en-cours' && (b.statut || '') !== 'demande-devis');
  }
  if (q) {
    bons = bons.filter(b =>
      ((b.numero||'') + ' ' + (b.geranceNom||'') + ' ' + (b.gerantNom||'') + ' ' + (b.locataireNom||'') + ' ' + (b.immeuble||'') + ' ' + (b.gerantTel||'') + ' ' + _bonProblemeClean(b))
        .toLowerCase().includes(q)
    );
  }
  if (count) {
    const lbl = state.bonsFilter === 'termines' ? 'bon(s) terminé(s)' : 'bon(s) actif(s)';
    // Rapports à transmettre : bons dont le statut est « 📕 Rapport à transmettre »
    const rapAFaire = (DB.bons || []).filter(b => !_isBonFactArchived(b) && (b.statut || '') === 'a-transmettre').length;
    const base = bons.length ? bons.length + ' ' + lbl : '';
    const rapHtml = rapAFaire
      ? `<span style="color:#b91c1c;font-weight:800;">📋 ${rapAFaire} rapport${rapAFaire > 1 ? 's' : ''} à transmettre</span>`
      : `<span style="color:#15803d;font-weight:700;">✅ Tous les rapports sont faits</span>`;
    count.innerHTML = base + (base ? ' &nbsp;·&nbsp; ' : '') + rapHtml;
  }
  if (!list) return;
  if (!bons.length) {
    const msg = state.bonsFilter === 'termines'
      ? 'Aucun bon terminé pour le moment.<br>Un bon apparaît ici quand son statut passe à « ✅ Travail terminé ».'
      : 'Aucun bon actif.<br>Glissez un PDF ci-dessus pour commencer, ou consultez les « ✅ Bons terminés ».';
    list.innerHTML = '<div class="empty"><div class="empty-icon">📄</div><div class="empty-text">' + msg + '</div></div>';
    return;
  }
  const groups = {};
  bons.forEach(b => {
    const key = _geranceCanon(b.geranceNom) || '(Sans gérance)';
    if (!groups[key]) groups[key] = [];
    groups[key].push(b);
  });
  // Index locataires et clients pour lookup rapide
  const locById = {};
  (DB.locataires || []).forEach(l => { if (l && l.id) locById[l.id] = l; });
  const locByName = {};
  (DB.locataires || []).forEach(l => { if (l && l.nom) locByName[l.nom.toLowerCase()] = l; });
  const clientById = {};
  (DB.clients || []).forEach(c => { if (c && c.id) clientById[c.id] = c; });
  const clientByName = {};
  (DB.clients || []).forEach(c => { if (c && c.nom) clientByName[c.nom.toLowerCase()] = c; });

  list.innerHTML = Object.keys(groups).sort().map(g => {
    const items = groups[g].sort((a,b) => (b.date||'').localeCompare(a.date||''));
    const gColor = colorForGeranceName(g);
    return `
      <div style="margin-top:14px;">
        <div style="font-size:16px;font-weight:900;color:#0d1b3e;background:${_hexTint(gColor,0.20)};border-left:6px solid ${gColor};text-transform:uppercase;letter-spacing:.3px;margin-bottom:9px;padding:9px 14px;border-radius:7px;box-shadow:0 1px 2px rgba(0,0,0,.06);">🏢 ${g} <span style="font-weight:800;color:#fff;background:${gColor};border-radius:11px;padding:1px 10px;font-size:13px;margin-left:6px;">${items.length}</span></div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${items.map(b => renderBonCard(b, state.bonsFilter === 'actifs')).join('')}
        </div>
      </div>
    `;
  }).join('');
}

// Auto-remplit le locataire et la gérance dans le formulaire de rapport
// à partir d'un numéro de bon de commande saisi
function autoFillFromBonNumero(numero) {
  if (!numero) return;
  const n = String(numero).trim();
  if (!n) return;
  // Cherche le bon par numéro (insensible aux espaces et à la casse)
  const norm = s => String(s||'').replace(/\s+/g,'').toLowerCase();
  const target = norm(n);
  const bon = (DB.bons || []).find(b => norm(b.numero) === target);
  if (!bon) {
    // Pas de toast si l'utilisateur tape progressivement — on reste silencieux
    return;
  }

  // 1. Auto-fill du locataire
  let locataire = null;
  if (bon.locataireId) locataire = (DB.locataires || []).find(l => l.id === bon.locataireId);
  if (!locataire && bon.locataireNom) {
    const ln = bon.locataireNom.toLowerCase();
    locataire = (DB.locataires || []).find(l => (l.nom||'').toLowerCase() === ln);
  }

  const setVal = (id, v) => { const el = $(id); if (el && !el.value.trim()) el.value = v || ''; };
  const setValForce = (id, v) => { const el = $(id); if (el) el.value = v || ''; };

  if (locataire) {
    // Coche la case "avec locataire" si elle existe et révèle le bloc
    const cb = $('r-avec-locataire'); if (cb && !cb.checked) { cb.checked = true; if (typeof toggleLocataire === 'function') toggleLocataire(); }
    const details = $('r-locataire-details'); if (details) details.style.display = 'block';
    // Remplit les champs (force pour ne pas garder de valeurs résiduelles)
    setValForce('r-locataire',         locataire.nom);
    setValForce('r-locataire-tel',     locataire.tel);
    setValForce('r-locataire-email',   locataire.email);
    setValForce('r-locataire-adresse', locataire.adresse);
    const hid = $('r-locataire-id'); if (hid) hid.value = locataire.id;
  } else if (bon.locataireNom) {
    // Pas de fiche locataire en base mais le bon a un nom — on remplit quand même le nom
    setValForce('r-locataire', bon.locataireNom);
  }

  // 2. Auto-sélection du client (gérance) dans le select
  if (bon.geranceId) {
    const sel = $('r-client');
    if (sel) {
      const opt = Array.from(sel.options).find(o => o.value === bon.geranceId);
      if (opt) {
        sel.value = bon.geranceId;
        if (typeof onClientChange === 'function') onClientChange();
        else sel.dispatchEvent(new Event('change'));
      }
    }
  }

  // 3. Si le bon a un immeuble et que l'adresse du rapport est vide, on la pré-remplit
  if (bon.immeuble) setVal('r-adresse', bon.immeuble);

  // 4. Dates d'intervention effectuées du bon → liste de dates du rapport + nb de passages
  const datesEff = _bonDatesInterv(bon);
  if (datesEff.length) {
    if (typeof rSetDates === 'function') rSetDates(datesEff);
    if ($('r-nb-passages') && !$('r-nb-passages').value.trim()) $('r-nb-passages').value = String(datesEff.length);
  }

  toast('✓ Locataire, gérance et dates auto-remplis depuis le bon ' + bon.numero, '#2d9e6b');
  if (typeof updatePDF === 'function') updatePDF();
}

// Détermine le type de nuisible + sa couleur à partir du texte du problème
function _nuisibleInfo(txt) {
  const t = (txt || '').toLowerCase();
  if (/gu[eê]pe|frelon|abeille/.test(t))          return { label: 'Guêpes',         color: '#f4a623' }; // jaune
  if (/punaise/.test(t))                          return { label: 'Punaises de lit', color: '#e63946' }; // rouge
  if (/\brat|souris|rongeur|d[ée]ratis|mulot/.test(t)) return { label: 'Rats / souris', color: '#2563eb' }; // bleu
  if (/blatte|cafard|cancrelat/.test(t))          return { label: 'Blattes',        color: '#2d9e6b' }; // vert
  if (/pigeon|oiseau|volatile|fiente/.test(t))    return { label: 'Pigeons',        color: '#7c3aed' }; // violet
  if (/fourmi/.test(t))                           return { label: 'Fourmis',        color: '#b45309' }; // brun
  if (/mouche|moucheron/.test(t))                 return { label: 'Mouches',        color: '#65a30d' }; // vert olive
  if (/capricorne|vrillette|termite|xylophage|vers? ?à ?bois|insecte.*bois|poutre/.test(t)) return { label: 'Insectes du bois', color: '#8b4513' };
  if (/puce/.test(t))                             return { label: 'Puces',          color: '#db2777' };
  if (/araign/.test(t))                           return { label: 'Araignées',      color: '#0891b2' };
  return { label: 'Autre', color: '#6b7280' }; // gris (non classé)
}

// Crée / met à jour / supprime l'intervention liée à un bon dans l'agenda interne
function _syncBonIntervention(b) {
  if (!b) return;
  const ivId = 'bon-iv-' + b.id;
  let ivs = (DB.intervs || []).filter(x => x.id !== ivId);
  if (b.dateIntervention) {
    let adresse = '';
    if (b.locataireId) { const l = (DB.locataires||[]).find(x=>x.id===b.locataireId); if (l) adresse = l.adresse || ''; }
    if (!adresse) adresse = b.immeuble || '';
    ivs.push({
      id: ivId,
      date: b.dateIntervention,
      heure: b.heureIntervention || '08:00',
      clientId: b.geranceId || '',
      clientNom: b.geranceNom || '',
      adresse: adresse,
      nuisible: _nuisibleInfo(_bonProblemeClean(b)).label,
      tech: '',
      statut: 'Planifiée',
      couleur: _nuisibleInfo(_bonProblemeClean(b)).color,
      notes: 'Bon ' + (b.numero || '') + (b.locataireNom ? ' — ' + b.locataireNom : ''),
      bonId: b.id,
      bonNumero: b.numero || '',
    });
  }
  DB.intervs = ivs;
  if (typeof renderAgenda === 'function') renderAgenda();
  if (typeof renderDashboard === 'function') renderDashboard();
}
// Enregistre la date de prochaine intervention sur un bon + planifie dans l'agenda
function updateBonDateInterv(id, value) {
  const bons = DB.bons;
  const b = bons.find(x => x.id === id);
  if (!b) return;
  b.dateIntervention = value;
  DB.bons = bons;
  _syncBonIntervention(b);
  toast(value ? ('📅 Planifié dans l\'agenda le ' + fmtDate(value)) : 'Date effacée (retiré de l\'agenda)', '#2d9e6b');
}
// Enregistre l'heure de prochaine intervention sur un bon + met à jour l'agenda
function updateBonHeureInterv(id, value) {
  const bons = DB.bons;
  const b = bons.find(x => x.id === id);
  if (!b) return;
  b.heureIntervention = value;
  DB.bons = bons;
  _syncBonIntervention(b);
  toast(value ? ('🕒 Heure : ' + value + ' (agenda mis à jour)') : 'Heure effacée', '#2d9e6b');
}
// Ajoute le bon à Google Agenda à la date/heure de prochaine intervention
function addBonToGoogle(id) {
  const b = (DB.bons || []).find(x => x.id === id);
  if (!b) return;
  if (!b.dateIntervention) { toast('Choisis d\'abord une date de prochaine intervention', '#e63946'); return; }
  // Titre : Nuisible — Gérance
  const nuisible = _nuisibleInfo(_bonProblemeClean(b)).label;
  const titre = [nuisible, b.geranceNom].filter(Boolean).join(' — ');
  const details = [
    'Bon ' + (b.numero || ''),
    b.geranceNom ? 'Gérance : ' + b.geranceNom : '',
    b.locataireNom ? 'Locataire : ' + b.locataireNom : '',
    _bonProblemeClean(b) ? 'Problème : ' + _bonProblemeClean(b) : ''
  ].filter(Boolean).join('\n');
  const url = _googleCalUrl({ titre, date: b.dateIntervention, heure: b.heureIntervention || '08:00', dureeMin: 60, details, lieu: b.immeuble || '' });
  window.open(url, '_blank');
}

// Met à jour le statut d'un bon (transmis / en-cours / termine / vide)
function updateBonStatut(id, value) {
  const bons = DB.bons;
  const b = bons.find(x => x.id === id);
  if (!b) return;
  const prev = b.statut || '';
  b.statut = value;
  // Statuts à alerte 48 h : on (ré)enclenche le minuteur en passant DANS le statut, on l'efface en sortant
  const alertStatuts = ['a-contacter', 'urgent'];
  let alerte = _bonAlerte(b);
  if (alertStatuts.includes(value)) {
    if (!alertStatuts.includes(prev) || !alerte) alerte = new Date().toISOString();
  } else {
    alerte = '';
  }
  b.probleme = _bonAssembleProbleme(_bonProblemeClean(b), _bonDatesInterv(b), _bonAffecte(b), _bonNote(b), _bonRapFait(b), alerte, _bonColor(b));
  DB.bons = bons; // déclenche le sync Supabase
  const labels = {
    '':              'Statut effacé',
    'a-contacter':   '📞 Statut : À contacter (alerte 48 h)',
    'urgent':        '🚨 Statut : Urgent (alerte 48 h)',
    'a-transmettre': '📕 Statut : Rapport à transmettre',
    'transmis':      '📨 Statut : Rapport transmis',
    'demande-devis': '📝 Statut : Demande de devis',
    'attente-devis': '⏸️ Statut : Attente de devis',
    'devis-valide':  '✍️ Statut : Devis validé',
    'en-cours':      '⏳ Statut : En cours de traitement',
    'termine':       '✅ Statut : Travail terminé',
    'a-facturer':    '🧾 Statut : À facturer',
  };
  toast(labels[value] || 'Statut mis à jour', '#2d9e6b');
  renderBons();
  // Le statut du bon décide de son apparition dans « Bons terminés à facturer »
  // (onglet Factures) et « Bons en demande de devis » (onglet Devis) → on rafraîchit ces vues.
  if (typeof renderDocuments === 'function') renderDocuments();
  if (typeof updateNavCounts === 'function') updateNavCounts();
  if (typeof renderDashboard === 'function') renderDashboard();
}

function confirmDeleteBon(id, label) {
  $('confirm-msg').textContent = `Supprimer le bon "${label}" ? Cette action est irréversible.`;
  $('confirm-btn').onclick = async () => {
    // 1. Récupérer le chemin du PDF avant suppression du bon
    const bon = (DB.bons || []).find(b => b.id === id);
    const pdfPath = bon ? bon.pdfPath : '';
    // 2. Retirer le bon du cache (déclenche la suppression Supabase)
    DB.bons = DB.bons.filter(b => b.id !== id);
    closeModal('modal-confirm');
    renderBons();
    toast('Bon supprimé', '#e63946');
    // 3. Supprimer le PDF du Storage en arrière-plan
    if (pdfPath) _deleteBonPdf(pdfPath);
  };
  openModal('modal-confirm');
}

// ============================================================
// EXPORT / IMPORT DES DONNÉES (sauvegarde JSON)
// ============================================================
function exportData() {
  const data = {
    _meta: {
      app: 'DERATEK',
      version: (typeof DERATEK_CONFIG !== 'undefined' && DERATEK_CONFIG.app) ? DERATEK_CONFIG.app.version : '2.0',
      exportedAt: new Date().toISOString()
    },
    drt_techs:        DB.techs,
    drt_clients:      DB.clients,
    drt_rapports:     DB.rapports,
    drt_intervs:      DB.intervs,
    drt_locataires:   DB.locataires,
    drt_bons:         DB.bons,
    drt_documents:    DB.documents,     // devis ET factures
    drt_prestations:  DB.prestations,
    drt_diagnostics:  DB.diagnostics,
    drt_fournisseurs: DB.fournisseurs
  };
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().split('T')[0];
  const a = document.createElement('a');
  a.href = url;
  a.download = `deratek-backup-${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  _setLastBackup();
  toast('✓ Sauvegarde téléchargée', '#2d9e6b');
}

// ---- Sauvegarde automatique (préférence locale, pas une donnée métier) ----
function _autoBackupOn() { try { return localStorage.getItem('drt_autobackup') === '1'; } catch (e) { return false; } }
function _lastBackup()   { try { return localStorage.getItem('drt_lastbackup') || ''; } catch (e) { return ''; } }
function _setLastBackup() { try { localStorage.setItem('drt_lastbackup', new Date().toISOString()); } catch (e) {} _refreshAutoBackupBtn(); }
function _refreshAutoBackupBtn() {
  const b = document.getElementById('btn-autobackup'); if (!b) return;
  const on = _autoBackupOn(); const last = _lastBackup();
  const lastTxt = last ? (' · dernière : ' + new Date(last).toLocaleDateString('fr-CH')) : ' · jamais';
  b.textContent = on ? '🔄 Sauvegarde auto : ON' : '🔄 Sauvegarde auto : OFF';
  b.style.background = on ? '#dcfce7' : '';
  b.style.color = on ? '#166534' : '';
  b.style.fontWeight = on ? '800' : '';
  b.title = (on ? 'Sauvegarde automatique hebdomadaire activée — cliquer pour désactiver' : 'Cliquer pour activer une sauvegarde automatique chaque semaine') + lastTxt;
}
function toggleAutoBackup() {
  const on = !_autoBackupOn();
  try { localStorage.setItem('drt_autobackup', on ? '1' : '0'); } catch (e) {}
  _refreshAutoBackupBtn();
  if (on) { toast('🔄 Sauvegarde auto activée (1×/semaine)', '#2d9e6b'); _autoBackupCheck(true); }
  else    { toast('Sauvegarde auto désactivée', '#6b7280'); }
}
// Au démarrage : si activée et que la dernière sauvegarde date de plus de 7 jours,
// on télécharge automatiquement une sauvegarde complète.
function _autoBackupCheck(force) {
  _refreshAutoBackupBtn();
  if (!_autoBackupOn()) return;
  const last = _lastBackup();
  const due = force || !last || (Date.now() - new Date(last).getTime() > 7 * 24 * 3600 * 1000);
  if (!due) return;
  try { exportData(); toast('🔄 Sauvegarde automatique effectuée', '#2d9e6b'); }
  catch (e) { console.warn('autobackup', e); }
}

// Export Excel LISIBLE (un onglet par catégorie) — généré côté navigateur via SheetJS.
function exportExcel() {
  if (typeof XLSX === 'undefined') { toast('Librairie Excel non chargée — réessayez dans un instant', '#e63946'); return; }
  try {
    const docs = DB.documents || [];
    const cleanM = s => String(s || '').replace(/\[ROLE:[^\]]*\]/g, '').replace(/\s*\[(ARCHIVE|NBPASS|DATESINT|LOC|INTERV|AFFECTE|NOTE|RAPFAIT|ALERTE):?[^\]]*\]/g, '').trim();
    const joinA = a => Array.isArray(a) ? a.filter(Boolean).join(', ') : (a || '');
    const numf = x => { const n = parseFloat(x); return isNaN(n) ? '' : n; };
    const isAnc = x => /\[ARCHIVE\]/.test(String(x.notes || ''));
    const sortBy = (arr, k) => (arr || []).slice().sort((a, b) => String(a[k] || '').localeCompare(String(b[k] || ''), 'fr'));
    const STF = { brouillon: 'Brouillon', pret: 'Prêt à envoyer', envoyee: 'Envoyée', payee: 'Payée' };
    const STD = { brouillon: 'Brouillon', envoye: 'Envoyé', accepte: 'Accepté', refuse: 'Refusé' };
    const STB = { 'a-transmettre': 'Rapport à transmettre', transmis: 'Transmis', 'demande-devis': 'Demande de devis', 'attente-devis': 'Attente devis', 'devis-valide': 'Devis validé', 'en-cours': 'En cours', termine: 'Terminé', 'a-facturer': 'À facturer', urgent: 'Urgent', 'a-contacter': 'À contacter' };
    const wb = XLSX.utils.book_new();
    const addSheet = (name, headers, rows, widths, moneyCols) => {
      const aoa = [headers].concat(rows);
      if (moneyCols && rows.length) {
        const tr = new Array(headers.length).fill(''); tr[0] = 'TOTAL';
        moneyCols.forEach(mc => { tr[mc] = rows.reduce((s, r) => s + (parseFloat(r[mc]) || 0), 0); });
        aoa.push(tr);
      }
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      if (widths) ws['!cols'] = widths.map(w => ({ wch: w }));
      ws['!freeze'] = { xSplit: 0, ySplit: 1 };
      XLSX.utils.book_append_sheet(wb, ws, name.substring(0, 31));
    };
    const today = new Date().toISOString().split('T')[0];

    // Résumé (en premier)
    const resume = [['DERATEK — Sauvegarde des données'], ['Exportée le ' + today], [], ['Catégorie', 'Nombre'],
      ['Clients / gérances', (DB.clients || []).length], ['Locataires', (DB.locataires || []).length],
      ['Bons', (DB.bons || []).length], ['Rapports', (DB.rapports || []).length],
      ['Factures', docs.filter(x => x.type === 'facture').length], ['Devis', docs.filter(x => x.type === 'devis').length],
      ['Fournisseurs', (DB.fournisseurs || []).length], ['Prestations', (DB.prestations || []).length],
      ['Diagnostics', (DB.diagnostics || []).length], ['Interventions (agenda)', (DB.intervs || []).length],
      ['Techniciens', (DB.techs || []).length]];
    const wsR = XLSX.utils.aoa_to_sheet(resume); wsR['!cols'] = [{ wch: 28 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, wsR, 'Résumé');

    // Factures
    const fact = sortBy(docs.filter(x => x.type === 'facture'), 'numero');
    addSheet('Factures', ['N°', 'Catégorie', 'Date', 'Client / gérance', 'Locataire', 'Adresse intervention', 'Total TTC', 'Statut'],
      fact.map(x => [x.numero || '', isAnc(x) ? 'Ancienne (importée)' : (x.statut === 'payee' ? 'Payée/archivée' : 'Courante'), x.dateDoc || '', x.clientNom || '', x.locataireNom || '', x.locataireAdresse || '', numf(x.total), STF[x.statut] || x.statut || '']),
      [12, 20, 12, 30, 26, 30, 14, 16], [6]);
    // Devis
    addSheet('Devis', ['N°', 'Date', 'Client / gérance', 'Locataire', 'Total TTC', 'Statut'],
      docs.filter(x => x.type === 'devis').map(x => [x.numero || '', x.dateDoc || '', x.clientNom || '', x.locataireNom || '', numf(x.total), STD[x.statut] || x.statut || '']),
      [14, 12, 30, 26, 14, 14], [4]);
    // Bons
    addSheet('Bons', ['N°', 'Date', 'Gérance', 'Gérant', 'Tél gérant', 'Locataire', 'Immeuble (intervention)', 'Problème / travaux', 'Statut'],
      sortBy(DB.bons, 'numero').map(x => [x.numero || '', x.date || '', x.geranceNom || '', x.gerantNom || '', x.gerantTel || '', x.locataireNom || '', x.immeuble || '', cleanM(x.probleme).substring(0, 300), STB[x.statut] || x.statut || '']),
      [16, 12, 28, 20, 16, 24, 30, 45, 18]);
    // Rapports
    addSheet('Rapports', ['N°', 'Date', 'Client / gérance', 'Technicien', 'Locataire', 'Adresse intervention', 'Nuisibles', 'N° bon', 'Montant', 'Statut'],
      (DB.rapports || []).map(x => { const l = _rapLoc(x); return [x.id || '', x.date || '', x.clientNom || '', x.tech || '', l.nom || '', l.adresse || x.adresse || '', joinA(x.nuisibles), x.bonCommande || '', numf(x.montant), x.statut || '']; }),
      [14, 12, 28, 16, 24, 30, 24, 16, 12, 12], [8]);
    // Clients
    addSheet('Clients-Gérances', ['Nom', 'Type', 'Contact', 'Rôle', 'Téléphone', 'Email', 'Adresse', 'NPA', 'Ville'],
      sortBy(DB.clients, 'nom').map(x => [x.nom || '', x.type || '', _rapContactNom(x.contact), _rapContactRole(x.contact) || '', x.tel || '', x.email || '', x.adresse || '', x.npa || '', x.ville || '']),
      [34, 14, 22, 12, 16, 28, 28, 8, 18]);
    // Locataires
    addSheet('Locataires', ['Nom', 'Prénom', 'Téléphone', 'Email', 'Adresse', 'NPA', 'Ville'],
      sortBy(DB.locataires, 'nom').map(x => [x.nom || '', x.prenom || '', x.tel || '', x.email || '', x.adresse || '', x.npa || '', x.ville || '']),
      [26, 18, 16, 28, 30, 8, 18]);
    // Fournisseurs
    addSheet('Fournisseurs', ['Nom', 'Secteur', 'N°', 'Date', 'Montant', 'Description'],
      sortBy(DB.fournisseurs, 'nom').map(x => [x.nom || '', x.secteur || '', x.numero || '', x.dateDoc || '', numf(x.montant), x.description || '']),
      [30, 22, 14, 12, 14, 40], [4]);
    // Agenda
    addSheet('Agenda-Interventions', ['Date', 'Heure', 'Client', 'Adresse', 'Nuisible', 'Technicien', 'Statut'],
      (DB.intervs || []).map(x => [x.date || '', x.heure || '', x.clientNom || '', x.adresse || '', x.nuisible || '', x.tech || '', x.statut || '']),
      [12, 8, 26, 30, 18, 16, 14]);
    // Prestations
    addSheet('Prestations', ['Libellé', 'Prix'], (DB.prestations || []).map(x => [x.libelle || '', numf(x.prix)]), [50, 14], [1]);
    // Techniciens
    addSheet('Techniciens', ['Nom'], (DB.techs || []).filter(t => typeof t === 'string').map(t => [t]), [30]);

    XLSX.writeFile(wb, 'deratek-lisible-' + today + '.xlsx');
    toast('✓ Export Excel téléchargé', '#2d9e6b');
  } catch (e) {
    console.error('exportExcel', e);
    toast('Erreur export Excel : ' + e.message, '#e63946');
  }
}

function importData(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data._meta || data._meta.app !== 'DERATEK') {
        if (!confirm('Ce fichier ne semble pas être une sauvegarde DERATEK officielle.\n\nImporter quand même ? (Toutes les données actuelles seront écrasées.)')) {
          event.target.value = '';
          return;
        }
      } else if (!confirm('Restaurer cette sauvegarde ?\n\n⚠️ Toutes les données actuelles seront écrasées.\nSauvegarde du : ' + (data._meta.exportedAt || '?'))) {
        event.target.value = '';
        return;
      }
      // Mapping clé export → propriété DB
      const map = {
        drt_techs:        'techs',
        drt_clients:      'clients',
        drt_rapports:     'rapports',
        drt_intervs:      'intervs',
        drt_locataires:   'locataires',
        drt_bons:         'bons',
        drt_documents:    'documents',
        drt_prestations:  'prestations',
        drt_diagnostics:  'diagnostics',
        drt_fournisseurs: 'fournisseurs',
      };
      let n = 0;
      Object.keys(map).forEach(k => {
        if (Array.isArray(data[k])) {
          DB[map[k]] = data[k]; // déclenche le sync Supabase
          n++;
        }
      });
      toast(`✓ ${n} collection(s) restaurée(s) — synchronisation Supabase en cours…`, '#2d9e6b');
      if (typeof renderDashboard === 'function')   renderDashboard();
      if (typeof renderClients === 'function')     renderClients();
      if (typeof renderLocataires === 'function')  renderLocataires();
      if (typeof renderBons === 'function')        renderBons();
      if (typeof renderRapports === 'function')    renderRapports();
      if (typeof renderDocuments === 'function')   renderDocuments();
      if (typeof renderFournisseurs === 'function')renderFournisseurs();
    } catch (err) {
      toast("Erreur d'import : " + err.message, '#e63946');
    } finally {
      event.target.value = '';
    }
  };
  reader.onerror = () => toast('Erreur de lecture du fichier', '#e63946');
  reader.readAsText(file);
}

// ============================================================
// DEVIS / FACTURES — logique QR-bill suisse + éditeur
// (logique QR portée du générateur DERATEK existant)
// ============================================================

// --- Helpers QR-bill ---
function _cleanIban(v) { return (v || '').replace(/\s+/g, '').toUpperCase(); }
function _displayIban(iban) { return _cleanIban(iban).replace(/(.{4})/g, '$1 ').trim(); }
function _fmtMontant(n) {
  const v = (typeof n === 'number') ? n : parseFloat(String(n || '0').replace(/'/g, '').replace(',', '.'));
  return (isNaN(v) ? 0 : v).toFixed(2);
}
function _displayMontant(a) {
  const s = _fmtMontant(a);
  const [int, dec] = s.split('.');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + '.' + dec;
}

// Bureaux DERATEK : adresse émettrice sélectionnable par document (Neuchâtel = défaut).
const BUREAUX = [
  { id: 'ne', label: 'Neuchâtel', rue: DERATEK_CONFIG.company.rue, npa: DERATEK_CONFIG.company.npa, ville: DERATEK_CONFIG.company.ville, tel: DERATEK_CONFIG.company.tel },
  { id: 'la', label: 'Lausanne', rue: 'Ch. des Pyramides 7', npa: '1007', ville: 'Lausanne', tel: '021 552 66 72' },
  { id: 'be', label: 'Berne', rue: 'Neufeldstrasse 119', npa: '3012', ville: 'Berne', tel: DERATEK_CONFIG.company.tel },
  { id: 'ge', label: 'Genève', rue: DERATEK_CONFIG.company.rue, npa: DERATEK_CONFIG.company.npa, ville: DERATEK_CONFIG.company.ville, tel: '022 552 33 72' }
];
function _docBureau(d) {
  return BUREAUX.find(b => b.id === ((d && d.bureauId) || 'ne')) || BUREAUX[0];
}
// Une facture importée d'historique est marquée par [ARCHIVE] dans ses notes
// (persisté dans Supabase via une colonne texte existante, sans nouvelle colonne).
function _docIsArchive(d) {
  return !!(d && (d._archive || /\[ARCHIVE\]/.test(String(d.notes || ''))));
}
// Un devis « archivé avec sa facture payée » : marqueur invisible [DEVISARCH].
// Il quitte alors la liste active des devis et s'affiche dans le dossier archivé de sa facture.
function _isDevisArchivedWithFacture(d) {
  return !!(d && (d.type || 'devis') === 'devis' && /\[DEVISARCH\]/.test(String(d.notes || '')));
}
function _setDevisArchivedFlag(devis, on) {
  if (!devis) return;
  const n = String(devis.notes || '');
  const has = /\[DEVISARCH\]/.test(n);
  if (on && !has) devis.notes = (n + ' [DEVISARCH]').trim();
  else if (!on && has) devis.notes = n.replace(/\s*\[DEVISARCH\]/g, '').trim();
}
// Synchronise l'archivage du devis source avec l'état payé de sa facture.
function _syncDevisArchiveWithFacture(facture, paid) {
  if (!facture || !facture.devisId) return;
  const dv = (DB.documents || []).find(x => x.id === facture.devisId && (x.type || 'devis') === 'devis');
  if (dv) _setDevisArchivedFlag(dv, !!paid);
}
function _docNotesClean(d) {
  return String((d && d.notes) || '')
    .replace(/\s*\[ARCHIVE\]\s*/g, ' ')
    .replace(/\s*\[RAPPEL:\d(?:\|[^\]]*)?\]\s*/g, ' ')
    .replace(/\s*\[RAPPEL(?:DOC|SRC|FD|TXT):[^\]]*\]\s*/g, ' ')
    .replace(/\s*\[ENVDATE:[^\]]*\]\s*/g, ' ')
    .replace(/\s*\[ORD:\d+\]\s*/g, ' ')
    .replace(/\s*\[EXPERT:[^\]]*\]\s*/g, ' ')
    .replace(/\s*\[DEVISARCH\]\s*/g, ' ')
    .trim();
}
// Ordre manuel d'affichage dans Anciennes factures (glisser-déposer) — marqueur [ORD:n]
function _ancOrd(d) { const m = String((d && d.notes) || '').match(/\[ORD:(\d+)\]/); return m ? parseInt(m[1], 10) : 999999; }
function _setAncOrd(d, n) { if (!d) return; d.notes = String(d.notes || '').replace(/\s*\[ORD:\d+\]/g, ''); d.notes += (d.notes ? ' ' : '') + '[ORD:' + n + ']'; }
// Date d'envoi d'une ancienne facture (marqueur [ENVDATE:ISO] dans notes)
function _ancEnvoiDate(d) { const m = String((d && d.notes) || '').match(/\[ENVDATE:([^\]]*)\]/); return m ? m[1] : ''; }
function _setAncEnvoiDate(d, iso) {
  if (!d) return;
  d.notes = String(d.notes || '').replace(/\s*\[ENVDATE:[^\]]*\]/g, '');
  if (iso) d.notes += (d.notes ? ' ' : '') + '[ENVDATE:' + iso + ']';
}
// ---- Rappels SAUVEGARDÉS : un rappel généré est stocké comme document de type
// facture, identifié par des marqueurs dans "notes" (survivent à Supabase). ----
function _isRappelDoc(d) { return /\[RAPPELDOC:\d\]/.test(String((d && d.notes) || '')); }
// Une facture créée DANS l'app porte toujours un numéro « F-AAAA-… ». Toute facture
// dont le numéro NE commence PAS par « F- » (ou marquée [ARCHIVE]) est une ANCIENNE
// facture importée → sa place est dans l'onglet « Anciennes factures », pas « Factures ».
function _isAncienneFacture(d) {
  if (!d || d.type !== 'facture' || _isRappelDoc(d)) return false;
  if (_docIsArchive(d)) return true;
  const num = String(d.numero || '').trim();
  return num !== '' && !/^f-/i.test(num);
}
function _rappelMeta(d) {
  const notes = String((d && d.notes) || '');
  const mN = notes.match(/\[RAPPELDOC:(\d)\]/);
  if (!mN) return null;
  const niveau = parseInt(mN[1], 10) || 1;
  const srcId = (notes.match(/\[RAPPELSRC:([^\]]*)\]/) || [])[1] || '';
  const factureDate = (notes.match(/\[RAPPELFD:([^\]]*)\]/) || [])[1] || '';
  const txtB64 = (notes.match(/\[RAPPELTXT:([^\]]*)\]/) || [])[1] || '';
  return { niveau, srcId, factureDate, texte: txtB64 ? _decNote(txtB64) : (RAPPEL_TEXTES[niveau] || '') };
}
// Échéance du délai de 10 jours après le dernier rappel émis (pour une facture source).
// Retourne { daysLeft, niveau, deadline } ou null si aucun rappel daté.
function _rappelDeadlineInfo(d) {
  const niveau = _ancRappelNiveau(d);
  if (!niveau) return null;   // aucun rappel émis → pas de décompte
  // Date de référence du dernier rappel, par priorité :
  //  1) date stockée dans le marqueur [RAPPEL:n|date]  2) date du doc de rappel
  //  3) date d'envoi de la facture  4) date de la facture
  let baseStr = _ancRappelDate(d);
  if (!baseStr) {
    const rappels = (DB.documents || []).filter(x => _isRappelDoc(x) && (_rappelMeta(x) || {}).srcId === d.id && x.dateDoc);
    if (rappels.length) { let last = rappels[0]; rappels.forEach(r => { if ((r.dateDoc || '') > (last.dateDoc || '')) last = r; }); baseStr = last.dateDoc; }
  }
  if (!baseStr) baseStr = _ancEnvoiDate(d) || d.dateDoc;
  if (!baseStr) return null;
  const base = new Date(baseStr + 'T00:00:00');
  if (isNaN(base.getTime())) return null;
  const deadline = new Date(base.getTime() + 10 * 86400000);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const daysLeft = Math.round((deadline.getTime() - now.getTime()) / 86400000);
  return { daysLeft, niveau, deadline };
}
// Reconstitue les champs runtime _rappel* d'un document rappel rechargé depuis Supabase
function _applyRappelRuntime(d) {
  if (!d || d._rappel) return d;
  const m = _rappelMeta(d);
  if (!m) return d;
  d._rappel = true;
  d._rappelNiveau = m.niveau;
  d._rappelSourceId = m.srcId;
  d._rappelLabel = RAPPEL_LABELS[m.niveau];
  d._rappelTexte = m.texte;
  d._rappelFactureDate = m.factureDate || d._rappelFactureDate;
  return d;
}
// Niveau de rappel déjà émis (marqueur [RAPPEL:n] ou [RAPPEL:n|date] dans notes)
function _ancRappelNiveau(d) { const m = String((d && d.notes) || '').match(/\[RAPPEL:(\d)(?:\|[^\]]*)?\]/); return m ? parseInt(m[1], 10) : 0; }
// Date du dernier rappel (partie après « | » dans le marqueur), si présente
function _ancRappelDate(d) { const m = String((d && d.notes) || '').match(/\[RAPPEL:\d\|([^\]]+)\]/); return m ? m[1] : ''; }
function _setAncRappel(id, niveau) {
  const docs = DB.documents; const d = docs.find(x => x.id === id); if (!d) return;
  let n = String(d.notes || '').replace(/\s*\[RAPPEL:\d(?:\|[^\]]*)?\]/g, '');
  if (niveau) n += (n ? ' ' : '') + '[RAPPEL:' + niveau + '|' + today() + ']';   // on horodate le rappel
  d.notes = n; DB.documents = docs;
  if (typeof renderAnciennesList === 'function') renderAnciennesList();
}

// ============================================================
// FACTURATION ARCHIVÉE : quand une facture est PAYÉE et liée à un bon,
// le trio (bon + rapport + facture) devient un dossier clos. Calculé
// dynamiquement (aucun marqueur) : si on dé-paie la facture, tout revient.
// ============================================================
function _factNorm(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }
// Une facture (non importée Excel) payée et rattachée à un bon
function _isFactureFactArchived(d) {
  // Toute facture PAYÉE part dans « Facturation archivée », qu'elle soit liée à un bon
  // ou non, ET y compris les anciennes factures importées. (Jamais les documents de rappel.)
  return !!(d && d.type === 'facture' && (d.statut || '') === 'payee' && !_isRappelDoc(d));
}
// Un bon est archivé s'il a une facture payée liée OU si un de ses rapports a été
// envoyé manuellement dans « Facturation archivée » (avant même la facture).
function _isBonFactArchived(b) {
  if (!b || !b.id) return false;
  if ((DB.documents || []).some(d => _isFactureFactArchived(d) && d.bonId === b.id)) return true;
  return (DB.rapports || []).some(r => _rapManualArchived(r) && r.bonCommande && _factNorm(r.bonCommande) === _factNorm(b.numero));
}
// Un rapport est archivé s'il l'a été manuellement, ou si son bon est archivé (facture payée)
function _isRapportFactArchived(r) {
  if (!r) return false;
  if (_rapManualArchived(r)) return true;
  if (!r.bonCommande) return false;
  const bon = (DB.bons || []).find(b => _factNorm(b.numero) === _factNorm(r.bonCommande));
  return bon ? _isBonFactArchived(bon) : false;
}
// Construit les dossiers archivés. Deux sources qui FUSIONNENT automatiquement par bon :
//   1) factures PAYÉES liées à un bon (dossier complet)
//   2) rapports envoyés manuellement à l'archive (facture pas encore faite)
// Quand la facture d'un rapport manuellement archivé devient payée, elle rejoint
// automatiquement le même dossier (le bon sert de clé commune).
function _factArchiveSets() {
  const sets = [];
  const seenBon = new Set();
  const seenRap = new Set();
  const _rapForBon = bon => (DB.rapports || []).find(r => bon && _factNorm(r.bonCommande) === _factNorm(bon.numero)) || null;
  // 1) Factures payées
  (DB.documents || []).forEach(d => {
    if (!_isFactureFactArchived(d)) return;
    const bon = (DB.bons || []).find(b => b.id === d.bonId) || null;
    const rapport = bon ? _rapForBon(bon) : null;
    const devis = d.devisId ? ((DB.documents || []).find(x => x.id === d.devisId && (x.type || 'devis') === 'devis') || null) : null;
    sets.push({ facture: d, bon, rapport, devis, manual: false });
    if (bon) seenBon.add(bon.id);
    if (rapport) seenRap.add(rapport.id);
  });
  // 2) Rapports archivés manuellement (pas encore couverts par une facture payée)
  (DB.rapports || []).forEach(r => {
    if (!_rapManualArchived(r) || seenRap.has(r.id)) return;
    const bon = r.bonCommande ? ((DB.bons || []).find(b => _factNorm(b.numero) === _factNorm(r.bonCommande)) || null) : null;
    if (bon && seenBon.has(bon.id)) { seenRap.add(r.id); return; }
    // facture liée éventuelle (même non payée) pour information
    const facture = bon ? ((DB.documents || []).find(x => x.type === 'facture' && x.bonId === bon.id && !_docIsArchive(x)) || null) : null;
    sets.push({ facture, bon, rapport: r, manual: true });
    if (bon) seenBon.add(bon.id);
    seenRap.add(r.id);
  });
  sets.sort((a, b) => ((b.facture && b.facture.dateDoc) || (b.rapport && b.rapport.date) || '').localeCompare((a.facture && a.facture.dateDoc) || (a.rapport && a.rapport.date) || ''));
  return sets;
}
// Rendu de l'onglet « Facturation archivée »
function renderFactArchive() {
  updateNavCounts();
  const box = $('fact-archive-list'); if (!box) return;
  const q = (($('fact-archive-search') || {}).value || '').toLowerCase();
  let sets = _factArchiveSets();
  if (q) sets = sets.filter(s => {
    const f = s.facture || {}, b = s.bon, r = s.rapport;
    return ((f.numero||'') + ' ' + (f.clientNom||'') + ' ' + (f.locataireNom||'') + ' ' + (b ? (b.numero||'') : '') + ' ' + (b ? (b.geranceNom||'') : '') + ' ' + (r ? (r.clientNom||'') : '') + ' ' + (r ? (r.id||'') : '')).toLowerCase().includes(q);
  });
  const sub = $('fact-archive-sub');
  const paid = sets.filter(s => s.facture && (s.facture.statut === 'payee'));
  const totalArch = paid.reduce((s, x) => s + (parseFloat(x.facture.total) || 0), 0);
  const pend = sets.length - paid.length;
  if (sub) sub.textContent = sets.length + ' dossier(s) · ' + _displayMontant(totalArch) + ' CHF encaissés' + (pend ? ' · ' + pend + ' en attente de facture' : '');
  if (!sets.length) {
    box.innerHTML = '<div class="empty"><div class="empty-icon">📦</div><div class="empty-text">Aucun dossier archivé.<br>Archivez un rapport depuis la liste « Rapports » (📦), ou marquez une facture liée à un bon comme « Payée ».</div></div>';
    return;
  }
  const pill = (icon, txt, col) => `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;color:${col};background:${_hexTint(col,0.12)};border:1px solid ${_hexTint(col,0.30)};border-radius:6px;padding:3px 8px;">${icon} ${txt}</span>`;
  const card = (s) => {
    const f = s.facture, b = s.bon, r = s.rapport, dv = s.devis;
    const isPaid = !!(f && f.statut === 'payee');
    const clientNom = (f && f.clientNom) || (r && r.clientNom) || (b && b.geranceNom) || '—';
    const locNom = (f && f.locataireNom) || (r && _rapLoc(r).nom) || '';
    const montant = (f && f.total) ? _displayMontant(f.total) + ' CHF · ✅ Payée' : (r && r.montant ? r.montant + ' CHF' : '') ;
    const statutTxt = isPaid
      ? `<span style="color:#15803d;">${_displayMontant(f.total || 0)} CHF · ✅ Payée</span>`
      : `<span style="color:#b45309;">📦 Archivé · ⏳ facture à venir${(f ? ' (brouillon)' : '')}</span>`;
    const dateTxt = (f && f.dateDoc) || (r && r.date) || '';
    return `
    <div${f ? ` id="factarch-${f.id}"` : ''} style="background:#fff;border:1px solid #e5e7eb;border-left:4px solid ${isPaid ? '#0f766e' : '#f59e0b'};border-radius:10px;padding:12px 14px;margin-bottom:8px;box-shadow:0 1px 2px rgba(0,0,0,.04);transition:box-shadow .3s;">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        <div style="font-size:13px;font-weight:800;color:var(--navy);min-width:150px;">${clientNom}</div>
        <div style="flex:1;font-size:12px;color:var(--g600);">${locNom ? ('🏠 ' + locNom) : ''}</div>
        <div style="font-size:13px;font-weight:800;">${statutTxt}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px;">
        ${b ? pill('📄', 'Bon ' + (b.numero || ''), '#2563eb') : pill('📄', 'Bon — (aucun)', '#9ca3af')}
        ${r ? pill('📋', 'Rapport ' + (r.id || ''), '#7c3aed') : pill('📋', 'Rapport — (aucun)', '#9ca3af')}
        ${dv ? pill('📝', 'Devis ' + (dv.numero || ''), '#8b5cf6') : ''}
        ${f ? pill('🧾', 'Facture ' + (f.numero || ''), '#0f766e') : pill('🧾', 'Facture — à faire', '#9ca3af')}
        <span style="font-size:11px;color:var(--g400);">📅 ${fmtDate(dateTxt) || '—'}</span>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:10px;border-top:1px dashed #eee;padding-top:10px;">
        ${b && b.pdfPath ? `<button class="btn btn-ghost btn-sm" onclick="viewBonPdf('${b.id}')" onmouseenter="bonPdfPreview('${b.id}', this)" onmouseleave="bonPdfPreviewHide()" title="Survol = aperçu · Clic = ouvrir">📎 PDF du bon</button>` : ''}
        ${r ? `<button class="btn btn-ghost btn-sm" onclick="editRapport('${r.id}')" onmouseenter="rapPdfPreview('${r.id}', this)" onmouseleave="bonPdfPreviewHide()" title="Survol = aperçu du rapport · Clic = ouvrir">📋 Voir le rapport</button>` : ''}
        ${dv ? `<button class="btn btn-ghost btn-sm" onclick="editDoc('${dv.id}')">📝 Voir le devis</button>
        <button class="btn btn-ghost btn-sm" onclick="downloadDocPDF('${dv.id}')" title="Télécharger le PDF du devis">📥 PDF devis</button>` : ''}
        ${f ? `<button class="btn btn-ghost btn-sm" onclick="editDoc('${f.id}')">✏️ Voir la facture</button>
        <button class="btn btn-ghost btn-sm" onclick="downloadDocPDF('${f.id}')" onmouseenter="factPdfPreview('${f.id}', this)" onmouseleave="bonPdfPreviewHide()" title="Survol = aperçu · Clic = télécharger">📥 PDF facture</button>`
        : (b ? `<button class="btn btn-navy btn-sm" onclick="createFactureFromBon('${b.id}')" title="Créer la facture pour ce dossier">🧾 Créer la facture</button>` : '')}
        <button class="btn btn-ghost btn-sm" onclick="${isPaid ? `unarchiveFact('${f.id}')` : (r ? `unarchiveRapport('${r.id}')` : '')}" title="Ressortir ce dossier de l'archive">↩︎ Désarchiver</button>
      </div>
    </div>`;
  };
  // Deux sections : dossiers complets (bon/rapport) et factures payées sans bon
  const withDossier = sets.filter(s => s.bon || s.rapport);
  const sansBon = sets.filter(s => !s.bon && !s.rapport);
  const section = (titre, arr, color) => arr.length ? `
    <div style="font-size:13px;font-weight:800;color:${color};text-transform:uppercase;letter-spacing:.3px;margin:4px 0 8px;border-bottom:2px solid ${_hexTint(color,0.4)};padding-bottom:4px;">${titre} <span style="font-weight:600;color:var(--g600);">(${arr.length})</span></div>
    ${arr.map(card).join('')}` : '';
  box.innerHTML = section('📦 Dossiers complets — bon · rapport · facture', withDossier, '#0f766e')
                + (sansBon.length && withDossier.length ? '<div style="height:14px;"></div>' : '')
                + section('🧾 Factures payées sans bon', sansBon, '#1d4ed8');
}
// Désarchive : remet la facture en « Envoyée » (non payée) → le trio ressort des archives
function unarchiveFact(id) {
  const docs = DB.documents; const d = docs.find(x => x.id === id); if (!d) return;
  d.statut = 'envoyee';
  // On ressort aussi le devis source qui avait été archivé avec la facture
  if (d.type === 'facture' && d.devisId) _syncDevisArchiveWithFacture(d, false);
  DB.documents = docs;
  renderFactArchive();
  toast('Dossier ressorti de l\'archive (facture remise en « non payée »)', '#2d9e6b');
}
// Désarchive un dossier archivé manuellement (retire le marqueur [ARCHIVE] du rapport)
function unarchiveRapport(rid) {
  _setRapArchive(rid, false);
  renderFactArchive(); renderRapports(); if (typeof renderBons === 'function') renderBons(); updateNavCounts();
  toast('Dossier ressorti de l\'archive', '#2d9e6b');
}

// Construit le payload SPC 0200 (Swiss QR Code), refType NON (IBAN classique)
// debtor = { nom, rue, npa, ville } (le client payeur) — optionnel
// cred = adresse créancier (bureau émetteur) — optionnel, défaut = config société
function _buildSpcPayload(montant, message, debtor, cred) {
  const co = DERATEK_CONFIG.company;
  const c = cred || {};
  const cRue = c.rue || co.rue, cNpa = c.npa || co.npa, cVille = c.ville || co.ville;
  // Le payload SPC est strictement « une ligne = un champ » : tout retour à la ligne
  // saisi par l'utilisateur (nom/adresse sur plusieurs lignes) doit devenir un espace.
  const _q = s => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const lines = [];
  lines.push('SPC');                 // QRType
  lines.push('0200');                // Version
  lines.push('1');                   // Coding UTF-8
  lines.push(_cleanIban(co.iban));   // IBAN
  // Créancier (structuré)
  lines.push('S', _q(co.nom), _q(cRue), '', _q(cNpa), _q(cVille), (co.pays || 'CH').toUpperCase());
  // Ultimate creditor (vide)
  lines.push('', '', '', '', '', '', '');
  // Montant + devise
  lines.push(_fmtMontant(montant));
  lines.push(co.devise || 'CHF');
  // Débiteur (le client payeur) — type structuré si présent
  if (debtor && _q(debtor.nom)) {
    lines.push('S', _q(debtor.nom), _q(debtor.rue), '', _q(debtor.npa), _q(debtor.ville), 'CH');
  } else {
    lines.push('', '', '', '', '', '', '');
  }
  // Référence
  lines.push('NON');                 // pas de référence structurée
  lines.push('');
  // Message libre (n° de facture)
  lines.push(_q(message));
  lines.push('EPD');                 // Trailer
  lines.push('');                    // Bill information
  return lines.join('\r\n');
}

// Génère le QR (dataURL PNG) à partir du payload, avec qrcode-generator
function _makeQrDataUrl(payload) {
  if (typeof qrcode === 'undefined') { console.warn('lib qrcode absente'); return null; }
  const qr = qrcode(0, 'M');
  qr.addData(payload, 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 4, px = 10;
  const total = (count + quiet * 2) * px;
  const canvas = document.createElement('canvas');
  canvas.width = total; canvas.height = total;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, total, total);
  ctx.fillStyle = '#000';
  for (let r = 0; r < count; r++)
    for (let c = 0; c < count; c++)
      if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
  return canvas.toDataURL('image/png');
}

// --- Numérotation auto ---
function _nextDocNumero(type) {
  const year = new Date().getFullYear();
  const prefix = type === 'facture' ? 'F' : 'D';
  // Les factures démarrent à 101 (F-AAAA-101), les devis à 212 (D-AAAA-212).
  const base = (type === 'facture') ? 100 : 211;
  const docs = (DB.documents || []).filter(d => d.type === type && (d.numero || '').includes('-' + year + '-'));
  let max = base;
  docs.forEach(d => {
    const m = (d.numero || '').match(/-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return `${prefix}-${year}-${String(max + 1).padStart(3, '0')}`;
}

// --- Calcul des totaux à partir des lignes (avec rabais avant TVA) ---
function _calcTotaux(lignes, tvaTaux, rabaisTaux, expertise) {
  const r2 = n => Math.round(n * 100) / 100;
  const sousTotal = (lignes || []).reduce((s, l) => s + (parseFloat(l.qte) || 0) * (parseFloat(l.prix) || 0) * (1 - ((parseFloat(l.rabais) || 0) / 100)), 0);
  const rabaisMontant = sousTotal * ((parseFloat(rabaisTaux) || 0) / 100);
  const exp = parseFloat(expertise) || 0;          // déduction expertise (avant TVA, après rabais)
  const net = sousTotal - rabaisMontant - exp;
  const tva = net * ((parseFloat(tvaTaux) || 0) / 100);
  return {
    sousTotal: r2(sousTotal),
    rabaisMontant: r2(rabaisMontant),
    expertise: r2(exp),
    net: r2(net),
    tvaMontant: r2(tva),
    total: r2(net + tva)
  };
}
// Montant de l'expertise à déduire : champ mémoire d.expertise, sinon marqueur [EXPERT:n] dans notes
function _docExpertise(d) {
  if (!d) return 0;
  if (d.expertise !== undefined && d.expertise !== null && d.expertise !== '') return parseFloat(d.expertise) || 0;
  const m = String(d.notes || '').match(/\[EXPERT:([0-9.]+)\]/);
  return m ? (parseFloat(m[1]) || 0) : 0;
}

// --- État de l'éditeur de devis en cours ---
let _editingDoc = null;

// Crée un devis OU une facture pré-rempli depuis un bon
function createDocFromBon(bonId, type) {
  type = type || 'devis';
  const bon = (DB.bons || []).find(b => b.id === bonId);
  if (!bon) { toast('Bon introuvable', '#e63946'); return; }
  const cli = bon.geranceId ? (DB.clients || []).find(c => c.id === bon.geranceId) : null;
  const loc = bon.locataireId ? (DB.locataires || []).find(l => l.id === bon.locataireId)
            : (bon.locataireNom ? (DB.locataires || []).find(l => (l.nom||'').toLowerCase() === bon.locataireNom.toLowerCase()) : null);
  // Ligne principale (problème) + une ligne dédiée aux dates d'intervention effectuées
  const lignes = [
    { desc: _bonProblemeClean(bon) ? ('Intervention : ' + _bonProblemeClean(bon)) : 'Intervention antinuisibles', qte: 1, prix: 0 }
  ];
  const _dInterv = _bonDatesInterv(bon);
  if (_dInterv.length) lignes.push({ desc: 'Dates d\'intervention : ' + _dInterv.map(fmtDate).join(', '), qte: 1, prix: 0 });
  _editingDoc = {
    id: newId(),
    type: type,
    numero: _nextDocNumero(type),
    dateDoc: today(),
    clientId: bon.geranceId || '',
    clientNom: bon.geranceNom || (cli ? cli.nom : ''),
    clientAdresse: cli ? (cli.adresse || '') : '',
    clientNpa: cli ? (cli.npa || '') : '',
    clientVille: cli ? (cli.ville || '') : '',
    locataireNom: bon.locataireNom || '',
    locataireAdresse: loc ? (loc.adresse || '') : '',
    proprietaire: bon.proprietaire || '',
    bonId: bon.id,
    lignes: lignes,
    tvaTaux: DERATEK_CONFIG.company.tvaTaux || 8.1,
    rabais: 5,
    statut: 'brouillon',
    notes: '',
    _bonNote: _bonNoteText(bon)
  };
  openDocEditor();
}
// Raccourcis depuis un bon
function createDevisFromBon(bonId)   { createDocFromBon(bonId, 'devis'); }
function createFactureFromBon(bonId) { createDocFromBon(bonId, 'facture'); }

// Types de clients pour lesquels on propose de créer directement un devis/facture
const CLIENT_TYPES_DOC = ['Particulier', 'PPE', 'Association', 'Commune'];
// Crée un devis OU une facture pré-rempli depuis un client (le client est le destinataire/payeur)
function createDocFromClient(clientId, type) {
  type = type || 'devis';
  const c = (DB.clients || []).find(x => x.id === clientId);
  if (!c) { toast('Client introuvable', '#e63946'); return; }
  _editingDoc = {
    id: newId(), type: type, numero: _nextDocNumero(type), dateDoc: today(),
    clientId: c.id, clientNom: c.nom || '', clientAdresse: c.adresse || '',
    clientNpa: c.npa || '', clientVille: c.ville || '',
    locataireNom: '', locataireAdresse: '', proprietaire: '', bonId: '', nuisible: '',
    lignes: [{ desc: '', qte: 1, prix: 0 }, { desc: "Dates d'intervention : ", qte: 1, prix: 0 }],
    tvaTaux: DERATEK_CONFIG.company.tvaTaux || 8.1, rabais: 5, statut: 'brouillon', notes: ''
  };
  // Bascule sur l'onglet Devis / Factures puis ouvre l'éditeur (le document se crée « dans Factures »)
  if (typeof showDocsScreen === 'function') showDocsScreen(type);
  openDocEditor();
}
function createDevisFromClient(id)   { createDocFromClient(id, 'devis'); }
function createFactureFromClient(id) { createDocFromClient(id, 'facture'); }

// Ouvre un NOUVEAU rapport d'intervention pré-rempli depuis un bon de travaux
// Liste déroulante « 📋 Rapport ▾ » d'un bon : crée le rapport du type choisi,
// pré-rempli depuis le bon (général = rapport d'intervention classique).
function createRapportTypeFromBon(bonId, type) {
  if (!type) return;
  if (type === 'general') { createRapportFromBon(bonId); return; }
  const bon = (DB.bons || []).find(b => b.id === bonId);
  if (!bon) { toast('Bon introuvable', '#e63946'); return; }
  if (type === 'rongeurs') openNewRongeurs(); else if (type === 'blattes') openNewBlattes(); else if (type === 'fourmis') openNewFourmis(); else if (type === 'punaises') openNewPunaises(); else openNewDiagnostic();
  autoFillDiagFromBon(bon.numero || '');
}

function createRapportFromBon(bonId) {
  const bon = (DB.bons || []).find(b => b.id === bonId);
  if (!bon) { toast('Bon introuvable', '#e63946'); return; }
  state.editingRapportId = null;
  resetRapportForm();
  // Gérance / client
  const cli = (bon.geranceId ? (DB.clients||[]).find(c => c.id === bon.geranceId) : null)
           || (bon.geranceNom ? (DB.clients||[]).find(c => (c.nom||'').toLowerCase() === bon.geranceNom.toLowerCase()) : null);
  if (cli) { populateClientSelectRapport(cli.id); onClientChange(); }
  else if (bon.geranceNom && $('r-client')) {
    // Gérance non encore en base : on laisse le select vide mais on remplit le contact
  }
  const setVal = (id, v) => { const el = $(id); if (el && v) el.value = v; };
  // Gérant (contact) — priorité aux infos du bon
  setVal('r-contact', bon.gerantNom || (cli ? cli.contact : ''));
  setVal('r-tel',     bon.gerantTel || (cli ? cli.tel : ''));
  setVal('r-email',   bon.gerantEmail || (cli ? cli.email : ''));
  // Date du jour + n° de bon de commande
  setVal('r-date', today());
  setVal('r-bon-commande', bon.numero || '');
  if ($('r-noint')) $('r-noint').value = bon.numero || $('r-noint').value;
  // Problème → description de l'intervention
  setVal('r-description', _bonProblemeClean(bon) || '');
  // Dates d'intervention effectuées du bon → liste de dates du rapport + nombre de passages
  const datesEff = _bonDatesInterv(bon);
  if (typeof rSetDates === 'function') rSetDates(datesEff);
  if (datesEff.length && $('r-nb-passages')) $('r-nb-passages').value = String(datesEff.length);
  // Locataire (lieu d'intervention)
  const loc = (bon.locataireId ? (DB.locataires||[]).find(l => l.id === bon.locataireId) : null)
           || (bon.locataireNom ? (DB.locataires||[]).find(l => (l.nom||'').toLowerCase() === bon.locataireNom.toLowerCase()) : null);
  const locNom = bon.locataireNom || (loc ? loc.nom : '');
  const locAdr = (loc ? loc.adresse : '') || bon.immeuble || '';
  if (locNom || locAdr || (loc && (loc.tel || loc.email))) {
    if ($('r-avec-locataire')) $('r-avec-locataire').checked = true;
    toggleLocataire();
    setVal('r-locataire', locNom);
    setVal('r-locataire-tel', loc ? loc.tel : '');
    setVal('r-locataire-email', loc ? loc.email : '');
    setVal('r-locataire-adresse', locAdr);
  }
  // Adresse d'intervention (immeuble du bon, sinon adresse du locataire) → on ouvre le bloc
  _setAdresseInter(bon.immeuble || locAdr || '');
  if (typeof updatePDF === 'function') updatePDF();
  showScreen('rapport-edit');
  toast('Rapport pré-rempli depuis le bon ' + (bon.numero || ''), '#2d9e6b');
}

// Crée un rapport depuis un devis/facture. Si le document est lié à un bon,
// on réutilise le pré-remplissage depuis le bon ; sinon on pré-remplit depuis le document.
function createRapportFromDoc(docId, type) {
  if (!type) return;
  const d = (DB.documents || []).find(x => x.id === docId);
  if (!d) { toast('Document introuvable', '#e63946'); return; }
  if (d.bonId) { createRapportTypeFromBon(d.bonId, type); return; }
  // Rapports spécialisés sans bon lié : on ouvre le formulaire vierge du bon type
  if (type === 'rongeurs') { openNewRongeurs(); return; }
  if (type === 'blattes')  { openNewBlattes(); return; }
  if (type === 'fourmis')  { openNewFourmis(); return; }
  if (type === 'punaises') { openNewPunaises(); return; }
  if (type === 'bois')     { openNewDiagnostic(); return; }
  // Rapport général → pré-remplir depuis le document (client, locataire, adresse)
  state.editingRapportId = null;
  resetRapportForm();
  const cli = (d.clientId ? (DB.clients || []).find(c => c.id === d.clientId) : null)
           || (d.clientNom ? (DB.clients || []).find(c => (c.nom || '').toLowerCase() === String(d.clientNom).toLowerCase()) : null);
  if (cli) { populateClientSelectRapport(cli.id); onClientChange(); }
  const setVal = (id, v) => { const el = $(id); if (el && v) el.value = v; };
  setVal('r-contact', d.proprietaire || (cli ? cli.contact : ''));
  setVal('r-tel', cli ? cli.tel : '');
  setVal('r-email', cli ? cli.email : '');
  setVal('r-date', today());
  if (d.locataireNom || d.locataireAdresse) {
    if ($('r-avec-locataire')) $('r-avec-locataire').checked = true;
    toggleLocataire();
    setVal('r-locataire', d.locataireNom);
    setVal('r-locataire-adresse', d.locataireAdresse);
  }
  _setAdresseInter(d.locataireAdresse || '');
  if (typeof updatePDF === 'function') updatePDF();
  showScreen('rapport-edit');
  toast('Rapport pré-rempli depuis ' + (d.type === 'facture' ? 'la facture ' : 'le devis ') + (d.numero || ''), '#2d9e6b');
}

// Nouveau document vierge (devis ou facture)
function openNewDoc(type) {
  type = type || 'devis';
  _editingDoc = {
    id: newId(), type: type, numero: _nextDocNumero(type),
    dateDoc: today(), clientId: '', clientNom: '', clientAdresse: '', clientNpa: '', clientVille: '',
    locataireNom: '', bonId: '', nuisible: '',
    lignes: [{ desc: '', qte: 1, prix: 0 }, { desc: "Dates d'intervention : ", qte: 1, prix: 0 }],
    tvaTaux: DERATEK_CONFIG.company.tvaTaux || 8.1, rabais: 5, statut: 'brouillon', notes: ''
  };
  openDocEditor();
}
function openNewDevis()   { openNewDoc('devis'); }
function openNewFacture() { openNewDoc('facture'); }

// Remplit le document à partir d'un n° de bon saisi dans l'éditeur
function autoFillDocFromBon(numero) {
  if (!_editingDoc || !numero) return;
  const norm = s => String(s||'').replace(/\s+/g,'').toLowerCase();
  const target = norm(numero);
  const bon = (DB.bons || []).find(b => norm(b.numero) === target);
  _editingDoc._bonNumeroSaisi = numero;
  if (!bon) { toast('Aucun bon trouvé avec ce numéro', '#e63946'); return; }
  const cli = bon.geranceId ? (DB.clients || []).find(c => c.id === bon.geranceId) : null;
  _editingDoc.bonId = bon.id;
  _editingDoc.clientId = bon.geranceId || '';
  _editingDoc.clientNom = bon.geranceNom || (cli ? cli.nom : '');
  _editingDoc.clientAdresse = cli ? (cli.adresse || '') : '';
  _editingDoc.clientNpa = cli ? (cli.npa || '') : '';
  _editingDoc.clientVille = cli ? (cli.ville || '') : '';
  _editingDoc.locataireNom = bon.locataireNom || '';
  const locAf = bon.locataireId ? (DB.locataires || []).find(l => l.id === bon.locataireId)
            : (bon.locataireNom ? (DB.locataires || []).find(l => (l.nom||'').toLowerCase() === bon.locataireNom.toLowerCase()) : null);
  _editingDoc.locataireAdresse = locAf ? (locAf.adresse || '') : '';
  _editingDoc.proprietaire = bon.proprietaire || '';
  _editingDoc._bonNote = _bonNoteText(bon);
  // Pré-remplit une ligne avec le problème du bon (l'utilisateur n'a plus qu'à mettre le prix + ajuster la désignation)
  if (_editingDoc.lignes.length === 1 && !(_editingDoc.lignes[0].desc || '').trim()) {
    _editingDoc.lignes[0].desc = _bonProblemeClean(bon) ? ('Intervention : ' + _bonProblemeClean(bon)) : 'Intervention antinuisibles';
  }
  // Ajoute une ligne dédiée aux dates d'intervention effectuées (si pas déjà présente)
  const _dInterv = _bonDatesInterv(bon);
  if (_dInterv.length) {
    const ligneDates = 'Dates d\'intervention : ' + _dInterv.map(fmtDate).join(', ');
    if (!_editingDoc.lignes.some(l => (l.desc || '').indexOf('Dates d\'intervention') === 0)) {
      _editingDoc.lignes.push({ desc: ligneDates, qte: 1, prix: 0 });
    }
  }
  toast('✓ Rempli depuis le bon ' + bon.numero + ' (' + (_editingDoc.clientNom||'') + ')', '#2d9e6b');
  renderDocEditor();
}

// Sélection d'un client dans le dropdown de l'éditeur → pré-remplit les coordonnées
function onDocClientSelect(clientId) {
  if (!_editingDoc) return;
  const c = (DB.clients || []).find(x => x.id === clientId);
  if (!c) { _editingDoc.clientId = ''; return; }
  _editingDoc.clientId = c.id;
  _editingDoc.clientNom = c.nom || '';
  _editingDoc.clientAdresse = c.adresse || '';
  _editingDoc.clientNpa = c.npa || '';
  _editingDoc.clientVille = c.ville || '';
  renderDocEditor();
}

// Édite un document existant
function editDoc(id) {
  const d = (DB.documents || []).find(x => x.id === id);
  if (!d) return;
  // Rappel sauvegardé → on le rouvre en mode rappel (sans la logique de réparation des totaux)
  if (_isRappelDoc(d)) {
    _editingDoc = JSON.parse(JSON.stringify(d));
    if (!_editingDoc.lignes || !_editingDoc.lignes.length) _editingDoc.lignes = [{ desc: '', qte: 1, prix: 0 }];
    _applyRappelRuntime(_editingDoc);
    openDocEditor();
    return;
  }
  _editingDoc = JSON.parse(JSON.stringify(d));
  if (!_editingDoc.lignes || !_editingDoc.lignes.length) _editingDoc.lignes = [{ desc: '', qte: 1, prix: 0 }];
  if (_editingDoc.rabais === undefined || _editingDoc.rabais === null) _editingDoc.rabais = 0;
  // Déduction expertise : on lit le marqueur [EXPERT:n] et on le retire de la note affichée
  _editingDoc.expertise = _docExpertise(_editingDoc);
  // Devis archivé avec sa facture : on retire le marqueur de l'affichage mais on le restaure à la sauvegarde
  _editingDoc._wasDevisArch = /\[DEVISARCH\]/.test(String(_editingDoc.notes || ''));
  _editingDoc.notes = String(_editingDoc.notes || '').replace(/\s*\[DEVISARCH\]\s*/g, ' ').replace(/\s*\[EXPERT:[^\]]*\]\s*/g, ' ').trim();
  // Réparation : on prend comme cible le sous-total recalculé depuis le TOTAL TTC stocké
  // (plus fiable que le sous-total HT que l'IA peut avoir mal extrait)
  const sommeLignes = _editingDoc.lignes.reduce((s, l) => s + (parseFloat(l.qte)||0) * (parseFloat(l.prix)||0) * (1 - ((parseFloat(l.rabais)||0)/100)), 0);
  const totalStocke = parseFloat(_editingDoc.total) || 0;
  const sousTotalStocke = parseFloat(_editingDoc.sousTotal) || 0;
  const rabaisTaux = parseFloat(_editingDoc.rabais) || 0;
  const tvaTauxDoc = parseFloat(_editingDoc.tvaTaux) || 8.1;
  let cibleSousTotal = sousTotalStocke;
  if (totalStocke > 0) {
    const facteur = (1 - rabaisTaux/100) * (1 + tvaTauxDoc/100);
    // On réintègre l'expertise déduite pour retrouver le vrai sous-total des lignes
    const sousTotalDepuisTtc = (totalStocke + (parseFloat(_editingDoc.expertise)||0) * (1 + tvaTauxDoc/100)) / facteur;
    // Si la somme actuelle ne s'aligne ni au sous-total stocké ni à celui calculé depuis le TTC,
    // on privilégie le TTC qui est l'info la plus fiable du PDF
    if (Math.abs(sommeLignes - sousTotalDepuisTtc) > 1) {
      cibleSousTotal = Math.round(sousTotalDepuisTtc * 100) / 100;
    }
  }
  if (cibleSousTotal > 0 && Math.abs(sommeLignes - cibleSousTotal) > 0.5) {
    if (sommeLignes === 0) {
      _editingDoc.lignes.push({ desc: 'Forfait global (selon document original)', qte: 1, prix: cibleSousTotal });
    } else {
      _editingDoc.lignes.push({ desc: 'Ajustement / complément', qte: 1, prix: Math.round((cibleSousTotal - sommeLignes) * 100) / 100 });
    }
  }
  openDocEditor();
}

// Ouvre la modale d'édition
function openDocEditor() {
  renderDocEditor();
  openModal('modal-doc');
}
// Change le bureau émetteur (adresse) du document en cours
function docSetBureau(id) {
  if (!_editingDoc) return;
  _editingDoc.bureauId = id;
  renderDocEditor();
  const bu = _docBureau(_editingDoc);
  toast('Bureau : DERATEK ' + bu.label, '#2d9e6b');
}

// Prestations par défaut (toujours proposées dans le menu déroulant)
const DEFAULT_PRESTATIONS = [
  { libelle: 'Main-d\'œuvre', prix: 0 },
  { libelle: 'Matériel', prix: 0 },
  { libelle: 'Traitement d\'un nid de guêpes dans un caisson de store', prix: 0 },
  { libelle: 'Traitement d\'un nid de guêpes en toiture', prix: 0 },
  { libelle: 'Traitement contre les fouines', prix: 0 },
  { libelle: 'Traitement dératisation', prix: 0 },
];
// Liste fusionnée : défauts + prestations ajoutées par l'utilisateur (sans doublon)
function getAllPrestations() {
  const custom = DB.prestations || [];
  const seen = new Set();
  const out = [];
  custom.concat(DEFAULT_PRESTATIONS).forEach(p => {
    const key = (p.libelle || '').toLowerCase().trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(p);
  });
  return out.sort((a, b) => (a.libelle||'').localeCompare(b.libelle||''));
}
// Sélection d'une prestation modèle → remplit la description (et le prix si défini)
function onLignePresta(i, value) {
  if (!value || !_editingDoc || !_editingDoc.lignes[i]) return;
  if (value.indexOf('presta:') === 0) {
    // Prestation par nuisible (BON_NOTE_PRESTATIONS) → on insère la description complète
    const [gi, ii] = value.slice(7).split('-').map(Number);
    const it = BON_NOTE_PRESTATIONS[gi] && BON_NOTE_PRESTATIONS[gi].items[ii];
    if (it) _editingDoc.lignes[i].desc = it.desc;
  } else {
    const libelle = (value.indexOf('lib:') === 0) ? value.slice(4) : value;
    _editingDoc.lignes[i].desc = libelle;
    const p = getAllPrestations().find(x => x.libelle === libelle);
    if (p && parseFloat(p.prix) > 0) _editingDoc.lignes[i].prix = parseFloat(p.prix);
  }
  renderDocEditor();
}
// Change le nuisible du document (filtre les prestations proposées par ligne)
function docSetNuisible(v) {
  if (!_editingDoc) return;
  _editingDoc.nuisible = v || '';
  renderDocEditor();
}
function docSetNuisible2(v) {
  if (!_editingDoc) return;
  _editingDoc.nuisible2 = v || '';
  renderDocEditor();
}
// Options du menu "prestation" d'une ligne : prestations du nuisible choisi + standards toujours présents
function _docPrestaOptions(nuisibles) {
  let html = '<option value="">＋ Choisir une prestation…</option>';
  _prestaMatchGroups(nuisibles).forEach(g => {
    const gi = BON_NOTE_PRESTATIONS.indexOf(g);
    html += `<optgroup label="${g.groupe}">` +
      g.items.map((it, ii) => `<option value="presta:${gi}-${ii}">${it.label}</option>`).join('') +
      '</optgroup>';
  });
  html += '<optgroup label="Standard">' +
    '<option value="lib:Matériel et main d\'œuvre">Matériel et main d\'œuvre</option>' +
    '<option value="lib:Dates d\'intervention : ">Dates d\'intervention</option>' +
    getAllPrestations().map(p => `<option value="lib:${(p.libelle||'').replace(/"/g,'&quot;')}">${(p.libelle||'').replace(/</g,'&lt;')}</option>`).join('') +
    '</optgroup>';
  return html;
}
// Enregistre la description (et le prix) d'une ligne comme nouvelle prestation modèle
function addPrestaModel(i) {
  if (!_editingDoc || !_editingDoc.lignes[i]) return;
  const desc = (_editingDoc.lignes[i].desc || '').trim();
  if (!desc) { toast('Écris d\'abord une description', '#e63946'); return; }
  const prix = parseFloat(_editingDoc.lignes[i].prix) || 0;
  const all = getAllPrestations();
  if (all.some(p => (p.libelle||'').toLowerCase() === desc.toLowerCase())) {
    toast('Cette prestation existe déjà dans les modèles', '#f4a623'); return;
  }
  const list = DB.prestations;
  list.push({ id: newId(), libelle: desc, prix: prix });
  DB.prestations = list;
  toast('✓ Prestation ajoutée aux modèles', '#2d9e6b');
  renderDocEditor();
}

// --- Gestionnaire de prestations (catalogue) ---
function openPrestationsModal() {
  renderPrestationsList();
  openModal('modal-prestations');
}
function renderPrestationsList() {
  const box = $('prestations-list');
  if (!box) return;
  const custom = DB.prestations || [];
  const defauts = DEFAULT_PRESTATIONS;
  const row = (libelle, prix, id) => `
    <div style="display:flex;align-items:center;gap:8px;padding:7px 9px;border:1px solid #eee;border-radius:6px;margin-bottom:5px;">
      <div style="flex:1;font-size:13px;">${(libelle||'').replace(/</g,'&lt;')}</div>
      <div style="font-size:12px;color:var(--g600);width:90px;text-align:right;">${parseFloat(prix)>0 ? _displayMontant(prix)+' CHF' : '—'}</div>
      ${id ? `<button class="btn btn-red btn-xs" onclick="deletePrestation('${id}')" title="Supprimer">🗑</button>` : '<span style="font-size:10px;color:var(--g400);width:24px;text-align:center;" title="Prestation par défaut">🔒</span>'}
    </div>`;
  let html = '';
  if (custom.length) {
    html += '<div style="font-size:11px;font-weight:800;color:var(--navy);text-transform:uppercase;margin:4px 0 6px;">Mes prestations</div>';
    html += custom.slice().sort((a,b)=>(a.libelle||'').localeCompare(b.libelle||'')).map(p => row(p.libelle, p.prix, p.id)).join('');
  }
  html += '<div style="font-size:11px;font-weight:800;color:var(--g400);text-transform:uppercase;margin:12px 0 6px;">Prestations par défaut</div>';
  html += defauts.map(p => row(p.libelle, p.prix, null)).join('');
  box.innerHTML = html;
}
function addPrestationFromModal() {
  const libelle = ($('presta-libelle').value || '').trim();
  const prix = parseFloat($('presta-prix').value) || 0;
  if (!libelle) { toast('Indique un libellé', '#e63946'); return; }
  const all = getAllPrestations();
  if (all.some(p => (p.libelle||'').toLowerCase() === libelle.toLowerCase())) {
    toast('Cette prestation existe déjà', '#f4a623'); return;
  }
  const list = DB.prestations;
  list.push({ id: newId(), libelle: libelle, prix: prix });
  DB.prestations = list;
  $('presta-libelle').value = ''; $('presta-prix').value = '';
  toast('✓ Prestation ajoutée', '#2d9e6b');
  renderPrestationsList();
}
function deletePrestation(id) {
  DB.prestations = (DB.prestations || []).filter(p => p.id !== id);
  toast('Prestation supprimée', '#e63946');
  renderPrestationsList();
}

// Rendu de l'éditeur (lignes + totaux)
function renderDocEditor() {
  const d = _editingDoc;
  if (!d) return;
  const t = _calcTotaux(d.lignes, d.tvaTaux, d.rabais, d.expertise);
  const titre = d._rappel
    ? ('Rappel — Facture ' + (d.numero || ''))
    : ((d.type === 'facture' ? 'Facture ' : 'Devis ') + (d.numero || ''));
  const prestaOpts = _docPrestaOptions([d.nuisible, d.nuisible2]);
  const lignesHtml = d.lignes.map((l, i) => `
    <tr>
      <td style="padding:3px;">
        <select onchange="onLignePresta(${i}, this.value)" style="font-size:11px;width:100%;margin-bottom:3px;border-radius:4px;border:1px solid #ddd;padding:3px;color:var(--g600);">
          <option value="">＋ Choisir une prestation modèle…</option>
          ${prestaOpts}
        </select>
        <textarea class="form-input" rows="2" style="font-size:12px;resize:vertical;min-height:34px;line-height:1.4;" oninput="updateDocLigne(${i},'desc',this.value)" onpaste="docDescPaste(event,${i})" placeholder="Description libre (retours à la ligne possibles)">${(l.desc||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
      </td>
      <td style="padding:3px;width:70px;vertical-align:top;"><input class="form-input" type="number" step="0.01" style="font-size:12px;text-align:right;" value="${l.qte||0}" oninput="updateDocLigne(${i},'qte',this.value)"></td>
      <td style="padding:3px;width:100px;vertical-align:top;"><input class="form-input" type="number" step="0.01" style="font-size:12px;text-align:right;" value="${l.prix||0}" oninput="updateDocLigne(${i},'prix',this.value)"></td>
      <td style="padding:3px;width:62px;vertical-align:top;"><input class="form-input" type="number" step="1" min="0" max="100" style="font-size:12px;text-align:right;" value="${l.rabais||0}" oninput="updateDocLigne(${i},'rabais',this.value)" title="Rabais sur cette ligne (%) — ex. 50 pour le 2e nid"></td>
      <td id="lt-${i}" style="padding:3px;width:100px;text-align:right;font-size:12px;font-weight:600;vertical-align:top;">${_displayMontant((parseFloat(l.qte)||0)*(parseFloat(l.prix)||0)*(1-((parseFloat(l.rabais)||0)/100)))}</td>
      <td style="padding:3px;width:54px;text-align:center;vertical-align:top;">
        <button class="btn btn-ghost btn-xs" onclick="addPrestaModel(${i})" title="Enregistrer cette description comme modèle">💾</button>
        <button class="btn btn-red btn-xs" onclick="removeDocLigne(${i})" title="Supprimer la ligne">✕</button>
      </td>
    </tr>
  `).join('');
  const box = $('modal-doc-form') || $('modal-doc-body');
  if (!box) return;
  const noteHtml = (d._bonNote && d._bonNote.trim())
    ? `<div style="background:#fffbeb;border:1.5px solid #f59e0b;border-radius:8px;padding:10px 12px;margin-bottom:12px;">
         <div style="font-size:11px;font-weight:800;color:#b45309;text-transform:uppercase;letter-spacing:.3px;margin-bottom:4px;">📝 Note interne du bon (pour la facturation)</div>
         <div style="font-size:13px;color:#7c2d12;white-space:pre-wrap;">${(d._bonNote).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
       </div>`
    : '';
  const n = Math.min(3, Math.max(1, parseInt(d._rappelNiveau, 10) || 1));
  const rappelHtml = d._rappel
    ? `<div style="background:#fef2f2;border:1.5px solid #dc2626;border-radius:8px;padding:12px 14px;margin-bottom:14px;">
         <div style="font-size:12px;font-weight:800;color:#b91c1c;text-transform:uppercase;letter-spacing:.3px;margin-bottom:10px;">📄 Options du rappel de paiement</div>
         <div class="form-group" style="margin-bottom:10px;max-width:340px;">
           <label class="form-label" style="font-weight:700;">Niveau de rappel</label>
           <select class="form-input" onchange="rappelEditSetNiveau(this.value)" style="font-weight:600;">
             <option value="1" ${n===1?'selected':''}>1er rappel</option>
             <option value="2" ${n===2?'selected':''}>2e rappel (+60 CHF)</option>
             <option value="3" ${n===3?'selected':''}>3e rappel — mise en demeure</option>
           </select>
         </div>
         <div class="form-group" style="margin-bottom:0;">
           <label class="form-label" style="font-weight:700;">Texte du rappel <span style="font-weight:400;color:#6b7280;">— modifiable, ajoute ici tes infos complémentaires</span></label>
           <textarea class="form-input" rows="6" style="resize:vertical;font-size:13px;" oninput="_editingDoc._rappelTexte=this.value;_docPdfLive()">${(d._rappelTexte||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
         </div>
       </div>`
    : '';
  box.innerHTML = `
    ${noteHtml}
    ${rappelHtml}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
      <div class="form-group" style="grid-column:1 / -1;">
        <label class="form-label">🏢 Bureau émetteur (adresse imprimée sur le document)</label>
        <select class="form-input" onchange="docSetBureau(this.value)" style="font-weight:600;">
          ${BUREAUX.map(bu => `<option value="${bu.id}" ${(d.bureauId||'ne')===bu.id?'selected':''}>DERATEK ${bu.label} — ${bu.rue}, ${bu.npa} ${bu.ville} · Tél. ${bu.tel}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">🐛 Nuisible concerné (filtre les prestations)</label>
        <select class="form-input" onchange="docSetNuisible(this.value)" style="font-size:13px;">${_bonNoteNuisibleOptions(d.nuisible || '')}</select>
      </div>
      <div class="form-group">
        <label class="form-label">🐛 2ᵉ nuisible (optionnel)</label>
        <select class="form-input" onchange="docSetNuisible2(this.value)" style="font-size:13px;">${_bonNoteNuisibleOptions(d.nuisible2 || '')}</select>
      </div>
      <div class="form-group"><label class="form-label">Client (gérance)</label>
        <select class="form-input" id="doc-client-select" onchange="onDocClientSelect(this.value)">
          <option value="">-- Choisir un client --</option>
          ${(DB.clients||[]).slice().sort((a,b)=>(a.nom||'').localeCompare(b.nom||'')).map(c=>`<option value="${c.id}" ${d.clientId===c.id?'selected':''}>${_clientOptionLabel(c).replace(/</g,'&lt;')}</option>`).join('')}
        </select>
        <textarea class="form-input" style="margin-top:5px;font-size:12px;resize:vertical;" rows="2" placeholder="ou saisir un nom manuellement — Entrée = nouvelle ligne sur le PDF" oninput="_editingDoc.clientNom=this.value;_editingDoc.clientId='';">${(d.clientNom||'').replace(/</g,'&lt;')}</textarea>
      </div>
      <div class="form-group"><label class="form-label">Locataire concerné</label><input class="form-input" id="doc-loc" value="${(d.locataireNom||'').replace(/"/g,'&quot;')}" oninput="_editingDoc.locataireNom=this.value"></div>
      <div class="form-group"><label class="form-label">Propriétaire (destinataire)</label><textarea class="form-input" style="resize:vertical;" rows="2" oninput="_editingDoc.proprietaire=this.value" placeholder="Ex. Monsieur Aldo Brauen — Entrée = nouvelle ligne sur le PDF">${(d.proprietaire||'').replace(/</g,'&lt;')}</textarea></div>
      <div class="form-group" style="grid-column:1 / -1;"><label class="form-label">Adresse du locataire</label><input class="form-input" value="${(d.locataireAdresse||'').replace(/"/g,'&quot;')}" oninput="_editingDoc.locataireAdresse=this.value" placeholder="Rue, étage, NPA ville"></div>
      <div class="form-group"><label class="form-label">Adresse client</label><textarea class="form-input" style="resize:vertical;" rows="2" oninput="_editingDoc.clientAdresse=this.value" placeholder="Entrée = nouvelle ligne sur le PDF">${(d.clientAdresse||'').replace(/</g,'&lt;')}</textarea></div>
      <div style="display:grid;grid-template-columns:1fr 2fr;gap:8px;">
        <div class="form-group"><label class="form-label">NPA</label><input class="form-input" value="${(d.clientNpa||'').replace(/"/g,'&quot;')}" oninput="_editingDoc.clientNpa=this.value"></div>
        <div class="form-group"><label class="form-label">Ville</label><input class="form-input" value="${(d.clientVille||'').replace(/"/g,'&quot;')}" oninput="_editingDoc.clientVille=this.value"></div>
      </div>
      <div class="form-group"><label class="form-label">N° de bon (remplissage auto)</label><input class="form-input" id="doc-bon-numero" value="${(d._bonNumeroSaisi||'').replace(/"/g,'&quot;')}" placeholder="Tape le n° du bon puis Entrée" onchange="autoFillDocFromBon(this.value)" onblur="autoFillDocFromBon(this.value)"></div>
      <div class="form-group"><label class="form-label">Date</label><input class="form-input" type="date" value="${d.dateDoc||''}" oninput="_editingDoc.dateDoc=this.value"></div>
      <div class="form-group"><label class="form-label">Rabais (%)</label><input class="form-input" type="number" step="0.1" value="${d.rabais||0}" oninput="docSetMontantField('rabais',this.value)"></div>
      <div class="form-group"><label class="form-label">TVA (%)</label><input class="form-input" type="number" step="0.1" value="${d.tvaTaux}" oninput="docSetMontantField('tvaTaux',this.value)"></div>
      <div class="form-group" style="grid-column:1 / -1;"><label class="form-label">🔍 Déduction expertise (CHF) — déduite avant TVA</label><input class="form-input" type="number" step="0.01" min="0" value="${d.expertise||0}" oninput="docSetMontantField('expertise',this.value)" placeholder="Ex. 150 — montant de l'expertise à créditer si le devis est accepté"></div>
    </div>
    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin:6px 0;">Lignes</div>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="font-size:10px;color:var(--g400);text-transform:uppercase;text-align:left;">
        <th style="padding:3px;">Description</th><th style="padding:3px;text-align:right;">Qté</th><th style="padding:3px;text-align:right;">Prix unit.</th><th style="padding:3px;text-align:right;">Rabais %</th><th style="padding:3px;text-align:right;">Total</th><th></th>
      </tr></thead>
      <tbody>${lignesHtml}</tbody>
    </table>
    <button class="btn btn-ghost btn-sm" onclick="addDocLigne()" style="margin-top:8px;">+ Ajouter une ligne</button>
    <div id="doc-summary" style="margin-top:14px;margin-left:auto;width:280px;font-size:13px;">${_docSummaryHtml(t, d)}</div>
    <div class="form-group" style="margin-top:10px;"><label class="form-label">Notes / conditions</label><textarea class="form-input" rows="2" oninput="_editingDoc.notes=this.value">${d.notes||''}</textarea></div>
    ${(d.type === 'devis' && !d._rappel) ? `
      <div style="margin-top:12px;border-top:1px dashed #ccc;padding-top:12px;">
        <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">📷 Photos (incluses dans le PDF)</div>
        <input type="file" id="doc-photos-file" accept="image/*" multiple style="display:none" onchange="docAddPhotos(event)">
        <button class="btn btn-navy btn-sm" type="button" onclick="document.getElementById('doc-photos-file').click()">📷 Ajouter des photos</button>
        <span style="font-size:11px;color:var(--g400);margin-left:6px;">Ajoutées au PDF du devis (non stockées — à ajouter avant de générer le PDF).</span>
        <div id="doc-photos-box" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;"></div>
      </div>` : ''}
    ${(d.type === 'facture' && !d._rappel) ? `
      <div style="margin-top:14px;border-top:1px dashed #ccc;padding-top:12px;">
        <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🇨🇭 Aperçu QR-facture</div>
        <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;">
          <div id="doc-qr-preview" style="width:120px;height:120px;background:#fff;border:1px solid #e5e7eb;border-radius:6px;display:flex;align-items:center;justify-content:center;"></div>
          <div style="font-size:11px;color:var(--g600);line-height:1.6;">
            <div><b>Créancier :</b> ${DERATEK_CONFIG.company.nom} (${_docBureau(d).label}) — ${_docBureau(d).rue}, ${_docBureau(d).npa} ${_docBureau(d).ville}</div>
            <div><b>IBAN :</b> ${_displayIban(DERATEK_CONFIG.company.iban)}</div>
            <div><b>Payable par :</b> ${d.clientNom || '(client non défini)'}</div>
            <div><b>Montant :</b> ${_displayMontant(t.total)} CHF</div>
            <div><b>Communication :</b> Facture ${d.numero || ''}</div>
            <div style="color:var(--g400);margin-top:4px;">Le QR-bill complet sera dans le PDF (bouton « 📥 PDF »).</div>
          </div>
        </div>
      </div>
    ` : ''}
  `;
  const title = $('modal-doc-title'); if (title) title.textContent = titre;
  // Boutons du pied de page : mode rappel → bouton « Générer le PDF du rappel »
  const ft = $('modal-doc-ft');
  if (ft) {
    ft.innerHTML = d._rappel
      ? `<button class="btn btn-ghost" onclick="closeModal('modal-doc')">Annuler</button>
         <button class="btn btn-navy" onclick="rappelGenererDepuisEditeur()">📄 Générer le PDF du rappel</button>`
      : `<button class="btn btn-ghost" onclick="closeModal('modal-doc')">Annuler</button>
         <button class="btn btn-ghost" onclick="saveDocBrouillon()" title="Enregistrer en brouillon pour le finir plus tard (rappel dans Factures)">💾 Brouillon — à finir</button>
         <button class="btn btn-ghost" onclick="downloadDocPDF(_editingDoc)" title="Télécharger le PDF (avec les photos ajoutées)">📥 Télécharger le PDF</button>
         <button class="btn btn-navy" onclick="saveDoc()">✓ Enregistrer</button>`;
  }
  // Génère l'aperçu QR pour les factures
  if (d.type === 'facture' && !d._rappel) {
    try {
      const debtor = { nom: d.clientNom, rue: d.clientAdresse, npa: d.clientNpa, ville: d.clientVille };
      const payload = _buildSpcPayload(t.total, 'Facture ' + (d.numero || ''), debtor, _docBureau(d));
      const url = _makeQrDataUrl(payload);
      const prev = $('doc-qr-preview');
      if (prev && url) prev.innerHTML = `<img src="${url}" style="width:116px;height:116px;">`;
    } catch (e) { console.warn('QR preview', e); }
  }
  if (typeof docRenderPhotos === 'function') docRenderPhotos();
  _docPdfLive();   // aperçu PDF en direct à droite
}

// Aperçu PDF en direct du document en cours d'édition (panneau de droite de l'éditeur).
let _docPdfLiveTimer = null, _docPdfLiveUrl = null;
let _docPdfZoom = 0;   // 0 = ajusté à la largeur ; sinon zoom en pourcentage
const _DOC_PDF_ZOOMS = [50, 75, 100, 125, 150, 200, 300];
function _docPdfSrc(url) {
  return url + '#toolbar=0&navpanes=0&' + (_docPdfZoom ? ('zoom=' + _docPdfZoom) : 'view=FitH');
}
// delta : +1 / -1 pour zoomer, 0 pour revenir à « ajusté à la largeur »
function docPdfZoom(delta) {
  if (!delta) {
    _docPdfZoom = 0;
  } else {
    const cur = _docPdfZoom || 100;
    let i = _DOC_PDF_ZOOMS.indexOf(cur);
    if (i < 0) { i = _DOC_PDF_ZOOMS.findIndex(s => s >= cur); if (i < 0) i = _DOC_PDF_ZOOMS.length - 1; }
    i = Math.max(0, Math.min(_DOC_PDF_ZOOMS.length - 1, i + delta));
    _docPdfZoom = _DOC_PDF_ZOOMS[i];
  }
  const lbl = document.getElementById('doc-pdf-zoom-lbl');
  if (lbl) lbl.textContent = _docPdfZoom ? (_docPdfZoom + '%') : 'Ajusté';
  const ifr = document.getElementById('doc-pdf-preview');
  if (ifr && _docPdfLiveUrl) ifr.src = _docPdfSrc(_docPdfLiveUrl);
}
// Ouvre l'aperçu en grand dans un nouvel onglet (pleine page)
function docPdfOpenFull() {
  let u = _docPdfLiveUrl;
  if (!u && _editingDoc) { try { u = downloadDocPDF(_editingDoc, 'blob'); } catch (e) {} }
  if (u) window.open(u, '_blank');
  else toast('Aperçu indisponible', '#e63946');
}
function _docPdfLive() {
  if (!_editingDoc) return;
  clearTimeout(_docPdfLiveTimer);
  _docPdfLiveTimer = setTimeout(() => {
    const ifr = document.getElementById('doc-pdf-preview');
    if (!ifr) return;
    try {
      const url = downloadDocPDF(_editingDoc, 'blob');
      if (!url) return;
      if (_docPdfLiveUrl) { try { URL.revokeObjectURL(_docPdfLiveUrl); } catch (e) {} }
      _docPdfLiveUrl = url;
      ifr.src = _docPdfSrc(url);
    } catch (e) { console.warn('aperçu live', e); }
  }, 350);
}

// HTML du bloc récapitulatif des totaux
function _docSummaryHtml(t, d) {
  return `
    <div style="display:flex;justify-content:space-between;padding:3px 0;"><span>Sous-total HT</span><b>${_displayMontant(t.sousTotal)} CHF</b></div>
    ${(d.rabais||0) > 0 ? `<div style="display:flex;justify-content:space-between;padding:3px 0;color:#e63946;"><span>Rabais ${d.rabais}%</span><span>− ${_displayMontant(t.rabaisMontant)} CHF</span></div>` : ''}
    ${(t.expertise||0) > 0 ? `<div style="display:flex;justify-content:space-between;padding:3px 0;color:#e63946;"><span>Déduction expertise</span><span>− ${_displayMontant(t.expertise)} CHF</span></div>` : ''}
    ${((d.rabais||0) > 0 || (t.expertise||0) > 0) ? `<div style="display:flex;justify-content:space-between;padding:3px 0;"><span>Net HT</span><b>${_displayMontant(t.net)} CHF</b></div>` : ''}
    <div style="display:flex;justify-content:space-between;padding:3px 0;color:var(--g600);"><span>TVA ${d.tvaTaux}%</span><span>${_displayMontant(t.tvaMontant)} CHF</span></div>
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-top:2px solid var(--navy);font-size:15px;font-weight:800;color:var(--navy);"><span>Total TTC</span><span>${_displayMontant(t.total)} CHF</span></div>`;
}

// Mise à jour d'une ligne SANS re-render complet (évite la perte de focus à la frappe)
function updateDocLigne(i, field, val) {
  if (!_editingDoc || !_editingDoc.lignes[i]) return;
  _editingDoc.lignes[i][field] = (field === 'desc') ? val : (parseFloat(val) || 0);
  // La description n'affecte pas les montants, mais on rafraîchit quand même l'aperçu PDF
  if (field === 'desc') { if (typeof _docPdfLive === 'function') _docPdfLive(); return; }
  // Pour qté/prix : mettre à jour uniquement la cellule total de la ligne + le récapitulatif
  const l = _editingDoc.lignes[i];
  const cell = $('lt-' + i);
  if (cell) cell.textContent = _displayMontant((parseFloat(l.qte)||0) * (parseFloat(l.prix)||0) * (1 - ((parseFloat(l.rabais)||0)/100)));
  const t = _calcTotaux(_editingDoc.lignes, _editingDoc.tvaTaux, _editingDoc.rabais, _editingDoc.expertise);
  const sum = $('doc-summary');
  if (sum) sum.innerHTML = _docSummaryHtml(t, _editingDoc);
  // Met à jour aussi l'aperçu QR (facture) sans reconstruire les champs
  if (_editingDoc.type === 'facture') {
    try {
      const debtorNom = (_editingDoc.proprietaire||'').trim() ? _editingDoc.proprietaire : _editingDoc.clientNom;
      const payload = _buildSpcPayload(t.total, 'Facture ' + (_editingDoc.numero||''), { nom: debtorNom, rue: _editingDoc.clientAdresse, npa: _editingDoc.clientNpa, ville: _editingDoc.clientVille });
      const url = _makeQrDataUrl(payload);
      const prev = $('doc-qr-preview');
      if (prev && url) prev.innerHTML = `<img src="${url}" style="width:116px;height:116px;">`;
    } catch (e) {}
  }
}
// Met à jour rabais / TVA / expertise SANS reconstruire l'éditeur (garde le focus à la frappe)
function docSetMontantField(field, val) {
  if (!_editingDoc) return;
  _editingDoc[field] = parseFloat(val) || 0;
  const t = _calcTotaux(_editingDoc.lignes, _editingDoc.tvaTaux, _editingDoc.rabais, _editingDoc.expertise);
  const sum = $('doc-summary');
  if (sum) sum.innerHTML = _docSummaryHtml(t, _editingDoc);
  if (_editingDoc.type === 'facture') {
    try {
      const debtorNom = (_editingDoc.proprietaire||'').trim() ? _editingDoc.proprietaire : _editingDoc.clientNom;
      const payload = _buildSpcPayload(t.total, 'Facture ' + (_editingDoc.numero||''), { nom: debtorNom, rue: _editingDoc.clientAdresse, npa: _editingDoc.clientNpa, ville: _editingDoc.clientVille });
      const url = _makeQrDataUrl(payload);
      const prev = $('doc-qr-preview');
      if (prev && url) prev.innerHTML = `<img src="${url}" style="width:116px;height:116px;">`;
    } catch (e) {}
  }
  if (typeof _docPdfLive === 'function') _docPdfLive();
}
function addDocLigne() { _editingDoc.lignes.push({ desc: '', qte: 1, prix: 0 }); renderDocEditor(); }
function removeDocLigne(i) { _editingDoc.lignes.splice(i, 1); if (!_editingDoc.lignes.length) _editingDoc.lignes.push({ desc: '', qte: 1, prix: 0 }); renderDocEditor(); }
// Colle du texte dans une désignation en retirant les marqueurs de gras ** (sinon ils s'affichent en astérisques)
function docDescPaste(ev, i) {
  ev.preventDefault();
  let txt = ((ev.clipboardData || window.clipboardData).getData('text') || '').replace(/\*\*/g, '');
  const ta = ev.target;
  const s = ta.selectionStart, e = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + txt + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + txt.length;
  updateDocLigne(i, 'desc', ta.value);
}

// --- Photos du devis (en mémoire uniquement, incluses dans le PDF) ---
function docAddPhotos(ev) {
  const files = [...(ev.target.files || [])]; if (!files.length) return;
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1000, r = Math.min(1, MAX / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * r); cv.height = Math.round(img.height * r);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        if (!_editingDoc) return;
        if (!Array.isArray(_editingDoc.photos)) _editingDoc.photos = [];
        _editingDoc.photos.push({ data: cv.toDataURL('image/jpeg', 0.82), caption: '', use: true });
        docRenderPhotos(); _docPdfLive();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
  ev.target.value = '';
}
function docRemovePhoto(i) { if (_editingDoc && Array.isArray(_editingDoc.photos)) { _editingDoc.photos.splice(i, 1); docRenderPhotos(); _docPdfLive(); } }
function docSetPhotoCaption(i, v) { if (_editingDoc && _editingDoc.photos && _editingDoc.photos[i]) { _editingDoc.photos[i].caption = v; _docPdfLive(); } }
function docRenderPhotos() {
  const box = $('doc-photos-box'); if (!box) return;
  const photos = (_editingDoc && _editingDoc.photos) || [];
  box.innerHTML = photos.map((p, i) => `
    <div style="width:150px;">
      <img src="${p.data}" style="width:150px;height:105px;object-fit:cover;border-radius:6px;border:1px solid #e5e7eb;">
      <input class="form-input" style="font-size:11px;margin-top:4px;" placeholder="Légende (optionnel)" value="${(p.caption||'').replace(/"/g,'&quot;')}" oninput="docSetPhotoCaption(${i},this.value)">
      <button class="btn btn-red btn-xs" style="margin-top:3px;width:100%;" onclick="docRemovePhoto(${i})">🗑 Retirer</button>
    </div>`).join('') || '<div style="font-size:11px;color:var(--g400);">Aucune photo ajoutée.</div>';
}

// Enregistre le document (devis/facture)
// Enregistre le document en brouillon (rappel « à finir ») dans l'onglet Devis/Factures
function saveDocBrouillon() {
  if (!_editingDoc) return;
  _editingDoc.statut = 'brouillon';
  saveDoc();
  toast('💾 Enregistré en brouillon — à finir dans ' + (_editingDoc && _editingDoc.type === 'facture' ? 'Factures' : 'Devis'), '#2563eb');
}
function saveDoc() {
  if (!_editingDoc) return;
  const t = _calcTotaux(_editingDoc.lignes, _editingDoc.tvaTaux, _editingDoc.rabais, _editingDoc.expertise);
  _editingDoc.sousTotal = t.sousTotal;
  _editingDoc.rabaisMontant = t.rabaisMontant;
  _editingDoc.tvaMontant = t.tvaMontant;
  _editingDoc.total = t.total;
  // Déduction expertise → persistée via le marqueur invisible [EXPERT:n] dans notes
  // (pas de nouvelle colonne Supabase). On retire d'abord un éventuel ancien marqueur.
  {
    const exp = parseFloat(_editingDoc.expertise) || 0;
    let nt = String(_editingDoc.notes || '').replace(/\s*\[EXPERT:[^\]]*\]\s*/g, ' ').trim();
    if (exp > 0) nt += (nt ? '\n' : '') + '[EXPERT:' + exp + ']';
    // Restaure le marqueur d'archivage du devis s'il était présent avant l'édition
    if (_editingDoc._wasDevisArch && !/\[DEVISARCH\]/.test(nt)) nt += (nt ? ' ' : '') + '[DEVISARCH]';
    _editingDoc.notes = nt;
  }
  // Retire les champs transitoires d'UI avant sauvegarde
  const toSave = JSON.parse(JSON.stringify(_editingDoc));
  delete toSave._wasDevisArch;
  delete toSave._bonNumeroSaisi;
  delete toSave.expertise;   // persisté dans notes via [EXPERT:n]
  delete toSave.photos;      // photos non stockées en base (incluses uniquement dans le PDF)
  const docs = DB.documents;
  const i = docs.findIndex(x => x.id === toSave.id);
  if (i >= 0) docs[i] = toSave; else docs.push(toSave);
  DB.documents = docs;
  // Si ce devis vient d'un bon en "Demande de devis", on bascule le bon en
  // "Attente de devis" : il revient dans la liste des bons actifs (jamais perdu)
  // et quitte la section "Bons en demande de devis".
  if (toSave.type === 'devis' && toSave.bonId) {
    const bons = DB.bons; const lb = bons.find(b => b.id === toSave.bonId);
    if (lb && (lb.statut || '') === 'demande-devis') { lb.statut = 'attente-devis'; DB.bons = bons; }
  }
  toast('✓ ' + (_editingDoc.type === 'facture' ? 'Facture' : 'Devis') + ' enregistré', '#2d9e6b');
  closeModal('modal-doc');
  // Si c'est une ancienne facture archivée, on reste sur son onglet et on rafraîchit sa liste
  if (_docIsArchive(toSave)) {
    if (typeof renderAnciennesList === 'function') renderAnciennesList();
    if (typeof renderClients === 'function') renderClients();
    if (typeof renderDashboard === 'function') renderDashboard();
    return;
  }
  // Bascule sur l'onglet correspondant au type enregistré pour qu'il soit visible
  state.docsFilter = (toSave.type === 'facture') ? 'facture' : 'devis';
  renderDocuments();
  // Le CA du portefeuille client dépend des factures payées → on rafraîchit
  if (typeof renderClients === 'function') renderClients();
  if (typeof renderDashboard === 'function') renderDashboard();
}

// Change le statut d'un document
function updateDocStatut(id, value) {
  const docs = DB.documents;
  const d = docs.find(x => x.id === id);
  if (!d) return;
  d.statut = value;
  // Facture payée → on archive aussi le devis source (et on le ressort si on dé-paie)
  if (d.type === 'facture' && d.devisId) _syncDevisArchiveWithFacture(d, value === 'payee');
  DB.documents = docs;
  if (value === 'payee' && d.devisId) toast('✅ Payée — facture et devis archivés ensemble dans « 📦 Facturation archivée »', '#0f766e');
  else if (value === 'payee' && d.bonId) toast('✅ Payée — dossier classé dans « 📦 Facturation archivée »', '#0f766e');
  else toast('Statut mis à jour ✓', '#2d9e6b');
  renderDocuments();
  // Le CA "CHF facturés" du portefeuille client dépend des factures payées → on rafraîchit
  if (typeof renderClients === 'function') renderClients();
  if (typeof renderDashboard === 'function') renderDashboard();
}

// Convertit un devis accepté en facture
function convertDevisToFacture(id) {
  const devis = (DB.documents || []).find(x => x.id === id);
  if (!devis) return;
  const facture = JSON.parse(JSON.stringify(devis));
  facture.id = newId();
  facture.type = 'facture';
  facture.numero = _nextDocNumero('facture');
  facture.dateDoc = today();
  facture.statut = 'brouillon';
  facture.devisId = devis.id;
  const docs = DB.documents;
  docs.push(facture);
  DB.documents = docs;
  // Marque le devis comme accepté s'il ne l'est pas
  if (devis.statut !== 'accepte') { devis.statut = 'accepte'; DB.documents = docs; }
  toast('✓ Facture ' + facture.numero + ' créée depuis le devis', '#2d9e6b');
  state.docsFilter = 'facture';
  renderDocuments();
}

function confirmDeleteDoc(id, label) {
  $('confirm-msg').textContent = `Supprimer "${label}" ? Cette action est irréversible.`;
  $('confirm-btn').onclick = () => {
    DB.documents = DB.documents.filter(d => d.id !== id);
    closeModal('modal-confirm');
    renderDocuments();
    toast('Document supprimé', '#e63946');
  };
  openModal('modal-confirm');
}

// Liste des devis/factures
function renderDocuments() {
  updateNavCounts();
  const list = $('documents-list');
  const count = $('documents-count');
  const q = (($('doc-search') || {}).value || '').toLowerCase();
  const filtre = state.docsFilter === 'facture' ? 'facture' : 'devis';
  // Titre de la page selon l'onglet
  const titleEl = document.querySelector('#screen-devis .page-title');
  if (titleEl) titleEl.textContent = (filtre === 'facture') ? 'Factures' : 'Devis';
  // Exclut les factures payées liées à un bon (parties dans « Facturation archivée »)
  let docs = (DB.documents || []).slice().filter(d => (d.type || 'devis') === filtre && !_docIsArchive(d) && !_isFactureFactArchived(d) && !_isRappelDoc(d) && !_isAncienneFacture(d) && !_isDevisArchivedWithFacture(d));
  const allOfType = docs.slice();   // tous les docs du type (pour les compteurs/totaux), avant filtre statut
  // Filtre par statut (chips récap)
  const sf = state.docStatutFilter || 'tous';
  if (sf !== 'tous') docs = docs.filter(d => (d.statut || 'brouillon') === sf);
  if (q) docs = docs.filter(d => {
    const bonNo = d.bonId ? (((DB.bons||[]).find(b => b.id === d.bonId)||{}).numero || '') : '';
    return ((d.numero||'')+' '+(d.clientNom||'')+' '+(d.locataireNom||'')+' '+(d.proprietaire||'')+' '+(d.clientVille||'')+' '+bonNo+' '+(d.notes||'')).toLowerCase().includes(q);
  });
  docs.sort((a, b) => (b.dateDoc || '').localeCompare(a.dateDoc || ''));
  if (count) count.textContent = allOfType.length ? allOfType.length + ' ' + (filtre === 'facture' ? 'facture(s)' : 'devis') : '';
  if (!list) return;
  // Section "Bons terminés à facturer" (uniquement dans l'onglet Factures) :
  // les bons au statut "Terminé" qui n'ont pas encore de facture liée.
  let aFacturerHtml = '';
  if (filtre === 'facture') {
    const dejaFacture = id => (DB.documents || []).some(x => (x.type === 'facture') && x.bonId === id);
    const aFacturer = (DB.bons || []).filter(b => (b.statut || '') === 'termine' && !dejaFacture(b.id))
      .sort((a, b) => {
        const ga = _geranceCanon(a.geranceNom || '').toLowerCase(), gbn = _geranceCanon(b.geranceNom || '').toLowerCase();
        if (ga !== gbn) return ga.localeCompare(gbn, 'fr');
        return (a.numero || '').localeCompare(b.numero || '');
      });
    if (aFacturer.length) {
      aFacturerHtml = `
        <div style="margin-bottom:14px;border:1.5px solid #16a34a;border-radius:10px;padding:12px 14px;background:#f0fdf4;">
          <div style="font-size:13px;font-weight:800;color:#166534;margin-bottom:10px;">✅ Bons terminés à facturer (${aFacturer.length})</div>
          <div style="display:flex;flex-direction:column;gap:6px;">
            ${aFacturer.map(b => renderBonCard(b)).join('')}
          </div>
        </div>`;
    }
  }
  // Section "Bons en demande de devis" (uniquement dans l'onglet Devis) :
  // les bons au statut "Demande de devis" qui n'ont pas encore de devis lié.
  let aDeviserHtml = '';
  if (filtre === 'devis') {
    const dejaDevis = id => (DB.documents || []).some(x => ((x.type || 'devis') === 'devis') && x.bonId === id);
    const aDeviser = (DB.bons || []).filter(b => (b.statut || '') === 'demande-devis' && !dejaDevis(b.id))
      .sort((a, b) => {
        const ga = _geranceCanon(a.geranceNom || '').toLowerCase(), gbn = _geranceCanon(b.geranceNom || '').toLowerCase();
        if (ga !== gbn) return ga.localeCompare(gbn, 'fr');
        return (a.numero || '').localeCompare(b.numero || '');
      });
    if (aDeviser.length) {
      aDeviserHtml = `
        <div style="margin-bottom:14px;border:1.5px solid #6366f1;border-radius:10px;padding:12px 14px;background:#eef2ff;">
          <div style="font-size:13px;font-weight:800;color:#3730a3;margin-bottom:10px;">📝 Bons en demande de devis (${aDeviser.length})</div>
          <div style="display:flex;flex-direction:column;gap:6px;">
            ${aDeviser.map(b => renderBonCard(b)).join('')}
          </div>
        </div>`;
    }
  }
  // Section "À finir / brouillons" : les devis/factures encore en brouillon (rappel)
  let brouillonsHtml = '';
  const brouillons = docs.filter(d => (d.statut || '') === 'brouillon')
    .slice().sort((a, b) => (b.dateDoc || '').localeCompare(a.dateDoc || ''));
  if (brouillons.length) {
    const accent = (filtre === 'facture') ? '#2d9e6b' : '#8b5cf6';
    brouillonsHtml = `
      <div style="margin-bottom:14px;border:1.5px solid #f59e0b;border-radius:10px;padding:12px 14px;background:#fffbeb;">
        <div style="font-size:13px;font-weight:800;color:#b45309;margin-bottom:10px;">🕒 À finir — ${filtre === 'facture' ? 'factures' : 'devis'} en brouillon (${brouillons.length})</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${brouillons.map(d => `
            <div style="display:flex;align-items:center;gap:12px;background:#fff;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;flex-wrap:wrap;">
              <div style="min-width:120px;"><div style="font-size:12px;font-weight:800;color:var(--navy);">${filtre==='facture'?'🧾':'📝'} ${d.numero||'—'}</div><div style="font-size:11px;color:var(--g600);">📅 ${fmtDate(d.dateDoc)||'—'}</div></div>
              <div style="flex:1;min-width:150px;font-size:12px;color:var(--g600);">${d.clientNom||'—'}${d.locataireNom?(' · 🏠 '+d.locataireNom):''}</div>
              <div style="min-width:100px;text-align:right;font-size:13px;font-weight:700;color:var(--navy);">${_displayMontant(d.total||0)} CHF</div>
              <button class="btn btn-sm" onclick="editDoc('${d.id}')" title="Finir ce document" style="font-weight:700;border:1.5px solid ${accent};background:#fff;color:${accent};">✏️ Finir</button>
            </div>`).join('')}
        </div>
      </div>`;
  }
  // Barre récap + filtres par statut (uniquement pour les Factures)
  let statsBar = '';
  if (filtre === 'facture') {
    const byS = st => allOfType.filter(d => (d.statut || 'brouillon') === st);
    const sumS = st => byS(st).reduce((s, d) => s + (parseFloat(d.total) || 0), 0);
    // Les factures PAYÉES ne sont plus dans la liste (elles sont dans « Facturation archivée »).
    // On les recompte directement depuis toutes les factures pour le total encaissé.
    const paidAll = (DB.documents || []).filter(_isFactureFactArchived);
    const tBrouillon = sumS('brouillon'), tPret = sumS('pret'), tEnvoyee = sumS('envoyee'), tPayee = paidAll.reduce((s, d) => s + (parseFloat(d.total) || 0), 0);
    const chip = (val, label, n, col) => {
      const on = (sf === val);
      return `<button onclick="docSetStatutFilter('${val}')" style="font-size:12px;font-weight:700;padding:6px 11px;border-radius:20px;cursor:pointer;border:1.5px solid ${on ? col : '#d1d5db'};background:${on ? col : '#fff'};color:${on ? '#fff' : '#374151'};">${label} (${n})</button>`;
    };
    const carte = (label, montant, bg, bd, cl) =>
      `<div style="background:${bg};border:1px solid ${bd};border-radius:8px;padding:7px 12px;font-size:12px;"><span style="color:${cl};font-weight:800;">${label}</span> : <b>${_displayMontant(montant)} CHF</b></div>`;
    statsBar = `
      <div style="display:flex;flex-wrap:wrap;gap:7px;align-items:center;justify-content:flex-end;margin-bottom:10px;">
        ${chip('tous', 'Toutes', allOfType.length, '#0d1b3e')}
        ${chip('brouillon', '🕒 Brouillon', byS('brouillon').length, '#f59e0b')}
        ${chip('pret', '📤 Prêt à envoyer', byS('pret').length, '#d97706')}
        ${chip('envoyee', '📨 Envoyées', byS('envoyee').length, '#2563eb')}
        <button onclick="showScreen('fact-archive')" title="Les factures payées sont dans « Facturation archivée »" style="font-size:12px;font-weight:700;padding:6px 11px;border-radius:20px;cursor:pointer;border:1.5px solid #16a34a;background:#fff;color:#166534;">✅ Payées (${paidAll.length}) ↗</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;">
        ${carte('📤 Prêt à envoyer', tPret, '#fff7ed', '#fed7aa', '#c2410c')}
        ${carte('Total envoyé (à encaisser)', tEnvoyee, '#eff6ff', '#bfdbfe', '#1d4ed8')}
        ${carte('Brouillons', tBrouillon, '#fffbeb', '#fde68a', '#b45309')}
        ${carte('Encaissé (payées)', tPayee, '#f0fdf4', '#bbf7d0', '#15803d')}
      </div>`;
  } else {
    // Devis : récap des montants par statut (surtout les acceptés)
    const byS = st => allOfType.filter(d => (d.statut || 'brouillon') === st);
    const sumS = st => byS(st).reduce((s, d) => s + (parseFloat(d.total) || 0), 0);
    const carteD = (label, n, montant, bg, bd, cl) =>
      `<div style="background:${bg};border:1px solid ${bd};border-radius:8px;padding:7px 12px;font-size:12px;"><span style="color:${cl};font-weight:800;">${label}</span> : <b>${_displayMontant(montant)} CHF</b> <span style="color:var(--g400);">(${n})</span></div>`;
    statsBar = `
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;">
        ${carteD('✅ Devis acceptés', byS('accepte').length, sumS('accepte'), '#f0fdf4', '#bbf7d0', '#15803d')}
        ${carteD('📨 Envoyés', byS('envoye').length, sumS('envoye'), '#eff6ff', '#bfdbfe', '#1d4ed8')}
        ${carteD('🕒 Brouillons', byS('brouillon').length, sumS('brouillon'), '#fffbeb', '#fde68a', '#b45309')}
        ${carteD('❌ Refusés', byS('refuse').length, sumS('refuse'), '#fef2f2', '#fecaca', '#b91c1c')}
      </div>`;
  }
  const topHtml = statsBar + aFacturerHtml + aDeviserHtml + brouillonsHtml;
  if (!docs.length) {
    const msg = (filtre === 'facture')
      ? 'Aucune facture.<br>Crée une facture avec « + Nouvelle facture » ou convertis un devis accepté.'
      : 'Aucun devis.<br>Crée un devis depuis un bon « à facturer » ou avec « + Nouveau devis ».';
    list.innerHTML = topHtml + '<div class="empty"><div class="empty-icon">🧾</div><div class="empty-text">' + msg + '</div></div>';
    return;
  }
  const statutColors = {
    'brouillon': { bg:'#f3f4f6', color:'#6b7280' },
    'envoye':    { bg:'#dbeafe', color:'#1d4ed8' },
    'accepte':   { bg:'#bbf7d0', color:'#166534' },
    'refuse':    { bg:'#fecaca', color:'#991b1b' },
    'pret':      { bg:'#facc15', color:'#422006' },
    'envoyee':   { bg:'#1a2744', color:'#ffffff' },
    'payee':     { bg:'#bbf7d0', color:'#166534' },
  };
  const statutLabel = { brouillon:'Brouillon', pret:'Prêt à être envoyé', envoye:'Envoyé', accepte:'Accepté', refuse:'Refusé', envoyee:'Envoyée', payee:'Payée' };
  const cardOf = (d) => {
    const isDevis = d.type === 'devis';
    const st = statutColors[d.statut] || statutColors.brouillon;
    // Bon lié → n° de bon + adresse d'intervention ; rapport lié → technicien
    const _bon = d.bonId ? (DB.bons || []).find(b => b.id === d.bonId) : null;
    const _bonNum = (_bon && _bon.numero) || d.bonCommande || '';
    const _adrInt = (_bon && _bon.immeuble) || d.locataireAdresse || '';
    let _tech = '';
    if (_bon) {
      const _rap = (DB.rapports || []).find(r => _factNorm(r.bonCommande) === _factNorm(_bon.numero));
      _tech = (_rap && _rap.tech) || _bonAffecte(_bon) || '';
    }
    const opts = isDevis
      ? ['brouillon','envoye','accepte','refuse']
      : ['brouillon','pret','envoyee','payee'];
    // Factures : carte teintée de la couleur de la gérance. Devis : violet.
    const gColor = isDevis ? '#8b5cf6' : colorForGeranceName(_geranceCanon(d.clientNom || '') || '(Sans client)');
    const cardBg = isDevis ? '#fff' : _hexTint(gColor, 0.10);
    const cardBorder = isDevis ? '#e5e7eb' : _hexTint(gColor, 0.30);
    return `
    <div id="docrow-${d.id}" style="display:flex;align-items:center;gap:14px;background:${cardBg};border:1px solid ${cardBorder};border-left:4px solid ${gColor};border-radius:8px;padding:10px 14px;margin-bottom:6px;box-shadow:0 1px 2px rgba(0,0,0,.04);flex-wrap:wrap;transition:box-shadow .3s;">
      <div style="min-width:130px;">
        <div style="font-size:13px;font-weight:800;color:var(--navy);">${isDevis?'📝':'🧾'} ${d.numero||''}${_isRappelDoc(d)?` <span style="font-size:9px;font-weight:800;color:#fff;background:#dc2626;border-radius:8px;padding:1px 6px;vertical-align:middle;">RAPPEL ${(_rappelMeta(d)||{}).niveau||''}</span>`:''}</div>
        <div style="font-size:11px;${d.statut==='envoyee'?'color:var(--navy);font-weight:800;':'color:var(--g600);'}">📅 ${fmtDate(d.dateDoc)||'—'}</div>
      </div>
      <div style="flex:1.4;min-width:160px;">
        <div style="font-size:10px;color:var(--g400);text-transform:uppercase;font-weight:700;">Client</div>
        <div style="font-size:12px;font-weight:600;color:var(--navy);">${d.clientNom||'—'}</div>
        ${d.locataireNom?`<div style="font-size:11px;color:var(--g600);">🏠 ${d.locataireNom}</div>`:''}
        ${_adrInt?`<div style="font-size:11px;color:var(--g600);">📍 ${_adrInt}</div>`:''}
        ${_bonNum?`<div style="font-size:11px;color:var(--g600);">📄 Bon ${_bonNum}</div>`:''}
        ${_tech?`<div style="font-size:11px;color:var(--g600);">👷 ${_tech}</div>`:''}
      </div>
      <div style="min-width:110px;text-align:right;">
        <div style="font-size:10px;color:var(--g400);text-transform:uppercase;font-weight:700;">Total TTC</div>
        <div style="font-size:14px;font-weight:800;color:var(--navy);">${_displayMontant(d.total||0)} CHF</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;flex-shrink:0;">
        <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;">
          <select onchange="updateDocStatut('${d.id}',this.value)" style="font-size:11px;font-weight:700;padding:5px 7px;border-radius:6px;border:1.5px solid ${st.color};background:${st.bg};color:${st.color};cursor:pointer;">
            ${opts.map(o=>`<option value="${o}" ${d.statut===o?'selected':''}>${statutLabel[o]}</option>`).join('')}
          </select>
          <button class="btn btn-ghost btn-sm" onclick="editDoc('${d.id}')" title="Modifier">✏️</button>
          <button class="btn btn-ghost btn-sm" onclick="downloadDocPDF('${d.id}')" title="Télécharger le PDF">📥 PDF</button>
          ${_bon ? (_bon.pdfPath
            ? `<button class="btn btn-sm" onclick="viewBonPdf('${_bon.id}')" onmouseenter="bonPdfPreview('${_bon.id}', this)" onmouseleave="bonPdfPreviewHide()" title="PDF du bon ${_bonNum} — survol = aperçu · clic = ouvrir" style="font-weight:700;border:1.5px solid #2563eb;background:#eff6ff;color:#1d4ed8;">📎 Bon</button>`
            : `<button class="btn btn-sm" onclick="generateBonPDF('${_bon.id}')" title="Générer le PDF imprimable du bon ${_bonNum}" style="font-weight:700;border:1.5px solid #2563eb;background:#eff6ff;color:#1d4ed8;">🖨 Bon</button>`) : ''}
          ${isDevis?`<select onchange="createRapportFromDoc('${d.id}', this.value); this.selectedIndex=0;" title="Créer un rapport depuis ce devis" style="font-weight:700;font-size:12px;border:1.5px solid #7c3aed;background:#faf5ff;color:#6d28d9;border-radius:6px;padding:5.5px 4px;cursor:pointer;max-width:118px;">
            <option value="" selected>📋 Rapport ▾</option>
            <option value="general">📋 Rapport général</option>
            <option value="bois">🪵 Insectes du bois</option>
            <option value="rongeurs">🐀 Rongeurs</option>
            <option value="blattes">🪳 Blattes</option>
            <option value="fourmis">🐜 Fourmis</option>
            <option value="punaises">🛏️ Punaises de lit</option>
          </select>`:''}
          ${isDevis?`<button class="btn btn-navy btn-sm" onclick="convertDevisToFacture('${d.id}')" title="Convertir en facture">→ Facture</button>`:''}
          <button class="btn btn-red btn-sm btn-xs" onclick="confirmDeleteDoc('${d.id}','${(d.numero||'').replace(/'/g,"\\'")}')" title="Supprimer">🗑</button>
        </div>
        ${d.statut==='envoyee'?`<div style="font-size:15px;font-weight:800;color:#1a2744;">📅 ${fmtDate(d.dateDoc)||'—'}</div>`:''}
      </div>
    </div>`;
  };
  // Barre de classement (par date / par gérance)
  const gb = state.docGroupBy || 'date';
  const gbtn = (v, label) => `<button onclick="docSetGroupBy('${v}')" style="font-size:11px;font-weight:700;padding:5px 10px;border-radius:16px;cursor:pointer;border:1.5px solid ${gb===v?'#0d1b3e':'#d1d5db'};background:${gb===v?'#0d1b3e':'#fff'};color:${gb===v?'#fff':'#374151'};">${label}</button>`;
  const groupToolbar = `<div style="display:flex;gap:6px;align-items:center;margin-bottom:10px;"><span style="font-size:11px;color:var(--g600);font-weight:700;">Classer :</span>${gbtn('date','📅 Par date')}${gbtn('gerance','🏢 Par gérance')}</div>`;
  // Rendu : à plat (par date) ou regroupé par gérance
  let cardsHtml;
  if (gb === 'gerance') {
    // Regroupe par gérance avec une clé NORMALISÉE (minuscules, espaces, variantes via _geranceCanon)
    // pour que la même gérance écrite différemment soit bien réunie.
    const groups = {};
    docs.forEach(d => {
      const canon = _geranceCanon(d.clientNom || '') || '(Sans client)';
      const key = canon.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!groups[key]) groups[key] = { name: canon, items: [] };
      groups[key].items.push(d);
    });
    cardsHtml = Object.keys(groups).sort((a, b) => groups[a].name.localeCompare(groups[b].name, 'fr')).map(k => {
      const arr = groups[k].items;
      const sub = arr.reduce((s, d) => s + (parseFloat(d.total) || 0), 0);
      // En-tête de gérance coloré (couleur de la gérance) pour les factures
      const gColor = (filtre === 'facture') ? colorForGeranceName(groups[k].name) : '#0d1b3e';
      const headStyle = (filtre === 'facture')
        ? `background:${_hexTint(gColor, 0.18)};color:${gColor};border-radius:8px;padding:7px 12px;`
        : `color:var(--navy);border-bottom:2px solid #e5e7eb;padding-bottom:4px;`;
      const dot = (filtre === 'facture') ? `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${gColor};margin-right:6px;vertical-align:middle;"></span>` : '🏢 ';
      return `
        <div style="margin-top:12px;">
          <div style="font-size:13px;font-weight:800;text-transform:uppercase;margin-bottom:6px;${headStyle}">${dot}${groups[k].name} <span style="font-weight:500;opacity:.85;">(${arr.length} · ${_displayMontant(sub)} CHF)</span></div>
          ${arr.map(cardOf).join('')}
        </div>`;
    }).join('');
  } else {
    cardsHtml = docs.map(cardOf).join('');
  }
  list.innerHTML = topHtml + groupToolbar + cardsHtml;
}
// Classement de la liste devis/factures : 'date' ou 'gerance'
function docSetGroupBy(v) {
  state.docGroupBy = (v === 'gerance') ? 'gerance' : 'date';
  renderDocuments();
}

// ============================================================
// IMPORT IA — glisser un PDF de devis/facture existant
// ============================================================
function docHandleDrop(e) {
  e.preventDefault();
  const dz = $('doc-dropzone'); if (dz) dz.classList.remove('drag');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) docProcessImportFile(f);
}
function docHandleInput(e) { const f = e.target.files && e.target.files[0]; if (f) docProcessImportFile(f); }

async function docProcessImportFile(file) {
  const st = $('doc-import-status');
  const cf = $('doc-import-confirm');
  if (cf) { cf.style.display = 'none'; cf.innerHTML = ''; }
  if (file.type !== 'application/pdf') { toast('Merci de déposer un fichier PDF', '#e63946'); return; }
  const setSt = m => { if (st) { st.style.display = 'block'; st.innerHTML = m; } };
  try {
    setSt('⏳ Lecture du PDF…');
    const texte = await bonExtractText(file);
    if (!texte || texte.length < 20) { setSt(''); toast('PDF non lisible.', '#e63946'); return; }
    setSt('🤖 Analyse du document par l\'IA…');
    const infos = await docExtractFromAI(texte);
    setSt('');
    docShowImportConfirm(infos, file.name);
  } catch (err) { setSt(''); console.error(err); toast('Erreur : ' + err.message, '#e63946'); }
}

async function docExtractFromAI(texte) {
  const systemPrompt =
    'Tu extrais EXHAUSTIVEMENT les informations d\'un DEVIS ou d\'une FACTURE émis par l\'entreprise DERATEK (Suisse, CHF, TVA 8.1%). ' +
    'Réponds UNIQUEMENT par un objet JSON valide, sans texte ni balises.\n' +
    'ATTENTION EXPÉDITEUR (à NE JAMAIS confondre avec le client/locataire) : l\'émetteur est DERATEK, dont l\'adresse est "Rue des Mille-Boilles 2, 2000 Neuchâtel" (ou "Chemin des Pyramides 7, 1007 Lausanne" / "Rue Maillefer 25 Neuchâtel" / "Neufeldstrasse 119 Berne"), tél 032 552 21 72, TVA CHE-276.656.145, info@deratek.ch. N\'utilise JAMAIS ces coordonnées comme adresse du destinataire, du client ou du lieu d\'intervention. Le destinataire est le bloc d\'adresse situé EN HAUT À DROITE.\n' +
    'Clés (chaîne vide ou tableau vide si absent) :\n' +
    '{\n"type":"devis ou facture (devine d\'après le PDF)",\n' +
    '"numero":"numéro du document (ex D-2026-001 ou F-2026-001)",\n' +
    '"date":"date d\'émission du document au format AAAA-MM-JJ",\n' +
    '"bon_numero":"numéro du bon de travaux / bon d\'intervention / bon de commande s\'il est mentionné. ATTENTION : DERATEK utilise souvent le libellé \\"BON POUR TRAVAUX N° xxxx xxx xxx\\" (3 groupes de chiffres séparés par des espaces, ex \\"2026 041 211\\"). Cherche aussi : BT-xxxx, BC-xxxxx, N° de commande, Réf. travaux, Ordre de travaux. Conserve les espaces du numéro tel qu\'écrit.",\n' +
    '"objet":"objet / sujet / description courte du document (ex : Traitement contre les rats — appartement 3e étage)",\n' +
    '"client_nom":"nom de la GÉRANCE / société destinataire (à qui est adressé le document). Le bloc destinataire est souvent de la forme \\"<Propriétaire> p.a. <Gérance> / <adresse de la gérance>\\". Dans ce cas client_nom = la GÉRANCE (ce qui suit \\"p.a.\\" ou \\"p/a\\"), ex \\"Naef Immobilier La Chaux-de-Fonds SA\\". JAMAIS DERATEK.",\n' +
    '"client_adresse":"rue et numéro du destinataire (adresse de la gérance, en haut à droite). JAMAIS l\'adresse de DERATEK.",\n' +
    '"client_npa":"NPA du destinataire",\n' +
    '"client_ville":"ville du destinataire",\n' +
    '"locataire_nom":"NOM ou raison sociale du locataire / occupant concerné par l\'intervention. ATTENTION : sur les factures DERATEK il apparaît juste APRÈS le n° de bon pour travaux, sous la forme \\"<Société ou nom> / <type de local>\\" (ex \\"Société Royal Panini\'s Sàrl / Commerce rez-de-chaussée\\"). Souvent précédé de \\"locataire :\\" ou \\"chez :\\" sur d\'autres documents. Garde le nom complet AVANT le slash (et sans le type de local).",\n' +
    '"locataire_prenom":"prénom du locataire s\'il est mentionné séparément (ne pas remplir si c\'est une société)",\n' +
    '"locataire_adresse":"rue et numéro du LIEU D\'INTERVENTION. ATTENTION : sur les factures DERATEK c\'est l\'adresse écrite JUSTE SOUS la ligne \\"BON POUR TRAVAUX N° ...\\" (ex \\"Rue du Lac 14, 2416 Les Brenets\\"). NE confonds PAS avec l\'adresse de la gérance (en haut à droite) ni avec celle de DERATEK. Extrais la rue+numéro ; mets le NPA et la ville dans locataire_npa / locataire_ville.",\n' +
    '"locataire_npa":"code postal NPA du locataire si mentionné",\n' +
    '"locataire_ville":"ville du locataire si mentionnée",\n' +
    '"locataire_tel":"téléphone du locataire si mentionné (formats CH : 079..., 0XX..., +41...)",\n' +
    '"locataire_email":"email du locataire si mentionné",\n' +
    '"proprietaire":"NOM du propriétaire = la personne/entité écrite AVANT \\"p.a.\\" (ou \\"p/a\\") dans le bloc destinataire. Ex pour \\"David Wigger p.a. Naef Immobilier La Chaux-de-Fonds SA\\" → proprietaire = \\"David Wigger\\". Vide s\'il n\'y a pas de \\"p.a.\\".",\n' +
    '"sous_total":"montant HT total avant rabais et TVA (chiffres uniquement, point décimal)",\n' +
    '"rabais":"taux du rabais en % s\'il est mentionné (chiffres, ex 5 pour 5%)",\n' +
    '"rabais_montant":"MONTANT du rabais en CHF tel qu\'écrit dans le document (chiffres uniquement, point décimal). Ex pour \\"Rabais 5 % ... 302.52 CHF\\" mets 302.52. Vide si aucun rabais.",\n' +
    '"tva_taux":"taux TVA en % (8.1 par défaut)",\n' +
    '"tva_montant":"montant TVA (chiffres)",\n' +
    '"total":"montant TOTAL TTC final (chiffres uniquement, point décimal)",\n' +
    '"lignes":[{"desc":"description précise de la prestation/article","qte":1,"prix":0}],\n' +
    '"notes":"notes / conditions de paiement / mentions diverses si présentes. N\'INCLUS PAS la mention \\"Payable par ...\\" ni le destinataire/propriétaire : ils sont gérés ailleurs."\n}\n\n' +
    'RÈGLES IMPORTANTES pour le tableau "lignes" :\n' +
    '- Tu DOIS extraire CHAQUE ligne du tableau de prestations séparément (une entrée JSON par ligne du PDF), avec sa description complète.\n' +
    '- RÈGLE ABSOLUE SUR LES PRIX : n\'attribue un "prix" à une ligne QUE si un montant chiffré est EXPLICITEMENT écrit en face de cette ligne dans le PDF (colonne MONTANT ou TOTAL). N\'INVENTE JAMAIS un prix. NE RÉPARTIS JAMAIS un total global entre les lignes. Si la case montant de la ligne est vide, mets prix=0.\n' +
    '- Beaucoup de devis DERATEK sont FORFAITAIRES : les prestations sont décrites SANS prix individuel, et un seul montant global apparaît sur une ligne du type "Matériel et main d\'œuvre — Forfait : 6050.30 CHF". Dans ce cas : garde toutes les descriptions avec prix=0, et mets le montant uniquement sur la ligne forfait (et sur les rares lignes qui ont un vrai prix, ex location de nacelle).\n' +
    '- Si une ligne n\'a pas de quantité explicite, mets qte=1.\n' +
    '- Si une ligne montre un montant (ex "Location nacelle : 1\'210 CHF" ou "Forfait main d\'œuvre : 6050.30"), mets qte=1 et prix=ce montant.\n' +
    '- Les prix doivent être des nombres (pas de CHF, pas d\'apostrophe de milliers).\n' +
    '- DATES D\'INTERVENTION : si une ou plusieurs dates d\'intervention/de passage apparaissent (ex "Intervention du 12.03.2026" ou "Passages : 12.03 et 19.03.2026"), crée une LIGNE SÉPARÉE dédiée, de la forme {"desc":"Dates d\'interventions : 30.01.2026","qte":1,"prix":0}. Ne les mets PAS dans le champ "date" du document (qui est la date d\'émission), ni dans l\'objet, ni collées à une autre prestation.\n' +
    '- STRUCTURE DES LIGNES souhaitée (une entrée JSON par ligne, dans cet ordre quand les éléments existent) : 1) la prestation/description principale (prix 0 si pas de montant en face), 2) une ligne "Dates d\'interventions : ..." si des dates figurent, 3) la ligne "Matériel et main d\'œuvre" (ou le forfait) qui porte le montant. N\'ajoute PAS toi-même de ligne pour le n° de bon de travaux (elle est gérée séparément).\n' +
    '- NE FORCE PAS la somme des lignes à égaler le sous_total : reporte les montants tels qu\'ils sont écrits, rien de plus.';
  const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DERATEK_CONFIG.mistral.apiKey },
    body: JSON.stringify({
      model: DERATEK_CONFIG.mistral.model, max_tokens: 4000, temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: texte }]
    })
  });
  if (!response.ok) { let m='API '+response.status; try{const e=await response.json();m=(e.error&&e.error.message)||m;}catch(e){} throw new Error(m); }
  const data = await response.json();
  const raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!raw) throw new Error('Réponse IA vide');
  return JSON.parse(raw.replace(/```json/gi,'').replace(/```/g,'').trim());
}

function docShowImportConfirm(infos, fileName) {
  const box = $('doc-import-confirm'); if (!box) return;
  const type = (infos.type||'').toLowerCase().includes('factur') ? 'facture' : 'devis';
  const statutOpts = type === 'facture'
    ? ['brouillon','pret','envoyee','payee']
    : ['brouillon','envoye','accepte','refuse'];
  const statutLabels = { brouillon:'Brouillon', pret:'Prêt à être envoyé', envoye:'Envoyé', envoyee:'Envoyée', accepte:'Accepté', refuse:'Refusé', payee:'Payée' };
  const champ = (label, key, val) =>
    `<div style="margin-bottom:6px;">
       <label style="display:block;font-size:11px;font-weight:700;color:var(--g600);text-transform:uppercase;margin-bottom:3px;">${label}</label>
       <input class="form-input" id="docimp-${key}" value="${(val==null?'':String(val)).replace(/"/g,'&quot;')}" style="font-size:13px;">
     </div>`;
  const lignesArr = Array.isArray(infos.lignes) ? infos.lignes : [];
  box.innerHTML = `
    <div style="background:#fff;border:2px solid var(--navy);border-radius:12px;padding:18px;box-shadow:0 4px 18px rgba(13,27,62,.12);">
      <div style="font-size:15px;font-weight:800;color:var(--navy);margin-bottom:4px;">✅ Document analysé — type détecté : <span id="docimp-type-disp" style="color:var(--red);">${type === 'facture' ? 'FACTURE' : 'DEVIS'}</span></div>
      <div style="font-size:12px;color:var(--g600);margin-bottom:14px;">Vérifie les champs, choisis le statut, puis enregistre. Fichier : <b>${fileName||''}</b></div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:0 14px;">
        <div class="form-group"><label class="form-label">Type</label>
          <select class="form-input" id="docimp-type" onchange="docImportTypeChange(this.value)">
            <option value="devis" ${type==='devis'?'selected':''}>Devis</option>
            <option value="facture" ${type==='facture'?'selected':''}>Facture</option>
          </select>
        </div>
        ${champ('N° document', 'numero', infos.numero)}
        ${champ('Date émise (AAAA-MM-JJ)', 'date', infos.date)}
        ${champ('N° bon travaux/intervention', 'bon_numero', infos.bon_numero)}
      </div>
      <div class="form-group" style="margin-bottom:10px;"><label class="form-label">Objet / Description courte</label>
        <input class="form-input" id="docimp-objet" value="${(infos.objet||'').replace(/"/g,'&quot;')}" placeholder="Ex : Traitement contre cafards — appartement 3ème">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 14px;">
        <div style="border-right:1px dashed var(--g300);padding-right:10px;">
          <div style="font-size:11px;font-weight:800;color:var(--navy);margin-bottom:4px;text-transform:uppercase;">🏢 Client / Gérance (destinataire)</div>
          ${champ('Client (gérance)', 'client_nom', infos.client_nom)}
          ${champ('Adresse client', 'client_adresse', infos.client_adresse)}
          <div style="display:grid;grid-template-columns:1fr 2fr;gap:8px;">
            ${champ('NPA', 'client_npa', infos.client_npa)}
            ${champ('Ville', 'client_ville', infos.client_ville)}
          </div>
          ${champ('Propriétaire (p.a.)', 'proprietaire', infos.proprietaire)}
        </div>
        <div style="padding-left:10px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
            <div style="font-size:11px;font-weight:800;color:var(--navy);text-transform:uppercase;">🏠 Locataire (lieu d'intervention)</div>
            <label style="font-size:11px;font-weight:700;color:var(--g600);display:flex;align-items:center;gap:4px;cursor:pointer;">
              <input type="checkbox" id="docimp-creer-locataire" ${(infos.locataire_nom||'').trim()?'checked':''} style="margin:0;">
              Créer dans Locataires
            </label>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 8px;">
            ${champ('Prénom', 'locataire_prenom', infos.locataire_prenom)}
            ${champ('Nom', 'locataire_nom', infos.locataire_nom)}
          </div>
          ${champ('Adresse / rue', 'locataire_adresse', infos.locataire_adresse)}
          <div style="display:grid;grid-template-columns:1fr 2fr;gap:8px;">
            ${champ('NPA', 'locataire_npa', infos.locataire_npa)}
            ${champ('Ville', 'locataire_ville', infos.locataire_ville)}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 8px;">
            ${champ('Téléphone', 'locataire_tel', infos.locataire_tel)}
            ${champ('Email', 'locataire_email', infos.locataire_email)}
          </div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:0 14px;">
        ${champ('Sous-total HT', 'sous_total', infos.sous_total)}
        ${champ('Rabais (%)', 'rabais', infos.rabais)}
        ${champ('TVA (%)', 'tva_taux', infos.tva_taux || '8.1')}
        ${champ('Total TTC', 'total', infos.total)}
      </div>
      <input type="hidden" id="docimp-rabais_montant" value="${(infos.rabais_montant==null?'':String(infos.rabais_montant)).replace(/"/g,'&quot;')}">
      <div style="font-size:11px;color:var(--g600);margin:-4px 0 8px;">💡 Les lignes sans prix dans le PDF restent à 0 — le montant réel est porté par la ligne « forfait ». Le rabais exact du document est conservé.</div>
      <div class="form-group"><label class="form-label">Statut</label>
        <select class="form-input" id="docimp-statut">
          ${statutOpts.map(o => `<option value="${o}">${statutLabels[o]||o}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label class="form-label">Notes / conditions</label><textarea class="form-input" id="docimp-notes" rows="2">${infos.notes||''}</textarea></div>
      <div style="margin-top:10px;border-top:1px dashed var(--g300);padding-top:10px;">
        <div style="font-size:12px;font-weight:800;color:var(--navy);margin-bottom:6px;">📋 Lignes détectées par l'IA (${lignesArr.length}) — vérifie / corrige :</div>
        <div id="docimp-lignes-wrap" style="max-height:240px;overflow-y:auto;border:1px solid var(--g200);border-radius:8px;padding:6px;background:#fafbfc;">
          ${lignesArr.length === 0
            ? '<div style="font-size:12px;color:#b00;padding:8px;">⚠️ L\'IA n\'a détecté aucune ligne détaillée. Tu peux en ajouter ci-dessous ou laisser un forfait sera calculé automatiquement à l\'enregistrement.</div>'
            : lignesArr.map((l,i)=>`
            <div style="display:grid;grid-template-columns:1fr 60px 90px 64px;gap:6px;margin-bottom:4px;align-items:center;" data-li="${i}">
              <input class="form-input" style="font-size:12px;padding:4px 8px;" placeholder="Description" value="${(l.desc||l.description||'').replace(/"/g,'&quot;')}" data-fk="desc">
              <input class="form-input" style="font-size:12px;padding:4px 8px;text-align:center;" type="number" step="0.01" placeholder="Qté" value="${l.qte||l.quantite||1}" data-fk="qte">
              <input class="form-input" style="font-size:12px;padding:4px 8px;text-align:right;" type="number" step="0.01" placeholder="Prix" value="${l.prix||l.prix_unitaire||0}" data-fk="prix">
              <div style="display:flex;gap:1px;align-items:center;justify-content:flex-end;">
                <button class="btn btn-ghost" style="padding:2px 4px;font-size:12px;line-height:1;" onclick="docImpMoveLine(this,-1)" title="Monter">▲</button>
                <button class="btn btn-ghost" style="padding:2px 4px;font-size:12px;line-height:1;" onclick="docImpMoveLine(this,1)" title="Descendre">▼</button>
                <button class="btn btn-ghost" style="padding:2px 4px;font-size:12px;color:#b00;line-height:1;" onclick="this.closest('[data-li]').remove()" title="Supprimer">✕</button>
              </div>
            </div>`).join('')}
        </div>
        <button class="btn btn-ghost" style="font-size:12px;margin-top:6px;" onclick="docImpAddLine()">+ Ajouter une ligne</button>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">
        <button class="btn btn-ghost" onclick="docImportCancel()">Annuler</button>
        <button class="btn btn-navy" onclick="docImportSave()">✓ Enregistrer</button>
      </div>
    </div>`;
  box.style.display = 'block';
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Mémorise les lignes IA pour la sauvegarde
  box.dataset.lignes = JSON.stringify(lignesArr);
}
function docImportTypeChange(v) {
  const disp = $('docimp-type-disp'); if (disp) disp.textContent = v === 'facture' ? 'FACTURE' : 'DEVIS';
  const sel = $('docimp-statut'); if (!sel) return;
  const opts = v === 'facture' ? ['brouillon','pret','envoyee','payee'] : ['brouillon','envoye','accepte','refuse'];
  const labels = { brouillon:'Brouillon', pret:'Prêt à être envoyé', envoye:'Envoyé', envoyee:'Envoyée', accepte:'Accepté', refuse:'Refusé', payee:'Payée' };
  sel.innerHTML = opts.map(o => `<option value="${o}">${labels[o]||o}</option>`).join('');
}
function docImpAddLine() {
  const wrap = $('docimp-lignes-wrap'); if (!wrap) return;
  const div = document.createElement('div');
  div.setAttribute('data-li', wrap.querySelectorAll('[data-li]').length);
  div.style.cssText = 'display:grid;grid-template-columns:1fr 60px 90px 64px;gap:6px;margin-bottom:4px;align-items:center;';
  div.innerHTML = `
    <input class="form-input" style="font-size:12px;padding:4px 8px;" placeholder="Description" value="" data-fk="desc">
    <input class="form-input" style="font-size:12px;padding:4px 8px;text-align:center;" type="number" step="0.01" placeholder="Qté" value="1" data-fk="qte">
    <input class="form-input" style="font-size:12px;padding:4px 8px;text-align:right;" type="number" step="0.01" placeholder="Prix" value="0" data-fk="prix">
    <div style="display:flex;gap:1px;align-items:center;justify-content:flex-end;">
      <button class="btn btn-ghost" style="padding:2px 4px;font-size:12px;line-height:1;" onclick="docImpMoveLine(this,-1)" title="Monter">▲</button>
      <button class="btn btn-ghost" style="padding:2px 4px;font-size:12px;line-height:1;" onclick="docImpMoveLine(this,1)" title="Descendre">▼</button>
      <button class="btn btn-ghost" style="padding:2px 4px;font-size:12px;color:#b00;line-height:1;" onclick="this.closest('[data-li]').remove()" title="Supprimer">✕</button>
    </div>`;
  wrap.appendChild(div);
}
// Déplace une ligne d'import vers le haut (dir=-1) ou le bas (dir=1)
function docImpMoveLine(btn, dir) {
  const row = btn.closest('[data-li]'); if (!row) return;
  const wrap = row.parentElement; if (!wrap) return;
  if (dir < 0) {
    const prev = row.previousElementSibling;
    if (prev) wrap.insertBefore(row, prev);
  } else {
    const next = row.nextElementSibling;
    if (next) wrap.insertBefore(next, row);
  }
}
function _docImpReadLines() {
  const wrap = $('docimp-lignes-wrap'); if (!wrap) return [];
  return Array.from(wrap.querySelectorAll('[data-li]')).map(row => {
    const get = k => { const i = row.querySelector('[data-fk="'+k+'"]'); return i ? i.value : ''; };
    const desc = (get('desc')||'').trim();
    const qte = parseFloat(get('qte'))||0;
    const prix = parseFloat(get('prix'))||0;
    if (!desc && qte === 0 && prix === 0) return null;
    return { desc, qte: qte||1, prix };
  }).filter(Boolean);
}
function docImportCancel() {
  const box = $('doc-import-confirm'); if (box) { box.style.display = 'none'; box.innerHTML = ''; }
  const fi = $('doc-file-input'); if (fi) fi.value = '';
}
function docImportSave() {
  const box = $('doc-import-confirm');
  const v = id => { const el = $('docimp-' + id); return el ? el.value.trim() : ''; };
  const type = v('type') || 'devis';
  const numero = v('numero') || _nextDocNumero(type);
  let sousTotal = parseFloat(v('sous_total')) || 0;
  let rabais = parseFloat(v('rabais')) || 0;              // taux % saisi/extrait
  const rabaisMontantPdf = parseFloat(v('rabais_montant')) || 0; // montant exact lu sur le PDF
  const tvaTaux = parseFloat(v('tva_taux')) || 8.1;
  let total = parseFloat(v('total')) || 0;

  // Lit les lignes telles qu'éditées par l'utilisateur dans le formulaire d'import
  let lignes = _docImpReadLines();
  const sommeLignes = lignes.reduce((s, l) => s + (l.qte || 0) * (l.prix || 0), 0);

  // ── Détermination du sous-total HT ────────────────────────────────────────
  if (sommeLignes > 0.5) {
    // Des lignes portent de vrais prix (forfait + nacelle, etc.) → on leur fait
    // confiance et le sous-total HT = somme des lignes. On NE répartit RIEN et on
    // ne réécrit PAS le sous-total depuis le TTC (ça fausserait les vraies lignes).
    sousTotal = Math.round(sommeLignes * 100) / 100;
  } else {
    // Aucune ligne chiffrée (que des descriptions) → forfait global, comme avant :
    // on déduit le sous-total HT depuis le Total TTC si possible.
    if (total > 0) {
      const facteur = (1 - rabais/100) * (1 + tvaTaux/100);
      const sousTotalCible = total / facteur;
      if (sousTotal === 0 || Math.abs(sousTotalCible - sousTotal) > 1) {
        sousTotal = Math.round(sousTotalCible * 100) / 100;
      }
    }
    if (sousTotal > 0) {
      lignes.push({ desc: 'Forfait global (selon devis/facture original)', qte: 1, prix: sousTotal });
    }
  }

  // ── Rabais : on reproduit le MONTANT exact du PDF si l'IA l'a lu ───────────
  // (utile quand le rabais ne porte que sur une partie, ex le forfait seul).
  // On stocke un taux % "effectif" pour que tous les calculs en aval (éditeur,
  // PDF, stats) retombent sur le même montant.
  let rabaisMontant;
  if (rabaisMontantPdf > 0 && sousTotal > 0) {
    rabaisMontant = Math.round(rabaisMontantPdf * 100) / 100;
    rabais = Math.round((rabaisMontant / sousTotal) * 10000) / 100; // % effectif, 2 déc.
  } else {
    rabaisMontant = Math.round(sousTotal * (rabais / 100) * 100) / 100;
  }
  let tvaMontant = Math.round((sousTotal - rabaisMontant) * (tvaTaux / 100) * 100) / 100;
  // Total : on garde le Total TTC lu sur le PDF s'il existe (reproduction fidèle,
  // certains documents ont 1-2 ct d'écart d'arrondi) ; sinon on le recalcule.
  const totalCalc = Math.round((sousTotal - rabaisMontant + tvaMontant) * 100) / 100;
  if (!(total > 0)) total = totalCalc;
  // Liaison avec un bon de travaux existant si le numéro extrait correspond
  const bonNumeroSaisi = v('bon_numero');
  let bonIdLie = '';
  if (bonNumeroSaisi) {
    const norm = s => String(s||'').replace(/\s+/g,'').toLowerCase();
    const target = norm(bonNumeroSaisi);
    const bonTrouve = (DB.bons || []).find(b => norm(b.numero) === target);
    if (bonTrouve) bonIdLie = bonTrouve.id;
  }

  // ── Création / liaison du locataire dans la rubrique Locataires ───────────
  const locPrenom = v('locataire_prenom');
  const locNomFam = v('locataire_nom');
  const locNomComplet = (locPrenom && locNomFam) ? (locPrenom + ' ' + locNomFam) : (locNomFam || locPrenom);
  const locAdr  = v('locataire_adresse');
  const locNpa  = v('locataire_npa');
  const locVille= v('locataire_ville');
  const locTel  = v('locataire_tel');
  const locMail = v('locataire_email');
  const creerLocataire = !!($('docimp-creer-locataire') && $('docimp-creer-locataire').checked);
  let locataireMessage = '';
  if (creerLocataire && locNomComplet) {
    const norm = s => String(s||'').replace(/\s+/g,'').toLowerCase();
    // Cherche un client (gérance) existant pour rattacher le locataire
    const clientNomImp = v('client_nom');
    let clientIdLie = '';
    if (clientNomImp) {
      const ciCible = norm(clientNomImp);
      const cTrouve = (DB.clients || []).find(c => norm(c.nom) === ciCible);
      if (cTrouve) clientIdLie = cTrouve.id;
    }
    // Cherche un locataire existant (même nom + même adresse ou même nom + même client)
    const cibleNom = norm(locNomComplet);
    const cibleAdr = norm(locAdr);
    const dejaExiste = (DB.locataires || []).find(l => {
      if (norm(l.nom) !== cibleNom) return false;
      if (cibleAdr && norm(l.adresse) === cibleAdr) return true;
      if (clientIdLie && l.clientId === clientIdLie) return true;
      return !cibleAdr && !clientIdLie; // même nom et pas d'adresse → considère identique
    });
    if (dejaExiste) {
      // Complète éventuellement les champs manquants
      let modifie = false;
      const enrichir = (k, val) => { if (val && !dejaExiste[k]) { dejaExiste[k] = val; modifie = true; } };
      enrichir('adresse', locAdr); enrichir('npa', locNpa); enrichir('ville', locVille);
      enrichir('tel', locTel); enrichir('email', locMail);
      enrichir('prenom', locPrenom);
      if (clientIdLie) enrichir('clientId', clientIdLie);
      if (modifie) { const ll = DB.locataires; DB.locataires = ll; }
      locataireMessage = ' (locataire « ' + locNomComplet + ' » déjà existant — coordonnées complétées)';
    } else {
      const nouveau = {
        id: newId(),
        nom: locNomComplet,
        prenom: locPrenom,
        tel: locTel, email: locMail,
        adresse: locAdr, npa: locNpa, ville: locVille,
        clientId: clientIdLie,
        notes: 'Créé automatiquement depuis l\'import ' + (type === 'facture' ? 'de la facture' : 'du devis') + ' ' + numero
      };
      const ll = DB.locataires; ll.push(nouveau); DB.locataires = ll;
      locataireMessage = ' + locataire « ' + locNomComplet + ' » créé';
    }
  }
  // ──────────────────────────────────────────────────────────────────────────
  // L'objet et le n° de bon sont reportés comme LIGNES de la prestation
  // (et non plus dans les notes). Les notes ne gardent que ce que l'utilisateur saisit.
  const objet = v('objet');
  // Les notes ne gardent que ce que l'utilisateur saisit, MAIS on retire les lignes
  // "Payable par ..." : le propriétaire/destinataire est déjà géré dans l'adresse du document.
  const notesFinales = (v('notes') || '')
    .split('\n')
    .filter(l => !/^\s*payable\s+par\b/i.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  {
    const norm = s => String(s||'')
      .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'')
      .replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
    const objetN = norm(objet);
    // S'assure qu'il y a au moins une ligne support
    if (lignes.length === 0 && objet) lignes.push({ desc: objet, qte: 1, prix: 0 });
    // 1) Objet → ligne dédiée en tête, sauf s'il est déjà présent dans une ligne
    if (objet) {
      const dejaPresent = lignes.some(l => {
        const dN = norm(l.desc);
        if (!objetN) return false;
        if (dN.includes(objetN)) return true;
        const mots = objetN.split(' ').filter(w => w.length > 3);
        if (!mots.length) return false;
        return mots.filter(w => dN.includes(w)).length / mots.length >= 0.7;
      });
      if (!dejaPresent) lignes.unshift({ desc: objet, qte: 1, prix: 0 });
    }
    // 2) N° de bon de travaux → ligne séparée tout en haut (s'il n'y est pas déjà)
    if (bonNumeroSaisi) {
      const dejaBon = lignes.some(l => norm(l.desc).indexOf(norm(bonNumeroSaisi)) !== -1);
      if (!dejaBon) lignes.unshift({ desc: 'N° bon de travaux : ' + bonNumeroSaisi, qte: 1, prix: 0 });
    }
  }

  const doc = {
    id: newId(),
    type: type,
    numero: numero,
    dateDoc: v('date') || today(),
    bonId: bonIdLie,
    clientNom: v('client_nom'),
    clientAdresse: v('client_adresse'),
    clientNpa: v('client_npa'),
    clientVille: v('client_ville'),
    locataireNom: v('locataire_nom'),
    locataireAdresse: v('locataire_adresse'),
    proprietaire: v('proprietaire'),
    lignes: lignes,
    sousTotal: Math.round(sousTotal*100)/100,
    rabais: rabais,
    rabaisMontant: Math.round(rabaisMontant*100)/100,
    tvaTaux: tvaTaux,
    tvaMontant: Math.round(tvaMontant*100)/100,
    total: Math.round(total*100)/100,
    statut: v('statut') || 'brouillon',
    notes: notesFinales
  };
  const list = DB.documents; list.push(doc); DB.documents = list;
  toast('✓ ' + (type==='facture'?'Facture':'Devis') + ' ' + doc.numero + ' importé' + locataireMessage, '#2d9e6b');
  docImportCancel();
  state.docsFilter = (type === 'facture') ? 'facture' : 'devis';
  renderDocuments();
  if (typeof renderLocataires === 'function') renderLocataires();
  if (typeof renderDashboard === 'function') renderDashboard();
}

// Rétablit l'espacement autour de "p.a." / "p/a" (ex "PREVHORp.a. Naef" → "PREVHOR p.a. Naef")
// et nettoie les espaces multiples. Sert pour l'affichage du destinataire et du débiteur QR.
function _fixPa(txt) {
  // Les retours à la ligne saisis par l'utilisateur sont PRÉSERVÉS (on ne compresse
  // que les espaces/tabulations), afin que le bloc destinataire garde sa mise en forme.
  return String(txt || '')
    .split('\n')
    .map(line => line
      .replace(/[ \t]*p[ \t]*[\.\/][ \t]*a\.?[ \t]*/gi, ' p.a. ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim())
    .join('\n')
    .trim();
}

// Bande "Nos prestations" en bas de page (pictogramme + libellé), façon modèle.
function _drawPrestationsFooter(doc, W, H) {
  // Bande illustrée "Nos prestations" (image PNG base64 : ligne rouge + 6 pictos + libellés).
  if (typeof FOOTER_PRESTATIONS_B64 === 'undefined' || !FOOTER_PRESTATIONS_B64) return;
  const margin = 20;
  const imgW = W - 2 * margin;             // pleine largeur utile
  const imgH = imgW * (320 / 1500);        // ratio de l'image source (1500x320)
  const y = H - 8 - imgH;                  // ancrée plus bas en bas de page
  try { doc.addImage(FOOTER_PRESTATIONS_B64, 'PNG', margin, y, imgW, imgH); } catch (e) { console.warn('footer prestations', e); }
}
// Génère le PDF (devis ou facture) — facture inclut le QR-bill
// ============================================================
// RAPPELS DE PAIEMENT (factures impayées)
// ============================================================
const RAPPEL_LABELS = { 1: '1ER RAPPEL', 2: '2E RAPPEL', 3: '3E RAPPEL — MISE EN DEMEURE' };
const RAPPEL_TEXTES = {
  1: "Sauf erreur ou omission de notre part, la facture mentionnée ci-dessous demeure impayée à ce jour. Nous vous prions de bien vouloir procéder à son règlement dans un délai de 10 jours. Si votre paiement s'est croisé avec ce rappel, nous vous prions de ne pas en tenir compte et vous en remercions.",
  2: "Malgré notre premier rappel, la facture mentionnée ci-dessous demeure impayée. Nous vous prions de bien vouloir la régler dans un délai de 10 jours. Conformément à nos conditions, des frais de rappel de CHF 60.00 sont désormais ajoutés au montant dû.",
  3: "Malgré nos rappels précédents, la facture mentionnée ci-dessous demeure impayée. Par la présente, nous vous mettons formellement EN DEMEURE de régler le montant total ci-dessous dans un délai de 10 jours. À défaut de paiement dans ce délai, nous engagerons sans autre avis une procédure de recouvrement (poursuite), tous les frais en découlant étant à votre charge.",
};
// Ouvre la facture en mode RAPPEL dans le grand éditeur (avec aperçu PDF en direct),
// pré-rempli avec le niveau choisi. L'utilisateur modifie tout puis génère le PDF.
function openRappelModal(docId, niveau) {
  const src = (DB.documents || []).find(x => x.id === docId);
  if (!src) { toast('Facture introuvable', '#e63946'); return; }
  niveau = Math.min(3, Math.max(1, parseInt(niveau, 10) || 1));
  let baseTotal = parseFloat(src.total);
  if (!baseTotal || isNaN(baseTotal)) { try { baseTotal = _calcTotaux(src.lignes || [], src.tvaTaux, src.rabais).total || 0; } catch (e) { baseTotal = 0; } }
  const frais = niveau >= 2 ? 60 : 0;
  const r = JSON.parse(JSON.stringify(src));
  r._rappel = true;
  r._rappelNiveau = niveau;
  r._rappelSourceId = docId;
  r._rappelLabel = RAPPEL_LABELS[niveau];
  r._rappelTexte = RAPPEL_TEXTES[niveau];
  r._rappelFactureDate = src.dateDoc;       // date de la facture d'origine (sous-titre du PDF)
  r.dateDoc = today();                       // date d'émission du rappel (« Neuchâtel, le … »)
  r.lignes = [{ desc: 'Facture N° ' + (src.numero || '') + (src.dateDoc ? (' du ' + fmtDate(src.dateDoc)) : '') + ' — montant impayé', qte: 1, prix: baseTotal }];
  if (frais) r.lignes.push({ desc: 'Frais de rappel (' + niveau + 'e rappel)', qte: 1, prix: frais });
  r.tvaTaux = 0; r.rabais = 0; r.notes = '';
  _editingDoc = r;
  openDocEditor();
}
// Changement de niveau depuis l'éditeur de rappel : met à jour le texte légal et les frais.
function rappelEditSetNiveau(v) {
  if (!_editingDoc) return;
  const n = Math.min(3, Math.max(1, parseInt(v, 10) || 1));
  _editingDoc._rappelNiveau = n;
  _editingDoc._rappelLabel = RAPPEL_LABELS[n];
  _editingDoc._rappelTexte = RAPPEL_TEXTES[n];
  const frais = n >= 2 ? 60 : 0;
  _editingDoc.lignes = (_editingDoc.lignes || []).filter(l => !/frais de rappel/i.test(l.desc || ''));
  if (frais) _editingDoc.lignes.push({ desc: 'Frais de rappel (' + n + 'e rappel)', qte: 1, prix: frais });
  renderDocEditor();
}
// Génère le PDF du rappel, l'enregistre comme document (visible dans le ruban Factures
// ET sous la facture d'origine dans Anciennes factures), puis mémorise le niveau atteint.
function rappelGenererDepuisEditeur() {
  if (!_editingDoc) return;
  const niv = _editingDoc._rappelNiveau || 1;
  downloadDocPDF(_editingDoc);
  _saveRappelDoc(_editingDoc, niv);
  if (_editingDoc._rappelSourceId) _setAncRappel(_editingDoc._rappelSourceId, niv);
  closeModal('modal-doc');
  toast('📄 ' + (RAPPEL_LABELS[niv] || 'Rappel') + ' généré et enregistré', '#2d9e6b');
  if (typeof renderDocuments === 'function') { state.docsFilter = 'facture'; renderDocuments(); }
  if (typeof renderAnciennesList === 'function') renderAnciennesList();
}
// Enregistre (ou met à jour) le rappel dans DB.documents.
function _saveRappelDoc(ed, niv) {
  const t = _calcTotaux(ed.lignes, ed.tvaTaux, ed.rabais);
  const toSave = JSON.parse(JSON.stringify(ed));
  ['_bonNumeroSaisi', '_bonNote', '_rappel', '_rappelLabel', '_rappelTexte', '_rappelFactureDate', '_rappelNiveau', '_rappelSourceId']
    .forEach(k => delete toSave[k]);
  toSave.sousTotal = t.sousTotal; toSave.tvaMontant = t.tvaMontant; toSave.rabaisMontant = t.rabaisMontant; toSave.total = t.total;
  toSave.type = 'facture';
  toSave.statut = 'envoyee';
  // Métadonnées du rappel encodées dans notes (préserve d'éventuelles notes utilisateur)
  const baseNotes = String(ed.notes || '').replace(/\s*\[RAPPEL(?:DOC|SRC|FD|TXT):[^\]]*\]/g, '').replace(/\s*\[RAPPEL:\d\]/g, '').trim();
  const markers = '[RAPPELDOC:' + niv + '][RAPPELSRC:' + (ed._rappelSourceId || '') + '][RAPPELFD:' + (ed._rappelFactureDate || '') + '][RAPPELTXT:' + _encNote(ed._rappelTexte || '') + ']';
  toSave.notes = (baseNotes ? baseNotes + ' ' : '') + markers;
  const docs = DB.documents;
  // Si on régénère le même rappel (même facture source + même niveau), on remplace l'existant
  const existing = docs.find(x => _isRappelDoc(x) && (_rappelMeta(x) || {}).srcId === (ed._rappelSourceId || '') && (_rappelMeta(x) || {}).niveau === niv);
  if (existing) { toSave.id = existing.id; const i = docs.findIndex(x => x.id === existing.id); docs[i] = toSave; }
  else { toSave.id = newId(); docs.push(toSave); }
  DB.documents = docs;
}

// Génère un PDF imprimable pour un bon manuel (bon de travail sans PDF scanné).
function generateBonPDF(bonId) {
  const b = (DB.bons || []).find(x => x.id === bonId);
  if (!b) { toast('Bon introuvable', '#e63946'); return; }
  if (!window.jspdf || !window.jspdf.jsPDF) { toast('Librairie PDF non chargée', '#e63946'); return; }
  try {
    const co = DERATEK_CONFIG.company;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const W = 210, H = 297;
    // --- En-tête (logo + coordonnées + filet) ---
    const logoW = 62, logoH = logoW * 199 / 900, logoY = 13;
    const headerFiletY = logoY + logoH + 5;
    if (typeof LOGO_B64 !== 'undefined') { try { doc.addImage(LOGO_B64, 'PNG', 20, logoY, logoW, logoH); } catch (e) {} }
    else { doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.setTextColor(13, 27, 62); doc.text('DERATEK', 20, 23); }
    const cy0 = logoY + 4;
    const colA = [co.rue, `${co.npa} ${co.ville}`, 'Tél. ' + co.tel];
    const colB = [co.email, co.tva];
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(70);
    colA.forEach((l, i) => { if (l) doc.text(l, 92, cy0 + i * 4.4); });
    colB.forEach((l, i) => { if (l) doc.text(l, 146, cy0 + i * 4.4); });
    doc.setTextColor(13, 27, 62);
    try { doc.textWithLink('www.deratek.ch', 146, cy0 + 2 * 4.4, { url: 'https://www.deratek.ch' }); } catch (e) { doc.text('www.deratek.ch', 146, cy0 + 2 * 4.4); }
    doc.setTextColor(0);
    doc.setDrawColor(200, 205, 213); doc.setLineWidth(0.4); doc.line(20, headerFiletY, 190, headerFiletY);
    // --- Bandeau titre ---
    let y = headerFiletY + 8;
    doc.setFillColor(13, 27, 62); doc.rect(20, y, 170, 11, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(255);
    doc.text('BON DE TRAVAIL', 24, y + 7.4);
    doc.setFontSize(11); doc.text(String(b.numero || ''), 186, y + 7.4, { align: 'right' });
    doc.setTextColor(0); y += 17;
    // Date
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    doc.text('Date : ' + (fmtDate(b.date) || '—'), 20, y); y += 9;
    // Fiches liées : on récupère les coordonnées complètes (téléphones, e-mails, adresses)
    const cli = (b.geranceId && (DB.clients || []).find(c => c.id === b.geranceId))
             || (b.geranceNom && (DB.clients || []).find(c => (c.nom || '').toLowerCase() === String(b.geranceNom).toLowerCase()))
             || null;
    const loc = (b.locataireId && (DB.locataires || []).find(l => l.id === b.locataireId))
             || (b.locataireNom && (DB.locataires || []).find(l => (l.nom || '').toLowerCase() === String(b.locataireNom).toLowerCase()))
             || null;
    const gerTel   = b.gerantTel   || (cli ? cli.tel   : '');
    const gerEmail = b.gerantEmail || (cli ? cli.email : '');
    const gerAdr   = cli ? [cli.adresse, `${cli.npa || ''} ${cli.ville || ''}`.trim()].filter(Boolean).join(', ') : '';
    const locTel   = loc ? (loc.tel   || '') : '';
    const locEmail = loc ? (loc.email || '') : '';
    const locAdr   = (loc ? [loc.adresse, `${loc.npa || ''} ${loc.ville || ''}`.trim()].filter(Boolean).join(', ') : '') || b.immeuble || '';
    // --- Champs (label : valeur) ---
    const rows = [
      ['Gérance', b.geranceNom || '—'],
      ['Gérant', b.gerantNom || ''],
      ['Tél. gérance', gerTel],
      ['E-mail gérance', gerEmail],
      ['Adresse gérance', gerAdr],
      ['Propriétaire', b.proprietaire || ''],
      ['Locataire', b.locataireNom || '—'],
      ['Tél. locataire', locTel],
      ['E-mail locataire', locEmail],
      ['Adresse locataire', locAdr],
      ['Immeuble', b.immeuble || ''],
      ['Contact sur place', b.contactSurPlace || ''],
      ['Concierge', b.concierge || ''],
    ].filter(r => r[1]);
    doc.setFontSize(10);
    rows.forEach(([k, v]) => {
      doc.setFont('helvetica', 'bold'); doc.setTextColor(90); doc.text(k + ' :', 20, y);
      doc.setFont('helvetica', 'normal'); doc.setTextColor(0);
      const lines = doc.splitTextToSize(String(v), 110);
      lines.forEach((ln, i) => doc.text(ln, 74, y + i * 5));
      y += Math.max(6, lines.length * 5 + 1);
    });
    y += 4;
    // --- Nuisible / problème ---
    doc.setFillColor(245, 247, 250); doc.rect(20, y, 170, 8, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(13, 27, 62);
    doc.text('NUISIBLE / PROBLÈME SIGNALÉ', 24, y + 5.5); doc.setTextColor(0); y += 12;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    doc.splitTextToSize(_bonProblemeClean(b) || '—', 168).forEach(ln => { doc.text(ln, 22, y); y += 5; });
    y += 6;
    // --- Dates d'intervention ---
    const dates = _bonDatesInterv(b);
    doc.setFont('helvetica', 'bold'); doc.setTextColor(90); doc.text('Dates d\'intervention :', 20, y);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(0);
    doc.text(dates.length ? dates.map(fmtDate).join(', ') : '—', 74, y);
    y += 22;
    // --- Zone de signatures ---
    doc.setDrawColor(160); doc.setLineWidth(0.3);
    doc.line(24, y, 92, y); doc.line(118, y, 186, y);
    doc.setFontSize(8.5); doc.setTextColor(110);
    doc.text('Signature technicien', 24, y + 4);
    doc.text('Signature client', 118, y + 4);
    doc.setTextColor(0);
    if (typeof _drawPrestationsFooter === 'function') _drawPrestationsFooter(doc, W, H);
    const fname = 'bon-' + String(b.numero || 'sans-numero').replace(/[^\w-]+/g, '_') + '.pdf';
    doc.save(fname);
    toast('PDF du bon généré', '#2d9e6b');
  } catch (e) { console.error(e); toast('Erreur lors de la génération du PDF du bon', '#e63946'); }
}

function downloadDocPDF(id, mode) {
  // id peut être un identifiant OU directement un objet document (aperçu en direct dans l'éditeur)
  let d = (id && typeof id === 'object') ? id : (DB.documents || []).find(x => x.id === id);
  if (!d) { if (mode !== 'blob') toast('Document introuvable', '#e63946'); return; }
  // Rappel sauvegardé (rechargé sans champs runtime) → on reconstitue _rappel* sur une copie
  if (!d._rappel && _isRappelDoc(d)) d = _applyRappelRuntime(JSON.parse(JSON.stringify(d)));
  if (!window.jspdf || !window.jspdf.jsPDF) { toast('Librairie PDF non chargée', '#e63946'); return; }
  // Sécurisation : lignes peut arriver comme string JSON depuis Supabase, ou être absent
  if (typeof d.lignes === 'string') { try { d.lignes = JSON.parse(d.lignes); } catch (e) { d.lignes = []; } }
  if (!Array.isArray(d.lignes)) d.lignes = [];
  if (d.rabais === undefined || d.rabais === null) d.rabais = 0;
  if (d.tvaTaux === undefined || d.tvaTaux === null) d.tvaTaux = 8.1;
  try {
  const co = DERATEK_CONFIG.company;
  const bureau = _docBureau(d);   // adresse du bureau émetteur choisi pour ce document
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, H = 297;
  // Police du document : Arial (embarquée via fonts_arial.js — Liberation Sans, métriques
  // strictement identiques à Arial). Repli sur Helvetica si le fichier n'est pas chargé.
  const FONT = (function () { try { return doc.getFontList().Arial ? 'Arial' : 'helvetica'; } catch (e) { return 'helvetica'; } })();
  const isFacture = d.type === 'facture';
  const t = _calcTotaux(d.lignes, d.tvaTaux, d.rabais, _docExpertise(d));

  // --- En-tête horizontal (LOGO + coordonnées) — dessiné sur CHAQUE page ---
  const logoW = 62, logoH = logoW * 199 / 900;   // logo agrandi (ratio d'origine conservé)
  const logoY = 13;
  const headerFiletY = logoY + logoH + 5;        // Y du filet de séparation
  const drawHeader = () => {
    if (typeof LOGO_B64 !== 'undefined') {
      try { doc.addImage(LOGO_B64, 'PNG', 20, logoY, logoW, logoH); }
      catch (e) { console.warn('logo', e); }
    } else {
      doc.setFont(FONT, 'bold'); doc.setFontSize(20); doc.setTextColor(13, 27, 62); doc.text('DERATEK', 20, 23);
    }
    // Coordonnées en 2 colonnes à droite du logo
    const cy0 = logoY + 4;
    const colA = [bureau.rue, `${bureau.npa} ${bureau.ville}`, 'Tél. ' + bureau.tel];
    const colB = [co.email, co.tva];
    doc.setFont(FONT, 'normal'); doc.setFontSize(8.5); doc.setTextColor(70);
    colA.forEach((l, i) => { if (l) doc.text(l, 92, cy0 + i * 4.4); });
    colB.forEach((l, i) => { if (l) doc.text(l, 146, cy0 + i * 4.4); });
    // Site web (lien cliquable) sous l'email / la TVA
    doc.setTextColor(13, 27, 62);
    try { doc.textWithLink('www.deratek.ch', 146, cy0 + 2 * 4.4, { url: 'https://www.deratek.ch' }); }
    catch (e) { doc.text('www.deratek.ch', 146, cy0 + 2 * 4.4); }
    doc.setTextColor(0);
    // Filet de séparation sous l'en-tête
    doc.setDrawColor(200, 205, 213); doc.setLineWidth(0.4); doc.line(20, headerFiletY, 190, headerFiletY);
    doc.setFont(FONT, 'normal'); doc.setTextColor(0);
  };
  // Démarre une nouvelle page de contenu : saut de page + en-tête répété, renvoie le Y de départ
  const startContentPage = () => { doc.addPage(); drawHeader(); return headerFiletY + 8; };
  drawHeader();

  // Date d'émission, sous le filet, à GAUCHE ("Neuchâtel, le ...") — hors de la
  // fenêtre droite de l'enveloppe C5 (sinon la date apparaît dans la fenêtre).
  doc.setFont(FONT, 'bold'); doc.setFontSize(10); doc.setTextColor(13, 27, 62);
  doc.text((bureau.ville || 'Neuchâtel') + ', le ' + (fmtDate(d.dateDoc) || ''), 20, headerFiletY + 5);
  doc.setFont(FONT, 'normal'); doc.setTextColor(0);

  // Destinataire (client) à droite — même position que le générateur
  // Si un propriétaire est renseigné : "Propriétaire / p.a. Gérance / adresse gérance"
  doc.setFontSize(11);
  let dy = 59;   // adresse du destinataire alignée sur la ligne « N° TVA » (titleY 50 + 9)
  const _hasStruct = (d.clientAdresse || '').trim() || (d.clientNpa || '').trim() || (d.clientVille || '').trim();
  let destLines;
  if ((d.proprietaire || '').trim()) {
    destLines = [d.proprietaire, 'p.a. ' + (d.clientNom || ''), d.clientAdresse, `${d.clientNpa||''} ${d.clientVille||''}`.trim()].filter(Boolean);
  } else if (!_hasStruct && (d.clientNom || '').includes(',')) {
    // Destinataire combiné dans un seul champ → on le découpe sur les virgules (1 élément par ligne)
    destLines = (d.clientNom || '').split(',').map(s => s.trim()).filter(Boolean);
  } else {
    destLines = [d.clientNom, d.clientAdresse, `${d.clientNpa||''} ${d.clientVille||''}`.trim()].filter(Boolean);
  }
  // Les retours à la ligne saisis dans les champs deviennent de vraies lignes du bloc destinataire
  destLines = destLines.map(l => _fixPa(l))
    .reduce((acc, l) => acc.concat(String(l).split('\n')), [])
    .map(s => s.trim()).filter(Boolean);
  destLines.forEach(l => { doc.splitTextToSize(String(l), 80).forEach(ln => { doc.text(ln, 120, dy); dy += 5.2; }); });

  // Titre du document À GAUCHE de l'adresse du destinataire (même hauteur, en haut)
  const titleY = 50;
  if (d._rappel) {
    doc.setFont(FONT, 'bold'); doc.setFontSize(15); doc.setTextColor(200, 30, 30);
    doc.text(d._rappelLabel || 'RAPPEL DE PAIEMENT', 20, titleY);
    doc.setFont(FONT, 'normal'); doc.setFontSize(9.5); doc.setTextColor(90);
    doc.text('Facture ' + (d.numero || '') + ((d._rappelFactureDate || d.dateDoc) ? (' du ' + fmtDate(d._rappelFactureDate || d.dateDoc)) : ''), 20, titleY + 6);
    doc.setTextColor(0);
  } else {
    doc.setFont(FONT, 'bold'); doc.setFontSize(14); doc.setTextColor(13, 27, 62);
    doc.text((isFacture ? 'Facture ' : 'Devis ') + (d.numero || ''), 20, titleY);
    doc.setTextColor(0);
  }
  // Bloc infos "label : valeur" sous le titre (à gauche)
  let infoY = titleY + 9;
  const bonLie = d.bonId ? (DB.bons || []).find(b => b.id === d.bonId) : null;
  const infoPairs = [
    ['N° TVA', co.tva],
    [isFacture ? 'Date facture' : 'Date devis', fmtDate(d.dateDoc) || ''],
  ];
  const _nuisDoc = [d.nuisible, d.nuisible2].map(x => String(x || '').trim()).filter(Boolean).join(', ');
  if (_nuisDoc) infoPairs.push(['Nuisible traité', _nuisDoc]);
  infoPairs.push(['Délai de paiement', '30 jours']);
  // Bon manuel (aucun bon fourni par la gérance) → libellé « Bon interne » : le numéro
  // BCM est une référence DERATEK, pas un n° de bon de travail du client.
  if (bonLie && bonLie.numero) infoPairs.unshift([_isBonManuel(bonLie) ? 'Bon interne' : 'N° bon de travail', bonLie.numero]);
  doc.setFontSize(9);
  infoPairs.forEach(([k, v]) => {
    if (!v) return;
    doc.setFont(FONT, 'normal'); doc.setTextColor(90);
    doc.text(k, 20, infoY);
    doc.setTextColor(0); doc.text(': ' + v, 62, infoY);
    infoY += 4.6;
  });
  infoY += 2;
  // Texte descriptif de l'intervention (« Concerne : … »). Placé PLUS BAS que la fenêtre
  // de l'enveloppe C5 (sinon son adresse apparaît dans la fenêtre à côté du destinataire).
  const descParts = [];
  if (d.locataireNom) descParts.push('Concerne : ' + d.locataireNom);
  if (d.locataireAdresse) descParts.push(d.locataireAdresse);
  if (descParts.length) {
    let cy = Math.max(infoY, 92);   // 92 mm : sous la zone fenêtre du destinataire
    doc.setFont(FONT, 'normal'); doc.setFontSize(9); doc.setTextColor(40);
    doc.splitTextToSize(descParts.join(' — '), 170).forEach(ln => { doc.text(ln, 20, cy); cy += 4.6; });
    doc.setTextColor(0);
    infoY = cy;
  }
  // Texte de relance (rappel de paiement), placé sous la zone fenêtre de l'enveloppe
  if (d._rappel && d._rappelTexte) {
    let ry = Math.max(infoY, 96);
    doc.setFont(FONT, 'normal'); doc.setFontSize(10); doc.setTextColor(20);
    doc.splitTextToSize(d._rappelTexte, 170).forEach(ln => { doc.text(ln, 20, ry); ry += 5.2; });
    doc.setTextColor(0);
    infoY = ry + 3;
  }

  // En-tête du tableau — ruban BLEU (navy) avec texte blanc
  const drawLignesHeader = (y) => {
    doc.setFillColor(13, 27, 62); doc.rect(20, y - 5, 170, 7.5, 'F');
    doc.setTextColor(255, 255, 255); doc.setFontSize(8.5); doc.setFont(FONT, 'bold');
    doc.text('Désignation', 22, y); doc.text('Qté', 130, y, {align:'right'}); doc.text('Prix HT', 156, y, {align:'right'}); doc.text('Montant', 188, y, {align:'right'});
    doc.setTextColor(0); doc.setFont(FONT, 'normal');
    return y + 8.5;
  };

  // La table démarre sous le bloc infos (qui est déjà sous l'adresse) ET, surtout,
  // SOUS la fenêtre de l'enveloppe C5 : sinon le ruban bleu « Désignation » apparaît
  // dans la fenêtre à côté de l'adresse du destinataire. On impose donc un plancher.
  const ENV_WINDOW_SAFE_Y = 103;   // mm — remonté de 1 cm à la demande
  const startY = Math.max(infoY + 3, dy + 5, ENV_WINDOW_SAFE_Y);
  // Hauteur réelle du bloc totaux (sous-total + [rabais] + tva + total), marge incluse.
  // Rappel : un seul total. Facture : ~23 mm (sans rabais) / ~28 mm (avec rabais).
  const totalsH = d._rappel ? 14 : ((d.rabais || 0) > 0 ? 28 : 24);
  const lignes = d.lignes || [];

  // Géométrie du bulletin QR suisse : bande de 105 mm ancrée en bas d'une page.
  const QR_TOP = H - 105;             // perforation haute du bulletin
  const QR_NEED_TOP = QR_TOP - 10;    // le contenu doit finir au-dessus (place pour la condition de paiement)
  const contentBottom = H - 20;       // marge basse normale du flux

  // Rythme vertical uniforme : hauteur d'une ligne de texte + marge identique
  // au-dessus et en dessous du filet, quelle que soit la longueur de la désignation.
  doc.setFontSize(9.5);
  let LINE = 4.4;   // hauteur d'une ligne de texte (mm)
  let PAD  = 3;     // marge uniforme texte ↔ filet ↔ ligne suivante

  // --- Compression adaptative (factures) : on resserre UNIQUEMENT le tableau (jamais les
  // totaux, qui gardent un espacement normal), juste ce qu'il faut pour tenir sur UNE page. ---
  let _K = 1;
  if (isFacture) {
    // Hauteur cumulée des RANGÉES seules (l'en-tête du tableau, 8.5 mm, n'est pas comprimé).
    let rowsRaw = 0;
    lignes.forEach(l => { rowsRaw += doc.splitTextToSize(l.desc || '', 100).length * LINE + 2 * PAD; });
    const headerH = 8.5;
    // Place réellement disponible pour les rangées avant le bulletin QR (totaux réservés).
    const availForRows = QR_NEED_TOP - startY - headerH - totalsH - 1;
    // On comprime UNIQUEMENT ce qu'il faut pour garder le QR sur la page 1 dès qu'il
    // y a la place. Si même comprimé au maximum ça ne tient pas → vraie 2e page.
    if (rowsRaw > availForRows) {
      const k = availForRows / rowsRaw;
      if (k >= 0.55) _K = k;
    }
  }
  LINE *= _K; PAD *= _K;

  // Les lignes suivent le flux normal et continuent en page suivante si nécessaire.
  let ty = startY;
  ty = drawLignesHeader(ty);
  lignes.forEach((l) => {
    const _lr = parseFloat(l.rabais) || 0;
    const lt = (parseFloat(l.qte)||0) * (parseFloat(l.prix)||0) * (1 - _lr/100);
    const descLines = doc.splitTextToSize(String(l.desc || '').replace(/\*\*/g, '') + (_lr > 0 ? '   (rabais ' + _lr + '%)' : ''), 100);
    if (!descLines.length) descLines.push('');
    // Rendu ligne par ligne : une désignation longue se PARTAGE sur deux pages
    // (au lieu de basculer en entier sur la page suivante et de laisser un grand vide).
    let rowFirst = true;
    descLines.forEach((dl) => {
      if (ty + LINE + PAD > contentBottom) { ty = drawLignesHeader(startContentPage()); }
      const baseY = ty + LINE - 1;
      doc.text(dl, 22, baseY);
      if (rowFirst) {
        // Ligne purement informative (aucun prix) → on n'imprime pas « 0.00 » dans
        // les colonnes Qté / Prix HT / Montant : la désignation reste seule.
        const _sansPrix = (parseFloat(l.prix) || 0) === 0 && lt === 0;
        if (!_sansPrix) {
          doc.text(String(l.qte||0), 130, baseY, {align:'right'});
          doc.text(_displayMontant(l.prix||0), 156, baseY, {align:'right'});
          doc.text(_displayMontant(lt), 188, baseY, {align:'right'});
        }
        rowFirst = false;
      }
      ty += LINE;
    });
    // Filet fin sous la rangée
    const sepY = ty + PAD;
    doc.setDrawColor(225, 228, 233); doc.setLineWidth(0.2);
    doc.line(20, sepY, 190, sepY);
    ty = sepY + PAD;
  });

  // Bloc des totaux, juste APRÈS toutes les lignes (saut de page si pas la place).
  if (ty + totalsH > contentBottom) { ty = startContentPage(); }
  ty += 3;
  doc.line(120, ty, 190, ty); ty += 4.3;
  doc.setFontSize(9.5); doc.setFont(FONT, 'normal');
  if (d._rappel) {
    // Rappel : pas de détail HT/TVA, juste le montant total à payer (le QR reprend ce montant)
    doc.setFont(FONT, 'bold'); doc.setFontSize(12); doc.setTextColor(180, 30, 30);
    doc.text('Total à payer', 130, ty); doc.text(_displayMontant(t.total) + ' CHF', 188, ty, {align:'right'});
    doc.setTextColor(0);
    ty += 6;
  } else {
  doc.text('Sous-total HT', 130, ty); doc.text(_displayMontant(t.sousTotal) + ' CHF', 188, ty, {align:'right'}); ty += 4.3;
  if ((d.rabais || 0) > 0) {
    doc.setTextColor(180, 40, 40);
    doc.text(`Rabais ${d.rabais}%`, 130, ty); doc.text('- ' + _displayMontant(t.rabaisMontant) + ' CHF', 188, ty, {align:'right'}); ty += 4.3;
    doc.setTextColor(0);
  }
  if ((t.expertise || 0) > 0) {
    doc.setTextColor(180, 40, 40);
    doc.text('Déduction expertise', 130, ty); doc.text('- ' + _displayMontant(t.expertise) + ' CHF', 188, ty, {align:'right'}); ty += 4.3;
    doc.setTextColor(0);
  }
  doc.text(`TVA ${d.tvaTaux}%`, 130, ty); doc.text(_displayMontant(t.tvaMontant) + ' CHF', 188, ty, {align:'right'}); ty += 5.5;
  doc.setFont(FONT, 'bold'); doc.setFontSize(11);
  doc.text('Total TTC', 130, ty); doc.text(_displayMontant(t.total) + ' CHF', 188, ty, {align:'right'});
  ty += 6;
  }

  // Notes éventuelles, dans le flux (on retire le marqueur technique [ARCHIVE])
  if (_docNotesClean(d)) {
    const noteLines = doc.splitTextToSize(_docNotesClean(d), 170);
    const notesH = noteLines.length * 4.5 + 8;
    if (ty + notesH > contentBottom) { ty = startContentPage(); }
    doc.setFont(FONT,'normal'); doc.setFontSize(9); doc.setTextColor(80);
    doc.text(noteLines, 20, ty + 6); doc.setTextColor(0);
    ty += notesH;
  }

  // --- Photos (devis uniquement) : incluses dans le PDF, paginées si besoin ---
  if (!isFacture && !d._rappel && Array.isArray(d.photos)) {
    const dphotos = d.photos.filter(p => p && p.data && p.use !== false);
    if (dphotos.length) {
      if (ty + 16 > contentBottom) { ty = startContentPage(); }
      ty += 6;
      doc.setFont(FONT,'bold'); doc.setFontSize(11); doc.setTextColor(13,27,62);
      doc.text('Photos', 20, ty);
      doc.setDrawColor(200,205,213); doc.setLineWidth(0.4); doc.line(20, ty+1.8, 190, ty+1.8);
      doc.setTextColor(0); ty += 7;
      const pw = (170 - 6) / 2, ph = 58;
      dphotos.forEach((p, i) => {
        const col = i % 2;
        if (col === 0 && ty + ph + 10 > contentBottom) { ty = startContentPage(); }
        const px = 20 + col * (pw + 6);
        try {
          doc.addImage(p.data, 'JPEG', px, ty, pw, ph);
          doc.setDrawColor(225,228,238); doc.rect(px, ty, pw, ph, 'D');
          if (p.caption) { doc.setFont(FONT,'italic'); doc.setFontSize(8); doc.setTextColor(70); doc.text(doc.splitTextToSize(String(p.caption), pw).slice(0,2), px, ty+ph+3.6); doc.setTextColor(0); }
        } catch (e) {}
        if (col === 1 || i === dphotos.length - 1) ty += ph + 11;
      });
    }
  }

  // --- Bon pour accord (devis uniquement) : date + signature du client ---
  if (!isFacture && !d._rappel) {
    if (ty + 30 > contentBottom) { ty = startContentPage(); }
    ty += 10;
    const bx = 110, bw = 80;
    doc.setFont(FONT, 'bold'); doc.setFontSize(10); doc.setTextColor(13, 27, 62);
    doc.text('Bon pour accord', bx, ty);
    doc.setFont(FONT, 'normal'); doc.setFontSize(9); doc.setTextColor(80);
    doc.text('Date et signature du client :', bx, ty + 6);
    doc.setTextColor(0);
    doc.setDrawColor(120); doc.setLineWidth(0.3);
    doc.line(bx, ty + 22, bx + bw, ty + 22);
    ty += 26;
  }

  // --- Bulletin QR (factures) : DANS LE FLUX, ancré en bas de la page courante. ---
  // S'il ne reste pas la place sous le contenu, il bascule entier en bas de la page
  // suivante (jamais coupé, jamais superposé au texte).
  let qrPageNum = doc.internal.getNumberOfPages();
  if (isFacture) {
    if (ty > QR_NEED_TOP) {            // pas assez de place sous le contenu → page suivante
      doc.addPage(); drawHeader();     // en-tête répété sur la page du bulletin
      qrPageNum = doc.internal.getNumberOfPages();
    }
    doc.setPage(qrPageNum);
    const billTop = H - 105;
    const recW = 62, payX = recW, padX = 5;
    const message = 'Facture ' + (d.numero || '');
    // Débiteur du QR : propriétaire si présent, payable à l'adresse de la gérance
    const debtorNom = (d.proprietaire || '').trim() ? d.proprietaire : d.clientNom;
    const debtor = { nom: debtorNom, rue: d.clientAdresse, npa: d.clientNpa, ville: d.clientVille };
    const payload = _buildSpcPayload(t.total, message, debtor, bureau);
    const qrUrl = _makeQrDataUrl(payload);
    const debtLines = ((d.proprietaire || '').trim()
      ? [d.proprietaire, 'p.a. ' + (d.clientNom||''), d.clientAdresse, `${d.clientNpa||''} ${d.clientVille||''}`.trim()].filter(Boolean)
      : ((d.clientNom || '').trim() ? [d.clientNom, d.clientAdresse, `${d.clientNpa||''} ${d.clientVille||''}`.trim()].filter(Boolean) : null));
    const debtLinesClean = debtLines
      ? debtLines.map(l => _fixPa(l))
          .reduce((acc, l) => acc.concat(String(l).split('\n')), [])
          .map(s => s.trim()).filter(Boolean)
      : null;

    // Conditions de paiement, juste au-dessus de la ligne pointillée
    doc.setFont(FONT, 'bold'); doc.setFontSize(9); doc.setTextColor(13, 27, 62);
    doc.text('Condition de paiement : 30 jours net.', 20, billTop - 11);
    doc.setFont(FONT, 'normal'); doc.setFontSize(8.5); doc.setTextColor(90);
    doc.text('Veuillez utiliser le bulletin de versement ci-dessous pour le paiement.', 20, billTop - 6);
    doc.setTextColor(0);

    // Lignes de découpe
    doc.setLineWidth(0.2); doc.setDrawColor(120); doc.setLineDashPattern([1.4, 1], 0);
    doc.line(0, billTop, W, billTop); doc.line(payX, billTop, payX, H);
    doc.setLineDashPattern([], 0);
    doc.setFontSize(8); doc.setTextColor(110); doc.text('✂', 3, billTop + 1.2); doc.setTextColor(0);

    const L = (txt, x, y) => { doc.setFont(FONT,'bold'); doc.setFontSize(6); doc.text(txt, x, y); return y + 3.4; };
    const V = (arr, x, y, size, maxW) => {
      doc.setFont(FONT,'normal'); doc.setFontSize(size||8);
      const lh = (size||8)*0.40; let cy = y;
      (Array.isArray(arr)?arr:[arr]).forEach(ln => { if(!ln) return; (maxW?doc.splitTextToSize(String(ln),maxW):[String(ln)]).forEach(p=>{doc.text(p,x,cy);cy+=lh;}); });
      return cy;
    };
    const credLines = [_displayIban(co.iban), co.nom, bureau.rue, `${bureau.npa} ${bureau.ville}`].filter(Boolean);
    const amountDisp = _displayMontant(t.total);

    // Récépissé
    let y = billTop + 7;
    doc.setFont(FONT,'bold'); doc.setFontSize(11); doc.text('Récépissé', padX, y); y += 8;
    y = L('Compte / Payable à', padX, y); y = V(credLines, padX, y, 7, recW-padX-4) + 1.5;
    y = L('Payable par', padX, y);
    if (debtLinesClean) y = V(debtLinesClean, padX, y, 7, recW-padX-4) + 1.5; else y += 6;
    const amountY = 255;
    L('Monnaie', padX, amountY); L('Montant', padX+18, amountY);
    V([co.devise||'CHF'], padX, amountY+3.6, 8); V([amountDisp], padX+18, amountY+3.6, 8);
    doc.setFont(FONT,'bold'); doc.setFontSize(6); doc.text('Point de dépôt', recW-5, H-8, {align:'right'});

    // Section paiement
    const px2 = payX + 5; let py = billTop + 7;
    doc.setFont(FONT,'bold'); doc.setFontSize(11); doc.text('Section paiement', px2, py);
    const qrSize = 46, qrX = px2, qrY = py + 4;
    if (qrUrl) doc.addImage(qrUrl, 'PNG', qrX, qrY, qrSize, qrSize);
    // Croix suisse au centre
    const cx = qrX+qrSize/2, cyc = qrY+qrSize/2;
    doc.setFillColor(0,0,0); doc.rect(cx-3.5,cyc-3.5,7,7,'F');
    doc.setFillColor(255,255,255); doc.rect(cx-3.0,cyc-3.0,6,6,'F');
    doc.setFillColor(0,0,0); doc.rect(cx-2.05,cyc-0.65,4.1,1.3,'F'); doc.rect(cx-0.65,cyc-2.05,1.3,4.1,'F');
    const may = amountY;
    L('Monnaie', px2, may); L('Montant', px2+18, may);
    V([co.devise||'CHF'], px2, may+3.6, 9); V([amountDisp], px2+18, may+3.6, 9);
    const ix = qrX+qrSize+8, infoW = W-ix-6; let iy = billTop+7;
    iy = L('Compte / Payable à', ix, iy); iy = V(credLines, ix, iy, 9, infoW) + 2;
    iy += 2.5; iy = L('Informations supplémentaires', ix, iy); iy = V([message], ix, iy, 9, infoW) + 2;
    iy += 2.5; iy = L('Payable par', ix, iy);
    if (debtLinesClean) iy = V(debtLinesClean, ix, iy, 9, infoW) + 2;
  }

  // --- Bande "Nos prestations" en bas de la DERNIÈRE page ---
  // Uniquement sur les FACTURES (retirée des devis à la demande), et seulement si
  // cette page ne contient PAS le bulletin QR (pas de superposition).
  const lastPage = doc.internal.getNumberOfPages();
  if (isFacture && lastPage > 1 && lastPage !== qrPageNum) {
    doc.setPage(lastPage);
    _drawPrestationsFooter(doc, W, H);
  }

  // Mode "blob" : on renvoie une URL d'aperçu (survol) au lieu de télécharger.
  if (mode === 'blob') return doc.output('bloburl');
  const fname = (d._rappel ? 'rappel-' : (isFacture?'facture-':'devis-')) + (d.numero||'doc').replace(/[^a-z0-9]+/gi,'-').toLowerCase() + '.pdf';
  doc.save(fname);
  toast('✓ PDF téléchargé', '#2d9e6b');
  } catch (err) {
    console.error('PDF error', err);
    if (mode !== 'blob') toast('Erreur PDF : ' + (err.message || 'voir console'), '#e63946');
  }
}

// ============================================================
// RAPPORT DIAGNOSTIC INSECTES DU BOIS
// ============================================================
const INSECTES_BOIS = ['Capricornes des maisons', 'Vrillettes (petite/grosse)', 'Lyctus', 'Termites', 'Fourmis charpentières', 'Sirex', 'Hespérophanes'];

// Fiches descriptives des insectes xylophages — incluses automatiquement
// dans le PDF pour chaque insecte coché dans le diagnostic.
const INSECTES_BOIS_INFO = {
  'Capricornes des maisons': {
    latin: 'Hylotrupes bajulus',
    bois: 'Résineux (sapin, épicéa, pin) — aubier des charpentes',
    indices: "Trous d'envol ovales de 6 à 10 mm, galeries remplies de vermoulure tassée, surface du bois souvent intacte en apparence, grignotement parfois audible",
    cycle: 'Larve active 3 à 10 ans dans le bois avant l\'envol de l\'adulte (juin–août)',
    risque: 'Peut compromettre la résistance mécanique de la charpente ; traitement indispensable dès détection',
  },
  'Vrillettes (petite/grosse)': {
    latin: 'Anobium punctatum / Xestobium rufovillosum',
    bois: 'Feuillus et résineux ; la grosse vrillette préfère les bois humides ou dégradés par des champignons (chêne ancien)',
    indices: "Trous d'envol ronds de 1 à 3 mm (petite) ou 2,5 à 4 mm (grosse), vermoulure granuleuse s'écoulant des trous, bois criblé",
    cycle: 'Larve 2 à 4 ans, davantage en bois sec',
    risque: "Affaiblissement progressif ; la grosse vrillette révèle souvent un problème d'humidité à traiter en parallèle",
  },
  'Lyctus': {
    latin: 'Lyctus brunneus / Lyctus linearis',
    bois: "Feuillus riches en amidon : aubier de chêne, frêne, châtaignier, bois exotiques (parquets, menuiseries récentes)",
    indices: "Trous d'envol ronds de 1 à 2 mm, vermoulure très fine semblable à du talc",
    cycle: 'Cycle court : 8 à 12 mois',
    risque: "Réduit l'aubier en poudre ; propagation rapide dans les bois mis en œuvre récemment",
  },
  'Termites': {
    latin: 'Reticulitermes spp.',
    bois: 'Tous bois et matériaux cellulosiques, en progression depuis le sol',
    indices: "Pas de trous d'envol visibles : bois feuilleté vidé de l'intérieur, cordonnets terreux, surface intacte",
    cycle: 'Colonie pérenne de plusieurs milliers à millions d\'individus',
    risque: 'Dégâts structurels majeurs et rapides ; traitement spécialisé de la zone entière requis',
  },
  'Fourmis charpentières': {
    latin: 'Camponotus spp.',
    bois: 'Bois humides, tendres ou déjà dégradés',
    indices: 'Galeries lisses et propres (sans vermoulure interne), sciure grossière rejetée à proximité, ouvrières visibles',
    cycle: 'Colonie installée plusieurs années, essaimage au printemps',
    risque: "Ne mangent pas le bois mais le creusent pour nicher ; révèlent presque toujours un problème d'humidité",
  },
  'Sirex': {
    latin: 'Sirex / Urocerus spp. (guêpes du bois)',
    bois: 'Résineux, généralement infestés avant la mise en œuvre du bois',
    indices: "Trous d'envol parfaitement circulaires de 4 à 7 mm, galeries fourrées de vermoulure compacte",
    cycle: 'Larve 1 à 3 ans',
    risque: 'Pas de réinfestation du bois sec mis en œuvre ; dégâts limités mais trous inesthétiques',
  },
  'Hespérophanes': {
    latin: 'Trichoferus holosericeus',
    bois: 'Feuillus : chêne, peuplier, arbres fruitiers',
    indices: "Trous d'envol ovales de 3 à 7 mm, vermoulure fine et tassée — l'équivalent du capricorne pour les feuillus",
    cycle: 'Larve 2 à 5 ans',
    risque: 'Peut affaiblir fortement les éléments porteurs en feuillus',
  },
};

// Champs additionnels du diagnostic stockés SANS nouvelle colonne Supabase :
// repliés dans la colonne texte "diagnostic" via des marqueurs invisibles
// [METHODE:b64] [ZONES:b64] [TRAIT:b64] [SUIVI:b64] (convention du projet).
const _DIAG_MARKERS = {
  methode: 'METHODE', zones: 'ZONES', traitement: 'TRAIT', suivi: 'SUIVI', signes: 'SIGNES',
  postes: 'POSTES', prevention: 'PREV', materiel: 'MATERIEL', rodenticides: 'RODENT', actions: 'ACTIONS',
  bureau: 'BUREAU', doctype: 'DOCTYPE', noPlan: 'NOPLAN', noPhotos: 'NOPHOTOS', noTech: 'NOTECH',
  rodenticideAutre: 'RODAUTRE', postesNb: 'POSTNB', suiviRem: 'SUIVREM',
  contrat: 'CONTRAT', contratPassages: 'CONTRATP', contratMontant: 'CONTRATM', contratZones: 'CONTRATZ', contratRem: 'CONTRATR',
  dateInt1: 'DI1', dateInt2: 'DI2', dateInt3: 'DI3', dateProchain: 'DIP',
  statut: 'STATUT', noSign: 'NOSIGN', ruban: 'RUBAN', noHum: 'NOHUM', hygiene: 'HYGIENE', fiche: 'FICHE',
  // Rapport punaises de lit : consignes de préparation du locataire
  preparation: 'PREPA', preparationRem: 'PREPAREM',
};
const _DIAG_JSON_KEYS = new Set(['signes', 'postes', 'materiel', 'rodenticides', 'actions', 'preparation']);   // tableaux/objets → JSON dans le marqueur
const _DIAG_MARKER_RE = /\s*\[(?:METHODE|ZONES|TRAIT|SUIVREM|SUIVI|SIGNES|POSTES|POSTNB|PREV|MATERIEL|RODENT|RODAUTRE|ACTIONS|BUREAU|DOCTYPE|NOPLAN|NOPHOTOS|NOTECH|CONTRATP|CONTRATM|CONTRATZ|CONTRATR|CONTRAT|DI1|DI2|DI3|DIP|STATUT|NOSIGN|RUBAN|NOHUM|HYGIENE|FICHE|PREPAREM|PREPA):[^\]]*\]/g;
function _diagPack(d) {
  let txt = String(d.diagnostic || '').replace(_DIAG_MARKER_RE, '').trim();
  for (const k of Object.keys(_DIAG_MARKERS)) {
    let v = d[k];
    if (v && _DIAG_JSON_KEYS.has(k)) v = (Array.isArray(v) && !v.length) ? '' : JSON.stringify(v);
    if (v && String(v).trim()) txt += '\n[' + _DIAG_MARKERS[k] + ':' + _encNote(v) + ']';
    delete d[k];
  }
  d.diagnostic = txt;
  return d;
}
function _diagUnpack(d) {
  const out = JSON.parse(JSON.stringify(d));
  const src = String(out.diagnostic || '');
  for (const k of Object.keys(_DIAG_MARKERS)) {
    const m = src.match(new RegExp('\\[' + _DIAG_MARKERS[k] + ':([^\\]]*)\\]'));
    let v = m ? _decNote(m[1]) : (out[k] || '');
    if (_DIAG_JSON_KEYS.has(k)) { try { v = v ? JSON.parse(v) : []; } catch (e) { v = []; } if (!Array.isArray(v)) v = []; }
    out[k] = v;
  }
  out.diagnostic = src.replace(_DIAG_MARKER_RE, '').trim();
  if (!Array.isArray(out.insectes)) out.insectes = [];
  return out;
}
// Zones d'activité proposées dans la liste déroulante (rapports bois & rongeurs)
const ZONES_ACTIVITE = ['Cave', 'Couloirs de cave', 'Cuisine', 'Salle de bain', 'Chambre', 'Salon', 'Combles', 'Grenier', 'Local technique', 'Buanderie', 'Parking', 'Garage', 'Façade', 'Terrasse', 'Jardin', 'Toiture', 'Caisson de store', 'Gaines techniques', 'Parties communes', 'Appartement complet', 'Immeuble complet'];
// Ajoute une zone choisie dans la liste au champ texte (cumulable, champ libre conservé)
function diagAddZone(z) {
  if (!_editingDiag || !z) return;
  if (z === '__autre__') { const inp = $('diag-zones-input'); if (inp) inp.focus(); return; }
  const cur = String(_editingDiag.zones || '').trim();
  if (cur.split(',').map(s => s.trim().toLowerCase()).includes(z.toLowerCase())) return;
  _editingDiag.zones = cur ? cur + ', ' + z : z;
  const inp = $('diag-zones-input'); if (inp) inp.value = _editingDiag.zones;
  refreshDiagPreview();
}
// Champ déroulant + champ libre des zones (HTML commun aux deux éditeurs)
function _diagZonesField(d, label) {
  return `<div class="form-group"><label class="form-label">${label}</label>
    <select class="form-input" onchange="diagAddZone(this.value); this.selectedIndex=0;">
      <option value="">— Ajouter une zone —</option>
      ${ZONES_ACTIVITE.map(z => `<option>${z}</option>`).join('')}
      <option value="__autre__">Autre zone (champ libre)…</option>
    </select>
    <input class="form-input" id="diag-zones-input" style="margin-top:5px;font-size:12px;" value="${(d.zones||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.zones=this.value" placeholder="Les zones choisies s'ajoutent ici — texte libre possible">
  </div>`;
}
// Sélecteurs type de document (Rapport/Expertise) et bureau émetteur (HTML commun)
function _diagTypeBureauFields(d) {
  return `
    <div class="form-group"><label class="form-label">Type de document</label>
      <select class="form-input" oninput="_editingDiag.doctype=this.value">
        <option ${d.doctype!=='Expertise'?'selected':''}>Rapport</option>
        <option ${d.doctype==='Expertise'?'selected':''}>Expertise</option>
      </select>
    </div>
    <div class="form-group"><label class="form-label">Bureau émetteur (adresse sur le PDF)</label>
      <select class="form-input" oninput="_editingDiag.bureau=this.value">
        ${BUREAUX.map(b => `<option value="${b.id}" ${(d.bureau||'ne')===b.id?'selected':''}>${b.label} — ${b.rue}, ${b.npa} ${b.ville}</option>`).join('')}
      </select>
    </div>`;
}
// Champ technicien avec case « afficher sur le PDF » (décochable)
function _diagTechField(d) {
  return `<div class="form-group">
    <div style="display:flex;justify-content:space-between;align-items:center;"><label class="form-label">Technicien</label>
      <label style="display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:var(--g600);cursor:pointer;" title="Décocher pour ne pas afficher le technicien sur le PDF">
        <input type="checkbox" ${d.noTech?'':'checked'} onchange="_editingDiag.noTech=this.checked?'':'1'; refreshDiagPreview();" style="accent-color:var(--navy);"> sur le PDF
      </label>
    </div>
    <input class="form-input" value="${(d.tech||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.tech=this.value">
  </div>`;
}
// Dates d'intervention (1ʳᵉ/2ᵉ/3ᵉ + prochain passage) — zone visible en haut du PDF
function _diagDatesFields(d) {
  const f = (k, lbl) => `<div class="form-group"><label class="form-label">${lbl}</label><input class="form-input" type="date" value="${d[k]||''}" oninput="_editingDiag.${k}=this.value"></div>`;
  return `<div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">📅 Dates d'intervention (affichées en haut du PDF)</div>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;margin-bottom:14px;">
    ${f('dateInt1','1ʳᵉ intervention')}${f('dateInt2','2ᵉ intervention')}${f('dateInt3','3ᵉ intervention')}${f('dateProchain','Prochain passage prévu')}
  </div>`;
}
// Proposition de contrat annuel (case + champs détaillés)
function _diagContratFields(d) {
  return `<div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">
    <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
      <input type="checkbox" ${d.contrat?'checked':''} onchange="_editingDiag.contrat=this.checked?'1':''; renderDiagEditor();" style="accent-color:var(--navy);"> 📄 Proposition de contrat annuel
    </label>
  </div>
  ${d.contrat ? `
  <div style="border:1px solid #e5e7eb;border-radius:8px;padding:10px;margin-bottom:14px;background:#fafbfc;">
    <div style="font-size:11px;color:var(--g600);margin-bottom:8px;font-style:italic;">« Au vu de la situation constatée, une proposition de contrat annuel peut être envisagée afin d'assurer un suivi régulier, de limiter les risques de récidive et de maintenir une surveillance préventive des zones sensibles. » (texte ajouté automatiquement au PDF)</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="form-group"><label class="form-label">Nombre de passages annuels proposés</label><input class="form-input" value="${(d.contratPassages||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.contratPassages=this.value" placeholder="Ex. 4 passages par an"></div>
      <div class="form-group"><label class="form-label">Montant estimatif</label><input class="form-input" value="${(d.contratMontant||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.contratMontant=this.value" placeholder="Ex. CHF 1'200.– / an"></div>
      <div class="form-group"><label class="form-label">Zones concernées</label><input class="form-input" value="${(d.contratZones||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.contratZones=this.value" placeholder="Ex. caves, local poubelles, extérieurs"></div>
      <div class="form-group"><label class="form-label">Remarques particulières</label><input class="form-input" value="${(d.contratRem||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.contratRem=this.value"></div>
    </div>
  </div>` : '<div style="margin-bottom:10px;"></div>'}`;
}
// Agrandit la zone de texte pendant la frappe (revient à la taille normale en sortant)
function diagTaAutoGrow(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight + 4, 420) + 'px';
}
function diagTaShrink(el) { if (el) el.style.height = ''; }
// Case à cocher d'affichage d'une section dans le PDF (plan / photos)
function _diagSectionToggle(field, label) {
  const off = !!(_editingDiag && _editingDiag[field]);
  return `<label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:${off?'var(--g400)':'var(--navy)'};cursor:pointer;margin-left:10px;">
    <input type="checkbox" ${off?'':'checked'} onchange="_editingDiag.${field}=this.checked?'':'1'; renderDiagEditor();" style="accent-color:var(--navy);"> ${label}
  </label>`;
}
let _editingDiag = null;

// Type d'un document de la table diagnostics : 'bois' (DG-) ou 'rongeurs' (RG-)
function _diagType(d) { const n = (d && d.numero) || ''; if (n.startsWith('RG-')) return 'rongeurs'; if (n.startsWith('BL-')) return 'blattes'; if (n.startsWith('FM-')) return 'fourmis'; if (n.startsWith('PL-')) return 'punaises'; return 'bois'; }
function _nextDiagNumero(prefix) {
  prefix = prefix || 'DG';
  const year = new Date().getFullYear();
  const list = (DB.diagnostics || []).filter(d => (d.numero||'').startsWith(prefix + '-' + year + '-'));
  let max = 0;
  list.forEach(d => { const m = (d.numero||'').match(/-(\d+)$/); if (m) max = Math.max(max, parseInt(m[1],10)); });
  // Numéro de départ minimal par type : rongeurs (RG), blattes (BL), fourmis (FM)
  // et punaises de lit (PL) commencent à 210.
  const START = { RG: 210, BL: 210, FM: 210, PL: 210 };
  const next = Math.max(max + 1, START[prefix] || 1);
  return `${prefix}-${year}-${String(next).padStart(3,'0')}`;
}

function openNewDiagnostic() {
  _editingDiag = {
    id: newId(), numero: _nextDiagNumero(), dateDoc: today(), tech: '',
    clientId: '', clientNom: '', locataireNom: '', locataireAdresse: '',
    batiment: '', bonId: '', insectes: [], elementsTouches: '',
    activite: '', etendue: '', humidite: '', noHum: '', gravite: '', diagnostic: '', conclusion: '',
    methode: '', zones: '', traitement: '', suivi: '', photos: [],
    bureau: 'ne', doctype: 'Rapport', noPlan: '', noPhotos: '', noTech: '', statut: '', noSign: '1',
    suiviRem: '', contrat: '', contratPassages: '', contratMontant: '', contratZones: '', contratRem: '',
    dateInt1: '', dateInt2: '', dateInt3: '', dateProchain: ''
  };
  renderDiagEditor(); openModal('modal-diag');
}
function editDiag(id) {
  const d = (DB.diagnostics || []).find(x => x.id === id); if (!d) return;
  _editingDiag = _diagUnpack(d);
  _editingDiag.photos = [];
  renderDiagEditor(); openModal('modal-diag');
}
function toggleDiagInsecte(nom, checked) {
  if (!_editingDiag) return;
  const set = new Set(_editingDiag.insectes || []);
  if (checked) set.add(nom); else set.delete(nom);
  _editingDiag.insectes = [...set];
}
function renderDiagEditor() {
  const d = _editingDiag; if (!d) return;
  if (_diagType(d) === 'rongeurs') return renderRongeursEditor();
  if (_diagType(d) === 'blattes') return renderBlattesEditor();
  if (_diagType(d) === 'fourmis') return renderFourmisEditor();
  if (_diagType(d) === 'punaises') return renderPunaisesEditor();
  const box = $('modal-diag-body'); if (!box) return;
  const clientOpts = (DB.clients||[]).slice().sort((a,b)=>(a.nom||'').localeCompare(b.nom||'')).map(c=>`<option value="${c.id}" ${d.clientId===c.id?'selected':''}>${_clientOptionLabel(c).replace(/</g,'&lt;')}</option>`).join('');
  const insectesHtml = INSECTES_BOIS.map(n => `
    <label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;margin:3px 10px 3px 0;cursor:pointer;">
      <input type="checkbox" ${(d.insectes||[]).includes(n)?'checked':''} onchange="toggleDiagInsecte('${n.replace(/'/g,"\\'")}',this.checked)" style="accent-color:var(--navy);"> ${n}
    </label>`).join('');
  box.innerHTML = `
    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🪵 Identification</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
      <div class="form-group"><label class="form-label">N° de bon (remplissage auto)</label><input class="form-input" placeholder="Tape le n° puis Tab" onchange="autoFillDiagFromBon(this.value)" onblur="autoFillDiagFromBon(this.value)"></div>
      <div class="form-group"><label class="form-label">Date</label><input class="form-input" type="date" value="${d.dateDoc||''}" oninput="_editingDiag.dateDoc=this.value"></div>
      ${_diagTypeBureauFields(d)}
      <div class="form-group"><label class="form-label">Client (gérance)</label>
        <select class="form-input" onchange="onDiagClientSelect(this.value)"><option value="">-- Choisir --</option>${clientOpts}</select>
        <input class="form-input" style="margin-top:5px;font-size:12px;" placeholder="ou nom manuel" value="${(d.clientNom||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.clientNom=this.value;_editingDiag.clientId='';">
      </div>
      ${_diagTechField(d)}
      <div class="form-group"><label class="form-label">Locataire</label><input class="form-input" value="${(d.locataireNom||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.locataireNom=this.value"></div>
      <div class="form-group"><label class="form-label">Bâtiment / charpente concernée</label><input class="form-input" value="${(d.batiment||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.batiment=this.value" placeholder="Ex. charpente combles, villa"></div>
      <div class="form-group" style="grid-column:1/-1;"><label class="form-label">Adresse</label><input class="form-input" value="${(d.locataireAdresse||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.locataireAdresse=this.value"></div>
    </div>

    ${_diagDatesFields(d)}

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🐛 Insectes détectés & éléments touchés</div>
    <div style="margin-bottom:8px;">${insectesHtml}</div>
    <div class="form-group" style="margin-bottom:14px;"><label class="form-label">Éléments / bois touchés</label><textarea class="form-input" rows="2" oninput="_editingDiag.elementsTouches=this.value" placeholder="Ex. poutres, solives, chevrons, lambris...">${d.elementsTouches||''}</textarea></div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:6px;display:flex;align-items:center;flex-wrap:wrap;">✏️ Schéma de la charpente ${_diagSectionToggle('noPlan','Afficher dans le PDF')}</div>
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:8px;margin-bottom:14px;${d.noPlan?'display:none;':''}">
      <canvas id="diag-schema-canvas" width="2048" height="1216" style="width:100%;height:auto;border:1px dashed #ccc;border-radius:6px;cursor:crosshair;touch-action:none;background:#fff;"></canvas>
      <input type="file" id="diag-schema-file" accept="image/*" style="display:none" onchange="loadSchemaImage(event)">
      <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;align-items:center;">
        <span style="font-size:11px;font-weight:700;color:var(--g600);">Couleur :</span>
        ${DIAG_COLORS.map(c => `
          <button type="button" title="${c.label}" onclick="setDiagColor('${c.hex}')"
            style="width:24px;height:24px;border-radius:50%;cursor:pointer;background:${c.hex};border:${_diagColor===c.hex?'3px solid var(--navy)':'2px solid #e5e7eb'};"></button>`).join('')}
        <span style="font-size:10px;color:var(--g400);">(${(DIAG_COLORS.find(c=>c.hex===_diagColor)||{}).label||''})</span>
        <span style="width:1px;height:20px;background:#e5e7eb;"></span>
        <button class="btn ${_diagTool==='draw'?'btn-navy':'btn-ghost'} btn-sm" type="button" onclick="setDiagTool('draw')">✏️ Dessin</button>
        <button class="btn ${_diagTool==='text'?'btn-navy':'btn-ghost'} btn-sm" type="button" onclick="setDiagTool('text')">🔤 Texte</button>
        <button class="btn ${_diagTool==='element'?'btn-navy':'btn-ghost'} btn-sm" type="button" onclick="setDiagTool('element')" title="Clique sur une poutre du schéma 3D : elle prend la couleur choisie et tu peux y attacher une annotation">🎯 Élément</button>
      </div>
      <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">
        <button class="btn btn-navy btn-sm" type="button" onclick="openSchemaZoom()" title="Agrandir le schéma pour tracer confortablement (ou double-clic sur le schéma)">🔍 Plein écran</button>
        <button class="btn btn-navy btn-sm" type="button" onclick="document.getElementById('diag-schema-file').click()">📷 Importer une image / photo</button>
        <button class="btn btn-ghost btn-sm" type="button" onclick="clearDiagSchema()">↺ Effacer les annotations</button>
        <select class="form-input" style="width:auto;display:inline-block;font-size:12px;padding:5px 8px;" onchange="setDiagSchemaModele(this.value)" title="Choisir le modèle de schéma 3D (remplace le fond et efface les annotations)">
          ${[['2pans','🪵 Charpente 2 pans'],['4pans','🏠 Toit 4 pans (croupe)'],['demicroupe','🇨🇭 Demi-croupe (bernois)'],['mansarde','🏛 Toit mansardé'],['chalet','⛰ Chalet à pannes'],['appentis','📐 Appentis 1 pan'],['combles','🛏 Combles aménagés'],['plancher','🟫 Plancher / solivage'],['parquet','🪵 Parquet (lames)']].map(o => `<option value="${o[0]}" ${_diagSchemaModele===o[0]?'selected':''}>${o[1]}</option>`).join('')}
        </select>
        <button class="btn btn-ghost btn-sm" type="button" onclick="resetToDefaultSchema()" title="Redessiner le modèle choisi">↻ Redessiner</button>
        <span style="font-size:11px;color:var(--g400);align-self:center;">Dessine pour entourer les zones touchées ; en mode Texte, clique pour placer une note. La légende des couleurs est ajoutée automatiquement au PDF.</span>
      </div>
      <div style="margin-top:10px;border-top:1px dashed #e5e7eb;padding-top:8px;">
        <div style="font-size:11px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:6px;">📚 Bibliothèque des éléments bois <span style="font-weight:600;color:var(--g400);text-transform:none;">— clique sur un nom pour illuminer la pièce sur le schéma</span></div>
        <div style="display:flex;flex-wrap:wrap;gap:5px;">
          ${BOIS_ELEMENTS.map(n => `<button type="button" class="btn btn-ghost btn-sm" style="font-size:11px;padding:4px 9px;border:1px solid #e5e7eb;" onclick="highlightWoodElement('${n.replace(/'/g,"\\'")}')">${n}</button>`).join('')}
        </div>
      </div>
    </div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:6px;display:flex;align-items:center;flex-wrap:wrap;">📷 Photo inspection ${_diagSectionToggle('noPhotos','Afficher dans le PDF')}</div>
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:8px;margin-bottom:14px;${d.noPhotos?'display:none;':''}">
      <input type="file" id="diag-photos-file" accept="image/*" multiple style="display:none" onchange="addDiagPhotos(event)">
      <input type="file" id="diag-photo-replace-file" accept="image/*" style="display:none" onchange="onDiagPhotoReplace(event)">
      <button class="btn btn-navy btn-sm" type="button" onclick="document.getElementById('diag-photos-file').click()">📷 Ajouter des photos</button>
      <span style="font-size:11px;color:var(--g400);margin-left:6px;">Incluses dans le PDF avec date et auteur (non stockées en base — télécharge le PDF pour les garder).</span>
      <div id="diag-photos-box" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;"></div>
    </div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🔬 Diagnostic</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:8px;">
      <div class="form-group"><label class="form-label">Activité de l'infestation</label>
        <select class="form-input" oninput="_editingDiag.activite=this.value">
          <option value="" ${!d.activite?'selected':''}>-- Choisir --</option>
          <option ${d.activite==='Active'?'selected':''}>Active</option>
          <option ${d.activite==='Ancienne'?'selected':''}>Ancienne</option>
          <option ${d.activite==='Mixte (active + ancienne)'?'selected':''}>Mixte (active + ancienne)</option>
        </select>
      </div>
      <div class="form-group"><label class="form-label">Gravité</label>
        <select class="form-input" oninput="_editingDiag.gravite=this.value">
          <option value="" ${!d.gravite?'selected':''}>-- Choisir --</option>
          <option ${d.gravite==='Faible'?'selected':''}>Faible</option>
          <option ${d.gravite==='Modérée'?'selected':''}>Modérée</option>
          <option ${d.gravite==='Importante'?'selected':''}>Importante</option>
          <option ${d.gravite==='Critique (structure menacée)'?'selected':''}>Critique (structure menacée)</option>
        </select>
      </div>
      <div class="form-group"><label class="form-label">Étendue / surface concernée</label><input class="form-input" value="${(d.etendue||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.etendue=this.value" placeholder="Ex. ~20 m² de charpente"></div>
      <div class="form-group"><label class="form-label" style="display:flex;align-items:center;flex-wrap:wrap;">Taux d'humidité du bois ${_diagSectionToggle('noHum','Afficher dans le PDF')}</label><input class="form-input" value="${(d.humidite||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.humidite=this.value" placeholder="Ex. 14%" ${d.noHum?'style="display:none;"':''}></div>
      <div class="form-group"><label class="form-label">Méthode d'inspection</label>
        <select class="form-input" oninput="_editingDiag.methode=this.value">
          <option value="" ${!d.methode?'selected':''}>-- Choisir --</option>
          <option ${d.methode==='Inspection visuelle'?'selected':''}>Inspection visuelle</option>
          <option ${d.methode==='Visuelle + sondage mécanique'?'selected':''}>Visuelle + sondage mécanique</option>
          <option ${d.methode==='Visuelle + sondage + humidimètre'?'selected':''}>Visuelle + sondage + humidimètre</option>
          <option ${d.methode==='Visuelle + détection acoustique (appareil)'?'selected':''}>Visuelle + détection acoustique (appareil)</option>
          <option ${d.methode==='Visuelle + sondage + détection acoustique'?'selected':''}>Visuelle + sondage + détection acoustique</option>
          <option ${d.methode==='Inspection complète (visuelle, sondage, humidimètre, endoscope)'?'selected':''}>Inspection complète (visuelle, sondage, humidimètre, endoscope)</option>
          <option ${d.methode==='Inspection complète (visuelle, sondage, humidimètre, endoscope, acoustique)'?'selected':''}>Inspection complète (visuelle, sondage, humidimètre, endoscope, acoustique)</option>
        </select>
      </div>
      ${_diagZonesField(d, 'Zones inspectées / zone d\'activité')}
    </div>
    <div class="form-group" style="margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;"><label class="form-label">Observations / diagnostic détaillé</label><button type="button" class="btn btn-ghost btn-sm" id="diag-ai-diagnostic" onclick="diagAICorrect('diagnostic')" style="font-size:11px;padding:2px 8px;">✨ Corriger IA</button></div>
      <textarea class="form-input" id="diag-ta-diagnostic" rows="3" oninput="_editingDiag.diagnostic=this.value;diagTaAutoGrow(this)" onfocus="diagTaAutoGrow(this)" onblur="diagTaShrink(this)">${d.diagnostic||''}</textarea>
    </div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">💊 Traitement & suivi</div>
    <div class="form-group" style="margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;align-items:center;"><label class="form-label">Traitement recommandé</label><button type="button" class="btn btn-ghost btn-sm" id="diag-ai-traitement" onclick="diagAICorrect('traitement')" style="font-size:11px;padding:2px 8px;">✨ Corriger IA</button></div>
      <textarea class="form-input" id="diag-ta-traitement" rows="3" oninput="_editingDiag.traitement=this.value;diagTaAutoGrow(this)" onfocus="diagTaAutoGrow(this)" onblur="diagTaShrink(this)" placeholder="Ex. bûchage des parties vermoulues, traitement par injection + pulvérisation (produit certifié)...">${d.traitement||''}</textarea>
    </div>
    <div class="form-group" style="margin-bottom:14px;"><label class="form-label">Suivi / garantie</label><input class="form-input" value="${(d.suivi||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.suivi=this.value" placeholder="Ex. contrôle après 12 mois, garantie 10 ans"></div>

    ${_diagContratFields(d)}

    <div class="form-group">
      <div style="display:flex;justify-content:space-between;align-items:center;"><label class="form-label">Conclusion / recommandations</label><button type="button" class="btn btn-ghost btn-sm" id="diag-ai-conclusion" onclick="diagAICorrect('conclusion')" style="font-size:11px;padding:2px 8px;">✨ Corriger IA</button></div>
      <textarea class="form-input" id="diag-ta-conclusion" rows="2" oninput="_editingDiag.conclusion=this.value;diagTaAutoGrow(this)" onfocus="diagTaAutoGrow(this)" onblur="diagTaShrink(this)">${d.conclusion||''}</textarea>
    </div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin:14px 0 6px;display:flex;align-items:center;flex-wrap:wrap;">✍️ Signature numérique ${_diagSectionToggle('noSign','Afficher dans le PDF')}</div>
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:8px;${d.noSign?'display:none;':''}">
      <canvas id="diag-sign-canvas" width="400" height="140" style="width:min(400px,100%);height:auto;border:1px dashed #ccc;border-radius:6px;cursor:crosshair;touch-action:none;background:#fff;"></canvas>
      <div style="display:flex;gap:6px;margin-top:6px;align-items:center;flex-wrap:wrap;">
        <button class="btn btn-ghost btn-sm" type="button" onclick="clearDiagSignature()">↺ Effacer</button>
        <span style="font-size:11px;color:var(--g400);">Signe à la souris ou au doigt — la signature est insérée dans le PDF (non stockée en base).</span>
      </div>
    </div>
  `;
  const t = $('modal-diag-title'); if (t) t.textContent = 'Diagnostic bois ' + (d.numero||'');
  initDiagSchema();
  initDiagSignPad();
  renderDiagPhotos();
  box.oninput = () => refreshDiagPreview();
  _syncDiagPreviewPane();
  refreshDiagPreview();
}

// --- Pavé de signature numérique (en mémoire uniquement, insérée dans le PDF) ---
function initDiagSignPad() {
  const c = $('diag-sign-canvas'); if (!c) return;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  if (_editingDiag && _editingDiag.signature) {
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, c.width, c.height);
    img.src = _editingDiag.signature;
  }
  let drawing = false;
  const pos = e => { const r = c.getBoundingClientRect(); const tt = e.touches ? e.touches[0] : e; return { x: (tt.clientX - r.left) * (c.width / r.width), y: (tt.clientY - r.top) * (c.height / r.height) }; };
  const start = e => { drawing = true; const p = pos(e); ctx.strokeStyle = '#1a2744'; ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault(); };
  const move = e => { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); e.preventDefault(); };
  const end = () => { if (!drawing) return; drawing = false; if (_editingDiag) { _editingDiag.signature = c.toDataURL('image/png'); refreshDiagPreview(); } };
  c.onmousedown = start; c.onmousemove = move; c.onmouseup = end; c.onmouseleave = end;
  c.ontouchstart = start; c.ontouchmove = move; c.ontouchend = end;
}
function clearDiagSignature() {
  const c = $('diag-sign-canvas'); if (!c) return;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  if (_editingDiag) { delete _editingDiag.signature; refreshDiagPreview(); }
}

// --- Photos de l'inspection (en mémoire uniquement, incluses dans le PDF) ---
function addDiagPhotos(ev) {
  const files = [...(ev.target.files || [])]; if (!files.length) return;
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        // Réduction à 1000 px max pour limiter le poids du PDF
        const MAX = 1000;
        const r = Math.min(1, MAX / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * r); cv.height = Math.round(img.height * r);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        if (!_editingDiag) return;
        if (!Array.isArray(_editingDiag.photos)) _editingDiag.photos = [];
        _editingDiag.photos.push({
          data: cv.toDataURL('image/jpeg', 0.82), w: cv.width, h: cv.height, caption: '', use: true,
          addedAt: today(), by: (_editingDiag.tech || '').trim()
        });
        renderDiagPhotos();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
  ev.target.value = '';
}
function removeDiagPhoto(i) {
  if (!_editingDiag || !Array.isArray(_editingDiag.photos)) return;
  _editingDiag.photos.splice(i, 1);
  renderDiagPhotos();
}
function setDiagPhotoCaption(i, v) {
  const p = _editingDiag && _editingDiag.photos && _editingDiag.photos[i];
  if (!p) return;
  p.caption = v;
  if (today() !== p.addedAt) p.modifiedAt = today();   // traçabilité de la modification
}
// Remplacement d'une photo (l'historique date/auteur est conservé et complété)
let _diagReplaceIdx = -1;
function replaceDiagPhoto(i) {
  _diagReplaceIdx = i;
  const inp = $('diag-photo-replace-file'); if (inp) inp.click();
}
function onDiagPhotoReplace(ev) {
  const file = ev.target.files && ev.target.files[0]; if (!file) return;
  const i = _diagReplaceIdx; _diagReplaceIdx = -1;
  const p = _editingDiag && _editingDiag.photos && _editingDiag.photos[i];
  if (!p) { ev.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1000;
      const r = Math.min(1, MAX / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * r); cv.height = Math.round(img.height * r);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      p.data = cv.toDataURL('image/jpeg', 0.82); p.w = cv.width; p.h = cv.height;
      p.modifiedAt = today(); p.by = (_editingDiag.tech || p.by || '').trim();
      renderDiagPhotos();
      toast('✓ Photo remplacée', '#2d9e6b');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  ev.target.value = '';
}
// --- Annotation d'une photo : grande vue où l'on peut tracer dessus ---
// (mêmes outils que le plan : couleurs, dessin avec reconnaissance de forme, texte)
let _photoAnnIdx = -1, _photoAnnColor = '#e63946', _photoAnnTool = 'draw';
let _photoAnnDrawing = false, _photoAnnPts = [], _photoAnnSnap = null;
function openPhotoAnnotator(i) {
  const p = _editingDiag && _editingDiag.photos && _editingDiag.photos[i]; if (!p) return;
  _photoAnnIdx = i;
  if (!p.orig) p.orig = p.data;   // original conservé pour « Effacer les annotations »
  let ov = $('photo-ann-overlay');
  if (!ov) { ov = document.createElement('div'); ov.id = 'photo-ann-overlay'; document.body.appendChild(ov); }
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(13,27,62,.78);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;';
  ov.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:14px;max-width:980px;width:100%;max-height:96vh;overflow:auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div style="font-weight:800;color:var(--navy);font-size:14px;">✏️ Annoter la photo ${i+1} — trace directement sur l'image</div>
        <button class="btn btn-ghost btn-sm" type="button" onclick="closePhotoAnnotator(false)">✕</button>
      </div>
      <canvas id="photo-ann-canvas" style="width:100%;height:auto;border:1px solid #e5e7eb;border-radius:8px;cursor:crosshair;touch-action:none;background:#f4f5f8;"></canvas>
      <div id="photo-ann-tools" style="margin-top:8px;"></div>
      <div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end;">
        <button class="btn btn-ghost btn-sm" type="button" onclick="photoAnnReset()">↺ Effacer les annotations</button>
        <button class="btn btn-ghost" type="button" onclick="closePhotoAnnotator(false)">Annuler</button>
        <button class="btn btn-navy" type="button" onclick="closePhotoAnnotator(true)">✓ Valider les annotations</button>
      </div>
    </div>`;
  _photoAnnToolbar();
  const c = $('photo-ann-canvas');
  c.width = p.w || 1000; c.height = p.h || 700;
  const ctx = c.getContext('2d');
  const img = new Image();
  img.onload = () => ctx.drawImage(img, 0, 0, c.width, c.height);
  img.src = p.data;
  const lw = Math.max(3, c.width / 210);
  const pos = e => { const r = c.getBoundingClientRect(); const tt = e.touches ? e.touches[0] : e; return { x: (tt.clientX - r.left) * (c.width / r.width), y: (tt.clientY - r.top) * (c.height / r.height) }; };
  const start = e => {
    const pt = pos(e);
    if (_photoAnnTool === 'text') {
      e.preventDefault();
      const txt = prompt('Texte à placer sur la photo :');
      if (txt && txt.trim()) {
        ctx.font = 'bold ' + Math.round(c.width/34) + 'px Arial'; ctx.fillStyle = _photoAnnColor;
        ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(3, c.width/280); ctx.lineJoin = 'round';
        ctx.strokeText(txt.trim(), pt.x, pt.y); ctx.fillText(txt.trim(), pt.x, pt.y);
      }
      return;
    }
    _photoAnnDrawing = true; _photoAnnPts = [pt];
    try { _photoAnnSnap = ctx.getImageData(0, 0, c.width, c.height); } catch (err) { _photoAnnSnap = null; }
    ctx.strokeStyle = _photoAnnColor; ctx.lineWidth = lw; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(pt.x, pt.y); e.preventDefault();
  };
  const move = e => { if (!_photoAnnDrawing) return; const pt = pos(e); _photoAnnPts.push(pt); ctx.lineTo(pt.x, pt.y); ctx.stroke(); e.preventDefault(); };
  const end = () => {
    if (!_photoAnnDrawing) return;
    _photoAnnDrawing = false;
    const shape = _diagRecognizeShape(_photoAnnPts);
    if (shape && _photoAnnSnap) {
      ctx.putImageData(_photoAnnSnap, 0, 0);
      ctx.strokeStyle = _photoAnnColor; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      if (shape.type === 'ellipse') ctx.ellipse(shape.cx, shape.cy, shape.a, shape.b, 0, 0, Math.PI*2);
      else if (shape.type === 'rect') ctx.rect(shape.x, shape.y, shape.w, shape.h);
      else { ctx.moveTo(shape.x1, shape.y1); ctx.lineTo(shape.x2, shape.y2); }
      ctx.stroke();
    }
    _photoAnnPts = []; _photoAnnSnap = null;
  };
  c.onmousedown = start; c.onmousemove = move; c.onmouseup = end; c.onmouseleave = end;
  c.ontouchstart = start; c.ontouchmove = move; c.ontouchend = end;
}
function _photoAnnToolbar() {
  const box = $('photo-ann-tools'); if (!box) return;
  const colors = (_editingDiag && _diagType(_editingDiag) === 'rongeurs') ? RONGEUR_COLORS : DIAG_COLORS;
  box.innerHTML = `
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
      <span style="font-size:11px;font-weight:700;color:var(--g600);">Couleur :</span>
      ${colors.map(c => `
        <button type="button" title="${c.label}" onclick="photoAnnSetColor('${c.hex}')"
          style="width:24px;height:24px;border-radius:50%;cursor:pointer;background:${c.hex};border:${_photoAnnColor===c.hex?'3px solid var(--navy)':'2px solid #e5e7eb'};"></button>`).join('')}
      <span style="font-size:10px;color:var(--g400);">(${(colors.find(c=>c.hex===_photoAnnColor)||{}).label||''})</span>
      <span style="width:1px;height:20px;background:#e5e7eb;"></span>
      <button class="btn ${_photoAnnTool==='draw'?'btn-navy':'btn-ghost'} btn-sm" type="button" onclick="photoAnnSetTool('draw')">✏️ Dessin</button>
      <button class="btn ${_photoAnnTool==='text'?'btn-navy':'btn-ghost'} btn-sm" type="button" onclick="photoAnnSetTool('text')">🔤 Texte</button>
      <span style="font-size:11px;color:var(--g400);">Cercles, rectangles et traits sont automatiquement redressés.</span>
    </div>`;
}
function photoAnnSetColor(hex) { _photoAnnColor = hex; _photoAnnToolbar(); }
function photoAnnSetTool(t) { _photoAnnTool = t; _photoAnnToolbar(); }
function photoAnnReset() {
  const p = _editingDiag && _editingDiag.photos && _editingDiag.photos[_photoAnnIdx];
  const c = $('photo-ann-canvas'); if (!p || !c) return;
  const ctx = c.getContext('2d');
  const img = new Image();
  img.onload = () => { ctx.clearRect(0,0,c.width,c.height); ctx.drawImage(img, 0, 0, c.width, c.height); };
  img.src = p.orig || p.data;
}
function closePhotoAnnotator(save) {
  const p = _editingDiag && _editingDiag.photos && _editingDiag.photos[_photoAnnIdx];
  const c = $('photo-ann-canvas');
  if (save && p && c) {
    p.data = c.toDataURL('image/jpeg', 0.85);
    p.modifiedAt = today();
    if ((_editingDiag.tech || '').trim()) p.by = _editingDiag.tech.trim();
    renderDiagPhotos();
    toast('✓ Annotations enregistrées sur la photo', '#2d9e6b');
  }
  const ov = $('photo-ann-overlay'); if (ov) ov.remove();
  _photoAnnIdx = -1;
}

// Ligne de traçabilité d'une photo : « ajoutée le … par … (modifiée le …) »
function _diagPhotoMeta(p) {
  if (!p) return '';
  let m = p.addedAt ? 'ajoutée le ' + fmtDate(p.addedAt) : '';
  if (p.by) m += (m ? ' par ' : 'par ') + p.by;
  if (p.modifiedAt && p.modifiedAt !== p.addedAt) m += (m ? ' · ' : '') + 'modifiée le ' + fmtDate(p.modifiedAt);
  return m;
}
function setDiagPhotoUse(i, checked) {
  if (_editingDiag && _editingDiag.photos && _editingDiag.photos[i]) { _editingDiag.photos[i].use = !!checked; renderDiagPhotos(); }
}
function renderDiagPhotos() {
  const box = $('diag-photos-box'); if (!box) return;
  const photos = (_editingDiag && _editingDiag.photos) || [];
  box.innerHTML = photos.map((p, i) => `
    <div style="width:310px;">
      <div style="position:relative;">
        <img src="${p.data}" onclick="openPhotoAnnotator(${i})" title="Cliquer pour agrandir et tracer sur la photo"
          style="width:310px;height:210px;object-fit:cover;border-radius:6px;border:1px solid #e5e7eb;cursor:crosshair;${p.use===false?'opacity:.35;filter:grayscale(60%);':''}">
        <button type="button" onclick="removeDiagPhoto(${i})" title="Supprimer la photo"
          style="position:absolute;top:4px;right:4px;width:22px;height:22px;border-radius:50%;border:none;background:rgba(230,57,70,.92);color:#fff;font-size:11px;cursor:pointer;line-height:1;">✕</button>
        <button type="button" onclick="replaceDiagPhoto(${i})" title="Remplacer la photo"
          style="position:absolute;top:4px;right:30px;width:22px;height:22px;border-radius:50%;border:none;background:rgba(13,27,62,.85);color:#fff;font-size:10px;cursor:pointer;line-height:1;">🔄</button>
        <button type="button" onclick="openPhotoAnnotator(${i})" title="Agrandir et tracer sur la photo"
          style="position:absolute;bottom:4px;right:4px;height:22px;border-radius:11px;border:none;background:rgba(13,27,62,.85);color:#fff;font-size:10.5px;font-weight:700;cursor:pointer;line-height:1;padding:0 9px;">✏️ Tracer</button>
      </div>
      <label style="display:flex;align-items:center;gap:4px;font-size:10.5px;margin-top:3px;cursor:pointer;color:var(--g600);">
        <input type="checkbox" ${p.use!==false?'checked':''} onchange="setDiagPhotoUse(${i}, this.checked)" style="accent-color:var(--navy);"> Inclure au PDF
      </label>
      <div style="font-size:9.5px;color:var(--g400);margin-top:2px;line-height:1.3;">${_diagPhotoMeta(p)}</div>
      <input class="form-input" style="margin-top:3px;font-size:11px;padding:4px 6px;" placeholder="Légende..."
        value="${(p.caption||'').replace(/"/g,'&quot;')}" oninput="setDiagPhotoCaption(${i}, this.value)">
    </div>`).join('');
  refreshDiagPreview();
}

// --- Schéma de charpente annotable ---
// Couleurs d'annotation (la légende est imprimée automatiquement dans le PDF)
const DIAG_COLORS = [
  { hex: '#e63946', label: 'Infestation active' },
  { hex: '#f4a261', label: 'À surveiller' },
  { hex: '#2a6fdb', label: 'Humidité' },
  { hex: '#2d9e6b', label: 'Sain / traité' },
];
let _diagColor = '#e63946';
let _diagTool = 'draw'; // 'draw' | 'text'
function setDiagColor(hex) { _diagColor = hex; renderDiagEditor(); }
function setDiagTool(tool) { _diagTool = tool; renderDiagEditor(); }
let _diagDrawing = false;
let _diagStrokePts = [];
let _diagSnapshot = null;
// Élément de charpente le plus proche d'un clic (outil 🎯)
function _diagNearestPart(p) {
  let best = null, bestD = 10;
  for (const s of _diagSchemaParts) {
    const dx = s.bx - s.ax, dy = s.by - s.ay;
    const len2 = dx*dx + dy*dy; if (!len2) continue;
    let t = ((p.x - s.ax)*dx + (p.y - s.ay)*dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(p.x - (s.ax + t*dx), p.y - (s.ay + t*dy)) - s.w/2;
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}
// Colorie un élément cliqué et y attache une annotation en puce colorée
function _diagAnnotateElement(ctx, c, part, p) {
  // p et part sont en coordonnées logiques 640×380 → dessin mis à l'échelle
  const k = c.width / 640;
  ctx.save(); ctx.scale(k, k);
  ctx.strokeStyle = _diagColor; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.lineWidth = part.w + 2.6;
  ctx.beginPath(); ctx.moveTo(part.ax, part.ay); ctx.lineTo(part.bx, part.by); ctx.stroke();
  const txt = prompt('Annotation pour cet élément (laisser vide pour seulement le colorier) :');
  if (txt && txt.trim()) {
    const lx = Math.min(Math.max(p.x + 70, 70), 640 - 70);
    const ly = Math.max(p.y - 44, 16);
    ctx.strokeStyle = _diagColor; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(p.x, p.y); ctx.stroke();
    ctx.fillStyle = _diagColor;
    ctx.beginPath(); ctx.arc(p.x, p.y, 2.6, 0, Math.PI*2); ctx.fill();
    ctx.font = 'bold 13px Arial';
    const tw = ctx.measureText(txt.trim()).width, bw = tw + 16, bh = 20;
    const bx = Math.min(Math.max(lx - bw/2, 4), 640 - bw - 4), by = Math.max(ly - bh/2, 2);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 10); else ctx.rect(bx, by, bw, bh);
    ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText(txt.trim(), bx + 8, by + 14.5);
  }
  ctx.restore();
  if (_editingDiag) _editingDiag.schema = c.toDataURL('image/png');
  refreshDiagPreview();
}
// Reconnaissance de forme (comme l'annotation iPhone) : un tracé fermé
// approximativement rond devient une ellipse propre ; un trait presque
// droit devient une ligne droite. Retourne null si tracé libre.
function _diagRecognizeShape(pts) {
  if (!pts || pts.length < 8) return null;
  const xs = pts.map(p=>p.x), ys = pts.map(p=>p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = maxX-minX, h = maxY-minY;
  const first = pts[0], last = pts[pts.length-1];
  const dist = Math.hypot(last.x-first.x, last.y-first.y);
  let pathLen = 0;
  for (let i = 1; i < pts.length; i++) pathLen += Math.hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y);
  // Ligne droite : le chemin parcouru ≈ la distance directe
  if (dist > 40 && pathLen / dist < 1.08) return { type:'line', x1:first.x, y1:first.y, x2:last.x, y2:last.y };
  // Forme fermée, assez grande ? → ellipse ou rectangle
  if (w < 24 || h < 24) return null;
  const diag = Math.hypot(w, h);
  if (dist > diag * 0.3) return null;          // pas refermé
  if (pathLen < diag * 1.5) return null;        // trop court pour un tour complet
  const n = pts.length;
  // Score ellipse : distance normalisée des points à l'ellipse inscrite
  const cx = (minX+maxX)/2, cy = (minY+maxY)/2, a = w/2, b = h/2;
  let sum = 0, sum2 = 0;
  pts.forEach(p => { const r = Math.hypot((p.x-cx)/a, (p.y-cy)/b); sum += r; sum2 += r*r; });
  const mean = sum/n, sd = Math.sqrt(Math.max(0, sum2/n - mean*mean));
  const ellErr = Math.abs(mean-1) + sd;
  // Score rectangle : proximité des points au cadre + présence des 4 coins
  const halfMin = Math.min(w, h) / 2;
  let edgeSum = 0;
  pts.forEach(p => { edgeSum += Math.min(Math.abs(p.x-minX), Math.abs(maxX-p.x), Math.abs(p.y-minY), Math.abs(maxY-p.y)); });
  const edgeNorm = (edgeSum/n) / halfMin;
  const rCorner = diag * 0.11;
  let cornerMiss = 0;
  [[minX,minY],[maxX,minY],[minX,maxY],[maxX,maxY]].forEach(cn => {
    if (!pts.some(p => Math.hypot(p.x-cn[0], p.y-cn[1]) < rCorner)) cornerMiss++;
  });
  const rectErr = edgeNorm + cornerMiss * 0.5;
  if (rectErr < 0.45 && rectErr < ellErr) return { type:'rect', x:minX, y:minY, w, h };
  if (Math.abs(mean-1) < 0.28 && sd < 0.28) return { type:'ellipse', cx, cy, a, b };
  return null;
}
// ============================================================
// MOTEUR DE SCHÉMA CHARPENTE — géométrie 3D + rendu WebGL (three.js)
// avec repli axonométrique 2D si WebGL indisponible.
// ============================================================
let _diagSchemaParts = [];
let _beamTag = 'Bois';
// Modèle de charpente choisi pour le schéma 3D (rapport bois)
let _diagSchemaModele = '2pans';
function setDiagSchemaModele(m) { _diagSchemaModele = m || '2pans'; resetToDefaultSchema(); }

// Dispatcher : dessine le gabarit choisi
function _drawSchemaBase(ctx, W, H) { _drawCharpente(ctx, W, H, _diagSchemaModele); }

// ---------- 1) GÉOMÉTRIE : les gabarits émettent des éléments 3D ----------
function _collectCharpente(modele) {
  const items = [], chips = [];
  const P = (x, y, z) => ({ x: x, y: y, z: z });
  const beam = (a, b, w, pal) => items.push({ t: 'seg', a: a, b: b, w: w, pal: pal, tag: _beamTag });
  const line3 = (a, b, col, w) => items.push({ t: 'line', a: a, b: b, col: col, w: w || 1.2 });
  const face = (pts, c1, c2) => items.push({ t: 'face', pts: pts, c1: c1, c2: c2 || c1 });
  const chip = (txt, target, lx, ly) => chips.push({ txt: txt, target: target, lx: lx, ly: ly });
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
  const X = 210, Z = 250, YR = 92, YF = -26;
  const isPlancher = modele === 'plancher' || modele === 'parquet';
  const ox = 342.4;   // repère horizontal des étiquettes (espace 640×380)

  const PAL_FRONT = ['#cf9a5e', '#a9742f', '#7c5318'];
  const PAL_MID   = ['#b98a4e', '#956427', '#6e4815'];
  const PAL_BACK  = ['#a37843', '#825621', '#5e3d11'];
  const PAL_DARK  = ['#8d6536', '#6e4a1b', '#4e330c'];
  const PAL_CHEV  = ['#dcae77', '#bd8e51', '#9a6c2e'];

  // Plancher de solives (commun)
  const deck = (yf) => {
    _beamTag = 'Poutre porteuse';
    beam(P(0, yf, 0), P(0, yf, Z), 3, PAL_DARK);
    beam(P(X, yf, 0), P(X, yf, Z), 3, PAL_DARK);
    _beamTag = 'Solive';
    for (let z = 15; z <= Z - 15; z += 44) beam(P(0, yf, z), P(X, yf, z), 2.4, PAL_BACK);
    _beamTag = 'Poutre porteuse';
    beam(P(0, yf, 0), P(X, yf, 0), 3.2, PAL_MID);
  };
  const deckLinks = (yf) => {
    _beamTag = 'Montant bois';
    beam(P(0, yf, 0), P(0, 0, 0), 2.4, PAL_MID); beam(P(X, yf, 0), P(X, 0, 0), 2.4, PAL_MID);
    beam(P(0, yf, Z), P(0, 0, Z), 2.2, PAL_BACK); beam(P(X, yf, Z), P(X, 0, Z), 2.2, PAL_BACK);
  };
  const chevrons2pans = (skip) => {
    _beamTag = 'Chevron';
    for (let z = 14; z <= Z - 14; z += 26) {
      if (skip.some(zz => Math.abs(z - zz) < 9)) continue;
      beam(P(0, 0, z), P(105, YR, z), 1.7, PAL_CHEV);
      beam(P(X, 0, z), P(105, YR, z), 1.7, PAL_CHEV);
    }
  };
  const truss = (z, pal, w) => {
    _beamTag = 'Poutre principale';
    beam(P(0, 0, z), P(X, 0, z), w + 1, pal);
    _beamTag = 'Jambe de force';
    beam(P(105, 46, z), P(52.5, 0, z), w - 1.2, pal);
    beam(P(105, 46, z), P(157.5, 0, z), w - 1.2, pal);
    _beamTag = 'Poinçon';
    beam(P(105, 0, z), P(105, YR, z), w - 0.5, pal);
    _beamTag = 'Arbalétrier';
    beam(P(0, 0, z), P(105, YR, z), w, pal);
    beam(P(X, 0, z), P(105, YR, z), w, pal);
  };
  const trussCombles = (z, pal, w) => {
    _beamTag = 'Poutre principale';
    beam(P(0, 0, z), P(X, 0, z), w + 1, pal);
    _beamTag = 'Jambette';
    beam(P(32, 0, z), P(32, 28, z), w - 1.4, pal);
    beam(P(178, 0, z), P(178, 28, z), w - 1.4, pal);
    _beamTag = 'Faux-entrait';
    beam(P(66.2, 58, z), P(143.8, 58, z), w - 0.8, pal);
    _beamTag = 'Arbalétrier';
    beam(P(0, 0, z), P(105, YR, z), w, pal);
    beam(P(X, 0, z), P(105, YR, z), w, pal);
  };
  // Fenêtre de toit (Velux) avec chevêtre, dans le pan gauche
  const roofWindow = (x1, x2, z1, z2) => {
    const yAt = x => YR * x / 105;
    const A = P(x1, yAt(x1) + 0.8, z1), B = P(x2, yAt(x2) + 0.8, z1), C = P(x2, yAt(x2) + 0.8, z2), Dp = P(x1, yAt(x1) + 0.8, z2);
    face([A, B, C, Dp], 'rgba(126,176,219,0.62)', 'rgba(96,148,198,0.5)');
    const zm = (z1 + z2) / 2;
    _beamTag = 'Encadrement bois';
    beam(P(x1, yAt(x1), zm), P(x2, yAt(x2), zm), 2.6, PAL_DARK);
    beam(A, B, 3.2, PAL_DARK); beam(Dp, C, 3.2, PAL_DARK);
    beam(A, Dp, 3.2, PAL_DARK); beam(B, C, 3.2, PAL_DARK);
  };

  if (modele === 'parquet') {
    // ---- Parquet (lames, lambourdes, plinthes) ----
    face([P(0, 0, 0), P(0, 0, Z), P(0, 16, Z), P(0, 16, 0)], 'rgba(122,84,40,0.92)');
    face([P(0, 0, Z), P(X, 0, Z), P(X, 16, Z), P(0, 16, Z)], 'rgba(108,72,32,0.92)');
    face([P(0, 0, 0), P(X, 0, 0), P(X, 0, Z), P(0, 0, Z)], 'rgba(228,196,148,0.97)', 'rgba(204,168,116,0.97)');
    for (let x = 21; x < X; x += 21) line3(P(x, 0.5, 0), P(x, 0.5, Z), 'rgba(150,110,60,0.85)', 1.1);
    for (let i = 0; i < 10; i++) {
      const dec = (i % 3) * 28;
      for (let z = 20 + dec; z < Z - 6; z += 84) line3(P(i * 21, 0.5, z), P((i + 1) * 21, 0.5, z), 'rgba(150,110,60,0.7)', 1);
    }
    _beamTag = 'Plancher bois';
    beam(P(0, 0, 0), P(X, 0, 0), 3.6, PAL_FRONT);
    beam(P(X, 0, 0), P(X, 0, Z), 3.2, PAL_MID);
    _beamTag = 'Lambourde';
    beam(P(0, -11, 6), P(X, -11, 6), 4.2, PAL_DARK);
    for (let x = 16; x < X; x += 44) beam(P(x, -11, 2), P(x, 0, 2), 3.4, PAL_BACK);
    chip('Plinthe', P(0, 10, 125), ox - 250, 60);
    chip('Lames de parquet', P(105, 0, 125), ox + 60, 36);
    chip('About / joint', P(115.5, 0, 48), ox + 235, 120);
    chip('Lambourde', mid(P(0, -11, 6), P(X, -11, 6)), ox + 160, 270);
  } else if (modele === 'plancher') {
    // ---- Solivage seul ----
    _beamTag = 'Poutre porteuse';
    beam(P(0, 0, 0), P(0, 0, Z), 4.4, PAL_DARK);
    beam(P(X, 0, 0), P(X, 0, Z), 4.4, PAL_DARK);
    beam(P(0, 0, Z), P(X, 0, Z), 4, PAL_BACK);
    _beamTag = 'Poutre principale';
    beam(P(105, -7, 0), P(105, -7, Z), 6.2, PAL_DARK);
    _beamTag = 'Solive';
    for (let z = 12; z <= Z - 12; z += 22) beam(P(0, 0, z), P(X, 0, z), 2.6, PAL_MID);
    _beamTag = 'Poutre porteuse';
    beam(P(0, 0, 0), P(X, 0, 0), 4.6, PAL_FRONT);
    chip('Muralière', mid(P(0, 0, 0), P(0, 0, Z)), ox - 250, 90);
    chip('Solive', P(105, 0, 56), ox + 130, 56);
    chip('Poutre maîtresse', mid(P(105, -7, 0), P(105, -7, Z)), ox - 150, 290);
    chip('Rive / chevêtre', P(160, 0, 0), ox + 230, 230);
  } else if (modele === 'appentis') {
    // ---- Toit 1 pan ----
    const YH = 70, YB = 14;
    const yAt = x => YH - (YH - YB) * (x / X);
    deck(YF); deckLinks(YF);
    [0, Z / 2, Z].forEach((z, i) => {
      const pal = i === 2 ? PAL_BACK : (i === 1 ? PAL_MID : PAL_FRONT);
      const w = i === 2 ? 3.4 : (i === 1 ? 4 : 5);
      _beamTag = 'Poutre principale';
      beam(P(0, 0, z), P(X, 0, z), w, pal);
      _beamTag = 'Montant bois';
      beam(P(0, 0, z), P(0, YH, z), w - 0.6, pal);
      beam(P(X, 0, z), P(X, YB, z), w - 0.6, pal);
      _beamTag = 'Arbalétrier';
      beam(P(0, YH, z), P(X, YB, z), w, pal);
    });
    face([P(0, YH, 0), P(0, YH, Z), P(X, YB, Z), P(X, YB, 0)], 'rgba(226,190,140,0.32)', 'rgba(186,146,96,0.16)');
    _beamTag = 'Chevron';
    for (let z = 14; z <= Z - 14; z += 26) {
      if ([0, Z / 2, Z].some(zz => Math.abs(z - zz) < 9)) continue;
      beam(P(0, YH, z), P(X, YB, z), 1.7, PAL_CHEV);
    }
    _beamTag = 'Panne sablière';
    beam(P(0, YH, 0), P(0, YH, Z), 4.4, PAL_DARK);
    beam(P(X, YB, 0), P(X, YB, Z), 4.4, PAL_DARK);
    _beamTag = 'Panne intermédiaire';
    beam(P(70, yAt(70), 0), P(70, yAt(70), Z), 3.4, PAL_MID);
    beam(P(140, yAt(140), 0), P(140, yAt(140), Z), 3.4, PAL_MID);
    chip('Sablière haute', mid(P(0, YH, 0), P(0, YH, Z)), ox - 215, 30);
    chip('Panne', mid(P(70, yAt(70), 0), P(70, yAt(70), Z)), ox - 90, 60);
    chip('Chevron', P(105, yAt(105), 40), ox + 150, 30);
    chip('Sablière basse', mid(P(X, YB, 0), P(X, YB, Z)), ox + 240, 150);
    chip('Poteau', P(0, 35, 0), ox - 250, 175);
    chip('Solives', P(40, YF, 110), ox - 255, 280);
  } else if (modele === '4pans') {
    // ---- Toit 4 pans (croupes) ----
    const R0 = P(105, YR, 62), R1 = P(105, YR, 188);
    deck(YF); deckLinks(YF);
    truss(188, PAL_BACK, 3.6);
    face([P(0, 0, 0), P(0, 0, Z), P(105, YR, 188), P(105, YR, 62)], 'rgba(226,190,140,0.32)', 'rgba(196,156,104,0.15)');
    face([P(X, 0, 0), P(X, 0, Z), P(105, YR, 188), P(105, YR, 62)], 'rgba(176,132,82,0.40)', 'rgba(150,108,62,0.20)');
    face([P(0, 0, 0), P(X, 0, 0), R0], 'rgba(205,168,118,0.40)', 'rgba(185,148,98,0.25)');
    face([P(0, 0, Z), P(X, 0, Z), R1], 'rgba(165,124,76,0.30)', 'rgba(150,110,64,0.18)');
    _beamTag = 'Panne sablière';
    beam(P(0, 0, 0), P(0, 0, Z), 4.2, PAL_MID);
    beam(P(X, 0, 0), P(X, 0, Z), 4.2, PAL_MID);
    beam(P(0, 0, 0), P(X, 0, 0), 4.2, PAL_FRONT);
    beam(P(0, 0, Z), P(X, 0, Z), 3.6, PAL_BACK);
    _beamTag = 'Panne faîtière';
    beam(P(105, YR, 62), P(105, YR, 188), 5, PAL_DARK);
    _beamTag = 'Arêtier';
    beam(P(0, 0, 0), R0, 4.4, PAL_FRONT);
    beam(P(X, 0, 0), R0, 4.4, PAL_FRONT);
    beam(P(0, 0, Z), R1, 3.8, PAL_BACK);
    beam(P(X, 0, Z), R1, 3.8, PAL_BACK);
    truss(125, PAL_MID, 4.2);
    truss(62, PAL_FRONT, 5);
    chip('Faîtière', mid(R0, R1), ox - 130, 26);
    chip('Arêtier', mid(P(X, 0, 0), R0), ox + 190, 40);
    chip('Croupe', mid(mid(P(0, 0, 0), P(X, 0, 0)), R0), ox + 240, 120);
    chip('Sablière', mid(P(0, 0, 0), P(0, 0, Z)), ox - 262, 140);
    chip('Entrait', P(160, 0, 62), ox + 230, 255);
    chip('Solives', P(40, YF, 110), ox - 255, 280);
  } else if (modele === 'demicroupe') {
    // ---- 2 pans à demi-croupes (ferme bernoise) ----
    const ZR0 = 40, ZR1 = 210;
    const R0 = P(105, YR, ZR0), R1 = P(105, YR, ZR1);
    deck(YF); deckLinks(YF);
    face([P(0, 0, Z), P(X, 0, Z), P(157.5, 46, Z), P(52.5, 46, Z)], 'rgba(203,213,225,0.6)', 'rgba(173,186,204,0.5)');
    truss(ZR1, PAL_BACK, 3.6);
    face([P(0, 0, 0), P(0, 0, Z), P(105, YR, ZR1), P(105, YR, ZR0)], 'rgba(226,190,140,0.32)', 'rgba(196,156,104,0.15)');
    face([P(X, 0, 0), P(X, 0, Z), P(105, YR, ZR1), P(105, YR, ZR0)], 'rgba(176,132,82,0.40)', 'rgba(150,108,62,0.20)');
    face([P(52.5, 46, 0), P(157.5, 46, 0), R0], 'rgba(205,168,118,0.45)', 'rgba(185,148,98,0.28)');
    face([P(52.5, 46, Z), P(157.5, 46, Z), R1], 'rgba(165,124,76,0.32)', 'rgba(150,110,64,0.20)');
    face([P(0, 0, 0), P(X, 0, 0), P(157.5, 46, 0), P(52.5, 46, 0)], 'rgba(226,232,240,0.78)', 'rgba(199,210,224,0.66)');
    _beamTag = 'Panne sablière';
    beam(P(0, 0, 0), P(0, 0, Z), 4.2, PAL_MID);
    beam(P(X, 0, 0), P(X, 0, Z), 4.2, PAL_MID);
    [[0, PAL_FRONT, 5], [Z, PAL_BACK, 3.6]].forEach(t => {
      _beamTag = 'Poutre principale';
      beam(P(0, 0, t[0]), P(X, 0, t[0]), t[2] + 1, t[1]);
      _beamTag = 'Arbalétrier';
      beam(P(0, 0, t[0]), P(52.5, 46, t[0]), t[2], t[1]);
      beam(P(X, 0, t[0]), P(157.5, 46, t[0]), t[2], t[1]);
      _beamTag = 'Faux-entrait';
      beam(P(52.5, 46, t[0]), P(157.5, 46, t[0]), t[2] - 0.6, t[1]);
    });
    _beamTag = 'Arêtier';
    beam(P(52.5, 46, 0), R0, 4.2, PAL_FRONT); beam(P(157.5, 46, 0), R0, 4.2, PAL_FRONT);
    beam(P(52.5, 46, Z), R1, 3.6, PAL_BACK); beam(P(157.5, 46, Z), R1, 3.6, PAL_BACK);
    _beamTag = 'Panne faîtière';
    beam(P(105, YR, ZR0), P(105, YR, ZR1), 5, PAL_DARK);
    truss(125, PAL_MID, 4.2);
    truss(ZR0, PAL_FRONT, 5);
    chip('Faîtière', mid(R0, R1), ox - 130, 24);
    chip('Demi-croupe', mid(mid(P(52.5, 46, 0), P(157.5, 46, 0)), R0), ox + 215, 50);
    chip('Arêtier', mid(P(157.5, 46, 0), R0), ox + 255, 110);
    chip('Pignon', P(105, 20, 0), ox + 240, 215);
    chip('Sablière', mid(P(0, 0, 0), P(0, 0, Z)), ox - 262, 140);
    chip('Solives', P(40, YF, 110), ox - 255, 280);
  } else if (modele === 'mansarde') {
    // ---- Toit mansardé (brisis + terrasson) ----
    const BX = 38, BY = 62, RY = 86;
    deck(YF); deckLinks(YF);
    const mTruss = (z, pal, w) => {
      _beamTag = 'Poutre principale';
      beam(P(0, 0, z), P(X, 0, z), w + 1, pal);
      _beamTag = 'Poinçon';
      beam(P(105, 0, z), P(105, RY, z), w - 0.5, pal);
      _beamTag = 'Faux-entrait';
      beam(P(BX, BY, z), P(X - BX, BY, z), w - 0.6, pal);
      _beamTag = 'Arbalétrier';
      beam(P(0, 0, z), P(BX, BY, z), w, pal);
      beam(P(X, 0, z), P(X - BX, BY, z), w, pal);
      beam(P(BX, BY, z), P(105, RY, z), w, pal);
      beam(P(X - BX, BY, z), P(105, RY, z), w, pal);
    };
    mTruss(Z, PAL_BACK, 3.6);
    face([P(0, 0, 0), P(0, 0, Z), P(BX, BY, Z), P(BX, BY, 0)], 'rgba(186,140,90,0.42)', 'rgba(160,118,72,0.24)');
    face([P(X, 0, 0), P(X, 0, Z), P(X - BX, BY, Z), P(X - BX, BY, 0)], 'rgba(166,122,74,0.46)', 'rgba(140,100,58,0.26)');
    face([P(BX, BY, 0), P(BX, BY, Z), P(105, RY, Z), P(105, RY, 0)], 'rgba(226,190,140,0.32)', 'rgba(196,156,104,0.16)');
    face([P(X - BX, BY, 0), P(X - BX, BY, Z), P(105, RY, Z), P(105, RY, 0)], 'rgba(196,152,100,0.36)', 'rgba(170,128,80,0.20)');
    _beamTag = 'Panne sablière';
    beam(P(0, 0, 0), P(0, 0, Z), 4.2, PAL_MID);
    beam(P(X, 0, 0), P(X, 0, Z), 4.2, PAL_MID);
    _beamTag = 'Panne intermédiaire';
    beam(P(BX, BY, 0), P(BX, BY, Z), 4, PAL_DARK);
    beam(P(X - BX, BY, 0), P(X - BX, BY, Z), 4, PAL_DARK);
    _beamTag = 'Chevron';
    for (let z = 14; z <= Z - 14; z += 26) {
      if ([0, Z / 2, Z].some(zz => Math.abs(z - zz) < 9)) continue;
      beam(P(0, 0, z), P(BX, BY, z), 1.7, PAL_CHEV);
      beam(P(X, 0, z), P(X - BX, BY, z), 1.7, PAL_CHEV);
      beam(P(BX, BY, z), P(105, RY, z), 1.7, PAL_CHEV);
      beam(P(X - BX, BY, z), P(105, RY, z), 1.7, PAL_CHEV);
    }
    _beamTag = 'Panne faîtière';
    beam(P(105, RY, 0), P(105, RY, Z), 5, PAL_DARK);
    mTruss(Z / 2, PAL_MID, 4.2);
    mTruss(0, PAL_FRONT, 5.2);
    chip('Faîtière', mid(P(105, RY, 0), P(105, RY, Z)), ox - 150, 24);
    chip('Terrasson', P(71.5, 74, 60), ox - 25, 52);
    chip('Panne de bris', mid(P(X - BX, BY, 0), P(X - BX, BY, Z)), ox + 225, 76);
    chip('Brisis', P(X - BX / 2, BY / 2, 0), ox + 250, 165);
    chip('Faux-entrait', P(85, BY, 0), ox + 235, 120);
    chip('Entrait', P(160, 0, 0), ox + 225, 255);
    chip('Sablière', mid(P(0, 0, 0), P(0, 0, Z)), ox - 262, 140);
    chip('Solives', P(40, YF, 110), ox - 255, 280);
  } else if (modele === 'chalet') {
    // ---- Chalet alpin à pannes (grands avant-toits, pignons madriers) ----
    const D = 30;
    deck(YF); deckLinks(YF);
    [[Z, 'rgba(187,148,100,0.92)', 1.5], [0, 'rgba(213,176,128,0.97)', -1.5]].forEach(g => {
      face([P(0, 0, g[0]), P(X, 0, g[0]), P(105, YR, g[0])], g[1]);
      for (let yy = 12; yy < YR - 6; yy += 12) {
        const xr = 105 * (1 - yy / YR);
        line3(P(105 - xr, yy, g[0] + g[2]), P(105 + xr, yy, g[0] + g[2]), 'rgba(120,85,45,0.8)', 1.3);
      }
    });
    face([P(0, 0, -D), P(0, 0, Z + D), P(105, YR, Z + D), P(105, YR, -D)], 'rgba(226,190,140,0.30)', 'rgba(196,156,104,0.14)');
    face([P(X, 0, -D), P(X, 0, Z + D), P(105, YR, Z + D), P(105, YR, -D)], 'rgba(176,132,82,0.38)', 'rgba(150,108,62,0.18)');
    _beamTag = 'Panne sablière';
    beam(P(0, 0, -D), P(0, 0, Z + D), 4.6, PAL_MID);
    beam(P(X, 0, -D), P(X, 0, Z + D), 4.6, PAL_MID);
    _beamTag = 'Panne intermédiaire';
    beam(P(52.5, 46, -D), P(52.5, 46, Z + D), 4.2, PAL_DARK);
    beam(P(157.5, 46, -D), P(157.5, 46, Z + D), 4.2, PAL_DARK);
    _beamTag = 'Chevron';
    for (let z = -16; z <= Z + 16; z += 26) {
      beam(P(0, 0, z), P(105, YR, z), 1.7, PAL_CHEV);
      beam(P(X, 0, z), P(105, YR, z), 1.7, PAL_CHEV);
    }
    _beamTag = 'Panne faîtière';
    beam(P(105, YR, -D), P(105, YR, Z + D), 5.6, PAL_DARK);
    chip('Panne faîtière', mid(P(105, YR, -D), P(105, YR, Z + D)), ox - 150, 22);
    chip('Panne intermédiaire', mid(P(157.5, 46, 0), P(157.5, 46, Z)), ox + 215, 76);
    chip('Chevron', P(52.5, 46, 64), ox - 40, 54);
    chip('Pignon en madriers', P(105, 30, 0), ox + 215, 185);
    chip('Avant-toit (débord)', P(105, YR, -D + 4), ox + 218, 28);
    chip('Sablière', mid(P(0, 0, 0), P(0, 0, Z)), ox - 262, 140);
    chip('Solives', P(40, YF, 110), ox - 255, 280);
  } else if (modele === 'combles') {
    // ---- Combles aménagés ----
    deck(YF); deckLinks(YF);
    trussCombles(Z, PAL_BACK, 3.6);
    face([P(0, 0, 0), P(0, 0, Z), P(105, YR, Z), P(105, YR, 0)], 'rgba(226,190,140,0.34)', 'rgba(196,156,104,0.16)');
    face([P(X, 0, 0), P(X, 0, Z), P(105, YR, Z), P(105, YR, 0)], 'rgba(176,132,82,0.42)', 'rgba(150,108,62,0.22)');
    _beamTag = 'Panne sablière';
    beam(P(0, 0, 0), P(0, 0, Z), 4.2, PAL_MID);
    beam(P(X, 0, 0), P(X, 0, Z), 4.2, PAL_MID);
    _beamTag = 'Panne intermédiaire';
    beam(P(52.5, 46, 0), P(52.5, 46, Z), 3.4, PAL_MID);
    beam(P(157.5, 46, 0), P(157.5, 46, Z), 3.4, PAL_MID);
    chevrons2pans([0, Z / 2, Z]);
    roofWindow(34, 80, 150, 196);
    _beamTag = 'Panne faîtière';
    beam(P(105, YR, 0), P(105, YR, Z), 5, PAL_DARK);
    trussCombles(Z / 2, PAL_MID, 4.2);
    trussCombles(0, PAL_FRONT, 5.2);
    chip('Fenêtre de toit', P(57, YR * 57 / 105, 173), ox - 168, 80);
    chip('Faîtière', mid(P(105, YR, 0), P(105, YR, Z)), ox - 150, 26);
    chip('Chevron', P(52.5, 46, 40), ox - 30, 56);
    chip('Faux-entrait', mid(P(66.2, 58, 0), P(143.8, 58, 0)), ox + 235, 95);
    chip('Jambette', P(178, 14, 0), ox + 245, 200);
    chip('Arbalétrier', mid(P(0, 0, 0), P(105, YR, 0)), ox + 40, 22);
    chip('Entrait', P(120, 0, 0), ox + 215, 262);
    chip('Sablière', mid(P(0, 0, 0), P(0, 0, Z)), ox - 262, 140);
    chip('Solives', P(40, YF, 110), ox - 255, 280);
  } else {
    // ---- Charpente traditionnelle 2 pans (défaut) ----
    deck(YF); deckLinks(YF);
    truss(Z, PAL_BACK, 3.6);
    face([P(0, 0, 0), P(0, 0, Z), P(105, YR, Z), P(105, YR, 0)], 'rgba(226,190,140,0.34)', 'rgba(196,156,104,0.16)');
    face([P(X, 0, 0), P(X, 0, Z), P(105, YR, Z), P(105, YR, 0)], 'rgba(176,132,82,0.42)', 'rgba(150,108,62,0.22)');
    _beamTag = 'Panne sablière';
    beam(P(0, 0, 0), P(0, 0, Z), 4.2, PAL_MID);
    beam(P(X, 0, 0), P(X, 0, Z), 4.2, PAL_MID);
    _beamTag = 'Panne intermédiaire';
    beam(P(52.5, 46, 0), P(52.5, 46, Z), 3.4, PAL_MID);
    beam(P(157.5, 46, 0), P(157.5, 46, Z), 3.4, PAL_MID);
    chevrons2pans([0, Z / 2, Z]);
    roofWindow(34, 80, 150, 196);
    _beamTag = 'Panne faîtière';
    beam(P(105, YR, 0), P(105, YR, Z), 5, PAL_DARK);
    truss(Z / 2, PAL_MID, 4.2);
    truss(0, PAL_FRONT, 5.2);
    chip('Fenêtre de toit', P(57, YR * 57 / 105, 173), ox - 168, 80);
    chip('Faîtière', mid(P(105, YR, 0), P(105, YR, Z)), ox - 150, 26);
    chip('Chevron', P(52.5, 46, 40), ox - 30, 56);
    chip('Panne', mid(P(157.5, 46, 0), P(157.5, 46, Z)), ox + 230, 88);
    chip('Arbalétrier', mid(P(0, 0, 0), P(105, YR, 0)), ox + 40, 22);
    chip('Poinçon', P(105, 64, 0), ox + 250, 160);
    chip('Entrait / Poutre', P(160, 0, 0), ox + 230, 255);
    chip('Sablière', mid(P(0, 0, 0), P(0, 0, Z)), ox - 262, 140);
    chip('Solives', P(40, YF, 110), ox - 255, 280);
  }
  return { items: items, chips: chips, isPlancher: isPlancher };
}

// ---------- 2) RENDU ----------
function _parseRgba(s) {
  const m = String(s).match(/rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[, ]+([\d.]+))?\)/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  return { r: 200, g: 200, b: 200, a: 1 };
}

function _drawCharpente(ctx, W, H, modele) {
  const col = _collectCharpente(modele);
  _diagSchemaParts = [];
  ctx.clearRect(0, 0, W, H);
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#fbfcfe'); bg.addColorStop(1, '#e9eef5');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  let proj = null;
  if (typeof window !== 'undefined' && window.THREE) {
    try { proj = _charpenteRender3D(ctx, W, H, col); }
    catch (e) { console.warn('Rendu 3D indisponible, repli 2D :', e); proj = null; }
  }
  if (!proj) proj = _charpenteRender2D(ctx, W, H, col);
  // Étiquettes + registre des éléments cliquables (espace logique 640×380)
  const k = W / 640;
  ctx.save(); ctx.scale(k, k);
  col.items.forEach(it => {
    if (it.t !== 'seg') return;
    const a = proj(it.a), b = proj(it.b);
    _diagSchemaParts.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, w: Math.max(it.w, 4), tag: it.tag });
  });
  col.chips.forEach(cp => _drawChip640(ctx, cp.txt, proj(cp.target), cp.lx, cp.ly));
  ctx.restore();
}

// Étiquette « pro » (espace 640×380)
function _drawChip640(ctx, txt, target, lx, ly) {
  ctx.strokeStyle = 'rgba(100,116,139,0.85)'; ctx.lineWidth = 1.1;
  ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(target.x, target.y); ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(target.x, target.y, 3.1, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#64748b';
  ctx.beginPath(); ctx.arc(target.x, target.y, 2.1, 0, Math.PI * 2); ctx.fill();
  ctx.font = 'bold 11px Arial';
  const tw = ctx.measureText(txt).width, bw = tw + 14, bh = 18;
  const bx = lx - bw / 2, by = ly - bh / 2;
  ctx.save();
  ctx.shadowColor = 'rgba(13,27,62,0.35)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 2;
  ctx.fillStyle = '#0d1b3e';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 9); else ctx.rect(bx, by, bw, bh);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(bx + 0.5, by + 0.5, bw - 1, bh - 1, 8.5); else ctx.rect(bx, by, bw, bh);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.fillText(txt, bx + 7, by + 12.5);
}

// --- Rendu 3D WebGL (three.js) : vraie lumière, vraies ombres, vrai bois ---
let _threeRenderer = null;
function _charpenteRender3D(ctx, W, H, col) {
  if (!_threeRenderer) {
    const cv = document.createElement('canvas');
    _threeRenderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true, preserveDrawingBuffer: true });
    _threeRenderer.shadowMap.enabled = true;
    _threeRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }
  const renderer = _threeRenderer;
  renderer.setSize(W, H, false);
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.52));
  scene.add(new THREE.HemisphereLight(0xe9eef8, 0xc9a268, 0.38));
  const sun = new THREE.DirectionalLight(0xfff3e0, 0.95);
  sun.position.set(150, 360, 230);
  sun.castShadow = true;
  sun.shadow.mapSize.width = 2048; sun.shadow.mapSize.height = 2048;
  sun.shadow.camera.left = -340; sun.shadow.camera.right = 340;
  sun.shadow.camera.top = 340; sun.shadow.camera.bottom = -340;
  sun.shadow.camera.near = 10; sun.shadow.camera.far = 1200;
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0012;
  scene.add(sun);
  const groundY = (col.isPlancher ? -16 : -30);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), new THREE.ShadowMaterial({ opacity: 0.17 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = groundY; ground.receiveShadow = true;
  scene.add(ground);

  const xAxis = new THREE.Vector3(1, 0, 0);
  const box = new THREE.Box3();
  col.items.forEach((it, i) => {
    if (it.t === 'seg' || it.t === 'line') {
      const a = new THREE.Vector3(it.a.x, it.a.y, it.a.z);
      const b = new THREE.Vector3(it.b.x, it.b.y, it.b.z);
      box.expandByPoint(a); box.expandByPoint(b);
      const dir = b.clone().sub(a); const len = dir.length(); if (len < 0.01) return;
      const w = it.t === 'seg' ? Math.max(it.w * 1.15, 1.9) : 1.0;
      const geo = new THREE.BoxGeometry(len + w * 0.5, w, w * 0.82);
      let cstr;
      if (it.t === 'seg') cstr = it.pal[1];
      else { const m = _parseRgba(it.col); cstr = 'rgb(' + (m.r | 0) + ',' + (m.g | 0) + ',' + (m.b | 0) + ')'; }
      const c = new THREE.Color(cstr);
      if (it.t === 'seg') c.offsetHSL(0, 0.02, (((i * 73) % 17) / 17 - 0.5) * 0.06);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: c, roughness: 0.74, metalness: 0 }));
      mesh.position.copy(a.clone().add(b).multiplyScalar(0.5));
      mesh.quaternion.setFromUnitVectors(xAxis, dir.normalize());
      if (it.t === 'seg') { mesh.castShadow = true; mesh.receiveShadow = true; }
      scene.add(mesh);
    } else if (it.t === 'face') {
      const pts = it.pts.map(p => new THREE.Vector3(p.x, p.y, p.z));
      pts.forEach(p => box.expandByPoint(p));
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      geo.setIndex(pts.length === 3 ? [0, 1, 2] : [0, 1, 2, 0, 2, 3]);
      geo.computeVertexNormals();
      const m = _parseRgba(it.c1);
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(m.r / 255, m.g / 255, m.b / 255),
        transparent: m.a < 0.95, opacity: Math.min(m.a + 0.05, 1),
        side: THREE.DoubleSide, roughness: 0.92, metalness: 0,
        depthWrite: m.a >= 0.7,
      });
      scene.add(new THREE.Mesh(geo, mat));
    }
  });

  // Caméra orthographique, cadrage exact par projection des coins
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = 0.5 * Math.hypot(size.x, size.z);
  const cam = new THREE.OrthographicCamera(-160 * (640 / 380), 160 * (640 / 380), 160, -160, -2000, 4000);
  const d = radius * 2.2 + 150;
  cam.position.set(center.x + d * 0.72, center.y + d * 0.62, center.z + d * 0.88);
  cam.lookAt(center.x, center.y - 2, center.z);
  cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
  let mx = 0, my = 0;
  [[box.min.x, box.min.y, box.min.z], [box.max.x, box.min.y, box.min.z],
   [box.min.x, box.max.y, box.min.z], [box.min.x, box.min.y, box.max.z],
   [box.max.x, box.max.y, box.min.z], [box.max.x, box.min.y, box.max.z],
   [box.min.x, box.max.y, box.max.z], [box.max.x, box.max.y, box.max.z]].forEach(c0 => {
    const v = new THREE.Vector3(c0[0], c0[1], c0[2]).project(cam);
    mx = Math.max(mx, Math.abs(v.x)); my = Math.max(my, Math.abs(v.y));
  });
  const f = Math.max(mx, my) * 1.14;
  cam.left *= f; cam.right *= f; cam.top *= f; cam.bottom *= f;
  cam.updateProjectionMatrix();

  renderer.setClearColor(0x000000, 0);
  renderer.render(scene, cam);
  ctx.drawImage(renderer.domElement, 0, 0, W, H);
  scene.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(mm => mm.dispose());
  });
  return p => {
    const v = new THREE.Vector3(p.x, p.y, p.z).project(cam);
    return { x: (v.x * 0.5 + 0.5) * 640, y: (-v.y * 0.5 + 0.5) * 380 };
  };
}

// --- Repli 2D axonométrique (sans WebGL) : prismes dessinés à la main ---
function _charpenteRender2D(ctx, W, H, col) {
  const k = W / 640;
  const s = col.isPlancher ? 1.5 : 1.25;
  const ox = 640 * 0.535, oy = col.isPlancher ? 170 : 108;
  const proj = p => ({ x: ox + (p.x - p.z) * 0.866 * s, y: oy + (p.x + p.z) * 0.275 * s - p.y * s });
  ctx.save(); ctx.scale(k, k);
  // ombre au sol
  const shx = ox - 28, shy = oy + (210 + 250) * 0.275 * s * 0.62 + (col.isPlancher ? 14 : 40);
  ctx.save();
  ctx.translate(shx, shy); ctx.scale(1, 32 / 270);
  const sg = ctx.createRadialGradient(0, 0, 12, 0, 0, 270);
  sg.addColorStop(0, 'rgba(15,23,42,0.17)'); sg.addColorStop(0.7, 'rgba(15,23,42,0.08)'); sg.addColorStop(1, 'rgba(15,23,42,0)');
  ctx.fillStyle = sg;
  ctx.beginPath(); ctx.arc(0, 0, 270, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  col.items.forEach(it => {
    if (it.t === 'face') {
      const pts = it.pts.map(proj);
      const g = ctx.createLinearGradient(pts[0].x, pts[0].y, pts[2].x, pts[2].y);
      g.addColorStop(0, it.c1); g.addColorStop(1, it.c2);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath(); ctx.fill();
    } else if (it.t === 'line') {
      const a = proj(it.a), b = proj(it.b);
      ctx.strokeStyle = it.col; ctx.lineWidth = it.w; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    } else {
      const a = proj(it.a), b = proj(it.b), w = it.w, pal = it.pal;
      const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
      let nx = -dy / L, ny = dx / L;
      if (ny < 0) { nx = -nx; ny = -ny; }
      const hw = w / 2, ex = -w * 0.40, ey = -w * 0.52;
      if (w < 2.6) {
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(50,33,12,0.15)'; ctx.lineWidth = w + 1.6;
        ctx.beginPath(); ctx.moveTo(a.x + 1.6, a.y + 2.2); ctx.lineTo(b.x + 1.6, b.y + 2.2); ctx.stroke();
        const gs = ctx.createLinearGradient(a.x - nx * w, a.y - ny * w, a.x + nx * w, a.y + ny * w);
        gs.addColorStop(0, pal[0]); gs.addColorStop(1, pal[2]);
        ctx.strokeStyle = gs; ctx.lineWidth = w;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        return;
      }
      const A1 = { x: a.x - nx * hw, y: a.y - ny * hw }, B1 = { x: b.x - nx * hw, y: b.y - ny * hw };
      const A2 = { x: a.x + nx * hw, y: a.y + ny * hw }, B2 = { x: b.x + nx * hw, y: b.y + ny * hw };
      const quad = (p1, p2, p3, p4, fill) => {
        ctx.fillStyle = fill;
        ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.lineTo(p4.x, p4.y); ctx.closePath(); ctx.fill();
      };
      ctx.lineCap = 'butt';
      ctx.strokeStyle = 'rgba(50,33,12,0.14)'; ctx.lineWidth = w + 3;
      ctx.beginPath(); ctx.moveTo(a.x + 2.6, a.y + 3.6); ctx.lineTo(b.x + 2.6, b.y + 3.6); ctx.stroke();
      const g = ctx.createLinearGradient(A1.x, A1.y, A2.x, A2.y);
      g.addColorStop(0, pal[1]); g.addColorStop(1, pal[2]);
      quad(A1, B1, B2, A2, g);
      quad(A1, B1, { x: B1.x + ex, y: B1.y + ey }, { x: A1.x + ex, y: A1.y + ey }, pal[0]);
      quad(B1, B2, { x: B2.x + ex, y: B2.y + ey }, { x: B1.x + ex, y: B1.y + ey }, pal[1]);
      quad(A1, A2, { x: A2.x + ex, y: A2.y + ey }, { x: A1.x + ex, y: A1.y + ey }, pal[1]);
      ctx.strokeStyle = 'rgba(58,37,12,0.45)'; ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.moveTo(A1.x, A1.y); ctx.lineTo(B1.x, B1.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(A2.x, A2.y); ctx.lineTo(B2.x, B2.y); ctx.stroke();
    }
  });
  ctx.restore();
  return proj;
}

let _diagBgDataUrl = null;  // fond propre (schéma 3D ou photo importée), pour effacer les annotations
function initDiagSchema() {
  const c = $('diag-schema-canvas'); if (!c) return;
  const ctx = c.getContext('2d');
  if (_editingDiag && _editingDiag.schema) {
    _diagBgDataUrl = _editingDiag.schema;
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, c.width, c.height);
    img.src = _editingDiag.schema;
  } else {
    if (_editingDiag && _diagType(_editingDiag) === 'rongeurs') _drawPlanBase(ctx, c.width, c.height);
    else _drawSchemaBase(ctx, c.width, c.height);
    _diagBgDataUrl = c.toDataURL('image/png');
    if (_editingDiag) _editingDiag.schema = _diagBgDataUrl;
  }
  _diagAttachDraw(c, ctx);
  c.ondblclick = e => { e.preventDefault(); openSchemaZoom(); };
}

// ---- Bibliothèque des éléments bois : clic sur un nom → la pièce s'illumine ----
const BOIS_ELEMENTS = [
  'Poutre principale', 'Poutre porteuse', 'Solive', 'Chevron',
  'Panne faîtière', 'Panne intermédiaire', 'Panne sablière',
  'Arbalétrier', 'Poinçon', 'Jambe de force', 'Faux-entrait', 'Jambette', 'Arêtier',
  'Liteaux', 'Contre-liteaux', 'Lambourde', 'Plancher bois', 'Madrier',
  'Montant bois', 'Linteau bois', 'Encadrement bois', 'Plinthe bois',
  'Escalier bois', 'Parquet', 'Lambris', 'Charpente apparente',
];
let _hlTimer1 = null, _hlTimer2 = null;
function highlightWoodElement(name) {
  const c = $('diag-schema-canvas'); if (!c || !_editingDiag) return;
  let parts;
  if (name === 'Charpente apparente') parts = _diagSchemaParts.slice();
  else if (name === 'Parquet') parts = _diagSchemaParts.filter(s => s.tag === 'Plancher bois' || s.tag === 'Lambourde');
  else parts = _diagSchemaParts.filter(s => s.tag === name);
  if (!parts.length) {
    toast('« ' + name + ' » n\'est pas dessiné sur ce gabarit — indique-le avec ✏️ Dessin ou 🔤 Texte.', '#e6aa1e');
    return;
  }
  // Calque de surbrillance superposé (n'altère ni le schéma ni les annotations)
  const host = c.parentElement;
  host.style.position = 'relative';
  let ov = $('diag-hl-canvas');
  if (!ov) { ov = document.createElement('canvas'); ov.id = 'diag-hl-canvas'; host.appendChild(ov); }
  ov.width = c.width; ov.height = c.height;
  const hr = host.getBoundingClientRect(), cr = c.getBoundingClientRect();
  ov.style.cssText = 'position:absolute;left:' + (cr.left - hr.left) + 'px;top:' + (cr.top - hr.top) + 'px;width:' + cr.width + 'px;height:' + cr.height + 'px;pointer-events:none;opacity:1;transition:opacity .7s;z-index:5;';
  const k = c.width / 640;
  const octx = ov.getContext('2d');
  octx.clearRect(0, 0, ov.width, ov.height);
  octx.save(); octx.scale(k, k);
  octx.lineCap = 'round'; octx.lineJoin = 'round';
  parts.forEach(s => {
    octx.strokeStyle = 'rgba(255,196,0,0.35)'; octx.lineWidth = s.w + 12;
    octx.beginPath(); octx.moveTo(s.ax, s.ay); octx.lineTo(s.bx, s.by); octx.stroke();
  });
  parts.forEach(s => {
    octx.strokeStyle = 'rgba(255,153,0,0.95)'; octx.lineWidth = s.w + 2.5;
    octx.beginPath(); octx.moveTo(s.ax, s.ay); octx.lineTo(s.bx, s.by); octx.stroke();
  });
  octx.restore();
  c.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  toast('💡 ' + name + ' — ' + parts.length + ' pièce(s) illuminée(s)', '#0f766e');
  clearTimeout(_hlTimer1); clearTimeout(_hlTimer2);
  _hlTimer1 = setTimeout(() => { const o = $('diag-hl-canvas'); if (o) o.style.opacity = '0'; }, 2600);
  _hlTimer2 = setTimeout(() => { const o = $('diag-hl-canvas'); if (o) o.remove(); }, 3400);
}

// Gestionnaires de dessin du schéma (partagés entre la vue normale et le plein écran)
function _diagAttachDraw(c, ctx) {
  const pos = e => { const r = c.getBoundingClientRect(); const tt = e.touches ? e.touches[0] : e; return { x: (tt.clientX - r.left) * (c.width / r.width), y: (tt.clientY - r.top) * (c.height / r.height) }; };
  const start = e => {
    const p = pos(e);
    if (_diagTool === 'element' && _diagSchemaParts.length) {
      e.preventDefault();
      // Le registre des éléments est en coordonnées logiques 640×380
      const kEl = c.width / 640;
      const pl = { x: p.x / kEl, y: p.y / kEl };
      const part = _diagNearestPart(pl);
      if (!part) { toast('Clique plus près d\'un élément de la charpente', '#e6aa1e'); return; }
      _diagAnnotateElement(ctx, c, part, pl);
      return;
    }
    const kTool = c.width / 640;   // épaisseurs proportionnelles au canevas
    if (_diagTool === 'text') {
      e.preventDefault();
      const txt = prompt('Texte à placer sur le schéma :');
      if (txt && txt.trim()) {
        ctx.font = 'bold ' + Math.round(16 * kTool) + 'px Arial'; ctx.fillStyle = _diagColor;
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 3 * kTool; ctx.lineJoin = 'round';
        ctx.strokeText(txt.trim(), p.x, p.y); ctx.fillText(txt.trim(), p.x, p.y);
        if (_editingDiag) _editingDiag.schema = c.toDataURL('image/png');
        refreshDiagPreview();
      }
      return;
    }
    _diagDrawing = true;
    _diagStrokePts = [p];
    try { _diagSnapshot = ctx.getImageData(0, 0, c.width, c.height); } catch (err) { _diagSnapshot = null; }
    ctx.strokeStyle = _diagColor; ctx.lineWidth = 3 * kTool; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault();
  };
  const move = e => { if (!_diagDrawing) return; const p = pos(e); _diagStrokePts.push(p); ctx.lineTo(p.x, p.y); ctx.stroke(); e.preventDefault(); };
  const end = () => {
    if (!_diagDrawing) return;
    _diagDrawing = false;
    // Reconnaissance de forme : remplace le tracé brut par une forme propre
    const shape = _diagRecognizeShape(_diagStrokePts);
    if (shape && _diagSnapshot) {
      ctx.putImageData(_diagSnapshot, 0, 0);
      ctx.strokeStyle = _diagColor; ctx.lineWidth = 3 * (c.width / 640); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      if (shape.type === 'ellipse') ctx.ellipse(shape.cx, shape.cy, shape.a, shape.b, 0, 0, Math.PI*2);
      else if (shape.type === 'rect') ctx.rect(shape.x, shape.y, shape.w, shape.h);
      else { ctx.moveTo(shape.x1, shape.y1); ctx.lineTo(shape.x2, shape.y2); }
      ctx.stroke();
    }
    _diagStrokePts = []; _diagSnapshot = null;
    if (_editingDiag) _editingDiag.schema = c.toDataURL('image/png');
    refreshDiagPreview();
  };
  c.onmousedown = start; c.onmousemove = move; c.onmouseup = end; c.onmouseleave = end;
  c.ontouchstart = start; c.ontouchmove = move; c.ontouchend = end;
}

// ---- Schéma en plein écran : grande vue pour tracer confortablement ----
function openSchemaZoom() {
  if (!_editingDiag) return;
  let ov = $('schema-zoom-overlay');
  if (!ov) { ov = document.createElement('div'); ov.id = 'schema-zoom-overlay'; document.body.appendChild(ov); }
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(13,27,62,.78);z-index:99999;display:flex;align-items:center;justify-content:center;padding:14px;';
  ov.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:14px;max-width:1560px;width:100%;max-height:97vh;overflow:auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div style="font-weight:800;color:var(--navy);font-size:14px;">🔍 ${_diagType(_editingDiag)==='rongeurs' ? 'Plan des locaux' : 'Schéma de la charpente'} — vue agrandie</div>
        <button class="btn btn-navy btn-sm" type="button" onclick="closeSchemaZoom()">✓ Terminer</button>
      </div>
      <canvas id="diag-zoom-canvas" width="2048" height="1216" style="width:100%;height:auto;border:1px solid #e5e7eb;border-radius:8px;cursor:crosshair;touch-action:none;background:#fff;"></canvas>
      <div id="schema-zoom-tools" style="margin-top:8px;"></div>
    </div>`;
  _schemaZoomToolbar();
  const c = $('diag-zoom-canvas');
  const ctx = c.getContext('2d');
  if (_editingDiag.schema) {
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, c.width, c.height);
    img.src = _editingDiag.schema;
  } else {
    if (_diagType(_editingDiag) === 'rongeurs') _drawPlanBase(ctx, c.width, c.height);
    else _drawSchemaBase(ctx, c.width, c.height);
    _editingDiag.schema = c.toDataURL('image/png');
  }
  _diagAttachDraw(c, ctx);
}
function _schemaZoomToolbar() {
  const box = $('schema-zoom-tools'); if (!box) return;
  const rg = _editingDiag && _diagType(_editingDiag) === 'rongeurs';
  const colors = rg ? RONGEUR_COLORS : DIAG_COLORS;
  box.innerHTML = `
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
      <span style="font-size:11px;font-weight:700;color:var(--g600);">Couleur :</span>
      ${colors.map(cc => `
        <button type="button" title="${cc.label}" onclick="schemaZoomSetColor('${cc.hex}')"
          style="width:24px;height:24px;border-radius:50%;cursor:pointer;background:${cc.hex};border:${_diagColor===cc.hex?'3px solid var(--navy)':'2px solid #e5e7eb'};"></button>`).join('')}
      <span style="font-size:10px;color:var(--g400);">(${(colors.find(cc=>cc.hex===_diagColor)||{}).label||''})</span>
      <span style="width:1px;height:20px;background:#e5e7eb;"></span>
      <button class="btn ${_diagTool==='draw'?'btn-navy':'btn-ghost'} btn-sm" type="button" onclick="schemaZoomSetTool('draw')">✏️ Dessin</button>
      <button class="btn ${_diagTool==='text'?'btn-navy':'btn-ghost'} btn-sm" type="button" onclick="schemaZoomSetTool('text')">🔤 Texte</button>
      ${!rg ? `<button class="btn ${_diagTool==='element'?'btn-navy':'btn-ghost'} btn-sm" type="button" onclick="schemaZoomSetTool('element')">🎯 Élément</button>` : ''}
      <span style="width:1px;height:20px;background:#e5e7eb;"></span>
      <button class="btn btn-ghost btn-sm" type="button" onclick="schemaZoomClear()">↺ Effacer les annotations</button>
      <span style="font-size:11px;color:var(--g400);">Cercles, rectangles et traits sont automatiquement redressés.</span>
    </div>`;
}
function schemaZoomSetColor(hex) { _diagColor = hex; _schemaZoomToolbar(); }
function schemaZoomSetTool(t) { _diagTool = t; _schemaZoomToolbar(); }
function schemaZoomClear() {
  const c = $('diag-zoom-canvas'); if (!c) return;
  const ctx = c.getContext('2d');
  if (_diagBgDataUrl) {
    const img = new Image();
    img.onload = () => { ctx.clearRect(0,0,c.width,c.height); ctx.drawImage(img, 0, 0, c.width, c.height); if (_editingDiag) { _editingDiag.schema = c.toDataURL('image/png'); refreshDiagPreview(); } };
    img.src = _diagBgDataUrl;
  } else {
    if (_editingDiag && _diagType(_editingDiag) === 'rongeurs') _drawPlanBase(ctx, c.width, c.height);
    else _drawSchemaBase(ctx, c.width, c.height);
    if (_editingDiag) { _editingDiag.schema = c.toDataURL('image/png'); refreshDiagPreview(); }
  }
}
function closeSchemaZoom() {
  const ov = $('schema-zoom-overlay'); if (ov) ov.remove();
  renderDiagEditor();   // resynchronise la petite vue (canevas + barre d'outils)
}
// Importe une photo/image comme fond du schéma
function loadSchemaImage(ev) {
  const file = ev.target.files && ev.target.files[0]; if (!file) return;
  const c = $('diag-schema-canvas'); if (!c) return;
  const ctx = c.getContext('2d');
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      const r = Math.min(c.width / img.width, c.height / img.height);
      const w = img.width * r, h = img.height * r;
      ctx.drawImage(img, (c.width - w) / 2, (c.height - h) / 2, w, h);
      _diagSchemaParts = [];   // image importée : plus d'éléments cliquables
      _diagBgDataUrl = c.toDataURL('image/png');
      if (_editingDiag) _editingDiag.schema = _diagBgDataUrl;
      refreshDiagPreview();
      toast('✓ Image chargée — dessine pour entourer les zones', '#2d9e6b');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  ev.target.value = '';
}
// Efface uniquement les annotations (revient au fond propre)
function clearDiagSchema() {
  const c = $('diag-schema-canvas'); if (!c) return;
  const ctx = c.getContext('2d');
  if (_diagBgDataUrl) {
    const img = new Image();
    img.onload = () => { ctx.clearRect(0,0,c.width,c.height); ctx.drawImage(img, 0, 0, c.width, c.height); if (_editingDiag) _editingDiag.schema = c.toDataURL('image/png'); refreshDiagPreview(); };
    img.src = _diagBgDataUrl;
  } else {
    if (_editingDiag && _diagType(_editingDiag) === 'rongeurs') _drawPlanBase(ctx, c.width, c.height);
    else _drawSchemaBase(ctx, c.width, c.height);
    if (_editingDiag) _editingDiag.schema = c.toDataURL('image/png');
    refreshDiagPreview();
  }
}
// Revient au fond par défaut (schéma 3D charpente, ou plan quadrillé pour les rongeurs)
function resetToDefaultSchema() {
  const c = $('diag-schema-canvas'); if (!c) return;
  const ctx = c.getContext('2d');
  if (_editingDiag && _diagType(_editingDiag) === 'rongeurs') _drawPlanBase(ctx, c.width, c.height);
  else _drawSchemaBase(ctx, c.width, c.height);
  _diagBgDataUrl = c.toDataURL('image/png');
  if (_editingDiag) _editingDiag.schema = _diagBgDataUrl;
  refreshDiagPreview();
}
// Modèle de plan des locaux choisi (rapport rongeurs)
let _diagPlanModele = 'soussol';
function setDiagPlanModele(m) { _diagPlanModele = m || 'soussol'; resetToDefaultSchema(); }

// Fond "plan des locaux" : dispatcher vers le gabarit choisi
function _drawPlanBase(ctx, W, H) { _drawPlan(ctx, W, H, _diagPlanModele); }

// Moteur de dessin des plans d'architecte (vue de dessus)
function _drawPlan(ctx, W, H, modele) {
  ctx.clearRect(0, 0, W, H);
  const _k = W / 640;
  ctx.save(); ctx.scale(_k, _k);
  W = 640; H = 380;
  // Papier + quadrillage discret
  ctx.fillStyle = '#fdfdfb'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(148,163,184,0.18)'; ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 16) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y <= H; y += 16) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  const MUR = '#33415c', T = 8, t = 5;
  const wall = (x, y, w, h) => { ctx.fillStyle = MUR; ctx.fillRect(x, y, w, h); };
  const roomFill = (x, y, w, h, col) => { ctx.fillStyle = col || 'rgba(241,245,249,0.6)'; ctx.fillRect(x, y, w, h); };
  const label = (txt, x, y, size, col) => {
    ctx.fillStyle = col || '#475569'; ctx.font = '700 ' + (size || 11) + 'px Arial';
    ctx.textAlign = 'center'; ctx.fillText(txt.toUpperCase(), x, y); ctx.textAlign = 'left';
  };
  const sub = (txt, x, y) => { ctx.fillStyle = '#94a3b8'; ctx.font = '600 9px Arial'; ctx.textAlign = 'center'; ctx.fillText(txt, x, y); ctx.textAlign = 'left'; };
  // Ouverture blanche dans un mur + porte (battant + arc)
  const gapH = (x, y, len) => { ctx.fillStyle = '#fdfdfb'; ctx.fillRect(x, y - 0.5, len, t + 1); };
  const gapV = (x, y, len) => { ctx.fillStyle = '#fdfdfb'; ctx.fillRect(x - 0.5, y, t + 1, len); };
  const door = (hx, hy, len, a0) => {
    ctx.strokeStyle = '#64748b'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(hx, hy, len, a0, a0 + Math.PI / 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx + len * Math.cos(a0), hy + len * Math.sin(a0)); ctx.stroke();
  };
  const winH = (x, y, len) => {
    ctx.fillStyle = '#fdfdfb'; ctx.fillRect(x, y, len, T);
    ctx.strokeStyle = '#2a6fdb'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, y + T * 0.32); ctx.lineTo(x + len, y + T * 0.32);
    ctx.moveTo(x, y + T * 0.68); ctx.lineTo(x + len, y + T * 0.68); ctx.stroke();
  };
  const stairs = (x, y, w, h, n) => {
    ctx.strokeStyle = '#64748b'; ctx.lineWidth = 1.2;
    ctx.strokeRect(x, y, w, h);
    for (let i = 1; i < n; i++) { const yy = y + h * i / n; ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + w, yy); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(x + w / 2, y + h - 6); ctx.lineTo(x + w / 2, y + 8);
    ctx.lineTo(x + w / 2 - 4, y + 14); ctx.moveTo(x + w / 2, y + 8); ctx.lineTo(x + w / 2 + 4, y + 14); ctx.stroke();
  };
  const bins = (x, y) => {
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = '#cbd5e1'; ctx.fillRect(x + i * 24, y, 18, 18);
      ctx.strokeStyle = '#64748b'; ctx.lineWidth = 1.2; ctx.strokeRect(x + i * 24, y, 18, 18);
      ctx.strokeStyle = '#94a3b8'; ctx.beginPath(); ctx.moveTo(x + i * 24 + 4, y + 4); ctx.lineTo(x + i * 24 + 14, y + 14); ctx.moveTo(x + i * 24 + 14, y + 4); ctx.lineTo(x + i * 24 + 4, y + 14); ctx.stroke();
    }
  };
  // Cartouche : flèche du nord + échelle + note
  const cartouche = () => {
    ctx.strokeStyle = '#475569'; ctx.lineWidth = 1.4; ctx.fillStyle = '#475569';
    ctx.beginPath(); ctx.arc(614, 40, 14, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(614, 50); ctx.lineTo(614, 32); ctx.lineTo(609, 40); ctx.closePath(); ctx.fill();
    ctx.font = '700 10px Arial'; ctx.textAlign = 'center'; ctx.fillText('N', 614, 29); ctx.textAlign = 'left';
    ctx.strokeStyle = '#475569'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(22, 364); ctx.lineTo(82, 364); ctx.stroke();
    ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(22, 360); ctx.lineTo(22, 368); ctx.moveTo(52, 361); ctx.lineTo(52, 367); ctx.moveTo(82, 360); ctx.lineTo(82, 368); ctx.stroke();
    ctx.fillStyle = '#64748b'; ctx.font = '600 9px Arial'; ctx.fillText('≈ 2 m', 88, 367);
    ctx.textAlign = 'right'; ctx.fillText('Plan schématique — sans échelle', 632, 372); ctx.textAlign = 'left';
  };

  const x0 = 70, y0 = 46, x1 = 570, y1 = 324;
  const outer = () => {
    wall(x0 - T, y0 - T, (x1 - x0) + 2 * T, T);
    wall(x0 - T, y1, (x1 - x0) + 2 * T, T);
    wall(x0 - T, y0 - T, T, (y1 - y0) + 2 * T);
    wall(x1, y0 - T, T, (y1 - y0) + 2 * T);
  };

  if (modele === 'libre') {
    ctx.strokeStyle = '#9aa3b2'; ctx.lineWidth = 3;
    ctx.strokeRect(W * 0.08, H * 0.10, W * 0.84, H * 0.78);
    ctx.fillStyle = '#9aa3b2'; ctx.font = 'bold 13px Arial';
    ctx.fillText('Plan libre — dessine les murs, pièces, zones d\'activité et postes', W * 0.10, H * 0.97);
  } else if (modele === 'appartement') {
    roomFill(x0, y0, x1 - x0, y1 - y0);
    const cY0 = 180, cY1 = 216;
    roomFill(x0, cY0 + t, x1 - x0, cY1 - cY0 - 2 * t, 'rgba(226,232,240,0.7)');
    outer();
    wall(x0, cY0, x1 - x0, t); wall(x0, cY1 - t, x1 - x0, t);
    wall(300, y0, t, cY0 - y0); wall(450, y0, t, cY0 - y0);
    wall(320, cY1, t, y1 - cY1);
    // fenêtres
    winH(140, y0 - T, 60); winH(355, y0 - T, 50); winH(150, y1, 60); winH(420, y1, 60);
    // entrée + portes intérieures
    gapV(x0 - T + (T - t) / 2, 186, 26); door(x0, 212, 26, -Math.PI / 2);
    gapH(160, cY0, 26); door(160, cY0, 26, -Math.PI / 2);
    gapH(360, cY0, 26); door(360, cY0, 26, -Math.PI / 2);
    gapH(495, cY0, 26); door(495, cY0, 26, -Math.PI / 2);
    gapH(170, cY1 - t, 26); door(170, cY1, 26, 0);
    gapH(420, cY1 - t, 26); door(420, cY1, 26, 0);
    // cuisine : plan de travail + plaques
    ctx.fillStyle = '#e2e8f0'; ctx.fillRect(308, y0 + 2, 137, 22);
    ctx.strokeStyle = '#94a3b8'; ctx.strokeRect(308, y0 + 2, 137, 22);
    for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(394 + (i % 2) * 16, y0 + 9 + Math.floor(i / 2) * 9, 3.4, 0, Math.PI * 2); ctx.stroke(); }
    // salle de bain : baignoire
    ctx.strokeStyle = '#94a3b8'; ctx.strokeRect(530, y0 + 6, 32, 70);
    ctx.beginPath(); ctx.arc(546, y0 + 24, 9, 0, Math.PI * 2); ctx.stroke();
    label('Séjour', 185, 120); label('Cuisine', 375, 120); label('Salle de bain', 510, 120, 10);
    label('Couloir', 320, 202, 10, '#64748b');
    label('Chambre 1', 195, 275); label('Chambre 2', 445, 275);
    cartouche();
  } else if (modele === 'resto') {
    roomFill(x0, y0, x1 - x0, y1 - y0);
    outer();
    wall(300, y0, t, y1 - y0);                          // salle | partie technique
    wall(300, 170, x1 - 300, t);                        // cuisine / dessous
    wall(420, 170, t, y1 - 170);                        // plonge|réserve puis froide|poubelles
    wall(300, 240, x1 - 300, t);
    // portes
    gapV(300, 100, 30); door(300 + t / 2, 130, 28, -Math.PI / 2);
    gapV(300, 260, 26); door(300 + t / 2, 286, 24, -Math.PI / 2);
    gapH(340, 170, 24); door(340, 170, 24, -Math.PI / 2);
    gapH(470, 170, 24); door(470, 170, 24, -Math.PI / 2);
    gapH(340, 240, 24); door(340, 240, 24, -Math.PI / 2);
    gapH(470, 240, 24); door(470, 240, 24, -Math.PI / 2);
    // entrée client double battant
    gapH(150, y1, 52);
    door(150, y1, 26, -Math.PI / 2); door(202, y1, 26, Math.PI);
    winH(120, y0 - T, 70); winH(220, y0 - T, 50);
    // cuisine : plans de travail + fourneaux
    ctx.fillStyle = '#e2e8f0'; ctx.fillRect(308, y0 + 2, 254, 20); ctx.strokeStyle = '#94a3b8'; ctx.strokeRect(308, y0 + 2, 254, 20);
    ctx.fillStyle = '#e2e8f0'; ctx.fillRect(308, 130, 120, 18); ctx.strokeRect(308, 130, 120, 18);
    for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(478 + (i % 2) * 18, y0 + 8 + Math.floor(i / 2) * 8, 3.4, 0, Math.PI * 2); ctx.stroke(); }
    // réserve : étagères
    for (let yy = 188; yy <= 228; yy += 13) { ctx.strokeStyle = '#94a3b8'; ctx.beginPath(); ctx.moveTo(434, yy); ctx.lineTo(560, yy); ctx.stroke(); }
    // chambre froide : flocon
    ctx.strokeStyle = '#2a6fdb'; ctx.lineWidth = 1.6;
    for (let a = 0; a < 6; a++) { ctx.beginPath(); ctx.moveTo(360, 292); ctx.lineTo(360 + 12 * Math.cos(a * Math.PI / 3), 292 + 12 * Math.sin(a * Math.PI / 3)); ctx.stroke(); }
    bins(465, 280);
    // salle : tables rondes
    ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1.3;
    [[150, 120], [230, 200], [140, 265]].forEach(p => { ctx.beginPath(); ctx.arc(p[0], p[1], 16, 0, Math.PI * 2); ctx.stroke(); });
    label('Salle', 185, 75); label('Cuisine', 430, 110);
    label('Plonge', 360, 215, 10); label('Réserve sèche', 495, 182, 10);
    label('Ch. froide', 360, 265, 10); label('Local poubelles', 495, 268, 10);
    cartouche();
  } else if (modele === 'exterieur') {
    // Jardin
    roomFill(30, 30, 580, 320, 'rgba(220,237,222,0.55)');
    // Bâtiment
    ctx.fillStyle = '#e2e8f0'; ctx.fillRect(80, 60, 220, 140);
    ctx.strokeStyle = MUR; ctx.lineWidth = 5; ctx.strokeRect(80, 60, 220, 140);
    label('Bâtiment', 190, 135);
    gapH(170, 197, 26); door(170, 200, 24, 0);
    // terrasse
    ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1.2; ctx.setLineDash([4, 4]);
    ctx.strokeRect(300, 130, 90, 70); ctx.setLineDash([]);
    label('Terrasse', 345, 170, 10);
    // haie (limite droite)
    ctx.strokeStyle = '#5d8f63'; ctx.lineWidth = 2.4;
    for (let y = 40; y < 340; y += 18) { ctx.beginPath(); ctx.arc(596, y + 9, 9, Math.PI * 0.6, Math.PI * 2.4); ctx.stroke(); }
    label('Haie', 596, 356, 10, '#5d8f63');
    // arbres
    [[470, 90], [430, 250], [180, 280]].forEach(p => {
      ctx.strokeStyle = '#5d8f63'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(p[0], p[1], 20, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, Math.PI * 2); ctx.stroke();
    });
    // conteneurs + compost + regards
    bins(320, 70); label('Conteneurs', 352, 110, 10);
    ctx.strokeStyle = '#7a5c3a'; ctx.lineWidth = 1.6; ctx.strokeRect(520, 290, 30, 30); label('Compost', 535, 336, 9, '#7a5c3a');
    [[340, 230], [260, 310]].forEach(p => {
      ctx.strokeStyle = '#64748b'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(p[0], p[1], 10, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p[0] - 7, p[1]); ctx.lineTo(p[0] + 7, p[1]); ctx.moveTo(p[0], p[1] - 7); ctx.lineTo(p[0], p[1] + 7); ctx.stroke();
    });
    label('Regard égout', 340, 256, 9); label('Regard', 260, 336, 9);
    cartouche();
  } else {
    // ---- Sous-sol / caves (défaut) ----
    roomFill(x0, y0, x1 - x0, y1 - y0);
    const cY0 = 164, cY1 = 206;
    roomFill(x0, cY0 + t, x1 - x0, cY1 - cY0 - 2 * t, 'rgba(226,232,240,0.7)');
    outer();
    wall(x0, cY0, x1 - x0, t); wall(x0, cY1 - t, x1 - x0, t);
    wall(195, y0, t, cY0 - y0); wall(320, y0, t, cY0 - y0); wall(445, y0, t, cY0 - y0);
    wall(240, cY1, t, y1 - cY1); wall(410, cY1, t, y1 - cY1);
    wall(410, 268, x1 - 410, t);
    // soupiraux (petites fenêtres)
    winH(120, y0 - T, 36); winH(250, y0 - T, 36); winH(380, y0 - T, 36); winH(500, y0 - T, 36);
    // portes couloir → pièces
    gapH(120, cY0, 26); door(120, cY0, 26, -Math.PI / 2);
    gapH(245, cY0, 26); door(245, cY0, 26, -Math.PI / 2);
    gapH(370, cY0, 26); door(370, cY0, 26, -Math.PI / 2);
    gapH(495, cY0, 26); door(495, cY0, 26, -Math.PI / 2);
    gapH(140, cY1 - t, 26); door(140, cY1, 26, 0);
    gapH(310, cY1 - t, 26); door(310, cY1, 26, 0);
    gapH(430, cY1 - t, 26); door(430, cY1, 26, 0);
    gapH(470, 268, 24); door(470, 268, 24, -Math.PI / 2);
    // accès couloir (depuis l'extérieur, mur gauche)
    gapV(x0 - T + (T - t) / 2, 172, 26); door(x0, 198, 26, -Math.PI / 2);
    // escalier (en haut à droite du bloc bas)
    stairs(465, 214, 40, 48, 8);
    bins(440, 286);
    // technique : chaudière (cercle) + boiler
    ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(110, 250, 16, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeRect(140, 236, 24, 28);
    label('Cave 1', 132, 110); label('Cave 2', 257, 110); label('Cave 3', 382, 110); label('Buanderie', 508, 110, 10);
    label('Couloir de cave', 320, 190, 10, '#64748b');
    label('Local technique', 150, 296, 10); sub('chaudière · boiler', 150, 310);
    label('Cave 4', 325, 270); label('Escalier', 442, 232, 9);
    label('Poubelles', 500, 312, 9);
    cartouche();
  }
  ctx.restore();
}

// Corrige un texte libre du diagnostic via Mistral (orthographe + formulation pro)
const _DIAG_AI_LABELS = {
  diagnostic: 'les observations du diagnostic',
  traitement: 'le traitement recommandé',
  conclusion: 'la conclusion / les recommandations',
  prevention: 'les recommandations de prévention',
  hygiene: 'les recommandations d\'hygiène au client',
};
async function diagAICorrect(field) {
  const ta = $('diag-ta-' + field); if (!ta || !_editingDiag) return;
  const btn = $('diag-ai-' + field);
  const txt = (ta.value || '').trim();
  if (!txt) { toast('✍️ Écris d\'abord quelques mots à corriger.', '#e6aa1e'); return; }
  if (!(DERATEK_CONFIG && DERATEK_CONFIG.mistral && DERATEK_CONFIG.mistral.apiKey)) {
    toast('⚠️ Clé Mistral non configurée.', '#e63946'); return;
  }
  const oldLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '🤖 Correction…'; }
  try {
    const systemPrompt =
      "Tu es l'assistant d'une entreprise suisse d'antinuisibles (DERATEK). " +
      "On te donne un texte brut destiné à " +
      (_diagType(_editingDiag) === 'rongeurs'
        ? "un rapport spécial rongeurs (dératisation), "
        : _diagType(_editingDiag) === 'blattes'
        ? "un rapport spécial blattes/cafards (désinsectisation), "
        : _diagType(_editingDiag) === 'fourmis'
        ? "un rapport spécial fourmis (désinsectisation), "
        : _diagType(_editingDiag) === 'punaises'
        ? "un rapport spécial punaises de lit (désinsectisation), "
        : "un rapport de diagnostic d'insectes xylophages (bois/charpentes), ") +
      "plus précisément " + (_DIAG_AI_LABELS[field] || 'une section du rapport') + ". " +
      "Corrige l'orthographe et la grammaire, et améliore la formulation pour un ton professionnel et factuel. " +
      "CONSERVE toutes les informations telles quelles : mesures, pourcentages, dimensions, noms d'insectes, produits, prix en CHF, délais. " +
      "N'invente AUCUNE information absente. Reste concis. " +
      "Réponds UNIQUEMENT par le texte corrigé (texte simple, sans Markdown, sans préambule ni commentaire).";
    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DERATEK_CONFIG.mistral.apiKey },
      body: JSON.stringify({
        model: DERATEK_CONFIG.mistral.model, max_tokens: 900, temperature: 0,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: txt }]
      })
    });
    if (!response.ok) { let m = 'API ' + response.status; try { const e = await response.json(); m = (e.error && e.error.message) || m; } catch (e) {} throw new Error(m); }
    const data = await response.json();
    let raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!raw) throw new Error('Réponse IA vide');
    raw = raw.replace(/```[a-z]*/gi, '').replace(/```/g, '').trim();
    ta.value = raw;
    _editingDiag[field] = raw;
    toast('✓ Corrigé par l\'IA — relis avant d\'enregistrer.', '#2d9e6b');
  } catch (err) {
    console.error('Diag IA error:', err);
    toast('⚠️ Erreur IA : ' + err.message, '#e63946');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = oldLabel; }
  }
}

function onDiagClientSelect(id) {
  const c = (DB.clients||[]).find(x => x.id === id);
  if (!c) { _editingDiag.clientId=''; return; }
  _editingDiag.clientId = c.id; _editingDiag.clientNom = c.nom || '';
  renderDiagEditor();
}
function autoFillDiagFromBon(numero) {
  if (!_editingDiag || !numero) return;
  const norm = s => String(s||'').replace(/\s+/g,'').toLowerCase();
  const bon = (DB.bons||[]).find(b => norm(b.numero) === norm(numero));
  if (!bon) { toast('Aucun bon trouvé', '#e63946'); return; }
  const cli = bon.geranceId ? (DB.clients||[]).find(c=>c.id===bon.geranceId) : null;
  const loc = bon.locataireId ? (DB.locataires||[]).find(l=>l.id===bon.locataireId) : null;
  _editingDiag.clientId = bon.geranceId || '';
  _editingDiag.clientNom = bon.geranceNom || (cli?cli.nom:'');
  _editingDiag.locataireNom = bon.locataireNom || '';
  _editingDiag.locataireAdresse = loc ? (loc.adresse||'') : (bon.immeuble||'');
  _editingDiag.batiment = bon.immeuble || _editingDiag.batiment;
  _editingDiag.bonId = bon.id;
  toast('✓ Rempli depuis le bon ' + bon.numero, '#2d9e6b');
  renderDiagEditor();
}
// statut : '' (inchangé), 'Brouillon' (continuer plus tard) ou 'Finalisé'.
// keepOpen : enregistre sans fermer la modale.
function saveDiag(statut, keepOpen) {
  if (!_editingDiag) return;
  if (statut) _editingDiag.statut = statut;
  if (!_editingDiag.statut) _editingDiag.statut = 'Brouillon';
  // L'image du schéma et les photos ne sont PAS stockées en base (espace) :
  // le PDF généré tient lieu d'archive. Les champs additionnels (méthode,
  // zones, traitement, suivi…) sont repliés dans la colonne "diagnostic".
  const toSave = _diagPack(JSON.parse(JSON.stringify(_editingDiag)));
  delete toSave.schema;
  delete toSave.photos;
  delete toSave.signature;
  const list = DB.diagnostics;
  const i = list.findIndex(x => x.id === toSave.id);
  if (i >= 0) list[i] = toSave; else list.push(toSave);
  DB.diagnostics = list;
  // Rapport (rongeurs / blattes / fourmis / bois) FINALISÉ et lié à un bon :
  // le bon passe « terminé » et est marqué « rapport fait » (ruban vert ✅), comme un rapport général.
  if (_editingDiag.statut === 'Finalisé' && _editingDiag.bonId) {
    const bons = DB.bons;
    const bon = bons.find(b => b.id === _editingDiag.bonId);
    if (bon) {
      const stPrev = bon.statut || '';
      if (stPrev !== 'a-facturer' && stPrev !== 'termine') bon.statut = 'termine';
      bon.probleme = _bonAssembleProbleme(_bonProblemeClean(bon), _bonDatesInterv(bon), _bonAffecte(bon), _bonNote(bon), true, '', _bonColor(bon));
      DB.bons = bons;
      if (typeof renderBons === 'function') renderBons();
    }
  }
  renderDiagnostics();
  if (keepOpen) { toast('💾 Enregistré — tu peux continuer à travailler.', '#0f766e'); return; }
  if (_editingDiag.statut === 'Finalisé') { const _dt = _diagType(_editingDiag); toast('✓ ' + (_dt==='rongeurs'?'Rapport rongeurs':_dt==='blattes'?'Rapport blattes':_dt==='fourmis'?'Rapport fourmis':_dt==='punaises'?'Rapport punaises de lit':'Diagnostic bois') + ' finalisé. Pense à télécharger le PDF pour garder le schéma et les photos.', '#2d9e6b'); }
  else toast('🕒 Enregistré comme brouillon — à reprendre plus tard.', '#d97706');
  closeModal('modal-diag');
}
// Génère le PDF depuis l'éditeur ouvert (avec l'image du schéma en mémoire)
function downloadCurrentDiagPDF() {
  if (!_editingDiag) return;
  const c = $('diag-schema-canvas');
  if (c) { try { _editingDiag.schema = c.toDataURL('image/png'); } catch (e) {} }
  if (_diagType(_editingDiag) === 'rongeurs') _genRongeursPDF(_editingDiag);
  else if (_diagType(_editingDiag) === 'blattes') _genBlattesPDF(_editingDiag);
  else if (_diagType(_editingDiag) === 'fourmis') _genFourmisPDF(_editingDiag);
  else if (_diagType(_editingDiag) === 'punaises') _genPunaisesPDF(_editingDiag);
  else _genDiagPDF(_editingDiag);
}
function confirmDeleteDiag(id, label) {
  $('confirm-msg').textContent = `Supprimer le diagnostic "${label}" ?`;
  $('confirm-btn').onclick = () => {
    DB.diagnostics = DB.diagnostics.filter(d => d.id !== id);
    closeModal('modal-confirm'); renderDiagnostics(); toast('Diagnostic supprimé', '#e63946');
  };
  openModal('modal-confirm');
}
function renderDiagnostics() {
  // Les rapports spéciaux sont désormais affichés SOUS les rubans gérance du tableau
  // des rapports classiques (voir renderRapports). On vide donc l'ancienne section
  // séparée et on rafraîchit le tableau des rapports.
  const box = $('diagnostics-section'); if (box) box.innerHTML = '';
  if (typeof renderRapports === 'function') renderRapports();
}
function downloadDiagPDF(id) {
  const d = (DB.diagnostics||[]).find(x => x.id === id);
  if (!d) { toast('Diagnostic introuvable', '#e63946'); return; }
  const u = _diagUnpack(d);
  if (_diagType(u) === 'rongeurs') _genRongeursPDF(u); else if (_diagType(u) === 'blattes') _genBlattesPDF(u); else if (_diagType(u) === 'fourmis') _genFourmisPDF(u); else if (_diagType(u) === 'punaises') _genPunaisesPDF(u); else _genDiagPDF(u);
}
// Grille d'informations sur 2 colonnes au-dessus du ruban — même style que le
// rapport d'intervention classique (rows2col de pdf.js) : libellé gris en
// majuscules, valeur en gras, rangées alternées grisées. Retourne le nouveau y.
function _diagRows2Col(doc, pairs, y, M, CW) {
  const items = (pairs || []).filter(p => p && p[1]);
  if (!items.length) return y;
  const gap = 6, colW = (CW - gap) / 2, colTextW = colW - 6;
  for (let i = 0; i < items.length; i += 2) {
    const left = items[i], right = items[i+1];
    doc.setFont('helvetica','normal'); doc.setFontSize(8.5);
    const lL = doc.splitTextToSize(String(left[1]), colTextW);
    const rL = right ? doc.splitTextToSize(String(right[1]), colTextW) : [];
    const cellH = Math.max(8, lL.length*5 + 5, rL.length*5 + 5);
    if ((Math.floor(i/2) % 2) === 1) { doc.setFillColor(249,250,251); doc.rect(M, y, CW, cellH, 'F'); }
    const cell = (it, lines, x) => {
      doc.setTextColor(107,114,128); doc.setFont('helvetica','normal'); doc.setFontSize(7.5);
      doc.text(String(it[0]).toUpperCase(), x+2, y+4);
      doc.setFont('helvetica','bold'); doc.setFontSize(8.5); doc.setTextColor(31,41,55);
      doc.text(lines, x+2, y+9);
    };
    cell(left, lL, M);
    if (right) cell(right, rL, M + colW + gap);
    doc.setDrawColor(229,231,235); doc.setLineWidth(0.2); doc.line(M, y+cellH, M+CW, y+cellH);
    y += cellH;
  }
  doc.setTextColor(0);
  return y;
}

// Infos complémentaires tirées du bon enregistré (bonId) : n° de bon, gérant,
// téléphone, email, adresse du client, tél/logement du locataire. Retourne
// null si aucun bon n'est lié au rapport.
function _diagBonInfo(d) {
  if (typeof DB === 'undefined' || !d || !d.bonId) return null;
  const bon = (DB.bons || []).find(b => b.id === d.bonId);
  if (!bon) return null;
  const cli = (bon.geranceId ? (DB.clients||[]).find(c => c.id === bon.geranceId) : null)
           || (d.clientId ? (DB.clients||[]).find(c => c.id === d.clientId) : null);
  const loc = bon.locataireId ? (DB.locataires||[]).find(l => l.id === bon.locataireId) : null;
  const cleanContact = s => String(s||'').replace(/^\[ROLE:[^\]]*\]/, '').trim();
  return {
    bonNumero: bon.numero || '',
    gerant: bon.gerantNom || (cli ? cleanContact(cli.contact) : ''),
    tel: bon.gerantTel || (cli ? (cli.tel || '') : ''),
    email: bon.gerantEmail || (cli ? (cli.email || '') : ''),
    clientAdresse: cli ? [cli.adresse, [cli.npa, cli.ville].filter(Boolean).join(' ')].filter(Boolean).join(' ') : '',
    locTel: loc ? (loc.tel || '') : '',
    logement: (loc ? (loc.adresse || '') : '') || (bon.immeuble || ''),
  };
}

// Bandeau bien visible des dates d'intervention en haut de la page 1
function _diagDatesStrip(doc, d, y, M, CW) {
  const items = [
    ['1RE INTERVENTION', d.dateInt1], ['2E INTERVENTION', d.dateInt2],
    ['3E INTERVENTION', d.dateInt3], ['PROCHAIN PASSAGE', d.dateProchain],
  ].filter(p => p[1]);
  if (!items.length) return y;
  const h = 13;
  doc.setFillColor(255, 248, 230); doc.setDrawColor(244, 166, 35); doc.setLineWidth(0.4);
  doc.roundedRect(M, y, CW, h, 2, 2, 'FD');
  const colW = CW / items.length;
  items.forEach((it, i) => {
    const x = M + i*colW + 5;
    if (i) { doc.setDrawColor(240, 220, 170); doc.setLineWidth(0.3); doc.line(M + i*colW, y+2.5, M + i*colW, y+h-2.5); }
    doc.setFont('helvetica','normal'); doc.setFontSize(6.8); doc.setTextColor(160, 115, 20);
    doc.text(it[0], x, y+4.6);
    doc.setFont('helvetica','bold'); doc.setFontSize(10.5); doc.setTextColor(13,27,62);
    doc.text(fmtDate(it[1]) || '', x, y+10.3);
  });
  doc.setTextColor(0);
  return y + h + 4;
}

function _genDiagPDF(d, mode) {
  if (!d) { if (mode !== 'blob') toast('Diagnostic introuvable', '#e63946'); return; }
  if (!window.jspdf || !window.jspdf.jsPDF) { toast('Librairie PDF non chargée', '#e63946'); return; }
  const co = DERATEK_CONFIG.company;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:'mm', format:'a4' });
  const M = 20, R = 190, CW = R - M;            // marges gauche/droite, largeur utile
  const NAVY = [13,27,62], BROWN = [139,69,19], GREY = [110,110,110];
  const MAX_Y = 270;                             // plancher avant pied de page
  let y = 0;

  // --- Helpers --------------------------------------------------------
  const newPage = () => { doc.addPage(); y = 20; };
  const ensure = (h) => { if (y + h > MAX_Y) newPage(); };
  // keep = hauteur minimale de contenu à garder avec le titre (anti-titre orphelin)
  const section = (titre, keep) => {
    ensure(14 + (keep || 0));
    doc.setFillColor(BROWN[0],BROWN[1],BROWN[2]); doc.rect(M, y-3.2, 2.4, 4.4, 'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(NAVY[0],NAVY[1],NAVY[2]);
    doc.text(titre, M+4.5, y);
    doc.setDrawColor(BROWN[0],BROWN[1],BROWN[2]); doc.setLineWidth(0.4); doc.line(M, y+1.8, R, y+1.8);
    y += 7.5; doc.setTextColor(0); doc.setFont('helvetica','normal'); doc.setFontSize(10);
  };
  const field = (lbl, val, indent) => {
    if (!val) return;
    const x = indent || M;
    doc.setFont('helvetica','bold'); doc.setFontSize(9.5);
    const vx = x + Math.max(40, doc.getTextWidth(lbl + ' :') + 3);
    const lines = doc.splitTextToSize(String(val), R - vx - 2);
    ensure(Math.max(lines.length*4.8, 5.5) + 2);
    doc.setTextColor(60);
    doc.text(lbl + ' :', x, y);
    doc.setFont('helvetica','normal'); doc.setTextColor(0);
    doc.text(lines, vx, y);
    y += Math.max(lines.length*4.8, 5.5);
  };
  const para = (txt) => {
    if (!txt) return;
    doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(0);
    doc.splitTextToSize(String(txt), CW).forEach(ln => { ensure(6); doc.text(ln, M, y); y += 4.9; });
  };
  const badge = (txt, rgb, x, yy) => {
    doc.setFont('helvetica','bold'); doc.setFontSize(8.5);
    const w = doc.getTextWidth(txt) + 6;
    doc.setFillColor(rgb[0],rgb[1],rgb[2]);
    doc.roundedRect(x, yy-4.1, w, 5.6, 2.8, 2.8, 'F');
    doc.setTextColor(255); doc.text(txt, x+3, yy);
    doc.setTextColor(0);
    return w;
  };
  const GRAV_RGB = { 'Faible':[45,158,107], 'Modérée':[230,170,30], 'Importante':[235,120,40], 'Critique (structure menacée)':[230,57,70] };
  const ACT_RGB  = { 'Active':[230,57,70], 'Ancienne':[120,120,120], 'Mixte (active + ancienne)':[235,120,40] };

  // --- En-tête : logo + coordonnées, destinataire à droite -------------
  // En-tête horizontal — identique aux factures (downloadDocPDF)
  // Bureau émetteur choisi dans le rapport (Neuchâtel par défaut)
  const bu = (typeof BUREAUX !== 'undefined' && BUREAUX.find(b => b.id === d.bureau)) || { rue: co.rue, npa: co.npa, ville: co.ville, tel: co.tel };
  const logoW = 62, logoH = logoW*199/900;
  const logoY = 13;
  const headerFiletY = logoY + logoH + 5;
  if (typeof LOGO_B64 !== 'undefined') { try { doc.addImage(LOGO_B64,'PNG',20,logoY,logoW,logoH); } catch(e){} }
  else { doc.setFont('helvetica','bold'); doc.setFontSize(20); doc.setTextColor(13,27,62); doc.text('DERATEK', 20, 23); }
  const cy0 = logoY + 4;
  doc.setFont('helvetica','normal'); doc.setFontSize(8.5); doc.setTextColor(70);
  [bu.rue, `${bu.npa} ${bu.ville}`, 'Tél. '+(bu.tel||co.tel)].forEach((l,i)=>{ if(l) doc.text(l, 92, cy0 + i*4.4); });
  [co.email, co.tva].forEach((l,i)=>{ if(l) doc.text(l, 146, cy0 + i*4.4); });
  doc.setTextColor(13,27,62);
  try { doc.textWithLink('www.deratek.ch', 146, cy0 + 2*4.4, { url:'https://www.deratek.ch' }); } catch(e) { doc.text('www.deratek.ch', 146, cy0 + 2*4.4); }
  doc.setTextColor(0);
  doc.setDrawColor(200,205,213); doc.setLineWidth(0.4); doc.line(20, headerFiletY, 190, headerFiletY);
  // Date à droite sous le filet (comme les factures)
  doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(13,27,62);
  doc.text((bu.ville||'Neuchâtel') + ', le ' + (fmtDate(d.dateDoc)||''), 190, headerFiletY + 5, { align:'right' });
  doc.setFont('helvetica','normal'); doc.setTextColor(0);
  // Informations sur 2 colonnes au-dessus du ruban (style rapport classique,
  // enrichies depuis le bon enregistré quand il y en a un)
  const bi = _diagBonInfo(d) || {};

  // --- Bandeau titre (juste sous l'en-tête) -----------------------------
  y = headerFiletY + 9;
  doc.setFillColor(NAVY[0],NAVY[1],NAVY[2]);
  doc.roundedRect(M, y, CW, 16, 2, 2, 'F');
  doc.setFont('helvetica','bold'); doc.setFontSize(14); doc.setTextColor(255);
  doc.text((d.doctype==='Expertise'?'EXPERTISE':'RAPPORT') + ' N° ' + (d.numero||''), M+6, y+6.8);
  doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.setTextColor(225,228,238);
  doc.text('Insectes xylophages — bois & charpentes', M+6, y+12.4);
  doc.setFontSize(10.5); doc.setFont('helvetica','bold'); doc.setTextColor(255);
  doc.text(fmtDate(d.dateDoc)||'', R-6, y+6.8, { align:'right' });
  doc.setTextColor(0);
  y += 21;

  // Informations sur 2 colonnes (style rapport classique, enrichies du bon)
  y = _diagRows2Col(doc, [
    ['Technicien', d.noTech ? '' : d.tech],
    ['Client', [(d.clientNom||''), bi.clientAdresse].filter(Boolean).join('\n')],
    ['N° bon de commande', bi.bonNumero],
    ['Adresse d\'intervention', d.locataireAdresse],
    ['Gérant', bi.gerant],
    ['Téléphone', bi.tel],
    ['Email', bi.email],
    ['Locataire', d.locataireNom],
    ['Tél. locataire', bi.locTel],
    ['Logement', (bi.logement && bi.logement !== d.locataireAdresse) ? bi.logement : ''],
    ['Bâtiment / charpente', d.batiment],
    ['Méthode d\'inspection', d.methode],
    ['Zones inspectées', d.zones],
    ['N° intervention', bi.bonNumero],
  ], y, M, CW);

  // Dates d'intervention bien visibles, sous la grille (à la place du ruban)
  y = _diagDatesStrip(doc, d, y + 5, M, CW);
  y += 1;

  // --- Synthèse : activité / gravité / étendue / humidité --------------
  const synth = [
    ['ACTIVITÉ', d.activite, ACT_RGB[d.activite]],
    ['GRAVITÉ', d.gravite, GRAV_RGB[d.gravite]],
    ['ÉTENDUE', d.etendue, null],
  ];
  if (!d.noHum) synth.push(['HUMIDITÉ DU BOIS', d.humidite, null]);
  if (synth.some(s => s[1])) {
    ensure(20);
    const colW = CW/synth.length;
    doc.setDrawColor(225,228,238); doc.setLineWidth(0.3);
    doc.roundedRect(M, y, CW, 15, 2, 2, 'D');
    synth.forEach((s, i) => {
      const cx = M + i*colW + 4;
      if (i) doc.line(M + i*colW, y+2.5, M + i*colW, y+12.5);
      doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(GREY[0],GREY[1],GREY[2]);
      doc.text(s[0], cx, y+5);
      if (!s[1]) { doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(150); doc.text('—', cx, y+11.2); return; }
      if (s[2]) { badge(String(s[1]).replace(' (structure menacée)',''), s[2], cx, y+11.2); }
      else {
        doc.setFont('helvetica','bold'); doc.setFontSize(9.5); doc.setTextColor(NAVY[0],NAVY[1],NAVY[2]);
        doc.text(doc.splitTextToSize(String(s[1]), colW-8)[0]||'', cx, y+11.2);
      }
    });
    doc.setTextColor(0);
    y += 21;
  }

  // --- Constatations ----------------------------------------------------
  section('Constatations');
  field('Insectes détectés', (d.insectes||[]).join(', '));
  field('Éléments / bois touchés', d.elementsTouches);
  if (d.diagnostic) {
    y += 1.5;
    doc.setFont('helvetica','bold'); doc.setFontSize(9.5); doc.setTextColor(60);
    ensure(8); doc.text('Observations :', M, y); y += 5; doc.setTextColor(0);
    para(d.diagnostic);
  }

  // --- Schéma de la charpente + légende ---------------------------------
  if (d.schema && !d.noPlan) {
    const schemaH = 100;
    if (y + schemaH + 22 > MAX_Y) newPage();
    y += 3; section('Schéma de la charpente');
    try {
      doc.addImage(d.schema, 'PNG', M, y, 170, schemaH);
      doc.setDrawColor(225,228,238); doc.rect(M, y, 170, schemaH, 'D');
      y += schemaH + 5;
      // Légende des couleurs d'annotation
      let lx = M;
      DIAG_COLORS.forEach(c => {
        const rgb = [parseInt(c.hex.slice(1,3),16), parseInt(c.hex.slice(3,5),16), parseInt(c.hex.slice(5,7),16)];
        doc.setFillColor(rgb[0],rgb[1],rgb[2]); doc.circle(lx+1.5, y-1.2, 1.5, 'F');
        doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(70);
        doc.text(c.label, lx+4.5, y);
        lx += 4.5 + doc.getTextWidth(c.label) + 8;
      });
      doc.setTextColor(0);
      y += 6;
    } catch (e) {}
  }

  // --- Photos de l'inspection -------------------------------------------
  const photos = (!d.noPhotos && Array.isArray(d.photos)) ? d.photos.filter(p => p && p.data && p.use !== false) : [];
  if (photos.length) {
    y += 2; section('Photos de l\'inspection', 62);
    const pw = (CW - 6) / 2, ph = 58;
    photos.forEach((p, i) => {
      const col = i % 2;
      if (col === 0 && y + ph + 8 > MAX_Y) newPage();
      const px = M + col*(pw+6);
      try {
        doc.addImage(p.data, 'JPEG', px, y, pw, ph);
        doc.setDrawColor(225,228,238); doc.rect(px, y, pw, ph, 'D');
        const meta = (typeof _diagPhotoMeta === 'function') ? _diagPhotoMeta(p) : '';
        const cap = ['Photo ' + (i+1), p.caption, meta ? '(' + meta + ')' : ''].filter(Boolean).join(' — ');
        doc.setFont('helvetica','italic'); doc.setFontSize(7.5); doc.setTextColor(70);
        doc.text(doc.splitTextToSize(cap, pw).slice(0, 2), px, y+ph+3.6);
        doc.setTextColor(0);
      } catch (e) {}
      if (col === 1 || i === photos.length-1) y += ph + 8;
    });
    y += 2;
  }

  // --- Fiches descriptives des insectes détectés -------------------------
  const fiches = (d.insectes||[]).filter(n => INSECTES_BOIS_INFO[n]);
  if (fiches.length) {
    y += 2; section('Fiches des insectes détectés', 38);
    fiches.forEach(nom => {
      const f = INSECTES_BOIS_INFO[nom];
      // Hauteur estimée de la fiche pour la garder entière sur une page
      doc.setFont('helvetica','normal'); doc.setFontSize(9.5);
      const estH = 13 + [f.bois, f.indices, f.cycle, f.risque].reduce((s,v)=> s + Math.max(doc.splitTextToSize(String(v),135).length*4.8, 5.5), 0);
      ensure(Math.min(estH, 75));
      doc.setFillColor(247,242,235);
      doc.roundedRect(M, y-1, CW, 7, 1.5, 1.5, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(10);
      const nomW = doc.getTextWidth(nom);
      doc.setTextColor(BROWN[0],BROWN[1],BROWN[2]);
      doc.text(nom, M+3, y+3.6);
      doc.setFont('helvetica','italic'); doc.setFontSize(9); doc.setTextColor(110);
      doc.text(f.latin, M+3+nomW+4, y+3.6);
      doc.setTextColor(0);
      y += 10;
      field('Bois attaqués', f.bois, M+3);
      field('Indices typiques', f.indices, M+3);
      field('Cycle de vie', f.cycle, M+3);
      field('Risque', f.risque, M+3);
      y += 3;
    });
  }

  // --- Traitement recommandé & suivi -------------------------------------
  if (d.traitement || d.suivi) {
    y += 2; section('Traitement recommandé', 12);
    para(d.traitement);
    if (d.suivi) { y += 1.5; field('Suivi / garantie', d.suivi); }
  }

  // --- Proposition de contrat annuel --------------------------------------
  if (d.contrat) {
    y += 2; section('Proposition de contrat annuel', 18);
    para("Au vu de la situation constatée, une proposition de contrat annuel peut être envisagée afin d'assurer un suivi régulier, de limiter les risques de récidive et de maintenir une surveillance préventive des zones sensibles.");
    y += 1.5;
    field('Passages annuels proposés', d.contratPassages);
    field('Montant estimatif', d.contratMontant);
    field('Zones concernées', d.contratZones);
    field('Remarques', d.contratRem);
  }

  // --- Conclusion (encadré) ----------------------------------------------
  if (d.conclusion) {
    // On fixe la police AVANT de découper : sinon le calcul de largeur se fait avec
    // la taille laissée par la section précédente et les lignes débordent du cadre.
    doc.setFont('helvetica','normal'); doc.setFontSize(10);
    const lines = doc.splitTextToSize(String(d.conclusion), CW-13);
    const boxH = lines.length*4.9 + 8;
    if (y + boxH + 12 > MAX_Y) newPage();
    y += 2; section('Conclusion / recommandations');
    doc.setFillColor(240,243,250); doc.setDrawColor(NAVY[0],NAVY[1],NAVY[2]); doc.setLineWidth(0.3);
    doc.roundedRect(M, y-2, CW, boxH, 2, 2, 'FD');
    doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(NAVY[0],NAVY[1],NAVY[2]);
    lines.forEach((ln, i) => doc.text(ln, M+5, y+3.5 + i*4.9));
    doc.setTextColor(0);
    y += boxH + 4;
  }

  // --- Signature -----------------------------------------------------------
  if (!d.noSign) {
    ensure(32);
    y += 8;
    doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.setTextColor(40);
    doc.text(bu.ville + ', le ' + (fmtDate(d.dateDoc)||''), M, y);
    doc.text('DERATEK' + (d.tech && !d.noTech ? ' — ' + d.tech : ''), 120, y);
    if (d.signature) { try { doc.addImage(d.signature, 'PNG', 120, y+1.5, 45, 15.75); } catch (e) {} }
    doc.setDrawColor(120); doc.setLineWidth(0.3); doc.line(120, y+18, 186, y+18);
    doc.setFontSize(8); doc.setTextColor(GREY[0],GREY[1],GREY[2]);
    doc.text('Signature', 120, y+21.5);
    doc.setTextColor(0);
  }

  // --- Pied de page sur toutes les pages ------------------------------------
  const nb = doc.getNumberOfPages();
  for (let i = 1; i <= nb; i++) {
    doc.setPage(i);
    doc.setDrawColor(BROWN[0],BROWN[1],BROWN[2]); doc.setLineWidth(0.3); doc.line(M, 283, R, 283);
    doc.setFont('helvetica','normal'); doc.setFontSize(7.5); doc.setTextColor(GREY[0],GREY[1],GREY[2]);
    doc.text('DERATEK Professional Pest Control — ' + co.rue + ', ' + co.npa + ' ' + co.ville + ' — ' + co.email, M, 287.5);
    doc.text('Page ' + i + '/' + nb, R, 287.5, { align:'right' });
    doc.setTextColor(0);
  }

  if (mode === 'blob') return doc.output('blob');
  doc.save('diagnostic-bois-' + (d.numero||'doc').replace(/[^a-z0-9]+/gi,'-').toLowerCase() + '.pdf');
  toast('✓ PDF diagnostic téléchargé', '#2d9e6b');
}

// ---- Aperçu PDF en direct (diagnostic bois & rapport rongeurs) ----
let _diagPreviewOn = false;
let _diagPreviewTimer = null;
let _diagPreviewUrl = null;
function _syncDiagPreviewPane() {
  const pane = $('diag-preview-pane'), box = $('modal-diag-box'), btn = $('diag-preview-btn');
  if (pane) pane.style.display = _diagPreviewOn ? 'block' : 'none';
  if (box) box.style.maxWidth = _diagPreviewOn ? '1600px' : '1020px';
  if (btn) { btn.classList.toggle('btn-navy', _diagPreviewOn); btn.classList.toggle('btn-ghost', !_diagPreviewOn); }
}
function toggleDiagPreview() {
  _diagPreviewOn = !_diagPreviewOn;
  _syncDiagPreviewPane();
  if (_diagPreviewOn) refreshDiagPreview(true);
}
function refreshDiagPreview(now) {
  if (!_diagPreviewOn || !_editingDiag) return;
  clearTimeout(_diagPreviewTimer);
  _diagPreviewTimer = setTimeout(() => {
    if (!_diagPreviewOn || !_editingDiag) return;
    const c = $('diag-schema-canvas');
    if (c) { try { _editingDiag.schema = c.toDataURL('image/png'); } catch (e) {} }
    try {
      const _dt = _diagType(_editingDiag);
      const blob = _dt === 'rongeurs' ? _genRongeursPDF(_editingDiag, 'blob')
        : _dt === 'blattes' ? _genBlattesPDF(_editingDiag, 'blob')
        : _dt === 'fourmis' ? _genFourmisPDF(_editingDiag, 'blob')
        : _genDiagPDF(_editingDiag, 'blob');
      if (!blob) return;
      const ifr = $('diag-pdf-preview'); if (!ifr) return;
      if (_diagPreviewUrl) { try { URL.revokeObjectURL(_diagPreviewUrl); } catch (e) {} }
      _diagPreviewUrl = URL.createObjectURL(blob);
      ifr.src = _diagPreviewUrl + '#toolbar=0&navpanes=0&view=FitH';
    } catch (err) { console.warn('Aperçu PDF diag :', err); }
  }, now === true ? 0 : 700);
}

// ============================================================
// RAPPORT SPÉCIAL RONGEURS (même table "diagnostics", numéros RG-)
// ============================================================
const RONGEURS_ESPECES = ['Rat brun (surmulot)', 'Rats d\'égout', 'Rat noir', 'Souris domestique', 'Mulot', 'Campagnol', 'Loir / Lérot', 'Fouine', 'Chauves-souris'];
const RONGEURS_SIGNES = ['Déjections', 'Traces de gras (frottements)', 'Rongements / dégâts matériels', 'Terriers / galeries', 'Bruits (grattements)', 'Odeur d\'urine', 'Empreintes / coulées', 'Denrées entamées', 'Nids'];
const RONGEURS_MATERIEL = [
  'Postes d\'appâtage sécurisés', 'Poste d\'appâtage sécurisé rats', 'Poste d\'appâtage sécurisé souris',
  'Boîtes d\'appâtage sécurisées', 'Tunnel Speed Break Pro Rats', 'Tunnel Speed Break Pro Souris',
  'Blocs hydrofuges', 'Pâte fraîche', 'Céréales / grains',
  'Pièges mécaniques', 'Tapettes mécaniques', 'Postes à souris', 'Piège à capture vive', 'Plaques de glu',
  'Percement de trous 5 mm au plafond', 'Percement de trous 5 mm dans les zones techniques',
  'Injection de produit dans les cavités', 'Grillage / colmatage', 'Caméra / endoscope',
];
const RONGEURS_RODENTICIDES = ['Wax Block', 'Talon Inject Pro', 'Racumin Injection', 'Brodifacoum', 'Bromadiolone', 'Difénacoum', 'Diféthialone', 'Flocoumafen', 'Aucun rodenticide utilisé'];
const SUIVI_OPTIONS = ['Traitement résolu', 'Traitement en cours', 'Prochain passage à prévoir', 'Deuxième passage à prévoir', 'Troisième passage à prévoir', 'Contrôle de suivi à prévoir', 'Détection à prévoir', 'Surveillance recommandée', 'Dossier à clôturer', 'Proposition de contrat annuel recommandée'];
const RONGEURS_ACTIONS = [
  'Contrôle des consommations dans les postes d\'appâtage sécurisés',
  'Remplacement des appâts consommés si nécessaire',
  'Maintien du dispositif en place à titre préventif',
  'Retrait des appâts et des dispositifs en fin de traitement',
];
const RONGEUR_COLORS = [
  { hex: '#e63946', label: 'Activité confirmée' },
  { hex: '#f4a261', label: 'À surveiller' },
  { hex: '#2a6fdb', label: 'Poste / piège' },
  { hex: '#2d9e6b', label: 'RAS / sécurisé' },
];
// Fiches descriptives des espèces — incluses dans le PDF pour chaque espèce cochée
const RONGEURS_INFO = {
  'Rat brun (surmulot)': {
    latin: 'Rattus norvegicus',
    habitat: 'Caves, égouts, terriers extérieurs, niveaux bas — excellent nageur',
    indices: 'Déjections en capsule de 17–20 mm, traces de gras le long des plinthes, terriers avec déblais, coulées marquées',
    biologie: '250–500 g ; néophobe (méfiant envers les nouveautés) ; jusqu\'à 5–7 portées par an de 6–12 petits',
    risque: 'Dégâts matériels importants (câbles, isolation), contamination des denrées, vecteur de leptospirose et salmonelles',
  },
  'Rat noir': {
    latin: 'Rattus rattus',
    habitat: 'Combles, greniers, faux plafonds — grimpeur agile, niveaux hauts',
    indices: 'Déjections fusiformes de 8–12 mm dispersées, traces de gras sur poutres et câbles, bruits en hauteur la nuit',
    biologie: '150–250 g, plus fin et plus agile que le surmulot ; 3–6 portées par an',
    risque: 'Dégâts aux toitures et isolations, contamination des stocks ; souvent en hauteur, postes à placer en conséquence',
  },
  'Souris domestique': {
    latin: 'Mus musculus',
    habitat: 'Intérieur des bâtiments : cuisines, doublages, arrière-cuisines, réserves',
    indices: 'Déjections de 3–8 mm en grand nombre, grignotages multiples, odeur d\'urine caractéristique, nids en matériaux déchiquetés',
    biologie: '15–30 g ; curieuse (contrairement aux rats) ; reproduction très rapide : 5–10 portées par an',
    risque: 'Contamination étendue des denrées (grignote partout par petites quantités), dégâts électriques',
  },
  'Mulot': {
    latin: 'Apodemus sylvaticus',
    habitat: 'Extérieur (jardins, champs) ; entre dans les caves, garages et réserves à l\'automne',
    indices: 'Réserves de graines cachées, déjections proches de celles de la souris, présence saisonnière',
    biologie: 'Grands yeux et grandes oreilles, excellent sauteur ; 2–4 portées par an',
    risque: 'Dégâts aux stocks et semences ; intrusion généralement saisonnière — l\'exclusion suffit souvent',
  },
  'Campagnol': {
    latin: 'Microtus spp. / Arvicola terrestris',
    habitat: 'Extérieur : pelouses, jardins, vergers — galeries superficielles',
    indices: 'Monticules de terre aplatis, galeries à fleur de sol, végétaux sectionnés au ras',
    biologie: 'Herbivore strict, actif jour et nuit toute l\'année',
    risque: 'Dégâts aux racines, bulbes et jeunes arbres ; rarement à l\'intérieur des bâtiments',
  },
  'Loir / Lérot': {
    latin: 'Glis glis / Eliomys quercinus',
    habitat: 'Combles, isolations de toiture, cabanons — actif la nuit, hiberne d\'octobre à avril',
    indices: 'Bruits nocturnes très marqués (courses, roulements), déjections groupées, isolation déplacée en boules',
    biologie: 'Nocturne, hibernant ; 1 portée par an',
    risque: 'Espèce protégée : pas de rodenticide — capture et exclusion (grillager les accès) uniquement',
  },
  'Rats d\'égout': {
    latin: 'Rattus norvegicus (population des canalisations)',
    habitat: 'Réseaux d\'égouts et canalisations, remontées par les sauts de loup, colonnes de chute et regards défectueux',
    indices: 'Apparitions près des écoulements, déjections de 17–20 mm, traces de gras autour des regards, bruits dans les colonnes',
    biologie: 'Excellent nageur, remonte les conduites verticales ; colonies importantes dans les réseaux',
    risque: 'Contamination (leptospirose), dégâts aux canalisations ; traitement en collaboration avec un contrôle des réseaux (clapets anti-retour, regards étanches)',
  },
  'Chauves-souris': {
    latin: 'Chiroptera (pipistrelles et autres espèces)',
    habitat: 'Combles, derrière les volets et bardages, fissures de façade — colonies estivales de mise bas',
    indices: 'Guano sous les points de sortie (déjections friables qui s\'effritent, paillettes brillantes de restes d\'insectes), traces brunes aux ouvertures, cris au crépuscule',
    biologie: 'Insectivores nocturnes, très utiles ; hibernation en hiver, colonies de mise bas en été',
    risque: 'Toutes les espèces sont strictement protégées en Suisse (LPN) : aucun traitement ni capture — cohabitation ou exclusion douce uniquement hors période de reproduction, en accord avec le centre de coordination chauves-souris (CCO)',
  },
  'Fouine': {
    latin: 'Martes foina',
    habitat: 'Combles, granges, garages — active la nuit, gîte dans les isolations de toiture',
    indices: 'Bruits nocturnes forts (courses, cris), déjections torsadées à restes de poils/noyaux, restes de proies, isolation éventrée, câbles de voiture rongés',
    biologie: 'Carnivore solitaire et territorial, nocturne ; 1 portée par an au printemps',
    risque: 'Dégâts importants à l\'isolation et aux câbles ; pas de rodenticide — exclusion, répulsifs et capture selon la réglementation cantonale (animal protégé par la loi sur la chasse)',
  },
};

function openNewRongeurs() {
  _editingDiag = {
    id: newId(), numero: _nextDiagNumero('RG'), dateDoc: today(), tech: '',
    clientId: '', clientNom: '', locataireNom: '', locataireAdresse: '',
    batiment: '', bonId: '', insectes: [], elementsTouches: '',
    activite: '', gravite: '', zones: '', diagnostic: '', conclusion: '',
    traitement: '', suivi: '', prevention: '', signes: [], postes: [], materiel: [],
    rodenticides: [], actions: [], photos: [],
    bureau: 'ne', doctype: 'Rapport', noPlan: '', noPhotos: '', noTech: '', statut: '', ruban: '', noSign: '1',
    rodenticideAutre: '', postesNb: '', suiviRem: '',
    contrat: '', contratPassages: '', contratMontant: '', contratZones: '', contratRem: '',
    dateInt1: '', dateInt2: '', dateInt3: '', dateProchain: ''
  };
  renderDiagEditor(); openModal('modal-diag');
}
// Coche/décoche un élément d'une liste du rapport (générique)
function toggleDiagList(field, nom, checked) {
  if (!_editingDiag) return;
  const set = new Set(_editingDiag[field] || []);
  if (checked) set.add(nom); else set.delete(nom);
  _editingDiag[field] = [...set];
}
function toggleRongeurSigne(nom, checked) {
  if (!_editingDiag) return;
  const set = new Set(_editingDiag.signes || []);
  if (checked) set.add(nom); else set.delete(nom);
  _editingDiag.signes = [...set];
}
function toggleRongeurMateriel(nom, checked) {
  if (!_editingDiag) return;
  const set = new Set(_editingDiag.materiel || []);
  if (checked) set.add(nom); else set.delete(nom);
  _editingDiag.materiel = [...set];
}
// --- Postes d'appâtage / pièges ---
function addRongeurPoste() {
  if (!_editingDiag) return;
  if (!Array.isArray(_editingDiag.postes)) _editingDiag.postes = [];
  _editingDiag.postes.push({ emplacement: '', produit: '' });
  renderRongeursPostes();
}
function removeRongeurPoste(i) {
  if (!_editingDiag || !Array.isArray(_editingDiag.postes)) return;
  _editingDiag.postes.splice(i, 1);
  renderRongeursPostes();
}
function setRongeurPoste(i, k, v) {
  if (_editingDiag && _editingDiag.postes && _editingDiag.postes[i]) _editingDiag.postes[i][k] = v;
}
function renderRongeursPostes() {
  const box = $('rongeur-postes-box'); if (!box) return;
  const postes = (_editingDiag && _editingDiag.postes) || [];
  box.innerHTML = postes.map((p, i) => `
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:5px;">
      <span style="font-size:11px;font-weight:800;color:var(--navy);min-width:26px;">N°${i+1}</span>
      <input class="form-input" style="flex:1.3;font-size:12px;padding:5px 8px;" placeholder="Emplacement (ex. cave, local poubelles...)" value="${(p.emplacement||'').replace(/"/g,'&quot;')}" oninput="setRongeurPoste(${i},'emplacement',this.value)">
      <input class="form-input" style="flex:1;font-size:12px;padding:5px 8px;" placeholder="Produit / piège (ex. bloc brodifacoum, tapette...)" value="${(p.produit||'').replace(/"/g,'&quot;')}" oninput="setRongeurPoste(${i},'produit',this.value)">
      <button type="button" class="btn btn-ghost btn-sm" onclick="removeRongeurPoste(${i})" title="Retirer" style="padding:3px 8px;">✕</button>
    </div>`).join('') || '<div style="font-size:11px;color:var(--g400);">Aucun poste — clique sur « + Ajouter un poste ».</div>';
  refreshDiagPreview();
}

function renderRongeursEditor() {
  const d = _editingDiag; if (!d) return;
  const box = $('modal-diag-body'); if (!box) return;
  const clientOpts = (DB.clients||[]).slice().sort((a,b)=>(a.nom||'').localeCompare(b.nom||'')).map(c=>`<option value="${c.id}" ${d.clientId===c.id?'selected':''}>${_clientOptionLabel(c).replace(/</g,'&lt;')}</option>`).join('');
  const especesHtml = RONGEURS_ESPECES.map(n => `
    <label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;margin:3px 10px 3px 0;cursor:pointer;">
      <input type="checkbox" ${(d.insectes||[]).includes(n)?'checked':''} onchange="toggleDiagInsecte('${n.replace(/'/g,"\\'")}',this.checked)" style="accent-color:var(--navy);"> ${n}
    </label>`).join('');
  const signesHtml = RONGEURS_SIGNES.map(n => `
    <label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;margin:3px 10px 3px 0;cursor:pointer;">
      <input type="checkbox" ${(d.signes||[]).includes(n)?'checked':''} onchange="toggleRongeurSigne('${n.replace(/'/g,"\\'")}',this.checked)" style="accent-color:var(--navy);"> ${n}
    </label>`).join('');
  const materielHtml = RONGEURS_MATERIEL.map(n => `
    <label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;margin:3px 10px 3px 0;cursor:pointer;">
      <input type="checkbox" ${(d.materiel||[]).includes(n)?'checked':''} onchange="toggleRongeurMateriel('${n.replace(/'/g,"\\'")}',this.checked)" style="accent-color:var(--navy);"> ${n}
    </label>`).join('');
  const rodentHtml = RONGEURS_RODENTICIDES.map(n => `
    <label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;margin:3px 10px 3px 0;cursor:pointer;">
      <input type="checkbox" ${(d.rodenticides||[]).includes(n)?'checked':''} onchange="toggleDiagList('rodenticides','${n.replace(/'/g,"\\'")}',this.checked)" style="accent-color:var(--navy);"> ${n}
    </label>`).join('');
  const actionsHtml = RONGEURS_ACTIONS.map(n => `
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;margin:3px 0;cursor:pointer;">
      <input type="checkbox" ${(d.actions||[]).includes(n)?'checked':''} onchange="toggleDiagList('actions','${n.replace(/'/g,"\\'")}',this.checked)" style="accent-color:var(--navy);"> ${n}
    </label>`).join('');
  box.innerHTML = `
    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🐀 Identification</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
      <div class="form-group"><label class="form-label">N° de bon (remplissage auto)</label><input class="form-input" placeholder="Tape le n° puis Tab" onchange="autoFillDiagFromBon(this.value)" onblur="autoFillDiagFromBon(this.value)"></div>
      <div class="form-group"><label class="form-label">Date</label><input class="form-input" type="date" value="${d.dateDoc||''}" oninput="_editingDiag.dateDoc=this.value"></div>
      ${_diagTypeBureauFields(d)}
      <div class="form-group" style="grid-column:1/-1;"><label class="form-label">Nuisible affiché dans le ruban du PDF</label>
        <select class="form-input" oninput="_editingDiag.ruban=this.value">
          <option value="" ${!d.ruban?'selected':''}>Automatique (espèce cochée, sinon « Dératisation »)</option>
          ${['Rongeurs','Rats','Souris','Rat brun (surmulot)','Rats d\'égout','Rat noir','Souris domestique','Mulot','Campagnol','Loir / Lérot','Fouine','Chauves-souris'].map(o => `<option ${d.ruban===o?'selected':''}>${o}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label class="form-label">Client (gérance)</label>
        <select class="form-input" onchange="onDiagClientSelect(this.value)"><option value="">-- Choisir --</option>${clientOpts}</select>
        <input class="form-input" style="margin-top:5px;font-size:12px;" placeholder="ou nom manuel" value="${(d.clientNom||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.clientNom=this.value;_editingDiag.clientId='';">
      </div>
      ${_diagTechField(d)}
      <div class="form-group"><label class="form-label">Locataire</label><input class="form-input" value="${(d.locataireNom||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.locataireNom=this.value"></div>
      <div class="form-group"><label class="form-label">Site / bâtiment concerné</label><input class="form-input" value="${(d.batiment||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.batiment=this.value" placeholder="Ex. immeuble locatif, restaurant, cave"></div>
      <div class="form-group" style="grid-column:1/-1;"><label class="form-label">Adresse</label><input class="form-input" value="${(d.locataireAdresse||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.locataireAdresse=this.value"></div>
    </div>

    ${_diagDatesFields(d)}

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🐭 Espèces détectées</div>
    <div style="margin-bottom:10px;">${especesHtml}</div>
    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🔎 Signes observés</div>
    <div style="margin-bottom:12px;">${signesHtml}</div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:8px;">
      <div class="form-group"><label class="form-label">Activité de l'infestation</label>
        <select class="form-input" oninput="_editingDiag.activite=this.value">
          <option value="" ${!d.activite?'selected':''}>-- Choisir --</option>
          <option ${d.activite==='Active'?'selected':''}>Active</option>
          <option ${d.activite==='Ancienne (traces)'?'selected':''}>Ancienne (traces)</option>
          <option ${d.activite==='Mixte'?'selected':''}>Mixte</option>
        </select>
      </div>
      <div class="form-group"><label class="form-label">Niveau d'infestation</label>
        <select class="form-input" oninput="_editingDiag.gravite=this.value">
          <option value="" ${!d.gravite?'selected':''}>-- Choisir --</option>
          <option ${d.gravite==='Faible'?'selected':''}>Faible</option>
          <option ${d.gravite==='Modérée'?'selected':''}>Modérée</option>
          <option ${d.gravite==='Importante'?'selected':''}>Importante</option>
          <option ${d.gravite==='Critique (infestation massive)'?'selected':''}>Critique (infestation massive)</option>
        </select>
      </div>
      ${_diagZonesField(d, 'Zone d\'activité')}
      <div class="form-group"><label class="form-label">Points d'entrée détectés</label><input class="form-input" value="${(d.elementsTouches||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.elementsTouches=this.value" placeholder="Ex. passage de conduites, porte de cave non étanche"></div>
    </div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:6px;display:flex;align-items:center;flex-wrap:wrap;">✏️ Plan des locaux ${_diagSectionToggle('noPlan','Afficher dans le PDF')}</div>
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:8px;margin-bottom:14px;${d.noPlan?'display:none;':''}">
      <canvas id="diag-schema-canvas" width="2048" height="1216" style="width:100%;height:auto;border:1px dashed #ccc;border-radius:6px;cursor:crosshair;touch-action:none;background:#fff;"></canvas>
      <input type="file" id="diag-schema-file" accept="image/*" style="display:none" onchange="loadSchemaImage(event)">
      <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;align-items:center;">
        <span style="font-size:11px;font-weight:700;color:var(--g600);">Couleur :</span>
        ${RONGEUR_COLORS.map(c => `
          <button type="button" title="${c.label}" onclick="setDiagColor('${c.hex}')"
            style="width:24px;height:24px;border-radius:50%;cursor:pointer;background:${c.hex};border:${_diagColor===c.hex?'3px solid var(--navy)':'2px solid #e5e7eb'};"></button>`).join('')}
        <span style="font-size:10px;color:var(--g400);">(${(RONGEUR_COLORS.find(c=>c.hex===_diagColor)||{}).label||''})</span>
        <span style="width:1px;height:20px;background:#e5e7eb;"></span>
        <button class="btn ${_diagTool==='draw'?'btn-navy':'btn-ghost'} btn-sm" type="button" onclick="setDiagTool('draw')">✏️ Dessin</button>
        <button class="btn ${_diagTool==='text'?'btn-navy':'btn-ghost'} btn-sm" type="button" onclick="setDiagTool('text')">🔤 Texte</button>
      </div>
      <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">
        <button class="btn btn-navy btn-sm" type="button" onclick="openSchemaZoom()" title="Agrandir le plan pour tracer confortablement (ou double-clic sur le plan)">🔍 Plein écran</button>
        <button class="btn btn-navy btn-sm" type="button" onclick="document.getElementById('diag-schema-file').click()">📷 Importer une image / plan</button>
        <button class="btn btn-ghost btn-sm" type="button" onclick="clearDiagSchema()">↺ Effacer les annotations</button>
        <select class="form-input" style="width:auto;display:inline-block;font-size:12px;padding:5px 8px;" onchange="setDiagPlanModele(this.value)" title="Choisir le modèle de plan (remplace le fond et efface les annotations)">
          ${[['soussol','🏚 Sous-sol / caves'],['appartement','🏠 Appartement'],['resto','🍽 Restaurant / cuisine pro'],['exterieur','🌳 Extérieurs / jardin'],['libre','📐 Quadrillage libre']].map(o => `<option value="${o[0]}" ${_diagPlanModele===o[0]?'selected':''}>${o[1]}</option>`).join('')}
        </select>
        <button class="btn btn-ghost btn-sm" type="button" onclick="resetToDefaultSchema()" title="Redessiner le modèle choisi">↻ Redessiner</button>
        <span style="font-size:11px;color:var(--g400);align-self:center;">Entoure les zones d'activité et marque les postes par-dessus le plan. La légende est ajoutée au PDF.</span>
      </div>
    </div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:6px;display:flex;align-items:center;flex-wrap:wrap;">📷 Photo inspection ${_diagSectionToggle('noPhotos','Afficher dans le PDF')}</div>
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:8px;margin-bottom:14px;${d.noPhotos?'display:none;':''}">
      <input type="file" id="diag-photos-file" accept="image/*" multiple style="display:none" onchange="addDiagPhotos(event)">
      <input type="file" id="diag-photo-replace-file" accept="image/*" style="display:none" onchange="onDiagPhotoReplace(event)">
      <button class="btn btn-navy btn-sm" type="button" onclick="document.getElementById('diag-photos-file').click()">📷 Ajouter des photos</button>
      <span style="font-size:11px;color:var(--g400);margin-left:6px;">Incluses dans le PDF avec date et auteur (non stockées en base).</span>
      <div id="diag-photos-box" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;"></div>
    </div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🧰 Matériel utilisé</div>
    <div style="margin-bottom:12px;">${materielHtml}</div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">☠️ Rodenticide professionnel utilisé (à base de)</div>
    <div style="margin-bottom:4px;">${rodentHtml}</div>
    <div class="form-group" style="margin-bottom:12px;max-width:360px;"><input class="form-input" style="font-size:12px;" value="${(d.rodenticideAutre||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.rodenticideAutre=this.value" placeholder="Autre produit (champ libre)"></div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">✅ Mesures du traitement</div>
    <div style="margin-bottom:12px;">${actionsHtml}</div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:6px;">🪤 Postes d'appâtage / pièges posés</div>
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:8px;margin-bottom:14px;">
      <div class="form-group" style="margin-bottom:8px;max-width:240px;"><label class="form-label">Nombre de postes d'appâtage</label><input class="form-input" type="number" min="0" step="1" value="${String(d.postesNb||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.postesNb=this.value" placeholder="Ex. 6"></div>
      <div style="font-size:11px;color:var(--g400);margin-bottom:6px;">Le détail ci-dessous est facultatif — le nombre seul suffit pour le PDF.</div>
      <div id="rongeur-postes-box" style="margin-bottom:6px;"></div>
      <button class="btn btn-navy btn-sm" type="button" onclick="addRongeurPoste()">+ Ajouter un poste</button>
    </div>

    <div class="form-group" style="margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;"><label class="form-label">Observations détaillées</label><button type="button" class="btn btn-ghost btn-sm" id="diag-ai-diagnostic" onclick="diagAICorrect('diagnostic')" style="font-size:11px;padding:2px 8px;">✨ Corriger IA</button></div>
      <textarea class="form-input" id="diag-ta-diagnostic" rows="3" oninput="_editingDiag.diagnostic=this.value;diagTaAutoGrow(this)" onfocus="diagTaAutoGrow(this)" onblur="diagTaShrink(this)">${d.diagnostic||''}</textarea>
    </div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">💊 Plan de traitement & suivi</div>
    <div class="form-group" style="margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;align-items:center;"><label class="form-label">Plan de traitement</label><button type="button" class="btn btn-ghost btn-sm" id="diag-ai-traitement" onclick="diagAICorrect('traitement')" style="font-size:11px;padding:2px 8px;">✨ Corriger IA</button></div>
      <textarea class="form-input" id="diag-ta-traitement" rows="3" oninput="_editingDiag.traitement=this.value;diagTaAutoGrow(this)" onfocus="diagTaAutoGrow(this)" onblur="diagTaShrink(this)" placeholder="Ex. pose de postes sécurisés en cave et local poubelles, contrôle à J+15...">${d.traitement||''}</textarea>
    </div>
    <div class="form-group" style="margin-bottom:14px;"><label class="form-label">Suivi / prochain passage</label>
      <select class="form-input" oninput="_editingDiag.suivi=this.value">
        <option value="" ${!d.suivi?'selected':''}>-- Choisir --</option>
        ${SUIVI_OPTIONS.map(o => `<option ${d.suivi===o?'selected':''}>${o}</option>`).join('')}
        ${d.suivi && !SUIVI_OPTIONS.includes(d.suivi) ? `<option selected>${d.suivi.replace(/</g,'&lt;')}</option>` : ''}
      </select>
      <input class="form-input" style="margin-top:5px;font-size:12px;" value="${(d.suiviRem||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.suiviRem=this.value" placeholder="Remarque complémentaire (champ libre)">
    </div>

    <div class="form-group" style="margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;"><label class="form-label">Prévention recommandée</label><button type="button" class="btn btn-ghost btn-sm" id="diag-ai-prevention" onclick="diagAICorrect('prevention')" style="font-size:11px;padding:2px 8px;">✨ Corriger IA</button></div>
      <textarea class="form-input" id="diag-ta-prevention" rows="2" oninput="_editingDiag.prevention=this.value;diagTaAutoGrow(this)" onfocus="diagTaAutoGrow(this)" onblur="diagTaShrink(this)" placeholder="Ex. colmater le passage de conduites, fermer les portes de cave, gestion des déchets...">${d.prevention||''}</textarea>
    </div>

    ${_diagContratFields(d)}

    <div class="form-group">
      <div style="display:flex;justify-content:space-between;align-items:center;"><label class="form-label">Conclusion / recommandations</label><button type="button" class="btn btn-ghost btn-sm" id="diag-ai-conclusion" onclick="diagAICorrect('conclusion')" style="font-size:11px;padding:2px 8px;">✨ Corriger IA</button></div>
      <textarea class="form-input" id="diag-ta-conclusion" rows="2" oninput="_editingDiag.conclusion=this.value;diagTaAutoGrow(this)" onfocus="diagTaAutoGrow(this)" onblur="diagTaShrink(this)">${d.conclusion||''}</textarea>
    </div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin:14px 0 6px;display:flex;align-items:center;flex-wrap:wrap;">✍️ Signature numérique ${_diagSectionToggle('noSign','Afficher dans le PDF')}</div>
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:8px;${d.noSign?'display:none;':''}">
      <canvas id="diag-sign-canvas" width="400" height="140" style="width:min(400px,100%);height:auto;border:1px dashed #ccc;border-radius:6px;cursor:crosshair;touch-action:none;background:#fff;"></canvas>
      <div style="display:flex;gap:6px;margin-top:6px;align-items:center;flex-wrap:wrap;">
        <button class="btn btn-ghost btn-sm" type="button" onclick="clearDiagSignature()">↺ Effacer</button>
        <span style="font-size:11px;color:var(--g400);">Signe à la souris ou au doigt — la signature est insérée dans le PDF (non stockée en base).</span>
      </div>
    </div>
  `;
  const t = $('modal-diag-title'); if (t) t.textContent = 'Rapport rongeurs ' + (d.numero||'');
  initDiagSchema();
  initDiagSignPad();
  renderDiagPhotos();
  renderRongeursPostes();
  box.oninput = () => refreshDiagPreview();
  _syncDiagPreviewPane();
  refreshDiagPreview();
}

function _genRongeursPDF(d, mode) {
  if (!d) { if (mode !== 'blob') toast('Rapport introuvable', '#e63946'); return; }
  if (!window.jspdf || !window.jspdf.jsPDF) { toast('Librairie PDF non chargée', '#e63946'); return; }
  const co = DERATEK_CONFIG.company;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:'mm', format:'a4' });
  const M = 20, R = 190, CW = R - M;
  const NAVY = [13,27,62], SLATE = [95,111,129], GREY = [110,110,110];
  const MAX_Y = 270;
  let y = 0;

  const newPage = () => { doc.addPage(); y = 20; };
  const ensure = (h) => { if (y + h > MAX_Y) newPage(); };
  // keep = hauteur minimale de contenu à garder avec le titre (anti-titre orphelin)
  const section = (titre, keep) => {
    ensure(14 + (keep || 0));
    doc.setFillColor(SLATE[0],SLATE[1],SLATE[2]); doc.rect(M, y-3.2, 2.4, 4.4, 'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(NAVY[0],NAVY[1],NAVY[2]);
    doc.text(titre, M+4.5, y);
    doc.setDrawColor(SLATE[0],SLATE[1],SLATE[2]); doc.setLineWidth(0.4); doc.line(M, y+1.8, R, y+1.8);
    y += 7.5; doc.setTextColor(0); doc.setFont('helvetica','normal'); doc.setFontSize(10);
  };
  const field = (lbl, val, indent) => {
    if (!val) return;
    const x = indent || M;
    doc.setFont('helvetica','bold'); doc.setFontSize(9.5);
    const vx = x + Math.max(40, doc.getTextWidth(lbl + ' :') + 3);
    const lines = doc.splitTextToSize(String(val), R - vx - 2);
    ensure(Math.max(lines.length*4.8, 5.5) + 2);
    doc.setTextColor(60);
    doc.text(lbl + ' :', x, y);
    doc.setFont('helvetica','normal'); doc.setTextColor(0);
    doc.text(lines, vx, y);
    y += Math.max(lines.length*4.8, 5.5);
  };
  const para = (txt) => {
    if (!txt) return;
    doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(0);
    doc.splitTextToSize(String(txt), CW).forEach(ln => { ensure(6); doc.text(ln, M, y); y += 4.9; });
  };
  const badge = (txt, rgb, x, yy) => {
    doc.setFont('helvetica','bold'); doc.setFontSize(8.5);
    const w = doc.getTextWidth(txt) + 6;
    doc.setFillColor(rgb[0],rgb[1],rgb[2]);
    doc.roundedRect(x, yy-4.1, w, 5.6, 2.8, 2.8, 'F');
    doc.setTextColor(255); doc.text(txt, x+3, yy);
    doc.setTextColor(0);
    return w;
  };
  const GRAV_RGB = { 'Faible':[45,158,107], 'Modérée':[230,170,30], 'Importante':[235,120,40], 'Critique (infestation massive)':[230,57,70] };
  const ACT_RGB  = { 'Active':[230,57,70], 'Ancienne (traces)':[120,120,120], 'Mixte':[235,120,40] };

  // En-tête
  // En-tête horizontal — identique aux factures (downloadDocPDF)
  // Bureau émetteur choisi dans le rapport (Neuchâtel par défaut)
  const bu = (typeof BUREAUX !== 'undefined' && BUREAUX.find(b => b.id === d.bureau)) || { rue: co.rue, npa: co.npa, ville: co.ville, tel: co.tel };
  const logoW = 62, logoH = logoW*199/900;
  const logoY = 13;
  const headerFiletY = logoY + logoH + 5;
  if (typeof LOGO_B64 !== 'undefined') { try { doc.addImage(LOGO_B64,'PNG',20,logoY,logoW,logoH); } catch(e){} }
  else { doc.setFont('helvetica','bold'); doc.setFontSize(20); doc.setTextColor(13,27,62); doc.text('DERATEK', 20, 23); }
  const cy0 = logoY + 4;
  doc.setFont('helvetica','normal'); doc.setFontSize(8.5); doc.setTextColor(70);
  [bu.rue, `${bu.npa} ${bu.ville}`, 'Tél. '+(bu.tel||co.tel)].forEach((l,i)=>{ if(l) doc.text(l, 92, cy0 + i*4.4); });
  [co.email, co.tva].forEach((l,i)=>{ if(l) doc.text(l, 146, cy0 + i*4.4); });
  doc.setTextColor(13,27,62);
  try { doc.textWithLink('www.deratek.ch', 146, cy0 + 2*4.4, { url:'https://www.deratek.ch' }); } catch(e) { doc.text('www.deratek.ch', 146, cy0 + 2*4.4); }
  doc.setTextColor(0);
  doc.setDrawColor(200,205,213); doc.setLineWidth(0.4); doc.line(20, headerFiletY, 190, headerFiletY);
  // Date à droite sous le filet (comme les factures)
  doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(13,27,62);
  doc.text((bu.ville||'Neuchâtel') + ', le ' + (fmtDate(d.dateDoc)||''), 190, headerFiletY + 5, { align:'right' });
  doc.setFont('helvetica','normal'); doc.setTextColor(0);
  // Informations sur 2 colonnes au-dessus du ruban (style rapport classique,
  // enrichies depuis le bon enregistré quand il y en a un)
  const bi = _diagBonInfo(d) || {};

  // Bandeau titre (juste sous l'en-tête)
  y = headerFiletY + 9;
  doc.setFillColor(NAVY[0],NAVY[1],NAVY[2]);
  doc.roundedRect(M, y, CW, 16, 2, 2, 'F');
  doc.setFont('helvetica','bold'); doc.setFontSize(14); doc.setTextColor(255);
  doc.text((d.doctype==='Expertise'?'EXPERTISE':'RAPPORT') + ' N° ' + (d.numero||''), M+6, y+6.8);
  doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.setTextColor(225,228,238);
  const rubanTxt = d.ruban || (((d.insectes||[]).length === 1) ? d.insectes[0] : 'Dératisation');
  doc.text(rubanTxt + ' — détection & plan d\'action', M+6, y+12.4);
  doc.setFontSize(10.5); doc.setFont('helvetica','bold'); doc.setTextColor(255);
  doc.text(fmtDate(d.dateDoc)||'', R-6, y+6.8, { align:'right' });
  doc.setTextColor(0);
  y += 21;

  // Informations sur 2 colonnes (style rapport classique, enrichies du bon)
  y = _diagRows2Col(doc, [
    ['Technicien', d.noTech ? '' : d.tech],
    ['Client', [(d.clientNom||''), bi.clientAdresse].filter(Boolean).join('\n')],
    ['N° bon de commande', bi.bonNumero],
    ['Adresse d\'intervention', d.locataireAdresse],
    ['Gérant', bi.gerant],
    ['Téléphone', bi.tel],
    ['Email', bi.email],
    ['Locataire', d.locataireNom],
    ['Tél. locataire', bi.locTel],
    ['Logement', (bi.logement && bi.logement !== d.locataireAdresse) ? bi.logement : ''],
    ['Site / bâtiment', d.batiment],
    ['Zones d\'activité', d.zones],
    ['Points d\'entrée', d.elementsTouches],
    ['N° intervention', bi.bonNumero],
  ], y, M, CW);

  // Dates d'intervention bien visibles, sous la grille (à la place du ruban)
  y = _diagDatesStrip(doc, d, y + 5, M, CW);
  y += 1;

  // Synthèse
  const postes = Array.isArray(d.postes) ? d.postes.filter(p => p && (p.emplacement || p.produit)) : [];
  const synth = [
    ['ACTIVITÉ', d.activite, ACT_RGB[d.activite]],
    ['NIVEAU D\'INFESTATION', d.gravite, GRAV_RGB[d.gravite]],
    ['ESPÈCES', (d.insectes||[]).length ? (d.insectes||[]).length + ' détectée(s)' : '', null],
    ['POSTES POSÉS', d.postesNb ? String(d.postesNb) : (postes.length ? String(postes.length) : ''), null],
  ];
  if (synth.some(s => s[1])) {
    ensure(20);
    const colW = CW/4;
    doc.setDrawColor(225,228,238); doc.setLineWidth(0.3);
    doc.roundedRect(M, y, CW, 15, 2, 2, 'D');
    synth.forEach((s, i) => {
      const cx = M + i*colW + 4;
      if (i) doc.line(M + i*colW, y+2.5, M + i*colW, y+12.5);
      doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(GREY[0],GREY[1],GREY[2]);
      doc.text(s[0], cx, y+5);
      if (!s[1]) { doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(150); doc.text('—', cx, y+11.2); return; }
      if (s[2]) { badge(String(s[1]).replace(' (infestation massive)',''), s[2], cx, y+11.2); }
      else {
        doc.setFont('helvetica','bold'); doc.setFontSize(9.5); doc.setTextColor(NAVY[0],NAVY[1],NAVY[2]);
        doc.text(doc.splitTextToSize(String(s[1]), colW-8)[0]||'', cx, y+11.2);
      }
    });
    doc.setTextColor(0);
    y += 21;
  }

  // Constatations
  section('Constatations');
  field('Espèces détectées', (d.insectes||[]).join(', '));
  field('Signes observés', (d.signes||[]).join(', '));
  if (d.diagnostic) {
    y += 1.5;
    doc.setFont('helvetica','bold'); doc.setFontSize(9.5); doc.setTextColor(60);
    ensure(8); doc.text('Observations :', M, y); y += 5; doc.setTextColor(0);
    para(d.diagnostic);
  }

  // Plan des locaux + légende
  if (d.schema && !d.noPlan) {
    const schemaH = 100;
    if (y + schemaH + 22 > MAX_Y) newPage();
    y += 3; section('Plan des locaux');
    try {
      doc.addImage(d.schema, 'PNG', M, y, 170, schemaH);
      doc.setDrawColor(225,228,238); doc.rect(M, y, 170, schemaH, 'D');
      y += schemaH + 5;
      let lx = M;
      RONGEUR_COLORS.forEach(c => {
        const rgb = [parseInt(c.hex.slice(1,3),16), parseInt(c.hex.slice(3,5),16), parseInt(c.hex.slice(5,7),16)];
        doc.setFillColor(rgb[0],rgb[1],rgb[2]); doc.circle(lx+1.5, y-1.2, 1.5, 'F');
        doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(70);
        doc.text(c.label, lx+4.5, y);
        lx += 4.5 + doc.getTextWidth(c.label) + 8;
      });
      doc.setTextColor(0);
      y += 6;
    } catch (e) {}
  }

  // Photos
  const photos = (!d.noPhotos && Array.isArray(d.photos)) ? d.photos.filter(p => p && p.data && p.use !== false) : [];
  if (photos.length) {
    y += 2; section('Photos de l\'inspection', 62);
    const pw = (CW - 6) / 2, ph = 58;
    photos.forEach((p, i) => {
      const col = i % 2;
      if (col === 0 && y + ph + 8 > MAX_Y) newPage();
      const px = M + col*(pw+6);
      try {
        doc.addImage(p.data, 'JPEG', px, y, pw, ph);
        doc.setDrawColor(225,228,238); doc.rect(px, y, pw, ph, 'D');
        const meta = (typeof _diagPhotoMeta === 'function') ? _diagPhotoMeta(p) : '';
        const cap = ['Photo ' + (i+1), p.caption, meta ? '(' + meta + ')' : ''].filter(Boolean).join(' — ');
        doc.setFont('helvetica','italic'); doc.setFontSize(7.5); doc.setTextColor(70);
        doc.text(doc.splitTextToSize(cap, pw).slice(0, 2), px, y+ph+3.6);
        doc.setTextColor(0);
      } catch (e) {}
      if (col === 1 || i === photos.length-1) y += ph + 8;
    });
    y += 2;
  }

  // Tableau des postes d'appâtage / pièges
  if (postes.length) {
    y += 2; section('Postes d\'appâtage / pièges posés', 18);
    const c1 = M, c2 = M+14, c3 = M+105;
    const drawPostesHeader = () => {
      doc.setFillColor(NAVY[0],NAVY[1],NAVY[2]);
      doc.rect(M, y-4, CW, 6.5, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(8.5); doc.setTextColor(255);
      doc.text('N°', c1+2, y); doc.text('Emplacement', c2+2, y); doc.text('Produit / piège', c3+2, y);
      doc.setTextColor(0);
      y += 5;
    };
    ensure(8);
    drawPostesHeader();
    postes.forEach((p, i) => {
      const lines1 = doc.splitTextToSize(String(p.emplacement||'—'), c3-c2-6);
      const lines2 = doc.splitTextToSize(String(p.produit||'—'), R-c3-6);
      const rowH = Math.max(lines1.length, lines2.length)*4.6 + 2.4;
      if (y + rowH + 2 > MAX_Y) { newPage(); drawPostesHeader(); }
      if (i % 2 === 0) { doc.setFillColor(246,247,250); doc.rect(M, y-3.4, CW, rowH, 'F'); }
      doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.text(String(i+1), c1+2, y);
      doc.setFont('helvetica','normal');
      doc.text(lines1, c2+2, y);
      doc.text(lines2, c3+2, y);
      y += rowH;
    });
    doc.setDrawColor(225,228,238); doc.setLineWidth(0.3); doc.line(M, y-2.8, R, y-2.8);
    y += 4;
  }

  // Fiches des espèces détectées
  const fiches = (d.insectes||[]).filter(n => RONGEURS_INFO[n]);
  if (fiches.length) {
    y += 2; section('Fiches des espèces détectées', 38);
    fiches.forEach(nom => {
      const f = RONGEURS_INFO[nom];
      doc.setFont('helvetica','normal'); doc.setFontSize(9.5);
      const estH = 13 + [f.habitat, f.indices, f.biologie, f.risque].reduce((s,v)=> s + Math.max(doc.splitTextToSize(String(v),135).length*4.8, 5.5), 0);
      ensure(Math.min(estH, 75));
      doc.setFillColor(238,241,246);
      doc.roundedRect(M, y-1, CW, 7, 1.5, 1.5, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(10);
      const nomW = doc.getTextWidth(nom);
      doc.setTextColor(SLATE[0],SLATE[1],SLATE[2]);
      doc.text(nom, M+3, y+3.6);
      doc.setFont('helvetica','italic'); doc.setFontSize(9); doc.setTextColor(110);
      doc.text(f.latin, M+3+nomW+4, y+3.6);
      doc.setTextColor(0);
      y += 10;
      field('Habitat', f.habitat, M+3);
      field('Indices typiques', f.indices, M+3);
      field('Biologie', f.biologie, M+3);
      field('Risque', f.risque, M+3);
      y += 3;
    });
  }

  // Plan de traitement & suivi
  const materiel = Array.isArray(d.materiel) ? d.materiel : [];
  const rodenticides = Array.isArray(d.rodenticides) ? d.rodenticides : [];
  const actions = Array.isArray(d.actions) ? d.actions : [];
  // Ligne avec une vraie case cochée dessinée (☑)
  const checkLine = (txt) => {
    const lines = doc.splitTextToSize(String(txt), CW - 8);
    ensure(lines.length*4.8 + 2);
    doc.setDrawColor(NAVY[0],NAVY[1],NAVY[2]); doc.setLineWidth(0.35);
    doc.rect(M, y-3, 3.2, 3.2);
    doc.setDrawColor(45,158,107); doc.setLineWidth(0.6);
    doc.line(M+0.7, y-1.4, M+1.4, y-0.6); doc.line(M+1.4, y-0.6, M+2.7, y-2.6);
    doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.setTextColor(0);
    doc.text(lines, M+5.5, y);
    y += lines.length*4.8 + 1;
  };
  if (d.traitement || d.suivi || materiel.length || rodenticides.length || actions.length) {
    y += 2; section('Plan de traitement', 12);
    if (materiel.length) { field('Matériel utilisé', materiel.join(', ')); y += 1; }
    if (d.postesNb) { field('Nombre de postes d\'appâtage', String(d.postesNb)); y += 1; }
    const rodAucun = rodenticides.includes('Aucun rodenticide utilisé');
    const rodList = rodenticides.filter(r => r !== 'Aucun rodenticide utilisé');
    if (rodAucun) { field('Rodenticide', 'Aucun rodenticide utilisé'); y += 1; }
    else if (rodList.length || d.rodenticideAutre) { field('Rodenticide', 'Professionnel à base de ' + [...rodList, d.rodenticideAutre].filter(Boolean).join(', ')); y += 1; }
    para(d.traitement);
    if (actions.length) { y += 1.5; actions.forEach(a => checkLine(a)); }
    const suiviTxt = [d.suivi, d.suiviRem].filter(Boolean).join(' — ');
    if (suiviTxt) { y += 1.5; field('Suivi / prochain passage', suiviTxt); }
  }

  // Prévention recommandée
  if (d.prevention) {
    y += 2; section('Prévention recommandée', 12);
    para(d.prevention);
  }

  // Proposition de contrat annuel
  if (d.contrat) {
    y += 2; section('Proposition de contrat annuel', 18);
    para("Au vu de la situation constatée, une proposition de contrat annuel peut être envisagée afin d'assurer un suivi régulier, de limiter les risques de récidive et de maintenir une surveillance préventive des zones sensibles.");
    y += 1.5;
    field('Passages annuels proposés', d.contratPassages);
    field('Montant estimatif', d.contratMontant);
    field('Zones concernées', d.contratZones);
    field('Remarques', d.contratRem);
  }

  // Conclusion (encadré)
  if (d.conclusion) {
    // On fixe la police AVANT de découper : sinon le calcul de largeur se fait avec
    // la taille laissée par la section précédente et les lignes débordent du cadre.
    doc.setFont('helvetica','normal'); doc.setFontSize(10);
    const lines = doc.splitTextToSize(String(d.conclusion), CW-13);
    const boxH = lines.length*4.9 + 8;
    if (y + boxH + 12 > MAX_Y) newPage();
    y += 2; section('Conclusion / recommandations');
    doc.setFillColor(240,243,250); doc.setDrawColor(NAVY[0],NAVY[1],NAVY[2]); doc.setLineWidth(0.3);
    doc.roundedRect(M, y-2, CW, boxH, 2, 2, 'FD');
    doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(NAVY[0],NAVY[1],NAVY[2]);
    lines.forEach((ln, i) => doc.text(ln, M+5, y+3.5 + i*4.9));
    doc.setTextColor(0);
    y += boxH + 4;
  }

  // Signature
  if (!d.noSign) {
    ensure(32);
    y += 8;
    doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.setTextColor(40);
    doc.text(bu.ville + ', le ' + (fmtDate(d.dateDoc)||''), M, y);
    doc.text('DERATEK' + (d.tech && !d.noTech ? ' — ' + d.tech : ''), 120, y);
    if (d.signature) { try { doc.addImage(d.signature, 'PNG', 120, y+1.5, 45, 15.75); } catch (e) {} }
    doc.setDrawColor(120); doc.setLineWidth(0.3); doc.line(120, y+18, 186, y+18);
    doc.setFontSize(8); doc.setTextColor(GREY[0],GREY[1],GREY[2]);
    doc.text('Signature', 120, y+21.5);
    doc.setTextColor(0);
  }

  // Pied de page
  const nb = doc.getNumberOfPages();
  for (let i = 1; i <= nb; i++) {
    doc.setPage(i);
    doc.setDrawColor(SLATE[0],SLATE[1],SLATE[2]); doc.setLineWidth(0.3); doc.line(M, 283, R, 283);
    doc.setFont('helvetica','normal'); doc.setFontSize(7.5); doc.setTextColor(GREY[0],GREY[1],GREY[2]);
    doc.text('DERATEK Professional Pest Control — ' + co.rue + ', ' + co.npa + ' ' + co.ville + ' — ' + co.email, M, 287.5);
    doc.text('Page ' + i + '/' + nb, R, 287.5, { align:'right' });
    doc.setTextColor(0);
  }

  if (mode === 'blob') return doc.output('blob');
  doc.save('rapport-rongeurs-' + (d.numero||'doc').replace(/[^a-z0-9]+/gi,'-').toLowerCase() + '.pdf');
  toast('✓ PDF rapport rongeurs téléchargé', '#2d9e6b');
}

// ============================================================
// RAPPORT SPÉCIAL BLATTES (même table "diagnostics", numéros BL-)
// ============================================================
const BLATTES_ESPECES = ['Blatte germanique', 'Blatte orientale', 'Blatte américaine', 'Blatte rayée', 'Blatte des meubles'];
const BLATTES_SIGNES = ['Individus vivants', 'Individus morts', 'Déjections (points noirs)', 'Oothèques (capsules d\'œufs)', 'Mues / exuvies', 'Odeur caractéristique', 'Traces grasses', 'Présence diurne (forte infestation)'];
const BLATTES_MATERIEL = ['Pistolet applicateur de gel', 'Pulvérisateur professionnel', 'Pièges collants de monitoring', 'Lampe / miroir d\'inspection', 'Endoscope', 'Nébulisateur / fogger'];
const BLATTES_PRODUITS = ['Gel insecticide (appât)', 'Pulvérisation rémanente', 'Régulateur de croissance (IGR)', 'Poudre / terre de diatomée', 'Nébulisation (fogging)', 'Pièges de monitoring', 'Aucun produit chimique'];
const BLATTES_ACTIONS = [
  'Application de gel dans les zones d\'activité (plinthes, fissures, derrière les meubles)',
  'Pulvérisation rémanente des zones de passage',
  'Pose de pièges de monitoring (suivi de l\'activité)',
  'Contrôle des points d\'eau et zones chaudes',
  'Maintien du dispositif en place à titre préventif',
  'Contrôle de l\'efficacité au prochain passage',
];
// Fiches descriptives des espèces — incluses dans le PDF pour chaque espèce cochée
const BLATTES_INFO = {
  'Blatte germanique': {
    latin: 'Blattella germanica',
    habitat: 'Cuisines, salles de bain, derrière les appareils chauds (frigo, four, lave-vaisselle) — zones humides et chaudes',
    indices: 'Petites blattes brun clair (12–15 mm) à deux bandes sombres, oothèques portées par la femelle, déjections en points noirs',
    biologie: 'Espèce la plus prolifique : une femelle peut générer plusieurs centaines de descendants par an ; développement très rapide',
    risque: 'Contamination des denrées et surfaces, allergènes, prolifération explosive — traitement par gel appât le plus efficace',
  },
  'Blatte orientale': {
    latin: 'Blatta orientalis',
    habitat: 'Caves, sous-sols, canalisations, locaux poubelles — zones fraîches et humides, niveaux bas',
    indices: 'Grandes blattes brun foncé à noir (20–27 mm), déplacement lent, odeur marquée, présence près des écoulements',
    biologie: 'Développement plus lent que la germanique ; tolère le froid ; souvent liée à des défauts de canalisation',
    risque: 'Remonte par les canalisations et siphons secs ; contamination ; traitement combiné pulvérisation + contrôle des réseaux',
  },
  'Blatte américaine': {
    latin: 'Periplaneta americana',
    habitat: 'Locaux techniques chauds et humides, chaufferies, vides sanitaires, réseaux — bâtiments collectifs et restaurants',
    indices: 'Très grandes blattes brun-roux (28–44 mm), capables de voler/planer, déjections plus grosses',
    biologie: 'Longue durée de vie, aime la chaleur (>28°C) ; colonies dans les gaines techniques',
    risque: 'Contamination importante, déplacements entre étages par les gaines ; traitement des réseaux et points chauds',
  },
  'Blatte rayée': {
    latin: 'Supella longipalpa',
    habitat: 'Pièces sèches et chaudes : chambres, bureaux, derrière cadres et appareils électroniques (TV, box) — en hauteur',
    indices: 'Petites blattes claires (10–14 mm) à bandes claires transversales, oothèques collées en hauteur',
    biologie: 'Préfère les endroits secs et chauds (contrairement à la germanique) ; se disperse dans tout le logement',
    risque: 'Infestation diffuse et difficile à localiser ; gel appât réparti dans toutes les pièces',
  },
  'Blatte des meubles': {
    latin: 'Supella longipalpa (blatte à bandes brunes)',
    habitat: 'Mobilier, plinthes, appareils électroménagers — pièces chauffées et sèches',
    indices: 'Petite taille, bandes claires, œufs collés sous les meubles et tiroirs',
    biologie: 'Discrète, se cache dans le mobilier ; reproduction continue en intérieur chauffé',
    risque: 'Dispersion dans tout le logement par le mobilier ; nécessite un traitement complet et un suivi',
  },
};

// ============================================================
// RAPPORT SPÉCIAL PUNAISES DE LIT (même table "diagnostics", numéros PL-)
// ============================================================
const PUNAISES_ESPECES = ['Punaise de lit commune', 'Punaise de lit tropicale'];
const PUNAISES_SIGNES = [
  'Individus vivants (adultes)', 'Larves / juvéniles', 'Individus morts',
  'Œufs (blancs, ~1 mm)', 'Mues / exuvies', 'Déjections (points noirs)',
  'Traces de sang sur la literie', 'Odeur caractéristique (coriandre)',
  'Piqûres signalées par l\'occupant', 'Aucun signe visible (monitoring en cours)',
];
const PUNAISES_ZONES = [
  'Matelas (coutures, étiquettes)', 'Sommier / cadre de lit', 'Tête de lit',
  'Table de nuit', 'Plinthes', 'Prises et interrupteurs', 'Canapé / fauteuils',
  'Rideaux', 'Armoire / commode', 'Tableaux et cadres', 'Parquet / lames disjointes', 'Bagages / valises',
];
const PUNAISES_MATERIEL = [
  'Générateur de vapeur sèche', 'Pulvérisateur professionnel', 'Poudreuse',
  'Canons à chaleur (traitement thermique)', 'Sondes de température',
  'Housses anti-punaises', 'Pièges de monitoring (intercepteurs)', 'Aspirateur HEPA',
  'Lampe / miroir d\'inspection',
];
const PUNAISES_PRODUITS = [
  'Vapeur sèche (choc thermique localisé)', 'Pulvérisation insecticide rémanente',
  'Terre de diatomée / poudre insecticide', 'Traitement thermique complet du volume',
  'Régulateur de croissance (IGR)', 'Pièges de monitoring', 'Aucun produit chimique',
];
const PUNAISES_ACTIONS = [
  'Traitement vapeur sèche du matelas, sommier et tête de lit',
  'Pulvérisation rémanente des plinthes, fissures et zones de repos',
  'Application de terre de diatomée dans les fissures, prises et plinthes',
  'Traitement thermique complet du volume (50–60 °C)',
  'Démontage des prises et interrupteurs pour traitement',
  'Pose de housses anti-punaises sur matelas et sommier',
  'Pose de pièges de monitoring (intercepteurs sous les pieds du lit)',
  'Aspiration HEPA des zones infestées avant traitement',
  'Contrôle de l\'efficacité au prochain passage',
];
// Consignes de préparation à cocher — condition clé de la réussite du traitement
const PUNAISES_PREPARATION = [
  'Laver tout le linge et la literie à 60 °C minimum',
  'Sécher au sèche-linge à haute température (30 min) ce qui ne se lave pas à 60 °C',
  'Enfermer le linge propre dans des sacs hermétiques jusqu\'à la fin du traitement',
  'Aspirer soigneusement sols, plinthes et sommier (jeter le sac dehors immédiatement)',
  'Décoller le lit des murs et écarter les meubles',
  'Vider les tables de nuit et les commodes proches du lit',
  'Ne pas déplacer d\'affaires vers une autre pièce ou un autre logement',
  'Débarrasser l\'encombrement au sol (cartons, vêtements, journaux)',
  'Libérer l\'accès aux plinthes, prises et interrupteurs',
  'Prévoir de ne pas laver les surfaces traitées pendant plusieurs semaines',
  'Laisser le logement ventilé et inoccupé pendant le délai indiqué',
  'Ne pas jeter les meubles infestés sans les signaler (risque de dissémination)',
];
// Fiches descriptives des espèces — incluses dans le PDF pour chaque espèce cochée
const PUNAISES_INFO = {
  'Punaise de lit commune': {
    latin: 'Cimex lectularius',
    habitat: 'Chambres à coucher : coutures du matelas, sommier, tête de lit, plinthes, prises — à moins de 2 m du lieu de couchage',
    indices: 'Adultes brun-roux aplatis (4–7 mm), points noirs de déjections, taches de sang sur les draps, mues translucides, œufs blancs collés dans les fissures',
    biologie: 'Une femelle pond 5 à 12 œufs par jour, jusqu\'à 500 dans sa vie. Résiste plusieurs mois sans se nourrir. Activité nocturne. Cycle complet en 5 à 8 semaines selon la température.',
    risque: 'Piqûres en ligne ou en grappe, démangeaisons, troubles du sommeil et anxiété. Dissémination très rapide par les bagages, le mobilier et les gaines techniques entre appartements. Ne transmet pas de maladie.',
  },
  'Punaise de lit tropicale': {
    latin: 'Cimex hemipterus',
    habitat: 'Mêmes zones que la punaise commune, mais liée aux climats chauds — importée par les voyages ; se maintient dans les logements bien chauffés',
    indices: 'Très proche de Cimex lectularius, distinction au pronotum (bords moins élargis) — identification à la loupe',
    biologie: 'Cycle plus rapide en ambiance chaude (>25 °C) ; même mode de reproduction et de dispersion que l\'espèce commune',
    risque: 'Identiques à la punaise commune. Résistances aux insecticides plus fréquemment signalées : le traitement combiné vapeur/chaleur est privilégié.',
  },
};

function openNewPunaises() {
  _editingDiag = {
    id: newId(), numero: _nextDiagNumero('PL'), dateDoc: today(), tech: '',
    clientId: '', clientNom: '', locataireNom: '', locataireAdresse: '',
    batiment: '', bonId: '', insectes: [], elementsTouches: '',
    activite: '', gravite: '', zones: '', diagnostic: '', conclusion: '',
    traitement: '', suivi: '', prevention: '', hygiene: '', signes: [], postes: [], materiel: [],
    rodenticides: [], actions: [], photos: [],
    preparation: [], preparationRem: '',
    bureau: 'ne', doctype: 'Rapport', noPlan: '1', noPhotos: '', noTech: '', statut: '', ruban: '', noSign: '1',
    rodenticideAutre: '', postesNb: '', suiviRem: '',
    contrat: '', contratPassages: '', contratMontant: '', contratZones: '', contratRem: '',
    dateInt1: '', dateInt2: '', dateInt3: '', dateProchain: ''
  };
  renderDiagEditor(); openModal('modal-diag');
}

function renderPunaisesEditor() {
  const d = _editingDiag; if (!d) return;
  const box = $('modal-diag-body'); if (!box) return;
  const clientOpts = (DB.clients || []).slice().sort((a, b) => (a.nom || '').localeCompare(b.nom || '', 'fr'))
    .map(c => `<option value="${c.id}" ${d.clientId === c.id ? 'selected' : ''}>${_clientOptionLabel(c).replace(/</g, '&lt;')}</option>`).join('');
  const checkList = (arr, field, toggleFn) => arr.map(n => `
    <label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;margin:3px 10px 3px 0;cursor:pointer;">
      <input type="checkbox" ${(d[field] || []).includes(n) ? 'checked' : ''} onchange="${toggleFn}('${field}','${n.replace(/'/g, "\\'")}',this.checked)" style="accent-color:var(--navy);"> ${n}
    </label>`).join('');
  const especesHtml = PUNAISES_ESPECES.map(n => `
    <label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;margin:3px 10px 3px 0;cursor:pointer;">
      <input type="checkbox" ${(d.insectes || []).includes(n) ? 'checked' : ''} onchange="toggleDiagInsecte('${n.replace(/'/g, "\\'")}',this.checked)" style="accent-color:var(--navy);"> ${n}
    </label>`).join('');
  const signesHtml   = checkList(PUNAISES_SIGNES,   'signes',       'toggleDiagList');
  const zonesHtml    = checkList(PUNAISES_ZONES,    'postes',       'toggleDiagList');
  const materielHtml = checkList(PUNAISES_MATERIEL, 'materiel',     'toggleDiagList');
  const produitsHtml = checkList(PUNAISES_PRODUITS, 'rodenticides', 'toggleDiagList');
  const actionsHtml  = PUNAISES_ACTIONS.map(n => `
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;margin:3px 0;cursor:pointer;">
      <input type="checkbox" ${(d.actions || []).includes(n) ? 'checked' : ''} onchange="toggleDiagList('actions','${n.replace(/'/g, "\\'")}',this.checked)" style="accent-color:var(--navy);"> ${n}
    </label>`).join('');
  const prepaHtml = PUNAISES_PREPARATION.map(n => `
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;margin:3px 0;cursor:pointer;">
      <input type="checkbox" ${(d.preparation || []).includes(n) ? 'checked' : ''} onchange="toggleDiagList('preparation','${n.replace(/'/g, "\\'")}',this.checked)" style="accent-color:var(--navy);"> ${n}
    </label>`).join('');
  box.innerHTML = `
    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🛏️ Identification</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
      <div class="form-group"><label class="form-label">N° de bon (remplissage auto)</label><input class="form-input" placeholder="Tape le n° puis Tab" onchange="autoFillDiagFromBon(this.value)" onblur="autoFillDiagFromBon(this.value)"></div>
      <div class="form-group"><label class="form-label">Date</label><input class="form-input" type="date" value="${d.dateDoc || ''}" oninput="_editingDiag.dateDoc=this.value"></div>
      ${_diagTypeBureauFields(d)}
      <div class="form-group" style="grid-column:1/-1;"><label class="form-label">Nuisible affiché dans le ruban du PDF</label>
        <select class="form-input" oninput="_editingDiag.ruban=this.value">
          <option value="" ${!d.ruban ? 'selected' : ''}>Automatique (espèce cochée, sinon « Punaises de lit »)</option>
          ${['Punaises de lit', 'Punaise de lit commune', 'Punaise de lit tropicale'].map(o => `<option ${d.ruban === o ? 'selected' : ''}>${o}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label class="form-label">Client (gérance)</label>
        <select class="form-input" onchange="onDiagClientSelect(this.value)"><option value="">-- Choisir --</option>${clientOpts}</select>
        <input class="form-input" style="margin-top:5px;font-size:12px;" placeholder="ou nom manuel" value="${(d.clientNom || '').replace(/"/g, '&quot;')}" oninput="_editingDiag.clientNom=this.value;_editingDiag.clientId='';">
      </div>
      ${_diagTechField(d)}
      <div class="form-group"><label class="form-label">Locataire</label><input class="form-input" value="${(d.locataireNom || '').replace(/"/g, '&quot;')}" oninput="_editingDiag.locataireNom=this.value"></div>
      <div class="form-group"><label class="form-label">Site / logement concerné</label><input class="form-input" value="${(d.batiment || '').replace(/"/g, '&quot;')}" oninput="_editingDiag.batiment=this.value" placeholder="Ex. appartement 3e étage, chambre, hôtel"></div>
      <div class="form-group" style="grid-column:1/-1;"><label class="form-label">Adresse</label><input class="form-input" value="${(d.locataireAdresse || '').replace(/"/g, '&quot;')}" oninput="_editingDiag.locataireAdresse=this.value"></div>
    </div>

    ${_diagDatesFields(d)}

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🛏️ Espèce identifiée</div>
    <div style="margin-bottom:10px;">${especesHtml}</div>
    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🔎 Signes observés</div>
    <div style="margin-bottom:12px;">${signesHtml}</div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">📍 Zones inspectées / infestées</div>
    <div style="margin-bottom:12px;">${zonesHtml}</div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:8px;">
      <div class="form-group"><label class="form-label">Activité de l'infestation</label>
        <select class="form-input" oninput="_editingDiag.activite=this.value">
          <option value="" ${!d.activite ? 'selected' : ''}>-- Choisir --</option>
          <option ${d.activite === 'Active' ? 'selected' : ''}>Active</option>
          <option ${d.activite === 'Ancienne (traces)' ? 'selected' : ''}>Ancienne (traces)</option>
          <option ${d.activite === 'Mixte' ? 'selected' : ''}>Mixte</option>
        </select>
      </div>
      <div class="form-group"><label class="form-label">Niveau d'infestation</label>
        <select class="form-input" oninput="_editingDiag.gravite=this.value">
          <option value="" ${!d.gravite ? 'selected' : ''}>-- Choisir --</option>
          <option ${d.gravite === 'Faible' ? 'selected' : ''}>Faible</option>
          <option ${d.gravite === 'Modérée' ? 'selected' : ''}>Modérée</option>
          <option ${d.gravite === 'Importante' ? 'selected' : ''}>Importante</option>
          <option ${d.gravite === 'Critique (infestation massive)' ? 'selected' : ''}>Critique (infestation massive)</option>
        </select>
      </div>
      ${_diagZonesField(d, 'Pièces traitées')}
      <div class="form-group"><label class="form-label">Origine probable / voie d'introduction</label><input class="form-input" value="${(d.elementsTouches || '').replace(/"/g, '&quot;')}" oninput="_editingDiag.elementsTouches=this.value" placeholder="Ex. voyage, mobilier d'occasion, logement voisin, gaines techniques"></div>
    </div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:6px;display:flex;align-items:center;flex-wrap:wrap;">📷 Photo inspection ${_diagSectionToggle('noPhotos', 'Afficher dans le PDF')}</div>
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:8px;margin-bottom:14px;${d.noPhotos ? 'display:none;' : ''}">
      <input type="file" id="diag-photos-file" accept="image/*" multiple style="display:none" onchange="addDiagPhotos(event)">
      <input type="file" id="diag-photo-replace-file" accept="image/*" style="display:none" onchange="onDiagPhotoReplace(event)">
      <button class="btn btn-navy btn-sm" type="button" onclick="document.getElementById('diag-photos-file').click()">📷 Ajouter des photos</button>
      <span style="font-size:11px;color:var(--g400);margin-left:6px;">Incluses dans le PDF avec date et auteur (non stockées en base).</span>
      <div id="diag-photos-box" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;"></div>
    </div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🧰 Matériel / méthode</div>
    <div style="margin-bottom:12px;">${materielHtml}</div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🧪 Traitement appliqué</div>
    <div style="margin-bottom:4px;">${produitsHtml}</div>
    <div class="form-group" style="margin-bottom:12px;max-width:360px;"><input class="form-input" style="font-size:12px;" value="${(d.rodenticideAutre || '').replace(/"/g, '&quot;')}" oninput="_editingDiag.rodenticideAutre=this.value" placeholder="Autre produit (champ libre)"></div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">✅ Mesures du traitement</div>
    <div style="margin-bottom:12px;">${actionsHtml}</div>

    <div style="font-size:12px;font-weight:800;color:#b45309;text-transform:uppercase;margin-bottom:6px;">🧺 Préparation du locataire (avant / après traitement)</div>
    <div style="border:1.5px solid #fcd34d;background:#fffbeb;border-radius:8px;padding:10px;margin-bottom:14px;">
      <div style="font-size:11px;color:#92400e;margin-bottom:6px;">Coche les consignes remises au locataire — elles apparaîtront dans le PDF. Sans préparation, un traitement punaises échoue le plus souvent.</div>
      ${prepaHtml}
      <div class="form-group" style="margin-top:8px;margin-bottom:0;">
        <textarea class="form-input" rows="2" oninput="_editingDiag.preparationRem=this.value" placeholder="Consignes complémentaires (champ libre)">${d.preparationRem || ''}</textarea>
      </div>
    </div>

    <div class="form-group" style="margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;"><label class="form-label">Observations détaillées</label><button type="button" class="btn btn-ghost btn-sm" id="diag-ai-diagnostic" onclick="diagAICorrect('diagnostic')" style="font-size:11px;padding:2px 8px;">✨ Corriger IA</button></div>
      <textarea class="form-input" id="diag-ta-diagnostic" rows="3" oninput="_editingDiag.diagnostic=this.value;diagTaAutoGrow(this)" onfocus="diagTaAutoGrow(this)" onblur="diagTaShrink(this)">${d.diagnostic || ''}</textarea>
    </div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">💊 Plan de traitement & suivi</div>
    <div class="form-group" style="margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;align-items:center;"><label class="form-label">Plan de traitement</label><button type="button" class="btn btn-ghost btn-sm" id="diag-ai-traitement" onclick="diagAICorrect('traitement')" style="font-size:11px;padding:2px 8px;">✨ Corriger IA</button></div>
      <textarea class="form-input" id="diag-ta-traitement" rows="3" oninput="_editingDiag.traitement=this.value;diagTaAutoGrow(this)" onfocus="diagTaAutoGrow(this)" onblur="diagTaShrink(this)" placeholder="Ex. vapeur + insecticide rémanent sur literie et plinthes, 2e passage à J+15 pour traiter les éclosions...">${d.traitement || ''}</textarea>
    </div>
    <div class="form-group" style="margin-bottom:14px;"><label class="form-label">Suivi / prochain passage</label>
      <select class="form-input" oninput="_editingDiag.suivi=this.value">
        <option value="" ${!d.suivi ? 'selected' : ''}>-- Choisir --</option>
        ${SUIVI_OPTIONS.map(o => `<option ${d.suivi === o ? 'selected' : ''}>${o}</option>`).join('')}
        ${d.suivi && !SUIVI_OPTIONS.includes(d.suivi) ? `<option selected>${d.suivi.replace(/</g, '&lt;')}</option>` : ''}
      </select>
      <input class="form-input" style="margin-top:5px;font-size:12px;" value="${(d.suiviRem || '').replace(/"/g, '&quot;')}" oninput="_editingDiag.suiviRem=this.value" placeholder="Remarque complémentaire (champ libre)">
    </div>

    <div class="form-group" style="margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;"><label class="form-label">Prévention recommandée</label><button type="button" class="btn btn-ghost btn-sm" id="diag-ai-prevention" onclick="diagAICorrect('prevention')" style="font-size:11px;padding:2px 8px;">✨ Corriger IA</button></div>
      <textarea class="form-input" id="diag-ta-prevention" rows="2" oninput="_editingDiag.prevention=this.value;diagTaAutoGrow(this)" onfocus="diagTaAutoGrow(this)" onblur="diagTaShrink(this)" placeholder="Ex. inspecter les bagages au retour de voyage, éviter le mobilier d'occasion, housses de matelas...">${d.prevention || ''}</textarea>
    </div>

    ${_diagContratFields(d)}

    <div class="form-group">
      <div style="display:flex;justify-content:space-between;align-items:center;"><label class="form-label">Conclusion / recommandations</label><button type="button" class="btn btn-ghost btn-sm" id="diag-ai-conclusion" onclick="diagAICorrect('conclusion')" style="font-size:11px;padding:2px 8px;">✨ Corriger IA</button></div>
      <textarea class="form-input" id="diag-ta-conclusion" rows="2" oninput="_editingDiag.conclusion=this.value;diagTaAutoGrow(this)" onfocus="diagTaAutoGrow(this)" onblur="diagTaShrink(this)">${d.conclusion || ''}</textarea>
    </div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin:14px 0 6px;display:flex;align-items:center;flex-wrap:wrap;">✍️ Signature numérique ${_diagSectionToggle('noSign', 'Afficher dans le PDF')}</div>
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:8px;${d.noSign ? 'display:none;' : ''}">
      <canvas id="diag-sign-canvas" width="400" height="140" style="width:min(400px,100%);height:auto;border:1px dashed #ccc;border-radius:6px;cursor:crosshair;touch-action:none;background:#fff;"></canvas>
      <div style="display:flex;gap:6px;margin-top:6px;align-items:center;flex-wrap:wrap;">
        <button class="btn btn-ghost btn-sm" type="button" onclick="clearDiagSignature()">↺ Effacer</button>
        <span style="font-size:11px;color:var(--g400);">Signe à la souris ou au doigt — la signature est insérée dans le PDF (non stockée en base).</span>
      </div>
    </div>
  `;
  const t = $('modal-diag-title'); if (t) t.textContent = 'Rapport punaises de lit ' + (d.numero || '');
  initDiagSignPad();
  renderDiagPhotos();
}

function openNewBlattes() {
  _editingDiag = {
    id: newId(), numero: _nextDiagNumero('BL'), dateDoc: today(), tech: '',
    clientId: '', clientNom: '', locataireNom: '', locataireAdresse: '',
    batiment: '', bonId: '', insectes: [], elementsTouches: '',
    activite: '', gravite: '', zones: '', diagnostic: '', conclusion: '',
    traitement: '', suivi: '', prevention: '', hygiene: '', signes: [], postes: [], materiel: [],
    rodenticides: [], actions: [], photos: [],
    bureau: 'ne', doctype: 'Rapport', noPlan: '1', noPhotos: '', noTech: '', statut: '', ruban: '', noSign: '1',
    rodenticideAutre: '', postesNb: '', suiviRem: '',
    contrat: '', contratPassages: '', contratMontant: '', contratZones: '', contratRem: '',
    dateInt1: '', dateInt2: '', dateInt3: '', dateProchain: ''
  };
  renderDiagEditor(); openModal('modal-diag');
}

function renderBlattesEditor() {
  const d = _editingDiag; if (!d) return;
  const box = $('modal-diag-body'); if (!box) return;
  const clientOpts = (DB.clients||[]).slice().sort((a,b)=>(a.nom||'').localeCompare(b.nom||'')).map(c=>`<option value="${c.id}" ${d.clientId===c.id?'selected':''}>${_clientOptionLabel(c).replace(/</g,'&lt;')}</option>`).join('');
  const checkList = (arr, field, toggleFn) => arr.map(n => `
    <label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;margin:3px 10px 3px 0;cursor:pointer;">
      <input type="checkbox" ${(d[field]||[]).includes(n)?'checked':''} onchange="${toggleFn}('${field}','${n.replace(/'/g,"\\'")}',this.checked)" style="accent-color:var(--navy);"> ${n}
    </label>`).join('');
  const especesHtml = BLATTES_ESPECES.map(n => `
    <label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;margin:3px 10px 3px 0;cursor:pointer;">
      <input type="checkbox" ${(d.insectes||[]).includes(n)?'checked':''} onchange="toggleDiagInsecte('${n.replace(/'/g,"\\'")}',this.checked)" style="accent-color:var(--navy);"> ${n}
    </label>`).join('');
  const signesHtml   = checkList(BLATTES_SIGNES,   'signes',       'toggleDiagList');
  const materielHtml = checkList(BLATTES_MATERIEL, 'materiel',     'toggleDiagList');
  const produitsHtml = checkList(BLATTES_PRODUITS, 'rodenticides', 'toggleDiagList');
  const actionsHtml  = BLATTES_ACTIONS.map(n => `
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;margin:3px 0;cursor:pointer;">
      <input type="checkbox" ${(d.actions||[]).includes(n)?'checked':''} onchange="toggleDiagList('actions','${n.replace(/'/g,"\\'")}',this.checked)" style="accent-color:var(--navy);"> ${n}
    </label>`).join('');
  box.innerHTML = `
    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🪳 Identification</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
      <div class="form-group"><label class="form-label">N° de bon (remplissage auto)</label><input class="form-input" placeholder="Tape le n° puis Tab" onchange="autoFillDiagFromBon(this.value)" onblur="autoFillDiagFromBon(this.value)"></div>
      <div class="form-group"><label class="form-label">Date</label><input class="form-input" type="date" value="${d.dateDoc||''}" oninput="_editingDiag.dateDoc=this.value"></div>
      ${_diagTypeBureauFields(d)}
      <div class="form-group" style="grid-column:1/-1;"><label class="form-label">Nuisible affiché dans le ruban du PDF</label>
        <select class="form-input" oninput="_editingDiag.ruban=this.value">
          <option value="" ${!d.ruban?'selected':''}>Automatique (espèce cochée, sinon « Blattes »)</option>
          ${['Blattes','Blatte germanique','Blatte orientale','Blatte américaine','Blatte rayée','Cafards'].map(o => `<option ${d.ruban===o?'selected':''}>${o}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label class="form-label">Client (gérance)</label>
        <select class="form-input" onchange="onDiagClientSelect(this.value)"><option value="">-- Choisir --</option>${clientOpts}</select>
        <input class="form-input" style="margin-top:5px;font-size:12px;" placeholder="ou nom manuel" value="${(d.clientNom||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.clientNom=this.value;_editingDiag.clientId='';">
      </div>
      ${_diagTechField(d)}
      <div class="form-group"><label class="form-label">Locataire</label><input class="form-input" value="${(d.locataireNom||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.locataireNom=this.value"></div>
      <div class="form-group"><label class="form-label">Site / bâtiment concerné</label><input class="form-input" value="${(d.batiment||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.batiment=this.value" placeholder="Ex. cuisine, restaurant, immeuble locatif"></div>
      <div class="form-group" style="grid-column:1/-1;"><label class="form-label">Adresse</label><input class="form-input" value="${(d.locataireAdresse||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.locataireAdresse=this.value"></div>
    </div>

    ${_diagDatesFields(d)}

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🪳 Espèces détectées</div>
    <div style="margin-bottom:10px;">${especesHtml}</div>
    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🔎 Signes observés</div>
    <div style="margin-bottom:12px;">${signesHtml}</div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:8px;">
      <div class="form-group"><label class="form-label">Activité de l'infestation</label>
        <select class="form-input" oninput="_editingDiag.activite=this.value">
          <option value="" ${!d.activite?'selected':''}>-- Choisir --</option>
          <option ${d.activite==='Active'?'selected':''}>Active</option>
          <option ${d.activite==='Ancienne (traces)'?'selected':''}>Ancienne (traces)</option>
          <option ${d.activite==='Mixte'?'selected':''}>Mixte</option>
        </select>
      </div>
      <div class="form-group"><label class="form-label">Niveau d'infestation</label>
        <select class="form-input" oninput="_editingDiag.gravite=this.value">
          <option value="" ${!d.gravite?'selected':''}>-- Choisir --</option>
          <option ${d.gravite==='Faible'?'selected':''}>Faible</option>
          <option ${d.gravite==='Modérée'?'selected':''}>Modérée</option>
          <option ${d.gravite==='Importante'?'selected':''}>Importante</option>
          <option ${d.gravite==='Critique (infestation massive)'?'selected':''}>Critique (infestation massive)</option>
        </select>
      </div>
      ${_diagZonesField(d, 'Zones inspectées / d\'activité')}
      <div class="form-group"><label class="form-label">Foyers / points d'eau / zones chaudes</label><input class="form-input" value="${(d.elementsTouches||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.elementsTouches=this.value" placeholder="Ex. derrière le frigo, sous l'évier, gaines techniques"></div>
    </div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:6px;display:flex;align-items:center;flex-wrap:wrap;">📷 Photo inspection ${_diagSectionToggle('noPhotos','Afficher dans le PDF')}</div>
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:8px;margin-bottom:14px;${d.noPhotos?'display:none;':''}">
      <input type="file" id="diag-photos-file" accept="image/*" multiple style="display:none" onchange="addDiagPhotos(event)">
      <input type="file" id="diag-photo-replace-file" accept="image/*" style="display:none" onchange="onDiagPhotoReplace(event)">
      <button class="btn btn-navy btn-sm" type="button" onclick="document.getElementById('diag-photos-file').click()">📷 Ajouter des photos</button>
      <span style="font-size:11px;color:var(--g400);margin-left:6px;">Incluses dans le PDF avec date et auteur (non stockées en base).</span>
      <div id="diag-photos-box" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;"></div>
    </div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🧰 Matériel / méthode</div>
    <div style="margin-bottom:12px;">${materielHtml}</div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🧪 Insecticide / gel professionnel utilisé</div>
    <div style="margin-bottom:4px;">${produitsHtml}</div>
    <div class="form-group" style="margin-bottom:12px;max-width:360px;"><input class="form-input" style="font-size:12px;" value="${(d.rodenticideAutre||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.rodenticideAutre=this.value" placeholder="Autre produit (champ libre)"></div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">✅ Mesures du traitement</div>
    <div style="margin-bottom:12px;">${actionsHtml}</div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:6px;">🎯 Points de gel / pièges posés</div>
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:8px;margin-bottom:14px;">
      <div class="form-group" style="margin-bottom:8px;max-width:240px;"><label class="form-label">Nombre de points de gel / pièges</label><input class="form-input" type="number" min="0" step="1" value="${String(d.postesNb||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.postesNb=this.value" placeholder="Ex. 12"></div>
      <div style="font-size:11px;color:var(--g400);margin-bottom:6px;">Le détail ci-dessous est facultatif — le nombre seul suffit pour le PDF.</div>
      <div id="rongeur-postes-box" style="margin-bottom:6px;"></div>
      <button class="btn btn-navy btn-sm" type="button" onclick="addRongeurPoste()">+ Ajouter un point</button>
    </div>

    <div class="form-group" style="margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;"><label class="form-label">Observations détaillées</label><button type="button" class="btn btn-ghost btn-sm" id="diag-ai-diagnostic" onclick="diagAICorrect('diagnostic')" style="font-size:11px;padding:2px 8px;">✨ Corriger IA</button></div>
      <textarea class="form-input" id="diag-ta-diagnostic" rows="3" oninput="_editingDiag.diagnostic=this.value;diagTaAutoGrow(this)" onfocus="diagTaAutoGrow(this)" onblur="diagTaShrink(this)">${d.diagnostic||''}</textarea>
    </div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">💊 Plan de traitement & suivi</div>
    <div class="form-group" style="margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;align-items:center;"><label class="form-label">Plan de traitement</label><button type="button" class="btn btn-ghost btn-sm" id="diag-ai-traitement" onclick="diagAICorrect('traitement')" style="font-size:11px;padding:2px 8px;">✨ Corriger IA</button></div>
      <textarea class="form-input" id="diag-ta-traitement" rows="3" oninput="_editingDiag.traitement=this.value;diagTaAutoGrow(this)" onfocus="diagTaAutoGrow(this)" onblur="diagTaShrink(this)" placeholder="Ex. application de gel dans la cuisine, 2e passage à J+15 pour rompre le cycle...">${d.traitement||''}</textarea>
    </div>
    <div class="form-group" style="margin-bottom:14px;"><label class="form-label">Suivi / prochain passage</label>
      <select class="form-input" oninput="_editingDiag.suivi=this.value">
        <option value="" ${!d.suivi?'selected':''}>-- Choisir --</option>
        ${SUIVI_OPTIONS.map(o => `<option ${d.suivi===o?'selected':''}>${o}</option>`).join('')}
        ${d.suivi && !SUIVI_OPTIONS.includes(d.suivi) ? `<option selected>${d.suivi.replace(/</g,'&lt;')}</option>` : ''}
      </select>
      <input class="form-input" style="margin-top:5px;font-size:12px;" value="${(d.suiviRem||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.suiviRem=this.value" placeholder="Remarque complémentaire (champ libre)">
    </div>

    <div class="form-group" style="margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;"><label class="form-label">🧼 Hygiène recommandée au client</label><button type="button" class="btn btn-ghost btn-sm" id="diag-ai-hygiene" onclick="diagAICorrect('hygiene')" style="font-size:11px;padding:2px 8px;">✨ Corriger IA</button></div>
      <textarea class="form-input" id="diag-ta-hygiene" rows="2" oninput="_editingDiag.hygiene=this.value;diagTaAutoGrow(this)" onfocus="diagTaAutoGrow(this)" onblur="diagTaShrink(this)" placeholder="Ex. nettoyage des graisses derrière les appareils, ne pas laisser de vaisselle/denrées la nuit, vider les poubelles, réparer les fuites d'eau...">${d.hygiene||''}</textarea>
    </div>

    <div class="form-group" style="margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;"><label class="form-label">Prévention recommandée</label><button type="button" class="btn btn-ghost btn-sm" id="diag-ai-prevention" onclick="diagAICorrect('prevention')" style="font-size:11px;padding:2px 8px;">✨ Corriger IA</button></div>
      <textarea class="form-input" id="diag-ta-prevention" rows="2" oninput="_editingDiag.prevention=this.value;diagTaAutoGrow(this)" onfocus="diagTaAutoGrow(this)" onblur="diagTaShrink(this)" placeholder="Ex. colmater les fissures, étanchéifier les passages de conduites, contrôler les livraisons...">${d.prevention||''}</textarea>
    </div>

    ${_diagContratFields(d)}

    <div class="form-group">
      <div style="display:flex;justify-content:space-between;align-items:center;"><label class="form-label">Conclusion / recommandations</label><button type="button" class="btn btn-ghost btn-sm" id="diag-ai-conclusion" onclick="diagAICorrect('conclusion')" style="font-size:11px;padding:2px 8px;">✨ Corriger IA</button></div>
      <textarea class="form-input" id="diag-ta-conclusion" rows="2" oninput="_editingDiag.conclusion=this.value;diagTaAutoGrow(this)" onfocus="diagTaAutoGrow(this)" onblur="diagTaShrink(this)">${d.conclusion||''}</textarea>
    </div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin:14px 0 6px;display:flex;align-items:center;flex-wrap:wrap;">✍️ Signature numérique ${_diagSectionToggle('noSign','Afficher dans le PDF')}</div>
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:8px;${d.noSign?'display:none;':''}">
      <canvas id="diag-sign-canvas" width="400" height="140" style="width:min(400px,100%);height:auto;border:1px dashed #ccc;border-radius:6px;cursor:crosshair;touch-action:none;background:#fff;"></canvas>
      <div style="display:flex;gap:6px;margin-top:6px;align-items:center;flex-wrap:wrap;">
        <button class="btn btn-ghost btn-sm" type="button" onclick="clearDiagSignature()">↺ Effacer</button>
        <span style="font-size:11px;color:var(--g400);">Signe à la souris ou au doigt — la signature est insérée dans le PDF (non stockée en base).</span>
      </div>
    </div>
  `;
  const t = $('modal-diag-title'); if (t) t.textContent = 'Rapport blattes ' + (d.numero||'');
  initDiagSignPad();
  renderDiagPhotos();
  renderRongeursPostes();
  box.oninput = () => refreshDiagPreview();
  _syncDiagPreviewPane();
  refreshDiagPreview();
}

function _genBlattesPDF(d, mode) {
  if (!d) { if (mode !== 'blob') toast('Rapport introuvable', '#e63946'); return; }
  if (!window.jspdf || !window.jspdf.jsPDF) { toast('Librairie PDF non chargée', '#e63946'); return; }
  const co = DERATEK_CONFIG.company;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:'mm', format:'a4' });
  const M = 20, R = 190, CW = R - M;
  const NAVY = [13,27,62], SLATE = [95,111,129], GREY = [110,110,110];
  const MAX_Y = 270;
  let y = 0;

  const newPage = () => { doc.addPage(); y = 20; };
  const ensure = (h) => { if (y + h > MAX_Y) newPage(); };
  const section = (titre, keep) => {
    ensure(14 + (keep || 0));
    doc.setFillColor(SLATE[0],SLATE[1],SLATE[2]); doc.rect(M, y-3.2, 2.4, 4.4, 'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(NAVY[0],NAVY[1],NAVY[2]);
    doc.text(titre, M+4.5, y);
    doc.setDrawColor(SLATE[0],SLATE[1],SLATE[2]); doc.setLineWidth(0.4); doc.line(M, y+1.8, R, y+1.8);
    y += 7.5; doc.setTextColor(0); doc.setFont('helvetica','normal'); doc.setFontSize(10);
  };
  const field = (lbl, val, indent) => {
    if (!val) return;
    const x = indent || M;
    doc.setFont('helvetica','bold'); doc.setFontSize(9.5);
    const vx = x + Math.max(40, doc.getTextWidth(lbl + ' :') + 3);
    const lines = doc.splitTextToSize(String(val), R - vx - 2);
    ensure(Math.max(lines.length*4.8, 5.5) + 2);
    doc.setTextColor(60);
    doc.text(lbl + ' :', x, y);
    doc.setFont('helvetica','normal'); doc.setTextColor(0);
    doc.text(lines, vx, y);
    y += Math.max(lines.length*4.8, 5.5);
  };
  const para = (txt) => {
    if (!txt) return;
    doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(0);
    doc.splitTextToSize(String(txt), CW).forEach(ln => { ensure(6); doc.text(ln, M, y); y += 4.9; });
  };
  const badge = (txt, rgb, x, yy) => {
    doc.setFont('helvetica','bold'); doc.setFontSize(8.5);
    const w = doc.getTextWidth(txt) + 6;
    doc.setFillColor(rgb[0],rgb[1],rgb[2]);
    doc.roundedRect(x, yy-4.1, w, 5.6, 2.8, 2.8, 'F');
    doc.setTextColor(255); doc.text(txt, x+3, yy);
    doc.setTextColor(0);
    return w;
  };
  const GRAV_RGB = { 'Faible':[45,158,107], 'Modérée':[230,170,30], 'Importante':[235,120,40], 'Critique (infestation massive)':[230,57,70] };
  const ACT_RGB  = { 'Active':[230,57,70], 'Ancienne (traces)':[120,120,120], 'Mixte':[235,120,40] };

  // En-tête horizontal — identique aux factures / rapport rongeurs
  const bu = (typeof BUREAUX !== 'undefined' && BUREAUX.find(b => b.id === d.bureau)) || { rue: co.rue, npa: co.npa, ville: co.ville, tel: co.tel };
  const logoW = 62, logoH = logoW*199/900;
  const logoY = 13;
  const headerFiletY = logoY + logoH + 5;
  if (typeof LOGO_B64 !== 'undefined') { try { doc.addImage(LOGO_B64,'PNG',20,logoY,logoW,logoH); } catch(e){} }
  else { doc.setFont('helvetica','bold'); doc.setFontSize(20); doc.setTextColor(13,27,62); doc.text('DERATEK', 20, 23); }
  const cy0 = logoY + 4;
  doc.setFont('helvetica','normal'); doc.setFontSize(8.5); doc.setTextColor(70);
  [bu.rue, `${bu.npa} ${bu.ville}`, 'Tél. '+(bu.tel||co.tel)].forEach((l,i)=>{ if(l) doc.text(l, 92, cy0 + i*4.4); });
  [co.email, co.tva].forEach((l,i)=>{ if(l) doc.text(l, 146, cy0 + i*4.4); });
  doc.setTextColor(13,27,62);
  try { doc.textWithLink('www.deratek.ch', 146, cy0 + 2*4.4, { url:'https://www.deratek.ch' }); } catch(e) { doc.text('www.deratek.ch', 146, cy0 + 2*4.4); }
  doc.setTextColor(0);
  doc.setDrawColor(200,205,213); doc.setLineWidth(0.4); doc.line(20, headerFiletY, 190, headerFiletY);
  doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(13,27,62);
  doc.text((bu.ville||'Neuchâtel') + ', le ' + (fmtDate(d.dateDoc)||''), 190, headerFiletY + 5, { align:'right' });
  doc.setFont('helvetica','normal'); doc.setTextColor(0);
  const bi = _diagBonInfo(d) || {};

  // Bandeau titre
  y = headerFiletY + 9;
  doc.setFillColor(NAVY[0],NAVY[1],NAVY[2]);
  doc.roundedRect(M, y, CW, 16, 2, 2, 'F');
  doc.setFont('helvetica','bold'); doc.setFontSize(14); doc.setTextColor(255);
  doc.text((d.doctype==='Expertise'?'EXPERTISE':'RAPPORT') + ' N° ' + (d.numero||''), M+6, y+6.8);
  doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.setTextColor(225,228,238);
  const rubanTxt = d.ruban || (((d.insectes||[]).length === 1) ? d.insectes[0] : 'Blattes');
  doc.text(rubanTxt + ' — détection & plan d\'action', M+6, y+12.4);
  doc.setFontSize(10.5); doc.setFont('helvetica','bold'); doc.setTextColor(255);
  doc.text(fmtDate(d.dateDoc)||'', R-6, y+6.8, { align:'right' });
  doc.setTextColor(0);
  y += 21;

  // Informations sur 2 colonnes
  y = _diagRows2Col(doc, [
    ['Technicien', d.noTech ? '' : d.tech],
    ['Client', [(d.clientNom||''), bi.clientAdresse].filter(Boolean).join('\n')],
    ['N° bon de commande', bi.bonNumero],
    ['Adresse d\'intervention', d.locataireAdresse],
    ['Gérant', bi.gerant],
    ['Téléphone', bi.tel],
    ['Email', bi.email],
    ['Locataire', d.locataireNom],
    ['Tél. locataire', bi.locTel],
    ['Logement', (bi.logement && bi.logement !== d.locataireAdresse) ? bi.logement : ''],
    ['Site / bâtiment', d.batiment],
    ['Zones inspectées', d.zones],
    ['Foyers / zones chaudes', d.elementsTouches],
  ], y, M, CW);

  y = _diagDatesStrip(doc, d, y + 5, M, CW);
  y += 1;

  // Synthèse
  const postes = Array.isArray(d.postes) ? d.postes.filter(p => p && (p.emplacement || p.produit)) : [];
  const synth = [
    ['ACTIVITÉ', d.activite, ACT_RGB[d.activite]],
    ['NIVEAU D\'INFESTATION', d.gravite, GRAV_RGB[d.gravite]],
    ['ESPÈCES', (d.insectes||[]).length ? (d.insectes||[]).length + ' détectée(s)' : '', null],
    ['POINTS TRAITÉS', d.postesNb ? String(d.postesNb) : (postes.length ? String(postes.length) : ''), null],
  ];
  if (synth.some(s => s[1])) {
    ensure(20);
    const colW = CW/4;
    doc.setDrawColor(225,228,238); doc.setLineWidth(0.3);
    doc.roundedRect(M, y, CW, 15, 2, 2, 'D');
    synth.forEach((s, i) => {
      const cx = M + i*colW + 4;
      if (i) doc.line(M + i*colW, y+2.5, M + i*colW, y+12.5);
      doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(GREY[0],GREY[1],GREY[2]);
      doc.text(s[0], cx, y+5);
      if (!s[1]) { doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(150); doc.text('—', cx, y+11.2); return; }
      if (s[2]) { badge(String(s[1]).replace(' (infestation massive)',''), s[2], cx, y+11.2); }
      else {
        doc.setFont('helvetica','bold'); doc.setFontSize(9.5); doc.setTextColor(NAVY[0],NAVY[1],NAVY[2]);
        doc.text(doc.splitTextToSize(String(s[1]), colW-8)[0]||'', cx, y+11.2);
      }
    });
    doc.setTextColor(0);
    y += 21;
  }

  // Constatations
  section('Constatations');
  field('Espèces détectées', (d.insectes||[]).join(', '));
  field('Signes observés', (d.signes||[]).join(', '));
  field('Foyers / zones chaudes', d.elementsTouches);
  if (d.diagnostic) {
    y += 1.5;
    doc.setFont('helvetica','bold'); doc.setFontSize(9.5); doc.setTextColor(60);
    ensure(8); doc.text('Observations :', M, y); y += 5; doc.setTextColor(0);
    para(d.diagnostic);
  }

  // Photos
  const photos = (!d.noPhotos && Array.isArray(d.photos)) ? d.photos.filter(p => p && p.data && p.use !== false) : [];
  if (photos.length) {
    y += 2; section('Photos de l\'inspection', 62);
    const pw = (CW - 6) / 2, ph = 58;
    photos.forEach((p, i) => {
      const col = i % 2;
      if (col === 0 && y + ph + 8 > MAX_Y) newPage();
      const px = M + col*(pw+6);
      try {
        doc.addImage(p.data, 'JPEG', px, y, pw, ph);
        doc.setDrawColor(225,228,238); doc.rect(px, y, pw, ph, 'D');
        const meta = (typeof _diagPhotoMeta === 'function') ? _diagPhotoMeta(p) : '';
        const cap = ['Photo ' + (i+1), p.caption, meta ? '(' + meta + ')' : ''].filter(Boolean).join(' — ');
        doc.setFont('helvetica','italic'); doc.setFontSize(7.5); doc.setTextColor(70);
        doc.text(doc.splitTextToSize(cap, pw).slice(0, 2), px, y+ph+3.6);
        doc.setTextColor(0);
      } catch (e) {}
      if (col === 1 || i === photos.length-1) y += ph + 8;
    });
    y += 2;
  }

  // Tableau des points de gel / pièges
  if (postes.length) {
    y += 2; section('Points de gel / pièges posés', 18);
    const c1 = M, c2 = M+14, c3 = M+105;
    const drawPostesHeader = () => {
      doc.setFillColor(NAVY[0],NAVY[1],NAVY[2]);
      doc.rect(M, y-4, CW, 6.5, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(8.5); doc.setTextColor(255);
      doc.text('N°', c1+2, y); doc.text('Emplacement', c2+2, y); doc.text('Produit / dispositif', c3+2, y);
      doc.setTextColor(0);
      y += 5;
    };
    ensure(8);
    drawPostesHeader();
    postes.forEach((p, i) => {
      const lines1 = doc.splitTextToSize(String(p.emplacement||'—'), c3-c2-6);
      const lines2 = doc.splitTextToSize(String(p.produit||'—'), R-c3-6);
      const rowH = Math.max(lines1.length, lines2.length)*4.6 + 2.4;
      if (y + rowH + 2 > MAX_Y) { newPage(); drawPostesHeader(); }
      if (i % 2 === 0) { doc.setFillColor(246,247,250); doc.rect(M, y-3.4, CW, rowH, 'F'); }
      doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.text(String(i+1), c1+2, y);
      doc.setFont('helvetica','normal');
      doc.text(lines1, c2+2, y);
      doc.text(lines2, c3+2, y);
      y += rowH;
    });
    doc.setDrawColor(225,228,238); doc.setLineWidth(0.3); doc.line(M, y-2.8, R, y-2.8);
    y += 4;
  }

  // Fiches des espèces détectées
  const fiches = (d.insectes||[]).filter(n => BLATTES_INFO[n]);
  if (fiches.length) {
    y += 2; section('Fiches des espèces détectées', 38);
    fiches.forEach(nom => {
      const f = BLATTES_INFO[nom];
      doc.setFont('helvetica','normal'); doc.setFontSize(9.5);
      const estH = 13 + [f.habitat, f.indices, f.biologie, f.risque].reduce((s,v)=> s + Math.max(doc.splitTextToSize(String(v),135).length*4.8, 5.5), 0);
      ensure(Math.min(estH, 75));
      doc.setFillColor(238,241,246);
      doc.roundedRect(M, y-1, CW, 7, 1.5, 1.5, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(10);
      const nomW = doc.getTextWidth(nom);
      doc.setTextColor(SLATE[0],SLATE[1],SLATE[2]);
      doc.text(nom, M+3, y+3.6);
      doc.setFont('helvetica','italic'); doc.setFontSize(9); doc.setTextColor(110);
      doc.text(f.latin, M+3+nomW+4, y+3.6);
      doc.setTextColor(0);
      y += 10;
      field('Habitat', f.habitat, M+3);
      field('Indices typiques', f.indices, M+3);
      field('Biologie', f.biologie, M+3);
      field('Risque', f.risque, M+3);
      y += 3;
    });
  }

  // Plan de traitement & suivi
  const materiel = Array.isArray(d.materiel) ? d.materiel : [];
  const produits = Array.isArray(d.rodenticides) ? d.rodenticides : [];
  const actions = Array.isArray(d.actions) ? d.actions : [];
  const checkLine = (txt) => {
    const lines = doc.splitTextToSize(String(txt), CW - 8);
    ensure(lines.length*4.8 + 2);
    doc.setDrawColor(NAVY[0],NAVY[1],NAVY[2]); doc.setLineWidth(0.35);
    doc.rect(M, y-3, 3.2, 3.2);
    doc.setDrawColor(45,158,107); doc.setLineWidth(0.6);
    doc.line(M+0.7, y-1.4, M+1.4, y-0.6); doc.line(M+1.4, y-0.6, M+2.7, y-2.6);
    doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.setTextColor(0);
    doc.text(lines, M+5.5, y);
    y += lines.length*4.8 + 1;
  };
  if (d.traitement || d.suivi || materiel.length || produits.length || actions.length) {
    y += 2; section('Plan de traitement', 12);
    if (materiel.length) { field('Matériel / méthode', materiel.join(', ')); y += 1; }
    if (d.postesNb) { field('Nombre de points de gel / pièges', String(d.postesNb)); y += 1; }
    const prodAucun = produits.includes('Aucun produit chimique');
    const prodList = produits.filter(r => r !== 'Aucun produit chimique');
    if (prodAucun && !prodList.length && !d.rodenticideAutre) { field('Produit', 'Aucun produit chimique utilisé'); y += 1; }
    else if (prodList.length || d.rodenticideAutre) { field('Insecticide / gel professionnel', [...prodList, d.rodenticideAutre].filter(Boolean).join(', ')); y += 1; }
    para(d.traitement);
    if (actions.length) { y += 1.5; actions.forEach(a => checkLine(a)); }
    const suiviTxt = [d.suivi, d.suiviRem].filter(Boolean).join(' — ');
    if (suiviTxt) { y += 1.5; field('Suivi / prochain passage', suiviTxt); }
  }

  // Hygiène recommandée
  if (d.hygiene) {
    y += 2; section('Hygiène recommandée', 12);
    para(d.hygiene);
  }

  // Prévention recommandée
  if (d.prevention) {
    y += 2; section('Prévention recommandée', 12);
    para(d.prevention);
  }

  // Proposition de contrat annuel
  if (d.contrat) {
    y += 2; section('Proposition de contrat annuel', 18);
    para("Au vu de la situation constatée, une proposition de contrat annuel peut être envisagée afin d'assurer un suivi régulier, de limiter les risques de récidive et de maintenir une surveillance préventive des zones sensibles.");
    y += 1.5;
    field('Passages annuels proposés', d.contratPassages);
    field('Montant estimatif', d.contratMontant);
    field('Zones concernées', d.contratZones);
    field('Remarques', d.contratRem);
  }

  // Conclusion (encadré)
  if (d.conclusion) {
    // On fixe la police AVANT de découper : sinon le calcul de largeur se fait avec
    // la taille laissée par la section précédente et les lignes débordent du cadre.
    doc.setFont('helvetica','normal'); doc.setFontSize(10);
    const lines = doc.splitTextToSize(String(d.conclusion), CW-13);
    const boxH = lines.length*4.9 + 8;
    if (y + boxH + 12 > MAX_Y) newPage();
    y += 2; section('Conclusion / recommandations');
    doc.setFillColor(240,243,250); doc.setDrawColor(NAVY[0],NAVY[1],NAVY[2]); doc.setLineWidth(0.3);
    doc.roundedRect(M, y-2, CW, boxH, 2, 2, 'FD');
    doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(NAVY[0],NAVY[1],NAVY[2]);
    lines.forEach((ln, i) => doc.text(ln, M+5, y+3.5 + i*4.9));
    doc.setTextColor(0);
    y += boxH + 4;
  }

  // Signature
  if (!d.noSign) {
    ensure(32);
    y += 8;
    doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.setTextColor(40);
    doc.text(bu.ville + ', le ' + (fmtDate(d.dateDoc)||''), M, y);
    doc.text('DERATEK' + (d.tech && !d.noTech ? ' — ' + d.tech : ''), 120, y);
    if (d.signature) { try { doc.addImage(d.signature, 'PNG', 120, y+1.5, 45, 15.75); } catch (e) {} }
    doc.setDrawColor(120); doc.setLineWidth(0.3); doc.line(120, y+18, 186, y+18);
    doc.setFontSize(8); doc.setTextColor(GREY[0],GREY[1],GREY[2]);
    doc.text('Signature', 120, y+21.5);
    doc.setTextColor(0);
  }

  // Pied de page
  const nb = doc.getNumberOfPages();
  for (let i = 1; i <= nb; i++) {
    doc.setPage(i);
    doc.setDrawColor(SLATE[0],SLATE[1],SLATE[2]); doc.setLineWidth(0.3); doc.line(M, 283, R, 283);
    doc.setFont('helvetica','normal'); doc.setFontSize(7.5); doc.setTextColor(GREY[0],GREY[1],GREY[2]);
    doc.text('DERATEK Professional Pest Control — ' + co.rue + ', ' + co.npa + ' ' + co.ville + ' — ' + co.email, M, 287.5);
    doc.text('Page ' + i + '/' + nb, R, 287.5, { align:'right' });
    doc.setTextColor(0);
  }

  if (mode === 'blob') return doc.output('blob');
  doc.save('rapport-blattes-' + (d.numero||'doc').replace(/[^a-z0-9]+/gi,'-').toLowerCase() + '.pdf');
  toast('✓ PDF rapport blattes téléchargé', '#2d9e6b');
}

function _genPunaisesPDF(d, mode) {
  if (!d) { if (mode !== 'blob') toast('Rapport introuvable', '#e63946'); return; }
  if (!window.jspdf || !window.jspdf.jsPDF) { toast('Librairie PDF non chargée', '#e63946'); return; }
  const co = DERATEK_CONFIG.company;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:'mm', format:'a4' });
  const M = 20, R = 190, CW = R - M;
  const NAVY = [13,27,62], SLATE = [95,111,129], GREY = [110,110,110];
  const MAX_Y = 270;
  let y = 0;

  const newPage = () => { doc.addPage(); y = 20; };
  const ensure = (h) => { if (y + h > MAX_Y) newPage(); };
  const section = (titre, keep) => {
    ensure(14 + (keep || 0));
    doc.setFillColor(SLATE[0],SLATE[1],SLATE[2]); doc.rect(M, y-3.2, 2.4, 4.4, 'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(NAVY[0],NAVY[1],NAVY[2]);
    doc.text(titre, M+4.5, y);
    doc.setDrawColor(SLATE[0],SLATE[1],SLATE[2]); doc.setLineWidth(0.4); doc.line(M, y+1.8, R, y+1.8);
    y += 7.5; doc.setTextColor(0); doc.setFont('helvetica','normal'); doc.setFontSize(10);
  };
  const field = (lbl, val, indent) => {
    if (!val) return;
    const x = indent || M;
    doc.setFont('helvetica','bold'); doc.setFontSize(9.5);
    const vx = x + Math.max(40, doc.getTextWidth(lbl + ' :') + 3);
    const lines = doc.splitTextToSize(String(val), R - vx - 2);
    ensure(Math.max(lines.length*4.8, 5.5) + 2);
    doc.setTextColor(60);
    doc.text(lbl + ' :', x, y);
    doc.setFont('helvetica','normal'); doc.setTextColor(0);
    doc.text(lines, vx, y);
    y += Math.max(lines.length*4.8, 5.5);
  };
  const para = (txt) => {
    if (!txt) return;
    doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(0);
    doc.splitTextToSize(String(txt), CW).forEach(ln => { ensure(6); doc.text(ln, M, y); y += 4.9; });
  };
  const badge = (txt, rgb, x, yy) => {
    doc.setFont('helvetica','bold'); doc.setFontSize(8.5);
    const w = doc.getTextWidth(txt) + 6;
    doc.setFillColor(rgb[0],rgb[1],rgb[2]);
    doc.roundedRect(x, yy-4.1, w, 5.6, 2.8, 2.8, 'F');
    doc.setTextColor(255); doc.text(txt, x+3, yy);
    doc.setTextColor(0);
    return w;
  };
  const GRAV_RGB = { 'Faible':[45,158,107], 'Modérée':[230,170,30], 'Importante':[235,120,40], 'Critique (infestation massive)':[230,57,70] };
  const ACT_RGB  = { 'Active':[230,57,70], 'Ancienne (traces)':[120,120,120], 'Mixte':[235,120,40] };

  // En-tête horizontal — identique aux factures / rapport rongeurs
  const bu = (typeof BUREAUX !== 'undefined' && BUREAUX.find(b => b.id === d.bureau)) || { rue: co.rue, npa: co.npa, ville: co.ville, tel: co.tel };
  const logoW = 62, logoH = logoW*199/900;
  const logoY = 13;
  const headerFiletY = logoY + logoH + 5;
  if (typeof LOGO_B64 !== 'undefined') { try { doc.addImage(LOGO_B64,'PNG',20,logoY,logoW,logoH); } catch(e){} }
  else { doc.setFont('helvetica','bold'); doc.setFontSize(20); doc.setTextColor(13,27,62); doc.text('DERATEK', 20, 23); }
  const cy0 = logoY + 4;
  doc.setFont('helvetica','normal'); doc.setFontSize(8.5); doc.setTextColor(70);
  [bu.rue, `${bu.npa} ${bu.ville}`, 'Tél. '+(bu.tel||co.tel)].forEach((l,i)=>{ if(l) doc.text(l, 92, cy0 + i*4.4); });
  [co.email, co.tva].forEach((l,i)=>{ if(l) doc.text(l, 146, cy0 + i*4.4); });
  doc.setTextColor(13,27,62);
  try { doc.textWithLink('www.deratek.ch', 146, cy0 + 2*4.4, { url:'https://www.deratek.ch' }); } catch(e) { doc.text('www.deratek.ch', 146, cy0 + 2*4.4); }
  doc.setTextColor(0);
  doc.setDrawColor(200,205,213); doc.setLineWidth(0.4); doc.line(20, headerFiletY, 190, headerFiletY);
  doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(13,27,62);
  doc.text((bu.ville||'Neuchâtel') + ', le ' + (fmtDate(d.dateDoc)||''), 190, headerFiletY + 5, { align:'right' });
  doc.setFont('helvetica','normal'); doc.setTextColor(0);
  const bi = _diagBonInfo(d) || {};

  // Bandeau titre
  y = headerFiletY + 9;
  doc.setFillColor(NAVY[0],NAVY[1],NAVY[2]);
  doc.roundedRect(M, y, CW, 16, 2, 2, 'F');
  doc.setFont('helvetica','bold'); doc.setFontSize(14); doc.setTextColor(255);
  doc.text((d.doctype==='Expertise'?'EXPERTISE':'RAPPORT') + ' N° ' + (d.numero||''), M+6, y+6.8);
  doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.setTextColor(225,228,238);
  const rubanTxt = d.ruban || (((d.insectes||[]).length === 1) ? d.insectes[0] : 'Punaises de lit');
  doc.text(rubanTxt + ' — détection & plan d\'action', M+6, y+12.4);
  doc.setFontSize(10.5); doc.setFont('helvetica','bold'); doc.setTextColor(255);
  doc.text(fmtDate(d.dateDoc)||'', R-6, y+6.8, { align:'right' });
  doc.setTextColor(0);
  y += 21;

  // Informations sur 2 colonnes
  y = _diagRows2Col(doc, [
    ['Technicien', d.noTech ? '' : d.tech],
    ['Client', [(d.clientNom||''), bi.clientAdresse].filter(Boolean).join('\n')],
    ['N° bon de commande', bi.bonNumero],
    ['Adresse d\'intervention', d.locataireAdresse],
    ['Gérant', bi.gerant],
    ['Téléphone', bi.tel],
    ['Email', bi.email],
    ['Locataire', d.locataireNom],
    ['Tél. locataire', bi.locTel],
    ['Logement', (bi.logement && bi.logement !== d.locataireAdresse) ? bi.logement : ''],
    ['Site / bâtiment', d.batiment],
    ['Zones inspectées', d.zones],
    ['Foyers / zones chaudes', d.elementsTouches],
  ], y, M, CW);

  y = _diagDatesStrip(doc, d, y + 5, M, CW);
  y += 1;

  // Synthèse
  const postes = Array.isArray(d.postes) ? d.postes.filter(p => p && (p.emplacement || p.produit)) : [];
  const synth = [
    ['ACTIVITÉ', d.activite, ACT_RGB[d.activite]],
    ['NIVEAU D\'INFESTATION', d.gravite, GRAV_RGB[d.gravite]],
    ['ESPÈCES', (d.insectes||[]).length ? (d.insectes||[]).length + ' détectée(s)' : '', null],
    ['POINTS TRAITÉS', d.postesNb ? String(d.postesNb) : (postes.length ? String(postes.length) : ''), null],
  ];
  if (synth.some(s => s[1])) {
    ensure(20);
    const colW = CW/4;
    doc.setDrawColor(225,228,238); doc.setLineWidth(0.3);
    doc.roundedRect(M, y, CW, 15, 2, 2, 'D');
    synth.forEach((s, i) => {
      const cx = M + i*colW + 4;
      if (i) doc.line(M + i*colW, y+2.5, M + i*colW, y+12.5);
      doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(GREY[0],GREY[1],GREY[2]);
      doc.text(s[0], cx, y+5);
      if (!s[1]) { doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(150); doc.text('—', cx, y+11.2); return; }
      if (s[2]) { badge(String(s[1]).replace(' (infestation massive)',''), s[2], cx, y+11.2); }
      else {
        doc.setFont('helvetica','bold'); doc.setFontSize(9.5); doc.setTextColor(NAVY[0],NAVY[1],NAVY[2]);
        doc.text(doc.splitTextToSize(String(s[1]), colW-8)[0]||'', cx, y+11.2);
      }
    });
    doc.setTextColor(0);
    y += 21;
  }

  // Constatations
  section('Constatations');
  field('Espèces détectées', (d.insectes||[]).join(', '));
  field('Signes observés', (d.signes||[]).join(', '));
  field('Foyers / zones chaudes', d.elementsTouches);
  if (d.diagnostic) {
    y += 1.5;
    doc.setFont('helvetica','bold'); doc.setFontSize(9.5); doc.setTextColor(60);
    ensure(8); doc.text('Observations :', M, y); y += 5; doc.setTextColor(0);
    para(d.diagnostic);
  }

  // Photos
  const photos = (!d.noPhotos && Array.isArray(d.photos)) ? d.photos.filter(p => p && p.data && p.use !== false) : [];
  if (photos.length) {
    y += 2; section('Photos de l\'inspection', 62);
    const pw = (CW - 6) / 2, ph = 58;
    photos.forEach((p, i) => {
      const col = i % 2;
      if (col === 0 && y + ph + 8 > MAX_Y) newPage();
      const px = M + col*(pw+6);
      try {
        doc.addImage(p.data, 'JPEG', px, y, pw, ph);
        doc.setDrawColor(225,228,238); doc.rect(px, y, pw, ph, 'D');
        const meta = (typeof _diagPhotoMeta === 'function') ? _diagPhotoMeta(p) : '';
        const cap = ['Photo ' + (i+1), p.caption, meta ? '(' + meta + ')' : ''].filter(Boolean).join(' — ');
        doc.setFont('helvetica','italic'); doc.setFontSize(7.5); doc.setTextColor(70);
        doc.text(doc.splitTextToSize(cap, pw).slice(0, 2), px, y+ph+3.6);
        doc.setTextColor(0);
      } catch (e) {}
      if (col === 1 || i === photos.length-1) y += ph + 8;
    });
    y += 2;
  }

  // Tableau des points de gel / pièges
  if (postes.length) {
    y += 2; section('Zones traitées / pièges posés', 18);
    const c1 = M, c2 = M+14, c3 = M+105;
    const drawPostesHeader = () => {
      doc.setFillColor(NAVY[0],NAVY[1],NAVY[2]);
      doc.rect(M, y-4, CW, 6.5, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(8.5); doc.setTextColor(255);
      doc.text('N°', c1+2, y); doc.text('Emplacement', c2+2, y); doc.text('Produit / dispositif', c3+2, y);
      doc.setTextColor(0);
      y += 5;
    };
    ensure(8);
    drawPostesHeader();
    postes.forEach((p, i) => {
      const lines1 = doc.splitTextToSize(String(p.emplacement||'—'), c3-c2-6);
      const lines2 = doc.splitTextToSize(String(p.produit||'—'), R-c3-6);
      const rowH = Math.max(lines1.length, lines2.length)*4.6 + 2.4;
      if (y + rowH + 2 > MAX_Y) { newPage(); drawPostesHeader(); }
      if (i % 2 === 0) { doc.setFillColor(246,247,250); doc.rect(M, y-3.4, CW, rowH, 'F'); }
      doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.text(String(i+1), c1+2, y);
      doc.setFont('helvetica','normal');
      doc.text(lines1, c2+2, y);
      doc.text(lines2, c3+2, y);
      y += rowH;
    });
    doc.setDrawColor(225,228,238); doc.setLineWidth(0.3); doc.line(M, y-2.8, R, y-2.8);
    y += 4;
  }

  // Fiches des espèces détectées
  const fiches = (d.insectes||[]).filter(n => PUNAISES_INFO[n]);
  if (fiches.length) {
    y += 2; section('Fiches des espèces détectées', 38);
    fiches.forEach(nom => {
      const f = PUNAISES_INFO[nom];
      doc.setFont('helvetica','normal'); doc.setFontSize(9.5);
      const estH = 13 + [f.habitat, f.indices, f.biologie, f.risque].reduce((s,v)=> s + Math.max(doc.splitTextToSize(String(v),135).length*4.8, 5.5), 0);
      ensure(Math.min(estH, 75));
      doc.setFillColor(238,241,246);
      doc.roundedRect(M, y-1, CW, 7, 1.5, 1.5, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(10);
      const nomW = doc.getTextWidth(nom);
      doc.setTextColor(SLATE[0],SLATE[1],SLATE[2]);
      doc.text(nom, M+3, y+3.6);
      doc.setFont('helvetica','italic'); doc.setFontSize(9); doc.setTextColor(110);
      doc.text(f.latin, M+3+nomW+4, y+3.6);
      doc.setTextColor(0);
      y += 10;
      field('Habitat', f.habitat, M+3);
      field('Indices typiques', f.indices, M+3);
      field('Biologie', f.biologie, M+3);
      field('Risque', f.risque, M+3);
      y += 3;
    });
  }

  // Plan de traitement & suivi
  const materiel = Array.isArray(d.materiel) ? d.materiel : [];
  const produits = Array.isArray(d.rodenticides) ? d.rodenticides : [];
  const actions = Array.isArray(d.actions) ? d.actions : [];
  const checkLine = (txt) => {
    const lines = doc.splitTextToSize(String(txt), CW - 8);
    ensure(lines.length*4.8 + 2);
    doc.setDrawColor(NAVY[0],NAVY[1],NAVY[2]); doc.setLineWidth(0.35);
    doc.rect(M, y-3, 3.2, 3.2);
    doc.setDrawColor(45,158,107); doc.setLineWidth(0.6);
    doc.line(M+0.7, y-1.4, M+1.4, y-0.6); doc.line(M+1.4, y-0.6, M+2.7, y-2.6);
    doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.setTextColor(0);
    doc.text(lines, M+5.5, y);
    y += lines.length*4.8 + 1;
  };
  if (d.traitement || d.suivi || materiel.length || produits.length || actions.length) {
    y += 2; section('Plan de traitement', 12);
    if (materiel.length) { field('Matériel / méthode', materiel.join(', ')); y += 1; }
    if (d.postesNb) { field('Nombre de pièges / points traités', String(d.postesNb)); y += 1; }
    const prodAucun = produits.includes('Aucun produit chimique');
    const prodList = produits.filter(r => r !== 'Aucun produit chimique');
    if (prodAucun && !prodList.length && !d.rodenticideAutre) { field('Produit', 'Aucun produit chimique utilisé'); y += 1; }
    else if (prodList.length || d.rodenticideAutre) { field('Traitement appliqué', [...prodList, d.rodenticideAutre].filter(Boolean).join(', ')); y += 1; }
    para(d.traitement);
    if (actions.length) { y += 1.5; actions.forEach(a => checkLine(a)); }
    const suiviTxt = [d.suivi, d.suiviRem].filter(Boolean).join(' — ');
    if (suiviTxt) { y += 1.5; field('Suivi / prochain passage', suiviTxt); }
  }

  // Hygiène recommandée
  if (d.hygiene) {
    y += 2; section('Hygiène recommandée', 12);
    para(d.hygiene);
  }

  // Préparation du locataire (spécifique punaises de lit)
  {
    const prep = (d.preparation || []);
    if (prep.length || d.preparationRem) {
      y += 2; section('Préparation du locataire', 20);
      para("La réussite du traitement dépend directement du respect des consignes ci-dessous par l'occupant. Sans cette préparation, une nouvelle infestation est très probable.");
      y += 1.5;
      prep.forEach(a => checkLine(a));
      if (d.preparationRem) { y += 1.5; para(d.preparationRem); }
    }
  }

  // Prévention recommandée
  if (d.prevention) {
    y += 2; section('Prévention recommandée', 12);
    para(d.prevention);
  }

  // Proposition de contrat annuel
  if (d.contrat) {
    y += 2; section('Proposition de contrat annuel', 18);
    para("Au vu de la situation constatée, une proposition de contrat annuel peut être envisagée afin d'assurer un suivi régulier, de limiter les risques de récidive et de maintenir une surveillance préventive des zones sensibles.");
    y += 1.5;
    field('Passages annuels proposés', d.contratPassages);
    field('Montant estimatif', d.contratMontant);
    field('Zones concernées', d.contratZones);
    field('Remarques', d.contratRem);
  }

  // Conclusion (encadré)
  if (d.conclusion) {
    // On fixe la police AVANT de découper : sinon le calcul de largeur se fait avec
    // la taille laissée par la section précédente et les lignes débordent du cadre.
    doc.setFont('helvetica','normal'); doc.setFontSize(10);
    const lines = doc.splitTextToSize(String(d.conclusion), CW-13);
    const boxH = lines.length*4.9 + 8;
    if (y + boxH + 12 > MAX_Y) newPage();
    y += 2; section('Conclusion / recommandations');
    doc.setFillColor(240,243,250); doc.setDrawColor(NAVY[0],NAVY[1],NAVY[2]); doc.setLineWidth(0.3);
    doc.roundedRect(M, y-2, CW, boxH, 2, 2, 'FD');
    doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(NAVY[0],NAVY[1],NAVY[2]);
    lines.forEach((ln, i) => doc.text(ln, M+5, y+3.5 + i*4.9));
    doc.setTextColor(0);
    y += boxH + 4;
  }

  // Signature
  if (!d.noSign) {
    ensure(32);
    y += 8;
    doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.setTextColor(40);
    doc.text(bu.ville + ', le ' + (fmtDate(d.dateDoc)||''), M, y);
    doc.text('DERATEK' + (d.tech && !d.noTech ? ' — ' + d.tech : ''), 120, y);
    if (d.signature) { try { doc.addImage(d.signature, 'PNG', 120, y+1.5, 45, 15.75); } catch (e) {} }
    doc.setDrawColor(120); doc.setLineWidth(0.3); doc.line(120, y+18, 186, y+18);
    doc.setFontSize(8); doc.setTextColor(GREY[0],GREY[1],GREY[2]);
    doc.text('Signature', 120, y+21.5);
    doc.setTextColor(0);
  }

  // Pied de page
  const nb = doc.getNumberOfPages();
  for (let i = 1; i <= nb; i++) {
    doc.setPage(i);
    doc.setDrawColor(SLATE[0],SLATE[1],SLATE[2]); doc.setLineWidth(0.3); doc.line(M, 283, R, 283);
    doc.setFont('helvetica','normal'); doc.setFontSize(7.5); doc.setTextColor(GREY[0],GREY[1],GREY[2]);
    doc.text('DERATEK Professional Pest Control — ' + co.rue + ', ' + co.npa + ' ' + co.ville + ' — ' + co.email, M, 287.5);
    doc.text('Page ' + i + '/' + nb, R, 287.5, { align:'right' });
    doc.setTextColor(0);
  }

  if (mode === 'blob') return doc.output('blob');
  doc.save('rapport-punaises-' + (d.numero||'doc').replace(/[^a-z0-9]+/gi,'-').toLowerCase() + '.pdf');
  toast('✓ PDF rapport punaises de lit téléchargé', '#2d9e6b');
}

// ============================================================
// RAPPORT SPÉCIAL FOURMIS (même table "diagnostics", numéros FM-)
// ============================================================
const FOURMIS_ESPECES = ['Lasius niger — fourmi noire des jardins', 'Lasius emarginatus — fourmi bicolore / des maisons', 'Lasius brunneus — fourmi brune liée au bois', 'Lasius flavus — fourmi jaune', 'Lasius fuliginosus — fourmi fuligineuse', 'Tetramorium caespitum / immigrans — fourmi des pavés', 'Myrmica rubra — fourmi rouge (piqueuse)', 'Camponotus ligniperda — grande fourmi charpentière', 'Camponotus herculeanus — fourmi charpentière des bois', 'Camponotus vagus — fourmi charpentière noire', 'Formica rufa / polyctena — fourmis rousses des bois (protégées)', 'Monomorium pharaonis — fourmi pharaon', 'Tapinoma magnum — fourmi invasive', "Linepithema humile — fourmi d'Argentine (invasive)"];
const FOURMIS_SIGNES = ['Pistes d\'ouvrières', 'Fourmis ailées (essaimage / vol nuptial)', 'Ailes tombées au sol', 'Terre / déblais (nid)', 'Présence en cuisine', 'Présence dans fissures / plinthes', 'Nid visible', 'Dégâts au bois (charpentières)'];
const FOURMIS_MATERIEL = ['Pistolet applicateur de gel', 'Poudreuse (injection)', 'Pulvérisateur professionnel', 'Aspirateur', 'Loupe / microscope numérique', 'Endoscope'];
const FOURMIS_PRODUITS = ['Gel insecticide (appât)', 'Poudre insecticide (injection)', 'Pulvérisation rémanente', 'Traitement par injection', 'Aucun produit chimique'];
const FOURMIS_ACTIONS = [
  'Injection de poudre dans fissures, trous, rails de fenêtres, plinthes et vides de construction',
  'Application de gel insecticide sur les pistes d\'ouvrières',
  'Pulvérisation ciblée des zones périphériques, seuils, cadres et points d\'entrée',
  'Aspiration des fourmis ailées visibles à l\'intérieur',
  'Colmatage des fissures et ouvertures après traitement',
  'Contrôle de suivi à prévoir',
];
const FOURMIS_INFO = {
  'Lasius niger — fourmi noire des jardins': { latin: 'Lasius niger', habitat: 'Extérieur : jardins, pelouses, sous dalles/pavés/terrasses, bordures, murs, seuils, fissures ; entre dans les bâtiments pour la nourriture', indices: 'Ouvrières noires à brun foncé (3–5 mm), pistes vers les sources sucrées, vols nuptiaux de juin à août', biologie: 'Colonie à une reine, plusieurs milliers d\'ouvrières ; essaimage estival massif', risque: 'Pas de dégât structurel ; nuisance en cuisine/véranda ; forte présence = nid proche' },
  'Lasius emarginatus — fourmi bicolore / des maisons': { latin: 'Lasius emarginatus', habitat: 'Endroits chauds et secs : murs, façades, fissures, cadres de fenêtres, seuils, terrasses ; aussi à l\'intérieur', indices: 'Ouvrières 3–5 mm, thorax brun-roux/clair, tête et abdomen plus foncés ; pistes régulières', biologie: 'Nids dans fissures, murs et zones creuses', risque: 'Nuisance intérieure ; nids dans murs creux et zones chaudes' },
  'Lasius brunneus — fourmi brune liée au bois': { latin: 'Lasius brunneus', habitat: 'Bois mort, humide ou dégradé (champignons) : arbres, souches, poutres, cadres, charpentes', indices: 'Ouvrières 2–4 mm, brunâtres à thorax plus clair ; souvent en soirée/nuit', biologie: 'Ne mange pas le bois mais occupe cavités et bois affaibli', risque: 'Indicateur d\'humidité/bois dégradé ; ne pas confondre avec un xylophage' },
  'Lasius flavus — fourmi jaune': { latin: 'Lasius flavus', habitat: 'Pelouses, prairies, jardins, talus ; nids souterrains', indices: 'Petite, jaune à jaune-brun, peu visible ; petits monticules de terre ; vols de juillet à septembre', biologie: 'Vit surtout sous terre (élevage de pucerons racinaires)', risque: 'Rarement problématique à l\'intérieur ; gêne près des façades/terrasses' },
  'Lasius fuliginosus — fourmi fuligineuse': { latin: 'Lasius fuliginosus', habitat: 'Près du bois, arbres, souches, cavités, murs, vieux bâtiments', indices: 'Noire brillante, un peu plus grande que L. niger, odeur si écrasée, pistes très visibles', biologie: 'Nids dans cavités et zones protégées', risque: 'Liée aux cavités/arbres et vieux bâtiments ; vérifier les points d\'entrée' },
  'Tetramorium caespitum / immigrans — fourmi des pavés': { latin: 'Tetramorium caespitum / immigrans', habitat: 'Sous pavés, dalles, terrasses, bordures, fissures de béton, murs, seuils ; zones minérales ensoleillées', indices: 'Brun foncé à noire (2,5–4 mm) ; petits tas de sable entre les joints ; vols de juin à août', biologie: 'Colonies populeuses', risque: 'Entre par fissures/seuils ; gêne en cuisine, véranda, cave' },
  'Myrmica rubra — fourmi rouge (piqueuse)': { latin: 'Myrmica rubra', habitat: 'Jardins, prairies humides, bordures, sols frais, massifs', indices: 'Rougeâtre (4–6 mm) ; pique (sensation de brûlure) ; vols d\'août à septembre', biologie: 'Colonies à reines multiples, agressive', risque: 'Piqûres ; gêne en terrasse et places de jeux ; traiter de façon localisée' },
  'Camponotus ligniperda — grande fourmi charpentière': { latin: 'Camponotus ligniperda', habitat: 'Bois mort, souches, troncs, forêts ; aussi poutres, bardages, cloisons, isolations, charpentes', indices: 'Très grande, noire à zones brun-rougeâtre, ouvrières polymorphes ; sciure, galeries, bruits ; vols de mai à août', biologie: 'Creuse des galeries dans le bois (ne le mange pas), surtout si humide/dégradé', risque: 'Affaiblissement des bois de structure ; expertise et détection acoustique recommandées' },
  'Camponotus herculeanus — fourmi charpentière des bois': { latin: 'Camponotus herculeanus', habitat: 'Zones boisées, troncs, souches, bois mort/humide, éléments anciens', indices: 'Grande, sombre, ouvrières de tailles variables ; galeries, sciure, activité nocturne ; vols de juin à juillet', biologie: 'S\'installe dans le bois fragilisé/humide', risque: 'Problématique dans charpentes/poutres/bardages ; inspection approfondie' },
  'Camponotus vagus — fourmi charpentière noire': { latin: 'Camponotus vagus', habitat: 'Bois mort, souches, troncs, arbres morts ; près des bâtiments si bois ancien/stocké', indices: 'Grande, noire, ouvrières de tailles variables', biologie: 'Liée au bois mort et aux cavités favorables', risque: 'Indique du bois dégradé/cavités ; éliminer les bois morts stockés contre le bâtiment' },
  'Formica rufa / polyctena — fourmis rousses des bois (protégées)': { latin: 'Formica rufa / polyctena', habitat: 'Forêts, lisières, clairières, chemins forestiers', indices: 'Moyennes à grandes, rougeâtres et noires ; grandes fourmilières en dôme (aiguilles, brindilles)', biologie: 'Rôle écologique important', risque: 'Non nuisibles du bâtiment, espèces protégées : ne pas détruire, évaluer si très proche d\'une habitation' },
  'Monomorium pharaonis — fourmi pharaon': { latin: 'Monomorium pharaonis', habitat: 'Bâtiments chauffés : immeubles, hôpitaux/EMS, cuisines, restaurants, gaines, faux plafonds, murs creux', indices: 'Très petite (~2 mm), jaune à brun clair, discrète et rapide ; nids multiples', biologie: 'Accouplement dans le nid → colonies satellites ; se fragmente si mal traitée', risque: 'Très problématique ; uniquement par appâts professionnels, jamais de répulsif/pulvérisation' },
  'Tapinoma magnum — fourmi invasive': { latin: 'Tapinoma magnum', habitat: 'Sols, jardins, trottoirs, dalles, murs, terrasses, espaces verts, gaines, zones urbaines', indices: 'Noire brillante, ouvrières de tailles variables ; supercolonies à nombreuses reines, nids annexes', biologie: 'Développement surtout en période chaude ; progression par colonies très importantes', risque: 'Invasive difficile à maîtriser ; traitement global, plusieurs passages, suivi, coordination commune/gérance' },
  "Linepithema humile — fourmi d'Argentine (invasive)": { latin: 'Linepithema humile', habitat: 'Zones urbaines, jardins, serres, bâtiments chauffés, zones humides', indices: 'Brun clair à foncé, très mobile, longues pistes denses ; colonies à plusieurs reines', biologie: 'Extension par déplacement des reines ; dépend de la chaleur', risque: 'Invasive ; traitement global par appâts, éviter les pulvérisations répulsives seules, suivi régulier' },
};
// Fiches techniques insérables dans le rapport (texte de référence DERATEK)
const FOURMIS_FICHES = {
  vol_nuptial: {
    titre: 'Vols nuptiaux des fourmis',
    texte:
`1. Définition
Le vol nuptial, également appelé essaimage, est une phase naturelle de reproduction chez les fourmis. Durant cette période, la colonie produit des individus ailés, composés de mâles reproducteurs et de jeunes reines. Ces fourmis ailées quittent le nid afin de s'accoupler en plein air, lorsque les conditions climatiques sont favorables.
Après l'accouplement, les mâles meurent généralement rapidement. Les jeunes reines fécondées perdent ensuite leurs ailes et recherchent un endroit favorable afin de fonder une nouvelle colonie. C'est pour cette raison que l'on peut observer soudainement un grand nombre de fourmis ailées autour des fenêtres, plinthes, fissures, seuils de portes, rails de fenêtres, terrasses ou façades.

2. Période des vols nuptiaux
Les vols nuptiaux ont principalement lieu entre le printemps et la fin de l'été, selon l'espèce de fourmis et les conditions météorologiques.
Périodes généralement observées :
- Fourmis noires des jardins : de juin à août, parfois jusqu'en septembre.
- Fourmis des pavés : de juin à août.
- Fourmis bicolores : de juin à juillet, parfois durant l'été.
- Fourmis jaunes : de juillet à septembre.
- Fourmis rouges : d'août à septembre.
- Fourmis charpentières : de mai à août selon les espèces.
Ces dates restent indicatives. Les vols nuptiaux peuvent varier selon la région, l'altitude, la température, l'humidité, l'exposition du bâtiment et les conditions climatiques de l'année.

3. Conditions favorables
Les vols nuptiaux se déclenchent généralement lorsque plusieurs conditions sont réunies :
- Temps chaud.
- Taux d'humidité élevé.
- Période suivant une pluie ou un orage.
- Vent faible ou absence de vent.
- Température extérieure favorable.
- Sols, murs ou façades suffisamment réchauffés.
Il est fréquent que plusieurs colonies essaiment en même temps dans une même zone. Cela peut donner l'impression d'une invasion soudaine, alors qu'il s'agit en réalité d'un phénomène naturel de reproduction.

4. Origine probable
La présence de fourmis ailées indique généralement qu'une colonie est déjà bien développée à proximité. L'origine peut se situer dans :
- Les fissures de façade.
- Les joints dégradés.
- Les seuils de portes.
- Les cadres et rails de fenêtres.
- Les plinthes.
- Les vides de construction.
- Les terrasses, dalles ou pavés.
- Les murs creux.
- Les zones périphériques du bâtiment.
- Les espaces chauds et humides.
Dans certains cas, les fourmis peuvent s'introduire à l'intérieur par de très petites ouvertures, notamment au niveau des fenêtres, plinthes, gaines techniques, seuils ou fissures.

5. Risques en cas d'absence de traitement
Si le problème n'est pas traité correctement, les jeunes reines fécondées peuvent tenter de créer de nouvelles colonies. Cela peut entraîner :
- Des récidives les années suivantes.
- La création de nouveaux nids à proximité.
- Une activité plus importante autour du bâtiment.
- Une présence régulière de fourmis à l'intérieur.
- Le développement de plusieurs colonies ou colonies satellites.
- Une difficulté de traitement plus importante si l'infestation s'installe durablement.
La présence de fourmis ailées ne doit donc pas être prise à la légère, surtout si elle se répète chaque année ou si les fourmis apparaissent à l'intérieur du bâtiment.

6. Méthodes d'inspection
Lors de l'inspection, il est important de contrôler les éléments suivants :
- Identification de l'espèce si possible, notamment à l'aide d'une loupe ou d'un microscope numérique.
- Recherche des points de sortie.
- Contrôle des plinthes, fissures, cadres de fenêtres, rails, seuils et joints.
- Observation des pistes de fourmis ouvrières.
- Recherche d'ailes tombées au sol.
- Vérification des zones chaudes, humides ou abritées.
- Contrôle des façades, terrasses, murs, dalles et pavés.
- Détermination de l'origine probable : intérieure ou extérieure.

7. Traitement recommandé
Le traitement doit être adapté à la situation et à l'espèce concernée. Il peut comprendre :
- Injection de poudre insecticide professionnelle dans les fissures, trous, rails de fenêtres, plinthes, vides de construction et zones de passage.
- Application de gel insecticide professionnel lorsque des ouvrières sont visibles.
- Pulvérisation ciblée sur les zones périphériques, seuils, cadres, fissures et points d'entrée.
- Traitement par injection dans les zones profondes ou difficilement accessibles.
- Aspiration des fourmis ailées visibles à l'intérieur, en complément du traitement.
- Colmatage des fissures et ouvertures après traitement, afin de limiter les récidives.
Il est important de ne pas se limiter uniquement aux fourmis visibles. Le traitement doit viser les zones de passage, les accès, les fissures et les endroits où la colonie peut être installée.

8. Prévention
Afin de limiter les risques de récidive, il est recommandé de :
- Reboucher les fissures et ouvertures après traitement.
- Contrôler les joints de fenêtres et de portes.
- Vérifier les seuils, plinthes et cadres de fenêtres.
- Éviter les restes alimentaires accessibles.
- Surveiller les zones extérieures proches du bâtiment.
- Réaliser un traitement préventif au printemps, généralement entre mars et avril.
- Prévoir deux passages préventifs si une forte activité a déjà été constatée les années précédentes.
Un traitement préventif au printemps permet de réduire l'activité des colonies avant la période des vols nuptiaux.

9. Conclusion
La présence de fourmis ailées correspond très probablement à un vol nuptial. Ce phénomène est naturel, mais il indique souvent qu'une colonie est déjà présente à proximité du bâtiment. Les jeunes reines fécondées peuvent ensuite tenter de fonder de nouvelles colonies, ce qui peut provoquer des récidives les années suivantes.
Un traitement ciblé des fissures, plinthes, rails de fenêtres, seuils, cadres et zones périphériques est recommandé afin de neutraliser l'activité et de limiter le risque de nouvelles installations. Un suivi dans les jours suivants permet d'évaluer l'efficacité du traitement et de déterminer si un second passage est nécessaire.`
  },
  lasius_niger: { titre: 'Lasius niger — fourmi noire des jardins', texte:
`Identification :
La Lasius niger est l'une des fourmis les plus courantes en Suisse. Les ouvrières sont généralement de couleur noire à brun foncé. Elles mesurent environ 3 à 5 mm. Les reines sont plus grandes, notamment lors des vols nuptiaux.

Habitat :
Cette espèce vit principalement à l'extérieur, dans les jardins, pelouses, sous les dalles, pavés, terrasses, bordures, murs, seuils et fissures. Elle peut s'introduire dans les bâtiments à la recherche de nourriture.

Période des vols nuptiaux :
Les vols nuptiaux ont généralement lieu de juin à août, parfois jusqu'en septembre selon les conditions climatiques. Les vols sont souvent observés par temps chaud, humide et avec peu de vent.

Risques dans les bâtiments :
Cette espèce ne cause généralement pas de dégâts structurels. Elle peut toutefois devenir gênante lorsqu'elle pénètre dans les cuisines, salons, vérandas, caves ou autour des fenêtres. Une forte présence peut indiquer un nid proche du bâtiment.

Traitement recommandé :
- Recherche des pistes de fourmis et des points d'entrée.
- Traitement par gel insecticide professionnel sur les zones de passage.
- Injection de poudre insecticide dans les fissures, seuils, rails de fenêtres, plinthes et vides.
- Pulvérisation ciblée en périphérie extérieure si nécessaire.
- Colmatage des fissures après traitement.
- Suivi après quelques jours si l'activité persiste.

Conclusion :
La Lasius niger est une espèce très fréquente en extérieur. Sa présence dans le bâtiment est souvent liée à une recherche de nourriture ou à des accès ouverts depuis l'extérieur.` },
  lasius_emarginatus: { titre: 'Lasius emarginatus — fourmi bicolore / des maisons', texte:
`Identification :
La Lasius emarginatus est une fourmi de petite taille, généralement entre 3 et 5 mm. Elle présente souvent un thorax brun-roux à brun clair, avec une tête et un abdomen plus foncés. Elle peut être confondue avec d'autres espèces du genre Lasius.

Habitat :
Cette espèce apprécie les endroits chauds et secs. On la rencontre souvent dans les murs, façades, fissures, cadres de fenêtres, seuils, terrasses, dalles et zones périphériques des bâtiments. Elle peut également être observée à l'intérieur.

Période des vols nuptiaux :
Les vols nuptiaux sont généralement observés de juin à juillet, parfois plus tard selon les conditions météorologiques.

Risques dans les bâtiments :
Elle peut former des nids dans les fissures, murs, façades ou zones creuses. Sa présence à l'intérieur peut devenir gênante, surtout lorsqu'elle suit des pistes régulières vers une source alimentaire.

Traitement recommandé :
- Inspection des cadres de fenêtres, seuils, plinthes, murs et fissures.
- Injection de poudre insecticide professionnelle dans les fissures et cavités.
- Application de gel insecticide sur les pistes actives.
- Pulvérisation ciblée sur les zones périphériques et points d'entrée.
- Colmatage après traitement afin d'éviter les récidives.

Conclusion :
La Lasius emarginatus est une espèce fréquemment associée aux bâtiments. Elle doit être traitée en ciblant les accès, fissures, murs creux et zones chaudes.` },
  lasius_brunneus: { titre: 'Lasius brunneus — fourmi brune liée au bois', texte:
`Identification :
La Lasius brunneus est une petite fourmi, généralement de 2 à 4 mm. Elle possède souvent une coloration brunâtre, avec un thorax plus clair. Elle peut être difficile à identifier sans observation précise.

Habitat :
Cette espèce est souvent liée au bois mort, humide ou dégradé, notamment le bois attaqué par des champignons. Elle peut se retrouver dans des arbres, souches, poutres, cadres, charpentes ou éléments en bois fragilisés.

Période des vols nuptiaux :
Les vols nuptiaux peuvent apparaître dès le mois de mai, parfois dans les bâtiments, souvent en soirée ou durant la nuit selon les conditions.

Risques dans les bâtiments :
Sa présence peut indiquer un problème d'humidité ou de bois dégradé. Elle ne doit pas être confondue avec un insecte xylophage classique, car elle ne se nourrit pas du bois, mais peut utiliser des cavités existantes ou du bois déjà affaibli.

Traitement recommandé :
- Inspection du bois, des poutres, cadres, plinthes et zones humides.
- Recherche d'humidité, de champignons ou de bois ramolli.
- Identification au microscope numérique si nécessaire.
- Traitement par injection de poudre insecticide dans les cavités actives.
- Suppression ou remplacement du bois fortement dégradé si nécessaire.
- Correction de la cause d'humidité.

Conclusion :
La présence de Lasius brunneus doit attirer l'attention sur l'état du bois. Il est important d'évaluer l'humidité et la dégradation des éléments en bois.` },
  lasius_flavus: { titre: 'Lasius flavus — fourmi jaune', texte:
`Identification :
La Lasius flavus est une petite fourmi de couleur jaune à jaune-brun. Elle est souvent moins visible que les autres espèces, car elle vit principalement sous terre.

Habitat :
Elle vit principalement dans les pelouses, prairies, jardins, talus et zones herbeuses. Elle construit souvent des nids souterrains et peut produire de petits monticules de terre.

Période des vols nuptiaux :
Les vols nuptiaux ont généralement lieu de juillet à septembre, souvent après des périodes chaudes et humides.

Risques dans les bâtiments :
Cette espèce pose rarement problème à l'intérieur des bâtiments. Elle peut toutefois être observée près des façades, terrasses ou pelouses autour des habitations.

Traitement recommandé :
- Traitement uniquement si la présence devient gênante.
- Pulvérisation ciblée autour des zones actives.
- Traitement localisé des nids extérieurs si nécessaire.
- Surveillance après traitement.

Conclusion :
La Lasius flavus est surtout une espèce extérieure. Elle est rarement problématique dans les bâtiments, sauf en cas de forte activité proche des accès.` },
  tetramorium: { titre: 'Tetramorium caespitum / immigrans — fourmi des pavés', texte:
`Identification :
Petite fourmi brun foncé à noire, généralement de 2,5 à 4 mm. Elle est souvent observée sur les dalles, pavés, terrasses, trottoirs et zones minérales.

Habitat :
Cette espèce vit fréquemment sous les pavés, dalles, terrasses, bordures, fissures de béton, murs et seuils. Elle apprécie les zones minérales chauffées par le soleil.

Période des vols nuptiaux :
Les vols nuptiaux ont généralement lieu de juin à août, avec une forte activité possible en début d'été selon les conditions.

Risques dans les bâtiments :
Elle peut entrer dans les bâtiments par les fissures, seuils, joints de terrasse, rails de portes-fenêtres ou cadres. Elle peut devenir gênante dans les cuisines, vérandas, caves ou locaux techniques.

Traitement recommandé :
- Inspection des dalles, pavés, seuils, terrasses et fissures.
- Traitement par pulvérisation ciblée autour des zones minérales.
- Injection de poudre insecticide dans les fissures, joints et seuils.
- Gel insecticide si des pistes alimentaires sont visibles.
- Colmatage des accès après traitement.

Conclusion :
La fourmi des pavés est très fréquente autour des bâtiments. Le traitement doit viser les dalles, seuils, terrasses et fissures périphériques.` },
  myrmica_rubra: { titre: 'Myrmica rubra — fourmi rouge (piqueuse)', texte:
`Identification :
La Myrmica rubra est une fourmi rougeâtre, généralement de 4 à 6 mm. Elle peut piquer ou provoquer une sensation de brûlure lorsqu'elle est dérangée.

Habitat :
Elle vit souvent dans les jardins, prairies humides, bordures, zones herbeuses, sols frais, massifs et zones proches de l'humidité.

Période des vols nuptiaux :
Les vols nuptiaux ont généralement lieu d'août à septembre, selon la météo.

Risques dans les bâtiments :
Elle pose surtout problème en extérieur, dans les jardins, terrasses, places de jeux ou zones de passage. Sa présence à l'intérieur est moins fréquente, mais possible près des accès ou zones humides.

Traitement recommandé :
- Localisation précise du nid extérieur.
- Pulvérisation ciblée sur les zones de passage.
- Traitement localisé du nid si accessible.
- Protection des zones sensibles, notamment terrasses et places de jeux.
- Éviter les traitements dispersants non ciblés.

Conclusion :
La Myrmica rubra est principalement une fourmi extérieure. Elle peut être gênante à cause de ses piqûres et doit être traitée de manière localisée.` },
  camponotus_ligniperda: { titre: 'Camponotus ligniperda — grande fourmi charpentière', texte:
`Identification :
La Camponotus ligniperda est une grande fourmi, parmi les plus grandes espèces indigènes. Les ouvrières peuvent présenter différentes tailles. La coloration est souvent noire avec des zones brun-rougeâtre. Les reines sont nettement plus grandes.

Habitat :
Elle vit naturellement dans les bois morts, souches, troncs, arbres, forêts et zones boisées. Elle peut aussi s'installer dans des éléments en bois, poutres, bardages, cloisons, isolations ou charpentes si les conditions sont favorables.

Période des vols nuptiaux :
Les vols nuptiaux peuvent avoir lieu de mai à août, souvent plus tôt que certaines petites espèces de fourmis.

Risques dans les bâtiments :
Cette espèce peut creuser ou utiliser des galeries dans le bois, surtout lorsque celui-ci est humide, dégradé ou déjà affaibli. Elle peut également s'installer dans des isolations ou cavités. Une inspection technique est indispensable.

Traitement recommandé :
- Inspection complète du bois, des poutres, bardages, charpentes et isolations.
- Recherche de sciure, galeries, bruits, ouvrières de grande taille et points d'entrée.
- Détection acoustique si nécessaire.
- Traitement par injection ciblée dans les zones actives.
- Traitement insecticide professionnel adapté aux cavités.
- Correction de l'humidité et remplacement du bois trop dégradé si nécessaire.
- Suivi obligatoire après traitement.

Conclusion :
La Camponotus ligniperda doit être prise au sérieux lorsqu'elle est observée dans une structure en bois. Une expertise du bois est recommandée afin d'évaluer l'activité et les risques.` },
  camponotus_herculeanus: { titre: 'Camponotus herculeanus — fourmi charpentière des bois', texte:
`Identification :
Grande fourmi du genre Camponotus, de couleur sombre, avec des ouvrières de tailles variables. Elle ressemble à d'autres fourmis charpentières et nécessite parfois une identification précise.

Habitat :
Elle est souvent liée aux zones boisées, troncs, souches, bois mort, bois humide ou éléments en bois anciens. Elle peut être rencontrée dans les régions forestières ou proches des bâtiments avec présence de bois.

Période des vols nuptiaux :
Les vols nuptiaux se produisent généralement entre juin et juillet, parfois plus largement selon l'altitude et la météo.

Risques dans les bâtiments :
Elle peut s'installer dans le bois fragilisé, humide ou dégradé. Sa présence dans une charpente, une poutre ou un bardage doit faire l'objet d'une inspection approfondie.

Traitement recommandé :
- Inspection du bois et des zones humides.
- Recherche de galeries, sciure, points d'entrée et activité nocturne.
- Traitement par injection ciblée dans les cavités.
- Correction des causes d'humidité.
- Remplacement des éléments très dégradés si nécessaire.
- Suivi technique après intervention.

Conclusion :
La Camponotus herculeanus est une espèce liée au bois. Elle peut devenir problématique si elle s'installe dans des éléments structurels ou des zones humides du bâtiment.` },
  camponotus_vagus: { titre: 'Camponotus vagus — fourmi charpentière noire', texte:
`Identification :
Grande fourmi noire, souvent observée à proximité du bois mort, des arbres, souches ou zones chaudes. Les ouvrières peuvent être de tailles différentes.

Habitat :
Elle vit principalement dans le bois mort, les souches, troncs, arbres morts ou bois dégradé. Elle peut être observée près des bâtiments lorsque du bois ancien, humide ou stocké est présent.

Période des vols nuptiaux :
Les vols nuptiaux ont généralement lieu de juin à août selon les conditions.

Risques dans les bâtiments :
Elle peut indiquer la présence de bois dégradé ou de cavités favorables. Sa présence dans ou autour d'une structure en bois doit être contrôlée.

Traitement recommandé :
- Inspection des bois extérieurs, bardages, poutres, souches et zones humides.
- Élimination des bois morts ou stockés contre le bâtiment.
- Traitement localisé des zones actives.
- Injection de poudre insecticide si présence dans une cavité.
- Correction des causes favorables.

Conclusion :
La Camponotus vagus est principalement liée au bois mort. Sa présence près d'un bâtiment doit conduire à vérifier les bois dégradés et les points d'entrée.` },
  formica_rufa: { titre: 'Formica rufa / polyctena — fourmis rousses des bois (protégées)', texte:
`Identification :
Fourmis de taille moyenne à grande, généralement rougeâtres et noires. Elles construisent souvent de grandes fourmilières en dôme avec des aiguilles, brindilles et matériaux végétaux.

Habitat :
Elles vivent principalement en forêt, lisières, clairières, chemins forestiers et zones boisées. Elles jouent un rôle écologique important.

Période des vols nuptiaux :
Les vols nuptiaux ont généralement lieu au printemps ou au début de l'été, selon les espèces et les conditions.

Risques dans les bâtiments :
Ces espèces ne sont généralement pas des nuisibles du bâtiment. Elles sont principalement forestières et utiles à l'écosystème.

Traitement recommandé :
- Ne pas traiter sans nécessité.
- Ne pas détruire les fourmilières forestières.
- Évaluer la situation si elles se trouvent très proches d'une habitation.
- Orienter vers une solution respectueuse de l'environnement si nécessaire.

Conclusion :
Les fourmis rousses des bois ont un rôle écologique important. Elles ne doivent pas être traitées comme des nuisibles classiques, sauf cas très particulier et après évaluation.` },
  monomorium_pharaonis: { titre: 'Monomorium pharaonis — fourmi pharaon', texte:
`Identification :
La fourmi pharaon est une très petite fourmi, souvent jaune à brun clair, avec une taille généralement proche de 2 mm. Elle est discrète, rapide et peut former plusieurs nids dans un même bâtiment.

Habitat :
Elle vit principalement dans les bâtiments chauffés : immeubles, hôpitaux, EMS, cuisines, restaurants, locaux techniques, gaines, faux plafonds, murs creux et zones chaudes.

Période des vols nuptiaux :
La fourmi pharaon ne réalise généralement pas de vol nuptial extérieur classique. L'accouplement se fait dans le nid, ce qui favorise la formation de colonies satellites.

Risques dans les bâtiments :
C'est une espèce très problématique en bâtiment. Elle peut se disperser dans les gaines, murs, locaux techniques et étages. Un mauvais traitement peut provoquer une fragmentation de la colonie et aggraver l'infestation.

Traitement recommandé :
- Ne pas pulvériser de manière agressive.
- Ne pas utiliser de répulsif ou traitement dispersant.
- Utiliser uniquement des appâts professionnels adaptés.
- Traiter l'ensemble du bâtiment si plusieurs zones sont touchées.
- Réaliser un suivi sur plusieurs semaines.
- Identifier les zones chaudes, gaines, cuisines, locaux techniques et salles d'eau.
- Informer les occupants de ne pas utiliser d'insecticide grand public.

Conclusion :
La fourmi pharaon nécessite une stratégie spécifique par appâts. Un traitement inadapté peut disperser les colonies et rendre l'infestation beaucoup plus difficile à maîtriser.` },
  tapinoma_magnum: { titre: 'Tapinoma magnum — fourmi invasive', texte:
`Identification :
La Tapinoma magnum est une fourmi noire brillante, généralement de petite taille, mais avec des ouvrières de tailles variables dans une même colonie. Elle peut former de très grandes colonies avec de nombreuses reines.

Habitat :
Elle se développe dans les sols, jardins, trottoirs, dalles, murs, terrasses, bordures, espaces verts, gaines et zones urbaines. Elle peut pénétrer dans les bâtiments par les fissures, seuils, gaines et zones techniques.

Période des vols nuptiaux :
Les vols nuptiaux peuvent varier selon les conditions, mais l'espèce se développe surtout durant la période chaude. Sa progression est surtout liée à la présence de colonies très importantes et de nombreux nids annexes.

Risques dans les bâtiments :
Cette espèce invasive peut devenir très difficile à maîtriser lorsqu'elle est installée. Elle peut former des supercolonies, envahir des jardins, trottoirs, bâtiments et locaux techniques. Elle peut provoquer une gêne importante pour les habitants.

Traitement recommandé :
- Identification précise indispensable.
- Cartographie des zones actives.
- Traitement global et non uniquement localisé.
- Application de gels ou appâts adaptés selon la situation.
- Traitement des fissures, joints, seuils, murs et périphéries.
- Plusieurs passages nécessaires.
- Suivi régulier sur plusieurs semaines ou mois.
- Collaboration avec la commune ou la gérance si l'infestation dépasse une seule parcelle.

Conclusion :
La Tapinoma magnum est une espèce invasive à fort potentiel de développement. Une intervention rapide, globale et suivie est recommandée afin d'éviter son extension.` },
  linepithema_humile: { titre: "Linepithema humile — fourmi d'Argentine (invasive)", texte:
`Identification :
Petite fourmi brun clair à brun foncé, souvent très mobile. Elle peut former de très grandes colonies avec plusieurs reines.

Habitat :
Elle est surtout connue dans les zones urbaines, jardins, serres, bâtiments chauffés, zones humides et régions favorables. Elle peut se déplacer en longues pistes très actives.

Période des vols nuptiaux :
Cette espèce forme surtout de grandes colonies par extension et déplacement des reines. Le développement dépend fortement des conditions climatiques et de la chaleur.

Risques dans les bâtiments :
Elle peut envahir les bâtiments, cuisines, locaux techniques, jardins et zones extérieures. Elle est difficile à éliminer en raison de ses colonies étendues et de la présence de nombreuses reines.

Traitement recommandé :
- Identification précise.
- Traitement par appâts professionnels adaptés.
- Éviter les pulvérisations répulsives seules.
- Traiter les pistes, zones d'entrée et périphéries.
- Réaliser plusieurs passages.
- Suivi régulier indispensable.

Conclusion :
La fourmi d'Argentine est une espèce invasive pouvant former de très grandes colonies. Le traitement doit être global, progressif et suivi.` },
  lasius_fuliginosus: { titre: 'Lasius fuliginosus — fourmi fuligineuse', texte:
`Identification :
Fourmi noire brillante, souvent légèrement plus grande que Lasius niger. Elle peut dégager une odeur caractéristique lorsqu'elle est écrasée. Elle forme parfois des pistes très visibles.

Habitat :
Elle vit souvent près du bois, des arbres, souches, cavités, murs, bâtiments anciens ou zones avec matériaux organiques. Elle peut établir des nids dans des cavités ou zones protégées.

Période des vols nuptiaux :
Les vols nuptiaux ont généralement lieu durant l'été, selon les conditions climatiques.

Risques dans les bâtiments :
Elle peut être observée dans les vieux bâtiments, cavités, murs, zones boisées ou structures proches d'arbres. Sa présence peut indiquer une cavité favorable ou du bois ancien à proximité.

Traitement recommandé :
- Recherche des pistes extérieures et intérieures.
- Inspection des arbres, souches, murs, façades et cavités.
- Traitement localisé des zones actives.
- Injection dans les fissures ou cavités si nécessaire.
- Correction des points d'entrée.

Conclusion :
La Lasius fuliginosus peut être liée aux cavités, arbres et vieux bâtiments. Une inspection des points d'entrée et des zones boisées proches est recommandée.` }
};

function openNewFourmis() {
  _editingDiag = {
    id: newId(), numero: _nextDiagNumero('FM'), dateDoc: today(), tech: '',
    clientId: '', clientNom: '', locataireNom: '', locataireAdresse: '',
    batiment: '', bonId: '', insectes: [], elementsTouches: '',
    activite: '', gravite: '', zones: '', diagnostic: '', conclusion: '',
    traitement: '', suivi: '', prevention: '', hygiene: '', fiche: '', signes: [], postes: [], materiel: [],
    rodenticides: [], actions: [], photos: [],
    bureau: 'ne', doctype: 'Rapport', noPlan: '1', noPhotos: '', noTech: '', statut: '', ruban: '', noSign: '1',
    rodenticideAutre: '', postesNb: '', suiviRem: '',
    contrat: '', contratPassages: '', contratMontant: '', contratZones: '', contratRem: '',
    dateInt1: '', dateInt2: '', dateInt3: '', dateProchain: ''
  };
  renderDiagEditor(); openModal('modal-diag');
}
// Insère (ajoute) le texte d'une fiche technique dans le champ Fiche du rapport fourmis
function fourmisAddFiche(key) {
  if (!_editingDiag) return;
  const f = FOURMIS_FICHES[key]; if (!f) return;
  const block = 'FICHE TECHNIQUE - ' + f.titre.toUpperCase() + '\n\n' + f.texte;
  const cur = (_editingDiag.fiche || '').trim();
  _editingDiag.fiche = cur ? (cur + '\n\n\n' + block) : block;
  const ta = $('diag-ta-fiche'); if (ta) { ta.value = _editingDiag.fiche; diagTaAutoGrow(ta); }
  refreshDiagPreview();
}

function renderFourmisEditor() {
  const d = _editingDiag; if (!d) return;
  const box = $('modal-diag-body'); if (!box) return;
  const clientOpts = (DB.clients||[]).slice().sort((a,b)=>(a.nom||'').localeCompare(b.nom||'')).map(c=>`<option value="${c.id}" ${d.clientId===c.id?'selected':''}>${_clientOptionLabel(c).replace(/</g,'&lt;')}</option>`).join('');
  const checkList = (arr, field) => arr.map(n => `
    <label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;margin:3px 10px 3px 0;cursor:pointer;">
      <input type="checkbox" ${(d[field]||[]).includes(n)?'checked':''} onchange="toggleDiagList('${field}','${n.replace(/'/g,"\\'")}',this.checked)" style="accent-color:var(--navy);"> ${n}
    </label>`).join('');
  const especesHtml = FOURMIS_ESPECES.map(n => `
    <label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;margin:3px 10px 3px 0;cursor:pointer;">
      <input type="checkbox" ${(d.insectes||[]).includes(n)?'checked':''} onchange="toggleDiagInsecte('${n.replace(/'/g,"\\'")}',this.checked)" style="accent-color:var(--navy);"> ${n}
    </label>`).join('');
  const signesHtml   = checkList(FOURMIS_SIGNES,   'signes');
  const materielHtml = checkList(FOURMIS_MATERIEL, 'materiel');
  const produitsHtml = checkList(FOURMIS_PRODUITS, 'rodenticides');
  const actionsHtml  = FOURMIS_ACTIONS.map(n => `
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;margin:3px 0;cursor:pointer;">
      <input type="checkbox" ${(d.actions||[]).includes(n)?'checked':''} onchange="toggleDiagList('actions','${n.replace(/'/g,"\\'")}',this.checked)" style="accent-color:var(--navy);"> ${n}
    </label>`).join('');
  const fichesOpts = Object.keys(FOURMIS_FICHES).map(k => `<option value="${k}">${FOURMIS_FICHES[k].titre.replace(/</g,'&lt;')}</option>`).join('');
  box.innerHTML = `
    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🐜 Identification</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
      <div class="form-group"><label class="form-label">N° de bon (remplissage auto)</label><input class="form-input" placeholder="Tape le n° puis Tab" onchange="autoFillDiagFromBon(this.value)" onblur="autoFillDiagFromBon(this.value)"></div>
      <div class="form-group"><label class="form-label">Date</label><input class="form-input" type="date" value="${d.dateDoc||''}" oninput="_editingDiag.dateDoc=this.value"></div>
      ${_diagTypeBureauFields(d)}
      <div class="form-group" style="grid-column:1/-1;"><label class="form-label">Nuisible affiché dans le ruban du PDF</label>
        <select class="form-input" oninput="_editingDiag.ruban=this.value">
          <option value="" ${!d.ruban?'selected':''}>Automatique (espèce cochée, sinon « Fourmis »)</option>
          ${['Fourmis','Fourmis ailées (vol nuptial)','Fourmi noire des jardins','Fourmi des pavés','Fourmi charpentière','Fourmi pharaon'].map(o => `<option ${d.ruban===o?'selected':''}>${o}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label class="form-label">Client (gérance)</label>
        <select class="form-input" onchange="onDiagClientSelect(this.value)"><option value="">-- Choisir --</option>${clientOpts}</select>
        <input class="form-input" style="margin-top:5px;font-size:12px;" placeholder="ou nom manuel" value="${(d.clientNom||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.clientNom=this.value;_editingDiag.clientId='';">
      </div>
      ${_diagTechField(d)}
      <div class="form-group"><label class="form-label">Locataire</label><input class="form-input" value="${(d.locataireNom||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.locataireNom=this.value"></div>
      <div class="form-group"><label class="form-label">Site / bâtiment concerné</label><input class="form-input" value="${(d.batiment||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.batiment=this.value" placeholder="Ex. immeuble, terrasse, façade, cuisine"></div>
      <div class="form-group" style="grid-column:1/-1;"><label class="form-label">Adresse</label><input class="form-input" value="${(d.locataireAdresse||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.locataireAdresse=this.value"></div>
    </div>

    ${_diagDatesFields(d)}

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🐜 Espèces détectées</div>
    <div style="margin-bottom:10px;">${especesHtml}</div>
    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🔎 Signes observés</div>
    <div style="margin-bottom:12px;">${signesHtml}</div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:8px;">
      <div class="form-group"><label class="form-label">Activité de l'infestation</label>
        <select class="form-input" oninput="_editingDiag.activite=this.value">
          <option value="" ${!d.activite?'selected':''}>-- Choisir --</option>
          <option ${d.activite==='Active'?'selected':''}>Active</option>
          <option ${d.activite==='Ancienne (traces)'?'selected':''}>Ancienne (traces)</option>
          <option ${d.activite==='Mixte'?'selected':''}>Mixte</option>
        </select>
      </div>
      <div class="form-group"><label class="form-label">Niveau d'infestation</label>
        <select class="form-input" oninput="_editingDiag.gravite=this.value">
          <option value="" ${!d.gravite?'selected':''}>-- Choisir --</option>
          <option ${d.gravite==='Faible'?'selected':''}>Faible</option>
          <option ${d.gravite==='Modérée'?'selected':''}>Modérée</option>
          <option ${d.gravite==='Importante'?'selected':''}>Importante</option>
          <option ${d.gravite==='Critique (infestation massive)'?'selected':''}>Critique (infestation massive)</option>
        </select>
      </div>
      ${_diagZonesField(d, 'Zones inspectées / d\'activité')}
      <div class="form-group"><label class="form-label">Origine probable / points d'entrée</label><input class="form-input" value="${(d.elementsTouches||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.elementsTouches=this.value" placeholder="Ex. fissures de façade, seuils, rails de fenêtres, terrasse"></div>
    </div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:6px;display:flex;align-items:center;flex-wrap:wrap;">📷 Photo inspection ${_diagSectionToggle('noPhotos','Afficher dans le PDF')}</div>
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:8px;margin-bottom:14px;${d.noPhotos?'display:none;':''}">
      <input type="file" id="diag-photos-file" accept="image/*" multiple style="display:none" onchange="addDiagPhotos(event)">
      <input type="file" id="diag-photo-replace-file" accept="image/*" style="display:none" onchange="onDiagPhotoReplace(event)">
      <button class="btn btn-navy btn-sm" type="button" onclick="document.getElementById('diag-photos-file').click()">📷 Ajouter des photos</button>
      <span style="font-size:11px;color:var(--g400);margin-left:6px;">Incluses dans le PDF avec date et auteur (non stockées en base).</span>
      <div id="diag-photos-box" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;"></div>
    </div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🧰 Matériel / méthode</div>
    <div style="margin-bottom:12px;">${materielHtml}</div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🧪 Insecticide professionnel utilisé</div>
    <div style="margin-bottom:4px;">${produitsHtml}</div>
    <div class="form-group" style="margin-bottom:12px;max-width:360px;"><input class="form-input" style="font-size:12px;" value="${(d.rodenticideAutre||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.rodenticideAutre=this.value" placeholder="Autre produit (champ libre)"></div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">✅ Mesures du traitement</div>
    <div style="margin-bottom:12px;">${actionsHtml}</div>

    <div class="form-group" style="margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;"><label class="form-label">Observations détaillées</label><button type="button" class="btn btn-ghost btn-sm" id="diag-ai-diagnostic" onclick="diagAICorrect('diagnostic')" style="font-size:11px;padding:2px 8px;">✨ Corriger IA</button></div>
      <textarea class="form-input" id="diag-ta-diagnostic" rows="3" oninput="_editingDiag.diagnostic=this.value;diagTaAutoGrow(this)" onfocus="diagTaAutoGrow(this)" onblur="diagTaShrink(this)">${d.diagnostic||''}</textarea>
    </div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:6px;">📋 Fiches techniques (annexées au PDF)</div>
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:10px;margin-bottom:14px;">
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">
        <select class="form-input" style="max-width:440px;font-size:12px;" onchange="if(this.value){fourmisAddFiche(this.value);this.selectedIndex=0;}">
          <option value="">＋ Insérer une fiche technique…</option>
          ${fichesOpts}
        </select>
        <button type="button" class="btn btn-ghost btn-sm" onclick="_editingDiag.fiche='';var t=$('diag-ta-fiche');if(t)t.value='';refreshDiagPreview();" style="font-size:12px;">🗑 Vider</button>
      </div>
      <textarea class="form-input" id="diag-ta-fiche" rows="3" oninput="_editingDiag.fiche=this.value;diagTaAutoGrow(this)" onfocus="diagTaAutoGrow(this)" onblur="diagTaShrink(this)" placeholder="Clique une fiche ci-dessus pour insérer son texte (modifiable). Elle apparaîtra en annexe du PDF.">${(d.fiche||'').replace(/</g,'&lt;')}</textarea>
    </div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">💊 Plan de traitement & suivi</div>
    <div class="form-group" style="margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;align-items:center;"><label class="form-label">Plan de traitement</label><button type="button" class="btn btn-ghost btn-sm" id="diag-ai-traitement" onclick="diagAICorrect('traitement')" style="font-size:11px;padding:2px 8px;">✨ Corriger IA</button></div>
      <textarea class="form-input" id="diag-ta-traitement" rows="3" oninput="_editingDiag.traitement=this.value;diagTaAutoGrow(this)" onfocus="diagTaAutoGrow(this)" onblur="diagTaShrink(this)" placeholder="Ex. injection de poudre dans les fissures de façade, gel sur les pistes, 2e passage à prévoir...">${d.traitement||''}</textarea>
    </div>
    <div class="form-group" style="margin-bottom:14px;"><label class="form-label">Suivi / prochain passage</label>
      <select class="form-input" oninput="_editingDiag.suivi=this.value">
        <option value="" ${!d.suivi?'selected':''}>-- Choisir --</option>
        ${SUIVI_OPTIONS.map(o => `<option ${d.suivi===o?'selected':''}>${o}</option>`).join('')}
        ${d.suivi && !SUIVI_OPTIONS.includes(d.suivi) ? `<option selected>${d.suivi.replace(/</g,'&lt;')}</option>` : ''}
      </select>
      <input class="form-input" style="margin-top:5px;font-size:12px;" value="${(d.suiviRem||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.suiviRem=this.value" placeholder="Remarque complémentaire (champ libre)">
    </div>

    <div class="form-group" style="margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;"><label class="form-label">Prévention recommandée</label><button type="button" class="btn btn-ghost btn-sm" id="diag-ai-prevention" onclick="diagAICorrect('prevention')" style="font-size:11px;padding:2px 8px;">✨ Corriger IA</button></div>
      <textarea class="form-input" id="diag-ta-prevention" rows="2" oninput="_editingDiag.prevention=this.value;diagTaAutoGrow(this)" onfocus="diagTaAutoGrow(this)" onblur="diagTaShrink(this)" placeholder="Ex. reboucher les fissures, contrôler joints et seuils, traitement préventif au printemps...">${d.prevention||''}</textarea>
    </div>

    ${_diagContratFields(d)}

    <div class="form-group">
      <div style="display:flex;justify-content:space-between;align-items:center;"><label class="form-label">Conclusion / recommandations</label><button type="button" class="btn btn-ghost btn-sm" id="diag-ai-conclusion" onclick="diagAICorrect('conclusion')" style="font-size:11px;padding:2px 8px;">✨ Corriger IA</button></div>
      <textarea class="form-input" id="diag-ta-conclusion" rows="2" oninput="_editingDiag.conclusion=this.value;diagTaAutoGrow(this)" onfocus="diagTaAutoGrow(this)" onblur="diagTaShrink(this)">${d.conclusion||''}</textarea>
    </div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin:14px 0 6px;display:flex;align-items:center;flex-wrap:wrap;">✍️ Signature numérique ${_diagSectionToggle('noSign','Afficher dans le PDF')}</div>
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:8px;${d.noSign?'display:none;':''}">
      <canvas id="diag-sign-canvas" width="400" height="140" style="width:min(400px,100%);height:auto;border:1px dashed #ccc;border-radius:6px;cursor:crosshair;touch-action:none;background:#fff;"></canvas>
      <div style="display:flex;gap:6px;margin-top:6px;align-items:center;flex-wrap:wrap;">
        <button class="btn btn-ghost btn-sm" type="button" onclick="clearDiagSignature()">↺ Effacer</button>
        <span style="font-size:11px;color:var(--g400);">Signe à la souris ou au doigt — la signature est insérée dans le PDF (non stockée en base).</span>
      </div>
    </div>
  `;
  const t = $('modal-diag-title'); if (t) t.textContent = 'Rapport fourmis ' + (d.numero||'');
  initDiagSignPad();
  renderDiagPhotos();
  box.oninput = () => refreshDiagPreview();
  _syncDiagPreviewPane();
  refreshDiagPreview();
}

function _genFourmisPDF(d, mode) {
  if (!d) { if (mode !== 'blob') toast('Rapport introuvable', '#e63946'); return; }
  if (!window.jspdf || !window.jspdf.jsPDF) { toast('Librairie PDF non chargée', '#e63946'); return; }
  const co = DERATEK_CONFIG.company;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:'mm', format:'a4' });
  const M = 20, R = 190, CW = R - M;
  const NAVY = [13,27,62], SLATE = [95,111,129], GREY = [110,110,110];
  const MAX_Y = 270;
  let y = 0;

  const newPage = () => { doc.addPage(); y = 20; };
  const ensure = (h) => { if (y + h > MAX_Y) newPage(); };
  const section = (titre, keep) => {
    ensure(14 + (keep || 0));
    doc.setFillColor(SLATE[0],SLATE[1],SLATE[2]); doc.rect(M, y-3.2, 2.4, 4.4, 'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(NAVY[0],NAVY[1],NAVY[2]);
    doc.text(titre, M+4.5, y);
    doc.setDrawColor(SLATE[0],SLATE[1],SLATE[2]); doc.setLineWidth(0.4); doc.line(M, y+1.8, R, y+1.8);
    y += 7.5; doc.setTextColor(0); doc.setFont('helvetica','normal'); doc.setFontSize(10);
  };
  const field = (lbl, val, indent) => {
    if (!val) return;
    const x = indent || M;
    doc.setFont('helvetica','bold'); doc.setFontSize(9.5);
    const vx = x + Math.max(40, doc.getTextWidth(lbl + ' :') + 3);
    const lines = doc.splitTextToSize(String(val), R - vx - 2);
    ensure(Math.max(lines.length*4.8, 5.5) + 2);
    doc.setTextColor(60);
    doc.text(lbl + ' :', x, y);
    doc.setFont('helvetica','normal'); doc.setTextColor(0);
    doc.text(lines, vx, y);
    y += Math.max(lines.length*4.8, 5.5);
  };
  const para = (txt) => {
    if (!txt) return;
    doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(0);
    String(txt).split('\n').forEach(function(p){
      if (!p) { y += 3; return; }
      doc.splitTextToSize(p, CW).forEach(ln => { ensure(6); doc.text(ln, M, y); y += 4.9; });
    });
  };
  const badge = (txt, rgb, x, yy) => {
    doc.setFont('helvetica','bold'); doc.setFontSize(8.5);
    const w = doc.getTextWidth(txt) + 6;
    doc.setFillColor(rgb[0],rgb[1],rgb[2]);
    doc.roundedRect(x, yy-4.1, w, 5.6, 2.8, 2.8, 'F');
    doc.setTextColor(255); doc.text(txt, x+3, yy);
    doc.setTextColor(0);
    return w;
  };
  const GRAV_RGB = { 'Faible':[45,158,107], 'Modérée':[230,170,30], 'Importante':[235,120,40], 'Critique (infestation massive)':[230,57,70] };
  const ACT_RGB  = { 'Active':[230,57,70], 'Ancienne (traces)':[120,120,120], 'Mixte':[235,120,40] };

  const bu = (typeof BUREAUX !== 'undefined' && BUREAUX.find(b => b.id === d.bureau)) || { rue: co.rue, npa: co.npa, ville: co.ville, tel: co.tel };
  const logoW = 62, logoH = logoW*199/900;
  const logoY = 13;
  const headerFiletY = logoY + logoH + 5;
  if (typeof LOGO_B64 !== 'undefined') { try { doc.addImage(LOGO_B64,'PNG',20,logoY,logoW,logoH); } catch(e){} }
  else { doc.setFont('helvetica','bold'); doc.setFontSize(20); doc.setTextColor(13,27,62); doc.text('DERATEK', 20, 23); }
  const cy0 = logoY + 4;
  doc.setFont('helvetica','normal'); doc.setFontSize(8.5); doc.setTextColor(70);
  [bu.rue, `${bu.npa} ${bu.ville}`, 'Tél. '+(bu.tel||co.tel)].forEach((l,i)=>{ if(l) doc.text(l, 92, cy0 + i*4.4); });
  [co.email, co.tva].forEach((l,i)=>{ if(l) doc.text(l, 146, cy0 + i*4.4); });
  doc.setTextColor(13,27,62);
  try { doc.textWithLink('www.deratek.ch', 146, cy0 + 2*4.4, { url:'https://www.deratek.ch' }); } catch(e) { doc.text('www.deratek.ch', 146, cy0 + 2*4.4); }
  doc.setTextColor(0);
  doc.setDrawColor(200,205,213); doc.setLineWidth(0.4); doc.line(20, headerFiletY, 190, headerFiletY);
  doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(13,27,62);
  doc.text((bu.ville||'Neuchâtel') + ', le ' + (fmtDate(d.dateDoc)||''), 190, headerFiletY + 5, { align:'right' });
  doc.setFont('helvetica','normal'); doc.setTextColor(0);
  const bi = _diagBonInfo(d) || {};

  y = headerFiletY + 9;
  doc.setFillColor(NAVY[0],NAVY[1],NAVY[2]);
  doc.roundedRect(M, y, CW, 16, 2, 2, 'F');
  doc.setFont('helvetica','bold'); doc.setFontSize(14); doc.setTextColor(255);
  doc.text((d.doctype==='Expertise'?'EXPERTISE':'RAPPORT') + ' N° ' + (d.numero||''), M+6, y+6.8);
  doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.setTextColor(225,228,238);
  const rubanTxt = d.ruban || (((d.insectes||[]).length === 1) ? d.insectes[0] : 'Fourmis');
  doc.text(rubanTxt + ' — détection & plan d\'action', M+6, y+12.4);
  doc.setFontSize(10.5); doc.setFont('helvetica','bold'); doc.setTextColor(255);
  doc.text(fmtDate(d.dateDoc)||'', R-6, y+6.8, { align:'right' });
  doc.setTextColor(0);
  y += 21;

  y = _diagRows2Col(doc, [
    ['Technicien', d.noTech ? '' : d.tech],
    ['Client', [(d.clientNom||''), bi.clientAdresse].filter(Boolean).join('\n')],
    ['N° bon de commande', bi.bonNumero],
    ['Adresse d\'intervention', d.locataireAdresse],
    ['Gérant', bi.gerant],
    ['Téléphone', bi.tel],
    ['Email', bi.email],
    ['Locataire', d.locataireNom],
    ['Tél. locataire', bi.locTel],
    ['Logement', (bi.logement && bi.logement !== d.locataireAdresse) ? bi.logement : ''],
    ['Site / bâtiment', d.batiment],
    ['Zones inspectées', d.zones],
    ['Origine / points d\'entrée', d.elementsTouches],
  ], y, M, CW);

  y = _diagDatesStrip(doc, d, y + 5, M, CW);
  y += 1;

  const postes = Array.isArray(d.postes) ? d.postes.filter(p => p && (p.emplacement || p.produit)) : [];
  const synth = [
    ['ACTIVITÉ', d.activite, ACT_RGB[d.activite]],
    ['NIVEAU D\'INFESTATION', d.gravite, GRAV_RGB[d.gravite]],
    ['ESPÈCES', (d.insectes||[]).length ? (d.insectes||[]).length + ' détectée(s)' : '', null],
    ['ESSAIMAGE', (d.signes||[]).some(s => /ail/i.test(s)) ? 'Oui' : '', null],
  ];
  if (synth.some(s => s[1])) {
    ensure(20);
    const colW = CW/4;
    doc.setDrawColor(225,228,238); doc.setLineWidth(0.3);
    doc.roundedRect(M, y, CW, 15, 2, 2, 'D');
    synth.forEach((s, i) => {
      const cx = M + i*colW + 4;
      if (i) doc.line(M + i*colW, y+2.5, M + i*colW, y+12.5);
      doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(GREY[0],GREY[1],GREY[2]);
      doc.text(s[0], cx, y+5);
      if (!s[1]) { doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(150); doc.text('—', cx, y+11.2); return; }
      if (s[2]) { badge(String(s[1]).replace(' (infestation massive)',''), s[2], cx, y+11.2); }
      else {
        doc.setFont('helvetica','bold'); doc.setFontSize(9.5); doc.setTextColor(NAVY[0],NAVY[1],NAVY[2]);
        doc.text(doc.splitTextToSize(String(s[1]), colW-8)[0]||'', cx, y+11.2);
      }
    });
    doc.setTextColor(0);
    y += 21;
  }

  section('Constatations');
  field('Espèces détectées', (d.insectes||[]).join(', '));
  field('Signes observés', (d.signes||[]).join(', '));
  field('Origine / points d\'entrée', d.elementsTouches);
  if (d.diagnostic) {
    y += 1.5;
    doc.setFont('helvetica','bold'); doc.setFontSize(9.5); doc.setTextColor(60);
    ensure(8); doc.text('Observations :', M, y); y += 5; doc.setTextColor(0);
    para(d.diagnostic);
  }

  const photos = (!d.noPhotos && Array.isArray(d.photos)) ? d.photos.filter(p => p && p.data && p.use !== false) : [];
  if (photos.length) {
    y += 2; section('Photos de l\'inspection', 62);
    const pw = (CW - 6) / 2, ph = 58;
    photos.forEach((p, i) => {
      const col = i % 2;
      if (col === 0 && y + ph + 8 > MAX_Y) newPage();
      const px = M + col*(pw+6);
      try {
        doc.addImage(p.data, 'JPEG', px, y, pw, ph);
        doc.setDrawColor(225,228,238); doc.rect(px, y, pw, ph, 'D');
        const meta = (typeof _diagPhotoMeta === 'function') ? _diagPhotoMeta(p) : '';
        const cap = ['Photo ' + (i+1), p.caption, meta ? '(' + meta + ')' : ''].filter(Boolean).join(' — ');
        doc.setFont('helvetica','italic'); doc.setFontSize(7.5); doc.setTextColor(70);
        doc.text(doc.splitTextToSize(cap, pw).slice(0, 2), px, y+ph+3.6);
        doc.setTextColor(0);
      } catch (e) {}
      if (col === 1 || i === photos.length-1) y += ph + 8;
    });
    y += 2;
  }

  const fiches = (d.insectes||[]).filter(n => FOURMIS_INFO[n]);
  if (fiches.length) {
    y += 2; section('Fiches des espèces détectées', 38);
    fiches.forEach(nom => {
      const f = FOURMIS_INFO[nom];
      doc.setFont('helvetica','normal'); doc.setFontSize(9.5);
      const estH = 13 + [f.habitat, f.indices, f.biologie, f.risque].reduce((s,v)=> s + Math.max(doc.splitTextToSize(String(v),135).length*4.8, 5.5), 0);
      ensure(Math.min(estH, 75));
      doc.setFillColor(238,241,246);
      doc.roundedRect(M, y-1, CW, 7, 1.5, 1.5, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(10);
      const nomW = doc.getTextWidth(nom);
      doc.setTextColor(SLATE[0],SLATE[1],SLATE[2]);
      doc.text(nom, M+3, y+3.6);
      doc.setFont('helvetica','italic'); doc.setFontSize(9); doc.setTextColor(110);
      doc.text(f.latin, M+3+nomW+4, y+3.6);
      doc.setTextColor(0);
      y += 10;
      field('Habitat', f.habitat, M+3);
      field('Indices typiques', f.indices, M+3);
      field('Biologie', f.biologie, M+3);
      field('Risque', f.risque, M+3);
      y += 3;
    });
  }

  const materiel = Array.isArray(d.materiel) ? d.materiel : [];
  const produits = Array.isArray(d.rodenticides) ? d.rodenticides : [];
  const actions = Array.isArray(d.actions) ? d.actions : [];
  const checkLine = (txt) => {
    const lines = doc.splitTextToSize(String(txt), CW - 8);
    ensure(lines.length*4.8 + 2);
    doc.setDrawColor(NAVY[0],NAVY[1],NAVY[2]); doc.setLineWidth(0.35);
    doc.rect(M, y-3, 3.2, 3.2);
    doc.setDrawColor(45,158,107); doc.setLineWidth(0.6);
    doc.line(M+0.7, y-1.4, M+1.4, y-0.6); doc.line(M+1.4, y-0.6, M+2.7, y-2.6);
    doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.setTextColor(0);
    doc.text(lines, M+5.5, y);
    y += lines.length*4.8 + 1;
  };
  if (d.traitement || d.suivi || materiel.length || produits.length || actions.length) {
    y += 2; section('Plan de traitement', 12);
    if (materiel.length) { field('Matériel / méthode', materiel.join(', ')); y += 1; }
    const prodAucun = produits.includes('Aucun produit chimique');
    const prodList = produits.filter(r => r !== 'Aucun produit chimique');
    if (prodAucun && !prodList.length && !d.rodenticideAutre) { field('Produit', 'Aucun produit chimique utilisé'); y += 1; }
    else if (prodList.length || d.rodenticideAutre) { field('Insecticide professionnel', [...prodList, d.rodenticideAutre].filter(Boolean).join(', ')); y += 1; }
    para(d.traitement);
    if (actions.length) { y += 1.5; actions.forEach(a => checkLine(a)); }
    const suiviTxt = [d.suivi, d.suiviRem].filter(Boolean).join(' — ');
    if (suiviTxt) { y += 1.5; field('Suivi / prochain passage', suiviTxt); }
  }

  if (d.prevention) {
    y += 2; section('Prévention recommandée', 12);
    para(d.prevention);
  }

  if (d.contrat) {
    y += 2; section('Proposition de contrat annuel', 18);
    para("Au vu de la situation constatée, une proposition de contrat annuel peut être envisagée afin d'assurer un suivi régulier, de limiter les risques de récidive et de maintenir une surveillance préventive des zones sensibles.");
    y += 1.5;
    field('Passages annuels proposés', d.contratPassages);
    field('Montant estimatif', d.contratMontant);
    field('Zones concernées', d.contratZones);
    field('Remarques', d.contratRem);
  }

  if (d.conclusion) {
    // On fixe la police AVANT de découper : sinon le calcul de largeur se fait avec
    // la taille laissée par la section précédente et les lignes débordent du cadre.
    doc.setFont('helvetica','normal'); doc.setFontSize(10);
    const lines = doc.splitTextToSize(String(d.conclusion), CW-13);
    const boxH = lines.length*4.9 + 8;
    if (y + boxH + 12 > MAX_Y) newPage();
    y += 2; section('Conclusion / recommandations');
    doc.setFillColor(240,243,250); doc.setDrawColor(NAVY[0],NAVY[1],NAVY[2]); doc.setLineWidth(0.3);
    doc.roundedRect(M, y-2, CW, boxH, 2, 2, 'FD');
    doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(NAVY[0],NAVY[1],NAVY[2]);
    lines.forEach((ln, i) => doc.text(ln, M+5, y+3.5 + i*4.9));
    doc.setTextColor(0);
    y += boxH + 4;
  }

  // Fiche(s) technique(s) annexée(s)
  if (d.fiche && String(d.fiche).trim()) {
    y += 2; section('Fiche technique', 14);
    para(d.fiche);
  }

  if (!d.noSign) {
    ensure(32);
    y += 8;
    doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.setTextColor(40);
    doc.text(bu.ville + ', le ' + (fmtDate(d.dateDoc)||''), M, y);
    doc.text('DERATEK' + (d.tech && !d.noTech ? ' — ' + d.tech : ''), 120, y);
    if (d.signature) { try { doc.addImage(d.signature, 'PNG', 120, y+1.5, 45, 15.75); } catch (e) {} }
    doc.setDrawColor(120); doc.setLineWidth(0.3); doc.line(120, y+18, 186, y+18);
    doc.setFontSize(8); doc.setTextColor(GREY[0],GREY[1],GREY[2]);
    doc.text('Signature', 120, y+21.5);
    doc.setTextColor(0);
  }

  const nb = doc.getNumberOfPages();
  for (let i = 1; i <= nb; i++) {
    doc.setPage(i);
    doc.setDrawColor(SLATE[0],SLATE[1],SLATE[2]); doc.setLineWidth(0.3); doc.line(M, 283, R, 283);
    doc.setFont('helvetica','normal'); doc.setFontSize(7.5); doc.setTextColor(GREY[0],GREY[1],GREY[2]);
    doc.text('DERATEK Professional Pest Control — ' + co.rue + ', ' + co.npa + ' ' + co.ville + ' — ' + co.email, M, 287.5);
    doc.text('Page ' + i + '/' + nb, R, 287.5, { align:'right' });
    doc.setTextColor(0);
  }

  if (mode === 'blob') return doc.output('blob');
  doc.save('rapport-fourmis-' + (d.numero||'doc').replace(/[^a-z0-9]+/gi,'-').toLowerCase() + '.pdf');
  toast('✓ PDF rapport fourmis téléchargé', '#2d9e6b');
}

// ============================================================
// STATISTIQUES
// ============================================================
let _statCharts = {};
// Plugin Chart.js : dessine la valeur + pourcentage sur chaque part / barre
const _statDataLabelsPlugin = {
  id: 'statDataLabels',
  afterDatasetsDraw(chart) {
    const { ctx, data, chartArea } = chart;
    const ds = data.datasets[0]; if (!ds) return;
    const total = ds.data.reduce((s, v) => s + (parseFloat(v) || 0), 0) || 1;
    const meta = chart.getDatasetMeta(0);
    const isDonut = chart.config.type === 'doughnut';
    const isMoney = chart.options._isMoney;
    ctx.save();
    ctx.font = 'bold 11px Arial';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    meta.data.forEach((el, i) => {
      const v = ds.data[i]; if (!v) return;
      const pct = (v / total * 100).toFixed(0) + '%';
      let x, y, drawWhite = true;
      if (isDonut) {
        const pos = el.tooltipPosition();
        x = pos.x; y = pos.y;
        // Affiche pourcentage seulement si la part est assez grande (>5%)
        if (v / total < 0.05) return;
      } else {
        x = el.x; y = el.y - 12;
        ctx.fillStyle = '#0d1b3e'; drawWhite = false;
      }
      if (drawWhite) ctx.fillStyle = '#fff';
      const label = isDonut ? pct : ((isMoney ? _displayMontant(v) : v) + ' (' + pct + ')');
      ctx.fillText(label, x, y);
    });
    ctx.restore();
  }
};
function _makeChart(id, type, labels, data, colors, isMoney) {
  const cv = $(id);
  if (!cv || typeof Chart === 'undefined') return;
  if (_statCharts[id]) { try { _statCharts[id].destroy(); } catch (e) {} }
  if (!labels.length) {
    const ctx = cv.getContext('2d'); ctx.clearRect(0,0,cv.width,cv.height);
    ctx.fillStyle = '#9ca3af'; ctx.font = '13px Arial'; ctx.textAlign = 'center';
    ctx.fillText('Aucune donnée', cv.width/2, cv.height/2);
    return;
  }
  const isDonut = (type === 'doughnut');
  const total = data.reduce((s, v) => s + (parseFloat(v) || 0), 0) || 1;
  _statCharts[id] = new Chart(cv, {
    type,
    data: { labels, datasets: [{
      data, backgroundColor: colors,
      borderColor: '#fff', borderWidth: isDonut ? 2 : 0,
      borderRadius: isDonut ? 0 : 6, maxBarThickness: 56
    }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      _isMoney: !!isMoney,
      plugins: {
        legend: { display: isDonut, position: 'right', labels: { font: { size: 11 }, boxWidth: 12, padding: 8 } },
        tooltip: { callbacks: { label: c => {
          const v = c.parsed.y !== undefined ? c.parsed.y : c.parsed;
          const pct = (v / total * 100).toFixed(1) + '%';
          return ' ' + (isMoney ? _displayMontant(v) + ' CHF' : v) + ' · ' + pct;
        } } }
      },
      cutout: isDonut ? '55%' : undefined,
      scales: isDonut ? {} : {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: { beginAtZero: true, ticks: { font: { size: 10 }, precision: isMoney ? undefined : 0 }, grid: { color: '#f0f0f0' } }
      }
    },
    plugins: [_statDataLabelsPlugin]
  });
}
function renderStats() {
  const bons = DB.bons || [], docs = DB.documents || [], fourn = DB.fournisseurs || [];
  const factures = docs.filter(d => d.type === 'facture');
  const devis = docs.filter(d => d.type === 'devis');
  const caFactures = factures.reduce((s, f) => s + (parseFloat(f.total)||0), 0);
  const depenses = fourn.reduce((s, f) => s + (parseFloat(f.montant)||0), 0);

  const card = (val, label, color) => `
    <div class="card" style="padding:14px;text-align:center;">
      <div style="font-size:26px;font-weight:800;color:${color||'var(--navy)'};">${val}</div>
      <div style="font-size:10px;color:var(--g400);text-transform:uppercase;letter-spacing:.4px;margin-top:2px;">${label}</div>
    </div>`;
  const cards = $('stats-cards');
  if (cards) cards.innerHTML =
    card(bons.length, 'Bons') +
    card((DB.clients||[]).length, 'Clients') +
    card((DB.locataires||[]).length, 'Locataires') +
    card(devis.length, 'Devis') +
    card(factures.length, 'Factures') +
    card(_displayMontant(caFactures), 'CA facturé (CHF)', '#2d9e6b') +
    card(_displayMontant(depenses), 'Dépenses fourn. (CHF)', '#e63946');

  // Nuisibles → camembert (donut)
  const nuis = {};
  bons.forEach(b => { const info = _nuisibleInfo(_bonProblemeClean(b)); (nuis[info.label] = nuis[info.label] || { n: 0, color: info.color }).n++; });
  let nk = Object.keys(nuis).sort((a,b)=>nuis[b].n-nuis[a].n);
  _makeChart('chart-nuisibles', 'doughnut', nk, nk.map(k=>nuis[k].n), nk.map(k=>nuis[k].color), false);

  // Gérances → camembert (donut)
  const ger = {};
  bons.forEach(b => { const g = b.geranceNom || '(Sans gérance)'; ger[g] = (ger[g]||0)+1; });
  let gk = Object.keys(ger).sort((a,b)=>ger[b]-ger[a]);
  _makeChart('chart-gerances', 'doughnut', gk, gk.map(k=>ger[k]), gk.map(k=>colorForGeranceName(k)), false);

  // Statuts → barres verticales
  const statutLabels = { '':'Non défini', 'urgent':'Urgent', 'a-contacter':'À contacter', 'a-transmettre':'Rapport à transmettre', 'transmis':'Transmis', 'demande-devis':'Demande de devis', 'attente-devis':'Attente devis', 'devis-valide':'Devis validé', 'en-cours':'En cours', 'termine':'Terminé', 'a-facturer':'À facturer' };
  const statutCol = { '':'#9ca3af','urgent':'#ef4444','a-contacter':'#06b6d4','transmis':'#3b82f6','demande-devis':'#6366f1','attente-devis':'#8b5cf6','devis-valide':'#14b8a6','en-cours':'#f97316','termine':'#22c55e','a-facturer':'#ef4444' };
  const st = {};
  bons.forEach(b => { const s = b.statut || ''; st[s] = (st[s]||0)+1; });
  let sk = Object.keys(st).sort((a,b)=>st[b]-st[a]);
  _makeChart('chart-statuts', 'bar', sk.map(k=>statutLabels[k]||k), sk.map(k=>st[k]), sk.map(k=>statutCol[k]||'#6b7280'), false);

  // Dépenses par secteur → barres verticales (CHF)
  const sec = {};
  fourn.forEach(f => { const s = f.secteur || 'Autre'; sec[s] = (sec[s]||0) + (parseFloat(f.montant)||0); });
  let sek = Object.keys(sec).sort((a,b)=>sec[b]-sec[a]);
  _makeChart('chart-secteurs', 'bar', sek, sek.map(k=>Math.round(sec[k]*100)/100), sek.map(k=>SECTEUR_COLORS[k]||'#64748b'), true);
}

// ============================================================
// DÉCOMPTE TVA
// ============================================================
function _tvaPeriode(annee, periode) {
  const ranges = {
    annee: [`${annee}-01-01`, `${annee}-12-31`],
    s1:    [`${annee}-01-01`, `${annee}-06-30`],
    s2:    [`${annee}-07-01`, `${annee}-12-31`],
    t1:    [`${annee}-01-01`, `${annee}-03-31`],
    t2:    [`${annee}-04-01`, `${annee}-06-30`],
    t3:    [`${annee}-07-01`, `${annee}-09-30`],
    t4:    [`${annee}-10-01`, `${annee}-12-31`],
  };
  return ranges[periode] || ranges.annee;
}
function renderTVA() {
  // Remplir le sélecteur d'années (à partir des données + année courante)
  const selA = $('tva-annee');
  if (selA && !selA.options.length) {
    const annees = new Set([new Date().getFullYear()]);
    (DB.documents || []).forEach(d => { if (d.dateDoc) annees.add(parseInt(d.dateDoc.slice(0,4),10)); });
    (DB.fournisseurs || []).forEach(f => { if (f.dateDoc) annees.add(parseInt(f.dateDoc.slice(0,4),10)); });
    selA.innerHTML = [...annees].filter(Boolean).sort((a,b)=>b-a).map(a=>`<option value="${a}">${a}</option>`).join('');
  }
  const annee = (selA && selA.value) || new Date().getFullYear();
  const periode = ($('tva-periode') && $('tva-periode').value) || 'annee';
  const [d1, d2] = _tvaPeriode(annee, periode);
  const inRange = d => d && d >= d1 && d <= d2;

  // VENTES (factures) → TVA collectée, groupé par taux
  const ventes = {};
  (DB.documents || []).filter(x => x.type === 'facture' && inRange(x.dateDoc)).forEach(f => {
    const taux = parseFloat(f.tvaTaux) || 0;
    const baseHt = (parseFloat(f.sousTotal)||0) - (parseFloat(f.rabaisMontant)||0);
    const tva = parseFloat(f.tvaMontant) || 0;
    if (!ventes[taux]) ventes[taux] = { base: 0, tva: 0 };
    ventes[taux].base += baseHt; ventes[taux].tva += tva;
  });
  // ACHATS (fournisseurs) → TVA déductible, groupé par taux calculé
  const achats = {};
  (DB.fournisseurs || []).filter(x => inRange(x.dateDoc)).forEach(f => {
    const ht = parseFloat(f.montantHt) || 0;
    const tva = parseFloat(f.tva) || 0;
    let taux = ht > 0 ? Math.round((tva / ht) * 1000) / 10 : 0;
    if (!achats[taux]) achats[taux] = { base: 0, tva: 0 };
    achats[taux].base += ht; achats[taux].tva += tva;
  });

  const sumTva = obj => Object.values(obj).reduce((s, x) => s + x.tva, 0);
  const totCollectee = sumTva(ventes);
  const totDeductible = sumTva(achats);
  const aPayer = totCollectee - totDeductible;

  // Cartes
  const card = (titre, montant, color) => `
    <div class="card" style="padding:16px;">
      <div style="font-size:11px;font-weight:700;color:var(--g400);text-transform:uppercase;letter-spacing:.4px;">${titre}</div>
      <div style="font-size:24px;font-weight:800;color:${color};margin-top:4px;">${_displayMontant(montant)} CHF</div>
    </div>`;
  const cards = $('tva-cards');
  if (cards) cards.innerHTML =
    card('TVA collectée', totCollectee, 'var(--navy)') +
    card('TVA déductible', totDeductible, 'var(--navy)') +
    card('TVA à payer', aPayer, aPayer >= 0 ? '#e63946' : '#2d9e6b');

  // Tables
  const tableHtml = (obj) => {
    const taux = Object.keys(obj).map(Number).sort((a,b)=>b-a);
    if (!taux.length) return '<div style="text-align:center;color:var(--g400);font-size:13px;padding:14px;">Aucune donnée</div>';
    let h = `<table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead><tr style="color:var(--g400);text-transform:uppercase;font-size:10px;text-align:right;">
        <th style="text-align:left;padding:4px;">Taux</th><th style="padding:4px;">Base HT</th><th style="padding:4px;">TVA</th>
      </tr></thead><tbody>`;
    taux.forEach(t => {
      h += `<tr style="border-top:1px solid #f0f0f0;">
        <td style="text-align:left;padding:6px 4px;font-weight:700;">${t}%</td>
        <td style="text-align:right;padding:6px 4px;">${_displayMontant(obj[t].base)}</td>
        <td style="text-align:right;padding:6px 4px;font-weight:700;color:var(--navy);">${_displayMontant(obj[t].tva)}</td>
      </tr>`;
    });
    const totBase = Object.values(obj).reduce((s,x)=>s+x.base,0);
    const totTva = Object.values(obj).reduce((s,x)=>s+x.tva,0);
    h += `<tr style="border-top:2px solid var(--navy);font-weight:800;">
      <td style="text-align:left;padding:6px 4px;">Total</td>
      <td style="text-align:right;padding:6px 4px;">${_displayMontant(totBase)}</td>
      <td style="text-align:right;padding:6px 4px;color:var(--navy);">${_displayMontant(totTva)}</td>
    </tr></tbody></table>`;
    return h;
  };
  if ($('tva-ventes')) $('tva-ventes').innerHTML = tableHtml(ventes);
  if ($('tva-achats')) $('tva-achats').innerHTML = tableHtml(achats);
}

// ============================================================
// FOURNISSEURS — lecture IA du PDF + classement par secteur
// ============================================================
const SECTEURS_FOURN = ['Matériel', 'Informatique', 'Garage / véhicules', 'Communication / marketing', 'Administratif', 'Carburant', 'Assurances', 'Produits / consommables', 'Autre'];
const SECTEUR_COLORS = {
  'Matériel': '#f97316', 'Informatique': '#3b82f6', 'Garage / véhicules': '#6b7280',
  'Communication / marketing': '#ec4899', 'Administratif': '#8b5cf6', 'Carburant': '#ef4444',
  'Assurances': '#14b8a6', 'Produits / consommables': '#10b981', 'Autre': '#64748b'
};
let _pendingFournPdf = null;

function fournHandleDrop(e) {
  e.preventDefault();
  const dz = $('fourn-dropzone'); if (dz) dz.classList.remove('drag');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) fournProcessFile(f);
}
function fournHandleInput(e) { const f = e.target.files && e.target.files[0]; if (f) fournProcessFile(f); }

async function fournProcessFile(file) {
  const status = $('fourn-status'); const confirm = $('fourn-confirm');
  if (confirm) { confirm.style.display = 'none'; confirm.innerHTML = ''; }
  if (file.type !== 'application/pdf') { toast('Merci de déposer un fichier PDF', '#e63946'); return; }
  _pendingFournPdf = file;
  const setStatus = m => { if (status) { status.style.display = 'block'; status.innerHTML = m; } };
  try {
    setStatus('⏳ Lecture du PDF en cours…');
    const texte = await bonExtractText(file);
    if (!texte || texte.length < 20) { setStatus(''); toast('Ce PDF ne contient pas de texte lisible.', '#e63946'); return; }
    setStatus('🤖 Analyse du document par l\'IA…');
    const infos = await fournExtractInfosIA(texte);
    setStatus('');
    fournShowConfirm(infos, file.name);
  } catch (err) { setStatus(''); console.error('Fourn error:', err); toast('Erreur : ' + err.message, '#e63946'); }
}

async function fournExtractInfosIA(texte) {
  const systemPrompt =
    'Tu extrais les informations d\'une FACTURE FOURNISSEUR. Réponds UNIQUEMENT par un objet JSON valide, ' +
    'sans texte ni balises Markdown. Utilise exactement ces clés (chaîne vide si absent) :\n' +
    '{\n"fournisseur":"nom du fournisseur / entreprise émettrice",\n' +
    '"numero":"numéro de facture",\n' +
    '"date":"date de la facture au format AAAA-MM-JJ",\n' +
    '"montant_ht":"montant hors taxe (HT), chiffres uniquement",\n' +
    '"tva":"montant de la TVA, chiffres uniquement",\n' +
    '"montant":"montant total TTC, chiffres uniquement (ex 1234.50)",\n' +
    '"description":"objet ou résumé court des articles/prestations"\n}';
  const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DERATEK_CONFIG.mistral.apiKey },
    body: JSON.stringify({
      model: DERATEK_CONFIG.mistral.model, max_tokens: 700, temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: texte }]
    })
  });
  if (!response.ok) { let m = 'API ' + response.status; try { const e = await response.json(); m = (e.error && e.error.message) || m; } catch (e) {} throw new Error(m); }
  const data = await response.json();
  const raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!raw) throw new Error('Réponse IA vide');
  return JSON.parse(raw.replace(/```json/gi, '').replace(/```/g, '').trim());
}

// ============================================================
// ANCIENNES FACTURES — import Excel (.xlsx) + extraction IA, une à la fois
// ============================================================
function ancReset() {
  state.anc = { queue: [], qIdx: 0, fileName: '' };
  const dz = $('anc-dropzone'); if (dz) dz.style.display = '';
  const st = $('anc-status'); if (st) { st.style.display = 'none'; st.textContent = ''; }
  const fm = $('anc-form'); if (fm) { fm.style.display = 'none'; fm.innerHTML = ''; }
  const pr = $('anc-progress'); if (pr) pr.textContent = 'Glisse une ou plusieurs factures Excel — chaque fichier = une facture.';
  const inp = $('anc-file-input'); if (inp) inp.value = '';
}
function ancHandleDrop(e) {
  e.preventDefault();
  const dz = $('anc-dropzone'); if (dz) dz.classList.remove('drag');
  const fs = e.dataTransfer.files;
  if (fs && fs.length) ancStartFiles(fs);
}
function ancHandleInput(e) { const fs = e.target.files; if (fs && fs.length) ancStartFiles(fs); }
function ancStartFiles(fileList) {
  // Chaque fichier .xlsx = UNE facture complète. On les traite l'un après l'autre.
  state.anc = { queue: Array.from(fileList), qIdx: 0, fileName: '' };
  const dz = $('anc-dropzone'); if (dz) dz.style.display = 'none';
  ancProcessFile();
}
function ancSetStatus(msg, show) {
  const st = $('anc-status'); if (!st) return;
  st.style.display = (show === false) ? 'none' : 'block';
  st.textContent = msg || '';
}
// Lit tout le contenu d'une feuille Excel et le renvoie en texte (toutes cellules non vides)
function _ancReadSheetText(file) {
  return new Promise((resolve, reject) => {
    if (typeof XLSX === 'undefined') { reject(new Error('Librairie Excel non chargée — rafraîchis la page')); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const wb = XLSX.read(new Uint8Array(ev.target.result), { type: 'array' });
        const out = [];
        wb.SheetNames.forEach(n => {
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, blankrows: false, defval: '' });
          rows.forEach(r => {
            const line = r.map(c => String(c == null ? '' : c).trim()).filter(Boolean).join('  |  ');
            if (line) out.push(line);
          });
        });
        resolve(out.join('\n'));
      } catch (e) { reject(e); }
    };
    reader.onerror = () => reject(new Error('lecture du fichier impossible'));
    reader.readAsArrayBuffer(file);
  });
}
async function ancProcessFile() {
  const a = state.anc;
  const fm = $('anc-form'); if (fm) { fm.style.display = 'none'; fm.innerHTML = ''; }
  const pr = $('anc-progress');
  if (!a.queue || a.qIdx >= a.queue.length) {
    ancSetStatus('✅ Terminé — ' + ((a.queue || []).length) + ' fichier(s) traité(s).');
    if (pr) pr.textContent = 'Import terminé. Glisse d\'autres fichiers si besoin.';
    const dz = $('anc-dropzone'); if (dz) dz.style.display = '';
    return;
  }
  const file = a.queue[a.qIdx];
  a.fileName = file.name;
  if (pr) pr.textContent = 'Facture ' + (a.qIdx + 1) + ' / ' + a.queue.length + ' — ' + file.name;
  ancSetStatus('📖 Lecture de ' + file.name + '…');
  let text;
  try { text = await _ancReadSheetText(file); }
  catch (err) { console.error('Excel read', err); ancSetStatus('⚠️ Lecture impossible : ' + err.message + ' — clique « Passer ».'); ancShowForm({}); return; }
  ancSetStatus('🤖 Analyse de la facture par l\'IA…');
  try {
    const infos = await ancExtractIA(text);
    ancSetStatus('', false);
    ancShowForm(infos);
  } catch (err) {
    console.error('Anc IA error', err);
    ancSetStatus('⚠️ Erreur IA : ' + err.message + ' — remplis manuellement ci-dessous.');
    ancShowForm({});
  }
}
async function ancExtractIA(texte) {
  const systemPrompt =
    "On te donne le contenu COMPLET d'une ancienne FACTURE (un seul document) d'une entreprise antinuisibles (DERATEK), lu depuis Excel. " +
    "Extrais les informations et réponds UNIQUEMENT par un objet JSON valide, sans texte ni Markdown. Clés exactes (chaîne vide si absent) :\n" +
    '{\n' +
    '"numero_facture":"numéro de la facture (ex 37126)",\n' +
    '"numero_bon":"numéro de bon de travail / bon pour travaux / bon de commande si présent (ex \'2026 021 124\')",\n' +
    '"numero_devis":"numéro de devis cité dans le texte (ex 260378)",\n' +
    '"date":"date de la facture au format AAAA-MM-JJ (ex \'NEUCHÂTEL LE 20.04.2026\' -> 2026-04-20)",\n' +
    '"proprietaire":"UNIQUEMENT si l\'adresse contient \'p.a.\' (= par adresse / chez) : le nom de la personne AVANT le p.a. (ex \'Monsieur Aldo Brauen\'). Vide s\'il n\'y a pas de p.a.",\n' +
    '"facturation_nom":"nom du DESTINATAIRE à qui la facture est adressée. S\'il y a un \'p.a.\', c\'est l\'ENTITÉ APRÈS le p.a. (la gérance/régie, ex \'Naef Immobilier Neuchâtel SA\'). Sinon c\'est le nom complet en haut (ex \'Monsieur Patrice Racine\')",\n' +
    '"facturation_adresse":"rue et numéro de ce destinataire (la gérance s\'il y a un p.a.), ex \'Rue des Terreaux 9\' ou \'Rue du Doubs 61\'",\n' +
    '"facturation_npa":"code postal du destinataire, ex \'2001\'",\n' +
    '"facturation_ville":"ville du destinataire, ex \'Neuchâtel\'",\n' +
    '"locataire_nom":"nom de l\'occupant du LIEU d\'intervention cité dans la description des travaux (ex \'Madame Massy\'), DIFFÉRENT du destinataire",\n' +
    '"locataire_prenom":"prénom de l\'occupant si présent",\n' +
    '"locataire_adresse":"adresse du LIEU d\'intervention citée dans la description (ex \'Rue du Nord 48, 2300 La Chaux-de-Fonds\')",\n' +
    '"nuisible":"type de nuisible traité (punaises de lit, souris, rats, guêpes, blattes, fourmis…)",\n' +
    '"prestation":"objet / résumé court des travaux (ex \'Traitement contre les punaises de lit\')",\n' +
    '"prix_ht":"montant HORS TAXE principal, souvent la ligne \'Matériel et main d\'oeuvre\' ou le sous-total HT avant rabais (ex 1890), chiffres uniquement",\n' +
    '"rabais":"montant du rabais en CHF (ligne \'Rabais\'), chiffres uniquement (ex 94.5)"\n' +
    '}\n' +
    "IMPORTANT : sépare bien le DESTINATAIRE de la facture (facturation) du LIEU d'intervention (locataire). Ne renvoie que des nombres pour prix_ht et rabais (sans 'CHF', point décimal).";
  const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DERATEK_CONFIG.mistral.apiKey },
    body: JSON.stringify({
      model: DERATEK_CONFIG.mistral.model, max_tokens: 800, temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: texte }]
    })
  });
  if (!response.ok) { let m = 'API ' + response.status; try { const e = await response.json(); m = (e.error && e.error.message) || m; } catch (e) {} throw new Error(m); }
  const data = await response.json();
  const raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!raw) throw new Error('Réponse IA vide');
  return JSON.parse(raw.replace(/```json/gi, '').replace(/```/g, '').trim());
}
function ancShowForm(infos) {
  const fm = $('anc-form'); if (!fm) return;
  infos = infos || {};
  const v = x => (x == null ? '' : String(x)).replace(/"/g, '&quot;');
  const a = state.anc;
  const champ = (label, key, val, ph) =>
    `<div class="form-group" style="margin-bottom:8px;">
       <label class="form-label">${label}</label>
       <input class="form-input" id="anc-${key}" value="${v(val)}" placeholder="${ph||''}" style="font-size:13px;">
     </div>`;
  fm.style.display = 'block';
  fm.innerHTML = `
    <div style="background:#fff;border:2px solid var(--navy);border-radius:12px;padding:18px;box-shadow:0 4px 18px rgba(13,27,62,.12);">
      <div style="font-size:15px;font-weight:800;color:var(--navy);margin-bottom:4px;">📁 Facture ${a.qIdx + 1} / ${a.queue.length} — vérifie puis valide</div>
      <div style="font-size:12px;color:var(--g600);margin-bottom:14px;">Corrige ce que l'IA aurait mal lu, puis « ✅ Valider et enregistrer ».</div>
      <div id="anc-doublon" style="display:none;"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0 14px;">
        ${champ('N° facture', 'numero_facture', infos.numero_facture)}
        ${champ('N° bon de travail', 'numero_bon', infos.numero_bon)}
        ${champ('N° devis', 'numero_devis', infos.numero_devis)}
        ${champ('Date (AAAA-MM-JJ)', 'date', infos.date)}
        ${champ('Locataire — nom', 'locataire_nom', infos.locataire_nom)}
        ${champ('Locataire — prénom', 'locataire_prenom', infos.locataire_prenom)}
        ${champ('Nuisible', 'nuisible', infos.nuisible)}
      </div>
      ${champ("Adresse du locataire (lieu d'intervention)", 'locataire_adresse', infos.locataire_adresse)}
      <div class="form-group" style="margin-bottom:8px;"><label class="form-label">Prestation / travaux</label>
        <textarea class="form-input" id="anc-prestation" rows="2" style="font-size:13px;">${(infos.prestation||'').replace(/</g,'&lt;')}</textarea>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 14px;">
        ${champ('Prix HT (CHF)', 'prix_ht', infos.prix_ht)}
        ${champ('Rabais (CHF)', 'rabais', infos.rabais)}
      </div>
      <div style="border-top:1px dashed #ccc;margin-top:8px;padding-top:10px;">
        <div style="font-size:11px;font-weight:800;color:var(--g600);text-transform:uppercase;margin-bottom:6px;">Destinataire de la facture</div>
        ${champ('Propriétaire (si « p.a. » — sinon laisser vide)', 'proprietaire', infos.proprietaire)}
        ${champ('Nom / Gérance (destinataire de la facture)', 'facturation_nom', infos.facturation_nom)}
        ${champ('Rue et numéro', 'facturation_adresse', infos.facturation_adresse)}
        <div style="display:grid;grid-template-columns:1fr 2fr;gap:0 14px;">
          ${champ('NPA', 'facturation_npa', infos.facturation_npa)}
          ${champ('Ville', 'facturation_ville', infos.facturation_ville)}
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--g600);margin-top:4px;cursor:pointer;">
          <input type="checkbox" id="anc-create-client" style="width:16px;height:16px;accent-color:var(--navy);">
          Créer aussi une fiche client pour ce destinataire (sinon non enregistré)
        </label>
        <select class="form-input" id="anc-client-type" style="font-size:12px;margin-top:6px;max-width:220px;">
          <option value="Gérance">Gérance</option><option value="Particulier">Particulier</option>
          <option value="PPE">PPE</option><option value="Commune">Commune</option>
          <option value="Association">Association</option><option value="Entreprise">Entreprise</option>
        </select>
      </div>
      <div class="form-group" style="margin-top:10px;">
        <label class="form-label">Statut de la facture</label>
        <select class="form-input" id="anc-statut" style="font-size:13px;max-width:220px;">
          <option value="payee">Payée</option>
          <option value="envoyee">Facture envoyée</option>
          <option value="impayee">Pas payée</option>
        </select>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap;">
        <button class="btn btn-ghost" onclick="ancPasser()">↷ Passer cette ligne</button>
        <button class="btn btn-green" onclick="ancValider()">✅ Valider et enregistrer</button>
      </div>
    </div>`;
  // Alerte « déjà enregistrée » : au chargement et à chaque modification du n° de facture
  const _nf = $('anc-numero_facture');
  if (_nf) _nf.addEventListener('input', ancCheckDoublon);
  ancCheckDoublon();
}
function ancPasser() { state.anc.qIdx++; ancProcessFile(); }
// Liste des anciennes factures importées, conservée dans l'onglet (payée / non payée)
function renderAnciennesList() {
  const box = $('anc-list'); if (!box) return;
  const all = (DB.documents || []).filter(d => _isAncienneFacture(d));
  if (!all.length) { box.innerHTML = ''; return; }
  // Les payées sont parties dans « Facturation archivée » → ici on n'affiche que les NON payées.
  const paidList = all.filter(d => d.statut === 'payee');
  const shown = all.filter(d => d.statut !== 'payee').slice().sort((a, b) => (_ancOrd(a) - _ancOrd(b)) || (b.dateDoc || '').localeCompare(a.dateDoc || ''));
  // Tri optionnel par numéro de facture (croissant / décroissant) ; sinon ordre manuel
  const _ancSort = state.ancSort || 'manuel';
  if (_ancSort === 'num-asc' || _ancSort === 'num-desc') {
    const numOf = d => { const m = String(d.numero || '').match(/\d+/g); return m ? parseInt(m.join(''), 10) : NaN; };
    shown.sort((a, b) => { const na = numOf(a), nb = numOf(b); let c; if (isNaN(na) && isNaN(nb)) c = String(a.numero||'').localeCompare(String(b.numero||'')); else if (isNaN(na)) c = 1; else if (isNaN(nb)) c = -1; else c = na - nb; return _ancSort === 'num-desc' ? -c : c; });
  }
  const nPay = paidList.length;
  const totalPaye = paidList.reduce((s, d) => s + (parseFloat(d.total) || 0), 0);
  const totalNonPaye = shown.reduce((s, d) => s + (parseFloat(d.total) || 0), 0);
  const nNonPay = shown.length;
  // Détail par statut : envoyées vs pas payées
  const envoyees = shown.filter(d => (d.statut || 'envoyee') !== 'impayee');
  const pasPayees = shown.filter(d => d.statut === 'impayee');
  const nEnv = envoyees.length, sEnv = envoyees.reduce((s, d) => s + (parseFloat(d.total) || 0), 0);
  const nImp = pasPayees.length, sImp = pasPayees.reduce((s, d) => s + (parseFloat(d.total) || 0), 0);
  // Filtre cliquable (cartes récap) : 'tous' | 'envoyee' | 'impayee'
  const af = state.ancFilter || 'tous';
  const _ancQ = (state.ancSearch || '').trim().toLowerCase();
  const _ancMatch = d => {
    if (!_ancQ) return true;
    const hay = [d.numero, d.clientNom, d.proprietaire, d.locataireNom, d.locataireAdresse, String(d.notes || '')].join(' ').toLowerCase();
    return hay.includes(_ancQ);
  };
  const displayed = (af === 'impayee' ? pasPayees : (af === 'envoyee' ? envoyees : shown)).filter(_ancMatch);
  const ring = (on, col) => on ? `box-shadow:0 0 0 2px ${col};` : '';
  box.innerHTML = `
    <div style="border-top:1px solid #eee;padding-top:12px;margin-bottom:8px;">
      <div style="font-size:13px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">📁 Anciennes factures à encaisser (${nNonPay}) · ${_displayMontant(totalNonPaye)} CHF</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
        <div onclick="ancSetFilter('envoyee')" title="Cliquer pour n'afficher que les factures envoyées" style="cursor:pointer;background:#eef2ff;border:1px solid #c7d2fe;border-radius:8px;padding:7px 12px;font-size:12px;${ring(af==='envoyee','#6366f1')}"><span style="color:#1a2744;font-weight:800;">📨 Factures envoyées</span> : <b>${nEnv}</b> · ${_displayMontant(sEnv)} CHF</div>
        <div onclick="ancSetFilter('impayee')" title="Cliquer pour n'afficher que les factures pas payées" style="cursor:pointer;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:7px 12px;font-size:12px;${ring(af==='impayee','#f59e0b')}"><span style="color:#9a3412;font-weight:800;">⏳ Pas payées</span> : <b>${nImp}</b> · ${_displayMontant(sImp)} CHF</div>
        <div onclick="ancSetFilter('tous')" title="Cliquer pour afficher toutes les factures à encaisser" style="cursor:pointer;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:7px 12px;font-size:12px;${ring(af==='tous','#d97706')}"><span style="color:#b45309;font-weight:800;">Total à encaisser</span> : <b>${_displayMontant(totalNonPaye)} CHF</b> <span style="color:var(--g400);">(${nNonPay})</span></div>
        <div onclick="showScreen('fact-archive')" title="Voir les factures payées dans « Facturation archivée »" style="cursor:pointer;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:7px 12px;font-size:12px;"><span style="color:#15803d;font-weight:800;">✅ Encaissé → Facturation archivée</span> : <b>${_displayMontant(totalPaye)} CHF</b> <span style="color:var(--g400);">(${nPay})</span> ↗</div>
      </div>
    </div>
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px;">
      <div style="position:relative;flex:1;max-width:420px;">
        <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);font-size:13px;color:var(--g400);pointer-events:none;">🔎</span>
        <input id="anc-search" type="text" value="${(state.ancSearch || '').replace(/"/g, '&quot;')}" oninput="ancSetSearch(this.value)" placeholder="Rechercher : n° facture, client, propriétaire, locataire…" style="width:100%;font-size:13px;padding:7px 30px 7px 30px;border:1px solid #d1d5db;border-radius:8px;box-sizing:border-box;">
        ${_ancQ ? `<span onclick="ancSetSearch('')" title="Effacer la recherche" style="position:absolute;right:9px;top:50%;transform:translateY(-50%);cursor:pointer;font-size:13px;color:var(--g400);">✕</span>` : ''}
      </div>
      ${_ancQ ? `<span style="font-size:11px;color:var(--g600);white-space:nowrap;">${displayed.length} résultat${displayed.length > 1 ? 's' : ''}</span>` : ''}
    </div>
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px;font-size:12px;flex-wrap:wrap;">
      <span style="color:var(--g600);font-weight:700;">Trier :</span>
      <button class="btn ${_ancSort==='manuel'?'btn-navy':'btn-ghost'} btn-sm" onclick="ancSetSort('manuel')" title="Ordre manuel (glisser-déposer)">⠿ Manuel</button>
      <button class="btn ${_ancSort==='num-asc'?'btn-navy':'btn-ghost'} btn-sm" onclick="ancSetSort('num-asc')" title="Numéro croissant">N° croissant ↑</button>
      <button class="btn ${_ancSort==='num-desc'?'btn-navy':'btn-ghost'} btn-sm" onclick="ancSetSort('num-desc')" title="Numéro décroissant">N° décroissant ↓</button>
    </div>
    ${!shown.length ? `<div style="font-size:13px;color:var(--g600);padding:8px 2px;">🎉 Toutes les anciennes factures sont payées et classées dans « Facturation archivée ».</div>` : ''}
    ${shown.length && !displayed.length ? `<div style="font-size:13px;color:var(--g600);padding:8px 2px;">Aucune facture dans ce filtre. <a href="#" onclick="ancSetFilter('tous');return false;" style="color:var(--navy);font-weight:700;">Tout afficher</a></div>` : ''}
    <div style="display:flex;flex-direction:column;gap:6px;">
      ${displayed.map(d => {
        const paye = d.statut === 'payee';
        const notes = String(d.notes || '');
        const bonNo = (notes.match(/Bon n°\s*([^·\n]+)/) || [])[1];
        const devNo = (notes.match(/Devis n°\s*([^·\n]+)/) || [])[1];
        const refs = [bonNo ? '📄 Bon ' + bonNo.trim() : '', devNo ? '📝 Devis ' + devNo.trim() : ''].filter(Boolean).join(' · ');
        // Rappels sauvegardés rattachés à cette facture (listés sous la facture, repliables)
        const rappels = (DB.documents || []).filter(x => _isRappelDoc(x) && (_rappelMeta(x) || {}).srcId === d.id)
          .sort((a, b) => ((_rappelMeta(a) || {}).niveau || 0) - ((_rappelMeta(b) || {}).niveau || 0));
        state.ancRappelsOpen = state.ancRappelsOpen || {};
        const rapOpen = !!state.ancRappelsOpen[d.id];
        const rappelsHtml = (rappels.length && rapOpen) ? `<div style="margin:2px 0 0 22px;display:flex;flex-direction:column;gap:4px;">
            ${rappels.map(r => { const meta = _rappelMeta(r) || {}; return `<div style="display:flex;align-items:center;gap:10px;background:#dc2626;border:1px solid #dc2626;border-radius:7px;padding:6px 11px;flex-wrap:wrap;">
              <div style="font-size:11px;font-weight:800;color:#fff;min-width:130px;">📄 ${RAPPEL_LABELS[meta.niveau] || ('RAPPEL ' + (meta.niveau || ''))}</div>
              <div style="font-size:11px;color:#ffe4e4;flex:1;min-width:90px;">📅 ${fmtDate(r.dateDoc) || '—'}</div>
              <div style="font-size:12px;font-weight:800;color:#fff;min-width:90px;text-align:right;">${_displayMontant(r.total || 0)} CHF</div>
              <button class="btn btn-sm" style="background:#fff;color:#b91c1c;font-weight:700;" onclick="editDoc('${r.id}')" title="Rouvrir / modifier ce rappel">✏️</button>
              <button class="btn btn-sm" style="background:#fff;color:#b91c1c;font-weight:700;" onclick="downloadDocPDF('${r.id}')" title="Télécharger le PDF du rappel">📥 PDF</button>
              <button class="btn btn-sm" style="background:#7f1d1d;color:#fff;font-weight:700;" onclick="ancDeleteDoc('${r.id}')" title="Supprimer ce rappel">🗑</button>
            </div>`; }).join('')}
          </div>` : '';
        return `<div id="ancrow-${d.id}" style="display:flex;flex-direction:column;gap:2px;transition:box-shadow .3s;" ondragover="ancDragOver(event)" ondrop="ancDrop(event,'${d.id}')"><div style="display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #e5e7eb;border-left:4px solid ${paye ? '#22c55e' : '#f59e0b'};border-radius:8px;padding:8px 12px;flex-wrap:wrap;">
          <div draggable="true" ondragstart="ancDragStart(event,'${d.id}')" ondragend="ancDragEnd(event)" title="Glisser pour déplacer cette facture vers le haut ou le bas" style="cursor:grab;color:#9ca3af;font-size:16px;flex-shrink:0;padding:0 2px;user-select:none;">⠿</div>
          <div style="width:130px;flex-shrink:0;">
            <div style="font-size:13px;font-weight:800;color:var(--navy);">🧾 ${d.numero || '—'}</div>
            <div style="font-size:11px;color:var(--g600);">📅 ${fmtDate(d.dateDoc) || '—'}</div>
            ${refs ? `<div style="font-size:10px;color:var(--g400);">${refs}</div>` : ''}
          </div>
          <div style="flex:0 0 320px;max-width:320px;min-width:0;">
            <div style="font-size:10px;color:var(--g400);text-transform:uppercase;font-weight:700;">🏢 Destinataire</div>
            <div style="font-size:12px;font-weight:600;color:var(--navy);">${d.clientNom || '—'}</div>
            ${d.proprietaire ? `<div style="font-size:11px;color:var(--g600);">👤 Propriétaire : ${d.proprietaire}</div>` : ''}
            ${d.locataireNom ? `<div style="font-size:11px;color:var(--g600);">🏠 Locataire : ${d.locataireNom}${d.locataireAdresse ? ' · ' + d.locataireAdresse : ''}</div>` : ''}
          </div>
          <div style="width:110px;flex-shrink:0;text-align:right;"><div style="font-size:14px;font-weight:800;color:var(--navy);">${_displayMontant(d.total || 0)} CHF</div></div>
          <div style="display:flex;gap:6px;align-items:center;flex:1;min-width:0;flex-wrap:wrap;">
            ${(() => {
              const stt = d.statut === 'payee' ? 'payee' : d.statut === 'impayee' ? 'impayee' : 'envoyee';
              const bg = stt === 'payee' ? '#dcfce7' : stt === 'impayee' ? '#fef3c7' : '#1a2744';
              const bd = stt === 'payee' ? '#22c55e' : stt === 'impayee' ? '#f59e0b' : '#1a2744';
              const cl = stt === 'payee' ? '#166534' : stt === 'impayee' ? '#92400e' : '#ffffff';
              return `<select onchange="ancSetStatut('${d.id}', this.value)" style="font-size:11px;font-weight:700;padding:5px 7px;border-radius:6px;border:1.5px solid ${bd};background:${bg};color:${cl};cursor:pointer;">
                <option value="payee" ${stt === 'payee' ? 'selected' : ''}>✅ Payée</option>
                <option value="envoyee" ${stt === 'envoyee' ? 'selected' : ''}>📨 Facture envoyée</option>
                <option value="impayee" ${stt === 'impayee' ? 'selected' : ''}>⏳ Pas payée</option>
              </select>${stt === 'envoyee' ? (() => { const ed = _ancEnvoiDate(d) || d.dateDoc; return ed ? `<span title="Date d'envoi de la facture (mise à jour quand tu re-sélectionnes « Facture envoyée »)" style="font-size:10px;font-weight:700;color:#ffffff;background:#1a2744;border-radius:10px;padding:2px 8px;">📨 envoyée le ${fmtDate(ed)}</span>` : ''; })() : ''}`;
            })()}
            ${!paye ? (() => {
              const niv = _ancRappelNiveau(d);
              const dl = _rappelDeadlineInfo(d);
              let dlChip = '';
              if (dl) {
                if (dl.daysLeft > 0) {
                  dlChip = `<span title="Échéance du délai de 10 jours (${fmtDate(dl.deadline.toISOString().slice(0,10))})" style="font-size:10px;font-weight:800;color:#422006;background:#facc15;border:1px solid #facc15;border-radius:10px;padding:2px 8px;">⏳ J-${dl.daysLeft}</span>`;
                } else {
                  const next = dl.niveau < 3 ? ` — passer au ${dl.niveau + 1}e rappel` : '';
                  dlChip = `<span title="Le délai de 10 jours est dépassé" style="font-size:10px;font-weight:800;color:#fff;background:#dc2626;border-radius:10px;padding:2px 8px;">⏱ délai dépassé${next}</span>`;
                }
              }
              return `<select onchange="if(this.value){openRappelModal('${d.id}', parseInt(this.value,10));this.value='';}" title="Préparer un rappel de paiement" style="font-size:11px;font-weight:700;padding:5px 7px;border-radius:6px;border:1.5px solid #dc2626;background:#fff;color:#b91c1c;cursor:pointer;">
                <option value="">📄 Rappel…</option>
                <option value="1">1er rappel</option>
                <option value="2">2e rappel (+60 CHF)</option>
                <option value="3">3e rappel (mise en demeure)</option>
              </select>${niv ? `<span onclick="ancToggleRappels('${d.id}')" title="Afficher / masquer les rappels enregistrés" style="font-size:10px;font-weight:800;color:#fff;background:#dc2626;border:1px solid #dc2626;border-radius:10px;padding:2px 8px;cursor:pointer;">rappel ${niv} fait ${rapOpen ? '▴' : '▾'}</span>` : ''}${dlChip}`;
            })() : ''}
            <div style="margin-left:auto;display:flex;gap:5px;align-items:center;flex-shrink:0;">
              <button class="btn btn-ghost btn-sm" onclick="ancAddClientFromDoc('${d.id}')" title="Enregistrer le destinataire dans les fiches clients">👥 + Client</button>
              ${d.locataireNom ? `<button class="btn btn-ghost btn-sm" onclick="ancAddLocataireFromDoc('${d.id}')" title="Enregistrer le locataire dans les fiches locataires">🏠 + Locataire</button>` : ''}
              <button class="btn btn-navy btn-sm" onclick="editDoc('${d.id}')" title="Modifier cette facture (pour la renvoyer)">✏️ Modifier</button>
              <button class="btn btn-ghost btn-sm" onclick="downloadDocPDF('${d.id}')" title="Télécharger le PDF">📥 PDF</button>
              <button class="btn btn-red btn-sm btn-xs" onclick="ancDeleteDoc('${d.id}')" title="Supprimer">🗑</button>
            </div>
          </div>
        </div>${rappelsHtml}</div>`;
      }).join('')}
    </div>`;
}
function ancSetSearch(v) {
  state.ancSearch = v || '';
  renderAnciennesList();
  const el = $('anc-search');
  if (el) { el.focus(); try { const n = el.value.length; el.setSelectionRange(n, n); } catch (e) {} }
}
function ancSetFilter(v) { state.ancFilter = v || 'tous'; renderAnciennesList(); }
function ancSetSort(v) { state.ancSort = v || 'manuel'; renderAnciennesList(); }
function ancToggleRappels(id) {
  state.ancRappelsOpen = state.ancRappelsOpen || {};
  state.ancRappelsOpen[id] = !state.ancRappelsOpen[id];
  renderAnciennesList();
}
// --- Glisser-déposer : réordonner les anciennes factures (haut / bas) ---
let _ancDragId = null;
function ancDragStart(e, id) {
  _ancDragId = id;
  try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); } catch (_) {}
}
function ancDragEnd() { _ancDragId = null; }
function ancDragOver(e) {
  if (!_ancDragId) return;
  e.preventDefault();
  try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
}
function ancDrop(e, targetId) {
  e.preventDefault();
  const dragId = _ancDragId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
  _ancDragId = null;
  if (!dragId || dragId === targetId) return;
  const docs = DB.documents;
  const ids = docs.filter(d => _isAncienneFacture(d) && d.statut !== 'payee')
    .sort((a, b) => (_ancOrd(a) - _ancOrd(b)) || (b.dateDoc || '').localeCompare(a.dateDoc || ''))
    .map(d => d.id);
  const from = ids.indexOf(dragId), to = ids.indexOf(targetId);
  if (from < 0 || to < 0) return;
  ids.splice(to, 0, ids.splice(from, 1)[0]);   // insère la ligne déplacée à la place de la cible
  ids.forEach((id, i) => { const d = docs.find(x => x.id === id); if (d) _setAncOrd(d, i); });
  DB.documents = docs;
  renderAnciennesList();
  toast('↕ Ordre mis à jour', '#2d9e6b');
}
function ancSetStatut(id, value) {
  const docs = DB.documents; const d = docs.find(x => x.id === id); if (!d) return;
  d.statut = value;
  // Marquée « envoyée » → on enregistre la date du jour d'envoi
  if (value === 'envoyee') _setAncEnvoiDate(d, today());
  // Facture payée → on archive aussi le devis source (et on le ressort si on dé-paie)
  if (d.type === 'facture' && d.devisId) _syncDevisArchiveWithFacture(d, value === 'payee');
  DB.documents = docs;
  renderAnciennesList();
  if (typeof renderFactArchive === 'function') renderFactArchive();
  if (typeof updateNavCounts === 'function') updateNavCounts();
  const msg = value === 'payee' ? '✅ Payée → classée dans Facturation archivée'
            : value === 'impayee' ? '⏳ Marquée pas payée'
            : '📨 Marquée envoyée le ' + (fmtDate(today()) || '');
  toast(msg, '#2d9e6b');
}
function ancDeleteDoc(id) {
  const d = (DB.documents || []).find(x => x.id === id); if (!d) return;
  if (!confirm('Supprimer définitivement la facture ' + (d.numero || '') + ' ?')) return;
  DB.documents = (DB.documents || []).filter(x => x.id !== id);
  renderAnciennesList();
  toast('Facture supprimée', '#e63946');
}
// Ouvre la fiche client pré-remplie depuis une ancienne facture (tu choisis le type et tu enregistres)
function ancAddClientFromDoc(id) {
  const d = (DB.documents || []).find(x => x.id === id); if (!d) return;
  openNewClient();   // réinitialise + ouvre la modale client
  const set = (fid, v) => { const el = $(fid); if (el) el.value = v || ''; };
  set('cl-nom', d.clientNom || '');
  set('cl-adresse', d.clientAdresse || '');
  set('cl-npa', d.clientNpa || '');
  set('cl-ville', d.clientVille || '');
  if (d.proprietaire) set('cl-contact', d.proprietaire);   // le propriétaire comme personne de contact
  toast('Vérifie le type puis « Enregistrer »', '#2563eb');
}
// Ouvre la fiche locataire pré-remplie depuis une ancienne facture
function ancAddLocataireFromDoc(id) {
  const d = (DB.documents || []).find(x => x.id === id); if (!d || !d.locataireNom) return;
  state.editingLocataireId = null;
  const set = (fid, v) => { const el = $(fid); if (el) el.value = v || ''; };
  ['loc-prenom','loc-nom','loc-tel','loc-email','loc-adresse','loc-npa','loc-ville','loc-notes'].forEach(f => set(f, ''));
  set('loc-nom', d.locataireNom);
  set('loc-adresse', d.locataireAdresse || '');
  if (typeof _refreshLocClientDropdown === 'function') _refreshLocClientDropdown('');
  const t = $('modal-locataire-title'); if (t) t.textContent = 'Nouveau locataire';
  const del = $('loc-delete-btn'); if (del) del.style.display = 'none';
  openModal('modal-locataire');
  toast('Vérifie / complète puis « Enregistrer »', '#2563eb');
}
// Cherche une facture DÉJÀ enregistrée portant le même numéro, dans TOUTES les rubriques :
// Factures courantes, Anciennes factures ET Facturation archivée (payées). Rappels exclus.
function _factureDoublons(numero, excludeId) {
  const n = _factNorm(numero);
  if (!n) return [];
  return (DB.documents || []).filter(d =>
    d && d.type === 'facture' && !_isRappelDoc(d) && d.id !== excludeId && _factNorm(d.numero) === n
  );
}
// Où se trouve cette facture (pour le message d'alerte)
function _factureRubrique(d) {
  if (_isFactureFactArchived(d)) return '📦 Facturation archivée (payée)';
  if (_isAncienneFacture(d)) return '📁 Anciennes factures';
  return '🧾 Factures';
}
// Affiche/masque le bandeau d'alerte « facture déjà enregistrée » dans le formulaire d'import
function ancCheckDoublon() {
  const box = $('anc-doublon'); if (!box) return;
  const el = $('anc-numero_facture');
  const dbl = _factureDoublons(el ? el.value : '');
  if (!dbl.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.innerHTML = `
    <div style="background:#fef2f2;border:2px solid #dc2626;border-radius:8px;padding:10px 12px;margin-bottom:12px;">
      <div style="font-size:13px;font-weight:800;color:#b91c1c;margin-bottom:4px;">⚠️ Cette facture est déjà enregistrée (${dbl.length})</div>
      ${dbl.map(d => `<div style="font-size:12px;color:#7f1d1d;">• N° <b>${d.numero || '—'}</b> · 📅 ${fmtDate(d.dateDoc) || '—'} · ${_displayMontant(d.total || 0)} CHF · ${d.clientNom || '—'} → ${_factureRubrique(d)}</div>`).join('')}
      <div style="font-size:11px;color:#991b1b;margin-top:5px;">Utilise « ⏭ Passer » pour l'ignorer, ou modifie le n° si c'est une facture différente.</div>
    </div>`;
}

function ancValider() {
  const val = id => { const el = $(id); return el ? String(el.value).trim() : ''; };
  // Garde-fou : facture déjà présente (y compris dans la facturation archivée)
  const _dbl = _factureDoublons(val('anc-numero_facture'));
  if (_dbl.length) {
    const _ou = _dbl.map(d => '• N° ' + (d.numero || '—') + ' du ' + (fmtDate(d.dateDoc) || '—') + ' — ' + _factureRubrique(d).replace(/^[^\w]+\s*/, '')).join('\n');
    if (!confirm('⚠️ La facture n° ' + val('anc-numero_facture') + ' est DÉJÀ enregistrée :\n\n' + _ou + '\n\nL\'enregistrer quand même (doublon) ?')) return;
  }
  const num = s => parseFloat(String(s).replace(/[^\d.,-]/g, '').replace(',', '.')) || 0;
  const prixHT = num(val('anc-prix_ht'));
  const rabais = num(val('anc-rabais'));
  const tvaTaux = DERATEK_CONFIG.company.tvaTaux || 8.1;
  const presta = val('anc-prestation') || 'Intervention antinuisibles';
  const lignes = [{ desc: presta, qte: 1, prix: prixHT }];
  const rabaisPct = prixHT > 0 ? (rabais / prixHT * 100) : 0;
  const t = _calcTotaux(lignes, tvaTaux, rabaisPct);
  const locNom = [val('anc-locataire_prenom'), val('anc-locataire_nom')].filter(Boolean).join(' ');
  const notesParts = [];
  if (val('anc-numero_bon')) notesParts.push('Bon n° ' + val('anc-numero_bon'));
  if (val('anc-numero_devis')) notesParts.push('Devis n° ' + val('anc-numero_devis'));
  if (val('anc-nuisible')) notesParts.push('Nuisible : ' + val('anc-nuisible'));
  notesParts.push('Importé de l\'historique Excel');
  const doc = {
    id: newId(), type: 'facture',
    numero: val('anc-numero_facture') || _nextDocNumero('facture'),
    dateDoc: val('anc-date') || today(),
    clientId: '', clientNom: val('anc-facturation_nom') || '',
    clientAdresse: val('anc-facturation_adresse') || '',
    clientNpa: val('anc-facturation_npa') || '', clientVille: val('anc-facturation_ville') || '',
    locataireNom: locNom, locataireAdresse: val('anc-locataire_adresse') || '',
    proprietaire: val('anc-proprietaire') || '', bonId: '',
    lignes: lignes, tvaTaux: tvaTaux, rabais: Math.round(rabaisPct * 100) / 100,
    statut: val('anc-statut') || 'payee',
    sousTotal: t.sousTotal, rabaisMontant: t.rabaisMontant, tvaMontant: t.tvaMontant, total: t.total,
    notes: '[ARCHIVE] ' + notesParts.join(' · '), _archive: true
  };
  const docs = DB.documents; docs.push(doc); DB.documents = docs;
  if ($('anc-create-client') && $('anc-create-client').checked && doc.clientNom) {
    const exists = (DB.clients || []).some(c => (c.nom || '').toLowerCase() === doc.clientNom.toLowerCase());
    if (!exists) {
      const cl = DB.clients;
      cl.push({ id: newId(), nom: doc.clientNom, type: val('anc-client-type') || 'Gérance', adresse: doc.clientAdresse || '', npa: doc.clientNpa || '', ville: doc.clientVille || '', contact: '', tel: '', email: '', notes: '' });
      DB.clients = cl;
      toast('Fiche client créée : ' + doc.clientNom, '#2d9e6b');
    }
  }
  toast('✓ Facture ' + (doc.numero || '') + ' enregistrée', '#2d9e6b');
  renderAnciennesList();
  state.anc.qIdx++;
  ancProcessFile();
}

function fournShowConfirm(infos, fileName) {
  const box = $('fourn-confirm'); if (!box) return;
  const champ = (label, key, val) =>
    `<div style="margin-bottom:8px;">
       <label style="display:block;font-size:11px;font-weight:700;color:var(--g600);text-transform:uppercase;margin-bottom:3px;">${label}</label>
       <input class="form-input" id="fournf-${key}" value="${(val||'').replace(/"/g,'&quot;')}" style="font-size:13px;">
     </div>`;
  box.innerHTML = `
    <div style="background:#fff;border:2px solid var(--navy);border-radius:12px;padding:18px;box-shadow:0 4px 18px rgba(13,27,62,.12);">
      <div style="font-size:15px;font-weight:800;color:var(--navy);margin-bottom:4px;">✅ Document fournisseur analysé</div>
      <div style="font-size:12px;color:var(--g600);margin-bottom:14px;">Vérifie, choisis le secteur, puis valide. Fichier : <b>${fileName||''}</b></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 14px;">
        ${champ('Fournisseur', 'fournisseur', infos.fournisseur)}
        ${champ('N° de facture', 'numero', infos.numero)}
        ${champ('Date (AAAA-MM-JJ)', 'date', infos.date)}
        ${champ('Montant HT (CHF)', 'montant_ht', infos.montant_ht)}
        ${champ('TVA (CHF)', 'tva', infos.tva)}
        ${champ('Montant TTC (CHF)', 'montant', infos.montant)}
      </div>
      <div style="margin-bottom:8px;">
        <label style="display:block;font-size:11px;font-weight:700;color:var(--g600);text-transform:uppercase;margin-bottom:3px;">Secteur</label>
        <select class="form-input" id="fournf-secteur" style="font-size:13px;">
          ${SECTEURS_FOURN.map(s => `<option value="${s}">${s}</option>`).join('')}
        </select>
      </div>
      <div style="margin-bottom:8px;">
        <label style="display:block;font-size:11px;font-weight:700;color:var(--g600);text-transform:uppercase;margin-bottom:3px;">Description</label>
        <textarea class="form-input" id="fournf-description" rows="2" style="font-size:13px;">${(infos.description||'')}</textarea>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;">
        <button class="btn btn-ghost" onclick="fournCancel()">Annuler</button>
        <button class="btn btn-navy" onclick="fournConfirmSave()">✓ Enregistrer le fournisseur</button>
      </div>
    </div>`;
  box.style.display = 'block';
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function fournCancel() {
  const box = $('fourn-confirm'); if (box) { box.style.display = 'none'; box.innerHTML = ''; }
  const fi = $('fourn-file-input'); if (fi) fi.value = '';
  _pendingFournPdf = null;
}

async function _uploadFournPdf(fId, file) {
  if (!sb || !file) return '';
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return '';
    const path = `${session.user.id}/${fId}-${file.name.replace(/[^\w.-]+/g, '_')}`;
    const { error } = await sb.storage.from('fournisseurs-pdfs').upload(path, file, { contentType: 'application/pdf', upsert: true });
    if (error) { console.warn('Upload fourn pdf', error); toast('PDF non uploadé : ' + error.message, '#e63946'); return ''; }
    return path;
  } catch (e) { console.warn(e); return ''; }
}

async function fournConfirmSave() {
  const v = id => { const el = $('fournf-' + id); return el ? el.value.trim() : ''; };
  const fId = newId();
  let pdfPath = '';
  if (_pendingFournPdf) { toast('Upload du PDF…', '#1a2744'); pdfPath = await _uploadFournPdf(fId, _pendingFournPdf); }
  const fourn = {
    id: fId,
    nom: v('fournisseur'),
    numero: v('numero'),
    dateDoc: v('date'),
    montantHt: parseFloat(v('montant_ht')) || 0,
    tva: parseFloat(v('tva')) || 0,
    montant: parseFloat(v('montant')) || 0,
    secteur: v('secteur') || 'Autre',
    description: v('description'),
    pdfPath: pdfPath
  };
  if (!fourn.nom && !fourn.numero) { toast('Rien à enregistrer (fournisseur vide)', '#e63946'); return; }
  const list = DB.fournisseurs;
  list.push(fourn);
  DB.fournisseurs = list;
  toast('✓ Fournisseur enregistré' + (pdfPath ? ' + PDF' : ''), '#2d9e6b');
  _pendingFournPdf = null;
  fournCancel();
  renderFournisseurs();
}

async function viewFournPdf(id) {
  const f = (DB.fournisseurs || []).find(x => x.id === id);
  if (!f || !f.pdfPath) { toast('Aucun PDF associé', '#e63946'); return; }
  try {
    const { data, error } = await sb.storage.from('fournisseurs-pdfs').createSignedUrl(f.pdfPath, 3600);
    if (error || !data) { toast('Erreur lien PDF', '#e63946'); return; }
    window.open(data.signedUrl, '_blank');
  } catch (e) { toast('Erreur : ' + e.message, '#e63946'); }
}

function confirmDeleteFourn(id, label) {
  $('confirm-msg').textContent = `Supprimer le fournisseur "${label}" ?`;
  $('confirm-btn').onclick = async () => {
    const f = (DB.fournisseurs || []).find(x => x.id === id);
    const pdfPath = f ? f.pdfPath : '';
    DB.fournisseurs = DB.fournisseurs.filter(x => x.id !== id);
    closeModal('modal-confirm');
    renderFournisseurs();
    toast('Fournisseur supprimé', '#e63946');
    if (pdfPath) { try { await sb.storage.from('fournisseurs-pdfs').remove([pdfPath]); } catch (e) {} }
  };
  openModal('modal-confirm');
}

function renderFournisseurs() {
  updateNavCounts();
  const list = $('fournisseurs-list');
  const count = $('fournisseurs-count');
  const q = (($('fourn-search') || {}).value || '').toLowerCase();
  let items = (DB.fournisseurs || []).slice();
  if (q) items = items.filter(f => ((f.nom||'')+' '+(f.numero||'')+' '+(f.description||'')+' '+(f.secteur||'')).toLowerCase().includes(q));
  if (count) count.textContent = items.length ? items.length + ' facture(s) fournisseur' : '';
  if (!list) return;
  if (!items.length) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">📦</div><div class="empty-text">Aucune facture fournisseur.<br>Glisse un PDF ci-dessus pour commencer.</div></div>';
    return;
  }
  const groups = {};
  items.forEach(f => { const k = f.secteur || 'Autre'; (groups[k] = groups[k] || []).push(f); });
  list.innerHTML = Object.keys(groups).sort().map(sec => {
    const arr = groups[sec].sort((a, b) => (b.dateDoc||'').localeCompare(a.dateDoc||''));
    const col = SECTEUR_COLORS[sec] || '#64748b';
    const totalSec = arr.reduce((s, f) => s + (parseFloat(f.montant)||0), 0);
    return `
      <div style="margin-top:14px;">
        <div style="font-size:13px;font-weight:800;color:${col};text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px;border-bottom:2px solid ${col};padding-bottom:4px;">
          📦 ${sec} <span style="font-weight:500;color:var(--g600);">(${arr.length} · ${_displayMontant(totalSec)} CHF)</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${arr.map(f => `
            <div style="display:flex;align-items:center;gap:14px;background:#fff;border:1px solid #e5e7eb;border-left:4px solid ${col};border-radius:8px;padding:10px 14px;flex-wrap:wrap;">
              <div style="min-width:150px;">
                <div style="font-size:13px;font-weight:800;color:var(--navy);">${f.nom||'—'}</div>
                <div style="font-size:11px;color:var(--g600);">📅 ${fmtDate(f.dateDoc)||'—'}${f.numero?' · N° '+f.numero:''}</div>
              </div>
              <div style="flex:2;min-width:160px;font-size:12px;color:var(--g600);">${f.description||''}</div>
              <div style="min-width:140px;text-align:right;">
                ${(f.montantHt||f.tva) ? `<div style="font-size:11px;color:var(--g600);">HT ${_displayMontant(f.montantHt||0)} · TVA ${_displayMontant(f.tva||0)}</div>` : ''}
                <div style="font-size:14px;font-weight:800;color:var(--navy);">${_displayMontant(f.montant||0)} CHF <span style="font-size:9px;color:var(--g400);">TTC</span></div>
              </div>
              <div style="display:flex;gap:5px;align-items:center;flex-shrink:0;">
                ${f.pdfPath ? `<button class="btn btn-ghost btn-sm" onclick="viewFournPdf('${f.id}')" title="Voir le PDF">📎 PDF</button>` : ''}
                <button class="btn btn-red btn-sm btn-xs" onclick="confirmDeleteFourn('${f.id}','${(f.nom||'').replace(/'/g,"\\'")}')" title="Supprimer">🗑</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>`;
  }).join('');
}
