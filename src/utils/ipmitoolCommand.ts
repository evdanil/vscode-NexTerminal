/**
 * Conservative command-head scan for a hint, not a shell interpreter. Keep this
 * function self-contained: the editor embeds its compiled source so its live
 * hint and the host's delivery note use the same rule.
 */
export function textRunsIpmitool(text: string): boolean {
  const runsIpmitool = (words: string[], assignmentAllowed: boolean[], redirectionAllowed: boolean[]): boolean => {
    let index = 0;
    let allowAssignments = true;
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
    const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);
    while (index < words.length) {
      const word = words[index];
      if (redirectionAllowed[index]) {
        const redirection = /^(?:\d*)(?:&>>|&>|>>|<>|<&|>&|>|<)(.*)$/.exec(word);
        if (redirection) {
          index += redirection[1] ? 1 : 2;
          if (index > words.length) return false;
          continue;
        }
      }
      if (allowAssignments && assignmentAllowed[index] && assignment.test(word)) { index++; continue; }
      const name = basename(word);
      if (name === "sudo") {
        index++;
        allowAssignments = true;
        while (index < words.length && words[index].startsWith("-")) {
          const option = words[index++];
          const shortValueOption = /^-[EABbnSHkis]*[ugpCD](.*)$/.exec(option);
          if (["-u", "--user", "-g", "--group", "-p", "--prompt", "-C", "--close-from", "-D", "--chdir"].includes(option)) {
            if (index >= words.length) return false;
            index++;
          } else if (shortValueOption) {
            if (shortValueOption[1] === "") {
              if (index >= words.length) return false;
              index++;
            }
          } else if (
            !/^(?:--(?:user|group|prompt|close-from|chdir|preserve-env)=.+|-[ugpCD].+)$/.test(option) &&
            !["--login", "--shell", "--non-interactive", "--askpass", "--background", "--bell", "--set-home", "--stdin", "--reset-timestamp", "--preserve-env"].includes(option) &&
            option !== "--" && !/^-[EABbnSHkis]+$/.test(option)
          ) {
            return false;
          }
          if (option === "--") break;
        }
        continue;
      }
      if (name === "env") {
        index++;
        allowAssignments = false;
        while (index < words.length) {
          const option = words[index];
          if (assignment.test(option) || option === "-i" || option === "--ignore-environment") { index++; continue; }
          if (option === "-u" || option === "--unset") {
            if (index + 1 >= words.length) return false;
            index += 2;
            continue;
          }
          if (/^(?:-u.+|--unset=.+)$/.test(option)) { index++; continue; }
          if (option === "--") index++;
          break;
        }
        continue;
      }
      if (name === "command") {
        index++;
        allowAssignments = false;
        if (words[index] === "-v" || words[index] === "-V") return false;
        if (words[index] === "-p" || words[index] === "--") index++;
        if (words[index]?.startsWith("-")) return false;
        continue;
      }
      if (name === "exec") {
        index++;
        allowAssignments = false;
        while (words[index]?.startsWith("-")) {
          const option = words[index++];
          if (option === "-a") {
            if (index >= words.length) return false;
            index++;
          } else if (option !== "--" && !/^-[cl]+$/.test(option)) {
            return false;
          }
          if (option === "--") break;
        }
        continue;
      }
      if (name === "time") {
        index++;
        allowAssignments = false;
        if (words[index] === "-p" || words[index] === "--") index++;
        if (words[index]?.startsWith("-")) return false;
        continue;
      }
      if (name === "nice") {
        index++;
        allowAssignments = false;
        if (words[index] === "-n") index += 2;
        continue;
      }
      return !word.includes("$") && !word.includes("\\") && name === "ipmitool";
    }
    return false;
  };

  let words: string[] = [];
  let assignmentAllowed: boolean[] = [];
  let redirectionAllowed: boolean[] = [];
  let word = "";
  let inWord = false;
  let wordAllowsAssignment = true;
  let wordAllowsRedirection = true;
  let quote: "'" | '"' | undefined;
  const finishWord = () => {
    if (inWord) {
      words.push(word);
      assignmentAllowed.push(wordAllowsAssignment);
      redirectionAllowed.push(wordAllowsRedirection);
    }
    word = "";
    inWord = false;
    wordAllowsAssignment = true;
    wordAllowsRedirection = true;
  };
  const finishSegment = () => {
    finishWord();
    const result = runsIpmitool(words, assignmentAllowed, redirectionAllowed);
    words = [];
    assignmentAllowed = [];
    redirectionAllowed = [];
    return result;
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === "\\" && i + 1 < text.length) {
        const next = text[i + 1];
        if (next === "$" || next === "`" || next === '"' || next === "\\" || next === "\n") {
          i++;
          if (next !== "\n") word += next;
        } else {
          word += char;
        }
      }
      // Substitutions are active inside double quotes, but inert inside single quotes.
      else if (char === "`" || (char === "$" && text[i + 1] === "(")) return false;
      else word += char;
      continue;
    }
    if (char === "\\") {
      if (!word.includes("=")) wordAllowsAssignment = false;
      if (!/[<>]/.test(word)) wordAllowsRedirection = false;
      if (i + 1 < text.length && text[i + 1] !== "\n") word += text[++i];
      else if (text[i + 1] === "\n") i++;
      inWord = true;
      continue;
    }
    if (char === "'" || char === '"') {
      if (!word.includes("=")) wordAllowsAssignment = false;
      if (!/[<>]/.test(word)) wordAllowsRedirection = false;
      quote = char;
      inWord = true;
      continue;
    }
    if (char === "#" && !inWord) {
      while (i + 1 < text.length && text[i + 1] !== "\n" && text[i + 1] !== "\r") i++;
      continue;
    }
    // Dynamic substitutions and heredocs need a real shell parser. Ignore
    // these markers in comments and single quotes, where they are inert.
    if (char === "`" || (char === "$" && text[i + 1] === "(") || (char === "<" && text[i + 1] === "<")) return false;
    if (char === "&" && (text[i - 1] === ">" || text[i - 1] === "<" || text[i + 1] === ">")) {
      word += char;
      inWord = true;
      continue;
    }
    if (char === ";" || char === "|" || char === "&" || char === "\n" || char === "\r") {
      if (finishSegment()) return true;
      continue;
    }
    if (/\s/.test(char)) { finishWord(); continue; }
    word += char;
    inWord = true;
  }
  return !quote && finishSegment();
}

/** Embed the same classifier in the editor's existing nonce-protected script. */
export function ipmitoolCommandWebviewJs(): string {
  return `var textRunsIpmitool = ${textRunsIpmitool.toString()};`;
}
