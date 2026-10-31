// Layer definitions shared by the AR capture, plan view and DXF writer.
// aci = AutoCAD Color Index, css = colour used on screen.
export const LAYERS = {
  LAWN_BOUNDARY: { label: 'Lawn boundary', kind: 'polyline', closed: true, aci: 3, css: '#2e9d3a' },
  OBSTACLES: { label: 'Obstacle (bed / patch)', kind: 'polyline', closed: true, aci: 1, css: '#d33a3a' },
  TREES: { label: 'Tree / post (centre, then edge)', kind: 'circle', closed: false, aci: 2, css: '#c9a800' },
  WATER_SOURCE: { label: 'Water source (tap / valve)', kind: 'point', closed: false, aci: 5, css: '#1e6fe0' },
  HARDSCAPE: { label: 'Hardscape (house / fence line)', kind: 'polyline', closed: false, aci: 8, css: '#777777' },
};

export const LAYER_ORDER = Object.keys(LAYERS);

export const EDGE_LABEL_LAYER = { name: 'EDGE_LENGTHS', aci: 7 };
