import { describe, expect, it } from "vitest";
import { renderTunnelMonitorHtml } from "../../src/ui/tunnelMonitorHtml";

describe("renderTunnelMonitorHtml", () => {
  it("renders empty state when no active tunnels", () => {
    const html = renderTunnelMonitorHtml({
      servers: [],
      tunnels: [],
      activeSessions: [],
      activeTunnels: []
    });

    expect(html).toContain("Active tunnels: 0");
    expect(html).toContain("No active tunnels. Start one from the Tunnel Patch Bay.");
  });

  it("renders tunnel rows and escapes HTML-sensitive fields", () => {
    const html = renderTunnelMonitorHtml({
      servers: [
        {
          id: "s1",
          name: "Server <A>",
          host: "127.0.0.1",
          port: 22,
          username: "dev",
          authType: "password",
          isHidden: false
        }
      ],
      tunnels: [
        {
          id: "t1",
          name: "DB & Metrics",
          localPort: 15432,
          remoteIP: "10.0.0.10",
          remotePort: 5432,
          autoStart: false
        }
      ],
      activeSessions: [],
      activeTunnels: [
        {
          id: "a1",
          profileId: "t1",
          serverId: "s1",
          localPort: 15432,
          remoteIP: "10.0.0.10",
          remotePort: 5432,
          startedAt: Date.now(),
          bytesIn: 1024,
          bytesOut: 2048
        }
      ]
    });

    expect(html).toContain("Active tunnels: 1");
    expect(html).toContain("DB &amp; Metrics");
    expect(html).toContain("Server &lt;A&gt;");
    expect(html).toContain("1.0 KB");
    expect(html).toContain("2.0 KB");
  });
});
