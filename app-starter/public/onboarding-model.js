// New accounts enter their development costs before using Arosa. Hard costs have no default: builders
// and GCs price them too differently for a house number to stand in, and rentals and condos are built
// to different finishes, so both are asked. The other inputs start at the house costs and are
// confirmed one step at a time.

export const HARD_COST_KEYS = ["rentalHardCostPerGrossSqft", "condoHardCostPerGrossSqft"];

// Each field is shown in the unit people quote it in and stored in the deal settings' own unit.
export const FIELDS = {
  rentalHardCostPerGrossSqft: { label: "Rental hard cost", unit: "$ / gross sf", hint: "Construction only for a rental building, with your GC's fee.", min: 100, max: 2500, step: 5, toView: v => v, toStore: v => v, format: v => `$${Math.round(v).toLocaleString("en-US")}` },
  condoHardCostPerGrossSqft: { label: "Condo hard cost", unit: "$ / gross sf", hint: "Construction only for condominiums. Use the same number if you build both the same way.", min: 100, max: 2500, step: 5, toView: v => v, toStore: v => v, format: v => `$${Math.round(v).toLocaleString("en-US")}` },
  softCostPctOfHard: { label: "Soft costs", unit: "% of hard cost", min: 0, max: 100, step: 0.5, toView: v => round(v * 100, 2), toStore: v => round(v / 100, 4), format: v => `${v}%` },
  carryAndFinancingPct: { label: "Financing and carry", unit: "% of cost", min: 0, max: 100, step: 0.5, toView: v => round(v * 100, 2), toStore: v => round(v / 100, 4), format: v => `${v}%` },
  zfaToGrossFactor: { label: "Gross area added", unit: "% over zoning floor area", min: 0, max: 50, step: 1, toView: v => round((v - 1) * 100, 1), toStore: v => round(1 + v / 100, 3), format: v => `${v}%` },
  zfaToNetEfficiency: { label: "Sellable share", unit: "% of zoning floor area", min: 50, max: 100, step: 1, toView: v => round(v * 100, 1), toStore: v => round(v / 100, 3), format: v => `${v}%` },
  goodDealCapRate: { label: "Rental yield on cost", unit: "% for a good deal", min: 2, max: 20, step: 0.25, toView: v => round(v * 100, 2), toStore: v => round(v / 100, 4), format: v => `${v}%` },
  goodDealCondoMargin: { label: "Condo profit margin", unit: "% for a good deal", min: 2, max: 60, step: 1, toView: v => round(v * 100, 1), toStore: v => round(v / 100, 3), format: v => `${v}%` },
};

// The first screen says why a new account is asked for its costs before anything else.
export const WELCOME = {
  title: "Arosa prices every site with your costs",
  lines: [
    "Each listing comes with a land value, a deal tier, a yield and a margin. All of it depends on what it costs you to build, and that number changes a lot from one builder to the next.",
    "Tell us yours once. It takes about a minute, and you can change it any time.",
  ],
  action: "Set my costs",
};

export const STEPS = [
  { id: "hard", short: "Hard costs", title: "What does it cost you to build?", line: "Hard cost per gross square foot on a typical ground-up project, for rentals and for condos. Every deal in Arosa is priced with your numbers. Soft costs and financing come next.", fields: [...HARD_COST_KEYS] },
  { id: "soft", short: "Soft costs and financing", title: "Soft costs and financing", line: "Design, permits, legal and fees on top of hard cost, then interest and carry through construction.", fields: ["softCostPctOfHard", "carryAndFinancingPct"] },
  { id: "efficiency", short: "Building efficiency", title: "How efficient are your buildings?", line: "Walls, mechanicals and cellars add gross area. Halls, lobby and core come out of what you can sell or rent.", fields: ["zfaToGrossFactor", "zfaToNetEfficiency"] },
  { id: "returns", short: "Target returns", title: "What returns do you need?", line: "Arosa calls a site a good deal when the land price still leaves you these returns.", fields: ["goodDealCapRate", "goodDealCondoMargin"] },
  { id: "review", short: "Review", title: "Your numbers", line: "You can change these any time from the listings page.", fields: [] },
];

const round = (n, digits) => Number(Number(n).toFixed(digits));

// Starting values in view units: house costs for everything except hard costs, which start empty.
export function initialValues(baseline) {
  const values = {};
  for (const [key, field] of Object.entries(FIELDS)) values[key] = HARD_COST_KEYS.includes(key) ? null : field.toView(baseline[key]);
  return values;
}

export function fieldError(key, value) {
  const field = FIELDS[key];
  if (value === null || value === "" || !Number.isFinite(Number(value))) return HARD_COST_KEYS.includes(key) ? `Enter your ${key.startsWith("condo") ? "condo" : "rental"} hard cost to continue.` : "Enter a number.";
  const n = Number(value);
  if (n < field.min || n > field.max) return `Use a value from ${field.min.toLocaleString("en-US")} to ${field.max.toLocaleString("en-US")}.`;
  return null;
}

export const stepErrors = (step, values) => Object.fromEntries(step.fields.map(key => [key, fieldError(key, values[key])]).filter(([, error]) => error));

// What one square foot of zoning floor area costs to deliver, before height-class and narrow-lot
// adjustments: hard cost on the gross area, then soft costs, then financing and carry. The stack is
// the rental building's; the condo building's is alongside it.
export function costStack(values) {
  const field = key => (fieldError(key, values[key]) ? null : FIELDS[key].toStore(Number(values[key])));
  const rentalHard = field("rentalHardCostPerGrossSqft"), condoHard = field("condoHardCostPerGrossSqft"), gross = field("zfaToGrossFactor"), soft = field("softCostPctOfHard"), carry = field("carryAndFinancingPct");
  if (rentalHard === null || condoHard === null || gross === null || soft === null || carry === null) return null;
  const stackFor = hard => {
    const hardPart = hard * gross, softPart = hardPart * soft, carryPart = (hardPart + softPart) * carry;
    return { hard: Math.round(hardPart), soft: Math.round(softPart), carry: Math.round(carryPart), total: Math.round(hardPart + softPart + carryPart) };
  };
  const rental = stackFor(rentalHard);
  return { ...rental, rental, condo: stackFor(condoHard) };
}

// Deal settings to save. The great and bad thresholds keep their spacing around the good one.
export function toDealSettings(values, baseline) {
  const settings = { ...baseline };
  for (const [key, field] of Object.entries(FIELDS)) settings[key] = field.toStore(Number(values[key]));
  // The pre-split single hard cost reads back as the rental figure for older consumers.
  settings.hardCostPerGrossSqft = settings.rentalHardCostPerGrossSqft;
  const shift = (good, great, bad, min, max) => {
    const delta = settings[good] - baseline[good];
    settings[great] = round(Math.min(max, Math.max(min, baseline[great] + delta)), 4);
    settings[bad] = round(Math.min(max, Math.max(min, baseline[bad] + delta)), 4);
  };
  shift("goodDealCapRate", "greatDealCapRate", "badDealCapRate", 0.02, 0.2);
  shift("goodDealCondoMargin", "greatDealCondoMargin", "badDealCondoMargin", 0.02, 0.6);
  return settings;
}
