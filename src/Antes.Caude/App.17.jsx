import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, doc, setDoc, onSnapshot, addDoc, updateDoc, deleteDoc, getDocs, writeBatch } from 'firebase/firestore';
import {
  Trash2, Flag, Fuel, CheckCircle2, Circle, Home, List, Pencil
} from 'lucide-react';
import logoBastos from './assets/logoBastos.png';
import logoSemFundo from './assets/logoSemFundo.png'; // by BASTOS, fundo transparente
import logoRoute from './assets/logoRoute.jpg'; // ícone RouteFlex (setas)

// Configuração Firebase: 1) injetada pela plataforma, 2) variáveis VITE_FIREBASE_* do .env, 3) demo
const envConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

const firebaseConfig =
  typeof __firebase_config !== 'undefined'
    ? JSON.parse(__firebase_config)
    : envConfig.apiKey
    ? envConfig
    : {
        apiKey: "demo-key",
        authDomain: "demo.firebaseapp.com",
        projectId: "demo-project",
        storageBucket: "demo.appspot.com",
        messagingSenderId: "123456789",
        appId: "1:123456789:web:demo"
      };

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = typeof __app_id !== 'undefined' ? __app_id : 'routeflex-pro-app';

// ---------- Reset de dados obsoletos ----------
// Os destinos antigos (Hospital de São José, etc.) vivem no FIRESTORE, em
// artifacts/{appId}/users/{uid}/stops, e voltam a cada arranque via onSnapshot.
// Por isso o reset tem de apagar a nuvem, não só o localStorage.
// Incrementa DATA_VERSION sempre que quiseres que TODOS os utilizadores arranquem limpos.
const DATA_VERSION = '3';
const DATA_VERSION_KEY = 'routeflex_data_version'; // chave nova: ignora flags antigas ('app_version')

const purgeCloudData = async (uid) => {
  const stopsCol = collection(db, 'artifacts', appId, 'users', uid, 'stops');
  const snap = await getDocs(stopsCol);
  for (let i = 0; i < snap.docs.length; i += 400) { // limite do Firestore: 500 operações por batch
    const batch = writeBatch(db);
    snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  // Só limpa o destino final guardado (mantém consumo/preço do combustível)
  await setDoc(doc(db, 'artifacts', appId, 'users', uid, 'settings', 'main'), { finalDest: null }, { merge: true });
};

// Garante um utilizador autenticado (anónimo se necessário).
// Partilha a mesma tentativa entre chamadas simultâneas (arranque + clique do utilizador).
let authPromise = null;
const ensureUser = async () => {
  if (typeof auth.authStateReady === 'function') await auth.authStateReady(); // espera restauro da sessão
  if (auth.currentUser) return auth.currentUser;
  if (!authPromise) {
    authPromise = signInAnonymously(auth)
      .then((cred) => cred.user)
      .finally(() => { authPromise = null; });
  }
  return authPromise;
};

// `t` = função de tradução do componente (ver useState de lang)
const authErrorMessage = (e, t) => {
  const code = e?.code || '';
  if (code === 'auth/operation-not-allowed' || code === 'auth/admin-restricted-operation') {
    return t('auth_anon');
  }
  if (code === 'auth/api-key-not-valid.-please-pass-a-valid-api-key.' || code === 'auth/invalid-api-key') {
    return t('auth_cfg');
  }
  if (code === 'auth/network-request-failed') {
    return t('auth_net');
  }
  return t('auth_generic', { code: code ? ` (${code})` : '' });
};

// Escapa texto do utilizador antes de o inserir em popups HTML do Leaflet
const escapeHtml = (t) =>
  String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Rotas e custos ----------
const haversineKm = (a, b) => {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

// Estimativa offline: linha reta entre os pontos x 1.3 (fator médio de estrada)
const estimateRouteKm = (points) =>
  points.slice(1).reduce((km, p, i) => km + haversineKm(points[i], p), 0) * 1.3;

// Estado de confirmação da localização de uma paragem.
// Sobe quando a geocodificação melhora: paragens antigas passam a 'por confirmar' (⚠️).
const GEO_OK = 'ok2';

// ---------- Ordenação por proximidade (Nearest Neighbor) ----------
const hasCoords = (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng);

// Ordena as paragens pela distância real (haversine): começa no `origin` (GPS) e vai sempre
// para a paragem não visitada mais próxima da atual. Sem `origin`, parte da 1ª paragem da lista.
// Paragens sem coordenadas válidas não se conseguem ordenar: vão para o fim, pela ordem original.
const orderByProximity = (list, origin = null) => {
  const remaining = list.filter(hasCoords);
  const withoutCoords = list.filter((p) => !hasCoords(p));
  const ordered = [];

  let current = hasCoords(origin) ? origin : remaining.shift();
  if (current && current !== origin) ordered.push(current);

  while (current && remaining.length > 0) {
    let nearest = 0;
    let best = Infinity;
    remaining.forEach((p, i) => {
      const d = haversineKm(current, p);
      if (d < best) { best = d; nearest = i; }
    });
    current = remaining.splice(nearest, 1)[0];
    ordered.push(current);
  }
  return [...ordered, ...withoutCoords];
};

// ---------- Qualidade da geocodificação ----------
const plainText = (t) => String(t || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// "rua da alegria,40,lisboa" -> "rua da alegria 40, lisboa" (vírgulas com espaço; nº de porta junto da rua)
const normalizeQuery = (q) => {
  const tokens = String(q).split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  tokens.forEach((tok) => {
    if (/^\d{1,4}[A-Za-z]?$/.test(tok) && out.length > 0 && !/^\d/.test(out[out.length - 1])) {
      out[out.length - 1] += ' ' + tok; // nº de porta
    } else {
      out.push(tok);
    }
  });
  return out.join(', ');
};

// Localidade pedida pelo utilizador = último pedaço sem dígitos (ignora "Portugal")
const cityOfQuery = (q) => {
  const tokens = q.split(', ');
  for (let i = tokens.length - 1; i > 0; i--) {
    const tk = plainText(tokens[i]);
    if (tk && tk !== 'portugal' && !/\d/.test(tk)) return tk;
  }
  return null;
};

// Entre os candidatos do Nominatim: 1º só os da localidade pedida; 2º o mais perto do utilizador
const pickBestResult = (data, q, userPos) => {
  const city = cityOfQuery(q);
  const byCity = city ? data.filter((r) => plainText(r.display_name).includes(city)) : [];
  const pool = byCity.length ? byCity : data;
  if (Number.isFinite(userPos?.lat) && Number.isFinite(userPos?.lng) && pool.length > 1) {
    const dist = (r) => haversineKm(userPos, { lat: parseFloat(r.lat), lng: parseFloat(r.lon) });
    return [...pool].sort((a, b) => dist(a) - dist(b))[0];
  }
  return pool[0];
};

// Pede a rota ao OSRM (lança erro se falhar)
const fetchOsrmRoute = async (points) => {
  const coords = points.map((w) => `${w.lng},${w.lat}`).join(';');
  const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`);
  if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes?.[0]) throw new Error(data.message || data.code || 'Rota impossível');
  return data.routes[0];
};

// Grupo de uma paragem: '' = sem grupo (mostrado como GERAL).
// 'Todos' é o filtro "ver tudo" e 'Editar ✏️' é o pill por nomear: nenhum dos dois é um grupo real.
const UNNAMED_GROUP = 'Editar ✏️';

// ============================================================
// TRADUÇÕES (i18n) — PT é a língua base; EN / ES / FR completas.
// Para mudar um texto: edite-o aqui. Para adicionar uma língua: copie um bloco e acrescente-a em LANGS.
// {n}, {i}, {c}, {g}, {a}, {code} são substituídos por t('chave', { n: 3 }).
// Chaves terminadas em _one são usadas quando n === 1 (singular).
// ============================================================
const LANGS = [
  { code: 'pt', locale: 'pt-PT', label: 'PT' },
  { code: 'en', locale: 'en-GB', label: 'EN' },
  { code: 'es', locale: 'es-ES', label: 'ES' },
  { code: 'fr', locale: 'fr-FR', label: 'FR' }
];

const TRANSLATIONS = {
  pt: {
    panel_collapse: 'Recolher',
    panel_edit: 'Editar',
    panel_add: 'Adicionar',
    geo_progress: 'A localizar moradas… {done}/{total}',
    import_missing: '{f} sem localização (marcadas com ⚠️). Corrija a morada para as incluir na rota.',
    fix_locations: 'Corrigir localizações ({n})',
    fix_done: 'Localizações atualizadas: {ok} encontradas, {f} não encontradas.',
    geo_unverified: 'Localização por confirmar',
    clear_all: 'Limpar todos os destinos',
    clear_confirm: 'Apagar todos os destinos e o destino final? Esta ação não pode ser desfeita.',
    // Cabeçalhos
    hdr_home: 'RouteFlex Pro',
    hdr_lists: 'Gestor de Rotas & Destinos',
    hdr_map: 'Mapa Interativo',
    hdr_costs: 'Combustível & Definições',
    // Navegação
    nav_home: 'Início',
    nav_lists: 'Destinos',
    nav_costs: 'Custos',
    lang_label: 'Idioma',
    // Dashboard
    today_route: 'ROTA DE HOJE',
    selected_dest: '{n} Destinos Selecionados',
    selected_dest_one: '{n} Destino Selecionado',
    est_cost: 'Custo Est.:',
    launch_gmaps: 'Iniciar Percurso',
    pro_active: 'RouteFlex Pro Ativo',
    pro_activate: 'Ativar Versão Pro',
    pro_sub_active: 'Sincronização e CSV desbloqueados',
    pro_sub_free: 'Desbloqueie todas as funções avançadas',
    badge_active: 'Ativo ✓',
    badge_unlock: 'Desbloquear ➔',
    pro_alert: 'A sua licença Route Pro está ativa e totalmente funcional!',
    quick_tools: 'Ferramentas Rápidas',
    import_csv: 'Importar CSV',
    // Listas
    groups_title: 'GRUPOS DE DESTINOS',
    all: 'Todos',
    name_ph: 'Nome...',
    ok: 'OK',
    edit_pill: 'Editar ✏️',
    new_dest: 'Novo Destino',
    edit_dest: 'Editar Destino',
    cancel: 'Cancelar',
    ph_client: 'Nome / Entidade',
    ph_address: 'Morada ou local (ex: Oxford Street, London ou Eiffel Tower)',
    ph_postal: 'Código Postal (opcional)',
    ph_floor: 'Andar / Fração (ex: 3º Dto)',
    ph_notes: 'Notas / Códigos de acesso',
    general_opt: 'GERAL (sem grupo)',
    general: 'GERAL',
    searching: 'A pesquisar no mapa...',
    save_changes: '💾 Guardar Alterações',
    add_dest: '+ Adicionar Destino',
    final_title: 'Destino Final de Retorno',
    ph_final: 'Morada de retorno...',
    selected_today: 'DESTINOS SELECIONADOS PARA HOJE:',
    export_csv: 'Exportar CSV:',
    all_groups: 'Todos os grupos',
    edit_aria: 'Editar destino',
    open_full_route: 'Iniciar Percurso',
    final_dest_label: 'Destino final: {a}',
    // Cartão do mapa
    route_summary: 'Resumo da rota',
    distance: 'Distância',
    duration: 'Duração',
    consumption: 'Consumo',
    est_cost_lbl: 'Custo estimado',
    // Custos
    energy_title: 'Tipo de Energia / Veículo',
    editable: 'Editável',
    e_label_Gasóleo: '⛽ Gasóleo',
    e_label_Gasolina95: '⛽ Gasolina 95',
    e_label_GPL: '🔥 GPL Auto',
    e_label_Elétrico: '⚡ Elétrico (EV)',
    e_name_Gasóleo: 'Gasóleo',
    e_name_Gasolina95: 'Gasolina 95',
    e_name_GPL: 'GPL',
    e_name_Elétrico: 'Elétrico',
    price_kwh: 'Preço por kWh (€)',
    price_l: 'Preço por Litro (€)',
    cons_kwh: 'Consumo (kWh/100km)',
    cons_l: 'Consumo (L/100km)',
    plate: 'Matrícula (Opcional)',
    // Paywall
    pw_title: 'RouteFlex Pro',
    pw_sub: 'Desbloqueie a sincronização em nuvem e a importação/exportação de listas.',
    pw_f1: 'Sincronização permanente entre Telemóvel e PC',
    pw_f2: 'Importação em bloco de listas com endereços(CSV)',
    pw_f3: 'Exportação em ficheiro de Cópias de Segurança',
    pw_f4: 'Guardar destinos ilimitados na nuvem',
    plan_monthly: 'Plano Mensal',
    price_month: '9,99 €',
    per_month: '/ mês',
    plan_yearly: 'Plano Anual',
    save_badge: 'Poupe ~20€',
    price_year: '99,99 €',
    per_year: '/ ano',
    pay_monthly_alert: 'Redirecionar para Pagamento Mensal (9,99€)',
    pay_yearly_alert: 'Redirecionar para Pagamento Anual (99,99€)',
    have_code: 'Tem um código de ativação ou licença?',
    ph_code: 'Insira o código',
    activate: 'Ativar',
    continue_free: 'Continuar no plano gratuito',
    code_ok: ' Código ativado com sucesso! Bem-vindo ao RouteFlex Pro.',
    code_bad: 'Código inválido ou expirado.',
    // Alertas
    no_export: 'Não há destinos para exportar.',
    no_dest_group: 'Não há destinos no grupo "{g}".',
    csv_empty: 'O ficheiro CSV está vazio ou sem dados.',
    client_n: 'Cliente {i}',
    import_ok: 'Importação concluída! {n} destinos carregados com sucesso.',
    import_ok_one: 'Importação concluída! {n} destino carregado com sucesso.',
    import_none: 'Não foram encontrados dados válidos.',
    import_err: 'Ocorreu um erro ao processar o ficheiro CSV.',
    enter_addr: 'Introduza a morada do local.',
    not_found: 'Morada não encontrada.',
    process_err: 'Erro ao processar o destino.',
    final_removed: 'Ponto de chegada removido (opcional).',
    final_nf: 'Destino final não encontrado.',
    final_ok: 'Ponto de chegada definido com sucesso!',
    final_err: 'Erro ao geocodificar o destino final.',
    sel_one: 'Selecione pelo menos uma morada para a rota.',
    route_fail: 'Não foi possível calcular a rota (serviço OSRM indisponível ou coordenadas inválidas).',
    // Popups do mapa
    popup_start: 'Ponto de Partida (Localização Atual)',
    popup_delivery: 'Entrega {i}: {c}',
    popup_nav: 'Navegar no Google Maps',
    popup_final: 'DESTINO FINAL',
    // Erros de autenticação
    auth_anon: 'Ative o início de sessão "Anónimo" no Firebase Console (Authentication → Sign-in method).',
    auth_cfg: 'Configuração Firebase inválida (chaves de demonstração). Defina as variáveis VITE_FIREBASE_* no ficheiro .env.',
    auth_net: 'Sem ligação à internet para autenticar. Tente novamente.',
    auth_generic: 'Erro de autenticação{code}.',
    // Cabeçalhos do CSV (exportação)
    csv_client: 'Cliente',
    csv_address: 'Morada',
    csv_postal: 'Código Postal',
    csv_floor: 'Andar',
    csv_notes: 'Notas',
    csv_group: 'Grupo'
  },

  en: {
    panel_collapse: 'Collapse',
    panel_edit: 'Edit',
    panel_add: 'Add',
    geo_progress: 'Locating addresses… {done}/{total}',
    import_missing: '{f} could not be located (marked ⚠️). Fix the address to include them in the route.',
    fix_locations: 'Fix locations ({n})',
    fix_done: 'Locations updated: {ok} found, {f} not found.',
    geo_unverified: 'Location not confirmed',
    clear_all: 'Clear all stops',
    clear_confirm: 'Delete all stops and the final destination? This cannot be undone.',
    hdr_home: 'RouteFlex Pro',
    hdr_lists: 'Route & Stop Manager',
    hdr_map: 'Interactive Map',
    hdr_costs: 'Fuel & Settings',
    nav_home: 'Home',
    nav_lists: 'Stops',
    nav_costs: 'Costs',
    lang_label: 'Language',
    today_route: "TODAY'S ROUTE",
    selected_dest: '{n} Stops Selected',
    selected_dest_one: '{n} Stop Selected',
    est_cost: 'Est. Cost:',
    launch_gmaps: 'Start Route',
    pro_active: 'RouteFlex Pro Active',
    pro_activate: 'Activate Pro Version',
    pro_sub_active: 'Sync and CSV unlocked',
    pro_sub_free: 'Unlock all advanced features',
    badge_active: 'Active ✓',
    badge_unlock: 'Unlock ➔',
    pro_alert: 'Your Route Pro licence is active and fully functional!',
    quick_tools: 'Quick Tools',
    import_csv: 'Import CSV',
    groups_title: 'STOP GROUPS',
    all: 'All',
    name_ph: 'Name...',
    ok: 'OK',
    edit_pill: 'Edit ✏️',
    new_dest: 'New Stop',
    edit_dest: 'Edit Stop',
    cancel: 'Cancel',
    ph_client: 'Name / Business',
    ph_address: 'Address or place (e.g. Oxford Street, London or Eiffel Tower)',
    ph_postal: 'Postcode (optional)',
    ph_floor: 'Floor / Flat (e.g. 3rd Right)',
    ph_notes: 'Notes / Access codes',
    general_opt: 'GENERAL (no group)',
    general: 'GENERAL',
    searching: 'Searching the map...',
    save_changes: '💾 Save Changes',
    add_dest: '+ Add Stop',
    final_title: 'Final Return Destination',
    ph_final: 'Return address...',
    selected_today: 'STOPS SELECTED FOR TODAY:',
    export_csv: 'Export CSV:',
    all_groups: 'All groups',
    edit_aria: 'Edit stop',
    open_full_route: 'Start Route',
    final_dest_label: 'Final destination: {a}',
    route_summary: 'Route summary',
    distance: 'Distance',
    duration: 'Duration',
    consumption: 'Consumption',
    est_cost_lbl: 'Estimated cost',
    energy_title: 'Energy Type / Vehicle',
    editable: 'Editable',
    e_label_Gasóleo: '⛽ Diesel',
    e_label_Gasolina95: '⛽ Petrol 95',
    e_label_GPL: '🔥 LPG Auto',
    e_label_Elétrico: '⚡ Electric (EV)',
    e_name_Gasóleo: 'Diesel',
    e_name_Gasolina95: 'Petrol 95',
    e_name_GPL: 'LPG',
    e_name_Elétrico: 'Electric',
    price_kwh: 'Price per kWh (€)',
    price_l: 'Price per Litre (€)',
    cons_kwh: 'Consumption (kWh/100km)',
    cons_l: 'Consumption (L/100km)',
    plate: 'Licence plate (Optional)',
    pw_title: 'RouteFlex Pro',
    pw_sub: 'Unlock cloud sync and list import/export.',
    pw_f1: 'Permanent sync between Phone and PC',
    pw_f2: 'Bulk import of address lists (CSV)',
    pw_f3: 'Backup export to file',
    pw_f4: 'Store unlimited stops in the cloud',
    plan_monthly: 'Monthly Plan',
    price_month: '€9.99',
    per_month: '/ month',
    plan_yearly: 'Yearly Plan',
    save_badge: 'Save ~€20',
    price_year: '€99.99',
    per_year: '/ year',
    pay_monthly_alert: 'Redirecting to Monthly Payment (€9.99)',
    pay_yearly_alert: 'Redirecting to Yearly Payment (€99.99)',
    have_code: 'Have an activation code or licence?',
    ph_code: 'Enter code',
    activate: 'Activate',
    continue_free: 'Continue on the free plan',
    code_ok: ' Code activated successfully! Welcome to RouteFlex Pro.',
    code_bad: 'Invalid or expired code.',
    no_export: 'There are no stops to export.',
    no_dest_group: 'There are no stops in the group "{g}".',
    csv_empty: 'The CSV file is empty or has no data.',
    client_n: 'Client {i}',
    import_ok: 'Import complete! {n} stops loaded successfully.',
    import_ok_one: 'Import complete! {n} stop loaded successfully.',
    import_none: 'No valid data was found.',
    import_err: 'An error occurred while processing the CSV file.',
    enter_addr: 'Enter the address of the place.',
    not_found: 'Address not found.',
    process_err: 'Error processing the stop.',
    final_removed: 'Arrival point removed (optional).',
    final_nf: 'Final destination not found.',
    final_ok: 'Arrival point set successfully!',
    final_err: 'Error geocoding the final destination.',
    sel_one: 'Select at least one address for the route.',
    route_fail: 'Could not calculate the route (OSRM service unavailable or invalid coordinates).',
    popup_start: 'Starting Point (Current Location)',
    popup_delivery: 'Delivery {i}: {c}',
    popup_nav: 'Navigate in Google Maps',
    popup_final: 'FINAL DESTINATION',
    auth_anon: 'Enable "Anonymous" sign-in in the Firebase Console (Authentication → Sign-in method).',
    auth_cfg: 'Invalid Firebase configuration (demo keys). Set the VITE_FIREBASE_* variables in the .env file.',
    auth_net: 'No internet connection to authenticate. Please try again.',
    auth_generic: 'Authentication error{code}.',
    csv_client: 'Client',
    csv_address: 'Address',
    csv_postal: 'Postcode',
    csv_floor: 'Floor',
    csv_notes: 'Notes',
    csv_group: 'Group'
  },

  es: {
    panel_collapse: 'Contraer',
    panel_edit: 'Editar',
    panel_add: 'Añadir',
    geo_progress: 'Localizando direcciones… {done}/{total}',
    import_missing: '{f} sin localización (marcadas con ⚠️). Corrige la dirección para incluirlas en la ruta.',
    fix_locations: 'Corregir ubicaciones ({n})',
    fix_done: 'Ubicaciones actualizadas: {ok} encontradas, {f} no encontradas.',
    geo_unverified: 'Ubicación sin confirmar',
    clear_all: 'Borrar todos los destinos',
    clear_confirm: '¿Eliminar todos los destinos y el destino final? Esta acción no se puede deshacer.',
    hdr_home: 'RouteFlex Pro',
    hdr_lists: 'Gestor de Rutas y Destinos',
    hdr_map: 'Mapa Interactivo',
    hdr_costs: 'Combustible y Ajustes',
    nav_home: 'Inicio',
    nav_lists: 'Destinos',
    nav_costs: 'Costes',
    lang_label: 'Idioma',
    today_route: 'RUTA DE HOY',
    selected_dest: '{n} Destinos Seleccionados',
    selected_dest_one: '{n} Destino Seleccionado',
    est_cost: 'Coste Est.:',
    launch_gmaps: 'Iniciar Recorrido',
    pro_active: 'RouteFlex Pro Activo',
    pro_activate: 'Activar Versión Pro',
    pro_sub_active: 'Sincronización y CSV desbloqueados',
    pro_sub_free: 'Desbloquea todas las funciones avanzadas',
    badge_active: 'Activo ✓',
    badge_unlock: 'Desbloquear ➔',
    pro_alert: '¡Tu licencia Route Pro está activa y totalmente funcional!',
    quick_tools: 'Herramientas Rápidas',
    import_csv: 'Importar CSV',
    groups_title: 'GRUPOS DE DESTINOS',
    all: 'Todos',
    name_ph: 'Nombre...',
    ok: 'OK',
    edit_pill: 'Editar ✏️',
    new_dest: 'Nuevo Destino',
    edit_dest: 'Editar Destino',
    cancel: 'Cancelar',
    ph_client: 'Nombre / Entidad',
    ph_address: 'Dirección o lugar (ej: Oxford Street, London o Eiffel Tower)',
    ph_postal: 'Código Postal (opcional)',
    ph_floor: 'Piso / Puerta (ej: 3º Dcha)',
    ph_notes: 'Notas / Códigos de acceso',
    general_opt: 'GENERAL (sin grupo)',
    general: 'GENERAL',
    searching: 'Buscando en el mapa...',
    save_changes: '💾 Guardar Cambios',
    add_dest: '+ Añadir Destino',
    final_title: 'Destino Final de Regreso',
    ph_final: 'Dirección de regreso...',
    selected_today: 'DESTINOS SELECCIONADOS PARA HOY:',
    export_csv: 'Exportar CSV:',
    all_groups: 'Todos los grupos',
    edit_aria: 'Editar destino',
    open_full_route: 'Iniciar Recorrido',
    final_dest_label: 'Destino final: {a}',
    route_summary: 'Resumen de la ruta',
    distance: 'Distancia',
    duration: 'Duración',
    consumption: 'Consumo',
    est_cost_lbl: 'Coste estimado',
    energy_title: 'Tipo de Energía / Vehículo',
    editable: 'Editable',
    e_label_Gasóleo: '⛽ Diésel',
    e_label_Gasolina95: '⛽ Gasolina 95',
    e_label_GPL: '🔥 GLP Auto',
    e_label_Elétrico: '⚡ Eléctrico (EV)',
    e_name_Gasóleo: 'Diésel',
    e_name_Gasolina95: 'Gasolina 95',
    e_name_GPL: 'GLP',
    e_name_Elétrico: 'Eléctrico',
    price_kwh: 'Precio por kWh (€)',
    price_l: 'Precio por Litro (€)',
    cons_kwh: 'Consumo (kWh/100km)',
    cons_l: 'Consumo (L/100km)',
    plate: 'Matrícula (Opcional)',
    pw_title: 'RouteFlex Pro',
    pw_sub: 'Desbloquea la sincronización en la nube y la importación/exportación de listas.',
    pw_f1: 'Sincronización permanente entre Móvil y PC',
    pw_f2: 'Importación en bloque de listas con direcciones (CSV)',
    pw_f3: 'Exportación de copias de seguridad en archivo',
    pw_f4: 'Guarda destinos ilimitados en la nube',
    plan_monthly: 'Plan Mensual',
    price_month: '9,99 €',
    per_month: '/ mes',
    plan_yearly: 'Plan Anual',
    save_badge: 'Ahorra ~20€',
    price_year: '99,99 €',
    per_year: '/ año',
    pay_monthly_alert: 'Redirigiendo al Pago Mensual (9,99€)',
    pay_yearly_alert: 'Redirigiendo al Pago Anual (99,99€)',
    have_code: '¿Tienes un código de activación o licencia?',
    ph_code: 'Introduce el código',
    activate: 'Activar',
    continue_free: 'Continuar con el plan gratuito',
    code_ok: ' Código activado con éxito. Bienvenido a RouteFlex Pro.',
    code_bad: 'Código inválido o caducado.',
    no_export: 'No hay destinos para exportar.',
    no_dest_group: 'No hay destinos en el grupo "{g}".',
    csv_empty: 'El archivo CSV está vacío o no tiene datos.',
    client_n: 'Cliente {i}',
    import_ok: '¡Importación completada! {n} destinos cargados con éxito.',
    import_ok_one: '¡Importación completada! {n} destino cargado con éxito.',
    import_none: 'No se encontraron datos válidos.',
    import_err: 'Se produjo un error al procesar el archivo CSV.',
    enter_addr: 'Introduce la dirección del lugar.',
    not_found: 'Dirección no encontrada.',
    process_err: 'Error al procesar el destino.',
    final_removed: 'Punto de llegada eliminado (opcional).',
    final_nf: 'Destino final no encontrado.',
    final_ok: '¡Punto de llegada definido con éxito!',
    final_err: 'Error al geocodificar el destino final.',
    sel_one: 'Selecciona al menos una dirección para la ruta.',
    route_fail: 'No se pudo calcular la ruta (servicio OSRM no disponible o coordenadas inválidas).',
    popup_start: 'Punto de Partida (Ubicación Actual)',
    popup_delivery: 'Entrega {i}: {c}',
    popup_nav: 'Navegar en Google Maps',
    popup_final: 'DESTINO FINAL',
    auth_anon: 'Activa el inicio de sesión "Anónimo" en la consola de Firebase (Authentication → Sign-in method).',
    auth_cfg: 'Configuración de Firebase no válida (claves de demostración). Define las variables VITE_FIREBASE_* en el archivo .env.',
    auth_net: 'Sin conexión a internet para autenticarse. Inténtalo de nuevo.',
    auth_generic: 'Error de autenticación{code}.',
    csv_client: 'Cliente',
    csv_address: 'Dirección',
    csv_postal: 'Código Postal',
    csv_floor: 'Piso',
    csv_notes: 'Notas',
    csv_group: 'Grupo'
  },

  fr: {
    panel_collapse: 'Réduire',
    panel_edit: 'Modifier',
    panel_add: 'Ajouter',
    geo_progress: 'Localisation des adresses… {done}/{total}',
    import_missing: "{f} sans localisation (marquées ⚠️). Corrigez l'adresse pour les inclure dans l'itinéraire.",
    fix_locations: 'Corriger les localisations ({n})',
    fix_done: 'Localisations mises à jour : {ok} trouvées, {f} introuvables.',
    geo_unverified: 'Localisation non confirmée',
    clear_all: 'Effacer toutes les destinations',
    clear_confirm: 'Supprimer toutes les destinations et la destination finale ? Cette action est irréversible.',
    hdr_home: 'RouteFlex Pro',
    hdr_lists: 'Gestionnaire de Tournées & Destinations',
    hdr_map: 'Carte Interactive',
    hdr_costs: 'Carburant & Réglages',
    nav_home: 'Accueil',
    nav_lists: 'Destinations',
    nav_costs: 'Coûts',
    lang_label: 'Langue',
    today_route: "TOURNÉE D'AUJOURD'HUI",
    selected_dest: '{n} Destinations Sélectionnées',
    selected_dest_one: '{n} Destination Sélectionnée',
    est_cost: 'Coût Est. :',
    launch_gmaps: 'Démarrer le Parcours',
    pro_active: 'RouteFlex Pro Actif',
    pro_activate: 'Activer la Version Pro',
    pro_sub_active: 'Synchronisation et CSV débloqués',
    pro_sub_free: 'Débloquez toutes les fonctions avancées',
    badge_active: 'Actif ✓',
    badge_unlock: 'Débloquer ➔',
    pro_alert: 'Votre licence Route Pro est active et entièrement fonctionnelle !',
    quick_tools: 'Outils Rapides',
    import_csv: 'Importer un CSV',
    groups_title: 'GROUPES DE DESTINATIONS',
    all: 'Tous',
    name_ph: 'Nom...',
    ok: 'OK',
    edit_pill: 'Modifier ✏️',
    new_dest: 'Nouvelle Destination',
    edit_dest: 'Modifier la Destination',
    cancel: 'Annuler',
    ph_client: 'Nom / Entité',
    ph_address: 'Adresse ou lieu (ex : Oxford Street, London ou Eiffel Tower)',
    ph_postal: 'Code Postal (facultatif)',
    ph_floor: 'Étage / Porte (ex : 3e Dr.)',
    ph_notes: "Notes / Codes d'accès",
    general_opt: 'GÉNÉRAL (sans groupe)',
    general: 'GÉNÉRAL',
    searching: 'Recherche sur la carte...',
    save_changes: '💾 Enregistrer les Modifications',
    add_dest: '+ Ajouter une Destination',
    final_title: 'Destination Finale de Retour',
    ph_final: 'Adresse de retour...',
    selected_today: "DESTINATIONS SÉLECTIONNÉES POUR AUJOURD'HUI :",
    export_csv: 'Exporter en CSV :',
    all_groups: 'Tous les groupes',
    edit_aria: 'Modifier la destination',
    open_full_route: 'Démarrer le Parcours',
    final_dest_label: 'Destination finale : {a}',
    route_summary: "Résumé de l'itinéraire",
    distance: 'Distance',
    duration: 'Durée',
    consumption: 'Consommation',
    est_cost_lbl: 'Coût estimé',
    energy_title: "Type d'Énergie / Véhicule",
    editable: 'Modifiable',
    e_label_Gasóleo: '⛽ Diesel',
    e_label_Gasolina95: '⛽ Essence 95',
    e_label_GPL: '🔥 GPL Auto',
    e_label_Elétrico: '⚡ Électrique (EV)',
    e_name_Gasóleo: 'Diesel',
    e_name_Gasolina95: 'Essence 95',
    e_name_GPL: 'GPL',
    e_name_Elétrico: 'Électrique',
    price_kwh: 'Prix par kWh (€)',
    price_l: 'Prix par Litre (€)',
    cons_kwh: 'Consommation (kWh/100km)',
    cons_l: 'Consommation (L/100km)',
    plate: "Plaque d'immatriculation (Facultatif)",
    pw_title: 'RouteFlex Pro',
    pw_sub: 'Débloquez la synchronisation dans le cloud et l\'importation/exportation de listes.',
    pw_f1: 'Synchronisation permanente entre Mobile et PC',
    pw_f2: 'Importation en lot de listes d\'adresses (CSV)',
    pw_f3: 'Exportation des sauvegardes dans un fichier',
    pw_f4: 'Destinations illimitées dans le cloud',
    plan_monthly: 'Forfait Mensuel',
    price_month: '9,99 €',
    per_month: '/ mois',
    plan_yearly: 'Forfait Annuel',
    save_badge: 'Économisez ~20€',
    price_year: '99,99 €',
    per_year: '/ an',
    pay_monthly_alert: 'Redirection vers le Paiement Mensuel (9,99€)',
    pay_yearly_alert: 'Redirection vers le Paiement Annuel (99,99€)',
    have_code: "Vous avez un code d'activation ou une licence ?",
    ph_code: 'Saisissez le code',
    activate: 'Activer',
    continue_free: 'Continuer avec le forfait gratuit',
    code_ok: ' Code activé avec succès ! Bienvenue dans RouteFlex Pro.',
    code_bad: 'Code invalide ou expiré.',
    no_export: "Aucune destination à exporter.",
    no_dest_group: 'Aucune destination dans le groupe « {g} ».',
    csv_empty: 'Le fichier CSV est vide ou ne contient aucune donnée.',
    client_n: 'Client {i}',
    import_ok: 'Importation terminée ! {n} destinations chargées avec succès.',
    import_ok_one: 'Importation terminée ! {n} destination chargée avec succès.',
    import_none: "Aucune donnée valide n'a été trouvée.",
    import_err: "Une erreur s'est produite lors du traitement du fichier CSV.",
    enter_addr: "Saisissez l'adresse du lieu.",
    not_found: 'Adresse introuvable.',
    process_err: 'Erreur lors du traitement de la destination.',
    final_removed: "Point d'arrivée supprimé (facultatif).",
    final_nf: 'Destination finale introuvable.',
    final_ok: "Point d'arrivée défini avec succès !",
    final_err: 'Erreur lors du géocodage de la destination finale.',
    sel_one: 'Sélectionnez au moins une adresse pour la route.',
    route_fail: "Impossible de calculer l'itinéraire (service OSRM indisponible ou coordonnées invalides).",
    popup_start: 'Point de Départ (Position Actuelle)',
    popup_delivery: 'Livraison {i} : {c}',
    popup_nav: 'Naviguer dans Google Maps',
    popup_final: 'DESTINATION FINALE',
    auth_anon: 'Activez la connexion « Anonyme » dans la console Firebase (Authentication → Sign-in method).',
    auth_cfg: 'Configuration Firebase invalide (clés de démonstration). Définissez les variables VITE_FIREBASE_* dans le fichier .env.',
    auth_net: "Pas de connexion internet pour s'authentifier. Réessayez.",
    auth_generic: "Erreur d'authentification{code}.",
    csv_client: 'Client',
    csv_address: 'Adresse',
    csv_postal: 'Code Postal',
    csv_floor: 'Étage',
    csv_notes: 'Notes',
    csv_group: 'Groupe'
  }
};


// Tradutor: usa a língua pedida, cai para PT se faltar a chave (e para a própria chave se faltar em tudo).
const translate = (lang, key, vars = {}) => {
  const dict = TRANSLATIONS[lang] || TRANSLATIONS.pt;
  const useOne = vars.n === 1 && (dict[`${key}_one`] ?? TRANSLATIONS.pt[`${key}_one`]) != null;
  const k = useOne ? `${key}_one` : key;
  const raw = dict[k] ?? TRANSLATIONS.pt[k] ?? key;
  return raw.replace(/\{(\w+)\}/g, (m, name) => (vars[name] != null ? String(vars[name]) : m));
};

// Língua inicial: a guardada pelo utilizador → a do telemóvel/browser → português
const detectLang = () => {
  try {
    const saved = localStorage.getItem('routeflex_lang');
    if (LANGS.some((l) => l.code === saved)) return saved;
  } catch (e) { /* localStorage indisponível */ }
  const nav = (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'pt').slice(0, 2).toLowerCase();
  return LANGS.some((l) => l.code === nav) ? nav : 'pt';
};

// Nomes "de sistema" (valores guardados/comparados na lógica) em todas as línguas:
// assim um CSV exportado em EN volta a ser lido corretamente em PT, e vice-versa.
const SYSTEM_ALL = new Set(['Todos', 'All', 'Tous']);
const SYSTEM_GENERAL = new Set(['GERAL', 'GENERAL', 'GÉNÉRAL']);
const SYSTEM_UNNAMED = new Set(['Editar ✏️', 'Edit ✏️', 'Modifier ✏️']);

const normalizeGroup = (g) => (!g || SYSTEM_ALL.has(g) || SYSTEM_GENERAL.has(g) || SYSTEM_UNNAMED.has(g) ? '' : g);

export default function App() {
  // ---------- Idioma ----------
  const [isAddFormOpen, setIsAddFormOpen] = useState(false);
  const [lang, setLang] = useState(detectLang);
  const t = (key, vars) => translate(lang, key, vars);
  const locale = (LANGS.find((l) => l.code === lang) || LANGS[0]).locale;
  // Números com a vírgula/ponto do idioma (1,68 em PT/ES/FR · 1.68 em EN)
  const fmt = (n, d = 2) => Number(n).toLocaleString(locale, { minimumFractionDigits: d, maximumFractionDigits: d });
  // Nome mostrado de um grupo (os valores guardados continuam a ser os originais)
  const groupLabel = (g) => (SYSTEM_UNNAMED.has(g) ? t('edit_pill') : g);
  const langRef = useRef(lang);
  langRef.current = lang;
  const startMarkerRef = useRef(null); // marcador "ponto de partida" (para retraduzir o popup)

  const changeLang = (code) => {
    setLang(code);
    try { localStorage.setItem('routeflex_lang', code); } catch (e) { /* ignora */ }
  };
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // Navegação entre separadores
  const [activeTab, setActiveTab] = useState('inicio'); // 'inicio', 'listas', 'mapa', 'custos'
  const [selectedGroup, setSelectedGroup] = useState('Todos');

  // Estados do Utilizador e Dados
  const [user, setUser] = useState(null);
  const [stops, setStops] = useState([]);
  const [finalDest, setFinalDest] = useState(null);
  const [userPos, setUserPos] = useState(null);
  const [loading, setLoading] = useState(false);
  const [routeInfo, setRouteInfo] = useState(null);

  // Formulários e Configurações (Incluindo Andar e Notas)
  // Estados para Controlo do Plano Pro e Código de Licença
  const [userProfile, setUserProfile] = useState({ plan: 'free' }); 
  const [showPaywall, setShowPaywall] = useState(false);
  const [promoCode, setPromoCode] = useState('');
  const [promoError, setPromoError] = useState('');

  const isPro = userProfile?.plan === 'pro';
  const [newStop, setNewStop] = useState({ client: '', address: '', postalCode: '', floor: '', notes: '', group: '' });
  const [editingStopId, setEditingStopId] = useState(null); // id da paragem em edição (null = a criar nova)
  const formRef = useRef(null);
  const [exportGroup, setExportGroup] = useState('Todos'); // grupo escolhido para exportar em CSV
  const [finalDestInput, setFinalDestInput] = useState('');
  const [energyType, setEnergyType] = useState('Gasóleo');
  const [fuelPrice, setFuelPrice] = useState(1.68);
  const [carData, setCarData] = useState({ plate: '', consumption: 6.5 });
  const [geoProgress, setGeoProgress] = useState(null); // { done, total } enquanto localiza moradas

  // 5 Pílulas Iniciais com o texto 'Editar ✏️'
  const [groups, setGroups] = useState(['Editar ✏️', 'Editar ✏️', 'Editar ✏️', 'Editar ✏️', 'Editar ✏️']);
  const [editingGroupIdx, setEditingGroupIdx] = useState(null);
  const [editGroupValue, setEditGroupValue] = useState('');
  // Validação do Código de Licença
  const handleApplyCode = () => {
    if (promoCode.trim().toLowerCase() === 'route2026pro') {
      setUserProfile({ plan: 'pro' });
      setShowPaywall(false);
      setPromoCode('');
      setPromoError('');
      alert(t('code_ok'));
    } else {
      setPromoError(true); // só o estado: o texto é traduzido ao mostrar
    }
  };

  // ---------- Exportar CSV (Protegido para Pro) ----------
  // Mesma ordem de colunas que o importador lê: Cliente, Morada, Código Postal, Andar, Notas, Grupo
  const CSV_HEADERS = ['csv_client', 'csv_address', 'csv_postal', 'csv_floor', 'csv_notes', 'csv_group'].map((k) => t(k));
  const CSV_BOM = String.fromCharCode(0xfeff);
  const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const slugify = (t) =>
    String(t).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'grupo';

  const downloadStopsCSV = (list, namePart) => {
    const rows = [CSV_HEADERS.map(csvCell).join(',')];
    list.forEach((s) => {
      rows.push(
        [s.client, s.address, s.postalCode, s.floor, s.notes, normalizeGroup(s.group) || t('general')]
          .map(csvCell)
          .join(',')
      );
    });

    // BOM (U+FEFF) no início: o Excel só abre os acentos corretamente com ele
    const blob = new Blob([CSV_BOM + rows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `destinos_${namePart}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Exporta só um grupo ('Todos' = tudo; 'GERAL' = paragens sem grupo)
  const handleExportGroupCSV = (groupName = selectedGroup) => {
    if (!isPro) {
      setShowPaywall(true);
      return;
    }

    const all = !groupName || groupName === 'Todos';
    const target = normalizeGroup(groupName);
    const list = all ? stops : stops.filter((s) => normalizeGroup(s.group) === target);

    if (list.length === 0) {
      return alert(all ? t('no_export') : t('no_dest_group', { g: groupName }));
    }
    downloadStopsCSV(list, all ? 'todos' : slugify(groupName));
  };

  const handleExportCSV = () => handleExportGroupCSV('Todos');

  // Importar CSV em Bloco (100% Seguro e Local)
  const handleImportCSV = (e) => {
    if (!isPro) {
      setShowPaywall(true);
      e.target.value = '';
      return;
    }

    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const text = event.target.result;
        const lines = text.split(/\r\n|\n/).map(l => l.trim()).filter(l => l.length > 0);

        if (lines.length <= 1) {
          alert(t('csv_empty'));
          return;
        }

        // 1) Lê as linhas
        const rows = [];
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(c => c.replace(/^"|"$/g, '').trim());
          const row = {
            client: cols[0] || t('client_n', { i }),
            address: cols[1] || '',
            postalCode: cols[2] || '',
            floor: cols[3] || '',
            notes: cols[4] || '',
            group: cols[5] || 'Todos'
          };
          if (!cols[1] && !cols[0]) continue;
          rows.push(row);
        }

        // 2) Geocodifica cada morada a sério (Nominatim: máx. 1 pedido/s) — nada de coordenadas inventadas
        const newStops = [];
        let missing = 0;
        setLoading(true);
        for (let k = 0; k < rows.length; k++) {
          setGeoProgress({ done: k, total: rows.length });
          const r = rows[k];
          // Só a morada é pesquisada: o nome do cliente nunca entra na pesquisa
          if (k > 0) await sleep(1100);
          const found = r.address ? await geocodeAddress(r.address, r.postalCode) : null;
          if (!found) missing++;
          newStops.push({
            id: `${Date.now()}-${k}`,
            ...r,
            group: normalizeGroup(r.group),
            lat: found ? Number(found.lat) : null,
            lng: found ? Number(found.lon) : null,
            place: found?.place || '',
            geo: found ? GEO_OK : 'missing', // GEO_OK = localização confirmada pelo Nominatim
            selected: !!found
          });
        }

        if (newStops.length > 0) {
          setStops(prev => [...prev, ...newStops]);
          alert(t('import_ok', { n: newStops.length - missing }) + (missing ? '\n' + t('import_missing', { f: missing }) : ''));
        } else {
          alert(t('import_none'));
        }
      } catch (err) {
        console.error("Erro crítico na importação:", err);
        alert(t('import_err'));
      } finally {
        setGeoProgress(null);
        setLoading(false);
        e.target.value = '';
      }
    };

    reader.readAsText(file);
  };

  // Referências do Mapa Leaflet.
  // O contentor do mapa fica SEMPRE montado no DOM (só alterna hidden/block),
  // por isso a instância do Leaflet vive do arranque até ao fecho da app.
  const mapContainerRef = useRef(null);   // <div> do mapa
  const mapInstance = useRef(null);       // L.Map
  const stopsLayerRef = useRef(null);     // L.LayerGroup: marcadores das paragens
  const routeLayerRef = useRef(null);     // L.LayerGroup: linha da rota OSRM
  const finalLayerRef = useRef(null);     // L.LayerGroup: destino final
  const needsFitRef = useRef(false);      // há conteúdo novo por enquadrar quando o mapa estiver visível

  // Enquadra rota/marcadores. Se o mapa estiver escondido (largura 0) adia até voltar ao separador.
  const fitMap = () => {
    const L = window.L;
    const map = mapInstance.current;
    const el = mapContainerRef.current;
    if (!L || !map || !el || el.offsetWidth === 0) return;

    map.invalidateSize({ animate: false });

    const bounds = L.latLngBounds([]);
    routeLayerRef.current?.eachLayer((l) => l.getBounds && bounds.extend(l.getBounds()));
    if (!bounds.isValid()) {
      stopsLayerRef.current?.eachLayer((m) => m.getLatLng && bounds.extend(m.getLatLng()));
      finalLayerRef.current?.eachLayer((m) => m.getLatLng && bounds.extend(m.getLatLng()));
    }
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
    needsFitRef.current = false;
  };

  // 1. Autenticação Anónima (inicia logo no arranque)
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, setUser);
    ensureUser().catch((e) => console.error('Falha no login anónimo:', e));
    return unsub;
  }, []);

  // 2. Cria o mapa UMA vez (no arranque) e destrói-o só quando a app é desmontada
  useEffect(() => {
    const L = window.L;
    const container = mapContainerRef.current;
    if (!L || !container || mapInstance.current) return;

    const map = L.map(container, { zoomControl: false }).setView([25, 10], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap'
    }).addTo(map);

    stopsLayerRef.current = L.layerGroup().addTo(map);
    routeLayerRef.current = L.layerGroup().addTo(map);
    finalLayerRef.current = L.layerGroup().addTo(map);
    mapInstance.current = map;
    let cancelled = false; // evita callbacks tardios (ex.: React StrictMode monta/desmonta/monta em dev)

    // Quando o contentor passa de hidden (0x0) a block, o Leaflet tem de recalcular o tamanho
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          map.invalidateSize({ animate: false });
          if (needsFitRef.current) fitMap();
        })
      : null;
    ro?.observe(container);

    // Localização atual (ponto de partida)
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (cancelled) return;
          const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          setUserPos(p);
          startMarkerRef.current = L.circleMarker([p.lat, p.lng], { radius: 8, color: '#004a99', fillColor: '#0284c7', fillOpacity: 0.8 })
            .addTo(map)
            .bindPopup(translate(langRef.current, 'popup_start'));
          if (stopsLayerRef.current?.getLayers().length === 0) map.setView([p.lat, p.lng], 14);
        },
        () => {},
        { timeout: 10000 }
      );
    }

    return () => {
      cancelled = true;
      startMarkerRef.current = null;
      ro?.disconnect();
      map.remove();
      mapInstance.current = null;
      stopsLayerRef.current = null;
      routeLayerRef.current = null;
      finalLayerRef.current = null;
    };
  }, []);

  // 2a. Ao regressar ao separador do mapa: recalcular tamanho (e enquadrar se houver novidades)
  useEffect(() => {
    if (activeTab !== 'mapa') return;
    const id = requestAnimationFrame(() => {
      const map = mapInstance.current;
      if (!map) return;
      map.invalidateSize({ animate: false });
      if (needsFitRef.current) fitMap();
    });
    return () => cancelAnimationFrame(id);
  }, [activeTab]);

  // 2b. Marcadores das paragens selecionadas (camada própria; com números e Google Maps)
  useEffect(() => {
    const L = window.L;
    const layer = stopsLayerRef.current;
    if (!L || !layer) return;

    layer.clearLayers();
    orderByProximity(stops.filter((s) => s.selected && hasCoords(s)), userPos)
      .forEach((s, idx) => {
        const numberedIcon = L.divIcon({
          className: 'custom-number-marker',
          html: `<div style="
            background-color: #2563eb;
            color: white;
            font-weight: bold;
            border-radius: 50%;
            width: 28px;
            height: 28px;
            display: flex;
            align-items: center;
            justify-content: center;
            border: 2px solid white;
            box-shadow: 0 2px 5px rgba(0,0,0,0.3);
            font-size: 13px;
          ">${idx + 1}</div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14]
        });

        const googleMapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=driving`;

        L.marker([s.lat, s.lng], { icon: numberedIcon })
          .bindPopup(`
            <div style="font-family: sans-serif; min-width: 150px;">
              <b>${escapeHtml(t('popup_delivery', { i: idx + 1, c: s.client }))}</b><br/>
              <span style="font-size: 11px; color: #64748b;">${escapeHtml(s.address)}</span>
              <div style="margin-top: 8px;">
                <a href="${googleMapsUrl}" target="_blank" style="display: block; background: #2563eb; color: white; padding: 5px 8px; border-radius: 4px; text-decoration: none; font-size: 11px; font-weight: bold; text-align: center;">${escapeHtml(t('popup_nav'))}</a>
              </div>
            </div>
          `)
          .addTo(layer);
      });

    needsFitRef.current = true;
    fitMap();
  }, [stops, lang, userPos]);

  // 2c. Marcador do destino final
  useEffect(() => {
    const L = window.L;
    const layer = finalLayerRef.current;
    if (!L || !layer) return;

    layer.clearLayers();
    if (finalDest && Number.isFinite(finalDest.lat) && Number.isFinite(finalDest.lng)) {
      L.marker([finalDest.lat, finalDest.lng])
        .bindPopup(`<b>${escapeHtml(t('popup_final'))}</b><br/>${escapeHtml(finalDest.address)}`)
        .addTo(layer);
      needsFitRef.current = true;
      fitMap();
    }
  }, [finalDest, lang]);

  // 2d. Retraduz o popup do ponto de partida quando muda o idioma
  useEffect(() => {
    startMarkerRef.current?.setPopupContent(translate(lang, 'popup_start'));
  }, [lang]);

  // 3. Sincronização com Firestore.
  // No 1º arranque de cada DATA_VERSION apaga primeiro os destinos antigos da nuvem e só depois
  // começa a ouvir; assim o onSnapshot já não traz dados obsoletos para o ecrã.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const unsubs = [];

    (async () => {
      let needsReset = false;
      try { needsReset = localStorage.getItem(DATA_VERSION_KEY) !== DATA_VERSION; } catch (e) { /* sem localStorage */ }

      if (needsReset) {
        try {
          await purgeCloudData(user.uid);
          try {
            localStorage.setItem(DATA_VERSION_KEY, DATA_VERSION);
            localStorage.removeItem('stops');       // chaves antigas
            localStorage.removeItem('app_version');
          } catch (e) { /* ignora */ }
        } catch (err) {
          console.warn('Reset da nuvem falhou (volta a tentar no próximo arranque).', err);
        }
        if (cancelled) return;
        setStops([]);
        setFinalDest(null);
        setRouteInfo(null);
      }
      if (cancelled) return;

      const q = collection(db, 'artifacts', appId, 'users', user.uid, 'stops');
      unsubs.push(onSnapshot(q, (snapshot) => {
        const stopsData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        setStops(stopsData);
      }));

      const settingsDoc = doc(db, 'artifacts', appId, 'users', user.uid, 'settings', 'main');
      unsubs.push(onSnapshot(settingsDoc, (docSnap) => {
        if (docSnap.exists()) {
          const data = docSnap.data();
          if (data.finalDest) setFinalDest(data.finalDest);
          if (data.carData) setCarData(data.carData);
          if (data.fuelPrice) setFuelPrice(data.fuelPrice);
        }
      }));
    })();

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [user]);

  // 4. Distância/duração da rota para o dashboard: estimativa imediata (offline) + valor exato do OSRM
  useEffect(() => {
    const sel = orderByProximity(stops.filter((s) => s.selected && hasCoords(s)), userPos);
    if (sel.length === 0) {
      setRouteInfo(null);
      return;
    }

    // Ponto de partida: GPS (ou 1ª paragem) -> paragens selecionadas -> destino final (opcional)
    const points = [userPos || sel[0], ...sel, ...(finalDest ? [finalDest] : [])];
    setRouteInfo({ distanceKm: estimateRouteKm(points), durationMin: null, source: 'estimativa' });

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const route = await fetchOsrmRoute(points);
        if (!cancelled) {
          setRouteInfo({ distanceKm: route.distance / 1000, durationMin: Math.round(route.duration / 60), source: 'osrm' });
        }
      } catch (e) {
        console.warn('OSRM indisponível; a manter a estimativa em linha reta.', e);
      }
    }, 700);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [stops, finalDest, userPos]);

  // ---------- Geocodificação (Nominatim) ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Remove acentos: "São Gens" -> "Sao Gens"
  const stripAccents = (str) => str.normalize('NFD').replace(/[̀-ͯ]/g, '');

  // Pedido HTTP: em app nativa (Capacitor) envia os headers exigidos pelo Nominatim.
  // No browser, 'User-Agent' não pode ser definido e provoca falha de CORS/preflight,
  // por isso aí o idioma segue no parâmetro accept-language do URL.
  const nominatimGet = async (url) => {
    const cap = typeof window !== 'undefined' ? window.Capacitor : null;
    const nativeHttp = cap?.isNativePlatform?.() ? cap?.Plugins?.CapacitorHttp : null;

    if (nativeHttp) {
      const r = await nativeHttp.get({
        url,
        headers: {
          'User-Agent': 'GestorRotasApp/1.0',
          'Accept-Language': `${navigator.language || 'en'},en;q=0.8`
        }
      });
      if (r.status < 200 || r.status >= 300) return null;
      return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    }

    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  };

  const geocodeOnce = async (q, userPos) => {
    const latParam = userPos?.lat ? `&lat=${userPos.lat}` : '';
    const lonParam = userPos?.lng ? `&lon=${userPos.lng}` : '';
    // O /search do Nominatim ignora lat/lon; o que dá prioridade a resultados próximos é a `viewbox`
    // (sem `bounded=1`, é só preferência — continua a encontrar moradas fora da caixa).
    const d = 0.5; // ~50 km à volta do utilizador
    const viewboxParam = Number.isFinite(userPos?.lat) && Number.isFinite(userPos?.lng)
  ? `&viewbox=${userPos.lng - d},${userPos.lat + d},${userPos.lng + d},${userPos.lat - d}`
  : '';
    
    const url =
      'https://nominatim.openstreetmap.org/search' +
      `?format=jsonv2&limit=5&addressdetails=1` +
      latParam +
      lonParam +
      viewboxParam +
      `&q=${encodeURIComponent(q)}`;

    try {
      const data = await nominatimGet(url);
      if (!Array.isArray(data) || data.length === 0) return null;
      const best = pickBestResult(data, q, userPos);
      const lat = parseFloat(best.lat);
      const lon = parseFloat(best.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const a = best.address || {};
      const place = [a.city || a.town || a.village || a.municipality || a.county, a.country].filter(Boolean).join(', ');
      return { lat, lon, display: best.display_name || q, place };
    } catch (e) {
      console.error('Erro no geocode:', e);
      return null;
    }
  };

 // Tenta a string original (NFC) e, se falhar, a versão sem acentos
  const geocode = async (query) => {
    const q = normalizeQuery((query || '').normalize('NFC').replace(/\s+/g, ' ').trim());
    if (!q) return null;

    const variants = [q];
    const plain = stripAccents(q);
    if (plain !== q) variants.push(plain);

    for (let i = 0; i < variants.length; i++) {
      if (i > 0) await sleep(1100); // limite Nominatim: 1 pedido/s
      const r = await geocodeOnce(variants[i], userPos); // <--- Adicionado o userPos aqui!
      if (r) return r;
    }
    return null;
  };

  

  // Cascata de tentativas (serve em qualquer país — não assume cidade nem país):
  // 1) morada + código postal  2) só a morada  3) só o código postal.
  // Se houver vários candidatos, escolhe o da localidade escrita e, a seguir, o mais perto do utilizador.
  const geocodeAddress = async (base, postalInput = '') => {
    const attempts = [];
    if (postalInput && !base.includes(postalInput)) attempts.push(`${base}, ${postalInput}`);
    attempts.push(base);
    if (postalInput) attempts.push(postalInput);

    const tried = new Set();
    for (const q of attempts) {
      if (tried.has(q)) continue;
      tried.add(q);
      if (tried.size > 1) await sleep(1100);
      const result = await geocode(q);
      if (result) return result;
    }
    return null;
  };

  const emptyStopForm = () => ({ client: '', address: '', postalCode: '', floor: '', notes: '', group: normalizeGroup(selectedGroup) });

  // Preenche o formulário de topo com os dados de uma paragem (modo edição)
  const startEditStop = (s) => {
    setNewStop({
      client: s.client || '',
      address: s.address || '',
      postalCode: s.postalCode || '',
      floor: s.floor || '',
      notes: s.notes || '',
      group: normalizeGroup(s.group)
    });
    setEditingStopId(s.id);
    setIsAddFormOpen(true); // abre o painel retrátil
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const cancelEditStop = () => {
    setEditingStopId(null);
    setNewStop(emptyStopForm());
    setIsAddFormOpen(false);
  };

  // Adicionar Paragem/Destino (ou guardar alterações quando está em edição)
  const handleAddStop = async () => {
    const clientInput = (newStop.client || '').trim();
    const addressInput = (newStop.address || '').trim();
    const postalInput = (newStop.postalCode || '').trim();

    // Base da pesquisa: SÓ a morada. O nome/entidade é apenas para mostrar na lista.
    const base = addressInput;
    if (!base) {
      return alert(t('enter_addr'));
    }

    // Paragem em edição (se entretanto foi apagada, volta a comportar-se como "nova")
    const editingStop = editingStopId != null ? stops.find((s) => s.id === editingStopId) : null;

    setLoading(true);
    try {
      // Aguarda a autenticação (em paralelo com a geocodificação); não bloqueia o utilizador
      const userPromise = ensureUser();
      userPromise.catch(() => {}); // evita "unhandled rejection"

      // Em edição, só volta a geocodificar se a morada ou o código postal mudaram
      const locationChanged =
        !editingStop || editingStop.geo !== GEO_OK || base !== editingStop.address || postalInput !== (editingStop.postalCode || '');

      let lat;
      let lng;
      let place = editingStop?.place || '';
      if (locationChanged) {
        const result = await geocodeAddress(base, postalInput);

        if (!result) {
          alert(t('not_found'));
          return;
        }
        lat = Number(result.lat);
        lng = Number(result.lon);
        place = result.place || '';
      } else {
        lat = editingStop.lat;
        lng = editingStop.lng;
      }

      const fields = {
        client: clientInput || base, // só para mostrar (se vazio, repete a morada)
        address: base,
        postalCode: postalInput,
        floor: (newStop.floor || '').trim(),
        group: normalizeGroup(newStop.group),
        notes: (newStop.notes || '').trim(),
        lat,
        lng,
        place,
        geo: GEO_OK
      };

      // ---- Guardar alterações de uma paragem existente ----
      if (editingStop) {
        setStops((prev) => prev.map((s) => (s.id === editingStop.id ? { ...s, ...fields } : s)));
        setEditingStopId(null);
        setNewStop(emptyStopForm());
        setIsAddFormOpen(false); // fecha o painel depois de guardar

        try {
          const currentUser = await userPromise;
          if (currentUser && currentUser.uid !== 'local-demo-user') {
            await updateDoc(
              doc(db, 'artifacts', appId, 'users', currentUser.uid, 'stops', String(editingStop.id)),
              fields
            );
          }
        } catch (err) {
          console.warn("Modo local: alterações guardadas só na memória.", err);
        }
        return;
      }

      // ---- Nova paragem ----
      const newStopData = {
        id: Date.now().toString(),
        ...fields,
        selected: true,
        createdAt: new Date().toISOString()
      };

      // 1. ADICIONA LOCALMENTE INSTANTANEAMENTE (a app funciona 100% sem erros)
      setStops(prev => [newStopData, ...prev]);

      // Limpa os campos do formulário e recolhe o painel
      setNewStop(emptyStopForm());
      setIsAddFormOpen(false);

      // 2. Tenta guardar na Nuvem/Firebase em segundo plano (se falhar, não lança alert)
      try {
        const currentUser = await userPromise;
        if (currentUser && currentUser.uid !== 'local-demo-user') {
          await addDoc(collection(db, 'artifacts', appId, 'users', currentUser.uid, 'stops'), {
            ...newStopData,
            id: undefined // deixa o Firestore gerar a sua própria chave na nuvem
          });
        }
      } catch (err) {
        console.warn("Modo local: destino guardado na memória/browser.", err);
      }

    } catch (e) {
      console.error('Erro ao processar destino:', e);
      alert(t('process_err'));
    } finally {
      setLoading(false);
    }
  };

 // Definir Ponto de Chegada (Opcional & Funcional Offline)
  const handleSetFinalDest = async () => {
    const input = finalDestInput.trim();
    if (!input) {
      setFinalDest(null);
      alert(t('final_removed'));
      return;
    }
    setLoading(true);
    try {
      // Otimização: Geocodifica a morada sem esperar por Firebase
      const result = await geocode(input);
      if (!result) {
        alert(t('final_nf'));
        return;
      }
      
      const destData = {
        address: input,
        place: result.place || '',
        lat: Number(result.lat),
        lng: Number(result.lon)
      };
      
      setFinalDest(destData);
      alert(t('final_ok'));
    } catch (e) {
      console.error("Erro ao definir destino final:", e);
      alert(t('final_err'));
    } finally {
      setLoading(false);
    }
  };

  // Selecionar/Desselecionar Paragem (Com Fallback Local)
  const toggleStopSelection = async (stop) => {
    // 1. Atualiza logo o estado local no React (o ecrã responde instantaneamente)
    setStops(prevStops => 
      prevStops.map(s => s.id === stop.id ? { ...s, selected: !s.selected } : s)
    );

    // 2. Tenta guardar no Firebase em segundo plano
    try {
      const currentUser = await ensureUser();
      if (currentUser && currentUser.uid !== 'local-demo-user') {
        const stopRef = doc(db, 'artifacts', appId, 'users', currentUser.uid, 'stops', stop.id);
        await updateDoc(stopRef, { selected: !stop.selected });
      }
    } catch (e) {
      console.warn("Modo local: não foi possível sincronizar seleção na nuvem", e);
    }
  };

  // Remover Paragem (Com Fallback Local)
  const deleteStop = async (id) => {
    if (editingStopId === id) cancelEditStop();
    // 1. Remove logo do estado local no React
    setStops(prevStops => prevStops.filter(s => s.id !== id));

    // 2. Tenta eliminar no Firebase em segundo plano
    try {
      const currentUser = await ensureUser();
      if (currentUser && currentUser.uid !== 'local-demo-user') {
        await deleteDoc(doc(db, 'artifacts', appId, 'users', currentUser.uid, 'stops', id));
      }
    } catch (e) {
      console.warn("Modo local: não foi possível eliminar na nuvem", e);
    }
  };

  // Paragens cuja localização nunca foi confirmada (ex.: importadas com a versão antiga, que inventava coordenadas)
  const unverifiedStops = stops.filter((s) => s.geo !== GEO_OK);

  const handleFixLocations = async () => {
    const targets = unverifiedStops.filter((s) => s.address);
    if (targets.length === 0) return;
    setLoading(true);
    let ok = 0;
    try {
      for (let k = 0; k < targets.length; k++) {
        setGeoProgress({ done: k, total: targets.length });
        const st = targets[k];
        if (k > 0) await sleep(1100);
        const found = await geocodeAddress(st.address, st.postalCode || '');
        const patch = found
          ? { lat: Number(found.lat), lng: Number(found.lon), place: found.place || '', geo: GEO_OK, selected: st.selected || st.geo === 'missing' }
          : { lat: null, lng: null, geo: 'missing', selected: false };
        if (found) ok++;
        setStops((prev) => prev.map((x) => (x.id === st.id ? { ...x, ...patch } : x)));
        try {
          const cu = await ensureUser();
          if (cu && cu.uid !== 'local-demo-user') {
            await updateDoc(doc(db, 'artifacts', appId, 'users', cu.uid, 'stops', String(st.id)), patch);
          }
        } catch (err) { /* modo local */ }
      }
      alert(t('fix_done', { ok, f: targets.length - ok }));
    } finally {
      setGeoProgress(null);
      setLoading(false);
    }
  };

  // Recomeçar do zero: apaga destinos, destino final, rota desenhada e os dados na nuvem
  const handleClearAll = async () => {
    if (!window.confirm(t('clear_confirm'))) return;
    setStops([]);
    setFinalDest(null);
    setFinalDestInput('');
    setRouteInfo(null);
    setEditingStopId(null);
    setNewStop(emptyStopForm());
    setIsAddFormOpen(false);
    routeLayerRef.current?.clearLayers();
    try {
      const currentUser = await ensureUser();
      if (currentUser && currentUser.uid !== 'local-demo-user') await purgeCloudData(currentUser.uid);
    } catch (e) {
      console.warn('Modo local: não foi possível limpar a nuvem', e);
    }
  };

  // Cálculo da Rota OSRM (desenha a linha no mapa; os marcadores são geridos pelos efeitos 2b/2c)
  const calculateRoute = async () => {
    const selectedStops = orderByProximity(stops.filter((s) => s.selected && hasCoords(s)), userPos);
    if (selectedStops.length === 0) return alert(t('sel_one'));

    setActiveTab('mapa');
    setLoading(true);
    try {
      const points = [userPos || selectedStops[0], ...selectedStops, ...(finalDest ? [finalDest] : [])];
      const route = await fetchOsrmRoute(points);

      const layer = routeLayerRef.current;
      if (layer && window.L) {
        layer.clearLayers();
        window.L.geoJSON(route.geometry, {
          style: { color: '#0284c7', weight: 5, opacity: 0.8 }
        }).addTo(layer);
        needsFitRef.current = true;
        fitMap();
      }

      // Só guarda distância/duração: o custo é calculado a partir dos parâmetros da aba Custos
      setRouteInfo({ distanceKm: route.distance / 1000, durationMin: Math.round(route.duration / 60), source: 'osrm' });
    } catch (e) {
      console.error("Erro no cálculo da rota:", e);
      alert(t('route_fail'));
    } finally {
      setLoading(false);
    }
  };

  const selectedCount = stops.filter(s => s.selected).length;


  const filteredStops = selectedGroup === 'Todos' ? stops : stops.filter((s) => normalizeGroup(s.group) === selectedGroup);

  // Link global do Google Maps.
  // Com destino final definido, ele é SEMPRE o `destination` e as paragens selecionadas passam a pontos intermédios.
  // Sem destino final, mantém-se o comportamento antigo (a última paragem é o destino).
  const hasFinalDest = !!finalDest && Number.isFinite(finalDest.lat) && Number.isFinite(finalDest.lng);

  const buildGoogleMapsUrl = (list) => {
    // Filtra paragens selecionadas que tenham morada
    const validStops = list.filter((s) => s.selected && (s.address || hasCoords(s)));
    // Sequência otimizada: da posição atual para a paragem mais próxima, e assim sucessivamente.
    // O destino final (se existir) continua a ser sempre o `destination`.
    const sel = orderByProximity(validStops, userPos);

    if (sel.length === 0 && !hasFinalDest) return null;

    const dest = hasFinalDest ? finalDest : sel[sel.length - 1];
    const waypoints = hasFinalDest ? sel : sel.slice(0, -1);

    // Como cada ponto vai para o Google Maps (funciona em qualquer país):
    //  1) morada + código postal + localidade/país devolvidos pelo geocodificador (sem inventar cidade)
    //  2) sem localidade guardada: coordenadas exatas (sem ambiguidade)
    //  3) sem coordenadas: só o texto da morada
    const formatAddress = (item) => {
      if (!item) return '';
      if (typeof item === 'string') return encodeURIComponent(item);
      if (item.address && item.place) {
        // acrescenta só o que o utilizador ainda não escreveu (evita "London, London")
        const typed = plainText(`${item.address} ${item.postalCode || ''}`);
        const extra = item.place.split(', ').filter((part) => !typed.includes(plainText(part)));
        return encodeURIComponent([item.address, item.postalCode, ...extra].filter(Boolean).join(', '));
      }
      if (hasCoords(item)) return `${item.lat},${item.lng}`;
      return item.address ? encodeURIComponent([item.address, item.postalCode].filter(Boolean).join(', ')) : '';
    };

    const destStr = formatAddress(dest);
    if (!destStr) return null;

    // Constrói o URL do Google Maps usando texto em vez de coordenadas
    let url = `https://www.google.com/maps/dir/?api=1&destination=${destStr}&travelmode=driving`;
    
    if (waypoints.length > 0) {
      const wpStrings = waypoints.map(formatAddress).filter(Boolean);
      if (wpStrings.length > 0) {
        url += `&waypoints=${wpStrings.join('%7C')}`;
      }
    }
    
    return url;
  };
  const googleMapsUrl = buildGoogleMapsUrl(filteredStops);

  // Custo da rota = distância x consumo x preço. Recalcula sozinho quando muda qualquer um dos três.
  const unitLabel = energyType === 'Elétrico' ? 'kWh' : 'L';
  const energyKey = energyType === 'Gasolina 95' ? 'Gasolina95' : energyType; // chave do dicionário
  const routeUnits = routeInfo ? (routeInfo.distanceKm * carData.consumption) / 100 : 0;
  const routeCost = routeUnits * fuelPrice;
  const approx = routeInfo?.source === 'estimativa' ? '~' : '';

  return (
    <div className="flex justify-center items-center min-h-screen bg-[#dce4ec] p-2 font-sans">
      {/* Container Telemóvel Mobile */}
      <div className="w-[360px] h-[720px] bg-white rounded-[35px] border-[8px] border-[#1e293b] shadow-2xl overflow-hidden flex flex-col relative">
        
      {/* Status Bar */}
        <div className="bg-[#0f172a] text-white px-4 py-2 text-[11px] flex justify-between items-center">
          <span>09:41</span>
          <div className="text-center leading-tight">
            <div className="font-bold text-sm">RouteFlex Pro</div>
            <img src={logoBastos} alt="by BASTOS" style={{ height: '11px', width: 'auto', display: 'block', margin: '2px auto 0 auto', opacity: 0.9 }} />
          </div>
          <span>🔋 98%</span>
        </div>
      

       

        {/* App Header com Ícone Hexágono + Nome */}
        <div className="bg-[#004a99] text-white py-3 px-4 flex items-center justify-center gap-2 shadow-md">
          <img src={logoRoute} alt="RouteFlex" className="w-8 h-8 rounded-lg object-cover shrink-0 shadow-sm" />
          <span className="font-bold text-xl tracking-wide">
            {activeTab === 'inicio' && t('hdr_home')}
            {activeTab === 'listas' && t('hdr_lists')}
            {activeTab === 'mapa' && t('hdr_map')}
            {activeTab === 'custos' && t('hdr_costs')}
          </span>
        </div>

        {/* Área de Conteúdo Dinâmico */}
        <div className="flex-1 overflow-y-auto p-3 bg-[#f8fafc]">
          {geoProgress && (
            <div className="sticky top-0 z-20 mb-2 bg-[#004a99] text-white text-[11px] font-bold rounded-lg px-3 py-1.5 shadow text-center">
              {t('geo_progress', { done: geoProgress.done + 1, total: geoProgress.total })}
            </div>
          )}
          
        {/* ==========================================
              PROPOSTA A: DASHBOARD CENTRAL (INÍCIO)
              ========================================== */}
          {activeTab === 'inicio' && (
            <div className="space-y-3 p-3">
              {/* Seletor de idioma (discreto) */}
              <div className="flex justify-end items-center gap-1 -mb-1 text-[10px] text-slate-400" role="group" aria-label={t('lang_label')}>
                <span aria-hidden="true">🌐</span>
                {LANGS.map((l, i) => (
                  <React.Fragment key={l.code}>
                    {i > 0 && <span aria-hidden="true" className="text-slate-300">·</span>}
                    <button
                      onClick={() => changeLang(l.code)}
                      aria-pressed={lang === l.code}
                      className={`px-0.5 cursor-pointer transition-colors ${
                        lang === l.code ? 'text-[#004a99] font-bold underline underline-offset-2' : 'hover:text-slate-600'
                      }`}
                    >
                      {l.label}
                    </button>
                  </React.Fragment>
                ))}
              </div>

              {/* Painel de Resumo Rápido */}
              <div className="bg-gradient-to-r from-[#004a99] to-[#0284c7] text-white p-4 rounded-xl shadow-sm">
                <div className="text-[13px] opacity-90 font-semibold tracking-wider uppercase">{t('today_route')}</div>
                <div className="text-xl font-bold my-1">{t('selected_dest', { n: selectedCount })}</div>
                <div className="text-xs opacity-90">
                  {t('est_cost')} <b>{routeInfo ? `${approx}${fmt(routeCost)} €` : `${fmt(0)} €`}</b>
                  {routeInfo && (
                    <span> · {approx}{fmt(routeInfo.distanceKm, 1)} km · {fmt(routeUnits, 1)} {unitLabel}</span>
                  )}
                </div>
                <div className="text-[12px] opacity-75">
                  {t(`e_name_${energyKey}`)} · {fmt(fuelPrice)} €/{unitLabel} · {fmt(carData.consumption, Number.isInteger(Number(carData.consumption)) ? 0 : 1)} {unitLabel}/100 km
                </div>

                {/* Botão de Atalho Direto para o Google Maps */}
                {googleMapsUrl && (
                  <a
                    href={googleMapsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-4 w-full py-3 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl font-bold text-xs flex items-center justify-center gap-2 shadow-sm transition-colors text-center block"
                  >
                    <span>{t('launch_gmaps')}</span>
                  </a>
                )}
              </div>

              {/* Botão de Estado / Ativação Pro */}
              <div>
                <button
                  onClick={() => {
                    if (!isPro) {
                      setShowPaywall(true);
                    } else {
                      alert(t('pro_alert'));
                    }
                  }}
                  className={`w-full py-3 px-4 rounded-xl font-bold text-xs flex items-center justify-between shadow-sm transition cursor-pointer ${
                    isPro 
                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100' 
                      : 'bg-gradient-to-r from-amber-500 to-amber-600 text-white shadow-amber-500/20 hover:opacity-95'
                  }`}
                >
                 <div className="flex items-center gap-2">
    <div className="text-left">
      <div className="font-extrabold">{isPro ? t('pro_active') : t('pro_activate')}</div>
      <div className={`text-[12px] font-normal ${isPro ? 'text-emerald-600' : 'text-amber-100'}`}>
        {isPro ? t('pro_sub_active') : t('pro_sub_free')}
      </div>
    </div>
  </div>
                  <span className={`text-xs px-2.5 py-1 rounded-lg font-bold ${isPro ? 'bg-emerald-200/60 text-emerald-800' : 'bg-white/20 text-white'}`}>
                    {isPro ? t('badge_active') : t('badge_unlock')}
                  </span>
                </button>
              </div>

              {/* Ferramentas Úteis (Sem redundâncias de menus) */}
              <div className="bg-white rounded-xl p-3 border border-slate-200 shadow-sm space-y-2">
{/* <span className="text-xs font-bold text-slate-700 block">Ferramentas Rápidas</span> */}                <div className="grid grid-cols-1 gap-2">
                  <button 
                    onClick={() => {
                      if (!isPro) {
                        setShowPaywall(true);
                      } else {
                        document.getElementById('hiddenCsvInput')?.click();
                      }
                    }}
                    className="p-3 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg flex items-center justify-center gap-2 text-slate-700 transition-colors cursor-pointer"
                  >
                    <span className="text-base">📄</span>
                    <span className="text-xs font-bold">{t('import_csv')} {!isPro && '🔒'}</span>
                    <input
                      id="hiddenCsvInput"
                      type="file"
                      accept=".csv"
                      onChange={handleImportCSV}
                      className="hidden"
                    />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ==========================================
              PROPOSTA B: OPERAÇÃO E GRUPOS (LISTAS)
             ========================================== */}
        {activeTab === 'listas' && (
            <div className="space-y-3">
              
              {/* Barra de Grupos Dinâmica com Scroll Horizontal */}
              <div className="space-y-1.5">
                <div className="text-[11px] font-bold text-slate-500 flex justify-between items-center">
                  <span>{t('groups_title')}</span>
                </div>

                <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-none snap-x">
                  {/* Botão Todos */}
                  <button
                    onClick={() => setSelectedGroup('Todos')}
                    className={`px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap border transition cursor-pointer ${
                      selectedGroup === 'Todos'
                        ? 'bg-[#004a99] text-white border-[#004a99]'
                        : 'bg-white text-slate-700 border-slate-200'
                    }`}
                  >
                    {t('all')}
                  </button>

                  {/* Grupos Editáveis */}
                  {groups.map((group, idx) => (
                    <div key={idx} className="flex items-center gap-1 snap-start">
                      {editingGroupIdx === idx ? (
                        <div className="flex items-center gap-1 bg-white border border-[#004a99] rounded-full px-2.5 py-0.5 shadow-sm">
                          <input
                            type="text"
                            value={editGroupValue}
                            onChange={(e) => setEditGroupValue(e.target.value)}
                            className="w-20 text-xs outline-none font-bold text-[#004a99]"
                            placeholder={t('name_ph')}
                            autoFocus
                          />
                          <button
                            onClick={() => {
                              const newName = editGroupValue.trim();
                              if (newName) {
                                const oldName = groups[idx];
                                const newGroups = [...groups];
                                newGroups[idx] = newName;
                                setGroups(newGroups);

                                // Renomear um grupo já nomeado: leva consigo as paragens, o filtro e o formulário
                                if (oldName !== UNNAMED_GROUP && oldName !== newName) {
                                  setStops((prev) => prev.map((st) => (st.group === oldName ? { ...st, group: newName } : st)));
                                  if (selectedGroup === oldName) setSelectedGroup(newName);
                                  setNewStop((f) => (f.group === oldName ? { ...f, group: newName } : f));
                                  setExportGroup((g) => (g === oldName ? newName : g));
                                }
                              }
                              setEditingGroupIdx(null);
                            }}
                            className="text-emerald-600 font-bold text-xs px-1 cursor-pointer"
                          >
                            {t('ok')}
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            setEditingGroupIdx(idx);
                            setEditGroupValue(group === 'Editar ✏️' ? '' : group);
                          }}
                          className={`px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap border transition cursor-pointer ${
                            selectedGroup === group
                              ? 'bg-[#004a99] text-white border-[#004a99]'
                              : 'bg-white text-slate-700 border-slate-200'
                          }`}
                        >
                          {groupLabel(group)}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

             {/* Painel Retrátil de Novo Destino / Edição */}
<div ref={formRef} className="bg-white rounded-xl shadow-sm border border-[#e2e8f0] mb-4 overflow-hidden text-xs">
  {/* Cabeçalho Clicável */}
  <button
    type="button"
    onClick={() => setIsAddFormOpen(!isAddFormOpen)}
    className="w-full px-3 py-2.5 flex items-center justify-between bg-slate-50 hover:bg-slate-100 transition-colors border-b border-slate-100 cursor-pointer"
  >
    <div className="flex items-center gap-2">
      <span className="text-[#004a99] font-bold text-sm">
        {isAddFormOpen ? '➖' : '➕'}
      </span>
      <span className="font-bold text-[#1e293b]">
        {editingStopId != null ? t('edit_dest') : t('new_dest')}
      </span>
    </div>

    <div className="flex items-center gap-2">
      {editingStopId != null && (
        <span 
          onClick={(e) => { 
            e.stopPropagation(); 
            cancelEditStop(); 
          }} 
          className="text-[10px] text-slate-500 underline cursor-pointer"
        >
          {t('cancel')}
        </span>
      )}
      <span className="font-medium text-[#004a99] bg-blue-50 px-2 py-0.5 rounded">
        {isAddFormOpen ? t('panel_collapse') : (editingStopId != null ? t('panel_edit') : t('panel_add'))}
      </span>
    </div>
  </button>

  {/* Formulário Expandível */}
  {isAddFormOpen && (
    <div className="p-3 space-y-2 bg-white">
      {/* Nome do Cliente */}
      <input 
        type="text" 
        placeholder={t('ph_client')} 
        value={newStop.client}
        onChange={e => setNewStop({ ...newStop, client: e.target.value })}
        className="w-full border border-slate-200 p-1.5 rounded outline-none focus:border-[#004a99]"
      />

      {/* Morada Principal ou Local Conhecido */}
      <input 
        type="text" 
        placeholder={t('ph_address')} 
        value={newStop.address}
        onChange={e => setNewStop({ ...newStop, address: e.target.value })}
        className="w-full border border-slate-200 p-1.5 rounded outline-none focus:border-[#004a99]"
      />

      {/* Janela de Código Postal e Janela de Andar / Fração */}
      <div className="grid grid-cols-2 gap-2">
        <input 
          type="text" 
          placeholder={t('ph_postal')} 
          value={newStop.postalCode || ''}
          onChange={e => setNewStop({ ...newStop, postalCode: e.target.value })}
          className="col-span-1 border border-slate-200 p-1.5 rounded outline-none focus:border-[#004a99]"
        />
        <input 
          type="text" 
          placeholder={t('ph_floor')} 
          value={newStop.floor || ''}
          onChange={e => setNewStop({ ...newStop, floor: e.target.value })}
          autoComplete="off"
          className="col-span-1 border border-slate-200 p-1.5 rounded outline-none focus:border-[#004a99]"
        />
      </div>

      {/* Janela de Notas */}
      <input 
        type="text" 
        placeholder={t('ph_notes')} 
        value={newStop.notes || ''}
        onChange={e => setNewStop({ ...newStop, notes: e.target.value })}
        className="w-full border border-slate-200 p-1.5 rounded outline-none focus:border-[#004a99]"
      />

      {/* Seleção do Grupo e Botão Adicionar */}
      <div className="flex gap-2 pt-1">
        <select
          value={newStop.group || ''}
          onChange={(e) => setNewStop({ ...newStop, group: e.target.value })}
          className="border border-slate-200 p-1.5 rounded text-xs text-slate-700 bg-white outline-none focus:border-[#004a99]"
        >
          <option value="">{t('general_opt')}</option>
          {groups
            .filter((g) => g !== UNNAMED_GROUP)
            .map((g, idx) => (
              <option key={idx} value={g}>{groupLabel(g)}</option>
            ))}
          {/* Se o grupo atual já não existe na lista (pill renomeado), mantém-no visível */}
          {newStop.group && !groups.includes(newStop.group) && (
            <option value={newStop.group}>{groupLabel(newStop.group)}</option>
          )}
        </select>
        
        <button 
          type="button"
          onClick={async () => {
            await handleAddStop();
          }} 
          disabled={loading} 
          className="flex-1 bg-[#004a99] text-white font-bold rounded py-1.5 cursor-pointer hover:bg-blue-800 transition-colors flex items-center justify-center"
        >
          {loading ? t('searching') : (editingStopId != null ? t('save_changes') : t('add_dest'))}
        </button>
      </div>
    </div>
  )}
</div>
              {/* Ponto de Chegada / Destino Final */}
              <div className="bg-white p-2.5 rounded-xl border border-[#e2e8f0] space-y-1.5 text-xs shadow-sm">
                <div className="font-bold text-red-600 flex items-center gap-1 text-[11px]">
                  <Flag className="w-3 h-3" /> {t('final_title')}
                </div>
                <div className="flex gap-1.5">
                  <input 
                    type="text" placeholder={t('ph_final')} value={finalDestInput}
                    onChange={e => setFinalDestInput(e.target.value)}
                    className="flex-1 border p-1 rounded text-xs outline-none"
                  />
                  <button onClick={handleSetFinalDest} className="bg-red-500 text-white px-2.5 py-1 rounded font-bold text-xs">
                    {t('ok')}
                  </button>
                </div>
                {finalDest && <p className="text-[10px] text-emerald-600 font-bold truncate">✔ {finalDest.address}</p>}
              </div>

              <div className="text-[11px] font-bold text-[#64748b]">{t('selected_today')}</div>

              {/* Exportar CSV por grupo */}
              <div className="flex gap-2 items-center bg-white p-2 rounded-xl border border-[#e2e8f0] shadow-sm text-xs">
                <span className="font-bold text-slate-600 whitespace-nowrap">{t('export_csv')}</span>
                <select
                  value={exportGroup}
                  onChange={(e) => setExportGroup(e.target.value)}
                  className="flex-1 min-w-0 border border-slate-200 p-1.5 rounded text-xs text-slate-700 bg-white"
                >
                  <option value="Todos">{t('all_groups')}</option>
                  <option value="GERAL">{t('general_opt')}</option>
                  {groups
                    .filter((g) => g !== UNNAMED_GROUP)
                    .map((g, idx) => (
                      <option key={idx} value={g}>{groupLabel(g)}</option>
                    ))}
                </select>
                <button
                  onClick={() => handleExportGroupCSV(exportGroup)}
                  className="bg-slate-800 hover:bg-slate-900 text-white font-bold px-3 py-1.5 rounded cursor-pointer whitespace-nowrap"
                >
                  ⬇ CSV {!isPro && '🔒'}
                </button>
              </div>

             {/* Lista de Destinos Cadastrados */}
              <div className="space-y-3">
                <div className="space-y-1.5">
                  {filteredStops.map((s) => {
                    return (
                      <div
                        key={s.id}
                        className={`bg-white rounded-lg border border-[#e2e8f0] p-2.5 flex flex-col shadow-sm text-xs ${
                          editingStopId === s.id ? 'ring-2 ring-[#004a99]' : ''
                        }`}
                      >
                        {/* Linha principal com todos os teus elementos originais */}
                        <div className="flex justify-between items-center w-full">
                          <button onClick={() => toggleStopSelection(s)} className="mr-2">
                            {s.selected ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <Circle className="w-4 h-4 text-slate-300" />}
                          </button>
                          
                          <div className="flex-1 truncate mx-1">
                            <b className="text-[#1e293b]">{s.client}</b><br/>
                            <span className="text-[#64748b] text-[10px] truncate">{s.address}</span>
                          </div>

                          <span className="bg-[#e0f2fe] text-[#0369a1] px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ml-1">
                            {normalizeGroup(s.group) || t('general')}
                          </span>

                          {s.geo !== GEO_OK && (
                            <span title={t('geo_unverified')} className="ml-1 text-[11px]">⚠️</span>
                          )}

                          <button
                            onClick={() => startEditStop(s)}
                            className="text-slate-400 hover:text-[#004a99] ml-2 cursor-pointer"
                            aria-label={t('edit_aria')}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>

                          <button onClick={() => deleteStop(s.id)} className="text-slate-300 hover:text-red-500 ml-2">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {unverifiedStops.length > 0 && (
                  <button
                    onClick={handleFixLocations}
                    disabled={loading}
                    className="w-full py-1.5 rounded-lg bg-amber-50 border border-amber-300 text-amber-800 text-[11px] font-bold cursor-pointer disabled:opacity-50"
                  >
                    {t('fix_locations', { n: unverifiedStops.length })}
                  </button>
                )}

                {stops.length > 0 && (
                  <button
                    onClick={handleClearAll}
                    className="w-full text-[10px] text-slate-400 hover:text-red-500 underline cursor-pointer"
                  >
                    {t('clear_all')}
                  </button>
                )}

                {/* Botão Único Global para Enviar a Rota para o Google Maps */}
                {googleMapsUrl && (
                  <a
                    href={googleMapsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full mt-3 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold text-xs flex items-center justify-center gap-2 shadow-sm transition-colors text-center"
                  >
                    <span>{t('launch_gmaps')}</span>
                  </a>
                )}
                {googleMapsUrl && hasFinalDest && (
                  <p className="text-[10px] text-slate-500 text-center truncate">{t('final_dest_label', { a: finalDest.address })}</p>
                )}
              </div>
            </div>
          )}

          {/* ==========================================
              SEPARADOR MAPA INTERATIVO
              Sempre montado: só alterna hidden/block (nunca renderização condicional)
             ========================================== */}
          <div
            className={`${activeTab === 'mapa' ? 'block' : 'hidden'} relative z-0 h-[380px] w-full rounded-xl overflow-hidden border border-slate-200`}
          >
            <div ref={mapContainerRef} className="h-full w-full" />
          </div>

          {/* Cartão de resumo da rota: irmão do mapa (não precisa de Fragment) */}
          {routeInfo && activeTab === 'mapa' && (
            <div className="mt-3 bg-white rounded-xl border border-[#e2e8f0] shadow-sm p-3 text-xs">
              <div className="font-bold text-[#1e293b] mb-2">{t('route_summary')}</div>
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-slate-50 rounded-lg p-2">
                  <div className="text-[10px] text-slate-500">{t('distance')}</div>
                  <div className="font-bold text-[#004a99]">{approx}{fmt(routeInfo.distanceKm, 1)} km</div>
                </div>
                <div className="bg-slate-50 rounded-lg p-2">
                  <div className="text-[10px] text-slate-500">{t('duration')}</div>
                  <div className="font-bold text-[#004a99]">
                    {routeInfo.durationMin == null
                      ? '—'
                      : routeInfo.durationMin >= 60
                      ? `${Math.floor(routeInfo.durationMin / 60)} h ${routeInfo.durationMin % 60} min`
                      : `${routeInfo.durationMin} min`}
                  </div>
                </div>
                <div className="bg-slate-50 rounded-lg p-2">
                  <div className="text-[10px] text-slate-500">{t('consumption')}</div>
                  <div className="font-bold text-[#004a99]">
                    {fmt(routeUnits, 1)} {unitLabel}
                  </div>
                </div>
                <div className="bg-slate-50 rounded-lg p-2">
                  <div className="text-[10px] text-slate-500">{t('est_cost_lbl')}</div>
                  <div className="font-bold text-emerald-600">{approx}{fmt(routeCost)} €</div>
                </div>
              </div>
            </div>
          )}

         
     {/* ==========================================
              SEPARADOR DEFINIÇÕES E CUSTOS
              ========================================== */}
          {activeTab === 'custos' && (
            <div className="space-y-3 text-xs">
              <div className="bg-white p-3.5 rounded-xl border border-[#e2e8f0] space-y-3 shadow-sm">
                <div className="font-bold text-[#1e293b] border-b pb-2 flex justify-between items-center">
                  <span>{t('energy_title')}</span>
                </div>
                
              {/* Seletor de Tipo de Energia */}
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: t('e_label_Gasóleo'), type: 'Gasóleo', defaultPrice: 1.68, defaultCons: 5.5 },
                    { label: t('e_label_Gasolina95'), type: 'Gasolina95', defaultPrice: 1.72, defaultCons: 6.0 },
                    { label: t('e_label_GPL'), type: 'GPL', defaultPrice: 0.85, defaultCons: 7.0 },
                    { label: t('e_label_Elétrico'), type: 'Elétrico', defaultPrice: 0.20, defaultCons: 16 }
                  ].map(item => (
                    <button
                      key={item.type}
                      onClick={() => {
                        setEnergyType(item.type);
                        setFuelPrice(item.defaultPrice);
                        setCarData({ ...carData, consumption: item.defaultCons });
                      }}
                      className={`p-2 rounded-lg border text-left font-semibold transition cursor-pointer ${
                        energyType === item.type 
                          ? 'border-[#004a99] bg-[#e0f2fe] text-[#004a99]' 
                          : 'border-slate-200 bg-white text-slate-700'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>

                {/* Inputs Manuais de Preço e Consumo */}
                <div className="space-y-2.5 pt-2 border-t border-slate-100">
                  <div className="flex justify-between items-center">
                    <span className="text-slate-600">
                      {energyType === 'Elétrico' ? t('price_kwh') : t('price_l')}
                    </span>
                    <input 
                      type="number" 
                      step="0.01" 
                      value={fuelPrice} 
                      onChange={e => setFuelPrice(parseFloat(e.target.value) || 0)}
                      className="w-20 border border-slate-300 rounded p-1 text-right font-bold text-[#004a99] outline-none focus:border-[#004a99]"
                    />
                  </div>

                  <div className="flex justify-between items-center">
                    <span className="text-slate-600">
                      {energyType === 'Elétrico' ? t('cons_kwh') : t('cons_l')}
                    </span>
                    <input 
                      type="number" 
                      step="0.1" 
                      value={carData.consumption}
                      onChange={e => setCarData({ ...carData, consumption: parseFloat(e.target.value) || 0 })}
                      className="w-20 border border-slate-300 rounded p-1 text-right font-bold text-[#004a99] outline-none focus:border-[#004a99]"
                    />
                  </div>

                  <div className="flex justify-between items-center pt-1">
                    <span className="text-slate-600">{t('plate')}</span>
                    <input 
                      type="text" 
                      placeholder="AA-00-AA" 
                      value={carData.plate}
                      onChange={e => setCarData({ ...carData, plate: e.target.value })}
                      className="w-24 border border-slate-300 p-1 rounded text-center font-mono uppercase text-xs outline-none focus:border-[#004a99]"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

        </div>

        

        {/* Assinatura By Bastos por cima do footer */}
        <div className="text-center py-2 bg-white border-t border-slate-100 px-3">
          <img 
  src={logoSemFundo} 
  alt="By BASTOS - The Heritage Software Project" 
  style={{ height: '32px', width: 'auto', display: 'inline-block' }} 
/>
        </div>

      {/* Barra de Navegação Inferior (Bottom Nav) - Limpa (3 Separadores) */}
        <div className="h-[60px] bg-white border-t border-[#e2e8f0] flex justify-around items-center">
          <button 
            onClick={() => setActiveTab('inicio')} 
            className={`flex flex-col items-center border-none bg-transparent cursor-pointer ${activeTab === 'inicio' ? 'text-[#004a99] font-bold' : 'text-[#64748b]'}`}
          >
            <Home className="w-5 h-5" />
            <span className="text-[10px]">{t('nav_home')}</span>
          </button>
          
          <button 
            onClick={() => setActiveTab('listas')} 
            className={`flex flex-col items-center border-none bg-transparent cursor-pointer ${activeTab === 'listas' ? 'text-[#004a99] font-bold' : 'text-[#64748b]'}`}
          >
            <List className="w-5 h-5" />
            <span className="text-[10px]">{t('nav_lists')}</span>
          </button>

          <button 
            onClick={() => setActiveTab('custos')} 
            className={`flex flex-col items-center border-none bg-transparent cursor-pointer ${activeTab === 'custos' ? 'text-[#004a99] font-bold' : 'text-[#64748b]'}`}
          >
            <Fuel className="w-5 h-5" />
            <span className="text-[10px]">{t('nav_costs')}</span>
          </button>
        </div>

      </div>

      {/* MODAL PAYWALL & ATIVAÇÃO DE LICENÇA */}
      {showPaywall && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 text-center shadow-2xl relative border border-slate-100">
            
            <button 
              onClick={() => setShowPaywall(false)}
              className="absolute top-3 right-3 text-slate-400 hover:text-slate-600 font-bold p-1 text-lg cursor-pointer"
            >
              ✕
            </button>

            <div className="w-12 h-12 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center mx-auto mb-3 text-2xl">
              👑
            </div>

            <h3 className="text-xl font-bold text-slate-800 mb-1">{t('pw_title')}</h3>
            <p className="text-xs text-slate-500 mb-4">
              {t('pw_sub')}
            </p>

            <ul className="text-left text-xs text-slate-600 space-y-2 mb-6 bg-slate-50 p-3.5 rounded-xl border border-slate-100">
              <li className="flex items-center gap-2">
                <span className="text-emerald-500 font-bold">✓</span> {t('pw_f1')}
              </li>
              <li className="flex items-center gap-2">
                <span className="text-emerald-500 font-bold">✓</span> {t('pw_f2')}
              </li>
              <li className="flex items-center gap-2">
                <span className="text-emerald-500 font-bold">✓</span> {t('pw_f3')}
              </li>
              <li className="flex items-center gap-2">
                <span className="text-emerald-500 font-bold">✓</span> {t('pw_f4')}
              </li>
            </ul>

            {/* Opções de Preço */}
            <div className="space-y-2.5 mb-4">
              <button 
                onClick={() => alert(t('pay_monthly_alert'))}
                className="w-full py-3 px-4 rounded-xl border-2 border-[#004a99] bg-blue-50/50 hover:bg-blue-50 flex items-center justify-between font-bold text-slate-800 transition cursor-pointer"
              >
                <span className="text-xs">{t('plan_monthly')}</span>
                <span className="text-sm text-[#004a99]">{t('price_month')} <span className="text-[10px] font-normal text-slate-500">{t('per_month')}</span></span>
              </button>

              <button 
                onClick={() => alert(t('pay_yearly_alert'))}
                className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-[#004a99] to-blue-700 text-white flex items-center justify-between font-bold shadow-md hover:opacity-95 transition relative overflow-hidden cursor-pointer"
              >
                <span className="text-xs flex items-center gap-1">
                  {t('plan_yearly')} <span className="bg-amber-400 text-slate-900 text-[9px] px-1.5 py-0.5 rounded-full font-extrabold uppercase">{t('save_badge')}</span>
                </span>
                <span className="text-sm">{t('price_year')} <span className="text-[10px] font-normal text-blue-200">{t('per_year')}</span></span>
              </button>
            </div>

            {/* Caixinha para o Código de Ativação */}
            <div className="pt-3 border-t border-slate-100">
              <p className="text-[11px] text-slate-500 mb-2 font-medium">{t('have_code')}</p>
              <div className="flex gap-2">
                <input 
                  type="text" 
                  placeholder={t('ph_code')}
                  value={promoCode}
                  onChange={(e) => {
                    setPromoCode(e.target.value);
                    setPromoError('');
                  }}
                  className="flex-1 px-3 py-1.5 text-xs rounded-lg border border-slate-300 focus:outline-none focus:border-[#004a99] font-mono"
                />
                <button 
                  onClick={handleApplyCode}
                  className="bg-slate-800 hover:bg-slate-900 text-white font-bold text-xs px-3 py-1.5 rounded-lg transition cursor-pointer"
                >
                  {t('activate')}
                </button>
              </div>
              {promoError && (
                <p className="text-[10px] text-red-500 mt-1 text-left font-medium">{t('code_bad')}</p>
              )}
            </div>

            <button 
              onClick={() => setShowPaywall(false)}
              className="mt-4 text-xs text-slate-400 hover:text-slate-600 underline font-medium cursor-pointer"
            >
              {t('continue_free')} 
            </button>

            {/* Assinatura By Bastos no fundo do Modal */}
            <div className="mt-4 pt-3 border-t border-slate-100 flex justify-center">
              <img 
                src={logoBastos} 
                alt="By BASTOS - The Heritage Software Project" 
                style={{ height: '80px', width: 'auto' }} 
              />
            </div>

          </div>
        </div>
      )}

    </div>
  );
}