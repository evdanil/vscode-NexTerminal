import { describe, expect, it } from "vitest";
import { ipmitoolCommandWebviewJs, textRunsIpmitool } from "../../src/utils/ipmitoolCommand";

// The head of a segment is fixed once an ipmitool word has completed, so a
// later substitution or heredoc marker cannot hide it; text AFTER a marker and
// dynamic heads stay unclassified because they need a real shell parser.
describe("textRunsIpmitool", () => {
  it.each([
  ["a substitution after the ipmitool head", "ipmitool -H $(cat h) mc info\n"],
  ["a backtick after the ipmitool head", "ipmitool -H `x` mc info\n"],
  ["a substitution inside double quotes after the head", "sudo ipmitool -H h -P \"$(cat pw)\" sol activate\n"],
  ["a here-string after the head", "ipmitool raw 0x06 0x01 <<< foo\n"],
  ["a heredoc after the head", "ipmitool shell <<EOF\nmc info\nEOF\n"],
  ["a substitution in a redirection target", "ipmitool sdr > /tmp/sdr-$(date +%s).txt\n"],
  ["an arithmetic expansion after the head", "ipmitool -t $((0x20)) raw 6 1\n"],
  ["a legacy variable and substitution style", "ipmitool -H $host -U $user -P $(pass bmc) sol activate\n"],
  ["a command wrapper with -p and --", "command -p -- ipmitool -E\n"],
  ["an obsolescent nice adjustment", "nice -5 ipmitool -E\n"],
  ["a sudo SELinux role", "sudo -r role_r ipmitool -E\n"],
  ["an attached sudo SELinux role", "sudo --role=role_r ipmitool -E\n"],
  ["a sudo SELinux type", "sudo -t type_t ipmitool -E\n"],
  ["an attached sudo SELinux type", "sudo --type=type_t ipmitool -E\n"],
  ["a sudo login class", "sudo -c class ipmitool -E\n"],
  ["a sudo auth type", "sudo -a auth ipmitool -E\n"],
  ["a time wrapper with -p", "time -p ipmitool -E\n"],
  ["a time wrapper with -p and --", "time -p -- ipmitool -E\n"],
    ["a here-string attached to the head", "ipmitool<<<foo\n"],
    ["a heredoc attached to the head", "ipmitool<<EOF\nmc info\nEOF\n"],
    ["a sudo auth-type long option", "sudo --auth-type=x ipmitool -E\n"],
    ["a sudo login-class long option", "sudo --login-class=x ipmitool -E\n"],
    ["a separated sudo long option 0", "sudo --role role_r ipmitool -E\n"],
    ["a separated sudo long option 1", "sudo --type type_t ipmitool -E\n"],
    ["a separated sudo long option 2", "sudo --auth-type pam ipmitool -E\n"],
    ["a separated sudo long option 3", "sudo --login-class staff ipmitool -E\n"]
  ])("detects ipmitool with %s", (_case, text) => {
    expect(textRunsIpmitool(text)).toBe(true);
  });

  it.each([
  ["a heredoc body", "cat <<EOF\nipmitool -E\nEOF\n"],
  ["a nested shell heredoc", "sh <<'EOF'\nipmitool -E\nEOF\n"],
  ["a dynamic head with a substitution", "ipmi$(echo tool) -E\n"],
  ["a quoted head with a substitution", "\"ipmitool$(x)\" -E\n"],
  ["a dynamic head from a substitution", "$(which ipmitool) -E\n"],
  ["a leading redirection target substitution", "> $(mktemp) ipmitool -E\n"],
  ["a leading process substitution", "<(true) ipmitool -E\n"],
  ["a later segment after a substitution", "echo $(date); ipmitool -E\n"],
  ["a later line after a backtick", "echo `date`\nipmitool -E\n"],
  ["a dynamic sudo operand", "sudo -u $(whoami) ipmitool -E\n"],
  ["a dynamic env operand", "env $(x) ipmitool -E\n"],
  ["a sudo long option value 0", "sudo --user ipmitool\n"],
  ["a sudo long option value 1", "sudo --auth-type ipmitool\n"],
  ["a sudo long option value 2", "sudo --login-class ipmitool -E\n"],
  ["a repeated time -p", "time -p -p -- ipmitool -E\n"]
  ])("does not detect ipmitool with %s", (_case, text) => {
    expect(textRunsIpmitool(text)).toBe(false);
  });

  it("still finds ipmitool before a substitution in an earlier segment", () => {
    expect(textRunsIpmitool("ipmitool mc info; echo `date`\n")).toBe(true);
  });

  it("is self-contained when embedded in the webview", () => {
    const embedded = new Function(`${ipmitoolCommandWebviewJs()}\nreturn textRunsIpmitool;`)() as (t: string) => boolean;
    expect(embedded("ipmitool -H $(cat h) mc info")).toBe(true);
    expect(embedded("ipmi$(echo tool) -E")).toBe(false);
  });
});
