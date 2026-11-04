// Steps 3 and 4 from their inputs: the program comparison with its decision, and the pro forma and
// unit mix of the program it recommends. The example generator and the site page embed both use it,
// with the research service's own calculation functions passed in.
export function decide({ computeProForma, comparePrograms }, { shared, variants, mixes }, at) {
  const comparison = comparePrograms({ shared, variants });
  const pick = variants.find((v) => v.label === comparison.recommendation.label);
  // An affordable share is priced as rents scaled across the building, as the comparison does.
  const scale = 1 - (pick.affordableShare ?? 0) * (1 - (pick.affordableRentScale ?? 1));
  const market = { ...shared.market, rents: shared.market.rents.map((r) => ({ ...r, rentPerSqftPerMonth: Math.round(r.rentPerSqftPerMonth * scale * 100) / 100 })) };
  const { market: _market, targetReturnOnCost: _target, program: _program, ...costs } = shared;
  const proForma = { ...computeProForma({ productType: pick.productType, ...costs, market, program: pick.program }), name: pick.label, createdAt: at };
  return { comparison: { ...comparison, createdAt: at }, proForma, program: mixes[pick.label] };
}
