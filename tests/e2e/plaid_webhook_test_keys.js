"use strict";

const TRUSTED_KID = "e2e-plaid-webhook-key";
const TRUSTED_PUBLIC = Object.freeze({
  kty: "EC", x: "9NS1L0luTq6Ga0DE1DQzdtG8TFMaWX7Iymr3MryWtvs",
  y: "enHuVLHR3kFbHDLHHJiUDBooFm45K_XEn5J885Hi3Bg", crv: "P-256",
});
const TRUSTED_PRIVATE = Object.freeze({
  ...TRUSTED_PUBLIC, d: "zuvbrflwMVT1J4ZVZrr_3wc5epkSYtion7NGsXVkBcc",
});
const WRONG_PRIVATE = Object.freeze({
  kty: "EC", x: "OQrjX36Q3aPdy2tTrGd8LjOZwJieVAHp00aJ7ncQBbw",
  y: "eqysIzk4kCrkcVy6I9BpRndH7SE2ObZyAR3x0SQ7aFg", crv: "P-256",
  d: "WBA9ZPArTmtwvv4ehpzUJgv46GG-08seoeTpDOTEVeM",
});

module.exports = { TRUSTED_KID, TRUSTED_PUBLIC, TRUSTED_PRIVATE, WRONG_PRIVATE };
