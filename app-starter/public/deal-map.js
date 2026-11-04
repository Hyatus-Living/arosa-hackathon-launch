// New York projected flat for the drawn city map: north up, one ground scale on both axes, the five
// boroughs inside a fixed frame.
import { NYC_EXTENT } from "./core-model.js";

const PAD = 12;
// One ground scale on both axes: a degree of longitude is drawn cos(latitude) as wide as a degree of latitude.
const KX = Math.cos((((NYC_EXTENT.north + NYC_EXTENT.south) / 2) * Math.PI) / 180);
const WIDTH = 400;
const SCALE = (WIDTH - 2 * PAD) / ((NYC_EXTENT.east - NYC_EXTENT.west) * KX);
// The whole city in map units; the canvas always keeps this shape.
export const MAP_FRAME = { width: WIDTH, height: Math.round(2 * PAD + (NYC_EXTENT.north - NYC_EXTENT.south) * SCALE) };

export function projectNyc(lat, lon) {
  return { x: PAD + (lon - NYC_EXTENT.west) * KX * SCALE, y: PAD + (NYC_EXTENT.north - lat) * SCALE };
}
