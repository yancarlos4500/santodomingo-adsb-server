import http from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { AircraftStore } from "./aircraftStore";
import type { BeastFeeder, RawFeeder, SbsFeeder } from "./feeders";

export interface FeederRefs {
  beast: BeastFeeder;
  raw: RawFeeder;
  sbs: SbsFeeder;
}

export function createWebServer(
  store: AircraftStore,
  feeders: FeederRefs,
): { server: http.Server; app: express.Express; wss: WebSocketServer } {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/api/aircraft", (_req, res) => {
    res.json({ now: Date.now(), aircraft: store.snapshot() });
  });

  app.get("/api/stats", (_req, res) => {
    res.json({
      now: Date.now(),
      aircraft: store.size(),
      feeders: {
        beast: feeders.beast.stats(),
        raw: feeders.raw.stats(),
        sbs: feeders.sbs.stats(),
      },
    });
  });

  app.get("/healthz", (_req, res) => {
    res.type("text/plain").send("ok");
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "snapshot", aircraft: store.snapshot() }));
  });

  return { server, app, wss };
}

export function broadcastSnapshot(wss: WebSocketServer, store: AircraftStore) {
  if (wss.clients.size === 0) return;
  const payload = JSON.stringify({
    type: "snapshot",
    now: Date.now(),
    aircraft: store.snapshot(),
  });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}
