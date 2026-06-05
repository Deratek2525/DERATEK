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
  showScreen('devis');
  // Surligne le bon bouton du menu (devis ou factures)
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const nb = $(state.docsFilter === 'facture' ? 'nb-factures' : 'nb-devis');
  if (nb) nb.classList.add('active');
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screen = $(`screen-${name}`);
  if (screen) screen.classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const nb = $(`nb-${name}`);
  if (nb) nb.classList.add('active');
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
function renderAgenda() {
  if (state.agendaView === 'semaine') renderSemaine();
  else renderMois();
}
function getWeekStart(d) {
  const dt = new Date(d); const day = dt.getDay();
  dt.setDate(dt.getDate() - (day === 0 ? 6 : day - 1));
  dt.setHours(0,0,0,0); return dt;
}
function renderSemaine() {
  const sv = $('agenda-semaine-view'), mv = $('agenda-mois-view');
  sv.style.display = 'block'; mv.style.display = 'none';
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
  const sv = $('agenda-semaine-view'), mv = $('agenda-mois-view');
  sv.style.display = 'none'; mv.style.display = 'block';
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
  const q = ($('cl-search') || {}).value || '';
  const list = DB.clients.filter(c => {
    const match = c.nom.toLowerCase().includes(q.toLowerCase()) || (c.ville||'').toLowerCase().includes(q.toLowerCase());
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
      <div style="display:flex;gap:4px;align-items:center;flex-shrink:0;">
        <button class="btn btn-ghost btn-sm" onclick="editClient('${c.id}')" title="Modifier">✏️</button>
        <button class="btn btn-ghost btn-sm" onclick="openNewRapportForClient('${c.id}')" title="Nouveau rapport">+ Rapport</button>
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
  const q = ($('rapp-search') || {}).value || '';
  const list = DB.rapports.filter(r => {
    const m = r.id.toLowerCase().includes(q.toLowerCase()) || (r.clientNom||'').toLowerCase().includes(q.toLowerCase()) || (r.nuisibles||[]).join(' ').toLowerCase().includes(q.toLowerCase()) || (r.bonCommande||'').toLowerCase().includes(q.toLowerCase());
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

  const ligneRapport = r => `
    <tr onclick="editRapport('${r.id}')">
      <td style="font-weight:700;color:var(--navy);">${r.id}</td>
      <td>${r.clientNom||'—'}</td>
      <td>${r.bonCommande || '—'}</td>
      <td>${(r.nuisibles||[]).join(', ')||'—'}</td>
      <td>${fmtDate(r.date)}</td>
      <td>${r.tech||'—'}</td>
      <td>${r.montant ? r.montant+' CHF' : '—'}</td>
      <td><span class="badge ${badgeCls(r.statut)}">${r.statut}</span></td>
      <td><button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();confirmDeleteRapport('${r.id}')">🗑</button></td>
    </tr>`;

  tb.innerHTML = noms.map(nom => {
    // Rapports de la gérance, du plus récent au plus ancien
    const rapps = groupes[nom].slice().reverse();
    const nb = rapps.length;
    const entete = `
      <tr class="rapport-groupe">
        <td colspan="9">🏢 ${nom} <span class="rapport-groupe-nb">${nb} rapport${nb > 1 ? 's' : ''}</span></td>
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
    DB.clients.map(c => `<option value="${c.id}"${c.id === selectedId ? ' selected' : ''}>${c.nom} (${c.type})</option>`).join('');
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
  ['t-pulv','t-vapeur','t-thermique','t-injection','t-appats','t-monitoring','t-desinfect','t-flocage','t-gel','t-poudre','t-fumigation','t-pose','t-appatage','t-rodenticide','t-racumin','t-talonwax'].forEach(id => { const el = $(id); if (el) el.checked = false; });
  renderProduits(); resetPhotoGrid(); clearSig();
  $('edit-id').textContent = newId;
  $('edit-status').className = 'badge b-gray'; $('edit-status').textContent = 'Brouillon';
  $('edit-meta').textContent = '';
  // Par défaut, on garde le bloc Locataire ouvert (l'utilisateur peut le fermer manuellement)
  if ($('r-avec-locataire')) $('r-avec-locataire').checked = true;
  clearLocataireSelection();
  if ($('bloc-locataire')) $('bloc-locataire').style.display = 'block';
  const d = $('r-locataire-details'); if (d) d.style.display = 'block';
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
  // Décode passages + dates d'intervention depuis la description (marqueurs)
  const rMeta = _rapMeta(r.description);
  if ($('r-description')) $('r-description').value = rMeta.descClean;
  if ($('r-nb-passages')) $('r-nb-passages').value = rMeta.nbPassages;
  rSetDates(rMeta.dates);
  // Décode le rôle + nom du contact (gérant…)
  if ($('r-contact')) $('r-contact').value = _rapContactNom(r.contact);
  if ($('r-contact-role')) $('r-contact-role').value = _rapContactRole(r.contact) || 'Gérant';
  document.querySelectorAll('#tab-nuisibles input[type=checkbox]').forEach(c => c.checked = (r.nuisibles||[]).includes(c.value));
  ['t-pulv','t-vapeur','t-thermique','t-injection','t-appats','t-monitoring','t-desinfect','t-flocage','t-gel','t-poudre','t-fumigation','t-pose','t-appatage','t-rodenticide','t-racumin','t-talonwax'].forEach(id => { const el = $(id); if (el) el.checked = (r.traitement||[]).includes(id); });
  if ($('r-rdv-heure')) $('r-rdv-heure').value = r.rdvHeure || '';
  if ($('r-bon-commande')) $('r-bon-commande').value = r.bonCommande || '';
  // Restaurer le locataire : depuis le marqueur [LOC:...] (ou anciens champs pour rétrocompat)
  const lc = rMeta.loc || {};
  const locNom = lc.nom || r.locataire || '';
  const locTel = lc.tel || r.locataireTel || '';
  const locEmail = lc.email || r.locataireEmail || '';
  const locAdr = lc.adresse || r.locataireAdresse || '';
  const setL = (id, v) => { const el = $(id); if (el) el.value = v || ''; };
  setL('r-locataire', locNom); setL('r-locataire-tel', locTel);
  setL('r-locataire-email', locEmail); setL('r-locataire-adresse', locAdr);
  const hasLoc = !!(locNom || locTel || locEmail || locAdr);
  if ($('r-avec-locataire')) $('r-avec-locataire').checked = hasLoc;
  toggleLocataire();
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
    if (!$('r-tel').value)    $('r-tel').value    = c.tel || '';
    if (!$('r-email').value)  $('r-email').value  = c.email || '';
    // Contact : nom + rôle (gérant, concierge…) repris de la fiche client
    if (!$('r-contact').value) $('r-contact').value = _rapContactNom(c.contact);
    const role = _rapContactRole(c.contact);
    if (role && $('r-contact-role')) $('r-contact-role').value = role;
    if (!$('r-adresse').value) {
      $('r-adresse').value = c.adresse || '';
      $('r-npa').value     = c.npa || '';
      $('r-ville').value   = c.ville || '';
    }
  }
  updatePDF();
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
    .trim();
  const dates = di.split(',').map(x => x.trim()).filter(Boolean).sort();
  return {
    nbPassages: np.trim(), dates: dates, descClean: clean,
    loc: lc ? {
      nom:     (lcParts[0] || '').replace(/¦/g, '|'),
      tel:     (lcParts[1] || '').replace(/¦/g, '|'),
      email:   (lcParts[2] || '').replace(/¦/g, '|'),
      adresse: (lcParts[3] || '').replace(/¦/g, '|'),
    } : null
  };
}
function _composeRapDesc(descClean, nbPassages, dates, loc) {
  let out = (descClean || '').trim();
  const arr = Array.isArray(dates) ? dates.map(x => String(x||'').trim()).filter(Boolean) : [];
  if (nbPassages) out += (out ? '\n' : '') + '[NBPASS:' + String(nbPassages).trim() + ']';
  if (arr.length) out += (out ? '\n' : '') + '[DATESINT:' + arr.join(',') + ']';
  // Locataire : encodé "nom|tel|email|adresse" (| échappé en ¦ dans les valeurs)
  if (loc && (loc.nom || loc.tel || loc.email || loc.adresse)) {
    const esc = v => String(v || '').replace(/\|/g, '¦');
    out += (out ? '\n' : '') + '[LOC:' + [esc(loc.nom), esc(loc.tel), esc(loc.email), esc(loc.adresse)].join('|') + ']';
  }
  return out;
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
  const tLabels = {'t-pulv':'Pulvérisation','t-vapeur':'Vapeur','t-thermique':'Thermique','t-injection':'Injection','t-appats':'Appâts/pièges','t-monitoring':'Monitoring','t-desinfect':'Désinfection','t-flocage':'Flocage','t-gel':'Gel','t-poudre':'Poudre','t-fumigation':'Fumigation','t-pose':'Pièges mécaniques','t-appatage':'Boîtes d\'appâtage sécurisées','t-rodenticide':'Rodenticides professionnels','t-racumin':'Racumin','t-talonwax':'Talonwax injection'};
  ['t-pulv','t-vapeur','t-thermique','t-injection','t-appats','t-monitoring','t-desinfect','t-flocage','t-gel','t-poudre','t-fumigation','t-pose','t-appatage','t-rodenticide','t-racumin','t-talonwax'].forEach(id => { const el = $(id); if (el && el.checked) { traitement.push(id); traitementLabels.push(tLabels[id]); } });

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
  // Locataire : stocké dans la description (colonnes locataire absentes côté Supabase)
  const _loc = {
    nom: _lv('r-locataire'), tel: _lv('r-locataire-tel'),
    email: _lv('r-locataire-email'), adresse: _lv('r-locataire-adresse')
  };
  r.description = _composeRapDesc($('r-description').value, ($('r-nb-passages')||{}).value || '', rReadDates(), _loc);
  const list = DB.rapports;
  const i = list.findIndex(x => x.id === state.editingRapportId);
  if (i >= 0) list[i] = r; else list.push(r);
  DB.rapports = list; state.editingRapportId = r.id;
  $('edit-id').textContent = r.id;

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
      description: r.description || '—', traitement: traitementLabels.join(', ') || '—',
      produits: produitsStr || '—', precautions: r.precautions || '—',
      resultat: r.resultat || '—', recommandations: r.recommandations || '—',
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
  const tL = {'t-pulv':'Pulvérisation','t-vapeur':'Vapeur','t-thermique':'Thermique','t-injection':'Injection','t-appats':'Appâts','t-monitoring':'Monitoring','t-desinfect':'Désinfection','t-flocage':'Flocage','t-gel':'Gel','t-poudre':'Poudre','t-fumigation':'Fumigation','t-pose':'Pièges','t-appatage':'Boîtes d\'appâtage sécurisées','t-rodenticide':'Rodenticides professionnels','t-racumin':'Racumin','t-talonwax':'Talonwax injection'};
  ['t-pulv','t-vapeur','t-thermique','t-injection','t-appats','t-monitoring','t-desinfect','t-flocage','t-gel','t-poudre','t-fumigation','t-pose','t-appatage','t-rodenticide','t-racumin','t-talonwax'].forEach(id => { const el = $(id); if (el && el.checked) traitement.push(tL[id]); });
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
  const desc = $('r-description').value || '—';
  st('pdf-description', desc.substring(0,100) + (desc.length > 100 ? '…' : ''));
  st('pdf-traitement',  traitement.join(', ') || '—');
  const montant = $('r-montant').value;
  st('pdf-montant', montant ? montant+' CHF' : '—');
  st('pdf-resultat', $('r-resultat').value);
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
    const infos = await bonExtractInfosIA(texte);
    setStatus('');
    bonShowConfirm(infos, file.name);
  } catch (err) {
    setStatus('');
    console.error('Bon error:', err);
    toast('Erreur : ' + err.message, '#e63946');
  }
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
  const q = (($('loc-search') || {}).value || '').toLowerCase();
  const all = DB.locataires || [];
  const list = q
    ? all.filter(l => ((l.nom||'') + ' ' + (l.adresse||'')).toLowerCase().includes(q))
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
// Types d'intervention
const BON_NOTE_TYPES_INTERV = [
  'Diagnostic', 'Traitement préventif', 'Traitement curatif', 'Désinsectisation',
  'Dératisation', 'Dépigeonnage', 'Capture / éviction', 'Contrôle de suivi', 'Garantie / retour',
  'Traitement d\'un nid de guêpes',
  'Traitement d\'un nid de guêpes sous toiture',
  'Traitement d\'un nid de guêpes dans un caisson de store',
  'Traitement d\'un nid de guêpes dans un buisson',
  'Traitement d\'un nid de guêpes dans le jardin'
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
  const base = { statut: '', nuisible: '', typeInterv: '', prixHT: '', rabais: '', tva: '', texte: '' };
  if (!raw) return base;
  const s = raw.trim();
  if (s.charAt(0) === '{') {
    try {
      const o = JSON.parse(s);
      return {
        statut: o.statut || '', nuisible: o.nuisible || '', typeInterv: o.typeInterv || '',
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
  return !!(d && (d.statut || d.nuisible || d.typeInterv || (d.prixHT !== '' && d.prixHT != null) || (d.texte || '').trim()));
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
  if (d.nuisible) lines.push('Nuisible : ' + d.nuisible);
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
function _bonProblemeClean(b) {
  return String((b && b.probleme) || '')
    .replace(/\s*\[INTERV:[^\]]*\]/g, '')
    .replace(/\s*\[AFFECTE:[^\]]*\]/g, '')
    .replace(/\s*\[NOTE:[^\]]*\]/g, '')
    .replace(/\s*\[RAPFAIT:[^\]]*\]/g, '')
    .trim();
}
// Réassemble la chaîne "probleme" : texte propre + marqueurs (dates, affecté, note, rapport fait).
// Source unique de vérité pour ne jamais perdre un marqueur lors d'une modif.
function _bonAssembleProbleme(clean, dates, aff, note, rapFait) {
  let out = String(clean || '').trim();
  const arr = (dates || []).map(s => String(s || '').trim()).filter(Boolean);
  if (arr.length) out += (out ? '\n' : '') + '[INTERV:' + arr.join(',') + ']';
  if (aff) out += (out ? '\n' : '') + '[AFFECTE:' + aff + ']';
  if (note && String(note).trim()) out += (out ? '\n' : '') + '[NOTE:' + _encNote(note) + ']';
  if (rapFait) out += (out ? '\n' : '') + '[RAPFAIT:1]';
  return out;
}
// Réécrit probleme propre + tous les marqueurs existants
function _bonComposeProbleme(b) {
  return _bonAssembleProbleme(_bonProblemeClean(b), _bonDatesInterv(b), _bonAffecte(b), _bonNote(b), _bonRapFait(b));
}
function _setBonDatesInterv(b, dates) {
  const arr = (dates || []).map(s => String(s||'').trim()).filter(Boolean).slice(0, 5).sort();
  b.probleme = _bonAssembleProbleme(_bonProblemeClean(b), arr, _bonAffecte(b), _bonNote(b), _bonRapFait(b));
}
// Affecte un technicien à un bon
function bonSetAffecte(id, value) {
  const b = (DB.bons || []).find(x => x.id === id); if (!b) return;
  b.probleme = _bonAssembleProbleme(_bonProblemeClean(b), _bonDatesInterv(b), value, _bonNote(b), _bonRapFait(b));
  const bons = DB.bons; DB.bons = bons;
  renderBons();
  toast(value ? ('Affecté à ' + value) : 'Affectation retirée', '#2d9e6b');
}
// Enregistre/efface la note interne d'un bon
function bonSetNote(id, text) {
  const b = (DB.bons || []).find(x => x.id === id); if (!b) return;
  b.probleme = _bonAssembleProbleme(_bonProblemeClean(b), _bonDatesInterv(b), _bonAffecte(b), text, _bonRapFait(b));
  const bons = DB.bons; DB.bons = bons;
}
// Coche/décoche "rapport fait" pour un bon (suivi visuel, sans toucher au statut)
function bonToggleRapFait(id) {
  const b = (DB.bons || []).find(x => x.id === id); if (!b) return;
  const nv = !_bonRapFait(b);
  b.probleme = _bonAssembleProbleme(_bonProblemeClean(b), _bonDatesInterv(b), _bonAffecte(b), _bonNote(b), nv);
  const bons = DB.bons; DB.bons = bons;
  renderBons();
  toast(nv ? '✓ Rapport marqué comme fait' : 'Coche retirée', '#2d9e6b');
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
  // Nuisible (avec optgroups par catégorie)
  const selN = $('bon-note-nuisible');
  if (selN) selN.innerHTML = _bonNoteNuisibleOptions(d.nuisible);
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

function renderBons() {
  const list = $('bons-list');
  const count = $('bons-count');
  const q = (($('bon-search') || {}).value || '').toLowerCase();
  let bons = DB.bons || [];
  // Filtre actifs / en cours / terminés (un bon "terminé" = statut 'termine')
  const isTermine = b => (b.statut || '') === 'termine';
  if (state.bonsFilter === 'termines') {
    bons = bons.filter(isTermine);
  } else if (state.bonsFilter === 'en-cours') {
    bons = bons.filter(b => (b.statut || '') === 'en-cours');
  } else {
    bons = bons.filter(b => !isTermine(b));
  }
  if (q) {
    bons = bons.filter(b =>
      ((b.numero||'') + ' ' + (b.geranceNom||'') + ' ' + (b.locataireNom||'') + ' ' + (b.immeuble||'') + ' ' + _bonProblemeClean(b))
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
          ${items.map(b => {
            const loc = (b.locataireId && locById[b.locataireId]) || (b.locataireNom && locByName[b.locataireNom.toLowerCase()]) || null;
            const locTel     = loc ? (loc.tel || '')     : '';
            const locAdresse = loc ? (loc.adresse || '') : (b.immeuble || '');
            const cli = (b.geranceId && clientById[b.geranceId]) || (b.geranceNom && clientByName[b.geranceNom.toLowerCase()]) || null;
            // Priorité aux infos gérant stockées sur le bon (chaque bon peut avoir son propre gérant)
            // Fallback sur les infos du client si le bon ne les a pas
            const gerantNom = b.gerantNom || (cli ? _rapContactNom(cli.contact) : '');
            const gerantTel = b.gerantTel || (cli ? (cli.tel || '')     : '');
            const statut = b.statut || '';
            // Couleur de fond du select selon le statut (ordre du workflow)
            const statutStyles = {
              '':              { bg: '#f3f4f6', color: '#6b7280', border: '#d1d5db' }, // gris
              'a-transmettre': { bg: '#fca5a5', color: '#7f1d1d', border: '#dc2626' }, // rouge vif
              'transmis':      { bg: '#dbeafe', color: '#1d4ed8', border: '#3b82f6' }, // bleu
              'attente-devis': { bg: '#ede9fe', color: '#6d28d9', border: '#8b5cf6' }, // violet
              'devis-valide':  { bg: '#ccfbf1', color: '#0f766e', border: '#14b8a6' }, // teal
              'en-cours':      { bg: '#fed7aa', color: '#9a3412', border: '#f97316' }, // orange
              'termine':       { bg: '#bbf7d0', color: '#166534', border: '#22c55e' }, // vert
              'a-facturer':    { bg: '#fecaca', color: '#991b1b', border: '#ef4444' }, // rouge
            };
            const stStyle = statutStyles[statut] || statutStyles[''];
            return `
            <div id="bonrow-${b.id}" style="display:flex;align-items:stretch;gap:14px;background:${_hexTint(gColor, 0.10)};border:1px solid ${_hexTint(gColor, 0.30)};border-left:4px solid ${gColor};border-radius:8px;padding:10px 14px;box-shadow:0 1px 2px rgba(0,0,0,.04);flex-wrap:wrap;transition:box-shadow .3s;">
              <div style="display:flex;align-items:center;gap:10px;min-width:130px;">
                <div style="width:34px;height:34px;border-radius:50%;background:${gColor};color:#fff;display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;">📄</div>
                <div>
                  <div style="font-size:13px;font-weight:800;color:var(--navy);line-height:1.2;">Bon ${b.numero || '(s. n°)'}</div>
                  <div style="font-size:12px;color:var(--red);font-weight:600;">📅 ${fmtDate(b.date) || '—'}</div>
                </div>
              </div>
              <div style="flex:1;min-width:130px;">
                <div style="font-size:10px;color:var(--g400);text-transform:uppercase;font-weight:700;letter-spacing:.3px;">🏢 Gérance</div>
                <div style="font-size:12px;font-weight:600;color:var(--navy);">${g}</div>
              </div>
              <div style="flex:1;min-width:130px;">
                <div style="font-size:10px;color:var(--g400);text-transform:uppercase;font-weight:700;letter-spacing:.3px;">👤 Gérant</div>
                <div style="font-size:12px;">${gerantNom || '—'}</div>
                ${gerantTel ? `<div style="font-size:11px;color:var(--g600);">📞 ${gerantTel}</div>` : ''}
              </div>
              <div style="flex:1.2;min-width:150px;">
                <div style="font-size:10px;color:var(--g400);text-transform:uppercase;font-weight:700;letter-spacing:.3px;">🏠 Locataire</div>
                <div style="font-size:12px;">${b.locataireNom || '—'}</div>
                ${locTel ? `<div style="font-size:11px;color:var(--g600);">📞 ${locTel}</div>` : ''}
              </div>
              <div style="flex:1.4;min-width:170px;">
                <div style="font-size:10px;color:var(--g400);text-transform:uppercase;font-weight:700;letter-spacing:.3px;">📍 Adresse</div>
                <div style="font-size:12px;color:var(--g600);">${locAdresse || '—'}</div>
              </div>
              <div style="flex:1.6;min-width:180px;">
                <div style="font-size:10px;color:var(--g400);text-transform:uppercase;font-weight:700;letter-spacing:.3px;">🐛 Nuisible / problème</div>
                <div style="font-size:12px;color:var(--g600);">${_bonProblemeClean(b) || '—'}</div>
              </div>
              <div style="display:flex;flex-direction:column;gap:3px;align-items:flex-start;flex-shrink:0;min-width:170px;">
                <div style="font-size:10px;color:var(--g400);text-transform:uppercase;font-weight:700;">📅 Prochaine interv.</div>
                <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">
                  <input type="date" value="${b.dateIntervention||''}" onchange="updateBonDateInterv('${b.id}', this.value)" style="font-family:Arial;font-size:12px;font-weight:bold;color:#e63946;padding:4px 6px;border-radius:6px;border:1.5px solid #e63946;">
                  <input type="time" value="${b.heureIntervention||''}" onchange="updateBonHeureInterv('${b.id}', this.value)" style="font-family:Arial;font-size:12px;font-weight:bold;color:#e63946;padding:4px 6px;border-radius:6px;border:1.5px solid #e63946;width:78px;">
                  <button class="btn btn-ghost btn-xs" onclick="addBonToGoogle('${b.id}')" title="Ajouter à Google Agenda">📅</button>
                </div>
              </div>
              <div style="display:flex;flex-direction:column;gap:3px;align-items:flex-start;flex-shrink:0;min-width:155px;">
                <div style="font-size:10px;color:var(--g400);text-transform:uppercase;font-weight:700;">✅ Interventions effectuées</div>
                <div style="display:flex;flex-direction:column;gap:3px;">
                  ${(() => {
                    const ds = _bonDatesInterv(b);
                    let html = ds.map((d, i) => `<div style="display:flex;gap:3px;align-items:center;">
                      <input type="date" value="${d}" onchange="bonSetDateEffectuee('${b.id}', ${i}, this.value)" style="font-family:Arial;font-size:11px;font-weight:bold;color:#166534;padding:3px 5px;border-radius:6px;border:1.5px solid #22c55e;">
                      <button class="btn btn-ghost btn-xs" style="color:#b00;padding:1px 5px;" onclick="bonSetDateEffectuee('${b.id}', ${i}, '')" title="Retirer">✕</button>
                    </div>`).join('');
                    if (ds.length < 5) html += `<button class="btn btn-ghost btn-xs" style="color:#166534;" onclick="bonAddDateEffectuee('${b.id}')" title="Ajouter une date d'intervention effectuée">+ Ajouter (${ds.length}/5)</button>`;
                    else html += `<div style="font-size:10px;color:var(--g400);">5/5 (max)</div>`;
                    return html;
                  })()}
                </div>
              </div>
              <div style="display:flex;flex-direction:column;gap:3px;align-items:flex-start;flex-shrink:0;min-width:140px;">
                <div style="font-size:10px;color:var(--g400);text-transform:uppercase;font-weight:700;">👷 Affecté à</div>
                ${(() => {
                  const aff = _bonAffecte(b);
                  const techs = (DB.techs || []);
                  const opts = ['<option value="">— Personne —</option>']
                    .concat(techs.map(t => `<option value="${(t||'').replace(/"/g,'&quot;')}" ${aff===t?'selected':''}>${t}</option>`));
                  // Si l'affecté n'est plus dans la liste, on l'ajoute pour ne pas le perdre
                  if (aff && !techs.includes(aff)) opts.push(`<option value="${aff.replace(/"/g,'&quot;')}" selected>${aff}</option>`);
                  return `<select onchange="bonSetAffecte('${b.id}', this.value)" title="Technicien / responsable affecté" style="font-size:11px;font-weight:700;padding:5px 7px;border-radius:6px;border:1.5px solid ${aff?'#2563eb':'#d1d5db'};background:${aff?'#eff6ff':'#fff'};color:${aff?'#1d4ed8':'#6b7280'};cursor:pointer;max-width:135px;">${opts.join('')}</select>`;
                })()}
              </div>
              <div style="display:flex;gap:6px;align-items:center;flex-shrink:0;">
                <select onchange="updateBonStatut('${b.id}', this.value)" title="Statut du bon" style="font-size:11px;font-weight:700;padding:6px 8px;border-radius:6px;border:1.5px solid ${stStyle.border};background:${stStyle.bg};color:${stStyle.color};cursor:pointer;">
                  <option value="">— Statut —</option>
                  <option value="a-transmettre" ${statut === 'a-transmettre' ? 'selected' : ''}>📕 Rapport à transmettre</option>
                  <option value="transmis"      ${statut === 'transmis'      ? 'selected' : ''}>📨 Rapport transmis</option>
                  <option value="attente-devis" ${statut === 'attente-devis' ? 'selected' : ''}>⏸️ Attente de devis</option>
                  <option value="devis-valide"  ${statut === 'devis-valide'  ? 'selected' : ''}>✍️ Devis validé</option>
                  <option value="en-cours"      ${statut === 'en-cours'      ? 'selected' : ''}>⏳ En cours de traitement</option>
                  <option value="termine"       ${statut === 'termine'       ? 'selected' : ''}>✅ Travail terminé</option>
                  <option value="a-facturer"    ${statut === 'a-facturer'    ? 'selected' : ''}>🧾 À facturer</option>
                </select>
                ${b.pdfPath ? `<button class="btn btn-ghost btn-sm" onclick="viewBonPdf('${b.id}')" title="Ouvrir le PDF dans un nouvel onglet">📎 PDF</button>` : ''}
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
                <button class="btn btn-red btn-sm btn-xs" onclick="confirmDeleteBon('${b.id}','${(b.numero||b.id).replace(/'/g,"\\'")}')" title="Supprimer">🗑</button>
              </div>
            </div>
          `; }).join('')}
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
  b.statut = value;
  DB.bons = bons; // déclenche le sync Supabase
  const labels = {
    '':              'Statut effacé',
    'a-transmettre': '📕 Statut : Rapport à transmettre',
    'transmis':      '📨 Statut : Rapport transmis',
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
    drt_techs:      DB.techs,
    drt_clients:    DB.clients,
    drt_rapports:   DB.rapports,
    drt_intervs:    DB.intervs,
    drt_locataires: DB.locataires,
    drt_bons:       DB.bons
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
  toast('✓ Sauvegarde téléchargée', '#2d9e6b');
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
        drt_techs:      'techs',
        drt_clients:    'clients',
        drt_rapports:   'rapports',
        drt_intervs:    'intervs',
        drt_locataires: 'locataires',
        drt_bons:       'bons',
      };
      let n = 0;
      Object.keys(map).forEach(k => {
        if (Array.isArray(data[k])) {
          DB[map[k]] = data[k]; // déclenche le sync Supabase
          n++;
        }
      });
      toast(`✓ ${n} collection(s) restaurée(s) — synchronisation Supabase en cours…`, '#2d9e6b');
      if (typeof renderDashboard === 'function')  renderDashboard();
      if (typeof renderClients === 'function')    renderClients();
      if (typeof renderLocataires === 'function') renderLocataires();
      if (typeof renderBons === 'function')       renderBons();
      if (typeof renderRapports === 'function')   renderRapports();
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

// Construit le payload SPC 0200 (Swiss QR Code), refType NON (IBAN classique)
// debtor = { nom, rue, npa, ville } (le client payeur) — optionnel
function _buildSpcPayload(montant, message, debtor) {
  const co = DERATEK_CONFIG.company;
  const lines = [];
  lines.push('SPC');                 // QRType
  lines.push('0200');                // Version
  lines.push('1');                   // Coding UTF-8
  lines.push(_cleanIban(co.iban));   // IBAN
  // Créancier (structuré)
  lines.push('S', co.nom || '', co.rue || '', '', co.npa || '', co.ville || '', (co.pays || 'CH').toUpperCase());
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
    locataireNom: '', bonId: '', lignes: [{ desc: '', qte: 1, prix: 0 }],
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
function onLignePresta(i, libelle) {
  if (!libelle || !_editingDoc || !_editingDoc.lignes[i]) return;
  _editingDoc.lignes[i].desc = libelle;
  const p = getAllPrestations().find(x => x.libelle === libelle);
  if (p && parseFloat(p.prix) > 0) _editingDoc.lignes[i].prix = parseFloat(p.prix);
  renderDocEditor();
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
  const prestaOpts = getAllPrestations().map(p => `<option value="${(p.libelle||'').replace(/"/g,'&quot;')}">${(p.libelle||'').replace(/</g,'&lt;')}</option>`).join('');
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
            <div><b>Créancier :</b> ${DERATEK_CONFIG.company.nom} — ${_displayIban(DERATEK_CONFIG.company.iban)}</div>
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
      const payload = _buildSpcPayload(t.total, 'Facture ' + (d.numero || ''), debtor);
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
  toast('✓ ' + (_editingDoc.type === 'facture' ? 'Facture' : 'Devis') + ' enregistré', '#2d9e6b');
  closeModal('modal-doc');
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
  toast('Statut mis à jour ✓', '#2d9e6b');
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
  const list = $('documents-list');
  const count = $('documents-count');
  const q = (($('doc-search') || {}).value || '').toLowerCase();
  const filtre = state.docsFilter === 'facture' ? 'facture' : 'devis';
  // Titre de la page selon l'onglet
  const titleEl = document.querySelector('#screen-devis .page-title');
  if (titleEl) titleEl.textContent = (filtre === 'facture') ? 'Factures' : 'Devis';
  let docs = (DB.documents || []).slice().filter(d => (d.type || 'devis') === filtre);
  if (q) docs = docs.filter(d => ((d.numero||'')+' '+(d.clientNom||'')+' '+(d.locataireNom||'')).toLowerCase().includes(q));
  docs.sort((a, b) => (b.dateDoc || '').localeCompare(a.dateDoc || ''));
  if (count) count.textContent = docs.length ? docs.length + ' ' + (filtre === 'facture' ? 'facture(s)' : 'devis') : '';
  if (!list) return;
  if (!docs.length) {
    const msg = (filtre === 'facture')
      ? 'Aucune facture.<br>Crée une facture avec « + Nouvelle facture » ou convertis un devis accepté.'
      : 'Aucun devis.<br>Crée un devis depuis un bon « à facturer » ou avec « + Nouveau devis ».';
    list.innerHTML = '<div class="empty"><div class="empty-icon">🧾</div><div class="empty-text">' + msg + '</div></div>';
    return;
  }
  const statutColors = {
    'brouillon': { bg:'#f3f4f6', color:'#6b7280' },
    'envoye':    { bg:'#dbeafe', color:'#1d4ed8' },
    'accepte':   { bg:'#bbf7d0', color:'#166534' },
    'refuse':    { bg:'#fecaca', color:'#991b1b' },
    'envoyee':   { bg:'#dbeafe', color:'#1d4ed8' },
    'payee':     { bg:'#bbf7d0', color:'#166534' },
  };
  const statutLabel = { brouillon:'Brouillon', envoye:'Envoyé', accepte:'Accepté', refuse:'Refusé', envoyee:'Envoyée', payee:'Payée' };
  list.innerHTML = docs.map(d => {
    const isDevis = d.type === 'devis';
    const accent = isDevis ? '#8b5cf6' : '#2d9e6b';
    const st = statutColors[d.statut] || statutColors.brouillon;
    const opts = isDevis
      ? ['brouillon','envoye','accepte','refuse']
      : ['brouillon','envoyee','payee'];
    return `
    <div style="display:flex;align-items:center;gap:14px;background:#fff;border:1px solid #e5e7eb;border-left:4px solid ${accent};border-radius:8px;padding:10px 14px;margin-bottom:6px;box-shadow:0 1px 2px rgba(0,0,0,.04);flex-wrap:wrap;">
      <div style="min-width:130px;">
        <div style="font-size:13px;font-weight:800;color:var(--navy);">${isDevis?'📝':'🧾'} ${d.numero||''}</div>
        <div style="font-size:11px;color:var(--g600);">📅 ${fmtDate(d.dateDoc)||'—'}</div>
      </div>
      <div style="flex:1.4;min-width:160px;">
        <div style="font-size:10px;color:var(--g400);text-transform:uppercase;font-weight:700;">Client</div>
        <div style="font-size:12px;font-weight:600;color:var(--navy);">${d.clientNom||'—'}</div>
        ${d.locataireNom?`<div style="font-size:11px;color:var(--g600);">🏠 ${d.locataireNom}</div>`:''}
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
  }).join('');
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
    ? ['brouillon','envoyee','payee']
    : ['brouillon','envoye','accepte','refuse'];
  const statutLabels = { brouillon:'Brouillon', envoye:'Envoyé', envoyee:'Envoyée', accepte:'Accepté', refuse:'Refusé', payee:'Payée' };
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
  const opts = v === 'facture' ? ['brouillon','envoyee','payee'] : ['brouillon','envoye','accepte','refuse'];
  const labels = { brouillon:'Brouillon', envoye:'Envoyé', envoyee:'Envoyée', accepte:'Accepté', refuse:'Refusé', payee:'Payée' };
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
function downloadDocPDF(id) {
  const d = (DB.documents || []).find(x => x.id === id);
  if (!d) { toast('Document introuvable', '#e63946'); return; }
  if (!window.jspdf || !window.jspdf.jsPDF) { toast('Librairie PDF non chargée', '#e63946'); return; }
  // Sécurisation : lignes peut arriver comme string JSON depuis Supabase, ou être absent
  if (typeof d.lignes === 'string') { try { d.lignes = JSON.parse(d.lignes); } catch (e) { d.lignes = []; } }
  if (!Array.isArray(d.lignes)) d.lignes = [];
  if (d.rabais === undefined || d.rabais === null) d.rabais = 0;
  if (d.tvaTaux === undefined || d.tvaTaux === null) d.tvaTaux = 8.1;
  try {
  const co = DERATEK_CONFIG.company;
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
    const colA = [co.rue, `${co.npa} ${co.ville}`, 'Tél. ' + co.tel];
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
  doc.text('Neuchâtel, le ' + (fmtDate(d.dateDoc) || ''), 190, headerFiletY + 7, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setTextColor(0);

  // Destinataire (client) à droite — même position que le générateur
  // Si un propriétaire est renseigné : "Propriétaire / p.a. Gérance / adresse gérance"
  doc.setFontSize(11);
  let dy = 62;
  let destLines;
  if ((d.proprietaire || '').trim()) {
    destLines = [d.proprietaire, 'p.a. ' + (d.clientNom || ''), d.clientAdresse, `${d.clientNpa||''} ${d.clientVille||''}`.trim()].filter(Boolean);
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

  // En-tête du tableau — style modèle : fond gris clair, texte gris foncé, filet dessous
  const drawLignesHeader = (y) => {
    doc.setFillColor(238, 240, 244); doc.rect(20, y - 5, 170, 7, 'F');
    doc.setTextColor(70, 80, 100); doc.setFontSize(8.5); doc.setFont('helvetica', 'bold');
    doc.text('Désignation', 22, y); doc.text('Qté', 130, y, {align:'right'}); doc.text('Prix HT', 156, y, {align:'right'}); doc.text('Montant', 188, y, {align:'right'});
    doc.setDrawColor(180, 190, 205); doc.setLineWidth(0.3); doc.line(20, y + 2, 190, y + 2);
    doc.setTextColor(0); doc.setFont('helvetica', 'normal');
    return y + 7;
  };

  const startY = Math.max(106, infoY + 3);
  // Hauteur réelle du bloc totaux (sous-total + [rabais] + tva + total), marge incluse
  const totalsH = (d.rabais || 0) > 0 ? 24 : 20;
  const lignes = d.lignes || [];

  // Géométrie du bulletin QR suisse : bande de 105 mm ancrée en bas d'une page.
  const QR_TOP = H - 105;             // perforation haute du bulletin
  const QR_NEED_TOP = QR_TOP - 13;    // le contenu doit finir au-dessus (place pour la condition de paiement)
  const contentBottom = H - 20;       // marge basse normale du flux

  // Espacement FIXE entre les lignes : le tableau grandit naturellement, sans compression.
  const padding = 5;

  // Hauteurs naturelles des lignes (selon le wrap du texte de désignation)
  doc.setFontSize(9.5);
  const lineHeights = lignes.map(l => {
    const dl = doc.splitTextToSize(l.desc || '', 100);
    return Math.max(dl.length * 4.2, 6);
  });

  // Les lignes suivent le flux normal et continuent en page suivante si nécessaire.
  let ty = startY;
  ty = drawLignesHeader(ty);
  lignes.forEach((l, i) => {
    const lt = (parseFloat(l.qte)||0) * (parseFloat(l.prix)||0);
    const descLines = doc.splitTextToSize(l.desc || '', 100);
    const lineH = lineHeights[i];
    if (ty + lineH > contentBottom) {
      ty = drawLignesHeader(startContentPage());
    }
    doc.text(descLines, 22, ty, { lineHeightFactor: 1.15 });
    doc.text(String(l.qte||0), 130, ty, {align:'right'});
    doc.text(_displayMontant(l.prix||0), 156, ty, {align:'right'});
    doc.text(_displayMontant(lt), 188, ty, {align:'right'});
    // Filet fin sous chaque ligne (style modèle)
    doc.setDrawColor(225, 228, 233); doc.setLineWidth(0.2);
    doc.line(20, ty + lineH + padding - 2.5, 190, ty + lineH + padding - 2.5);
    ty += lineH + padding;
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

  // Notes éventuelles, dans le flux
  if (d.notes) {
    const noteLines = doc.splitTextToSize(d.notes, 170);
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
    const payload = _buildSpcPayload(t.total, message, debtor);
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
    const credLines = [_displayIban(co.iban), co.nom, co.rue, `${co.npa} ${co.ville}`].filter(Boolean);
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
  // On l'affiche uniquement si cette page ne contient PAS le bulletin QR (pas de superposition).
  const lastPage = doc.internal.getNumberOfPages();
  if (lastPage > 1 && !(isFacture && lastPage === qrPageNum)) {
    doc.setPage(lastPage);
    _drawPrestationsFooter(doc, W, H);
  }

  const fname = (isFacture?'facture-':'devis-') + (d.numero||'doc').replace(/[^a-z0-9]+/gi,'-').toLowerCase() + '.pdf';
  doc.save(fname);
  toast('✓ PDF téléchargé', '#2d9e6b');
  } catch (err) {
    console.error('PDF error', err);
    toast('Erreur PDF : ' + (err.message || 'voir console'), '#e63946');
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
  const statutLabels = { '':'Non défini', 'a-transmettre':'Rapport à transmettre', 'transmis':'Transmis', 'attente-devis':'Attente devis', 'devis-valide':'Devis validé', 'en-cours':'En cours', 'termine':'Terminé', 'a-facturer':'À facturer' };
  const statutCol = { '':'#9ca3af','transmis':'#3b82f6','attente-devis':'#8b5cf6','devis-valide':'#14b8a6','en-cours':'#f97316','termine':'#22c55e','a-facturer':'#ef4444' };
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
