export interface MapTheme {
  id: string;
  name: string;
  terrain: { grass: string; meadow: string; scrub: string; detail: string };
  water: { fill: string; shore: string; line: string; ripple: string };
  vegetation: { canopy: string[]; outline: string; trunk: string; shadow: string };
}
