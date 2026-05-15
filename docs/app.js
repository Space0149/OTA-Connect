const loginButton = document.getElementById("loginButton");
const joinButton = document.getElementById("joinButton");
const roomInput = document.getElementById("roomInput");
const serverInput = document.getElementById("serverInput");
const joinPanel = document.getElementById("joinPanel");
const chatShell = document.getElementById("chatShell");
const profileRow = document.getElementById("profileRow");
const profileAvatar = document.getElementById("profileAvatar");
const profileName = document.getElementById("profileName");
const joinError = document.getElementById("joinError");
const roomTitle = document.getElementById("roomTitle");
const connectionStatus = document.getElementById("connectionStatus");
const messages = document.getElementById("messages");
const transcript = document.getElementById("transcript");
const messageForm = document.getElementById("messageForm");
const messageInput = document.getElementById("messageInput");
const typingStatus = document.getElementById("typingStatus");
const leaveButton = document.getElementById("leaveButton");
const voiceButton = document.getElementById("voiceButton");
const muteButton = document.getElementById("muteButton");
const voiceStatus = document.getElementById("voiceStatus");
const remoteAudio = document.getElementById("remoteAudio");

let serverUrl = localStorage.getItem("ota.web.serverUrl") || "";
let sessionToken = localStorage.getItem("ota.web.sessionToken") || "";
let currentUser = null;
let currentRoomId = "";
let socket = null;
let typingTimer = null;
let localVoiceStream = null;
let voiceActive = false;
let voiceMuted = false;
let voiceStarting = false;
const typingUsers = new Map();
const voicePeers = new Map();
let rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

serverInput.value = serverUrl;

function normalizeServerUrl(value) {
  return value.trim().replace(/\/+$/, "");
}

function setServerUrl(value) {
  serverUrl = normalizeServerUrl(value);
  serverInput.value = serverUrl;
  localStorage.setItem("ota.web.serverUrl", serverUrl);
}

function formatTime(iso) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(iso));
}

function setError(message) {
  joinError.textContent = message || "";
}

function setConnectionStatus(status) {
  connectionStatus.textContent = status;
  connectionStatus.className = "status-pill";
  if (status === "Connected") connectionStatus.classList.add("connected");
  if (status === "Reconnecting") connectionStatus.classList.add("reconnecting");
}

function renderProfile(user) {
  currentUser = user;
  profileAvatar.src = user.avatar;
  profileName.textContent = user.username;
  profileRow.classList.remove("hidden");
}

function addTranscriptLine({ timestamp, username, message }) {
  const line = document.createElement("div");
  line.className = "log-line";
  line.innerHTML = `
    <span class="log-time">${formatTime(timestamp)}</span>
    <span class="log-user"></span>
    <span class="log-message"></span>
  `;
  line.querySelector(".log-user").textContent = username;
  line.querySelector(".log-message").textContent = message;
  transcript.appendChild(line);
  transcript.scrollTop = transcript.scrollHeight;
}

function addSystemLog(message) {
  addTranscriptLine({ timestamp: new Date().toISOString(), username: "system", message });
}

function addMessage(payload) {
  const item = document.createElement("article");
  item.className = "message";
  item.innerHTML = `
    <img class="avatar" alt="" />
    <div>
      <div class="message-meta">
        <strong></strong>
        <span>${formatTime(payload.timestamp)}</span>
      </div>
      <div class="message-body"></div>
    </div>
  `;
  item.querySelector(".avatar").src = payload.user.avatar;
  item.querySelector("strong").textContent = payload.user.username;
  item.querySelector(".message-body").textContent = payload.message;
  messages.appendChild(item);
  messages.scrollTop = messages.scrollHeight;

  addTranscriptLine({
    timestamp: payload.timestamp,
    username: payload.user.username,
    message: payload.message
  });
}

function updateTypingStatus() {
  const names = [...typingUsers.values()];
  if (names.length === 0) typingStatus.textContent = "No one is typing";
  else if (names.length === 1) typingStatus.textContent = `${names[0]} is typing`;
  else typingStatus.textContent = `${names.join(", ")} are typing`;
}

function setVoiceStatus(message) {
  voiceStatus.textContent = message;
}

async function ensureLocalVoiceStream() {
  if (localVoiceStream) return localVoiceStream;
  localVoiceStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: false
  });
  localVoiceStream.getAudioTracks().forEach((track) => {
    track.enabled = !voiceMuted;
  });
  return localVoiceStream;
}

function removeVoicePeer(peerSocketId) {
  const peer = voicePeers.get(peerSocketId);
  if (!peer) return;
  peer.pc.close();
  peer.audio?.remove();
  voicePeers.delete(peerSocketId);
  setVoiceStatus(voicePeers.size === 0 && voiceActive ? "Voice connected" : `${voicePeers.size + 1} in voice`);
}

function createVoicePeer(peerSocketId, user) {
  const existing = voicePeers.get(peerSocketId);
  if (existing) return existing.pc;

  const pc = new RTCPeerConnection(rtcConfig);
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.playsInline = true;
  remoteAudio.appendChild(audio);

  localVoiceStream?.getTracks().forEach((track) => pc.addTrack(track, localVoiceStream));

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket?.emit("voice:signal", {
        targetSocketId: peerSocketId,
        signal: { type: "candidate", candidate: event.candidate }
      });
    }
  };

  pc.ontrack = (event) => {
    audio.srcObject = event.streams[0];
    audio.play().catch(() => {});
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
      removeVoicePeer(peerSocketId);
    }
  };

  voicePeers.set(peerSocketId, { pc, audio, user });
  setVoiceStatus(`${voicePeers.size + 1} in voice`);
  return pc;
}

async function callVoicePeer(participant) {
  const pc = createVoicePeer(participant.socketId, participant.user);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit("voice:signal", {
    targetSocketId: participant.socketId,
    signal: { type: "offer", description: pc.localDescription }
  });
}

async function handleVoiceSignal(payload) {
  if (!voiceActive || !payload?.fromSocketId || !payload.signal) return;
  await ensureLocalVoiceStream();

  const pc = createVoicePeer(payload.fromSocketId, payload.fromUser);
  const { signal } = payload;

  if (signal.type === "offer") {
    await pc.setRemoteDescription(new RTCSessionDescription(signal.description));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("voice:signal", {
      targetSocketId: payload.fromSocketId,
      signal: { type: "answer", description: pc.localDescription }
    });
    return;
  }

  if (signal.type === "answer") {
    await pc.setRemoteDescription(new RTCSessionDescription(signal.description));
    return;
  }

  if (signal.type === "candidate" && signal.candidate) {
    await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
  }
}

async function startVoice() {
  if (voiceActive || voiceStarting) return;
  if (!currentRoomId) {
    addSystemLog("Join a room before starting voice");
    return;
  }
  if (!socket?.connected) {
    addSystemLog("Voice requires an active room connection");
    return;
  }

  try {
    voiceStarting = true;
    setVoiceStatus("Starting voice");
    await ensureLocalVoiceStream();
    socket.emit("voice:join", null, async (response) => {
      voiceStarting = false;
      if (!response?.ok) {
        addSystemLog(response?.error || "Voice failed to start");
        setVoiceStatus("Voice idle");
        return;
      }

      voiceActive = true;
      voiceButton.textContent = "Leave Voice";
      voiceButton.classList.add("active");
      muteButton.classList.remove("hidden");
      setVoiceStatus(response.participants.length === 0 ? "Voice connected" : `${response.participants.length + 1} in voice`);
      addSystemLog("Joined voice");

      for (const participant of response.participants) {
        await callVoicePeer(participant);
      }
    });
  } catch (error) {
    voiceStarting = false;
    addSystemLog(`Voice error: ${error.message}`);
    setVoiceStatus("Voice blocked");
  }
}

function stopVoice(announce = true) {
  voiceStarting = false;
  if (announce && socket?.connected && voiceActive) socket.emit("voice:leave");
  for (const peerSocketId of [...voicePeers.keys()]) removeVoicePeer(peerSocketId);
  localVoiceStream?.getTracks().forEach((track) => track.stop());
  localVoiceStream = null;
  voiceActive = false;
  voiceMuted = false;
  voiceButton.textContent = "Join Voice";
  voiceButton.classList.remove("active");
  muteButton.textContent = "Mute";
  muteButton.classList.add("hidden");
  muteButton.classList.remove("active");
  setVoiceStatus("Voice idle");
}

function toggleMute() {
  if (!localVoiceStream) return;
  voiceMuted = !voiceMuted;
  localVoiceStream.getAudioTracks().forEach((track) => {
    track.enabled = !voiceMuted;
  });
  muteButton.textContent = voiceMuted ? "Unmute" : "Mute";
  muteButton.classList.toggle("active", voiceMuted);
  addSystemLog(voiceMuted ? "Microphone muted" : "Microphone unmuted");
}

function joinRoom(roomId, { resetFeed = true, logMessage = `Joined room ${roomId}` } = {}) {
  if (!socket) return;

  socket.emit("room:join", roomId, (response) => {
    if (!response?.ok) {
      setError(response?.error || "Could not join room.");
      return;
    }

    currentRoomId = response.roomId;
    roomTitle.textContent = `Room ${response.roomId}`;

    if (resetFeed) {
      messages.innerHTML = "";
      transcript.innerHTML = "";
      typingUsers.clear();
      updateTypingStatus();
    }

    if (logMessage) addSystemLog(logMessage);
    joinPanel.classList.add("hidden");
    chatShell.classList.remove("hidden");
    messageInput.focus();
  });
}

async function loadMe(token) {
  const response = await fetch(`${serverUrl}/me`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error("Session expired. Please login again.");
  const data = await response.json();
  renderProfile(data.user);
}

async function loadServerConfig() {
  const response = await fetch(`${serverUrl}/config`);
  if (!response.ok) throw new Error("Could not load server config.");
  const data = await response.json();
  if (Array.isArray(data.rtcIceServers) && data.rtcIceServers.length > 0) {
    rtcConfig = { iceServers: data.rtcIceServers };
  }
}

function connectSocket() {
  if (typeof io !== "function") {
    setError("Socket.IO client failed to load.");
    return;
  }

  if (socket) socket.disconnect();

  socket = io(serverUrl, {
    auth: { token: sessionToken },
    transports: ["websocket", "polling"],
    reconnection: true
  });

  socket.on("connect", () => {
    setConnectionStatus("Connected");
    if (currentRoomId) {
      joinRoom(currentRoomId, {
        resetFeed: false,
        logMessage: `Reconnected to room ${currentRoomId}`
      });
    }
  });
  socket.on("disconnect", () => {
    setConnectionStatus("Disconnected");
    stopVoice(false);
  });
  socket.io.on("reconnect_attempt", () => setConnectionStatus("Reconnecting"));
  socket.on("connect_error", (error) => setError(error.message));
  socket.on("message:new", addMessage);
  socket.on("room:user-joined", (payload) => addSystemLog(`${payload.user.username} joined ${payload.roomId}`));
  socket.on("room:user-left", (payload) => addSystemLog(`${payload.user.username} left ${payload.roomId}`));
  socket.on("typing:update", (payload) => {
    if (payload.typing) typingUsers.set(payload.user.discordId, payload.user.username);
    else typingUsers.delete(payload.user.discordId);
    updateTypingStatus();
  });
  socket.on("voice:user-joined", (payload) => addSystemLog(`${payload.user.username} joined voice`));
  socket.on("voice:user-left", (payload) => {
    removeVoicePeer(payload.socketId);
    addSystemLog(`${payload.user.username} left voice`);
  });
  socket.on("voice:signal", (payload) => {
    handleVoiceSignal(payload).catch((error) => addSystemLog(`Voice signal error: ${error.message}`));
  });
}

async function acceptToken(token) {
  sessionToken = token;
  localStorage.setItem("ota.web.sessionToken", token);
  await loadMe(token);
  connectSocket();
}

function consumeTokenFromUrl() {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token");
  if (!token) return;

  url.searchParams.delete("token");
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
  void acceptToken(token).catch((error) => {
    localStorage.removeItem("ota.web.sessionToken");
    setError(error.message);
  });
}

loginButton.addEventListener("click", () => {
  setError("");
  const nextServerUrl = normalizeServerUrl(serverInput.value);
  if (!nextServerUrl) {
    setError("Enter your backend URL first.");
    return;
  }
  setServerUrl(nextServerUrl);

  const returnTo = `${window.location.origin}${window.location.pathname}`;
  window.location.href = `${serverUrl}/auth/discord?returnTo=${encodeURIComponent(returnTo)}`;
});

joinButton.addEventListener("click", async () => {
  const nextServerUrl = normalizeServerUrl(serverInput.value);
  if (!nextServerUrl) {
    setError("Enter your backend URL first.");
    return;
  }
  if (nextServerUrl !== serverUrl) {
    setServerUrl(nextServerUrl);
    await loadServerConfig().catch((error) => addSystemLog(`Config warning: ${error.message}`));
  }

  const roomId = roomInput.value.trim().toUpperCase();
  if (!currentUser || !sessionToken) {
    setError("Login with Discord first.");
    return;
  }
  if (!roomId) {
    setError("Enter a Room ID.");
    return;
  }
  setError("");
  if (!socket || !socket.connected) connectSocket();
  joinRoom(roomId);
});

leaveButton.addEventListener("click", () => {
  stopVoice();
  socket?.emit("room:leave");
  currentRoomId = "";
  chatShell.classList.add("hidden");
  joinPanel.classList.remove("hidden");
});

voiceButton.addEventListener("click", () => {
  if (voiceActive) stopVoice();
  else startVoice();
});

muteButton.addEventListener("click", toggleMute);

messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = messageInput.value.trim();
  if (!message) return;

  socket.emit("message:send", { message }, (response) => {
    if (!response?.ok) addSystemLog(response?.error || "Message failed");
  });
  messageInput.value = "";
  socket.emit("typing:stop");
});

messageInput.addEventListener("input", () => {
  if (!socket) return;
  socket.emit("typing:start");
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => socket.emit("typing:stop"), 900);
});

serverInput.addEventListener("change", () => {
  setServerUrl(serverInput.value);
});

async function bootstrap() {
  if (serverUrl) {
    try {
      await loadServerConfig();
    } catch (error) {
      setError(error.message);
    }
  }

  consumeTokenFromUrl();

  if (!sessionToken || !serverUrl) return;
  try {
    await acceptToken(sessionToken);
  } catch (error) {
    localStorage.removeItem("ota.web.sessionToken");
    setError(error.message);
  }
}

bootstrap();
