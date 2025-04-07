// public/client.js
console.log("Client script loaded.");

// --- DOM Elements / State Variables / Config ---
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
let currentSessionId = null; // Internal session ID from our backend's MCP server
let ephemeralToken = null; // Token for OpenAI Realtime API
let accumulatedAssistantText = ""; // Accumulates Realtime API's transcript of its own speech
let currentAssistantMessageId = null; // Tracks the Realtime API's message item ID
let expectingAssistantResponse = false; // Are we waiting for the Realtime API to respond?
let lastUserTranscriptSent = "";
let transcriptBuffer = ""; // Buffer for user's speech transcription
let transcriptTimeoutId = null;

const REALTIME_API_URL = "https://api.openai.com/v1/realtime";
const REALTIME_MODEL = "gpt-4o-mini-realtime-preview-2024-12-17"; // Match backend
const BACKEND_WS_URL = `ws://${window.location.host}/mcp-proxy`;
const TRANSCRIPT_SEND_DELAY = 500; // ms to wait after last delta before sending
const KEEP_ALIVE_INTERVAL = 25000; // ms for WebRTC keep-alive
let keepAliveIntervalId = null;
let lastDataChannelActivity = Date.now();

// --- Helper Functions ---
function updateStatus(message, isError = false) {
  console.log(`Status: ${message}`);
  if (statusDiv) {
    statusDiv.textContent = `Status: ${message}`;
    statusDiv.style.color = isError ? "red" : "#555";
  }
}

function addTranscriptLine(text, type = "status") {
  if (!transcriptDiv) return;
  const line = document.createElement("div");
  line.textContent = text; // Raw text for status/error
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
  updateStatus("Requesting token...");
  try {
    const r = await fetch("/session-token"); // Calls our backend endpoint
    if (!r.ok) {
      let errorMsg = `Backend error: ${r.statusText}`;
      try {
        const errBody = await r.json();
        errorMsg = errBody.error || errorMsg;
      } catch (_) { /* ignore parsing error */ }
      throw new Error(errorMsg);
    }
    const d = await r.json();
    if (!d.client_secret?.value) throw new Error("Invalid token response from backend.");
    console.log("Got session token object:", d);
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

// --- WebSocket Functions ---
function connectWebSocket() {
  return new Promise((resolve, reject) => {
    updateStatus("Connecting backend WS...");
    if (webSocket && webSocket.readyState === WebSocket.OPEN) {
      console.log("WebSocket already open.");
      resolve(true);
      return;
    }
    if (webSocket) { // Clean up old socket if exists but not open
      webSocket.onopen = null;
      webSocket.onerror = null;
      webSocket.onclose = null;
      webSocket.onmessage = null;
      if (webSocket.readyState !== WebSocket.CLOSED) {
        try { webSocket.close(); } catch (e) { }
      }
    }

    webSocket = new WebSocket(BACKEND_WS_URL);

    webSocket.onopen = () => {
      console.log("Backend WS open.");
      updateStatus("Connected backend.");
      resolve(true); // Resolve the promise when connection is open
    };

    webSocket.onerror = (error) => {
      console.error("Backend WS error:", error);
      updateStatus("Backend WS error.", true);
      addTranscriptLine("Lost backend connection.", "error");
      reject(error); // Reject the promise on error
      cleanupConnections(); // Clean up everything
    };

    webSocket.onclose = (event) => {
      console.log(`Backend WS closed. Code: ${event.code}, Reason: ${event.reason}`);
      updateStatus("Disconnected backend.");
      addTranscriptLine("Disconnected backend.", "status");
      // Only reject if it wasn't opened successfully first
      if (!connectButton.disabled) { // If connect button is enabled, we likely failed to connect initially
        reject(new Error("WebSocket closed before opening successfully."));
      }
      cleanupConnections(); // Clean up everything
    };

    webSocket.onmessage = (event) => {
      console.log(`[CLIENT] [${currentSessionId || 'NO_SESSION'}] Received WebSocket message:`, event.data);
      try {
        const message = JSON.parse(event.data);
        if (message.type === "sessionId" && message.sessionId) {
          currentSessionId = message.sessionId;
          console.log("Received internal session ID:", currentSessionId);
          updateStatus("Session active.");
          // Enable recording ONLY after getting the session ID
          connectButton.disabled = true;
          recordButton.disabled = false;
          stopButton.disabled = true;
        } else if (message.type === "error") {
          addTranscriptLine(`Backend error: ${message.message}`, "error");
          updateStatus(`Backend error: ${message.message}`, true);
          expectingAssistantResponse = false; // Reset expectation
          recordButton.disabled = !!currentSessionId; // Disable if no session
          stopButton.disabled = true;
        } else if (message.type === "status_update") {
          addTranscriptLine(`Backend: ${message.message}`, "status");
        } else {
          console.warn(`[CLIENT] Unhandled WebSocket message type from backend: ${message.type}`);
        }
      } catch (e) {
        console.error("Failed parse backend WS msg:", e);
      }
    };
  });
}

function sendMessageToBackend(message) {
  if (
    webSocket &&
    webSocket.readyState === WebSocket.OPEN &&
    currentSessionId // Use the internal session ID for backend communication
  ) {
    message.sessionId = currentSessionId; // Add internal session ID
    console.log(`[CLIENT] [${currentSessionId}] Sending WebSocket message to Backend:`, message);
    webSocket.send(JSON.stringify(message));
  } else {
    console.error("WS not open/no internal session ID for message:", message);
    addTranscriptLine("Cannot communicate with backend. Disconnected?", "error");
    updateStatus("Backend disconnected?", true);
    // Reset relevant states if needed
    expectingAssistantResponse = false;
    recordButton.disabled = !!currentSessionId;
    stopButton.disabled = true;
  }
}

// --- WebRTC Functions ---
async function setupWebRTC() {
  if (!ephemeralToken) {
    console.error("No OpenAI ephemeral token for WebRTC.");
    return false;
  }
  updateStatus("Setting up WebRTC with OpenAI...");
  try {
    // Close existing connection if any
    if (peerConnection) {
      console.log("Closing existing PeerConnection before creating new one.");
      closeWebRTCSession(); // Use our cleanup function
    }

    peerConnection = new RTCPeerConnection();
    lastDataChannelActivity = Date.now();

    peerConnection.ontrack = (event) => {
      lastDataChannelActivity = Date.now();
      console.log("Got remote track from OpenAI:", event.track.kind);
      if (event.track.kind === "audio" && audioPlayer) {
        if (!audioPlayer.srcObject || audioPlayer.srcObject !== event.streams[0]) {
          audioPlayer.srcObject = event.streams[0];
          console.log("Attached remote audio track to player.");
        } else {
          console.log("Remote audio track already attached.");
        }
      }
    };

    // Data channel for receiving events FROM OpenAI
    dataChannel = peerConnection.createDataChannel("oai-events", { ordered: true });
    console.log("WebRTC Data channel created.");

    dataChannel.onmessage = (event) => {
      lastDataChannelActivity = Date.now();
      handleRealtimeEvent(event); // Handle events from OpenAI
    };
    dataChannel.onopen = () => {
      lastDataChannelActivity = Date.now();
      console.log("WebRTC Data channel OPEN with OpenAI");
      updateStatus("Realtime connection active.");
      startKeepAlive(); // Start pinging OpenAI
    };
    dataChannel.onclose = () => {
      console.log("WebRTC Data channel CLOSED with OpenAI");
      updateStatus("Realtime connection closed.");
      stopKeepAlive();
      // Optionally trigger full cleanup if channel closes unexpectedly
      if (peerConnection && peerConnection.connectionState !== 'closed') {
        console.warn("Data channel closed unexpectedly, cleaning up WebRTC.");
        closeWebRTCSession();
      }
    };
    dataChannel.onerror = (err) => {
      console.error("WebRTC Data channel error:", err);
      updateStatus("Realtime connection error.", true);
      stopKeepAlive();
      // Optionally trigger full cleanup on error
      console.warn("Data channel error, cleaning up WebRTC.");
      closeWebRTCSession();
    };

    // Get microphone access and add track
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => {
      if (!peerConnection) return; // Guard against race condition during cleanup
      // Ensure we don't add the same track multiple times if reconnecting quickly
      if (!peerConnection.getSenders().find(s => s.track === track)) {
        peerConnection.addTrack(track, stream);
        console.log("Added mic track to PeerConnection.");
      } else {
        console.log("Mic track already added.");
      }
    });
    lastDataChannelActivity = Date.now();

    // --- State change logging (Unchanged) ---
    peerConnection.onconnectionstatechange = (event) => {
      if (!peerConnection) return; // Guard
      console.log("WebRTC State:", peerConnection.connectionState);
      lastDataChannelActivity = Date.now();
      switch (peerConnection.connectionState) {
        case "connected": updateStatus("WebRTC Connected."); break;
        case "disconnected": updateStatus("WebRTC Disconnected."); stopKeepAlive(); break; // Don't cleanup immediately
        case "failed":
          updateStatus("WebRTC Failed.", true);
          addTranscriptLine("WebRTC connection failed.", "error");
          stopKeepAlive();
          closeWebRTCSession(); // Cleanup on failure
          break;
        case "closed":
          updateStatus("WebRTC Closed.");
          stopKeepAlive();
          // closeWebRTCSession(); // Already handled by closeWebRTCSession or external cleanup
          break;
        default: updateStatus(`WebRTC state: ${peerConnection.connectionState}`);
      }
    };
    peerConnection.oniceconnectionstatechange = (event) => { if (!peerConnection) return; lastDataChannelActivity = Date.now(); console.log("ICE State:", peerConnection.iceConnectionState); };
    peerConnection.onicegatheringstatechange = (event) => { if (!peerConnection) return; lastDataChannelActivity = Date.now(); console.log("ICE Gathering State:", peerConnection.iceGatheringState); };
    // --- End State change logging ---


    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    console.log("Local SDP created for OpenAI.");
    lastDataChannelActivity = Date.now();

    // Send OFFER to OpenAI Realtime API
    const sdpResponse = await fetch(
      `${REALTIME_API_URL}?model=${REALTIME_MODEL}`, // Use the correct model
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
      throw new Error(`OpenAI SDP exchange fail (${sdpResponse.status}): ${errorText}`);
    }
    const answerSdp = await sdpResponse.text();
    if (!peerConnection || peerConnection.signalingState === 'closed') {
      console.warn("PeerConnection closed before setting remote description. Aborting.");
      return false;
    }
    await peerConnection.setRemoteDescription({ type: "answer", sdp: answerSdp });
    lastDataChannelActivity = Date.now();
    console.log("WebRTC setup complete with OpenAI, state:", peerConnection.connectionState);
    return true;
  } catch (error) {
    console.error("WebRTC Setup Error:", error);
    updateStatus(`WebRTC fail: ${error.message}`, true);
    addTranscriptLine(`Realtime connect fail: ${error.message}`, "error");
    closeWebRTCSession(); // Ensure cleanup on error
    return false;
  }
}


// --- Keep-Alive Functions ---
function startKeepAlive() {
  stopKeepAlive(); // Ensure no duplicates
  console.log(`Starting keep-alive ping to OpenAI every ${KEEP_ALIVE_INTERVAL}ms`);
  keepAliveIntervalId = setInterval(() => {
    if (dataChannel && dataChannel.readyState === "open") {
      const now = Date.now();
      // Send ping more frequently than the interval to ensure activity
      if (now - lastDataChannelActivity > KEEP_ALIVE_INTERVAL / 2) {
        console.log("Sending WebRTC keep-alive ping to OpenAI.");
        try {
          // Use a simple, standard message if possible, or OpenAI's specific ping if documented
          dataChannel.send(JSON.stringify({ type: "ping" }));
          lastDataChannelActivity = now; // Update last activity *after* sending
        } catch (e) {
          console.error("Error sending keep-alive ping:", e);
          // Consider closing connection if ping fails repeatedly
        }
      }
    } else {
      console.log("Keep-alive: Data channel not open, stopping ping.");
      stopKeepAlive();
    }
  }, KEEP_ALIVE_INTERVAL); // Check every interval
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
    console.log("Stopping active MediaRecorder during cleanup.");
    try { mediaRecorder.stop(); }
    catch (e) { console.warn("Error stopping media recorder during cleanup:", e); }
  }
  mediaRecorder = null;
  isRecording = false;

  if (dataChannel) {
    console.log("Closing WebRTC DataChannel.");
    dataChannel.onmessage = null; // Remove handlers first
    dataChannel.onopen = null;
    dataChannel.onclose = null;
    dataChannel.onerror = null;
    try { dataChannel.close(); }
    catch (e) { console.warn("Error closing data channel during cleanup:", e); }
  }
  dataChannel = null;

  if (peerConnection) {
    console.log("Closing RTCPeerConnection.");
    peerConnection.ontrack = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.oniceconnectionstatechange = null;
    peerConnection.onicegatheringstatechange = null;

    peerConnection.getSenders().forEach((sender) => {
      if (sender.track) {
        console.log(`Stopping sender track: ${sender.track.kind} (${sender.track.label})`);
        sender.track.stop();
      }
    });
    peerConnection.getReceivers().forEach((receiver) => {
      if (receiver.track) {
        console.log(`Stopping receiver track: ${receiver.track.kind} (${receiver.track.label})`);
        receiver.track.stop();
      }
    });

    try { peerConnection.close(); }
    catch (e) { console.warn("Error closing peer connection during cleanup:", e); }
  }
  peerConnection = null;

  if (audioPlayer) {
    console.log("Pausing and clearing audio player source during WebRTC cleanup.");
    audioPlayer.pause();
    audioPlayer.srcObject = null; // Important for remote tracks
    if (audioPlayer.src.startsWith('blob:')) {
      URL.revokeObjectURL(audioPlayer.src); // Clean up blob URLs
    }
    audioPlayer.src = "";
  }

  updateStatus("WebRTC disconnected."); // Update status after cleanup attempts
  console.log("WebRTC session closed.");
}

function cleanupConnections() {
  console.log("Cleaning up all connections (WebRTC & WebSocket)...");
  closeWebRTCSession(); // Close WebRTC first

  if (webSocket) {
    console.log("Closing WebSocket connection.");
    webSocket.onopen = null; // Remove handlers
    webSocket.onerror = null;
    webSocket.onclose = null;
    webSocket.onmessage = null;
    if (webSocket.readyState !== WebSocket.CLOSED && webSocket.readyState !== WebSocket.CLOSING) {
      try { webSocket.close(); }
      catch (e) { console.warn("Error closing WebSocket during cleanup:", e); }
    }
  }
  webSocket = null;

  // Reset all state variables
  currentSessionId = null;
  ephemeralToken = null;
  expectingAssistantResponse = false;
  accumulatedAssistantText = "";
  assistantAudioBuffer = [];
  currentAssistantMessageId = null;
  transcriptBuffer = "";
  lastUserTranscriptSent = "";

  if (transcriptTimeoutId) clearTimeout(transcriptTimeoutId);
  transcriptTimeoutId = null;

  // Reset UI
  connectButton.disabled = false;
  recordButton.disabled = true;
  stopButton.disabled = true;
  if (transcriptDiv) transcriptDiv.innerHTML = ""; // Clear transcript display
  addTranscriptLine("Disconnected. Ready to connect again.", "status");
  updateStatus("Disconnected. Ready to connect.");
}


// --- Event Handlers ---
connectButton.onclick = async () => {
  connectButton.disabled = true;
  updateStatus("Initializing...");
  addTranscriptLine("Connecting...", "status");

  await cleanupConnections(); // Ensure clean state before connecting

  const tokenOk = await getEphemeralToken();
  if (!tokenOk) {
    connectButton.disabled = false; // Re-enable button on failure
    return;
  }

  const webrtcOk = await setupWebRTC();
  if (!webrtcOk) {
    cleanupConnections(); // Clean up if WebRTC fails
    connectButton.disabled = false;
    return;
  }

  // Only connect WebSocket if WebRTC setup succeeded
  try {
    await connectWebSocket();
    // If successful, connectWebSocket sets button states internally via session ID message
  } catch (wsError) {
    updateStatus("Backend WS connect fail.", true);
    addTranscriptLine("Backend connect fail.", "error");
    cleanupConnections(); // Clean up everything if WS fails
    connectButton.disabled = false;
  }
};

recordButton.onclick = async () => {
  if (isRecording || !peerConnection || peerConnection.connectionState !== "connected" ||
    !dataChannel || dataChannel.readyState !== "open" || !currentSessionId || expectingAssistantResponse) {
    console.warn("Cannot record. State:", /* ... logging ... */);
    updateStatus("Cannot record (check state or wait).", true);
    return;
  }

  updateStatus("Starting recording...");
  // No realtimeApiHandledResponse flag needed
  recordButton.disabled = true;
  stopButton.disabled = false;
  isRecording = true;
  transcriptBuffer = "";
  lastUserTranscriptSent = "";
  if (transcriptTimeoutId) clearTimeout(transcriptTimeoutId);
  lastDataChannelActivity = Date.now();

  // Reset state for the upcoming assistant turn
  accumulatedAssistantText = "";
  assistantAudioBuffer = [];
  currentAssistantMessageId = null;
  if (audioPlayer) {
    audioPlayer.pause();
    if (audioPlayer.src.startsWith('blob:')) URL.revokeObjectURL(audioPlayer.src);
    audioPlayer.src = "";
  }


  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioTrack = stream.getAudioTracks()[0];
    const existingSender = peerConnection?.getSenders().find((s) => s.track?.kind === "audio");

    if (existingSender?.track) {
      if (existingSender.track.readyState === "ended" || existingSender.track.id !== audioTrack.id) {
        console.log("Replacing existing ended/different audio track.");
        await existingSender.replaceTrack(audioTrack);
      } else {
        console.log("Re-enabling existing audio track sender.");
        existingSender.track.enabled = true; // Ensure it's enabled if previously stopped
      }
    } else if (peerConnection) { // Check peerConnection exists
      console.log("Adding new audio track sender.");
      peerConnection.addTrack(audioTrack, stream);
    }

    // --- MediaRecorder Setup ---
    const options = {}; // Add MIME type if needed: { mimeType: 'audio/webm;codecs=opus' };
    mediaRecorder = new MediaRecorder(stream, options);

    mediaRecorder.onstop = () => {
      console.log("Recording stopped locally (mediaRecorder.onstop).");
      isRecording = false; // Update state
      // Stop the tracks from the stream used by MediaRecorder
      stream.getTracks().forEach((track) => {
        console.log(`Stopping track from MediaRecorder stream: ${track.kind} (${track.label})`);
        track.stop();
      });

      // Attempt to disable the track on the sender again for good measure
      if (peerConnection) {
        const audioSender = peerConnection.getSenders().find((s) => s.track?.kind === "audio");
        if (audioSender?.track && audioSender.track.readyState !== 'ended') {
          // Don't disable if it's already ended
          // audioSender.track.enabled = false; // Disabling might not be necessary if stopped
          console.log("Checked audio track sender after stopping recording.");
        }
      }

      console.log("Waiting for final transcription from Realtime API...");
      updateStatus("Processing...");
      stopButton.disabled = true; // Disable stop button now

      // Safety timeout for transcription completion
      if (transcriptTimeoutId) clearTimeout(transcriptTimeoutId);
      transcriptTimeoutId = setTimeout(() => {
        if (!expectingAssistantResponse && transcriptBuffer) {
          console.warn("Safety timeout: Handling potentially incomplete user transcript.");
          handleTranscriptionCompleted(transcriptBuffer);
        } else if (expectingAssistantResponse) {
          console.log("Safety timeout: Assistant response already started, ignoring user transcript timeout.");
        } else {
          console.log("Safety timeout: No transcript buffer and not expecting response.");
        }
      }, TRANSCRIPT_SEND_DELAY * 4); // Increased timeout (2 seconds)
    };

    mediaRecorder.onerror = (event) => {
      console.error("MediaRecorder error:", event.error);
      updateStatus("Recording error.", true);
      addTranscriptLine("Error during recording.", "error");
      // Reset recording state
      isRecording = false;
      recordButton.disabled = !!currentSessionId && !expectingAssistantResponse;
      stopButton.disabled = true;
      stream.getTracks().forEach(track => track.stop()); // Stop tracks on error too
    };

    mediaRecorder.start(); // Start recording
    updateStatus("Listening...");

  } catch (error) {
    console.error("Recording start error (getUserMedia or MediaRecorder):", error);
    updateStatus(`Mic/Recording error: ${error.message}`, true);
    addTranscriptLine(`Mic/Recording fail: ${error.message}`, "error");
    recordButton.disabled = !!currentSessionId; // Re-enable if session is active
    stopButton.disabled = true;
    isRecording = false;
    // Attempt to stop tracks if peerConnection exists
    const audioSender = peerConnection?.getSenders().find((s) => s.track?.kind === "audio");
    if (audioSender?.track) { audioSender.track.stop(); }
  }
};

stopButton.onclick = () => {
  if (mediaRecorder && isRecording) {
    console.log("Stop button clicked, stopping MediaRecorder...");
    updateStatus("Stopping recording...");
    stopButton.disabled = true; // Disable immediately
    recordButton.disabled = true; // Disable record until processing finishes
    try {
      mediaRecorder.stop(); // This will trigger the onstop handler
    } catch (e) {
      console.error("Error stopping MediaRecorder:", e);
      // Manually reset state if stop fails critically
      isRecording = false;
      recordButton.disabled = !currentSessionId; // Re-enable record if session still valid
      stopButton.disabled = true;
      updateStatus("Error stopping recording.", true);
    }
  } else {
    console.warn("Stop button clicked but not recording or no recorder.");
    isRecording = false; // Ensure state is correct
    recordButton.disabled = !!currentSessionId && !expectingAssistantResponse;
    stopButton.disabled = true;
  }
};

audioPlayer.onplay = () => {
  updateStatus("Assistant speaking...");
  recordButton.disabled = true; // Cannot record while assistant speaks
  stopButton.disabled = true;
};

audioPlayer.onended = () => {
  console.log(`[CLIENT] [${currentSessionId || 'NO_SESSION'}] Assistant audio playback ended.`);
  updateStatus("Idle.");
  expectingAssistantResponse = false; // Ready for user input
  recordButton.disabled = !currentSessionId; // Enable recording if session active
  stopButton.disabled = true;
  // Clean up blob URL
  if (audioPlayer.src && audioPlayer.src.startsWith('blob:')) {
    URL.revokeObjectURL(audioPlayer.src);
    console.log("Revoked Blob URL:", audioPlayer.src);
  }
  audioPlayer.src = ""; // Clear src
  // Clear srcObject just in case, though src should be used for blobs
  if (audioPlayer.srcObject) {
    audioPlayer.srcObject = null;
  }
};

audioPlayer.onerror = (e) => {
  const mediaError = e.target?.error;
  const errorMessage = mediaError ? `Code ${mediaError.code}: ${mediaError.message}` : (e.message || 'Unknown error');

  // Ignore benign errors when src is empty/default
  if (!audioPlayer.src || audioPlayer.src === window.location.href) {
    console.warn("Audio player error ignored for empty/default src:", errorMessage);
    if (audioPlayer.src !== "") { audioPlayer.src = ""; } // Ensure src is cleared
    return;
  }

  console.error("Audio player error during expected playback:", errorMessage, e);
  updateStatus("Error playing assistant audio.", true);
  addTranscriptLine("Failed to play assistant audio.", "error");

  // Reset state reliably
  expectingAssistantResponse = false;
  recordButton.disabled = !currentSessionId; // Enable recording if session active
  stopButton.disabled = true;
  accumulatedAssistantText = "";
  assistantAudioBuffer = [];
  currentAssistantMessageId = null;

  // Clean up player source
  if (audioPlayer.src.startsWith('blob:')) {
    URL.revokeObjectURL(audioPlayer.src);
  }
  audioPlayer.src = "";
  if (audioPlayer.srcObject) {
    audioPlayer.srcObject = null;
  }
};

// --- Handle Incoming Realtime Events ---
function handleRealtimeEvent(event) {
  lastDataChannelActivity = Date.now(); // Update activity on any message
  let data;
  try { data = JSON.parse(event.data); }
  catch (e) { console.error("Bad Realtime event format:", event.data, e); return; }

  console.log(`[CLIENT] [${currentSessionId || 'NO_SESSION'}] REALTIME_EVENT Received: Type=${data.type}`);

  switch (data.type) {
    // --- User Transcription Handling ---
    case "conversation.item.input_audio_transcription.delta":
      if (data.delta) {
        transcriptBuffer += data.delta;
        if (transcriptTimeoutId) clearTimeout(transcriptTimeoutId);
        // Set timeout only if we are not already expecting an assistant response
        if (!expectingAssistantResponse) {
          transcriptTimeoutId = setTimeout(() => {
            console.log("Transcript delta timeout - handling potentially final user segment.");
            handleTranscriptionCompleted(transcriptBuffer);
          }, TRANSCRIPT_SEND_DELAY);
        }
      }
      break;
    case "conversation.item.input_audio_transcription.completed":
      if (transcriptTimeoutId) clearTimeout(transcriptTimeoutId);
      transcriptTimeoutId = null;
      // Process only if assistant isn't already talking/expected
      if (!expectingAssistantResponse) {
        handleTranscriptionCompleted(data.transcript);
      } else {
        console.log("Ignoring late user transcription completion as assistant response is expected/in progress.");
        transcriptBuffer = ""; // Clear buffer even if ignored
      }
      break;

    // --- Assistant Response Lifecycle ---
    case "response.output_item.added":
      if (data.item?.type === "message" && data.item?.role === "assistant") {
        currentAssistantMessageId = data.item.id;
        console.log(`[CLIENT] [${currentSessionId}] REALTIME_EVENT Assistant response started (Message ID: ${currentAssistantMessageId}).`);
        accumulatedAssistantText = ""; // Reset for new response
        assistantAudioBuffer = [];   // Reset for new response
        audioPlayer.pause();         // Stop previous audio
        if (audioPlayer.src.startsWith('blob:')) URL.revokeObjectURL(audioPlayer.src);
        audioPlayer.src = "";        // Clear previous source
        if (audioPlayer.srcObject) audioPlayer.srcObject = null;

        updateStatus("Assistant preparing response...");
        expectingAssistantResponse = true; // Now waiting for OpenAI's response
        recordButton.disabled = true;
        stopButton.disabled = true;
      }
      break;

    // --- Assistant Text Handling ---
    case "response.audio_transcript.delta":
      if (data.delta) {
        accumulatedAssistantText += data.delta;
        // Optional: Update UI with live transcript here if desired
        console.log(`[CLIENT] [${currentSessionId}] Assistant transcript delta: "${data.delta}"`);
      }
      break;
    case "response.audio_transcript.done":
      if (data.transcript) { accumulatedAssistantText = data.transcript; }
      console.log(`[CLIENT] [${currentSessionId}] REALTIME_EVENT Assistant transcript done: "${accumulatedAssistantText}"`);
      // Display final text
      addTranscriptLine(accumulatedAssistantText, "assistant");
      // Send final transcript to backend for storage
      sendMessageToBackend({
        type: "store_assistant_transcript",
        content: accumulatedAssistantText,
        // sessionId is added by sendMessageToBackend
      });
      // Don't reset expectingAssistantResponse here, wait for audio/response.done
      break;

    // --- Assistant Audio Handling ---
    case "response.audio.delta":
      if (data.delta) {
        try {
          const binaryString = atob(data.delta);
          const len = binaryString.length;
          const bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) { bytes[i] = binaryString.charCodeAt(i); }
          assistantAudioBuffer.push(bytes);
        } catch (e) { console.error("Audio base64 decode error:", e); }
      }
      break;
    case "response.audio.done":
      console.log(`[CLIENT] [${currentSessionId}] REALTIME_EVENT Audio stream done. Buffer chunks: ${assistantAudioBuffer.length}, Size: ${assistantAudioBuffer.reduce((s, c) => s + c.length, 0)} bytes`);
      if (assistantAudioBuffer.length > 0 && audioPlayer) {
        updateStatus("Preparing audio playback...");
        try {
          const blob = createWavBlob(assistantAudioBuffer);
          const url = URL.createObjectURL(blob);
          console.log(`[CLIENT] [${currentSessionId}] Audio blob created, size: ${blob.size}, URL: ${url}`);
          audioPlayer.src = url;
          audioPlayer.load();

          const playAudio = () => {
            if (!audioPlayer || audioPlayer.src !== url) {
              console.warn("playAudio called but src changed or player gone.");
              return;
            }
            console.log(`[CLIENT] [${currentSessionId}] Attempting to play audio (readyState: ${audioPlayer.readyState})`);
            audioPlayer.play()
              .then(() => {
                console.log(`[CLIENT] [${currentSessionId}] ASSISTANT_AUDIO_PLAYING: Playback started.`);
                // expectingAssistantResponse should remain true until onended
              })
              .catch(e => {
                console.error("Audio play() promise rejected:", e);
                updateStatus("Error playing audio (autoplay blocked?).", true);
                addTranscriptLine("Audio playback failed. Please ensure audio is allowed.", "error");
                expectingAssistantResponse = false; // Failed, allow user input
                recordButton.disabled = !currentSessionId;
                // Clean up blob URL on immediate failure
                if (audioPlayer.src === url) {
                  URL.revokeObjectURL(url);
                  audioPlayer.src = "";
                }
              });
            // Clean up listeners after first attempt
            audioPlayer.removeEventListener("canplaythrough", playAudio);
            audioPlayer.removeEventListener("loadeddata", playAudio);
          };

          // Listen for events indicating readiness
          audioPlayer.addEventListener("canplaythrough", playAudio);
          audioPlayer.addEventListener("loadeddata", playAudio);

          // Safety timeout
          setTimeout(() => {
            if (audioPlayer && audioPlayer.paused && audioPlayer.src === url) {
              console.warn(`[CLIENT] [${currentSessionId}] Playback safety timeout, forcing play.`);
              playAudio();
            }
            // Clean up listeners if timeout occurs before they fire
            audioPlayer?.removeEventListener("canplaythrough", playAudio);
            audioPlayer?.removeEventListener("loadeddata", playAudio);
          }, 1500); // 1.5 seconds

        } catch (e) {
          console.error("Error during audio blob/playback setup:", e);
          updateStatus("Audio preparation error.", true);
          addTranscriptLine("Failed to prepare assistant audio.", "error");
          expectingAssistantResponse = false; // Failed, allow user input
          recordButton.disabled = !currentSessionId;
          assistantAudioBuffer = []; // Clear buffer on error
        }
      } else {
        console.log("[CLIENT] Audio done event, but no audio buffer/player. Response might be text-only or cancelled.");
        updateStatus("Idle (No audio generated).");
        expectingAssistantResponse = false; // No audio coming, allow user input
        recordButton.disabled = !currentSessionId;
      }
      assistantAudioBuffer = []; // Clear buffer after processing attempt
      break;

    // --- End of Response / Errors ---
    case "response.done":
      console.log(`[CLIENT] [${currentSessionId}] REALTIME_EVENT Response processing 'done'. Status: ${data.response?.status}, ID: ${data.response?.id}`);
      // Check if audio is currently playing or loading
      const isAudioActive = audioPlayer && (!audioPlayer.paused || audioPlayer.readyState >= 2); // readyState 2 = HAVE_METADATA

      if (!isAudioActive) {
        console.log("Response done, and audio player is not active. Resetting state.");
        updateStatus("Idle.");
        expectingAssistantResponse = false;
        recordButton.disabled = !currentSessionId;
      } else {
        console.log("Response done. Waiting for audio playback to finish (onended event).");
      }
      // Keep accumulated text until potentially overwritten by next response's transcript
      currentAssistantMessageId = null; // This specific response cycle is complete
      break;
    case "response.cancelled":
      console.warn(`[CLIENT] [${currentSessionId}] REALTIME_EVENT Response cancelled: ${data.response?.status_details?.reason}, ID: ${data.response?.id}`);
      addTranscriptLine(`Assistant response cancelled (${data.response?.status_details?.reason || 'unknown'}).`, "status");
      updateStatus("Idle (Response cancelled).");
      // Reset all relevant state immediately
      expectingAssistantResponse = false;
      recordButton.disabled = !currentSessionId;
      stopButton.disabled = true;
      accumulatedAssistantText = "";
      assistantAudioBuffer = [];
      audioPlayer.pause();
      if (audioPlayer.src.startsWith('blob:')) URL.revokeObjectURL(audioPlayer.src);
      audioPlayer.src = "";
      if (audioPlayer.srcObject) audioPlayer.srcObject = null;
      currentAssistantMessageId = null;
      break;
    case "error":
      console.error("Realtime API Error Event received:", data.error);
      const errorMessage = data.error?.message || "Unknown error";
      const errorCode = data.error?.code || "N/A";
      addTranscriptLine(`Realtime API Error: ${errorMessage} (Code: ${errorCode})`, "error");
      updateStatus(`Realtime Error: ${errorCode}`, true);
      console.log("Resetting state due to Realtime API error event.");
      // Reset state
      expectingAssistantResponse = false;
      recordButton.disabled = !currentSessionId;
      stopButton.disabled = true;
      accumulatedAssistantText = "";
      assistantAudioBuffer = [];
      audioPlayer.pause();
      if (audioPlayer.src.startsWith('blob:')) URL.revokeObjectURL(audioPlayer.src);
      audioPlayer.src = "";
      if (audioPlayer.srcObject) audioPlayer.srcObject = null;
      currentAssistantMessageId = null;
      if (transcriptTimeoutId) { clearTimeout(transcriptTimeoutId); transcriptTimeoutId = null; transcriptBuffer = ""; }
      // Determine if error is fatal for the session
      if (["session_not_found", "auth_error", "connection_error", "rate_limit_exceeded"].includes(errorCode)) {
        console.warn(`Realtime API Error (Code: ${errorCode}) suggests fatal issue. Cleaning up all connections.`);
        cleanupConnections(); // Full cleanup
      } else {
        console.warn(`Realtime API Error (Code: ${errorCode}) occurred, attempting to continue session if possible.`);
        // Keep session ID, maybe re-enable connect? Or just let user retry recording.
        connectButton.disabled = true; // Assume session might still be valid unless error code proves otherwise
        recordButton.disabled = !currentSessionId; // Allow retry if session still exists
      }
      break;

    // --- Informational Events (Unchanged) ---
    case "input_audio_buffer.speech_started": updateStatus("Speech detected..."); break;
    case "input_audio_buffer.speech_stopped": updateStatus("Speech stopped..."); break;
    case "input_audio_buffer.committed": updateStatus("Audio committed, transcribing..."); break;
    case "pong": console.log("Keep-alive pong received from OpenAI."); break;
    case "session.created": console.log("Realtime session created event received (already handled during setup)."); break;
    // Add cases for other potential events if needed, e.g., output_audio_buffer events
    case "output_audio_buffer.started": console.log("Realtime API started buffering output audio."); break;
    case "output_audio_buffer.stopped": console.log("Realtime API stopped buffering output audio."); break;
    case "output_audio_buffer.cleared": console.log("Realtime API output audio buffer cleared."); break;


    default:
      console.log("[CLIENT] Unhandled Realtime event type:", data.type, data);
  }
}


// --- handleTranscriptionCompleted ---
function handleTranscriptionCompleted(transcript) {
  if (transcriptTimeoutId) { clearTimeout(transcriptTimeoutId); transcriptTimeoutId = null; }

  const trimmedTranscript = transcript ? transcript.trim() : "";

  // Only process if not empty, not duplicate, AND assistant isn't already responding
  if (trimmedTranscript && trimmedTranscript !== lastUserTranscriptSent && !expectingAssistantResponse) {
    console.log(`[CLIENT] [${currentSessionId || 'NO_SESSION'}] USER_TRANSCRIPT_FINALIZED: "${trimmedTranscript}"`);
    addTranscriptLine(trimmedTranscript, "user");

    // Send to backend for STORAGE ONLY
    sendMessageToBackend({
      type: "user_transcript", // Just to store it
      content: trimmedTranscript,
      // Session ID added in sendMessageToBackend
    });

    lastUserTranscriptSent = trimmedTranscript;
    expectingAssistantResponse = true; // Now expecting Realtime API to respond directly
    updateStatus("Processing your speech..."); // Realtime API is now processing
    recordButton.disabled = true; // Disable while Realtime API processes
    stopButton.disabled = true; // Should already be disabled
  } else if (!trimmedTranscript) {
    console.log("[CLIENT] Ignoring empty user transcript completion.");
    updateStatus("Idle (no speech detected?).");
    recordButton.disabled = !currentSessionId && !expectingAssistantResponse;
    stopButton.disabled = true;
  } else if (expectingAssistantResponse) {
    console.log("[CLIENT] Ignoring user transcript completion because assistant response is expected/in progress.");
  } else { // Duplicate
    console.log("[CLIENT] Skipping duplicate user transcript send.");
    recordButton.disabled = !currentSessionId && !expectingAssistantResponse;
    stopButton.disabled = true;
  }

  transcriptBuffer = ""; // Always clear buffer
}

// --- WAV Creation Helper (Unchanged) ---
function createWavBlob(pcmDataChunks) {
  console.log(`createWavBlob called with ${pcmDataChunks.length} chunks.`);
  const totalLength = pcmDataChunks.reduce((sum, arr) => sum + arr.length, 0);
  if (totalLength === 0) {
    console.warn("Attempted to create WAV blob with zero data length.");
    return new Blob([], { type: "audio/wav" }); // Return empty blob
  }
  const sampleRate = 24000;
  const numChannels = 1;
  const bytesPerSample = 2; // 16-bit PCM
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = totalLength;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // Subchunk1Size for PCM
  view.setUint16(20, 1, true); // AudioFormat = 1 for PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true); // BitsPerSample
  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // Write PCM data
  const pcm = new Uint8Array(buffer, 44);
  let offset = 0;
  pcmDataChunks.forEach(chunk => {
    pcm.set(chunk, offset);
    offset += chunk.length;
  });

  console.log(`Created WAV blob with final size: ${buffer.byteLength}`);
  return new Blob([buffer], { type: 'audio/wav' });
}
function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

// --- Initial Page Load ---
updateStatus("Ready to connect.");