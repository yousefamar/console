// Minimal IATA → coordinate lookup for drawing flight arcs on the map.
//
// Deliberately small — just the airports this household actually flies through
// plus common European/global hubs. SerpApi's google_flights does NOT return
// coordinates, so arcs need this table. Extend as new airports come up; an
// unknown code just means that leg is skipped (logged), never a crash.

export interface AirportCoord {
  lat: number
  lon: number
  city: string
}

export const AIRPORTS: Record<string, AirportCoord> = {
  // London / UK
  LHR: { lat: 51.4700, lon: -0.4543, city: 'London Heathrow' },
  LGW: { lat: 51.1537, lon: -0.1821, city: 'London Gatwick' },
  STN: { lat: 51.8860, lon: 0.2389, city: 'London Stansted' },
  LTN: { lat: 51.8747, lon: -0.3683, city: 'London Luton' },
  LCY: { lat: 51.5048, lon: 0.0495, city: 'London City' },
  EDI: { lat: 55.9500, lon: -3.3725, city: 'Edinburgh' },
  MAN: { lat: 53.3537, lon: -2.2750, city: 'Manchester' },
  DUB: { lat: 53.4213, lon: -6.2701, city: 'Dublin' },
  // Netherlands / Germany / nearby
  AMS: { lat: 52.3105, lon: 4.7683, city: 'Amsterdam' },
  FRA: { lat: 50.0379, lon: 8.5622, city: 'Frankfurt' },
  MUC: { lat: 48.3538, lon: 11.7861, city: 'Munich' },
  BER: { lat: 52.3667, lon: 13.5033, city: 'Berlin' },
  BRU: { lat: 50.9014, lon: 4.4844, city: 'Brussels' },
  // Italy
  MXP: { lat: 45.6306, lon: 8.7281, city: 'Milan Malpensa' },
  LIN: { lat: 45.4451, lon: 9.2767, city: 'Milan Linate' },
  BGY: { lat: 45.6739, lon: 9.7042, city: 'Milan Bergamo' },
  FCO: { lat: 41.8003, lon: 12.2389, city: 'Rome Fiumicino' },
  VCE: { lat: 45.5053, lon: 12.3519, city: 'Venice' },
  NAP: { lat: 40.8860, lon: 14.2908, city: 'Naples' },
  BLQ: { lat: 44.5354, lon: 11.2887, city: 'Bologna' },
  FLR: { lat: 43.8100, lon: 11.2051, city: 'Florence' },
  // France / Iberia
  CDG: { lat: 49.0097, lon: 2.5479, city: 'Paris CDG' },
  ORY: { lat: 48.7233, lon: 2.3794, city: 'Paris Orly' },
  BCN: { lat: 41.2974, lon: 2.0833, city: 'Barcelona' },
  MAD: { lat: 40.4983, lon: -3.5676, city: 'Madrid' },
  LIS: { lat: 38.7742, lon: -9.1342, city: 'Lisbon' },
  // Central / Eastern / Nordic
  ZRH: { lat: 47.4647, lon: 8.5492, city: 'Zurich' },
  GVA: { lat: 46.2381, lon: 6.1090, city: 'Geneva' },
  VIE: { lat: 48.1103, lon: 16.5697, city: 'Vienna' },
  PRG: { lat: 50.1008, lon: 14.2600, city: 'Prague' },
  CPH: { lat: 55.6180, lon: 12.6508, city: 'Copenhagen' },
  ATH: { lat: 37.9364, lon: 23.9445, city: 'Athens' },
  DBV: { lat: 42.5614, lon: 18.2682, city: 'Dubrovnik' },
  SPU: { lat: 43.5389, lon: 16.2980, city: 'Split' },
  // Long haul (handy for future "anywhere" arcs)
  JFK: { lat: 40.6413, lon: -73.7781, city: 'New York JFK' },
}

export function airportCoord(iata: string): AirportCoord | undefined {
  return AIRPORTS[iata.trim().toUpperCase()]
}
