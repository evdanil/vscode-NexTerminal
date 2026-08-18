import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInsecureHttpsFetch } from "../../src/services/inventory/insecureFetch";

/**
 * THE ONE THING A STUBBED `https.request` CANNOT PROVE: that
 * `rejectUnauthorized: false` actually completes a TLS handshake the platform
 * `fetch` refuses. This spins a real `node:https` server holding a real
 * self-signed certificate — the exact shape of the EVE-NG box that motivated
 * the option (self-signed, and served on an address its subject does not name)
 * — and drives both transports at it.
 *
 * The certificate is generated into a temp dir at run time and deleted after;
 * nothing is committed. If `openssl` is unavailable the suite skips rather than
 * failing, because the unit suite already covers every branch of the adapter
 * through its injection seam — this file exists to certify the handshake.
 */

interface Certs {
  key: string;
  cert: string;
  dir: string;
}

function generateSelfSigned(): Certs | undefined {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "nexus-insecure-tls-"));
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        // No subjectAltName and a name that is NOT the address the test dials:
        // both halves of the user's real failure (self-signed AND a certificate
        // that does not list the address) in one certificate.
        "-subj",
        "/CN=eve.example.com"
      ],
      { stdio: "ignore" }
    );
    return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8"), dir };
  } catch {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
    return undefined;
  }
}

const certs = generateSelfSigned();

describe.skipIf(!certs)("insecure-TLS transport against a real self-signed HTTPS server", () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer({ key: certs!.key, cert: certs!.cert }, (req, res) => {
      if (req.url === "/api/auth/login") {
        let body = "";
        req.on("data", (chunk) => {
          body += String(chunk);
        });
        req.on("end", () => {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie": ["XSRF-TOKEN=abc; Path=/", "unetlab_session=s3ss10n; Path=/; HttpOnly"]
          });
          res.end(JSON.stringify({ code: 200, status: "success", message: "", data: null, echoed: JSON.parse(body || "{}") }));
        });
        return;
      }
      if (req.url === "/hang") {
        // Deliberately never answered: the abort test must win the race against
        // the response every time, not merely usually.
        return;
      }
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "https://elsewhere.example.com/" });
        res.end("");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 200, status: "success", data: { version: "5.0.1-13" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (certs) {
      rmSync(certs.dir, { recursive: true, force: true });
    }
  });

  it("THE PLATFORM FETCH REFUSES THIS SERVER with a TLS certificate code — the failure the user is blocked on, reproduced (⊘ if this ever passes, the fixture stopped being a self-signed server and every other assertion here is vacuous)", async () => {
    const err = await fetch(`${origin}/api/status`).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    const code = ((err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code) as string;
    expect([
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "ERR_TLS_CERT_ALTNAME_INVALID"
    ]).toContain(code);
  });

  it("the insecure transport COMPLETES the same handshake and reads the body (⊘ this is the assertion no stubbed https.request can make)", async () => {
    const res = await createInsecureHttpsFetch()(`${origin}/api/status`, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toMatchObject({ status: "success", data: { version: "5.0.1-13" } });
  });

  it("carries a real POST body and hands back BOTH real Set-Cookie headers, the login path end to end", async () => {
    const res = await createInsecureHttpsFetch()(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username: "admin", password: "pw", html5: "-1" }),
      redirect: "manual"
    });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(await res.text()) as { echoed: Record<string, unknown> };
    expect(parsed.echoed).toEqual({ username: "admin", password: "pw", html5: "-1" });
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies.some((c) => c.startsWith("unetlab_session=s3ss10n"))).toBe(true);
  });

  it("does not follow a real 302 — the status comes back intact", async () => {
    const res = await createInsecureHttpsFetch()(`${origin}/redirect`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://elsewhere.example.com/");
  });

  it("still fails, with an AbortSignal.timeout's own TimeoutError, when the deadline expires mid-request against a server that never answers", async () => {
    const err = await createInsecureHttpsFetch()(`${origin}/hang`, { redirect: "manual", signal: AbortSignal.timeout(100) }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("TimeoutError");
  });

  it("still surfaces a genuine connection failure with its node code intact, so error mapping keeps working on this transport", async () => {
    const err = await createInsecureHttpsFetch()("https://127.0.0.1:1/api/status", { redirect: "manual" }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect((err as { code?: string }).code).toBe("ECONNREFUSED");
  });
});
