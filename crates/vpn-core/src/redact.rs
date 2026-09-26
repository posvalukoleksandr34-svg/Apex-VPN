//! Log redaction. Unless diagnostic mode is on, IP addresses and WireGuard
//! keys never reach the log file: IPv4 keeps its first octet, IPv6 its first
//! group, and keys are removed entirely. That keeps logs useful for support
//! ("the endpoint was a 185.x address") without being a record of where
//! someone connected from.

use std::net::IpAddr;

pub fn redact(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut token = String::new();
    for ch in input.chars() {
        if is_token_char(ch) {
            token.push(ch);
        } else {
            flush(&mut token, &mut out);
            out.push(ch);
        }
    }
    flush(&mut token, &mut out);
    out
}

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '+' | '/' | '=' | '[' | ']')
}

fn flush(token: &mut String, out: &mut String) {
    if token.is_empty() {
        return;
    }
    out.push_str(&redact_token(token));
    token.clear();
}

fn redact_token(t: &str) -> String {
    if is_wireguard_key(t) {
        return "<key>".into();
    }
    // `dns=10.64.0.1`, `10.64.0.2/32`: redact each side of the separator.
    if let Some(i) = t.find(['=', '/', '+']) {
        return format!("{}{}{}", redact_token(&t[..i]), &t[i..=i], redact_token(&t[i + 1..]));
    }
    redact_address(t)
}

fn redact_address(t: &str) -> String {
    if t.is_empty() {
        return String::new();
    }
    // Split off a trailing port (`1.2.3.4:51820`, `[2001:db8::1]:51820`).
    let (host, suffix) = split_port(t);
    let trimmed = host.trim_matches(|c| c == '[' || c == ']');
    let trailing_dot = trimmed.ends_with('.') && trimmed.len() > 1;
    let candidate = if trailing_dot { &trimmed[..trimmed.len() - 1] } else { trimmed };
    match candidate.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => {
            format!("{}.x.x.x{}{}", v4.octets()[0], if trailing_dot { "." } else { "" }, suffix)
        }
        Ok(IpAddr::V6(v6)) => format!("{:x}:x{}", v6.segments()[0], suffix),
        Err(_) => t.to_string(),
    }
}

fn split_port(t: &str) -> (&str, &str) {
    if let Some(end) = t.find("]:") {
        return (&t[..=end], &t[end + 1..]);
    }
    if t.matches(':').count() == 1 {
        if let Some((h, p)) = t.split_once(':') {
            if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) {
                return (h, &t[h.len()..]);
            }
        }
    }
    (t, "")
}

fn is_wireguard_key(t: &str) -> bool {
    t.len() == 44
        && t.ends_with('=')
        && t[..43].chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_ipv4_with_and_without_port() {
        assert_eq!(redact("endpoint 185.65.134.10:51820 up"), "endpoint 185.x.x.x:51820 up");
        assert_eq!(redact("dns=10.64.0.1,1.1.1.1"), "dns=10.x.x.x,1.x.x.x");
        assert_eq!(redact("address 10.64.0.2/32"), "address 10.x.x.x/32");
        assert_eq!(redact("at 192.168.1.1."), "at 192.x.x.x.");
    }

    #[test]
    fn masks_ipv6() {
        assert_eq!(redact("addr 2001:db8::1 ok"), "addr 2001:x ok");
        assert_eq!(redact("peer [2a03:1b20::5]:51820"), "peer 2a03:x:51820");
    }

    #[test]
    fn removes_keys() {
        let key = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=";
        assert_eq!(redact(&format!("peer {key} set")), "peer <key> set");
    }

    #[test]
    fn leaves_ordinary_text_alone() {
        let s = "Connecting to de-fra-001 (attempt 2), version 1.2.3, time 12:30";
        assert_eq!(redact(s), s);
    }
}
