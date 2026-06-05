export interface WebviewDocumentParts {
  /**
   * CSP/style/script nonce. When omitted, the Content-Security-Policy meta tag
   * is dropped and the `<style>`/`<script>` tags carry no `nonce` attribute.
   * Every current caller supplies a nonce; the no-nonce path exists so the
   * helper can model a CSP-less document without forcing a fake nonce.
   */
  nonce?: string;
  /** Inner CSS, placed verbatim between `<style …>` and `</style>`. */
  css: string;
  /** Inner body markup, placed verbatim between `<body>` and the `<script>`. */
  body: string;
  /** Inner JS, placed verbatim between `<script …>` and `</script>`. */
  script: string;
}

/**
 * Render the shared webview HTML document shell — `<!DOCTYPE>` + `<head>` with
 * charset/viewport/CSP meta tags, a nonce'd `<style>` block, a `<body>`, and a
 * nonce'd `<script>` block.
 *
 * Reproduces, byte-for-byte, the boilerplate previously inlined in every panel
 * HTML builder. The three content slots (`css`, `body`, `script`) are inserted
 * verbatim — callers keep their own indentation — so the rendered output is
 * identical to the hand-written templates.
 */
export function renderWebviewDocument({ nonce, css, body, script }: WebviewDocumentParts): string {
  const cspMeta = nonce
    ? `  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />\n`
    : "";
  const nonceAttr = nonce ? ` nonce="${nonce}"` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
${cspMeta}  <style${nonceAttr}>
${css}
  </style>
</head>
<body>
${body}
  <script${nonceAttr}>
${script}
  </script>
</body>
</html>`;
}
