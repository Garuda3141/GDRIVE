import { sendSignal } from "./signaling";

export function createConnection(
  remoteId: string,
  onData: (data: string | ArrayBuffer) => void
): { conn: RTCPeerConnection; channel: RTCDataChannel } {
  const conn = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  console.log(" New RTCPeerConnection for", remoteId);

  conn.oniceconnectionstatechange = () => console.log("ICE:", conn.iceConnectionState);
  conn.onconnectionstatechange = () => console.log("Conn:", conn.connectionState);

  // Offerer’s channel:
  const channel = conn.createDataChannel("chat");
  channel.binaryType = "arraybuffer";
  channel.onopen = () => console.log("✅ DataChannel opened with", remoteId);
  channel.onmessage = (e) => onData(e.data);

  conn.onicecandidate = (e) => {
    if (e.candidate) {
      console.log("→ ICE to", remoteId, e.candidate);
      sendSignal(remoteId, { type: "candidate", candidate: e.candidate });
    }
  };

  // Answerer’s channel is handled in App.tsx under conn.ondatachannel

  return { conn, channel };
}

export async function createOffer(remoteId: string, conn: RTCPeerConnection) {
  const offer = await conn.createOffer();
  await conn.setLocalDescription(offer);
  console.log("→ OFFER to", remoteId);
  sendSignal(remoteId, { type: "offer", sdp: offer });
}

export async function handleOffer(
  remoteId: string,
  conn: RTCPeerConnection,
  offer: RTCSessionDescriptionInit
) {
  console.log("← OFFER from", remoteId);
  await conn.setRemoteDescription(new RTCSessionDescription(offer));
}

export async function handleAnswer(
  remoteId: string,
  conn: RTCPeerConnection,
  answer: RTCSessionDescriptionInit
) {
  console.log("← ANSWER from", remoteId);
  await conn.setRemoteDescription(new RTCSessionDescription(answer));
}

export async function handleCandidate(conn: RTCPeerConnection, candidate: RTCIceCandidateInit) {
  console.log("← CANDIDATE", candidate);
  await conn.addIceCandidate(new RTCIceCandidate(candidate));
}
