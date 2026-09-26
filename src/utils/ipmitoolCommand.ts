/**
 * Conservative command-head scan for a hint, not a shell interpreter. Keep this
 * function self-contained: the editor embeds its compiled source so its live
 * hint and the host's delivery note use the same rule.
 */
export function textRunsIpmitool(text: string): boolean {
  // Dynamic command substitutions and heredocs need a real shell parser. A
  // missed advisory hint is preferable to a false claim about what will run.
  if (text.includes("$(") || text.includes("`") || text.includes("<<")) return false;

  const runsIpmitool = (words: string[]): boolean => {
    let index = 0;
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;
    const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);
    while (index < words.length) {
      const word = words[index];
      if (assignment.test(word)) { index++; continue; }
      const name = basename(word);
      if (name === "sudo") {
        index++;
        while (index < words.length && words[index].startsWith("-")) {
          const option = words[index++];
          if (["-u", "--user", "-g", "--group", "-p", "--prompt", "-C", "--close-from"].includes(option)) {
            if (index >= words.length) return false;
            index++;
          } else if (option !== "--" && !/^-[EnHSbkv]+$/.test(option)) {
            return false;
          }
          if (option === "--") break;
        }
        continue;
      }
      if (name === "env") {
        index++;
        while (index < words.length) {
          const option = words[index];
          if (assignment.test(option) || option === "-i" || option === "--ignore-environment") { index++; continue; }
          if (option === "-u" || option === "--unset") {
            if (index + 1 >= words.length) return false;
            index += 2;
            continue;
          }
          if (option === "--") index++;
          break;
        }
        continue;
      }
      if (name === "command" || name === "exec" || name === "time") {
        index++;
        continue;
      }
      if (name === "nice") {
        index++;
        if (words[index] === "-n") index += 2;
        continue;
      }
      return !word.includes("$") && !word.includes("\\") && name === "ipmitool";
    }
    return false;
  };

  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | undefined;
  const finishWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const finishSegment = () => {
    finishWord();
    const result = runsIpmitool(words);
    words = [];
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
      else if (char === "\\" && i + 1 < text.length) word += text[++i];
      else word += char;
      continue;
    }
    if (char === "\\") {
      if (i + 1 < text.length && text[i + 1] !== "\n") word += text[++i];
      else if (text[i + 1] === "\n") i++;
      inWord = true;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; inWord = true; continue; }
    if (char === "#" && !inWord) {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
      continue;
    }
    if (char === ";" || char === "|" || char === "&" || char === "\n") {
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
