// Default hard construction cost of a new residential building in New York City, used when an account has
// not set its own. The published New York range runs from a plain low-rise to a high-specification tower, so
// each building is placed in it twice: by its structure (storeys) and by its specification (the price per SF
// it sells at, since finishes, systems and amenities follow the market a building is built for). The two
// places are averaged, and the figure is escalated from the survey date by the same report's New York index.

export const NYC_HARD_COST = {
  asOf: '2026-07-01',
  source: 'Rider Levett Bucknall, North America Quarterly Construction Cost Report, third quarter 2026: New York multi-family hard construction cost per SF of gross floor area',
  url: 'https://www.rlb.com/wp-content/uploads/sites/4/2026/09/Q3-2026-QCR.pdf',
  lowPerGrossSqft: 260,
  highPerGrossSqft: 510,
  // The same report's comparative cost index for New York (the highest of the US cities it tracks) and its
  // change over the year to July 2026. No published index divides the city by borough, so one location applies.
  costIndex: {city: 'New York', value: 39239, annualChange: 0.0484, asOf: '2026-07-01'},
  // Thirds of the range by structure. Planning placement, not a survey figure.
  structures: [
    {maxStoreys: 6, key: 'low_rise', label: 'wood or light-gauge steel low-rise', position: 1 / 6},
    {maxStoreys: 12, key: 'mid_rise', label: 'concrete mid-rise', position: 1 / 2},
    {maxStoreys: null, key: 'high_rise', label: 'concrete high-rise with deeper foundations and more elevators', position: 5 / 6},
  ],
  // The ends of the specification scale: new-building condominium prices per SF at the 10th and 90th
  // percentile of the city's ZIP codes with recorded closings (each ZIP median times the citywide new-building
  // premium of 1.35), measured from the deal store's closings. Placed on a log scale between them.
  specification: {lowSalePsf: 580, highSalePsf: 2230, asOf: '2026-10-22', source: 'New-building condominium price per SF at the 10th and 90th percentile of New York City ZIP codes with recorded closings, measured from DOF closings in the deal store'},
};

const structureFor = storeys => NYC_HARD_COST.structures.find(s => s.maxStoreys === null || storeys <= s.maxStoreys);

// Where a building's sale price sits between the specification ends, 0 to 1; mid-scale without a price.
export function specificationPosition(salePsf) {
  const {lowSalePsf, highSalePsf} = NYC_HARD_COST.specification;
  if (!(Number(salePsf) > 0)) return 0.5;
  return Math.max(0, Math.min(1, Math.log(salePsf / lowSalePsf) / Math.log(highSalePsf / lowSalePsf)));
}

// The house hard cost per gross SF for a building of this many storeys selling at salePsf, on valuationDate.
export function defaultHardCost({storeys, salePsf, valuationDate}) {
  const c = NYC_HARD_COST, structure = structureFor(storeys), spec = specificationPosition(salePsf);
  const position = (structure.position + spec) / 2;
  const years = Math.max(0, (Date.parse(valuationDate) - Date.parse(c.costIndex.asOf)) / (365.25 * 24 * 3600 * 1000)) || 0;
  const escalation = (1 + c.costIndex.annualChange) ** years;
  return {
    perGrossSqft: Math.round((c.lowPerGrossSqft + (c.highPerGrossSqft - c.lowPerGrossSqft) * position) * escalation),
    structure: structure.key, structureLabel: structure.label,
    position: Number(position.toFixed(3)), specificationPosition: Number(spec.toFixed(3)), escalation: Number(escalation.toFixed(4)),
  };
}

// One line of basis text for a valuation that used the house cost table.
export function hardCostBasisText() {
  const c = NYC_HARD_COST;
  return `${c.source} (${c.url}), $${c.lowPerGrossSqft} to $${c.highPerGrossSqft}; each building is placed in that range by its structure (${c.structures.map(s => s.label).join(', ')}, the lower, middle and upper third) averaged with its specification (its sale price per SF between $${c.specification.lowSalePsf.toLocaleString('en-US')} and $${c.specification.highSalePsf.toLocaleString('en-US')}: ${c.specification.source}, ${c.specification.asOf}), and escalated from July 2026 at the report's New York index change of ${(c.costIndex.annualChange * 100).toFixed(2)}% a year; one location applies citywide`;
}
