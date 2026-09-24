/**
 * Minimal Mode-S / ADS-B decoder covering the message types most feeders
 * emit in bulk:
 *   - DF17 / DF18 Extended Squitter (ADS-B / TIS-B)
 *       TC  1-4  : Aircraft identification (callsign)
 *       TC  5-8  : Surface position (global CPR)
 *       TC  9-18 : Airborne position (barometric altitude, global CPR)
 *       TC 19    : Airborne velocity (ground speed subtypes 1/2)
 *       TC 20-22 : Airborne position (GNSS altitude, global CPR)
 *
 * Global CPR decoding requires an even+odd frame pair from the same
 * aircraft within ~10 s. Frames received in isolation contribute
 * altitude / heading / callsign but not lat/lon until a pair is seen.
 *
 * This decoder trusts the caller to have validated the CRC (Beast / raw
 * feeders normally forward only CRC-valid frames).
 */

const NL_TABLE: Array<{ nl: number; lat: number }> = buildNlTable();

export interface DecodedMessage {
  icao: string;
  df: number;
  tc?: number;
  callsign?: string;
  /** Wake-turbulence/emitter category, e.g. "A3" (formatted like readsb/dump1090). */
  category?: string;
  lat?: number;
  lon?: number;
  /** Barometric altitude (TC 9-18). */
  altitudeFt?: number;
  /** GNSS/geometric height above ellipsoid (TC 20-22), when reported instead of barometric. */
  altitudeGeomFt?: number;
  groundSpeedKt?: number;
  trackDeg?: number;
  verticalRateFpm?: number;
  onGround?: boolean;
  /** Navigation Integrity Category, derived from the position type code. */
  nic?: number;
  /** Containment radius in meters implied by `nic`. */
  rc?: number;
  /** Best-effort position source: DF17 is always ICAO-addressed ADS-B; DF18 is typically TIS-B. */
  posSource?: "adsb_icao" | "tisb";
  /** MCP/FCU selected altitude, from the Target State and Status message (TC 29). */
  navAltitudeMcpFt?: number;
  /** FMS selected altitude, from the Target State and Status message (TC 29). */
  navAltitudeFmsFt?: number;
  /** Selected barometric pressure setting (QNH), in hPa/mbar. */
  navQnh?: number;
  /** Selected heading, in degrees. */
  navHeadingDeg?: number;
}

interface CprFrame {
  lat: number; // 17-bit encoded latitude
  lon: number; // 17-bit encoded longitude
  time: number;
  surface: boolean;
}

interface AircraftDecodeState {
  even?: CprFrame;
  odd?: CprFrame;
}

/**
 * Stateful decoder — keeps per-aircraft CPR frame history so that
 * even/odd pairs can be combined into a global position fix.
 */
export class ModeSDecoder {
  private readonly state = new Map<string, AircraftDecodeState>();

  /** Maximum age (ms) for pairing even and odd CPR frames. */
  private readonly cprPairMaxAgeMs = 10_000;

  decode(frame: Buffer): DecodedMessage | null {
    if (frame.length !== 7 && frame.length !== 14) return null;
    const df = (frame[0] >> 3) & 0x1f;

    // Only DF17/18 carry ICAO24 in the clear (bytes 1..3). For DF11
    // the ICAO is also in the clear. For DF0/4/5/16/20/21 the ICAO is
    // XOR-encoded into the CRC (Address/Parity) and requires a lookup
    // table of known aircraft — we skip those here.
    if (df !== 17 && df !== 18 && df !== 11) return null;

    const icao = frame.subarray(1, 4).toString("hex");

    if (df === 11) {
      // All-call reply — announces presence only.
      return { icao, df };
    }

    // DF17 / DF18 extended squitter, ME field is bytes 4..10.
    const me = frame.subarray(4, 11);
    const tc = (me[0] >> 3) & 0x1f;
    const msg: DecodedMessage = { icao, df, tc, posSource: df === 18 ? "tisb" : "adsb_icao" };

    if (tc >= 1 && tc <= 4) {
      msg.callsign = decodeCallsign(me);
      msg.category = categoryFromTypeCode(tc, me[0] & 0x07);
    } else if (tc >= 5 && tc <= 8) {
      // Surface position — encoded speed/track live in the ME field too.
      const surface = decodeSurfaceVelocity(me);
      if (surface) {
        msg.groundSpeedKt = surface.speed;
        msg.trackDeg = surface.track;
      }
      msg.onGround = true;
      const pos = this.tryPosition(icao, me, true);
      if (pos) {
        msg.lat = pos.lat;
        msg.lon = pos.lon;
      }
    } else if ((tc >= 9 && tc <= 18) || (tc >= 20 && tc <= 22)) {
      const alt = decodeAirbornePositionAltitude(me, tc);
      if (tc >= 20) msg.altitudeGeomFt = alt;
      else msg.altitudeFt = alt;
      msg.onGround = false;
      const nic = TC_TO_NIC[tc];
      if (nic !== undefined) {
        msg.nic = nic;
        msg.rc = NIC_TO_RC[nic];
      }
      const pos = this.tryPosition(icao, me, false);
      if (pos) {
        msg.lat = pos.lat;
        msg.lon = pos.lon;
      }
    } else if (tc === 19) {
      const v = decodeAirborneVelocity(me);
      if (v) {
        if (v.speed !== undefined) msg.groundSpeedKt = v.speed;
        if (v.track !== undefined) msg.trackDeg = v.track;
        if (v.vrate !== undefined) msg.verticalRateFpm = v.vrate;
      }
      msg.onGround = false;
    } else if (tc === 29) {
      const ts = decodeTargetStateAndStatus(me);
      if (ts.altitudeFt !== undefined) {
        if (ts.altitudeSource === "FMS") msg.navAltitudeFmsFt = ts.altitudeFt;
        else msg.navAltitudeMcpFt = ts.altitudeFt;
      }
      if (ts.qnh !== undefined) msg.navQnh = ts.qnh;
      if (ts.headingDeg !== undefined) msg.navHeadingDeg = ts.headingDeg;
    }

    return msg;
  }

  private tryPosition(
    icao: string,
    me: Buffer,
    surface: boolean,
  ): { lat: number; lon: number } | null {
    const oddFlag = (me[2] >> 2) & 0x01;
    const latCpr = ((me[2] & 0x03) << 15) | (me[3] << 7) | (me[4] >> 1);
    const lonCpr = ((me[4] & 0x01) << 16) | (me[5] << 8) | me[6];
    const now = Date.now();

    let st = this.state.get(icao);
    if (!st) {
      st = {};
      this.state.set(icao, st);
    }
    const frame: CprFrame = { lat: latCpr, lon: lonCpr, time: now, surface };
    if (oddFlag) st.odd = frame;
    else st.even = frame;

    if (!st.even || !st.odd) return null;
    if (Math.abs(st.even.time - st.odd.time) > this.cprPairMaxAgeMs) return null;
    if (st.even.surface !== st.odd.surface) return null;

    return decodeCprGlobal(st.even, st.odd, oddFlag === 1, surface);
  }
}

// --- ME-field helpers ---------------------------------------------------

/** Position type code -> Navigation Integrity Category (base table, ignoring the NIC supplement bit). */
const TC_TO_NIC: Record<number, number> = {
  9: 11, 10: 10, 11: 8, 12: 7, 13: 6, 14: 5, 15: 4, 16: 2, 17: 1, 18: 0,
  20: 11, 21: 10, 22: 0,
};

/** NIC -> containment radius in meters (DO-260B Table 2-8). */
const NIC_TO_RC: Record<number, number> = {
  11: 7.5, 10: 25, 9: 75, 8: 185.2, 7: 370.4, 6: 926, 5: 1852, 4: 3704,
  3: 7408, 2: 14816, 1: 37040,
};

/**
 * Emitter category, formatted like readsb/dump1090: high nibble encodes the
 * message subtype set (TC 1-4 -> D/C/B/A), low nibble is the CA subfield.
 */
function categoryFromTypeCode(tc: number, ca: number): string {
  const high = (0x0e - tc) & 0x0f;
  const byte = (high << 4) | (ca & 0x07);
  return byte.toString(16).toUpperCase().padStart(2, "0");
}

const CALLSIGN_CHARS =
  "#ABCDEFGHIJKLMNOPQRSTUVWXYZ##### ###############0123456789######";

function decodeCallsign(me: Buffer): string {
  // 8 characters packed 6 bits each starting at bit 8 of the ME field.
  const chars: string[] = [];
  const bits = bytesToBits(me);
  for (let i = 0; i < 8; i++) {
    let idx = 0;
    for (let b = 0; b < 6; b++) idx = (idx << 1) | bits[8 + i * 6 + b];
    chars.push(CALLSIGN_CHARS[idx] ?? "#");
  }
  return chars.join("").replace(/[#_ ]+$/g, "").trim();
}

function decodeAirbornePositionAltitude(me: Buffer, tc: number): number | undefined {
  // Altitude occupies ME bits 9-20 (12 bits): all of me[1] plus the top
  // nibble of me[2].
  const ac12 = ((me[1] << 4) | (me[2] >> 4)) & 0x0fff;

  if (tc >= 20 && tc <= 22) {
    // GNSS height above ellipsoid, metres.
    return Math.round(ac12 * 3.28084);
  }

  const q = (ac12 >> 4) & 0x01;
  if (q === 1) {
    const n = ((ac12 & 0x0fe0) >> 1) | (ac12 & 0x000f);
    return n * 25 - 1000;
  }
  // Gillham-coded altitude — rarely seen in ADS-B; leave unresolved.
  return undefined;
}

interface AirborneVelocity {
  speed?: number;
  track?: number;
  vrate?: number;
}

function decodeAirborneVelocity(me: Buffer): AirborneVelocity | null {
  const subtype = me[0] & 0x07;
  if (subtype !== 1 && subtype !== 2) return null; // ground-referenced only

  const ewDir = (me[1] & 0x04) >> 2;
  const ewVel = ((me[1] & 0x03) << 8) | me[2];
  const nsDir = (me[3] & 0x80) >> 7;
  const nsVel = ((me[3] & 0x7f) << 3) | ((me[4] & 0xe0) >> 5);

  const ew = (ewDir === 0 ? 1 : -1) * (ewVel - 1);
  const ns = (nsDir === 0 ? 1 : -1) * (nsVel - 1);
  const scale = subtype === 2 ? 4 : 1;
  const ewS = ew * scale;
  const nsS = ns * scale;

  const speed = Math.sqrt(ewS * ewS + nsS * nsS);
  let track = (Math.atan2(ewS, nsS) * 180) / Math.PI;
  if (track < 0) track += 360;

  const vrSign = (me[4] & 0x08) >> 3;
  const vrRaw = ((me[4] & 0x07) << 6) | ((me[5] & 0xfc) >> 2);
  const vrate = vrRaw === 0 ? undefined : (vrSign === 0 ? 1 : -1) * (vrRaw - 1) * 64;

  return { speed: Math.round(speed), track: Math.round(track * 10) / 10, vrate };
}

interface TargetStateAndStatus {
  altitudeFt?: number;
  altitudeSource?: "MCP/FCU" | "FMS";
  qnh?: number;
  headingDeg?: number;
}

/**
 * BDS 6,2 Target State and Status (TC=29): pilot-selected altitude/heading
 * and barometric setting. Bit offsets per DO-260B \u00a72.2.3.2.7.1 (verified
 * against pyModeS bds62), counted 0-55 from the MSB of the 56-bit ME field.
 */
function decodeTargetStateAndStatus(me: Buffer): TargetStateAndStatus {
  let payload = 0n;
  for (const b of me) payload = (payload << 8n) | BigInt(b);
  const bits = (from: number, width: number): number =>
    Number((payload >> BigInt(55 - (from + width - 1))) & ((1n << BigInt(width)) - 1n));

  const out: TargetStateAndStatus = {};

  const altRaw = bits(9, 11);
  if (altRaw !== 0) {
    out.altitudeFt = (altRaw - 1) * 32;
    out.altitudeSource = bits(8, 1) === 1 ? "FMS" : "MCP/FCU";
  }

  const baroRaw = bits(20, 9);
  if (baroRaw !== 0) out.qnh = Math.round((800 + (baroRaw - 1) * 0.8) * 10) / 10;

  if (bits(29, 1) !== 0) {
    out.headingDeg = Math.round(((bits(30, 9) * 360) / 512) * 10) / 10;
  }

  return out;
}

function decodeSurfaceVelocity(me: Buffer): { speed: number; track: number } | null {
  const mov = ((me[0] & 0x07) << 4) | ((me[1] & 0xf0) >> 4);
  const speed = surfaceMovementToKt(mov);
  const trackValid = (me[1] & 0x08) !== 0;
  const trackRaw = ((me[1] & 0x07) << 4) | ((me[2] & 0xf0) >> 4);
  const track = trackValid ? (trackRaw * 360) / 128 : undefined;
  if (speed === undefined && track === undefined) return null;
  return { speed: speed ?? 0, track: track ?? 0 };
}

function surfaceMovementToKt(m: number): number | undefined {
  if (m === 0 || m === 127) return undefined;
  if (m === 1) return 0;
  if (m <= 8) return 0.125 + (m - 1) * 0.125;
  if (m <= 12) return 1 + (m - 8) * 0.25;
  if (m <= 38) return 2 + (m - 12) * 0.5;
  if (m <= 93) return 15 + (m - 38) * 1;
  if (m <= 108) return 70 + (m - 93) * 2;
  if (m <= 123) return 100 + (m - 108) * 5;
  return 175;
}

// --- CPR decoding -------------------------------------------------------

function decodeCprGlobal(
  even: CprFrame,
  odd: CprFrame,
  latestIsOdd: boolean,
  surface: boolean,
): { lat: number; lon: number } | null {
  const zoneScale = surface ? 90 : 360;
  const dLatEven = zoneScale / 60;
  const dLatOdd = zoneScale / 59;

  const evLatFrac = even.lat / 131072; // 2^17
  const odLatFrac = odd.lat / 131072;

  const j = Math.floor(59 * evLatFrac - 60 * odLatFrac + 0.5);
  let latEven = dLatEven * (mod(j, 60) + evLatFrac);
  let latOdd = dLatOdd * (mod(j, 59) + odLatFrac);
  if (!surface) {
    if (latEven >= 270) latEven -= 360;
    if (latOdd >= 270) latOdd -= 360;
  }

  const nlEven = cprNL(latEven);
  const nlOdd = cprNL(latOdd);
  if (nlEven !== nlOdd) return null; // straddled a transition, wait for a fresh pair

  const lat = latestIsOdd ? latOdd : latEven;
  const nl = latestIsOdd ? nlOdd : nlEven;
  const ni = Math.max(nl - (latestIsOdd ? 1 : 0), 1);
  const dLon = zoneScale / ni;

  const evLonFrac = even.lon / 131072;
  const odLonFrac = odd.lon / 131072;

  const m = Math.floor(
    evLonFrac * (nlEven - 1) - odLonFrac * nlEven + 0.5,
  );
  const lonFrac = latestIsOdd ? odLonFrac : evLonFrac;
  let lon = dLon * (mod(m, ni) + lonFrac);
  if (!surface && lon >= 180) lon -= 360;
  if (surface) {
    // Surface encoding covers 90-degree quadrants; pick nearest to receiver
    // is impossible without a reference — leave in [0, 90) for now.
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

function cprNL(lat: number): number {
  const abs = Math.abs(lat);
  if (abs >= 87) return 1;
  for (const row of NL_TABLE) {
    if (abs < row.lat) return row.nl;
  }
  return 1;
}

function buildNlTable(): Array<{ nl: number; lat: number }> {
  // Transition latitudes from RTCA DO-260B Table 2-1.
  const table = [
    { nl: 59, lat: 10.47047130 },
    { nl: 58, lat: 14.82817437 },
    { nl: 57, lat: 18.18626357 },
    { nl: 56, lat: 21.02939493 },
    { nl: 55, lat: 23.54504487 },
    { nl: 54, lat: 25.82924707 },
    { nl: 53, lat: 27.93898710 },
    { nl: 52, lat: 29.91135686 },
    { nl: 51, lat: 31.77209708 },
    { nl: 50, lat: 33.53993436 },
    { nl: 49, lat: 35.22899598 },
    { nl: 48, lat: 36.85025108 },
    { nl: 47, lat: 38.41241892 },
    { nl: 46, lat: 39.92256684 },
    { nl: 45, lat: 41.38651832 },
    { nl: 44, lat: 42.80914012 },
    { nl: 43, lat: 44.19454951 },
    { nl: 42, lat: 45.54626723 },
    { nl: 41, lat: 46.86733252 },
    { nl: 40, lat: 48.16039128 },
    { nl: 39, lat: 49.42776439 },
    { nl: 38, lat: 50.67150166 },
    { nl: 37, lat: 51.89342469 },
    { nl: 36, lat: 53.09516153 },
    { nl: 35, lat: 54.27817472 },
    { nl: 34, lat: 55.44378444 },
    { nl: 33, lat: 56.59318756 },
    { nl: 32, lat: 57.72747354 },
    { nl: 31, lat: 58.84763776 },
    { nl: 30, lat: 59.95459277 },
    { nl: 29, lat: 61.04917774 },
    { nl: 28, lat: 62.13216659 },
    { nl: 27, lat: 63.20427479 },
    { nl: 26, lat: 64.26616523 },
    { nl: 25, lat: 65.31845310 },
    { nl: 24, lat: 66.36171008 },
    { nl: 23, lat: 67.39646774 },
    { nl: 22, lat: 68.42322022 },
    { nl: 21, lat: 69.44242631 },
    { nl: 20, lat: 70.45451075 },
    { nl: 19, lat: 71.45986473 },
    { nl: 18, lat: 72.45884545 },
    { nl: 17, lat: 73.45177442 },
    { nl: 16, lat: 74.43893416 },
    { nl: 15, lat: 75.42056257 },
    { nl: 14, lat: 76.39684391 },
    { nl: 13, lat: 77.36789461 },
    { nl: 12, lat: 78.33374083 },
    { nl: 11, lat: 79.29428225 },
    { nl: 10, lat: 80.24923213 },
    { nl: 9, lat: 81.19801349 },
    { nl: 8, lat: 82.13956981 },
    { nl: 7, lat: 83.07199445 },
    { nl: 6, lat: 83.99173563 },
    { nl: 5, lat: 84.89166191 },
    { nl: 4, lat: 85.75541621 },
    { nl: 3, lat: 86.53536998 },
    { nl: 2, lat: 87.00000000 },
  ];
  return table;
}

function bytesToBits(buf: Buffer): number[] {
  const bits = new Array<number>(buf.length * 8);
  for (let i = 0; i < buf.length; i++) {
    for (let b = 0; b < 8; b++) bits[i * 8 + b] = (buf[i] >> (7 - b)) & 1;
  }
  return bits;
}
