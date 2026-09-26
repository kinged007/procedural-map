export interface MapTheme {
  id: string;
  name: string;
  terrain: {
    grass: string;
    meadow: string;
    scrub: string;
    rock: string;
    beach: string;
    detail: string;
  };
  water: { fill: string; shore: string; line: string; ripple: string };
  roads: { primary: string; secondary: string; path: string; casing: string };
  vegetation: { canopy: string[]; outline: string; trunk: string; shadow: string };
}
