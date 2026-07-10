import http from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { AircraftStore } from "./aircraftStore";
import type { BeastFeeder, RawFeeder, SbsFeeder } from "./feeders";
import type { ServerConfig } from "./config";

export interface FeederRefs {
  beast: BeastFeeder;
  raw: RawFeeder;
  sbs: SbsFeeder;
}

export function createWebServer(
  store: AircraftStore,
  feeders: FeederRefs,
  config: ServerConfig,
): { server: http.Server; app: express.Express; wss: WebSocketServer } {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/feed", (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "feed.html"));
  });

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

  app.get("/api/feed-info", (_req, res) => {
    res.json({
      siteName: config.siteName ?? null,
      beast: config.publicBeast ?? null,
      raw: config.publicRaw ?? null,
      sbs: config.publicSbs ?? null,
      internal: {
        beastPort: config.beastPort,
        rawPort: config.rawPort,
        sbsPort: config.sbsPort,
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
