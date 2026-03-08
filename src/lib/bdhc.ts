/**
 * BDHC (Binary Data Height Collision) parser for DPPt.
 *
 * BDHC files define 3D terrain geometry for Gen IV maps using rectangular
 * "plates" with height values and slope normals. The game uses this data
 * to determine the player's Y-height at any (X, Z) world position.
 *
 * Format (Diamond/Pearl/Platinum):
 *   Header (0x44 bytes):
 *     0x00: "BDHC" magic
 *     0x04: u16 = 32, u16 = 0  (version/flags)
 *     0x08: u16 coordSize (12), u16 numCoords
 *     0x0C: u16 slopeSize (12), u16 numSlopes
 *     0x10: u16 plateSize (12), u16 numPlates
 *     0x14-0x27: stripe/index metadata
 *     0x28-0x43: quadrant bounds (8 × s16 pairs)
 *   Data:
 *     Section 1: Coordinates (numCoords × 12 bytes)
 *     Section 2: Slopes (numSlopes × 12 bytes)
 *     Section 3: Plates (numPlates × 12 bytes)
 *     Section 4: Stripe groups
 *     Section 5: Stripes
 *     Section 6: Triangle/plate indices
 *
 * Reference: Pokemon DS Map Studio (Trifindo) — BdhcLoaderDP.java
 */

import { BinaryReader } from "./binary";

// ─── Constants ───────────────────────────────────────────────

/** Normalization divisor for slope vectors. */
const SLOPE_UNIT = 4095.56247663;

/** Predefined slope normals for common plate types. */
export const PLATE_TYPES = {
  PLANE: 0,
  BRIDGE: 1,
  LEFT_STAIRS: 2,
  RIGHT_STAIRS: 3,
  UP_STAIRS: 4,
  DOWN_STAIRS: 5,
  OTHER: 6,
} as const;

export const SLOPE_PRESETS: Record<number, [number, number, number]> = {
  [PLATE_TYPES.PLANE]:        [0, 4096, 0],
  [PLATE_TYPES.BRIDGE]:       [0, 4096, 0],
  [PLATE_TYPES.LEFT_STAIRS]:  [2896, 2896, 0],
  [PLATE_TYPES.RIGHT_STAIRS]: [-2896, 2896, 0],
  [PLATE_TYPES.UP_STAIRS]:    [0, 2896, 2896],
  [PLATE_TYPES.DOWN_STAIRS]:  [0, 2896, -2896],
};

// ─── Types ───────────────────────────────────────────────────

export interface BdhcPoint {
  x: number;
  y: number;
  z: number; // height (fixed-point decoded)
}

export interface BdhcSlope {
  x: number;
  y: number;
  z: number;
}

export interface BdhcPlate {
  /** Vertex indices (3 for DP triangles, or 2 corner refs for HGSS rects) */
  pointIndices: number[];
  slopeIndex: number;
  distance: number; // plane distance (fixed-point decoded)
}

export interface BdhcStripe {
  y: number;
  plateIndices: number[];
}

export interface BDHC {
  points: BdhcPoint[];
  slopes: BdhcSlope[];
  plates: BdhcPlate[];
  stripes: BdhcStripe[];
  /** Pre-computed plate geometries for rendering */
  geometry: PlateGeometry[];
}

export interface PlateGeometry {
  /** 3D vertices of the plate surface (4 corners for quads, 3 for tris) */
  vertices: [number, number, number][];
  /** Normal vector */
  normal: [number, number, number];
  /** Plate type classification */
  type: number;
  /** Base height */
  baseZ: number;
}

// ─── Fixed-Point Decode ──────────────────────────────────────

/** Decode a 4-byte NDS fixed-point value: u16 frac + s16 int → float */
function decodeFixedPoint(fracPart: number, intPart: number): number {
  return intPart + (fracPart & 0xFFFF) / 65536.0;
}

// ─── DP Format Parser ────────────────────────────────────────

export function parseBDHC(buffer: ArrayBuffer): BDHC | null {
  if (!buffer || buffer.byteLength < 0x44) return null;

  const r = new BinaryReader(buffer);

  // Magic check
  const magic = r.str(4);
  if (magic !== "BDHC") return null;

  // Header fields
  r.skip(4); // version bytes (32, 0)

  const coordSize = r.u16();
  const numCoords = r.u16();
  const slopeSize = r.u16();
  const numSlopes = r.u16();
  const plateSize = r.u16();
  const numPlates = r.u16();

  // Stripe metadata
  r.skip(4); // field, stripe group count
  const stripeGroupSize = r.u16();
  r.skip(2);
  const maxNumStripes = r.u16();
  const maxNumTris = r.u16();
  const stripeDataSize = r.u16();
  r.skip(2);
  const triIndicesSize = r.u16();
  r.skip(2);

  // Quadrant bounds (16 × s16)
  const quadBounds: number[] = [];
  for (let i = 0; i < 16; i++) quadBounds.push(r.i16());

  // ─── Section 1: Coordinates ──────────────────
  const points: BdhcPoint[] = [];
  for (let i = 0; i < numCoords; i++) {
    r.skip(2); // padding
    const x = r.i16();
    const fracZ = r.u16();
    const intZ = r.i16();
    r.skip(2); // padding
    const y = r.i16();
    r.skip(2); // padding
    points.push({
      x,
      y,
      z: decodeFixedPoint(fracZ, intZ),
    });
  }

  // ─── Section 2: Slopes ───────────────────────
  const slopes: BdhcSlope[] = [];
  for (let i = 0; i < numSlopes; i++) {
    slopes.push({
      x: r.i32(),
      z: r.i32(),
      y: r.i32(),
    });
  }

  // ─── Section 3: Plates ───────────────────────
  const plates: BdhcPlate[] = [];
  for (let i = 0; i < numPlates; i++) {
    const p1 = r.u16();
    const p2 = r.u16();
    const p3 = r.u16();
    const slopeIdx = r.u16();
    const fracD = r.u16();
    const intD = r.i16();
    plates.push({
      pointIndices: [p1, p2, p3],
      slopeIndex: slopeIdx,
      distance: -(decodeFixedPoint(fracD, intD)),
    });
  }

  // ─── Section 4: Stripe groups ────────────────
  const numStripeGroups = 2; // DP uses 2 groups typically
  const stripeGroups: { count: number; offset: number }[] = [];
  for (let g = 0; g < numStripeGroups; g++) {
    stripeGroups.push({
      count: r.u16(),
      offset: r.u16(),
    });
  }

  // ─── Section 5: Stripes ──────────────────────
  const totalStripes = stripeGroups.reduce((sum, g) => sum + g.count, 0);
  const rawStripes: { numIndices: number; y: number; indexOffset: number }[] = [];
  for (let i = 0; i < totalStripes && r.remaining() >= 10; i++) {
    const numIndices = r.u16();
    r.skip(2);
    const y = r.i16();
    const indexOffset = r.u16();
    r.skip(2);
    rawStripes.push({ numIndices, y, indexOffset });
  }

  // ─── Section 6: Triangle indices ─────────────
  const allIndices: number[] = [];
  const numIndices = Math.floor(triIndicesSize / 2);
  for (let i = 0; i < numIndices && r.remaining() >= 2; i++) {
    allIndices.push(r.u16());
  }

  // Build stripe objects with resolved plate indices
  const stripes: BdhcStripe[] = rawStripes.map(rs => ({
    y: rs.y,
    plateIndices: allIndices.slice(rs.indexOffset / 2, rs.indexOffset / 2 + rs.numIndices),
  }));

  // ─── Compute geometry for rendering ──────────
  const geometry = computePlateGeometry(points, slopes, plates);

  return { points, slopes, plates, stripes, geometry };
}

// ─── Plate Type Classification ───────────────────────────────

function classifySlope(slope: BdhcSlope): number {
  const { x, y, z } = slope;
  // Check against known slope presets
  if (x === 0 && z === 4096 && y === 0) return PLATE_TYPES.PLANE;
  if (x === 2896 && z === 2896 && y === 0) return PLATE_TYPES.LEFT_STAIRS;
  if (x === -2896 && z === 2896 && y === 0) return PLATE_TYPES.RIGHT_STAIRS;
  if (x === 0 && z === 2896 && y === 2896) return PLATE_TYPES.UP_STAIRS;
  if (x === 0 && z === 2896 && y === -2896) return PLATE_TYPES.DOWN_STAIRS;
  return PLATE_TYPES.OTHER;
}

// ─── Height Calculation ──────────────────────────────────────

/**
 * Calculate the Z height at a given (worldX, worldY) position
 * using the plane equation defined by a plate's slope + distance.
 */
export function calculatePlateZ(
  plate: BdhcPlate,
  slopes: BdhcSlope[],
  worldX: number,
  worldY: number
): number {
  const slope = slopes[plate.slopeIndex];
  if (!slope) return plate.distance;

  const xd = slope.x / SLOPE_UNIT;
  const zd = slope.z / SLOPE_UNIT;
  const yd = slope.y / SLOPE_UNIT;
  const d = plate.distance;

  // Plane: xd*X + zd*Z + yd*Y = d
  // Solve for Z: Z = (d - xd*X - yd*Y) / zd
  if (Math.abs(zd) > 0.001) {
    return (d - xd * worldX - yd * worldY) / zd;
  }
  return d;
}

// ─── Geometry Generation ─────────────────────────────────────

function computePlateGeometry(
  points: BdhcPoint[],
  slopes: BdhcSlope[],
  plates: BdhcPlate[]
): PlateGeometry[] {
  const geometries: PlateGeometry[] = [];

  for (const plate of plates) {
    const [i1, i2, i3] = plate.pointIndices;
    const p1 = points[i1];
    const p2 = points[i2];
    const p3 = points[i3];
    if (!p1 || !p2 || !p3) continue;

    const slope = slopes[plate.slopeIndex];
    const plateType = slope ? classifySlope(slope) : PLATE_TYPES.PLANE;

    // For DP format, plates reference 3 corner points of a triangle
    // But conceptually most plates are rectangular.
    // The 3 points typically define a bounding rectangle:
    //   p1 = one corner, p2 = opposite corner, p3 = defines the plane
    // We'll compute corner heights using the plane equation.

    const minX = Math.min(p1.x, p2.x, p3.x);
    const maxX = Math.max(p1.x, p2.x, p3.x);
    const minY = Math.min(p1.y, p2.y, p3.y);
    const maxY = Math.max(p1.y, p2.y, p3.y);

    // Calculate height at each corner using the plane equation
    const z00 = calculatePlateZ(plate, slopes, minX, minY);
    const z10 = calculatePlateZ(plate, slopes, maxX, minY);
    const z01 = calculatePlateZ(plate, slopes, minX, maxY);
    const z11 = calculatePlateZ(plate, slopes, maxX, maxY);

    // Normalize the slope for the normal vector
    const nx = slope ? slope.x / SLOPE_UNIT : 0;
    const ny = slope ? slope.z / SLOPE_UNIT : 1;
    const nz = slope ? slope.y / SLOPE_UNIT : 0;

    geometries.push({
      vertices: [
        [minX, z00, minY],
        [maxX, z10, minY],
        [maxX, z11, maxY],
        [minX, z01, maxY],
      ],
      normal: [nx, ny, nz],
      type: plateType,
      baseZ: (z00 + z10 + z01 + z11) / 4,
    });
  }

  return geometries;
}

/**
 * Build a simple 32×32 heightmap grid from BDHC data.
 * For each tile, find the plate that covers it and compute the height.
 * Returns a Float32Array of heights (32×32).
 */
export function buildHeightmap(
  bdhc: BDHC,
  gridWidth = 32,
  gridHeight = 32,
  tileSize = 16, // NDS map tile size in world units
): Float32Array {
  const heights = new Float32Array(gridWidth * gridHeight);

  for (let gy = 0; gy < gridHeight; gy++) {
    for (let gx = 0; gx < gridWidth; gx++) {
      // World coordinate at tile center
      const wx = gx * tileSize + tileSize / 2;
      const wy = gy * tileSize + tileSize / 2;

      // Find the plate that contains this point
      let bestZ = 0;
      let found = false;

      for (const geo of bdhc.geometry) {
        const [v0, v1, v2, v3] = geo.vertices;
        const pMinX = Math.min(v0[0], v1[0], v2[0], v3[0]);
        const pMaxX = Math.max(v0[0], v1[0], v2[0], v3[0]);
        const pMinY = Math.min(v0[2], v1[2], v2[2], v3[2]);
        const pMaxY = Math.max(v0[2], v1[2], v2[2], v3[2]);

        if (wx >= pMinX && wx <= pMaxX && wy >= pMinY && wy <= pMaxY) {
          // Interpolate height
          const tx = pMaxX > pMinX ? (wx - pMinX) / (pMaxX - pMinX) : 0;
          const ty = pMaxY > pMinY ? (wy - pMinY) / (pMaxY - pMinY) : 0;
          const z0 = v0[1] + (v1[1] - v0[1]) * tx;
          const z1 = v3[1] + (v2[1] - v3[1]) * tx;
          const z = z0 + (z1 - z0) * ty;

          if (!found || z > bestZ) {
            bestZ = z;
            found = true;
          }
        }
      }

      heights[gy * gridWidth + gx] = bestZ;
    }
  }

  return heights;
}
