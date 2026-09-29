/**
 * Conservative command-head scan for a hint, not a shell interpreter. Keep this
 * function self-contained: the editor embeds its compiled source so its live
 * hint and the host's delivery note use the same rule.
 */
export function textRunsIpmitool(text: string): boolean {
  const runsIpmitool = (words: string[], assignmentAllowed: boolean[], redirectionAllowed: boolean[]): boolean => {
    const executableWords: string[] = [];
    const executableAssignmentAllowed: boolean[] = [];
    for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
      const redirection = redirectionAllowed[wordIndex] && /^(?:\d*)(?:&>>|&>|>>|<>|<&|>&|>\||>|<)(.*)$/.exec(words[wordIndex]);
      if (redirection) {
        if (!redirection[1]) {
          if (++wordIndex >= words.length) return false;
        }
        continue;
      }
      executableWords.push(words[wordIndex]);
      executableAssignmentAllowed.push(assignmentAllowed[wordIndex]);
    }
    words = executableWords;
    assignmentAllowed = executableAssignmentAllowed;
    let index = 0;
    let allowAssignments = true;
    let argvAssignmentsAllowed = false;
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
    const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);
    while (index < words.length) {
      const word = words[index];
      if (allowAssignments && (assignmentAllowed[index] || argvAssignmentsAllowed) && assignment.test(word)) { index++; continue; }
      const name = basename(word);
      if (name === "sudo") {
        index++;
        allowAssignments = true;
        argvAssignmentsAllowed = true;
        while (index < words.length && words[index].startsWith("-")) {
          const option = words[index++];
          const shortValueOption = /^-[EABbnSHkisP]*[ugpCDTRrtca](.*)$/.exec(option);
          if (["-u", "--user", "-g", "--group", "-p", "--prompt", "-C", "--close-from", "-D", "--chdir", "-T", "--command-timeout", "-R", "--chroot", "-r", "--role", "-t", "--type", "-c", "-a"].includes(option)) {
            if (index >= words.length) return false;
            index++;
          } else if (shortValueOption) {
            if (shortValueOption[1] === "") {
              if (index >= words.length) return false;
              index++;
            }
          } else if (
            !/^(?:--(?:user|group|prompt|close-from|chdir|preserve-env|command-timeout|chroot|role|type)=.+|-[ugpCDTRrtca].+)$/.test(option) &&
            !["--login", "--shell", "--non-interactive", "--askpass", "--background", "--bell", "--set-home", "--stdin", "--reset-timestamp", "--preserve-env", "--preserve-groups"].includes(option) &&
            option !== "--" && !/^-[EABbnSHkisP]+$/.test(option)
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
        // GNU env stops interpreting options at its first NAME=VALUE. A later
        // -u is the attempted command, not a wrapper option to skip.
        let optionsAllowed = true;
        while (index < words.length) {
          const option = words[index];
          if (assignment.test(option)) { optionsAllowed = false; index++; continue; }
          if (!optionsAllowed) break;
          if (option === "--") { optionsAllowed = false; index++; continue; }
          if (option === "-i" || option === "--ignore-environment" || option === "-v" || option === "--debug") { index++; continue; }
          if (option === "-C" || option === "--chdir") {
            if (index + 1 >= words.length) return false;
            index += 2;
            continue;
          }
          if (/^(?:-C.+|--chdir=.+)$/.test(option)) { index++; continue; }
          if (option === "-u" || option === "--unset") {
            if (index + 1 >= words.length) return false;
            index += 2;
            continue;
          }
          if (/^(?:-u.+|--unset=.+)$/.test(option)) { index++; continue; }
          break;
        }
        continue;
      }
      if (name === "command") {
        index++;
        allowAssignments = false;
        if (words[index] === "-v" || words[index] === "-V") return false;
        while (words[index] === "-p") index++;
        if (words[index] === "--") index++;
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
        while (words[index] === "-p") index++;
        if (words[index] === "--") index++;
        if (words[index]?.startsWith("-")) return false;
        continue;
      }
      if (name === "nice") {
        index++;
        allowAssignments = false;
        if (words[index] === "-n" || words[index] === "--adjustment") {
          if (!/^[+-]?\d+$/.test(words[index + 1] ?? "")) return false;
          index += 2;
        } else if (/^(?:-n[+-]?\d+|-\d+|--adjustment=[+-]?\d+)$/.test(words[index] ?? "")) {
          index++;
        }
        if (words[index] === "--") index++;
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

  // The "$" placeholder stands in for the in-progress word: it can satisfy a
  // dangling redirect operator (`ipmitool sdr > /tmp/x-$(date)`) or a wrapper
  // operand, but never classifies as ipmitool itself (it contains "$"), so a
  // dynamic head such as `ipmi$(echo tool)` stays unclassified.
  const headAlreadyIpmitool = () =>
    runsIpmitool([...words, "$"], [...assignmentAllowed, false], [...redirectionAllowed, false]);

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
      else if (char === "`" || (char === "$" && text[i + 1] === "(")) return headAlreadyIpmitool();
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
      // A quoted target begins a new word after a complete redirect operator.
      // Even an empty target must leave a following | as a pipeline separator.
      if (wordAllowsRedirection && /^(?:\d*)(?:&>>|&>|>>|<>|<&|>&|>\||>|<)$/.test(word)) finishWord();
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
    // Dynamic substitutions and heredocs need a real shell parser to find where
    // the nested command or heredoc body ends, so nothing AFTER the marker can
    // be classified. Words completed BEFORE it are different: a leading
    // ipmitool word already fixes which program runs. Ignore these markers in
    // comments and single quotes, where they are inert.
    if (char === "`" || (char === "$" && text[i + 1] === "(") ||
        ((char === "<" || char === ">") && text[i + 1] === "(") ||
        (char === "<" && text[i + 1] === "<")) return headAlreadyIpmitool();
    if (char === "&" && (text[i - 1] === ">" || text[i - 1] === "<" || text[i + 1] === ">")) {
      if (text[i + 1] === ">" && inWord && !/^(?:\d*)$/.test(word)) finishWord();
      word += char;
      inWord = true;
      continue;
    }
    // A redirection may touch the executable without whitespace. Keep the
    // executable and operator separate while retaining a leading fd number.
    // Quoted or escaped text cannot supply fd digits or an operator prefix.
    if ((char === ">" || char === "<") && inWord &&
        (!wordAllowsRedirection ||
          !/^(?:\d*|&|(?:\d*)(?:&>>|&>|>>|<>|<&|>&|>\||>|<))$/.test(word))) {
      finishWord();
    }
    // Bash >| clobbers a file; its target never begins a pipeline command.
    if (char === "|" && wordAllowsRedirection && /^(?:\d*)>$/.test(word)) {
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
