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
        console.warn(table, 'upsert', lastErr);
        if (typeof toast === 'function') toast('Erreur de sauvegarde Supabase : ' + lastErr.message, '#e63946');
      }
    }
    this._lastSync[table] = JSON.parse(JSON.stringify(newArr));
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
  agendaView:       'semaine',
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
const genId = () => `R-${new Date().getFullYear()}-${String(DB.rapports.length + 420).padStart(4,'0')}`;
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

function openModal(id)  { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }

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
function renderDashboard() {
  if (typeof updateBonsCounts === 'function') updateBonsCounts();
  const now = new Date();
  const days = ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];
  const months = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
  const dd = $('dash-date');
  if (dd) dd.textContent = `${days[now.getDay()]} ${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;

  const rapports = DB.rapports, clients = DB.clients;
  const brouillon = rapports.filter(r => r.statut === 'Brouillon').length;
  const bons = DB.bons || [];
  const docs = DB.documents || [];

  // --- Bornes de la semaine en cours (lundi → dimanche) ---
  const _monday = (() => { const d = new Date(now); const wd = (d.getDay() + 6) % 7; d.setHours(0,0,0,0); d.setDate(d.getDate() - wd); return d; })();
  const _sunday = (() => { const d = new Date(_monday); d.setDate(d.getDate() + 6); d.setHours(23,59,59,999); return d; })();
  const _ymd = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

  // --- Compteurs documents ---
  const facturesPayees   = docs.filter(d => d.type === 'facture' && d.statut === 'payee');
  const facturesNonPayees= docs.filter(d => d.type === 'facture' && d.statut !== 'payee');
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
    DB.clients.map(c => `<option value="${c.id}"${c.id === selectedId ? ' selected' : ''}>${c.nom}</option>`).join('');
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
    const nb = rapports.filter(r => r.clientId === c.id).length;
    // CA = anciens rapports "Envoyé" + factures PAYÉES liées au client (par id ou par nom)
    const caRapports = rapports.filter(r => r.clientId === c.id && r.statut === 'Envoyé').reduce((a,r) => a + (parseFloat(r.montant)||0), 0);
    const caFactures = (DB.documents || []).filter(d =>
        d.type === 'facture' && d.statut === 'payee' &&
        ((d.clientId && d.clientId === c.id) || (!d.clientId && _normNom(d.clientNom) === _normNom(c.nom)))
      ).reduce((a,d) => a + (parseFloat(d.total)||0), 0);
    const totalCA = caRapports + caFactures;
    const typeColor = colorForClient(c);
    const adresseFmt = [c.adresse, [c.npa, c.ville].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    return `
    <div style="display:flex;align-items:stretch;gap:14px;background:#fff;border:1px solid #e5e7eb;border-left:4px solid ${typeColor};border-radius:8px;padding:10px 14px;margin-bottom:6px;box-shadow:0 1px 2px rgba(0,0,0,.04);flex-wrap:wrap;">
      <div style="display:flex;align-items:center;gap:10px;min-width:200px;flex:1.5;">
        <div style="width:34px;height:34px;border-radius:50%;background:${typeColor};color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">${initials(c.nom)}</div>
        <div>
          <div style="font-size:13px;font-weight:800;color:var(--navy);line-height:1.2;">${c.nom}</div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:2px;">
            <span class="badge b-gray" style="background:${typeColor}22;color:${typeColor};">${c.type}</span>
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
      ${(() => { const m = _clientMeta(c); return (m.nuisible || m.dates.length) ? `
      <div style="flex:1.1;min-width:150px;">
        <div style="font-size:10px;color:var(--g400);text-transform:uppercase;font-weight:700;letter-spacing:.3px;">🐛 Nuisible / interv.</div>
        ${m.nuisible ? `<div style="font-size:12px;font-weight:600;color:var(--navy);">${m.nuisible}</div>` : ''}
        ${m.dates.length ? `<div style="font-size:11px;color:var(--g600);">📅 ${m.dates.map(d => fmtDate(d)).join(', ')}</div>` : ''}
      </div>` : ''; })()}
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
        <button class="btn btn-ghost btn-sm" onclick="openNewRapportForClient('${c.id}')" title="Nouveau rapport">+ Rapport</button>
        ${CLIENT_TYPES_DOC.includes(c.type) ? `
        <button class="btn btn-sm" onclick="createDevisFromClient('${c.id}')" title="Créer un devis pour ce client" style="font-weight:700;border:1.5px solid #8b5cf6;background:#f5f3ff;color:#6d28d9;">📝 Devis</button>
        <button class="btn btn-sm" onclick="createFactureFromClient('${c.id}')" title="Créer une facture pour ce client" style="font-weight:700;border:1.5px solid #2d9e6b;background:#ecfdf5;color:#166534;">🧾 Facture</button>` : ''}
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
  // Gérances triées par ordre alphabétique
  const noms = Object.keys(groupes).sort((a, b) => a.localeCompare(b, 'fr'));

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

  tb.innerHTML = noms.map(nom => {
    // Rapports de la gérance, du plus récent au plus ancien
    const rapps = groupes[nom].slice().reverse();
    const nb = rapps.length;
    const techs = [...new Set(rapps.map(r => r.tech).filter(Boolean))];
    const techTxt = techs.length ? `<span class="rapport-groupe-tech">👷 ${techs.join(', ')}</span>` : '';
    const entete = `
      <tr class="rapport-groupe">
        <td colspan="9">🏢 ${nom} <span class="rapport-groupe-nb">${nb} rapport${nb > 1 ? 's' : ''}</span>${techTxt}</td>
      </tr>`;
    return entete + rapps.map(ligneRapport).join('');
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
  sel.innerHTML = DB.techs.map(t => `<option value="${t}"${t === selected ? ' selected' : ''}>${t}</option>`).join('');
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
    // NB : on ne remplit PAS l'adresse d'intervention avec l'adresse de la gérance
    // (ce champ correspond au lieu d'intervention = locataire / immeuble).
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
      .map(c => `<option value="${c.id}"${c.id === selectedId ? ' selected' : ''}>${c.nom}</option>`));
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
    emailjs.send(DERATEK_CONFIG.emailjs.serviceId, DERATEK_CONFIG.emailjs.templateId, params)
      .then(() => {
        toast('Rapport envoyé à ' + DERATEK_CONFIG.email.deratek + ' ✓', '#2d9e6b');
        const clientEmail = r.email;
        if (clientEmail && clientEmail !== DERATEK_CONFIG.email.deratek) {
          const p2 = { ...params, email: clientEmail };
          emailjs.send(DERATEK_CONFIG.emailjs.serviceId, DERATEK_CONFIG.emailjs.templateId, p2)
            .then(() => toast('Email envoyé au client ✓', '#2d9e6b'))
            .catch(() => toast('Envoi client échoué', '#f4a623'));
        }
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
  st('pdf-description', desc.substring(0,100) + (desc.length > 100 ? '…' : ''));
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
function renderTechList() {
  const el = $('tech-list'); if (!el) return;
  const techs = DB.techs;
  el.innerHTML = techs.length ? techs.map((t,i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--g50);border-radius:7px;margin-bottom:6px;">
      <div class="av av-sm" style="background:var(--navy);">${initials(t)}</div>
      <span style="flex:1;font-size:13px;font-weight:500;">${t}</span>
      <button class="btn btn-ghost btn-xs" data-idx="${i}" onclick="deleteTech(this)">🗑</button>
    </div>`).join('')
  : '<div style="color:var(--g400);font-size:12px;">Aucun technicien.</div>';
}
function openTechModal() { renderTechList(); openModal('modal-tech'); }
function addTech() {
  const inp = $('tech-new-name'); const name = inp.value.trim();
  if (!name) { toast('Saisissez un nom', '#e63946'); return; }
  const list = DB.techs;
  if (list.includes(name)) { toast('Existe déjà', '#f4a623'); return; }
  list.push(name); DB.techs = list; inp.value = '';
  renderTechList();
  populateTechSelect($('r-tech'), $('r-tech').value);
  toast('Technicien ajouté ✓', '#2d9e6b');
}
function deleteTech(el) {
  const list = DB.techs; list.splice(parseInt(el.dataset.idx), 1); DB.techs = list;
  renderTechList();
  populateTechSelect($('r-tech'), $('r-tech').value);
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

// Traite le PDF : extraction texte -> IA -> récap
async function bonProcessFile(file) {
  const status = $('bon-status');
  const confirm = $('bon-confirm');
  if (confirm) { confirm.style.display = 'none'; confirm.innerHTML = ''; }
  if (file.type !== 'application/pdf') { toast('Merci de déposer un fichier PDF', '#e63946'); return; }

  // Mémorise le fichier pour l'upload à la validation
  _pendingBonPdf = file;

  const setStatus = (msg) => { if (status) { status.style.display = 'block'; status.innerHTML = msg; } };
  try {
    setStatus('⏳ Lecture du PDF en cours…');
    const texte = await bonExtractText(file);
    if (!texte || texte.length < 20) {
      setStatus('');
      toast('Ce PDF ne contient pas de texte lisible (PDF scanné ?).', '#e63946');
      return;
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
    garantieNote: '', showSigClient: true, sigLocataire: '',
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
    '"numero_bon": "numéro du bon de travaux",\n' +
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
function bonShowConfirm(infos, fileName) {
  const box = $('bon-confirm');
  if (!box) return;
  const champ = (label, key, val) =>
    `<div style="margin-bottom:8px;">
       <label style="display:block;font-size:11px;font-weight:700;color:var(--g600);text-transform:uppercase;margin-bottom:3px;">${label}</label>
       <input class="form-input" id="bonf-${key}" value="${(val||'').replace(/"/g,'&quot;')}" style="font-size:13px;">
     </div>`;

  box.innerHTML = `
    <div style="background:#fff;border:2px solid var(--navy);border-radius:12px;padding:18px;box-shadow:0 4px 18px rgba(13,27,62,.12);">
      <div style="font-size:15px;font-weight:800;color:var(--navy);margin-bottom:4px;">✅ Voici ce que l'IA a trouvé</div>
      <div style="font-size:12px;color:var(--g600);margin-bottom:14px;">Vérifiez et corrigez si besoin, puis validez. Fichier : <b>${fileName||''}</b></div>

      <div style="font-size:12px;font-weight:800;color:var(--red);text-transform:uppercase;letter-spacing:.5px;margin:6px 0 8px;">🏢 Gérance &amp; gérant (→ Clients)</div>
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

function bonCancel() {
  const box = $('bon-confirm');
  if (box) { box.style.display = 'none'; box.innerHTML = ''; }
  const fi = $('bon-file-input'); if (fi) fi.value = '';
  _pendingBonPdf = null;
}

// Récupère la valeur d'un input du récap (ou chaîne vide)
function _bonVal(key) { const el = $('bonf-' + key); return el ? el.value.trim() : ''; }

// Trouve une gérance existante par nom (insensible à la casse) ou en crée une nouvelle
function _findOrCreateGerance(infos) {
  const nom = (infos.gerance_nom || '').trim();
  if (!nom) return null;
  const clients = DB.clients;
  const existing = clients.find(c => (c.nom || '').toLowerCase() === nom.toLowerCase());
  if (existing) {
    const updates = {};
    // On NE remplace JAMAIS le contact existant de la gérance : on complète seulement
    // les champs vides. Le nom du gérant écrit sur le bon reste porté par le BON lui-même.
    if (!existing.contact && infos.gerant_nom)      updates.contact = infos.gerant_nom;
    if (!existing.tel     && infos.gerant_tel)      updates.tel     = infos.gerant_tel;
    if (!existing.email   && infos.gerant_email)    updates.email   = infos.gerant_email;
    if (!existing.adresse && infos.gerance_adresse) updates.adresse = infos.gerance_adresse;
    if (!existing.npa     && infos.gerance_npa)     updates.npa     = infos.gerance_npa;
    if (!existing.ville   && infos.gerance_ville)   updates.ville   = infos.gerance_ville;
    if (Object.keys(updates).length) {
      Object.assign(existing, updates);
      DB.clients = clients;
    }
    return existing;
  }
  const newClient = {
    id: newId(),
    nom: nom,
    type: 'Gérance',
    contact: infos.gerant_nom || '',
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
            <div style="display:flex;align-items:stretch;gap:14px;background:#fff;border:1px solid #e5e7eb;border-left:4px solid ${gColorL};border-radius:8px;padding:10px 14px;box-shadow:0 1px 2px rgba(0,0,0,.04);flex-wrap:wrap;">
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
  const nFact  = docs.filter(d => d.type === 'facture' && !_docIsArchive(d) && !_isFactureFactArchived(d)).length;
  const nRapports = (DB.rapports || []).filter(r => !_isRapportFactArchived(r)).length;
  const nFactArchive = _factArchiveSets().length;
  const set = (id, n) => { const el = $(id); if (el) el.textContent = n; };
  set('nb-bons-count', nA);
  set('nb-bons-encours-count', nE);
  set('nb-bons-termines-count', nT);
  set('nb-devis-count', nDevis);
  set('nb-factures-count', nFact);
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
  const gColor = customColor || colorForGeranceName(g);
  // Un bon URGENT est TOUJOURS en rouge plein, quel que soit l'onglet (priorité visuelle absolue).
  const _urgent = (b.statut === 'urgent');
  const baseColor = _urgent ? '#dc2626' : gColor;
  const fillSolid = _urgent ? true : (solid === true);   // fond plein (onglet « Bons » ou urgent) ou clair (en cours, terminés…)
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
    'urgent':        { bg: '#fee2e2', color: '#b91c1c', border: '#ef4444' }, // rouge
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
  const _lum = (h => { const m = String(h||'').replace('#','').match(/^([0-9a-f]{6})$/i); if(!m) return 1; const n=parseInt(m[1],16); return 0.2126*((n>>16&255)/255)+0.7152*((n>>8&255)/255)+0.0722*((n&255)/255); })(baseColor);
  const _dark = _lum < 0.62;
  const bg         = fillSolid ? baseColor : _hexTint(baseColor, 0.12);
  const borderCard = fillSolid ? 'rgba(0,0,0,.12)' : _hexTint(baseColor, 0.30);
  const borderLeft = fillSolid ? (_dark ? 'rgba(255,255,255,.55)' : 'rgba(0,0,0,.28)') : baseColor;
  const T  = fillSolid ? (_dark ? '#ffffff' : '#0d1b3e') : '#0d1b3e';
  const TL = fillSolid ? (_dark ? 'rgba(255,255,255,.72)' : '#475569') : '#64748b';
  const T2 = fillSolid ? (_dark ? 'rgba(255,255,255,.9)' : '#334155') : '#475569';
  const dateCol  = fillSolid ? (_dark ? '#ffdada' : '#b91c1c') : '#e63946';
  const iconBg   = fillSolid ? (_dark ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.08)') : baseColor;
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
                    return `<span title="En statut « ${lbl} » depuis plus de 48 h" style="font-size:11px;font-weight:800;color:#fff;background:#dc2626;border-radius:6px;padding:4px 9px;">⚠️ ${lbl} · +48 h</span>`;
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
                ${b.pdfPath ? `<button class="btn btn-ghost btn-sm" onclick="viewBonPdf('${b.id}')" onmouseenter="bonPdfPreview('${b.id}', this)" onmouseleave="bonPdfPreviewHide()" title="Survol = aperçu · Clic = ouvrir dans un nouvel onglet">📎 PDF</button>` : ''}
                ${(() => {
                  const hasNote = _bonNoteHasData(_bonNoteData(b));
                  return `<button class="btn btn-sm" onclick="openBonNote('${b.id}')" title="${hasNote ? 'Note interne (statut, prix, traitement…) — cliquer pour modifier' : 'Ajouter une note interne (statut, calcul de prix, remarques…) pour la facturation'}" style="font-weight:700;border:1.5px solid ${hasNote ? '#d97706' : '#d1d5db'};background:${hasNote ? '#fffbeb' : '#fff'};color:${hasNote ? '#b45309' : '#6b7280'};">📝 Note${hasNote ? ' •' : ''}</button>`;
                })()}
                ${(() => {
                  const fait = _bonRapFait(b);
                  const rapStyle = fait ? 'border:1.5px solid #16a34a;background:#16a34a;color:#fff;' : '';
                  return `<button class="btn ${fait ? 'btn-sm' : 'btn-ghost btn-sm'}" onclick="createRapportFromBon('${b.id}')" title="Créer un rapport d'intervention depuis ce bon" style="font-weight:700;${rapStyle}">📋 Rapport</button>
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
    count.textContent = bons.length ? bons.length + ' ' + lbl : '';
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
        <div style="font-size:13px;font-weight:800;color:${gColor};text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px;border-bottom:2px solid ${gColor};padding-bottom:4px;">🏢 ${g} <span style="font-weight:500;color:var(--g600);">(${items.length})</span></div>
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
  { id: 'la', label: 'Lausanne', rue: 'Ch. des Pyramides 7', npa: '1007', ville: 'Lausanne', tel: '021 552 66 72' }
];
function _docBureau(d) {
  return BUREAUX.find(b => b.id === ((d && d.bureauId) || 'ne')) || BUREAUX[0];
}
// Une facture importée d'historique est marquée par [ARCHIVE] dans ses notes
// (persisté dans Supabase via une colonne texte existante, sans nouvelle colonne).
function _docIsArchive(d) {
  return !!(d && (d._archive || /\[ARCHIVE\]/.test(String(d.notes || ''))));
}
function _docNotesClean(d) {
  return String((d && d.notes) || '').replace(/\s*\[ARCHIVE\]\s*/g, ' ').trim();
}

// ============================================================
// FACTURATION ARCHIVÉE : quand une facture est PAYÉE et liée à un bon,
// le trio (bon + rapport + facture) devient un dossier clos. Calculé
// dynamiquement (aucun marqueur) : si on dé-paie la facture, tout revient.
// ============================================================
function _factNorm(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }
// Une facture (non importée Excel) payée et rattachée à un bon
function _isFactureFactArchived(d) {
  return !!(d && d.type === 'facture' && (d.statut || '') === 'payee' && d.bonId && !_docIsArchive(d));
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
    sets.push({ facture: d, bon, rapport, manual: false });
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
  box.innerHTML = sets.map(s => {
    const f = s.facture, b = s.bon, r = s.rapport;
    const isPaid = !!(f && f.statut === 'payee');
    const clientNom = (f && f.clientNom) || (r && r.clientNom) || (b && b.geranceNom) || '—';
    const locNom = (f && f.locataireNom) || (r && _rapLoc(r).nom) || '';
    const montant = (f && f.total) ? _displayMontant(f.total) + ' CHF · ✅ Payée' : (r && r.montant ? r.montant + ' CHF' : '') ;
    const statutTxt = isPaid
      ? `<span style="color:#15803d;">${_displayMontant(f.total || 0)} CHF · ✅ Payée</span>`
      : `<span style="color:#b45309;">📦 Archivé · ⏳ facture à venir${(f ? ' (brouillon)' : '')}</span>`;
    const dateTxt = (f && f.dateDoc) || (r && r.date) || '';
    return `
    <div style="background:#fff;border:1px solid #e5e7eb;border-left:4px solid ${isPaid ? '#0f766e' : '#f59e0b'};border-radius:10px;padding:12px 14px;margin-bottom:8px;box-shadow:0 1px 2px rgba(0,0,0,.04);">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        <div style="font-size:13px;font-weight:800;color:var(--navy);min-width:150px;">${clientNom}</div>
        <div style="flex:1;font-size:12px;color:var(--g600);">${locNom ? ('🏠 ' + locNom) : ''}</div>
        <div style="font-size:13px;font-weight:800;">${statutTxt}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px;">
        ${b ? pill('📄', 'Bon ' + (b.numero || ''), '#2563eb') : pill('📄', 'Bon — (aucun)', '#9ca3af')}
        ${r ? pill('📋', 'Rapport ' + (r.id || ''), '#7c3aed') : pill('📋', 'Rapport — (aucun)', '#9ca3af')}
        ${f ? pill('🧾', 'Facture ' + (f.numero || ''), '#0f766e') : pill('🧾', 'Facture — à faire', '#9ca3af')}
        <span style="font-size:11px;color:var(--g400);">📅 ${fmtDate(dateTxt) || '—'}</span>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:10px;border-top:1px dashed #eee;padding-top:10px;">
        ${b && b.pdfPath ? `<button class="btn btn-ghost btn-sm" onclick="viewBonPdf('${b.id}')" onmouseenter="bonPdfPreview('${b.id}', this)" onmouseleave="bonPdfPreviewHide()" title="Survol = aperçu · Clic = ouvrir">📎 PDF du bon</button>` : ''}
        ${r ? `<button class="btn btn-ghost btn-sm" onclick="editRapport('${r.id}')" onmouseenter="rapPdfPreview('${r.id}', this)" onmouseleave="bonPdfPreviewHide()" title="Survol = aperçu du rapport · Clic = ouvrir">📋 Voir le rapport</button>` : ''}
        ${f ? `<button class="btn btn-ghost btn-sm" onclick="editDoc('${f.id}')">✏️ Voir la facture</button>
        <button class="btn btn-ghost btn-sm" onclick="downloadDocPDF('${f.id}')" onmouseenter="factPdfPreview('${f.id}', this)" onmouseleave="bonPdfPreviewHide()" title="Survol = aperçu · Clic = télécharger">📥 PDF facture</button>`
        : (b ? `<button class="btn btn-navy btn-sm" onclick="createFactureFromBon('${b.id}')" title="Créer la facture pour ce dossier">🧾 Créer la facture</button>` : '')}
        <button class="btn btn-ghost btn-sm" onclick="${isPaid ? `unarchiveFact('${f.id}')` : (r ? `unarchiveRapport('${r.id}')` : '')}" title="Ressortir ce dossier de l'archive">↩︎ Désarchiver</button>
      </div>
    </div>`;
  }).join('');
}
// Désarchive : remet la facture en « Envoyée » (non payée) → le trio ressort des archives
function unarchiveFact(id) {
  const docs = DB.documents; const d = docs.find(x => x.id === id); if (!d) return;
  d.statut = 'envoyee'; DB.documents = docs;
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
  const lines = [];
  lines.push('SPC');                 // QRType
  lines.push('0200');                // Version
  lines.push('1');                   // Coding UTF-8
  lines.push(_cleanIban(co.iban));   // IBAN
  // Créancier (structuré)
  lines.push('S', co.nom || '', cRue || '', '', cNpa || '', cVille || '', (co.pays || 'CH').toUpperCase());
  // Ultimate creditor (vide)
  lines.push('', '', '', '', '', '', '');
  // Montant + devise
  lines.push(_fmtMontant(montant));
  lines.push(co.devise || 'CHF');
  // Débiteur (le client payeur) — type structuré si présent
  if (debtor && (debtor.nom || '').trim()) {
    lines.push('S', debtor.nom || '', debtor.rue || '', '', debtor.npa || '', debtor.ville || '', 'CH');
  } else {
    lines.push('', '', '', '', '', '', '');
  }
  // Référence
  lines.push('NON');                 // pas de référence structurée
  lines.push('');
  // Message libre (n° de facture)
  lines.push(message || '');
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
  // Les factures démarrent à 101 (donc 1ère facture = F-AAAA-101).
  const base = (type === 'facture') ? 100 : 0;
  const docs = (DB.documents || []).filter(d => d.type === type && (d.numero || '').includes('-' + year + '-'));
  let max = base;
  docs.forEach(d => {
    const m = (d.numero || '').match(/-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return `${prefix}-${year}-${String(max + 1).padStart(3, '0')}`;
}

// --- Calcul des totaux à partir des lignes (avec rabais avant TVA) ---
function _calcTotaux(lignes, tvaTaux, rabaisTaux) {
  const r2 = n => Math.round(n * 100) / 100;
  const sousTotal = (lignes || []).reduce((s, l) => s + (parseFloat(l.qte) || 0) * (parseFloat(l.prix) || 0), 0);
  const rabaisMontant = sousTotal * ((parseFloat(rabaisTaux) || 0) / 100);
  const net = sousTotal - rabaisMontant;
  const tva = net * ((parseFloat(tvaTaux) || 0) / 100);
  return {
    sousTotal: r2(sousTotal),
    rabaisMontant: r2(rabaisMontant),
    net: r2(net),
    tvaMontant: r2(tva),
    total: r2(net + tva)
  };
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
  _editingDoc = JSON.parse(JSON.stringify(d));
  if (!_editingDoc.lignes || !_editingDoc.lignes.length) _editingDoc.lignes = [{ desc: '', qte: 1, prix: 0 }];
  if (_editingDoc.rabais === undefined || _editingDoc.rabais === null) _editingDoc.rabais = 0;
  // Réparation : on prend comme cible le sous-total recalculé depuis le TOTAL TTC stocké
  // (plus fiable que le sous-total HT que l'IA peut avoir mal extrait)
  const sommeLignes = _editingDoc.lignes.reduce((s, l) => s + (parseFloat(l.qte)||0) * (parseFloat(l.prix)||0), 0);
  const totalStocke = parseFloat(_editingDoc.total) || 0;
  const sousTotalStocke = parseFloat(_editingDoc.sousTotal) || 0;
  const rabaisTaux = parseFloat(_editingDoc.rabais) || 0;
  const tvaTauxDoc = parseFloat(_editingDoc.tvaTaux) || 8.1;
  let cibleSousTotal = sousTotalStocke;
  if (totalStocke > 0) {
    const facteur = (1 - rabaisTaux/100) * (1 + tvaTauxDoc/100);
    const sousTotalDepuisTtc = totalStocke / facteur;
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
  const t = _calcTotaux(d.lignes, d.tvaTaux, d.rabais);
  const titre = (d.type === 'facture' ? 'Facture ' : 'Devis ') + (d.numero || '');
  const prestaOpts = _docPrestaOptions([d.nuisible, d.nuisible2]);
  const lignesHtml = d.lignes.map((l, i) => `
    <tr>
      <td style="padding:3px;">
        <select onchange="onLignePresta(${i}, this.value)" style="font-size:11px;width:100%;margin-bottom:3px;border-radius:4px;border:1px solid #ddd;padding:3px;color:var(--g600);">
          <option value="">＋ Choisir une prestation modèle…</option>
          ${prestaOpts}
        </select>
        <input class="form-input" style="font-size:12px;" value="${(l.desc||'').replace(/"/g,'&quot;')}" oninput="updateDocLigne(${i},'desc',this.value)" placeholder="Description libre">
      </td>
      <td style="padding:3px;width:70px;vertical-align:top;"><input class="form-input" type="number" step="0.01" style="font-size:12px;text-align:right;" value="${l.qte||0}" oninput="updateDocLigne(${i},'qte',this.value)"></td>
      <td style="padding:3px;width:100px;vertical-align:top;"><input class="form-input" type="number" step="0.01" style="font-size:12px;text-align:right;" value="${l.prix||0}" oninput="updateDocLigne(${i},'prix',this.value)"></td>
      <td id="lt-${i}" style="padding:3px;width:100px;text-align:right;font-size:12px;font-weight:600;vertical-align:top;">${_displayMontant((parseFloat(l.qte)||0)*(parseFloat(l.prix)||0))}</td>
      <td style="padding:3px;width:54px;text-align:center;vertical-align:top;">
        <button class="btn btn-ghost btn-xs" onclick="addPrestaModel(${i})" title="Enregistrer cette description comme modèle">💾</button>
        <button class="btn btn-red btn-xs" onclick="removeDocLigne(${i})" title="Supprimer la ligne">✕</button>
      </td>
    </tr>
  `).join('');
  const box = $('modal-doc-body');
  if (!box) return;
  const noteHtml = (d._bonNote && d._bonNote.trim())
    ? `<div style="background:#fffbeb;border:1.5px solid #f59e0b;border-radius:8px;padding:10px 12px;margin-bottom:12px;">
         <div style="font-size:11px;font-weight:800;color:#b45309;text-transform:uppercase;letter-spacing:.3px;margin-bottom:4px;">📝 Note interne du bon (pour la facturation)</div>
         <div style="font-size:13px;color:#7c2d12;white-space:pre-wrap;">${(d._bonNote).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
       </div>`
    : '';
  box.innerHTML = `
    ${noteHtml}
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
          ${(DB.clients||[]).slice().sort((a,b)=>(a.nom||'').localeCompare(b.nom||'')).map(c=>`<option value="${c.id}" ${d.clientId===c.id?'selected':''}>${(c.nom||'').replace(/</g,'&lt;')}${c.type?' ('+c.type+')':''}</option>`).join('')}
        </select>
        <input class="form-input" style="margin-top:5px;font-size:12px;" placeholder="ou saisir un nom manuellement" value="${(d.clientNom||'').replace(/"/g,'&quot;')}" oninput="_editingDoc.clientNom=this.value;_editingDoc.clientId='';">
      </div>
      <div class="form-group"><label class="form-label">Locataire concerné</label><input class="form-input" id="doc-loc" value="${(d.locataireNom||'').replace(/"/g,'&quot;')}" oninput="_editingDoc.locataireNom=this.value"></div>
      <div class="form-group"><label class="form-label">Propriétaire (destinataire)</label><input class="form-input" value="${(d.proprietaire||'').replace(/"/g,'&quot;')}" oninput="_editingDoc.proprietaire=this.value" placeholder="Ex. Monsieur Aldo Brauen"></div>
      <div class="form-group" style="grid-column:1 / -1;"><label class="form-label">Adresse du locataire</label><input class="form-input" value="${(d.locataireAdresse||'').replace(/"/g,'&quot;')}" oninput="_editingDoc.locataireAdresse=this.value" placeholder="Rue, étage, NPA ville"></div>
      <div class="form-group"><label class="form-label">Adresse client</label><input class="form-input" value="${(d.clientAdresse||'').replace(/"/g,'&quot;')}" oninput="_editingDoc.clientAdresse=this.value"></div>
      <div style="display:grid;grid-template-columns:1fr 2fr;gap:8px;">
        <div class="form-group"><label class="form-label">NPA</label><input class="form-input" value="${(d.clientNpa||'').replace(/"/g,'&quot;')}" oninput="_editingDoc.clientNpa=this.value"></div>
        <div class="form-group"><label class="form-label">Ville</label><input class="form-input" value="${(d.clientVille||'').replace(/"/g,'&quot;')}" oninput="_editingDoc.clientVille=this.value"></div>
      </div>
      <div class="form-group"><label class="form-label">N° de bon (remplissage auto)</label><input class="form-input" id="doc-bon-numero" value="${(d._bonNumeroSaisi||'').replace(/"/g,'&quot;')}" placeholder="Tape le n° du bon puis Entrée" onchange="autoFillDocFromBon(this.value)" onblur="autoFillDocFromBon(this.value)"></div>
      <div class="form-group"><label class="form-label">Date</label><input class="form-input" type="date" value="${d.dateDoc||''}" oninput="_editingDoc.dateDoc=this.value"></div>
      <div class="form-group"><label class="form-label">Rabais (%)</label><input class="form-input" type="number" step="0.1" value="${d.rabais||0}" oninput="_editingDoc.rabais=parseFloat(this.value)||0;renderDocEditor()"></div>
      <div class="form-group"><label class="form-label">TVA (%)</label><input class="form-input" type="number" step="0.1" value="${d.tvaTaux}" oninput="_editingDoc.tvaTaux=parseFloat(this.value)||0;renderDocEditor()"></div>
    </div>
    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin:6px 0;">Lignes</div>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="font-size:10px;color:var(--g400);text-transform:uppercase;text-align:left;">
        <th style="padding:3px;">Description</th><th style="padding:3px;text-align:right;">Qté</th><th style="padding:3px;text-align:right;">Prix unit.</th><th style="padding:3px;text-align:right;">Total</th><th></th>
      </tr></thead>
      <tbody>${lignesHtml}</tbody>
    </table>
    <button class="btn btn-ghost btn-sm" onclick="addDocLigne()" style="margin-top:8px;">+ Ajouter une ligne</button>
    <div id="doc-summary" style="margin-top:14px;margin-left:auto;width:280px;font-size:13px;">${_docSummaryHtml(t, d)}</div>
    <div class="form-group" style="margin-top:10px;"><label class="form-label">Notes / conditions</label><textarea class="form-input" rows="2" oninput="_editingDoc.notes=this.value">${d.notes||''}</textarea></div>
    ${d.type === 'facture' ? `
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
  // Génère l'aperçu QR pour les factures
  if (d.type === 'facture') {
    try {
      const debtor = { nom: d.clientNom, rue: d.clientAdresse, npa: d.clientNpa, ville: d.clientVille };
      const payload = _buildSpcPayload(t.total, 'Facture ' + (d.numero || ''), debtor, _docBureau(d));
      const url = _makeQrDataUrl(payload);
      const prev = $('doc-qr-preview');
      if (prev && url) prev.innerHTML = `<img src="${url}" style="width:116px;height:116px;">`;
    } catch (e) { console.warn('QR preview', e); }
  }
}

// HTML du bloc récapitulatif des totaux
function _docSummaryHtml(t, d) {
  return `
    <div style="display:flex;justify-content:space-between;padding:3px 0;"><span>Sous-total HT</span><b>${_displayMontant(t.sousTotal)} CHF</b></div>
    ${(d.rabais||0) > 0 ? `<div style="display:flex;justify-content:space-between;padding:3px 0;color:#e63946;"><span>Rabais ${d.rabais}%</span><span>− ${_displayMontant(t.rabaisMontant)} CHF</span></div>
    <div style="display:flex;justify-content:space-between;padding:3px 0;"><span>Net HT</span><b>${_displayMontant(t.net)} CHF</b></div>` : ''}
    <div style="display:flex;justify-content:space-between;padding:3px 0;color:var(--g600);"><span>TVA ${d.tvaTaux}%</span><span>${_displayMontant(t.tvaMontant)} CHF</span></div>
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-top:2px solid var(--navy);font-size:15px;font-weight:800;color:var(--navy);"><span>Total TTC</span><span>${_displayMontant(t.total)} CHF</span></div>`;
}

// Mise à jour d'une ligne SANS re-render complet (évite la perte de focus à la frappe)
function updateDocLigne(i, field, val) {
  if (!_editingDoc || !_editingDoc.lignes[i]) return;
  _editingDoc.lignes[i][field] = (field === 'desc') ? val : (parseFloat(val) || 0);
  // La description n'affecte pas les montants → rien d'autre à faire
  if (field === 'desc') return;
  // Pour qté/prix : mettre à jour uniquement la cellule total de la ligne + le récapitulatif
  const l = _editingDoc.lignes[i];
  const cell = $('lt-' + i);
  if (cell) cell.textContent = _displayMontant((parseFloat(l.qte)||0) * (parseFloat(l.prix)||0));
  const t = _calcTotaux(_editingDoc.lignes, _editingDoc.tvaTaux, _editingDoc.rabais);
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
function addDocLigne() { _editingDoc.lignes.push({ desc: '', qte: 1, prix: 0 }); renderDocEditor(); }
function removeDocLigne(i) { _editingDoc.lignes.splice(i, 1); if (!_editingDoc.lignes.length) _editingDoc.lignes.push({ desc: '', qte: 1, prix: 0 }); renderDocEditor(); }

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
  const t = _calcTotaux(_editingDoc.lignes, _editingDoc.tvaTaux, _editingDoc.rabais);
  _editingDoc.sousTotal = t.sousTotal;
  _editingDoc.rabaisMontant = t.rabaisMontant;
  _editingDoc.tvaMontant = t.tvaMontant;
  _editingDoc.total = t.total;
  // Retire les champs transitoires d'UI avant sauvegarde
  const toSave = JSON.parse(JSON.stringify(_editingDoc));
  delete toSave._bonNumeroSaisi;
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
  DB.documents = docs;
  if (value === 'payee' && d.bonId) toast('✅ Payée — dossier classé dans « 📦 Facturation archivée »', '#0f766e');
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
  let docs = (DB.documents || []).slice().filter(d => (d.type || 'devis') === filtre && !_docIsArchive(d) && !_isFactureFactArchived(d));
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
    const tBrouillon = sumS('brouillon'), tPret = sumS('pret'), tEnvoyee = sumS('envoyee'), tPayee = sumS('payee');
    const totalEnvoye = tEnvoyee + tPayee;
    const chip = (val, label, n, col) => {
      const on = (sf === val);
      return `<button onclick="docSetStatutFilter('${val}')" style="font-size:12px;font-weight:700;padding:6px 11px;border-radius:20px;cursor:pointer;border:1.5px solid ${on ? col : '#d1d5db'};background:${on ? col : '#fff'};color:${on ? '#fff' : '#374151'};">${label} (${n})</button>`;
    };
    const carte = (label, montant, bg, bd, cl) =>
      `<div style="background:${bg};border:1px solid ${bd};border-radius:8px;padding:7px 12px;font-size:12px;"><span style="color:${cl};font-weight:800;">${label}</span> : <b>${_displayMontant(montant)} CHF</b></div>`;
    statsBar = `
      <div style="display:flex;flex-wrap:wrap;gap:7px;align-items:center;margin-bottom:10px;">
        ${chip('tous', 'Toutes', allOfType.length, '#0d1b3e')}
        ${chip('brouillon', '🕒 Brouillon', byS('brouillon').length, '#f59e0b')}
        ${chip('pret', '📤 Prêt à envoyer', byS('pret').length, '#d97706')}
        ${chip('envoyee', '📨 Envoyées', byS('envoyee').length, '#2563eb')}
        ${chip('payee', '✅ Payées', byS('payee').length, '#16a34a')}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;">
        ${carte('Total envoyé', totalEnvoye, '#ecfdf5', '#bbf7d0', '#166534')}
        ${carte('Total non envoyé (brouillons)', tBrouillon, '#fffbeb', '#fde68a', '#b45309')}
        ${carte('Reste à encaisser', tEnvoyee, '#eff6ff', '#bfdbfe', '#1d4ed8')}
        ${carte('Encaissé (payées)', tPayee, '#f0fdf4', '#bbf7d0', '#15803d')}
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
    'pret':      { bg:'#fef3c7', color:'#b45309' },
    'envoyee':   { bg:'#dbeafe', color:'#1d4ed8' },
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
    <div style="display:flex;align-items:center;gap:14px;background:${cardBg};border:1px solid ${cardBorder};border-left:4px solid ${gColor};border-radius:8px;padding:10px 14px;margin-bottom:6px;box-shadow:0 1px 2px rgba(0,0,0,.04);flex-wrap:wrap;">
      <div style="min-width:130px;">
        <div style="font-size:13px;font-weight:800;color:var(--navy);">${isDevis?'📝':'🧾'} ${d.numero||''}</div>
        <div style="font-size:11px;color:var(--g600);">📅 ${fmtDate(d.dateDoc)||'—'}</div>
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
      <div style="display:flex;gap:5px;align-items:center;flex-shrink:0;flex-wrap:wrap;">
        <select onchange="updateDocStatut('${d.id}',this.value)" style="font-size:11px;font-weight:700;padding:5px 7px;border-radius:6px;border:1.5px solid ${st.color};background:${st.bg};color:${st.color};cursor:pointer;">
          ${opts.map(o=>`<option value="${o}" ${d.statut===o?'selected':''}>${statutLabel[o]}</option>`).join('')}
        </select>
        <button class="btn btn-ghost btn-sm" onclick="editDoc('${d.id}')" title="Modifier">✏️</button>
        <button class="btn btn-ghost btn-sm" onclick="downloadDocPDF('${d.id}')" title="Télécharger le PDF">📥 PDF</button>
        ${isDevis?`<button class="btn btn-navy btn-sm" onclick="convertDevisToFacture('${d.id}')" title="Convertir en facture">→ Facture</button>`:''}
        <button class="btn btn-red btn-sm btn-xs" onclick="confirmDeleteDoc('${d.id}','${(d.numero||'').replace(/'/g,"\\'")}')" title="Supprimer">🗑</button>
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
  return String(txt || '')
    .replace(/\s*p\s*[\.\/]\s*a\.?\s*/gi, ' p.a. ')
    .replace(/\s{2,}/g, ' ')
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
function downloadDocPDF(id, mode) {
  const d = (DB.documents || []).find(x => x.id === id);
  if (!d) { if (mode !== 'blob') toast('Document introuvable', '#e63946'); return; }
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
  const isFacture = d.type === 'facture';
  const t = _calcTotaux(d.lignes, d.tvaTaux, d.rabais);

  // --- En-tête horizontal (LOGO + coordonnées) — dessiné sur CHAQUE page ---
  const logoW = 62, logoH = logoW * 199 / 900;   // logo agrandi (ratio d'origine conservé)
  const logoY = 13;
  const headerFiletY = logoY + logoH + 5;        // Y du filet de séparation
  const drawHeader = () => {
    if (typeof LOGO_B64 !== 'undefined') {
      try { doc.addImage(LOGO_B64, 'PNG', 20, logoY, logoW, logoH); }
      catch (e) { console.warn('logo', e); }
    } else {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.setTextColor(13, 27, 62); doc.text('DERATEK', 20, 23);
    }
    // Coordonnées en 2 colonnes à droite du logo
    const cy0 = logoY + 4;
    const colA = [bureau.rue, `${bureau.npa} ${bureau.ville}`, 'Tél. ' + bureau.tel];
    const colB = [co.email, co.tva];
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(70);
    colA.forEach((l, i) => { if (l) doc.text(l, 92, cy0 + i * 4.4); });
    colB.forEach((l, i) => { if (l) doc.text(l, 146, cy0 + i * 4.4); });
    // Site web (lien cliquable) sous l'email / la TVA
    doc.setTextColor(13, 27, 62);
    try { doc.textWithLink('www.deratek.ch', 146, cy0 + 2 * 4.4, { url: 'https://www.deratek.ch' }); }
    catch (e) { doc.text('www.deratek.ch', 146, cy0 + 2 * 4.4); }
    doc.setTextColor(0);
    // Filet de séparation sous l'en-tête
    doc.setDrawColor(200, 205, 213); doc.setLineWidth(0.4); doc.line(20, headerFiletY, 190, headerFiletY);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(0);
  };
  // Démarre une nouvelle page de contenu : saut de page + en-tête répété, renvoie le Y de départ
  const startContentPage = () => { doc.addPage(); drawHeader(); return headerFiletY + 8; };
  drawHeader();

  // Date d'émission, sous le filet, à droite ("Neuchâtel, le ...")
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(13, 27, 62);
  doc.text((bureau.ville || 'Neuchâtel') + ', le ' + (fmtDate(d.dateDoc) || ''), 190, headerFiletY + 7, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setTextColor(0);

  // Destinataire (client) à droite — même position que le générateur
  // Si un propriétaire est renseigné : "Propriétaire / p.a. Gérance / adresse gérance"
  doc.setFontSize(11);
  let dy = 62;
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
  destLines = destLines.map(l => _fixPa(l));
  destLines.forEach(l => { doc.splitTextToSize(String(l), 80).forEach(ln => { doc.text(ln, 120, dy); dy += 5.2; }); });

  // Titre du document (style modèle : "Facture N°" en gras, taille moyenne)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(13, 27, 62);
  doc.text((isFacture ? 'Facture ' : 'Devis ') + (d.numero || ''), 20, 90);
  doc.setTextColor(0);
  // Bloc infos en "label : valeur" alignés (façon modèle 5570)
  let infoY = 98;
  const bonLie = d.bonId ? (DB.bons || []).find(b => b.id === d.bonId) : null;
  const infoPairs = [
    ['N° TVA', co.tva],
    [isFacture ? 'Date facture' : 'Date devis', fmtDate(d.dateDoc) || ''],
    ['Délai de paiement', '30 jours'],
  ];
  if (bonLie && bonLie.numero) infoPairs.unshift(['N° bon de travail', bonLie.numero]);
  doc.setFontSize(9);
  infoPairs.forEach(([k, v]) => {
    if (!v) return;
    doc.setFont('helvetica', 'normal'); doc.setTextColor(90);
    doc.text(k, 20, infoY);
    doc.setTextColor(0); doc.text(': ' + v, 62, infoY);
    infoY += 4.6;
  });
  infoY += 2;
  // Texte descriptif de l'intervention (concerne + adresse), en paragraphe
  const descParts = [];
  if (d.locataireNom) descParts.push('Concerne : ' + d.locataireNom);
  if (d.locataireAdresse) descParts.push(d.locataireAdresse);
  if (descParts.length) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(40);
    doc.splitTextToSize(descParts.join(' — '), 170).forEach(ln => { doc.text(ln, 20, infoY); infoY += 4.6; });
    doc.setTextColor(0);
  }

  // En-tête du tableau — ruban BLEU (navy) avec texte blanc
  const drawLignesHeader = (y) => {
    doc.setFillColor(13, 27, 62); doc.rect(20, y - 5, 170, 7.5, 'F');
    doc.setTextColor(255, 255, 255); doc.setFontSize(8.5); doc.setFont('helvetica', 'bold');
    doc.text('Désignation', 22, y); doc.text('Qté', 130, y, {align:'right'}); doc.text('Prix HT', 156, y, {align:'right'}); doc.text('Montant', 188, y, {align:'right'});
    doc.setTextColor(0); doc.setFont('helvetica', 'normal');
    return y + 8.5;
  };

  const startY = Math.max(106, infoY + 3);
  // Hauteur réelle du bloc totaux (sous-total + [rabais] + tva + total), marge incluse
  const totalsH = (d.rabais || 0) > 0 ? 24 : 20;
  const lignes = d.lignes || [];

  // Géométrie du bulletin QR suisse : bande de 105 mm ancrée en bas d'une page.
  const QR_TOP = H - 105;             // perforation haute du bulletin
  const QR_NEED_TOP = QR_TOP - 13;    // le contenu doit finir au-dessus (place pour la condition de paiement)
  const contentBottom = H - 20;       // marge basse normale du flux

  // Rythme vertical uniforme : hauteur d'une ligne de texte + marge identique
  // au-dessus et en dessous du filet, quelle que soit la longueur de la désignation.
  doc.setFontSize(9.5);
  const LINE = 4.4;   // hauteur d'une ligne de texte (mm)
  const PAD  = 3;     // marge uniforme texte ↔ filet ↔ ligne suivante

  // Les lignes suivent le flux normal et continuent en page suivante si nécessaire.
  let ty = startY;
  ty = drawLignesHeader(ty);
  lignes.forEach((l) => {
    const lt = (parseFloat(l.qte)||0) * (parseFloat(l.prix)||0);
    const descLines = doc.splitTextToSize(l.desc || '', 100);
    const rowTextH = descLines.length * LINE;
    if (ty + rowTextH + PAD * 2 > contentBottom) {
      ty = drawLignesHeader(startContentPage());
    }
    const baseY = ty + LINE - 1;   // baseline de la 1re ligne (texte sous le haut de la rangée)
    doc.text(descLines, 22, baseY, { lineHeightFactor: LINE / 3.35 });
    doc.text(String(l.qte||0), 130, baseY, {align:'right'});
    doc.text(_displayMontant(l.prix||0), 156, baseY, {align:'right'});
    doc.text(_displayMontant(lt), 188, baseY, {align:'right'});
    // Filet fin à distance FIXE sous le texte (alignement régulier)
    const sepY = ty + rowTextH + PAD;
    doc.setDrawColor(225, 228, 233); doc.setLineWidth(0.2);
    doc.line(20, sepY, 190, sepY);
    ty = sepY + PAD;   // rangée suivante à la même distance sous le filet
  });

  // Bloc des totaux, juste APRÈS toutes les lignes (saut de page si pas la place).
  if (ty + totalsH > contentBottom) { ty = startContentPage(); }
  ty += 3;
  doc.line(120, ty, 190, ty); ty += 4.3;
  doc.setFontSize(9.5); doc.setFont('helvetica', 'normal');
  doc.text('Sous-total HT', 130, ty); doc.text(_displayMontant(t.sousTotal) + ' CHF', 188, ty, {align:'right'}); ty += 4.3;
  if ((d.rabais || 0) > 0) {
    doc.setTextColor(180, 40, 40);
    doc.text(`Rabais ${d.rabais}%`, 130, ty); doc.text('- ' + _displayMontant(t.rabaisMontant) + ' CHF', 188, ty, {align:'right'}); ty += 4.3;
    doc.setTextColor(0);
  }
  doc.text(`TVA ${d.tvaTaux}%`, 130, ty); doc.text(_displayMontant(t.tvaMontant) + ' CHF', 188, ty, {align:'right'}); ty += 5.5;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
  doc.text('Total TTC', 130, ty); doc.text(_displayMontant(t.total) + ' CHF', 188, ty, {align:'right'});
  ty += 6;

  // Notes éventuelles, dans le flux (on retire le marqueur technique [ARCHIVE])
  if (_docNotesClean(d)) {
    const noteLines = doc.splitTextToSize(_docNotesClean(d), 170);
    const notesH = noteLines.length * 4.5 + 8;
    if (ty + notesH > contentBottom) { ty = startContentPage(); }
    doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(80);
    doc.text(noteLines, 20, ty + 6); doc.setTextColor(0);
    ty += notesH;
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
    const debtLinesClean = debtLines ? debtLines.map(l => _fixPa(l)) : null;

    // Conditions de paiement, juste au-dessus de la ligne pointillée
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(13, 27, 62);
    doc.text('Condition de paiement : 30 jours net.', 20, billTop - 11);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(90);
    doc.text('Veuillez utiliser le bulletin de versement ci-dessous pour le paiement.', 20, billTop - 6);
    doc.setTextColor(0);

    // Lignes de découpe
    doc.setLineWidth(0.2); doc.setDrawColor(120); doc.setLineDashPattern([1.4, 1], 0);
    doc.line(0, billTop, W, billTop); doc.line(payX, billTop, payX, H);
    doc.setLineDashPattern([], 0);
    doc.setFontSize(8); doc.setTextColor(110); doc.text('✂', 3, billTop + 1.2); doc.setTextColor(0);

    const L = (txt, x, y) => { doc.setFont('helvetica','bold'); doc.setFontSize(6); doc.text(txt, x, y); return y + 3.4; };
    const V = (arr, x, y, size, maxW) => {
      doc.setFont('helvetica','normal'); doc.setFontSize(size||8);
      const lh = (size||8)*0.40; let cy = y;
      (Array.isArray(arr)?arr:[arr]).forEach(ln => { if(!ln) return; (maxW?doc.splitTextToSize(String(ln),maxW):[String(ln)]).forEach(p=>{doc.text(p,x,cy);cy+=lh;}); });
      return cy;
    };
    const credLines = [_displayIban(co.iban), co.nom, bureau.rue, `${bureau.npa} ${bureau.ville}`].filter(Boolean);
    const amountDisp = _displayMontant(t.total);

    // Récépissé
    let y = billTop + 7;
    doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.text('Récépissé', padX, y); y += 8;
    y = L('Compte / Payable à', padX, y); y = V(credLines, padX, y, 7, recW-padX-4) + 1.5;
    y = L('Payable par', padX, y);
    if (debtLinesClean) y = V(debtLinesClean, padX, y, 7, recW-padX-4) + 1.5; else y += 6;
    const amountY = 255;
    L('Monnaie', padX, amountY); L('Montant', padX+18, amountY);
    V([co.devise||'CHF'], padX, amountY+3.6, 8); V([amountDisp], padX+18, amountY+3.6, 8);
    doc.setFont('helvetica','bold'); doc.setFontSize(6); doc.text('Point de dépôt', recW-5, H-8, {align:'right'});

    // Section paiement
    const px2 = payX + 5; let py = billTop + 7;
    doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.text('Section paiement', px2, py);
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
  const fname = (isFacture?'facture-':'devis-') + (d.numero||'doc').replace(/[^a-z0-9]+/gi,'-').toLowerCase() + '.pdf';
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
let _editingDiag = null;

function _nextDiagNumero() {
  const year = new Date().getFullYear();
  const list = (DB.diagnostics || []).filter(d => (d.numero||'').includes('-' + year + '-'));
  let max = 0;
  list.forEach(d => { const m = (d.numero||'').match(/-(\d+)$/); if (m) max = Math.max(max, parseInt(m[1],10)); });
  return `DG-${year}-${String(max+1).padStart(3,'0')}`;
}

function openNewDiagnostic() {
  _editingDiag = {
    id: newId(), numero: _nextDiagNumero(), dateDoc: today(), tech: '',
    clientId: '', clientNom: '', locataireNom: '', locataireAdresse: '',
    batiment: '', bonId: '', insectes: [], elementsTouches: '',
    activite: '', etendue: '', humidite: '', gravite: '', diagnostic: '', conclusion: ''
  };
  renderDiagEditor(); openModal('modal-diag');
}
function editDiag(id) {
  const d = (DB.diagnostics || []).find(x => x.id === id); if (!d) return;
  _editingDiag = JSON.parse(JSON.stringify(d));
  if (!Array.isArray(_editingDiag.insectes)) _editingDiag.insectes = [];
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
  const box = $('modal-diag-body'); if (!box) return;
  const clientOpts = (DB.clients||[]).slice().sort((a,b)=>(a.nom||'').localeCompare(b.nom||'')).map(c=>`<option value="${c.id}" ${d.clientId===c.id?'selected':''}>${(c.nom||'').replace(/</g,'&lt;')}</option>`).join('');
  const insectesHtml = INSECTES_BOIS.map(n => `
    <label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;margin:3px 10px 3px 0;cursor:pointer;">
      <input type="checkbox" ${(d.insectes||[]).includes(n)?'checked':''} onchange="toggleDiagInsecte('${n.replace(/'/g,"\\'")}',this.checked)" style="accent-color:var(--navy);"> ${n}
    </label>`).join('');
  box.innerHTML = `
    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🪵 Identification</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
      <div class="form-group"><label class="form-label">N° de bon (remplissage auto)</label><input class="form-input" placeholder="Tape le n° puis Tab" onchange="autoFillDiagFromBon(this.value)" onblur="autoFillDiagFromBon(this.value)"></div>
      <div class="form-group"><label class="form-label">Date</label><input class="form-input" type="date" value="${d.dateDoc||''}" oninput="_editingDiag.dateDoc=this.value"></div>
      <div class="form-group"><label class="form-label">Client (gérance)</label>
        <select class="form-input" onchange="onDiagClientSelect(this.value)"><option value="">-- Choisir --</option>${clientOpts}</select>
        <input class="form-input" style="margin-top:5px;font-size:12px;" placeholder="ou nom manuel" value="${(d.clientNom||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.clientNom=this.value;_editingDiag.clientId='';">
      </div>
      <div class="form-group"><label class="form-label">Technicien</label><input class="form-input" value="${(d.tech||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.tech=this.value"></div>
      <div class="form-group"><label class="form-label">Locataire</label><input class="form-input" value="${(d.locataireNom||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.locataireNom=this.value"></div>
      <div class="form-group"><label class="form-label">Bâtiment / charpente concernée</label><input class="form-input" value="${(d.batiment||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.batiment=this.value" placeholder="Ex. charpente combles, villa"></div>
      <div class="form-group" style="grid-column:1/-1;"><label class="form-label">Adresse</label><input class="form-input" value="${(d.locataireAdresse||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.locataireAdresse=this.value"></div>
    </div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">🐛 Insectes détectés & éléments touchés</div>
    <div style="margin-bottom:8px;">${insectesHtml}</div>
    <div class="form-group" style="margin-bottom:14px;"><label class="form-label">Éléments / bois touchés</label><textarea class="form-input" rows="2" oninput="_editingDiag.elementsTouches=this.value" placeholder="Ex. poutres, solives, chevrons, lambris...">${d.elementsTouches||''}</textarea></div>

    <div style="font-size:12px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:6px;">✏️ Schéma de la charpente (entoure les zones touchées)</div>
    <div style="border:1px solid #e5e7eb;border-radius:8px;padding:8px;margin-bottom:14px;">
      <canvas id="diag-schema-canvas" width="640" height="380" style="width:100%;height:auto;border:1px dashed #ccc;border-radius:6px;cursor:crosshair;touch-action:none;background:#fff;"></canvas>
      <input type="file" id="diag-schema-file" accept="image/*" style="display:none" onchange="loadSchemaImage(event)">
      <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">
        <button class="btn btn-navy btn-sm" type="button" onclick="document.getElementById('diag-schema-file').click()">📷 Importer une image / photo</button>
        <button class="btn btn-ghost btn-sm" type="button" onclick="clearDiagSchema()">↺ Effacer les annotations</button>
        <button class="btn btn-ghost btn-sm" type="button" onclick="resetToDefaultSchema()">🪵 Schéma 3D par défaut</button>
        <span style="font-size:11px;color:var(--g400);align-self:center;">Importe une photo de la charpente, puis dessine pour entourer les zones touchées.</span>
      </div>
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
      <div class="form-group"><label class="form-label">Taux d'humidité du bois</label><input class="form-input" value="${(d.humidite||'').replace(/"/g,'&quot;')}" oninput="_editingDiag.humidite=this.value" placeholder="Ex. 14%"></div>
    </div>
    <div class="form-group" style="margin-bottom:8px;"><label class="form-label">Observations / diagnostic détaillé</label><textarea class="form-input" rows="3" oninput="_editingDiag.diagnostic=this.value">${d.diagnostic||''}</textarea></div>
    <div class="form-group"><label class="form-label">Conclusion / recommandations</label><textarea class="form-input" rows="2" oninput="_editingDiag.conclusion=this.value">${d.conclusion||''}</textarea></div>
  `;
  const t = $('modal-diag-title'); if (t) t.textContent = 'Diagnostic bois ' + (d.numero||'');
  initDiagSchema();
}

// --- Schéma de charpente annotable ---
let _diagDrawing = false;
function _drawSchemaBase(ctx, W, H) {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  // Décalage de profondeur (effet isométrique)
  const dx = W * 0.26, dy = -H * 0.16;
  const wood = '#8a5a28', woodDark = '#5e3c16';
  const L = (x1,y1,x2,y2,col,lw) => { ctx.strokeStyle=col; ctx.lineWidth=lw; ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke(); };
  const off = (p) => ({ x: p.x + dx, y: p.y + dy });

  // Ferme avant (king-post truss)
  const Lf = { x: W*0.10, y: H*0.66 };           // base gauche
  const Rf = { x: W*0.62, y: H*0.66 };           // base droite
  const Af = { x: (Lf.x+Rf.x)/2, y: H*0.30 };    // faîte (apex)
  const Mf = { x: (Lf.x+Rf.x)/2, y: Lf.y };      // pied du poinçon
  // Ferme arrière (décalée)
  const Lb = off(Lf), Rb = off(Rf), Ab = off(Af), Mb = off(Mf);

  // Pans de toiture (faces) légèrement teintés pour le volume
  ctx.fillStyle = 'rgba(180,130,70,0.12)';
  ctx.beginPath(); ctx.moveTo(Lf.x,Lf.y); ctx.lineTo(Af.x,Af.y); ctx.lineTo(Ab.x,Ab.y); ctx.lineTo(Lb.x,Lb.y); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(150,100,50,0.18)';
  ctx.beginPath(); ctx.moveTo(Rf.x,Rf.y); ctx.lineTo(Af.x,Af.y); ctx.lineTo(Ab.x,Ab.y); ctx.lineTo(Rb.x,Rb.y); ctx.closePath(); ctx.fill();

  // Pannes (lignes de liaison avant→arrière) : faîtière + sablières + arbalétriers
  L(Af.x,Af.y, Ab.x,Ab.y, woodDark, 4);          // faîtière
  L(Lf.x,Lf.y, Lb.x,Lb.y, wood, 3.5);            // sablière gauche
  L(Rf.x,Rf.y, Rb.x,Rb.y, wood, 3.5);            // sablière droite
  L(Mf.x,Mf.y, Mb.x,Mb.y, wood, 3);              // entrait liaison

  // Ferme arrière
  L(Lb.x,Lb.y, Ab.x,Ab.y, wood, 3); L(Ab.x,Ab.y, Rb.x,Rb.y, wood, 3); L(Lb.x,Lb.y, Rb.x,Rb.y, wood, 3);
  L(Ab.x,Ab.y, Mb.x,Mb.y, wood, 2.5);

  // Ferme avant (par-dessus)
  L(Lf.x,Lf.y, Af.x,Af.y, woodDark, 4.5);        // arbalétrier gauche
  L(Af.x,Af.y, Rf.x,Rf.y, woodDark, 4.5);        // arbalétrier droit
  L(Lf.x,Lf.y, Rf.x,Rf.y, woodDark, 5);          // entrait / poutre
  L(Af.x,Af.y, Mf.x,Mf.y, woodDark, 3.5);        // poinçon
  // Jambes de force avant
  const midPost = { x: Af.x, y: (Af.y+Mf.y)/2 };
  L(midPost.x,midPost.y, Lf.x+(Rf.x-Lf.x)*0.22, Lf.y, woodDark, 3);
  L(midPost.x,midPost.y, Lf.x+(Rf.x-Lf.x)*0.78, Rf.y, woodDark, 3);

  // Solives : grille de plancher sous l'entrait (profondeur)
  ctx.strokeStyle = wood; ctx.lineWidth = 2;
  const floorDrop = H*0.16;
  const Lf2 = {x:Lf.x, y:Lf.y+floorDrop}, Rf2 = {x:Rf.x, y:Rf.y+floorDrop};
  const Lb2 = off(Lf2), Rb2 = off(Rf2);
  // contour du plancher
  ctx.beginPath(); ctx.moveTo(Lf2.x,Lf2.y); ctx.lineTo(Rf2.x,Rf2.y); ctx.lineTo(Rb2.x,Rb2.y); ctx.lineTo(Lb2.x,Lb2.y); ctx.closePath(); ctx.stroke();
  // solives transversales
  for (let i=1;i<6;i++){ const tx=i/6; const a={x:Lf2.x+(Rf2.x-Lf2.x)*tx,y:Lf2.y+(Rf2.y-Lf2.y)*tx}; const b=off(a); L(a.x,a.y,b.x,b.y,wood,1.8); }
  // poutres avant/arrière du plancher
  L(Lf2.x,Lf2.y, Lf.x,Lf.y, wood,2); L(Rf2.x,Rf2.y, Rf.x,Rf.y, wood,2);

  // Étiquettes
  ctx.fillStyle = '#0d1b3e'; ctx.font = 'bold 13px Arial';
  ctx.fillText('Faîtière', (Af.x+Ab.x)/2 - 18, (Af.y+Ab.y)/2 - 8);
  ctx.fillText('Arbalétrier', Lf.x + 6, (Lf.y+Af.y)/2 - 8);
  ctx.fillText('Poinçon', Af.x + 6, midPost.y);
  ctx.fillText('Entrait / Poutre', (Lf.x+Rf.x)/2 - 40, Lf.y + 16);
  ctx.fillText('Pannes', (Rf.x+Rb.x)/2 - 6, (Rf.y+Rb.y)/2 - 6);
  ctx.fillText('Solives', Lf2.x + 4, (Lf2.y+Lb2.y)/2 + 16);
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
    _drawSchemaBase(ctx, c.width, c.height);
    _diagBgDataUrl = c.toDataURL('image/png');
    if (_editingDiag) _editingDiag.schema = _diagBgDataUrl;
  }
  const pos = e => { const r = c.getBoundingClientRect(); const tt = e.touches ? e.touches[0] : e; return { x: (tt.clientX - r.left) * (c.width / r.width), y: (tt.clientY - r.top) * (c.height / r.height) }; };
  const start = e => { _diagDrawing = true; const p = pos(e); ctx.strokeStyle = '#e63946'; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault(); };
  const move = e => { if (!_diagDrawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); e.preventDefault(); };
  const end = () => { if (!_diagDrawing) return; _diagDrawing = false; if (_editingDiag) _editingDiag.schema = c.toDataURL('image/png'); };
  c.onmousedown = start; c.onmousemove = move; c.onmouseup = end; c.onmouseleave = end;
  c.ontouchstart = start; c.ontouchmove = move; c.ontouchend = end;
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
      _diagBgDataUrl = c.toDataURL('image/png');
      if (_editingDiag) _editingDiag.schema = _diagBgDataUrl;
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
    img.onload = () => { ctx.clearRect(0,0,c.width,c.height); ctx.drawImage(img, 0, 0, c.width, c.height); if (_editingDiag) _editingDiag.schema = c.toDataURL('image/png'); };
    img.src = _diagBgDataUrl;
  } else {
    _drawSchemaBase(ctx, c.width, c.height);
    if (_editingDiag) _editingDiag.schema = c.toDataURL('image/png');
  }
}
// Revient au schéma 3D dessiné par défaut
function resetToDefaultSchema() {
  const c = $('diag-schema-canvas'); if (!c) return;
  const ctx = c.getContext('2d');
  _drawSchemaBase(ctx, c.width, c.height);
  _diagBgDataUrl = c.toDataURL('image/png');
  if (_editingDiag) _editingDiag.schema = _diagBgDataUrl;
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
function saveDiag() {
  if (!_editingDiag) return;
  // L'image du schéma n'est PAS stockée en base (pour économiser l'espace) :
  // le PDF généré + envoyé par mail tient lieu d'archive de l'image.
  const toSave = JSON.parse(JSON.stringify(_editingDiag));
  delete toSave.schema;
  const list = DB.diagnostics;
  const i = list.findIndex(x => x.id === toSave.id);
  if (i >= 0) list[i] = toSave; else list.push(toSave);
  DB.diagnostics = list;
  toast('✓ Diagnostic enregistré (texte). Pense à télécharger le PDF pour garder le schéma.', '#2d9e6b');
  closeModal('modal-diag');
  renderDiagnostics();
}
// Génère le PDF depuis l'éditeur ouvert (avec l'image du schéma en mémoire)
function downloadCurrentDiagPDF() {
  if (!_editingDiag) return;
  const c = $('diag-schema-canvas');
  if (c) { try { _editingDiag.schema = c.toDataURL('image/png'); } catch (e) {} }
  _genDiagPDF(_editingDiag);
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
  const box = $('diagnostics-section'); if (!box) return;
  const list = (DB.diagnostics || []).slice().sort((a,b)=>(b.dateDoc||'').localeCompare(a.dateDoc||''));
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div style="font-size:13px;font-weight:800;color:var(--navy);text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px;border-bottom:2px solid #8b4513;padding-bottom:4px;">🪵 Diagnostics bois (${list.length})</div>
    <div style="display:flex;flex-direction:column;gap:6px;">
      ${list.map(d => `
        <div style="display:flex;align-items:center;gap:14px;background:#fff;border:1px solid #e5e7eb;border-left:4px solid #8b4513;border-radius:8px;padding:10px 14px;flex-wrap:wrap;">
          <div style="min-width:130px;">
            <div style="font-size:13px;font-weight:800;color:var(--navy);">🪵 ${d.numero||''}</div>
            <div style="font-size:11px;color:var(--g600);">📅 ${fmtDate(d.dateDoc)||'—'}</div>
          </div>
          <div style="flex:1.4;min-width:150px;">
            <div style="font-size:10px;color:var(--g400);text-transform:uppercase;font-weight:700;">Client</div>
            <div style="font-size:12px;font-weight:600;color:var(--navy);">${d.clientNom||'—'}</div>
            ${d.locataireNom?`<div style="font-size:11px;color:var(--g600);">🏠 ${d.locataireNom}</div>`:''}
          </div>
          <div style="flex:1.6;min-width:170px;">
            <div style="font-size:10px;color:var(--g400);text-transform:uppercase;font-weight:700;">Insectes</div>
            <div style="font-size:12px;color:var(--g600);">${(d.insectes||[]).join(', ')||'—'}</div>
          </div>
          <div style="display:flex;gap:5px;align-items:center;flex-shrink:0;">
            <button class="btn btn-ghost btn-sm" onclick="editDiag('${d.id}')" title="Modifier">✏️</button>
            <button class="btn btn-ghost btn-sm" onclick="downloadDiagPDF('${d.id}')" title="PDF">📥 PDF</button>
            <button class="btn btn-red btn-sm btn-xs" onclick="confirmDeleteDiag('${d.id}','${(d.numero||'').replace(/'/g,"\\'")}')" title="Supprimer">🗑</button>
          </div>
        </div>
      `).join('')}
    </div>`;
}
function downloadDiagPDF(id) {
  const d = (DB.diagnostics||[]).find(x => x.id === id);
  if (!d) { toast('Diagnostic introuvable', '#e63946'); return; }
  _genDiagPDF(d);
}
function _genDiagPDF(d) {
  if (!d) { toast('Diagnostic introuvable', '#e63946'); return; }
  if (!window.jspdf || !window.jspdf.jsPDF) { toast('Librairie PDF non chargée', '#e63946'); return; }
  const co = DERATEK_CONFIG.company;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:'mm', format:'a4' });
  // En-tête logo + coordonnées
  const logoW = 60, logoH = logoW*199/900;
  if (typeof LOGO_B64 !== 'undefined') { try { doc.addImage(LOGO_B64,'PNG',20,15,logoW,logoH); } catch(e){} }
  let hy = 15+logoH+6;
  doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(40);
  [co.rue, `${co.npa} ${co.ville}`, 'Tél. '+co.tel, co.tva, co.email].forEach(l=>{ doc.text(l,20,hy); hy+=4.6; });
  doc.setTextColor(0);
  // Destinataire
  doc.setFontSize(11.5); let dy=62;
  [d.clientNom, d.locataireNom, d.locataireAdresse].filter(Boolean).forEach(l=>{ doc.splitTextToSize(String(l),80).forEach(ln=>{doc.text(ln,120,dy);dy+=5.2;}); });
  // Titre
  doc.setFont('helvetica','bold'); doc.setFontSize(15); doc.setTextColor(13,27,62);
  doc.text('RAPPORT DIAGNOSTIC — INSECTES DU BOIS', 20, 92);
  doc.setFont('helvetica','normal'); doc.setFontSize(9.5); doc.setTextColor(80);
  let y = 99;
  doc.text('N° ' + (d.numero||'') + '   •   Date : ' + (fmtDate(d.dateDoc)||''), 20, y); y+=5;
  if (d.tech) { doc.text('Technicien : ' + d.tech, 20, y); y+=5; }
  if (d.batiment) { doc.text('Bâtiment / charpente : ' + d.batiment, 20, y); y+=5; }
  doc.setTextColor(0);
  y += 4;
  const section = (titre) => { doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(13,27,62); doc.text(titre, 20, y); doc.setDrawColor(139,69,19); doc.setLineWidth(0.4); doc.line(20, y+1.5, 190, y+1.5); y+=7; doc.setTextColor(0); doc.setFont('helvetica','normal'); doc.setFontSize(10); };
  const field = (lbl, val) => { if(!val) return; doc.setFont('helvetica','bold'); doc.setFontSize(9.5); doc.text(lbl+' :', 20, y); doc.setFont('helvetica','normal'); const lines = doc.splitTextToSize(String(val), 145); doc.text(lines, 62, y); y += Math.max(lines.length*4.8, 5.5); };

  section('Insectes détectés & éléments touchés');
  field('Insectes', (d.insectes||[]).join(', '));
  field('Éléments / bois', d.elementsTouches);
  y += 3;
  section('Diagnostic');
  field('Activité', d.activite);
  field('Gravité', d.gravite);
  field('Étendue', d.etendue);
  field('Humidité du bois', d.humidite);
  if (d.diagnostic) { y+=1; doc.setFont('helvetica','bold');doc.setFontSize(9.5);doc.text('Observations :',20,y);y+=5; doc.setFont('helvetica','normal'); doc.splitTextToSize(d.diagnostic,170).forEach(ln=>{doc.text(ln,20,y);y+=4.8;}); }

  // Schéma de la charpente (image annotée)
  if (d.schema) {
    if (y > 200) { doc.addPage(); y = 20; }
    y += 4; section('Schéma de la charpente');
    try { doc.addImage(d.schema, 'PNG', 20, y, 170, 100); y += 104; } catch (e) {}
  }

  if (d.conclusion) { y+=4; section('Conclusion / recommandations'); doc.splitTextToSize(d.conclusion,170).forEach(ln=>{doc.text(ln,20,y);y+=4.8;}); }

  // Signature
  y = Math.max(y+14, 250);
  doc.setFontSize(9); doc.setTextColor(80);
  doc.text('DERATEK Professional Pest Control', 20, y);
  doc.text('Signature : ______________________', 120, y);
  doc.save('diagnostic-bois-' + (d.numero||'doc').replace(/[^a-z0-9]+/gi,'-').toLowerCase() + '.pdf');
  toast('✓ PDF diagnostic téléchargé', '#2d9e6b');
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
          <option value="envoyee">Envoyée (non payée)</option>
        </select>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap;">
        <button class="btn btn-ghost" onclick="ancPasser()">↷ Passer cette ligne</button>
        <button class="btn btn-green" onclick="ancValider()">✅ Valider et enregistrer</button>
      </div>
    </div>`;
}
function ancPasser() { state.anc.qIdx++; ancProcessFile(); }
// Liste des anciennes factures importées, conservée dans l'onglet (payée / non payée)
function renderAnciennesList() {
  const box = $('anc-list'); if (!box) return;
  const list = (DB.documents || []).filter(d => _docIsArchive(d) && (d.type || 'facture') === 'facture')
    .slice().sort((a, b) => (b.dateDoc || '').localeCompare(a.dateDoc || ''));
  if (!list.length) { box.innerHTML = ''; return; }
  const nPay = list.filter(d => d.statut === 'payee').length;
  const totalTTC = list.reduce((s, d) => s + (parseFloat(d.total) || 0), 0);
  const totalPaye = list.filter(d => d.statut === 'payee').reduce((s, d) => s + (parseFloat(d.total) || 0), 0);
  const totalNonPaye = totalTTC - totalPaye;
  const nNonPay = list.length - nPay;
  box.innerHTML = `
    <div style="border-top:1px solid #eee;padding-top:12px;margin-bottom:8px;">
      <div style="font-size:13px;font-weight:800;color:var(--navy);text-transform:uppercase;margin-bottom:8px;">📁 Anciennes factures enregistrées (${list.length}) · total ${_displayMontant(totalTTC)} CHF</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:7px 12px;font-size:12px;"><span style="color:#15803d;font-weight:800;">✅ Encaissé (payées)</span> : <b>${_displayMontant(totalPaye)} CHF</b> <span style="color:var(--g400);">(${nPay})</span></div>
        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:7px 12px;font-size:12px;"><span style="color:#b45309;font-weight:800;">⏳ Reste à encaisser (non payées)</span> : <b>${_displayMontant(totalNonPaye)} CHF</b> <span style="color:var(--g400);">(${nNonPay})</span></div>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;">
      ${list.map(d => {
        const paye = d.statut === 'payee';
        const notes = String(d.notes || '');
        const bonNo = (notes.match(/Bon n°\s*([^·\n]+)/) || [])[1];
        const devNo = (notes.match(/Devis n°\s*([^·\n]+)/) || [])[1];
        const refs = [bonNo ? '📄 Bon ' + bonNo.trim() : '', devNo ? '📝 Devis ' + devNo.trim() : ''].filter(Boolean).join(' · ');
        return `<div style="display:flex;align-items:center;gap:12px;background:#fff;border:1px solid #e5e7eb;border-left:4px solid ${paye ? '#22c55e' : '#f59e0b'};border-radius:8px;padding:8px 12px;flex-wrap:wrap;">
          <div style="min-width:130px;">
            <div style="font-size:13px;font-weight:800;color:var(--navy);">🧾 ${d.numero || '—'}</div>
            <div style="font-size:11px;color:var(--g600);">📅 ${fmtDate(d.dateDoc) || '—'}</div>
            ${refs ? `<div style="font-size:10px;color:var(--g400);">${refs}</div>` : ''}
          </div>
          <div style="flex:1.6;min-width:190px;">
            <div style="font-size:10px;color:var(--g400);text-transform:uppercase;font-weight:700;">🏢 Destinataire</div>
            <div style="font-size:12px;font-weight:600;color:var(--navy);">${d.clientNom || '—'}</div>
            ${d.proprietaire ? `<div style="font-size:11px;color:var(--g600);">👤 Propriétaire : ${d.proprietaire}</div>` : ''}
            ${d.locataireNom ? `<div style="font-size:11px;color:var(--g600);">🏠 Locataire : ${d.locataireNom}${d.locataireAdresse ? ' · ' + d.locataireAdresse : ''}</div>` : ''}
          </div>
          <div style="min-width:100px;text-align:right;"><div style="font-size:14px;font-weight:800;color:var(--navy);">${_displayMontant(d.total || 0)} CHF</div></div>
          <div style="display:flex;gap:5px;align-items:center;flex-shrink:0;flex-wrap:wrap;">
            <select onchange="ancSetStatut('${d.id}', this.value)" style="font-size:11px;font-weight:700;padding:5px 7px;border-radius:6px;border:1.5px solid ${paye ? '#22c55e' : '#f59e0b'};background:${paye ? '#dcfce7' : '#fef3c7'};color:${paye ? '#166534' : '#92400e'};cursor:pointer;">
              <option value="payee" ${paye ? 'selected' : ''}>✅ Payée</option>
              <option value="envoyee" ${!paye ? 'selected' : ''}>⏳ Non payée</option>
            </select>
            <button class="btn btn-ghost btn-sm" onclick="ancAddClientFromDoc('${d.id}')" title="Enregistrer le destinataire dans les fiches clients">👥 + Client</button>
            ${d.locataireNom ? `<button class="btn btn-ghost btn-sm" onclick="ancAddLocataireFromDoc('${d.id}')" title="Enregistrer le locataire dans les fiches locataires">🏠 + Locataire</button>` : ''}
            <button class="btn btn-navy btn-sm" onclick="editDoc('${d.id}')" title="Modifier cette facture (pour la renvoyer)">✏️ Modifier</button>
            <button class="btn btn-ghost btn-sm" onclick="downloadDocPDF('${d.id}')" title="Télécharger le PDF">📥 PDF</button>
            <button class="btn btn-red btn-sm btn-xs" onclick="ancDeleteDoc('${d.id}')" title="Supprimer">🗑</button>
          </div>
        </div>`;
      }).join('')}
    </div>`;
}
function ancSetStatut(id, value) {
  const docs = DB.documents; const d = docs.find(x => x.id === id); if (!d) return;
  d.statut = value; DB.documents = docs;
  renderAnciennesList();
  toast(value === 'payee' ? '✅ Marquée payée' : '⏳ Marquée non payée', '#2d9e6b');
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
function ancValider() {
  const val = id => { const el = $(id); return el ? String(el.value).trim() : ''; };
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
