export interface ServerConfig {
  /** TCP port that accepts Beast-format binary frames from feeders. */
  beastPort: number;
  /** TCP port that accepts raw AVR-format hex frames (e.g. "*8D...;\n"). */
  rawPort: number;
  /** TCP port that accepts SBS BaseStation CSV messages. */
  sbsPort: number;
  /** HTTP port for the web UI and JSON API (also WebSocket upgrade). */
  httpPort: number;
  /** Bind address for all listeners. */
  host: string;
  /** Drop aircraft from the store after this many ms of no updates. */
  aircraftTtlMs: number;
  /** Interval for pruning stale aircraft and broadcasting snapshots. */
  tickIntervalMs: number;
  /** Optional public `host:port` shown on the /feed page for Beast feeders. */
  publicBeast?: string;
  /** Optional public `host:port` shown on the /feed page for raw AVR feeders. */
  publicRaw?: string;
  /** Optional public `host:port` shown on the /feed page for SBS feeders. */
  publicSbs?: string;
  /** Optional operator/site name to display on the /feed page. */
  siteName?: string;
}

function intFromEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function stringOrUndef(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export function loadConfig(): ServerConfig {
  return {
    beastPort: intFromEnv("ADSB_BEAST_PORT", 30005),
    rawPort: intFromEnv("ADSB_RAW_PORT", 30002),
    sbsPort: intFromEnv("ADSB_SBS_PORT", 30003),
    // Railway (and most PaaS) inject PORT; fall back to ADSB_HTTP_PORT, then 8080.
    httpPort: intFromEnv("PORT", intFromEnv("ADSB_HTTP_PORT", 8080)),
    host: process.env.ADSB_HOST ?? "0.0.0.0",
    aircraftTtlMs: intFromEnv("ADSB_AIRCRAFT_TTL_MS", 60_000),
    tickIntervalMs: intFromEnv("ADSB_TICK_MS", 1_000),
    publicBeast: stringOrUndef("ADSB_PUBLIC_BEAST"),
    publicRaw: stringOrUndef("ADSB_PUBLIC_RAW"),
    publicSbs: stringOrUndef("ADSB_PUBLIC_SBS"),
    siteName: stringOrUndef("ADSB_SITE_NAME"),
  };
}
