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
  /** TCP port that streams live Beast frames out to pull-based consumers (e.g. aggregators). */
  beastOutPort: number;
  /** Optional public `host:port` for the Beast output feed, given to pull-based consumers. */
  publicBeastOut?: string;
  /** Optional operator/site name to display on the /feed page. */
  siteName?: string;
  /** Optional receiver latitude, used to show distance/bearing to aircraft. */
  siteLat?: number;
  /** Optional receiver longitude, used to show distance/bearing to aircraft. */
  siteLon?: number;
}

function intFromEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function floatFromEnv(name: string): number | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

function stringOrUndef(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export function loadConfig(): ServerConfig {
  // Railway's proxy/healthcheck always targets this exact PORT value, so it
  // must never be remapped — any port shuffling has to happen on the feeder
  // side instead.
  const httpPort = intFromEnv("PORT", intFromEnv("ADSB_HTTP_PORT", 8080));

  // A feeder port colliding with httpPort causes an EADDRINUSE crash loop
  // before the healthcheck can ever pass; bump the feeder off httpPort
  // instead of touching httpPort (which Railway's proxy depends on).
  const reserved = new Set<number>([httpPort]);
  const resolveFeederPort = (name: string, fallback: number): number => {
    let port = intFromEnv(name, fallback);
    while (reserved.has(port)) {
      console.error(
        `[config] ${name}=${port} collides with httpPort=${httpPort}; bumping to ${port + 1}.`,
      );
      port += 1;
    }
    reserved.add(port);
    return port;
  };

  const beastPort = resolveFeederPort("ADSB_BEAST_PORT", 30005);
  const rawPort = resolveFeederPort("ADSB_RAW_PORT", 30002);
  const sbsPort = resolveFeederPort("ADSB_SBS_PORT", 30003);
  const beastOutPort = resolveFeederPort("ADSB_BEAST_OUT_PORT", 30006);

  return {
    beastPort,
    rawPort,
    sbsPort,
    beastOutPort,
    httpPort,
    host: process.env.ADSB_HOST ?? "0.0.0.0",
    aircraftTtlMs: intFromEnv("ADSB_AIRCRAFT_TTL_MS", 60_000),
    tickIntervalMs: intFromEnv("ADSB_TICK_MS", 1_000),
    publicBeast: stringOrUndef("ADSB_PUBLIC_BEAST"),
    publicRaw: stringOrUndef("ADSB_PUBLIC_RAW"),
    publicSbs: stringOrUndef("ADSB_PUBLIC_SBS"),
    publicBeastOut: stringOrUndef("ADSB_PUBLIC_BEAST_OUT"),
    siteName: stringOrUndef("ADSB_SITE_NAME"),
    siteLat: floatFromEnv("ADSB_SITE_LAT"),
    siteLon: floatFromEnv("ADSB_SITE_LON"),
  };
}
