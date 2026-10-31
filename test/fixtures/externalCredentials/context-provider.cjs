const fs = require("node:fs");

// The observation file contains synthetic test inputs, never returned credentials.
const [observation, keyFile, ...args] = process.argv.slice(2);
if (args[0] === "choose") fs.appendFileSync(observation, `${JSON.stringify(args)}\n`);
else fs.writeFileSync(observation, JSON.stringify(args));
const method = args[args.length - 1];
const result = { version: 1, username: "provider-user" };
if (method === "--pass" && args[0] === "choose") {
  const [, session, hint, host] = args;
  if (!["target", "jump"].includes(session) || hint !== `${session}-hint` || host !== "127.0.0.1") process.exit(3);
  result.username = `${session}-login`;
  result.password = `${session}-password`;
} else if (method === "--pass") result.password = "provider-password";
else if (method === "--pkey") result.private_key = fs.readFileSync(keyFile, "utf8");
else process.exit(2);
process.stdout.write(JSON.stringify(result));
