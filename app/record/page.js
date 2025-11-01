"use client";

import { useEffect, useRef, useState } from "react";

// Constantes
const sampleRate = 16000;
const bufferSize = 4096;
const WS_ENDPOINT = "wss://platinum-lodge-ask-maria.trycloudflare.com/v1/record";

export default function RecordPage() {
  
  const [status, setStatus] = useState("idle");
  const [speaking, setSpeaking] = useState(false);
  const [sessionId, setSessionId] = useState(1);

  // Estado para el cuadro de la derecha (el resultado final)
  const [latestTranscript, setLatestTranscript] = useState(null);

  const canvasRef = useRef(null);
  const audioRef = useRef({ ctx: null, analyser: null, source: null, stream: null, scriptProcessor: null });
  const speakingRef = useRef(false);

  const [socket, setSocket] = useState(null);
  const socketRef = useRef(null);
  useEffect(() => { socketRef.current = socket; }, [socket]);

  // 'uiPhase' ahora controla AMBOS cuadros
  const [uiPhase, setUiPhase] = useState("idle"); // idle | listening | processing | done
  
  // Ya no necesitamos estos estados para la UI izquierda
  // const [lastSegment, setLastSegment] = useState(null);
  // const [transcriptInfo, setTranscriptInfo] = useState({ language: "es", duration: 0 });
  // const [segments, setSegments] = useState([]);
  
  const waitingFinalRef = useRef(false);
  const finalTimeoutRef = useRef(null);

  // ==================================================
  // ===== LÓGICA DE GRABACIÓN =====
  // ==================================================

  function openWS(onReady) {
    try {
      const ws = new WebSocket(WS_ENDPOINT);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        ws.send(JSON.stringify({ language: "es", sr: sampleRate }));
        onReady && onReady(ws);
      };
      
      ws.onmessage = (e) => {
        let m = null;
        try { m = JSON.parse(e.data); } catch { /* m queda null */ }

        if (!m) return;

        const isInfo = m.type === "info" || m.event === "info" || m.status === "info";
        const maybeSegments = m.segments || m.segment_list || (m.transcript && m.transcript.segments) || null;
        const maybeLanguage = m.language || (m.transcript && m.transcript.language) || null;
        const maybeDuration = m.duration || (m.transcript && m.transcript.duration) || null;

        if (isInfo || m.message) {
          const msg = m.message || "";
          if (msg.includes("grabacion iniciada")) setUiPhase("listening");
          if (msg.includes("procesando")) {
            setUiPhase("processing");
            // ya no necesitamos 'lastSegment'
            // if (typeof m.segment === "number") setLastSegment(m.segment);
          }
        }

        // Ya no necesitamos mostrar segmentos parciales
        // if (m.type === "partial" || ...) { ... }

        const isFinal = m.type === "transcribed" || m.type === "final" || m.event === "final" || m.status === "done" || m.done === true || !!maybeSegments;
        const isError = m.type === "error";

        if (isFinal) {
          console.log("¡Mensaje final recibido!", m);
          if (finalTimeoutRef.current) clearTimeout(finalTimeoutRef.current);
          waitingFinalRef.current = false;

          const transcriptData = m.transcript || m;
          const segs = transcriptData.segments || (Array.isArray(maybeSegments) ? maybeSegments : (
            transcriptData.text ? [{ start: null, end: null, text: transcriptData.text }] : []
          ));

          // Actualiza el estado general
          setUiPhase("done");

          // Actualiza el cuadro de la DERECHA
          const finalRaw = { ...transcriptData, segments: segs, language: (transcriptData.language || maybeLanguage || "es"), duration: (transcriptData.duration || (typeof maybeDuration === "number" ? maybeDuration : undefined)) };
          setLatestTranscript(finalRaw);

          setTimeout(() => {
            closeWS();
            setSessionId((n) => n + 1);
          }, 200);
        }
        
        else if (isError) {
          console.error("Error recibido del backend:", m.message);
          
          if (finalTimeoutRef.current) clearTimeout(finalTimeoutRef.current);
          waitingFinalRef.current = false;
          
          setUiPhase("idle"); // Resetea el estado
          
          // Muestra el error en el cuadro derecho
          setLatestTranscript({ error: m.message || "Error en el servidor" }); 
          
          setTimeout(() => {
            closeWS();
            setSessionId((n) => n + 1);
          }, 200);
        }
      }; // fin de onmessage

      ws.onclose = () => { setSocket(null); };
      ws.onerror = (err) => { console.error("WS error:", err); setStatus("error: ws connection"); };
      setSocket(ws);
      return ws;
    } catch (e) {
      console.error("WS init error:", e);
      setStatus("error: ws init");
      return null;
    }
  }

  function closeWS() {
    const ws = socketRef.current;
    if (!ws) return;
    try { ws.close(); } catch {}
    setSocket(null);
  }

  async function start() {
    if (status === "recording") return;

    // Limpia el cuadro de la derecha
    setLatestTranscript(null);

    let ws = socketRef.current;
    if (!ws || ws.readyState !== 1) {
      ws = openWS(async (readyWS) => {
        await startAudioAndStream(readyWS);
      });
      setStatus("connecting");
      setUiPhase("idle");
      // ya no necesitamos limpiar estos estados
      // setLastSegment(null);
      // setSegments([]);
      // setTranscriptInfo({ language: "es", duration: 0 });
      return;
    }

    await startAudioAndStream(ws);
  }

  async function startAudioAndStream(ws) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          noiseSuppression: false,
          echoCancellation: false,
          autoGainControl: false,
          sampleRate,
        },
      });
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx({ sampleRate });
      await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      const scriptProcessor = ctx.createScriptProcessor(bufferSize, 1, 1);

      scriptProcessor.onaudioprocess = (e) => {
        if (!socketRef.current || socketRef.current.readyState !== 1) return;
        const inputData = e.inputBuffer.getChannelData(0);
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcm16[i] = s * 0x7fff;
        }
        socketRef.current.send(pcm16.buffer);
      };

      source.connect(analyser);
      source.connect(scriptProcessor);
      scriptProcessor.connect(ctx.destination);
      audioRef.current = { ctx, analyser, source, stream, scriptProcessor };

      ws.send(JSON.stringify({ type: "start", sessionId }));

      setStatus("recording");
      setUiPhase("listening");
      // ya no necesitamos limpiar estos estados
      // setLastSegment(null);
      // setSegments([]);
      // setTranscriptInfo({ language: "es", duration: 0 });
    } catch (e) {
      setStatus("error: mic permissions");
      setSpeaking(false);
      speakingRef.current = false;
      console.error(e);
      if (socketRef.current && socketRef.current.readyState === 1) {
        socketRef.current.send(JSON.stringify({ type: "stop", sessionId }));
      }
    }
  }

  function stop() {
    if (status !== "recording") return;

    if (socketRef.current && socketRef.current.readyState === 1) {
      socketRef.current.send(JSON.stringify({ type: "stop", sessionId }));
    }

    if (finalTimeoutRef.current) clearTimeout(finalTimeoutRef.current);
    finalTimeoutRef.current = setTimeout(() => {
      console.warn("Timeout: El servidor no envió 'isFinal'. Forzando cierre.");
      waitingFinalRef.current = false;
      closeWS();
      setSessionId((n) => n + 1);
      setUiPhase("idle");
      setLatestTranscript({ error: "Timeout: El servidor tardó demasiado en responder." }); // Muestra error
    }, 300000); // 5 minutos (300000 ms) de gracia para tu CPU
    waitingFinalRef.current = true;

    // Cortar audio
    const { ctx, stream, scriptProcessor } = audioRef.current;
    if (scriptProcessor) { scriptProcessor.disconnect(); scriptProcessor.onaudioprocess = null; }
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx && ctx.state !== "closed") ctx.close();
    audioRef.current = { ctx: null, analyser: null, source: null, stream: null, scriptProcessor: null };

    setStatus("stopped");
    setUiPhase("processing"); 
    setSpeaking(false);
    speakingRef.current = false;
  }

  // Bucle de dibujo
  useEffect(() => {
    if (status !== "recording") {
      speakingRef.current = false;
      const canvas = canvasRef.current;
      if (canvas) { const c = canvas.getContext("2d"); c.clearRect(0, 0, canvas.width, canvas.height); }
      return;
    }
    const { analyser } = audioRef.current;
    const canvas = canvasRef.current;
    if (!analyser || !canvas) return;
    const c = canvas.getContext("2d");
    const data = new Uint8Array(analyser.fftSize);
    let animationFrameId;
    function loop() {
      analyser.getByteTimeDomainData(data);
      let energy = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; energy += v * v; }
      energy = Math.sqrt(energy / data.length);
      
      const newSpeaking = energy > 0.01; 
      if (newSpeaking !== speakingRef.current) { speakingRef.current = newSpeaking; setSpeaking(newSpeaking); }
      const rms = energy;
      c.clearRect(0, 0, canvas.width, canvas.height);
      c.fillStyle = "#999"; c.fillRect(0, 0, canvas.width, canvas.height);
      const h = Math.max(4, rms * canvas.height);
      c.fillStyle = newSpeaking ? "#0f0" : "#444"; 

      c.fillRect(0, canvas.height - h, canvas.width, h);
      animationFrameId = requestAnimationFrame(loop);
    }
    loop();
    return () => { cancelAnimationFrame(animationFrameId); };
  }, [status]);

  // Limpieza al desmontar
  useEffect(() => {
    return () => {
      try { if (status === "recording") stop(); } catch {}
      closeWS();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ===============================================
  // ===== RENDER (Dos Columnas) =====
  // ===============================================

  return (
    <div style={{ padding: 24, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, maxWidth: 1200, margin: "0 auto" }}>

      {/* ===== COLUMNA 1: CONTROLES ===== */}
      <div>
        <h1>Mic Check & Save</h1>
        <p>Estado: {status} · Sesión actual: <b>session{sessionId}</b></p>
        <div style={{ display: "flex", gap: 12 }}>
          <button onClick={start} disabled={status === "recording"}>Start</button>
          <button onClick={stop} disabled={status !== "recording"}>Stop</button>
        </div>
        <p style={{ color: speaking ? "lime" : "gray", margin: 0, fontSize: "1.2em", fontWeight: "bold" }}>
          {speaking ? "Hablando..." : "Silencio"}
        </p>
        <canvas ref={canvasRef} width={400} height={120} style={{ background: "#111", border: "1px solid #333", borderRadius: 8, marginTop: 8 }} />
        <p style={{ opacity: 0.75 }}>Habla cerca del mic. La barra verde debe subir cuando hablas.</p>

        {/* ===== INICIO DEL CAMBIO ===== */}
        {/*
          EL "CUADRADO" IZQUIERDO (Estado en vivo) HA SIDO ELIMINADO
        */}
        {/* ===== FIN DEL CAMBIO ===== */}
        
        {/* Mostramos un estado simple de la UI */}
        <div style={{ marginTop: 12, padding: 12, background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, minHeight: 60 }}>
          {uiPhase === "idle" && (<div style={{ color: "#bbb" }}>Listo para grabar.</div>)}
          {uiPhase === "listening" && (<div style={{ color: "deepskyblue", fontWeight: 600 }}>Escuchando…</div>)}
          {uiPhase === "processing" && (<div style={{ color: "orange", fontWeight: 600 }}>Transcribiendo... (Esperando al servidor)</div>)}
          {uiPhase === "done" && (<div style={{ color: "lime", fontWeight: 600 }}>¡Completado! Resultado a la derecha.</div>)}
        </div>
        
      </div>

      {/* ===== COLUMNA 2: RESULTADO FINAL (Estilo Apple) ===== */}
      <div>
        <TranscriptWindow transcriptData={latestTranscript} uiPhase={uiPhase} />
      </div>

    </div>
  );
}


/**
 * La "Ventana" estilo Apple para el resultado
 */
function TranscriptWindow({ transcriptData, uiPhase }) {
  return (
    <div style={{
      width: "100%",
      height: "calc(100vh - 48px)",
      maxHeight: 800,
      minHeight: 400,
      background: "#0b0b0b",
      border: "1px solid #2a2a2a",
      borderRadius: 8,
      display: "flex",
      flexDirection: "column",
      boxShadow: "0 4px 12px rgba(0,0,0,0.3)"
    }}>
      {/* Barra de título de Apple */}
      <div style={{
        padding: "8px 12px",
        borderBottom: "1px solid #2a2a2a",
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexShrink: 0
      }}>
        <span style={{ width: 12, height: 12, background: "#ff5f56", borderRadius: "50%" }}></span>
        <span style={{ width: 12, height: 12, background: "#ffbd2e", borderRadius: "50%" }}></span>
        <span style={{ width: 12, height: 12, background: "#27c93f", borderRadius: "50%" }}></span>
        <span style={{ color: "#aaa", fontSize: 13, marginLeft: "auto", marginRight: "auto", position: "relative", left: -24 }}>
          transcript.json
        </span>
      </div>

      {/* Contenido */}
      <div style={{
        padding: 12,
        flexGrow: 1,
        overflowY: "auto",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace",
        fontSize: 12,
        lineHeight: 1.5,
      }}>
        {/* Lógica para mostrar el contenido */}
        {transcriptData && !transcriptData.error ? (
          // 1. Si TENEMOS un JSON final, lo mostramos
          <TranscriptViewer transcriptData={transcriptData} />
        ) : transcriptData && transcriptData.error ? (
          // 2. Si recibimos un OBJETO DE ERROR
          <div style={{ color: "#ff8080", padding: 8, display: "flex", alignItems: "center", justifyContent: "center", height: "100%", whiteSpace: "pre-wrap" }}>
            {`Error del servidor: ${transcriptData.error}`}
          </div>
        ) : uiPhase === "processing" || (uiPhase === "done" && !transcriptData) ? (
          // 3. Si NO hay JSON, pero estamos procesando (esperando al CPU)
          <div style={{ color: "orange", padding: 8, display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
            Transcribiendo en el servidor (CPU)...
          </div>
        ) : uiPhase === "listening" ? (
          // 4. Si estamos escuchando
          <div style={{ color: "deepskyblue", padding: 8, display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
            Escuchando...
          </div>
        ) : (
          // 5. Si estamos inactivos
          <div style={{ color: "#666", padding: 8, display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
            Presiona "Start" para grabar. El resultado final aparecerá aquí.
          </div>
        )}
      </div>
    </div>
  );
}


/**
 * Componente de Visor (sin cambios)
 */
function TranscriptViewer({ transcriptData }) {
  if (!transcriptData) return <div style={{ color: "#666", padding: 8 }}>No hay datos.</div>;
  if (transcriptData.error) return <div style={{ color: "#ff8080", padding: 8 }}>Error: {transcriptData.error}</div>;
  
  const data = transcriptData; 
  const segments = data.segments || [];
  const fullText = data.text || "";

  const formatTime = (seconds) => {
    if (typeof seconds !== 'number' || isNaN(seconds)) return "??:??";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  if (segments.length === 0 && fullText) {
    return <div style={{ color: "#eee", whiteSpace: "pre-wrap" }}>{fullText}</div>;
  }
  if (segments.length === 0) {
     return <div style={{ color: "#666", padding: 8 }}>Sin segmentos.</div>;
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ color: "#aaa", fontSize: 10, borderBottom: "1px solid #333", paddingBottom: 8 }}>
        Idioma detectado: {data.language || 'desconocido'}
      </div>
      {segments.map((seg, index) => (
        <div key={seg.id || index} style={{ display: "flex", gap: 10, lineHeight: 1.5 }}>
          <div style={{ color: "#8aa", flexShrink: 0, width: 80, userSelect: "none" }}>
            [{formatTime(seg.start)} – {formatTime(seg.end)}]
          </div>
          <div style={{ color: "#eee", whiteSpace: "pre-wrap" }}>
            {seg.text ? seg.text.trim() : "..."}
          </div>
        </div>
      ))}
    </div>
  );
}
