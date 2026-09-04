// ============================================================
// DERATEK — Configuration
// ============================================================
const DERATEK_CONFIG = {
  supabase: {
    url:     'https://orhgyizvoudikkrfwdtt.supabase.co',
    anonKey: 'sb_publishable_iwk-ReoFQev9PtI504IaMQ_WRl8bqVg'
  },
  emailjs: {
    serviceId:  'service_vrngrk7',
    templateId: 'template_1mz9kem',
    publicKey:  '2rIx6hxRMTG3aLJQw'
  },
  email: {
    deratek: 'info@deratek.ch'
  },
  mistral: {
    // La cle n'est PLUS ici : elle vit dans les secrets Supabase (MISTRAL_API_KEY)
    // et l'application passe par la fonction /functions/v1/ia. Ainsi elle n'est
    // plus lisible depuis le site public ni depuis le depot GitHub.
    apiKey: '',
    // Modeles disponibles dans l'organisation Mistral de DERATEK (page « Limites »).
    // pixtral-12b-2409 n'existe plus : la lecture d'images passe par un modele
    // multimodal encore en service.
    model:       'mistral-small-2603',   // texte
    modelVision: 'mistral-medium-latest' // images et PDF scannes
  },
  app: {
    name: 'DERATEK',
    version: '3.1',
    maxRapports: 50
  },
  // Coordonnées de l'entreprise (créancier sur les QR-factures + en-tête devis/factures)
  company: {
    nom:      'Deratek',
    rue:      'Rue des Mille-Boilles 2',
    npa:      '2000',
    ville:    'Neuchâtel',
    pays:     'CH',
    tel:      '032 552 21 72',
    email:    'info@deratek.ch',
    tva:      'CHE-276.656.145 TVA',
    iban:     'CH41 0900 0000 1570 2659 7',
    refType:  'NON',     // IBAN classique sans référence structurée
    devise:   'CHF',
    tvaTaux:  8.1        // taux TVA standard suisse
  }
};
