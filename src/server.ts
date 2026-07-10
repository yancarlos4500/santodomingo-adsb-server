import { loadConfig } from "./config";
import { AircraftStore } from "./aircraftStore";
import { ModeSDecoder } from "./decoder";
import { BeastFeeder, RawFeeder, SbsFeeder } from "./feeders";
import { broadcastSnapshot, createWebServer } from "./webServer";

async function main() {
  const cfg = loadConfig();
  const store = new AircraftStore(cfg.aircraftTtlMs);
  const decoder = new ModeSDecoder();

  const beast = new BeastFeeder(store, decoder);
  const raw = new RawFeeder(store, decoder);
  const sbs = new SbsFeeder(store, decoder);

  const { server, wss } = createWebServer(store, { beast, raw, sbs }, cfg);

  await Promise.all([
    beast.listen(cfg.beastPort, cfg.host),
    raw.listen(cfg.rawPort, cfg.host),
    sbs.listen(cfg.sbsPort, cfg.host),
    new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(cfg.httpPort, cfg.host, () => {
        server.off("error", onError);
        console.log(`[web]   listening on http://${cfg.host}:${cfg.httpPort}`);
        resolve();
      });
    }),
  ]);

  const tick = setInterval(() => {
    const removed = store.prune();
    if (removed.length) {
      console.log(`[store] pruned ${removed.length} stale aircraft`);
    }
    broadcastSnapshot(wss, store);
  }, cfg.tickIntervalMs);

  const shutdown = async (signal: string) => {
    console.log(`\n[main] received ${signal}, shutting down…`);
    clearInterval(tick);
    wss.close();
    server.close();
    await Promise.allSettled([beast.stop(), raw.stop(), sbs.stop()]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  console.log("[main] ADS-B server ready. Point your feeders at:");
  console.log(`         Beast : tcp://${cfg.host}:${cfg.beastPort}`);
  console.log(`         Raw   : tcp://${cfg.host}:${cfg.rawPort}`);
  console.log(`         SBS-1 : tcp://${cfg.host}:${cfg.sbsPort}`);
}

main().catch((err) => {
  console.error("[main] fatal:", err);
  process.exit(1);
});
