/**
 * Words that mean "a kitchen appliance we sell". The Appliance category is much wider than hobs, chimneys and
 * dishwashers — the catalogue also holds coffee machines, wine chillers, ovens, microwaves, refrigerators, ice
 * makers and small appliances (kettles, toasters, blenders, air fryers…). Intent detection used to know only the
 * first three, so a shopper asking for a coffee machine was told "we don't carry that".
 *
 * Kept deliberately specific: "mixer" alone is NOT here (mixer taps are faucets), only "stand/hand mixer" and
 * "mixer grinder".
 */
const SUBTYPES = [
  "hobs?", "cooktops?", "burners?", "chimneys?", "(?:cooker\\s+)?hoods?", "dishwashers?",
  "coffee", "espresso", "cappuccino",
  "wine\\s+(?:chillers?|coolers?|cellars?|fridges?)", "beverage\\s+coolers?",
  "micro\\s*waves?", "ovens?", "refrigerators?", "fridges?", "freezers?",
  "kettles?", "toasters?", "blenders?", "juicers?", "(?:stand|hand)\\s+mixers?", "mixer\\s+grinders?",
  "food\\s+processors?", "air\\s*fryers?", "fryers?", "rice\\s+cookers?", "slow\\s+cookers?",
  "cooking\\s+(?:pots?|ranges?)", "ice\\s*makers?", "(?:milk\\s+)?frothers?",
  "humidors?", "cigars?", "barbecues?", "bbq", "grills?", "warming\\s+drawers?",
];

/** A specific appliance type (not the generic word "appliance"). */
export const APPLIANCE_SUBTYPE_PATTERN = new RegExp(`\\b(?:${SUBTYPES.join("|")})\\b`, "i");

/** Any appliance wording, including the generic "appliance(s)". */
export const APPLIANCE_ANY_PATTERN = new RegExp(`\\b(?:${SUBTYPES.join("|")}|appliances?)\\b`, "i");
