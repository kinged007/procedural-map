export interface GenerationConfig {
  seed: number;
  width?: number;
  height?: number;
  /**
   * Where this tile sits in a larger world. The terrain is sampled in world space at
   * `origin + local`, so two adjacent tiles generated with the same seed share one continuous
   * landscape instead of two copies of it. Defaults to the top left of the world.
   */
  origin?: { x?: number; y?: number };
  /**
   * Size of the world this tile belongs to, measured from `(0, 0)`. Every threshold that decides
   * where water, rock, meadow and scrub begin is taken from a sample of the whole world rather than
   * of the tile, so a lake or a rock line does not stop at the tile edge. Defaults to the tile's own
   * bounds, which is the single-tile case.
   */
  world?: { width?: number; height?: number };
  terrain?: { variation?: number; scale?: number };
  water?: { amount?: number; scale?: number };
  vegetation?: { density?: number; clustering?: number };
  roads?: { density?: number };
}

export interface ResolvedGenerationConfig {
  seed: number;
  width: number;
  height: number;
  origin: { x: number; y: number };
  world: { width: number; height: number };
  terrain: { variation: number; scale: number };
  water: { amount: number; scale: number };
  vegetation: { density: number; clustering: number };
  roads: { density: number };
}

export const DEFAULT_CONFIG: ResolvedGenerationConfig = {
  seed: 583921,
  width: 2048,
  height: 1536,
  origin: { x: 0, y: 0 },
  world: { width: 2048, height: 1536 },
  terrain: { variation: 0.35, scale: 0.004 },
  water: { amount: 0.2, scale: 0.003 },
  vegetation: { density: 0.65, clustering: 0.8 },
  roads: { density: 0.5 },
};
