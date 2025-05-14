export const ws = new WebSocket("ws://localhost:3001");

export let selfId = "";
const listeners: Record<string, (data: any) => void> = {};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === "init") {
    selfId = data.id;
  } else if (listeners[data.type]) {
    listeners[data.type](data);
  }
};

export function on(type: string, callback: (data: any) => void) {
  listeners[type] = callback;
}

export function send(to: string, payload: object) {
  ws.send(JSON.stringify({ to, ...payload }));
}

export function sendSignal(remoteId: string, signal: object) {
  send(remoteId, { type: "signal", signal });
}
