import { fileURLToPath } from "node:url";
import { serve } from "srvx";
import { staticMiddleware } from "srvx/static";
import app from "../dist/server/server.mjs";

const backend = new URL(process.env.SERVER_URL || "http://127.0.0.1:3001");
const client = fileURLToPath(new URL("../dist/client", import.meta.url));

function endToEndHeaders(source) {
  const headers = new Headers(source);
  for (const name of (headers.get("connection") ?? "").split(",")) {
    if (name.trim()) headers.delete(name.trim());
  }
  for (const name of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    headers.delete(name);
  }
  return headers;
}

async function proxy(request, url) {
  const target = new URL(backend);
  target.pathname = url.pathname;
  target.search = url.search;

  const headers = endToEndHeaders(request.headers);
  headers.delete("host");
  headers.set("accept-encoding", "identity");

  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.body,
      duplex: "half",
      redirect: "manual",
      signal: request.signal,
    });
  } catch {
    return new Response("Bad Gateway", { status: 502 });
  }

  const responseHeaders = endToEndHeaders(upstream.headers);
  if (upstream.body && responseHeaders.has("content-encoding")) {
    // Node fetch decodes compressed responses.
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

serve({
  hostname: process.env.HOSTNAME ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 3000),
  middleware: [staticMiddleware({ dir: client })],
  fetch(request) {
    const url = new URL(request.url);
    if (/^\/(api|uploads)(\/|$)/.test(url.pathname)) return proxy(request, url);
    return app.fetch(request);
  },
});
