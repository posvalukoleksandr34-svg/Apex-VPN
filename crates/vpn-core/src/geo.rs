/// Approximate position used for "Nearest" (from GeoIP of the last
/// unprotected IP observation).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GeoPoint {
    pub latitude: f64,
    pub longitude: f64,
}

/// Great-circle distance in kilometres (haversine).
pub fn distance_km(a: GeoPoint, b: GeoPoint) -> f64 {
    const EARTH_RADIUS_KM: f64 = 6371.0;
    let (lat1, lat2) = (a.latitude.to_radians(), b.latitude.to_radians());
    let dlat = (b.latitude - a.latitude).to_radians();
    let dlon = (b.longitude - a.longitude).to_radians();
    let h = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_KM * h.sqrt().asin()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frankfurt_to_new_york() {
        let fra = GeoPoint { latitude: 50.1109, longitude: 8.6821 };
        let nyc = GeoPoint { latitude: 40.7128, longitude: -74.0060 };
        let d = distance_km(fra, nyc);
        assert!((6180.0..6230.0).contains(&d), "{d}");
    }

    #[test]
    fn zero_distance() {
        let p = GeoPoint { latitude: 10.0, longitude: 20.0 };
        assert!(distance_km(p, p) < 1e-9);
    }
}
