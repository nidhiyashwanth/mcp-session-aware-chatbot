// public/client.js
console.log("Client script loaded.");

// --- DOM Elements / State Variables / Config (Unchanged) ---
const connectButton = document.getElementById("connectButton");
const recordButton = document.getElementById("recordButton");
const stopButton = document.getElementById("stopButton");
const statusDiv = document.getElementById("status");
const transcriptDiv = document.getElementById("transcript");
const audioPlayer = document.getElementById("audioPlayer");
let peerConnection = null;
let dataChannel = null;
let mediaRecorder = null;
let assistantAudioBuffer = [];
let isRecording = false;
let webSocket = null;
let currentSessionId = null;
let ephemeralToken = null;
let accumulatedAssistantText = "";
let currentAssistantMessageId = null;
let expectingAssistantResponse = false;
let lastUserTranscriptSent = "";
let transcriptBuffer = "";
let transcriptTimeoutId = null;
let realtimeApiHandledResponse = false;
const REALTIME_API_URL = "https://api.openai.com/v1/realtime";
const REALTIME_MODEL = "gpt-4o-mini-realtime-preview-2024-12-17";
const BACKEND_WS_URL = `ws://${window.location.host}/mcp-proxy`;
const USE_MANUAL_COMMIT = false;
const TRANSCRIPT_SEND_DELAY = 500;
const KEEP_ALIVE_INTERVAL = 25000;
let keepAliveIntervalId = null;
let lastDataChannelActivity = Date.now();

// --- Helper Functions (Unchanged) ---
function updateStatus(message, isError = false) {
  /* ... */ console.log(`Status: ${message}`);
  statusDiv.textContent = `Status: ${message}`;
  statusDiv.style.color = isError ? "red" : "#555";
}
function addTranscriptLine(text, type = "status") {
  /* ... */ const line = document.createElement("div");
  line.textContent = text;
  if (type === "user") {
    line.className = "user-message";
    line.textContent = `You: ${text}`;
  } else if (type === "assistant") {
    line.className = "assistant-message";
    line.textContent = `Assistant: ${text}`;
  } else if (type === "error") {
    line.className = "error-message";
    line.textContent = `Error: ${text}`;
  } else {
    line.className = "status-message";
  }
  transcriptDiv.appendChild(line);
  transcriptDiv.scrollTop = transcriptDiv.scrollHeight;
}
async function getEphemeralToken() {
  /* ... */ updateStatus("Requesting token...");
  try {
    const r = await fetch("/session-token");
    if (!r.ok) throw new Error(`Backend error: ${r.statusText}`);
    const d = await r.json();
    if (!d.client_secret?.value) throw new Error("Invalid token response.");
    console.log("Got session obj:", d);
    ephemeralToken = d.client_secret.value;
    updateStatus("Token received.");
    return true;
  } catch (e) {
    console.error("Token fetch error:", e);
    updateStatus(`Token fetch fail: ${e.message}`, true);
    addTranscriptLine(`Session init fail: ${e.message}`, "error");
    return false;
  }
}

// --- WebSocket Functions (Unchanged) ---
function connectWebSocket() {
  /* ... */ return new Promise((resolve, reject) => {
    updateStatus("Connecting backend WS...");
    webSocket = new WebSocket(BACKEND_WS_URL);
    webSocket.onopen = () => {
      console.log("Backend WS open.");
      updateStatus("Connected backend.");
      resolve(true);
    };
    webSocket.onerror = (error) => {
      console.error("Backend WS error:", error);
      updateStatus("Backend WS error.", true);
      addTranscriptLine("Lost backend connection.", "error");
      reject(error);
      cleanupConnections();
    };
    webSocket.onclose = () => {
      console.log("Backend WS closed.");
      updateStatus("Disconnected backend.");
      addTranscriptLine("Disconnected backend.", "status");
      cleanupConnections();
    };
    webSocket.onmessage = (event) => {
      console.log("Received from backend WS:", event.data);
      try {
        const message = JSON.parse(event.data);
        if (message.type === "sessionId" && message.sessionId) {
          currentSessionId = message.sessionId;
          console.log("Received session ID:", currentSessionId);
          updateStatus("Session active.");
          connectButton.disabled = true;
          recordButton.disabled = false;
          stopButton.disabled = true;
        } else if (message.type === "assistant_response" && message.content) {
          console.log("Received assistant text from backend:", message.content);
          addTranscriptLine(message.content, "assistant");
          if (realtimeApiHandledResponse) {
            console.warn(
              "Backend sent text, but Realtime API handled this response turn (ID: ",
              currentAssistantMessageId || "(cleared)",
              "). Prioritizing Realtime API outcome (even if audio failed). Ignoring backend text for TTS."
            );
          } else {
            console.log(
              "Realtime API did not handle response this turn, proceeding with TTS for backend text."
            );
            expectingAssistantResponse = false;
            updateStatus("Received response, synthesizing speech...");
            sendAssistantTextToRealtime(message.content);
          }
        } else if (message.type === "error") {
          addTranscriptLine(`Backend error: ${message.message}`, "error");
          updateStatus(`Backend error: ${message.message}`, true);
          expectingAssistantResponse = false;
          recordButton.disabled = !!currentSessionId;
          stopButton.disabled = true;
        } else if (message.type === "status_update") {
          addTranscriptLine(`Backend: ${message.message}`, "status");
        }
      } catch (e) {
        console.error("Failed parse backend WS msg:", e);
      }
    };
  });
}
function sendMessageToBackend(message) {
  /* ... */ if (
    webSocket &&
    webSocket.readyState === WebSocket.OPEN &&
    currentSessionId
  ) {
    message.sessionId = currentSessionId;
    webSocket.send(JSON.stringify(message));
    console.log("Sent backend WS:", message);
  } else {
    console.error("WS not open/no session ID.");
    addTranscriptLine("Cannot store message. Backend disconnected?", "error");
    updateStatus("Backend disconnected?", true);
    expectingAssistantResponse = false;
    recordButton.disabled = !!currentSessionId;
    stopButton.disabled = true;
  }
}

// --- Function to send assistant text to Realtime API for TTS ---
function sendAssistantTextToRealtime(text) {
  if (dataChannel && dataChannel.readyState === "open") {
    console.log("Sending assistant text to Realtime API for TTS:", text);
    // This message correctly requests both text and audio from the API
    // The audio response will be handled in handleRealtimeEvent via the response.audio.delta events
    const assistantMessageEvent = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "text",
            text: {
              value: text,
              annotations: [], // Include empty annotations as per REST API structure
            },
          },
        ],
      },
    };
    dataChannel.send(JSON.stringify(assistantMessageEvent));
    lastDataChannelActivity = Date.now();
  } else {
    console.error("Data channel not open for TTS request.");
    addTranscriptLine(
      "Cannot generate speech (Realtime connection issue).",
      "error"
    );
    updateStatus("Idle (Realtime Disconnected?).");
    expectingAssistantResponse = false;
    recordButton.disabled = !!currentSessionId;
    stopButton.disabled = true;
  }
}
// ----------------------------------------------------------------------

// --- WebRTC Functions (setupWebRTC unchanged) ---
async function setupWebRTC() {
  /* ... same ... */ if (!ephemeralToken) {
    console.error("No token for WebRTC.");
    return false;
  }
  updateStatus("Setting up WebRTC...");
  try {
    peerConnection = new RTCPeerConnection();
    lastDataChannelActivity = Date.now();

    peerConnection.ontrack = (event) => {
      lastDataChannelActivity = Date.now();
      console.log("Got remote track:", event.track.kind);
      if (event.track.kind === "audio" && audioPlayer) {
        if (!audioPlayer.srcObject) {
          audioPlayer.srcObject = event.streams[0];
          console.log("Attached remote audio track to player.");
        } else {
          console.log("Remote audio track already attached.");
        }
      }
    };

    dataChannel = peerConnection.createDataChannel("oai-events", {
      ordered: true,
    });
    console.log("Data channel created.");

    dataChannel.onmessage = (event) => {
      lastDataChannelActivity = Date.now();
      handleRealtimeEvent(event);
    };
    dataChannel.onopen = () => {
      lastDataChannelActivity = Date.now();
      console.log("Data channel OPEN");
      updateStatus("Realtime connection active.");
      startKeepAlive();
    };
    dataChannel.onclose = () => {
      console.log("Data channel CLOSED");
      updateStatus("Realtime connection closed.");
      stopKeepAlive();
    };
    dataChannel.onerror = (err) => {
      console.error("Data channel error:", err);
      updateStatus("Realtime connection error.", true);
      stopKeepAlive();
    };

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream
      .getTracks()
      .forEach((track) => peerConnection.addTrack(track, stream));
    console.log("Added mic track.");
    lastDataChannelActivity = Date.now();

    peerConnection.onconnectionstatechange = (event) => {
      console.log("WebRTC State:", peerConnection.connectionState);
      lastDataChannelActivity = Date.now();
      switch (peerConnection.connectionState) {
        case "connected":
          updateStatus("WebRTC Connected.");
          break;
        case "disconnected":
          updateStatus("WebRTC Disconnected. Attempting recovery...");
          stopKeepAlive();
          break;
        case "failed":
          updateStatus("WebRTC Failed.", true);
          addTranscriptLine("WebRTC connection failed.", "error");
          stopKeepAlive();
          closeWebRTCSession();
          break;
        case "closed":
          updateStatus("WebRTC Closed.");
          stopKeepAlive();
          closeWebRTCSession();
          break;
        default:
          updateStatus(`WebRTC state: ${peerConnection.connectionState}`);
      }
    };
    peerConnection.oniceconnectionstatechange = (event) => {
      lastDataChannelActivity = Date.now();
      console.log("ICE State:", peerConnection.iceConnectionState);
    };
    peerConnection.onicegatheringstatechange = (event) => {
      lastDataChannelActivity = Date.now();
      console.log("ICE Gathering State:", peerConnection.iceGatheringState);
    };

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    console.log("Local SDP created.");
    lastDataChannelActivity = Date.now();

    const sdpResponse = await fetch(
      `${REALTIME_API_URL}?model=${REALTIME_MODEL}`,
      {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${ephemeralToken}`,
          "Content-Type": "application/sdp",
        },
      }
    );

    if (!sdpResponse.ok) {
      const errorText = await sdpResponse.text();
      throw new Error(`OpenAI SDP fail (${sdpResponse.status}): ${errorText}`);
    }
    const answerSdp = await sdpResponse.text();
    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: answerSdp,
    });
    lastDataChannelActivity = Date.now();
    console.log(
      "WebRTC setup complete, state:",
      peerConnection.connectionState
    );
    return true;
  } catch (error) {
    console.error("WebRTC Setup Error:", error);
    updateStatus(`WebRTC fail: ${error.message}`, true);
    addTranscriptLine(`Realtime connect fail: ${error.message}`, "error");
    closeWebRTCSession();
    return false;
  }
}

// --- Keep-Alive Functions ---
function startKeepAlive() {
  stopKeepAlive();
  console.log(`Starting keep-alive ping every ${KEEP_ALIVE_INTERVAL}ms`);
  keepAliveIntervalId = setInterval(() => {
    if (dataChannel && dataChannel.readyState === "open") {
      const now = Date.now();
      if (now - lastDataChannelActivity > KEEP_ALIVE_INTERVAL) {
        console.log("Sending WebRTC keep-alive ping.");
        dataChannel.send(JSON.stringify({ type: "ping" }));
        lastDataChannelActivity = now;
      }
    } else {
      console.log("Keep-alive: Data channel not open, stopping ping.");
      stopKeepAlive();
    }
  }, KEEP_ALIVE_INTERVAL);
}

function stopKeepAlive() {
  if (keepAliveIntervalId) {
    console.log("Stopping keep-alive ping.");
    clearInterval(keepAliveIntervalId);
    keepAliveIntervalId = null;
  }
}

// --- Cleanup Functions ---
function closeWebRTCSession() {
  console.log("Closing WebRTC session...");
  stopKeepAlive();
  if (mediaRecorder && isRecording) {
    try {
      mediaRecorder.stop();
    } catch (e) {
      console.warn("Error stopping media recorder during cleanup:", e);
    }
  }
  mediaRecorder = null;
  isRecording = false;

  if (dataChannel) {
    try {
      dataChannel.close();
    } catch (e) {
      console.warn("Error closing data channel during cleanup:", e);
    }
  }
  dataChannel = null;

  if (peerConnection) {
    peerConnection.getSenders().forEach((sender) => {
      if (sender.track) {
        sender.track.stop();
      }
    });
    peerConnection.getReceivers().forEach((receiver) => {
      if (receiver.track) {
        receiver.track.stop();
      }
    });
    try {
      peerConnection.close();
    } catch (e) {
      console.warn("Error closing peer connection during cleanup:", e);
    }
  }
  peerConnection = null;
  audioPlayer.srcObject = null;
  audioPlayer.src = "";

  updateStatus("WebRTC disconnected.");
  console.log("WebRTC session closed.");
}

function cleanupConnections() {
  console.log("Cleaning up all connections...");
  closeWebRTCSession();

  if (webSocket) {
    try {
      webSocket.close();
    } catch (e) {
      console.warn("Error closing WebSocket during cleanup:", e);
    }
  }
  webSocket = null;

  currentSessionId = null;
  ephemeralToken = null;

  connectButton.disabled = false;
  recordButton.disabled = true;
  stopButton.disabled = true;
  transcriptDiv.innerHTML = "";
  addTranscriptLine("Disconnected. Ready to connect again.", "status");
  updateStatus("Disconnected. Ready to connect.");
}

// --- Event Handlers (Unchanged) ---
connectButton.onclick = async () => {
  connectButton.disabled = true;
  updateStatus("Initializing...");
  addTranscriptLine("Connecting...", "status");

  cleanupConnections();

  const tokenOk = await getEphemeralToken();
  if (!tokenOk) {
    connectButton.disabled = false;
    return;
  }

  const webrtcOk = await setupWebRTC();
  if (!webrtcOk) {
    cleanupConnections();
    connectButton.disabled = false;
    return;
  }

  try {
    await connectWebSocket();
  } catch (wsError) {
    updateStatus("Backend WS connect fail.", true);
    addTranscriptLine("Backend connect fail.", "error");
    cleanupConnections();
    connectButton.disabled = false;
  }
};
recordButton.onclick = async () => {
  if (
    isRecording ||
    !peerConnection ||
    peerConnection.connectionState !== "connected" ||
    !dataChannel ||
    dataChannel.readyState !== "open" ||
    !currentSessionId ||
    expectingAssistantResponse
  ) {
    console.warn(
      "Cannot record. State:",
      `isRecording=${isRecording}`,
      `pcState=${peerConnection?.connectionState}`,
      `dcState=${dataChannel?.readyState}`,
      `sessionId=${!!currentSessionId}`,
      `expectingResponse=${expectingAssistantResponse}`
    );
    updateStatus("Cannot record (check state or wait).", true);
    return;
  }

  updateStatus("Starting recording...");
  realtimeApiHandledResponse = false;
  recordButton.disabled = true;
  stopButton.disabled = false;
  isRecording = true;
  transcriptBuffer = "";
  lastUserTranscriptSent = "";
  if (transcriptTimeoutId) clearTimeout(transcriptTimeoutId);
  lastDataChannelActivity = Date.now();

  audioPlayer.pause();
  audioPlayer.src = "";
  assistantAudioBuffer = [];

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const audioTrack = stream.getAudioTracks()[0];
    const existingSender = peerConnection
      .getSenders()
      .find((s) => s.track?.kind === "audio");

    if (existingSender && existingSender.track) {
      if (
        existingSender.track.readyState === "ended" ||
        existingSender.track.id !== audioTrack.id
      ) {
        console.log("Replacing existing audio track.");
        await existingSender.replaceTrack(audioTrack);
      } else {
        console.log("Using existing audio track sender.");
        existingSender.track.enabled = true;
      }
    } else if (!existingSender) {
      console.log("Adding new audio track sender.");
      peerConnection.addTrack(audioTrack, stream);
    } else {
      console.log("Existing audio track sender seems okay.");
      existingSender.track.enabled = true;
    }

    const options = {};
    mediaRecorder = new MediaRecorder(stream, options);

    mediaRecorder.onstop = () => {
      console.log("Recording stopped locally.");
      isRecording = false;
      stream.getTracks().forEach((track) => track.stop());

      if (peerConnection) {
        const audioSender = peerConnection
          .getSenders()
          .find((s) => s.track?.kind === "audio");
        if (audioSender && audioSender.track) {
          audioSender.track.enabled = false;
          console.log("Disabled audio track sender.");
        }
      } else {
        console.warn(
          "mediaRecorder.onstop: peerConnection is null, cannot disable sender track."
        );
      }

      console.log("Waiting for VAD / transcription completion from server...");
      updateStatus("Processing...");
      stopButton.disabled = true;

      if (transcriptTimeoutId) clearTimeout(transcriptTimeoutId);
      transcriptTimeoutId = setTimeout(() => {
        if (!expectingAssistantResponse && transcriptBuffer) {
          console.warn(
            "Safety timeout: Handling potentially incomplete transcript."
          );
          handleTranscriptionCompleted(transcriptBuffer);
        }
      }, TRANSCRIPT_SEND_DELAY * 4);
    };

    mediaRecorder.start();
    updateStatus("Listening...");
  } catch (error) {
    console.error("Recording start error:", error);
    updateStatus(`Mic/Recording error: ${error.message}`, true);
    addTranscriptLine(`Mic/Recording fail: ${error.message}`, "error");
    recordButton.disabled = !!currentSessionId;
    stopButton.disabled = true;
    isRecording = false;
    const audioSender = peerConnection
      ?.getSenders()
      .find((s) => s.track?.kind === "audio");
    if (audioSender && audioSender.track) {
      audioSender.track.stop();
    }
  }
};
stopButton.onclick = () => {
  if (mediaRecorder && isRecording) {
    updateStatus("Stopping recording...");
    try {
      mediaRecorder.stop();
    } catch (e) {
      console.error("Error stopping MediaRecorder:", e);
      isRecording = false;
      recordButton.disabled = false;
      stopButton.disabled = true;
      updateStatus("Error stopping recording.", true);
    }
  } else {
    console.warn("Stop button clicked but not recording or no recorder.");
    isRecording = false;
    recordButton.disabled = !!currentSessionId && !expectingAssistantResponse;
    stopButton.disabled = true;
  }
};
audioPlayer.onplay = () => {
  updateStatus("Assistant speaking...");
  recordButton.disabled = true;
  stopButton.disabled = true;
};
audioPlayer.onended = () => {
  console.log("Assistant audio playback ended.");
  updateStatus("Idle.");
  if (!expectingAssistantResponse) {
    recordButton.disabled = !currentSessionId;
  }
  audioPlayer.src = "";
  URL.revokeObjectURL(audioPlayer.src);
};
audioPlayer.onerror = (e) => {
  console.error("Audio player error:", e);
  updateStatus("Error playing assistant audio.", true);
  addTranscriptLine("Failed to play assistant audio.", "error");
  if (!expectingAssistantResponse) {
    recordButton.disabled = !currentSessionId;
  }
  audioPlayer.src = "";
};

// --- Handle Incoming Realtime Events ---
function handleRealtimeEvent(event) {
  console.log("RAW EVENT:", event.data);
  lastDataChannelActivity = Date.now();

  let data;
  try {
    data = JSON.parse(event.data);
  } catch (e) {
    console.error("Bad Realtime event format:", event.data, e);
    return;
  }

  switch (data.type) {
    case "conversation.item.input_audio_transcription.delta":
      if (data.delta) {
        transcriptBuffer += data.delta;
        if (transcriptTimeoutId) clearTimeout(transcriptTimeoutId);
        transcriptTimeoutId = setTimeout(() => {
          console.log(
            "Transcript delta timeout - handling potentially final segment."
          );
          handleTranscriptionCompleted(transcriptBuffer);
        }, TRANSCRIPT_SEND_DELAY);
      }
      break;
    case "conversation.item.input_audio_transcription.completed":
      if (transcriptTimeoutId) clearTimeout(transcriptTimeoutId);
      transcriptTimeoutId = null;
      handleTranscriptionCompleted(data.transcript);
      break;
    case "response.output_item.added":
      if (data.item?.type === "message" && data.item?.role === "assistant") {
        realtimeApiHandledResponse = true;
        currentAssistantMessageId = data.item.id;
        accumulatedAssistantText = "";
        assistantAudioBuffer = [];
        audioPlayer.pause();
        audioPlayer.src = "";
        console.log("Assistant response item added, preparing for content.");
        updateStatus("Assistant preparing response...");
        expectingAssistantResponse = true;
        recordButton.disabled = true;
        stopButton.disabled = true;
      }
      break;
    case "response.text.delta":
      if (data.delta) {
        accumulatedAssistantText += data.delta;
      }
      break;
    case "response.text.done":
      if (data.text) {
        accumulatedAssistantText = data.text;
      }
      console.log(
        "Final assistant text received via Realtime:",
        accumulatedAssistantText
      );
      break;
    case "response.audio.delta":
      if (data.delta) {
        console.log(
          `Received audio delta chunk. Current buffer size: ${assistantAudioBuffer.reduce(
            (s, c) => s + c.length,
            0
          )} bytes`
        );
        try {
          const binaryString = atob(data.delta);
          const len = binaryString.length;
          const bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          assistantAudioBuffer.push(bytes);
        } catch (e) {
          console.error(
            "Audio base64 decode error:",
            e,
            "Problematic delta:",
            data.delta.substring(0, 50) + "..."
          );
        }
      } else {
        console.warn(
          "Received response.audio.delta event with no actual delta data."
        );
      }
      break;
    case "response.audio.done":
      console.log(
        `Audio stream done event received. Final buffer chunks: ${
          assistantAudioBuffer.length
        }, total size: ${assistantAudioBuffer.reduce(
          (s, c) => s + c.length,
          0
        )} bytes`
      );
      if (assistantAudioBuffer.length > 0 && audioPlayer) {
        updateStatus("Preparing audio playback...");
        try {
          const blob = createWavBlob(assistantAudioBuffer);
          const url = URL.createObjectURL(blob);
          console.log(
            `Audio blob created, size: ${blob.size}, type: ${blob.type}, URL: ${url}`
          );
          audioPlayer.src = url;

          console.log("Calling audioPlayer.load()");
          audioPlayer.load();

          const playAudio = () => {
            console.log(
              `Attempting to play audio (readyState: ${audioPlayer.readyState})`
            );
            audioPlayer
              .play()
              .then(() => {
                console.log("Audio playback successfully started via .play()");
              })
              .catch((e) => {
                console.error("Audio play() promise rejected:", e);
                updateStatus("Error playing audio (autoplay blocked?).", true);
                addTranscriptLine(
                  "Audio playback failed. Please ensure audio is allowed.",
                  "error"
                );
                expectingAssistantResponse = false;
                recordButton.disabled = !currentSessionId;
              });
            console.log(
              "Removing 'canplaythrough' and 'loadeddata' listeners for playAudio"
            );
            audioPlayer.removeEventListener("canplaythrough", playAudio);
            audioPlayer.removeEventListener("loadeddata", playAudio);
          };

          console.log(
            "Adding 'canplaythrough' and 'loadeddata' listeners for playAudio"
          );
          audioPlayer.addEventListener("canplaythrough", playAudio);
          audioPlayer.addEventListener("loadeddata", playAudio);
        } catch (e) {
          console.error(
            "Error during audio blob creation or playback setup:",
            e
          );
          updateStatus("Audio preparation error.", true);
          addTranscriptLine("Failed to prepare assistant audio.", "error");
          expectingAssistantResponse = false;
          recordButton.disabled = !currentSessionId;
          assistantAudioBuffer = [];
        }
      } else {
        console.log(
          "Audio done event, but no audio buffer or player available."
        );
        updateStatus("Idle (No audio received).");
        expectingAssistantResponse = false;
        recordButton.disabled = !currentSessionId;
      }
      assistantAudioBuffer = [];
      break;
    case "response.done":
      console.log("OpenAI Response 'done' event received.");
      if (!audioPlayer.src && !audioPlayer.srcObject) {
        console.log("Response done, but no audio source set. Resetting state.");
        updateStatus("Idle.");
        expectingAssistantResponse = false;
        recordButton.disabled = !currentSessionId;
      } else {
        console.log("Response done. Audio is playing or has played.");
      }
      currentAssistantMessageId = null;
      accumulatedAssistantText = "";
      break;
    case "response.cancelled":
      console.warn(
        "OpenAI Response cancelled:",
        data.response?.status_details?.reason
      );
      addTranscriptLine(
        `Assistant response cancelled (${
          data.response?.status_details?.reason || "unknown reason"
        }).`,
        "status"
      );
      updateStatus("Idle (Response cancelled).");
      expectingAssistantResponse = false;
      recordButton.disabled = !currentSessionId;
      stopButton.disabled = true;
      accumulatedAssistantText = "";
      assistantAudioBuffer = [];
      audioPlayer.pause();
      audioPlayer.src = "";
      currentAssistantMessageId = null;
      break;
    case "error":
      console.error("Realtime API Error Event received:", data.error);
      const errorMessage = data.error?.message || "Unknown error";
      const errorCode = data.error?.code || "N/A";
      addTranscriptLine(
        `Realtime API Error: ${errorMessage} (Code: ${errorCode})`,
        "error"
      );
      updateStatus(`Realtime Error: ${errorCode}`, true);
      console.log("Resetting state due to Realtime API error event.");
      expectingAssistantResponse = false;
      recordButton.disabled = !currentSessionId;
      stopButton.disabled = true;
      accumulatedAssistantText = "";
      assistantAudioBuffer = [];
      audioPlayer.pause();
      audioPlayer.src = "";
      currentAssistantMessageId = null;
      if (transcriptTimeoutId) {
        clearTimeout(transcriptTimeoutId);
        transcriptTimeoutId = null;
        transcriptBuffer = "";
      }
      if (
        errorCode === "session_not_found" ||
        errorCode === "auth_error" ||
        errorCode === "connection_error" ||
        errorCode === "rate_limit_exceeded"
      ) {
        console.warn(
          `Realtime API Error (Code: ${errorCode}) suggests fatal issue. Cleaning up all connections.`
        );
        cleanupConnections();
        connectButton.disabled = false;
      } else {
        console.warn(
          `Realtime API Error (Code: ${errorCode}) occurred, attempting to continue session.`
        );
      }
      break;
    case "input_audio_buffer.speech_started":
      updateStatus("Speech detected...");
      break;
    case "input_audio_buffer.speech_stopped":
      updateStatus("Speech stopped...");
      break;
    case "input_audio_buffer.committed":
      updateStatus("Audio committed, transcribing...");
      break;
    case "pong":
      console.log("Keep-alive pong received.");
      break;
    default:
      console.log("Unhandled Realtime event type:", data.type, data);
  }
}

// --- handleTranscriptionCompleted (Unchanged) ---
function handleTranscriptionCompleted(transcript) {
  if (transcriptTimeoutId) {
    clearTimeout(transcriptTimeoutId);
    transcriptTimeoutId = null;
  }

  const trimmedTranscript = transcript ? transcript.trim() : "";

  if (trimmedTranscript && trimmedTranscript !== lastUserTranscriptSent) {
    console.log(
      "Final transcript segment received/processed:",
      trimmedTranscript
    );
    addTranscriptLine(trimmedTranscript, "user");

    sendMessageToBackend({
      type: "user_transcript",
      content: trimmedTranscript,
    });

    lastUserTranscriptSent = trimmedTranscript;
    expectingAssistantResponse = true;
    updateStatus("Sent transcript, waiting for assistant...");
    recordButton.disabled = true;
    stopButton.disabled = true;
  } else if (!trimmedTranscript) {
    console.log("Ignoring empty or unchanged transcript.");
    updateStatus("Idle (no speech detected?).");
    if (!expectingAssistantResponse) {
      recordButton.disabled = !currentSessionId;
    }
    stopButton.disabled = true;
  } else {
    console.log("Skipping duplicate transcript send.");
    if (!expectingAssistantResponse) {
      recordButton.disabled = !currentSessionId;
    }
    stopButton.disabled = true;
  }

  transcriptBuffer = "";
}

// --- WAV Creation Helper (Unchanged) ---
function createWavBlob(pcmDataChunks) {
  console.log(`createWavBlob called with ${pcmDataChunks.length} chunks.`);
  /* ... */ const sr = 24000;
  const nc = 1;
  const bps = 2;
  const tl = pcmDataChunks.reduce((s, a) => s + a.length, 0);
  const pcm = new Uint8Array(tl);
  let o = 0;
  pcmDataChunks.forEach((c) => {
    pcm.set(c, o);
    o += c.length;
  });
  const b = new ArrayBuffer(44 + pcm.byteLength);
  const v = new DataView(b);
  writeString(v, 0, "RIFF");
  v.setUint32(4, 36 + pcm.byteLength, true);
  writeString(v, 8, "WAVE");
  writeString(v, 12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, nc, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * nc * bps, true);
  v.setUint16(32, nc * bps, true);
  v.setUint16(34, bps * 8, true);
  writeString(v, 36, "data");
  v.setUint32(40, pcm.byteLength, true);
  new Uint8Array(b, 44).set(pcm);

  console.log(`Created WAV blob with final size: ${b.byteLength}`);
  return new Blob([b], { type: "audio/wav" });
}
function writeString(view, offset, string) {
  /* ... */ for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

// --- Initial Page Load ---
updateStatus("Ready to connect.");
