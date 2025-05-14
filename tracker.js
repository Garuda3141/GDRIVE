const WebSocket = require("ws");
const crypto = require("crypto");

const wss = new WebSocket.Server({ port: 3001 });
const peers = new Map();

wss.on("connection", (ws) => {
  const id = crypto.randomUUID();
  peers.set(id, ws);
  ws.send(JSON.stringify({ type: "init", id }));

  broadcastPeers();

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);
    if (data.to && peers.has(data.to)) {
      peers.get(data.to).send(JSON.stringify({ ...data, from: id }));
    }
  });

  ws.on("close", () => {
    peers.delete(id);
    broadcastPeers();
  });

  function broadcastPeers() {
    const peerList = [...peers.keys()];
    for (const [pid, sock] of peers) {
      sock.send(
        JSON.stringify({ type: "peer-list", peers: peerList.filter((p) => p !== pid) })
      );
    }
  }
});

console.log("Tracker listening on ws://localhost:3001");
