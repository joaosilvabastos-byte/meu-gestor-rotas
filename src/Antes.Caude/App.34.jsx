import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, doc, setDoc, onSnapshot, deleteDoc, getDocs, writeBatch } from 'firebase/firestore';
import {
  Trash2, Flag, Fuel, CheckCircle2, Circle, Home, List, Pencil, Upload, Download, Check
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
// O Google Maps aceita no máximo 9 paragens intermédias + o destino = 10 pontos por link; o que passar é ignorado.
const MAPS_MAX_POINTS = 10;

// ---------- Google Play Billing (cordova-plugin-purchase v13) ----------
// UMA subscrição na Play Console com dois planos base. O produto é o ID da subscrição;
// cada botão pede a oferta (getOffer) do plano base correspondente.
const PRODUCT_ID = 'com.bybastos.routeflexpro';
const PLANS = {
  monthly: { id: 'monthly-plan', period: 'P1M' },
  yearly: { id: 'yearly-plan', period: 'P1Y' }
};
// Oferta do plano base: 1) id exato do plano; 2) "plano@oferta" (promoção desse plano); 3) pela duração (P1M / P1Y)
const findPlanOffer = (product, plan) => {
  const offers = (product && product.offers) || [];
  const lastPhase = (o) => (o.pricingPhases && o.pricingPhases[o.pricingPhases.length - 1]) || {};
  return (
    offers.find((o) => o.id === plan.id) ||
    offers.find((o) => String(o.id).split('@')[0] === plan.id) ||
    offers.find((o) => lastPhase(o).billingPeriod === plan.period) ||
    null
  );
};
const PRO_STORAGE_KEY = 'isPro_playstore';
const readProFlag = () => { try { return localStorage.getItem(PRO_STORAGE_KEY) === 'true'; } catch { return false; } };
// ---------- Armazenamento durável ----------
// localStorage (síncrono) + espelho em @capacitor/preferences (SharedPreferences do Android), se o plugin existir.
// Se o Android limpar o localStorage do WebView, os dados voltam do espelho no arranque.
const nativePrefs = () => { try { return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences; } catch { return null; } };
const kvSet = (k, v) => {
  try { localStorage.setItem(k, v); } catch { /* sem storage */ }
  try { const p = nativePrefs(); if (p) p.set({ key: k, value: v }); } catch { /* sem plugin */ }
};
const kvRemove = (k) => {
  try { localStorage.removeItem(k); } catch { /* sem storage */ }
  try { const p = nativePrefs(); if (p) p.remove({ key: k }); } catch { /* sem plugin */ }
};
const kvGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const kvGetNative = async (k) => { try { const p = nativePrefs(); if (!p) return null; const r = await p.get({ key: k }); return r && r.value != null ? r.value : null; } catch { return null; } };

// Números escritos pelo utilizador: aceita ponto e vírgula decimais; devolve NaN se não houver número
const sanitizeDecimal = (raw) => String(raw).replace(/[^0-9.,]/g, '');
const parseDecimal = (raw) => parseFloat(String(raw).replace(',', '.'));

const PRO_CODE_KEY = 'routeflex_pro_code';   // Pro ativado por código de licença
const STOPS_KEY = 'routeflex_stops_v1';      // lista de destinos
const readStops = () => { try { const v = JSON.parse(kvGet(STOPS_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

const writeProFlag = (on) => { if (on) kvSet(PRO_STORAGE_KEY, 'true'); else kvRemove(PRO_STORAGE_KEY); };

// O listener é registado já quando o módulo carrega, para nunca perder o evento 'deviceready'.
// Só no telemóvel (Capacitor/Cordova) é que o evento existe; no browser a promessa resolve a false.
const deviceReady = new Promise((resolve) => {
  if (typeof document === 'undefined') return resolve(false);
  const pluginThere = () => !!(window.CdvPurchase && window.CdvPurchase.store);
  document.addEventListener('deviceready', () => resolve(true), { once: true });
  // Se o evento já passou, ou o plugin demora a injetar-se, espreita até 10 s
  let tries = 0;
  const poll = setInterval(() => {
    if (pluginThere()) { clearInterval(poll); resolve(true); }
    else if (++tries >= 40) { clearInterval(poll); resolve(false); }
  }, 250);
});
// Identifica a versão em execução (aparece em Custos, no fundo). Se não coincidir com a que recebeste, estás a correr outro ficheiro.
const BUILD_ID = '2026.11.05-localidade';

// ---------- Leitura de CSV por NOME de coluna (qualquer ordem, vírgula ou ponto e vírgula) ----------
const CSV_ALIASES = {
  client:  ['cliente', 'clientelocal', 'local', 'nome', 'nomeentidade', 'entidade', 'client', 'name', 'customer', 'business', 'nombre', 'nom'],
  address: ['morada', 'endereco', 'direccao', 'rua', 'address', 'street', 'direccion', 'adresse'],
  postal:  ['codigopostal', 'codpostal', 'cp', 'postcode', 'postalcode', 'zip', 'zipcode', 'codigopostal', 'codepostal'],
  city:    ['localidade', 'cidade', 'concelho', 'city', 'town', 'ciudad', 'localidad', 'ville', 'localite'],
  floor:   ['andar', 'fracao', 'floor', 'piso', 'etage'],
  notes:   ['notas', 'observacoes', 'obs', 'notes', 'remarques'],
  group:   ['grupo', 'group', 'groupe']
};
const csvKey = (h) => plainText(h).replace(/[^a-z0-9]/g, '');

// Separador (; , ou TAB): conta fora de aspas nas primeiras linhas e escolhe o que aparece em TODAS elas.
// Em empate prefere ';' (vírgulas aparecem dentro de moradas: "Rua X, 12").
const detectDelimiter = (sampleLines) => {
  const countOutsideQuotes = (line, ch) => {
    let q = false, n = 0;
    for (const c of line) { if (c === '"') q = !q; else if (c === ch && !q) n++; }
    return n;
  };
  const sample = (Array.isArray(sampleLines) ? sampleLines : [sampleLines]).slice(0, 6);
  let best = ',', bestScore = -1;
  [';', '\t', ','].forEach((ch) => {
    const counts = sample.map((l) => countOutsideQuotes(l, ch));
    const score = Math.min(...counts) * 1000 + counts.reduce((a, b) => a + b, 0);
    if (score > bestScore) { best = ch; bestScore = score; }
  });
  return best;
};

// Lê os bytes do ficheiro: UTF-8 e, se não for válido (Excel antigo em Windows-1252), Windows-1252.
const decodeCsvBuffer = (buf) => {
  const b = new Uint8Array(buf);
  // UTF-16 (o Excel "Unicode" grava assim): reconhece-se pelo BOM FF FE / FE FF
  if (b.length > 1 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b.length > 1 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); }
  catch { return new TextDecoder('windows-1252').decode(b); }
};

// Localidade por defeito quando o CSV não a traz. Fica 'Lisboa' enquanto não houver outras paragens;
// a partir daí usa a localidade mais frequente das paragens já confirmadas (serve noutras cidades/países).
// Para desligar: DEFAULT_CITY = ''.
const DEFAULT_CITY = 'Lisboa';
const dominantPlaceText = (list) => {
  const count = {};
  list.forEach((x) => { const c = String(x.place || '').trim(); if (c) count[c] = (count[c] || 0) + 1; });
  return Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
};
const dominantCity = (list) => {
  const count = {};
  list.forEach((x) => { const c = String(x.place || '').split(', ')[0].trim(); if (c) count[c] = (count[c] || 0) + 1; });
  return Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
};

// Divide uma linha respeitando aspas ("a,b" fica numa célula) e "" como aspa literal
const parseCsvLine = (line, delim) => {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
};

// Cabeçalho -> índice de cada campo. Sem cabeçalho reconhecível (sem coluna de morada) usa a ordem fixa e a 1ª linha conta como dados.
const mapCsvColumns = (headerCols) => {
  const keys = headerCols.map(csvKey);
  const map = {};
  Object.entries(CSV_ALIASES).forEach(([field, names]) => {
    const idx = keys.findIndex((k) => names.includes(k));
    if (idx >= 0) map[field] = idx;
  });
  // Sem cabeçalho: ordem das colunas do próprio export da app (Cliente, Morada, Código Postal, Localidade, Andar, Notas, Grupo)
  if (map.address == null) return { client: 0, address: 1, postal: 2, city: 3, floor: 4, notes: 5, group: 6, legacy: true };
  return map;
};

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
    maps_split: 'O Google Maps aceita no máximo {max} paragens por link. A rota foi dividida em {n} links: faça-os por ordem (cada um começa onde o anterior acaba).',
    route_order: 'Ordem de entrega (igual à do Google Maps)',
    csv_city: 'Localidade',
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
    import_ok: 'Importação OK! {n} destinos carregados.',
    import_ok_one: 'Importação OK! {n} destino carregado.',
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
    csv_group: 'Grupo',
    delete_group: 'Eliminar grupo',
    delete_group_confirm: 'Eliminar o grupo "{g}"?\nOs {n} destinos mantêm-se, passam para GERAL (sem grupo).',
    billing_unavailable: "Subscrição indisponível neste momento. Abre a app instalada a partir da Google Play e tenta de novo.",
    restore_purchases: "Restaurar compras",
    restore_ok: "Pro restaurado com sucesso!",
    restore_none: "Não foram encontradas compras ativas nesta conta Google.",
    buy_ok: "Compra concluída. Pro ativado!",
    buy_error: "Não foi possível concluir a compra. Tenta de novo.",
    sub_terms: "Subscrição com renovação automática. Cancela quando quiseres na Google Play.",
    processing: "A processar…",
    export_plugin_missing: "Exportar CSV: instala os plugins @capacitor/filesystem e @capacitor/share e corre 'npx cap sync android'.",
    geo_approx: "Localização aproximada (centro da localidade): confirma/corrige a morada.",
    export_ready: "Ficheiro pronto: escolhe onde o guardar ou enviar.",
    csv_bad: "O ficheiro chegou à app sem dados: só tem o texto «{c}» ({b} bytes). O CSV no telemóvel está vazio ou corrompido. Copia-o outra vez para o telemóvel (Drive, e-mail ou cabo USB), abre-o para confirmar que tem as linhas e importa de novo.",
    export_name_prompt: "Nome do ficheiro CSV:",
    export_replace: "Já existe o ficheiro «{f}».\n\nOK = substituir\nCancelar = guardar como novo («{n}»)",
    template_csv: "Modelo CSV",
    template_saved: "CSV guardado em Downloads!",
    template_shared: "Modelo pronto: escolhe onde o guardar.",
    current_dest: "DESTINO ATUAL",
    floor_label: "Andar",
    notes_label: "Notas",
    complete_next: "Concluir e Ir para o Próximo",
    complete_last: "Concluir (último destino)",
    navigate_here: "Navegar",
    route_finished: "Rota concluída! 🎉",
    nav_app: "Navegação",
    reopen_stop: "Reabrir destino",
    no_floor_notes: "Sem andar nem notas para este destino.",
    done_btn: "Concluído",
    ph_city: "Localidade / Cidade",
    replace_route_confirm: "Substituir rota atual?\nOs {n} destinos existentes serão apagados e substituídos pelos do ficheiro.",
    replace_route_confirm_one: "Substituir rota atual?\nO destino existente será apagado e substituído pelos do ficheiro."
  },

  en: {
    maps_split: 'Google Maps accepts at most {max} stops per link. The route was split into {n} links: do them in order (each starts where the previous one ends).',
    route_order: 'Delivery order (same as Google Maps)',
    csv_city: 'City',
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
    import_ok: 'Import OK! {n} stops loaded.',
    import_ok_one: 'Import OK! {n} stop loaded.',
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
    csv_group: 'Group',
    delete_group: 'Delete group',
    delete_group_confirm: 'Delete the group "{g}"?\nThe {n} stops are kept and move to GENERAL (no group).',
    billing_unavailable: "Subscription unavailable right now. Open the app installed from Google Play and try again.",
    restore_purchases: "Restore purchases",
    restore_ok: "Pro restored successfully!",
    restore_none: "No active purchases found for this Google account.",
    buy_ok: "Purchase complete. Pro activated!",
    buy_error: "The purchase could not be completed. Please try again.",
    sub_terms: "Auto-renewing subscription. Cancel anytime in Google Play.",
    processing: "Processing…",
    export_plugin_missing: "CSV export: install @capacitor/filesystem and @capacitor/share and run 'npx cap sync android'.",
    geo_approx: "Approximate location (town centre): check/correct the address.",
    export_ready: "File ready: choose where to save or send it.",
    csv_bad: "The file reached the app without data: it only contains the text “{c}” ({b} bytes). The CSV on the phone is empty or corrupted. Copy it to the phone again (Drive, e-mail or USB), open it to check the rows, then import again.",
    export_name_prompt: "CSV file name:",
    export_replace: "The file “{f}” already exists.\n\nOK = replace it\nCancel = save as new (“{n}”)",
    template_csv: "CSV template",
    template_saved: "CSV saved in Downloads!",
    template_shared: "Template ready: choose where to save it.",
    current_dest: "CURRENT STOP",
    floor_label: "Floor",
    notes_label: "Notes",
    complete_next: "Complete and Go to Next",
    complete_last: "Complete (last stop)",
    navigate_here: "Navigate",
    route_finished: "Route complete! 🎉",
    nav_app: "Navigation",
    reopen_stop: "Reopen stop",
    no_floor_notes: "No floor or notes for this stop.",
    done_btn: "Done",
    ph_city: "Town / City",
    replace_route_confirm: "Replace current route?\nThe {n} existing stops will be deleted and replaced by the ones in the file.",
    replace_route_confirm_one: "Replace current route?\nThe existing stop will be deleted and replaced by the ones in the file."
  },

  es: {
    maps_split: 'Google Maps acepta como máximo {max} paradas por enlace. La ruta se dividió en {n} enlaces: hazlos en orden (cada uno empieza donde termina el anterior).',
    route_order: 'Orden de entrega (igual que en Google Maps)',
    csv_city: 'Localidad',
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
    import_ok: '¡Importación OK! {n} destinos cargados.',
    import_ok_one: '¡Importación OK! {n} destino cargado.',
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
    csv_group: 'Grupo',
    delete_group: 'Eliminar grupo',
    delete_group_confirm: '¿Eliminar el grupo "{g}"?\nLos {n} destinos se mantienen y pasan a GENERAL (sin grupo).',
    billing_unavailable: "Suscripción no disponible ahora. Abre la app instalada desde Google Play e inténtalo de nuevo.",
    restore_purchases: "Restaurar compras",
    restore_ok: "¡Pro restaurado con éxito!",
    restore_none: "No se encontraron compras activas en esta cuenta de Google.",
    buy_ok: "Compra completada. ¡Pro activado!",
    buy_error: "No se pudo completar la compra. Inténtalo de nuevo.",
    sub_terms: "Suscripción con renovación automática. Cancela cuando quieras en Google Play.",
    processing: "Procesando…",
    export_plugin_missing: "Exportar CSV: instala los plugins @capacitor/filesystem y @capacitor/share y ejecuta 'npx cap sync android'.",
    geo_approx: "Ubicación aproximada (centro de la localidad): revisa/corrige la dirección.",
    export_ready: "Archivo listo: elige dónde guardarlo o enviarlo.",
    csv_bad: "El archivo llegó a la app sin datos: solo contiene el texto «{c}» ({b} bytes). El CSV del teléfono está vacío o dañado. Cópialo de nuevo al teléfono (Drive, correo o USB), ábrelo para comprobar las filas e impórtalo otra vez.",
    export_name_prompt: "Nombre del archivo CSV:",
    export_replace: "Ya existe el archivo «{f}».\n\nAceptar = reemplazar\nCancelar = guardar como nuevo («{n}»)",
    template_csv: "Modelo CSV",
    template_saved: "¡CSV guardado en Descargas!",
    template_shared: "Modelo listo: elige dónde guardarlo.",
    current_dest: "DESTINO ACTUAL",
    floor_label: "Piso",
    notes_label: "Notas",
    complete_next: "Completar e Ir al Siguiente",
    complete_last: "Completar (último destino)",
    navigate_here: "Navegar",
    route_finished: "¡Ruta completada! 🎉",
    nav_app: "Navegación",
    reopen_stop: "Reabrir destino",
    no_floor_notes: "Sin piso ni notas para este destino.",
    done_btn: "Hecho",
    ph_city: "Localidad / Ciudad",
    replace_route_confirm: "¿Sustituir la ruta actual?\nLos {n} destinos existentes se borrarán y se sustituirán por los del archivo.",
    replace_route_confirm_one: "¿Sustituir la ruta actual?\nEl destino existente se borrará y se sustituirá por los del archivo."
  },

  fr: {
    maps_split: "Google Maps accepte au maximum {max} arrêts par lien. L'itinéraire a été divisé en {n} liens : faites-les dans l'ordre (chacun commence où le précédent se termine).",
    route_order: 'Ordre de livraison (identique à Google Maps)',
    csv_city: 'Localité',
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
    import_ok: 'Importation OK ! {n} destinations chargées.',
    import_ok_one: 'Importation OK ! {n} destination chargée.',
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
    csv_group: 'Groupe',
    delete_group: 'Supprimer le groupe',
    delete_group_confirm: 'Supprimer le groupe « {g} » ?\nLes {n} destinations sont conservées et passent à GÉNÉRAL (sans groupe).',
    billing_unavailable: "Abonnement indisponible pour le moment. Ouvrez l'app installée depuis Google Play et réessayez.",
    restore_purchases: "Restaurer les achats",
    restore_ok: "Pro restauré avec succès !",
    restore_none: "Aucun achat actif trouvé pour ce compte Google.",
    buy_ok: "Achat terminé. Pro activé !",
    buy_error: "L'achat n'a pas pu être finalisé. Réessayez.",
    sub_terms: "Abonnement à renouvellement automatique. Résiliez à tout moment dans Google Play.",
    processing: "Traitement…",
    export_plugin_missing: "Export CSV : installez @capacitor/filesystem et @capacitor/share puis lancez 'npx cap sync android'.",
    geo_approx: "Position approximative (centre de la localité) : vérifiez/corrigez l'adresse.",
    export_ready: "Fichier prêt : choisissez où l'enregistrer ou l'envoyer.",
    csv_bad: "Le fichier est arrivé sans données : il ne contient que le texte « {c} » ({b} octets). Le CSV du téléphone est vide ou corrompu. Copiez-le de nouveau sur le téléphone (Drive, e-mail ou USB), ouvrez-le pour vérifier les lignes, puis réimportez.",
    export_name_prompt: "Nom du fichier CSV :",
    export_replace: "Le fichier « {f} » existe déjà.\n\nOK = remplacer\nAnnuler = enregistrer comme nouveau (« {n} »)",
    template_csv: "Modèle CSV",
    template_saved: "CSV enregistré dans Téléchargements !",
    template_shared: "Modèle prêt : choisissez où l'enregistrer.",
    current_dest: "DESTINATION ACTUELLE",
    floor_label: "Étage",
    notes_label: "Notes",
    complete_next: "Terminer et Aller au Suivant",
    complete_last: "Terminer (dernière destination)",
    navigate_here: "Naviguer",
    route_finished: "Itinéraire terminé ! 🎉",
    nav_app: "Navigation",
    reopen_stop: "Rouvrir la destination",
    no_floor_notes: "Pas d'étage ni de notes pour cette destination.",
    done_btn: "Terminé",
    ph_city: "Localité / Ville",
    replace_route_confirm: "Remplacer l'itinéraire actuel ?\nLes {n} destinations existantes seront supprimées et remplacées par celles du fichier.",
    replace_route_confirm_one: "Remplacer l'itinéraire actuel ?\nLa destination existante sera supprimée et remplacée par celles du fichier."
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

// Sem distinguir maiúsculas/acentos: "Geral", "GERAL" e "geral" são o mesmo "sem grupo"
const plainSet = (set) => new Set([...set].map((x) => plainText(x).trim()));
const PLAIN_SYSTEM = new Set([...plainSet(SYSTEM_ALL), ...plainSet(SYSTEM_GENERAL), ...plainSet(SYSTEM_UNNAMED)]);
const normalizeGroup = (g) => (!g || PLAIN_SYSTEM.has(plainText(g).trim()) ? '' : g);

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
  const [stops, setStops] = useState(readStops); // arranca com os destinos guardados no telemóvel
  const [finalDest, setFinalDest] = useState(null);
  const [userPos, setUserPos] = useState(null);
  const [loading, setLoading] = useState(false);
  const [routeInfo, setRouteInfo] = useState(null);

  // Formulários e Configurações (Incluindo Andar e Notas)
  // Estados para Controlo do Plano Pro e Código de Licença
  const [userProfile, setUserProfile] = useState(() => ({ plan: kvGet(PRO_CODE_KEY) === 'true' ? 'pro' : 'free' }));
  const [showPaywall, setShowPaywall] = useState(false);
  const [promoCode, setPromoCode] = useState('');
  const [promoError, setPromoError] = useState('');

  const [isProPlay, setIsProPlay] = useState(readProFlag); // Pro comprado/restaurado na Google Play
  const [billingReady, setBillingReady] = useState(false);
  const [billingBusy, setBillingBusy] = useState(false);
  const billingDiag = useRef('A iniciar…'); // texto técnico mostrado se a compra falhar (ajuda a achar o problema)
  const [storePrices, setStorePrices] = useState({});      // preços reais devolvidos pela Play
  const isPro = userProfile?.plan === 'pro' || isProPlay;
  // Guarda os destinos sempre que mudam (um pequeno atraso junta várias alterações seguidas)
  useEffect(() => {
    const id = setTimeout(() => { try { kvSet(STOPS_KEY, JSON.stringify(stops)); } catch { /* quota */ } }, 300);
    return () => clearTimeout(id);
  }, [stops]);
  // Se o localStorage foi limpo pelo Android, recupera Pro e destinos do espelho nativo
  useEffect(() => {
    (async () => {
      if (!nativePrefs()) return;
      if (!readProFlag() && (await kvGetNative(PRO_STORAGE_KEY)) === 'true') { try { localStorage.setItem(PRO_STORAGE_KEY, 'true'); } catch { /* */ } setIsProPlay(true); }
      if (kvGet(PRO_CODE_KEY) !== 'true' && (await kvGetNative(PRO_CODE_KEY)) === 'true') { try { localStorage.setItem(PRO_CODE_KEY, 'true'); } catch { /* */ } setUserProfile({ plan: 'pro' }); }
      if (readStops().length === 0) {
        try { const v = JSON.parse((await kvGetNative(STOPS_KEY)) || '[]'); if (Array.isArray(v) && v.length) setStops((cur) => (cur.length ? cur : v)); } catch { /* */ }
      }
    })();
  }, []);
  const [newStop, setNewStop] = useState({ client: '', address: '', postalCode: '', city: '', floor: '', notes: '', group: '' });
  const [editingStopId, setEditingStopId] = useState(null); // id da paragem em edição (null = a criar nova)
  const formRef = useRef(null);
  const [exportGroup, setExportGroup] = useState('Todos'); // grupo escolhido para exportar em CSV
  const [finalDestInput, setFinalDestInput] = useState('');
  const [energyType, setEnergyType] = useState('Gasóleo');
  const [fuelPrice, setFuelPrice] = useState(1.68);
  const [carData, setCarData] = useState({ plate: '', consumption: 6.5 });
  // Texto que o utilizador está a escrever (permite campo vazio sem forçar '0'); null = mostra o valor guardado
  const [priceDraft, setPriceDraft] = useState(null);
  const [consDraft, setConsDraft] = useState(null);
  const [toastMsg, setToastMsg] = useState('');
  const toastTimer = useRef(null);
  const showToast = (msg) => {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(''), 2800);
  };
  const [geoProgress, setGeoProgress] = useState(null); // { done, total } enquanto localiza moradas

  // 5 Pílulas Iniciais com o texto 'Editar ✏️'
  const [groups, setGroups] = useState(['Editar ✏️', 'Editar ✏️', 'Editar ✏️', 'Editar ✏️', 'Editar ✏️']);
  const [editingGroupIdx, setEditingGroupIdx] = useState(null);
  const [editGroupValue, setEditGroupValue] = useState('');

  // Qualquer grupo que exista nos destinos (CSV importado, dados na nuvem...) passa a existir também
  // nos filtros: ocupa uma pílula por nomear ou, se não houver, é acrescentado ao fim.
  useEffect(() => {
    const names = [];
    stops.forEach((st) => {
      const g = normalizeGroup(st.group);
      if (g && !names.includes(g)) names.push(g);
    });
    const missing = names.filter((n) => !groups.includes(n));
    if (!missing.length) return;
    setGroups((prev) => {
      const next = [...prev];
      missing.forEach((n) => {
        if (next.includes(n)) return;
        const free = next.indexOf(UNNAMED_GROUP);
        if (free >= 0) next[free] = n; else next.push(n);
      });
      return next;
    });
  }, [stops, groups]);

  // Elimina um grupo: os destinos ficam, mas sem grupo (GERAL). A pílula volta a "Editar" (ou desaparece se era extra).
  const handleDeleteGroup = (idx) => {
    const name = groups[idx];
    if (!name || name === UNNAMED_GROUP) return;
    const n = stops.filter((st) => st.group === name).length;
    if (!window.confirm(t('delete_group_confirm', { g: name, n }))) return;
    setStops((prev) => prev.map((st) => (st.group === name ? { ...st, group: '' } : st)));
    setGroups((prev) => (idx < 5 ? prev.map((g, i) => (i === idx ? UNNAMED_GROUP : g)) : prev.filter((_, i) => i !== idx)));
    if (selectedGroup === name) setSelectedGroup('Todos');
    setNewStop((f) => (f.group === name ? { ...f, group: '' } : f));
    setExportGroup((g) => (g === name ? 'Todos' : g));
    setEditingGroupIdx(null);
  };
  // ---------- Google Play Billing ----------
  const grantPro = () => { writeProFlag(true); setIsProPlay(true); setShowPaywall(false); };
  const ownsPro = (store) => store.owned(PRODUCT_ID);

  useEffect(() => {
    let cancelled = false;
    deviceReady.then((isDevice) => {
      if (cancelled) return;
      const CdvPurchase = window.CdvPurchase;
      if (!isDevice || !CdvPurchase || !CdvPurchase.store) {
        billingDiag.current = !isDevice && !CdvPurchase
          ? 'Plugin cordova-plugin-purchase não encontrado (corre: npm i cordova-plugin-purchase && npx cap sync android; ou estás no browser)'
          : 'deviceready não disparou / store indisponível';
        return;
      }
      if (window.__routeflexBillingInit) { setBillingReady(true); return; } // evita registar duas vezes
      window.__routeflexBillingInit = true;

      let initOk = false; // só passa a true depois de store.initialize terminar sem erros
      const { store, ProductType, Platform } = CdvPurchase;
      try { store.verbosity = CdvPurchase.LogLevel.DEBUG; } catch { /* opcional */ } // logs no logcat: filtra por 'CordovaPurchase'
      const refreshPrices = () => {
        const prices = {};
        const product = store.get(PRODUCT_ID, Platform.GOOGLE_PLAY);
        Object.entries(PLANS).forEach(([key, plan]) => {
          const offer = findPlanOffer(product, plan);
          const phases = (offer && offer.pricingPhases) || [];
          const price = phases[phases.length - 1]; // última fase = preço recorrente (ignora período de teste)
          if (price && price.price) prices[key] = price.price;
        });
        setStorePrices(prices);
      };

      store.register([
        { id: PRODUCT_ID, type: ProductType.PAID_SUBSCRIPTION, platform: Platform.GOOGLE_PLAY }
      ]);

      store.when()
        .productUpdated(refreshPrices)
        .approved((transaction) => {
          // Compra aprovada: marca Pro, confirma a transação (obrigatório, senão a Google reembolsa em 3 dias) e atualiza a UI
          grantPro();
          transaction.finish();
        })
        .finished(() => setBillingBusy(false))
        .receiptsReady(() => {
          // Só retira o Pro se a loja iniciou sem erros e confirma que NÃO há subscrição ativa
          if (ownsPro(store)) grantPro();
          else if (initOk && readProFlag()) { writeProFlag(false); setIsProPlay(false); }
        });

      store.error((err) => {
        console.warn('Billing:', err && err.code, err && err.message);
        billingDiag.current = `Erro da loja ${err && err.code}: ${err && err.message}`;
        setBillingBusy(false);
      });

      store.initialize([Platform.GOOGLE_PLAY]).then((errors) => {
        if (cancelled) return;
        if (errors && errors.length) billingDiag.current = 'initialize: ' + errors.map((e) => `${e.code} ${e.message}`).join(' | ');
        else { billingDiag.current = 'Loja iniciada'; initOk = true; }
        setBillingReady(true);
        refreshPrices();
      });
    });
    return () => { cancelled = true; };
  }, []);

  // Botões Mensal / Anual
  const handleSubscribe = async (planKey) => {
    const plan = PLANS[planKey];
    const CdvPurchase = window.CdvPurchase;
    if (!plan || !billingReady || !CdvPurchase || !CdvPurchase.store) return alert(`${t('billing_unavailable')}\n\n[${billingDiag.current}]`);
    const product = CdvPurchase.store.get(PRODUCT_ID, CdvPurchase.Platform.GOOGLE_PLAY);
    const offer = findPlanOffer(product, plan); // oferta do plano base escolhido (monthly-plan / yearly-plan)
    if (!offer || offer.canPurchase === false) {
      // A Play não devolveu o produto/plano (ID errado, plano inativo, app fora de uma faixa de teste, conta sem licença...)
      const ids = ((product && product.offers) || []).map((o) => o.id).join(', ') || 'nenhuma';
      const why = !product ? `produto "${PRODUCT_ID}" não devolvido pela Play` : !offer ? `plano "${plan.id}" não encontrado (ofertas devolvidas: ${ids})` : `oferta "${offer.id}" não comprável (já subscrita?)`;
      return alert(`${t('billing_unavailable')}\n\n[${why} | ${billingDiag.current}]`);
    }
    setBillingBusy(true);
    try {
      const err = await offer.order(); // devolve um erro, ou undefined se o ecrã de pagamento abriu bem
      if (err && err.code !== CdvPurchase.ErrorCode.PAYMENT_CANCELLED) alert(`${t('buy_error')}\n\n[${err.code}: ${err.message}]`);
      if (err) setBillingBusy(false);
      // Sem erro: o resultado chega ao listener 'approved' (que desbloqueia o Pro e liberta o botão)
    } catch (e) {
      console.warn('Billing order:', e);
      setBillingBusy(false);
      alert(t('buy_error'));
    }
  };

  // Restaurar compras
  const handleRestore = async () => {
    const CdvPurchase = window.CdvPurchase;
    if (!billingReady || !CdvPurchase || !CdvPurchase.store) return alert(t('billing_unavailable'));
    setBillingBusy(true);
    try {
      await CdvPurchase.store.restorePurchases();
      if (ownsPro(CdvPurchase.store)) { grantPro(); alert(t('restore_ok')); }
      else alert(t('restore_none'));
    } catch (e) {
      console.warn('Billing restore:', e);
      alert(t('buy_error'));
    } finally {
      setBillingBusy(false);
    }
  };

  // Validação do Código de Licença
  const handleApplyCode = () => {
    if (promoCode.trim().toLowerCase() === 'route2026pro') {
      kvSet(PRO_CODE_KEY, 'true'); // mantém o Pro depois de fechar a app
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
  const CSV_HEADERS = ['csv_client', 'csv_address', 'csv_postal', 'csv_city', 'csv_floor', 'csv_notes', 'csv_group'].map((k) => t(k));
  const CSV_BOM = String.fromCharCode(0xfeff);
  const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const slugify = (t) =>
    String(t).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'grupo';

  const downloadStopsCSV = (list, namePart) => {
    const rows = [CSV_HEADERS.map(csvCell).join(',')];
    list.forEach((s) => {
      rows.push(
        [s.client, s.address, s.postalCode, s.city || '', s.floor, s.notes, normalizeGroup(s.group) || t('general')]
          .map(csvCell)
          .join(',')
      );
    });

    // BOM (U+FEFF) no início: o Excel só abre os acentos corretamente com ele
    const suggested = `destinos_${namePart}_${new Date().toISOString().slice(0, 10)}`;
    saveCsvFile(suggested, CSV_BOM + rows.join('\r\n'));
  };

  // Android (Capacitor): o <a download> não funciona no WebView. Grava no cache e abre a folha de partilha
  // (Guardar em Ficheiros/Drive, WhatsApp, e-mail...). No browser/PC mantém o download normal.
  const saveCsvFile = async (suggested, content) => {
    // Nome escolhido pelo utilizador (sem extensão; a app acrescenta .csv e tira caracteres proibidos)
    const typed = window.prompt(t('export_name_prompt'), suggested);
    if (typed === null) return; // cancelou
    const base = String(typed).replace(/\.csv$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || suggested;
    let filename = `${base}.csv`;

    const cap = window.Capacitor;
    const native = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
    if (native) {
      const { Filesystem, Share } = cap.Plugins || {};
      if (!Filesystem || !Share) { alert(t('export_plugin_missing')); return; }
      const exists = async (name) => { try { await Filesystem.stat({ path: name, directory: 'CACHE' }); return true; } catch { return false; } };
      // Nome já usado: substituir (OK) ou guardar como novo "nome (2).csv" (Cancelar)
      if (await exists(filename)) {
        let k = 2;
        while (await exists(`${base} (${k}).csv`)) k++;
        const fresh = `${base} (${k}).csv`;
        if (!window.confirm(t('export_replace', { f: filename, n: fresh }))) filename = fresh;
      }
      try {
        const written = await Filesystem.writeFile({ path: filename, data: content, directory: 'CACHE', encoding: 'utf8' });
        await Share.share({ title: filename, dialogTitle: t('export_ready'), files: [written.uri] });
      } catch (err) {
        const msg = String((err && err.message) || err || '');
        if (!/cancel/i.test(msg)) alert(`${t('buy_error')}\n\n[${msg}]`); // cancelar a partilha não é erro
      }
      return;
    }
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
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
  // O WebView do Android às vezes entrega só o NOME do ficheiro em vez do conteúdo ("ficheiro fantasma").
  // Por isso tenta vários métodos de leitura e só aceita o que não for esse falso conteúdo.
  const isPhantom = (buf, name) => {
    try {
      const txt = decodeCsvBuffer(buf).trim();
      return txt.length > 0 && txt.length <= String(name || '').length + 4 && !/[;,\t\n]/.test(txt) && /\.(csv|txt)\]?$/i.test(txt);
    } catch { return false; }
  };
  const readFileRobust = async (file) => {
    const methods = [
      () => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsArrayBuffer(file); }),
      () => file.arrayBuffer(),
      () => new Response(file).arrayBuffer(),
      () => file.slice(0, file.size).arrayBuffer()
    ];
    let last = null;
    for (const m of methods) {
      try {
        const buf = await m();
        if (buf) last = buf;
        if (buf && buf.byteLength && !isPhantom(buf, file.name)) return buf;
      } catch (err) { /* tenta o método seguinte */ }
    }
    return last;
  };

  // Processa o conteúdo (bytes) de um CSV: lê, geocodifica e acrescenta os destinos
  const importCsvBuffer = async (buffer, fileSize) => {
    {
      try {
        // Normaliza as quebras de linha ANTES de qualquer split: \r\n e \r viram \n
        const text = decodeCsvBuffer(buffer).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
        // \r\n (Windows), \n (Linux/Android) e \r solto (Mac antigo) — todos viram quebra de linha
        // Qualquer quebra de linha: \r\n, \n, \r, e também separadores Unicode (\u2028/\u2029/\u0085) e \v/\f; remove NULs
        const lines = text.replace(/\u0000/g, '').split(/\r\n|[\r\n\u2028\u2029\u0085\u000b\u000c]/).map(l => l.trim()).filter(l => l.length > 0);

        if (lines.length === 0) {
          alert(t('csv_empty'));
          return;
        }
        // Ficheiro "fantasma": o Android entregou só o NOME do ficheiro em vez do conteúdo (partilha/cópia falhada)
        if (lines.length === 1 && !/[;,\t]/.test(lines[0]) && !/\d{3,}/.test(lines[0]) && /\.(csv|txt)\]?$/i.test(lines[0])) {
          alert(t('csv_bad', { c: lines[0], b: fileSize }));
          return;
        }

        // 1) Lê as linhas pelo NOME das colunas (a coluna ID, ordem diferente, etc. já não estragam nada)
        const delim = detectDelimiter(lines);
        const cols0 = parseCsvLine(lines[0], delim);
        const map = mapCsvColumns(cols0);
        const dataCount = lines.length - (map.legacy ? 0 : 1);
        if (dataCount <= 0) {
          alert(t('csv_empty'));
          return;
        }
        // Já há destinos? Pergunta; ao confirmar, limpa a rota anterior ANTES de carregar o ficheiro novo
        const hadStops = stops.length > 0;
        if (hadStops) {
          if (!window.confirm(t('replace_route_confirm', { n: stops.length }))) return;
          await clearRoute();
        }
        const existing = hadStops ? [] : stops; // os destinos antigos já não contam
        const rows = [];
        const defaultCity = dominantCity(existing.filter((x) => x.geo === GEO_OK)) || DEFAULT_CITY;
        // Com cabeçalho a 1ª linha é ignorada; sem cabeçalho (map.legacy) é já uma morada
        for (let i = map.legacy ? 0 : 1; i < lines.length; i++) {
          const cols = parseCsvLine(lines[i], delim);
          // Sem cabeçalho: se a 1.ª coluna parece uma morada (tem número) e a 2.ª não, o ficheiro é só "Morada[, Localidade]"
          const addrOnly = map.legacy && (cols.length === 1 || (/\d/.test(cols[0] || '') && !/\d/.test(cols[1] || '')));
          const m = addrOnly ? { address: 0, city: cols.length > 1 ? 1 : undefined } : map;
          const get = (f) => (m[f] != null ? cols[m[f]] || '' : '');
          const row = {
            client: get('client') || t('client_n', { i }),
            address: get('address'),
            postalCode: get('postal'),
            city: get('city'),
            floor: get('floor'),
            notes: get('notes'),
            group: get('group') || 'Todos'
          };
          // Sem localidade nem código postal e com a morada numa só parte ("Avenida X"): assume a localidade por defeito
          if (!row.city && !row.postalCode && row.address && !/,/.test(row.address) && defaultCity && plainText(row.address) !== plainText(defaultCity)) row.city = defaultCity;
          if (!row.address && !get('client')) continue;
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
          const refCountry = dominantCountry([...existing.filter((x) => x.geo === GEO_OK), ...newStops.filter((x) => x.geo === GEO_OK)]);
          const found = r.address ? await geocodeAddress(r.address, r.postalCode, r.city, refCountry, r.client) : null;
          if (!found) missing++;
          newStops.push({
            id: `${Date.now()}-${k}`,
            ...r,
            group: (() => {
              // 'CAES' e 'caes' são o mesmo grupo: usa o nome já existente (da lista ou de linhas anteriores)
              const g = normalizeGroup(r.group);
              const known = [...groups, ...newStops.map((x) => x.group)].find((x) => x && x !== UNNAMED_GROUP && plainText(x) === plainText(g));
              return known || g;
            })(),
            lat: found ? Number(found.lat) : null,
            lng: found ? Number(found.lon) : null,
            place: found?.place || '',
            geo: found ? (found.approx ? 'approx' : GEO_OK) : 'missing', // GEO_OK = confirmada; 'approx' = só o centro da localidade
            selected: !!found
          });
        }

        if (newStops.length > 0) {
          setStops(prev => [...prev, ...newStops]);
          newStops.forEach((st) => { cloudSaveStop(st); }); // em segundo plano; já ficam guardadas no telemóvel
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
      }
    }
  };

  // <input type="file"> (browser/PC e plano B no Android)
  const handleImportCSV = async (e) => {
    const input = e.target;
    if (!isPro) {
      setShowPaywall(true);
      input.value = '';
      return;
    }
    const file = input.files && input.files[0];
    if (!file) return;
    let buffer = null;
    try { buffer = await readFileRobust(file); } catch (err) { console.warn('Leitura do CSV:', err); }
    input.value = '';
    if (!buffer) { alert(t('import_err')); return; }
    await importCsvBuffer(buffer, file.size);
  };

  // Android (Capacitor): seletor de ficheiros nativo do sistema, que devolve o conteúdo em base64.
  // Não depende do <input type="file"> do WebView. Plugin: @capawesome/capacitor-file-picker.
  const getNativePicker = () => {
    const cap = window.Capacitor;
    return cap && cap.isNativePlatform && cap.isNativePlatform() && cap.Plugins && cap.Plugins.FilePicker;
  };
  const handleImportClick = async () => {
    if (!isPro) { setShowPaywall(true); return; }
    const picker = getNativePicker();
    if (!picker) { document.getElementById('hiddenCsvInput')?.click(); return; }
    try {
      const res = await picker.pickFiles({ limit: 1, readData: true });
      const f = res && res.files && res.files[0];
      if (!f) return;
      let buffer = null;
      if (f.data) {
        const bin = atob(f.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        buffer = bytes.buffer;
      } else if (f.blob) {
        buffer = await f.blob.arrayBuffer();
      }
      if (!buffer) { alert(t('import_err')); return; }
      await importCsvBuffer(buffer, f.size || buffer.byteLength);
    } catch (err) {
      const msg = String((err && err.message) || err || '');
      if (/cancel/i.test(msg)) return; // o utilizador fechou o seletor
      console.warn('FilePicker:', err);
      document.getElementById('hiddenCsvInput')?.click(); // plano B: seletor normal do WebView
    }
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
    orderByProximity(stops.filter((s) => s.selected && !s.done && hasCoords(s)), userPos)
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
        // Junta a nuvem com os destinos que ainda só existem no telemóvel (importados offline, por exemplo)
        setStops((prev) => {
          const ids = new Set(stopsData.map((x) => String(x.id)));
          return [...stopsData, ...prev.filter((x) => !ids.has(String(x.id)))];
        });
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
    const sel = orderByProximity(stops.filter((s) => s.selected && !s.done && hasCoords(s)), userPos);
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

    // 429 = pedidos demasiado rápidos; 5xx = serviço ocupado. Espera e repete (até 3 vezes) em vez de
    // tratar como "morada não encontrada".
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.ok) return await res.json();
      if (res.status !== 429 && res.status < 500) return null;
      await sleep(2000 * (attempt + 1));
    }
    return null;
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
  // Sem limite de distância: Lisboa -> Porto (ou qualquer destino do mundo) é sempre aceite.
  // Só a última rede de segurança (morada SEM localidade, a rua pode existir em vários países) exige que o
  // resultado esteja no mesmo PAÍS das restantes paragens (`refCountry`), para nunca saltar para o Brasil.
  const countryOf = (place) => plainText(String(place || '').split(', ').pop());
  const dominantCountry = (list) => {
    const count = {};
    list.forEach((x) => { const c = countryOf(x.place); if (c) count[c] = (count[c] || 0) + 1; });
    return Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  };
  const geocodeAddress = async (base, postalInput = '', city = '', refCountry = '', clientName = '') => {
    const attempts = []; // { q, guarded }
    const add = (q, guarded = false) => attempts.push({ q, guarded });
    if (city) {
      // A localidade vai SEMPRE no fim: é ela que filtra candidatos de outros países/cidades
      if (postalInput && !base.includes(postalInput)) add(`${base}, ${postalInput}, ${city}`);
      add(`${base}, ${city}`);
      if (postalInput) add(`${postalInput}, ${city}`);
      // Rede de segurança: o OSM nem sempre conhece a freguesia/bairro (ex.: Camarate). Tenta sem localidade.
      add(base, true);
      // Número de porta que o OSM não conhece: aceita a rua inteira
      const noNumber = base.replace(/[\s,]+\d+\s?[A-Za-z]?$/, '').trim();
      if (noNumber && noNumber !== base) add(`${noNumber}, ${city}`);
      // Local de interesse sem número (miradouro, restaurante...): tenta o nome do cliente + localidade.
      // Só se a morada não tem números e o nome não parece uma pessoa/animal ("Rex (Beagle)", "Cliente 3").
      const cn = String(clientName || '').trim();
      if (cn && !/\d/.test(base) && !/[()]/.test(cn) && !/\d/.test(cn) && plainText(cn) !== plainText(base)) add(`${cn}, ${city}`, true);
    } else {
      if (postalInput && !base.includes(postalInput)) add(`${base}, ${postalInput}`);
      add(base);
      if (postalInput) add(postalInput);
    }

    const tried = new Set();
    for (const { q, guarded } of attempts) {
      if (tried.has(q)) continue;
      tried.add(q);
      if (tried.size > 1) await sleep(1100);
      const result = await geocode(q);
      if (!result) continue;
      if (guarded && refCountry && result.place && countryOf(result.place) !== refCountry) continue;
      return result;
    }
    // Último recurso (sem morada reconhecida): centro da localidade, marcado como aproximado
    if (city) {
      await sleep(1100);
      const centre = await geocode(city);
      if (centre) return { ...centre, approx: true };
    }
    return null;
  };

  // Grava (ou atualiza) UMA paragem inteira na nuvem com o mesmo id do ecrã; falha em silêncio (modo local)
  const cloudSaveStop = async (stop) => {
    try {
      const cu = await ensureUser();
      if (cu && cu.uid !== 'local-demo-user') {
        const clean = JSON.parse(JSON.stringify(stop)); // o Firestore não aceita undefined
        await setDoc(doc(db, 'artifacts', appId, 'users', cu.uid, 'stops', String(stop.id)), clean);
      }
    } catch (err) {
      console.warn('Modo local: destino guardado só no telemóvel.', err);
    }
  };

  const emptyStopForm = () => ({ client: '', address: '', postalCode: '', city: '', floor: '', notes: '', group: normalizeGroup(selectedGroup) });

  // Preenche o formulário de topo com os dados de uma paragem (modo edição)
  const startEditStop = (s) => {
    setNewStop({
      client: s.client || '',
      address: s.address || '',
      postalCode: s.postalCode || '',
      city: s.city || '',
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
    const cityInput = (newStop.city || '').trim();

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
        !editingStop || editingStop.geo !== GEO_OK || base !== editingStop.address || postalInput !== (editingStop.postalCode || '') || cityInput !== (editingStop.city || '');

      let lat;
      let lng;
      let place = editingStop?.place || '';
      let geoState = editingStop ? editingStop.geo : GEO_OK;
      if (locationChanged) {
        // A localidade escrita entra na pesquisa (filtra candidatos de outras cidades/países)
        const result = await geocodeAddress(base, postalInput, cityInput, dominantCountry(stops.filter((x) => x.geo === GEO_OK)), clientInput);

        if (!result) {
          alert(t('not_found'));
          return;
        }
        lat = Number(result.lat);
        lng = Number(result.lon);
        place = result.place || '';
        geoState = result.approx ? 'approx' : GEO_OK;
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
        city: cityInput,
        geo: geoState
      };

      // ---- Guardar alterações de uma paragem existente ----
      if (editingStop) {
        setStops((prev) => prev.map((s) => (s.id === editingStop.id ? { ...s, ...fields } : s)));
        setEditingStopId(null);
        setNewStop(emptyStopForm());
        setIsAddFormOpen(false); // fecha o painel depois de guardar

        await cloudSaveStop({ ...editingStop, ...fields });
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
      await cloudSaveStop(newStopData);

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
    await cloudSaveStop({ ...stop, selected: !stop.selected });
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
        const found = await geocodeAddress(st.address, st.postalCode || '', st.city || '', dominantCountry(stops.filter((x) => x.geo === GEO_OK)), st.client || '');
        const patch = found
          ? { lat: Number(found.lat), lng: Number(found.lon), place: found.place || '', geo: found.approx ? 'approx' : GEO_OK, selected: st.selected || st.geo === 'missing' }
          : { lat: null, lng: null, geo: 'missing', selected: false };
        if (found) ok++;
        setStops((prev) => prev.map((x) => (x.id === st.id ? { ...x, ...patch } : x)));
        await cloudSaveStop({ ...st, ...patch });
      }
      alert(t('fix_done', { ok, f: targets.length - ok }));
    } finally {
      setGeoProgress(null);
      setLoading(false);
    }
  };

  // Recomeçar do zero: apaga destinos, destino final, rota desenhada e os dados na nuvem
  // Apaga destinos, destino final, rota desenhada e dados na nuvem (sem perguntar)
  const clearRoute = async () => {
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
    setStops([]); // garante vazio mesmo que um evento antigo da nuvem tenha chegado entretanto
  };
  const handleClearAll = async () => {
    if (!window.confirm(t('clear_confirm'))) return;
    await clearRoute();
  };

  // Cálculo da Rota OSRM (desenha a linha no mapa; os marcadores são geridos pelos efeitos 2b/2c)
  const calculateRoute = async () => {
    const selectedStops = orderByProximity(stops.filter((s) => s.selected && !s.done && hasCoords(s)), userPos);
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

  const showNum = (n) => String(n).replace('.', lang === 'en' ? '.' : ','); // 1.68 -> '1,68' (PT/ES/FR)
  const selectedCount = stops.filter(s => s.selected && !s.done).length;


  const filteredStops = selectedGroup === 'Todos' ? stops : stops.filter((s) => normalizeGroup(s.group) === selectedGroup);

  // Link global do Google Maps.
  // Com destino final definido, ele é SEMPRE o `destination` e as paragens selecionadas passam a pontos intermédios.
  // Sem destino final, mantém-se o comportamento antigo (a última paragem é o destino).
  const hasFinalDest = !!finalDest && Number.isFinite(finalDest.lat) && Number.isFinite(finalDest.lng);

  // Sequência da rota (FONTE ÚNICA): paragens selecionadas, da posição atual para a mais próxima e assim
  // sucessivamente. A lista de destinos (números 1, 2, 3…) e o link do Maps usam exactamente esta ordem.
  // O destino final (se existir) continua a ser sempre o `destination`, depois da última paragem.
  const doneList = filteredStops
    .filter((s) => s.selected && s.done)
    .sort((a, b) => (a.doneAt || 0) - (b.doneAt || 0));
  const lastDone = doneList[doneList.length - 1];
  // Os pendentes ordenam-se a partir do último destino concluído (onde o utilizador está); sem concluídos, do GPS
  const pendingSequence = orderByProximity(
    filteredStops.filter((s) => s.selected && !s.done && (s.address || hasCoords(s))),
    hasCoords(lastDone) ? lastDone : userPos
  );
  const routeSequence = [...doneList, ...pendingSequence];
  const currentStop = pendingSequence[0] || null;
  const nextStop = pendingSequence[1] || null;
  const routeNumber = {}; // id -> 1, 2, 3…
  routeSequence.forEach((s, i) => { routeNumber[s.id] = i + 1; });
  // Lista mostrada: primeiro as paragens da rota pela ordem de entrega, depois as não selecionadas
  const displayStops = [...routeSequence, ...filteredStops.filter((s) => !routeNumber[s.id])];

  // Como cada ponto vai para o Google Maps (funciona em qualquer país):
  //  1) morada + código postal + localidade/país devolvidos pelo geocodificador (sem inventar cidade)
  //  2) sem localidade guardada: coordenadas exatas (sem ambiguidade)
  //  3) sem coordenadas: só o texto da morada
  const formatAddress = (item) => {
    if (!item) return '';
    if (typeof item === 'string') return encodeURIComponent(item);
    const address = (item.address || '').trim();
    const city = (item.city || '').trim();
    if (address && city) {
      // Com localidade: morada + código postal + localidade (+ país, se vier do geocodificador) — nunca só a rua
      const seen = plainText(`${address} ${item.postalCode || ''}`);
      const extra = [];
      [city, ...(item.place || '').split(', ')].filter(Boolean).forEach((part) => {
        if (!seen.includes(plainText(part)) && !extra.some((e) => plainText(e) === plainText(part))) extra.push(part);
      });
      return encodeURIComponent([address, item.postalCode, ...extra].filter(Boolean).join(', '));
    }
    // Sem localidade: coordenadas. O geocodificador já procurou junto da posição GPS do dispositivo,
    // por isso o Maps não vai parar a outro país. Último recurso (sem coordenadas): texto + localidade/país mais comuns da rota.
    if (hasCoords(item)) return `${item.lat},${item.lng}`;
    if (!address) return '';
    const ctx = dominantPlaceText(stops.filter((x) => x.geo === GEO_OK));
    return encodeURIComponent([address, item.postalCode, ctx].filter(Boolean).join(', '));
  };


  // Devolve UM link por cada grupo de até 10 pontos. O 2.º link começa (origin) onde o 1.º acaba, para nada
  // ficar esquecido. O destino final (se existir) é sempre o último ponto do último link.
  const buildGoogleMapsUrls = (sel) => {
    const points = [...sel, ...(hasFinalDest ? [finalDest] : [])];
    if (points.length === 0) return [];

    const urls = [];
    for (let i = 0; i < points.length; i += MAPS_MAX_POINTS) {
      const chunk = points.slice(i, i + MAPS_MAX_POINTS);
      const destStr = formatAddress(chunk[chunk.length - 1]);
      if (!destStr) continue;
      const originStr = i > 0 ? formatAddress(points[i - 1]) : ''; // 1.º link parte da posição atual
      let url = `https://www.google.com/maps/dir/?api=1${originStr ? `&origin=${originStr}` : ''}&destination=${destStr}&travelmode=driving`;
      const wpStrings = chunk.slice(0, -1).map(formatAddress).filter(Boolean);
      if (wpStrings.length > 0) url += `&waypoints=${wpStrings.join('%7C')}`;
      urls.push(url);
    }
    return urls;
  };
  const googleMapsUrls = buildGoogleMapsUrls(pendingSequence); // só o que falta fazer

  // Botões "Iniciar Percurso" (1 por link) + aviso quando a rota é dividida
  const mapsButtons = (cls) => googleMapsUrls.map((url, i) => (
    <a key={i} href={url} target="_blank" rel="noopener noreferrer" className={cls}>
      <span>{t('launch_gmaps')}{googleMapsUrls.length > 1 ? ` (${i + 1}/${googleMapsUrls.length})` : ''}</span>
    </a>
  ));
  const splitNote = googleMapsUrls.length > 1 ? t('maps_split', { n: googleMapsUrls.length, max: MAPS_MAX_POINTS }) : null;

  // Abre o Google Maps com navegação direta para UM destino
  const openNavigation = (stop) => {
    if (!stop) return;
    const dest = formatAddress(stop);
    if (!dest) return;
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`, '_blank', 'noopener');
  };

  // "Concluído": marca o destino atual, o cartão passa logo ao seguinte e abre o Google Maps para a morada dele
  const completeAndNext = () => {
    if (!currentStop) return;
    const finished = { ...currentStop, done: true, doneAt: Date.now() };
    setStops((prev) => prev.map((x) => (x.id === finished.id ? finished : x)));
    cloudSaveStop(finished);
    if (nextStop) openNavigation(nextStop);
    else showToast(t('route_finished'));
  };
  const reopenStop = (stop) => {
    const reopened = { ...stop, done: false, doneAt: null };
    setStops((prev) => prev.map((x) => (x.id === stop.id ? reopened : x)));
    cloudSaveStop(reopened);
  };

  // Ficheiro modelo para preencher e importar. Android: tenta gravar mesmo em Download; se o Android não deixar,
  // abre a folha de partilha ("Guardar em Ficheiros"). Browser: download normal.
  const handleTemplateCSV = async () => {
    const content = [
      'Cliente,Morada,Codigo Postal,Localidade,Andar,Notas,Grupo',
      'Exemplo Cliente,Rua Exemplo 123,1000-001,Lisboa,1 Dto,Nota exemplo,Grupo A'
    ].join('\r\n') + '\r\n';
    const filename = 'modelo_routeflex.csv';
    const cap = window.Capacitor;
    if (cap && cap.isNativePlatform && cap.isNativePlatform()) {
      const { Filesystem, Share } = cap.Plugins || {};
      if (!Filesystem) { alert(t('export_plugin_missing')); return; }
      try {
        try { if (Filesystem.requestPermissions) await Filesystem.requestPermissions(); } catch { /* Android 11+ não pede */ }
        await Filesystem.writeFile({ path: `Download/${filename}`, data: content, directory: 'EXTERNAL_STORAGE', encoding: 'utf8', recursive: true });
        showToast(t('template_saved'));
        return;
      } catch (err) {
        console.warn('Gravar em Download falhou, a partilhar:', err);
      }
      try {
        if (!Share) { alert(t('export_plugin_missing')); return; }
        const written = await Filesystem.writeFile({ path: filename, data: content, directory: 'CACHE', encoding: 'utf8' });
        showToast(t('template_shared'));
        await Share.share({ title: filename, dialogTitle: t('template_shared'), files: [written.uri] });
      } catch (err) {
        const msg = String((err && err.message) || err || '');
        if (!/cancel/i.test(msg)) alert(`${t('buy_error')}\n\n[${msg}]`);
      }
      return;
    }
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = filename;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(t('template_saved'));
  };

  // Cartão "Destino Atual": Andar e Notas em destaque + botão para concluir e seguir
  const currentCard = currentStop ? (
    <div className="rounded-2xl border-2 border-amber-400 bg-amber-50 p-3 shadow-md space-y-2">
      <div className="flex items-center justify-between text-[10px] font-extrabold tracking-wide text-amber-700">
        <span>{t('current_dest')}</span>
        <span>{doneList.length + 1}/{routeSequence.length}</span>
      </div>
      <div className="text-lg font-extrabold text-slate-800 leading-tight break-words">{currentStop.client}</div>
      <div className="text-xs text-slate-600 break-words">
        {[currentStop.address, currentStop.postalCode, currentStop.city].filter(Boolean).join(', ')}
      </div>
      {(currentStop.floor || currentStop.notes) ? (
        <div className="space-y-1.5">
          {currentStop.floor && (
            <div className="bg-white rounded-xl border border-amber-300 px-3 py-2">
              <div className="text-[10px] font-bold uppercase text-slate-500">{t('floor_label')}</div>
              <div className="text-2xl font-black text-[#004a99] leading-tight break-words">{currentStop.floor}</div>
            </div>
          )}
          {currentStop.notes && (
            <div className="bg-white rounded-xl border border-amber-300 px-3 py-2">
              <div className="text-[10px] font-bold uppercase text-slate-500">{t('notes_label')}</div>
              <div className="text-base font-bold text-slate-800 leading-snug break-words">{currentStop.notes}</div>
            </div>
          )}
        </div>
      ) : (
        <div className="text-[11px] text-slate-400 italic">{t('no_floor_notes')}</div>
      )}
      <button
        type="button"
        onClick={completeAndNext}
        className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-sm shadow-md flex items-center justify-center gap-2 cursor-pointer"
      >
        <Check className="w-4 h-4" />{t('done_btn')}
      </button>
    </div>
  ) : null;

  // Custo da rota = distância x consumo x preço. Recalcula sozinho quando muda qualquer um dos três.
  const unitLabel = energyType === 'Elétrico' ? 'kWh' : 'L';
  const energyKey = energyType === 'Gasolina 95' ? 'Gasolina95' : energyType; // chave do dicionário
  const routeUnits = routeInfo ? (routeInfo.distanceKm * carData.consumption) / 100 : 0;
  const routeCost = routeUnits * fuelPrice;
  const approx = routeInfo?.source === 'estimativa' ? '~' : '';

  return (
    <div className="w-full h-screen min-h-screen bg-white font-sans flex flex-col overflow-hidden relative">
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
                {mapsButtons('mt-4 w-full py-3 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl font-bold text-xs flex items-center justify-center gap-2 shadow-sm transition-colors text-center block')}
                {splitNote && <p className="mt-2 text-[10px] opacity-90 leading-snug">⚠️ {splitNote}</p>}
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
{/* <span className="text-xs font-bold text-slate-700 block">Ferramentas Rápidas</span> */}                <div className="flex flex-row gap-2">
                  <button 
                    onClick={handleImportClick}
                    className="flex-1 basis-0 min-w-0 p-3 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg flex items-center justify-center gap-2 text-slate-700 transition-colors cursor-pointer"
                  >
                    <Upload className="w-4 h-4 shrink-0" />
                    <span className="text-xs font-bold">{t('import_csv')} {!isPro && '🔒'}</span>
                    <input
                      id="hiddenCsvInput"
                      type="file"
                      accept=".csv,text/csv,text/comma-separated-values,application/csv,application/vnd.ms-excel,text/plain,application/octet-stream"
                      onChange={handleImportCSV}
                      className="hidden"
                    />
                  </button>
                  <button
                    type="button"
                    onClick={handleTemplateCSV}
                    className="flex-1 basis-0 min-w-0 p-3 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg flex items-center justify-center gap-2 text-slate-700 transition-colors cursor-pointer"
                  >
                    <Download className="w-4 h-4 shrink-0" />
                    <span className="text-xs font-bold">{t('template_csv')}</span>
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
              {currentCard}
              
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
                          {groups[idx] !== UNNAMED_GROUP && (
                            <button
                              type="button"
                              onClick={() => handleDeleteGroup(idx)}
                              title={t('delete_group')}
                              aria-label={t('delete_group')}
                              className="text-red-500 font-bold text-xs px-1 cursor-pointer"
                            >
                              🗑️
                            </button>
                          )}
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

      {/* Código Postal e Localidade / Cidade */}
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
          placeholder={t('ph_city')} 
          value={newStop.city || ''}
          onChange={e => setNewStop({ ...newStop, city: e.target.value })}
          className="col-span-1 border border-slate-200 p-1.5 rounded outline-none focus:border-[#004a99]"
        />
      </div>

      {/* Andar / Fração */}
      <input 
        type="text" 
        placeholder={t('ph_floor')} 
        value={newStop.floor || ''}
        onChange={e => setNewStop({ ...newStop, floor: e.target.value })}
        autoComplete="off"
        className="w-full border border-slate-200 p-1.5 rounded outline-none focus:border-[#004a99]"
      />

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
                  {displayStops.map((s) => {
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
                          
                          {s.done && (
                            <button
                              type="button"
                              onClick={() => reopenStop(s)}
                              title={t('reopen_stop')}
                              className="shrink-0 w-5 h-5 rounded-full bg-emerald-600 text-white flex items-center justify-center mr-1 cursor-pointer"
                            >
                              <Check className="w-3 h-3" />
                            </button>
                          )}
                          {!s.done && routeNumber[s.id] && (
                            <span
                              title={t('route_order')}
                              className="shrink-0 w-5 h-5 rounded-full bg-[#2563eb] text-white text-[10px] font-bold flex items-center justify-center mr-1"
                            >
                              {routeNumber[s.id]}
                            </span>
                          )}

                          <div className="flex-1 truncate mx-1">
                            <b className={s.done ? 'text-slate-400 line-through' : 'text-[#1e293b]'}>{s.client}</b><br/>
                            <span className="text-[#64748b] text-[10px] truncate">{s.address}</span>
                          </div>

                          <span className="bg-[#e0f2fe] text-[#0369a1] px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ml-1">
                            {normalizeGroup(s.group) || t('general')}
                          </span>

                          {s.geo === 'approx' && (
                            <span title={t('geo_approx')} className="ml-1 text-[11px]">📍</span>
                          )}
                          {s.geo !== GEO_OK && s.geo !== 'approx' && (
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
                {mapsButtons('w-full mt-3 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-bold text-xs flex items-center justify-center gap-2 shadow-sm transition-colors text-center')}
                {splitNote && <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2 leading-snug">⚠️ {splitNote}</p>}
                {googleMapsUrls.length > 0 && hasFinalDest && (
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
                      type="text" 
                      inputMode="decimal"
                      value={priceDraft ?? showNum(fuelPrice)}
                      onFocus={e => { setPriceDraft(Number(fuelPrice) === 0 ? '' : showNum(fuelPrice)); e.target.select(); }}
                      onChange={e => { const raw = sanitizeDecimal(e.target.value); setPriceDraft(raw); const n = parseDecimal(raw); setFuelPrice(Number.isFinite(n) ? n : 0); }}
                      onBlur={() => setPriceDraft(null)}
                      className="w-20 border border-slate-300 rounded p-1 text-right font-bold text-[#004a99] outline-none focus:border-[#004a99]"
                    />
                  </div>

                  <div className="flex justify-between items-center">
                    <span className="text-slate-600">
                      {energyType === 'Elétrico' ? t('cons_kwh') : t('cons_l')}
                    </span>
                    <input 
                      type="text" 
                      inputMode="decimal"
                      value={consDraft ?? showNum(carData.consumption)}
                      onFocus={e => { setConsDraft(Number(carData.consumption) === 0 ? '' : showNum(carData.consumption)); e.target.select(); }}
                      onChange={e => { const raw = sanitizeDecimal(e.target.value); setConsDraft(raw); const n = parseDecimal(raw); setCarData({ ...carData, consumption: Number.isFinite(n) ? n : 0 }); }}
                      onBlur={() => setConsDraft(null)}
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
              <p className="text-center text-[9px] text-slate-300 pt-1">build {BUILD_ID}</p>
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

      {/* MODAL PAYWALL & ATIVAÇÃO DE LICENÇA */}
      {showPaywall && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-3 z-50">
          {/* dvh = altura REAL visível (descontando barras do Android); scroll interno se o ecrã for muito baixo */}
          <div className="bg-white rounded-2xl w-full max-w-sm max-h-[calc(100dvh-1.5rem)] overflow-y-auto overscroll-contain p-4 text-center shadow-2xl relative border border-slate-100 scrollbar-thin">
            
            <button 
              onClick={() => setShowPaywall(false)}
              className="absolute top-2.5 right-2.5 text-slate-400 hover:text-slate-600 font-bold p-1 text-base cursor-pointer"
            >
              ✕
            </button>

            <div className="w-9 h-9 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center mx-auto mb-1.5 text-lg">
              👑
            </div>

            <h3 className="text-lg font-bold text-slate-800 mb-0.5">{t('pw_title')}</h3>
            <p className="text-[11px] text-slate-500 mb-2.5">
              {t('pw_sub')}
            </p>

            <ul className="text-left text-[11px] text-slate-600 space-y-1 mb-3 bg-slate-50 p-2.5 rounded-xl border border-slate-100">
              <li className="flex items-center gap-1.5">
                <span className="text-emerald-500 font-bold">✓</span> {t('pw_f1')}
              </li>
              <li className="flex items-center gap-1.5">
                <span className="text-emerald-500 font-bold">✓</span> {t('pw_f2')}
              </li>
              <li className="flex items-center gap-1.5">
                <span className="text-emerald-500 font-bold">✓</span> {t('pw_f3')}
              </li>
              <li className="flex items-center gap-1.5">
                <span className="text-emerald-500 font-bold">✓</span> {t('pw_f4')}
              </li>
            </ul>

            {/* Opções de Preço */}
            <div className="space-y-2 mb-2">
              <button 
                onClick={() => handleSubscribe('monthly')}
                disabled={billingBusy}
                className="w-full disabled:opacity-60 py-2.5 px-3 rounded-xl border-2 border-[#004a99] bg-blue-50/50 hover:bg-blue-50 flex items-center justify-between font-bold text-slate-800 transition cursor-pointer"
              >
                <span className="text-xs">{t('plan_monthly')}</span>
                <span className="text-xs text-[#004a99]">{storePrices.monthly || t('price_month')} <span className="text-[9px] font-normal text-slate-500">{t('per_month')}</span></span>
              </button>

              <button 
                onClick={() => handleSubscribe('yearly')}
                disabled={billingBusy}
                className="w-full disabled:opacity-60 py-2.5 px-3 rounded-xl bg-gradient-to-r from-[#004a99] to-blue-700 text-white flex items-center justify-between font-bold shadow-md hover:opacity-95 transition relative overflow-hidden cursor-pointer"
              >
                <span className="text-xs flex items-center gap-1">
                  {t('plan_yearly')} <span className="bg-amber-400 text-slate-900 text-[8px] px-1.5 py-0.5 rounded-full font-extrabold uppercase">{t('save_badge')}</span>
                </span>
                <span className="text-xs">{storePrices.yearly || t('price_year')} <span className="text-[9px] font-normal text-blue-200">{t('per_year')}</span></span>
              </button>
            </div>

            <button
              type="button"
              onClick={handleRestore}
              disabled={billingBusy}
              className="w-full mb-1 py-1 text-[11px] font-bold text-[#004a99] underline disabled:opacity-60 cursor-pointer"
            >
              {billingBusy ? t('processing') : t('restore_purchases')}
            </button>
            <p className="text-[9px] text-slate-400 mb-2 leading-tight">{t('sub_terms')}</p>

            {/* Caixinha para o Código de Ativação */}
            <div className="pt-2 border-t border-slate-100">
              <p className="text-[10px] text-slate-500 mb-1.5 font-medium">{t('have_code')}</p>
              <div className="flex gap-1.5">
                <input 
                  type="text" 
                  placeholder={t('ph_code')}
                  value={promoCode}
                  onChange={(e) => {
                    setPromoCode(e.target.value);
                    setPromoError('');
                  }}
                  className="flex-1 px-2.5 py-1 text-xs rounded-lg border border-slate-300 focus:outline-none focus:border-[#004a99] font-mono"
                />
                <button 
                  onClick={handleApplyCode}
                  className="bg-slate-800 hover:bg-slate-900 text-white font-bold text-xs px-2.5 py-1 rounded-lg transition cursor-pointer shrink-0"
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
              className="mt-2 text-[11px] text-slate-400 hover:text-slate-600 underline font-medium cursor-pointer"
            >
              {t('continue_free')} 
            </button>

            {/* Assinatura By Bastos no fundo do Modal */}
            <div className="mt-2 pt-2 border-t border-slate-100 flex justify-center">
              <img 
                src={logoBastos} 
                alt="By BASTOS - The Heritage Software Project" 
                style={{ height: '36px', width: 'auto' }}
              />
            </div>

          </div>
        </div>
      )}

      {toastMsg && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[60] max-w-[90%] bg-slate-900/90 text-white text-xs font-bold px-4 py-2 rounded-full shadow-lg text-center">
          {toastMsg}
        </div>
      )}

    </div>
  );
}