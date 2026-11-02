import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, doc, setDoc, onSnapshot, addDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { 
  MapPin, Plus, Trash2, Navigation, Flag, Car, Fuel, 
  CheckCircle2, Circle, Map as MapIcon, Home, List, Settings, 
  Play, Filter, Upload, Route 
} from 'lucide-react';

// Configuração Firebase (usar variáveis de ambiente ou o padrão injetado)
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {
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

 // Formulários e Configurações
  // Formulários e Configurações
  const [newStop, setNewStop] = useState({ client: '', address: '', floor: '', notes: '', group: 'Todos' });
  const [finalDestInput, setFinalDestInput] = useState('');
  const [energyType, setEnergyType] = useState('Gasóleo');
  const [fuelPrice, setFuelPrice] = useState(1.68);
  const [carData, setCarData] = useState({ plate: '', consumption: 6.5 });
  const [walkDrop, setWalkDrop] = useState(true);

  // 5 Pílulas Iniciais com o texto 'Editar ✏️'
  const [groups, setGroups] = useState(['Editar ✏️', 'Editar ✏️', 'Editar ✏️', 'Editar ✏️', 'Editar ✏️']);
  const [editingGroupIdx, setEditingGroupIdx] = useState(null);
  const [editGroupValue, setEditGroupValue] = useState('');

  // Referências do Mapa Leaflet
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const markersRef = useRef([]);
  const routeLayerRef = useRef(null);

  // 1. Autenticação Anónima
  useEffect(() => {
    const initAuth = async () => {
      try { await signInAnonymously(auth); } catch (e) { console.error(e); }
    };
    initAuth();
    return onAuthStateChanged(auth, setUser);
  }, []);

  // 2. Inicialização do Mapa Leaflet quando no separador 'mapa'
  useEffect(() => {
    if (activeTab === 'mapa' && mapRef.current && !mapInstance.current && window.L) {
      mapInstance.current = window.L.map(mapRef.current, { zoomControl: false }).setView([38.7223, -9.1393], 13);
      
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap'
      }).addTo(mapInstance.current);

      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition((pos) => {
          const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          setUserPos(p);
          if (mapInstance.current) {
            mapInstance.current.setView([p.lat, p.lng], 14);
            window.L.circleMarker([p.lat, p.lng], { radius: 8, color: '#004a99', fillColor: '#0284c7', fillOpacity: 0.8 })
              .addTo(mapInstance.current)
              .bindPopup("Ponto de Partida (Localização Atual)");
          }
        });
      }
    }
  }, [activeTab]);

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

 // Pesquisa de Morada Global (Geocoding - Nominatim)
// Pesquisa de Morada Global (Geocoding - Nominatim)
const geocode = async (query) => {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`;
    const res = await fetch(url, {
      headers: {
        'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8',
        'User-Agent': 'GestorRotasApp/1.0'
      }
    });

   if (!res.ok) return null;

    const data = await res.json();
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
  } catch (e) {
    console.error("Erro no geocode:", e);
    return null;
  }
};

  // Adicionar Paragem/Destino
 const handleAddStop = async () => {
    if (!newStop.address || !newStop.address.trim()) {
      return alert("Por favor, introduza a morada.");
    }

    setLoading(true);

    const addressInput = newStop.address.trim();
    const postalInput = newStop.postalCode ? newStop.postalCode.trim() : '';

    // 1. Monta a pesquisa simples
    let searchQuery = addressInput;
    if (postalInput && !addressInput.includes(postalInput)) {
      searchQuery = `${addressInput}, ${postalInput}`;
    }

    // 2. Executa a geocodificação
    let result = await geocode(searchQuery);

    // 3. Fallback: se falhar e tiver código postal, pesquisa pelo CP
    if ((!result || !result.lat) && postalInput) {
      result = await geocode(`${postalInput}, Portugal`);
    }

    // 4. Validação rigorosa do result
    if (result && result.lat && result.lon && user) {
      await addDoc(collection(db, 'artifacts', appId, 'users', user.uid, 'stops'), {
        client: newStop.client.trim() || addressInput,
        address: addressInput,
        postalCode: postalInput,
        floor: newStop.floor || '',
        group: newStop.group || 'Todos',
        notes: newStop.notes || '',
        lat: parseFloat(result.lat),
        lng: parseFloat(result.lon),
        selected: true
      });

      setNewStop({ client: '', address: '', postalCode: '', floor: '', notes: '', group: groups[0] || 'Todos' });
    } else {
      alert("Morada não encontrada.");
    }

    setLoading(false);
  };

  // Definir Ponto de Chegada
  const handleSetFinalDest = async () => {
    if (!finalDestInput) return;
    setLoading(true);
    const result = await geocode(finalDestInput);
    if (result && user) {
      const dest = {
        address: finalDestInput,
        lat: parseFloat(result.lat),
        lng: parseFloat(result.lon)
      };
      await setDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'settings', 'main'), {
        finalDest: dest, carData, fuelPrice
      }, { merge: true });
      setFinalDest(dest);
      setFinalDestInput('');
    } else {
      alert("Destino final não encontrado.");
    }
    setLoading(false);
  };

  // Selecionar/Desselecionar Paragem
  const toggleStopSelection = async (stop) => {
    if (!user) return;
    const stopRef = doc(db, 'artifacts', appId, 'users', user.uid, 'stops', stop.id);
    await updateDoc(stopRef, { selected: !stop.selected });
  };

  // Remover Paragem
  const deleteStop = async (id) => {
    if (!user) return;
    await deleteDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'stops', id));
  };

  // Cálculo da Rota OSRM e Gestão de Marcadores
  const calculateRoute = async () => {
    const selectedStops = stops.filter(s => s.selected);
    if (!finalDest) return alert("Por favor, defina o Ponto de Chegada.");
    if (selectedStops.length === 0) return alert("Selecione pelo menos uma morada para a rota.");
    if (!userPos) return alert("Aguarde pela deteção da localização GPS.");

    setLoading(true);
    setActiveTab('mapa');

    setTimeout(async () => {
      if (mapInstance.current && window.L) {
        // Limpar marcadores anteriores
        markersRef.current.forEach(m => mapInstance.current.removeLayer(m));
        if (routeLayerRef.current) mapInstance.current.removeLayer(routeLayerRef.current);

        const waypoints = [userPos, ...selectedStops, finalDest];
        const coords = waypoints.map(w => `${w.lng},${w.lat}`).join(';');

        try {
          const res = await fetch(`https://router.projectosrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`);
          const data = await res.json();

          if (data.routes && data.routes[0]) {
            const route = data.routes[0];
            routeLayerRef.current = window.L.geoJSON(route.geometry, {
              style: { color: '#0284c7', weight: 5, opacity: 0.8 }
            }).addTo(mapInstance.current);

            selectedStops.forEach((s, idx) => {
              const marker = window.L.marker([s.lat, s.lng]).addTo(mapInstance.current)
                .bindPopup(`<b>Entrega ${idx + 1}: ${s.client}</b><br/>${s.address}`);
              markersRef.current.push(marker);
            });

            const fMarker = window.L.marker([finalDest.lat, finalDest.lng]).addTo(mapInstance.current)
              .bindPopup(`<b>DESTINO FINAL</b><br/>${finalDest.address}`);
            markersRef.current.push(fMarker);

            const distKm = route.distance / 1000;
            const totalLiters = (distKm * carData.consumption) / 100;
            const totalCost = totalLiters * fuelPrice;

            setRouteInfo({
              distance: distKm.toFixed(1),
              duration: Math.round(route.duration / 60),
              cost: totalCost.toFixed(2),
              liters: totalLiters.toFixed(1)
            });

            mapInstance.current.fitBounds(routeLayerRef.current.getBounds(), { padding: [30, 30] });
          }
        } catch (e) {
          alert("Erro ao traçar rota OSRM.");
        }
      }
      setLoading(false);
    }, 300);
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

              <div className="text-xs font-bold text-[#334155]">Menu Principal:</div>

              {/* Menu em Grelha */}
              <div className="grid grid-cols-2 gap-2.5">
                <button onClick={() => setActiveTab('listas')} className="bg-white border border-[#e2e8f0] rounded-xl p-3 text-center shadow-sm hover:border-[#004a99] transition">
                  <div className="text-2xl mb-1">📍</div>
                  <div className="text-xs font-bold text-[#1e293b]">Criar Rota</div>
                </button>
                <button onClick={() => setActiveTab('listas')} className="bg-white border border-[#e2e8f0] rounded-xl p-3 text-center shadow-sm hover:border-[#004a99] transition">
                  <div className="text-2xl mb-1">👥</div>
                  <div className="text-xs font-bold text-[#1e293b]">Listas / Grupos</div>
                </button>
                <button onClick={() => alert("Importação CSV pronta na versão Web.")} className="bg-white border border-[#e2e8f0] rounded-xl p-3 text-center shadow-sm hover:border-[#004a99] transition">
                  <div className="text-2xl mb-1">📄</div>
                  <div className="text-xs font-bold text-[#1e293b]">Importar CSV</div>
                </button>
                <button onClick={() => setActiveTab('custos')} className="bg-white border border-[#e2e8f0] rounded-xl p-3 text-center shadow-sm hover:border-[#004a99] transition">
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

              {/* Formulário para Adicionar Destino */}
              <div className="bg-white p-3 rounded-xl border border-[#e2e8f0] space-y-2 text-xs shadow-sm">
                <div className="font-bold text-[#1e293b]">Novo Destino</div>
                <input 
                  type="text" placeholder="Nome / Entidade" value={newStop.client}
                  onChange={e => setNewStop({ ...newStop, client: e.target.value })}
                  className="w-full border border-slate-200 p-1.5 rounded outline-none focus:border-[#004a99]"
                />
                <input 
  type="text" 
  placeholder="Morada ou local (ex: Oxford Street, London ou Eiffel Tower)" 
  value={newStop.address}
  onChange={e => setNewStop({ ...newStop, address: e.target.value })}
  className="w-full border border-slate-200 p-1.5 rounded outline-none focus:border-[#004a99]"
/>
                <div className="flex gap-2">
                  <select 
                    value={newStop.group} onChange={e => setNewStop({ ...newStop, group: e.target.value })}
                    className="border border-slate-200 p-1.5 rounded text-xs text-slate-700 bg-white"
                  >
                    {groups.map((g, idx) => (
                      <option key={idx} value={g}>{g}</option>
                    ))}
                  </select>
                  <button onClick={handleAddStop} disabled={loading} className="flex-1 bg-[#004a99] text-white font-bold rounded py-1.5 cursor-pointer">
                    {loading ? "..." : "+ Adicionar"}
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
             ========================================== */}
          {activeTab === 'mapa' && (
  <div className="h-[calc(100vh-140px)] w-full rounded-xl overflow-hidden border border-slate-200">
    {stops.filter(s => s.selected && s.lat && s.lng).length === 0 ? (
      <div className="flex h-full items-center justify-center text-xs text-slate-500 font-medium p-4 text-center">
        Nenhum destino selecionado com localização no mapa. Adiciona ou seleciona um destino na lista.
      </div>
    ) : (
      /* Aqui fica o teu componente de Mapa (ex: MapContainer ou iframe) */
      <MapComponent stops={stops.filter(s => s.selected)} />
    )}
  </div>
)}

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
    </div>
  );
}