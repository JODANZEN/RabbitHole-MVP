/**
 * RabbitHole — Gemini Live (real-time voice) engine.
 *
 * Opens a WebSocket to the Gemini Live API, streams 16 kHz PCM mic audio up,
 * and plays 24 kHz PCM audio down. Uses ScriptProcessorNode for capture (no
 * AudioWorklet module file needed — simpler inside a content script).
 */

const MODEL = 'models/gemini-2.5-flash-native-audio-latest';
const WS_URL = (key: string) =>
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${key}`;

export interface LiveCallbacks {
  onState: (s: 'connecting' | 'listening' | 'speaking' | 'off') => void;
  onUserText?: (t: string) => void;
  onTutorText?: (t: string) => void;
  onTurnComplete?: () => void;
  onError: (e: string) => void;
}

let ws: WebSocket | null = null;
let inputCtx: AudioContext | null = null;
let outputCtx: AudioContext | null = null;
let micStream: MediaStream | null = null;
let processor: ScriptProcessorNode | null = null;
let sources: AudioBufferSourceNode[] = [];
let playHead = 0;
let running = false;

export function isLiveRunning() { return running; }

// ── audio helpers ────────────────────────────────────────────────────
function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}
function downsample(buffer: Float32Array, inRate: number, outRate: number): Float32Array {
  if (outRate >= inRate) return buffer;
  const ratio = inRate / outRate;
  const newLen = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const start = Math.round(i * ratio);
    const end = Math.min(Math.round((i + 1) * ratio), buffer.length);
    let sum = 0, c = 0;
    for (let j = start; j < end; j++) { sum += buffer[j]; c++; }
    result[i] = c ? sum / c : 0;
  }
  return result;
}
function b64encode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}

// ── playback ─────────────────────────────────────────────────────────
function playPCM(b64: string) {
  if (!outputCtx) return;
  const bytes = b64decode(b64);
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const f32 = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
  const buf = outputCtx.createBuffer(1, f32.length, 24000);
  buf.copyToChannel(f32, 0);
  const src = outputCtx.createBufferSource();
  src.buffer = buf;
  src.connect(outputCtx.destination);
  const now = outputCtx.currentTime;
  if (playHead < now) playHead = now;
  src.start(playHead);
  playHead += buf.duration;
  sources.push(src);
  src.onended = () => { sources = sources.filter((s) => s !== src); };
}
function stopPlayback() {
  for (const s of sources) { try { s.stop(); } catch { /* */ } }
  sources = [];
  if (outputCtx) playHead = outputCtx.currentTime;
}

// ── capture ──────────────────────────────────────────────────────────
async function startMic() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  inputCtx = new AudioContext();
  const src = inputCtx.createMediaStreamSource(micStream);
  processor = inputCtx.createScriptProcessor(4096, 1, 1);
  src.connect(processor);
  // ScriptProcessor only fires when connected to a destination; route through a muted gain.
  const mute = inputCtx.createGain();
  mute.gain.value = 0;
  processor.connect(mute);
  mute.connect(inputCtx.destination);

  processor.onaudioprocess = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const input = e.inputBuffer.getChannelData(0);
    const down = downsample(input, inputCtx!.sampleRate, 16000);
    const pcm = floatTo16BitPCM(down);
    const b64 = b64encode(new Uint8Array(pcm.buffer));
    ws.send(JSON.stringify({
      realtimeInput: { mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: b64 }] },
    }));
  };
}

// ── public API ───────────────────────────────────────────────────────
export async function startLive(apiKey: string, systemInstruction: string, cb: LiveCallbacks) {
  if (running) return;
  running = true;
  cb.onState('connecting');

  try {
    outputCtx = new AudioContext({ sampleRate: 24000 });
    await outputCtx.resume();
    playHead = outputCtx.currentTime;
  } catch {
    outputCtx = new AudioContext();
  }

  ws = new WebSocket(WS_URL(apiKey));
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    ws!.send(JSON.stringify({
      setup: {
        model: MODEL,
        generationConfig: { responseModalities: ['AUDIO'] },
        systemInstruction: { parts: [{ text: systemInstruction }] },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    }));
  };

  ws.onmessage = async (ev) => {
    const text = ev.data instanceof ArrayBuffer ? new TextDecoder().decode(ev.data) : ev.data;
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }

    if (msg.setupComplete) {
      try { await startMic(); cb.onState('listening'); }
      catch (e: any) { cb.onError('Microphone blocked on this page. Try another page or allow mic access.'); stopLive(); }
      return;
    }
    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.interrupted) stopPlayback();
    if (sc.inputTranscription?.text) cb.onUserText?.(sc.inputTranscription.text);
    if (sc.outputTranscription?.text) cb.onTutorText?.(sc.outputTranscription.text);
    for (const p of (sc.modelTurn?.parts || [])) {
      if (p.inlineData?.data) { playPCM(p.inlineData.data); cb.onState('speaking'); }
    }
    if (sc.turnComplete) { cb.onTurnComplete?.(); cb.onState('listening'); }
  };

  ws.onerror = () => cb.onError('Live connection error — check your network or Gemini key.');
  ws.onclose = (e) => {
    if (running && e.code !== 1000) cb.onError(e.reason || `Live closed (code ${e.code}).`);
    cleanup();
  };
}

export function stopLive() {
  running = false;
  cleanup();
}

function cleanup() {
  try { ws?.close(); } catch { /* */ }
  ws = null;
  try { processor?.disconnect(); } catch { /* */ }
  processor = null;
  try { micStream?.getTracks().forEach((t) => t.stop()); } catch { /* */ }
  micStream = null;
  try { inputCtx?.close(); } catch { /* */ }
  inputCtx = null;
  stopPlayback();
  try { outputCtx?.close(); } catch { /* */ }
  outputCtx = null;
}
