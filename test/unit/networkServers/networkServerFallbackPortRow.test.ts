/**
 * Unit tests for the degraded "fallback port" state on the service root rows
 * (`src/ui/networkServerTreeProvider.ts`).
 *
 * Both adapters answer an `EACCES` on their IANA port by binding an
 * unprivileged one instead (69 → 1069, 67 → 1067) rather than failing to
 * start. The wrong implementation this guards against is the original one,
 * which rendered that outcome as a plain green *running* — a service that is
 * up and, because clients target the well-known port, unreachable by anything
 * that has not been told otherwise.
 *
 * The fixture that carries the weight is the third one: TFTP **configured** on
 * 1069 and bound to 1069. That is a deliberate choice, not a fallback, and it
 * must render clean — which is what fails an implementation that tests for the
 * literal port numbers instead of comparing wanted against bound.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const readDhcpConfig = vi.hoisted(() => vi.fn(() => ({})));
const readTftpConfig = vi.hoisted(() => vi.fn(() => ({ port: 69, allowWrite: false })));

vi.mock("vscode", () => {
  const EventEmitter = vi.fn().mockImplementation(function () {
    return { event: vi.fn(), fire: vi.fn(), dispose: vi.fn() };
  });
  return {
    TreeItem: class {
      public id?: string;
      public description?: string;
      public tooltip?: string;
      public contextValue?: string;
      public iconPath?: unknown;
      public command?: unknown;
      public constructor(
        public label: string,
        public collapsibleState?: number
      ) {}
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class {
      public constructor(
        public id: string,
        public color?: { id: string }
      ) {}
    },
    ThemeColor: class {
      public constructor(public id: string) {}
    },
    EventEmitter
  };
});

vi.mock("../../../src/services/networkServers/networkServerManager", () => ({
  NETWORK_SERVER_KINDS: ["tftp", "dhcp"],
  readDhcpConfig,
  readTftpConfig
}));

import {
  NetworkServerRootTreeItem,
  NetworkServerTreeProvider
} from "../../../src/ui/networkServerTreeProvider";

interface RenderedIcon {
  id: string;
  color?: { id: string };
}

/**
 * Renders both root rows against a snapshot holding `sessions`.
 *
 * The provider reads the *configured* port from settings and the *bound* port
 * from the session, which is precisely the pair the degraded check compares —
 * so both have to come from the fixture rather than one being derived from the
 * other.
 */
function roots(sessions: unknown[]): Record<string, NetworkServerRootTreeItem> {
  const provider = new NetworkServerTreeProvider();
  provider.setSnapshot({ activeNetworkServerSessions: sessions } as never);
  const items = provider.getChildren() as NetworkServerRootTreeItem[];
  return Object.fromEntries(items.map((item) => [item.kind, item]));
}

beforeEach(() => {
  readDhcpConfig.mockReturnValue({});
  readTftpConfig.mockReturnValue({ port: 69, allowWrite: false });
});

describe("service root row — bound where clients will not look", () => {
  it("flags TFTP that fell back from 69 to 1069", () => {
    const tftp = roots([{ kind: "tftp", status: "running", boundPort: 1069 }]).tftp;
    expect(tftp.description).toBe("running · UDP 1069 · ⚠ fallback port");
    const icon = tftp.iconPath as RenderedIcon;
    expect(icon.id).toBe("warning");
    expect(icon.color?.id).toBe("testing.iconQueued");
    expect(String(tftp.tooltip)).toContain("could not bind");
    expect(String(tftp.tooltip)).toContain("UDP 69");
  });

  it("flags DHCP that fell back from 67 to 1067, and says a client cannot be redirected", () => {
    const dhcp = roots([{ kind: "dhcp", status: "running", boundPort: 1067 }]).dhcp;
    expect(dhcp.description).toBe("running · UDP 1067 · ⚠ fallback port");
    expect((dhcp.iconPath as RenderedIcon).id).toBe("warning");
    expect(String(dhcp.tooltip)).toContain("cannot be pointed at another port");
  });

  it("leaves a service configured on 1069 and bound to 1069 unflagged", () => {
    // Deliberate configuration, not a denied bind: nothing is degraded here,
    // and an implementation matching on the literal 1069 would say otherwise.
    readTftpConfig.mockReturnValue({ port: 1069, allowWrite: false });
    const tftp = roots([{ kind: "tftp", status: "running", boundPort: 1069 }]).tftp;
    expect(tftp.description).toBe("running · UDP 1069");
    const icon = tftp.iconPath as RenderedIcon;
    expect(icon.id).toBe("radio-tower");
    expect(icon.color?.id).toBe("testing.iconPassed");
  });

  it("leaves a service that got the port it asked for unflagged", () => {
    const tftp = roots([{ kind: "tftp", status: "running", boundPort: 69 }]).tftp;
    expect(tftp.description).toBe("running · UDP 69");
    expect((tftp.iconPath as RenderedIcon).id).toBe("radio-tower");
  });

  it("does not flag a stopped service, which has no bound port at all", () => {
    const tftp = roots([{ kind: "tftp", status: "stopped", boundPort: null }]).tftp;
    expect(tftp.description).toBe("stopped · UDP 69");
    expect((tftp.iconPath as RenderedIcon).id).toBe("radio-tower");
  });

  it("does not flag a service that is still starting", () => {
    // `boundPort` from a previous run can still be on the session while the
    // next start is in flight; a spinner, not a warning, is what that state is.
    const tftp = roots([{ kind: "tftp", status: "starting", boundPort: 1069 }]).tftp;
    expect(tftp.description).toBe("starting · UDP 1069");
    expect((tftp.iconPath as RenderedIcon).id).toBe("sync~spin");
  });

  it("still shows the configured port when no session exists yet", () => {
    const tftp = roots([]).tftp;
    expect(tftp.description).toBe("stopped · UDP 69");
  });
});
