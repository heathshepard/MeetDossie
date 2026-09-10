'use strict';

// scripts/_lib/listing-marketing-facts.js
//
// Verified fact pack for Heath's own active-listing daily marketing
// rotation (Fawndale / Nopalito / Senisa, per Heath's instruction
// 2026-09-10). Every number here was pulled live from connectMLS
// (lera.connectmls.com) on 2026-09-10 -- see .tmp/listing-status-check/
// for the raw dumps this was built from. NEVER hand-edit price/status here;
// that's listing_marketing_status's job (kept live via
// scripts/listing-marketing-status-sync.js). This file holds the STABLE
// facts (address, sqft, renovation details, school district, compliance
// flags) that don't change day to day.
//
// Angle rotation deliberately does NOT include a fixed "milestone" slot in
// the base deck -- milestones (a real price cut, a real new photo set) are
// injected only when genuinely true that day (see MILESTONES below), never
// fabricated. Compare against listing_marketing_status.list_price live to
// detect a real price change automatically -- see listing-marketing-
// generator.js's detectMilestone().

const LISTINGS = {
  '2015607': {
    key: 'fawndale',
    address: '702 Fawndale Dr',
    city: 'Windcrest',
    zip: '78239',
    mlsNumber: '2015607',
    isAgentOwned: true, // Owner: Heath Shepard, Owner LREA/LREB: Yes (confirmed live 2026-09-10)
    propertyType: 'Single Family Detached',
    beds: 4,
    baths: '3/0',
    sqft: 2334,
    yearBuilt: 1966,
    lotAcres: 0.271,
    hoa: 'None',
    subdivision: 'Windcrest',
    schoolDistrict: 'North East I.S.D.',
    features: [
      'Fully renovated 2024 - LVP flooring, ceramic tile, fresh paint, modern cabinetry',
      'Private 4th bedroom with its own full bath and separate entrance - ideal for guest suite, office, or rental income',
      'Oversized corner-lot backyard with real pool potential',
      'No HOA',
      'VA and FHA financing welcome',
    ],
    conditionCaveat:
      'Tenant vacated Sept 2026; move-out inspection noted shower damage and a possibly cracked '
      + 'countertop. Make-ready repairs pending before showings ramp up and before new listing '
      + 'photos are taken. NEVER write "move-in ready today" or "immaculate" in any post while '
      + 'this caveat is active -- describe the 2024 renovation (permanent, already done: kitchen, '
      + 'baths, flooring), never the present-moment walk-through condition. Confirm with Heath '
      + 'whether repairs are complete before using an interior "move-in ready" framing.',
    priceCompSqft: 107, // original-condition comp tier, verified 2026-09-09 (626/709/5927 comps)
    photos: {
      bucket: 'listing-media',
      images: [
        { file: 'fawndale/fawndale-01-exterior-real-FB.jpg', label: 'exterior', staged: false },
        { file: 'fawndale/fawndale-02-kitchen-wide-real-hero-IG-FB.jpg', label: 'kitchen', staged: false },
        { file: 'fawndale/fawndale-03-kitchen-nook-real-FB-IG.jpg', label: 'kitchen_nook', staged: false },
        { file: 'fawndale/fawndale-04-primary-bath-real-FB-IG.jpg', label: 'primary_bath', staged: false },
        { file: 'fawndale/fawndale-05-living-room-VIRTUALLY-STAGED-FB-IG.jpg', label: 'living_room', staged: true },
        { file: 'fawndale/fawndale-06-primary-bedroom-VIRTUALLY-STAGED-FB-IG.jpg', label: 'primary_bedroom', staged: true },
      ],
    },
    groupVenues: ['realtors_sa_boerne_bulverde_nb', 'tx_re_agents_statewide', 'tx_real_estate_statewide'],
  },
  '1916402': {
    key: 'nopalito',
    address: '23 Nopalito',
    city: 'San Antonio',
    zip: '78261',
    mlsNumber: '1916402',
    isAgentOwned: false, // Owner: Whyte Barry Jennifer Ann (confirmed live 2026-09-10)
    propertyType: 'Single Family Detached',
    beds: 4,
    baths: '4/0',
    sqft: 4495,
    yearBuilt: 2002,
    lotAcres: 3.48,
    hoa: 'Mandatory - Sendero Ranch Owners Association, $416.25/quarter + $200 transfer',
    subdivision: 'Sendero Ranch',
    schoolDistrict: 'North East I.S.D.',
    features: [
      'Architect Joe Stubblefield custom design on 3.48 gently rolling, wooded acres',
      'Guard-gated, controlled-access community',
      'Private first-floor primary suite, separate from other bedrooms',
      'Gourmet kitchen: JennAir appliances, double oven, induction cooktop, wine cooler, walk-in pantry',
      'Keith Zars pool and spa with waterfall',
      'Guest suite / 4th bedroom above the 3-car garage with kitchenette - in-law or game room potential',
    ],
    conditionCaveat: null,
    // PRICE: DO NOT hardcode -- read live from listing_marketing_status. A signed
    // amendment dropping this to $999,000 was sent to the Whytes 2026-09-10 but is
    // NOT YET reflected in MLS as of the last sync -- MLS still shows $1,195,000.
    // Never say "$999,000" or "under a million" anywhere until MLS actually flips.
    photos: {
      bucket: 'listing-media',
      images: [
        { file: 'nopalito/nopalito-01-hero-twilight-pool-FB.jpg', label: 'pool_twilight', staged: false },
        { file: 'nopalito/nopalito-02-exterior-daytime-IG-FB.jpg', label: 'exterior', staged: false },
        { file: 'nopalito/nopalito-03-great-room-fireplace-FB-IG.jpg', label: 'great_room', staged: false },
        { file: 'nopalito/nopalito-04-kitchen-bar-FB-IG.jpg', label: 'kitchen', staged: false },
      ],
    },
    groupVenues: [
      'realtors_sa_boerne_bulverde_nb',
      'spring_branch_bulverde_social',
      'stone_oak_neighborhood',
      'tx_re_agents_statewide',
    ],
  },
  '1997664': {
    key: 'senisa',
    address: '130 Senisa Dr',
    city: 'San Antonio',
    zip: '78228',
    mlsNumber: '1997664',
    isAgentOwned: true, // Owner: Heath Shepard, Owner LREA/LREB: Yes (confirmed live 2026-09-10 -- NOT flagged in the original task brief, corrected here)
    propertyType: 'Multi-Family (2-8 Units) - Duplex',
    beds: null, // per-unit: 3bd/1ba each side
    baths: null,
    sqft: 2408,
    yearBuilt: 1950,
    lotAcres: 0.27,
    hoa: 'None',
    subdivision: 'Jefferson Terrace',
    schoolDistrict: 'San Antonio I.S.D.',
    features: [
      'Fully renovated 2021: roof, HVAC, siding, LVP flooring, cabinets, countertops, appliances',
      'Owner-occupant house-hack: FHA financing on a 2-unit primary residence, rental income from the second unit can count toward qualifying (program-dependent)',
      'Separate electric meters - tenants pay their own power',
      'One-car garage per side, private rooftop deck serves as the upstairs unit entrance',
      'Zoned RM-4 - room for up to 4 units, future upside',
    ],
    conditionCaveat:
      'Both units are currently tenant-occupied. Showings require advance notice; any buyer '
      + 'framing must note the move-in timeline depends on existing lease terms. This is an '
      + 'owner-occupant/investor pitch, not a vacant move-in-ready single-family listing -- do '
      + 'not write copy that implies otherwise.',
    priceCompSqft: null,
    photos: {
      bucket: 'listing-media',
      images: [], // NONE UPLOADED YET -- flag to Heath. No dedicated marketing photos exist
                  // beyond whatever's in the MLS listing itself (not pulled/verified here).
                  // Do not draft an image-led post for Senisa until real photos exist.
    },
    groupVenues: ['realtors_sa_boerne_bulverde_nb', 'tx_re_agents_statewide', 'tx_real_estate_statewide'],
  },
};

// Tier-2 FB Group venues, from .tmp/nopalito-launch-2026-09-10/VENUE-PLAN.md
// (Heath's approved list, 2026-09-10). Only groups with a confirmed URL and
// no structural/rules blocker are listed. Shift Talk SA and the unconfirmed
// Windcrest Texas FYI page are deliberately excluded (see VENUE-PLAN.md).
const GROUP_VENUES = {
  realtors_sa_boerne_bulverde_nb: {
    name: 'Realtors San Antonio, Boerne, Bulverde, New Braunfels',
    url: 'https://www.facebook.com/groups/752142151598217',
    audience: 'agent-to-agent',
  },
  tx_re_agents_statewide: {
    name: 'Texas Real Estate Agents',
    url: 'https://www.facebook.com/groups/texasusarealestateagents/',
    audience: 'agent-to-agent',
  },
  tx_real_estate_statewide: {
    name: 'Texas Real Estate',
    url: null, // URL not captured in VENUE-PLAN.md -- confirm before first live send
    audience: 'agent-to-agent',
  },
  spring_branch_bulverde_social: {
    name: 'Spring Branch Bulverde Social Network',
    url: 'https://www.facebook.com/groups/springbranch/',
    audience: 'consumer',
  },
  stone_oak_neighborhood: {
    name: 'Stone Oak Neighborhood - San Antonio, Texas',
    url: 'https://www.facebook.com/groups/14695971124/',
    audience: 'consumer',
  },
};

// Angle rotation deck. 'milestone' is injected by the generator only when a
// real one exists that day (see listing-marketing-generator.js) -- it is
// NEVER a static deck entry a listing can draw without a real trigger.
const ANGLES = [
  'room_feature',
  'price_value',
  'neighborhood_lifestyle',
  'buyer_fit',
  'agent_to_agent',
  'showing_availability',
];

const TREC_ATTRIBUTION = 'Heath Shepard, REALTOR (R) | Keller Williams City View | TX Lic #751964';

const OWNER_DISCLOSURE = 'Seller/Owner is a licensed Texas real estate broker/sales agent.';

module.exports = { LISTINGS, GROUP_VENUES, ANGLES, TREC_ATTRIBUTION, OWNER_DISCLOSURE };
