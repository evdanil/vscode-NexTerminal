import { describe, expect, it } from "vitest";
import { renderTunnelMonitorHtml } from "../../src/ui/tunnelMonitorHtml";

describe("renderTunnelMonitorHtml", () => {
  it("renders empty state when no active tunnels", () => {
    const html = renderTunnelMonitorHtml({
      servers: [],
      tunnels: [],
      serialProfiles: [],
      activeSessions: [],
      activeSerialSessions: [],
      activeTunnels: [],
      remoteTunnels: []
    });

    expect(html).toContain("Active tunnels: 0");
    expect(html).toContain("No active tunnels. Start one from Port Forwarding.");
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
      serialProfiles: [],
      activeSessions: [],
      activeSerialSessions: [],
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
          bytesOut: 2048,
          connectionMode: "isolated",
          tunnelType: "local"
        }
      ],
      remoteTunnels: []
    });

    expect(html).toContain("Active tunnels: 1");
    expect(html).toContain("DB &amp; Metrics");
    expect(html).toContain("Server &lt;A&gt;");
    expect(html).toContain("1.0 KB");
    expect(html).toContain("2.0 KB");
    expect(html).toContain("isolated");
    expect(html).toContain("Local (-L)");
    expect(html).toContain("L 15432 -&gt; 10.0.0.10:5432");
  });

  it("renders type column for reverse tunnels", () => {
    const html = renderTunnelMonitorHtml({
      servers: [
        { id: "s1", name: "Server", host: "h", port: 22, username: "u", authType: "password", isHidden: false }
      ],
      tunnels: [
        { id: "t1", name: "Webhook", localPort: 3000, remoteIP: "127.0.0.1", remotePort: 8080, autoStart: false, tunnelType: "reverse", remoteBindAddress: "127.0.0.1", localTargetIP: "127.0.0.1" }
      ],
      serialProfiles: [],
      activeSessions: [],
      activeSerialSessions: [],
      activeTunnels: [
        {
          id: "a1", profileId: "t1", serverId: "s1",
          localPort: 3000, remoteIP: "127.0.0.1", remotePort: 8080,
          startedAt: Date.now(), bytesIn: 0, bytesOut: 512,
          connectionMode: "shared", tunnelType: "reverse",
          remoteBindAddress: "127.0.0.1", localTargetIP: "127.0.0.1"
        }
      ],
      remoteTunnels: []
    });

    expect(html).toContain("Reverse (-R)");
    expect(html).toContain("R 8080 &lt;- 127.0.0.1:3000");
  });

  it("renders type column for dynamic SOCKS5 tunnels", () => {
    const html = renderTunnelMonitorHtml({
      servers: [
        { id: "s1", name: "Server", host: "h", port: 22, username: "u", authType: "password", isHidden: false }
      ],
      tunnels: [
        { id: "t1", name: "Proxy", localPort: 1080, remoteIP: "0.0.0.0", remotePort: 0, autoStart: false, tunnelType: "dynamic" }
      ],
      serialProfiles: [],
      activeSessions: [],
      activeSerialSessions: [],
      activeTunnels: [
        {
          id: "a1", profileId: "t1", serverId: "s1",
          localPort: 1080, remoteIP: "0.0.0.0", remotePort: 0,
          startedAt: Date.now(), bytesIn: 4100, bytesOut: 12800,
          connectionMode: "shared", tunnelType: "dynamic"
        }
      ],
      remoteTunnels: []
    });

    expect(html).toContain("Dynamic (-D)");
    expect(html).toContain("D :1080 SOCKS5");
  });

  it("includes Type column header", () => {
    const html = renderTunnelMonitorHtml({
      servers: [
        { id: "s1", name: "S", host: "h", port: 22, username: "u", authType: "password", isHidden: false }
      ],
      tunnels: [
        { id: "t1", name: "T", localPort: 80, remoteIP: "r", remotePort: 80, autoStart: false }
      ],
      serialProfiles: [],
      activeSessions: [],
      activeSerialSessions: [],
      activeTunnels: [
        {
          id: "a1", profileId: "t1", serverId: "s1",
          localPort: 80, remoteIP: "r", remotePort: 80,
          startedAt: Date.now(), bytesIn: 0, bytesOut: 0,
          connectionMode: "shared", tunnelType: "local"
        }
      ],
      remoteTunnels: []
    });

    expect(html).toContain('<th scope="col">Type</th>');
  });
});
