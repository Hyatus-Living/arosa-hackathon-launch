---
name: keep-building
description: Underwriting the purchase of a building as it stands instead of building new (hold it, renovate and rent it, or renovate and sell it) with sourced rents, comparable sales, the current tax bill and a stated renovation budget, run as code by acres_keep_building. Load for "buy and hold", "rental property", "value-add", "renovate", "flip", "what should I offer", "does it cash flow", or any buy question where the user is not planning to develop.
---

# Keeping the building

Most buyers do not knock the building down. When the user asks whether to buy, what to offer, or whether a property cash flows, and does not ask what could be built, the question is what the building is worth kept: held as it stands, renovated and rented, or renovated and sold. A development residual that finds "no land value" answers a different question; say which question each figure answers. A full underwriting runs both lenses, and the site page shows them side by side under "Should you buy it".

## Inputs and where they come from
- **Price.** The user's offer, the contract price, or the asking price, in that order. When the site's assumptions hold a land price, that is the user's price for the whole property: use it.
- **Building.** Omit `building` to use the subject's PLUTO gross area, residential units and commercial area. A listing's interior area differs from the city's gross area; keep rents and values per sq ft on the same basis as the area they multiply, and say which.
- **Rent as it stands.** A rent roll from the user, the offering memorandum or the listing (mark rent-stabilized or controlled units `regulated`), or else comparable rentals in similar condition from `acres_market_comps`, per rentable sq ft per month. New-construction rents overstate an old building's income; do not use them for the as-is rent. Rent-stabilized registrations in the records digest and the deal store's count tell you a building has regulated units even when the listing does not.
- **Renovated rent and sale price.** Comparable rentals and closed sales of renovated buildings of the same kind nearby (`acres_market_comps`, the listing's own comps, ACRIS deeds on the block in `acres_development_ledger`). Give the statistic you took and the comparables behind it as `basis`. The upper part of a sale range is not a renovated value unless the comparables are renovated.
- **What standing buildings sell for.** `valuation.asIsValuePerSqft` from closed sales of the same kind of building nearby: this is what a buyer who lives there pays, and for one to three family houses it usually sets the price more than rent does.
- **Taxes.** `taxSource: "ledger"` reads the current DOF bill (assessed value × class rate) in NYC; otherwise the tax line from the listing or the user, with its basis.
- **Renovation.** The user's or a contractor's budget for a stated scope, or a planning figure per sq ft labeled as one. Put repairs for open HPD and DOB violations from the records digest in the scope: they run with the property and must be cured.
- **Cap rate and financing.** The market cap rate for this kind of building is the user's or a labeled planning figure; financing, vacancy, operating costs, contingency and targets default to planning assumptions the result lists in `inputs.assumed`. Replace any the user states.

## Reading the result
- Each way gives its highest price at its target (cap rate on all-in cost to hold, yield on all-in cost to renovate and rent, return on all-in cost to sell), the call against the price, and the same under the joint downside. The decision names the way that pays the most for the building; report it from `decision.verdict`, never from hand arithmetic.
- A hold whose debt coverage is under the lender's ask needs a smaller loan (`loanAtTargetCoverage`); say so rather than calling the deal dead.
- Rent-regulated units keep their rent after the work; a renovated sale price assumes delivery the regulated tenants usually prevent. With regulated units, the renovate-and-sell figure is an upper bound: say it.
- The analysis is year one and on total cost, not an IRR. Taxes stay at the current bill; a building of four or more units is reassessed on its income, so higher rents raise taxes over time.
- When the user changes a number on the site page, the saved analysis is repriced in code from this run's inputs. Read `inputs` before answering a follow-up, and run the tool again when the evidence itself (rents, comparables, scope) changes.

## Floor plans and the layout
Listings for small buildings often carry floor plans. When the question is what the space can become (adding a unit, reconfiguring a floor), find and draft the existing plan with the `floor-plans` skill before pricing the renovation, so the budget and the renovated rent rest on the layout the user will see.
