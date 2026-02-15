import type { SessionSnapshot } from "../core/contracts";
import { formatBytes } from "../utils/helpers";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
  <td>${escapeHtml(active.connectionMode)}</td>
  <td>${escapeHtml(formatBytes(active.bytesIn))}</td>
  <td>${escapeHtml(formatBytes(active.bytesOut))}</td>
  <td>${escapeHtml(startedAt)}</td>
</tr>`;
    })
    .join("\n");

  const body =
    tunnelRows.length > 0
      ? `<table role="table" aria-label="Active tunnel connections">
  <thead>
    <tr>
      <th scope="col">Tunnel</th>
      <th scope="col">Server</th>
      <th scope="col">Route</th>
      <th scope="col">Mode</th>
      <th scope="col">Inbound</th>
      <th scope="col">Outbound</th>
      <th scope="col">Started</th>
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
    body {
      font-family: var(--vscode-font-family);
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
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
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      overflow: hidden;
      background: var(--vscode-editor-background);
    }
    th {
      text-align: left;
      background: var(--vscode-list-hoverBackground);
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    td {
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    tr:nth-child(odd) td {
      background: var(--vscode-editor-background);
    }
    tr:nth-child(even) td {
      background: var(--vscode-list-hoverBackground);
    }
    tr:last-child td {
      border-bottom: none;
    }
    .empty-state {
      border: 1px dashed var(--vscode-panel-border);
      border-radius: 10px;
      padding: 20px 12px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-background);
    }
    .summary {
      margin: 0 0 10px 0;
      color: var(--vscode-terminal-ansiGreen);
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
