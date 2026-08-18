/**
 * THE CERTIFICATE-FAILURE VOCABULARY, SHARED BY EVERY PROVIDER THAT OFFERS THE
 * "connect anyway" OPT-IN.
 *
 * Node reports a TLS verification failure as an opaque OpenSSL identifier.
 * Echoed verbatim (`Could not reach 10.0.0.5: DEPTH_ZERO_SELF_SIGNED_CERT.`) it
 * names the problem in a vocabulary the user never chose and offers no remedy —
 * which is exactly how someone gets stuck rather than merely refused. This
 * module turns each code into a sentence that says what the server presented and
 * where the option to accept it lives.
 *
 * It lives here, rather than in one provider, because the SECOND provider to
 * offer the option (NetBox, after EVE-NG) would otherwise copy the table — and a
 * copied table is one that gets a new code added to it in one place only, so the
 * two providers would explain the same failure differently, or one of them not
 * at all. Everything provider-specific is passed in (`CertificateHintContext`),
 * so the table itself stays single-copy.
 *
 * PURE STRINGS, NO TRANSPORT. Nothing here imports `node:https` — it is shared
 * by the desktop providers but must never be what drags a node-only module into
 * a bundle.
 */

/** What one provider needs to say about itself inside an otherwise shared sentence. */
export interface CertificateHintContext {
  /**
   * The option's EXACT form label. A message naming a control the user cannot
   * find by that name is worse than the bare OpenSSL code it replaced, so this
   * is always the same constant the config field is labelled with.
   */
  optionLabel: string;
  /** The disclosure the option is drawn under, named exactly as the form draws it. */
  sectionLabel: string;
  /**
   * WHAT ACTUALLY CROSSES THE WIRE on this provider, as a noun phrase — "the
   * EVE-NG password", "the NetBox API token". This is the clause the user is
   * agreeing to, so it must name the real credential rather than a generic one.
   */
  exposureNoun: string;
  /**
   * An optional provider-specific clause appended to the SELF-SIGNED cause only
   * (EVE-NG ships a self-signed certificate by default, and saying so is what
   * tells that user this is the expected state rather than a break-in). Absent
   * for a provider where a self-signed certificate carries no such implication.
   */
  selfSignedNote?: string;
}

/**
 * The TLS verification failures a self-hosted box actually produces, and what to
 * say about each.
 *
 * A CLOSED set, not a prefix match: `ECONNREFUSED` and any future `CERT_`-shaped
 * code that is NOT a verification failure must keep the plain "could not reach"
 * wording rather than be swept into advice about certificates.
 *
 * The altname case is worded separately on purpose. It is the common shape of
 * this failure — a home server addressed by IP, holding a certificate that never
 * listed that IP — and calling it "not trusted" would be wrong: the certificate
 * may be signed perfectly well and simply issued for another name.
 */
const TLS_CERT_HINTS: Record<string, (host: string, ctx: CertificateHintContext) => string> = {
  DEPTH_ZERO_SELF_SIGNED_CERT: (host, ctx) => `${host} presented a self-signed certificate${ctx.selfSignedNote ?? ""}.`,
  SELF_SIGNED_CERT_IN_CHAIN: (host) => `${host} presented a certificate signed by an authority this machine does not trust.`,
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: (host) => `${host} presented a certificate whose signature could not be verified — usually an incomplete chain.`,
  ERR_TLS_CERT_ALTNAME_INVALID: (host) =>
    `${host} presented a certificate that does not cover this address — the usual case when the server is reached by IP address rather than by the name on its certificate.`,
  CERT_HAS_EXPIRED: (host) => `${host} presented an expired certificate.`,
  // A private CA whose intermediate the server does not serve — the shape right
  // behind self-signed/altname in a homelab, and worded as its own case because
  // the certificate may be signed perfectly well by an authority this machine
  // simply cannot reach the issuer of.
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: (host) =>
    `${host} presented a certificate whose issuer is not held by this machine — the usual case for a private certificate authority whose chain the server does not serve.`,
  // The clock-skew twin of CERT_HAS_EXPIRED: a lab box with a dead RTC issues a
  // certificate dated in the future. Saying "expired" here would send the user
  // to reissue a certificate that is fine.
  CERT_NOT_YET_VALID: (host) => `${host} presented a certificate that is not yet valid — usually a clock that is wrong on one end or the other.`
};

/**
 * The full sentence for a certificate verification failure, or `undefined` when
 * `code` is not one — in which case the caller keeps its existing wording.
 *
 * OWN MEMBER ONLY. A plain object literal answers `code` values like
 * "constructor"/"toString" with an INHERITED function, and the branch below
 * would then call it and build a message out of whatever came back. No real node
 * code is spelled that way, but the guard costs one call and this codebase
 * already draws the same line elsewhere (`hasOwnProperty` in ui/formDefinitions.ts).
 */
export function certificateFailureMessage(code: string, host: string, ctx: CertificateHintContext): string | undefined {
  const hint = Object.prototype.hasOwnProperty.call(TLS_CERT_HINTS, code) ? TLS_CERT_HINTS[code] : undefined;
  if (!hint) {
    return undefined;
  }
  // The raw code stays in the tail: it is what makes the failure searchable and
  // diagnosable once the sentence has done its job.
  return (
    `${hint(host, ctx)} To connect anyway, turn on “${ctx.optionLabel}” in this source's ${ctx.sectionLabel} — ` +
    `that skips certificate checks for this source only, and ${ctx.exposureNoun} is then sent over an unverified connection. (${code})`
  );
}
