const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const orb = document.getElementById("orb");
const state = document.getElementById("state");
const hint = document.getElementById("hint");
const connection = document.getElementById("connection");
const coreStatus = document.getElementById("coreStatus");
const voiceStatus = document.getElementById("voiceStatus");
const settingsDialog = document.getElementById("settingsDialog");
const tokenInput = document.getElementById("tokenInput");
const activationMode = document.getElementById("activationMode");

let recognition;
let isSpeaking = false;
let armed = false;
let pendingConfirmation = null;
let audioPlayer = null;
let lastMonitorEvent = localStorage.getItem("shopia.lastMonitorEvent") || "";

const settings = {
  get token() { return localStorage.getItem("shopia.token") || ""; },
  get activation() { return localStorage.getItem("shopia.activation") || "wake"; }
};

function setState(value, detail = "") {
  state.textContent = value;
  hint.textContent = detail || "Toque no núcleo ou diga “S.H.O.P.I.A”";
  orb.className = "orb " + value.toLowerCase().replace("processando", "thinking").replace("ouvindo", "listening").replace("falando", "speaking");
}

async function speak(text) {
  isSpeaking = true;
  recognition?.stop();
  setState("FALANDO", "Resposta de voz em andamento");
  try {
    if (settings.token) {
      const response = await fetch("/api/voice/speak", {
        method: "POST",
        headers: {"Content-Type": "application/json", "Authorization": `Bearer ${settings.token}`},
        body: JSON.stringify({text})
      });
      if (response.ok) {
        const url = URL.createObjectURL(await response.blob());
        audioPlayer = new Audio(url);
        await new Promise((resolve, reject) => {
          audioPlayer.onended = resolve;
          audioPlayer.onerror = reject;
          audioPlayer.play().catch(reject);
        });
        URL.revokeObjectURL(url);
      } else throw new Error("tts offline");
    } else throw new Error("no token");
  } catch (_) {
    await new Promise(resolve => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "pt-BR";
      utterance.rate = 1.02;
      utterance.onend = resolve;
      utterance.onerror = resolve;
      speechSynthesis.cancel();
      speechSynthesis.speak(utterance);
    });
  } finally {
    isSpeaking = false;
    audioPlayer = null;
    setState("AGUARDANDO");
    if (settings.activation === "wake") startListening();
  }
}

function interruptSpeech() {
  if (!isSpeaking) return;
  speechSynthesis.cancel();
  audioPlayer?.pause();
  isSpeaking = false;
  setState("OUVINDO", "Fala interrompida");
}

async function api(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: {"Content-Type": "application/json", "Authorization": `Bearer ${settings.token}`},
    body: JSON.stringify(body)
  });
  if (response.status === 401) {
    settingsDialog.showModal();
    throw new Error("Token inválido");
  }
  if (!response.ok) throw new Error("Falha de comunicação");
  return response.json();
}

async function processCommand(text) {
  const normalized = text.toLocaleLowerCase("pt-BR").trim();
  if (pendingConfirmation) {
    const approved = /^(sim|confirmo|pode|pode executar|autorizo)\b/.test(normalized);
    const denied = /^(nao|não|cancele|cancelar)\b/.test(normalized);
    if (!approved && !denied) {
      await speak("Responda sim para confirmar ou não para cancelar.");
      return;
    }
    setState("EXECUTANDO", "Aplicando sua decisão");
    const result = await api("/api/confirm", {confirmation_token: pendingConfirmation, approved});
    pendingConfirmation = null;
    await speak(result.speech);
    return;
  }
  setState("PROCESSANDO", "Interpretando e consultando os serviços necessários");
  try {
    const result = await api("/api/command", {
      text,
      channel: /Android/i.test(navigator.userAgent) ? "android" : "windows",
      device_id: localStorage.getItem("shopia.device") || crypto.randomUUID(),
      user_id: "owner"
    });
    if (result.status === "needs_confirmation") pendingConfirmation = result.confirmation_token;
    await speak(result.speech);
  } catch (error) {
    await speak("Não consegui me comunicar com o núcleo. Verifique as configurações e a conexão.");
  }
}

function handleTranscript(transcript) {
  const clean = transcript.trim();
  const wake = /\b(shopia|s h o p i a)\b/i;
  if (settings.activation === "touch" && !armed) return;
  if (!armed && !wake.test(clean)) return;
  let command = clean.replace(wake, "").replace(/^[,.:;\s]+/, "").trim();
  if (!armed && !command) {
    armed = true;
    speak("Estou ouvindo.");
    return;
  }
  armed = false;
  if (command) processCommand(command);
}

function startListening() {
  if (!recognition || isSpeaking) return;
  try { recognition.start(); } catch (_) {}
}

function setupRecognition() {
  if (!SpeechRecognition) {
    voiceStatus.textContent = "TOQUE PARA FALAR";
    hint.textContent = "Este navegador não oferece escuta contínua";
    return;
  }
  recognition = new SpeechRecognition();
  recognition.lang = "pt-BR";
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.onstart = () => {
    voiceStatus.textContent = "ATIVA";
    if (armed) setState("OUVINDO", "Pode falar");
  };
  recognition.onresult = event => {
    const transcript = event.results[event.results.length - 1][0].transcript;
    handleTranscript(transcript);
  };
  recognition.onend = () => {
    if (!isSpeaking && settings.activation === "wake") setTimeout(startListening, 500);
  };
  recognition.onerror = event => {
    if (event.error === "not-allowed") voiceStatus.textContent = "SEM PERMISSÃO";
  };
  if (settings.activation === "wake") startListening();
}

orb.addEventListener("click", () => {
  interruptSpeech();
  armed = true;
  setState("OUVINDO", "Pode falar");
  startListening();
});
document.getElementById("settingsButton").addEventListener("click", () => {
  tokenInput.value = settings.token;
  activationMode.value = settings.activation;
  settingsDialog.showModal();
});
document.getElementById("saveSettings").addEventListener("click", event => {
  event.preventDefault();
  localStorage.setItem("shopia.token", tokenInput.value.trim());
  localStorage.setItem("shopia.activation", activationMode.value);
  settingsDialog.close();
  location.reload();
});

async function initialize() {
  if (!localStorage.getItem("shopia.device")) localStorage.setItem("shopia.device", crypto.randomUUID());
  if (!settings.token) {
    try {
      const response = await fetch("/api/bootstrap");
      const bootstrap = response.ok ? await response.json() : null;
      if (bootstrap?.token) localStorage.setItem("shopia.token", bootstrap.token);
    } catch (_) {}
  }
  try {
    const health = await fetch("/api/health").then(r => r.json());
    connection.textContent = "ONLINE";
    coreStatus.textContent = health.ai_provider === "local" ? "IA LOCAL" : (health.ai_configured ? "IA CONECTADA" : "AGUARDA CHAVE");
  } catch (_) {
    connection.textContent = "OFFLINE";
    coreStatus.textContent = "INDISPONÍVEL";
  }
  setupRecognition();
  setState("AGUARDANDO");
  if (!settings.token) settingsDialog.showModal();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/service-worker.js");
  setInterval(checkMonitor, 30000);
}

async function checkMonitor() {
  if (!settings.token || isSpeaking) return;
  try {
    const response = await fetch("/api/monitor", {headers: {"Authorization": `Bearer ${settings.token}`}});
    if (!response.ok) return;
    const data = await response.json();
    const latest = data.events?.[data.events.length - 1];
    if (latest && latest.id !== lastMonitorEvent) {
      lastMonitorEvent = latest.id;
      localStorage.setItem("shopia.lastMonitorEvent", latest.id);
      await speak(`Pedro, detectei uma situação importante. ${latest.speech}`);
    }
  } catch (_) {}
}

initialize();
