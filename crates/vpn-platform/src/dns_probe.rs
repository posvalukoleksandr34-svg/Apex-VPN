//! A tiny DNS client for the DNS test: sends one A query over UDP straight
//! to a given resolver and reports what came back. It bypasses the OS
//! resolver on purpose, so it tests the resolver, not the cache.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::{Duration, Instant};
use tokio::net::UdpSocket;
use vpn_types::ipc::DnsTestResult;

pub async fn query_a(server: IpAddr, name: &str, timeout: Duration) -> DnsTestResult {
    let started = Instant::now();
    let result = tokio::time::timeout(timeout, exchange(server, name)).await;
    let rtt = started.elapsed().as_millis().min(u32::MAX as u128) as u32;
    let (ok, outcome, answers, rtt_ms) = match result {
        Err(_) => (false, "timeout".to_string(), vec![], None),
        Ok(Err(e)) => (false, format!("transport_error: {}", e.kind()), vec![], None),
        Ok(Ok(Reply { rcode, answers })) => (rcode == 0, rcode_name(rcode).to_string(), answers, Some(rtt)),
    };
    DnsTestResult { server, query: name.to_string(), ok, rtt_ms, outcome, answers }
}

struct Reply {
    rcode: u8,
    answers: Vec<IpAddr>,
}

async fn exchange(server: IpAddr, name: &str) -> std::io::Result<Reply> {
    let bind: SocketAddr = if server.is_ipv4() { "0.0.0.0:0".parse().unwrap() } else { "[::]:0".parse().unwrap() };
    let socket = UdpSocket::bind(bind).await?;
    socket.connect(SocketAddr::new(server, 53)).await?;
    let id: u16 = rand::random();
    let query = build_query(id, name).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad name"))?;
    socket.send(&query).await?;
    let mut buf = [0u8; 1500];
    loop {
        let n = socket.recv(&mut buf).await?;
        // Ignore anything that isn't the reply to our query (spoofing).
        if let Some(reply) = parse_reply(&buf[..n], id) {
            return Ok(reply);
        }
    }
}

pub(crate) fn build_query(id: u16, name: &str) -> Option<Vec<u8>> {
    let mut q = Vec::with_capacity(32 + name.len());
    q.extend_from_slice(&id.to_be_bytes());
    q.extend_from_slice(&[0x01, 0x00]); // RD
    q.extend_from_slice(&[0, 1, 0, 0, 0, 0, 0, 0]); // QD=1
    for label in name.trim_end_matches('.').split('.') {
        if label.is_empty() || label.len() > 63 {
            return None;
        }
        q.push(label.len() as u8);
        q.extend_from_slice(label.as_bytes());
    }
    q.push(0);
    q.extend_from_slice(&[0, 1, 0, 1]); // A, IN
    Some(q)
}

fn parse_reply(msg: &[u8], id: u16) -> Option<Reply> {
    if msg.len() < 12 || u16::from_be_bytes([msg[0], msg[1]]) != id || msg[2] & 0x80 == 0 {
        return None;
    }
    let rcode = msg[3] & 0x0f;
    let qd = u16::from_be_bytes([msg[4], msg[5]]);
    let an = u16::from_be_bytes([msg[6], msg[7]]);
    let mut pos = 12;
    for _ in 0..qd {
        pos = skip_name(msg, pos)? + 4;
    }
    let mut answers = Vec::new();
    for _ in 0..an {
        pos = skip_name(msg, pos)?;
        let header = msg.get(pos..pos + 10)?;
        let rtype = u16::from_be_bytes([header[0], header[1]]);
        let len = u16::from_be_bytes([header[8], header[9]]) as usize;
        pos += 10;
        let data = msg.get(pos..pos + len)?;
        if rtype == 1 && len == 4 {
            answers.push(IpAddr::V4(Ipv4Addr::new(data[0], data[1], data[2], data[3])));
        }
        pos += len;
    }
    Some(Reply { rcode, answers })
}

fn skip_name(msg: &[u8], mut pos: usize) -> Option<usize> {
    loop {
        let len = *msg.get(pos)?;
        if len & 0xc0 == 0xc0 {
            return Some(pos + 2);
        }
        if len == 0 {
            return Some(pos + 1);
        }
        pos += 1 + len as usize;
    }
}

fn rcode_name(rcode: u8) -> &'static str {
    match rcode {
        0 => "NOERROR",
        1 => "FORMERR",
        2 => "SERVFAIL",
        3 => "NXDOMAIN",
        4 => "NOTIMP",
        5 => "REFUSED",
        _ => "OTHER",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_standard_query() {
        let q = build_query(0xabcd, "example.com").unwrap();
        assert_eq!(&q[..4], &[0xab, 0xcd, 0x01, 0x00]);
        assert_eq!(&q[12..], b"\x07example\x03com\x00\x00\x01\x00\x01");
        assert!(build_query(1, "bad..name").is_none());
    }

    #[test]
    fn parses_an_answer_with_compression() {
        let mut m = build_query(7, "example.com").unwrap();
        m[2] = 0x81;
        m[3] = 0x80; // response, NOERROR
        m[7] = 1; // AN=1
        m.extend_from_slice(&[0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 93, 184, 216, 34]);
        let r = parse_reply(&m, 7).unwrap();
        assert_eq!(r.rcode, 0);
        assert_eq!(r.answers, vec![IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34))]);
        assert!(parse_reply(&m, 8).is_none(), "wrong id is ignored");
    }
}
