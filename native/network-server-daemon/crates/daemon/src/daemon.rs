//! Request dispatch.
//!
//! Kept apart from `main` so the whole method surface can be driven from a test
//! without a process, a pipe, or a socket.

use nexus_rpc::{ErrorCode, Outgoing, Request};
use serde_json::{json, Map, Value};

use crate::config::ConfigStore;
use crate::dhcp_service::{self, DhcpService};
use crate::events::Emitter;
use crate::tftp_service::{self, TftpService};

pub struct Daemon {
    emitter: Emitter,
    store: ConfigStore,
    tftp: TftpService,
    dhcp: DhcpService,
}

impl Daemon {
    #[must_use]
    pub fn new(emitter: Emitter) -> Self {
        Self {
            tftp: TftpService::new(emitter.clone()),
            dhcp: DhcpService::new(emitter.clone()),
            store: ConfigStore::default(),
            emitter,
        }
    }

    /// Applies the spawn-time environment seed.
    ///
    /// Must run **before** `ready` is emitted: the host may issue `list` the
    /// instant it sees `ready`, and that snapshot has to already reflect the
    /// configured ports rather than the defaults. Getting this order wrong shows
    /// up as the UI briefly displaying port 69 for a service the operator moved
    /// to 6900.
    pub fn apply_env_seed(&mut self) {
        if let Some(warning) = self.store.apply_env_seed() {
            self.emitter.log("daemon", "warn", &warning);
        }
        self.push_config_to_services();
    }

    /// Stops every service. Idempotent.
    pub fn stop_all(&mut self) {
        self.tftp.stop();
        self.dhcp.stop();
    }

    /// Dispatches one request and produces its response.
    pub fn handle(&mut self, request: &Request) -> Outgoing {
        let id = request.id;
        match request.method.as_str() {
            "list" => Outgoing::result(
                id,
                json!([self.tftp.snapshot(), self.dhcp.snapshot()]),
            ),
            "getStatus" => match Self::service_id(request) {
                Ok(tftp_service::SERVICE_ID) => Outgoing::result(id, self.tftp.snapshot()),
                Ok(dhcp_service::SERVICE_ID) => Outgoing::result(id, self.dhcp.snapshot()),
                Ok(unknown) => Self::not_found(id, unknown),
                Err(response) => response,
            },
            "configure" => self.handle_configure(request),
            "start" => self.handle_start(request),
            "stop" => self.handle_stop(request),
            "restart" => self.handle_restart(request),
            "cancelTransfer" => self.handle_cancel(request),
            "getServiceRuntime" => match Self::service_id(request) {
                Ok(tftp_service::SERVICE_ID) => Outgoing::result(id, self.tftp.runtime()),
                Ok(dhcp_service::SERVICE_ID) => Outgoing::result(id, self.dhcp.runtime()),
                Ok(unknown) => Self::not_found(id, unknown),
                Err(response) => response,
            },
            other => Outgoing::error(
                id,
                ErrorCode::MethodNotFound,
                format!("Unknown method: {other}"),
            ),
        }
    }

    // -- individual methods -------------------------------------------------

    fn handle_configure(&mut self, request: &Request) -> Outgoing {
        let configs = match request.params.get("configs") {
            Some(Value::Object(map)) => map.clone(),
            None | Some(Value::Null) => Map::new(),
            Some(_) => {
                return Outgoing::error(
                    request.id,
                    ErrorCode::InvalidParams,
                    "configs must be an object",
                )
            }
        };
        match self.apply_configs(&configs) {
            Ok(changed) => Outgoing::result(request.id, json!({ "ok": true, "changed": changed })),
            Err(message) => Outgoing::error(request.id, ErrorCode::InvalidParams, message),
        }
    }

    fn handle_start(&mut self, request: &Request) -> Outgoing {
        let service = match Self::service_id(request) {
            Ok(service) => service,
            Err(response) => return response,
        };
        if let Err(response) = self.apply_inline_config(request, service) {
            return response;
        }
        match service {
            tftp_service::SERVICE_ID => match self.tftp.start() {
                Ok(()) => Self::ok(request.id, service),
                Err(message) => Outgoing::error(request.id, ErrorCode::InternalError, message),
            },
            dhcp_service::SERVICE_ID => match self.dhcp.start() {
                Ok(()) => Self::ok(request.id, service),
                Err(message) => Outgoing::error(request.id, ErrorCode::InternalError, message),
            },
            unknown => Self::not_found(request.id, unknown),
        }
    }

    fn handle_stop(&mut self, request: &Request) -> Outgoing {
        match Self::service_id(request) {
            // Stopping something that was never started is success, not an
            // error: it is already in the state the caller asked for.
            Ok(tftp_service::SERVICE_ID) => {
                self.tftp.stop();
                Self::ok(request.id, tftp_service::SERVICE_ID)
            }
            Ok(dhcp_service::SERVICE_ID) => {
                self.dhcp.stop();
                Self::ok(request.id, dhcp_service::SERVICE_ID)
            }
            Ok(unknown) => Self::not_found(request.id, unknown),
            Err(response) => response,
        }
    }

    fn handle_restart(&mut self, request: &Request) -> Outgoing {
        let service = match Self::service_id(request) {
            Ok(service) => service,
            Err(response) => return response,
        };
        match service {
            tftp_service::SERVICE_ID => {
                // Stop first, THEN apply.
                //
                // In the reference implementation this ordering was
                // load-bearing: `configure` refused to evict a *running*
                // adapter instance, so applying before the stop left the old
                // instance in place and restarted it with the settings it
                // already had — the operator's edit silently never took effect.
                //
                // Here it is not load-bearing, and honesty about that is worth
                // more than a comment implying otherwise: there is no cached
                // instance to evict, because `TftpService::start` reads the
                // configuration field directly. Both orderings produce the same
                // result, and no test can tell them apart — the mutation audit
                // confirms exactly that. The order is kept because it is the
                // one that stays correct if a cache is ever introduced, and
                // because "stop, reconfigure, start" is the sequence a reader
                // expects.
                self.tftp.stop();
                if let Err(response) = self.apply_inline_config(request, service) {
                    return response;
                }
                match self.tftp.start() {
                    Ok(()) => Self::ok(request.id, service),
                    Err(message) => Outgoing::error(request.id, ErrorCode::InternalError, message),
                }
            }
            dhcp_service::SERVICE_ID => {
                // Same ordering rule as TFTP above: stop, then apply, then
                // start. Here it *is* load-bearing in one respect — the lease
                // file is flushed by the stop, so the restarted engine restores
                // the table the running one had rather than the one it started
                // with.
                self.dhcp.stop();
                if let Err(response) = self.apply_inline_config(request, service) {
                    return response;
                }
                match self.dhcp.start() {
                    Ok(()) => Self::ok(request.id, service),
                    Err(message) => Outgoing::error(request.id, ErrorCode::InternalError, message),
                }
            }
            unknown => Self::not_found(request.id, unknown),
        }
    }

    fn handle_cancel(&mut self, request: &Request) -> Outgoing {
        let service = match Self::service_id(request) {
            Ok(service) => service,
            Err(response) => return response,
        };
        if service != tftp_service::SERVICE_ID {
            return Outgoing::error(
                request.id,
                ErrorCode::NotFound,
                format!("Service '{service}' has no cancellable transfers."),
            );
        }
        let transfer_id = match request.string_param("transferId") {
            Ok(value) => value,
            Err(code) => {
                return Outgoing::error(request.id, code, "transferId must be a string")
            }
        };
        let cancelled = self.tftp.cancel_transfer(transfer_id);
        Outgoing::result(
            request.id,
            json!({ "ok": cancelled, "id": service, "transferId": transfer_id }),
        )
    }

    // -- helpers ------------------------------------------------------------

    /// Reads and interns the `id` parameter.
    ///
    /// Interning to `&'static str` is what lets the match arms above compare
    /// against the service constants rather than against string literals that
    /// could drift apart from them.
    fn service_id(request: &Request) -> Result<&'static str, Outgoing> {
        let raw = request.string_param("id").map_err(|code| {
            Outgoing::error(request.id, code, "id must be a string naming a service")
        })?;
        match raw {
            tftp_service::SERVICE_ID => Ok(tftp_service::SERVICE_ID),
            dhcp_service::SERVICE_ID => Ok(dhcp_service::SERVICE_ID),
            // Returned as an owned name so the caller can report it; leaking a
            // `&'static str` per unknown id would be a slow memory leak driven
            // by the peer.
            _ => Err(Self::not_found(request.id, raw)),
        }
    }

    fn apply_inline_config(
        &mut self,
        request: &Request,
        service: &'static str,
    ) -> Result<(), Outgoing> {
        let Some(config @ Value::Object(_)) = request.params.get("config") else {
            return Ok(());
        };
        // The set of changed ids is not interesting here — the caller is a
        // `start` or `restart`, whose own result says what happened.
        self.store
            .apply_one(service, config)
            .map_err(|e| Outgoing::error(request.id, ErrorCode::InvalidParams, e.0))?;
        self.push_config_to_services();
        Ok(())
    }

    fn apply_configs(&mut self, configs: &Map<String, Value>) -> Result<Vec<String>, String> {
        let changed = self.store.apply(configs).map_err(|e| e.0)?;
        self.push_config_to_services();
        Ok(changed)
    }

    /// Hands current configuration to the services.
    ///
    /// Safe to call unconditionally: the TFTP service reads its configuration at
    /// `start`, so a running engine is unaffected and the new values take effect
    /// on the next start. There is no cached service instance to evict, which is
    /// what makes "the user's edit silently never took effect" unrepresentable.
    fn push_config_to_services(&mut self) {
        self.tftp.set_config(self.store.tftp().clone());
        self.dhcp.set_config(self.store.dhcp().clone());
    }

    fn ok(id: i64, service: &str) -> Outgoing {
        Outgoing::result(id, json!({ "ok": true, "id": service }))
    }

    fn not_found(id: i64, service: &str) -> Outgoing {
        // The name is echoed, so bound it: it comes from the peer.
        let shown: String = service.chars().take(64).collect();
        Outgoing::error(id, ErrorCode::NotFound, format!("Server '{shown}' not found."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::Emitter;
    use crate::throttle::{self, ThrottleWorker};
    use nexus_rpc::MessageWriter;
    use nexus_tftp::testsupport::TempDir;
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);

    impl Write for Sink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct Harness {
        daemon: Daemon,
        sink: Sink,
        _worker: ThrottleWorker,
    }

    impl Harness {
        fn new() -> Self {
            let sink = Sink::default();
            let writer = Arc::new(MessageWriter::new(Box::new(sink.clone())));
            let (throttle, worker) = throttle::spawn(|_| {}, throttle::WINDOW);
            let emitter = Emitter::new(writer, throttle);
            Self {
                daemon: Daemon::new(emitter),
                sink,
                _worker: worker,
            }
        }

        fn call(&mut self, method: &str, params: &Value) -> Value {
            let line = json!({ "id": 1, "method": method, "params": params }).to_string();
            let request = Request::parse(&line).unwrap();
            serde_json::to_value(self.daemon.handle(&request)).unwrap()
        }

        fn events(&self) -> Vec<Value> {
            String::from_utf8(self.sink.0.lock().unwrap().clone())
                .unwrap()
                .lines()
                .map(|l| serde_json::from_str(l).unwrap())
                .collect()
        }
    }

    #[test]
    fn list_enumerates_both_services_without_starting_anything() {
        let mut h = Harness::new();
        let result = h.call("list", &json!({}));
        let services = result["result"].as_array().unwrap();
        assert_eq!(services.len(), 2);
        assert_eq!(services[0]["id"], json!("tftp"));
        assert_eq!(services[0]["status"], json!("stopped"));
        assert_eq!(services[1]["id"], json!("dhcp"));
        assert_eq!(services[1]["port"], json!(67));
    }

    #[test]
    fn get_status_answers_for_a_known_service_and_refuses_an_unknown_one() {
        let mut h = Harness::new();
        assert_eq!(h.call("getStatus", &json!({"id": "tftp"}))["result"]["id"], json!("tftp"));
        let error = h.call("getStatus", &json!({"id": "ftp"}));
        assert_eq!(error["error"]["code"], json!("NOT_FOUND"));
    }

    #[test]
    fn configure_reports_what_changed_and_is_idempotent() {
        let mut h = Harness::new();
        let first = h.call("configure", &json!({"configs": {"tftp": {"port": 6900}}}));
        assert_eq!(first["result"]["changed"], json!(["tftp"]));
        let second = h.call("configure", &json!({"configs": {"tftp": {"port": 6900}}}));
        assert_eq!(second["result"]["changed"], json!([]));
    }

    #[test]
    fn configuration_is_visible_in_the_snapshot_before_anything_starts() {
        // The whole point of seeding and of `configure` is that the UI shows the
        // port the operator chose rather than the default.
        let mut h = Harness::new();
        h.call("configure", &json!({"configs": {"tftp": {"port": 6900}}}));
        assert_eq!(h.call("getStatus", &json!({"id": "tftp"}))["result"]["port"], json!(6900));
    }

    #[test]
    fn a_bad_configuration_is_refused_with_invalid_params() {
        let mut h = Harness::new();
        let error = h.call(
            "configure",
            &json!({"configs": {"tftp": {"interface": "nope"}}}),
        );
        assert_eq!(error["error"]["code"], json!("INVALID_PARAMS"));
    }

    /// A DHCP configuration that binds an ephemeral loopback port, so the test
    /// never touches the real network and never needs privileges.
    fn loopback_dhcp() -> Value {
        json!({
            "port": 0,
            "bindAddress": "127.0.0.1",
            "rangeStart": "10.0.0.10",
            "rangeEnd": "10.0.0.20",
            "gateway": "10.0.0.1",
            "serverId": "10.0.0.1",
            "broadcast": "127.0.0.1"
        })
    }

    #[test]
    fn dhcp_starts_serves_and_stops_like_any_other_service() {
        let mut h = Harness::new();
        assert_eq!(
            h.call("start", &json!({"id": "dhcp", "config": loopback_dhcp()}))["result"]["ok"],
            json!(true)
        );
        let runtime = h.call("getServiceRuntime", &json!({"id": "dhcp"}));
        assert_eq!(runtime["result"]["snapshot"]["status"], json!("running"));
        assert_eq!(runtime["result"]["poolInfo"]["poolSize"], json!(11));
        let bound = runtime["result"]["boundPort"].as_u64().unwrap();
        assert_ne!(bound, 0, "an ephemeral bind must report the real port");

        assert_eq!(h.call("stop", &json!({"id": "dhcp"}))["result"]["ok"], json!(true));
        assert_eq!(
            h.call("getStatus", &json!({"id": "dhcp"}))["result"]["status"],
            json!("stopped")
        );
        // The socket must really be gone, not merely marked stopped.
        assert!(
            std::net::UdpSocket::bind(("127.0.0.1", u16::try_from(bound).unwrap())).is_ok(),
            "the port was still held after stop"
        );
    }

    #[test]
    fn an_unservable_dhcp_configuration_is_refused_where_it_is_written() {
        // An inverted pool is caught by `configure`, so the operator sees it
        // against the edit that introduced it rather than at the next start.
        let mut h = Harness::new();
        let response = h.call(
            "start",
            &json!({"id": "dhcp", "config": {"port": 0, "bindAddress": "127.0.0.1",
                                             "rangeStart": "10.0.0.20", "rangeEnd": "10.0.0.10"}}),
        );
        assert_eq!(response["error"]["code"], json!("INVALID_PARAMS"));
        // And the rejected value was never stored.
        assert_eq!(
            h.call("getServiceRuntime", &json!({"id": "dhcp"}))["result"]["snapshot"]["status"],
            json!("stopped")
        );
    }

    #[test]
    fn a_dhcp_bind_failure_rejects_and_marks_the_service_in_error() {
        // Reporting `{ok: true}` for a failed start is how a bind failure
        // becomes invisible: the host has nothing to reject on, so the user is
        // told the service started while the sidebar shows an error.
        let held = std::net::UdpSocket::bind(("127.0.0.1", 0)).unwrap();
        let port = held.local_addr().unwrap().port();
        let mut h = Harness::new();
        let mut config = loopback_dhcp();
        config["port"] = json!(port);
        let response = h.call("start", &json!({"id": "dhcp", "config": config}));
        assert_eq!(response["error"]["code"], json!("INTERNAL_ERROR"));
        assert!(
            response["error"]["message"].as_str().unwrap().contains("already in use"),
            "got {}",
            response["error"]["message"]
        );
        assert_eq!(
            h.call("getStatus", &json!({"id": "dhcp"}))["result"]["status"],
            json!("error"),
            "the status the sidebar renders must agree with the answer the caller got"
        );
    }

    #[test]
    fn a_bad_dhcp_configuration_is_refused_with_invalid_params() {
        let mut h = Harness::new();
        for bad in [
            json!({"bindAddress": "nope"}),
            json!({"rangeStart": "192.168.2."}),
            json!({"subnet": "255.0.255.0"}),
            json!({"static": {"aa:bb:cc:dd:ee:ff": "not-an-address"}}),
            json!({"vendorSpecificOptions": [{"subOption": 255, "value": "x"}]}),
            json!({"tftpServerAddresses": ["10.0.0.1", "nope"]}),
        ] {
            let error = h.call("configure", &json!({"configs": {"dhcp": bad}}));
            assert_eq!(
                error["error"]["code"],
                json!("INVALID_PARAMS"),
                "{bad} should have been refused"
            );
        }
    }

    #[test]
    fn dhcp_restart_applies_configuration_a_running_service_had_ignored() {
        let mut h = Harness::new();
        h.call("start", &json!({"id": "dhcp", "config": loopback_dhcp()}));
        let mut narrower = loopback_dhcp();
        narrower["rangeEnd"] = json!("10.0.0.15");
        h.call("configure", &json!({"configs": {"dhcp": narrower}}));
        assert_eq!(
            h.call("getServiceRuntime", &json!({"id": "dhcp"}))["result"]["poolInfo"]["poolSize"],
            json!(11),
            "a configure while running must not disturb the engine"
        );

        assert_eq!(h.call("restart", &json!({"id": "dhcp"}))["result"]["ok"], json!(true));
        assert_eq!(
            h.call("getServiceRuntime", &json!({"id": "dhcp"}))["result"]["poolInfo"]["poolSize"],
            json!(6),
            "the stored edit must take effect on restart"
        );
        h.call("stop", &json!({"id": "dhcp"}));
    }

    #[test]
    fn a_stopped_dhcp_service_still_answers_with_the_shape_the_host_renders() {
        let mut h = Harness::new();
        // Stopping something that was never started is success, not an error.
        assert_eq!(h.call("stop", &json!({"id": "dhcp"}))["result"]["ok"], json!(true));
        let runtime = h.call("getServiceRuntime", &json!({"id": "dhcp"}));
        assert_eq!(runtime["result"]["leases"], json!([]));
        assert_eq!(runtime["result"]["boundPort"], Value::Null);
        assert_eq!(runtime["result"]["packetCounters"]["discoverCount"], json!(0));
    }

    #[test]
    fn an_unknown_method_is_reported_as_such() {
        let mut h = Harness::new();
        assert_eq!(
            h.call("teleport", &json!({}))["error"]["code"],
            json!("METHOD_NOT_FOUND")
        );
    }

    #[test]
    fn a_missing_id_parameter_is_invalid_params_not_a_panic() {
        let mut h = Harness::new();
        for method in ["getStatus", "start", "stop", "restart", "cancelTransfer", "getServiceRuntime"] {
            let response = h.call(method, &json!({}));
            assert_eq!(
                response["error"]["code"],
                json!("INVALID_PARAMS"),
                "{method} mishandled a missing id"
            );
        }
    }

    #[test]
    fn cancel_transfer_is_refused_for_services_that_have_no_transfers() {
        let mut h = Harness::new();
        let error = h.call("cancelTransfer", &json!({"id": "dhcp", "transferId": "x"}));
        assert_eq!(error["error"]["code"], json!("NOT_FOUND"));
    }

    #[test]
    fn cancelling_a_transfer_that_never_existed_is_a_false_not_an_error() {
        // The operator clicking Cancel as the last block lands is a race, not a
        // failure — and it must not lazily bring a stopped service into being.
        let mut h = Harness::new();
        let result = h.call(
            "cancelTransfer",
            &json!({"id": "tftp", "transferId": "10.0.0.1:9"}),
        );
        assert_eq!(result["result"]["ok"], json!(false));
        assert_eq!(h.call("getStatus", &json!({"id": "tftp"}))["result"]["status"], json!("stopped"));
    }

    #[test]
    fn a_start_failure_is_an_error_response_not_a_success() {
        // Reporting `{ok: true}` for a failed start is how a bind failure once
        // became invisible: the host had nothing to reject on, so the user was
        // told the service had started while the sidebar showed an error.
        let temp = TempDir::new("daemon-badroot");
        let missing = temp.path().join("no-such-directory");
        let mut h = Harness::new();
        let response = h.call(
            "start",
            &json!({"id": "tftp", "config": {"root": missing.to_string_lossy(), "port": 0, "interface": "127.0.0.1"}}),
        );
        assert_eq!(response["error"]["code"], json!("INTERNAL_ERROR"));
        assert!(
            response["error"]["message"].as_str().unwrap().contains("does not exist"),
            "got {}", response["error"]["message"]
        );
        assert_eq!(
            h.call("getStatus", &json!({"id": "tftp"}))["result"]["status"],
            json!("error")
        );
    }

    #[test]
    fn a_real_start_stop_cycle_reports_the_bound_port_and_releases_it() {
        let temp = TempDir::new("daemon-cycle");
        let mut h = Harness::new();
        let root = temp.path().to_string_lossy().into_owned();
        let started = h.call(
            "start",
            &json!({"id": "tftp", "config": {"root": root, "port": 0, "interface": "127.0.0.1", "allowWrite": true}}),
        );
        assert_eq!(started["result"]["ok"], json!(true));

        let runtime = h.call("getServiceRuntime", &json!({"id": "tftp"}));
        let bound = runtime["result"]["boundPort"].as_u64().unwrap();
        assert_ne!(bound, 0, "an ephemeral bind must report the real port");
        assert_eq!(runtime["result"]["allowWrite"], json!(true));
        assert_eq!(runtime["result"]["transfers"], json!([]));
        assert_eq!(runtime["result"]["snapshot"]["status"], json!("running"));

        assert_eq!(h.call("stop", &json!({"id": "tftp"}))["result"]["ok"], json!(true));
        assert_eq!(
            h.call("getStatus", &json!({"id": "tftp"}))["result"]["status"],
            json!("stopped")
        );
        // The socket must really be gone, not merely marked stopped.
        assert!(
            std::net::UdpSocket::bind(("127.0.0.1", u16::try_from(bound).unwrap())).is_ok(),
            "the port was still held after stop"
        );
    }

    #[test]
    fn starting_an_already_running_service_is_idempotent() {
        let temp = TempDir::new("daemon-idempotent");
        let mut h = Harness::new();
        let config = json!({"root": temp.path().to_string_lossy(), "port": 0, "interface": "127.0.0.1"});
        assert_eq!(
            h.call("start", &json!({"id": "tftp", "config": config}))["result"]["ok"],
            json!(true)
        );
        assert_eq!(
            h.call("start", &json!({"id": "tftp"}))["result"]["ok"],
            json!(true),
            "a second start must not fail on its own socket"
        );
        h.call("stop", &json!({"id": "tftp"}));
    }

    #[test]
    fn restart_applies_new_configuration_that_a_running_service_had_ignored() {
        // The ordering rule: stop, then apply, then start. Applying first leaves
        // the running engine in place and restarts it with the settings it
        // already had — the user's edit silently never takes effect.
        let temp = TempDir::new("daemon-restart");
        let mut h = Harness::new();
        let root = temp.path().to_string_lossy().into_owned();
        h.call(
            "start",
            &json!({"id": "tftp", "config": {"root": root.clone(), "port": 0, "interface": "127.0.0.1", "allowWrite": false}}),
        );
        // A `configure` while running is stored but must not disturb the engine.
        h.call(
            "configure",
            &json!({"configs": {"tftp": {"root": root, "port": 0, "interface": "127.0.0.1", "allowWrite": true}}}),
        );
        let before = h.call("getServiceRuntime", &json!({"id": "tftp"}));
        assert_eq!(before["result"]["snapshot"]["status"], json!("running"));

        assert_eq!(
            h.call("restart", &json!({"id": "tftp"}))["result"]["ok"],
            json!(true)
        );
        let after = h.call("getServiceRuntime", &json!({"id": "tftp"}));
        assert_eq!(
            after["result"]["allowWrite"],
            json!(true),
            "the stored edit must take effect on restart"
        );
        h.call("stop", &json!({"id": "tftp"}));
    }

    #[test]
    fn every_lifecycle_transition_is_announced() {
        let temp = TempDir::new("daemon-events");
        let mut h = Harness::new();
        h.call(
            "start",
            &json!({"id": "tftp", "config": {"root": temp.path().to_string_lossy(), "port": 0, "interface": "127.0.0.1"}}),
        );
        h.call("stop", &json!({"id": "tftp"}));
        let statuses: Vec<String> = h
            .events()
            .iter()
            .filter(|e| e["event"] == json!("statusChange"))
            .map(|e| e["data"]["status"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            statuses,
            vec!["starting", "running", "stopping", "stopped"],
            "the host derives its view from these, not from RPC results"
        );
    }
}
