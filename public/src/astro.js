// Low-precision ephemeris (good to ~1°) for placing the sun, moon and stars above the disc.
// Each body hangs directly above its "sub-point": the place where it is overhead right now.
const RAD = Math.PI / 180;
const norm360 = (a) => ((a % 360) + 360) % 360;
const norm180 = (a) => norm360(a + 180) - 180;

export function skyAt(date) {
  const d = date.getTime() / 86400000 + 2440587.5 - 2451545.0; // days since J2000
  const gmst = norm360(280.46061837 + 360.98564736629 * d);
  const e = (23.439 - 0.00000036 * d) * RAD; // obliquity

  // Sun
  const g = norm360(357.529 + 0.98560028 * d) * RAD;
  const q = norm360(280.459 + 0.98564736 * d);
  const sunLam = norm360(q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
  const sl = sunLam * RAD;
  const sunRa = Math.atan2(Math.cos(e) * Math.sin(sl), Math.cos(sl)) / RAD;
  const sunDec = Math.asin(Math.sin(e) * Math.sin(sl)) / RAD;

  // Moon
  const Lm = norm360(218.316 + 13.176396 * d);
  const Mm = norm360(134.963 + 13.064993 * d) * RAD;
  const F = norm360(93.272 + 13.22935 * d) * RAD;
  const moonLam = norm360(Lm + 6.289 * Math.sin(Mm));
  const lam = moonLam * RAD;
  const beta = 5.128 * Math.sin(F) * RAD;
  const moonRa = Math.atan2(Math.sin(lam) * Math.cos(e) - Math.tan(beta) * Math.sin(e), Math.cos(lam)) / RAD;
  const moonDec = Math.asin(Math.sin(beta) * Math.cos(e) + Math.cos(beta) * Math.sin(e) * Math.sin(lam)) / RAD;

  const elong = norm360(moonLam - sunLam);
  return {
    gmst,
    sun: { lon: norm180(sunRa - gmst), lat: sunDec },
    moon: {
      lon: norm180(moonRa - gmst),
      lat: moonDec,
      elong,
      illum: (1 - Math.cos(elong * RAD)) / 2,
      phase: phaseName(elong),
    },
  };
}

function phaseName(e) {
  const names = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous', 'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent'];
  return names[Math.round(e / 45) % 8];
}

// Sun altitude (degrees) at a place, from the sub-solar point.
export function sunAltitude(lonlat, sun) {
  const [l1, p1] = [lonlat[0] * RAD, lonlat[1] * RAD];
  const [l2, p2] = [sun.lon * RAD, sun.lat * RAD];
  const c = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(l1 - l2);
  return 90 - Math.acos(Math.max(-1, Math.min(1, c))) / RAD;
}

// Bright stars: [name, RA°, Dec°, magnitude]
export const STARS = [
  ['Polaris', 37.95, 89.26, 2.0], ['Yildun', 263.05, 86.59, 4.4], ['Epsilon UMi', 251.49, 82.04, 4.2],
  ['Zeta UMi', 236.01, 77.79, 4.3], ['Eta UMi', 244.38, 75.76, 5.0], ['Kochab', 222.68, 74.16, 2.1], ['Pherkad', 230.18, 71.83, 3.0],
  ['Dubhe', 165.93, 61.75, 1.8], ['Merak', 165.46, 56.38, 2.4], ['Phecda', 178.46, 53.69, 2.4], ['Megrez', 183.86, 57.03, 3.3],
  ['Alioth', 193.51, 55.96, 1.8], ['Mizar', 200.98, 54.93, 2.2], ['Alkaid', 206.89, 49.31, 1.9],
  ['Caph', 2.29, 59.15, 2.3], ['Schedar', 10.13, 56.54, 2.2], ['Navi', 14.18, 60.72, 2.4], ['Ruchbah', 21.45, 60.24, 2.7], ['Segin', 28.6, 63.67, 3.4],
  ['Betelgeuse', 88.79, 7.41, 0.5], ['Rigel', 78.63, -8.2, 0.1], ['Bellatrix', 81.28, 6.35, 1.6], ['Saiph', 86.94, -9.67, 2.1],
  ['Alnitak', 85.19, -1.94, 1.8], ['Alnilam', 84.05, -1.2, 1.7], ['Mintaka', 83.0, -0.3, 2.2], ['Meissa', 83.78, 9.93, 3.4],
  ['Sirius', 101.29, -16.72, -1.5], ['Vega', 279.23, 38.78, 0.0], ['Arcturus', 213.92, 19.18, -0.1], ['Capella', 79.17, 46.0, 0.1],
  ['Deneb', 310.36, 45.28, 1.3], ['Altair', 297.7, 8.87, 0.8], ['Aldebaran', 68.98, 16.51, 0.9], ['Antares', 247.35, -26.43, 1.0],
  ['Spica', 201.3, -11.16, 1.0], ['Regulus', 152.09, 11.97, 1.4], ['Procyon', 114.83, 5.22, 0.4], ['Pollux', 116.33, 28.03, 1.1],
  ['Castor', 113.65, 31.89, 1.6], ['Canopus', 95.99, -52.7, -0.7], ['Fomalhaut', 344.41, -29.62, 1.2], ['Achernar', 24.43, -57.24, 0.5],
  ['Acrux', 186.65, -63.1, 0.8], ['Mimosa', 191.93, -59.69, 1.3], ['Gacrux', 187.79, -57.11, 1.6], ['Imai', 183.79, -58.75, 2.8],
  ['Rigil Kentaurus', 219.9, -60.83, -0.3], ['Hadar', 210.96, -60.37, 0.6],
];

// Constellation stick figures as pairs of star names.
export const LINES = [
  ['Polaris', 'Yildun'], ['Yildun', 'Epsilon UMi'], ['Epsilon UMi', 'Zeta UMi'], ['Zeta UMi', 'Kochab'], ['Kochab', 'Pherkad'], ['Pherkad', 'Eta UMi'], ['Eta UMi', 'Zeta UMi'],
  ['Dubhe', 'Merak'], ['Merak', 'Phecda'], ['Phecda', 'Megrez'], ['Megrez', 'Dubhe'], ['Megrez', 'Alioth'], ['Alioth', 'Mizar'], ['Mizar', 'Alkaid'],
  ['Caph', 'Schedar'], ['Schedar', 'Navi'], ['Navi', 'Ruchbah'], ['Ruchbah', 'Segin'],
  ['Meissa', 'Betelgeuse'], ['Meissa', 'Bellatrix'], ['Betelgeuse', 'Alnitak'], ['Bellatrix', 'Mintaka'], ['Alnitak', 'Alnilam'], ['Alnilam', 'Mintaka'],
  ['Alnitak', 'Saiph'], ['Mintaka', 'Rigel'], ['Castor', 'Pollux'],
  ['Acrux', 'Gacrux'], ['Mimosa', 'Imai'],
];
