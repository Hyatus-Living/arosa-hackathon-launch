"""A 200 by 330 ft Lower Manhattan lot (120 Broadway proportions) under a C5-5-style envelope: a six-storey
base on the full lot (retail at grade, office above), a 15-storey residential tower of 80 by 230 ft set back
50 ft from every street line at 28 percent lot coverage (ZR 33-451 allows 40 percent), and one below-grade
parking level. FAR 15 per ZR 33-122. Writes planning/out/{concept.pascal.json, concept.ifc, takeoffs.json}.
"""
import json
import os
from collections import Counter

import ifcopenshell

from engine import Rules, Storey, UnitType, plan
from exporters import ifc, pascal

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
LOT = [[0, 0], [200, 0], [200, 330], [0, 330]]
TOWER = [[60, 50], [140, 50], [140, 280], [60, 280]]
MIX = [UnitType('studio', 0.20, 450), UnitType('1br', 0.45, 650), UnitType('2br', 0.25, 950), UnitType('3br', 0.10, 1250)]
STOREYS = [
    Storey('Cellar parking', 'parking', LOT, 10, below_grade=True),
    Storey('Ground retail', 'retail', LOT, 15),
    Storey('Office', 'office', LOT, 12.5, count=5),
    Storey('Residential', 'residential', TOWER, 10.5, count=15),
]

if __name__ == '__main__':
    plans, takeoffs = plan(LOT, STOREYS, MIX, Rules())
    os.makedirs(OUT, exist_ok=True)
    with open(f'{OUT}/takeoffs.json', 'w') as handle:
        json.dump(takeoffs, handle, indent=1)
    summary = 'Six-storey full-lot base with a 15-storey residential tower at 28 percent coverage (ZR 33-451 allows 40 percent); FAR 15 per ZR 33-122.'
    pascal.write(f'{OUT}/concept.pascal.json', pascal.concept_args('C5-5 tower over base', summary, LOT, plans, max_far=15))
    ifc.write(f'{OUT}/concept.ifc', 'Acres planning spike', LOT, plans)
    print(json.dumps({k: v for k, v in takeoffs.items() if k != 'storeys'}, indent=1))
    model = ifcopenshell.open(f'{OUT}/concept.ifc')
    counts = Counter(e.is_a() for e in model)
    print('IFC schema', model.schema, 'entities', sum(counts.values()), {k: counts[k] for k in ('IfcSite', 'IfcBuilding', 'IfcBuildingStorey', 'IfcSpace', 'IfcSlab', 'IfcWall')})
    for name in sorted(os.listdir(OUT)):
        print(f'{name}: {os.path.getsize(f"{OUT}/{name}") / 1024:.0f} KB')
