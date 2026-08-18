import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { request as httpsRequest } from "node:https";

/**
 * A SCOPED insecure-TLS transport — the narrow slice of `fetch` an inventory
 * provider actually uses, spoken over `node:https` with certificate
 * verification turned off, and reachable ONLY from a source whose owner
 * explicitly opted in over an `https:` URL.
 *
 * WHY NOT THE TWO OBVIOUS ROUTES:
 *  - `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"` is PROCESS-GLOBAL, and
 *    the VS Code extension host is shared with every other installed
 *    extension. Setting it — even briefly around one request — silently
 *    disables certificate verification for code that never asked for it and
 *    has no way to notice. Not an option at any scope.
 *  - undici's per-request `dispatcher` would be exactly right, but undici is
 *    not an importable public Node API and is not a dependency of this
 *    extension; pulling it in for one checkbox is disproportionate.
 *
 * SUPPORTED SURFACE (everything `EveApiClient.raw()` sends, and nothing else):
 *   input   — a URL string or `URL`, scheme `https:` only.
 *   init    — `method`, `headers` (plain record / `Headers` / pair array), a
 *             STRING `body`, `redirect: "manual"`, and an `AbortSignal`.
 *   result  — `status`, `statusText`, `ok`, `url`, `text()`, `json()`, and
 *             headers with `get` / `has` / `getSetCookie` / `forEach`.
 *
 * Anything outside that throws by name rather than being quietly approximated:
 * a `Request` input, a non-`https:` URL, a redirect mode other than `manual`,
 * a non-string body, a compressed response body, an over-cap response, and the
 * `Response` members that are not implemented. A wrong guess in this adapter
 * would surface far away as "not EVE-NG JSON", so it refuses instead.
 */

/** The `node:https` entry point, narrowed to the one overload used and injectable for tests. */
export type HttpsRequestFn = (options: RequestOptions, callback: (res: IncomingMessage) => void) => ClientRequest;

/**
 * Ceiling on a response body held in memory. The peer on the other end of this
 * transport is UNVERIFIED by construction, so "however much it sends" is not an
 * acceptable answer: an EVE-NG JSend envelope is kilobytes, and a body this far
 * past that is a fault or an attack either way. Tripping it destroys the request
 * rather than growing the extension host's heap.
 */
export const INSECURE_FETCH_MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Thrown for anything outside the supported surface — always by this name, never silently handled. */
class InsecureFetchUnsupported extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InsecureFetchUnsupportedError";
  }
}

/**
 * The response headers, hand-rolled rather than borrowed from the platform
 * `Headers`, for two reasons: `getSetCookie()` must be present regardless of
 * the host runtime's `Headers` vintage (login depends on it — see
 * `readSessionCookie`), and `Headers.append` VALIDATES header names, so one
 * malformed name from an unverified peer would throw and destroy an otherwise
 * usable response.
 */
class InsecureResponseHeaders {
  /** lower-cased name -> every value the server sent under it, in order. */
  private readonly map = new Map<string, string[]>();

  public constructor(raw: NodeJS.Dict<string | string[]>) {
    for (const [name, value] of Object.entries(raw)) {
      if (value === undefined) {
        continue;
      }
      this.map.set(name.toLowerCase(), Array.isArray(value) ? [...value] : [value]);
    }
  }

  /** Folded with ", " for multiple values, matching how `fetch`'s Headers answers. */
  public get(name: string): string | null {
    const values = this.map.get(name.toLowerCase());
    return values && values.length > 0 ? values.join(", ") : null;
  }

  public has(name: string): boolean {
    return this.map.has(name.toLowerCase());
  }

  /**
   * LOAD-BEARING. `readSessionCookie` prefers this over `get("set-cookie")`
   * because a login response legitimately carries several Set-Cookie headers
   * and folding them into one string can split a cookie value on a comma.
   * Node hands `set-cookie` back as an ARRAY (a lone value as a plain string),
   * and both shapes normalize to an array here.
   */
  public getSetCookie(): string[] {
    return [...(this.map.get("set-cookie") ?? [])];
  }

  public forEach(callback: (value: string, name: string) => void): void {
    for (const [name] of this.map) {
      callback(this.get(name) ?? "", name);
    }
  }
}

function unsupportedMember(member: string): never {
  throw new InsecureFetchUnsupported(
    `Response.${member} is not implemented by the insecure-TLS transport — it supports status, text(), json() and headers only.`
  );
}

function makeResponse(url: string, status: number, statusText: string, headers: InsecureResponseHeaders, text: string): Response {
  const response = {
    status,
    statusText,
    ok: status >= 200 && status < 300,
    url,
    // Redirects are never followed (see `redirect: "manual"` below), so this is
    // always false — a 3xx arrives as an ordinary response instead.
    redirected: false,
    type: "basic" as const,
    headers,
    bodyUsed: false,
    text: async (): Promise<string> => text,
    json: async (): Promise<unknown> => JSON.parse(text) as unknown,
    arrayBuffer: async (): Promise<ArrayBuffer> => unsupportedMember("arrayBuffer"),
    blob: async (): Promise<never> => unsupportedMember("blob"),
    bytes: async (): Promise<never> => unsupportedMember("bytes"),
    formData: async (): Promise<never> => unsupportedMember("formData"),
    clone: (): never => unsupportedMember("clone"),
    get body(): never {
      return unsupportedMember("body");
    }
  };
  return response as unknown as Response;
}

/**
 * Every spelling of `headers` an `init` may carry, normalized onto the plain
 * record `node:https` wants. Spelled out locally rather than as `HeadersInit`
 * because the extension host tsconfig has no DOM lib — `fetch`'s types come
 * from `@types/node`, which does not export that alias.
 */
type HeadersInput = Record<string, string> | [string, string][] | { forEach(cb: (value: string, name: string) => void): void };

function normalizeHeaders(init: HeadersInput | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) {
    return out;
  }
  if (Array.isArray(init)) {
    for (const pair of init) {
      out[String(pair[0])] = String(pair[1]);
    }
    return out;
  }
  const maybeIterable = init as { forEach?: (cb: (value: string, name: string) => void) => void };
  if (typeof maybeIterable.forEach === "function") {
    maybeIterable.forEach((value, name) => {
      out[name] = value;
    });
    return out;
  }
  for (const [name, value] of Object.entries(init as Record<string, string>)) {
    out[name] = String(value);
  }
  return out;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

/**
 * Builds a `fetch`-shaped function that skips TLS certificate verification.
 * Constructing one does no I/O and opens no socket — the caller decides, per
 * request, whether this or the platform `fetch` is used.
 */
export function createInsecureHttpsFetch(requestImpl: HttpsRequestFn = httpsRequest as unknown as HttpsRequestFn): typeof fetch {
  const insecureFetch = (input: string | URL, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      // --- input / init validation, all before a socket is opened -----------
      let url: URL;
      try {
        if (typeof input === "string") {
          url = new URL(input);
        } else if (input instanceof URL) {
          url = input;
        } else {
          throw new InsecureFetchUnsupported(
            "The insecure-TLS transport accepts a URL string or URL only — a Request object is not supported."
          );
        }
      } catch (err) {
        reject(err instanceof InsecureFetchUnsupported ? err : new InsecureFetchUnsupported(`The insecure-TLS transport was given an invalid URL: ${String(input)}`));
        return;
      }
      if (url.protocol !== "https:") {
        reject(
          new InsecureFetchUnsupported(
            `The insecure-TLS transport speaks https: only, and was asked for "${url.protocol}" — relaxing certificate checks is meaningless off TLS.`
          )
        );
        return;
      }
      // Only `manual` is honoured: this adapter never follows a redirect, and
      // accepting `follow` while not following would be a silent lie. The
      // caller (`EveApiClient.raw()`) always sets `manual` on purpose — a 3xx
      // from the lab box must not be able to carry the crawl, or a 307's login
      // POST body with the password in it, to another origin.
      if (init?.redirect !== "manual") {
        reject(
          new InsecureFetchUnsupported(
            `The insecure-TLS transport requires redirect: "manual" (it never follows a redirect); got ${String(init?.redirect ?? "undefined")}.`
          )
        );
        return;
      }
      if (init.body !== undefined && init.body !== null && typeof init.body !== "string") {
        reject(new InsecureFetchUnsupported("The insecure-TLS transport supports a string request body only."));
        return;
      }
      const body = typeof init.body === "string" ? init.body : undefined;

      const headers = normalizeHeaders(init.headers as HeadersInput | undefined);
      if (body !== undefined && !hasHeader(headers, "content-length")) {
        // Without this node falls back to `Transfer-Encoding: chunked`, which
        // the caller never asked for and a PHP backend need not accept.
        headers["Content-Length"] = String(Buffer.byteLength(body));
      }
      if (!hasHeader(headers, "accept-encoding")) {
        // `node:https` does NOT decompress a response. Asking for identity keeps
        // the body readable rather than handing the JSend parser gzip bytes.
        headers["Accept-Encoding"] = "identity";
      }

      const signal = init.signal ?? undefined;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }

      // --- one-shot settlement ---------------------------------------------
      let settled = false;
      let onAbort: (() => void) | undefined;
      const detach = (): void => {
        if (onAbort && signal) {
          signal.removeEventListener("abort", onAbort);
        }
      };
      const fail = (err: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        detach();
        reject(err);
      };
      const succeed = (res: Response): void => {
        if (settled) {
          return;
        }
        settled = true;
        detach();
        resolve(res);
      };

      const req = requestImpl(
        {
          protocol: url.protocol,
          // `URL.hostname` keeps an IPv6 literal's brackets; `node:https` wants
          // the bare address (the same asymmetry `EveApiClient.hostname` handles).
          hostname: url.hostname.replace(/^\[|\]$/g, ""),
          port: url.port || "443",
          path: `${url.pathname}${url.search}`,
          method: (init.method ?? "GET").toUpperCase(),
          headers,
          // THE ENTIRE POINT — and the only place in this extension where it is
          // set. Per-request, on a socket this call owns, so no other extension
          // (and no other Nexus request) is affected.
          rejectUnauthorized: false
        },
        (res: IncomingMessage) => {
          const encoding = res.headers["content-encoding"];
          const coding = (Array.isArray(encoding) ? encoding[0] : encoding)?.toLowerCase();
          if (coding && coding !== "identity") {
            req.destroy();
            res.destroy();
            fail(
              new InsecureFetchUnsupported(
                `The insecure-TLS transport cannot read a "${coding}" content-encoding — it asks for identity and does not decompress.`
              )
            );
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > INSECURE_FETCH_MAX_BODY_BYTES) {
              req.destroy();
              res.destroy();
              fail(new InsecureFetchUnsupported(`Response body from ${url.host} is too large (over ${INSECURE_FETCH_MAX_BODY_BYTES} bytes).`));
              return;
            }
            chunks.push(chunk);
          });
          // Errors on the RESPONSE stream (a connection reset mid-body) must
          // reject rather than resolve a truncated envelope the JSend parser
          // would then blame on the base URL.
          res.on("error", (err: Error) => fail(err));
          res.on("end", () => {
            succeed(
              makeResponse(
                url.toString(),
                res.statusCode ?? 0,
                res.statusMessage ?? "",
                new InsecureResponseHeaders(res.headers),
                // Decoded once over the joined buffer, so a multi-byte character
                // straddling a chunk boundary survives.
                Buffer.concat(chunks).toString("utf8")
              )
            );
          });
        }
      );

      // The node error object is passed through UNWRAPPED: `mapNetworkError`
      // reads `err.code` (DEPTH_ZERO_SELF_SIGNED_CERT, ERR_TLS_CERT_ALTNAME_INVALID,
      // ECONNREFUSED…), and wrapping it would erase exactly the field that makes
      // the failure explainable.
      req.on("error", (err: Error) => fail(err));

      if (signal) {
        onAbort = (): void => {
          // The signal's OWN reason, never a substitute: `raw()` branches on
          // `err.name === "AbortError" || "TimeoutError"` to tell a crawl-deadline
          // truncation from a network timeout, and a generic Error there silently
          // reclassifies the former as the latter and discards a whole crawl.
          // Rejecting BEFORE destroy() means the ECONNRESET that destroy raises
          // hits the already-settled guard rather than overwriting the reason.
          fail(signal.reason);
          req.destroy();
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      req.end(body);
    });
  return insecureFetch as unknown as typeof fetch;
}
