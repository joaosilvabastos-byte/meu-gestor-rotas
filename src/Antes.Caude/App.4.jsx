import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, doc, setDoc, onSnapshot, addDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { 
  MapPin, Plus, Trash2, Navigation, Flag, Car, Fuel, 
  CheckCircle2, Circle, Map as MapIcon, Home, List, Settings, 
  Play, Filter, Upload, Route 
} from 'lucide-react';

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

const authErrorMessage = (e) => {
  const code = e?.code || '';
  if (code === 'auth/operation-not-allowed' || code === 'auth/admin-restricted-operation') {
    return 'Ative o início de sessão "Anónimo" no Firebase Console (Authentication → Sign-in method).';
  }
  if (code === 'auth/api-key-not-valid.-please-pass-a-valid-api-key.' || code === 'auth/invalid-api-key') {
    return 'Configuração Firebase inválida (chaves de demonstração). Defina as variáveis VITE_FIREBASE_* no ficheiro .env.';
  }
  if (code === 'auth/network-request-failed') {
    return 'Sem ligação à internet para autenticar. Tente novamente.';
  }
  return `Erro de autenticação${code ? ` (${code})` : ''}.`;
};

// Escapa texto do utilizador antes de o inserir em popups HTML do Leaflet
const escapeHtml = (t) =>
  String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export default function App() {
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
  const [newStop, setNewStop] = useState({ client: '', address: '', postalCode: '', floor: '', notes: '', group: 'Todos' });
  const [finalDestInput, setFinalDestInput] = useState('');
  const [energyType, setEnergyType] = useState('Gasóleo');
  const [fuelPrice, setFuelPrice] = useState(1.68);
  const [carData, setCarData] = useState({ plate: '', consumption: 6.5 });
  const [walkDrop, setWalkDrop] = useState(true);

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
      alert('🎉 Código ativado com sucesso! Bem-vindo ao Route Pro.');
    } else {
      setPromoError('Código inválido ou expirado.');
    }
  };

  // Exportar CSV (Protegido para Pro)
  const handleExportCSV = () => {
    if (!isPro) {
      setShowPaywall(true);
      return;
    }

    if (stops.length === 0) return alert("Não há destinos para exportar.");

    const headers = ["client", "address", "postalCode", "floor", "notes", "group"];
    const csvRows = [headers.join(",")];

    stops.forEach(s => {
      const row = [
        `"${(s.client || '').replace(/"/g, '""')}"`,
        `"${(s.address || '').replace(/"/g, '""')}"`,
        `"${(s.postalCode || '').replace(/"/g, '""')}"`,
        `"${(s.floor || '').replace(/"/g, '""')}"`,
        `"${(s.notes || '').replace(/"/g, '""')}"`,
        `"${(s.group || 'Todos').replace(/"/g, '""')}"`
      ];
      csvRows.push(row.join(","));
    });

    const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `destinos_routepro_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
  };

  // Importar CSV em Bloco (Protegido para Pro)
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
      const text = event.target.result;
      const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
      
      if (lines.length <= 1) return alert("O ficheiro CSV está vazio ou sem dados.");

      setLoading(true);
      try {
        const currentUser = await ensureUser();
        let guardados = 0;

        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(c => c.replace(/^"|"$/g, '').trim());
          
          const client = cols[0] || 'Sem Nome';
          const address = cols[1] || '';
          const postalCode = cols[2] || '';
          const floor = cols[3] || '';
          const notes = cols[4] || '';
          const group = cols[5] || 'Todos';

          if (!address && !client) continue;

          const query = postalCode ? `${address}, ${postalCode}` : `${address}, Portugal`;
          const result = await geocode(query) || await geocode(address);

          if (result) {
            await addDoc(collection(db, 'artifacts', appId, 'users', currentUser.uid, 'stops'), {
              client,
              address,
              postalCode,
              floor,
              notes,
              group,
              lat: Number(result.lat),
              lng: Number(result.lon),
              selected: true
            });
            guardados++;
          }
          await sleep(1100);
        }

        alert(`Importação concluída! ${guardados} destinos carregados com sucesso.`);
      } catch (err) {
        console.error("Erro na importação:", err);
        alert("Erro ao ler o ficheiro CSV.");
      } finally {
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

    const map = L.map(container, { zoomControl: false }).setView([38.7223, -9.1393], 13);
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
          L.circleMarker([p.lat, p.lng], { radius: 8, color: '#004a99', fillColor: '#0284c7', fillOpacity: 0.8 })
            .addTo(map)
            .bindPopup('Ponto de Partida (Localização Atual)');
          if (stopsLayerRef.current?.getLayers().length === 0) map.setView([p.lat, p.lng], 14);
        },
        () => {},
        { timeout: 10000 }
      );
    }

    return () => {
      cancelled = true;
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

  // 2b. Marcadores das paragens selecionadas (camada própria; não mexe na rota)
  useEffect(() => {
    const L = window.L;
    const layer = stopsLayerRef.current;
    if (!L || !layer) return;

    layer.clearLayers();
    stops
      .filter((s) => s.selected && Number.isFinite(s.lat) && Number.isFinite(s.lng))
      .forEach((s, idx) => {
        L.marker([s.lat, s.lng])
          .bindPopup(`<b>Entrega ${idx + 1}: ${escapeHtml(s.client)}</b><br/>${escapeHtml(s.address)}`)
          .addTo(layer);
      });

    needsFitRef.current = true;
    fitMap();
  }, [stops]);

  // 2c. Marcador do destino final
  useEffect(() => {
    const L = window.L;
    const layer = finalLayerRef.current;
    if (!L || !layer) return;

    layer.clearLayers();
    if (finalDest && Number.isFinite(finalDest.lat) && Number.isFinite(finalDest.lng)) {
      L.marker([finalDest.lat, finalDest.lng])
        .bindPopup(`<b>DESTINO FINAL</b><br/>${escapeHtml(finalDest.address)}`)
        .addTo(layer);
      needsFitRef.current = true;
      fitMap();
    }
  }, [finalDest]);

  // 3. Sincronização em Tempo Real com Firestore
  useEffect(() => {
    if (!user) return;

    const q = collection(db, 'artifacts', appId, 'users', user.uid, 'stops');
    const unsubscribeStops = onSnapshot(q, (snapshot) => {
      const stopsData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setStops(stopsData);
    });

    const settingsDoc = doc(db, 'artifacts', appId, 'users', user.uid, 'settings', 'main');
    const unsubscribeSettings = onSnapshot(settingsDoc, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (data.finalDest) setFinalDest(data.finalDest);
        if (data.carData) setCarData(data.carData);
        if (data.fuelPrice) setFuelPrice(data.fuelPrice);
      }
    });

    return () => {
      unsubscribeStops();
      unsubscribeSettings();
    };
  }, [user]);

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
          'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8'
        }
      });
      if (r.status < 200 || r.status >= 300) return null;
      return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    }

    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  };

  const geocodeOnce = async (q) => {
    const url =
      'https://nominatim.openstreetmap.org/search' +
      `?format=jsonv2&limit=1&accept-language=${encodeURIComponent('pt-PT,pt,en')}` +
      `&q=${encodeURIComponent(q)}`;
    try {
      const data = await nominatimGet(url);
      if (!Array.isArray(data) || data.length === 0) return null;
      const lat = parseFloat(data[0].lat);
      const lon = parseFloat(data[0].lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return { lat, lon, display: data[0].display_name || q };
    } catch (e) {
      console.error('Erro no geocode:', e);
      return null;
    }
  };

  // Tenta a string original (NFC) e, se falhar, a versão sem acentos
  const geocode = async (query) => {
    const q = (query || '').normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!q) return null;

    const variants = [q];
    const plain = stripAccents(q);
    if (plain !== q) variants.push(plain);

    for (let i = 0; i < variants.length; i++) {
      if (i > 0) await sleep(1100); // limite Nominatim: 1 pedido/s
      const r = await geocodeOnce(variants[i]);
      if (r) return r;
    }
    return null;
  };

  // Adicionar Paragem/Destino
  const handleAddStop = async () => {
    const clientInput = (newStop.client || '').trim();
    const addressInput = (newStop.address || '').trim();
    const postalInput = (newStop.postalCode || '').trim();

    // Base da pesquisa: Morada; se vazia, usa Nome/Entidade
    const base = addressInput || clientInput;
    if (!base) {
      return alert('Introduza a morada ou o nome do local.');
    }
    setLoading(true);
    try {
      // Aguarda a autenticação (em paralelo com a geocodificação); não bloqueia o utilizador
      const userPromise = ensureUser();
      userPromise.catch(() => {}); // evita "unhandled rejection"

      // Tentativa 1: string exata (+ código postal, se existir e não estiver já incluído)
      const exact =
        postalInput && !base.includes(postalInput) ? `${base}, ${postalInput}` : base;

      const attempts = [exact];
      // Tentativa 2: só código postal + país
      if (postalInput) attempts.push(`${postalInput}, Portugal`);
      // Tentativa 3: string + ", Portugal"
      attempts.push(`${base}, Portugal`);

      let result = null;
      const tried = new Set();
      for (const q of attempts) {
        if (tried.has(q)) continue;
        tried.add(q);
        if (tried.size > 1) await sleep(1100);
        result = await geocode(q);
        if (result) break;
      }

      if (!result) {
        alert('Morada não encontrada.');
        return;
      }

      // Cria a estrutura do novo destino
      const newStopData = {
        id: Date.now().toString(),
        client: clientInput || base,
        address: base,
        postalCode: postalInput,
        floor: (newStop.floor || '').trim(),
        group: newStop.group || 'Todos',
        notes: (newStop.notes || '').trim(),
        lat: Number(result.lat),
        lng: Number(result.lon),
        selected: true,
        createdAt: new Date().toISOString()
      };

      // 1. ADICIONA LOCALMENTE INSTANTANEAMENTE (a app funciona 100% sem erros)
      setStops(prev => [newStopData, ...prev]);

      // Limpa os campos do formulário
      setNewStop({ client: '', address: '', postalCode: '', floor: '', notes: '', group: groups[0] || 'Todos' });

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
      alert('Erro ao processar o destino.');
    } finally {
      setLoading(false);
    }
  };

 // Definir Ponto de Chegada (Opcional & Funcional Offline)
  const handleSetFinalDest = async () => {
    const input = finalDestInput.trim();
    if (!input) {
      setFinalDest(null);
      alert("Ponto de chegada removido (opcional).");
      return;
    }
    setLoading(true);
    try {
      // Otimização: Geocodifica a morada sem esperar por Firebase
      const result = (await geocode(input)) || (await geocode(`${input}, Portugal`));
      if (!result) {
        alert("Destino final não encontrado.");
        return;
      }
      
      const destData = {
        address: input,
        lat: Number(result.lat),
        lng: Number(result.lon)
      };
      
      setFinalDest(destData);
      alert("Ponto de chegada definido com sucesso!");
    } catch (e) {
      console.error("Erro ao definir destino final:", e);
      alert("Erro ao geocodificar o destino final.");
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

  // Cálculo da Rota OSRM (desenha apenas a linha; os marcadores são geridos pelos efeitos 2b/2c)
  const calculateRoute = async () => {
    const selectedStops = stops.filter(
      (s) => s.selected && Number.isFinite(s.lat) && Number.isFinite(s.lng)
    );
    if (selectedStops.length === 0) return alert("Selecione pelo menos uma morada para a rota.");

    // Ponto de partida flexível (GPS se existir, senão a primeira paragem)
    const startPos = userPos || { lat: selectedStops[0].lat, lng: selectedStops[0].lng };

    setActiveTab('mapa');
    setLoading(true);
    try {
      const waypoints = [startPos, ...selectedStops];
      if (finalDest) waypoints.push(finalDest);
      const coords = waypoints.map((w) => `${w.lng},${w.lat}`).join(';');

      const res = await fetch(
        `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`
      );
      if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
      const data = await res.json();

      if (data.code !== 'Ok' || !data.routes?.[0]) {
        console.error("Erro retornado pelo OSRM:", data);
        alert(`Erro OSRM: ${data.message || data.code || 'Coordenadas inválidas ou rota impossível.'}`);
        return;
      }

      const route = data.routes[0];
      const layer = routeLayerRef.current;
      if (layer && window.L) {
        layer.clearLayers();
        window.L.geoJSON(route.geometry, {
          style: { color: '#0284c7', weight: 5, opacity: 0.8 }
        }).addTo(layer);
        needsFitRef.current = true;
        fitMap();
      }

      const distKm = route.distance / 1000;
      const totalLiters = (distKm * carData.consumption) / 100;
      const totalCost = totalLiters * fuelPrice;

      setRouteInfo({
        distance: distKm.toFixed(1),
        duration: Math.round(route.duration / 60),
        cost: totalCost.toFixed(2),
        liters: totalLiters.toFixed(1)
      });
    } catch (e) {
      console.error("Erro no cálculo da rota:", e);
      alert("Erro de ligação ao serviço OSRM.");
    } finally {
      setLoading(false);
    }
  };

  const selectedCount = stops.filter(s => s.selected).length;
  const filteredStops = selectedGroup === 'Todos' ? stops : stops.filter(s => s.group === selectedGroup);

  return (
    <div className="flex justify-center items-center min-h-screen bg-[#dce4ec] p-2 font-sans">
      {/* Container Telemóvel Mobile */}
      <div className="w-[360px] h-[720px] bg-white rounded-[35px] border-[8px] border-[#1e293b] shadow-2xl overflow-hidden flex flex-col relative">
        
        {/* Status Bar */}
        <div className="bg-[#0f172a] text-white px-4 py-2 text-[11px] flex justify-between items-center">
          <span>09:41</span>
          <span>RouteFlex Pro</span>
          <span>🔋 98%</span>
        </div>

        {/* App Header */}
        <div className="bg-[#004a99] color-white text-white p-3 text-center font-bold text-sm shadow-md">
          {activeTab === 'inicio' && 'RouteFlex Pro - Início'}
          {activeTab === 'listas' && 'Gestor de Rotas & Destinos'}
          {activeTab === 'mapa' && 'Mapa Interativo'}
          {activeTab === 'custos' && 'Combustível & Definições'}
        </div>

        {/* Área de Conteúdo Dinâmico */}
        <div className="flex-1 overflow-y-auto p-3 bg-[#f8fafc]">
          
         {/* ==========================================
              PROPOSTA A: DASHBOARD CENTRAL (INÍCIO)
              ========================================== */}
          {activeTab === 'inicio' && (
            <div className="space-y-3">
              {/* Painel de Resumo Rápido */}
              <div className="bg-gradient-to-r from-[#004a99] to-[#0284c7] text-white p-4 rounded-xl shadow-sm">
                <div className="text-[11px] opacity-90 font-semibold tracking-wider uppercase">ROTA DE HOJE</div>
                <div className="text-xl font-bold my-1">{selectedCount} Destinos Selecionados</div>
                <div className="text-xs opacity-90">
                Custo Est.: <b>{routeInfo && selectedCount > 0 ? `${routeInfo.cost} €` : '0.00 €'}</b> (Gasóleo DGEG)
              </div>
              </div>

              {/* Botão de Estado / Ativação Pro no Ecrã Inicial */}
              <div>
                <button
                  onClick={() => {
                    if (!isPro) {
                      setShowPaywall(true);
                    } else {
                      alert("A sua licença Route Pro está ativa e totalmente funcional!");
                    }
                  }}
                  className={`w-full py-3 px-4 rounded-xl font-bold text-xs flex items-center justify-between shadow-sm transition cursor-pointer ${
                    isPro 
                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100' 
                      : 'bg-gradient-to-r from-amber-500 to-amber-600 text-white shadow-amber-500/20 hover:opacity-95'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-base">{isPro ? '✨' : '👑'}</span>
                    <div className="text-left">
                      <div className="font-extrabold">{isPro ? 'Route Pro Ativo' : 'Ativar Versão Pro'}</div>
                      <div className={`text-[10px] font-normal ${isPro ? 'text-emerald-600' : 'text-amber-100'}`}>
                        {isPro ? 'Sincronização e CSV desbloqueados' : 'Desbloqueie todas as funções avançadas'}
                      </div>
                    </div>
                  </div>
                  <span className={`text-xs px-2.5 py-1 rounded-lg font-bold ${isPro ? 'bg-emerald-200/60 text-emerald-800' : 'bg-white/20 text-white'}`}>
                    {isPro ? 'Ativo ✓' : 'Desbloquear ➔'}
                  </span>
                </button>
              </div>

              <div className="text-xs font-bold text-[#334155]">Menu Principal:</div>

              {/* Menu em Grelha */}
              <div className="grid grid-cols-2 gap-2.5">
                <button onClick={() => setActiveTab('listas')} className="bg-white border border-[#e2e8f0] rounded-xl p-3 text-center shadow-sm hover:border-[#004a99] transition cursor-pointer">
                  <div className="text-2xl mb-1">📍</div>
                  <div className="text-xs font-bold text-[#1e293b]">Criar Rota</div>
                </button>
                <button onClick={() => setActiveTab('listas')} className="bg-white border border-[#e2e8f0] rounded-xl p-3 text-center shadow-sm hover:border-[#004a99] transition cursor-pointer">
                  <div className="text-2xl mb-1">👥</div>
                  <div className="text-xs font-bold text-[#1e293b]">Listas / Grupos</div>
                </button>
                
                {/* Botão Importar CSV Protegido com Botão Real e Bloqueio Paywall */}
                <button 
                  onClick={() => {
                    if (!isPro) {
                      setShowPaywall(true); // Abre o modal de ativação se for Free
                    } else {
                      document.getElementById('hiddenCsvInput')?.click(); // Abre os ficheiros se for Pro
                    }
                  }}
                  className="bg-white border border-[#e2e8f0] rounded-xl p-3 text-center shadow-sm hover:border-[#004a99] transition cursor-pointer relative flex flex-col items-center justify-center"
                >
                  <div className="text-2xl mb-1">📄</div>
                  <div className="text-xs font-bold text-[#1e293b] flex items-center justify-center gap-1">
                    Importar CSV {!isPro && '🔒'}
                  </div>
                  <input
                    id="hiddenCsvInput"
                    type="file"
                    accept=".csv"
                    onChange={handleImportCSV}
                    className="hidden"
                  />
                </button>

                <button onClick={() => setActiveTab('custos')} className="bg-white border border-[#e2e8f0] rounded-xl p-3 text-center shadow-sm hover:border-[#004a99] transition cursor-pointer">
                  <div className="text-2xl mb-1">⚙️</div>
                  <div className="text-xs font-bold text-[#1e293b]">Combustível / EV</div>
                </button>
              </div>

              <button 
                onClick={calculateRoute}
                className="w-full mt-2 py-3 bg-[#10b981] hover:bg-emerald-600 text-white rounded-xl font-bold text-xs shadow-sm transition flex items-center justify-center gap-2"
              >
                🚀 Lançar GPS (Otimizar & Ver Mapa)
              </button>
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
                  <span>GRUPOS DE DESTINOS (Deslize ▶)</span>
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
                    Todos
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
                            placeholder="Nome..."
                            autoFocus
                          />
                          <button
                            onClick={() => {
                              if (editGroupValue.trim()) {
                                const newGroups = [...groups];
                                newGroups[idx] = editGroupValue.trim();
                                setGroups(newGroups);
                              }
                              setEditingGroupIdx(null);
                            }}
                            className="text-emerald-600 font-bold text-xs px-1 cursor-pointer"
                          >
                            OK
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
                          {group}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Formulário para Adicionar Destino */}
<div className="bg-white p-3 rounded-xl border border-[#e2e8f0] space-y-2 text-xs shadow-sm">
  <div className="font-bold text-[#1e293b]">Novo Destino</div>
  
  {/* Nome do Cliente */}
  <input 
    type="text" 
    placeholder="Nome / Entidade" 
    value={newStop.client}
    onChange={e => setNewStop({ ...newStop, client: e.target.value })}
    className="w-full border border-slate-200 p-1.5 rounded outline-none focus:border-[#004a99]"
  />

  {/* Morada Principal ou Local Conhecido */}
  <input 
    type="text" 
    placeholder="Morada ou local (ex: Oxford Street, London ou Eiffel Tower)" 
    value={newStop.address}
    onChange={e => setNewStop({ ...newStop, address: e.target.value })}
    className="w-full border border-slate-200 p-1.5 rounded outline-none focus:border-[#004a99]"
  />

  {/* Janela de Código Postal e Janela de Andar / Fração */}
  <div className="grid grid-cols-2 gap-2">
    <input 
      type="text" 
      placeholder="Código Postal (opcional)" 
      value={newStop.postalCode || ''}
      onChange={e => setNewStop({ ...newStop, postalCode: e.target.value })}
      className="col-span-1 border border-slate-200 p-1.5 rounded outline-none focus:border-[#004a99]"
    />
    <input 
  type="text" 
  placeholder="Andar / Fração (ex: 3º Dto)" 
  value={newStop.floor || ''}
  onChange={e => setNewStop({ ...newStop, floor: e.target.value })}
  autoComplete="off"
  className="col-span-1 border border-slate-200 p-1.5 rounded outline-none focus:border-[#004a99]"
/>
  </div>

  {/* Janela de Notas */}
  <input 
    type="text" 
    placeholder="Notas / Códigos de acesso" 
    value={newStop.notes || ''}
    onChange={e => setNewStop({ ...newStop, notes: e.target.value })}
    className="w-full border border-slate-200 p-1.5 rounded outline-none focus:border-[#004a99]"
  />

                {/* Seleção do Grupo e Botão Adicionar */}
                <div className="flex gap-2 pt-1">
                  <select 
                    value={newStop.group} 
                    onChange={e => setNewStop({ ...newStop, group: e.target.value })}
                    className="border border-slate-200 p-1.5 rounded text-xs text-slate-700 bg-white"
                  >
                    {groups.map((g, idx) => (
                      <option key={idx} value={g}>{g}</option>
                    ))}
                  </select>
                  <button 
                    onClick={handleAddStop} 
                    disabled={loading} 
                    className="flex-1 bg-[#004a99] text-white font-bold rounded py-1.5 cursor-pointer"
                  >
                    {loading ? "A pesquisar no mapa..." : "+ Adicionar Destino"}
                  </button>
                </div>
              </div>

              {/* Ponto de Chegada / Destino Final */}
              <div className="bg-white p-2.5 rounded-xl border border-[#e2e8f0] space-y-1.5 text-xs shadow-sm">
                <div className="font-bold text-red-600 flex items-center gap-1 text-[11px]">
                  <Flag className="w-3 h-3" /> Destino Final de Retorno
                </div>
                <div className="flex gap-1.5">
                  <input 
                    type="text" placeholder="Morada de retorno..." value={finalDestInput}
                    onChange={e => setFinalDestInput(e.target.value)}
                    className="flex-1 border p-1 rounded text-xs outline-none"
                  />
                  <button onClick={handleSetFinalDest} className="bg-red-500 text-white px-2.5 py-1 rounded font-bold text-xs">
                    OK
                  </button>
                </div>
                {finalDest && <p className="text-[10px] text-emerald-600 font-bold truncate">✔ {finalDest.address}</p>}
              </div>

              <div className="text-[11px] font-bold text-[#64748b]">DESTINOS SELECIONADOS PARA HOJE:</div>

              {/* Lista de Destinos Cadastrados */}
              <div className="space-y-1.5">
                {filteredStops.map(s => (
                  <div key={s.id} className="bg-white rounded-lg border border-[#e2e8f0] p-2.5 flex justify-between items-center shadow-sm text-xs">
                    <button onClick={() => toggleStopSelection(s)} className="mr-2">
                      {s.selected ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <Circle className="w-4 h-4 text-slate-300" />}
                    </button>
                    <div className="flex-1 truncate">
                      <b className="text-[#1e293b]">{s.client}</b><br/>
                      <span className="text-[#64748b] text-[10px] truncate">{s.address}</span>
                    </div>
                    <span className="bg-[#e0f2fe] text-[#0369a1] px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ml-2">
                      {s.group || 'GERAL'}
                    </span>
                    <button onClick={() => deleteStop(s.id)} className="text-slate-300 hover:text-red-500 ml-2">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ==========================================
              SEPARADOR MAPA INTERATIVO
              Sempre montado: só alterna hidden/block (nunca renderização condicional)
             ========================================== */}
          <div
            className={`${activeTab === 'mapa' ? 'block' : 'hidden'} relative z-0 h-[540px] w-full rounded-xl overflow-hidden border border-slate-200`}
          >
            <div ref={mapContainerRef} className="h-full w-full" />
          </div>

          {/* ==========================================
              SEPARADOR DEFINIÇÕES E CUSTOS
             ========================================== */}
         {/* ==========================================
              SEPARADOR DEFINIÇÕES E CUSTOS
             ========================================== */}
          {activeTab === 'custos' && (
            <div className="space-y-3 text-xs">
              <div className="bg-white p-3.5 rounded-xl border border-[#e2e8f0] space-y-3 shadow-sm">
                <div className="font-bold text-[#1e293b] border-b pb-2 flex justify-between items-center">
                  <span>Tipo de Energia / Veículo</span>
                  <span className="text-[10px] text-[#004a99] bg-blue-50 px-2 py-0.5 rounded font-normal">
                    Editável
                  </span>
                </div>

                {/* Seletor de Tipo de Energia */}
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: '⛽ Gasóleo', type: 'Gasóleo', defaultPrice: 1.68, defaultCons: 5.5 },
                    { label: '⛽ Gasolina 95', type: 'Gasolina 95', defaultPrice: 1.75, defaultCons: 6.8 },
                    { label: '🔥 GPL Auto', type: 'GPL', defaultPrice: 0.85, defaultCons: 8.0 },
                    { label: '⚡ Elétrico (EV)', type: 'Elétrico', defaultPrice: 0.22, defaultCons: 16.5 }
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
                      {energyType === 'Elétrico' ? 'Preço por kWh (€)' : 'Preço por Litro (€)'}
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
                      {energyType === 'Elétrico' ? 'Consumo (kWh/100km)' : 'Consumo (L/100km)'}
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
                    <span className="text-slate-600">Matrícula (Opcional)</span>
                    <input 
                      type="text" 
                      placeholder="AA-00-AA" 
                      value={carData.plate}
                      onChange={e => setCarData({ ...carData, plate: e.target.value })}
                      className="w-24 border border-slate-300 p-1 rounded text-center font-mono uppercase text-xs outline-none focus:border-[#004a99]"
                    />
                  </div>
                </div>

                {/* Opção Walk-Drop */}
                <div className="flex justify-between items-center pt-2 border-t border-slate-100">
                  <span className="text-slate-600">🚶 Walk-Drop (A pé até 50m)</span>
                  <input 
                    type="checkbox" 
                    checked={walkDrop} 
                    onChange={e => setWalkDrop(e.target.checked)}
                    className="w-4 h-4 text-[#004a99] rounded cursor-pointer"
                  />
                </div>
              </div>
            </div>
          )}

        </div>

       {/* Barra de Navegação Inferior (Bottom Nav) */}
        <div className="h-[60px] bg-white border-t border-[#e2e8f0] flex justify-around items-center">
          <button 
            onClick={() => setActiveTab('inicio')} 
            className={`flex flex-col items-center border-none bg-transparent cursor-pointer ${activeTab === 'inicio' ? 'text-[#004a99] font-bold' : 'text-[#64748b]'}`}
          >
            <Home className="w-5 h-5" />
            <span className="text-[10px]">Início</span>
          </button>
          
          <button 
            onClick={() => setActiveTab('listas')} 
            className={`flex flex-col items-center border-none bg-transparent cursor-pointer ${activeTab === 'listas' ? 'text-[#004a99] font-bold' : 'text-[#64748b]'}`}
          >
            <List className="w-5 h-5" />
            <span className="text-[10px]">Listas</span>
          </button>
          
          <button 
            onClick={() => setActiveTab('mapa')} 
            className={`flex flex-col items-center border-none bg-transparent cursor-pointer ${activeTab === 'mapa' ? 'text-[#004a99] font-bold' : 'text-[#64748b]'}`}
          >
            <MapIcon className="w-5 h-5" />
            <span className="text-[10px]">Mapa</span>
          </button>

          <button 
            onClick={() => setActiveTab('custos')} 
            className={`flex flex-col items-center border-none bg-transparent cursor-pointer ${activeTab === 'custos' ? 'text-[#004a99] font-bold' : 'text-[#64748b]'}`}
          >
            <Fuel className="w-5 h-5" />
            <span className="text-[10px]">Custos</span>
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

            <h3 className="text-xl font-bold text-slate-800 mb-1">Route Pro</h3>
            <p className="text-xs text-slate-500 mb-4">
              Desbloqueie a sincronização em nuvem e a importação de turmas/listas em lote.
            </p>

            <ul className="text-left text-xs text-slate-600 space-y-2 mb-6 bg-slate-50 p-3.5 rounded-xl border border-slate-100">
              <li className="flex items-center gap-2">
                <span className="text-emerald-500 font-bold">✓</span> Sincronização permanente entre Telemóvel e PC
              </li>
              <li className="flex items-center gap-2">
                <span className="text-emerald-500 font-bold">✓</span> Importação em bloco de turmas e moradas (CSV)
              </li>
              <li className="flex items-center gap-2">
                <span className="text-emerald-500 font-bold">✓</span> Exportação e Cópias de Segurança em ficheiro
              </li>
              <li className="flex items-center gap-2">
                <span className="text-emerald-500 font-bold">✓</span> Guardar destinos ilimitados na nuvem
              </li>
            </ul>

            {/* Opções de Preço */}
            <div className="space-y-2.5 mb-4">
              <button 
                onClick={() => alert("Redirecionar para Pagamento Mensal (9,99€)")}
                className="w-full py-3 px-4 rounded-xl border-2 border-[#004a99] bg-blue-50/50 hover:bg-blue-50 flex items-center justify-between font-bold text-slate-800 transition cursor-pointer"
              >
                <span className="text-xs">Plano Mensal</span>
                <span className="text-sm text-[#004a99]">9,99 € <span className="text-[10px] font-normal text-slate-500">/ mês</span></span>
              </button>

              <button 
                onClick={() => alert("Redirecionar para Pagamento Anual (99,99€)")}
                className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-[#004a99] to-blue-700 text-white flex items-center justify-between font-bold shadow-md hover:opacity-95 transition relative overflow-hidden cursor-pointer"
              >
                <span className="text-xs flex items-center gap-1">
                  Plano Anual <span className="bg-amber-400 text-slate-900 text-[9px] px-1.5 py-0.5 rounded-full font-extrabold uppercase">Poupe ~20€</span>
                </span>
                <span className="text-sm">99,99 € <span className="text-[10px] font-normal text-blue-200">/ ano</span></span>
              </button>
            </div>

            {/* Caixinha para o Código de Ativação */}
            <div className="pt-3 border-t border-slate-100">
              <p className="text-[11px] text-slate-500 mb-2 font-medium">Tem um código de ativação ou licença?</p>
              <div className="flex gap-2">
                <input 
                  type="text" 
                  placeholder="Insira o código"
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
                  Ativar
                </button>
              </div>
              {promoError && (
                <p className="text-[10px] text-red-500 mt-1 text-left font-medium">{promoError}</p>
              )}
            </div>

            <button 
              onClick={() => setShowPaywall(false)}
              className="mt-4 text-xs text-slate-400 hover:text-slate-600 underline font-medium cursor-pointer"
            >
              Continuar no plano gratuito local
            </button>

          </div>
        </div>
      )}

    </div>
  );
}