/** 单点诊断：测 TCP 探活耗时与结果，用于定位 ensureRunning 误判。 */
import { connect } from "node:net";

const port = Number(process.argv[2] || 43129);
const rounds = Number(process.argv[3] || 3);

function probe(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const finish = (v, why) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve({ ok: v, ms: Date.now() - t0, why });
    };
    const sock = connect({ host: "127.0.0.1", port });
    sock.on("connect", () => finish(true, "connect"));
    sock.on("error", (e) => finish(false, e.code || "error"));
    setTimeout(() => finish(false, "timeout"), timeoutMs);
  });
}

for (let i = 0; i < rounds; i++) {
  const r = await probe(port);
  process.stdout.write(`round ${i + 1}: ${r.ok ? "OPEN" : "CLOSED"} (${r.why}) ${r.ms}ms\n`);
}
