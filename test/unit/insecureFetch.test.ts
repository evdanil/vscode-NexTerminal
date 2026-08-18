import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { describe, expect, it } from "vitest";
import {
  INSECURE_FETCH_MAX_BODY_BYTES,
  createInsecureHttpsFetch,
  type HttpsRequestFn
} from "../../src/services/inventory/insecureFetch";

/**
 * The scoped insecure-TLS transport. It exists because the two obvious ways to
 * accept a self-signed / IP certificate are both wrong here:
 *   - `NODE_TLS_REJECT_UNAUTHORIZED=0` is PROCESS-global, and the VS Code
 *     extension host is shared with every other installed extension;
 *   - a per-request undici `dispatcher` is not a public Node API and undici is
 *     not a dependency of this extension.
 * So this is a `node:https` adapter covering exactly the slice of `fetch` that
 * `EveApiClient.raw()` uses, constructed with `rejectUnauthorized: false`, and
 * reached ONLY from a source that opted in over an `https:` URL.
 */

// ---------------------------------------------------------------------------
// A fake `https.request` — the adapter's single injection seam. Real TLS is
// exercised end-to-end in test/integration/insecureFetch.integration.test.ts;
// here the seam keeps every branch deterministic and instant.
// ---------------------------------------------------------------------------

interface FakeRequest extends EventEmitter {
  ended: boolean;
  destroyed: boolean;
  written: string | undefined;
  end(body?: string): void;
  destroy(err?: Error): void;
}

interface Recorder {
  requestImpl: HttpsRequestFn;
  calls: { options: RequestOptions; req: FakeRequest }[];
  /** Deliver a response to call `index`. */
  respond(index: number, res: { status?: number; statusMessage?: string; headers?: Record<string, string | string[]>; body?: string | Buffer | Buffer[] }): void;
  /** Deliver a caller-built body stream to call `index` — for the stalled / erroring body cases. */
  respondWith(index: number, stream: Readable, res?: { status?: number; headers?: Record<string, string | string[]> }): void;
}

function recorder(): Recorder {
  const calls: { options: RequestOptions; req: FakeRequest }[] = [];
  const callbacks: ((res: IncomingMessage) => void)[] = [];
  const requestImpl: HttpsRequestFn = (options, callback) => {
    const req = new EventEmitter() as FakeRequest;
    req.ended = false;
    req.destroyed = false;
    req.written = undefined;
    req.end = (body?: string): void => {
      req.ended = true;
      req.written = body;
    };
    req.destroy = (): void => {
      req.destroyed = true;
    };
    calls.push({ options, req });
    callbacks.push(callback);
    return req as unknown as ReturnType<HttpsRequestFn>;
  };
  return {
    requestImpl,
    calls,
    respond(index, res): void {
      const chunks = res.body === undefined ? [] : Array.isArray(res.body) ? res.body : [Buffer.from(res.body)];
      const stream = Readable.from(chunks) as unknown as IncomingMessage;
      (stream as { statusCode?: number }).statusCode = res.status ?? 200;
      (stream as { statusMessage?: string }).statusMessage = res.statusMessage ?? "OK";
      (stream as { headers?: Record<string, string | string[]> }).headers = res.headers ?? {};
      callbacks[index](stream);
    },
    respondWith(index, stream, res): void {
      const msg = stream as unknown as IncomingMessage;
      (msg as { statusCode?: number }).statusCode = res?.status ?? 200;
      (msg as { statusMessage?: string }).statusMessage = "OK";
      (msg as { headers?: Record<string, string | string[]> }).headers = res?.headers ?? {};
      callbacks[index](msg);
    }
  };
}

/**
 * Issue a request and hand back both the pending promise and the recorder.
 * `redirect: "manual"` is defaulted in because `EveApiClient.raw()` sets it on
 * EVERY request and the adapter refuses anything else outright — the refusal
 * itself is pinned separately below.
 */
function issue(url: string, init?: RequestInit): { rec: Recorder; promise: Promise<Response> } {
  const rec = recorder();
  const fetchImpl = createInsecureHttpsFetch(rec.requestImpl);
  return { rec, promise: fetchImpl(url, { redirect: "manual", ...init }) };
}

/** Lets the adapter's own microtasks run before the fake responds. */
async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

describe("createInsecureHttpsFetch — request construction", () => {
  it("turns verification OFF — the entire point of the transport (⊘ omitting rejectUnauthorized keeps Node's default of true and the self-signed lab box still fails)", async () => {
    const { rec, promise } = issue("https://eve.example.com/api/status");
    await tick();
    expect(rec.calls[0].options.rejectUnauthorized).toBe(false);
    rec.respond(0, { body: "{}" });
    await promise;
  });

  it("carries the URL's host, explicit port and full path+query onto the node:https options (⊘ dropping the search string sends a different request than the caller built)", async () => {
    const { rec, promise } = issue("https://eve.example.com:8443/api/labs/A%20B.unl/nodes?x=1");
    await tick();
    expect(rec.calls[0].options.hostname).toBe("eve.example.com");
    expect(rec.calls[0].options.port).toBe("8443");
    expect(rec.calls[0].options.path).toBe("/api/labs/A%20B.unl/nodes?x=1");
    rec.respond(0, { body: "{}" });
    await promise;
  });

  it("defaults the port to 443 when the URL names none", async () => {
    const { rec, promise } = issue("https://eve.example.com/api/status");
    await tick();
    expect(rec.calls[0].options.port).toBe("443");
    rec.respond(0, { body: "{}" });
    await promise;
  });

  it("strips the brackets from an IPv6 host, which is what node:https wants (⊘ passing [::1] verbatim makes the connection fail to resolve)", async () => {
    const { rec, promise } = issue("https://[2001:db8::5]:8443/api/status");
    await tick();
    expect(rec.calls[0].options.hostname).toBe("2001:db8::5");
    rec.respond(0, { body: "{}" });
    await promise;
  });

  it("sends the method, the caller's headers and a string body, with an explicit Content-Length (⊘ leaving Content-Length off makes node chunk the login POST, which EVE-NG's PHP backend need not accept)", async () => {
    const body = JSON.stringify({ username: "admin", password: "pw", html5: "-1" });
    const { rec, promise } = issue("https://eve.example.com/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
      redirect: "manual"
    });
    await tick();
    const { options, req } = rec.calls[0];
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({ "Content-Type": "application/json", Accept: "application/json" });
    expect(options.headers?.["Content-Length"]).toBe(String(Buffer.byteLength(body)));
    expect(req.written).toBe(body);
    rec.respond(0, { body: "{}" });
    await promise;
  });

  it("accepts headers as a Headers instance or as an array of pairs, not only a plain object", async () => {
    const a = issue("https://eve.example.com/api/status", { headers: new Headers({ Cookie: "unetlab_session=s1" }) });
    await tick();
    expect(String(a.rec.calls[0].options.headers?.["cookie"] ?? a.rec.calls[0].options.headers?.["Cookie"])).toBe("unetlab_session=s1");
    a.rec.respond(0, { body: "{}" });
    await a.promise;

    const b = issue("https://eve.example.com/api/status", { headers: [["Accept", "application/json"]] });
    await tick();
    expect(b.rec.calls[0].options.headers?.["Accept"]).toBe("application/json");
    b.rec.respond(0, { body: "{}" });
    await b.promise;
  });

  it("asks for an UNcompressed body, because node:https does not decompress one (⊘ letting the server gzip yields bytes the JSend parser reads as 'not EVE-NG JSON')", async () => {
    const { rec, promise } = issue("https://eve.example.com/api/status");
    await tick();
    expect(rec.calls[0].options.headers?.["Accept-Encoding"]).toBe("identity");
    rec.respond(0, { body: "{}" });
    await promise;
  });
});

// ---------------------------------------------------------------------------
// Response surface
// ---------------------------------------------------------------------------

describe("createInsecureHttpsFetch — response", () => {
  it("exposes the status and the decoded body text, reassembled across chunks", async () => {
    const { rec, promise } = issue("https://eve.example.com/api/status");
    await tick();
    rec.respond(0, { status: 201, body: [Buffer.from('{"sta'), Buffer.from('tus":"success"}')] });
    const res = await promise;
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('{"status":"success"}');
  });

  it("decodes a multi-byte UTF-8 body split across a chunk boundary (⊘ decoding each chunk on its own mangles a lab name into replacement characters)", async () => {
    const full = Buffer.from("Lab — ünïcode");
    const { rec, promise } = issue("https://eve.example.com/api/status");
    await tick();
    rec.respond(0, { body: [full.subarray(0, 6), full.subarray(6)] });
    expect(await (await promise).text()).toBe("Lab — ünïcode");
  });

  it("RETURNS EVERY Set-Cookie header from getSetCookie() — login reads the unetlab_session cookie through it, so a shim that only folds them into one string breaks the exact path this option exists to unblock", async () => {
    const { rec, promise } = issue("https://eve.example.com/api/auth/login", { method: "POST", body: "{}", redirect: "manual" });
    await tick();
    rec.respond(0, {
      headers: { "set-cookie": ["XSRF-TOKEN=abc; Path=/", "unetlab_session=s3ss10n; Path=/; HttpOnly"] },
      body: '{"status":"success"}'
    });
    const res = await promise;
    expect(res.headers.getSetCookie()).toEqual(["XSRF-TOKEN=abc; Path=/", "unetlab_session=s3ss10n; Path=/; HttpOnly"]);
  });

  it("still reports a SINGLE Set-Cookie header as a one-element array (node gives a lone value as a plain string)", async () => {
    const { rec, promise } = issue("https://eve.example.com/api/auth/login", { method: "POST", body: "{}", redirect: "manual" });
    await tick();
    rec.respond(0, { headers: { "set-cookie": "unetlab_session=only; Path=/" }, body: "{}" });
    expect((await promise).headers.getSetCookie()).toEqual(["unetlab_session=only; Path=/"]);
  });

  it("folds several values into one comma-joined string for get(), the way fetch's Headers does", async () => {
    const { rec, promise } = issue("https://eve.example.com/api/status");
    await tick();
    rec.respond(0, { headers: { "set-cookie": ["a=1", "b=2"] }, body: "{}" });
    const res = await promise;
    expect(res.headers.get("set-cookie")).toBe("a=1, b=2");
  });

  it("matches header names case-insensitively and answers null for one the server never sent", async () => {
    const { rec, promise } = issue("https://eve.example.com/api/status");
    await tick();
    rec.respond(0, { headers: { "content-type": "application/json" }, body: "{}" });
    const res = await promise;
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.has("CONTENT-TYPE")).toBe(true);
    expect(res.headers.get("x-absent")).toBeNull();
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("DOES NOT FOLLOW a redirect — a 3xx comes back as an ordinary response, exactly as redirect:'manual' promises (⊘ following it lets a 307 replay the login POST body, password included, at another origin)", async () => {
    const { rec, promise } = issue("https://eve.example.com/api/auth/login", { method: "POST", body: '{"password":"pw"}', redirect: "manual" });
    await tick();
    rec.respond(0, { status: 307, statusMessage: "Temporary Redirect", headers: { location: "https://evil.example.com/api/auth/login" }, body: "" });
    const res = await promise;
    expect(res.status).toBe(307);
    expect(rec.calls).toHaveLength(1);
    expect(res.headers.get("location")).toBe("https://evil.example.com/api/auth/login");
  });
});

// ---------------------------------------------------------------------------
// Abort — the error NAME is load-bearing
// ---------------------------------------------------------------------------

describe("createInsecureHttpsFetch — abort", () => {
  it("rejects with the SIGNAL'S OWN REASON, so a TimeoutError stays a TimeoutError (⊘ rejecting a generic Error makes raw() read a crawl-deadline abort as a network failure and discard the whole crawl)", async () => {
    const controller = new AbortController();
    const reason = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const { rec, promise } = issue("https://eve.example.com/api/status", { signal: controller.signal });
    await tick();
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);
    await expect(promise).rejects.toMatchObject({ name: "TimeoutError" });
    expect(rec.calls[0].req.destroyed).toBe(true);
  });

  it("preserves the AbortError name an AbortController's default reason carries", async () => {
    const controller = new AbortController();
    const { promise } = issue("https://eve.example.com/api/status", { signal: controller.signal });
    await tick();
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects an ALREADY-aborted signal without opening a connection at all", async () => {
    const rec = recorder();
    const reason = new DOMException("gone", "TimeoutError");
    await expect(createInsecureHttpsFetch(rec.requestImpl)("https://eve.example.com/api/status", { redirect: "manual", signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(rec.calls).toHaveLength(0);
  });

  it("aborts a response whose BODY stalls after the headers arrived, still with the signal's reason (⊘ resolving the half-read body hands the JSend parser a truncated envelope)", async () => {
    const controller = new AbortController();
    const reason = new DOMException("timed out", "TimeoutError");
    const rec = recorder();
    const promise = createInsecureHttpsFetch(rec.requestImpl)("https://eve.example.com/api/status", { redirect: "manual", signal: controller.signal });
    await tick();
    // Headers have arrived; the body emits one chunk and then never ends.
    const stalled = new Readable({ read(): void {} });
    rec.respondWith(0, stalled);
    stalled.push(Buffer.from('{"sta'));
    await tick();
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);
    expect(rec.calls[0].req.destroyed).toBe(true);
  });

  it("settles exactly ONCE — a socket error raised by the abort's own destroy() cannot overwrite the signal's reason", async () => {
    const controller = new AbortController();
    const reason = new DOMException("timed out", "TimeoutError");
    const { rec, promise } = issue("https://eve.example.com/api/status", { signal: controller.signal });
    await tick();
    controller.abort(reason);
    rec.calls[0].req.emit("error", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    await expect(promise).rejects.toBe(reason);
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

describe("createInsecureHttpsFetch — errors", () => {
  it("rejects with the node error UNWRAPPED, so its .code survives for mapNetworkError to read (⊘ wrapping it in a new Error loses the code and every failure reads as a bare message)", async () => {
    const { rec, promise } = issue("https://eve.example.com/api/status");
    await tick();
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    rec.calls[0].req.emit("error", err);
    await expect(promise).rejects.toBe(err);
    await expect(promise).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("propagates, with its code intact, an error raised while the body is still streaming (⊘ swallowing it resolves a half-read envelope that the parser then blames on the base URL)", async () => {
    const r = recorder();
    const promise = createInsecureHttpsFetch(r.requestImpl)("https://eve.example.com/api/status", { redirect: "manual" });
    await tick();
    const stream = new Readable({ read(): void {} });
    r.respondWith(0, stream);
    stream.push(Buffer.from('{"sta'));
    await tick();
    stream.destroy(Object.assign(new Error("aborted"), { code: "ECONNRESET" }));
    await expect(promise).rejects.toMatchObject({ code: "ECONNRESET" });
  });
});

// ---------------------------------------------------------------------------
// The surface it deliberately REFUSES — loud, never silently mis-handled
// ---------------------------------------------------------------------------

describe("createInsecureHttpsFetch — refuses what it does not implement", () => {
  it("refuses a non-https URL, so the transport can never be the reason an http:// or file:// request is made", async () => {
    const rec = recorder();
    const fetchImpl = createInsecureHttpsFetch(rec.requestImpl);
    await expect(fetchImpl("http://eve.example.com/api/status", { redirect: "manual" })).rejects.toThrow(/https/i);
    expect(rec.calls).toHaveLength(0);
  });

  it("refuses any redirect mode other than 'manual', because it never follows one and silently not following a 'follow' request would be a lie", async () => {
    const rec = recorder();
    const fetchImpl = createInsecureHttpsFetch(rec.requestImpl);
    await expect(fetchImpl("https://eve.example.com/x", { redirect: "follow" })).rejects.toThrow(/redirect/i);
    expect(rec.calls).toHaveLength(0);
  });

  it("refuses a non-string body rather than sending something the caller did not mean", async () => {
    const rec = recorder();
    const fetchImpl = createInsecureHttpsFetch(rec.requestImpl);
    await expect(fetchImpl("https://eve.example.com/x", { method: "POST", body: new URLSearchParams({ a: "1" }), redirect: "manual" })).rejects.toThrow(/body/i);
    expect(rec.calls).toHaveLength(0);
  });

  it("refuses a Request object as input — only a URL string or URL is understood", async () => {
    const rec = recorder();
    const fetchImpl = createInsecureHttpsFetch(rec.requestImpl);
    await expect(fetchImpl({ url: "https://eve.example.com/x" } as unknown as string, { redirect: "manual" })).rejects.toThrow(/URL/i);
    expect(rec.calls).toHaveLength(0);
  });

  it("refuses a COMPRESSED response instead of handing back bytes that look like corrupt JSON", async () => {
    const { rec, promise } = issue("https://eve.example.com/api/status");
    await tick();
    rec.respond(0, { headers: { "content-encoding": "gzip" }, body: " garbage" });
    await expect(promise).rejects.toThrow(/content-encoding/i);
  });

  it("stops reading a body past the size cap and destroys the connection — an unverified peer must not be able to grow the extension host's heap without bound", async () => {
    const rec = recorder();
    const promise = createInsecureHttpsFetch(rec.requestImpl)("https://eve.example.com/api/status", { redirect: "manual" });
    await tick();
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    const chunks: Buffer[] = [];
    for (let i = 0; i * chunk.length <= INSECURE_FETCH_MAX_BODY_BYTES; i += 1) {
      chunks.push(chunk);
    }
    rec.respond(0, { body: chunks });
    await expect(promise).rejects.toThrow(/too large|exceed/i);
  });

  it("refuses the Response members it does not implement, loudly, rather than answering with something wrong", async () => {
    const { rec, promise } = issue("https://eve.example.com/api/status");
    await tick();
    rec.respond(0, { body: '{"a":1}' });
    const res = await promise;
    expect(await res.json()).toEqual({ a: 1 });
    await expect(res.arrayBuffer()).rejects.toThrow(/not implemented/i);
    expect(() => res.clone()).toThrow(/not implemented/i);
  });
});
