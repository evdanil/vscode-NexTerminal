# Containerlab Inventory

Containerlab sync discovers **deployed nodes** and creates a connection profile for each one. It reads the Containerlab inspection data from the Linux machine that runs discovery; it does not read undeployed topology files or manage the lab.

Containerlab `0.68.0` is the minimum supported version. Later releases must return the same detailed inspection data. Nexus checks the version and rejects an unsupported release or malformed result rather than treating it as an empty lab.

## Where Discovery Runs

**Local Extension Host** means the machine running the Nexus extension. That may be a Linux desktop, a Linux environment in WSL, or a remote machine reached with VS Code Remote SSH. In WSL or a Remote SSH window, make sure the extension is running on the Linux host that has the selected Docker socket.

Containerlab discovery requires **rootful Docker on Linux** through a selected Unix socket. The socket must refer to the daemon that owns the deployed lab and must be usable by the configured command. This also applies to the Host Binary runner, which still uses Docker to identify and validate that daemon. Docker Desktop and rootless Docker are not supported. Use a Linux extension host with a rootful Docker daemon and its Unix socket.

The source form's **Discovery Location** selects **Local Extension Host** or **Remote SSH**. For Remote SSH, select a live, addressable SSH profile under **Lab Host SSH Profile**. Nexus uses that existing profile and its SSH route to reach the lab host; it does not ask you to enter a second set of lab-host credentials. If the host or one of its required jump profiles is missing or changes, restore or select a valid SSH profile before testing or syncing. Discovery will not silently switch to Local or Direct.

## Configure the Source

| Setting | What it does |
| --- | --- |
| **Discovery Location** | Runs on the extension host or through an existing SSH profile. Defaults to Local Extension Host. |
| **Lab Host SSH Profile** | Required for Remote SSH. It is the discovery destination and, under Automatic device routing, the SSH jump host for discovered nodes. |
| **CLI Runner** | Selects Host Binary, Disposable Docker Image, or Existing Docker Container. |
| **Containerlab Executable** | The host executable name or absolute path. Defaults to `containerlab`; used inside the selected container runner when applicable. |
| **Docker Executable** | The Docker client name or absolute path on the machine running the outer command. Defaults to `docker`. |
| **Installed Runner Image** | Required for Disposable Docker Image. Enter an image that is already installed on the selected daemon and contains Containerlab. Nexus never pulls it. |
| **Existing Runner Container** | Required for Existing Docker Container. Choose a container that is already running and already has the selected Docker socket mounted read-write for Containerlab. Nexus does not add mounts or change its permissions. |
| **Docker Socket** | Absolute Unix socket path on the selected Linux host. Defaults to `/var/run/docker.sock`. |
| **Use Noninteractive Sudo** | Off by default. When selected, the outer host command uses `sudo -n --`; configure it to work without a password prompt. It does not prompt for a sudo password. |
| **Device Connection** | Automatic or Direct. This controls connections to discovered devices, not where discovery runs. |
| **Lab Filter** | An optional exact lab name. It is applied after complete discovery. Leave it empty to include all labs. |
| **Address Preference** | Prefer IPv4 or IPv6 when both management addresses are available; defaults to IPv4 first and falls back to the other family. |
| **Lab Status Poll Interval (seconds)** | A value from `0` to `3600`. `0` disables background polling and is the default. Polling uses only already-approved, noninteractive discovery. |

The source keeps the usual inventory settings too: target folder, node authentication profile, fallback username, device-template rules, and removed-device policy. The profile used to authenticate to a remote lab host is separate from the node credentials. Node credentials come from the source's authentication profile or a matching device template.

## Choose a CLI Runner

**Host Binary** runs the installed Containerlab CLI on the selected Linux host. Install Containerlab `0.68.0` or later and the Docker client there, and make sure both can use the selected rootful socket. This mode does not start a helper container.

**Disposable Docker Image** is for a Containerlab image that is already installed. Nexus uses its immutable image identity for the bounded check and inspection, mounts only the selected Docker socket, disables container networking, and removes the temporary helper when the command finishes. It does not pull the image, install Containerlab, or widen Docker permissions. If the image is missing or changes before execution, choose or install the intended image and run Test or Sync again.

**Existing Docker Container** uses a container selected by its exact name or full 64-character Docker ID; abbreviated IDs are not accepted. It must already be running, have a read-write mount of the selected Docker socket, and include a compatible Containerlab CLI. Nexus checks the container's identity before it runs; it does not start, stop, reconfigure, or remove this container. If the container or mount is missing, repair it outside Nexus or select another runner.

All three modes inspect the selected Docker daemon using the configured socket. A missing CLI, unavailable socket, incompatible daemon, wrong runner image/container, or insufficient socket access fails the operation; Nexus will not silently try another daemon or grant extra permissions. If the outer command needs elevated access, select **Use Noninteractive Sudo** only after configuring passwordless sudo for that command.

## Device Connections and Template Routes

**Automatic** is the default. For local discovery it means discovered devices use a direct connection. For Remote SSH it routes their SSH connections through the selected lab-host profile, while discovery itself uses that profile to reach the lab host. **Direct** bypasses the jump host, even though discovery still runs remotely through it; use Direct only when the extension host can reach the node endpoint itself.

Containerlab normally configures external management access so the lab host can reach its nodes, subject to the management-network and host-firewall setup. That does not guarantee that a separate desktop can reach a node directly. Docker bridge addresses are not normally routable from outside the Docker host; direct access requires suitable network routes and Docker/firewall policy. See Containerlab's [access from external hosts](https://containerlab.dev/manual/network/#access-from-external-hosts) and Docker's [direct-routing requirements](https://docs.docker.com/engine/network/port-publishing/#direct-routing). When those routes are not available from the extension host, keep **Automatic** for Remote SSH discovery or configure a reachable jump host in a matching device template. Neither routing choice proves an SSH service is listening.

The lab-host profile authenticates the discovery connection; it is not copied into the node's credentials. Set node credentials on the inventory source or with [Device Templates](device-templates.md). Discovery offers SSH endpoints on port 22 when a node has a usable management address, but it does not check that an SSH server is listening or that the node credentials work.

A matching device template can set its own SSH jump host or an explicit Direct route. In a template, **Not set** means no opinion and leaves the source default available; **Direct** is an explicit route. Fill and Override follow the template ownership rules, and a route you set by hand stays yours. On a source-managed profile, **Automatic** returns the route to the source, while **Keep Direct** records a manual direct choice that later syncs preserve.

## See What Was Discovered

Each lab becomes a folder below the source's target folder. A node's stable identity is its lab and reported container name; its display and template-matching name comes from Containerlab's node-name label. Template rules can match `lab`, `kind`, `image`, `nodeName`, or `name`.

The exact **Lab Filter** is applied to the full result. It does not narrow the Docker or Containerlab inspection command, so other labs are still checked for a valid complete response before Nexus applies the filter.

Running nodes and nodes reported as created, stopped, dead, or paused remain in inventory. If a node has no usable management address, it stays as an addressless placeholder instead of disappearing and triggering the removed-device policy. Some nodes may remain addressless indefinitely: discovery reads the address Containerlab reports but does not assign one. If you know a reachable endpoint, edit the profile's Host, Port and connection settings. That gives the profile an endpoint; it does not configure the node or prove that SSH is listening. A hand-entered endpoint stays user-owned under the normal inventory field-ownership rules while the source reports no address. Nexus does not start the node for you.

Containerlab state describes the container, not network reachability or SSH readiness. Known running state can decorate the row; stopped state does not. An unfamiliar or transitional state is shown without a running decoration and clears an older running indication. If the node has an address but no SSH service, configure a reachable SSH service outside Nexus or edit the profile to use a valid endpoint and credentials.

The source can include internal helper containers returned by Containerlab's all-node inspection, but excludes those explicitly marked as internal. Malformed rows, duplicate node identities, or unsupported detailed output fail discovery; they are not interpreted as an empty inventory. A result over the node limit is marked partial and suppresses pruning.

## Approve Execution and Status Polling

Each explicit Test or Sync asks you to choose **Run** or cancel before Containerlab executes its bounded preflight and inspection. Approved status checks reuse the current window's session authority without prompting. Nexus requires a trusted VS Code workspace and checks the saved source or active form, lab host, runner, selected socket, and SSH dependencies before execution.

Saving a source does **not** require Test or Run, and saving an untested source does not authorize commands. A Test of an exact current Add/Edit form can transfer its approval when that same form is saved. An unchanged metadata edit can keep the source's approval; changing the execution setup or route requires a new Run decision. Only the tested current form can transfer approval.

Approval is local to each running VS Code window. Restarting the extension host starts without approval and requires Test or Sync followed by Run again. Saved approval records, backups, and share exports never restore or transfer authority. A change made in another window has no immediate cross-window revocation guarantee; rerun Test or Sync in each window that should use the changed setup.

Background status polling never opens a prompt or renews approval. If a source is not approved or its noninteractive SSH path is unavailable, a background poll skips it. Leave the interval at `0` to keep polling off; enabling an interval does not grant execution authority. Sharing resets the interval to `0` on the recipient's source.

## Limits and Recovery

Containerlab inventory is read-only. Nexus does not deploy or destroy nodes, start or stop them, open container shells, install Containerlab, pull images, change lab networks, or adopt nodes from another inventory source. Existing profile actions remain available for a discovered node. For an addressless node, use the manual Host, Port and connection settings remedy above if you know a reachable endpoint; discovery itself does not provide SSH readiness.

Containerlab discovery does not run in the web-extension runtime. The `webExtension` entry is a static unsupported-runtime shell and does not restore this provider's source UI or execute its discovery. Use desktop VS Code with a Linux extension host for local discovery, or configure an existing SSH profile to a rootful Linux lab host for remote discovery.

See [Inventory Sync](README.md) for sync plans and removed-device policy, and [Device Templates](device-templates.md) for source and template route ownership.
