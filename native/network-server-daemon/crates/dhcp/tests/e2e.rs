//! End-to-end tests: a real UDP socket, real DHCP packets, a real lease file.
//!
//! Everything the unit tests drive through a recorder is driven here through the
//! engine's own socket loop instead, because the seam between "the core handles
//! this correctly" and "the thread that owns the socket actually gets there" is
//! exactly where a service can pass every unit test and serve nothing.
//!
//! Only the network is scoped down: loopback, an ephemeral port, an
//! eleven-address pool. Nothing here reaches a real LAN.
//!
//! # Reading replies
//!
//! A DHCP client listens on port 68, and that is where a server sends. Port 68
//! is privileged on Unix, so the tests that need to *read* a reply bind it and
//! skip with a message when the platform refuses — an all-green run on a machine
//! that skipped them must not read as one that exercised them. The tests that
//! only need to observe *effects* use the engine's own runtime snapshot and
//! always run.

use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::Path;
use std::time::{Duration, Instant};

use nexus_dhcp::constants::{CLIENT_PORT, OPTION_REQUESTED_IP, OPTION_SERVER_ID};
use nexus_dhcp::engine::{Engine, EngineOptions, RuntimeSnapshot};
use nexus_dhcp::lease::LeaseInfo;
use nexus_dhcp::persistence;
use nexus_dhcp::protocol::{Message, MessageType};
use nexus_dhcp::testsupport::{PacketBuilder, TempDir};

const MAC_A: [u8; 6] = [0xAA, 0x00, 0x00, 0x00, 0x00, 0x0A];
const MAC_B: [u8; 6] = [0xBB, 0x00, 0x00, 0x00, 0x00, 0x0B];

fn ip(text: &str) -> Ipv4Addr {
    text.parse().expect("test address parses")
}

fn options(lease_store: Option<&Path>) -> EngineOptions {
    EngineOptions {
        address: IpAddr::V4(Ipv4Addr::LOCALHOST),
        port: 0,
        range_start: ip("10.0.0.10"),
        range_end: ip("10.0.0.20"),
        subnet: ip("255.255.255.0"),
        gateway: ip("10.0.0.1"),
        dns: vec![ip("10.0.0.1")],
        lease_secs: 3600,
        server_id: ip("10.0.0.1"),
        // Replies go to loopback rather than a subnet broadcast, so nothing
        // these tests do reaches the real network.
        broadcast: Ipv4Addr::LOCALHOST,
        lease_store_path: lease_store.map(Path::to_path_buf),
        ..EngineOptions::default()
    }
}

fn start(options: &EngineOptions) -> Engine {
    Engine::start(options, Box::new(|_| {})).expect("the engine binds an ephemeral loopback port")
}

/// A client socket on some ephemeral port — enough to *send*.
fn sender() -> UdpSocket {
    UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).expect("an ephemeral client port")
}

/// A client socket on port 68, or `None` when the platform refuses it.
fn client_on_dhcp_port() -> Option<UdpSocket> {
    match UdpSocket::bind((Ipv4Addr::LOCALHOST, CLIENT_PORT)) {
        Ok(socket) => {
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("a read timeout can be set");
            Some(socket)
        }
        Err(e) => {
            eprintln!(
                "SKIPPED reply-reading test: cannot bind UDP {CLIENT_PORT} on loopback ({e}). \
                 On Unix this port is privileged."
            );
            None
        }
    }
}

fn send(socket: &UdpSocket, packet: &[u8], port: u16) {
    socket
        .send_to(packet, SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port))
        .expect("the datagram is sent");
}

/// Reads the next reply addressed to *this* exchange.
///
/// Every engine in this binary broadcasts to loopback port 68, and only one test
/// can hold that port at a time — so the one that does receives the replies of
/// every engine running concurrently beside it. Matching on the transaction id
/// and the hardware address is what a real client does for the same reason, and
/// it is what keeps these tests from reading each other's mail.
fn recv_for(socket: &UdpSocket, mac: &[u8], xid: u32) -> io::Result<Message> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut buffer = [0u8; 2048];
    while Instant::now() < deadline {
        let (len, _) = socket.recv_from(&mut buffer)?;
        let Ok(message) = Message::decode(&buffer[..len]) else {
            continue;
        };
        if message.xid == xid && message.chaddr == mac {
            return Ok(message);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "no reply for this exchange arrived within five seconds",
    ))
}

fn discover(mac: &[u8]) -> Vec<u8> {
    discover_with(mac, 0x1234)
}

fn discover_with(mac: &[u8], xid: u32) -> Vec<u8> {
    PacketBuilder::new(mac).xid(xid).message_type(1).build()
}

fn request(mac: &[u8], wanted: Ipv4Addr, server: Ipv4Addr) -> Vec<u8> {
    request_with(mac, 0x1234, wanted, server)
}

fn request_with(mac: &[u8], xid: u32, wanted: Ipv4Addr, server: Ipv4Addr) -> Vec<u8> {
    PacketBuilder::new(mac)
        .xid(xid)
        .message_type(3)
        .option(OPTION_REQUESTED_IP, &wanted.octets())
        .option(OPTION_SERVER_ID, &server.octets())
        .build()
}

/// Waits until the engine's lease table satisfies `predicate`.
fn await_runtime(
    engine: &Engine,
    what: &str,
    predicate: impl Fn(&RuntimeSnapshot) -> bool,
) -> RuntimeSnapshot {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut last = None;
    while Instant::now() < deadline {
        if let Some(runtime) = engine.runtime() {
            if predicate(&runtime) {
                return runtime;
            }
            last = Some(runtime);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("timed out waiting for {what}; last seen: {last:?}");
}

/// Waits until the engine's lease table satisfies `predicate`.
fn await_leases(
    engine: &Engine,
    what: &str,
    predicate: impl Fn(&[LeaseInfo]) -> bool,
) -> Vec<LeaseInfo> {
    await_runtime(engine, what, |runtime| predicate(&runtime.leases)).leases
}

#[test]
fn a_discover_over_a_real_socket_produces_an_offer_on_the_wire() {
    const MAC: [u8; 6] = [0xAA, 0x11, 0x11, 0x11, 0x11, 0x11];
    const XID: u32 = 0x0E2E_0001;
    let Some(client) = client_on_dhcp_port() else {
        return;
    };
    let engine = start(&options(None));
    send(&client, &discover_with(&MAC, XID), engine.bound_port());

    let offer = recv_for(&client, &MAC, XID).expect("the server answers a DISCOVER");
    assert_eq!(offer.options.message_type(), Some(MessageType::Offer));
    assert_eq!(offer.yiaddr, ip("10.0.0.10"));
    assert_eq!(offer.chaddr, MAC.to_vec());
    assert_eq!(
        offer.options.ipv4(OPTION_SERVER_ID),
        Some(ip("10.0.0.1")),
        "a client picks its server by this option"
    );
}

#[test]
fn a_full_dora_exchange_completes_over_the_wire() {
    const MAC: [u8; 6] = [0xAA, 0x22, 0x22, 0x22, 0x22, 0x22];
    const XID: u32 = 0x0E2E_0002;
    let Some(client) = client_on_dhcp_port() else {
        return;
    };
    let engine = start(&options(None));
    let port = engine.bound_port();

    send(&client, &discover_with(&MAC, XID), port);
    let offer = recv_for(&client, &MAC, XID).expect("an OFFER arrives");
    assert_eq!(offer.options.message_type(), Some(MessageType::Offer));

    send(&client, &request_with(&MAC, XID, offer.yiaddr, ip("10.0.0.1")), port);
    let ack = recv_for(&client, &MAC, XID).expect("an ACK arrives");
    assert_eq!(ack.options.message_type(), Some(MessageType::Ack));
    assert_eq!(ack.yiaddr, offer.yiaddr);
    assert_eq!(
        ack.options.u32(nexus_dhcp::constants::OPTION_LEASE_TIME),
        Some(3600),
        "the client learns how long it may keep the address"
    );

    let leases = await_leases(&engine, "the lease to bind", |l| {
        l.iter().any(|lease| lease.ip == offer.yiaddr && lease.bound_at > 0)
    });
    assert_eq!(leases.len(), 1);
}

#[test]
fn two_clients_over_a_real_socket_never_get_the_same_address() {
    // The failure this whole service exists to avoid.
    let engine = start(&options(None));
    let port = engine.bound_port();
    let client = sender();
    send(&client, &discover(&MAC_A), port);
    send(&client, &discover(&MAC_B), port);

    let leases = await_leases(&engine, "two offers", |l| l.len() == 2);
    let mut addresses: Vec<Ipv4Addr> = leases.iter().map(|l| l.ip).collect();
    addresses.sort_unstable();
    addresses.dedup();
    assert_eq!(addresses.len(), 2, "two clients, two addresses: {leases:?}");
}

#[test]
fn a_lease_survives_a_restart_and_stays_out_of_the_pool() {
    // A device takes a lease, the daemon dies, and a second device asks for an
    // address before the first one's lease has expired.
    let dir = TempDir::new("dhcp-e2e-restart");
    let store = dir.path().join("dhcp-leases.json");
    let client = sender();

    let leased = {
        let mut engine = start(&options(Some(&store)));
        let port = engine.bound_port();
        send(&client, &discover(&MAC_A), port);
        let offered = await_leases(&engine, "an offer", |l| !l.is_empty())[0].ip;
        send(&client, &request(&MAC_A, offered, ip("10.0.0.1")), port);
        await_runtime(&engine, "the bind", |runtime| {
            runtime.counters.request_count >= 1
                && runtime.counters.ack_count >= 1
                && runtime.leases.iter().any(|lease| {
                    lease.ip == offered && lease.mac.as_str() == "AA-00-00-00-00-0A"
                })
        });
        engine.stop();
        offered
    };

    let persisted = persistence::load_leases(&store);
    assert_eq!(persisted.len(), 1, "stopping must flush the lease table to disk");
    assert_eq!(persisted[0].ip, leased);

    let engine = start(&options(Some(&store)));
    let port = engine.bound_port();
    let restored = engine.runtime().expect("the restarted engine answers").leases;
    assert_eq!(restored.len(), 1, "it must come up knowing the lease");
    assert_eq!(
        restored[0].bound_at, persisted[0].bound_at,
        "the original bind time survives, not a fresh one"
    );

    // The payoff.
    send(&client, &discover(&MAC_B), port);
    let leases = await_leases(&engine, "the second client's offer", |l| l.len() == 2);
    let second = leases
        .iter()
        .find(|l| l.mac.as_str() != restored[0].mac.as_str())
        .expect("the second client is in the table");
    assert_ne!(
        second.ip, leased,
        "a restored lease must keep its address out of the free pool"
    );
}

#[test]
fn a_reserved_address_is_held_before_its_device_has_ever_spoken() {
    let mut o = options(None);
    o.statics = nexus_dhcp::net::normalize_static_map([("aa:00:00:00:00:0a", ip("10.0.0.10"))]);
    let engine = start(&o);
    let client = sender();

    // Another client asks first. Without seeding it walks away with 10.0.0.10.
    send(&client, &discover(&MAC_B), engine.bound_port());
    let leases = await_leases(&engine, "the other client's offer", |l| !l.is_empty());
    assert_ne!(leases[0].ip, ip("10.0.0.10"), "the reservation must already be held");

    send(&client, &discover(&MAC_A), engine.bound_port());
    let leases = await_leases(&engine, "the reserved device's offer", |l| l.len() == 2);
    let reserved = leases
        .iter()
        .find(|l| l.mac.as_str() == "AA-00-00-00-00-0A")
        .expect("the reserved device is in the table");
    assert_eq!(reserved.ip, ip("10.0.0.10"));
}

#[test]
fn a_flood_of_malformed_datagrams_leaves_the_service_answering() {
    // The property that matters most for an unauthenticated LAN listener: a
    // parser failure must not take the socket loop down with it.
    let engine = start(&options(None));
    let port = engine.bound_port();
    let client = sender();

    let mut seed = 0x9E37_79B9u32;
    for size in [1usize, 8, 60, 239, 240, 241, 512, 1500] {
        for _ in 0..40 {
            let mut buf = vec![0u8; size];
            for byte in &mut buf {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                *byte = (seed & 0xFF) as u8;
            }
            send(&client, &buf, port);
        }
    }
    // Deliberate truncated-option packets: a length byte that promises more
    // than the datagram carries.
    for declared in [1u8, 4, 16, 200, 255] {
        let packet = PacketBuilder::new(&MAC_A)
            .message_type(1)
            .raw_option_bytes(&[OPTION_REQUESTED_IP, declared])
            .build();
        let cut = packet.iter().rposition(|b| *b == 255).unwrap_or(packet.len());
        send(&client, &packet[..cut], port);
    }

    // And now a legitimate client, after all of that.
    send(&client, &discover(&MAC_A), port);
    let leases = await_leases(&engine, "the service to still be serving", |l| !l.is_empty());
    assert_eq!(leases[0].ip, ip("10.0.0.10"));

    let counters = engine.runtime().expect("the loop is alive").counters;
    assert!(counters.malformed_count >= 320, "got {}", counters.malformed_count);
    assert_eq!(counters.discover_count, 1);
}

#[test]
fn stopping_releases_the_port() {
    let mut engine = start(&options(None));
    let port = engine.bound_port();
    engine.stop();
    assert!(
        UdpSocket::bind((Ipv4Addr::LOCALHOST, port)).is_ok(),
        "the port was still held after stop"
    );
}
