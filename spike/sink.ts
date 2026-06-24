// Throwaway capture sink for the Pager spike. Receives notification captures
// from the Tampermonkey userscript and logs them, so we can confirm Teams/OWA
// actually emit through the page-context Notification API on this machine.
// The real bridge (Rust, svastha-core) replaces this later.

const PORT = Number(process.env.PAGER_SINK_PORT ?? 4500);
const recent: unknown[] = [];

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    if (req.method === "POST" && url.pathname === "/capture") {
      try {
        const body = (await req.json()) as Record<string, unknown>;
        const row = { ...body, received_at: new Date().toISOString() };
        recent.unshift(row);
        if (recent.length > 200) recent.pop();
        const tag = row.source === "__diag" ? "diag" : String(row.source ?? "?");
        const line = `[${row.received_at}] ${row.host ?? "?"} ${tag}: ${row.title ?? ""}`;
        console.log(row.body ? `${line} — ${row.body}` : line);
        return new Response("ok", { headers: cors });
      } catch {
        return new Response("bad json", { status: 400, headers: cors });
      }
    }

    if (url.pathname === "/") {
      return new Response(JSON.stringify(recent, null, 2), {
        headers: { "content-type": "application/json", ...cors },
      });
    }

    return new Response("not found", { status: 404, headers: cors });
  },
});

console.log(`pager sink listening on http://127.0.0.1:${server.port}`);
console.log(`  POST /capture   receive a capture`);
console.log(`  GET  /          dump recent captures as JSON`);
