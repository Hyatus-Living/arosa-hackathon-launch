#!/usr/bin/env python3
"""
Bridge for ZacharyHampton/HomeHarvest (https://github.com/ZacharyHampton/HomeHarvest).
Reads JSON parameters from stdin and returns normalized MLS/Realtor.com property
comparables plus per-bedroom $/sqft, observed closed-sale counts and listing age,
coordinates, and incremental sync payloads for the Acres MarketStore. Listing agent
contact details and vendor AVM figures are deliberately not returned.
"""
import json
import re
import statistics
import sys
from datetime import datetime, timezone

def safe_num(val):
    if val is None or isinstance(val, bool):
        return None
    try:
        f = float(val)
        return f if f == f else None
    except (ValueError, TypeError):
        return None

def safe_int(val):
    n = safe_num(val)
    return int(round(n)) if n is not None else None

def median_or_none(vals, digits=2):
    clean = [v for v in vals if v is not None and v > 0]
    if not clean:
        return None
    return round(float(statistics.median(clean)), digits)

def parse_date(val):
    if not val:
        return None
    s = str(val).strip()[:10]
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except Exception:
        return None

TYPICAL_RENTAL_SQFT = {0: 475, 1: 675, 2: 950, 3: 1250}

def compute_dom(raw, listing_kind, today_date):
    dom = safe_int(raw.get("days_on_mls"))
    if dom is not None and 0 < dom <= 730:
        return dom
    list_dt = parse_date(raw.get("list_date"))
    if not list_dt:
        return None
    if listing_kind == "sold":
        pend_dt = parse_date(raw.get("pending_date"))
        if pend_dt and 0 < (pend_dt - list_dt).days <= 730:
            return (pend_dt - list_dt).days
        sold_dt = parse_date(raw.get("last_sold_date"))
        if sold_dt and 0 < (sold_dt - list_dt).days <= 730:
            return (sold_dt - list_dt).days
    else:
        diff = (today_date - list_dt).days
        if 0 < diff <= 730:
            return diff
    return None

def extract_details_metadata(details_list):
    meta = {"annualTax": None, "frontageFt": None, "neighborhood": None, "subtype": None}
    if not isinstance(details_list, list):
        return meta
    for block in details_list:
        if not isinstance(block, dict):
            continue
        texts = block.get("text")
        if not isinstance(texts, list):
            continue
        for line in texts:
            s = str(line or "").strip()
            if s.startswith("Annual Tax Amount:"):
                meta["annualTax"] = safe_num(re.sub(r"[^0-9.]", "", s.split(":", 1)[1]))
            elif s.startswith("Frontage Length:"):
                meta["frontageFt"] = safe_num(re.sub(r"[^0-9.]", "", s.split(":", 1)[1]))
            elif s.startswith("Source Neighborhood:") and not meta["neighborhood"]:
                meta["neighborhood"] = s.split(":", 1)[1].strip() or None
            elif s.startswith("Property Subtype:") and not meta["subtype"]:
                meta["subtype"] = s.split(":", 1)[1].strip() or None
    return meta

def avm_available(raw):
    # Vendor AVM figures are not stored; only whether the listing carried one.
    estimates = raw.get("current_estimates")
    if isinstance(estimates, list) and any(isinstance(e, dict) and safe_num(e.get("estimate")) for e in estimates):
        return True
    return safe_num(raw.get("estimated_value")) is not None

# An asking price under this share of the listing's own estimate is almost always a placeholder, a
# partial interest or a price for something other than the whole lot.
PRICE_UNDER_ESTIMATE_SHARE = 0.20

def price_far_below_estimate(raw, list_price):
    # Compared here so only the yes/no result is stored, never the vendor figure.
    estimates = [safe_num(e.get("estimate")) for e in raw.get("current_estimates") or [] if isinstance(e, dict)]
    estimate = next((e for e in estimates if e), None) or safe_num(raw.get("estimated_value"))
    if not estimate or not list_price:
        return None
    return list_price < PRICE_UNDER_ESTIMATE_SHARE * estimate

def extract_rows(raw, listing_kind, today_date):
    if not isinstance(raw, dict):
        return []
    desc = raw.get("description") if isinstance(raw.get("description"), dict) else {}
    loc_obj = raw.get("location") if isinstance(raw.get("location"), dict) else {}
    addr = (
        loc_obj.get("address")
        if isinstance(loc_obj.get("address"), dict)
        else (raw.get("address") if isinstance(raw.get("address"), dict) else {})
    )
    coord = addr.get("coordinate") if isinstance(addr.get("coordinate"), dict) else {}
    county_obj = loc_obj.get("county") if isinstance(loc_obj.get("county"), dict) else {}

    line = addr.get("line") or raw.get("full_street_line") or raw.get("street") or ""
    unit_str = addr.get("unit") or ""
    formatted_addr = (
        addr.get("formatted_address")
        or raw.get("formatted_address")
        or (f"{line} {unit_str}".strip() if line else "")
    )
    street_number = addr.get("street_number") or None
    street_name = addr.get("street_name") or None
    street_suffix = addr.get("street_suffix") or None
    city = addr.get("city") or raw.get("city") or None
    state = addr.get("state_code") or addr.get("state") or raw.get("state") or None
    zip_code = addr.get("postal_code") or raw.get("zip_code") or None
    lat = safe_num(coord.get("lat") if coord else raw.get("latitude"))
    lon = safe_num(coord.get("lon") if coord else raw.get("longitude"))
    county = county_obj.get("name") or raw.get("county") or None
    fips_code = county_obj.get("fips_code") or raw.get("fips_code") or None

    url = raw.get("href") or raw.get("property_url") or raw.get("permalink") or None
    if url and not str(url).startswith("http"):
        url = f"https://www.realtor.com/realestateandhomes-detail/{str(url).lstrip('/')}"

    primary_photo = raw.get("primary_photo") if isinstance(raw.get("primary_photo"), dict) else {}
    photo_url = primary_photo.get("href") or None

    property_id = str(raw.get("property_id") or "").strip() or None
    listing_id = str(raw.get("listing_id") or "").strip() or None
    mls_status = raw.get("mls_status") or raw.get("status") or None

    days_on_mls = compute_dom(raw, listing_kind, today_date)
    list_date = str(raw.get("list_date") or "")[:10] or None
    pending_date = str(raw.get("pending_date") or "")[:10] or None
    sold_date = str(raw.get("last_sold_date") or "")[:10] or None
    last_update_date = str(raw.get("last_update_date") or raw.get("last_status_change_date") or "") or None
    year_built = safe_int(desc.get("year_built") if desc else raw.get("year_built"))
    stories = safe_int(desc.get("stories") if desc else raw.get("stories"))
    lot_sqft = safe_int(desc.get("lot_sqft") if desc else raw.get("lot_sqft"))
    style = (desc.get("type") if desc else None) or raw.get("style") or None

    detail_meta = extract_details_metadata(raw.get("details"))
    has_avm = avm_available(raw)

    # Expand multi-unit rental buildings when `units` array is present
    units_list = raw.get("units")
    if listing_kind == "for_rent" and isinstance(units_list, list) and len(units_list) > 0:
        out_units = []
        for idx, u in enumerate(units_list[:12]):
            if not isinstance(u, dict):
                continue
            udesc = u.get("description") if isinstance(u.get("description"), dict) else {}
            ubeds = safe_int(udesc.get("beds"))
            ubaths = safe_num(udesc.get("baths_consolidated") or udesc.get("baths"))
            usqft = safe_int(udesc.get("sqft"))
            if usqft is not None and usqft < 180:
                usqft = None
            uprice = safe_num(u.get("list_price"))
            if uprice is None or ubeds is None:
                continue
            eff_sqft = usqft or TYPICAL_RENTAL_SQFT.get(min(max(ubeds, 0), 3), 750)
            rent_psf = None
            if eff_sqft and eff_sqft > 0:
                cand = uprice / eff_sqft
                if 0.5 <= cand <= 35:
                    rent_psf = round(cand, 2)
            unit_prop_id = f"{property_id}:u{idx + 1}" if property_id else None
            out_units.append({
                "propertyId": unit_prop_id,
                "listingId": listing_id,
                "listingType": "for_rent",
                "mlsStatus": mls_status,
                "address": f"{formatted_addr} (Unit #{idx + 1})".strip() if formatted_addr else None,
                "streetLine": line or None,
                "streetNumber": street_number,
                "streetName": street_name,
                "streetSuffix": street_suffix,
                "unit": f"Unit #{idx + 1}",
                "city": city,
                "state": state,
                "zipCode": zip_code,
                "county": county,
                "fipsCode": fips_code,
                "latitude": lat,
                "longitude": lon,
                "url": url,
                "photoUrl": photo_url,
                "style": str(style).lower() if style else "apartment",
                "assetClass": "condo_coop_apartment",
                "isDevelopmentCandidate": False,
                "beds": ubeds,
                "baths": ubaths,
                "sqft": usqft,
                "sqftEstimated": usqft is None,
                "lotSqft": lot_sqft,
                "frontageFt": detail_meta["frontageFt"],
                "yearBuilt": year_built,
                "stories": stories,
                "listPrice": uprice,
                "soldPrice": None,
                "pricePerSqft": None,
                "rentPerSqftPerMonth": rent_psf,
                "annualTax": detail_meta["annualTax"],
                "neighborhood": detail_meta["neighborhood"],
                "daysOnMls": days_on_mls,
                "listDate": list_date,
                "pendingDate": pending_date,
                "soldDate": None,
                "lastUpdateDate": last_update_date,
                "avmAvailable": has_avm,
            })
        if out_units:
            return out_units

    beds = safe_int(desc.get("beds") if desc else raw.get("beds"))
    baths_full = safe_num(desc.get("baths_full"))
    baths_half = safe_num(desc.get("baths_half"))
    baths = safe_num(
        desc.get("baths_consolidated")
        or desc.get("baths")
        or (baths_full + 0.5 * (baths_half or 0) if baths_full is not None else None)
        or raw.get("full_baths")
    )
    sqft = safe_int(desc.get("sqft") if desc else raw.get("sqft"))
    if sqft is not None and sqft < 150:
        sqft = None

    list_price = safe_num(raw.get("list_price") or raw.get("list_price_min"))
    sold_price = safe_num(raw.get("sold_price") or raw.get("last_sold_price")) if listing_kind == "sold" else None

    price = sold_price if listing_kind == "sold" and sold_price else list_price
    prc_sqft = safe_num(raw.get("price_per_sqft") or raw.get("prc_sqft"))
    if prc_sqft is None and price and sqft and sqft > 0:
        prc_sqft = round(price / sqft, 2)

    rent_psf = None
    sqft_estimated = False
    if listing_kind == "for_rent" and list_price:
        eff_sqft = sqft
        if not eff_sqft and beds is not None:
            eff_sqft = TYPICAL_RENTAL_SQFT.get(min(max(beds, 0), 3), 750)
            sqft_estimated = True
        if eff_sqft and eff_sqft > 0:
            cand = list_price / eff_sqft
            if 0.5 <= cand <= 35:
                rent_psf = round(cand, 2)

    style_norm = str(style).lower().strip() if style else ""
    has_unit = bool(unit_str and str(unit_str).strip()) or any(
        tok in (formatted_addr or "").lower() for tok in (" apt ", " unit ", "#", " ph", " fl ")
    )
    if style_norm in ("land", "farm") and not has_unit:
        asset_class = "land_development"
    elif style_norm in ("condos", "condo", "coop", "co_op", "co-op", "apartment") or has_unit:
        asset_class = "condo_coop_apartment"
    elif style_norm in ("single_family", "townhomes", "townhouse", "multi_family", "duplex_triplex", "building", "commercial", "investment"):
        asset_class = "townhouse_single_family"
    elif "condo" in style_norm or "coop" in style_norm or "apart" in style_norm:
        asset_class = "condo_coop_apartment"
    else:
        asset_class = "condo_coop_apartment" if has_unit else "unknown"

    is_dev_candidate = (
        not has_unit
        and asset_class in ("land_development", "townhouse_single_family", "unknown")
        and listing_kind in ("for_sale", "pending", "sold", "off_market")
    )

    return [{
        "propertyId": property_id,
        "listingId": listing_id,
        "listingType": listing_kind,
        "mlsStatus": mls_status,
        "address": formatted_addr or None,
        "streetLine": line or None,
        "streetNumber": street_number,
        "streetName": street_name,
        "streetSuffix": street_suffix,
        "unit": unit_str or None,
        "city": city,
        "state": state,
        "zipCode": zip_code,
        "county": county,
        "fipsCode": fips_code,
        "latitude": lat,
        "longitude": lon,
        "url": url,
        "photoUrl": photo_url,
        "style": style_norm or None,
        "assetClass": asset_class,
        "isDevelopmentCandidate": is_dev_candidate,
        "beds": beds,
        "baths": baths,
        "sqft": sqft,
        "sqftEstimated": sqft_estimated,
        "lotSqft": lot_sqft,
        "frontageFt": detail_meta["frontageFt"],
        "yearBuilt": year_built,
        "stories": stories,
        "listPrice": list_price,
        "soldPrice": sold_price,
        "pricePerSqft": prc_sqft if listing_kind != "for_rent" else None,
        "rentPerSqftPerMonth": rent_psf,
        "annualTax": detail_meta["annualTax"],
        "neighborhood": detail_meta["neighborhood"],
        "daysOnMls": days_on_mls,
        "listDate": list_date,
        "pendingDate": pending_date,
        "soldDate": sold_date if listing_kind == "sold" else None,
        "lastUpdateDate": last_update_date,
        "avmAvailable": has_avm,
        "priceFarBelowEstimate": price_far_below_estimate(raw, list_price) if listing_kind == "for_sale" else None,
    }]

def fallback_locations(location, zip_code=None):
    candidates = [location]
    if zip_code and str(zip_code).strip() and str(zip_code).strip() not in candidates:
        candidates.append(str(zip_code).strip())
    return candidates

def summarize_bedroom_bucket(b, rows_subset):
    sale_rows = [
        r for r in rows_subset
        if r["listingType"] in ("sold", "for_sale")
        and ((b < 3 and r["beds"] == b) or (b == 3 and r["beds"] is not None and r["beds"] >= 3))
    ]
    sold_only = [r for r in sale_rows if r["listingType"] == "sold"]
    active_sale = [r for r in sale_rows if r["listingType"] == "for_sale"]
    condo_sale = [r for r in sale_rows if r.get("assetClass") == "condo_coop_apartment"]
    condo_sold = [r for r in sold_only if r.get("assetClass") == "condo_coop_apartment"]
    condo_sold_priced = [r for r in condo_sold if (r.get("soldPrice") or 0) > 0 and (r.get("sqft") or 0) > 0]
    th_sale = [r for r in sale_rows if r.get("assetClass") == "townhouse_single_family"]
    rent_rows = [
        r for r in rows_subset
        if r["listingType"] == "for_rent"
        and ((b < 3 and r["beds"] == b) or (b == 3 and r["beds"] is not None and r["beds"] >= 3))
    ]
    return {
        "bedrooms": b,
        "saleSampleCount": len(sale_rows),
        "closedSoldCount": len(sold_only),
        "activeForSaleCount": len(active_sale),
        "medianSalePricePerSqft": median_or_none([r["pricePerSqft"] for r in sale_rows], 0),
        "medianClosedSoldPricePerSqft": median_or_none([r["soldPrice"] / r["sqft"] for r in sold_only if (r.get("soldPrice") or 0) > 0 and (r.get("sqft") or 0) > 0], 0),
        "medianActiveAskPricePerSqft": median_or_none([r["pricePerSqft"] for r in active_sale], 0),
        "medianSalePrice": median_or_none([r["soldPrice"] if r["listingType"] == "sold" else r["listPrice"] for r in sale_rows], 0),
        "medianSaleSqft": median_or_none([r["sqft"] for r in sale_rows], 0),
        "medianSaleDaysOnMls": median_or_none([r["daysOnMls"] for r in sale_rows], 0),
        "medianClosedSoldDaysOnMls": median_or_none([r["daysOnMls"] for r in sold_only], 0),
        "condoCoopSaleSampleCount": len(condo_sale),
        "medianCondoCoopSalePricePerSqft": median_or_none([r["pricePerSqft"] for r in condo_sale], 0),
        "condoCoopClosedSoldCount": len(condo_sold),
        "condoCoopClosedSoldPriceSampleCount": len(condo_sold_priced),
        "medianCondoCoopClosedSoldPricePerSqft": median_or_none([r["soldPrice"] / r["sqft"] for r in condo_sold_priced], 0),
        "medianCondoCoopSaleDaysOnMls": median_or_none([r["daysOnMls"] for r in condo_sale], 0),
        "townhouseSingleFamilySaleSampleCount": len(th_sale),
        "medianTownhouseSingleFamilySalePricePerSqft": median_or_none([r["pricePerSqft"] for r in th_sale], 0),
        "medianTownhouseSingleFamilySaleDaysOnMls": median_or_none([r["daysOnMls"] for r in th_sale], 0),
        "rentSampleCount": len(rent_rows),
        "medianRentPerSqftPerMonth": median_or_none([r["rentPerSqftPerMonth"] for r in rent_rows], 2),
        "medianMonthlyRent": median_or_none([r["listPrice"] for r in rent_rows], 0),
        "medianRentSqft": median_or_none([r["sqft"] for r in rent_rows], 0),
        "medianRentDaysOnMls": median_or_none([r["daysOnMls"] for r in rent_rows], 0),
    }

def main():
    payload = json.loads(sys.stdin.read() or "{}")
    locations = payload.get("locations")
    location = str(payload.get("location") or "").strip()
    if not location and isinstance(locations, list) and locations:
        location = str(locations[0] or "").strip()
    if not location:
        print(json.dumps({"error": "location is required"}))
        return

    try:
        from homeharvest import scrape_property
    except Exception as exc:
        print(json.dumps({"error": f"homeharvest unavailable: {exc}"}))
        return

    listing_types = payload.get("listingTypes") or ["sold", "for_sale", "for_rent"]
    property_types = payload.get("propertyTypes") or None
    radius = safe_num(payload.get("radiusMiles"))
    past_days = safe_int(payload.get("pastDays"))
    if past_days is None and "sold" in listing_types and not payload.get("updatedSince") and not payload.get("updatedInPastHours"):
        past_days = 180
    updated_since = payload.get("updatedSince") or None
    updated_in_past_hours = safe_int(payload.get("updatedInPastHours"))
    sort_by = payload.get("sortBy") or ("last_update_date" if (updated_since or updated_in_past_hours) else None)
    sort_direction = payload.get("sortDirection") or "desc"
    extra_property_data = bool(payload.get("extraPropertyData", False))
    # Realtor.com serves at most 10,000 results per query.
    limit_per_type = max(5, min(safe_int(payload.get("limit")) or 40, 10000))
    zip_hint = payload.get("zipCode")
    today_date = datetime.now(timezone.utc).date()

    target_locations = [str(x).strip() for x in locations if str(x).strip()] if isinstance(locations, list) and locations else [location]

    all_rows = []
    errors = {}
    resolved_locations = {}

    for base_loc in target_locations:
        loc_candidates = fallback_locations(base_loc, zip_hint if len(target_locations) == 1 else None)
        for ltype in listing_types:
            type_rows = []
            for cand_idx, loc_cand in enumerate(loc_candidates):
                kwargs = {
                    "location": loc_cand,
                    "listing_type": ltype,
                    "return_type": "raw",
                    "limit": limit_per_type,
                    "extra_property_data": extra_property_data,
                }
                if property_types:
                    kwargs["property_type"] = property_types
                if radius is not None and radius > 0 and cand_idx == 0 and len(target_locations) == 1:
                    kwargs["radius"] = radius
                if ltype == "sold" and past_days:
                    kwargs["past_days"] = past_days
                elif ltype in ("for_sale", "for_rent") and past_days and payload.get("filterActiveByPastDays"):
                    kwargs["past_days"] = past_days
                if updated_since:
                    kwargs["updated_since"] = updated_since
                    kwargs["parallel"] = False
                elif updated_in_past_hours:
                    kwargs["updated_in_past_hours"] = updated_in_past_hours
                    kwargs["parallel"] = False
                if sort_by:
                    kwargs["sort_by"] = sort_by
                    kwargs["sort_direction"] = sort_direction
                try:
                    raw_list = scrape_property(**kwargs) or []
                    for item in raw_list[:limit_per_type]:
                        type_rows.extend(extract_rows(item, ltype, today_date))
                    if type_rows:
                        resolved_locations[f"{base_loc}:{ltype}" if len(target_locations) > 1 else ltype] = loc_cand
                        break
                except Exception as exc:
                    errors[f"{ltype}:{loc_cand}"] = str(exc)
            all_rows.extend(type_rows)

    by_bedrooms = {}
    for b in [0, 1, 2, 3]:
        by_bedrooms[str(b)] = summarize_bedroom_bucket(b, all_rows)

    out = {
        "location": location,
        "locations": target_locations,
        "resolvedLocationsByType": resolved_locations,
        "retrievedAt": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "totalComps": len(all_rows),
        "closedSalesWindowDays": past_days if not updated_since and not updated_in_past_hours else None,
        "byBedrooms": by_bedrooms,
        "sampleComps": all_rows[:30],
        "allRows": all_rows if payload.get("includeAllRows", True) else [],
        "errors": errors,
    }
    print(json.dumps(out))

if __name__ == "__main__":
    main()
