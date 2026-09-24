import http from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { AircraftStore } from "./aircraftStore";
import type { BeastFeeder, RawFeeder, SbsFeeder, BeastOutServer, BeastPushClient } from "./feeders";
import type { ServerConfig } from "./config";

export interface FeederRefs {
  beast: BeastFeeder;
  raw: RawFeeder;
  sbs: SbsFeeder;
  beastOut: BeastOutServer;
  pushClients: BeastPushClient[];
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

  // ADSBExchange/airplanes.live-style pull API: aircraft within `dist` nm of a point.
  app.get("/api/v3/lat/:lat/lon/:lon/dist/:dist", (req, res) => {
    const lat = Number.parseFloat(req.params.lat);
    const lon = Number.parseFloat(req.params.lon);
    const dist = Number.parseFloat(req.params.dist);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(dist)) {
      res.status(400).json({ error: "lat, lon, and dist must be numbers" });
      return;
    }
    const start = Date.now();
    const ac = [];
    for (const a of store.snapshot()) {
      if (a.lat === undefined || a.lon === undefined) continue;
      const dst = haversineNm(lat, lon, a.lat, a.lon);
      if (dst > dist) continue;
      ac.push({
        hex: a.icao,
        type: a.posSource,
        flight: a.callsign,
        category: a.category,
        alt_baro: a.onGround ? "ground" : a.altitudeFt ?? null,
        alt_geom: a.altitudeGeomFt,
        gs: a.groundSpeedKt,
        track: a.trackDeg,
        baro_rate: a.verticalRateFpm,
        squawk: a.squawk,
        lat: a.lat,
        lon: a.lon,
        nic: a.nic,
        rc: a.rc,
        messages: a.messages,
        seen: Math.round((Date.now() - a.lastSeen) / 1000),
        seen_pos: Math.round((Date.now() - a.lastSeen) / 1000),
        rssi: a.rssi,
        dst: Math.round(dst * 10) / 10,
        dir: Math.round(bearingDeg(lat, lon, a.lat, a.lon)),
      });
    }
    res.json({ ac, msg: "No error", now: Date.now(), total: ac.length, ctime: Date.now(), ptime: Date.now() - start });
  });

  app.get("/api/stats", (_req, res) => {
    res.json({
      now: Date.now(),
      aircraft: store.size(),
      feeders: {
        beast: feeders.beast.stats(),
        raw: feeders.raw.stats(),
        sbs: feeders.sbs.stats(),
        beastOut: feeders.beastOut.stats(),
      },
      pushTargets: feeders.pushClients.map((p) => p.stats()),
    });
  });

  app.get("/api/feed-info", (_req, res) => {
    res.json({
      siteName: config.siteName ?? null,
      siteLat: config.siteLat ?? null,
      siteLon: config.siteLon ?? null,
      beast: config.publicBeast ?? null,
      raw: config.publicRaw ?? null,
      sbs: config.publicSbs ?? null,
      beastOut: config.publicBeastOut ?? null,
      internal: {
        beastPort: config.beastPort,
        rawPort: config.rawPort,
        sbsPort: config.sbsPort,
        beastOutPort: config.beastOutPort,
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

const EARTH_RADIUS_NM = 3440.065;

function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(a));
}

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
