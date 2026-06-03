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
    // Logo DERATEK (image, version sombre) en haut à gauche sur une carte blanche
    let logoOk = false;
    if (typeof LOGO_B64 !== 'undefined' && LOGO_B64) {
      try {
        const logoW = 46, logoH = logoW * 199 / 900; // ratio d'origine du logo
        const padX = 3, padY = 2.5;
        const cardW = logoW + padX * 2, cardH = logoH + padY * 2;
        const cardY = (32 - cardH) / 2;
        doc.setFillColor(255, 255, 255);
        doc.roundedRect(M, cardY, cardW, cardH, 1.5, 1.5, 'F');
        doc.addImage(LOGO_B64, 'PNG', M + padX, cardY + padY, logoW, logoH);
        logoOk = true;
      } catch (e) { logoOk = false; }
    }
    if (!logoOk) {
      doc.setTextColor(...C.white);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(22);
      doc.text('DERATEK', M, 14);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(180, 190, 210);
      doc.text('PROFESSIONAL PEST CONTROL', M, 21);
    }
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
      // Fond en dégradé bleu (foncé → clair) simulé par fines bandes verticales
      const h = 7, steps = 60;
      const c1 = [26, 39, 68];    // navy foncé (gauche)
      const c2 = [59, 130, 246];  // bleu clair (droite)
      for (let i = 0; i < steps; i++) {
        const t = i / (steps - 1);
        const r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
        const g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
        const b = Math.round(c1[2] + (c2[2] - c1[2]) * t);
        doc.setFillColor(r, g, b);
        doc.rect(M + (CW * i / steps), y, CW / steps + 0.5, h, 'F');
      }
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.text(title.toUpperCase(), M + 3, y + 4.8);
      y += 10;
    }

    function row(key, val, shade) {
      if (!val) return;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      const valLines = doc.splitTextToSize(String(val), CW - 6);
      const rowH = Math.max(8, valLines.length * 5 + 5);
      checkPage(rowH + 2);
      if (shade) { doc.setFillColor(249, 250, 251); doc.rect(M, y, CW, rowH, 'F'); }
      // Clé en gris petit au-dessus
      doc.setTextColor(...C.muted);
      doc.setFontSize(7.5);
      doc.text(String(key).toUpperCase(), M + 2, y + 4);
      // Valeur en dessous alignée à gauche
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(...C.text);
      doc.text(valLines, M + 2, y + 9);
      doc.setDrawColor(...C.border);
      doc.line(M, y + rowH, M + CW, y + rowH);
      y += rowH;
    }

    // Affiche une liste de paires {key,val} sur DEUX colonnes
    function rows2col(pairs) {
      const items = (pairs || []).filter(p => p && p.val);
      if (!items.length) return;
      const colW = (CW - 6) / 2;          // largeur d'une colonne
      const gap = 6;                       // espace entre colonnes
      const colTextW = colW - 6;
      for (let i = 0; i < items.length; i += 2) {
        const left = items[i];
        const right = items[i + 1];
        const lLines = doc.splitTextToSize(String(left.val), colTextW);
        const rLines = right ? doc.splitTextToSize(String(right.val), colTextW) : [];
        const cellH = Math.max(8, lLines.length * 5 + 5, rLines.length * 5 + 5);
        checkPage(cellH + 2);
        const shade = (Math.floor(i / 2) % 2 === 1);
        // Fond grisé sur toute la largeur (évite le décrochage entre colonnes)
        if (shade) { doc.setFillColor(249, 250, 251); doc.rect(M, y, CW, cellH, 'F'); }
        const drawCell = (it, lines, x) => {
          doc.setTextColor(...C.muted); doc.setFont('helvetica','normal'); doc.setFontSize(7.5);
          doc.text(String(it.key).toUpperCase(), x + 2, y + 4);
          doc.setFont('helvetica','bold'); doc.setFontSize(8.5); doc.setTextColor(...C.text);
          doc.text(lines, x + 2, y + 9);
        };
        drawCell(left, lLines, M);
        if (right) drawCell(right, rLines, M + colW + gap);
        doc.setDrawColor(...C.border);
        doc.line(M, y + cellH, M + CW, y + cellH);
        y += cellH;
      }
    }

    function textBox(text, bgColor) {
      if (!text) return;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      const lines = doc.splitTextToSize(String(text), CW - 10);
      const lineH = 5;
      const padding = 8;
      const pageBottom = 285;      // bas de page A4 en mm
      const usableH = pageBottom - 15 - padding; // hauteur de texte sur une page entière
      const maxLinesPerPage = Math.floor(usableH / lineH);

      // Découpe le texte en "morceaux" qui tiennent chacun sur une page,
      // en commençant par remplir la place restante sur la page courante.
      let idx = 0;
      let firstChunk = true;
      while (idx < lines.length) {
        // Place réellement disponible sur la page courante
        let avail = pageBottom - y - padding;
        let linesFit = Math.floor(avail / lineH);
        // Si presque rien ne rentre (< 3 lignes), on passe à la page suivante
        if (linesFit < 3 && (lines.length - idx) > linesFit) {
          doc.addPage(); y = 15;
          avail = pageBottom - y - padding;
          linesFit = Math.floor(avail / lineH);
        }
        const take = Math.min(linesFit, maxLinesPerPage, lines.length - idx);
        const chunk = lines.slice(idx, idx + take);
        const h = chunk.length * lineH + padding;
        if (bgColor) doc.setFillColor(...bgColor); else doc.setFillColor(249, 250, 251);
        doc.roundedRect(M, y, CW, h, 2, 2, 'F');
        doc.setDrawColor(...C.border);
        doc.roundedRect(M, y, CW, h, 2, 2, 'S');
        doc.setTextColor(...C.text);
        doc.text(chunk, M + 4, y + 6);
        y += h + 4;
        idx += take;
        firstChunk = false;
        if (idx < lines.length) { doc.addPage(); y = 15; }
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

    // ── INFOS GÉNÉRALES (deux colonnes) ──────────────────────
    sTitle('Informations générales');
    const adresseFull = (rapport.adresse||'') + (rapport.npa?' '+rapport.npa:'') + (rapport.ville?' '+rapport.ville:'');
    // Le nom de la gérance + son adresse sont regroupés dans la même case "Client"
    const clientBloc = (rapport.clientNom || '') + (adresseFull.trim() ? '\n' + adresseFull.trim() : '');
    const infoPairs = [
      { key: 'Technicien',            val: rapport.tech },
      { key: 'Client',                val: clientBloc },
      { key: 'N° Bon de commande',    val: rapport.bonCommande },
      { key: (rapport.contactRole && rapport.contactRole !== 'Contact') ? rapport.contactRole : 'Contact',
        val: String(rapport.contact || '').replace(/^\[ROLE:[^\]]*\]/, '').trim() },
      { key: 'Téléphone',             val: rapport.tel },
      { key: 'Email',                 val: rapport.email },
    ];
    if (rapport.locataire) {
      infoPairs.push({ key: 'Locataire', val: rapport.locataire });
      infoPairs.push({ key: 'Tél. locataire', val: rapport.locataireTel });
      infoPairs.push({ key: 'Email locataire', val: rapport.locataireEmail });
      infoPairs.push({ key: "Adresse d'intervention", val: rapport.locataireAdresse });
    }
    infoPairs.push({ key: 'Bâtiment',       val: rapport.batiment });
    infoPairs.push({ key: 'Localisation',   val: rapport.localisation });
    infoPairs.push({ key: 'N° Intervention', val: rapport.noint });
    rows2col(infoPairs);
    y += 5;

    // ── NUISIBLES & NIVEAU  +  TRAITEMENT (bandeau partagé 2 colonnes) ──
    const tLabels = {
      't-pulv':'Pulvérisation','t-vapeur':'Vapeur','t-thermique':'Thermique',
      't-injection':'Injection','t-appats':'Appâts/pièges','t-monitoring':'Monitoring',
      't-desinfect':'Désinfection','t-flocage':'Flocage','t-gel':'Gel','t-poudre':'Poudre',
      't-fumigation':'Fumigation','t-pose':'Pièges mécaniques',
      't-appatage':"Boîtes d'appâtage sécurisées",'t-rodenticide':'Rodenticides professionnels',
      't-racumin':'Racumin','t-talonwax':'Talonwax injection'
    };
    const methodes = (rapport.traitement||[]).map(t => tLabels[t]||t);
    checkPage(40);
    const colW = (CW - 6) / 2;
    const xL = M, xR = M + colW + 6;
    // Bandeau dégradé partagé avec deux titres
    {
      const h = 7, steps = 60, c1 = [26,39,68], c2 = [59,130,246];
      for (let i = 0; i < steps; i++) {
        const t = i/(steps-1);
        doc.setFillColor(Math.round(c1[0]+(c2[0]-c1[0])*t), Math.round(c1[1]+(c2[1]-c1[1])*t), Math.round(c1[2]+(c2[2]-c1[2])*t));
        doc.rect(M + (CW*i/steps), y, CW/steps + 0.5, h, 'F');
      }
      doc.setTextColor(255,255,255); doc.setFont('helvetica','bold'); doc.setFontSize(7.5);
      doc.text("NUISIBLES & NIVEAU", xL + 3, y + 4.8);
      doc.text("TRAITEMENT APPLIQUÉ", xR + 3, y + 4.8);
      y += 10;
    }
    const yTop = y;
    // ----- Colonne GAUCHE : nuisibles + niveau + superficie -----
    let yL = yTop;
    const nuisibles = rapport.nuisibles || [];
    if (nuisibles.length) {
      let tagX = xL;
      nuisibles.forEach(n => {
        if (tagX + doc.getTextWidth(n) + 12 > xL + colW) { yL += 9; tagX = xL; }
        const tw = doc.getTextWidth(n) + 6;
        doc.setFillColor(...C.red); doc.roundedRect(tagX, yL, tw, 6, 1, 1, 'F');
        doc.setTextColor(...C.white); doc.setFont('helvetica','bold'); doc.setFontSize(7.5);
        doc.text(n, tagX + 3, yL + 4.2);
        tagX += tw + 3;
      });
      yL += 9;
    }
    if (rapport.niveau) {
      doc.setFillColor(255,240,240); doc.roundedRect(xL, yL, colW, 11, 2, 2, 'F');
      doc.setTextColor(...C.muted); doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.text("NIVEAU D'INFESTATION", xL+3, yL+4);
      doc.setTextColor(...C.red); doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.text(String(rapport.niveau), xL+3, yL+9);
      yL += 13;
    }
    if (rapport.superficie || rapport.pieces) {
      const supText = (rapport.superficie ? rapport.superficie + ' m²' : '—') + (rapport.pieces ? ' / ' + rapport.pieces + ' pièce(s)' : '');
      doc.setFillColor(255,248,230); doc.roundedRect(xL, yL, colW, 11, 2, 2, 'F');
      doc.setTextColor(...C.muted); doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.text('SUPERFICIE / PIÈCES', xL+3, yL+4);
      doc.setTextColor(176,120,0); doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.text(supText, xL+3, yL+9);
      yL += 13;
    }
    // ----- Colonne DROITE : méthodes de traitement -----
    let yR = yTop;
    if (methodes.length) {
      methodes.forEach(m => {
        const lines = doc.splitTextToSize('• ' + m, colW - 4);
        doc.setTextColor(30,64,175); doc.setFont('helvetica','bold'); doc.setFontSize(8.5);
        doc.text(lines, xR + 2, yR + 4);
        yR += lines.length * 4.5 + 1.5;
      });
    } else {
      doc.setTextColor(...C.muted); doc.setFont('helvetica','normal'); doc.setFontSize(8.5);
      doc.text('—', xR + 2, yR + 4); yR += 6;
    }
    // On reprend sous la plus longue des deux colonnes
    y = Math.max(yL, yR) + 3;
    if (rapport.zones) { row('Zones touchées', rapport.zones, false); y += 3; }

    // ── PASSAGES / DATES D'INTERVENTION ──────────────────────
    const _datesInt = Array.isArray(rapport.datesInterv) ? rapport.datesInterv.filter(Boolean) : [];
    if (rapport.nbPassages || _datesInt.length) {
      if (rapport.nbPassages) row('Nombre de passages', String(rapport.nbPassages), false);
      if (_datesInt.length) row("Dates d'intervention", _datesInt.map(d => fmtDate(d)).join(', '), false);
      y += 3;
    }

    // ── OBSERVATIONS ─────────────────────────────────────────
    sTitle('Observations sur place');
    // Sécurité : retire d'éventuels marqueurs internes restés dans la description
    textBox(String(rapport.description || '').replace(/\s*\[NBPASS:[^\]]*\]/g, '').replace(/\s*\[DATESINT:[^\]]*\]/g, '').replace(/\s*\[LOC:[^\]]*\]/g, '').trim());
    if (rapport.origine) {
      checkPage(15);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...C.muted);
      doc.text('ORIGINE PROBABLE', M, y + 4);
      y += 7;
      textBox(rapport.origine);
    }
    if (rapport.contraintes) {
      checkPage(15);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...C.muted);
      doc.text('CONTRAINTES', M, y + 4);
      y += 7;
      textBox(rapport.contraintes);
    }
    y += 3;

    // ── PRODUITS & MATÉRIELS (le traitement appliqué est déjà au-dessus) ──
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

    if (rapport.precautions && rapport.showPrecautions !== false) {
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

    // ── PHOTOS avec commentaires (avant Résultat & Recommandations) ──
    const photos = rapport.photos || window._currentPhotos || [];
    const photoComments = rapport.photoComments || [];
    const validPhotos = photos.filter(p => p);
    if (validPhotos.length) {
      // Pas de saut de page forcé : on enchaîne, et on ne change de page que si besoin
      checkPage(80);
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

    // RDV + Garantie + Montant + Durée selon coches
    const showPrix = rapport.showPrix !== false;
    const showDuree = rapport.showDuree !== false;
    const showRdv = rapport.showRdv !== false;
    const showGarantie = rapport.showGarantie !== false;
    const showGarantieNote = rapport.showGarantieNote !== false;

    const boxes = [];
    if (showPrix && rapport.montant) boxes.push([rapport.montant + ' CHF', 'Montant', C.navy, C.white]);
    if (showRdv && rapport.rdv) {
      const rdvLabel = fmtDate(rapport.rdv) + (rapport.rdvHeure ? ' à ' + rapport.rdvHeure : '');
      boxes.push([rdvLabel, 'Prochain RDV', [240,243,248], C.navy]);
    }
    if (showGarantie && rapport.garantie) boxes.push([rapport.garantie, 'Garantie', [240,243,248], C.navy]);
    if (showDuree && rapport.duree) boxes.push([rapport.duree + ' h', 'Durée', [240,243,248], C.navy]);

    if (boxes.length) {
      checkPage(25);
      const boxW = (CW - (boxes.length-1)*4) / boxes.length;
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
    }
    if (showGarantieNote && rapport.garantieNote) { textBox(rapport.garantieNote); y += 3; }

    // ── SIGNATURE (uniquement locataire) ─────────────────────
    const showSigClient = rapport.showSigClient !== false;
    if (showSigClient) {
      checkPage(55);
      sTitle('Signature');
      y += 3;
      const sigW = (CW - 10) / 2; // même largeur qu'avant (demi-page)
      const bx = M;
      doc.setFillColor(249, 250, 251);
      doc.roundedRect(bx, y, sigW, 38, 2, 2, 'F');
      doc.setDrawColor(...C.border);
      doc.roundedRect(bx, y, sigW, 38, 2, 2, 'S');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(...C.navy);
      doc.text('LOCATAIRE', bx + 3, y + 6);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...C.text);
      doc.text(rapport.locataire || '—', bx + 3, y + 13);
      doc.setFillColor(255,255,255);
      doc.rect(bx + 3, y + 16, sigW - 6, 14, 'F');
      if (rapport.sigLocataire && rapport.sigLocataire.length > 100 && rapport.sigLocataire !== 'data:,') {
        try { doc.addImage(rapport.sigLocataire, 'PNG', bx + 3, y + 16, sigW - 6, 14); } catch(e) {}
      }
      doc.setDrawColor(...C.border);
      doc.line(bx + 3, y + 31, bx + sigW - 3, y + 31);
      doc.setFontSize(7); doc.setTextColor(...C.muted);
      doc.text('Signature', bx + 3, y + 36);
      doc.text(fmtDate(rapport.date), bx + sigW - 3, y + 36, { align: 'right' });
      y += 44;
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
  ['t-pulv','t-vapeur','t-thermique','t-injection','t-appats','t-monitoring','t-desinfect','t-flocage','t-gel','t-poudre','t-fumigation','t-pose','t-appatage','t-rodenticide','t-racumin','t-talonwax'].forEach(id => {
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
    contactRole:  document.getElementById('r-contact-role') ? document.getElementById('r-contact-role').value : '',
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
    showDuree:    document.getElementById('r-show-duree') ? document.getElementById('r-show-duree').checked : true,
    showRdv:      document.getElementById('r-show-rdv') ? document.getElementById('r-show-rdv').checked : true,
    showGarantie: document.getElementById('r-show-garantie') ? document.getElementById('r-show-garantie').checked : true,
    showGarantieNote: document.getElementById('r-show-garantie-note') ? document.getElementById('r-show-garantie-note').checked : true,
    showPrecautions: document.getElementById('r-show-precautions') ? document.getElementById('r-show-precautions').checked : true,
    volume:       document.getElementById('r-volume') ? document.getElementById('r-volume').value : '',
    photoComments: [0,1,2,3,4,5].map(i => { const el = document.getElementById('r-photo-comment-'+i); return el ? el.value : ''; }),
    materiels:    state.materiels || [],
    materielComment: document.getElementById('r-materiel-comment') ? document.getElementById('r-materiel-comment').value : '',
    garantieNote: document.getElementById('r-garantie-note') ? document.getElementById('r-garantie-note').value : '',
    showSigClient: document.getElementById('r-show-sig-client') ? document.getElementById('r-show-sig-client').checked : true,
    sigLocataire: document.getElementById('sig-locataire') ? document.getElementById('sig-locataire').toDataURL() : '',
    nuisibles, description: document.getElementById('r-description').value,
    nbPassages:   document.getElementById('r-nb-passages') ? document.getElementById('r-nb-passages').value : '',
    datesInterv:  (typeof rReadDates === 'function') ? rReadDates() : [],
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
    rdvHeure:     document.getElementById('r-rdv-heure') ? document.getElementById('r-rdv-heure').value : '',
    garantie:     document.getElementById('r-garantie').value,
    photos:       state.photos || [],
  };
}
