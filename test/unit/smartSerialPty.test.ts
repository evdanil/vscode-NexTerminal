import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SmartSerialPty,
  type SmartFollowPromptInput,
  type SmartFollowPromptResult,
  type SmartSerialPtyCallbacks,
  type SmartSerialTransport
} from "../../src/services/serial/smartSerialPty";
import type { SerialProfile } from "../../src/models/config";
import type { OpenPortParams, SerialPortInfo } from "../../src/services/serial/protocol";

vi.mock("vscode", () => ({
  EventEmitter: class MockEventEmitter<T> {
    private listeners = new Set<(value: T) => void>();

    public readonly event = (listener: (value: T) => void): { dispose: () => void } => {
      this.listeners.add(listener);
      return {
        dispose: () => {
          this.listeners.delete(listener);
        }
      };
    };

    public fire(value?: T): void {
      for (const listener of this.listeners) {
        listener(value as T);
      }
    }

    public dispose(): void {
      this.listeners.clear();
    }
  }
}));

type DataListener = (sessionId: string, data: Buffer) => void;
type ErrorListener = (sessionId: string, message: string) => void;
type DisconnectListener = (sessionId: string, reason: string) => void;

function makeProfile(overrides: Partial<SerialProfile> = {}): SerialProfile {
  return {
    id: "sp1",
    name: "Cisco Console",
    path: "COM5",
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    rtscts: false,
    mode: "smartFollow",
    ...overrides
  };
}

function createTransport(options: {
  listPorts: () => Promise<SerialPortInfo[]>;
  openPort: (params: OpenPortParams) => Promise<string>;
}): {
  transport: SmartSerialTransport;
  openPort: ReturnType<typeof vi.fn>;
  emitDisconnect: (sessionId: string, reason: string) => void;
} {
  const dataListeners = new Set<DataListener>();
  const errorListeners = new Set<ErrorListener>();
  const disconnectListeners = new Set<DisconnectListener>();
  const openPort = vi.fn(options.openPort);

  const transport: SmartSerialTransport = {
    listPorts: vi.fn(options.listPorts),
    openPort,
    writePort: vi.fn(async () => {}),
    closePort: vi.fn(async () => {}),
    onDidReceiveData(listener) {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    onDidReceiveError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    onDidDisconnect(listener) {
      disconnectListeners.add(listener);
      return () => disconnectListeners.delete(listener);
    }
  };

  return {
    transport,
    openPort,
    emitDisconnect: (sessionId, reason) => {
      for (const listener of disconnectListeners) {
        listener(sessionId, reason);
      }
    }
  };
}

interface TestHarness {
  callbacks: SmartSerialPtyCallbacks;
  spies: {
    onClosed: ReturnType<typeof vi.fn>;
    onTransportSessionChanged: ReturnType<typeof vi.fn>;
    onResolvedPort: ReturnType<typeof vi.fn>;
    onStateChanged: ReturnType<typeof vi.fn>;
    onFatalError: ReturnType<typeof vi.fn>;
    getBusyPaths: ReturnType<typeof vi.fn>;
    promptPortChoice: ReturnType<typeof vi.fn>;
    onActivePortChanged: ReturnType<typeof vi.fn>;
  };
  busyPaths: Set<string>;
  pickerScript: SmartFollowPromptResult[];
  pickerInputs: SmartFollowPromptInput[];
}

function makeCallbacks(
  opts: { busyPaths?: Set<string>; pickerScript?: SmartFollowPromptResult[] } = {}
): TestHarness {
  const busyPaths = opts.busyPaths ?? new Set<string>();
  const pickerScript = opts.pickerScript ?? [];
  const pickerInputs: SmartFollowPromptInput[] = [];

  const onClosed = vi.fn();
  const onTransportSessionChanged = vi.fn();
  const onResolvedPort = vi.fn();
  const onStateChanged = vi.fn();
  const onFatalError = vi.fn();
  const onActivePortChanged = vi.fn();
  const getBusyPaths = vi.fn(() => new Set(busyPaths));
  const promptPortChoice = vi.fn(async (input: SmartFollowPromptInput) => {
    pickerInputs.push(input);
    if (pickerScript.length === 0) {
      return { kind: "wait" } as SmartFollowPromptResult;
    }
    return pickerScript.shift()!;
  });

  const callbacks: SmartSerialPtyCallbacks = {
    onClosed,
    onTransportSessionChanged,
    onResolvedPort,
    onStateChanged,
    onFatalError,
    getBusyPaths,
    promptPortChoice,
    onActivePortChanged
  };

  return {
    callbacks,
    spies: {
      onClosed,
      onTransportSessionChanged,
      onResolvedPort,
      onStateChanged,
      onFatalError,
      getBusyPaths,
      promptPortChoice,
      onActivePortChanged
    },
    busyPaths,
    pickerScript,
    pickerInputs
  };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await Promise.resolve();
  }
}

const noopLogger = () => ({ log: vi.fn(), close: vi.fn() }) as any;

describe("SmartSerialPty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects silently when the preferred port is present and not busy", async () => {
    const { transport, openPort } = createTransport({
      listPorts: async () => [{ path: "COM5", serialNumber: "ABC123" }],
      openPort: async () => "session-1"
    });
    const harness = makeCallbacks();

    const pty = new SmartSerialPty(transport, makeProfile(), harness.callbacks, noopLogger());
    pty.open();
    await flushAsync();

    expect(openPort).toHaveBeenCalledTimes(1);
    expect(openPort).toHaveBeenCalledWith(expect.objectContaining({ path: "COM5" }));
    expect(harness.spies.promptPortChoice).not.toHaveBeenCalled();
    expect(harness.spies.onActivePortChanged).toHaveBeenLastCalledWith("COM5");
    expect(harness.spies.onStateChanged).toHaveBeenCalledWith("connected");

    pty.dispose();
  });

  it("prompts a picker when a single non-hint port is available and connects on user selection", async () => {
    const com9: SerialPortInfo = { path: "COM9", vendorId: "1111", productId: "2222", serialNumber: "ABC123" };
    const { transport, openPort } = createTransport({
      listPorts: async () => [com9],
      openPort: async (params) => {
        if (params.path === "COM5") {
          throw new Error("Port COM5 not found. Check that the device is connected and the port name is correct.");
        }
        return "session-1";
      }
    });
    const harness = makeCallbacks({ pickerScript: [{ kind: "connect", port: com9 }] });
    const writes: string[] = [];

    const pty = new SmartSerialPty(transport, makeProfile(), harness.callbacks, noopLogger());
    pty.onDidWrite((chunk) => writes.push(chunk));

    pty.open();
    await flushAsync();

    expect(harness.spies.promptPortChoice).toHaveBeenCalledTimes(1);
    expect(harness.pickerInputs[0]).toMatchObject({
      preferredPath: "COM5",
      preferredStatus: "missing",
      hasHint: false,
      hintMatches: [],
      otherCandidates: [com9],
      reason: "initial"
    });
    expect(openPort).toHaveBeenCalledWith(expect.objectContaining({ path: "COM9" }));
    expect(harness.spies.onActivePortChanged).toHaveBeenLastCalledWith("COM9");
    expect(harness.spies.onResolvedPort).toHaveBeenCalledWith("COM9", expect.objectContaining({ serialNumber: "ABC123" }));
    expect(writes.join("")).toContain("Preferred port updated from COM5 to COM9");

    pty.dispose();
  });

  it("silently reattaches to a hint-matching port without prompting", async () => {
    vi.useFakeTimers();
    let currentPorts: SerialPortInfo[] = [{ path: "COM5", serialNumber: "ABC123" }];
    let opens = 0;
    const { transport, emitDisconnect, openPort } = createTransport({
      listPorts: async () => currentPorts,
      openPort: async (params) => {
        opens += 1;
        if (opens === 1 && params.path === "COM5") {
          return "session-1";
        }
        if (params.path === "COM5") {
          throw new Error("Port COM5 not found. Check that the device is connected and the port name is correct.");
        }
        return "session-2";
      }
    });
    const harness = makeCallbacks();
    const writes: string[] = [];

    const pty = new SmartSerialPty(transport, makeProfile(), harness.callbacks, noopLogger());
    pty.onDidWrite((chunk) => writes.push(chunk));

    pty.open();
    await flushAsync();

    emitDisconnect("session-1", "Port closed");
    expect(writes.join("")).toContain("waiting for it or a safe replacement");

    currentPorts = [{ path: "COM9", serialNumber: "ABC123" }];
    await vi.advanceTimersByTimeAsync(2000);
    await flushAsync();

    expect(openPort).toHaveBeenNthCalledWith(2, expect.objectContaining({ path: "COM9" }));
    expect(harness.spies.promptPortChoice).not.toHaveBeenCalled();
    expect(harness.spies.onTransportSessionChanged).toHaveBeenLastCalledWith("session-2");
    expect(writes.join("")).toContain("Preferred port updated from COM5 to COM9");

    pty.dispose();
  });

  it("prompts the picker when multiple fallback ports are available and stays silent on the next poll", async () => {
    vi.useFakeTimers();
    const ports: SerialPortInfo[] = [
      { path: "COM7", manufacturer: "FTDI" },
      { path: "COM8", manufacturer: "Prolific" }
    ];
    const { transport } = createTransport({
      listPorts: async () => ports,
      openPort: async () => {
        throw new Error("Port COM5 not found. Check that the device is connected and the port name is correct.");
      }
    });
    const harness = makeCallbacks();

    const pty = new SmartSerialPty(transport, makeProfile(), harness.callbacks, noopLogger());
    pty.open();
    await flushAsync();

    expect(harness.spies.promptPortChoice).toHaveBeenCalledTimes(1);
    expect(harness.pickerInputs[0]).toMatchObject({
      otherCandidates: expect.arrayContaining([
        expect.objectContaining({ path: "COM7" }),
        expect.objectContaining({ path: "COM8" })
      ])
    });

    // Two more poll ticks with the same candidate set should not re-prompt.
    await vi.advanceTimersByTimeAsync(2000);
    await flushAsync();
    await vi.advanceTimersByTimeAsync(2000);
    await flushAsync();
    expect(harness.spies.promptPortChoice).toHaveBeenCalledTimes(1);

    pty.dispose();
  });

  it("enters sticky stopped state when serial runtime is missing and keeps the tab open", async () => {
    vi.useFakeTimers();
    const { transport, openPort } = createTransport({
      listPorts: async () => {
        throw new Error("Cannot find module 'serialport'");
      },
      openPort: async () => "session-1"
    });
    const harness = makeCallbacks();
    const writes: string[] = [];
    const closes: number[] = [];

    const pty = new SmartSerialPty(transport, makeProfile(), harness.callbacks, noopLogger());
    pty.onDidWrite((chunk) => writes.push(chunk));
    pty.onDidClose(() => closes.push(1));

    pty.open();
    await flushAsync();

    expect(openPort).not.toHaveBeenCalled(); // listPorts failed first → no open attempt
    expect(harness.spies.onClosed).not.toHaveBeenCalled();
    expect(closes).toHaveLength(0);
    expect(harness.spies.onFatalError).toHaveBeenCalledWith(expect.stringContaining("Serial runtime missing or incompatible"));
    expect(harness.spies.onActivePortChanged).toHaveBeenLastCalledWith(undefined);
    expect(writes.join("")).toContain("Serial runtime missing or incompatible");
    expect(writes.join("")).toContain("Close this terminal to release the Smart Follow lock");

    // Stopped state should not retry — advance the poll timer twice and assert no further work.
    const listCallsAfter = (transport.listPorts as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    await flushAsync();
    await vi.advanceTimersByTimeAsync(2000);
    await flushAsync();
    expect((transport.listPorts as ReturnType<typeof vi.fn>).mock.calls.length).toBe(listCallsAfter);
    expect(harness.spies.onClosed).not.toHaveBeenCalled();

    pty.dispose();
    expect(harness.spies.onClosed).toHaveBeenCalledTimes(1);
  });

  it("filters busy ports out of candidates and waits silently when none remain", async () => {
    const com7: SerialPortInfo = { path: "COM7" };
    const { transport } = createTransport({
      listPorts: async () => [com7],
      openPort: async () => {
        throw new Error("Port COM5 not found. Check that the device is connected and the port name is correct.");
      }
    });
    const harness = makeCallbacks({ busyPaths: new Set(["COM7"]) });

    const pty = new SmartSerialPty(transport, makeProfile(), harness.callbacks, noopLogger());
    pty.open();
    await flushAsync();

    expect(harness.spies.promptPortChoice).not.toHaveBeenCalled();
    expect(harness.spies.getBusyPaths).toHaveBeenCalled();

    pty.dispose();
  });

  it("excludes busy ports from the picker and shows only free candidates", async () => {
    const com7: SerialPortInfo = { path: "COM7" };
    const com9: SerialPortInfo = { path: "COM9", manufacturer: "FTDI" };
    const { transport } = createTransport({
      listPorts: async () => [com7, com9],
      openPort: async () => {
        throw new Error("Port COM5 not found.");
      }
    });
    const harness = makeCallbacks({ busyPaths: new Set(["COM7"]) });

    const pty = new SmartSerialPty(transport, makeProfile(), harness.callbacks, noopLogger());
    pty.open();
    await flushAsync();

    expect(harness.spies.promptPortChoice).toHaveBeenCalledTimes(1);
    const input = harness.pickerInputs[0];
    expect(input.otherCandidates.map((p) => p.path)).toEqual(["COM9"]);
    expect(input.otherCandidates.map((p) => p.path)).not.toContain("COM7");

    pty.dispose();
  });

  it("prompts immediately when the preferred port exists but is busy", async () => {
    const { transport } = createTransport({
      listPorts: async () => [
        { path: "COM5" },
        { path: "COM9", manufacturer: "FTDI" }
      ],
      openPort: async () => "should-not-be-called"
    });
    const harness = makeCallbacks({ busyPaths: new Set(["COM5"]) });

    const pty = new SmartSerialPty(transport, makeProfile(), harness.callbacks, noopLogger());
    pty.open();
    await flushAsync();

    expect(harness.spies.promptPortChoice).toHaveBeenCalledTimes(1);
    expect(harness.pickerInputs[0].preferredStatus).toBe("busy");
    expect(harness.pickerInputs[0].otherCandidates.map((p) => p.path)).toEqual(["COM9"]);

    pty.dispose();
  });

  it("prompts instead of silently reconnecting when the preferred port is busy and only one hint match exists", async () => {
    const com9: SerialPortInfo = { path: "COM9", serialNumber: "ABC123" };
    const { transport, openPort } = createTransport({
      listPorts: async () => [
        { path: "COM5", serialNumber: "ABC123" },
        com9
      ],
      openPort: async () => "session-1"
    });
    const harness = makeCallbacks({ busyPaths: new Set(["COM5"]) });
    const profile = makeProfile({ deviceHint: { serialNumber: "ABC123" } });

    const pty = new SmartSerialPty(transport, profile, harness.callbacks, noopLogger());
    pty.open();
    await flushAsync();

    expect(harness.spies.promptPortChoice).toHaveBeenCalledTimes(1);
    expect(harness.pickerInputs[0]).toMatchObject({
      preferredStatus: "busy",
      hintMatches: [com9],
      otherCandidates: []
    });
    expect(openPort).not.toHaveBeenCalled();

    pty.dispose();
  });

  it("silently picks the lone hint match on initial connect when preferred is missing", async () => {
    const com9: SerialPortInfo = { path: "COM9", serialNumber: "ABC123" };
    const { transport, openPort } = createTransport({
      listPorts: async () => [com9],
      openPort: async (params) => {
        if (params.path === "COM5") {
          throw new Error("Port COM5 not found.");
        }
        return "session-1";
      }
    });
    const harness = makeCallbacks();
    const profile = makeProfile({ deviceHint: { serialNumber: "ABC123" } });

    const pty = new SmartSerialPty(transport, profile, harness.callbacks, noopLogger());
    pty.open();
    await flushAsync();

    expect(harness.spies.promptPortChoice).not.toHaveBeenCalled();
    expect(openPort).toHaveBeenCalledWith(expect.objectContaining({ path: "COM9" }));
    expect(harness.spies.onActivePortChanged).toHaveBeenLastCalledWith("COM9");

    pty.dispose();
  });

  it("waits after a lone hint match fails to open instead of prompting with no choices", async () => {
    const com9: SerialPortInfo = { path: "COM9", serialNumber: "ABC123" };
    const { transport, openPort } = createTransport({
      listPorts: async () => [com9],
      openPort: async () => {
        throw new Error("Opening COM9: Access denied");
      }
    });
    const harness = makeCallbacks();
    const writes: string[] = [];
    const profile = makeProfile({ deviceHint: { serialNumber: "ABC123" } });

    const pty = new SmartSerialPty(transport, profile, harness.callbacks, noopLogger());
    pty.onDidWrite((chunk) => writes.push(chunk));
    pty.open();
    await flushAsync();

    expect(openPort).toHaveBeenCalledTimes(1);
    expect(openPort).toHaveBeenCalledWith(expect.objectContaining({ path: "COM9" }));
    expect(harness.spies.promptPortChoice).not.toHaveBeenCalled();
    expect(harness.spies.onStateChanged).toHaveBeenCalledWith("waiting");
    expect(writes.join("")).toContain("Hint-matched port COM9 could not be opened");
    expect(writes.join("")).toContain("Preferred port COM5 is missing. Smart Follow is waiting");

    pty.dispose();
  });

  it("triggers the picker mid-session when a foreign device appears on a new port", async () => {
    vi.useFakeTimers();
    let currentPorts: SerialPortInfo[] = [{ path: "COM5", serialNumber: "ABC123" }];
    const { transport, emitDisconnect } = createTransport({
      listPorts: async () => currentPorts,
      openPort: async (params) => {
        if (params.path === "COM5") return "session-1";
        return "session-2";
      }
    });
    const harness = makeCallbacks();

    const pty = new SmartSerialPty(transport, makeProfile(), harness.callbacks, noopLogger());
    pty.open();
    await flushAsync();

    // Connected on COM5; deviceHint now contains serialNumber=ABC123
    expect(harness.spies.onActivePortChanged).toHaveBeenLastCalledWith("COM5");

    // Unplug original device, plug in a different one on COM9
    currentPorts = [];
    emitDisconnect("session-1", "Port closed");
    await flushAsync();

    currentPorts = [{ path: "COM9", manufacturer: "Prolific", serialNumber: "DIFFERENT" }];
    await vi.advanceTimersByTimeAsync(2000);
    await flushAsync();

    expect(harness.spies.promptPortChoice).toHaveBeenCalledTimes(1);
    const input = harness.pickerInputs[0];
    expect(input.hasHint).toBe(true);
    expect(input.hintMatches).toHaveLength(0);
    expect(input.otherCandidates.map((p) => p.path)).toEqual(["COM9"]);

    pty.dispose();
  });

  it("does not re-prompt the picker on subsequent polls with the same candidate set", async () => {
    vi.useFakeTimers();
    const { transport } = createTransport({
      listPorts: async () => [{ path: "COM7" }, { path: "COM8" }],
      openPort: async () => {
        throw new Error("Port COM5 not found.");
      }
    });
    const harness = makeCallbacks(); // pickerScript empty → defaults to {kind: "wait"}

    const pty = new SmartSerialPty(transport, makeProfile(), harness.callbacks, noopLogger());
    pty.open();
    await flushAsync();

    expect(harness.spies.promptPortChoice).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(2000);
      await flushAsync();
    }
    expect(harness.spies.promptPortChoice).toHaveBeenCalledTimes(1);

    pty.dispose();
  });

  it("re-prompts the picker when the candidate set changes", async () => {
    vi.useFakeTimers();
    let currentPorts: SerialPortInfo[] = [{ path: "COM7" }];
    const { transport } = createTransport({
      listPorts: async () => currentPorts,
      openPort: async () => {
        throw new Error("Port COM5 not found.");
      }
    });
    const harness = makeCallbacks();

    const pty = new SmartSerialPty(transport, makeProfile(), harness.callbacks, noopLogger());
    pty.open();
    await flushAsync();

    expect(harness.spies.promptPortChoice).toHaveBeenCalledTimes(1);

    // New port appears
    currentPorts = [{ path: "COM7" }, { path: "COM8" }];
    await vi.advanceTimersByTimeAsync(2000);
    await flushAsync();

    expect(harness.spies.promptPortChoice).toHaveBeenCalledTimes(2);

    pty.dispose();
  });

  it("enters waiting (not stopped) when preferred port open fails with an access denied error", async () => {
    vi.useFakeTimers();
    const { transport, openPort } = createTransport({
      listPorts: async () => [{ path: "COM5" }],
      openPort: async () => {
        throw new Error("Opening COM5: Access denied");
      }
    });
    const harness = makeCallbacks();
    const closes: number[] = [];
    const writes: string[] = [];

    const pty = new SmartSerialPty(transport, makeProfile(), harness.callbacks, noopLogger());
    pty.onDidWrite((chunk) => writes.push(chunk));
    pty.onDidClose(() => closes.push(1));

    pty.open();
    await flushAsync();

    expect(closes).toHaveLength(0);
    expect(harness.spies.onClosed).not.toHaveBeenCalled();
    expect(harness.spies.onFatalError).not.toHaveBeenCalled();
    expect(harness.spies.onStateChanged).toHaveBeenCalledWith("waiting");
    expect(writes.join("")).toContain("could not be opened");
    expect(openPort).toHaveBeenCalledTimes(1);

    pty.dispose();
  });

  it("keeps the tab open after a disconnect (no dispose, no closeEmitter fire)", async () => {
    const { transport, emitDisconnect } = createTransport({
      listPorts: async () => [{ path: "COM5" }],
      openPort: async () => "session-1"
    });
    const harness = makeCallbacks();
    const closes: number[] = [];

    const pty = new SmartSerialPty(transport, makeProfile(), harness.callbacks, noopLogger());
    pty.onDidClose(() => closes.push(1));

    pty.open();
    await flushAsync();

    emitDisconnect("session-1", "Port closed");
    await flushAsync();

    expect(closes).toHaveLength(0);
    expect(harness.spies.onClosed).not.toHaveBeenCalled();
    expect(harness.spies.onActivePortChanged).toHaveBeenLastCalledWith(undefined);

    pty.dispose();
  });

  it("does not re-prompt immediately after a user-picked port fails to open", async () => {
    vi.useFakeTimers();
    const com9: SerialPortInfo = { path: "COM9" };
    let opens = 0;
    const { transport } = createTransport({
      listPorts: async () => [com9],
      openPort: async (params) => {
        opens += 1;
        if (params.path === "COM9") {
          throw new Error("Opening COM9: Access denied");
        }
        throw new Error("unexpected open: " + params.path);
      }
    });
    const harness = makeCallbacks({ pickerScript: [{ kind: "connect", port: com9 }] });

    const pty = new SmartSerialPty(transport, makeProfile(), harness.callbacks, noopLogger());
    pty.open();
    await flushAsync();

    // Picker shown once; user picked COM9; one open attempt that failed.
    expect(harness.spies.promptPortChoice).toHaveBeenCalledTimes(1);
    expect(opens).toBe(1);

    // Next poll: same candidate set → debounce kicks in, no new prompt or open.
    await vi.advanceTimersByTimeAsync(2000);
    await flushAsync();
    expect(harness.spies.promptPortChoice).toHaveBeenCalledTimes(1);
    expect(opens).toBe(1);

    pty.dispose();
  });

  it("disposes only when the user manually closes the terminal", async () => {
    const { transport } = createTransport({
      listPorts: async () => [{ path: "COM5" }],
      openPort: async () => "session-1"
    });
    const harness = makeCallbacks();
    const closes: number[] = [];

    const pty = new SmartSerialPty(transport, makeProfile(), harness.callbacks, noopLogger());
    pty.onDidClose(() => closes.push(1));

    pty.open();
    await flushAsync();
    expect(harness.spies.onClosed).not.toHaveBeenCalled();

    pty.close();
    expect(closes).toHaveLength(1);
    expect(harness.spies.onClosed).toHaveBeenCalledTimes(1);
  });

  it("fires onActivePortChanged on connect, disconnect, and stopped", async () => {
    vi.useFakeTimers();
    let raiseRuntimeMissing = false;
    const { transport, emitDisconnect } = createTransport({
      listPorts: async () => {
        if (raiseRuntimeMissing) {
          throw new Error("Cannot find module 'serialport'");
        }
        return [{ path: "COM5" }];
      },
      openPort: async () => "session-1"
    });
    const harness = makeCallbacks();

    const pty = new SmartSerialPty(transport, makeProfile(), harness.callbacks, noopLogger());
    pty.open();
    await flushAsync();

    expect(harness.spies.onActivePortChanged).toHaveBeenCalledWith("COM5");

    emitDisconnect("session-1", "Port closed");
    await flushAsync();
    expect(harness.spies.onActivePortChanged).toHaveBeenLastCalledWith(undefined);

    // Now make listPorts fail with runtime-missing on the next poll, which
    // should drive the PTY into the sticky stopped state.
    raiseRuntimeMissing = true;
    await vi.advanceTimersByTimeAsync(2000);
    await flushAsync();

    expect(harness.spies.onActivePortChanged).toHaveBeenLastCalledWith(undefined);
    expect(harness.spies.onFatalError).toHaveBeenCalledWith(
      expect.stringContaining("Serial runtime missing or incompatible")
    );

    pty.dispose();
  });
});
