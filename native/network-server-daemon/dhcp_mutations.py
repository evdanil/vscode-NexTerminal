"""DHCP mutations for the audit in `mutation-audit.py`.

Kept in its own module so the TFTP list stays readable; `mutation-audit.py`
imports and appends it. Every entry is (name, file, original, replacement) with
an optional fifth element documenting why a mutation is expected to survive.
"""

MUTATIONS = [
    # -- the headline property: bounds before the read ----------------------
    ("dhcp codec: an option length is trusted and the value read leniently",
     "crates/dhcp/src/protocol.rs",
     "        let available = reader.remaining();\n"
     "        if declared > available {\n"
     "            return Err(DecodeError::OptionTruncated { code, declared, available });\n"
     "        }\n"
     "        let value = reader.take(declared, \"option value\")?;",
     "        let available = reader.remaining();\n"
     "        let value = reader.take(declared.min(available), \"option value\")?;"),

    ("dhcp codec: the reader slices directly instead of checking first",
     "crates/dhcp/src/protocol.rs",
     "        let available = self.remaining();\n"
     "        if n > available {\n"
     "            return Err(DecodeError::TooShort { field, needed: n, available });\n"
     "        }\n"
     "        // Both bounds are already proven in range by the check above, so this\n"
     "        // slice cannot panic — but it is still expressed with `get` so that a\n"
     "        // future edit to the arithmetic above degrades to an error rather than\n"
     "        // to a panic.\n"
     "        let end = self.pos + n;\n"
     "        let slice = self\n"
     "            .buf\n"
     "            .get(self.pos..end)\n"
     "            .ok_or(DecodeError::TooShort { field, needed: n, available })?;",
     "        let available = self.remaining();\n"
     "        let end = self.pos + n;\n"
     "        let slice = &self.buf[self.pos..end];\n"
     "        let _ = available;"),

    ("dhcp codec: hlen is used without being bounded",
     "crates/dhcp/src/protocol.rs",
     "        if hlen == 0 || hardware_len > MAX_HARDWARE_LEN {\n"
     "            return Err(DecodeError::BadHardwareLength(hlen));\n"
     "        }\n",
     ""),

    ("dhcp codec: a numeric option is read from a value of the wrong length",
     "crates/dhcp/src/protocol.rs",
     "        match self.get(code) {\n"
     "            Some([a, b, c, d]) => Some(u32::from_be_bytes([*a, *b, *c, *d])),\n"
     "            _ => None,\n"
     "        }",
     "        match self.get(code) {\n"
     "            Some(v) if v.len() >= 4 => Some(u32::from_be_bytes([v[0], v[1], v[2], v[3]])),\n"
     "            _ => None,\n"
     "        }"),

    ("dhcp codec: a split option is last-write-wins instead of concatenated",
     "crates/dhcp/src/protocol.rs",
     "        self.0.entry(code).or_default().extend_from_slice(value);",
     "        self.0.insert(code, value.to_vec());"),

    ("dhcp codec: an oversized option value is truncated instead of refused",
     "crates/dhcp/src/protocol.rs",
     "        if value.len() > MAX_OPTION_VALUE_BYTES {\n"
     "            return Err(EncodeError::OptionTooLong { code, len: value.len() });\n"
     "        }\n"
     "        self.buf.push(code);\n"
     "        // Proven to fit by the check above.\n"
     "        self.buf.push(value.len() as u8);\n"
     "        self.buf.extend_from_slice(value);",
     "        let value = &value[..value.len().min(MAX_OPTION_VALUE_BYTES)];\n"
     "        self.buf.push(code);\n"
     "        self.buf.push(value.len() as u8);\n"
     "        self.buf.extend_from_slice(value);"),

    ("dhcp codec: an address list is clipped instead of refused",
     "crates/dhcp/src/protocol.rs",
     "        if values.len() * 4 > MAX_OPTION_VALUE_BYTES {\n"
     "            return Err(EncodeError::TooManyAddresses { code, count: values.len() });\n"
     "        }\n",
     "        let values = &values[..values.len().min(MAX_OPTION_VALUE_BYTES / 4)];\n"),

    ("dhcp codec: replies are not padded to the BOOTP minimum",
     "crates/dhcp/src/protocol.rs",
     "        if out.len() < MIN_REPLY_LEN {\n            out.resize(MIN_REPLY_LEN, 0);\n        }",
     ""),

    ("dhcp codec: client text is echoed with its control characters",
     "crates/dhcp/src/protocol.rs",
     "    text.chars()\n"
     "        .take(MAX_ECHOED_TEXT)\n"
     "        .map(|c| if c.is_control() { '\\u{fffd}' } else { c })\n"
     "        .collect()",
     "    text.chars().collect()"),

    # -- boot options -------------------------------------------------------
    ("dhcp boot: a reserved option 43 sub-option code is accepted",
     "crates/dhcp/src/boot.rs",
     "        if !is_valid_sub_option_code(entry.sub_option) {\n"
     "            return Err(BootOptionError::InvalidSubOptionCode(entry.sub_option));\n"
     "        }\n",
     ""),

    ("dhcp boot: an option 43 payload over 255 bytes is served anyway",
     "crates/dhcp/src/boot.rs",
     "    if encoded.len() > MAX_OPTION_VALUE_BYTES {\n"
     "        return Err(BootOptionError::PayloadTooLong(encoded.len()));\n"
     "    }\n",
     ""),

    ("dhcp boot: an odd hex literal silently drops half a byte",
     "crates/dhcp/src/boot.rs",
     "    if digits.len() % 2 == 1 {\n"
     "        return Err(BootOptionError::OddHexDigits {\n"
     "            raw: raw.to_owned(),\n"
     "            digits: digits.len(),\n"
     "        });\n"
     "    }\n",
     ""),

    ("dhcp boot: the vendor-class gate serves every client",
     "crates/dhcp/src/boot.rs",
     "        if !matches_vendor_class(self.vendor_class_id.as_deref(), observed_vendor_class) {\n"
     "            return Ok(false);\n"
     "        }\n",
     ""),

    ("dhcp boot: a vendor class matches on prefix instead of exactly",
     "crates/dhcp/src/boot.rs",
     "    observed.trim().eq_ignore_ascii_case(expected)",
     "    observed.trim().to_lowercase().starts_with(&expected.to_lowercase())"),

    # -- the MAC key --------------------------------------------------------
    ("dhcp keys: a MAC is stored as typed instead of canonicalised",
     "crates/dhcp/src/net.rs",
     "        let hex: String = raw.chars().filter(char::is_ascii_hexdigit).collect();\n"
     "        if hex.len() != 12 {\n"
     "            return Self(raw.trim().to_uppercase());\n"
     "        }",
     "        let hex: String = raw.chars().filter(char::is_ascii_hexdigit).collect();\n"
     "        if hex.len() != 12 || true {\n"
     "            return Self(raw.trim().to_uppercase());\n"
     "        }"),

    ("dhcp pool: pool size computed with a signed comparison",
     "crates/dhcp/src/net.rs",
     "    let first = u32::from(start);\n    let last = u32::from(end);\n    if last < first {\n        return 0;\n    }",
     "    let first = u32::from(start) as i32;\n"
     "    let last = u32::from(end) as i32;\n"
     "    if last < first {\n        return 0;\n    }\n"
     "    let first = first as u32;\n    let last = last as u32;"),

    ("dhcp pool: the broadcast address is the packaged default again",
     "crates/dhcp/src/net.rs",
     "    Ipv4Addr::from((g & m) | !m)",
     "    crate::constants::DEFAULT_BROADCAST"),

    # -- the lease table ----------------------------------------------------
    ("dhcp leases: static reservations are never seeded",
     "crates/dhcp/src/lease.rs",
     "            self.entries.insert(\n"
     "                mac.clone(),\n"
     "                LeaseEntry {\n"
     "                    address: *address,\n"
     "                    state: LeaseState::Reserved,",
     "            report.seeded.push((mac.clone(), *address));\n"
     "            #[allow(unreachable_code)]\n"
     "            if true { continue; }\n"
     "            self.entries.insert(\n"
     "                mac.clone(),\n"
     "                LeaseEntry {\n"
     "                    address: *address,\n"
     "                    state: LeaseState::Reserved,"),

    ("dhcp leases: seeding clobbers an entry already on its reserved address",
     "crates/dhcp/src/lease.rs",
     "            if self.entries.get(mac).is_some_and(|e| e.address == *address) {\n                continue;\n            }\n",
     ""),

    ("dhcp leases: a lease never expires while the server runs",
     "crates/dhcp/src/lease.rs",
     "        self.state == LeaseState::Reserved || self.expires_at_ms > now_ms",
     "        let _ = now_ms;\n        true"),

    ("dhcp leases: an unclaimed offer is persisted as if it were a lease",
     "crates/dhcp/src/lease.rs",
     "            .filter(|(_, entry)| entry.state == LeaseState::Bound && entry.is_live(now_ms))",
     "            .filter(|(_, entry)| entry.state != LeaseState::Reserved && entry.is_live(now_ms))"),

    ("dhcp leases: a reservation placeholder counts as an active lease",
     "crates/dhcp/src/lease.rs",
     "            .filter(|(_, entry)| entry.state != LeaseState::Reserved && entry.is_live(now_ms))\n"
     "            .map(|(mac, entry)| self.info_for(mac, entry, now_ms))\n"
     "            .collect()\n"
     "    }\n"
     "\n"
     "    /// The subset worth writing to disk.",
     "            .filter(|(_, entry)| entry.is_live(now_ms))\n"
     "            .map(|(mac, entry)| self.info_for(mac, entry, now_ms))\n"
     "            .collect()\n"
     "    }\n"
     "\n"
     "    /// The subset worth writing to disk."),

    ("dhcp leases: a declined address goes straight back into the pool",
     "crates/dhcp/src/lease.rs",
     "        if is_ip_in_pool(address, self.range_start, self.range_end) {\n"
     "            self.quarantine\n"
     "                .insert(address, now_ms + u64::from(self.quarantine_secs) * 1000);\n"
     "        }",
     "        let _ = now_ms;"),

    ("dhcp leases: a renewal resets the original bind time",
     "crates/dhcp/src/lease.rs",
     "        let bound_at_ms = if already_bound {\n"
     "            previous.and_then(|e| e.bound_at_ms).unwrap_or(now_ms)\n"
     "        } else {\n"
     "            now_ms\n"
     "        };",
     "        let bound_at_ms = now_ms;"),

    ("dhcp leases: a DISCOVER from a bound client cuts its lease to an offer window",
     "crates/dhcp/src/lease.rs",
     "        let expires_at_ms = match previous {\n"
     "            Some(entry) if entry.state == LeaseState::Bound && entry.address == address => {\n"
     "                entry.expires_at_ms.max(now_ms + u64::from(self.offer_secs) * 1000)\n"
     "            }\n"
     "            _ => now_ms + u64::from(self.offer_secs) * 1000,\n"
     "        };",
     "        let expires_at_ms = now_ms + u64::from(self.offer_secs) * 1000;"),

    ("dhcp leases: a requested address in use by someone else is granted",
     "crates/dhcp/src/lease.rs",
     "            if is_ip_in_pool(wanted, self.range_start, self.range_end)\n"
     "                && !self.is_taken_by_other(wanted, mac, now_ms)\n"
     "            {",
     "            if is_ip_in_pool(wanted, self.range_start, self.range_end) {"),

    # -- persistence --------------------------------------------------------
    ("dhcp persistence: the lease file is written straight at its target",
     "crates/dhcp/src/persistence.rs",
     "    let temp = temp_path(path);\n"
     "    // The temp file is written, flushed and closed before the rename, so the\n"
     "    // rename can only ever publish complete content.\n"
     "    {\n"
     "        let mut file = fs::File::create(&temp)?;\n"
     "        file.write_all(text.as_bytes())?;\n"
     "        file.sync_all()?;\n"
     "    }\n"
     "    match fs::rename(&temp, path) {\n"
     "        Ok(()) => Ok(()),\n"
     "        Err(error) => {\n"
     "            // Leaving the temp file behind would accumulate one orphan per\n"
     "            // failed write, in the directory the next read scans.\n"
     "            let _ = fs::remove_file(&temp);\n"
     "            Err(error)\n"
     "        }\n"
     "    }",
     "    let mut file = fs::File::create(path)?;\n"
     "    file.write_all(text.as_bytes())?;\n"
     "    Ok(())"),

    ("dhcp persistence: an expired lease is restored anyway",
     "crates/dhcp/src/persistence.rs",
     "        if lease.expires_at <= context.now_ms {\n"
     "            result.dropped.push(DroppedLease { lease: lease.clone(), reason: DropReason::Expired });\n"
     "            continue;\n"
     "        }\n",
     ""),

    ("dhcp persistence: a lease contradicting a reservation is restored anyway",
     "crates/dhcp/src/persistence.rs",
     "        if let Some(reserved) = context.statics.get(&lease.mac) {\n"
     "            if *reserved == lease.ip {\n"
     "                result.restored.push(LeaseInfo { lease_type: LeaseType::Static, ..lease.clone() });\n"
     "            } else {\n"
     "                result.dropped.push(DroppedLease {\n"
     "                    lease: lease.clone(),\n"
     "                    reason: DropReason::StaticConflict,\n"
     "                });\n"
     "            }\n"
     "            continue;\n"
     "        }\n",
     ""),

    ("dhcp persistence: a lease outside the current pool is restored anyway",
     "crates/dhcp/src/persistence.rs",
     "        if !is_ip_in_pool(lease.ip, context.range_start, context.range_end) {\n"
     "            result\n"
     "                .dropped\n"
     "                .push(DroppedLease { lease: lease.clone(), reason: DropReason::OutOfPool });\n"
     "            continue;\n"
     "        }\n",
     ""),

    ("dhcp persistence: a junk record discards the whole file",
     "crates/dhcp/src/persistence.rs",
     "    entries.iter().filter_map(lease_from_json).collect()",
     "    entries.iter().map(|e| lease_from_json(e).unwrap_or_else(|| LeaseInfo {\n"
     "        mac: MacKey::parse_lossy(\"00-00-00-00-00-00\"),\n"
     "        ip: Ipv4Addr::UNSPECIFIED,\n"
     "        bound_at: 0, lease_sec: 0, expires_at: 0, remaining_sec: 0,\n"
     "        hostname: None, lease_type: LeaseType::Dynamic,\n"
     "    })).collect()"),

    # -- the engine ---------------------------------------------------------
    ("dhcp engine: the socket is bound before the configuration is judged",
     "crates/dhcp/src/engine.rs",
     "        options.validate().map_err(StartError::Configuration)?;\n"
     "\n"
     "        let socket = UdpSocket::bind(SocketAddr::new(options.address, options.port))\n"
     "            .map_err(StartError::Bind)?;",
     "        let socket = UdpSocket::bind(SocketAddr::new(options.address, options.port))\n"
     "            .map_err(StartError::Bind)?;\n"
     "        options.validate().map_err(StartError::Configuration)?;"),

    ("dhcp engine: a request the server cannot satisfy is met with silence",
     "crates/dhcp/src/engine.rs",
     "            (Some(wanted), Some(available)) if wanted != available => {\n"
     "                self.send_nak(request, mac, &format!(\n"
     "                    \"{wanted} is not yours; {available} is what this server would assign\"\n"
     "                ));\n"
     "                return;\n"
     "            }",
     "            (Some(wanted), Some(available)) if wanted != available => {\n"
     "                let _ = (wanted, available);\n"
     "                return;\n"
     "            }"),

    ("dhcp engine: a REQUEST naming another server is answered anyway",
     "crates/dhcp/src/engine.rs",
     "        if let Some(chosen) = request.options.ipv4(OPTION_SERVER_ID) {\n"
     "            if chosen != self.server_id {\n"
     "                if let Some(freed) = self.table.release(mac, now) {\n"
     "                    self.mark_dirty();\n"
     "                    self.wire.log(\n"
     "                        LogLevel::Debug,\n"
     "                        format!(\"{mac} accepted an offer from {chosen}; released {freed}\"),\n"
     "                    );\n"
     "                }\n"
     "                return;\n"
     "            }\n"
     "        }\n",
     ""),

    ("dhcp engine: a NAK is unicast to the address being rejected",
     "crates/dhcp/src/engine.rs",
     "        if self.wire.send(self.reply_destination(request, true), &packet) {",
     "        if self.wire.send(self.reply_destination(request, false), &packet) {"),

    ("dhcp engine: a relayed request is answered directly to the client",
     "crates/dhcp/src/engine.rs",
     "        if !request.giaddr.is_unspecified() {\n"
     "            // Through the relay agent that forwarded it, on the *server* port.\n"
     "            return SocketAddr::new(IpAddr::V4(request.giaddr), DEFAULT_PORT);\n"
     "        }\n",
     ""),

    ("dhcp engine: a DHCPINFORM allocates an address and a lease",
     "crates/dhcp/src/engine.rs",
     "            if address.is_some() {\n"
     "                options.put_u32(OPTION_LEASE_TIME, self.lease_secs)?;",
     "            if true {\n"
     "                options.put_u32(OPTION_LEASE_TIME, self.lease_secs)?;"),

    ("dhcp engine: a malformed datagram is answered instead of dropped",
     "crates/dhcp/src/engine.rs",
     "                self.note_decode_error(&error, peer);\n                return;",
     "                self.note_decode_error(&error, peer);\n"
     "                self.counters.packets_sent += 1;\n"
     "                let _ = self.wire.send(peer, b\"\\x02\");\n"
     "                return;"),

    ("dhcp engine: offers and acks are counted as they arrive, not as they are sent",
     "crates/dhcp/src/engine.rs",
     "        if self.wire.send(self.reply_destination(request, false), &packet) {\n"
     "            self.counters.offer_count += 1;\n"
     "            self.counters.packets_sent += 1;\n"
     "        }",
     "        if self.wire.send(self.reply_destination(request, false), &packet) {\n"
     "            self.counters.packets_sent += 1;\n"
     "        }"),

    ("dhcp engine: leases are restored after reservations are seeded",
     "crates/dhcp/src/engine.rs",
     "        core.restore_persisted(options);\n"
     "        let report = core.table.seed_static_reservations(persistence::now_epoch_ms());",
     "        let report = core.table.seed_static_reservations(persistence::now_epoch_ms());\n"
     "        core.restore_persisted(options);",
     # Documented survivor: reconciliation has already resolved every case where
     # the two orders could differ.
     "reconciliation drops a persisted lease that contradicts a reservation "
     "before restore ever runs, so by the time either step executes the two "
     "orders agree on every entry. The order is kept because it is the one that "
     "stays correct if reconciliation is ever relaxed, and because "
     "restore-then-seed is what the reference implementation depends on"),

    # -- the daemon ---------------------------------------------------------
    ("dhcp service: a failed start answers success",
     "crates/daemon/src/daemon.rs",
     "            dhcp_service::SERVICE_ID => match self.dhcp.start() {\n"
     "                Ok(()) => Self::ok(request.id, service),\n"
     "                Err(message) => Outgoing::error(request.id, ErrorCode::InternalError, message),\n"
     "            },",
     "            dhcp_service::SERVICE_ID => match self.dhcp.start() {\n"
     "                Ok(()) => Self::ok(request.id, service),\n"
     "                Err(_) => Self::ok(request.id, service),\n"
     "            },"),

    ("dhcp service: a bad configuration is stored instead of refused",
     "crates/daemon/src/config.rs",
     "                parsed.resolve().map_err(ConfigError)?;\n",
     ""),

    ("dhcp service: a rejected configuration is stored anyway",
     "crates/daemon/src/config.rs",
     "                let parsed: DhcpConfig = serde_json::from_value(incoming.clone())\n"
     "                    .map_err(|e| ConfigError(format!(\"invalid dhcp configuration: {e}\")))?;",
     "                let parsed: DhcpConfig = serde_json::from_value(incoming.clone())\n"
     "                    .unwrap_or_default();"),

    ("dhcp service: the fallback fires for a port the operator chose",
     "crates/daemon/src/dhcp_service.rs",
     "            Err(error) if error.is_permission_denied() && configured == DHCP_DEFAULT_PORT => {",
     "            Err(error) if error.is_permission_denied() || error.is_address_in_use() => {"),
]
