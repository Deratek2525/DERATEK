/* ============================================================
   DERATEK — Application v2.0 — Supabase Edition
   ============================================================ */

// ============================================================
// SUPABASE CLIENT
// ============================================================
const SUPA_URL = 'https://orhgyizvoudikkrfwdtt.supabase.co';
const SUPA_KEY = 'sb_publishable_iwk-ReoFQev9PtI504IaMQ_WRl8bqVg';

const supa = {
  async query(table, method = 'GET', body = null, params = '') {
    const url = `${SUPA_URL}/rest/v1/${table}${params}`;
    const opts = {
      method,
      headers: {
        'apikey': SUPA_KEY,
        'Authorization': `Bearer ${SUPA_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
      }
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Supabase ${method} ${table}: ${err}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  },
  async select(table, params = '') { return this.query(table, 'GET', null, params); },
  async insert(table, data)        { return this.query(table, 'POST', data); },
  async update(table, data, where) { return this.query(table, 'PATCH', data, `?${where}`); },
  async upsert(table, data)        {
    const res = await fetch(`${SUPA_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'apikey': SUPA_KEY,
        'Authorization': `Bearer ${SUPA_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify(data)
    });
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  },
  async delete(table, where) { return this.query(table, 'DELETE', null, `?${where}`); },
};

// ============================================================
// BASE DE DONNÉES (Supabase + cache local)
// ============================================================
const DB = {
  // Cache local pour éviter trop de requêtes
  _cache: { techs: null, clients: null, locataires: null, rapports: null, intervs: null },

  // TECHS
  async getTechs() {
    if (this._cache.techs) return this._cache.techs;
    try {
      const rows = await supa.select('techniciens', '?order=nom');
      this._cache.techs = rows.map(r => r.nom);
      return this._cache.techs;
    } catch { return localStorage.getItem('drt_techs') ? JSON.parse(localStorage.getItem('drt_techs')) : []; }
  },
  async saveTechs(list) {
    this._cache.techs = list;
    localStorage.setItem('drt_techs', JSON.stringify(list));
    try {
      // Upsert chaque technicien
      for (const nom of list) {
        await supa.upsert('techniciens', { id: 'tech_' + nom.replace(/\s/g,'_').toLowerCase(), nom });
      }
    } catch(e) { console.warn('Supabase techs save:', e); }
  },

  // CLIENTS
  async getClients() {
    if (this._cache.clients) return this._cache.clients;
    try {
      const rows = await supa.select('clients', '?order=nom');
      this._cache.clients = rows;
      return rows;
    } catch { return localStorage.getItem('drt_clients') ? JSON.parse(localStorage.getItem('drt_clients')) : []; }
  },
  async saveClient(client) {
    this._cache.clients = null;
    localStorage.setItem('drt_clients_dirty', '1');
    try {
      await supa.upsert('clients', {
        id: client.id, nom: client.nom, type: client.type,
        contact: client.contact, tel: client.tel, email: client.email,
        web: client.web, adresse: client.adresse, npa: client.npa,
        ville: client.ville, num: client.num, tarif: client.tarif, notes: client.notes
      });
    } catch(e) { console.warn('Supabase client save:', e); toast('⚠ Sauvegardé localement uniquement', '#f4a623'); }
  },
  async deleteClient(id) {
    this._cache.clients = null;
    try { await supa.delete('clients', `id=eq.${id}`); } catch(e) { console.warn(e); }
  },

  // LOCATAIRES
  async getLocataires() {
    if (this._cache.locataires) return this._cache.locataires;
    try {
      const rows = await supa.select('locataires', '?order=nom');
      this._cache.locataires = rows;
      return rows;
    } catch { return []; }
  },
  async saveLocataire(loc) {
    this._cache.locataires = null;
    try {
      await supa.upsert('locataires', {
        id: loc.id, prenom: loc.prenom, nom: loc.nom,
        tel: loc.tel, email: loc.email, adresse: loc.adresse,
        npa: loc.npa, ville: loc.ville, client_id: loc.clientId || null, notes: loc.notes
      });
    } catch(e) { console.warn('Supabase locataire save:', e); }
  },
  async deleteLocataire(id) {
    this._cache.locataires = null;
    try { await supa.delete('locataires', `id=eq.${id}`); } catch(e) { console.warn(e); }
  },

  // RAPPORTS
  async getRapports() {
    if (this._cache.rapports) return this._cache.rapports;
    try {
      const rows = await supa.select('rapports', '?order=created_at.desc');
      // Mapper colonnes snake_case → camelCase
      this._cache.rapports = rows.map(r => this._mapRapport(r));
      return this._cache.rapports;
    } catch(e) {
      console.warn('Supabase rapports load:', e);
      return localStorage.getItem('drt_rapports') ? JSON.parse(localStorage.getItem('drt_rapports')) : [];
    }
  },
  _mapRapport(r) {
    return {
      id: r.id, clientId: r.client_id, clientNom: r.client_nom, clientEmail: r.client_email,
      date: r.date, tech: r.tech, contact: r.contact, tel: r.tel, email: r.email,
      adresse: r.adresse, npa: r.npa, ville: r.ville, localisation: r.localisation,
      batiment: r.batiment, noint: r.noint, bonCommande: r.bon_commande,
      locataireId: r.locataire_id, locataire: r.locataire, locataireTel: r.locataire_tel,
      locataireEmail: r.locataire_email, locataireAdresse: r.locataire_adresse,
      showPrix: r.show_prix, nuisibles: r.nuisibles || [], description: r.description,
      niveau: r.niveau, superficie: r.superficie, volume: r.volume,
      pieces: r.pieces, zones: r.zones, origine: r.origine, contraintes: r.contraintes,
      traitement: r.traitement || [], produits: r.produits || [],
      materiels: r.materiels || [], materielComment: r.materiel_comment,
      precautions: r.precautions, duree: r.duree, montant: r.montant,
      resultat: r.resultat, recommandations: r.recommandations,
      rdv: r.rdv, garantie: r.garantie, garantieNote: r.garantie_note,
      statut: r.statut, photoComments: r.photo_comments || [],
      sigClient: r.sig_client, sigLocataire: r.sig_locataire, sigTech: r.sig_tech,
      photos: []
    };
  },
  async saveRapport(r) {
    this._cache.rapports = null;
    const row = {
      id: r.id, client_id: r.clientId, client_nom: r.clientNom, client_email: r.clientEmail,
      date: r.date, tech: r.tech, contact: r.contact, tel: r.tel, email: r.email,
      adresse: r.adresse, npa: r.npa, ville: r.ville, localisation: r.localisation,
      batiment: r.batiment, noint: r.noint, bon_commande: r.bonCommande,
      locataire_id: r.locataireId || null, locataire: r.locataire,
      locataire_tel: r.locataireTel, locataire_email: r.locataireEmail,
      locataire_adresse: r.locataireAdresse, show_prix: r.showPrix !== false,
      nuisibles: r.nuisibles || [], description: r.description, niveau: r.niveau,
      superficie: r.superficie, volume: r.volume, pieces: r.pieces, zones: r.zones,
      origine: r.origine, contraintes: r.contraintes,
      traitement: r.traitement || [], produits: r.produits || [],
      materiels: r.materiels || [], materiel_comment: r.materielComment,
      precautions: r.precautions, duree: r.duree, montant: r.montant,
      resultat: r.resultat, recommandations: r.recommandations,
      rdv: r.rdv || null, garantie: r.garantie, garantie_note: r.garantieNote,
      statut: r.statut, photo_comments: r.photoComments || [],
      sig_client: r.sigClient || null, sig_locataire: r.sigLocataire || null,
      updated_at: new Date().toISOString()
    };
    try {
      await supa.upsert('rapports', row);
      toast('Rapport sauvegardé ✓', '#2d9e6b');
    } catch(e) {
      console.warn('Supabase rapport save:', e);
      // Fallback localStorage
      const list = JSON.parse(localStorage.getItem('drt_rapports') || '[]');
      const i = list.findIndex(x => x.id === r.id);
      if (i >= 0) list[i] = r; else list.push(r);
      localStorage.setItem('drt_rapports', JSON.stringify(list));
      toast('⚠ Sauvegardé localement (hors ligne)', '#f4a623');
    }
  },
  async deleteRapport(id) {
    this._cache.rapports = null;
    try { await supa.delete('rapports', `id=eq.${id}`); } catch(e) { console.warn(e); }
  },

  // PHOTOS
  async savePhotos(rapportId, photos) {
    if (!photos || !photos.some(p=>p)) return;
    try {
      // Compresser d'abord
      const compressed = await Promise.all(photos.map(p => compressPhotoAsync(p)));
      // Supprimer anciennes photos
      await supa.delete('photos', `rapport_id=eq.${rapportId}`);
      // Insérer nouvelles
      const rows = compressed.map((data, slot) => data ? { rapport_id: rapportId, slot, data } : null).filter(Boolean);
      if (rows.length) await supa.insert('photos', rows);
    } catch(e) {
      console.warn('Supabase photos save:', e);
      // Fallback localStorage
      const compressed = await Promise.all(photos.map(p => compressPhotoAsync(p)));
      try { localStorage.setItem('drt_photos_' + rapportId, JSON.stringify(compressed)); } catch {}
    }
  },
  async loadPhotos(rapportId) {
    try {
      const rows = await supa.select('photos', `?rapport_id=eq.${rapportId}&order=slot`);
      const arr = [null,null,null,null,null,null];
      rows.forEach(r => { if (r.slot >= 0 && r.slot < 6) arr[r.slot] = r.data; });
      return arr;
    } catch {
      const data = localStorage.getItem('drt_photos_' + rapportId);
      return data ? JSON.parse(data) : [null,null,null,null,null,null];
    }
  },

  // Upload PDF dans Supabase Storage
  async uploadPDF(rapportId, pdfBlob) {
    try {
      const fileName = `${rapportId}.pdf`;
      const res = await fetch(`${SUPA_URL}/storage/v1/object/rapport/${fileName}`, {
        method: 'POST',
        headers: {
          'apikey': SUPA_KEY,
          'Authorization': `Bearer ${SUPA_KEY}`,
          'Content-Type': 'application/pdf',
          'x-upsert': 'true'
        },
        body: pdfBlob
      });
      if (!res.ok) throw new Error(await res.text());
      return `${SUPA_URL}/storage/v1/object/public/rapport/${fileName}`;
    } catch(e) {
      console.warn('PDF upload error:', e);
      return null;
    }
  },
  get techs()    { return JSON.parse(localStorage.getItem('drt_techs') || '["Marc Dubois","Sophie Martin","Jean-Pierre Favre"]'); },
  set techs(v)   { localStorage.setItem('drt_techs', JSON.stringify(v)); this.saveTechs(v); },
  get clients()  { return this._cache.clients || JSON.parse(localStorage.getItem('drt_clients') || '[]'); },
  set clients(v) { localStorage.setItem('drt_clients', JSON.stringify(v)); },
  get locataires(){ return this._cache.locataires || JSON.parse(localStorage.getItem('drt_locataires') || '[]'); },
  set locataires(v){ localStorage.setItem('drt_locataires', JSON.stringify(v)); },
  get rapports() { return this._cache.rapports || JSON.parse(localStorage.getItem('drt_rapports') || '[]'); },
  set rapports(v){ localStorage.setItem('drt_rapports', JSON.stringify(v)); },
  get intervs()  { return this._cache.intervs || JSON.parse(localStorage.getItem('drt_intervs') || '[]'); },
  set intervs(v) {
    this._cache.intervs = v;
    localStorage.setItem('drt_intervs', JSON.stringify(v));
    // Sync Supabase
    this._syncIntervs(v);
  },
  async _syncIntervs(list) {
    try {
      // Upsert toutes les interventions
      if (list.length) await supa.upsert('interventions', list.map(iv => ({
        id: iv.id, date: iv.date, heure: iv.heure || '',
        client_id: iv.clientId || null, client_nom: iv.clientNom || '',
        adresse: iv.adresse || '', nuisible: iv.nuisible || '',
        tech: iv.tech || '', statut: iv.statut || 'Planifiée',
        couleur: iv.couleur || '#1a2744', notes: iv.notes || ''
      })));
    } catch(e) { console.warn('Intervs sync:', e); }
  },
  async getIntervs() {
    try {
      const rows = await supa.select('interventions', '?order=date,heure');
      const list = rows.map(r => ({
        id: r.id, date: r.date, heure: r.heure,
        clientId: r.client_id, clientNom: r.client_nom,
        adresse: r.adresse, nuisible: r.nuisible,
        tech: r.tech, statut: r.statut,
        couleur: r.couleur, notes: r.notes
      }));
      this._cache.intervs = list;
      localStorage.setItem('drt_intervs', JSON.stringify(list));
      return list;
    } catch(e) {
      console.warn('getIntervs:', e);
      return JSON.parse(localStorage.getItem('drt_intervs') || '[]');
    }
  },
};

// Compression photo async — réduit à max 900px largeur, qualité JPEG 0.65
function compressPhotoAsync(dataUrl) {
  return new Promise(resolve => {
    if (!dataUrl) return resolve(null);
    const img = new Image();
    img.onload = () => {
      const MAX = 900;
      let w = img.width, h = img.height;
      if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.65));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// ============================================================
// SEED DATA
// ============================================================
async function seedData() {
  // Charger depuis Supabase
  try {
    showLoading(true);
    const [clients, rapports, locataires, intervs] = await Promise.all([
      DB.getClients(), DB.getRapports(), DB.getLocataires(), DB.getIntervs()
    ]);
    DB._cache.clients = clients;
    DB._cache.rapports = rapports;
    DB._cache.locataires = locataires;
    DB._cache.intervs = intervs;
    localStorage.setItem('drt_clients', JSON.stringify(clients));
    localStorage.setItem('drt_rapports', JSON.stringify(rapports));
    localStorage.setItem('drt_locataires', JSON.stringify(locataires));
    localStorage.setItem('drt_intervs', JSON.stringify(intervs));

    // Seed données exemple si vide
    if (!clients.length) {
      const exemples = [
        { id:'cl1', nom:'Régie Naef SA', type:'Gérance', contact:'M. Naef', tel:'+41 21 320 45 00', email:'naef@naef.ch', adresse:'Av. de la Gare 22', npa:'1003', ville:'Lausanne', notes:'Client VIP', tarif:'150', num:'CLI-001' },
        { id:'cl2', nom:'Mme Véronique Roche', type:'Particulier', contact:'Mme Roche', tel:'+41 79 234 56 78', email:'v.roche@bluewin.ch', adresse:'Rue du Mont-Blanc 14', npa:'1201', ville:'Genève', notes:'', tarif:'120', num:'CLI-002' },
      ];
      for (const c of exemples) await DB.saveClient(c);
      DB._cache.clients = exemples;
    }
    if (!DB.techs.length) DB.techs = ['Marc Dubois', 'Sophie Martin', 'Jean-Pierre Favre'];
  } catch(e) {
    console.warn('Seed data error:', e);
    // Fallback localStorage
    if (!DB.techs.length) DB.techs = ['Marc Dubois', 'Sophie Martin', 'Jean-Pierre Favre'];
  } finally {
    showLoading(false);
  }
}

function showLoading(show) {
  let el = document.getElementById('app-loading');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-loading';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(26,39,68,.85);z-index:9999;display:flex;align-items:center;justify-content:center;color:#fff;font-size:18px;font-weight:700;letter-spacing:1px;';
    el.innerHTML = '<div style="text-align:center;"><div style="font-size:32px;margin-bottom:12px;">🐀</div>Chargement DERATEK...</div>';
    document.body.appendChild(el);
  }
  el.style.display = show ? 'flex' : 'none';
}

// ============================================================
// STATE
// ============================================================
let state = {
  editingRapportId: null,
  editingClientId:  null,
  editingIntervId:  null,
  rapportsFilter:   'Tous',
  clientsFilter:    'Tous',
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
const today = () => new Date().toISOString().split('T')[0];
const genId = () => `R-${new Date().getFullYear()}-${String(DB.rapports.length + 420).padStart(4,'0')}`;
const colorType = t => ({Gérance:'#f4a623',Particulier:'#7c3aed',PPE:'#2d9e6b',Commune:'#2563eb',Entreprise:'#e63946'}[t] || '#6b7280');
const badgeCls = s => ({Brouillon:'b-gray',Envoyé:'b-green',Finalisé:'b-blue',Terminée:'b-green','En cours':'b-blue',Planifiée:'b-gray',Urgent:'b-red',Annulée:'b-gray'}[s] || 'b-gray');
const initials = nom => nom.split(' ').filter(w => w.length > 1).slice(0,2).map(w => w[0].toUpperCase()).join('') || nom.slice(0,2).toUpperCase();

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screen = $(`screen-${name}`);
  if (screen) screen.classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const nb = $(`nb-${name}`);
  if (nb) nb.classList.add('active');
  if (name === 'dashboard')    renderDashboard();
  if (name === 'clients')      renderClients();
  if (name === 'locataires')   renderLocataires();
  if (name === 'rapports')     renderRapports();
  if (name === 'agenda')       renderAgenda();
  window.scrollTo(0, 0);
}

function toggleLocataire() {
  const checked = $('r-avec-locataire') && $('r-avec-locataire').checked;
  const bloc = $('bloc-locataire');
  if (bloc) bloc.style.display = checked ? 'block' : 'none';
  if (!checked) {
    // Vider les champs locataire
    if ($('r-locataire-id')) $('r-locataire-id').value = '';
    if ($('r-locataire')) $('r-locataire').value = '';
    if ($('r-locataire-tel')) $('r-locataire-tel').value = '';
    if ($('r-locataire-email')) $('r-locataire-email').value = '';
    if ($('r-locataire-adresse')) $('r-locataire-adresse').value = '';
    if ($('r-locataire-details')) $('r-locataire-details').style.display = 'none';
    // Réafficher adresse intervention
    if ($('bloc-adresse-details')) $('bloc-adresse-details').style.display = 'none';
    if ($('r-avec-adresse')) $('r-avec-adresse').checked = false;
  }
  updatePDF();
}

function toggleAdresse() {
  const checked = $('r-avec-adresse') && $('r-avec-adresse').checked;
  const bloc = $('bloc-adresse-details');
  if (bloc) bloc.style.display = checked ? 'block' : 'none';
  if (!checked) {
    if ($('r-adresse')) $('r-adresse').value = '';
    if ($('r-npa')) $('r-npa').value = '';
    if ($('r-ville')) $('r-ville').value = '';
  }
  updatePDF();
}

function updateCharCount(fieldId, countId, max) {
  const el = $(fieldId), counter = $(countId);
  if (!el || !counter) return;
  const len = el.value.length;
  counter.textContent = len;
  counter.style.color = len > max * 0.9 ? '#e63946' : len > max * 0.7 ? '#f4a623' : 'var(--g400)';
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
function doLogin() {
  const pwd = $('login-pwd').value;
  if (pwd === DERATEK_CONFIG.password) {
    $('login-screen').style.display = 'none';
    $('app').style.display = 'block';
    emailjs.init(DERATEK_CONFIG.emailjs.publicKey);
    seedData().then(() => {
      renderDashboard();
    });
  } else {
    $('login-error').style.display = 'block';
    $('login-pwd').value = '';
    $('login-pwd').focus();
  }
}
function doLogout() {
  $('app').style.display = 'none';
  $('login-screen').style.display = 'flex';
  $('login-pwd').value = '';
  $('login-error').style.display = 'none';
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
  const totalCA = rapports.filter(r => r.statut === 'Envoyé').reduce((a,r) => a + (parseFloat(r.montant)||0), 0);

  const ds = $('dash-stats');
  if (ds) ds.innerHTML = [
    { lbl: 'Total rapports', val: rapports.length, color: '' },
    { lbl: 'Brouillons', val: brouillon, color: 'color:var(--red)' },
    { lbl: 'Envoyés', val: rapports.filter(r => r.statut === 'Envoyé').length, color: 'color:var(--green)' },
    { lbl: 'Clients', val: clients.length, color: '' },
    { lbl: 'CA facturé', val: `${totalCA.toFixed(0)} CHF`, color: 'color:var(--green);font-size:18px' },
  ].map(s => `<div class="stat-card"><div class="stat-lbl">${s.lbl}</div><div class="stat-val" style="${s.color}">${s.val}</div></div>`).join('');

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

  // Upcoming — interventions agenda + RDV rapports
  const di = $('dash-intervs');
  if (di) {
    const upcoming = DB.intervs.filter(iv => iv.date >= today()).sort((a,b) => (a.date+a.heure).localeCompare(b.date+b.heure)).slice(0,5);

    // Ajouter les RDV des rapports
    const rdvRapports = DB.rapports
      .filter(r => r.rdv && r.rdv >= today())
      .sort((a,b) => a.rdv.localeCompare(b.rdv))
      .slice(0, 5)
      .map(r => ({
        type: 'rdv',
        id: r.id,
        date: r.rdv,
        heure: '—',
        clientNom: r.clientNom || '—',
        nuisible: (r.nuisibles||[]).join(', ') || 'Suivi',
        statut: 'Planifiée',
        couleur: '#f4a623'
      }));

    // Fusionner et trier
    const all = [...upcoming, ...rdvRapports]
      .sort((a,b) => a.date.localeCompare(b.date))
      .slice(0, 6);

    di.innerHTML = all.length ? all.map(iv => `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--g100);cursor:pointer;" onclick="${iv.type === 'rdv' ? `editRapport('${iv.id}')` : `openEditInterv('${iv.id}')`}">
        <div style="width:10px;height:10px;border-radius:50%;background:${iv.couleur||'#1a2744'};flex-shrink:0;"></div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:12px;">${iv.clientNom||'—'} ${iv.type==='rdv' ? '<span style="font-size:10px;background:#fff3cd;color:#856404;padding:1px 6px;border-radius:4px;margin-left:4px;">RDV rapport</span>' : ''}</div>
          <div style="font-size:11px;color:var(--g400);">${fmtDate(iv.date)}${iv.heure && iv.heure !== '—' ? ' à '+iv.heure : ''} · ${iv.nuisible}</div>
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
  $('agenda-period').textContent = `${fmtDate(weekDates[0].toISOString().split('T')[0])} — ${fmtDate(weekDates[6].toISOString().split('T')[0])}`;
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
      const dateStr = d.toISOString().split('T')[0];
      const cellIvs = DB.intervs.filter(iv => iv.date === dateStr && iv.heure && iv.heure.substring(0,2) === h.substring(0,2));
      html += `<div class="ag-day-cell" data-date="${dateStr}" data-heure="${h}" onclick="handleAgCell(this)">`;
      cellIvs.forEach(iv => {
        html += `<div class="ag-event" style="background:${iv.couleur}" data-id="${iv.id}" onclick="event.stopPropagation();handleAgEvent(this)" title="${iv.clientNom} — ${iv.nuisible}">${iv.heure} ${iv.clientNom}</div>`;
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
  const todayStr = new Date().toISOString().split('T')[0];
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
      html += `<div class="cal-ev" style="background:${iv.couleur}" data-id="${iv.id}" onclick="event.stopPropagation();handleAgEvent(this)">${iv.heure} ${iv.clientNom}</div>`;
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
function handleAgEvent(el) { if (el.dataset.id) openEditInterv(el.dataset.id); }

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
  ['iv-adresse','iv-nuisible','iv-notes'].forEach(id => { const el=$(id); if(el) el.value=''; });
  if ($('iv-type')) $('iv-type').value = '1ère intervention';
  $('iv-statut').value = 'Planifiée';
  $('iv-delete-btn').style.display = 'none';
  if ($('iv-locataire-info')) $('iv-locataire-info').style.display = 'none';
  state.selectedColor = '#e63946';
  document.querySelectorAll('#iv-colors .color-opt').forEach(c => c.classList.remove('selected'));
  const defColor = document.querySelector('#iv-colors .color-opt[data-color="#e63946"]');
  if (defColor) defColor.classList.add('selected');
  populateClientSelectInterv('');
  populateTechSelectInterv('');
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
  if ($('iv-type')) $('iv-type').value = iv.typeIntervention || '1ère intervention';
  $('iv-delete-btn').style.display = 'inline-flex';
  state.selectedColor = iv.couleur || '#e63946';
  document.querySelectorAll('#iv-colors .color-opt').forEach(c => {
    c.classList.toggle('selected', c.dataset.color === state.selectedColor);
  });
  populateClientSelectInterv(iv.clientId);
  populateTechSelectInterv(iv.tech);
  populateLocataireSelectInterv(iv.locataireId);
  // Afficher infos locataire si existant
  if (iv.locataireId) {
    const l = DB.locataires.find(x => x.id === iv.locataireId);
    if (l && $('iv-locataire-info')) {
      $('iv-loc-adresse').value = (l.adresse||'') + (l.npa?' '+l.npa:'') + (l.ville?' '+l.ville:'');
      $('iv-loc-tel').value = l.tel || '';
      $('iv-locataire-info').style.display = 'flex';
    }
  }
  openModal('modal-interv');
}

function populateClientSelectInterv(selectedId) {
  const sel = $('iv-client'); if (!sel) return;
  sel.innerHTML = '<option value="">-- Sélectionner --</option>' +
    DB.clients.map(c => `<option value="${c.id}"${c.id === selectedId ? ' selected' : ''}>${c.nom}</option>`).join('');
}

function populateTechSelectInterv(selectedTech) {
  const sel = $('iv-tech'); if (!sel) return;
  sel.innerHTML = '<option value="">-- Sélectionner --</option>' +
    DB.techs.map(t => `<option value="${t}"${t === selectedTech ? ' selected' : ''}>${t}</option>`).join('');
}

function populateLocataireSelectInterv(selectedId) {
  const sel = $('iv-locataire'); if (!sel) return;
  sel.innerHTML = '<option value="">-- Aucun locataire --</option>' +
    DB.locataires.map(l => `<option value="${l.id}"${l.id === selectedId ? ' selected' : ''}>${l.prenom} ${l.nom}</option>`).join('');
}

function onIvClientChange() {
  const clientId = $('iv-client').value;
  populateLocataireSelectInterv('');
  if ($('iv-locataire-info')) $('iv-locataire-info').style.display = 'none';
}

function onIvLocataireChange() {
  const id = $('iv-locataire').value;
  const info = $('iv-locataire-info');
  if (!id) { if (info) info.style.display = 'none'; return; }
  const l = DB.locataires.find(x => x.id === id);
  if (l) {
    $('iv-loc-adresse').value = (l.adresse||'') + (l.npa?' '+l.npa:'') + (l.ville?' '+l.ville:'');
    $('iv-loc-tel').value = l.tel || '';
    if (info) info.style.display = 'flex';
  }
}

function saveInterv() {
  const clientId = $('iv-client').value;
  const client = DB.clients.find(c => c.id === clientId);
  const locataireId = $('iv-locataire') ? $('iv-locataire').value : '';
  const locataire = DB.locataires.find(l => l.id === locataireId);
  const iv = {
    id: state.editingIntervId || ('iv' + Date.now()),
    date: $('iv-date').value, heure: $('iv-heure').value,
    clientId, clientNom: client ? client.nom : '',
    locataireId: locataireId || null,
    locataireNom: locataire ? locataire.prenom + ' ' + locataire.nom : '',
    adresse: $('iv-loc-adresse') && locataireId ? $('iv-loc-adresse').value : $('iv-adresse').value,
    nuisible: $('iv-nuisible').value,
    tech: $('iv-tech').value,
    typeIntervention: $('iv-type') ? $('iv-type').value : '1ère intervention',
    statut: $('iv-statut').value,
    couleur: state.selectedColor, notes: $('iv-notes').value,
  };
  if (!iv.date) { toast('La date est obligatoire', '#e63946'); return; }
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
  grid.innerHTML = list.map(c => {
    const nb = rapports.filter(r => r.clientId === c.id).length;
    const totalCA = rapports.filter(r => r.clientId === c.id && r.statut === 'Envoyé').reduce((a,r) => a + (parseFloat(r.montant)||0), 0);
    return `<div class="client-card">
      <div class="client-hd">
        <div class="av av-md" style="background:${colorType(c.type)}">${initials(c.nom)}</div>
        <div class="client-info">
          <div class="client-name">${c.nom}</div>
          <div style="display:flex;gap:6px;align-items:center;">
            <span class="badge b-gray">${c.type}</span>
            ${c.num ? `<span style="font-size:10px;color:var(--g400);">${c.num}</span>` : ''}
          </div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="editClient('${c.id}')">✏️ Modifier</button>
      </div>
      ${c.tel ? `<div class="client-contact-row">📞 ${c.tel}</div>` : ''}
      ${c.email ? `<div class="client-contact-row">✉️ ${c.email}</div>` : ''}
      ${c.ville ? `<div class="client-contact-row">📍 ${c.npa||''} ${c.ville}</div>` : ''}
      ${c.notes ? `<div style="font-size:11px;color:var(--g600);background:var(--g50);padding:7px 9px;border-radius:6px;margin:8px 0;">${c.notes}</div>` : ''}
      <div class="client-stats">
        <div class="cs-box"><div class="cs-val">${nb}</div><div class="cs-lbl">Rapports</div></div>
        <div class="cs-box"><div class="cs-val" style="color:var(--green);font-size:14px;">${totalCA.toFixed(0)}</div><div class="cs-lbl">CHF facturés</div></div>
        <div class="cs-box"><div class="cs-val">${c.tarif||'—'}</div><div class="cs-lbl">CHF/h</div></div>
      </div>
      <div class="client-actions">
        <button class="btn btn-ghost btn-sm" onclick="openNewRapportForClient('${c.id}')">+ Rapport</button>
        <button class="btn btn-red btn-sm btn-xs" onclick="confirmDeleteClient('${c.id}','${c.nom.replace(/'/g,"\\'")}')">🗑</button>
      </div>
    </div>`;
  }).join('');
}
function openNewClient() {
  state.editingClientId = null;
  $('modal-client-title').textContent = 'Nouveau client';
  ['cl-nom','cl-contact','cl-tel','cl-email','cl-web','cl-adresse','cl-npa','cl-ville','cl-num','cl-tarif','cl-notes'].forEach(id => $(id).value = '');
  $('cl-type').value = 'Gérance';
  $('cl-delete-btn').style.display = 'none';
  openModal('modal-client');
}
function editClient(id) {
  state.editingClientId = id;
  const c = DB.clients.find(x => x.id === id); if (!c) return;
  $('modal-client-title').textContent = 'Modifier le client';
  $('cl-nom').value = c.nom; $('cl-type').value = c.type;
  $('cl-contact').value = c.contact||''; $('cl-tel').value = c.tel||'';
  $('cl-email').value = c.email||''; $('cl-web').value = c.web||'';
  $('cl-adresse').value = c.adresse||''; $('cl-npa').value = c.npa||'';
  $('cl-ville').value = c.ville||''; $('cl-num').value = c.num||'';
  $('cl-tarif').value = c.tarif||''; $('cl-notes').value = c.notes||'';
  $('cl-delete-btn').style.display = 'inline-flex';
  openModal('modal-client');
}
function saveClient() {
  const nom = $('cl-nom').value.trim();
  if (!nom) { toast('Le nom est obligatoire', '#e63946'); return; }
  const data = {
    nom, type: $('cl-type').value, contact: $('cl-contact').value,
    tel: $('cl-tel').value, email: $('cl-email').value, web: $('cl-web').value,
    adresse: $('cl-adresse').value, npa: $('cl-npa').value, ville: $('cl-ville').value,
    num: $('cl-num').value, tarif: $('cl-tarif').value, notes: $('cl-notes').value,
  };
  if (state.editingClientId) {
    data.id = state.editingClientId;
  } else {
    data.id = 'cl' + Date.now();
  }
  DB._cache.clients = null;
  DB.saveClient(data).then(() => {
    DB.getClients().then(list => {
      DB._cache.clients = list;
      localStorage.setItem('drt_clients', JSON.stringify(list));
      closeModal('modal-client'); renderClients(); renderDashboard();
      toast(state.editingClientId ? 'Client mis à jour ✓' : 'Client ajouté ✓', '#2d9e6b');
    });
  });
}
function confirmDeleteClient(id, nom) {
  $('confirm-msg').textContent = `Supprimer "${nom}" ? Cette action est irréversible.`;
  $('confirm-btn').onclick = () => {
    DB.deleteClient(id).then(() => {
      DB._cache.clients = null;
      DB.getClients().then(list => { DB._cache.clients = list; closeModal('modal-confirm'); renderClients(); toast('Client supprimé', '#e63946'); });
    });
  };
  openModal('modal-confirm');
}

// ============================================================
// LOCATAIRES
// ============================================================
function renderLocataires() {
  const search = ($('loc-search') ? $('loc-search').value : '').toLowerCase();
  const list = DB.locataires.filter(l =>
    (l.prenom + ' ' + l.nom + ' ' + (l.ville||'')).toLowerCase().includes(search)
  );
  $('locataires-count').textContent = list.length + ' locataire(s)';
  const grid = $('locataires-grid'); if (!grid) return;
  grid.innerHTML = list.length ? list.map(l => {
    const gerance = l.clientId ? (DB.clients.find(c => c.id === l.clientId) || {}).nom || '' : '';
    return `<div class="client-card">
      <div class="client-card-hd">
        <div>
          <div class="client-name">🏠 ${l.prenom} ${l.nom}</div>
          <div class="client-type">${l.adresse||''}${l.npa ? ' '+l.npa : ''}${l.ville ? ' '+l.ville : ''}</div>
        </div>
      </div>
      <div class="client-info">
        ${l.tel ? `<div>📞 ${l.tel}</div>` : ''}
        ${l.email ? `<div>✉️ ${l.email}</div>` : ''}
        ${gerance ? `<div>🏢 ${gerance}</div>` : ''}
      </div>
      <div class="client-ft">
        <button class="btn btn-ghost btn-sm" onclick="editLocataire('${l.id}')">✏️ Modifier</button>
      </div>
    </div>`;
  }).join('') : '<div style="color:var(--g400);padding:20px;text-align:center;">Aucun locataire enregistré</div>';
}

function populateLocClientSelect(selectedId) {
  const sel = $('loc-client'); if (!sel) return;
  sel.innerHTML = '<option value="">-- Aucune gérance --</option>';
  DB.clients.filter(c => c.type === 'Gérance' || c.type === 'PPE' || c.type === 'Entreprise').forEach(c => {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.nom;
    if (c.id === selectedId) o.selected = true;
    sel.appendChild(o);
  });
}

function openNewLocataire() {
  state.editingLocataireId = null;
  $('modal-locataire-title').textContent = 'Nouveau locataire';
  ['loc-prenom','loc-nom','loc-tel','loc-email','loc-adresse','loc-npa','loc-ville','loc-notes'].forEach(id => { if ($(id)) $(id).value = ''; });
  populateLocClientSelect('');
  $('loc-delete-btn').style.display = 'none';
  openModal('modal-locataire');
}

function editLocataire(id) {
  state.editingLocataireId = id;
  const l = DB.locataires.find(x => x.id === id); if (!l) return;
  $('modal-locataire-title').textContent = 'Modifier le locataire';
  $('loc-prenom').value = l.prenom||''; $('loc-nom').value = l.nom||'';
  $('loc-tel').value = l.tel||''; $('loc-email').value = l.email||'';
  $('loc-adresse').value = l.adresse||''; $('loc-npa').value = l.npa||'';
  $('loc-ville').value = l.ville||''; $('loc-notes').value = l.notes||'';
  populateLocClientSelect(l.clientId||'');
  $('loc-delete-btn').style.display = 'inline-flex';
  openModal('modal-locataire');
}

function saveLocataire() {
  const prenom = $('loc-prenom').value.trim(), nom = $('loc-nom').value.trim();
  if (!prenom || !nom) { toast('Prénom et nom obligatoires', '#e63946'); return; }
  const data = {
    prenom, nom, tel: $('loc-tel').value, email: $('loc-email').value,
    adresse: $('loc-adresse').value, npa: $('loc-npa').value, ville: $('loc-ville').value,
    clientId: $('loc-client').value, notes: $('loc-notes').value,
    id: state.editingLocataireId || ('loc' + Date.now()),
  };
  DB._cache.locataires = null;
  DB.saveLocataire(data).then(() => {
    DB.getLocataires().then(list => {
      DB._cache.locataires = list;
      localStorage.setItem('drt_locataires', JSON.stringify(list));
      closeModal('modal-locataire');
      renderLocataires();
      populateLocataireSelectRapport('');
      toast(state.editingLocataireId ? 'Locataire mis à jour ✓' : 'Locataire ajouté ✓', '#2d9e6b');
    });
  });
}

function confirmDeleteLocataire(id) {
  $('confirm-msg').textContent = 'Supprimer ce locataire ? Cette action est irréversible.';
  $('confirm-btn').onclick = () => {
    DB.deleteLocataire(id).then(() => {
      DB._cache.locataires = null;
      DB.getLocataires().then(list => { DB._cache.locataires = list; closeModal('modal-confirm'); closeModal('modal-locataire'); renderLocataires(); toast('Locataire supprimé', '#e63946'); });
    });
  };
  openModal('modal-confirm');
}

function populateLocataireSelectRapport(selectedId) {
  const sel = $('r-locataire-id'); if (!sel) return;
  sel.innerHTML = '<option value="">-- Aucun locataire --</option>';
  DB.locataires.forEach(l => {
    const o = document.createElement('option');
    o.value = l.id; o.textContent = l.prenom + ' ' + l.nom + (l.ville ? ' — ' + l.ville : '');
    if (l.id === selectedId) o.selected = true;
    sel.appendChild(o);
  });
}

function onLocataireChange() {
  const id = $('r-locataire-id').value;
  const details = $('r-locataire-details');
  if (!id) {
    if (details) details.style.display = 'none';
    updatePDF();
    return;
  }
  const l = DB.locataires.find(x => x.id === id);
  if (l && details) {
    details.style.display = 'block';
    if ($('r-locataire')) $('r-locataire').value = l.prenom + ' ' + l.nom;
    if ($('r-locataire-tel')) $('r-locataire-tel').value = l.tel || '';
    if ($('r-locataire-email')) $('r-locataire-email').value = l.email || '';
    if ($('r-locataire-adresse')) $('r-locataire-adresse').value = (l.adresse||'') + (l.npa?' '+l.npa:'') + (l.ville?' '+l.ville:'');
    // Remplir adresse d'intervention avec celle du locataire et cocher
    if (l.adresse) {
      if ($('r-avec-adresse')) $('r-avec-adresse').checked = true;
      if ($('bloc-adresse-details')) $('bloc-adresse-details').style.display = 'block';
      if ($('r-adresse')) $('r-adresse').value = l.adresse || '';
      if ($('r-npa')) $('r-npa').value = l.npa || '';
      if ($('r-ville')) $('r-ville').value = l.ville || '';
    }
  }
  updatePDF();
}

// ============================================================
// RAPPORTS LIST
// ============================================================
function renderRapports() {
  const q = ($('rapp-search') || {}).value || '';
  const list = DB.rapports.filter(r => {
    const m = r.id.toLowerCase().includes(q.toLowerCase()) || (r.clientNom||'').toLowerCase().includes(q.toLowerCase()) || (r.nuisibles||[]).join(' ').toLowerCase().includes(q.toLowerCase());
    return m && (state.rapportsFilter === 'Tous' || r.statut === state.rapportsFilter);
  }).slice().reverse();
  const tb = $('rapports-tbody');
  if (!tb) return;
  tb.innerHTML = list.length ? list.map(r => `
    <tr onclick="editRapport('${r.id}')">
      <td style="font-weight:700;color:var(--navy);">${r.id}</td>
      <td>${r.clientNom||'—'}</td>
      <td>${(r.nuisibles||[]).join(', ')||'—'}</td>
      <td>${fmtDate(r.date)}</td>
      <td>${r.tech||'—'}</td>
      <td>${r.montant ? r.montant+' CHF' : '—'}</td>
      <td><span class="badge ${badgeCls(r.statut)}">${r.statut}</span></td>
      <td><button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();confirmDeleteRapport('${r.id}')">🗑</button></td>
    </tr>`).join('')
  : '<tr><td colspan="8"><div class="empty"><div class="empty-icon">📋</div><div class="empty-text">Aucun rapport</div></div></td></tr>';
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
  populateLocataireSelectRapport('');
  if ($('r-locataire-details')) $('r-locataire-details').style.display = 'none';
  if ($('bloc-locataire')) $('bloc-locataire').style.display = 'none';
  if ($('r-avec-locataire')) $('r-avec-locataire').checked = false;
  if ($('bloc-adresse-details')) $('bloc-adresse-details').style.display = 'none';
  if ($('r-avec-adresse')) $('r-avec-adresse').checked = false;
  ['r-contact','r-tel','r-email','r-adresse','r-npa','r-ville','r-localisation',
   'r-description','r-origine','r-contraintes','r-produits','r-precautions',
   'r-recommandations','r-rdv','r-noint','r-superficie','r-pieces','r-zones',
   'r-duree','r-montant','r-bon-commande','r-locataire','r-locataire-tel',
   'r-locataire-email','r-locataire-adresse','r-volume','r-garantie-note',
   'r-materiel-comment'].forEach(id => { const el = $(id); if (el) el.value = ''; });
  [0,1,2,3,4,5].forEach(i => { const el = $('r-photo-comment-'+i); if (el) el.value = ''; });
  state.materiels = [];
  clearSigClient(); clearSigLocataire();
  ['r-niveau','r-resultat','r-batiment','r-garantie'].forEach(id => { const el = $(id); if (el) el.value = ''; });
  if ($('r-show-prix')) $('r-show-prix').checked = true;
  document.querySelectorAll('#tab-nuisibles input[type=checkbox]').forEach(c => c.checked = false);
  ['t-pulv','t-vapeur','t-thermique','t-injection','t-appats','t-monitoring','t-desinfect','t-flocage','t-gel','t-poudre','t-fumigation','t-pose'].forEach(id => { const el = $(id); if (el) el.checked = false; });
  renderProduits(); renderMateriels(); resetPhotoGrid(); clearSig();
  $('edit-id').textContent = newId;
  $('edit-status').className = 'badge b-gray'; $('edit-status').textContent = 'Brouillon';
  $('edit-meta').textContent = '';
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
  // Charger photos depuis Supabase (async)
  state.photos = [null,null,null,null,null,null];
  DB.loadPhotos(r.id).then(photos => {
    state.photos = photos;
    resetPhotoGrid();
  });
  $('r-id').value = r.id; $('r-date').value = r.date || today();
  populateTechSelect($('r-tech'), r.tech || '');
  populateClientSelectRapport(r.clientId);
  ['r-contact','r-tel','r-email','r-adresse','r-npa','r-ville','r-localisation','r-batiment','r-noint','r-description','r-origine','r-contraintes','r-zones','r-precautions','r-duree','r-montant','r-recommandations','r-rdv'].forEach(id => {
    const el = $(id); const key = id.replace('r-','');
    if (el) el.value = r[key] || '';
  });
  if ($('r-bon-commande')) $('r-bon-commande').value = r.bonCommande || '';
  if ($('r-locataire')) $('r-locataire').value = r.locataire || '';
  if ($('r-locataire-tel')) $('r-locataire-tel').value = r.locataireTel || '';
  if ($('r-locataire-email')) $('r-locataire-email').value = r.locataireEmail || '';
  if ($('r-locataire-adresse')) $('r-locataire-adresse').value = r.locataireAdresse || '';
  if ($('r-show-prix')) $('r-show-prix').checked = r.showPrix !== false;
  if ($('r-volume')) $('r-volume').value = r.volume || '';
  if ($('r-garantie-note')) $('r-garantie-note').value = r.garantieNote || '';
  if ($('r-materiel-comment')) $('r-materiel-comment').value = r.materielComment || '';
  [0,1,2,3,4,5].forEach(i => { const el = $('r-photo-comment-'+i); if (el) el.value = (r.photoComments||[])[i] || ''; });
  state.materiels = r.materiels ? JSON.parse(JSON.stringify(r.materiels)) : [];
  populateLocataireSelectRapport(r.locataireId || '');
  if ($('r-locataire-details')) $('r-locataire-details').style.display = r.locataire ? 'block' : 'none';
  if ($('bloc-locataire')) $('bloc-locataire').style.display = r.locataire ? 'block' : 'none';
  if ($('r-avec-locataire')) $('r-avec-locataire').checked = !!r.locataire;
  const hasAdresse = !!(r.adresse);
  if ($('bloc-adresse-details')) $('bloc-adresse-details').style.display = hasAdresse ? 'block' : 'none';
  if ($('r-avec-adresse')) $('r-avec-adresse').checked = hasAdresse;
  // Restaurer signatures
  if (r.sigClient && $('sig-client')) {
    const img = new Image(); img.onload = () => $('sig-client').getContext('2d').drawImage(img,0,0); img.src = r.sigClient;
  }
  if (r.sigLocataire && $('sig-locataire')) {
    const img = new Image(); img.onload = () => $('sig-locataire').getContext('2d').drawImage(img,0,0); img.src = r.sigLocataire;
  }
  ['r-niveau','r-resultat','r-garantie','r-superficie','r-pieces'].forEach(id => {
    const el = $(id); const key = id.replace('r-','');
    if (el) el.value = r[key] || '';
  });
  document.querySelectorAll('#tab-nuisibles input[type=checkbox]').forEach(c => c.checked = (r.nuisibles||[]).includes(c.value));
  ['t-pulv','t-vapeur','t-thermique','t-injection','t-appats','t-monitoring','t-desinfect','t-flocage','t-gel','t-poudre','t-fumigation','t-pose'].forEach(id => { const el = $(id); if (el) el.checked = (r.traitement||[]).includes(id); });
  $('edit-id').textContent = r.id;
  $('edit-status').className = 'badge ' + badgeCls(r.statut); $('edit-status').textContent = r.statut;
  $('edit-meta').textContent = (r.clientNom || '') + (r.date ? ' · ' + fmtDate(r.date) : '');
  renderProduits(); renderMateriels(); resetPhotoGrid(); clearSig(); showTab('infos'); updatePDF();
  showScreen('rapport-edit');
}
function onClientChange() {
  const id = $('r-client').value;
  const c = DB.clients.find(x => x.id === id);
  if (c) {
    if (!$('r-tel').value)    $('r-tel').value    = c.tel || '';
    if (!$('r-email').value)  $('r-email').value  = c.email || '';
    if (!$('r-contact').value) $('r-contact').value = c.contact || '';
    if (!$('r-adresse').value) {
      $('r-adresse').value = c.adresse || '';
      $('r-npa').value     = c.npa || '';
      $('r-ville').value   = c.ville || '';
    }
  }
  updatePDF();
}

// ============================================================
// SAVE RAPPORT
// ============================================================
function saveRapport(statut) {
  const nuisibles = [];
  document.querySelectorAll('#tab-nuisibles input[type=checkbox]:checked').forEach(c => nuisibles.push(c.value));
  const traitement = [], traitementLabels = [];
  const tLabels = {'t-pulv':'Pulvérisation','t-vapeur':'Vapeur','t-thermique':'Thermique','t-injection':'Injection','t-appats':'Appâts/pièges','t-monitoring':'Monitoring','t-desinfect':'Désinfection','t-flocage':'Flocage','t-gel':'Gel','t-poudre':'Poudre','t-fumigation':'Fumigation','t-pose':'Pièges mécaniques'};
  ['t-pulv','t-vapeur','t-thermique','t-injection','t-appats','t-monitoring','t-desinfect','t-flocage','t-gel','t-poudre','t-fumigation','t-pose'].forEach(id => { const el = $(id); if (el && el.checked) { traitement.push(id); traitementLabels.push(tLabels[id]); } });

  const clientId  = $('r-client').value;
  const client    = DB.clients.find(c => c.id === clientId);
  const clientNom = client ? client.nom : '';
  const r = {
    id: $('r-id').value, clientId, clientNom, clientEmail: $('r-email').value,
    date: $('r-date').value, tech: $('r-tech').value,
    contact: $('r-contact').value, tel: $('r-tel').value, email: $('r-email').value,
    adresse: $('r-adresse').value, npa: $('r-npa').value, ville: $('r-ville').value,
    localisation: $('r-localisation').value, batiment: $('r-batiment').value, noint: $('r-noint').value,
    avecLocataire: $('r-avec-locataire') ? $('r-avec-locataire').checked : false,
    avecAdresse: $('r-avec-adresse') ? $('r-avec-adresse').checked : false,
    bonCommande: $('r-bon-commande') ? $('r-bon-commande').value : '',
    locataireId: $('r-locataire-id') ? $('r-locataire-id').value : '',
    locataire: $('r-locataire') ? $('r-locataire').value : '',
    locataireTel: $('r-locataire-tel') ? $('r-locataire-tel').value : '',
    locataireEmail: $('r-locataire-email') ? $('r-locataire-email').value : '',
    locataireAdresse: $('r-locataire-adresse') ? $('r-locataire-adresse').value : '',
    showPrix: $('r-show-prix') ? $('r-show-prix').checked : true,
    volume: $('r-volume') ? $('r-volume').value : '',
    photos: [], // photos stockées séparément via DB.savePhotos
    photoComments: [0,1,2,3,4,5].map(i => $('r-photo-comment-'+i) ? $('r-photo-comment-'+i).value : ''),
    materiels: JSON.parse(JSON.stringify(state.materiels || [])),
    materielComment: $('r-materiel-comment') ? $('r-materiel-comment').value : '',
    garantieNote: $('r-garantie-note') ? $('r-garantie-note').value : '',
    sigClient: $('sig-client') ? $('sig-client').toDataURL() : '',
    sigLocataire: $('sig-locataire') ? $('sig-locataire').toDataURL() : '',
    nuisibles, description: $('r-description').value, niveau: $('r-niveau').value,
    superficie: $('r-superficie').value, pieces: $('r-pieces').value, zones: $('r-zones').value,
    origine: $('r-origine').value, contraintes: $('r-contraintes').value,
    traitement, produits: JSON.parse(JSON.stringify(state.produits)),
    precautions: $('r-precautions').value, duree: $('r-duree').value, montant: $('r-montant').value,
    resultat: $('r-resultat').value, recommandations: $('r-recommandations').value,
    rdv: $('r-rdv').value, garantie: $('r-garantie').value, statut,
  };
  const list = DB.rapports;
  const i = list.findIndex(x => x.id === state.editingRapportId);
  if (i >= 0) list[i] = r; else list.push(r);
  DB._cache.rapports = null;
  state.editingRapportId = r.id;
  // Sauvegarder dans Supabase
  DB.saveRapport(r);
  // Sauvegarder photos séparément (compressées)
  if (state.photos && state.photos.some(p=>p)) {
    DB.savePhotos(r.id, state.photos);
  }
  // RDV → agenda automatique
  if (r.rdv && statut !== 'Brouillon') {
    const rdvId = 'rdv_' + r.id;
    const rdvExists = DB.intervs.find(iv => iv.id === rdvId);
    if (!rdvExists) {
      const rdvIv = {
        id: rdvId, rapportId: r.id, isRdv: true,
        date: r.rdv, heure: '09:00',
        clientId: r.clientId, clientNom: r.clientNom || '—',
        locataireId: r.locataireId || null,
        locataireNom: r.locataire || '',
        adresse: r.locataireAdresse || r.adresse || '',
        nuisible: (r.nuisibles||[]).join(', ') || '—',
        tech: r.tech || '',
        typeIntervention: '2ème intervention',
        statut: 'Planifiée', couleur: '#f4a623',
        notes: `RDV automatique — rapport ${r.id}`,
      };
      // Sauvegarder dans Supabase directement
      supa.upsert('interventions', {
        id: rdvIv.id, date: rdvIv.date, heure: rdvIv.heure,
        client_id: rdvIv.clientId, client_nom: rdvIv.clientNom,
        adresse: rdvIv.adresse, nuisible: rdvIv.nuisible,
        tech: rdvIv.tech, statut: rdvIv.statut,
        couleur: rdvIv.couleur, notes: rdvIv.notes
      }).then(() => {
        // Mettre à jour le cache local
        DB._cache.intervs = null;
        DB.getIntervs().then(list => {
          DB._cache.intervs = list;
          localStorage.setItem('drt_intervs', JSON.stringify(list));
          renderDashboard();
        });
      }).catch(e => console.warn('RDV Supabase:', e));
      // Aussi en local immédiatement
      const ivList = DB.intervs;
      ivList.push(rdvIv);
      DB._cache.intervs = ivList;
      localStorage.setItem('drt_intervs', JSON.stringify(ivList));
      toast('📅 RDV du ' + fmtDate(r.rdv) + ' ajouté à l\'agenda !', '#f4a623');
    }
  }
  $('edit-id').textContent = r.id;
  $('edit-status').className = 'badge ' + badgeCls(statut); $('edit-status').textContent = statut;

  if (statut === 'Envoyé') {
    toast('Envoi en cours...', '#f4a623');
    const produitsStr = state.produits.length
      ? state.produits.map(p => `• ${p.nom||''}${p.dosage ? ' — '+p.dosage : ''}${p.zone ? ' ('+p.zone+')' : ''}`).join('\n')
      : '—';
    const materielsStr = (state.materiels||[]).length
      ? state.materiels.map(m => `• ${m.nom||''}${m.qte ? ' × '+m.qte : ''}${m.zone ? ' — '+m.zone : ''}`).join('\n')
      : '—';
    const photoCommentsStr = (r.photoComments||[]).filter(c=>c).length
      ? (r.photoComments||[]).map((c,i) => c ? `Photo ${i+1} : ${c}` : '').filter(Boolean).join('\n')
      : '—';
    const superficieStr = (r.superficie ? r.superficie+' m²' : '') + (r.volume ? ' / '+r.volume+' m³' : '') + (r.pieces ? ' / '+r.pieces+' pièce(s)' : '') || '—';
    const params = {
      rapport_id:        r.id,
      date:              fmtDate(r.date),
      technicien:        r.tech || '—',
      // Client
      client_nom:        clientNom || '—',
      contact:           r.contact || '—',
      tel:               r.tel || '—',
      adresse:           (r.adresse||'') + (r.npa?' '+r.npa:'') + (r.ville?' '+r.ville:''),
      bon_commande:      r.bonCommande || '—',
      // Locataire
      locataire:         r.locataire || '—',
      locataire_tel:     r.locataireTel || '—',
      locataire_email:   r.locataireEmail || '—',
      locataire_adresse: r.locataireAdresse || '—',
      // Intervention
      noint:             r.noint || '—',
      batiment:          r.batiment || '—',
      localisation:      r.localisation || '—',
      superficie:        superficieStr,
      zones:             r.zones || '—',
      // Nuisibles
      nuisibles:         nuisibles.join(', ') || '—',
      niveau:            r.niveau || '—',
      // Observations
      description:       r.description || '—',
      origine:           r.origine || '—',
      contraintes:       r.contraintes || '—',
      // Traitement
      traitement:        traitementLabels.join(', ') || '—',
      produits:          produitsStr,
      materiels:         materielsStr,
      materiel_comment:  r.materielComment || '—',
      precautions:       r.precautions || '—',
      // Résultat
      resultat:          r.resultat || '—',
      recommandations:   r.recommandations || '—',
      // Facturation
      duree:             r.duree ? r.duree + ' heure(s)' : '—',
      montant:           (r.showPrix !== false && r.montant) ? r.montant + ' CHF' : '(non communiqué)',
      rdv:               r.rdv ? fmtDate(r.rdv) : '—',
      garantie:          r.garantie || '—',
      garantie_note:     r.garantieNote || '—',
      // Photos
      photo_comments:    photoCommentsStr,
      // Lien PDF — sera mis à jour après upload
      pdf_link:          '⏳ Génération en cours...',
      // Email
      email:             DERATEK_CONFIG.email.deratek,
      name:              r.tech || 'DERATEK',
    };

    // Générer et uploader le PDF, puis envoyer l'email avec le lien
    toast('Génération et upload du PDF...', '#f4a623');
    (async () => {
      try {
        // Charger les photos
        const photos = state.photos && state.photos.some(p=>p)
          ? state.photos
          : await DB.loadPhotos(r.id).catch(() => []);

        // Générer le PDF
        const rPdf = { ...r, photos };
        const doc = generatePDF(rPdf);
        let pdfLink = null;

        if (doc) {
          // Convertir en Blob
          const pdfBlob = doc.output('blob');
          // Uploader dans Supabase Storage
          pdfLink = await DB.uploadPDF(r.id, pdfBlob);
        }

        // Ajouter le lien dans les params — URL propre pour le bouton HTML
        params.pdf_link = pdfLink || '';
        params.pdf_url  = pdfLink || '';

        // Envoyer l'email uniquement à info@deratek.ch
        await emailjs.send(DERATEK_CONFIG.emailjs.serviceId, DERATEK_CONFIG.emailjs.templateId, params);
        toast('Rapport envoyé avec PDF ✓', '#2d9e6b');
      } catch(err) {
        console.error('Envoi error:', err);
        toast('Rapport sauvegardé — email échoué', '#f4a623');
      }
      setTimeout(() => showScreen('rapports'), 1500);
    })();
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
  const tL = {'t-pulv':'Pulvérisation','t-vapeur':'Vapeur','t-thermique':'Thermique','t-injection':'Injection','t-appats':'Appâts','t-monitoring':'Monitoring','t-desinfect':'Désinfection','t-flocage':'Flocage','t-gel':'Gel','t-poudre':'Poudre','t-fumigation':'Fumigation','t-pose':'Pièges'};
  ['t-pulv','t-vapeur','t-thermique','t-injection','t-appats','t-monitoring','t-desinfect','t-flocage','t-gel','t-poudre','t-fumigation','t-pose'].forEach(id => { const el = $(id); if (el && el.checked) traitement.push(tL[id]); });
  const st = (id, val) => { const el = $(id); if (el) el.textContent = val || '—'; };
  st('pdf-id',    $('r-id').value);
  st('pdf-date',  fmtDate($('r-date').value));
  st('pdf-tech',  $('r-tech').value);
  st('pdf-client', clientNom === '-- Sélectionner un client --' ? '—' : clientNom);

  // Bon de commande
  const bonCommande = $('r-bon-commande') ? $('r-bon-commande').value.trim() : '';
  const bcPrev = $('pdf-bon-commande-prev');
  if (bcPrev) { bcPrev.style.display = bonCommande ? 'block' : 'none'; bcPrev.textContent = bonCommande ? '📋 BC : ' + bonCommande : ''; }

  // Locataire
  const locataire = $('r-locataire') ? $('r-locataire').value.trim() : '';
  const locPrev = $('pdf-locataire-prev');
  if (locPrev) { locPrev.style.display = locataire ? 'block' : 'none'; locPrev.textContent = locataire ? '🏠 Locataire : ' + locataire : ''; }

  const adr = $('r-adresse').value, npa = $('r-npa').value, ville = $('r-ville').value;
  st('pdf-adresse', adr ? adr + (npa?' '+npa:'') + (ville?' '+ville:'') : '—');
  const pn = $('pdf-nuisibles');
  if (pn) pn.innerHTML = nuisibles.length
    ? nuisibles.map(n => `<span style="background:var(--red);color:#fff;font-size:8px;padding:1px 6px;border-radius:3px;display:inline-block;margin:1px;">${n}</span>`).join('')
    : '<span style="color:var(--g400);font-size:10px;">Aucun</span>';
  const sup = $('r-superficie').value, pie = $('r-pieces').value, vol = $('r-volume') ? $('r-volume').value : '';
  let supTxt = sup ? sup+'m²' : '—';
  if (vol) supTxt += ' / '+vol+'m³';
  if (pie) supTxt += ' / '+pie+' pièce(s)';
  st('pdf-superficie', supTxt);
  st('pdf-niveau',      $('r-niveau').value);
  const desc = $('r-description').value || '—';
  st('pdf-description', desc.substring(0,200) + (desc.length > 200 ? '…' : ''));
  st('pdf-traitement',  traitement.join(', ') || '—');

  // Coche prix
  const showPrix = $('r-show-prix') ? $('r-show-prix').checked : true;
  const montantBlock = $('pdf-montant-block');
  const montantEl = $('pdf-montant');
  if (montantBlock) montantBlock.style.display = showPrix ? '' : 'none';
  if (montantEl) { montantEl.style.display = showPrix ? '' : 'none'; if (showPrix) { const montant = $('r-montant').value; st('pdf-montant', montant ? montant+' CHF' : '—'); } }

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
// MATÉRIELS
// ============================================================
const MATERIEL_OPTIONS = [
  'Boîtes d\'appâtage sécurisées souris',
  'Boîtes d\'appâtage sécurisées rats',
  'Grilles de protection',
  'Pièges mécaniques souris',
  'Pièges mécaniques rats',
  'Pièges à colle',
  'Pièges à phéromones',
  'Distributeurs de gel',
  'Autres'
];
function renderMateriels() {
  const el = $('materiels-list'); if (!el) return;
  el.innerHTML = (state.materiels||[]).length
    ? state.materiels.map((m,i) => `
      <div style="display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:8px;margin-bottom:8px;align-items:center;">
        <select class="form-input" oninput="state.materiels[${i}].nom=this.value">
          ${MATERIEL_OPTIONS.map(o => `<option${o===m.nom?' selected':''}>${o}</option>`).join('')}
        </select>
        <input class="form-input" value="${m.qte||''}" placeholder="Qté" type="number" min="1" oninput="state.materiels[${i}].qte=this.value"/>
        <input class="form-input" value="${m.zone||''}" placeholder="Emplacement" oninput="state.materiels[${i}].zone=this.value"/>
        <button class="btn btn-ghost btn-xs" data-idx="${i}" onclick="deleteMateriel(this)">✕</button>
      </div>`).join('')
    : '<div style="font-size:12px;color:var(--g400);padding:8px 0;">Aucun matériel ajouté</div>';
}
function addMateriel() {
  if (!state.materiels) state.materiels = [];
  state.materiels.push({ nom: MATERIEL_OPTIONS[0], qte:'1', zone:'' });
  renderMateriels();
}
function deleteMateriel(el) {
  state.materiels.splice(parseInt(el.dataset.idx), 1);
  renderMateriels();
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
  const canvas = $('sig-canvas'); if (!canvas) return;
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
function clearSig() { const c = $('sig-canvas'); if (c) c.getContext('2d').clearRect(0,0,c.width,c.height); }

function initSigCanvas(canvasId, stateKey) {
  const canvas = $(canvasId); if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#1a2744'; ctx.lineWidth = 2; ctx.lineCap = 'round';
  let drawing = false;
  const gp = e => { const r = canvas.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return { x: (t.clientX-r.left)*(canvas.width/r.width), y: (t.clientY-r.top)*(canvas.height/r.height) }; };
  canvas.addEventListener('mousedown',  e => { drawing = true; const p = gp(e); ctx.beginPath(); ctx.moveTo(p.x,p.y); });
  canvas.addEventListener('mousemove',  e => { if (!drawing) return; const p = gp(e); ctx.lineTo(p.x,p.y); ctx.stroke(); });
  canvas.addEventListener('mouseup',    () => drawing = false);
  canvas.addEventListener('mouseleave', () => drawing = false);
  canvas.addEventListener('touchstart', e => { e.preventDefault(); drawing = true; const p = gp(e); ctx.beginPath(); ctx.moveTo(p.x,p.y); }, { passive:false });
  canvas.addEventListener('touchmove',  e => { e.preventDefault(); if (!drawing) return; const p = gp(e); ctx.lineTo(p.x,p.y); ctx.stroke(); }, { passive:false });
  canvas.addEventListener('touchend',   () => drawing = false);
}

function clearSigClient() {
  const c = $('sig-client'); if (c) c.getContext('2d').clearRect(0,0,c.width,c.height);
  state.sigClientData = null;
}
function clearSigLocataire() {
  const c = $('sig-locataire'); if (c) c.getContext('2d').clearRect(0,0,c.width,c.height);
  state.sigLocataireData = null;
}
function updateSigLabels() {
  const today = new Date().toLocaleDateString('fr-CH');
  const clientNom = (() => { const sel = $('r-client'); if (!sel) return ''; const c = DB.clients.find(x => x.id === sel.value); return c ? c.nom : ''; })();
  const locNom = $('r-locataire') ? $('r-locataire').value : '';
  if ($('sig-client-nom')) $('sig-client-nom').textContent = clientNom || 'Client / Gérance';
  if ($('sig-locataire-nom')) $('sig-locataire-nom').textContent = locNom || 'Locataire';
  if ($('sig-client-date')) $('sig-client-date').textContent = today;
  if ($('sig-locataire-date')) $('sig-locataire-date').textContent = today;
}

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
  initSigCanvas('sig-client', 'sigClient');
  initSigCanvas('sig-locataire', 'sigLocataire');
  updateSigLabels();
  if (!state.materiels) state.materiels = [];
  const pwdInput = $('login-pwd');
  if (pwdInput) pwdInput.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
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

  const basePrompt = `Tu es un rédacteur expert en langue française spécialisé dans les rapports techniques d'intervention anti-nuisibles en Suisse. Tu travailles pour DERATEK, une entreprise professionnelle de lutte antiparasitaire.

Tu reçois des textes saisis rapidement par des techniciens sur le terrain — souvent des notes brèves, des mots-clés, des phrases incomplètes ou mal formulées.

TON RÔLE : transformer ces notes en texte professionnel, fluide et bien rédigé. Tu ne te contentes pas de corriger — tu REFORMULES, tu ENRICHIS la syntaxe, tu STRUCTURES les idées.

TRAVAIL À EFFECTUER :
1. REFORMULATION : transforme les notes brèves en phrases complètes et professionnelles
2. SYNTAXE : construis des phrases bien structurées avec sujet, verbe, complément
3. ORTHOGRAPHE & GRAMMAIRE : corrige toutes les fautes sans exception
4. ACCENTS : ajoute tous les accents manquants (é, è, ê, à, â, ù, û, î, ô, ç)
5. PONCTUATION : virgules, points, majuscules en début de phrase uniquement
6. STYLE : vocabulaire technique précis du secteur pest control / dératisation
7. FLUIDITÉ : supprime les répétitions, lie les idées avec des connecteurs logiques
8. LONGUEUR : si le texte est très court (2-3 mots), développe-le en une phrase complète professionnelle

EXEMPLES de reformulations attendues :
- "nid guepe store" → "Un nid de guêpes a été découvert à l'intérieur du caisson de store."
- "beaucoup punaise lit partout chambre" → "Une infestation importante de punaises de lit a été constatée dans l'ensemble de la chambre, notamment au niveau du matelas, du sommier et des plinthes."
- "traitement ok pas probleme" → "Le traitement a été effectué sans difficulté particulière. L'ensemble des zones ciblées a été traité conformément au protocole."
- "locataire dit depuis 3 mois" → "Le locataire nous a informés que le problème persiste depuis environ trois mois."

ABSOLUMENT INTERDIT :
- Ajouter une introduction ou explication ("Voici le texte corrigé :", etc.)
- Inventer des informations absentes du texte original
- Ajouter des guillemets autour du résultat

Réponds UNIQUEMENT avec le texte reformulé et réécrit, rien d'autre.`;

  const prompts = {
    description:     basePrompt + "\n\nContexte : observations sur place lors d'une intervention anti-nuisibles. Décris ce qui a été constaté sur site de façon précise et professionnelle.",
    origine:         basePrompt + "\n\nContexte : origine probable de l'infestation. Explique les causes et vecteurs d'entrée de façon technique.",
    contraintes:     basePrompt + "\n\nContexte : contraintes et informations utiles pour l'intervention (allergies, animaux, accès, présence de personnes vulnérables, etc.).",
    precautions:     basePrompt + "\n\nContexte : précautions post-traitement à communiquer au client. Utilise un ton clair, rassurant et professionnel.",
    recommandations: basePrompt + "\n\nContexte : recommandations et suivi après intervention. Conseille le client sur les mesures préventives et les prochaines étapes.",
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
