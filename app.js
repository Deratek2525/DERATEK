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
    contactSurPlace: 'contact_sur_place',
    createdAt: 'created_at',
    pdfPath: 'pdf_path',
  } },
  rapports:   { js2db: {
    clientId: 'client_id', clientNom: 'client_nom', clientEmail: 'client_email',
    bonCommande: 'bon_commande', rdvHeure: 'rdv_heure',
  } },
  techs:      { js2db: {} },
  intervs:    { js2db: {} },
};
const META_COLS = new Set(['user_id', 'created_at']);

function toDb(table, obj) {
  const map = TABLE_FIELDS[table].js2db;
  const out = {};
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined) continue;
    out[map[k] || k] = obj[k];
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
  _cache:      { techs: [], clients: [], rapports: [], intervs: [], locataires: [], bons: [] },
  _lastSync:   { techs: [], clients: [], rapports: [], intervs: [], locataires: [], bons: [] },
  _pending:    new Set(),
  _processing: false,
  // Ordre IMPORTANT : tables sans dépendance FK d'abord, puis tables dépendantes
  // clients, locataires (qui dépendent de clients), rapports/intervs (qui dépendent de clients),
  // bons (qui dépendent de clients ET de locataires)
  _syncOrder:  ['techs', 'clients', 'locataires', 'rapports', 'intervs', 'bons'],

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
    const tables = ['clients', 'locataires', 'bons', 'rapports', 'techs', 'intervs'];
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
      const rows = toUpsert.map(o => toDb(table, o));
      const { error } = await sb.from(table).upsert(rows);
      if (error) {
        console.warn(table, 'upsert', error);
        if (typeof toast === 'function') toast('Erreur de sauvegarde Supabase : ' + error.message, '#e63946');
      }
    }
    this._lastSync[table] = JSON.parse(JSON.stringify(newArr));
  },

  _resetCache() {
    this._cache    = { techs: [], clients: [], rapports: [], intervs: [], locataires: [], bons: [] };
    this._lastSync = { techs: [], clients: [], rapports: [], intervs: [], locataires: [], bons: [] };
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
  if (name === 'rapports')     renderRapports();
  if (name === 'agenda')       renderAgenda();
  if (name === 'locataires')   renderLocataires();
  if (name === 'bons')         renderBons();
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
  ['iv-adresse','iv-nuisible','iv-notes'].forEach(id => $(id).value = '');
  $('iv-statut').value = 'Planifiée';
  $('iv-delete-btn').style.display = 'none';
  state.selectedColor = '#e63946';
  document.querySelectorAll('#iv-colors .color-opt').forEach(c => c.classList.remove('selected'));
  const defColor = document.querySelector('#iv-colors .color-opt[data-color="#e63946"]');
  if (defColor) defColor.classList.add('selected');
  populateClientSelectInterv('');
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
  $('iv-delete-btn').style.display = 'inline-flex';
  state.selectedColor = iv.couleur || '#e63946';
  document.querySelectorAll('#iv-colors .color-opt').forEach(c => {
    c.classList.toggle('selected', c.dataset.color === state.selectedColor);
  });
  populateClientSelectInterv(iv.clientId);
  openModal('modal-interv');
}
function populateClientSelectInterv(selectedId) {
  $('iv-client').innerHTML = '<option value="">-- Sélectionner --</option>' +
    DB.clients.map(c => `<option value="${c.id}"${c.id === selectedId ? ' selected' : ''}>${c.nom}</option>`).join('');
}
function saveInterv() {
  const clientId = $('iv-client').value;
  const client = DB.clients.find(c => c.id === clientId);
  const iv = {
    id: state.editingIntervId || newId(),
    date: $('iv-date').value, heure: $('iv-heure').value,
    clientId, clientNom: client ? client.nom : '',
    adresse: $('iv-adresse').value, nuisible: $('iv-nuisible').value,
    tech: $('iv-tech').value, statut: $('iv-statut').value,
    couleur: state.selectedColor, notes: $('iv-notes').value,
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
      ${c.contact ? `<div class="client-contact-row" style="font-weight:700;color:var(--navy);">👤 ${c.contact}</div>` : ''}
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
  document.querySelectorAll('#tab-nuisibles input[type=checkbox]').forEach(c => c.checked = false);
  ['t-pulv','t-vapeur','t-thermique','t-injection','t-appats','t-monitoring','t-desinfect','t-flocage','t-gel','t-poudre','t-fumigation','t-pose'].forEach(id => { const el = $(id); if (el) el.checked = false; });
  renderProduits(); resetPhotoGrid(); clearSig();
  $('edit-id').textContent = newId;
  $('edit-status').className = 'badge b-gray'; $('edit-status').textContent = 'Brouillon';
  $('edit-meta').textContent = '';
  if ($('r-avec-locataire')) $('r-avec-locataire').checked = false;
  clearLocataireSelection();
  if ($('bloc-locataire')) $('bloc-locataire').style.display = 'none';
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
  document.querySelectorAll('#tab-nuisibles input[type=checkbox]').forEach(c => c.checked = (r.nuisibles||[]).includes(c.value));
  ['t-pulv','t-vapeur','t-thermique','t-injection','t-appats','t-monitoring','t-desinfect','t-flocage','t-gel','t-poudre','t-fumigation','t-pose'].forEach(id => { const el = $(id); if (el) el.checked = (r.traitement||[]).includes(id); });
  if ($('r-rdv-heure')) $('r-rdv-heure').value = r.rdvHeure || '';
  if ($('r-bon-commande')) $('r-bon-commande').value = r.bonCommande || '';
  // Restaurer le locataire
  const setL = (id, v) => { const el = $(id); if (el) el.value = v || ''; };
  setL('r-locataire', r.locataire); setL('r-locataire-tel', r.locataireTel);
  setL('r-locataire-email', r.locataireEmail); setL('r-locataire-adresse', r.locataireAdresse);
  const hasLoc = !!(r.avecLocataire || r.locataire || r.locataireTel || r.locataireEmail || r.locataireAdresse);
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
    bonCommande: ($('r-bon-commande') ? $('r-bon-commande').value : ''),
    nuisibles, description: $('r-description').value, niveau: $('r-niveau').value,
    superficie: $('r-superficie').value, pieces: $('r-pieces').value, zones: $('r-zones').value,
    origine: $('r-origine').value, contraintes: $('r-contraintes').value,
    traitement, produits: JSON.parse(JSON.stringify(state.produits)),
    precautions: $('r-precautions').value, duree: $('r-duree').value, montant: $('r-montant').value,
    resultat: $('r-resultat').value, recommandations: $('r-recommandations').value,
    rdv: $('r-rdv').value, rdvHeure: ($('r-rdv-heure') ? $('r-rdv-heure').value : ''), garantie: $('r-garantie').value, statut,
    avecLocataire: !!($('r-avec-locataire') && $('r-avec-locataire').checked),
    locataire: _lv('r-locataire'), locataireTel: _lv('r-locataire-tel'),
    locataireEmail: _lv('r-locataire-email'), locataireAdresse: _lv('r-locataire-adresse'),
  };
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
  const tL = {'t-pulv':'Pulvérisation','t-vapeur':'Vapeur','t-thermique':'Thermique','t-injection':'Injection','t-appats':'Appâts','t-monitoring':'Monitoring','t-desinfect':'Désinfection','t-flocage':'Flocage','t-gel':'Gel','t-poudre':'Poudre','t-fumigation':'Fumigation','t-pose':'Pièges'};
  ['t-pulv','t-vapeur','t-thermique','t-injection','t-appats','t-monitoring','t-desinfect','t-flocage','t-gel','t-poudre','t-fumigation','t-pose'].forEach(id => { const el = $(id); if (el && el.checked) traitement.push(tL[id]); });
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
    'sans aucun texte autour, sans balises Markdown. Utilise exactement ces clés (chaîne vide si absent) :\n' +
    '{\n' +
    '"gerance_nom": "nom de la régie/gérance",\n' +
    '"gerant_nom": "nom du gérant ou gérante technique / contact",\n' +
    '"gerant_tel": "téléphone du gérant",\n' +
    '"gerant_email": "email du gérant",\n' +
    '"gerance_adresse": "adresse de facturation de la gérance (rue et numéro)",\n' +
    '"gerance_npa": "code postal gérance",\n' +
    '"gerance_ville": "ville gérance",\n' +
    '"numero_bon": "numéro du bon de travaux",\n' +
    '"date_bon": "date du bon au format AAAA-MM-JJ",\n' +
    '"immeuble": "adresse de l\'immeuble concerné",\n' +
    '"proprietaire": "nom du propriétaire",\n' +
    '"locataire_nom": "nom complet du/des locataire(s)",\n' +
    '"locataire_tel": "téléphone du locataire",\n' +
    '"locataire_email": "email du locataire",\n' +
    '"locataire_adresse": "adresse complète du locataire (immeuble, étage, appartement)",\n' +
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
        ${champ('Adresse locataire', 'locataire_adresse', infos.locataire_adresse)}
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
  const locs = DB.locataires;
  const existing = locs.find(l => (l.nom || '').toLowerCase() === nom.toLowerCase());
  if (existing) {
    const updates = {};
    if (!existing.tel       && infos.locataire_tel)     updates.tel       = infos.locataire_tel;
    if (!existing.email     && infos.locataire_email)   updates.email     = infos.locataire_email;
    if (!existing.adresse   && infos.locataire_adresse) updates.adresse   = infos.locataire_adresse;
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
    adresse: infos.locataire_adresse || '',
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
    return `
      <div style="margin-top:14px;">
        <div style="font-size:13px;font-weight:800;color:var(--navy);text-transform:uppercase;letter-spacing:.4px;margin-bottom:10px;border-bottom:2px solid var(--red);padding-bottom:5px;">
          🏢 ${g} <span style="font-weight:500;color:var(--g600);">(${items.length} locataire${items.length !== 1 ? 's' : ''})</span>
        </div>
        <div class="clients-grid">
          ${items.map(({ l, dateFmt }) => `
            <div class="client-card">
              <div class="client-hd">
                <div class="av av-md" style="background:#7c3aed">${initials(l.nom||'')}</div>
                <div class="client-info">
                  <div class="client-name">${l.nom||''}</div>
                  <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                    <span class="badge b-gray">Locataire</span>
                    ${dateFmt ? `<span style="font-size:10px;color:var(--g600);">📅 ${dateFmt}</span>` : ''}
                  </div>
                </div>
                <button class="btn btn-ghost btn-sm" onclick="editLocataire('${l.id}')">✏️ Modifier</button>
              </div>
              ${l.tel ? `<div class="client-contact-row">📞 ${l.tel}</div>` : ''}
              ${l.email ? `<div class="client-contact-row">✉️ ${l.email}</div>` : ''}
              ${l.adresse ? `<div class="client-contact-row">📍 ${l.adresse}</div>` : ''}
              ${(l.npa || l.ville) ? `<div class="client-contact-row">📍 ${l.npa||''} ${l.ville||''}</div>` : ''}
              ${l.notes ? `<div style="font-size:11px;color:var(--g600);background:var(--g50);padding:7px 9px;border-radius:6px;margin:8px 0;">${l.notes}</div>` : ''}
              <div class="client-actions">
                <button class="btn btn-red btn-sm btn-xs" onclick="confirmDeleteLocataire('${l.id}')">🗑</button>
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
function renderBons() {
  const list = $('bons-list');
  const count = $('bons-count');
  const q = (($('bon-search') || {}).value || '').toLowerCase();
  let bons = DB.bons || [];
  if (q) {
    bons = bons.filter(b =>
      ((b.numero||'') + ' ' + (b.geranceNom||'') + ' ' + (b.locataireNom||'') + ' ' + (b.immeuble||'') + ' ' + (b.probleme||''))
        .toLowerCase().includes(q)
    );
  }
  if (count) count.textContent = bons.length ? bons.length + ' bon(s)' : '';
  if (!list) return;
  if (!bons.length) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">📄</div><div class="empty-text">Aucun bon enregistré pour le moment.<br>Glissez un PDF ci-dessus pour commencer.</div></div>';
    return;
  }
  const groups = {};
  bons.forEach(b => {
    const key = b.geranceNom || '(Sans gérance)';
    if (!groups[key]) groups[key] = [];
    groups[key].push(b);
  });
  // Index locataires pour lookup rapide
  const locById = {};
  (DB.locataires || []).forEach(l => { if (l && l.id) locById[l.id] = l; });
  const locByName = {};
  (DB.locataires || []).forEach(l => { if (l && l.nom) locByName[l.nom.toLowerCase()] = l; });

  list.innerHTML = Object.keys(groups).sort().map(g => {
    const items = groups[g].sort((a,b) => (b.date||'').localeCompare(a.date||''));
    return `
      <div style="margin-top:14px;">
        <div style="font-size:13px;font-weight:800;color:var(--navy);text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px;border-bottom:2px solid var(--red);padding-bottom:4px;">🏢 ${g} <span style="font-weight:500;color:var(--g600);">(${items.length})</span></div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${items.map(b => {
            const loc = (b.locataireId && locById[b.locataireId]) || (b.locataireNom && locByName[b.locataireNom.toLowerCase()]) || null;
            const locTel     = loc ? (loc.tel || '')     : '';
            const locAdresse = loc ? (loc.adresse || '') : (b.immeuble || '');
            const statut = b.statut || '';
            // Couleur de fond du select selon le statut
            const statutStyles = {
              '':          { bg: '#f3f4f6', color: '#6b7280', border: '#d1d5db' },
              'transmis':  { bg: '#dbeafe', color: '#1d4ed8', border: '#3b82f6' },
              'en-cours':  { bg: '#fed7aa', color: '#9a3412', border: '#f97316' },
              'termine':   { bg: '#bbf7d0', color: '#166534', border: '#22c55e' },
            };
            const stStyle = statutStyles[statut] || statutStyles[''];
            return `
            <div style="display:flex;align-items:stretch;gap:14px;background:#fff;border:1px solid #e5e7eb;border-left:4px solid var(--navy);border-radius:8px;padding:10px 14px;box-shadow:0 1px 2px rgba(0,0,0,.04);flex-wrap:wrap;">
              <div style="display:flex;align-items:center;gap:10px;min-width:130px;">
                <div style="width:34px;height:34px;border-radius:50%;background:#0d1b3e;color:#fff;display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;">📄</div>
                <div>
                  <div style="font-size:13px;font-weight:800;color:var(--navy);line-height:1.2;">Bon ${b.numero || '(s. n°)'}</div>
                  <div style="font-size:12px;color:var(--red);font-weight:600;">📅 ${fmtDate(b.date) || '—'}</div>
                </div>
              </div>
              <div style="flex:1;min-width:130px;">
                <div style="font-size:10px;color:var(--g400);text-transform:uppercase;font-weight:700;letter-spacing:.3px;">🏢 Gérance</div>
                <div style="font-size:12px;font-weight:600;color:var(--navy);">${g}</div>
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
                <div style="font-size:12px;color:var(--g600);">${b.probleme || '—'}</div>
              </div>
              <div style="display:flex;gap:6px;align-items:center;flex-shrink:0;">
                <select onchange="updateBonStatut('${b.id}', this.value)" title="Statut du bon" style="font-size:11px;font-weight:700;padding:6px 8px;border-radius:6px;border:1.5px solid ${stStyle.border};background:${stStyle.bg};color:${stStyle.color};cursor:pointer;">
                  <option value="">— Statut —</option>
                  <option value="transmis" ${statut === 'transmis' ? 'selected' : ''}>📨 Rapport transmis</option>
                  <option value="en-cours" ${statut === 'en-cours' ? 'selected' : ''}>⏳ En cours de traitement</option>
                  <option value="termine"  ${statut === 'termine'  ? 'selected' : ''}>✅ Travail terminé</option>
                </select>
                ${b.pdfPath ? `<button class="btn btn-ghost btn-sm" onclick="viewBonPdf('${b.id}')" title="Ouvrir le PDF dans un nouvel onglet">📎 PDF</button>` : ''}
                <button class="btn btn-red btn-sm btn-xs" onclick="confirmDeleteBon('${b.id}','${(b.numero||b.id).replace(/'/g,"\\'")}')" title="Supprimer">🗑</button>
              </div>
            </div>
          `; }).join('')}
        </div>
      </div>
    `;
  }).join('');
}

// Met à jour le statut d'un bon (transmis / en-cours / termine / vide)
function updateBonStatut(id, value) {
  const bons = DB.bons;
  const b = bons.find(x => x.id === id);
  if (!b) return;
  b.statut = value;
  DB.bons = bons; // déclenche le sync Supabase
  const labels = {
    '':          'Statut effacé',
    'transmis':  '📨 Statut : Rapport transmis',
    'en-cours':  '⏳ Statut : En cours de traitement',
    'termine':   '✅ Statut : Travail terminé',
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
