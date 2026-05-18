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
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      const keyX = M + 2;
      const valX = M + 50;
      const valW = CW - 52; // largeur disponible pour la valeur
      const valLines = doc.splitTextToSize(String(val), valW);
      const rowH = Math.max(8, valLines.length * 5 + 5);
      checkPage(rowH + 2);
      if (shade) { doc.setFillColor(249, 250, 251); doc.rect(M, y, CW, rowH, 'F'); }
      doc.setTextColor(...C.muted);
      doc.setFont('helvetica', 'normal');
      doc.text(String(key), keyX, y + 5.5);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(...C.text);
      doc.text(valLines, valX, y + 5.5);
      doc.setDrawColor(...C.border);
      doc.line(M, y + rowH, M + CW, y + rowH);
      y += rowH;
    }

    function textBox(text, bgColor) {
      if (!text) return;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      const lines = doc.splitTextToSize(String(text), CW - 10);
      const lineH = 5;
      const padding = 8;
      const h = lines.length * lineH + padding;
      checkPage(Math.min(h + 5, 60)); // vérifier espace dispo
      // Si le texte ne tient pas sur la page restante, on pagine ligne par ligne
      const pageBottom = 285; // bas de page A4 en mm
      const available = pageBottom - y - 10;
      if (h > available && available > 20) {
        // Dessiner ce qui rentre sur cette page
        const linesOnPage = Math.floor((available - padding) / lineH);
        const firstLines = lines.slice(0, Math.max(1, linesOnPage));
        const h1 = firstLines.length * lineH + padding;
        if (bgColor) doc.setFillColor(...bgColor); else doc.setFillColor(249, 250, 251);
        doc.roundedRect(M, y, CW, h1, 2, 2, 'F');
        doc.setDrawColor(...C.border);
        doc.roundedRect(M, y, CW, h1, 2, 2, 'S');
        doc.setTextColor(...C.text);
        doc.text(firstLines, M + 4, y + 6);
        y += h1 + 3;
        // Reste sur nouvelle page
        const restLines = lines.slice(firstLines.length);
        if (restLines.length > 0) {
          doc.addPage(); y = 15;
          const h2 = restLines.length * lineH + padding;
          if (bgColor) doc.setFillColor(...bgColor); else doc.setFillColor(249, 250, 251);
          doc.roundedRect(M, y, CW, h2, 2, 2, 'F');
          doc.setDrawColor(...C.border);
          doc.roundedRect(M, y, CW, h2, 2, 2, 'S');
          doc.setTextColor(...C.text);
          doc.text(restLines, M + 4, y + 6);
          y += h2 + 5;
        }
      } else {
        checkPage(h + 5);
        if (bgColor) doc.setFillColor(...bgColor); else doc.setFillColor(249, 250, 251);
        doc.roundedRect(M, y, CW, h, 2, 2, 'F');
        doc.setDrawColor(...C.border);
        doc.roundedRect(M, y, CW, h, 2, 2, 'S');
        doc.setTextColor(...C.text);
        doc.text(lines, M + 4, y + 6);
        y += h + 5;
      }
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
    row('Technicien',      rapport.tech,       false);
    row('Client',          rapport.clientNom,  true);
    if (rapport.bonCommande) row('N° Bon de commande', rapport.bonCommande, false);
    if (rapport.locataire) {
      row('Locataire',          rapport.locataire,   true);
      if (rapport.locataireTel)     row('Tél. locataire',    rapport.locataireTel, false);
      if (rapport.locataireEmail)   row('Email locataire',   rapport.locataireEmail, true);
      if (rapport.locataireAdresse) row('Adresse d\'intervention', rapport.locataireAdresse, false);
    } else {
      // Pas de locataire → afficher adresse normale
      row('Adresse',         (rapport.adresse||'') + (rapport.npa?' '+rapport.npa:'') + (rapport.ville?' '+rapport.ville:''), false);
    }
    row('Adresse',         (rapport.adresse||'') + (rapport.npa?' '+rapport.npa:'') + (rapport.ville?' '+rapport.ville:''), false);
    row('Contact',         rapport.contact,    true);
    row('Téléphone',       rapport.tel,        false);
    row('Email',           rapport.email,      true);
    row('Bâtiment',        rapport.batiment,   false);
    row('Localisation',    rapport.localisation, true);
    row('N° Intervention', rapport.noint,      false);
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

    // Matériels posés
    const materiels = rapport.materiels || [];
    if (materiels.length) {
      checkPage(10 + materiels.length * 8);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(...C.navy);
      doc.text('Matériel posé :', M, y);
      y += 5;
      doc.setFillColor(...C.navy);
      doc.rect(M, y, CW, 7, 'F');
      doc.setTextColor(...C.white);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.text('Matériel', M + 3, y + 4.8);
      doc.text('Qté', M + 110, y + 4.8);
      doc.text('Emplacement', M + 130, y + 4.8);
      y += 7;
      materiels.forEach((m, i) => {
        checkPage(8);
        if (i % 2 === 0) { doc.setFillColor(249, 250, 251); doc.rect(M, y, CW, 7, 'F'); }
        doc.setTextColor(...C.text);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5);
        doc.text(m.nom || '—', M + 3, y + 4.8);
        doc.setFont('helvetica', 'normal');
        doc.text(String(m.qte || '—'), M + 110, y + 4.8);
        doc.text(m.zone || '—', M + 130, y + 4.8);
        doc.setDrawColor(...C.border);
        doc.line(M, y+7, M+CW, y+7);
        y += 7;
      });
      y += 3;
    }
    if (rapport.materielComment) { textBox(rapport.materielComment); y += 3; }

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
    const showPrix = rapport.showPrix !== false;
    const boxes = [];
    if (showPrix) boxes.push([rapport.montant ? rapport.montant+' CHF' : '—', 'Montant', C.navy, C.white]);
    boxes.push([rapport.rdv ? fmtDate(rapport.rdv) : '—', 'Prochain RDV', [240,243,248], C.navy]);
    boxes.push([rapport.garantie || '—', 'Garantie', [240,243,248], C.navy]);
    const boxW = (CW - (boxes.length - 1) * 4) / boxes.length;
    boxes.forEach(([val, lbl, bg, tc], i) => {
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
    if (rapport.garantieNote) { textBox(rapport.garantieNote); y += 3; }

    // ── DURÉE ────────────────────────────────────────────────
    if (rapport.duree) { row('Durée d\'intervention', rapport.duree + ' heure(s)', false); y += 3; }

    // ── PHOTOS avec commentaires ──────────────────────────────
    const photos = rapport.photos || window._currentPhotos || [];
    const photoComments = rapport.photoComments || [];
    const validPhotos = photos.filter(p => p);
    if (validPhotos.length) {
      doc.addPage();
      y = 15;
      sTitle('Photos d\'intervention');
      const labels = ['Avant 1','Avant 2','Pendant','Après 1','Après 2','Autre'];
      const allPhotos = photos.map((p,i) => ({ src: p, label: labels[i], comment: photoComments[i]||'' })).filter(p => p.src);
      const imgW = (CW - 6) / 2, imgH = 55;
      let col = 0;
      allPhotos.forEach((ph, i) => {
        const blockH = imgH + (ph.comment ? 18 : 10);
        checkPage(blockH + 5);
        const x = M + col * (imgW + 6);
        try {
          const fmt = ph.src.startsWith('data:image/png') ? 'PNG' : 'JPEG';
          doc.addImage(ph.src, fmt, x, y, imgW, imgH);
          doc.setDrawColor(...C.border);
          doc.rect(x, y, imgW, imgH, 'S');
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(8);
          doc.setTextColor(...C.muted);
          doc.text(ph.label, x + 2, y + imgH + 5);
          if (ph.comment) {
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(7.5);
            doc.setTextColor(...C.text);
            const lines = doc.splitTextToSize(ph.comment, imgW - 4);
            doc.text(lines[0], x + 2, y + imgH + 11);
          }
        } catch(e) { console.warn('Image error:', e); }
        col++;
        if (col >= 2) { col = 0; y += imgH + (ph.comment ? 20 : 12); }
      });
      if (col > 0) y += imgH + 20;
    }

    // ── SIGNATURES ───────────────────────────────────────────
    checkPage(55);
    sTitle('Signatures');
    y += 3;
    const sigW = (CW - 10) / 2;
    const sigLabels = [
      { label: 'Client / Gérance', nom: rapport.clientNom || '', data: rapport.sigClient },
      { label: 'Locataire',        nom: rapport.locataire || '', data: rapport.sigLocataire },
    ];
    const today = fmtDate(rapport.date);
    sigLabels.forEach((s, i) => {
      const bx = M + i * (sigW + 10);
      doc.setFillColor(249, 250, 251);
      doc.roundedRect(bx, y, sigW, 38, 2, 2, 'F');
      doc.setDrawColor(...C.border);
      doc.roundedRect(bx, y, sigW, 38, 2, 2, 'S');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(...C.navy);
      doc.text(s.label.toUpperCase(), bx + 3, y + 6);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...C.text);
      doc.text(s.nom || '—', bx + 3, y + 13);
      // Zone de signature
      doc.setFillColor(255,255,255);
      doc.rect(bx + 3, y + 16, sigW - 6, 14, 'F');
      if (s.data && s.data.length > 100 && s.data !== 'data:,') {
        try { doc.addImage(s.data, 'PNG', bx + 3, y + 16, sigW - 6, 14); } catch(e) {}
      }
      doc.setDrawColor(...C.border);
      doc.line(bx + 3, y + 31, bx + sigW - 3, y + 31);
      doc.setFontSize(7); doc.setTextColor(...C.muted);
      doc.text('Signature', bx + 3, y + 36);
      doc.text(today, bx + sigW - 3, y + 36, { align: 'right' });
    });
    y += 44;

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
  downloadOrPrintPDF(true);
}

// ── TÉLÉCHARGER PDF ──────────────────────────────────────────
function downloadPDF() {
  downloadOrPrintPDF(false);
}

async function downloadOrPrintPDF(print = false) {
  toast('Génération PDF...', '#1a2744');
  const r = getCurrentRapportData();
  // Charger photos (async)
  if (state.photos && state.photos.some(p=>p)) {
    r.photos = state.photos;
  } else {
    try { r.photos = await DB.loadPhotos(r.id); } catch { r.photos = []; }
  }
  const doc = generatePDF(r);
  if (doc) {
    if (print) {
      doc.autoPrint();
      doc.output('dataurlnewwindow');
    } else {
      doc.save(`DERATEK-${r.id || 'rapport'}-${r.date || ''}.pdf`);
      toast('PDF téléchargé ✓', '#2d9e6b');
    }
  } else {
    toast('Erreur génération PDF', '#e63946');
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
    bonCommande:  document.getElementById('r-bon-commande') ? document.getElementById('r-bon-commande').value : '',
    locataire:    document.getElementById('r-locataire') ? document.getElementById('r-locataire').value : '',
    locataireTel: document.getElementById('r-locataire-tel') ? document.getElementById('r-locataire-tel').value : '',
    locataireEmail: document.getElementById('r-locataire-email') ? document.getElementById('r-locataire-email').value : '',
    locataireAdresse: document.getElementById('r-locataire-adresse') ? document.getElementById('r-locataire-adresse').value : '',
    showPrix:     document.getElementById('r-show-prix') ? document.getElementById('r-show-prix').checked : true,
    volume:       document.getElementById('r-volume') ? document.getElementById('r-volume').value : '',
    photoComments: [0,1,2,3,4,5].map(i => { const el = document.getElementById('r-photo-comment-'+i); return el ? el.value : ''; }),
    materiels:    state.materiels || [],
    materielComment: document.getElementById('r-materiel-comment') ? document.getElementById('r-materiel-comment').value : '',
    garantieNote: document.getElementById('r-garantie-note') ? document.getElementById('r-garantie-note').value : '',
    sigClient:    document.getElementById('sig-client') ? document.getElementById('sig-client').toDataURL() : '',
    sigLocataire: document.getElementById('sig-locataire') ? document.getElementById('sig-locataire').toDataURL() : '',
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
    photos:       state.photos || [],
  };
}
