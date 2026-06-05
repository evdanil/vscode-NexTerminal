import { randomBytes } from "node:crypto";

/**
 * Generate a random nonce for webview Content-Security-Policy and
 * `<style>`/`<script>` tags. 16 random bytes, base64-encoded — matches the
 * value previously inlined across every panel.
 */
export function createWebviewNonce(): string {
  return randomBytes(16).toString("base64");
}
