import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  MapContainer, 
  TileLayer, 
  Marker, 
  Popup, 
  Circle, 
  Polyline,
  CircleMarker, 
  useMap 
} from 'react-leaflet';
import L from 'leaflet';
import { db, ref, onValue, set, push } from './firebase';

// =========================================================
// 1. CSS OVERRIDES & PERFORMANCE CONSTANTS
// =========================================================
const leafletDarkStyles = `
  .custom-dark-popup .leaflet-popup-content-wrapper,
  .custom-dark-popup .leaflet-popup-tip { background: #020617 !important; border: 1px solid #1e293b !important; box-shadow: 0 10px 40px -10px rgba(0,0,0,0.8) !important; color: #f8fafc !important; }
  .custom-dark-popup .leaflet-popup-tip { border-top: none !important; border-left: none !important; }
  .custom-dark-popup .leaflet-popup-content { margin: 0 !important; width: auto !important; }
  .custom-dark-popup a.leaflet-popup-close-button { color: #64748b !important; padding: 8px 8px 0 0 !important; font-size: 16px !important; font-weight: bold !important; }
  .custom-dark-popup a.leaflet-popup-close-button:hover { color: #f8fafc !important; background: transparent !important; }
  
  @keyframes pulse-red { 0% { fill-opacity: 0.1; stroke-opacity: 0.5; stroke-width: 1; } 50% { fill-opacity: 0.4; stroke-opacity: 1; stroke-width: 3; } 100% { fill-opacity: 0.1; stroke-opacity: 0.5; stroke-width: 1; } }
  .blindspot-zone path { animation: pulse-red 2s infinite ease-in-out; }
  
  /* Custom scrollbar for modals */
  .custom-scrollbar::-webkit-scrollbar { width: 4px; }
  .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
  .custom-scrollbar::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
  .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #475569; }
`;

const PATH_OPTIONS = {
  live: { color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.1, weight: 1 },
  alert: { color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 0.25, weight: 2 },
  offline: { color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.1, weight: 1 },
  trajLine: { color: '#6366f1', weight: 4, opacity: 0.9, dashArray: '8, 12', lineCap: 'round', lineJoin: 'round' },
  trajPoint: { color: '#6366f1', fillColor: '#818cf8', fillOpacity: 1, weight: 3 },
  zoneCovered: { color: '#facc15', fillColor: '#facc15', fillOpacity: 0.2, weight: 1 },
  zoneBlind: { color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.4, weight: 1, className: 'blindspot-zone' }
};

const createIcon = (color) => new L.Icon({
  iconUrl: `https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-${color}.png`,
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
  iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41]
});

const icons = { 
  live: createIcon('green'), 
  offline: createIcon('red'), 
  alert: createIcon('orange'),
  decommissioned: createIcon('black')
};

const PRIORITY_ZONES = [
  { id: 'pz1', name: 'Ashram Road Junction', lat: 23.035, lng: 72.571, radius: 250 },
  { id: 'pz2', name: 'Subhash Bridge Corridor', lat: 23.0645, lng: 72.5831, radius: 300 },
  { id: 'pz3', name: 'Paldi Underpass', lat: 23.0120, lng: 72.5714, radius: 200 },
];

function MapRecenter({ coords }) {
  const map = useMap();
  useEffect(() => { if (coords) map.flyTo(coords, 14, { duration: 0.35, easeLinearity: 0.25 }); }, [coords, map]);
  return null;
}

// =========================================================
// 2. REUSABLE MODAL COMPONENT
// =========================================================
const ModalWrapper = ({ isOpen, onClose, title, icon, colorClass, children, maxWidth = "max-w-md" }) => {
  if (!isOpen) return null;
  return (
    <div className="absolute inset-0 z-[2000] bg-black/75 backdrop-blur-md flex items-center justify-center p-6">
      <div className={`bg-slate-950 border border-slate-800 rounded-2xl w-full ${maxWidth} shadow-2xl overflow-hidden flex flex-col max-h-[85vh]`}>
        <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-900">
          <h2 className={`text-xs font-black ${colorClass} flex items-center gap-2 uppercase tracking-widest`}>
            <span className="text-base">{icon}</span> {title}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white font-bold transition-colors">✕</button>
        </div>
        <div className="p-5 overflow-y-auto custom-scrollbar">{children}</div>
      </div>
    </div>
  );
};

// =========================================================
// 3. LOW-LATENCY WEBRTC (WHEP) PLAYER
// =========================================================
function LiveVideoPlayer({ camId }) {
  const videoRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [streamError, setStreamError] = useState(false);
  const [errorType, setErrorType] = useState(null);

  useEffect(() => {
    let isMounted = true;
    let pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    
    setLoading(true); setStreamError(false); setErrorType(null);

    const timeoutMonitor = setTimeout(() => {
      if (isMounted && loading) { setLoading(false); setErrorType('502'); }
    }, 10000); 

    const startStream = async () => {
      try {
        const streamId = camId.toLowerCase().trim();
        const whepUrl = `http://103.250.160.189:8889/stream/${streamId}/whep`;

        pc.addTransceiver('video', { direction: 'recvonly' });

        pc.ontrack = (event) => {
          if (videoRef.current && isMounted) {
            videoRef.current.srcObject = event.streams[0];
            setLoading(false);
            clearTimeout(timeoutMonitor);
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const response = await fetch(whepUrl, {
          method: 'POST', body: offer.sdp,
          headers: { 'Content-Type': 'application/sdp', 'Authorization': `Basic ${btoa('raj.vignesh2000@gmail.com:TG69-CVYY-GTHN')}` }
        });

        if (!response.ok) throw new Error("WHEP Failed");
        const answerSdp = await response.text();
        if (isMounted) await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      } catch (err) {
        if (isMounted) { 
          setLoading(false); 
          clearTimeout(timeoutMonitor); 
          setErrorType('502'); 
        }
      }
    };

    startStream();
    return () => { isMounted = false; clearTimeout(timeoutMonitor); pc.close(); };
  }, [camId]);

  if (errorType === '502') {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-rose-950/30 text-slate-400 p-2">
        <span className="text-xl mb-1">⚠️</span>
        <span className="text-[10px] font-mono text-center text-rose-400 font-bold uppercase tracking-widest">502 Bad Gateway</span>
        <span className="text-[9px] text-slate-500 text-center mt-0.5">Stream host unreachable</span>
      </div>
    );
  }

  if (streamError) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center bg-slate-950 text-slate-400 p-2">
        <span className="text-xl mb-1">⚠️</span>
        <span className="text-[10px] font-mono text-center text-amber-400 font-bold uppercase tracking-widest">WHEP Negotiation Failed</span>
      </div>
    );
  }

  return (
    <div className="w-full h-full bg-black flex items-center justify-center relative">
      {loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/80 z-10">
          <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mb-1"></div>
          <span className="text-[9px] font-mono text-slate-300 tracking-wider">CONNECTING WHEP FEED...</span>
        </div>
      )}
      <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
    </div>
  );
}

// =========================================================
// 4. MAIN SENTINEL DASHBOARD COMPONENT
// =========================================================
export default function SentinelDashboard({ userRole = 'admin', userDept = 'ALL', onLogout }) {
  const [isGlobalLoading, setIsGlobalLoading] = useState(true);

  // STARTING EMPTY - No hardcoded cameras
  const [cameras, setCameras] = useState([]);
  const [selectedCam, setSelectedCam] = useState(null);
  
  // Debounced Search Setup
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  
  useEffect(() => {
    const t = setTimeout(() => setSearchTerm(searchInput), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const [recentAlerts, setRecentAlerts] = useState([]);
  const [allTransits, setAllTransits] = useState([]);

  // Modals & Tools State
  const [isWatchlistModalOpen, setIsWatchlistModalOpen] = useState(false);
  const [isOnboardModalOpen, setIsOnboardModalOpen] = useState(false);
  const [isTrajectoryModalOpen, setIsTrajectoryModalOpen] = useState(false);
  const [isGapAnalysisModalOpen, setIsGapAnalysisModalOpen] = useState(false);
  const [isHealthModalOpen, setIsHealthModalOpen] = useState(false);
  const [isAnprModalOpen, setIsAnprModalOpen] = useState(false);
  
  const [showTacticalGaps, setShowTacticalGaps] = useState(false);
  const [selectedTrajectoryPlate, setSelectedTrajectoryPlate] = useState(null);
  const [selectedAlertImage, setSelectedAlertImage] = useState(null);
  const [isEnhanced, setIsEnhanced] = useState(false);

  const [newWatchlist, setNewWatchlist] = useState({ plate: '', reason: 'Stolen Vehicle', priority: 'CRITICAL', dept: 'Statewide' });
  const [newCam, setNewCam] = useState({ id: '', name: '', lat: '', lng: '', dept: '' });
  const fileInputRef = useRef(null);

  // Initial Boot: Pull purely from Firebase Registry
  useEffect(() => {
    const registryRef = ref(db, 'registry');
    onValue(registryRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        const fbCams = Object.values(data).map((cam, i) => ({
          ...cam,
          installYear: cam.installYear || (2017 + (i % 6)),
          uptime: cam.uptime || (cam.status === 'offline' ? '82.4' : '99.1')
        }));
        setCameras(fbCams);
      } else {
        setCameras([]);
      }
      setIsGlobalLoading(false);
    }, { onlyOnce: true });
  }, []);

  // Firebase Realtime Listeners
  useEffect(() => {
    const alertsRef = ref(db, 'alerts');
    const unsubAlerts = onValue(alertsRef, (snapshot) => {
      const data = snapshot.val();
      if (!data) return;
      const alertList = Object.entries(data).map(([key, val]) => ({ id: key, ...val }));
      alertList.reverse();
      setRecentAlerts(alertList.slice(0, 10));

      const latest = alertList[0];
      if (latest && latest.camera_id) {
        setCameras((prevCams) => prevCams.map((cam) =>
          cam.id.toLowerCase() === latest.camera_id.toLowerCase() && cam.status !== 'decommissioned'
            ? { ...cam, status: 'alert', lastAlert: latest }
            : cam
        ));
      }
    });

    const transitsRef = ref(db, 'transits');
    const unsubTransits = onValue(transitsRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        const list = Object.values(data);
        list.sort((a, b) => new Date(b.timestamp_utc) - new Date(a.timestamp_utc));
        setAllTransits(list);
      }
    });

    return () => { unsubAlerts(); unsubTransits(); };
  }, []);

  // Safe Filtering
  const filteredCameras = useMemo(() => {
    return cameras.filter((cam) =>
      cam.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      cam.id?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      cam.dept?.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [cameras, searchTerm]);

  // Dynamic Gap & Coverage Math
  const coverageData = useMemo(() => {
    const activeCams = cameras.filter(c => c.status === 'live' || c.status === 'alert');
    const zones = PRIORITY_ZONES.map(zone => {
      const isCovered = activeCams.some(cam => {
        if (!cam.lat || !cam.lng) return false;
        return L.latLng(zone.lat, zone.lng).distanceTo(L.latLng(cam.lat, cam.lng)) <= 500;
      });
      return { ...zone, isCovered };
    });
    return { zones, blindspotCount: zones.filter(z => !z.isCovered).length, total: zones.length };
  }, [cameras]);

  // Dynamic Trajectory Plotting Math
  const currentTrajectoryPoints = useMemo(() => {
    if (!selectedTrajectoryPlate) return [];
    const hits = [...recentAlerts, ...allTransits].filter(
      item => item.plate_number?.toUpperCase() === selectedTrajectoryPlate.toUpperCase()
    );
    hits.sort((a, b) => new Date(a.timestamp_utc) - new Date(b.timestamp_utc));
    return hits.map(hit => {
      const matchedCam = cameras.find(c => c.id.toLowerCase() === hit.camera_id?.toLowerCase());
      return matchedCam && matchedCam.lat && matchedCam.lng ? [matchedCam.lat, matchedCam.lng] : null;
    }).filter(Boolean);
  }, [selectedTrajectoryPlate, recentAlerts, allTransits, cameras]);

  // =====================================================
  // ACTION HANDLERS
  // =====================================================

  const handleWipeDatabase = async () => {
    if (!window.confirm("CRITICAL WARNING: This will permanently vaporize ALL data (alerts, transits, registry, watchlist) from Firebase. Proceed?")) return;
    if (!window.confirm("Are you ABSOLUTELY sure? There is no undo.")) return;
    
    try {
      await set(ref(db, '/'), null); 
      setCameras([]);
      setRecentAlerts([]);
      setAllTransits([]);
      alert("Database completely wiped. You have a fresh slate.");
    } catch (error) {
      alert("Error wiping database: " + error.message);
    }
  };

  const handleDecommission = async (camId) => {
    if(!window.confirm(`WARNING: Decommissioning node ${camId.toUpperCase()} will sever its feed and remove its radius. Proceed?`)) return;
    setCameras(prev => prev.map(c => c.id === camId ? { ...c, status: 'decommissioned', uptime: '0.0' } : c));
    setSelectedCam(null);
    setIsHealthModalOpen(false);
    await set(ref(db, `registry/${camId}/status`), 'decommissioned');
  };

  const handleManualSubmit = async (e) => {
    e.preventDefault();
    if (!newCam.id || !newCam.lat || !newCam.lng) return;
    const camData = {
      id: newCam.id.toLowerCase().trim(), name: newCam.name.trim() || 'Monitored Node',
      lat: parseFloat(newCam.lat), lng: parseFloat(newCam.lng), dept: newCam.dept.trim() || 'Command Center',
      status: 'live', installYear: 2024, uptime: '100.0'
    };
    
    setCameras(prev => {
      const map = new Map(prev.map(c => [c.id, c]));
      map.set(camData.id, camData);
      return Array.from(map.values());
    });
    
    await set(ref(db, `registry/${camData.id}`), camData);
    setNewCam({ id: '', name: '', lat: '', lng: '', dept: '' });
    setIsOnboardModalOpen(false);
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      const rows = event.target.result.split('\n').slice(1);
      const newCams = [];
      for (let row of rows) {
        if (!row.trim()) continue;
        const [id, name, lat, lng, dept] = row.split(',');
        if (id && lat && lng) {
          const camObj = {
            id: id.trim().toLowerCase(), name: name ? name.trim() : 'Node', lat: parseFloat(lat.trim()), lng: parseFloat(lng.trim()),
            dept: dept ? dept.trim() : 'City Command', status: 'live', installYear: 2023, uptime: '99.0'
          };
          newCams.push(camObj);
          await set(ref(db, `registry/${camObj.id}`), camObj);
        }
      }
      
      setCameras(prev => {
        const map = new Map(prev.map(c => [c.id, c]));
        newCams.forEach(c => map.set(c.id, c));
        return Array.from(map.values());
      });
      
      alert('CSV Bulk Import Successful. Duplicates Overwritten.');
      if (fileInputRef.current) fileInputRef.current.value = '';
    };
    reader.readAsText(file);
  };

  const handleDeployWatchlist = async (e) => {
    e.preventDefault();
    if (!newWatchlist.plate.trim()) return;
    const payload = {
      plate: newWatchlist.plate.toUpperCase().trim(),
      reason: newWatchlist.reason,
      priority: newWatchlist.priority,
      deployed_by: userDept,
      timestamp_utc: new Date().toISOString()
    };
    await push(ref(db, 'watchlist'), payload);
    alert(`Target Plate ${payload.plate} committed to Statewide Mesh.`);
    setNewWatchlist({ plate: '', reason: 'Stolen Vehicle', priority: 'CRITICAL', dept: 'Statewide' });
    setIsWatchlistModalOpen(false);
  };

  // =====================================================
  // MEMOIZED MAP RENDERER (Zero Lag)
  // =====================================================
  const memoizedMapElements = useMemo(() => {
    return (
      <>
        {selectedCam && <MapRecenter coords={[selectedCam.lat, selectedCam.lng]} />}

        {currentTrajectoryPoints.map((pt, i) => (
          <CircleMarker key={`traj-${i}`} center={pt} radius={8} pathOptions={PATH_OPTIONS.trajPoint} />
        ))}

        {currentTrajectoryPoints.length > 1 && (
          <Polyline positions={currentTrajectoryPoints} pathOptions={PATH_OPTIONS.trajLine} />
        )}

        {showTacticalGaps && coverageData.zones.map(zone => (
          <Circle key={zone.id} center={[zone.lat, zone.lng]} radius={zone.radius} pathOptions={zone.isCovered ? PATH_OPTIONS.zoneCovered : PATH_OPTIONS.zoneBlind} />
        ))}

        {cameras.map((cam) => {
          const isAlert = cam.status === 'alert';
          const isLive = cam.status === 'live';
          const isDecommissioned = cam.status === 'decommissioned';

          return (
            <React.Fragment key={cam.id}>
              <Marker position={[cam.lat, cam.lng]} icon={icons[cam.status] || icons.live} eventHandlers={{ click: () => setSelectedCam(cam) }}>
                <Popup className="custom-dark-popup">
                  <div className="p-2 text-slate-100 w-72 bg-slate-950 rounded-lg">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] font-mono font-bold text-slate-400 uppercase">{cam.id}</span>
                      <span className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded ${
                        isDecommissioned ? 'bg-slate-800 text-slate-400' : isAlert ? 'bg-amber-500/20 text-amber-400' : isLive ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'
                      }`}>
                        {cam.status}
                      </span>
                    </div>
                    <h4 className="font-extrabold text-sm text-white leading-tight mb-0.5">{cam.name}</h4>
                    <p className="text-[11px] text-slate-400 mb-2">{cam.dept}</p>
                    
                    <div className="w-full h-40 bg-black rounded-lg overflow-hidden relative shadow-md mb-2">
                      {isDecommissioned ? (
                        <div className="w-full h-full flex flex-col items-center justify-center text-slate-500">
                          <span className="text-xl mb-1">☠️</span>
                          <span className="text-xs font-bold text-slate-400">Node Decommissioned</span>
                        </div>
                      ) : isLive || isAlert ? (
                        <>
                          <LiveVideoPlayer camId={cam.id} />
                          <div className="absolute top-2 right-2 flex items-center gap-1.5 bg-black/70 px-2 py-0.5 rounded backdrop-blur z-20">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                            <span className="text-[9px] font-mono font-bold text-slate-200">WHEP LIVE</span>
                          </div>
                        </>
                      ) : (
                        <div className="w-full h-full flex flex-col items-center justify-center text-slate-500">
                          <span className="text-xl mb-1">🔌</span>
                          <span className="text-xs font-bold text-rose-500">Camera Offline</span>
                        </div>
                      )}
                    </div>

                    <div className="flex gap-1.5">
                      <button 
                        onClick={() => window.open(`/?analytics=${cam.id}`, '_blank')}
                        className="flex-1 py-1.5 bg-blue-600/20 hover:bg-blue-600 border border-blue-500 text-blue-400 hover:text-white rounded-lg text-[10px] font-bold transition-colors flex justify-center items-center gap-1"
                      >
                        <span>⤢</span> Analytics
                      </button>
                      {!isDecommissioned && (
                        <button 
                          onClick={() => handleDecommission(cam.id)}
                          className="py-1.5 px-2 bg-rose-600/20 hover:bg-rose-600 border border-rose-500 text-rose-400 hover:text-white rounded-lg text-[10px] font-bold transition-colors"
                        >
                          Decommission
                        </button>
                      )}
                    </div>
                  </div>
                </Popup>
              </Marker>

              {!isDecommissioned && (
                <Circle 
                  center={[cam.lat, cam.lng]} 
                  radius={500} 
                  pathOptions={{ 
                    color: isAlert ? '#f59e0b' : isLive ? '#3b82f6' : '#ef4444', 
                    fillColor: isAlert ? '#f59e0b' : isLive ? '#3b82f6' : '#ef4444', 
                    fillOpacity: isAlert ? 0.25 : 0.05,
                    weight: isAlert ? 2 : 1
                  }} 
                />
              )}
            </React.Fragment>
          );
        })}
      </>
    );
  }, [cameras, selectedCam, currentTrajectoryPoints, showTacticalGaps, coverageData]);

  // =====================================================
  // INITIAL BOOT RENDER
  // =====================================================
  if (isGlobalLoading) {
    return (
      <div className="h-screen w-full bg-[#030712] flex flex-col items-center justify-center font-mono relative overflow-hidden select-none">
        <div className="absolute inset-0 bg-[linear-gradient(transparent_50%,rgba(0,0,0,0.25)_50%)] bg-[length:100%_4px] opacity-20 pointer-events-none"></div>
        <div className="text-blue-500 text-6xl mb-6 animate-pulse drop-shadow-[0_0_15px_rgba(59,130,246,0.5)]">🛡️</div>
        <h1 className="text-3xl font-black text-slate-100 tracking-[0.4em] mb-2 drop-shadow-md">
          SENTINEL <span className="text-blue-500">OS</span>
        </h1>
        <p className="text-xs text-blue-400/80 tracking-[0.3em] uppercase mb-8">Global Grid Initialization</p>
        <div className="w-64 h-1 bg-slate-900 rounded-full overflow-hidden relative shadow-inner">
          <div className="absolute top-0 left-0 h-full bg-blue-500 animate-[pulse_1s_ease-in-out_infinite] shadow-[0_0_10px_#3b82f6] w-full origin-left scale-x-100 transition-transform duration-1000"></div>
        </div>
        <p className="text-[10px] text-slate-500 uppercase tracking-widest mt-6 animate-pulse font-bold">Establishing Secure Uplink...</p>
      </div>
    );
  }

  // =====================================================
  // MAIN DASHBOARD UI RENDER
  // =====================================================
  return (
    <div className="flex h-screen w-full bg-[#030712] text-slate-200 font-sans overflow-hidden select-none relative animate-in fade-in duration-500">
      <style>{leafletDarkStyles}</style>

      {/* ===================================================== */}
      {/* FORENSIC WATCHLIST INSPECTOR MODAL                    */}
      {/* ===================================================== */}
      {selectedAlertImage && (
        <div 
          className="absolute inset-0 z-[3000] flex items-center justify-center bg-black/90 backdrop-blur-md p-6 select-none animate-in fade-in duration-200" 
          onClick={() => { setSelectedAlertImage(null); setIsEnhanced(false); }}
        >
          <div 
            className="relative max-w-4xl w-full bg-slate-950 border border-slate-800 rounded-2xl overflow-hidden shadow-[0_0_50px_rgba(225,29,72,0.15)] flex flex-col" 
            onClick={e => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="p-4 bg-slate-900 border-b border-slate-800 flex justify-between items-center">
              <div>
                <h3 className="text-sm font-black text-rose-500 uppercase tracking-wider flex items-center gap-2">
                  <span className="animate-pulse">🚨</span> Watchlist Interception Forensics
                </h3>
                <p className="text-[10px] font-mono text-slate-400 mt-0.5">Target Plate: <span className="text-amber-400 font-bold">{selectedAlertImage.plate_number}</span></p>
              </div>
              
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setIsEnhanced(!isEnhanced)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition border ${
                    isEnhanced 
                      ? 'bg-amber-500/20 border-amber-500 text-amber-300' 
                      : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white hover:bg-slate-700'
                  }`}
                >
                  {isEnhanced ? '⚡ Enhancement Active (Reset)' : '✨ Apply Neural Edge Enhancement'}
                </button>
                <button 
                  onClick={() => { setSelectedAlertImage(null); setIsEnhanced(false); }}
                  className="w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white flex items-center justify-center text-sm font-bold transition"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Main Image Stage */}
            <div className="relative bg-black flex items-center justify-center min-h-[350px] max-h-[60vh] p-4 overflow-hidden">
              <img 
                src={selectedAlertImage.image_data} 
                alt="Vehicle Snapshot" 
                style={{
                  filter: isEnhanced 
                    ? 'contrast(165%) brightness(115%) saturate(80%) drop-shadow(0px 0px 2px rgba(255,255,255,0.4))' 
                    : 'none'
                }}
                className="max-h-[55vh] max-w-full object-contain rounded transition-all duration-300"
              />

              {/* Tactical Crosshair */}
              <div className="absolute inset-0 pointer-events-none border border-white/5 flex items-center justify-center">
                <div className="w-16 h-16 border border-rose-500/30 rounded-full flex items-center justify-center">
                  <div className="w-2 h-2 bg-rose-500/60 rounded-full animate-ping"></div>
                </div>
              </div>

              {/* Rich Metadata Overlay */}
              <div className="absolute bottom-4 left-4 bg-slate-950/80 backdrop-blur-md border border-slate-700/50 p-3 rounded-xl flex flex-col gap-1 min-w-[250px] shadow-2xl">
                <span className="text-lg font-mono font-black text-amber-400 tracking-wider">{selectedAlertImage.plate_number}</span>
                <span className="text-xs text-slate-300 uppercase font-bold">{selectedAlertImage.entity_type}</span>
                <span className="text-[10px] text-slate-400 font-mono mt-1">
                  NODE: {selectedAlertImage.camera_id?.toUpperCase()} | {new Date(selectedAlertImage.timestamp_utc).toLocaleString()}
                </span>
                <span className="text-[10px] text-rose-400 font-bold uppercase mt-2 border-t border-slate-700/50 pt-2 flex items-center gap-1.5">
                  ⚠️ {selectedAlertImage.reason}
                </span>
              </div>

              {/* Disclaimer Banner when Enhanced */}
              {isEnhanced && (
                <div className="absolute top-4 left-4 right-4 bg-amber-950/90 border border-amber-600/60 p-2.5 rounded-lg backdrop-blur flex items-start gap-2.5 shadow-lg">
                  <span className="text-base leading-none">⚠️</span>
                  <div className="text-[10px] leading-tight text-amber-200">
                    <strong className="font-bold text-amber-400 block mb-0.5">SYNTHETIC DETAIL RECONSTRUCTION NOTICE:</strong>
                    Image sharpened using edge-frequency contrast amplification. Pixel artifacts and textures may be synthesized. Do not rely on enhanced edges for legal plate identification.
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="p-3 bg-slate-900/60 border-t border-slate-800 flex justify-between items-center text-[10px] font-mono text-slate-400">
              <span>RESOLUTION: INTERCEPT CROP MATRIX</span>
              <span>STATUS: {isEnhanced ? 'ENHANCED (USM + CLAHE)' : 'RAW CAPTURE'}</span>
            </div>
          </div>
        </div>
      )}

      {/* ===================================================== */}
      {/* MODALS SECTION                                        */}
      {/* ===================================================== */}
      
      <ModalWrapper isOpen={isOnboardModalOpen} onClose={() => setIsOnboardModalOpen(false)} title="Onboard Camera Node" icon="⊕" colorClass="text-emerald-400">
        <form onSubmit={handleManualSubmit} className="space-y-4">
          <div><label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">Node ID</label><input required type="text" value={newCam.id} onChange={e => setNewCam({...newCam, id: e.target.value})} className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-blue-500 font-mono" /></div>
          <div><label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">Location Name</label><input required type="text" value={newCam.name} onChange={e => setNewCam({...newCam, name: e.target.value})} className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-blue-500" /></div>
          <div className="flex gap-2">
            <div className="flex-1"><label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">Latitude</label><input required type="number" step="any" value={newCam.lat} onChange={e => setNewCam({...newCam, lat: e.target.value})} className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-blue-500 font-mono" /></div>
            <div className="flex-1"><label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">Longitude</label><input required type="number" step="any" value={newCam.lng} onChange={e => setNewCam({...newCam, lng: e.target.value})} className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-blue-500 font-mono" /></div>
          </div>
          <div><label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">Department</label><input type="text" value={newCam.dept} onChange={e => setNewCam({...newCam, dept: e.target.value})} className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-blue-500" placeholder="Traffic Police" /></div>
          <button type="submit" className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg text-xs uppercase tracking-wider transition">Commit Node</button>
        </form>
      </ModalWrapper>

      <ModalWrapper isOpen={isWatchlistModalOpen} onClose={() => setIsWatchlistModalOpen(false)} title="Authorize Watchlist Target" icon="🚨" colorClass="text-rose-500">
        <form onSubmit={handleDeployWatchlist} className="space-y-4">
          <div><label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5 block">Vehicle Registration</label><input required type="text" placeholder="GJ-01-PD-2182" value={newWatchlist.plate} onChange={e => setNewWatchlist({...newWatchlist, plate: e.target.value})} className="w-full bg-slate-900 border border-slate-800 rounded-lg px-4 py-2.5 text-sm uppercase font-mono outline-none text-white placeholder:text-slate-700" /></div>
          <div>
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5 block">Advisory Reason</label>
            <select value={newWatchlist.reason} onChange={e => setNewWatchlist({...newWatchlist, reason: e.target.value})} className="w-full bg-slate-900 border border-slate-800 rounded-lg px-4 py-2.5 text-sm outline-none text-slate-300">
              <option>Stolen Vehicle (eGujCop Alert)</option><option>Suspect in Transit (Law & Order)</option><option>Commercial Toll Evasion (RTO)</option>
            </select>
          </div>
          <button type="submit" className="w-full py-3.5 bg-rose-600 hover:bg-rose-500 text-white font-black rounded-lg text-[11px] uppercase tracking-widest mt-4">Commit to Statewide Mesh</button>
        </form>
      </ModalWrapper>

      <ModalWrapper isOpen={isTrajectoryModalOpen} onClose={() => setIsTrajectoryModalOpen(false)} title="Suspect Trajectory Reconstructor" icon="📍" colorClass="text-indigo-400" maxWidth="max-w-xl">
        <p className="text-xs text-slate-400 mb-3">Select a detected vehicle to plot its verified chronological route.</p>
        <div className="space-y-2 max-h-64 overflow-y-auto custom-scrollbar">
          {[...new Set(allTransits.map(t => t.plate_number))].filter(Boolean).map(plate => {
            const latestData = allTransits.find(t => t.plate_number === plate);
            
            return (
              <div 
                key={plate} 
                onClick={() => { setSelectedTrajectoryPlate(plate); setIsTrajectoryModalOpen(false); }} 
                className="p-3 bg-slate-900 border border-slate-800 rounded-xl cursor-pointer hover:border-indigo-500 flex justify-between items-center transition group"
              >
                <div className="flex items-center gap-3">
                  {latestData?.image_data ? (
                    <img src={latestData.image_data} alt="Vehicle Crop" className="w-12 h-12 object-cover rounded-lg bg-black border border-slate-700" />
                  ) : (
                    <div className="w-12 h-12 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-xl">🚗</div>
                  )}
                  <div>
                    <span className="font-mono font-bold text-amber-400 text-sm block tracking-wider">{plate}</span>
                    <span className="text-[10px] text-slate-400 font-bold uppercase">{latestData?.entity_type || 'Unknown Vehicle'}</span>
                  </div>
                </div>
                <span className="text-[10px] uppercase font-bold text-indigo-400 bg-indigo-500/10 px-3 py-1.5 rounded-lg border border-indigo-500/20 group-hover:bg-indigo-600 group-hover:text-white transition">
                  Plot Vector
                </span>
              </div>
            );
          })}
        </div>
      </ModalWrapper>

      <ModalWrapper isOpen={isGapAnalysisModalOpen} onClose={() => setIsGapAnalysisModalOpen(false)} title="Strategic Gap & Coverage Analysis" icon="📊" colorClass="text-emerald-400" maxWidth="max-w-xl">
        <div className="grid grid-cols-3 gap-3 text-center mb-4">
          <div className="bg-slate-900 p-3 rounded-xl border border-slate-800"><p className="text-[10px] text-slate-500 uppercase font-bold">Active Radii</p><p className="text-2xl font-black text-white">{cameras.filter(c => c.status === 'live' || c.status === 'alert').length}</p></div>
          <div className="bg-slate-900 p-3 rounded-xl border border-slate-800"><p className="text-[10px] text-slate-500 uppercase font-bold">Priority Zones</p><p className="text-2xl font-black text-emerald-400">{coverageData.total}</p></div>
          <div className="bg-slate-900 p-3 rounded-xl border border-slate-800"><p className="text-[10px] text-slate-500 uppercase font-bold">Blindspots</p><p className="text-2xl font-black text-rose-500">{coverageData.blindspotCount}</p></div>
        </div>
        <button onClick={() => { setShowTacticalGaps(!showTacticalGaps); setIsGapAnalysisModalOpen(false); }} className={`w-full py-2.5 rounded-lg text-xs font-bold uppercase transition ${showTacticalGaps ? 'bg-rose-600 text-white' : 'bg-slate-800 text-slate-200 border border-slate-700'}`}>
          {showTacticalGaps ? 'Disable Tactical Map Overlay' : 'Enable Tactical Map Overlay'}
        </button>
      </ModalWrapper>

      <ModalWrapper isOpen={isHealthModalOpen} onClose={() => setIsHealthModalOpen(false)} title="Infrastructure Lifecycle & Health Suite" icon="🛠️" colorClass="text-slate-300" maxWidth="max-w-xl">
        <div className="space-y-2 max-h-72 overflow-y-auto custom-scrollbar">
          {cameras.filter(c => c.status !== 'decommissioned').map(cam => {
            const isEOL = cam.installYear <= 2018;
            return (
              <div key={cam.id} className={`p-3 rounded-xl border flex justify-between items-center ${isEOL ? 'bg-amber-950/20 border-amber-500/40' : 'bg-slate-900 border-slate-800'}`}>
                <div>
                  <p className="font-bold text-xs text-white">{cam.name} <span className="text-[10px] font-mono text-slate-500">({cam.id})</span></p>
                  <p className="text-[10px] text-slate-400 mt-0.5">Installed: {cam.installYear || '2019'} • Uptime: {cam.uptime || '98'}%</p>
                </div>
                {isEOL && (
                  <button onClick={() => handleDecommission(cam.id)} className="px-2.5 py-1 bg-rose-600/20 border border-rose-500 text-rose-400 rounded text-[10px] font-bold uppercase hover:bg-rose-600 hover:text-white transition">
                    Decommission
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </ModalWrapper>

      <ModalWrapper isOpen={isAnprModalOpen} onClose={() => setIsAnprModalOpen(false)} title="RTO ANPR & ReID Transit Logs" icon="📸" colorClass="text-amber-400" maxWidth="max-w-2xl">
        <div className="space-y-2 max-h-72 overflow-y-auto custom-scrollbar">
          {allTransits.length === 0 ? (
            <p className="text-center text-slate-500 text-xs py-6 uppercase font-bold">Waiting for live data transmission...</p>
          ) : (
            allTransits.slice(0, 30).map((t, i) => (
              <div key={i} className="p-3 bg-slate-900 border border-slate-800 rounded-xl flex justify-between items-center text-xs">
                <div>
                  <p className="font-mono font-black text-amber-400 text-sm">{t.plate_number || 'UNKNOWN'}</p>
                  <p className="text-[10px] text-slate-400 mt-0.5">{t.entity_type} {t.color ? `• ${t.color}` : ''}</p>
                </div>
                <div className="text-right font-mono text-[10px] text-slate-500">
                  <p className="font-bold text-slate-300">{t.camera_id?.toUpperCase()}</p>
                  <p>{t.timestamp_utc?.split('T')[1]?.split('.')[0] || 'Recent'}</p>
                </div>
              </div>
            ))
          )}
        </div>
      </ModalWrapper>

      {/* ===================================================== */}
      {/* LEFT PANEL: ASSET REGISTRY & CONTROLS                 */}
      {/* ===================================================== */}
      <div className="w-[420px] min-w-[360px] border-r border-slate-800 flex flex-col bg-[#0f172a]/95 backdrop-blur z-10">
        
        <div className="p-5 border-b border-slate-800 bg-[#090d16]">
          <div className="flex items-center justify-between mb-1">
            <h1 className="text-xl font-black tracking-wider text-white flex items-center gap-2">
              <span className="text-blue-500 text-2xl">🛡️</span> SENTINEL OS
            </h1>
            <div className="flex gap-2 items-center">
              {onLogout && (
                <button 
                  onClick={onLogout} 
                  className="px-2.5 py-0.5 rounded-full text-[9px] font-extrabold bg-slate-800 text-slate-400 border border-slate-700 hover:bg-slate-700 hover:text-white transition"
                >
                  LOGOUT
                </button>
              )}
              <button 
                onClick={handleWipeDatabase} 
                className="px-2 py-0.5 rounded-full text-[9px] font-extrabold bg-rose-600/20 text-rose-500 border border-rose-500/30 hover:bg-rose-600 hover:text-white transition"
              >
                WIPE DB
              </button>
              <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-extrabold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                GRID ACTIVE
              </span>
            </div>
          </div>
          <p className="text-xs text-slate-400 font-medium">Enterprise Surveillance & Infrastructure Suite</p>
        </div>

        {/* Action Controls */}
        <div className="p-3 border-b border-slate-800 grid grid-cols-3 gap-2 bg-[#090d16]/50">
          <input type="file" accept=".csv" ref={fileInputRef} onChange={handleFileUpload} className="hidden" />
          <button onClick={() => setIsWatchlistModalOpen(true)} className="bg-rose-600/20 hover:bg-rose-600/30 text-rose-400 font-bold py-2 px-1 rounded-lg text-[10px] uppercase transition border border-rose-500/30">
            🚨 Target
          </button>
          <button onClick={() => fileInputRef.current?.click()} className="bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold py-2 px-1 rounded-lg text-[10px] uppercase transition border border-slate-700">
            CSV Import
          </button>
          <button onClick={() => setIsGapAnalysisModalOpen(true)} className="bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 font-bold py-2 px-1 rounded-lg text-[10px] uppercase transition border border-emerald-500/30">
            📊 Gaps
          </button>
          <button onClick={() => setIsTrajectoryModalOpen(true)} className="bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-400 font-bold py-2 px-1 rounded-lg text-[10px] uppercase transition border border-indigo-500/30">
            📍 Track
          </button>
          <button onClick={() => setIsHealthModalOpen(true)} className="bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold py-2 px-1 rounded-lg text-[10px] uppercase transition border border-slate-700">
            🛠️ Health
          </button>
          <button onClick={() => setIsOnboardModalOpen(true)} className="bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 font-bold py-2 px-1 rounded-lg text-[10px] uppercase transition border border-blue-500/30">
            ⊕ Onboard
          </button>
        </div>

        <div className="px-4 py-3 border-b border-slate-800">
          <input
            type="text"
            placeholder="Search by ID, name, or department..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-full bg-slate-900/80 border border-slate-700 rounded-lg px-3.5 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 font-medium"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2.5 custom-scrollbar">
          <div className="flex items-center justify-between px-1 mb-1">
            <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Registered Feeds</span>
            <span className="text-[11px] font-bold text-slate-500">{filteredCameras.length} Assets</span>
          </div>

          {filteredCameras.map((cam) => {
            const isAlert = cam.status === 'alert';
            const isLive = cam.status === 'live';
            const isDecommissioned = cam.status === 'decommissioned';

            return (
              <div
                key={cam.id}
                onClick={() => setSelectedCam(cam)}
                className={`p-3 rounded-xl border transition-all cursor-pointer ${
                  isDecommissioned
                    ? 'opacity-50 grayscale bg-slate-900 border-slate-800'
                    : isAlert
                    ? 'bg-amber-500/10 border-amber-500/50 shadow-[0_0_15px_rgba(245,158,11,0.15)]'
                    : selectedCam?.id === cam.id
                    ? 'bg-blue-600/15 border-blue-500'
                    : 'bg-slate-900/60 border-slate-800/80 hover:border-slate-700'
                }`}
              >
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div>
                    <span className="text-[10px] font-mono font-bold text-slate-400 uppercase">{cam.id}</span>
                    <p className="font-bold text-sm text-slate-100 leading-tight">{cam.name}</p>
                  </div>

                  <span className={`text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full flex items-center gap-1.5 ${
                    isDecommissioned
                      ? 'bg-slate-800 text-slate-400'
                      : isAlert
                      ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
                      : isLive
                      ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                      : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                  }`}>
                    {!isDecommissioned && (
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        isAlert ? 'bg-amber-400 animate-ping' : isLive ? 'bg-emerald-400' : 'bg-rose-500'
                      }`}></span>
                    )}
                    {cam.status}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400">{cam.dept}</p>
              </div>
            );
          })}
        </div>

        {/* Live Watchlist Hits (UPGRADED UI) */}
        {recentAlerts.length > 0 && (
          <div className="border-t border-slate-800 bg-[#090d16] p-4 max-h-64 overflow-y-auto custom-scrollbar">
            <p className="text-[11px] font-black uppercase tracking-widest text-amber-400 mb-3 flex items-center gap-1.5">
              <span className="animate-pulse">🚨</span> Live Interceptions
            </p>
            <div className="space-y-3">
              {recentAlerts.slice(0, 3).map((al, idx) => (
                <div key={idx} className="bg-slate-900/90 rounded-lg border border-amber-500/40 overflow-hidden shadow-[0_0_10px_rgba(245,158,11,0.1)]">
                  
                  {/* Image Snapshot Header (CLICKABLE) */}
                  {al.image_data && (
                    <div 
                      className="h-24 w-full bg-black relative border-b border-amber-500/20 cursor-pointer group"
                      onClick={() => setSelectedAlertImage(al)}
                    >
                      <img src={al.image_data} alt="Suspect Vehicle" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
                      
                      {/* Hover Overlay "VIEW FORENSICS" */}
                      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-rose-950/40 z-10">
                        <span className="text-white text-[10px] tracking-widest font-bold px-3 py-1.5 bg-black/80 rounded border border-rose-500/50 shadow-lg flex items-center gap-2">
                          <span>🔍</span> VIEW FORENSICS
                        </span>
                      </div>

                      <div className="absolute inset-0 bg-gradient-to-t from-slate-950 to-transparent pointer-events-none"></div>
                      <span className="absolute bottom-2 left-2 text-[10px] font-mono font-bold text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/30 z-20 pointer-events-none">
                        {al.camera_id?.toUpperCase()}
                      </span>
                    </div>
                  )}

                  <div className="p-2.5">
                    <div className="flex justify-between items-start mb-1">
                      <span className="font-mono font-black text-sm text-slate-100 tracking-wider">
                        {al.plate_number || 'TARGET'}
                      </span>
                      <span className="text-[9px] text-slate-500 font-mono">
                        {al.timestamp_utc ? new Date(al.timestamp_utc).toLocaleTimeString() : 'Just now'}
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-300 font-bold uppercase mb-1">{al.entity_type}</p>
                    <p className="text-[9px] text-rose-400 font-mono uppercase bg-rose-500/10 inline-block px-1.5 py-0.5 rounded border border-rose-500/20">
                      {al.reason || 'Watchlist Target Intercepted'}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>

      {/* ===================================================== */}
      {/* RIGHT WORKSPACE: TACTICAL GIS MAPPING ENGINE          */}
      {/* ===================================================== */}
      <div className="flex-1 relative h-full bg-[#050811]">
        
        {selectedTrajectoryPlate && (
          <div className="absolute top-6 left-6 z-[1000] bg-slate-950/90 border border-indigo-500/50 p-3 rounded-xl backdrop-blur-md flex items-center gap-4 shadow-xl">
            <div>
              <p className="text-[9px] font-black uppercase tracking-widest text-indigo-400">Active Suspect Vector</p>
              <p className="text-sm font-mono font-bold text-white tracking-wider">{selectedTrajectoryPlate}</p>
            </div>
            <button onClick={() => setSelectedTrajectoryPlate(null)} className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[10px] font-bold uppercase transition">
              Clear ✕
            </button>
          </div>
        )}

        <MapContainer 
          center={[22.2587, 71.1924]} 
          zoom={7} 
          zoomControl={false}
          className="w-full h-full z-0"
        >
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution='&copy; OpenStreetMap' className="map-tiles" />
          {memoizedMapElements}
        </MapContainer>
      </div>
      
    </div>
  );
}