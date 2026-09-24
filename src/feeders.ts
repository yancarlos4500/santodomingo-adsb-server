import net from "node:net";
import { AircraftStore, AircraftUpdate } from "./aircraftStore";
import { ModeSDecoder, DecodedMessage } from "./decoder";

export interface FeederStats {
  connections: number;
  totalFrames: number;
  totalBytes: number;
  peers: string[];
}

/** Anything that can accept a raw Mode-S frame and re-share it as Beast. */
export interface BeastSink {
  broadcastFrame(payload: Buffer, timestamp?: Buffer, signal?: number): void;
}

/**
 * A generic TCP listener whose per-connection handler is supplied by the
 * caller. All feeder endpoints share this so connection accounting,
 * error handling, and graceful shutdown live in one place.
 */
abstract class FeederListener {
  protected readonly server: net.Server;
  protected readonly clients = new Set<net.Socket>();
  protected framesTotal = 0;
  protected bytesTotal = 0;
  private warnedNoFrames = false;

  constructor(
    readonly name: string,
    protected readonly store: AircraftStore,
    protected readonly decoder: ModeSDecoder,
    /** Fan-out targets so inbound frames can be re-shared with pull consumers and pushed to upstream aggregators. */
    protected readonly sinks: BeastSink[] = [],
  ) {
    this.server = net.createServer((socket) => this.handleSocket(socket));
  }

  listen(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server.once("error", onError);
      this.server.listen(port, host, () => {
        this.server.off("error", onError);
        this.server.on("error", (err) =>
          console.error(`[${this.name}] server error:`, err.message),
        );
        console.log(`[${this.name}] listening on ${host}:${port}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    for (const c of this.clients) c.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  stats(): FeederStats {
    return {
      connections: this.clients.size,
      totalFrames: this.framesTotal,
      totalBytes: this.bytesTotal,
      peers: Array.from(this.clients).map(
        (s) => `${s.remoteAddress ?? "?"}:${s.remotePort ?? 0}`,
      ),
    };
  }

  protected abstract handleSocket(socket: net.Socket): void;

  /**
   * Call after processing each chunk. Warns once if a lot of bytes have
   * arrived without a single valid frame being decoded — usually means
   * the feeder is sending the wrong format for this port.
   */
  protected maybeWarnNoFrames(threshold = 1_000_000): void {
    if (this.warnedNoFrames || this.framesTotal > 0 || this.bytesTotal <= threshold) return;
    this.warnedNoFrames = true;
    console.warn(
      `[${this.name}] received ${this.bytesTotal} bytes but decoded 0 frames — ` +
        `the feeder is likely using the wrong format/port for this endpoint.`,
    );
  }

  protected apply(msg: DecodedMessage, source: string, rssi?: number) {
    const upd: AircraftUpdate = { icao: msg.icao, source };
    if (msg.callsign) upd.callsign = msg.callsign;
    if (msg.category !== undefined) upd.category = msg.category;
    if (msg.lat !== undefined) upd.lat = msg.lat;
    if (msg.lon !== undefined) upd.lon = msg.lon;
    if (msg.altitudeFt !== undefined) upd.altitudeFt = msg.altitudeFt;
    if (msg.altitudeGeomFt !== undefined) upd.altitudeGeomFt = msg.altitudeGeomFt;
    if (msg.groundSpeedKt !== undefined) upd.groundSpeedKt = msg.groundSpeedKt;
    if (msg.trackDeg !== undefined) upd.trackDeg = msg.trackDeg;
    if (msg.verticalRateFpm !== undefined) upd.verticalRateFpm = msg.verticalRateFpm;
    if (msg.onGround !== undefined) upd.onGround = msg.onGround;
    if (msg.nic !== undefined) upd.nic = msg.nic;
    if (msg.rc !== undefined) upd.rc = msg.rc;
    if (msg.posSource !== undefined) upd.posSource = msg.posSource;
    if (msg.navAltitudeMcpFt !== undefined) upd.navAltitudeMcpFt = msg.navAltitudeMcpFt;
    if (msg.navAltitudeFmsFt !== undefined) upd.navAltitudeFmsFt = msg.navAltitudeFmsFt;
    if (msg.navQnh !== undefined) upd.navQnh = msg.navQnh;
    if (msg.navHeadingDeg !== undefined) upd.navHeadingDeg = msg.navHeadingDeg;
    if (rssi !== undefined) upd.rssi = rssi;
    this.store.upsert(upd);
  }

  protected registerSocket(socket: net.Socket): string {
    const peer = `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? 0}`;
    this.clients.add(socket);
    console.log(`[${this.name}] feeder connected: ${peer}`);
    socket.setNoDelay(true);
    socket.on("close", () => {
      this.clients.delete(socket);
      console.log(`[${this.name}] feeder disconnected: ${peer}`);
    });
    socket.on("error", (err) =>
      console.warn(`[${this.name}] socket error ${peer}: ${err.message}`),
    );
    return peer;
  }
}

/**
 * Beast binary format:
 *   0x1a <type> <6-byte timestamp> <1-byte signal> <payload>
 * where type '1'/'2'/'3' correspond to Mode-AC (2 bytes), Mode-S short
 * (7 bytes) and Mode-S long (14 bytes). Any 0x1a byte inside header or
 * payload is escaped as 0x1a 0x1a.
 */
export class BeastFeeder extends FeederListener {
  private static readonly ESCAPE = 0x1a;
  private static readonly PAYLOAD_SIZE: Record<number, number> = {
    0x31: 2, // Mode-AC — we ignore, no ICAO
    0x32: 7, // Mode-S short
    0x33: 14, // Mode-S long
  };

  constructor(store: AircraftStore, decoder: ModeSDecoder, sinks: BeastSink[] = []) {
    super("beast", store, decoder, sinks);
  }

  protected handleSocket(socket: net.Socket): void {
    const peer = this.registerSocket(socket);
    let buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      this.bytesTotal += chunk.length;
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      buf = this.drain(buf, peer);
      this.maybeWarnNoFrames();
    });
  }

  private drain(buf: Buffer, peer: string): Buffer<ArrayBufferLike> {
    let i = 0;
    while (i < buf.length) {
      // Seek to next escape byte.
      const start = buf.indexOf(BeastFeeder.ESCAPE, i);
      if (start < 0) return Buffer.alloc(0);
      if (start + 1 >= buf.length) return buf.subarray(start);
      const type = buf[start + 1];
      const payloadSize = BeastFeeder.PAYLOAD_SIZE[type];
      if (payloadSize === undefined) {
        i = start + 1; // resync
        continue;
      }
      // Header (2) + timestamp (6) + signal (1) + payload; every 0x1a in
      // that stretch (except the initial one) is doubled.
      const parsed = this.readEscaped(buf, start + 2, 6 + 1 + payloadSize);
      if (!parsed) return buf.subarray(start); // wait for more data
      const { data, consumed } = parsed;
      const payload = data.subarray(7); // skip timestamp+signal
      this.framesTotal += 1;
      const msg = this.decoder.decode(payload);
      if (msg) this.apply(msg, peer, signalByteToRssi(data[6]));
      for (const sink of this.sinks) sink.broadcastFrame(payload, data.subarray(0, 6), data[6]);
      i = start + 2 + consumed;
    }
    return buf.subarray(i);
  }

  private readEscaped(
    buf: Buffer,
    from: number,
    want: number,
  ): { data: Buffer; consumed: number } | null {
    const out = Buffer.alloc(want);
    let outIdx = 0;
    let p = from;
    while (outIdx < want) {
      if (p >= buf.length) return null;
      const b = buf[p];
      if (b === BeastFeeder.ESCAPE) {
        if (p + 1 >= buf.length) return null;
        if (buf[p + 1] !== BeastFeeder.ESCAPE) return null; // frame boundary
        out[outIdx++] = BeastFeeder.ESCAPE;
        p += 2;
      } else {
        out[outIdx++] = b;
        p += 1;
      }
    }
    return { data: out, consumed: p - from };
  }
}

/**
 * Raw AVR format — newline-delimited ASCII, each line starts with '*' or
 * '@' (with a 12-hex-char MLAT timestamp prefix) and ends with ';'.
 */
export class RawFeeder extends FeederListener {
  constructor(store: AircraftStore, decoder: ModeSDecoder, sinks: BeastSink[] = []) {
    super("raw", store, decoder, sinks);
  }

  protected handleSocket(socket: net.Socket): void {
    const peer = this.registerSocket(socket);
    let leftover = "";
    socket.on("data", (chunk) => {
      this.bytesTotal += chunk.length;
      leftover += chunk.toString("ascii");
      const lines = leftover.split(/\r?\n/);
      leftover = lines.pop() ?? "";
      for (const line of lines) this.handleLine(line.trim(), peer);
      this.maybeWarnNoFrames();
    });
  }

  private handleLine(line: string, peer: string): void {
    if (!line) return;
    let hex: string;
    if (line.startsWith("*")) {
      hex = line.slice(1);
    } else if (line.startsWith("@")) {
      hex = line.slice(1 + 12); // strip 12-char MLAT timestamp
    } else {
      return;
    }
    if (hex.endsWith(";")) hex = hex.slice(0, -1);
    if (hex.length !== 14 && hex.length !== 28) return;
    let frame: Buffer;
    try {
      frame = Buffer.from(hex, "hex");
    } catch {
      return;
    }
    this.framesTotal += 1;
    const msg = this.decoder.decode(frame);
    if (msg) this.apply(msg, peer);
    for (const sink of this.sinks) sink.broadcastFrame(frame);
  }
}

/**
 * SBS BaseStation format — CSV, one message per line. We consume the
 * fields directly rather than re-decoding since the sender has already
 * done that. Field layout (1-indexed):
 *   1 MSG, 2 transmissionType, 3 sessionId, 4 aircraftId, 5 hexIdent,
 *   6 flightId, 7-8 date/time generated, 9-10 date/time logged,
 *   11 callsign, 12 altitude, 13 groundSpeed, 14 track, 15 lat, 16 lon,
 *   17 verticalRate, 18 squawk, 19 alert, 20 emergency, 21 spi,
 *   22 isOnGround
 */
export class SbsFeeder extends FeederListener {
  constructor(store: AircraftStore, decoder: ModeSDecoder) {
    super("sbs", store, decoder);
  }

  protected handleSocket(socket: net.Socket): void {
    const peer = this.registerSocket(socket);
    let leftover = "";
    socket.on("data", (chunk) => {
      this.bytesTotal += chunk.length;
      leftover += chunk.toString("utf8");
      const lines = leftover.split(/\r?\n/);
      leftover = lines.pop() ?? "";
      for (const line of lines) this.handleLine(line, peer);
      this.maybeWarnNoFrames();
    });
  }

  private handleLine(line: string, peer: string): void {
    if (!line || !line.startsWith("MSG,")) return;
    const parts = line.split(",");
    const icao = parts[4]?.toLowerCase();
    if (!icao || icao.length !== 6) return;
    const upd: AircraftUpdate = { icao, source: peer };

    const callsign = parts[10]?.trim();
    if (callsign) upd.callsign = callsign;
    const alt = numOr(parts[11]);
    if (alt !== undefined) upd.altitudeFt = alt;
    const gs = numOr(parts[12]);
    if (gs !== undefined) upd.groundSpeedKt = gs;
    const trk = numOr(parts[13]);
    if (trk !== undefined) upd.trackDeg = trk;
    const lat = numOr(parts[14]);
    const lon = numOr(parts[15]);
    if (lat !== undefined && lon !== undefined) {
      upd.lat = lat;
      upd.lon = lon;
    }
    const vr = numOr(parts[16]);
    if (vr !== undefined) upd.verticalRateFpm = vr;
    const sq = parts[17]?.trim();
    if (sq) upd.squawk = sq;
    const og = parts[21]?.trim();
    if (og === "-1" || og?.toLowerCase() === "true") upd.onGround = true;
    else if (og === "0" || og?.toLowerCase() === "false") upd.onGround = false;

    this.framesTotal += 1;
    this.store.upsert(upd);
  }
}

function numOr(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const s = v.trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** Approximates dBFS from the Beast 8-bit AGC signal byte, dump1090-style: 20*log10(signal/255). */
function signalByteToRssi(signal: number): number | undefined {
  if (!signal) return undefined;
  return Math.round(20 * Math.log10(signal / 255) * 10) / 10;
}

/**
 * Beast binary "output" server for pull-based consumers (aggregators that
 * connect to us and expect a live Beast stream, mirroring dump1090's
 * net-ro-port). Frames decoded from any inbound feeder are re-encoded and
 * fanned out to every connected client here.
 */
export class BeastOutServer implements BeastSink {
  private readonly server: net.Server;
  private readonly clients = new Set<net.Socket>();
  private framesSent = 0;
  private bytesSent = 0;

  constructor(private readonly name = "beast-out") {
    this.server = net.createServer((socket) => this.handleSocket(socket));
  }

  listen(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server.once("error", onError);
      this.server.listen(port, host, () => {
        this.server.off("error", onError);
        this.server.on("error", (err) =>
          console.error(`[${this.name}] server error:`, err.message),
        );
        console.log(`[${this.name}] listening on ${host}:${port}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    for (const c of this.clients) c.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  stats(): FeederStats {
    return {
      connections: this.clients.size,
      totalFrames: this.framesSent,
      totalBytes: this.bytesSent,
      peers: Array.from(this.clients).map(
        (s) => `${s.remoteAddress ?? "?"}:${s.remotePort ?? 0}`,
      ),
    };
  }

  private handleSocket(socket: net.Socket): void {
    const peer = `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? 0}`;
    this.clients.add(socket);
    console.log(`[${this.name}] consumer connected: ${peer}`);
    socket.setNoDelay(true);
    socket.on("close", () => {
      this.clients.delete(socket);
      console.log(`[${this.name}] consumer disconnected: ${peer}`);
    });
    socket.on("error", (err) =>
      console.warn(`[${this.name}] socket error ${peer}: ${err.message}`),
    );
    socket.resume(); // consumers only read; discard anything they send
  }

  /** Re-encode a raw 7/14-byte Mode-S frame as Beast and fan it out to every connected client. */
  broadcastFrame(payload: Buffer, timestamp?: Buffer, signal = 0x00): void {
    if (this.clients.size === 0) return;
    if (payload.length !== 7 && payload.length !== 14) return;
    const frame = encodeBeastFrame(payload, timestamp, signal);
    this.framesSent += 1;
    this.bytesSent += frame.length;
    for (const client of this.clients) {
      if (!client.destroyed) client.write(frame);
    }
  }
}

const BEAST_ESCAPE = 0x1a;

function escapeBeastBytes(bytes: Buffer): Buffer {
  let escapes = 0;
  for (const b of bytes) if (b === BEAST_ESCAPE) escapes++;
  if (escapes === 0) return bytes;
  const out = Buffer.alloc(bytes.length + escapes);
  let o = 0;
  for (const b of bytes) {
    out[o++] = b;
    if (b === BEAST_ESCAPE) out[o++] = BEAST_ESCAPE;
  }
  return out;
}

/** timestamp defaults to all-zero (no real radio clock) when the source didn't provide one, e.g. raw AVR. */
function encodeBeastFrame(payload: Buffer, timestamp: Buffer | undefined, signal: number): Buffer {
  const type = payload.length === 14 ? 0x33 : 0x32;
  const ts = timestamp && timestamp.length === 6 ? timestamp : Buffer.alloc(6);
  const body = escapeBeastBytes(Buffer.concat([ts, Buffer.from([signal & 0xff]), payload]));
  return Buffer.concat([Buffer.from([BEAST_ESCAPE, type]), body]);
}

export interface PushClientStats {
  target: string;
  connected: boolean;
  totalFrames: number;
  totalBytes: number;
}

/**
 * Outbound Beast feed — connects out to an upstream aggregator that
 * expects us to push data (e.g. santodomingoatc) and reconnects with
 * backoff if the link drops.
 */
export class BeastPushClient implements BeastSink {
  private socket: net.Socket | null = null;
  private connected = false;
  private closed = false;
  private backoffMs = 1_000;
  private framesSent = 0;
  private bytesSent = 0;
  private readonly name: string;

  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {
    this.name = `push:${host}:${port}`;
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on("connect", () => {
      this.connected = true;
      this.backoffMs = 1_000;
      console.log(`[${this.name}] connected`);
    });
    socket.on("error", (err) => console.warn(`[${this.name}] error: ${err.message}`));
    socket.on("close", () => {
      this.connected = false;
      this.socket = null;
      if (this.closed) return;
      console.log(`[${this.name}] disconnected, retrying in ${this.backoffMs}ms`);
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });
  }

  broadcastFrame(payload: Buffer, timestamp?: Buffer, signal = 0x00): void {
    if (!this.connected || !this.socket || this.socket.destroyed) return;
    if (payload.length !== 7 && payload.length !== 14) return;
    const frame = encodeBeastFrame(payload, timestamp, signal);
    this.framesSent += 1;
    this.bytesSent += frame.length;
    this.socket.write(frame);
  }

  stats(): PushClientStats {
    return {
      target: `${this.host}:${this.port}`,
      connected: this.connected,
      totalFrames: this.framesSent,
      totalBytes: this.bytesSent,
    };
  }

  stop(): void {
    this.closed = true;
    this.socket?.destroy();
  }
}
