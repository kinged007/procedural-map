export interface GenerationConfig {
  seed: number;
  width?: number;
  height?: number;
  terrain?: { variation?: number; scale?: number };
  water?: { amount?: number; scale?: number };
  vegetation?: { density?: number; clustering?: number };
  roads?: { density?: number };
}

export interface ResolvedGenerationConfig {
  seed: number;
  width: number;
  height: number;
  terrain: { variation: number; scale: number };
  water: { amount: number; scale: number };
  vegetation: { density: number; clustering: number };
  roads: { density: number };
}

export const DEFAULT_CONFIG: ResolvedGenerationConfig = {
  seed: 583921,
  width: 2048,
  height: 1536,
  terrain: { variation: 0.35, scale: 0.004 },
  water: { amount: 0.2, scale: 0.003 },
  vegetation: { density: 0.65, clustering: 0.8 },
  roads: { density: 0.5 },
};
