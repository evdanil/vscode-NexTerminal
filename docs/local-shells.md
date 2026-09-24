# Local Shells

Save named local terminal profiles and open one or more local shell sessions from the Connectivity Hub.

Use a launchable VS Code terminal profile from the profile dropdown, including common resolved PowerShell, Git Bash, Command Prompt, and WSL profiles when available, or choose **Custom Shell** to set an explicit shell path, one argument per line, a working directory, and an optional startup command.

## Add a Local Shell Profile

1. Run `Nexus: Add Local Shell Profile`, or use `Nexus: Add Profile` and select **Local Shell Profile**
2. Name the profile for the workflow you want to save, for example `PowerShell Admin`, `WSL Ubuntu`, or `Project Shell`
3. Choose **VS Code Profile** as the **Launch Mode**, then pick a launchable VS Code terminal profile in **VS Code Terminal Profile**. Nexus lists explicit-path profiles plus common resolved profiles such as PowerShell, Git Bash, Command Prompt, and detected WSL distros when their executable can be found.
4. Choose **Custom Shell** when you need a path, command, or arguments Nexus cannot infer. For WSL on Windows, use `C:\Windows\System32\wsl.exe`; add arguments one per line when you need a distro or startup option, for example `-d` and `Ubuntu`
5. Optionally set a working directory and startup command, then save the profile
6. Right-click the profile and select **Open Local Shell**. You can open multiple sessions from the same saved Local Shell profile.

## Macros and Scripts in Local Shells

Manual macros, auto-trigger macros, and Nexus scripts work with Local Shell sessions.

Auto-trigger macros can match Local Shell output. Existing macros scoped to **All terminals** will also apply to Local Shell sessions; use profile-scoped macros for shell-specific prompts.

## See also

- [Terminal Macros](macros.md) — manual and auto-trigger macros, trigger scopes
- [Scripting](scripting.md) — expect/send automation against a Local Shell session
- [Terminal](terminal.md) — highlighting and tab commands
- [Local Servers](local-servers.md) — run a long-lived local process (dev server, proxy, watcher) rather than an interactive shell
- [Connectivity Hub](connectivity-hub.md) — where Local Shell profiles live
