"use strict";

const CAPABILITY_NAMES = Object.freeze([
  "retrieval", "comparison", "causal_explanation",
]);

function requiredString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
}

function exact(value, keys, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    throw new TypeError(`${path} must declare exactly ${expected.join(", ")}`);
  }
}

function retrievalOnly(basis) {
  requiredString(basis, "retrieval basis");
  return Object.freeze({
    retrieval: Object.freeze({ claim: "claimed", basis }),
    comparison: Object.freeze({ claim: "not_claimed", basis: null }),
    causal_explanation: Object.freeze({ claim: "not_claimed", basis: null }),
  });
}

function validate(value, path = "capability_classes") {
  exact(value, CAPABILITY_NAMES, path);
  for (const name of CAPABILITY_NAMES) {
    exact(value[name], ["claim", "basis"], `${path}.${name}`);
    if (!["claimed", "not_claimed"].includes(value[name].claim)) {
      throw new TypeError(`${path}.${name}.claim is not allowed`);
    }
    if (value[name].claim === "claimed") requiredString(value[name].basis, `${path}.${name}.basis`);
    else if (value[name].basis !== null) {
      throw new TypeError(`${path}.${name}.basis must be null when unclaimed`);
    }
  }
  return value;
}

module.exports = { CAPABILITY_NAMES, retrievalOnly, validate };
