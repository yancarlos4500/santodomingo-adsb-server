# ADS-B Server

A self-hosted ADS-B aggregation server. Feeders (dump1090, readsb, PiAware, tar1090, etc.) connect over TCP and push aircraft messages; the server decodes them, keeps a live aircraft state store, and exposes a real-time web map plus a JSON API.

## Features

- Accepts three common feeder formats:
  - **Beast binary** on `tcp://0.0.0.0:30005`
  - **Raw AVR** hex on `tcp://0.0.0.0:30002`
  - **SBS-1 BaseStation** CSV on `tcp://0.0.0.0:30003`
- Built-in Mode-S / ADS-B decoder for callsign, position (global CPR), altitude, ground speed, track, and vertical rate.
- Aggregates data from many concurrent feeders and de-duplicates per ICAO24.
- Web UI at `http://localhost:8080` with a Leaflet map, aircraft sidebar, and live WebSocket updates.
- Bilingual (English / Spanish) **feeder onboarding page** at `/feed` with copy-pasteable snippets for readsb, adsb.im, and ad-hoc `nc` piping.
- JSON endpoints:
  - `GET /api/aircraft` — current tracked aircraft.
  - `GET /api/stats` — per-feeder connection and message counters.
  - `GET /api/feed-info` — the public endpoints shown on `/feed` (host:port strings from env).
  - `GET /api/v3/lat/:lat/lon/:lon/dist/:dist` — ADSBExchange/airplanes.live-style pull API: aircraft within `dist` nautical miles of a point.

## Install & run

Requires Node.js 18+.

```bash
npm install
npm run dev      # hot-reload dev server
# or
npm run build && npm start
```

## Feeding data

Any tool that speaks one of the standard dump1090 output formats can feed the server. Point the feeder's output socket at this server's matching port. Examples:

```bash
# Forward a local dump1090 Beast stream to this server
nc -l 30005 < /dev/tcp/dump1090-host/30005

# Feed pre-recorded raw AVR data
cat sample.avr | nc your-server 30002

# readsb / dump1090-fa net-connector
readsb --net-connector your-server,30005,beast_out
```

Each connected feeder is tracked in `/api/stats` by remote address.

## Feeding OUT to another aggregator (pull-based)

Some aggregators (e.g. a partner ATC/tracking site) don't push data to you — instead they connect to your server and pull a live Beast stream, the same way dump1090's `net-ro-port` works. This server exposes that on its own port:

- **Beast output**: `tcp://0.0.0.0:30006` (override with `ADSB_BEAST_OUT_PORT`)

Every frame decoded from your Beast and raw-AVR feeders is re-encoded as Beast and fanned out to whoever connects here — no configuration needed on this server beyond exposing the port. Give the consumer your host and this port (on Railway, add a TCP Proxy for it just like the inbound ports below) and they connect as a client:

```bash
# What the consumer runs — pulls Beast frames from this server
readsb --net-connector your-server.example.com,30006,beast_in
# or just inspect the raw stream
nc your-server.example.com 30006 | xxd | head
```

Connected consumers show up in `/api/stats` under `feeders.beastOut`, and the port is reported by `/api/feed-info` as `beastOut`.

### HTTP pull API (lat/lon/dist)

Some platforms don't speak Beast at all — they poll an ADSBExchange/airplanes.live-style HTTP endpoint instead, e.g. `http://your-host/api/v3/lat/{lat}/lon/{lon}/dist/{nm}`. This server exposes that shape directly over its normal HTTP port (no extra TCP Proxy needed, just the existing public URL):

```bash
curl "https://your-server.example.com/api/v3/lat/18.47/lon/-69.9/dist/250"
```

Returns `{ "ac": [...], "total": N, "ctime": <ms>, "ptime": <ms> }`, where each `ac` entry includes `hex`, `flight`, `lat`, `lon`, `alt_baro`, `gs`, `track`, `baro_rate`, `squawk`, `dst` (nm from the query point), and `dir` (bearing in degrees).

> Note: SBS-1-only feeders don't carry raw Mode-S frame bytes, so messages that arrive purely via the SBS port aren't re-broadcast on this output — only Beast- and raw-AVR-sourced traffic is.

## Feeding OUT to another aggregator (push-based)

Most aggregators (e.g. santodomingoatc) instead expose their own Beast *input* address and expect you to connect out to them, same as any other feeder. Set `ADSB_FEED_OUT_TARGETS` to a comma-separated list of `host:port` targets and this server will maintain a persistent outbound connection to each, pushing every frame decoded from your Beast and raw-AVR feeders (reconnecting with backoff if the link drops):

```bash
ADSB_FEED_OUT_TARGETS=hayabus.proxy.rlwy.net:11665
# multiple targets:
ADSB_FEED_OUT_TARGETS=host1:1234,host2:5678
```

Find the target's expected address from their own `/api/feed-info` endpoint (the `beast` field). Push status shows up in `/api/stats` under `pushTargets` (`connected`, `totalFrames`, `totalBytes` per target).

## Feeding from adsb.im (or any readsb / Ultrafeeder)

[adsb.im](https://adsb.im) ships Ultrafeeder (readsb) which can push Beast to arbitrary aggregators via its `net-connector` config.

In the adsb.im web UI, open **Setup → Ultrafeeder / Other Aggregators** and add a custom net-connector pointing at this server's Beast port. The line format is `host,port,protocol`:

```
your-server.example.com,30005,beast_reduce_out
```

Save and let Ultrafeeder restart. The feeder will appear in `/api/stats` as `<pi-ip>:port`.

> Tip: use `beast_reduce_out` (rate-limited) rather than `beast_out` for wide-area feeds — it's what most aggregators recommend and keeps bandwidth reasonable.

## Deploy to Railway

The repo is preconfigured for one-click deployment on [Railway](https://railway.com).

### Deploy

1. Push this repo to GitHub (or use the Railway CLI: `railway init && railway up`).
2. In Railway, **New Project → Deploy from GitHub repo** and pick this repo.
3. Railway detects Node.js, runs `npm ci && npm run build` (per [`railway.json`](railway.json)) and starts the server with `npm start`.
4. Railway auto-assigns a public HTTPS URL that maps to the container's `PORT` env var. The server binds its HTTP listener to `PORT` automatically. Open the URL to see the map.
5. Deploy health is polled at `/healthz`.

### Exposing feeder ports (TCP Proxy)

Railway's public URL only serves HTTP. To let external feeders connect to Beast/raw/SBS you need a **TCP Proxy** per feeder port (settings → **Networking → TCP Proxy**). For each port you want public, add one entry:

| Feeder      | Container port | TCP Proxy target |
| ----------- | -------------- | ---------------- |
| Beast       | `30005`        | 30005            |
| Raw AVR     | `30002`        | 30002            |
| SBS-1       | `30003`        | 30003            |
| Beast out   | `30006`        | 30006            |

Railway will give each proxy a public host + port such as `containers-us-west-XX.railway.app:12345`. Point your feeders at that host and port — the internal port stays 30005/30003/30002.

> TCP Proxy requires a paid Railway plan (Hobby or higher). If you only want to try the UI without receiving external feeders, deploying with just HTTP is fine.

### Environment variables on Railway

Railway sets `PORT` automatically; the server uses it for HTTP. You typically don't need to set anything else, but every value in the [Configuration](#configuration) table below can be overridden under **Variables** if you want to change the internal feeder ports, aircraft TTL, etc.

## Configuration

Environment variables (all optional):

| Variable                  | Default   | Description                                    |
| ------------------------- | --------- | ---------------------------------------------- |
| `PORT`                    | *(unset)* | Preferred HTTP port; set automatically by Railway/Heroku/etc. |
| `ADSB_HOST`               | `0.0.0.0` | Bind address for all listeners.                |
| `ADSB_BEAST_PORT`         | `30005`   | Beast binary feed port.                        |
| `ADSB_RAW_PORT`           | `30002`   | Raw AVR feed port.                             |
| `ADSB_SBS_PORT`           | `30003`   | SBS-1 BaseStation feed port.                   |
| `ADSB_BEAST_OUT_PORT`     | `30006`   | Beast output port for pull-based consumers.    |
| `ADSB_HTTP_PORT`          | `8080`    | Web UI + JSON + WebSocket port (fallback when `PORT` is unset). |
| `ADSB_AIRCRAFT_TTL_MS`    | `60000`   | Drop aircraft that haven't been seen in this window. |
| `ADSB_TICK_MS`            | `1000`    | Prune + broadcast interval.                    |
| `ADSB_PUBLIC_BEAST`       | *(unset)* | Public `host:port` shown on `/feed` for Beast (e.g. Railway TCP proxy address). |
| `ADSB_PUBLIC_RAW`         | *(unset)* | Public `host:port` shown on `/feed` for raw AVR. |
| `ADSB_PUBLIC_SBS`         | *(unset)* | Public `host:port` shown on `/feed` for SBS-1. |
| `ADSB_PUBLIC_BEAST_OUT`   | *(unset)* | Public `host:port` for the Beast output feed (given to pull-based consumers). |
| `ADSB_FEED_OUT_TARGETS`   | *(unset)* | Comma-separated `host:port` list of upstream aggregators to push our Beast stream to. |
| `ADSB_SITE_NAME`          | *(unset)* | Friendly site name shown on `/feed` (e.g. `Santo Domingo ADS-B`). |

## Notes

- The decoder handles DF17/18 extended squitters (bulk of ADS-B). Mode-S DF4/5/20/21 messages that XOR the ICAO into the CRC are ignored — decoding them requires a rolling table of known aircraft.
- Global CPR needs an even + odd frame pair from the same aircraft within ~10 s, so newly seen aircraft may take a few messages before a position appears on the map.
- This is a starter project, not a hardened public service. Put it behind a reverse proxy and add auth/rate limiting before exposing it to the internet.
# santodomingo-adsb-server
