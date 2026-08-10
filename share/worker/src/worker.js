// Three routes. Everything else falls through to the static assets binding,
// which serves the viewer page at /.
//
//   PUT /u      upload ciphertext, return {id}
//   GET /b/<id> stream the ciphertext back
//   GET /       viewer page (via ASSETS)
//
// The 10ms CPU limit is the design constraint: never buffer or transform the body.
// Objects are deleted by a bucket-wide R2 lifecycle rule, not by this Worker — there is
// no delete route and no revocation. See docs/specs/2026-08-10-replay-sharing-design.md.

import { checkUploadSize } from "./upload-size.js";

// 128 bits. share/hosts.js OBJECT_ID_CHARS (22) is the base64url length of this and must
// agree — change one without the other and every new link fails to parse.
const OBJECT_ID_BYTES = 16;

// Objects are immutable and content-addressed, so this is only bounded by how stale a
// deleted object may appear. Must stay well under the bucket's 7-day lifecycle TTL.
const BLOB_CACHE_SECONDS = 3600;

// Kept byte-identical with share/worker/public/_headers, which covers the static assets.
// Both are needed: the asset layer serves the viewer page without ever invoking this
// Worker, so a header set here never reaches it. Change one, change the other.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // rrweb injects styles at runtime
  "img-src 'self' data: https://assets.riftatlas-workers.com",
  "connect-src 'self'",
  "frame-src 'self' blob:" // rrweb builds its own sandboxed replay iframe
].join("; ");

const SECURITY_HEADERS = {
  "content-security-policy": CSP,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
};

// The viewer is same-origin with this Worker and needs no CORS. The extension is not:
// an extension page's fetch obeys CORS, and a PUT carrying x-share-token triggers a
// preflight. Without this the upload fails in a browser while working fine from curl and
// from Node — which is exactly why the spike did not catch it.
//
// Only chrome-extension:// origins are echoed back. Ordinary web pages get no header and
// their browsers block the response, so a random site cannot drive uploads through a
// visitor's browser. Granting this here rather than via extension host_permissions keeps
// a wildcard permission out of a distributed extension, and lets a self-hoster point the
// extension at their own instance from Settings with no manifest edit and no prompt.
function corsOriginFor(request) {
  const origin = request.headers.get("origin") || "";
  return origin.startsWith("chrome-extension://") ? origin : null;
}

function corsHeaders(request) {
  const origin = corsOriginFor(request);
  if (!origin) return { vary: "Origin" };
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "PUT, GET, OPTIONS",
    "access-control-allow-headers": "content-type, x-share-token",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
}

function withHeaders(res, request) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  if (request) for (const [k, v] of Object.entries(corsHeaders(request))) out.headers.set(k, v);
  return out;
}

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...SECURITY_HEADERS,
      ...(request ? corsHeaders(request) : {})
    }
  });
}

function newObjectId() {
  const raw = crypto.getRandomValues(new Uint8Array(OBJECT_ID_BYTES));
  let binary = "";
  for (const b of raw) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function upload(request, env) {
  if (env.UPLOADS_ENABLED !== "true") {
    return json({ error: "uploads are temporarily disabled" }, 503, request);
  }

  // Per-IP limit, applied before the token check so token guessing is throttled too.
  //
  // This uses the Workers rate-limiting binding rather than a WAF rate-limiting rule,
  // because WAF rules are zone-scoped and this Worker is served from workers.dev, which
  // has no zone. The binding is absent under `wrangler dev`, hence the guard.
  if (env.RATE_LIMITER) {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    if (!success) return json({ error: "too many uploads, try again shortly" }, 429, request);
  }

  // A speed bump, not a secret: this token ships inside a distributed extension and is
  // public by construction. Real abuse control is the size cap, the Cloudflare rate-limit
  // rule, the short TTL, and the Workers Free daily ceiling. See docs/adr/0001.
  if (request.headers.get("x-share-token") !== env.UPLOAD_TOKEN) {
    return json({ error: "bad token" }, 403, request);
  }

  // Content-Length is required, not optional: R2 will not accept a stream of unknown
  // length, and FixedLengthStream below needs a number to enforce.
  const size = checkUploadSize(request.headers.get("content-length"), env.MAX_UPLOAD_BYTES);
  if (!size.ok) return json(size.body, size.status);
  if (!request.body) return json({ error: "empty body" }, 400, request);

  // FixedLengthStream gives R2 the known length it needs while keeping the body streamed,
  // and it fails the upload if the client's Content-Length was a lie in either direction.
  // That is the size guard: a client cannot declare 1 KB and then send 100 MB.
  //
  // Defence in depth: measured against the live deployment, Cloudflare's edge rejects a
  // body that disagrees with Content-Length with its own 400 before this Worker runs. This
  // branch covers the case where it does not. The rejection is captured rather than
  // discarded because it is the only object that knows the body did not match, and a
  // put() failure alone cannot distinguish that from R2 being unavailable.
  const sized = new FixedLengthStream(size.bytes);
  let bodyError = null;
  const piping = request.body.pipeTo(sized.writable).catch((err) => {
    bodyError = err;
  });

  const id = newObjectId();
  try {
    await env.BUCKET.put(id, sized.readable);
  } catch (err) {
    await piping;
    if (bodyError) {
      console.error("upload body did not match content-length", bodyError);
      return json({ error: "body did not match content-length", limit: size.limit }, 413, request);
    }
    // Never echo the underlying message: this endpoint is effectively unauthenticated,
    // and R2/runtime errors can carry binding names and object keys.
    console.error("r2 put failed", err);
    return json({ error: "upload failed" }, 500, request);
  }
  return json({ id }, 201, request);
}

async function download(id, env, request) {
  const object = await env.BUCKET.get(id);
  if (!object) return json({ error: "not found" }, 404, request);

  return new Response(object.body, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": `public, max-age=${BLOB_CACHE_SECONDS}, immutable`,
      ...SECURITY_HEADERS,
      ...corsHeaders(request)
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Preflight. Answered for extension origins only; anything else gets the 405 below
    // and its browser blocks the real request, which is the intent.
    if (request.method === "OPTIONS" && corsOriginFor(request)) {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (url.pathname === "/u") {
      if (request.method !== "PUT") return json({ error: "method not allowed" }, 405, request);
      return upload(request, env);
    }

    if (url.pathname.startsWith("/b/")) {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405, request);
      return download(url.pathname.slice(3), env, request);
    }

    return withHeaders(await env.ASSETS.fetch(request), request);
  }
};
