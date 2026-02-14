import type { SessionSnapshot } from "../core/contracts";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function renderTunnelMonitorHtml(snapshot: SessionSnapshot): string {
  const tunnelRows = snapshot.activeTunnels
    .map((active) => {
      const profile = snapshot.tunnels.find((item) => item.id === active.profileId);
      const server = snapshot.servers.find((item) => item.id === active.serverId);
      const name = profile?.name ?? active.profileId;
      const serverName = server?.name ?? active.serverId;
      const startedAt = new Date(active.startedAt).toLocaleTimeString();
      return `<tr>
  <td>${escapeHtml(name)}</td>
  <td>${escapeHtml(serverName)}</td>
  <td>${escapeHtml(`${active.localPort} -> ${active.remoteIP}:${active.remotePort}`)}</td>
  <td>${escapeHtml(formatBytes(active.bytesIn))}</td>
  <td>${escapeHtml(formatBytes(active.bytesOut))}</td>
  <td>${escapeHtml(startedAt)}</td>
</tr>`;
    })
    .join("\n");

  const body =
    tunnelRows.length > 0
      ? `<table>
  <thead>
    <tr>
      <th>Tunnel</th>
      <th>Server</th>
      <th>Route</th>
      <th>Inbound</th>
      <th>Outbound</th>
      <th>Started</th>
    </tr>
  </thead>
  <tbody>
${tunnelRows}
  </tbody>
</table>`
      : `<div class="empty-state">No active tunnels. Start one from the Tunnel Patch Bay.</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      --bg: #0f1b2d;
      --bg-accent: #16425b;
      --text: #f4f7fb;
      --muted: #a8bfd1;
      --border: #2b4862;
      --row: #102235;
      --row-alt: #142c43;
      --good: #42c59a;
    }
    body {
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      background: linear-gradient(155deg, var(--bg) 0%, var(--bg-accent) 100%);
      color: var(--text);
      margin: 0;
      padding: 12px;
    }
    h2 {
      font-size: 13px;
      margin: 0 0 10px 0;
      letter-spacing: 0.4px;
      text-transform: uppercase;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      background: rgba(0, 0, 0, 0.15);
    }
    th {
      text-align: left;
      background: rgba(0, 0, 0, 0.2);
      color: var(--muted);
      font-weight: 600;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
    }
    td {
      padding: 8px 10px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    tr:nth-child(odd) td {
      background: var(--row);
    }
    tr:nth-child(even) td {
      background: var(--row-alt);
    }
    tr:last-child td {
      border-bottom: none;
    }
    .empty-state {
      border: 1px dashed var(--border);
      border-radius: 10px;
      padding: 20px 12px;
      text-align: center;
      color: var(--muted);
      background: rgba(0, 0, 0, 0.2);
    }
    .summary {
      margin: 0 0 10px 0;
      color: var(--good);
      font-size: 12px;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <h2>Nexus Tunnel Monitor</h2>
  <p class="summary">Active tunnels: ${snapshot.activeTunnels.length}</p>
  ${body}
</body>
</html>`;
}
