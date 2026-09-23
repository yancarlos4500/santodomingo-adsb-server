import net from "node:net";
import { AircraftStore, AircraftUpdate } from "./aircraftStore";
import { ModeSDecoder, DecodedMessage } from "./decoder";

export interface FeederStats {
  connections: number;
  totalFrames: number;
  totalBytes: number;
  peers: string[];
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

  protected apply(msg: DecodedMessage, source: string) {
    const upd: AircraftUpdate = { icao: msg.icao, source };
    if (msg.callsign) upd.callsign = msg.callsign;
    if (msg.lat !== undefined) upd.lat = msg.lat;
    if (msg.lon !== undefined) upd.lon = msg.lon;
    if (msg.altitudeFt !== undefined) upd.altitudeFt = msg.altitudeFt;
    if (msg.groundSpeedKt !== undefined) upd.groundSpeedKt = msg.groundSpeedKt;
    if (msg.trackDeg !== undefined) upd.trackDeg = msg.trackDeg;
    if (msg.verticalRateFpm !== undefined) upd.verticalRateFpm = msg.verticalRateFpm;
    if (msg.onGround !== undefined) upd.onGround = msg.onGround;
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

  constructor(store: AircraftStore, decoder: ModeSDecoder) {
    super("beast", store, decoder);
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
      if (msg) this.apply(msg, peer);
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
  constructor(store: AircraftStore, decoder: ModeSDecoder) {
    super("raw", store, decoder);
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
