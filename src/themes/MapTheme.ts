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
    /** The ground of a building that has fallen down, which is not a roof. */
    ruin: string;
    outline: string;
  };
  /**
   * Dock colours. Optional, for the same reason as `structures`: a theme written before docks
   * existed still renders. It is a group of its own rather than two fields on `structures` because
   * that group is read as a whole, and a theme supplying buildings but not docks would otherwise be
   * handed an undefined fill.
   */
  docks?: { deck: string; outline: string };
  /**
   * Resource site colours, one per kind, because the three are told apart by shape as well as by
   * colour and a consumer overriding one has not overridden the others. Optional, for the same reason
   * as `docks`.
   */
  resources?: { mine: string; fishing: string; hunting: string };
}
