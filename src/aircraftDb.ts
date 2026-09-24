/**
 * Aircraft registry lookups (registration, ICAO type, manufacturer) from
 * the free adsbdb.com public API, by Mode-S / ICAO24 hex. Results are
 * cached in-memory since registry data is essentially static per aircraft
 * — each ICAO is queried at most once per TTL regardless of message rate.
 */

export interface AircraftRegistryInfo {
  registration?: string;
  icaoAircraftType?: string;
  aircraftType?: string;
  manufacturer?: string;
  owner?: string;
  ownerCountry?: string;
}

interface CacheEntry {
  info: AircraftRegistryInfo | null;
  fetchedAt: number;
}

const FOUND_TTL_MS = 24 * 60 * 60_000;
const NOT_FOUND_TTL_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 5_000;

export class AircraftRegistryLookup {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<AircraftRegistryInfo | null>>();

  constructor(private readonly baseUrl = "https://api.adsbdb.com/v0/aircraft") {}

  /** Cached, deduped lookup — safe to call once per newly-seen aircraft. */
  async lookup(icao: string): Promise<AircraftRegistryInfo | null> {
    const key = icao.toLowerCase();
    const cached = this.cache.get(key);
    if (cached) {
      const ttl = cached.info ? FOUND_TTL_MS : NOT_FOUND_TTL_MS;
      if (Date.now() - cached.fetchedAt < ttl) return cached.info;
    }

    const existing = this.pending.get(key);
    if (existing) return existing;

    const promise = this.fetchOne(key)
      .then((info) => {
        this.cache.set(key, { info, fetchedAt: Date.now() });
        return info;
      })
      .catch(() => {
        this.cache.set(key, { info: null, fetchedAt: Date.now() });
        return null;
      })
      .finally(() => this.pending.delete(key));

    this.pending.set(key, promise);
    return promise;
  }

  private async fetchOne(icao: string): Promise<AircraftRegistryInfo | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/${icao}`, { signal: controller.signal });
      if (!res.ok) return null; // includes 404 for unknown aircraft
      const body = (await res.json()) as { response?: { aircraft?: Record<string, unknown> } };
      const a = body.response?.aircraft;
      if (!a) return null;
      return {
        registration: strOrUndef(a.registration),
        icaoAircraftType: strOrUndef(a.icao_type),
        aircraftType: strOrUndef(a.type),
        manufacturer: strOrUndef(a.manufacturer),
        owner: strOrUndef(a.registered_owner),
        ownerCountry: strOrUndef(a.registered_owner_country_name),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
