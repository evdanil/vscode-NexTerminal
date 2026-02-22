/**
 * Inline SVG illustrations for the tunnel form.
 *
 * Each entry contains both dark and light theme variants wrapped in
 * `illustration-dark` / `illustration-light` divs.  CSS in webviewStyles
 * toggles the correct one based on VS Code's body class.
 *
 * All styles use inline SVG presentation attributes (not <style> blocks)
 * to comply with the webview's nonce-based CSP and avoid class name
 * collisions between coexisting SVGs.
 *
 * Filter IDs are namespaced per SVG (e.g. glow-ld, glow-ll) to avoid
 * collisions when all variants coexist in a single HTML document.
 */

// ── Theme color palettes ────────────────────────────────────────────

interface ThemeColors {
  bg: string;
  boxFill: string;
  title: string;
  formKey: string;
  formVal: string;
  sep: string;
  boxText: string;
  portText: string;
  label: string;
  blue: string;
  green: string;
  purple: string;
  orange: string;
  gray: string;
}

const dark: ThemeColors = {
  bg: '#0d1117',
  boxFill: '#161b22',
  title: '#e5e9f0',
  formKey: '#e5c07b',
  formVal: '#98c379',
  sep: '#4c566a',
  boxText: '#eceff4',
  portText: '#81a1c1',
  label: '#8b949e',
  blue: '#58a6ff',
  green: '#3fb950',
  purple: '#d2a8ff',
  orange: '#f0883e',
  gray: '#8b949e',
};

const light: ThemeColors = {
  bg: '#f6f8fa',
  boxFill: '#ffffff',
  title: '#24292f',
  formKey: '#854d0e',
  formVal: '#1a7f37',
  sep: '#d0d7de',
  boxText: '#24292f',
  portText: '#0969da',
  label: '#57606a',
  blue: '#0969da',
  green: '#2da44e',
  purple: '#8250df',
  orange: '#e36209',
  gray: '#8c959f',
};

// ── Inline-attribute helpers (replace <style> class-based styles) ────

const SF = 'system-ui, sans-serif';
const MF = 'monospace';

function titleEl(x: number, y: number, c: ThemeColors, text: string): string {
  return `<text x="${x}" y="${y}" font-family="${SF}" font-size="20" font-weight="700" fill="${c.title}" text-anchor="middle">${text}</text>`;
}

function fk(text: string, c: ThemeColors): string {
  return `<tspan font-family="${MF}" font-size="14" fill="${c.formKey}">${text}</tspan>`;
}

function fv(text: string, c: ThemeColors): string {
  return `<tspan font-family="${MF}" font-size="14" fill="${c.formVal}" font-weight="bold">${text}</tspan>`;
}

function sep(c: ThemeColors): string {
  return `<tspan font-family="${MF}" font-size="14" fill="${c.sep}">   |   </tspan>`;
}

function labelEl(x: number, y: number, c: ThemeColors, text: string): string {
  return `<text x="${x}" y="${y}" font-family="${SF}" font-size="12" font-weight="500" fill="${c.label}" text-anchor="middle">${text}</text>`;
}

function boxTextEl(x: number, y: number, c: ThemeColors, text: string): string {
  return `<text x="${x}" y="${y}" font-family="${SF}" font-size="14" font-weight="600" fill="${c.boxText}" text-anchor="middle">${text}</text>`;
}

function portTextEl(
  x: number,
  y: number,
  c: ThemeColors,
  text: string,
): string {
  return `<text x="${x}" y="${y}" font-family="${MF}" font-size="12" fill="${c.portText}" text-anchor="middle">${text}</text>`;
}

function glowFilter(id: string): string {
  return `<filter id="${id}" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3" result="blur"/><feComposite in="SourceGraphic" in2="blur" operator="over"/></filter>`;
}

function packet(
  fill: string,
  gid: string,
  path: string,
  dur: string,
  begin?: string,
): string {
  const b = begin ? ` begin="${begin}"` : '';
  return `<circle r="5" fill="${fill}" filter="url(#${gid})"><animateMotion path="${path}" dur="${dur}"${b} repeatCount="indefinite"/></circle>`;
}

// ── Per-type SVG builders ───────────────────────────────────────────

function buildLocalSvg(c: ThemeColors, gid: string): string {
  return `<svg viewBox="0 0 1060 320" xmlns="http://www.w3.org/2000/svg">
  <defs>${glowFilter(gid)}</defs>
  <rect width="100%" height="100%" fill="${c.bg}" rx="12"/>
  ${titleEl(530, 40, c, 'Local Port Forwarding')}
  <text x="530" y="75" text-anchor="middle">${fk('Local Port: ', c)}${fv('8443', c)}${sep(c)}${fk('Remote Host: ', c)}${fv('RemoteServer', c)}${sep(c)}${fk('RemotePort: ', c)}${fv('443', c)}</text>
  <path d="M 160 200 L 530 200" stroke="${c.blue}" stroke-width="24" stroke-opacity="0.15" stroke-linecap="round"/>
  <path d="M 160 200 L 530 200" stroke="${c.blue}" stroke-width="2" stroke-dasharray="8,6"><animate attributeName="stroke-dashoffset" from="14" to="0" dur="0.5s" repeatCount="indefinite"/></path>
  ${labelEl(345, 180, c, '&#x1f512; Secure SSH Tunnel')}
  <path d="M 530 200 L 900 200" stroke="${c.gray}" stroke-width="2" stroke-dasharray="4,4"/>
  ${labelEl(715, 180, c, 'Unencrypted Forward')}
  <g>${packet(c.green, gid, 'M 160 200 L 530 200 L 900 200', '2.5s')}${packet(c.green, gid, 'M 160 200 L 530 200 L 900 200', '2.5s', '0.8s')}${packet(c.green, gid, 'M 160 200 L 530 200 L 900 200', '2.5s', '1.6s')}</g>
  <rect x="80" y="150" width="160" height="100" rx="8" fill="${c.boxFill}" stroke="${c.green}" stroke-width="2"/>
  ${boxTextEl(160, 195, c, '&#x1f4bb; Local Client')}
  ${portTextEl(160, 220, c, 'Port 8443')}
  <rect x="450" y="150" width="160" height="100" rx="8" fill="${c.boxFill}" stroke="${c.blue}" stroke-width="2"/>
  ${boxTextEl(530, 195, c, '&#x1f6e1;&#xfe0f; SSH Server')}
  ${portTextEl(530, 220, c, '(Gateway)')}
  <rect x="820" y="150" width="160" height="100" rx="8" fill="${c.boxFill}" stroke="${c.purple}" stroke-width="2"/>
  ${boxTextEl(900, 195, c, '&#x1f3af; Target Server')}
  ${portTextEl(900, 220, c, 'Port 443')}
</svg>`;
}

function buildReverseSvg(c: ThemeColors, gid: string): string {
  const mp = 'M 950 200 L 670 200 L 390 200 L 110 200';
  return `<svg viewBox="0 0 1060 320" xmlns="http://www.w3.org/2000/svg">
  <defs>${glowFilter(gid)}</defs>
  <rect width="100%" height="100%" fill="${c.bg}" rx="12"/>
  ${titleEl(530, 35, c, 'Remote Port Forwarding')}
  <text x="530" y="65" text-anchor="middle">${fk('Remote Bind Address: ', c)}${fv('RemoteServer', c)}${sep(c)}${fk('Remote Bind Port: ', c)}${fv('8080', c)}</text>
  <text x="530" y="90" text-anchor="middle">${fk('Local Target Host: ', c)}${fv('127.0.0.1', c)}${sep(c)}${fk('Local Target Port: ', c)}${fv('3000', c)}</text>
  <path d="M 670 200 L 950 200" stroke="${c.gray}" stroke-width="2" stroke-dasharray="4,4"/>
  ${labelEl(810, 180, c, 'Unencrypted')}
  <path d="M 390 200 L 670 200" stroke="${c.blue}" stroke-width="24" stroke-opacity="0.15" stroke-linecap="round"/>
  <path d="M 390 200 L 670 200" stroke="${c.blue}" stroke-width="2" stroke-dasharray="8,6"><animate attributeName="stroke-dashoffset" from="0" to="14" dur="0.5s" repeatCount="indefinite"/></path>
  ${labelEl(530, 180, c, '&#x1f512; Secure SSH Tunnel')}
  <path d="M 110 200 L 390 200" stroke="${c.gray}" stroke-width="2" stroke-dasharray="4,4"/>
  ${labelEl(250, 180, c, 'Unencrypted Forward')}
  <g>${packet(c.orange, gid, mp, '3s')}${packet(c.orange, gid, mp, '3s', '1s')}${packet(c.orange, gid, mp, '3s', '2s')}</g>
  <rect x="40" y="150" width="140" height="100" rx="8" fill="${c.boxFill}" stroke="${c.purple}" stroke-width="2"/>
  ${boxTextEl(110, 195, c, '&#x1f5a5;&#xfe0f; Local App')}
  ${portTextEl(110, 220, c, '127.0.0.1:3000')}
  <rect x="320" y="150" width="140" height="100" rx="8" fill="${c.boxFill}" stroke="${c.green}" stroke-width="2"/>
  ${boxTextEl(390, 195, c, '&#x1f4bb; Local Client')}
  ${portTextEl(390, 220, c, '(SSH Client)')}
  <rect x="600" y="150" width="140" height="100" rx="8" fill="${c.boxFill}" stroke="${c.blue}" stroke-width="2"/>
  ${boxTextEl(670, 195, c, '&#x1f6e1;&#xfe0f; SSH Server')}
  ${portTextEl(670, 220, c, 'Port 8080')}
  <rect x="880" y="150" width="140" height="100" rx="8" fill="${c.boxFill}" stroke="${c.orange}" stroke-width="2"/>
  ${boxTextEl(950, 195, c, '&#x1f310; Public')}
  ${portTextEl(950, 220, c, 'Request')}
</svg>`;
}

function buildDynamicSvg(c: ThemeColors, gid: string): string {
  return `<svg viewBox="0 0 1060 400" xmlns="http://www.w3.org/2000/svg">
  <defs>${glowFilter(gid)}</defs>
  <rect width="100%" height="100%" fill="${c.bg}" rx="12"/>
  ${titleEl(530, 40, c, 'Dynamic Port Forwarding (SOCKS)')}
  <text x="530" y="75" text-anchor="middle">${fk('Local Port: ', c)}${fv('1080', c)}</text>
  <path d="M 160 200 L 530 200" stroke="${c.blue}" stroke-width="24" stroke-opacity="0.15" stroke-linecap="round"/>
  <path d="M 160 200 L 530 200" stroke="${c.blue}" stroke-width="2" stroke-dasharray="8,6"><animate attributeName="stroke-dashoffset" from="14" to="0" dur="0.5s" repeatCount="indefinite"/></path>
  ${labelEl(345, 180, c, '&#x1f512; Secure SSH Tunnel')}
  <path d="M 530 200 L 900 100" stroke="${c.gray}" stroke-width="2" stroke-dasharray="4,4"/>
  <path d="M 530 200 L 900 200" stroke="${c.gray}" stroke-width="2" stroke-dasharray="4,4"/>
  <path d="M 530 200 L 900 300" stroke="${c.gray}" stroke-width="2" stroke-dasharray="4,4"/>
  ${labelEl(680, 180, c, 'Dynamic Routing')}
  <g>${packet(c.orange, gid, 'M 160 200 L 530 200 L 900 100', '2.5s')}${packet(c.purple, gid, 'M 160 200 L 530 200 L 900 200', '2.5s', '0.8s')}${packet(c.green, gid, 'M 160 200 L 530 200 L 900 300', '2.5s', '1.6s')}</g>
  <rect x="80" y="150" width="160" height="100" rx="8" fill="${c.boxFill}" stroke="${c.green}" stroke-width="2"/>
  ${boxTextEl(160, 195, c, '&#x1f4bb; Local Client')}
  ${portTextEl(160, 220, c, 'Port 1080')}
  <rect x="450" y="150" width="160" height="100" rx="8" fill="${c.boxFill}" stroke="${c.blue}" stroke-width="2"/>
  ${boxTextEl(530, 195, c, '&#x1f6e1;&#xfe0f; SSH Server')}
  ${portTextEl(530, 220, c, 'Dynamic Gateway')}
  <rect x="820" y="65" width="160" height="70" rx="8" fill="${c.boxFill}" stroke="${c.orange}" stroke-width="2"/>
  ${boxTextEl(900, 105, c, '&#x1f310; Example.com')}
  <rect x="820" y="165" width="160" height="70" rx="8" fill="${c.boxFill}" stroke="${c.purple}" stroke-width="2"/>
  ${boxTextEl(900, 205, c, '&#x1f310; External API')}
  <rect x="820" y="265" width="160" height="70" rx="8" fill="${c.boxFill}" stroke="${c.green}" stroke-width="2"/>
  ${boxTextEl(900, 305, c, '&#x1f5c4;&#xfe0f; Remote DB')}
</svg>`;
}

// ── Assembly ────────────────────────────────────────────────────────

function wrapThemes(darkSvg: string, lightSvg: string): string {
  return `<div class="illustration-dark">${darkSvg}</div>\n<div class="illustration-light">${lightSvg}</div>`;
}

export const tunnelIllustrationSvgs: Record<string, string> = {
  local: wrapThemes(
    buildLocalSvg(dark, 'glow-ld'),
    buildLocalSvg(light, 'glow-ll'),
  ),
  reverse: wrapThemes(
    buildReverseSvg(dark, 'glow-rd'),
    buildReverseSvg(light, 'glow-rl'),
  ),
  dynamic: wrapThemes(
    buildDynamicSvg(dark, 'glow-dd'),
    buildDynamicSvg(light, 'glow-dl'),
  ),
};
