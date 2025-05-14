import React, { useEffect, useState, useRef } from "react";
import { on, sendSignal, selfId } from "./lib/signaling";
import {
  createConnection,
  createOffer,
  handleOffer,
  handleAnswer,
  handleCandidate,
} from "./lib/webrtc";
import { v4 as uuidv4 } from "uuid";

type FileOffer = { type: "file-offer"; id: string; name: string; size: number };
type FileAccept = { type: "file-accept" | "file-reject"; id: string };
type FileDone = { type: "file-done"; id: string };

export default function App() {
  const [peers, setPeers] = useState<string[]>([]);
  const [messages, setMessages] = useState<string[]>([]);
  const [activePeer, setActivePeer] = useState<string | null>(null);
  const [peerConnection, setPeerConnection] = useState<RTCPeerConnection | null>(null);
  const [channels, setChannels] = useState<Record<string, RTCDataChannel>>({});
  const [input, setInput] = useState("");

  const [incomingOffer, setIncomingOffer] = useState<FileOffer | null>(null);
  const [receivingFiles, setReceivingFiles] = useState<
    Record<string, { name: string; size: number; received: number; buffers: Uint8Array[] }>
  >({});

  // Map of pending file-offer IDs to resolve functions
  const pendingAccept = useRef(new Map<string, (accepted: boolean) => void>());

  // 1) Peer discovery
  useEffect(() => {
    on("peer-list", ({ peers }) => {
      setPeers(peers.filter((id: string) => id !== selfId));
    });
  }, []);

  // 2) Signaling handler (offers, answers, candidates)
  useEffect(() => {
    on("signal", async (data: any) => {
      const { signal, from } = data;
      const { type: sigType } = signal;

      // ANSWERER path: got an OFFER from peer
      if (sigType === "offer") {
        const conn = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        setPeerConnection(conn);
        setActivePeer(from);

        conn.onicecandidate = (e) => {
          if (e.candidate) sendSignal(from, { type: "candidate", candidate: e.candidate });
        };

        conn.ondatachannel = (e) => {
          const ch = e.channel;
          ch.binaryType = "arraybuffer";
          setChannels((c) => ({ ...c, [from]: ch }));
          ch.onopen = () => console.log("Incoming DataChannel open");
          ch.onmessage = (evt) => handleDataMessage(evt.data);
        };

        await conn.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        const answer = await conn.createAnswer();
        await conn.setLocalDescription(answer);
        sendSignal(from, { type: "answer", sdp: answer });
        return;
      }

      // OFFERER path: got an ANSWER from peer
      if (sigType === "answer" && peerConnection && activePeer === from) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        return;
      }

      // ICE candidates
      if (sigType === "candidate" && peerConnection) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    });
  }, [peerConnection, activePeer]);

  // 3) Start connection (offerer)
  const startConnection = (peerId: string) => {
    const { conn, channel } = createConnection(peerId, handleDataMessage);
    conn.onicecandidate = (e) => {
      if (e.candidate) sendSignal(peerId, { type: "candidate", candidate: e.candidate });
    };
    setPeerConnection(conn);
    setActivePeer(peerId);
    setChannels((c) => ({ ...c, [peerId]: channel }));
    createOffer(peerId, conn);
  };

  // 4) Handle incoming DataChannel messages
  function handleDataMessage(raw: string | ArrayBuffer) {
    if (typeof raw === "string") {
      console.log("Received raw data:", raw);
      try {
        const obj = JSON.parse(raw);
        switch (obj.type) {
          case "text":
            setMessages((m) => [...m, `Peer: ${obj.message}`]);
            return;
          case "file-offer":
            setIncomingOffer(obj);
            return;
          case "file-accept":
          case "file-reject":
            pendingAccept.current.get(obj.id)?.(obj.type === "file-accept");
            pendingAccept.current.delete(obj.id);
            return;
          case "file-chunk": {
            const { id, data: b64 } = obj as { id: string; data: string };
            setReceivingFiles((prev) => {
              const rec = prev[id];
              if (!rec) {
                console.error("No receiver state for", id);
                return prev;
              }
              const bin = atob(b64);
              const arr = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
              const updated = {
                ...rec,
                received: rec.received + arr.byteLength,
                buffers: [...rec.buffers, arr],
              };
              setMessages((m) => [
                ...m,
                ` Receiving "${rec.name}" ${((updated.received / rec.size) * 100).toFixed(1)}%`,
              ]);
              return { ...prev, [id]: updated };
            });
            return;
          }
          case "file-done": {
            const { id } = obj as FileDone;
            setReceivingFiles((prev) => {
              const rec = prev[id];
              if (!rec) {
                console.error("No receiver state for", id);
                return prev;
              }
              const blob = new Blob(rec.buffers);
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = rec.name;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              setMessages((m) => [...m, ` Received file "${rec.name}"`]);
              const copy = { ...prev };
              delete copy[id];
              return copy;
            });
            return;
          }
          default:
            setMessages((m) => [...m, `Peer: ${raw}`]);
            return;
        }
      } catch (e) {
        console.error("JSON Parse error:", e);
        setMessages((m) => [...m, `Peer: ${raw}`]);
      }
    } else {
      console.error("Unexpected non-string data received:", raw);
    }
  }

  // 5) Send chat message
  const sendMessage = () => {
    if (!activePeer) return;
    const ch = channels[activePeer];
    if (ch?.readyState === "open") {
      ch.send(JSON.stringify({ type: "text", message: input }));
      setMessages((m) => [...m, `Me: ${input}`]);
      setInput("");
    }
  };

  // 6) File sender
  async function startFileTransfer(peerId: string, file: File) {
    const fid = uuidv4();
    const ch = channels[peerId];
    if (!ch || ch.readyState !== "open") return alert("Channel not open");
    ch.send(JSON.stringify({ type: "file-offer", id: fid, name: file.name, size: file.size }));
    setMessages((m) => [...m, ` Offered file "${file.name}" to ${peerId}`]);
    const accepted = await new Promise<boolean>((resolve) =>
      pendingAccept.current.set(fid, resolve)
    );
    if (!accepted) {
      setMessages((m) => [...m, `Peer rejected file "${file.name}"`]);
      return;
    }
    setMessages((m) => [...m, `Peer accepted file "${file.name}"`]);
    const CHUNK = 16 * 1024;
    let offset = 0;
    while (offset < file.size) {
      const slice = file.slice(offset, offset + CHUNK);
      const buf = new Uint8Array(await slice.arrayBuffer());
      let binary = "";
      for (let i = 0; i < buf.byteLength; i++) binary += String.fromCharCode(buf[i]);
      const b64 = btoa(binary);
      ch.send(JSON.stringify({ type: "file-chunk", id: fid, data: b64 }));
      offset += CHUNK;
    }
    ch.send(JSON.stringify({ type: "file-done", id: fid }));
    setMessages((m) => [...m, `Finished sending "${file.name}"`]);
  }

  // 7) Respond to incoming offer
  function respondToOffer(accept: boolean) {
    if (!incomingOffer || !activePeer) return;
    const { id, name, size } = incomingOffer;
    const ch = channels[activePeer];
    ch.send(JSON.stringify({ type: accept ? "file-accept" : "file-reject", id }));
    if (accept) {
      setReceivingFiles((r) => ({
        ...r,
        [id]: { name, size, received: 0, buffers: [] },
      }));
      setMessages((m) => [...m, `Started receiving "${name}"`]);
    }
    setIncomingOffer(null);
  }

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif" }}>
      <h1>gsend</h1>
      <p>Your ID: {selfId}</p>

      <h2>Peers</h2>
      {peers.map((id) => (
        <button key={id} onClick={() => startConnection(id)} style={{ margin: 4 }}>
          Connect {id}
        </button>
      ))}

      <h2>Chat & File Sharing</h2>
      <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid #ccc", padding: 8 }}>
        {messages.map((m, i) => (
          <div key={i}>{m}</div>
        ))}
      </div>

      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && sendMessage()}
        placeholder="Type a message and press Enter"
        style={{ width: "80%", marginRight: 8 }}
      />
      <button onClick={sendMessage}>Send</button>

      <div style={{ marginTop: 16 }}>
        <input
          type="file"
          disabled={!activePeer || channels[activePeer]?.readyState !== "open"}
          onChange={(e) => e.target.files?.[0] && startFileTransfer(activePeer!, e.target.files[0])}
        />
      </div>

      {incomingOffer && (
        <div
          style={{
            position: "fixed",
            top: "30%",
            left: "30%",
            background: "white",
            border: "1px solid #333",
            padding: 16,
          }}
        >
          <p>
            Peer wants to send you “{incomingOffer.name}” ({(incomingOffer.size / 1024).toFixed(1)}{" "}
            KB). Accept?
          </p>
          <button onClick={() => respondToOffer(true)} style={{ marginRight: 8 }}>
            Accept
          </button>
          <button onClick={() => respondToOffer(false)}>Reject</button>
        </div>
      )}
    </div>
  );
}
