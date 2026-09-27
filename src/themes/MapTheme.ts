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
  /** Where a river's channel becomes standing water. Optional, for the same reason. */
  riverMouths?: string;
  roads: { primary: string; secondary: string; path: string; casing: string };
  vegetation: { canopy: string[]; outline: string; trunk: string; shadow: string };
  /**
   * Building colours. Optional, for the same reason as `riverMouths`: a theme written before buildings
   * existed still renders, falling back to the default theme's values.
   */
  structures?: {
    wall: string;
    roof: string;
    roofFarm: string;
    outline: string;
  };
}
