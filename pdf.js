/* ============================================================
   DERATEK — Génération PDF v2.0
   Utilise jsPDF (inclus via CDN dans index.html)
   ============================================================ */

function generatePDF(rapport, statut) {
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const W = 210, M = 14, CW = W - M*2;
    let y = 0;

    // Couleurs
    const C = {
      navy:   [26,  39,  68],
      red:    [230, 57,  70],
      white:  [255, 255, 255],
      gray:   [249, 250, 251],
      border: [229, 231, 235],
      text:   [31,  41,  55],
      muted:  [107, 114, 128],
      green:  [45,  158, 107],
      orange: [244, 166, 35],
    };

    // ── HEADER ──────────────────────────────────────────────
    doc.setFillColor(...C.navy);
    doc.rect(0, 0, W, 32, 'F');
    doc.setTextColor(...C.white);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(22);
    doc.text('DERATEK', M, 14);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(180, 190, 210);
    doc.text('PROFESSIONAL PEST CONTROL', M, 21);
    // Badge RAPPORT
    doc.setFillColor(...C.red);
    doc.roundedRect(W - M - 54, 10, 54, 11, 2, 2, 'F');
    doc.setTextColor(...C.white);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.text("RAPPORT D'INTERVENTION", W - M - 27, 16.8, { align: 'center' });
    y = 37;

    // ── BANDE ID / DATE ──────────────────────────────────────
    doc.setFillColor(248, 250, 252);
    doc.rect(0, y, W, 13, 'F');
    doc.setDrawColor(...C.border);
    doc.line(0, y+13, W, y+13);
    doc.setTextColor(...C.navy);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.text(rapport.id || '—', M, y + 9);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...C.muted);
    doc.text(fmtDate(rapport.date), W - M, y + 9, { align: 'right' });
    y += 18;

    // ── HELPERS ──────────────────────────────────────────────
    function checkPage(needed = 20) {
      if (y + needed > 272) { doc.addPage(); y = 15; }
    }

    function sTitle(title) {
      checkPage(14);
      doc.setFillColor(240, 243, 248);
      doc.rect(M, y, CW, 7, 'F');
      doc.setDrawColor(...C.border);
      doc.rect(M, y, CW, 7, 'S');
      doc.setTextColor(...C.navy);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.text(title.toUpperCase(), M + 3, y + 4.8);
      y += 10;
    }

    function row(key, val, shade) {
      if (!val) return;
      checkPage(8);
      if (shade) { doc.setFillColor(249, 250, 251); doc.rect(M, y, CW, 7, 'F'); }
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(...C.muted);
      doc.text(String(key), M + 2, y + 5);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...C.text);
      const valLines = doc.splitTextToSize(String(val), CW - 58);
      doc.text(valLines, M + 58, y + 5);
      doc.setDrawColor(...C.border);
      doc.line(M, y+7, M+CW, y+7);
      y += 7;
    }

    function textBox(text, bgColor) {
      if (!text) return;
      checkPage(20);
      const lines = doc.splitTextToSize(String(text), CW - 8);
      const h = lines.length * 5 + 8;
      if (bgColor) { doc.setFillColor(...bgColor); } else { doc.setFillColor(249, 250, 251); }
      doc.roundedRect(M, y, CW, h, 2, 2, 'F');
      doc.setDrawColor(...C.border);
      doc.roundedRect(M, y, CW, h, 2, 2, 'S');
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(...C.text);
      doc.text(lines, M + 4, y + 6);
      y += h + 5;
    }

    function colorPill(label, value, bg, textColor, x, w) {
      doc.setFillColor(...bg);
      doc.roundedRect(x, y, w, 18, 3, 3, 'F');
      doc.setTextColor(...textColor);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.text(label.toUpperCase(), x + 4, y + 5.5);
      doc.setFontSize(12);
      doc.text(String(value || '—'), x + 4, y + 14);
    }

    function tag(text, x, tagY, bg, tc) {
      const tw = doc.getTextWidth(text) + 6;
      doc.setFillColor(...bg);
      doc.roundedRect(x, tagY, tw, 6, 1, 1, 'F');
      doc.setTextColor(...tc);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.text(text, x + 3, tagY + 4.2);
      return tw + 3;
    }

    // ── INFOS GÉNÉRALES ──────────────────────────────────────
    sTitle('Informations générales');
    row('Technicien',    rapport.tech,       false);
    row('Client',        rapport.clientNom,  true);
    row('Adresse',       (rapport.adresse||'') + (rapport.npa?' '+rapport.npa:'') + (rapport.ville?' '+rapport.ville:''), false);
    row('Contact',       rapport.contact,    true);
    row('Téléphone',     rapport.tel,        false);
    row('Email',         rapport.email,      true);
    row('Bâtiment',      rapport.batiment,   false);
    row('Localisation',  rapport.localisation, true);
    row('N° Intervention', rapport.noint,    false);
    y += 5;

    // ── NUISIBLES & NIVEAU ───────────────────────────────────
    sTitle('Nuisibles & Niveau d\'infestation');
    checkPage(30);

    // Nuisibles tags
    const nuisibles = rapport.nuisibles || [];
    if (nuisibles.length) {
      let tagX = M;
      nuisibles.forEach(n => {
        if (tagX + doc.getTextWidth(n) + 12 > M + CW) { y += 9; tagX = M; }
        tagX += tag(n, tagX, y, C.red, C.white);
      });
      y += 10;
    }

    // Niveau + Superficie
    if (rapport.niveau || rapport.superficie || rapport.pieces) {
      checkPage(25);
      colorPill('Niveau d\'infestation', rapport.niveau, [255, 240, 240], C.red, M, CW/2 - 3);
      const supText = (rapport.superficie ? rapport.superficie + ' m²' : '—') + (rapport.pieces ? ' / ' + rapport.pieces + ' pièce(s)' : '');
      colorPill('Superficie / Pièces', supText, [255, 248, 230], [176, 120, 0], M + CW/2 + 3, CW/2 - 3);
      y += 23;
    }
    if (rapport.zones) { row('Zones touchées', rapport.zones, false); y += 3; }
    y += 3;

    // ── OBSERVATIONS ─────────────────────────────────────────
    sTitle('Observations sur place');
    textBox(rapport.description);
    if (rapport.origine) { row('Origine probable', rapport.origine, false); y += 2; }
    if (rapport.contraintes) { row('Contraintes', rapport.contraintes, true); y += 2; }
    y += 3;

    // ── TRAITEMENT ───────────────────────────────────────────
    sTitle('Traitement appliqué');
    const tLabels = {
      't-pulv':'Pulvérisation','t-vapeur':'Vapeur','t-thermique':'Thermique',
      't-injection':'Injection','t-appats':'Appâts/pièges','t-monitoring':'Monitoring',
      't-desinfect':'Désinfection','t-flocage':'Flocage','t-gel':'Gel','t-poudre':'Poudre',
      't-fumigation':'Fumigation','t-pose':'Pièges mécaniques'
    };
    const methodes = (rapport.traitement||[]).map(t => tLabels[t]||t);
    if (methodes.length) {
      checkPage(15);
      doc.setFillColor(239, 246, 255);
      doc.roundedRect(M, y, CW, 10, 2, 2, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(30, 64, 175);
      doc.text(methodes.join('  ·  '), M + 4, y + 6.5);
      y += 14;
    }

    // Produits
    const produits = rapport.produits || [];
    if (produits.length) {
      checkPage(10 + produits.length * 8);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(...C.navy);
      doc.text('Produits utilisés :', M, y);
      y += 5;
      // En-tête tableau
      doc.setFillColor(...C.navy);
      doc.rect(M, y, CW, 7, 'F');
      doc.setTextColor(...C.white);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.text('Produit', M + 3, y + 4.8);
      doc.text('Dosage', M + 80, y + 4.8);
      doc.text('Zone', M + 130, y + 4.8);
      y += 7;
      produits.forEach((p, i) => {
        checkPage(8);
        if (i % 2 === 0) { doc.setFillColor(249, 250, 251); doc.rect(M, y, CW, 7, 'F'); }
        doc.setTextColor(...C.text);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.5);
        doc.text(p.nom || '—', M + 3, y + 4.8);
        doc.setFont('helvetica', 'normal');
        doc.text(p.dosage || '—', M + 80, y + 4.8);
        doc.text(p.zone || '—', M + 130, y + 4.8);
        doc.setDrawColor(...C.border);
        doc.line(M, y+7, M+CW, y+7);
        y += 7;
      });
      y += 5;
    }

    if (rapport.precautions) {
      checkPage(20);
      doc.setFillColor(255, 248, 230);
      doc.roundedRect(M, y, CW, 6, 2, 2, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(146, 64, 0);
      doc.text('⚠ PRÉCAUTIONS TRANSMISES AU CLIENT', M + 3, y + 4);
      y += 8;
      textBox(rapport.precautions, [255, 248, 230]);
    }
    y += 3;

    // ── RÉSULTAT & RECOMMANDATIONS ────────────────────────────
    sTitle('Résultat & Recommandations');
    checkPage(30);
    if (rapport.resultat) {
      doc.setFillColor(232, 247, 240);
      doc.roundedRect(M, y, CW, 10, 2, 2, 'F');
      doc.setDrawColor(110, 231, 183);
      doc.roundedRect(M, y, CW, 10, 2, 2, 'S');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(6, 95, 70);
      doc.text('Résultat :', M + 3, y + 6.5);
      doc.setFont('helvetica', 'normal');
      doc.text(rapport.resultat, M + 30, y + 6.5);
      y += 14;
    }
    textBox(rapport.recommandations);

    // RDV + Garantie + Montant
    checkPage(25);
    const boxW = (CW - 8) / 3;
    [[rapport.montant ? rapport.montant+' CHF' : '—', 'Montant', C.navy, C.white],
     [rapport.rdv ? fmtDate(rapport.rdv) : '—', 'Prochain RDV', [240,243,248], C.navy],
     [rapport.garantie || '—', 'Garantie', [240,243,248], C.navy]
    ].forEach(([val, lbl, bg, tc], i) => {
      const bx = M + i*(boxW + 4);
      doc.setFillColor(...bg);
      doc.roundedRect(bx, y, boxW, 16, 2, 2, 'F');
      doc.setTextColor(...tc);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.text(lbl.toUpperCase(), bx + 3, y + 5.5);
      doc.setFontSize(11);
      doc.text(String(val), bx + 3, y + 13);
    });
    y += 21;

    // ── DURÉE ────────────────────────────────────────────────
    if (rapport.duree) { row('Durée d\'intervention', rapport.duree + ' heure(s)', false); y += 3; }

    // ── PHOTOS ───────────────────────────────────────────────
    const photos = window._currentPhotos || [];
    const validPhotos = photos.filter(p => p);
    if (validPhotos.length) {
      doc.addPage();
      y = 15;
      sTitle('Photos d\'intervention');
      const labels = ['Avant 1','Avant 2','Pendant','Après 1','Après 2','Autre'];
      const allPhotos = photos.map((p,i) => ({ src: p, label: labels[i] })).filter(p => p.src);
      const imgW = (CW - 6) / 2, imgH = 55;
      let col = 0;
      allPhotos.forEach((ph, i) => {
        checkPage(imgH + 20);
        const x = M + col * (imgW + 6);
        try {
          doc.addImage(ph.src, 'JPEG', x, y, imgW, imgH);
          doc.setFillColor(0,0,0,0.4);
          doc.setDrawColor(...C.border);
          doc.rect(x, y, imgW, imgH, 'S');
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(8);
          doc.setTextColor(...C.muted);
          doc.text(ph.label, x + 2, y + imgH + 5);
        } catch(e) { console.warn('Image error:', e); }
        col++;
        if (col >= 2) { col = 0; y += imgH + 12; }
      });
      if (col > 0) y += imgH + 12;
    }

    // ── FOOTER ───────────────────────────────────────────────
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFillColor(...C.navy);
      doc.rect(0, 285, W, 12, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(...C.white);
      doc.text('DERATEK Professional Pest Control', M, 291.5);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(180, 190, 210);
      doc.text('info@deratek.ch', M + 70, 291.5);
      doc.text(`Page ${i} / ${pageCount}`, W - M, 291.5, { align: 'right' });
      doc.text('Document confidentiel — © DERATEK 2026', W/2, 291.5, { align: 'center' });
    }

    return doc;
  } catch(e) {
    console.error('PDF generation error:', e);
    return null;
  }
}

// ── BOUTON IMPRIMER ──────────────────────────────────────────
function printRapport() {
  const r = getCurrentRapportData();
  window._currentPhotos = state.photos;
  const doc = generatePDF(r);
  if (doc) {
    doc.autoPrint();
    doc.output('dataurlnewwindow');
  }
}

// ── TÉLÉCHARGER PDF ──────────────────────────────────────────
function downloadPDF() {
  const r = getCurrentRapportData();
  window._currentPhotos = state.photos;
  const doc = generatePDF(r);
  if (doc) {
    doc.save(`DERATEK-${r.id || 'rapport'}-${r.date || ''}.pdf`);
    toast('PDF téléchargé ✓', '#2d9e6b');
  }
}

// ── DONNÉES RAPPORT ACTUEL ───────────────────────────────────
function getCurrentRapportData() {
  const nuisibles = [];
  document.querySelectorAll('#tab-nuisibles input[type=checkbox]:checked').forEach(c => nuisibles.push(c.value));
  const traitement = [];
  ['t-pulv','t-vapeur','t-thermique','t-injection','t-appats','t-monitoring','t-desinfect','t-flocage','t-gel','t-poudre','t-fumigation','t-pose'].forEach(id => {
    const el = document.getElementById(id); if (el && el.checked) traitement.push(id);
  });
  const clientId = document.getElementById('r-client').value;
  const client = DB.clients.find(c => c.id === clientId);
  return {
    id:           document.getElementById('r-id').value,
    clientNom:    client ? client.nom : '',
    clientEmail:  document.getElementById('r-email').value,
    date:         document.getElementById('r-date').value,
    tech:         document.getElementById('r-tech').value,
    contact:      document.getElementById('r-contact').value,
    tel:          document.getElementById('r-tel').value,
    email:        document.getElementById('r-email').value,
    adresse:      document.getElementById('r-adresse').value,
    npa:          document.getElementById('r-npa').value,
    ville:        document.getElementById('r-ville').value,
    localisation: document.getElementById('r-localisation').value,
    batiment:     document.getElementById('r-batiment').value,
    noint:        document.getElementById('r-noint').value,
    nuisibles, description: document.getElementById('r-description').value,
    niveau:       document.getElementById('r-niveau').value,
    superficie:   document.getElementById('r-superficie').value,
    pieces:       document.getElementById('r-pieces').value,
    zones:        document.getElementById('r-zones').value,
    origine:      document.getElementById('r-origine').value,
    contraintes:  document.getElementById('r-contraintes').value,
    traitement,
    produits:     state.produits,
    precautions:  document.getElementById('r-precautions').value,
    duree:        document.getElementById('r-duree').value,
    montant:      document.getElementById('r-montant').value,
    resultat:     document.getElementById('r-resultat').value,
    recommandations: document.getElementById('r-recommandations').value,
    rdv:          document.getElementById('r-rdv').value,
    garantie:     document.getElementById('r-garantie').value,
  };
}
