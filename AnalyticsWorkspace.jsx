import React, { useState, useEffect, useRef } from 'react';
import { db, ref, push, onValue } from './firebase';

// =========================================================
// 1. SMART HYBRID STREAM RENDERER
// =========================================================
const ANPR_CAMERAS = ['cam06', 'cam12', 'cam21', 'cam22'];

function LargeVideoPlayer({ camId }) {
  const safeCamId = camId?.toLowerCase().trim() || '';
  const isAnprCamera = ANPR_CAMERAS.includes(safeCamId);

  if (isAnprCamera) {
    return (
      <div className="w-full h-full bg-black rounded-xl overflow-hidden border border-slate-800 shadow-2xl relative flex items-center justify-center">
        <img 
          src="http://localhost:5001/anpr_feed" 
          alt="Live AI Edge Stream" 
          className="w-full h-full object-cover"
          onError={(e) => {
            console.warn("Python edge stream on Port 5001 unavailable. Falling back to local MP4 asset.");
            e.target.style.display = 'none';
          }}
        />
        <video 
          src={`/${safeCamId}.mp4`} 
          autoPlay 
          loop 
          muted 
          playsInline 
          className="w-full h-full object-cover -z-10 absolute inset-0"
        />
        <div className="absolute top-4 right-4 flex items-center gap-2 bg-indigo-900/80 px-3 py-1 rounded backdrop-blur border border-indigo-500 z-10 shadow-lg">
          <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse"></span>
          <span className="text-[10px] font-mono font-bold text-indigo-100 uppercase tracking-widest">
            AI EDGE INFERENCE STREAM (YOLOv8 + GEMINI)
          </span>
        </div>
        <div className="absolute inset-0 pointer-events-none bg-[url('https://www.transparenttextures.com/patterns/scan-lines-light.png')] opacity-20"></div>
      </div>
    );
  }

  return <WhepPlayer camId={safeCamId} />;
}

function WhepPlayer({ camId }) {
  const videoRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [streamError, setStreamError] = useState(false);

  useEffect(() => {
    let pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    let isMounted = true;

    const startStream = async () => {
      try {
        setLoading(true);
        setStreamError(false);
        const whepUrl = `http://103.250.160.189:8889/stream/${camId}/whep`;

        pc.addTransceiver('video', { direction: 'recvonly' });

        pc.ontrack = (event) => {
          if (videoRef.current && isMounted) {
            videoRef.current.srcObject = event.streams[0] || new MediaStream([event.track]);
            videoRef.current.play().catch(() => {});
            setLoading(false);
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const credentials = btoa('raj.vignesh2000@gmail.com:TG69-CVYY-GTHN');
        const response = await fetch(whepUrl, {
          method: 'POST',
          body: offer.sdp,
          headers: { 'Content-Type': 'application/sdp', 'Authorization': `Basic ${credentials}` }
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const answerSdp = await response.text();
        if (isMounted) await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      } catch (err) {
        if (isMounted) { setStreamError(true); setLoading(false); }
      }
    };

    startStream();
    return () => { isMounted = false; pc.close(); };
  }, [camId]);

  return (
    <div className="w-full h-full bg-black rounded-xl overflow-hidden border border-slate-800 shadow-2xl relative flex items-center justify-center">
      {loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/80 z-10">
          <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mb-2"></div>
          <span className="text-[10px] font-mono text-slate-300 tracking-wider">CONNECTING TELEMETRY FEED...</span>
        </div>
      )}
      {streamError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950 text-slate-400 p-4">
          <span className="text-2xl mb-1">⚠️</span>
          <span className="text-xs font-mono text-amber-400 font-bold">WHEP Ingestion Stalled</span>
        </div>
      )}
      <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
      <div className="absolute top-4 right-4 flex items-center gap-2 bg-black/70 px-3 py-1 rounded backdrop-blur border border-slate-800 z-10">
        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
        <span className="text-[10px] font-mono font-bold text-slate-200 uppercase">WHEP LIVE</span>
      </div>
    </div>
  );
}

// =========================================================
// 2. SENTINEL AGENTIC COPILOT (INLINE COMPONENT)
// =========================================================
function SentinelCopilot({ onClose }) {
  const [query, setQuery] = useState('');
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;

    setMessages(prev => [...prev, { role: 'operator', text: query }]);
    setQuery('');
    setLoading(true);

    try {
      const res = await fetch('http://localhost:5000/api/copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: query })
      });
      
      const data = await res.json();
      setMessages(prev => [...prev, { role: 'copilot', text: data.reply || data.error }]);
    } catch (error) {
      setMessages(prev => [...prev, { role: 'copilot', text: "SYSTEM ERROR: Unable to reach AI Core. Check Flask backend." }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="absolute inset-0 z-40 bg-slate-950/90 backdrop-blur-sm p-8 flex flex-col justify-end animate-in fade-in duration-300">
      <div className="w-full max-w-4xl mx-auto bg-slate-900 border-2 border-emerald-500/30 rounded-xl shadow-[0_0_50px_rgba(16,185,129,0.15)] flex flex-col h-[70vh] mb-10 overflow-hidden">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-emerald-500/20 bg-slate-900 flex justify-between items-center">
          <h3 className="text-emerald-400 font-mono text-base font-black tracking-widest flex items-center gap-3">
            <span className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_10px_rgba(16,185,129,0.8)]"></span>
            SENTINEL OS COPILOT <span className="text-slate-500 font-normal text-xs ml-2">|| VERTEX AI COMMAND TERMINAL</span>
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white font-mono text-sm font-bold bg-slate-800 hover:bg-slate-700 px-3 py-1 rounded transition">
            [ ESC ] CLOSE TERMINAL
          </button>
        </div>

        {/* Chat Log */}
        <div className="p-6 flex-1 overflow-y-auto flex flex-col gap-4 font-mono text-sm bg-slate-950/50 custom-scrollbar">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-slate-500 space-y-4">
              <span className="text-4xl">🧠</span>
              <p className="italic text-center leading-relaxed">
                LangChain Database Routing Active.<br/>
                Try commanding the system: <span className="text-emerald-400 font-bold">"Find all white SUVs on SG Highway today."</span>
              </p>
            </div>
          )}
          {messages.map((msg, idx) => (
            <div key={idx} className={`p-4 rounded-lg shadow-lg ${
              msg.role === 'operator' 
                ? 'bg-slate-800 text-blue-300 ml-12 border-l-4 border-blue-500' 
                : 'bg-emerald-950/30 text-emerald-300 mr-12 border-l-4 border-emerald-500'
            }`}>
              <span className="opacity-50 text-[10px] font-black uppercase tracking-wider block mb-2">
                [{msg.role}]
              </span>
              <div className="whitespace-pre-wrap leading-relaxed">{msg.text}</div>
            </div>
          ))}
          {loading && (
            <div className="p-4 mr-12 bg-emerald-950/20 text-emerald-500/70 border-l-4 border-emerald-500/30 rounded-lg animate-pulse">
              <span className="text-xs">Processing spatial correlation...</span>
            </div>
          )}
        </div>

        {/* Input Form */}
        <form onSubmit={handleSearch} className="p-4 border-t border-emerald-500/20 bg-slate-900 flex gap-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Enter natural language command..."
            className="flex-1 bg-slate-950 border border-slate-700 text-emerald-100 px-5 py-4 rounded-lg focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 font-mono text-sm transition-all"
            autoFocus
          />
          <button 
            type="submit" 
            disabled={loading}
            className="bg-emerald-600 hover:bg-emerald-500 text-slate-900 font-black px-8 py-4 rounded-lg font-mono transition-colors disabled:opacity-50 tracking-widest shadow-lg shadow-emerald-900/50"
          >
            EXECUTE
          </button>
        </form>
      </div>
    </div>
  );
}

// =========================================================
// 3. MAIN ANALYTICS WORKSPACE
// =========================================================
export default function AnalyticsWorkspace({ camId: propCamId, userRole, userDept }) {
  const queryParams = new URLSearchParams(window.location.search);
  const camId = propCamId || queryParams.get('analytics') || 'cam21';
  const role = userRole || queryParams.get('role') || 'admin';
  const dept = userDept || queryParams.get('dept') || 'ALL';

  const [targetPlate, setTargetPlate] = useState('');
  const [latestIncident, setLatestIncident] = useState(null);
  const [transits, setTransits] = useState([]);
  const [selectedImage, setSelectedImage] = useState(null);
  const [selectedTransit, setSelectedTransit] = useState(null);
  const [isEnhanced, setIsEnhanced] = useState(false);
  const [showCopilot, setShowCopilot] = useState(false); // COPILOT STATE TOGGLE

  useEffect(() => {
    const unsubAlerts = onValue(ref(db, 'alerts'), (snap) => {
      if (!snap.val()) return setLatestIncident(null);
      const camAlerts = Object.values(snap.val())
        .filter(al => al.camera_id?.toLowerCase() === camId.toLowerCase())
        .sort((a, b) => new Date(b.timestamp_utc) - new Date(a.timestamp_utc));
      setLatestIncident(camAlerts.length > 0 ? camAlerts[0] : null);
    });

    const unsubTransits = onValue(ref(db, 'transits'), (snap) => {
      if (!snap.val()) return setTransits([]);
      setTransits(
        Object.values(snap.val())
          .filter(tr => tr.camera_id?.toLowerCase() === camId.toLowerCase())
          .reverse()
          .slice(0, 25)
      );
    });

    return () => { unsubAlerts(); unsubTransits(); };
  }, [camId]);

  // Handle ESC key to close Copilot
  useEffect(() => {
    const handleKeyDown = (e) => { if (e.key === 'Escape') setShowCopilot(false); };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleAddWatchlist = async (e) => {
    if (e) e.preventDefault();
    if (!targetPlate.trim()) return;
    await push(ref(db, 'watchlist'), { 
      plate: targetPlate.toUpperCase().trim(), 
      reason: 'Stolen Vehicle / eGujCop Alert',
      origin_cam: camId,
      timestamp_utc: new Date().toISOString()
    });
    alert(`Target Plate ${targetPlate.toUpperCase()} added to active Watchlist.`);
    setTargetPlate('');
  };

  // 🎯 NEW: DETERMINE IF THE LATEST INCIDENT IS A TRUE SECURITY THREAT (IGNORES TRAFFIC)
  const isSecurityAlert = latestIncident && latestIncident.reason && 
    !(latestIncident.reason.toUpperCase().includes('HELMET') || 
      latestIncident.reason.toUpperCase().includes('WRONG-WAY') || 
      latestIncident.reason.toUpperCase().includes('COMPOUND') ||
      latestIncident.reason.toUpperCase().includes('SPEEDING'));

  return (
    <div className="flex h-screen bg-[#070b14] text-slate-100 font-sans select-none overflow-hidden relative">
      
      {/* 🚀 COPILOT OVERLAY LAYER */}
      {showCopilot && <SentinelCopilot onClose={() => setShowCopilot(false)} />}

      {/* FORENSIC TELEMETRY INSPECTOR MODAL */}
      {selectedImage && (
        <div 
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-md p-6 select-none animate-in fade-in duration-200" 
          onClick={() => { setSelectedImage(null); setSelectedTransit(null); setIsEnhanced(false); }}
        >
          <div 
            className="relative max-w-5xl w-full bg-slate-950 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl flex flex-col" 
            onClick={e => e.stopPropagation()}
          >
            <div className="p-4 bg-slate-900 border-b border-slate-800 flex justify-between items-center">
              <div>
                <h3 className="text-sm font-black text-white uppercase tracking-wider flex items-center gap-2">
                  <span>🔍</span> Forensic Vehicle Telemetry & RTO Inspector
                </h3>
                <p className="text-[10px] font-mono text-slate-400">Node: {camId.toUpperCase()} | Direct AI Crop Buffer</p>
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
                  onClick={() => { setSelectedImage(null); setSelectedTransit(null); setIsEnhanced(false); }}
                  className="w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white flex items-center justify-center text-sm font-bold transition"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="relative bg-black flex items-center justify-center min-h-[360px] max-h-[62vh] p-4 overflow-hidden">
              <img 
                src={selectedImage} 
                alt="Vehicle Snapshot" 
                style={{
                  filter: isEnhanced 
                    ? 'contrast(165%) brightness(115%) saturate(80%) drop-shadow(0px 0px 2px rgba(255,255,255,0.4))' 
                    : 'none'
                }}
                className="max-h-[58vh] max-w-full object-contain rounded transition-all duration-300"
              />

              <div className="absolute inset-0 pointer-events-none border border-white/5 flex items-center justify-center">
                <div className="w-16 h-16 border border-emerald-500/30 rounded-full flex items-center justify-center">
                  <div className="w-2 h-2 bg-emerald-500/60 rounded-full animate-ping"></div>
                </div>
              </div>

              {/* TELEMETRY & CONFIDENCE OVERLAY */}
              {selectedTransit && (
                <div className="absolute bottom-4 left-4 bg-slate-950/90 backdrop-blur-md border border-slate-700/80 p-3 rounded-xl flex flex-col gap-1.5 min-w-[300px] max-w-[320px] shadow-2xl">
                  <div className="flex justify-between items-start">
                    <div>
                      <span className="text-xl font-mono font-black text-amber-400 tracking-wider block leading-none">
                        {selectedTransit.plate_number}
                      </span>
                      <span className="text-xs text-slate-300 uppercase font-bold">
                        {selectedTransit.entity_type}
                      </span>
                    </div>
                    
                    <div className={`px-2 py-1 rounded-md text-[11px] font-black border ${
                      selectedTransit.confidence >= 0.85 
                        ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40' 
                        : selectedTransit.confidence >= 0.60
                        ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                        : 'bg-rose-500/20 text-rose-400 border-rose-500/40'
                    }`}>
                      {(selectedTransit.confidence * 100).toFixed(1)}% CONF
                    </div>
                  </div>
                  
                  <div className="text-[9px] text-slate-400 font-mono mt-0.5 border-b border-slate-800 pb-2">
                    NODE: {selectedTransit.camera_id?.toUpperCase()} | {new Date(selectedTransit.timestamp_utc).toLocaleString()}
                  </div>

                  {selectedTransit.confidence < 0.80 ? (
                    <div className="mt-1 text-[9px] leading-tight text-rose-400 flex items-start gap-1.5 font-medium bg-rose-950/30 p-1.5 rounded border border-rose-500/20">
                      <span className="text-sm leading-none">⚠️</span>
                      <span>
                        <strong className="font-bold block text-rose-300">LOW CONFIDENCE WARNING:</strong> 
                        Optical distortion or blur detected. Manual verification is strictly required prior to dispatching e-Challan or enforcement units.
                      </span>
                    </div>
                  ) : (
                    <div className="mt-1 text-[9px] leading-tight text-emerald-400 flex items-start gap-1.5 font-medium bg-emerald-950/30 p-1.5 rounded border border-emerald-500/20">
                      <span className="text-sm leading-none">✅</span>
                      <span>
                        <strong className="font-bold block text-emerald-300">HIGH CONFIDENCE MATCH:</strong> 
                        AI verification meets the legal threshold ( &gt;80% ) for automated processing and trajectory mapping.
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* RTO PARIVAHAN DOSSIER OVERLAY */}
              {selectedTransit?.rto_dossier && (
                <div className="absolute top-4 right-4 w-72 bg-slate-950/90 backdrop-blur-md border border-slate-700 p-4 rounded-xl shadow-2xl flex flex-col gap-2">
                  <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-800 pb-2 mb-1 flex items-center gap-1.5">
                    <span className="text-blue-500">🏛️</span> Parivahan Compliance
                  </h4>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-slate-400">Insurance (Sec 196):</span>
                    <span className={`font-black ${selectedTransit.rto_dossier.insurance_status === 'VALID' ? 'text-emerald-400' : 'text-rose-500 animate-pulse'}`}>
                      {selectedTransit.rto_dossier.insurance_status}
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-slate-400">PUCC Status:</span>
                    <span className={`font-black ${selectedTransit.rto_dossier.pucc_status === 'VALID' ? 'text-emerald-400' : 'text-amber-500'}`}>
                      {selectedTransit.rto_dossier.pucc_status}
                    </span>
                  </div>
                  {selectedTransit.rto_dossier.total_fine_amount > 0 ? (
                    <div className="mt-2 pt-2 border-t border-slate-800">
                      <span className="text-[10px] font-bold text-rose-400 uppercase block">Total Recoverable Fines</span>
                      <span className="text-2xl font-black text-rose-500 block">₹{selectedTransit.rto_dossier.total_fine_amount.toLocaleString()}</span>
                      <div className="mt-1 space-y-0.5 mb-2">
                        {selectedTransit.rto_dossier.pending_challans?.map((c, i) => (
                          <div key={i} className="text-[9px] text-slate-400 flex justify-between">
                            <span>• {c.reason}</span>
                            <span>₹{c.amount}</span>
                          </div>
                        ))}
                      </div>
                      <button className="w-full bg-rose-600/20 text-rose-400 border border-rose-500 hover:bg-rose-600 hover:text-white text-[9px] font-black py-1.5 rounded transition uppercase tracking-widest">
                        Issue E-Challan Notice
                      </button>
                    </div>
                  ) : (
                    <div className="mt-2 pt-2 border-t border-slate-800">
                      <span className="text-[10px] font-bold text-emerald-400 uppercase block">Clear Record • No Fines</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="p-3 bg-slate-900/60 border-t border-slate-800 flex justify-between items-center text-[10px] font-mono text-slate-400">
              <span>RESOLUTION: CROP BUFFER MATRIX</span>
              <span>STATUS: {isEnhanced ? 'ENHANCED (USM + CLAHE)' : 'RAW CAPTURE'}</span>
            </div>
          </div>
        </div>
      )}

      {/* LEFT PANEL: VIDEO & METRICS */}
      <div className="flex-1 p-5 flex flex-col min-w-0">
        <div className="flex justify-between items-center mb-3">
          <div className="flex items-center gap-3">
            <span className="px-2.5 py-1 rounded bg-blue-600/20 text-blue-400 font-mono text-xs font-bold border border-blue-500/30 uppercase">
              {camId}
            </span>
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest px-2 py-0.5 border border-slate-700 rounded bg-slate-800/40">
              CLEARANCE: {dept}
            </span>
            <h1 className="text-xl font-black text-white">Tactical Video Analytics & ANPR Feed</h1>
          </div>
          <div className="flex items-center gap-3">
            
            {/* 🚀 NEW COPILOT LAUNCH BUTTON */}
            <button 
              onClick={() => setShowCopilot(true)} 
              className="px-4 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/40 border border-emerald-500/50 text-emerald-400 hover:text-emerald-300 rounded-lg text-xs font-black tracking-widest transition flex items-center gap-2"
            >
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
              LAUNCH AI COPILOT
            </button>

            <button onClick={() => window.close()} className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-bold transition">
              Close Window
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 relative mb-3">
          {/* 🎯 FIXED: RED BANNER NOW ONLY SHOWS FOR SECURITY THREATS AND IS FULLY CLICKABLE */}
          {isSecurityAlert && (
            <div 
              className="absolute top-4 left-4 right-4 bg-red-950/95 border-2 border-red-500 p-4 rounded-xl z-30 flex items-center justify-between shadow-[0_0_40px_rgba(239,68,68,0.5)] animate-in slide-in-from-top-4 cursor-pointer hover:bg-red-900 transition-colors"
              onClick={() => {
                if (latestIncident?.image_data) {
                  setSelectedImage(latestIncident.image_data);
                  setSelectedTransit(latestIncident);
                }
              }}
            >
              <div className="flex items-center gap-4">
                <span className="text-4xl animate-pulse">🚨</span>
                <div>
                  <h3 className="text-lg font-black tracking-widest text-red-500 uppercase">Watchlist Target Intercepted</h3>
                  <p className="text-sm font-mono text-white">PLATE: {latestIncident.plate_number} | {latestIncident.reason}</p>
                </div>
              </div>
              <button 
                onClick={(e) => { 
                  e.stopPropagation(); // Prevents the modal from opening when trying to dismiss
                  setLatestIncident(null); 
                }}
                className="bg-red-600 hover:bg-red-500 px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition"
              >
                Acknowledge
              </button>
            </div>
          )}
          <LargeVideoPlayer camId={camId} />
        </div>

        <div className="h-24 flex gap-3">
          <div className="flex-1 bg-slate-900/70 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
            <span className="text-[10px] font-black uppercase text-slate-400">Stream Clarity Assessment</span>
            <div className="flex items-end justify-between">
              <div>
                <span className="text-3xl font-mono font-black text-emerald-400">
                  {transits[0]?.clarity_score || '--'}
                </span>
                <span className="text-slate-500 ml-1 text-xs">/ 100</span>
              </div>
              <div className="px-2.5 py-1 rounded border bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-[10px] font-bold">
                LAPLACIAN CALIBRATED
              </div>
            </div>
          </div>

          <div className="flex-1 bg-slate-900/70 border border-slate-800 rounded-xl p-4 flex flex-col justify-between">
            <span className="text-[10px] font-black uppercase text-slate-400">Active Sector Alert</span>
            <div>
              {/* Note: This bottom panel will still display the newest vehicle plate whether it is traffic or security */}
              <p className="text-xl font-mono font-bold text-amber-400">{latestIncident?.plate_number || 'SECTOR SECURE'}</p>
              <p className="text-xs text-slate-400 capitalize">{latestIncident ? `${latestIncident.entity_type}` : 'Continuous Mesh Monitoring Active'}</p>
            </div>
          </div>
        </div>
      </div>

      {/* RIGHT PANEL: ANPR FEED */}
      <div className="w-[380px] border-l border-slate-800 bg-[#0c1220] p-5 flex flex-col z-10">
        {role === 'admin' ? (
          <>
            <h2 className="text-sm font-black text-white mb-2 uppercase">Deploy Watchlist Target</h2>
            <form onSubmit={handleAddWatchlist} className="space-y-2 mb-4">
              <input 
                type="text" 
                placeholder="ENTER VEHICLE PLATE" 
                value={targetPlate} 
                onChange={(e) => setTargetPlate(e.target.value)} 
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono uppercase focus:border-blue-500 outline-none text-white" 
                required 
              />
              <button type="submit" className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-2 rounded-lg text-xs uppercase transition tracking-wider shadow-lg shadow-blue-600/20">
                Commit Target
              </button>
            </form>
          </>
        ) : (
          <div className="mb-4 p-3 border border-slate-800 rounded-lg bg-slate-900/50 text-center">
            <p className="text-xs text-slate-400 font-bold">Operator Mode: Read-Only Clearance</p>
          </div>
        )}

        <div className="flex-1 flex flex-col min-h-0 border-t border-slate-800 pt-3">
          <div className="flex justify-between items-center mb-2">
            <span className="text-[11px] font-black uppercase text-slate-300 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
              Live ANPR Detections
            </span>
            <span className="text-[10px] text-slate-500 font-mono">Select image to inspect</span>
          </div>

          <div className="flex-1 overflow-y-auto space-y-3 pr-1 pb-4 custom-scrollbar">
            {transits.length === 0 ? (
              <div className="text-center text-slate-500 text-xs py-10">Waiting for transit logs...</div>
            ) : (
              transits.map((tr, idx) => {
                const isObscured = tr.plate_number === 'UNREADABLE';
                return (
                  <div key={idx} className="bg-slate-900/90 border border-slate-800 rounded-lg overflow-hidden flex flex-col shadow-md">
                    {tr.image_data && (
                      <div 
                        className="h-32 w-full bg-black border-b border-slate-800 relative cursor-pointer group"
                        onClick={() => { setSelectedImage(tr.image_data); setSelectedTransit(tr); }}
                      >
                        <img src={tr.image_data} alt="Vehicle Crop" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
                        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/40">
                          <span className="text-white text-xs font-bold px-2 py-1 bg-black/60 rounded border border-white/20">VIEW FORENSICS</span>
                        </div>
                      </div>
                    )}
                    <div className="p-3">
                      <div className="flex justify-between items-start mb-1">
                        <p className={`font-mono font-black text-sm tracking-wider ${isObscured ? 'text-slate-500' : 'text-emerald-400'}`}>
                          {tr.plate_number}
                        </p>
                        <span className="text-[10px] font-mono text-slate-500 mt-0.5">
                          {tr.timestamp_utc?.split('T')[1]?.split('.')[0] || 'Recent'}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-400 uppercase font-bold tracking-wide">
                        {tr.entity_type} {tr.clarity_score ? `• BLUR INDEX: ${tr.clarity_score}/100` : ''}
                      </p>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
