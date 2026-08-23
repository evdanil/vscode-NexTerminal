//! Minimal test scaffolding shared by this crate's unit tests, its integration
//! tests and the daemon's.
//!
//! Same reasoning as the TFTP crate's equivalent: the workspace deliberately
//! carries no third-party crates beyond `serde`, so a temp directory and a
//! packet builder are written here rather than pulled in.

#![doc(hidden)]

use std::io;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::constants::{HTYPE_ETHERNET, OPTION_END, OPTION_MESSAGE_TYPE, OP_BOOTREQUEST};
use crate::protocol::{FIXED_HEADER_LEN, MAGIC_COOKIE, MAX_HARDWARE_LEN};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A uniquely-named temporary directory, removed when dropped.
#[derive(Debug)]
pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    #[must_use]
    #[allow(
        clippy::needless_continue,
        reason = "reads as 'that name was taken, try the next one'"
    )]
    pub fn new(prefix: &str) -> Self {
        let base = std::env::temp_dir();
        for _ in 0..64 {
            let nonce = COUNTER.fetch_add(1, Ordering::Relaxed);
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let candidate = base.join(format!(
                "nexus-{prefix}-{}-{nonce}-{stamp}",
                std::process::id()
            ));
            match std::fs::create_dir(&candidate) {
                Ok(()) => return Self { path: candidate },
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => panic!("cannot create temp dir under {}: {e}", base.display()),
            }
        }
        panic!("exhausted temp directory name attempts");
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Assembles a BOOTREQUEST byte by byte.
///
/// Deliberately *not* built on top of the encoder under test: a builder that
/// shared the encoder's idea of the layout could not catch the encoder being
/// wrong about it. Every offset here is written out from RFC 2131 §2.
#[derive(Debug, Clone)]
pub struct PacketBuilder {
    chaddr: Vec<u8>,
    xid: u32,
    flags: u16,
    ciaddr: Ipv4Addr,
    giaddr: Ipv4Addr,
    options: Vec<u8>,
}

impl PacketBuilder {
    #[must_use]
    pub fn new(chaddr: &[u8]) -> Self {
        Self {
            chaddr: chaddr.to_vec(),
            xid: 0x1234_5678,
            flags: 0,
            ciaddr: Ipv4Addr::UNSPECIFIED,
            giaddr: Ipv4Addr::UNSPECIFIED,
            options: Vec::new(),
        }
    }

    /// The relay-agent address a client claims forwarded its request.
    #[must_use]
    pub fn giaddr(mut self, giaddr: Ipv4Addr) -> Self {
        self.giaddr = giaddr;
        self
    }

    #[must_use]
    pub fn xid(mut self, xid: u32) -> Self {
        self.xid = xid;
        self
    }

    #[must_use]
    pub fn flags(mut self, flags: u16) -> Self {
        self.flags = flags;
        self
    }

    #[must_use]
    pub fn ciaddr(mut self, address: Ipv4Addr) -> Self {
        self.ciaddr = address;
        self
    }

    /// Sets option 53.
    #[must_use]
    pub fn message_type(self, code: u8) -> Self {
        self.option(OPTION_MESSAGE_TYPE, &[code])
    }

    /// Appends `[code][len][value…]`.
    ///
    /// The length is taken from `value`, so a test that wants a *lying* length
    /// byte writes it by hand — which is exactly what the truncation tests do.
    #[must_use]
    pub fn option(mut self, code: u8, value: &[u8]) -> Self {
        self.options.push(code);
        self.options.push(u8::try_from(value.len()).expect("test option fits in a length byte"));
        self.options.extend_from_slice(value);
        self
    }

    /// Appends raw bytes to the option region, bypassing every check.
    #[must_use]
    pub fn raw_option_bytes(mut self, bytes: &[u8]) -> Self {
        self.options.extend_from_slice(bytes);
        self
    }

    #[must_use]
    pub fn build(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(300);
        out.push(OP_BOOTREQUEST);
        out.push(HTYPE_ETHERNET);
        out.push(u8::try_from(self.chaddr.len()).unwrap_or(0));
        out.push(0); // hops
        out.extend_from_slice(&self.xid.to_be_bytes());
        out.extend_from_slice(&0u16.to_be_bytes()); // secs
        out.extend_from_slice(&self.flags.to_be_bytes());
        out.extend_from_slice(&self.ciaddr.octets());
        out.extend_from_slice(&[0u8; 4]); // yiaddr
        out.extend_from_slice(&[0u8; 4]); // siaddr
        out.extend_from_slice(&self.giaddr.octets());
        let mut hardware = [0u8; MAX_HARDWARE_LEN];
        for (slot, byte) in hardware.iter_mut().zip(self.chaddr.iter()) {
            *slot = *byte;
        }
        out.extend_from_slice(&hardware);
        out.extend_from_slice(&[0u8; 64]); // sname
        out.extend_from_slice(&[0u8; 128]); // file
        debug_assert_eq!(out.len(), FIXED_HEADER_LEN);
        out.extend_from_slice(&MAGIC_COOKIE);
        out.extend_from_slice(&self.options);
        out.push(OPTION_END);
        if out.len() < 300 {
            out.resize(300, 0);
        }
        out
    }
}
