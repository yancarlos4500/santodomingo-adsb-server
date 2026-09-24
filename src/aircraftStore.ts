import { EventEmitter } from "node:events";
import type { AircraftRegistryInfo } from "./aircraftDb";

export interface AircraftUpdate {
  icao: string;
  callsign?: string;
  category?: string;
  lat?: number;
  lon?: number;
  altitudeFt?: number;
  altitudeGeomFt?: number;
  groundSpeedKt?: number;
  trackDeg?: number;
  verticalRateFpm?: number;
  squawk?: string;
  onGround?: boolean;
  nic?: number;
  rc?: number;
  posSource?: "adsb_icao" | "tisb";
  /** Approximate signal strength in dB, derived from the Beast signal byte when available. */
  rssi?: number;
  navAltitudeMcpFt?: number;
  navAltitudeFmsFt?: number;
  navQnh?: number;
  navHeadingDeg?: number;
  /** Indicated airspeed, from a Comm-B Heading and Speed Report (BDS 6,0). */
  iasKt?: number;
  /** Mach number, from a Comm-B Heading and Speed Report (BDS 6,0). */
  mach?: number;
  /** Feeder id (e.g. remote address) that supplied the message. */
  source?: string;
}

export interface Aircraft extends AircraftUpdate, AircraftRegistryInfo {
  icao: string;
  firstSeen: number;
  lastSeen: number;
  messages: number;
  sources: Set<string>;
}

export interface AircraftJson {
  icao: string;
  callsign?: string;
  category?: string;
  lat?: number;
  lon?: number;
  altitudeFt?: number;
  altitudeGeomFt?: number;
  groundSpeedKt?: number;
  trackDeg?: number;
  verticalRateFpm?: number;
  squawk?: string;
  onGround?: boolean;
  nic?: number;
  rc?: number;
  posSource?: "adsb_icao" | "tisb";
  rssi?: number;
  navAltitudeMcpFt?: number;
  navAltitudeFmsFt?: number;
  navQnh?: number;
  navHeadingDeg?: number;
  iasKt?: number;
  mach?: number;
  registration?: string;
  icaoAircraftType?: string;
  aircraftType?: string;
  manufacturer?: string;
  owner?: string;
  ownerCountry?: string;
  firstSeen: number;
  lastSeen: number;
  messages: number;
  sources: string[];
}

/**
 * In-memory store of currently tracked aircraft, keyed by ICAO24 hex.
 * Emits `update` when an aircraft is added or modified, `new` the first
 * time an ICAO is seen, and `remove` when pruned for staleness.
 */
export class AircraftStore extends EventEmitter {
  private readonly aircraft = new Map<string, Aircraft>();

  constructor(private readonly ttlMs: number) {
    super();
  }

  upsert(update: AircraftUpdate): Aircraft {
    const now = Date.now();
    const icao = update.icao.toLowerCase();
    let ac = this.aircraft.get(icao);
    const isNew = !ac;
    if (!ac) {
      ac = {
        icao,
        firstSeen: now,
        lastSeen: now,
        messages: 0,
        sources: new Set<string>(),
      };
      this.aircraft.set(icao, ac);
    }

    if (update.callsign !== undefined) ac.callsign = update.callsign;
    if (update.category !== undefined) ac.category = update.category;
    if (update.lat !== undefined) ac.lat = update.lat;
    if (update.lon !== undefined) ac.lon = update.lon;
    if (update.altitudeFt !== undefined) ac.altitudeFt = update.altitudeFt;
    if (update.altitudeGeomFt !== undefined) ac.altitudeGeomFt = update.altitudeGeomFt;
    if (update.groundSpeedKt !== undefined) ac.groundSpeedKt = update.groundSpeedKt;
    if (update.trackDeg !== undefined) ac.trackDeg = update.trackDeg;
    if (update.verticalRateFpm !== undefined) ac.verticalRateFpm = update.verticalRateFpm;
    if (update.squawk !== undefined) ac.squawk = update.squawk;
    if (update.onGround !== undefined) ac.onGround = update.onGround;
    if (update.nic !== undefined) ac.nic = update.nic;
    if (update.rc !== undefined) ac.rc = update.rc;
    if (update.posSource !== undefined) ac.posSource = update.posSource;
    if (update.rssi !== undefined) ac.rssi = update.rssi;
    if (update.navAltitudeMcpFt !== undefined) ac.navAltitudeMcpFt = update.navAltitudeMcpFt;
    if (update.navAltitudeFmsFt !== undefined) ac.navAltitudeFmsFt = update.navAltitudeFmsFt;
    if (update.navQnh !== undefined) ac.navQnh = update.navQnh;
    if (update.navHeadingDeg !== undefined) ac.navHeadingDeg = update.navHeadingDeg;
    if (update.iasKt !== undefined) ac.iasKt = update.iasKt;
    if (update.mach !== undefined) ac.mach = update.mach;
    if (update.source) ac.sources.add(update.source);

    ac.lastSeen = now;
    ac.messages += 1;

    this.emit("update", ac);
    if (isNew) this.emit("new", ac);
    return ac;
  }

  /** Merges registry lookup results (registration/type/manufacturer) into an already-tracked aircraft. */
  attachRegistry(icao: string, info: AircraftRegistryInfo): void {
    const ac = this.aircraft.get(icao.toLowerCase());
    if (!ac) return; // aircraft aged out before the lookup resolved
    Object.assign(ac, info);
    this.emit("update", ac);
  }

  prune(now: number = Date.now()): string[] {
    const removed: string[] = [];
    for (const [icao, ac] of this.aircraft) {
      if (now - ac.lastSeen > this.ttlMs) {
        this.aircraft.delete(icao);
        removed.push(icao);
        this.emit("remove", icao);
      }
    }
    return removed;
  }

  size(): number {
    return this.aircraft.size;
  }

  snapshot(): AircraftJson[] {
    const out: AircraftJson[] = [];
    for (const ac of this.aircraft.values()) {
      out.push({
        icao: ac.icao,
        callsign: ac.callsign,
        category: ac.category,
        lat: ac.lat,
        lon: ac.lon,
        altitudeFt: ac.altitudeFt,
        altitudeGeomFt: ac.altitudeGeomFt,
        groundSpeedKt: ac.groundSpeedKt,
        trackDeg: ac.trackDeg,
        verticalRateFpm: ac.verticalRateFpm,
        squawk: ac.squawk,
        onGround: ac.onGround,
        nic: ac.nic,
        rc: ac.rc,
        posSource: ac.posSource,
        rssi: ac.rssi,
        navAltitudeMcpFt: ac.navAltitudeMcpFt,
        navAltitudeFmsFt: ac.navAltitudeFmsFt,
        navQnh: ac.navQnh,
        navHeadingDeg: ac.navHeadingDeg,
        iasKt: ac.iasKt,
        mach: ac.mach,
        registration: ac.registration,
        icaoAircraftType: ac.icaoAircraftType,
        aircraftType: ac.aircraftType,
        manufacturer: ac.manufacturer,
        owner: ac.owner,
        ownerCountry: ac.ownerCountry,
        firstSeen: ac.firstSeen,
        lastSeen: ac.lastSeen,
        messages: ac.messages,
        sources: Array.from(ac.sources),
      });
    }
    return out;
  }
}
