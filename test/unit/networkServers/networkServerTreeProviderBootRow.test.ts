/**
 * @author kanekitakitos
 *
 * Unit tests for the DHCP "Boot / ZTP" detail row
 * (`src/ui/networkServerTreeProvider.ts`).
 *
 * The row is conditional, which is the whole point: a lab that only hands out
 * addresses gets no row at all, so its presence is itself the signal that ZTP is
 * configured. The tests therefore assert absence as carefully as presence, and
 * pin the vendor-class suffix — the one setting that can leave a
 * correctly-configured boot server reaching nothing, and the reason the summary
 * mentions it at all rather than burying it in the tooltip.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const readDhcpConfig = vi.hoisted(() => vi.fn());
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
      public constructor(
        public label: string,
        public collapsibleState?: number
      ) {}
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class {
      public constructor(public id: string) {}
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
  NetworkServerDetailTreeItem,
  NetworkServerRootTreeItem,
  NetworkServerTreeProvider
} from "../../../src/ui/networkServerTreeProvider";

function dhcpRows(config: Record<string, unknown>): NetworkServerDetailTreeItem[] {
  readDhcpConfig.mockReturnValue(config);
  const provider = new NetworkServerTreeProvider();
  const roots = provider.getChildren() as NetworkServerRootTreeItem[];
  const dhcpRoot = roots.find((root) => root.kind === "dhcp")!;
  return provider.getChildren(dhcpRoot) as NetworkServerDetailTreeItem[];
}

function bootRow(config: Record<string, unknown>): NetworkServerDetailTreeItem | undefined {
  return dhcpRows(config).find((row) => row.id === "networkServer:dhcp:boot");
}

beforeEach(() => {
  readDhcpConfig.mockReset();
  readTftpConfig.mockReturnValue({ port: 69, allowWrite: false });
});

describe("Boot / ZTP row — when it appears", () => {
  it("summarises the boot file and the server that serves it", () => {
    const row = bootRow({ bootFileName: "ztp.cfg", nextServer: "192.168.2.5" });
    expect(row?.label).toBe("Boot / ZTP");
    expect(row?.description).toBe("ztp.cfg via 192.168.2.5");
  });

  it("falls back to the first option-150 address when no nextServer is set", () => {
    const row = bootRow({ bootFileName: "ztp.cfg", tftpServerAddresses: ["192.168.2.7", "192.168.2.8"] });
    expect(row?.description).toBe("ztp.cfg via 192.168.2.7");
  });

  it("appears for a boot file with no server, and says so", () => {
    expect(bootRow({ bootFileName: "ztp.cfg" })?.description).toBe("ztp.cfg · no boot server set");
  });

  it("appears for a server with no boot file, and says so", () => {
    expect(bootRow({ nextServer: "192.168.2.5" })?.description).toBe("192.168.2.5 · no boot file set");
  });

  it("sits between the Lease Time row and the leases group", () => {
    const ids = dhcpRows({ bootFileName: "ztp.cfg", nextServer: "192.168.2.5" }).map((row) => row.id);
    expect(ids.indexOf("networkServer:dhcp:boot")).toBe(ids.indexOf("networkServer:dhcp:lease") + 1);
  });
});

describe("Boot / ZTP row — when it is omitted", () => {
  it("is absent when nothing about booting is configured", () => {
    const rows = dhcpRows({ rangeStart: "192.168.2.10", rangeEnd: "192.168.2.199" });
    expect(rows.some((row) => row.id === "networkServer:dhcp:boot")).toBe(false);
    // The rest of the DHCP branch is unaffected by the omission.
    expect(rows.map((row) => row.id)).toContain("networkServer:dhcp:pool");
  });

  it("is absent when only a vendor class is set, which boots nothing on its own", () => {
    expect(bootRow({ vendorClassId: "Cisco Systems, Inc." })).toBeUndefined();
  });

  it("is absent when the option-150 list is present but empty", () => {
    expect(bootRow({ tftpServerAddresses: [] })).toBeUndefined();
  });
});

describe("Boot / ZTP row — vendor-class suffix", () => {
  it("calls out a vendor-class filter after the summary", () => {
    const row = bootRow({
      bootFileName: "ztp.cfg",
      nextServer: "192.168.2.5",
      vendorClassId: "ArubaInstantAP"
    });
    expect(row?.description).toBe('ztp.cfg via 192.168.2.5 · only "ArubaInstantAP"');
  });

  it("omits the suffix entirely when no filter is set", () => {
    const row = bootRow({ bootFileName: "ztp.cfg", nextServer: "192.168.2.5" });
    expect(row?.description).not.toContain("only");
    expect(row?.description).toBe("ztp.cfg via 192.168.2.5");
  });

  it("appends the filter to the no-boot-file summary too", () => {
    expect(bootRow({ nextServer: "192.168.2.5", vendorClassId: "Cisco" })?.description).toBe(
      '192.168.2.5 · no boot file set · only "Cisco"'
    );
  });
});

describe("Boot / ZTP row — tooltip", () => {
  it("names each DHCP option number behind the row", () => {
    const tooltip = String(
      bootRow({
        bootFileName: "ztp.cfg",
        nextServer: "192.168.2.5",
        tftpServerAddresses: ["192.168.2.7", "192.168.2.8"],
        vendorClassId: "ArubaInstantAP"
      })?.tooltip
    );
    expect(tooltip).toContain("Boot file (option 67): ztp.cfg");
    expect(tooltip).toContain("Boot server (option 66): 192.168.2.5");
    expect(tooltip).toContain("TFTP servers (option 150): 192.168.2.7, 192.168.2.8");
    expect(tooltip).toContain("Vendor class filter (option 60): ArubaInstantAP");
  });

  it("spells out what is missing rather than leaving a blank line", () => {
    const tooltip = String(bootRow({ bootFileName: "ztp.cfg" })?.tooltip);
    expect(tooltip).toContain("Boot server (option 66): not set");
    expect(tooltip).toContain("TFTP servers (option 150): not set");
    expect(tooltip).toContain("Vendor class filter (option 60): all clients");
  });

  it("adds an option 43 line only when vendor-specific sub-options exist", () => {
    const withOptions = String(
      bootRow({
        bootFileName: "ztp.cfg",
        vendorSpecificOptions: [
          { subOption: 1, value: "ztp" },
          { subOption: 43, value: "0xC0A80201" }
        ]
      })?.tooltip
    );
    expect(withOptions).toContain("Vendor-specific (option 43): 1=ztp, 43=0xC0A80201");
    expect(String(bootRow({ bootFileName: "ztp.cfg", vendorSpecificOptions: [] })?.tooltip)).not.toContain(
      "option 43"
    );
  });
});
