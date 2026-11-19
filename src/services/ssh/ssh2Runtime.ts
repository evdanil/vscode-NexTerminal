// All runtime imports of ssh2 go through this module. A credential parser can
// load ssh2 before the connector, and ssh2 captures the named DH lookup once,
// when it first loads. Keep the shim active only during that load.
import { uninstallSshDhGroupCompat } from "./sshDhGroupCompat";
import { Client, createAgent, utils } from "ssh2";

uninstallSshDhGroupCompat();

export { Client, createAgent, utils };
