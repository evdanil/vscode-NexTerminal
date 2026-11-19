import type { HighlightRule } from "../utils/highlightRuleValidation";

interface HighlightProfilePreset {
  name: string;
  rules: readonly HighlightRule[];
}

function rule(label: string, pattern: string, color: string): HighlightRule {
  return { label, pattern, color, flags: "gi" };
}

// Rules run on plain terminal spans, which can contain multiple lines. The
// settings format supports g and i, so express line boundaries in the pattern.
const lineStart = String.raw`(?:^|(?<=[\r\n]))`;
const lineEnd = String.raw`(?=[ \t]{0,16}(?:[\r\n]|$))`;
const columnEnd = String.raw`(?=[ \t\r\n]|$)`;

const ipv4Octet = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
const ipv4 = String.raw`(?:${ipv4Octet}\.){3}${ipv4Octet}`;
const addressRules = [
  rule("IPv4 address or prefix", String.raw`(?<![\w.])${ipv4}(?:/(?:3[0-2]|[12]?\d))?(?![\w./])`, "cyan"),
  rule("MAC address", String.raw`(?<![\w:.-])(?:(?:[a-f0-9]{2}:){5}[a-f0-9]{2}|(?:[a-f0-9]{2}-){5}[a-f0-9]{2}|(?:[a-f0-9]{4}\.){2}[a-f0-9]{4})(?![\w:.-])`, "magenta")
];

const iosStyleCliRules = [
  rule("Configuration prompt", String.raw`${lineStart}[\w.-]{1,64}\(config[\w-]{0,40}\)#`, "yellow"),
  rule("CLI prompt", String.raw`${lineStart}[\w.-]{1,64}[>#]`, "cyan"),
  rule("CLI input error", String.raw`${lineStart}%[ \t]{0,8}(?:Invalid input|Incomplete command|Ambiguous command|Unrecognized command|Unknown command)\b`, "red"),
  rule("Severe syslog event", String.raw`%[A-Z0-9_]{1,32}-[0-2]-[A-Z0-9_]{1,48}(?=:)`, "red"),
  rule("Syslog error or warning", String.raw`%[A-Z0-9_]{1,32}-[34]-[A-Z0-9_]{1,48}(?=:)`, "yellow")
];

// Match the status before inspecting its preceding columns so the lookbehind
// runs only at candidate status words, even on a space-filled terminal line.
function inStatusColumn(prefix: string, status: string, suffix: string): string {
  return String.raw`\b${status}(?<=${prefix}${status})${suffix}`;
}

const ciscoBriefColumns = String.raw`${lineStart}[ \t]{0,12}[\w./:-]{1,48}[ \t]{1,24}(?:${ipv4}|unassigned)[ \t]{1,24}(?:YES|NO)[ \t]{1,16}[\w-]{1,16}[ \t]{1,24}`;
const ciscoInterface = String.raw`\b(?:Ethernet|FastEthernet|GigabitEthernet|TenGigabitEthernet|TwentyFiveGigE|FortyGigabitEthernet|HundredGigE|Gi|Fa|Te|Eth|Serial|Se|Loopback|Lo|Port-channel|Po|Vlan|Vl)\d{1,5}(?:/\d{1,5}){0,4}(?:\.\d{1,5})?\b`;

const junosInterface = String.raw`(?:(?:ge|xe|et|fe|em|fxp|reth)-\d{1,3}/\d{1,3}/\d{1,4}|(?:ae|irb|lo|vlan|reth|fxp|em|me|vme)\d{1,5})(?:\.\d{1,5})?`;
const junosTerseColumns = String.raw`${lineStart}[ \t]{0,12}${junosInterface}[ \t]{1,32}`;

const eosInterface = String.raw`(?:Ethernet|Et|Port-Channel|Po|Management|Ma|Vlan|Vl|Loopback|Lo)\d{1,5}(?:/\d{1,5}){0,4}(?:\.\d{1,5})?`;
// A nonempty Name column has nonspace endpoints, so padding cannot be
// redistributed across the Port, Name, and Status column separators.
const eosStatusColumns = String.raw`${lineStart}[ \t]{0,12}${eosInterface}[ \t]{1,40}(?:[^ \t\r\n](?:[^\r\n]{0,62}[^ \t\r\n])?[ \t]{2,24})?`;
const eosStatusTail = String.raw`(?=[ \t]{2,24}(?:\d{1,4}|trunk|routed|in Po\d{1,5}|--)[ \t]{1,16}(?:a-full|a-half|full|half|auto|unconf|unknown|--)${columnEnd})`;

export const HIGHLIGHT_PROFILE_PRESETS: readonly HighlightProfilePreset[] = [
  {
    name: "Cisco IOS / IOS XE",
    rules: [
      ...iosStyleCliRules,
      rule("Brief interface administratively down", inStatusColumn(ciscoBriefColumns, String.raw`administratively[ \t]{1,16}down[ \t]{1,24}down`, lineEnd), "yellow"),
      rule("Brief interface down", inStatusColumn(ciscoBriefColumns, String.raw`(?:down[ \t]{1,24}(?:up|down)|up[ \t]{1,24}down)`, lineEnd), "red"),
      rule("Brief interface up", inStatusColumn(ciscoBriefColumns, String.raw`up[ \t]{1,24}up`, lineEnd), "green"),
      rule("Administratively down", String.raw`\badministratively down\b`, "yellow"),
      rule("Line protocol down", String.raw`\bline protocol is down\b`, "red"),
      rule("Line protocol up", String.raw`\bline protocol is up\b`, "green"),
      rule("BGP neighbor established", String.raw`\bBGP state = Established\b`, "green"),
      rule("BGP neighbor negotiating", String.raw`\bBGP state = (?:Idle|Active|Connect|OpenSent|OpenConfirm)\b`, "yellow"),
      rule("Interface name", ciscoInterface, "blue"),
      ...addressRules
    ]
  },
  {
    name: "Juniper Junos",
    rules: [
      rule("Configuration hierarchy", String.raw`${lineStart}\[edit(?: [^\r\n\]]{1,100})?\]${lineEnd}`, "yellow"),
      rule("Junos prompt", String.raw`${lineStart}[\w.-]{1,64}@[\w.-]{1,64}[>#]`, "cyan"),
      rule("CLI syntax error", String.raw`${lineStart}(?:(?:syntax error|unknown command)\b|error:)`, "red"),
      rule("Terse interface disabled", inStatusColumn(junosTerseColumns, String.raw`down[ \t]{1,24}(?:up|down)`, columnEnd), "yellow"),
      rule("Terse link down", inStatusColumn(junosTerseColumns, String.raw`up[ \t]{1,24}down`, columnEnd), "red"),
      rule("Terse link up", inStatusColumn(junosTerseColumns, String.raw`up[ \t]{1,24}up`, columnEnd), "green"),
      rule("BGP routing-table peer established", String.raw`\bEstabl(?=[ \t]{1,16}[\w.-]{1,64}:)`, "green"),
      rule("BGP neighbor established", String.raw`\b(?:Peer )?State:[ \t]{1,12}Established\b`, "green"),
      rule("Interface name", String.raw`(?<![\w-])${junosInterface}(?![\w/.-])`, "blue"),
      ...addressRules
    ]
  },
  {
    name: "Arista EOS",
    rules: [
      ...iosStyleCliRules,
      rule("Port error-disabled", inStatusColumn(eosStatusColumns, "errdisabled", String.raw`(?=${eosStatusTail}|[ \t]{2,24}[\w-]{1,60}${lineEnd})`), "red"),
      rule("Port disconnected", inStatusColumn(eosStatusColumns, "notconnect", eosStatusTail), "red"),
      rule("Port disabled", inStatusColumn(eosStatusColumns, "disabled", eosStatusTail), "yellow"),
      rule("Port connected", inStatusColumn(eosStatusColumns, "connected", eosStatusTail), "green"),
      rule("Line protocol disconnected", String.raw`\bline protocol is down\b`, "red"),
      rule("Line protocol connected", String.raw`\bline protocol is up\b`, "green"),
      rule("BGP neighbor established", String.raw`\bBGP state is Established\b`, "green"),
      rule("Interface name", String.raw`\b${eosInterface}(?![\w/.-])`, "blue"),
      ...addressRules
    ]
  }
];
