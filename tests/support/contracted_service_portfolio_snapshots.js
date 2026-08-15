"use strict";

function review(propertyId, sourceArtifactId, note) {
  return [{
    id: `${propertyId}-review`, property_id: propertyId, reviewed_as_of: "2026-08-14",
    source_artifact_id: sourceArtifactId, provenance_note: note,
    recorded_at: "2026-08-14T12:00:00Z",
  }];
}

function empty(propertyId) {
  return {
    property_id: propertyId,
    coverage_reviews: [], requirements: [], providers: [], engagements: [], documents: [],
    terms: [], scopes: [], locations: [], prices: [], financial_observations: [],
    decision_links: [], obligations: [], users: [],
  };
}

function solo4125() {
  const propertyId = "solo-4125";
  const snapshot = empty(propertyId);
  snapshot.coverage_reviews = review(propertyId, "solo-folder-review",
    "Reviewed the Contracts and Third Party Agreements folders and the June 2026 reporting package.");
  snapshot.requirements = [
    { id: "solo-req-print", property_id: propertyId, service_class: "other",
      service_label: "Resident printing amenity", determination: "contracted_service_required",
      effective_from: "2021-11-11", basis: "Executed PrintWithMe agreement." },
    { id: "solo-req-pest", property_id: propertyId, service_class: "pest_control",
      determination: "contracted_service_required", effective_from: "2022-11-07",
      basis: "Executed Ehrlich service agreement." },
  ];
  snapshot.providers = [
    { id: "solo-provider-print", provider_name: "PrintWithMe, LLC" },
    { id: "solo-provider-ehrlich", provider_name: "Ehrlich Pest Control" },
    { id: "solo-provider-patriot", provider_name: "Patriot Pest Solutions" },
    { id: "solo-provider-trash", provider_name: "Philly-wide Disposal Co" },
    { id: "solo-provider-otis", provider_name: "Otis Elevator Company" },
  ];
  snapshot.engagements = [
    { id: "solo-eng-print", property_id: propertyId, service_class: "other",
      service_label: "Resident printing amenity", provider_id: "solo-provider-print",
      engagement_label: "First-floor resident printer", effective_from: "2021-11-11" },
    { id: "solo-eng-pest", property_id: propertyId, service_class: "pest_control",
      provider_id: "solo-provider-ehrlich", engagement_label: "Interior pest program",
      effective_from: "2022-11-07" },
  ];
  snapshot.documents = [
    { id: "solo-doc-print", property_id: propertyId, engagement_id: "solo-eng-print",
      source_artifact_id: "solo-printwithme-2021", document_kind: "agreement",
      execution_state: "executed", document_date: "2021-11-11",
      filename: "PWM_-__OneFive_-_Solo_On_Chestnut.docx_(2).pdf" },
    { id: "solo-doc-pest", property_id: propertyId, engagement_id: "solo-eng-pest",
      source_artifact_id: "solo-ehrlich-2022", document_kind: "agreement",
      execution_state: "executed", document_date: "2022-11-10",
      named_effective_date: "2022-11-07", filename: "4125 Erlich Contract - Pest Control" },
    { id: "solo-doc-otis-proposal", property_id: propertyId, engagement_id: null,
      source_artifact_id: "solo-otis-2020", document_kind: "proposal",
      execution_state: "unsigned", document_date: "2020-08-12",
      filename: "4125 Chestnut - Otis - unexecuted.pdf" },
    { id: "solo-doc-generator-proposal", property_id: propertyId, engagement_id: null,
      source_artifact_id: "solo-generator-2023", document_kind: "proposal",
      execution_state: "unsigned", document_date: "2023-01-12",
      filename: "Generator.pdf" },
  ];
  snapshot.terms = [
    { id: "solo-term-print", property_id: propertyId, engagement_id: "solo-eng-print",
      document_id: "solo-doc-print", term_authority: "governing",
      commencement_date: null,
      commencement_trigger: "Installation and activation of the printer amenity",
      initial_end_date: null, initial_term_months: 12, term_kind: "fixed",
      automatic_renewal: true, renewal_period_months: 12, notice_days: 30,
      recorded_at: "2021-11-11T17:09:19Z" },
    { id: "solo-term-pest", property_id: propertyId, engagement_id: "solo-eng-pest",
      document_id: "solo-doc-pest", term_authority: "governing",
      commencement_date: "2022-11-07", initial_end_date: null, term_kind: "month_to_month",
      automatic_renewal: null, notice_days: 30, continues_until_terminated: true,
      termination_for_convenience: true, recorded_at: "2022-11-10T12:00:00Z" },
  ];
  snapshot.scopes = [
    { id: "solo-scope-print", property_id: propertyId, engagement_id: "solo-eng-print",
      term_id: "solo-term-print", effective_from: "2021-11-11",
      scope_summary: "Resident print, scan, copy, and fax amenity in the first-floor lounge.",
      frequency_summary: "Continuous amenity service", source_artifact_id: "solo-printwithme-2021" },
    { id: "solo-scope-pest", property_id: propertyId, engagement_id: "solo-eng-pest",
      term_id: "solo-term-pest", effective_from: "2022-11-07",
      scope_summary: "Interior mice, rats, cockroach, and non-wood-boring ant control.",
      frequency_summary: "Twice monthly; up to eight units per visit",
      source_artifact_id: "solo-ehrlich-2022" },
  ];
  snapshot.prices = [
    { id: "solo-price-print", property_id: propertyId, term_id: "solo-term-print",
      price_basis: "monthly", amount_cents: 19900, currency_code: "USD" },
    { id: "solo-price-pest", property_id: propertyId, term_id: "solo-term-pest",
      price_basis: "monthly", amount_cents: 19933, currency_code: "USD" },
  ];
  snapshot.financial_observations = [
    { id: "solo-obs-print", property_id: propertyId, engagement_id: "solo-eng-print",
      provider_id: "solo-provider-print", service_class: "other",
      observation_kind: "invoice", line_label: "Monthly fee for operating PrintWithMe",
      period_start: "2026-06-01", period_end: "2026-06-30", amount_cents: 23460,
      source_artifact_id: "solo-june-2026-gl" },
    { id: "solo-obs-patriot", property_id: propertyId, engagement_id: null,
      provider_id: "solo-provider-patriot", service_class: "pest_control",
      observation_kind: "accounting_line", line_label: "Bi-weekly pest service - June 2026",
      period_start: "2026-06-01", period_end: "2026-06-30", amount_cents: 35640,
      source_artifact_id: "solo-june-2026-gl" },
    { id: "solo-obs-trash", property_id: propertyId, engagement_id: null,
      provider_id: "solo-provider-trash", service_class: "waste_removal",
      observation_kind: "accounting_line", line_label: "Trash removal - June 2026",
      period_start: "2026-06-01", period_end: "2026-06-30", amount_cents: 151000,
      source_artifact_id: "solo-june-2026-gl" },
    { id: "solo-obs-otis", property_id: propertyId, engagement_id: null,
      provider_id: "solo-provider-otis", service_class: "elevator_maintenance",
      observation_kind: "accounting_line",
      line_label: "Elevator maintenance invoice; service period 09/2025-08/2026",
      period_start: "2026-06-01", period_end: "2026-06-30", amount_cents: 120189,
      source_artifact_id: "solo-june-2026-gl" },
    { id: "solo-obs-snow", property_id: propertyId, engagement_id: null,
      service_class: "snow_removal", observation_kind: "accounting_line",
      line_label: "Snow Removal Contract - 2026 YTD", period_start: "2026-01-01",
      period_end: "2026-06-30", amount_cents: 237500,
      source_artifact_id: "solo-june-2026-income-statement" },
    { id: "solo-obs-security", property_id: propertyId, engagement_id: null,
      service_class: "fire_alarm_monitoring", observation_kind: "accounting_line",
      line_label: "Security / Fire Monitoring - June 2026", period_start: "2026-06-01",
      period_end: "2026-06-30", amount_cents: 25391,
      source_artifact_id: "solo-june-2026-gl" },
  ];
  return snapshot;
}

function skyline1417() {
  const propertyId = "skyline-1417";
  const snapshot = empty(propertyId);
  snapshot.coverage_reviews = review(propertyId, "skyline-folder-review",
    "Reviewed Management Binder contracted services and June 2026 workpapers.");
  snapshot.requirements = [{ id: "skyline-req-elevator", property_id: propertyId,
    service_class: "elevator_maintenance", determination: "contracted_service_required",
    effective_from: "2025-01-01", basis: "Executed Fujitec maintenance agreement." }];
  snapshot.providers = [
    { id: "skyline-provider-fujitec", provider_name: "Fujitec America, Inc." },
    { id: "skyline-provider-clean", provider_name: "David & Daisy's Janitorial Maid Services" },
    { id: "skyline-provider-ehrlich", provider_name: "Ehrlich Pest Control" },
    { id: "skyline-provider-vital", provider_name: "Vital Security" },
    { id: "skyline-provider-oliver", provider_name: "Oliver Fire Protection & Security" },
  ];
  snapshot.engagements = [{ id: "skyline-eng-fujitec", property_id: propertyId,
    service_class: "elevator_maintenance", provider_id: "skyline-provider-fujitec",
    engagement_label: "Passenger elevator PE1", effective_from: "2024-11-11" }];
  snapshot.documents = [{ id: "skyline-doc-fujitec", property_id: propertyId,
    engagement_id: "skyline-eng-fujitec", source_artifact_id: "skyline-fujitec-2024",
    document_kind: "agreement", execution_state: "executed", document_date: "2024-11-14",
    named_effective_date: "2024-11-11",
    filename: "V2_Fujitec Maintenance _Skyline_One Five Capital (1).pdf" }];
  snapshot.terms = [{ id: "skyline-term-fujitec", property_id: propertyId,
    engagement_id: "skyline-eng-fujitec", document_id: "skyline-doc-fujitec",
    term_authority: "governing", commencement_date: "2025-01-01",
    initial_end_date: "2026-01-01", term_kind: "fixed", automatic_renewal: true,
    renewal_period_months: 60, notice_days: 90, recorded_at: "2024-11-14T12:00:00Z" }];
  snapshot.scopes = [{ id: "skyline-scope-fujitec", property_id: propertyId,
    engagement_id: "skyline-eng-fujitec", term_id: "skyline-term-fujitec",
    effective_from: "2025-01-01",
    scope_summary: "Preventive maintenance for Skyline passenger elevator PE1.",
    frequency_summary: "Quarterly", source_artifact_id: "skyline-fujitec-2024" }];
  snapshot.prices = [{ id: "skyline-price-fujitec", property_id: propertyId,
    term_id: "skyline-term-fujitec", price_basis: "monthly", amount_cents: 15000,
    currency_code: "USD", description: "Subject to annual labor-cost adjustment" }];
  snapshot.financial_observations = [
    { id: "skyline-obs-fujitec", property_id: propertyId,
      engagement_id: "skyline-eng-fujitec", provider_id: "skyline-provider-fujitec",
      service_class: "elevator_maintenance", observation_kind: "accounting_line",
      line_label: "Elevator Contract - June 2026", period_start: "2026-06-01",
      period_end: "2026-06-30", amount_cents: 17010,
      source_artifact_id: "skyline-june-2026-workpapers" },
    { id: "skyline-obs-clean", property_id: propertyId, engagement_id: null,
      provider_id: "skyline-provider-clean", service_class: "building_cleaning",
      observation_kind: "invoice", line_label: "Monthly cleaning - June 2026",
      period_start: "2026-06-01", period_end: "2026-06-30", amount_cents: 155000,
      source_artifact_id: "skyline-june-2026-workpapers" },
    { id: "skyline-obs-pest", property_id: propertyId, engagement_id: null,
      provider_id: "skyline-provider-ehrlich", service_class: "pest_control",
      observation_kind: "invoice", line_label: "Pest control maintenance - June 2026",
      period_start: "2026-06-01", period_end: "2026-06-30", amount_cents: 34662,
      source_artifact_id: "skyline-june-2026-workpapers" },
    { id: "skyline-obs-trash", property_id: propertyId, engagement_id: null,
      service_class: "waste_removal", observation_kind: "accounting_line",
      line_label: "Trash disposal - June 2026", period_start: "2026-06-01",
      period_end: "2026-06-30", amount_cents: 101000,
      source_artifact_id: "skyline-june-2026-workpapers" },
    { id: "skyline-obs-fire", property_id: propertyId, engagement_id: null,
      provider_id: "skyline-provider-oliver", service_class: "fire_sprinkler_service",
      observation_kind: "invoice", line_label: "Sprinkler service invoice",
      period_start: "2026-06-01", period_end: "2026-06-30", amount_cents: 93565,
      source_artifact_id: "skyline-june-2026-workpapers" },
    { id: "skyline-obs-security", property_id: propertyId, engagement_id: null,
      provider_id: "skyline-provider-vital", service_class: "security_concierge",
      observation_kind: "invoice", line_label: "Quarterly security billing",
      period_start: "2026-04-01", period_end: "2026-06-30", amount_cents: 32400,
      source_artifact_id: "skyline-june-2026-workpapers" },
    { id: "skyline-obs-snow", property_id: propertyId, engagement_id: null,
      service_class: "snow_removal", observation_kind: "accounting_line",
      line_label: "Snow removal - 2026 YTD", period_start: "2026-01-01",
      period_end: "2026-06-30", amount_cents: 67500,
      source_artifact_id: "skyline-june-2026-workpapers" },
  ];
  return snapshot;
}

function greenery1325() {
  const propertyId = "greenery-1325";
  const snapshot = empty(propertyId);
  snapshot.coverage_reviews = review(propertyId, "greenery-folder-review",
    "Reviewed Management Binder contracted services and June 2026 workpapers.");
  snapshot.requirements = [{ id: "greenery-req-amazon", property_id: propertyId,
    service_class: "other", service_label: "Amazon package locker",
    determination: "contracted_service_required", effective_from: "2024-06-10",
    basis: "Electronically accepted Amazon Hub amendment." }];
  snapshot.providers = [
    { id: "greenery-provider-amazon", provider_name: "Amazon.com Services LLC" },
    { id: "greenery-provider-clean", provider_name: "David & Daisy's Janitorial Maid Services" },
    { id: "greenery-provider-ehrlich", provider_name: "Ehrlich Pest Control" },
    { id: "greenery-provider-vital", provider_name: "Vital Security" },
    { id: "greenery-provider-otis", provider_name: "Otis Elevator Company" },
  ];
  snapshot.engagements = [{ id: "greenery-eng-amazon", property_id: propertyId,
    service_class: "other", service_label: "Amazon package locker",
    provider_id: "greenery-provider-amazon", engagement_label: "Resident package locker",
    effective_from: "2024-06-10" }];
  snapshot.documents = [{ id: "greenery-doc-amazon", property_id: propertyId,
    engagement_id: "greenery-eng-amazon", source_artifact_id: "greenery-amazon-2024",
    document_kind: "amendment", execution_state: "executed", document_date: "2024-06-10",
    filename: "AMAZON HUB APARTMENT LOCKER LOCATION AGREEMENT.pdf" }];
  snapshot.terms = [{ id: "greenery-term-amazon", property_id: propertyId,
    engagement_id: "greenery-eng-amazon", document_id: "greenery-doc-amazon",
    term_authority: "governing", commencement_date: null,
    commencement_trigger: "Installation and activation of the Amazon Hub at the property",
    initial_end_date: null, initial_term_months: 60,
    term_kind: "fixed", automatic_renewal: true, renewal_period_months: 60,
    notice_days: 30, recorded_at: "2024-06-10T19:43:00Z" }];
  snapshot.scopes = [{ id: "greenery-scope-amazon", property_id: propertyId,
    engagement_id: "greenery-eng-amazon", term_id: "greenery-term-amazon",
    effective_from: "2024-06-10",
    scope_summary: "Apartment package locker service, maintenance, and customer support.",
    frequency_summary: "Continuous amenity service", source_artifact_id: "greenery-amazon-2024" }];
  snapshot.prices = [{ id: "greenery-price-amazon", property_id: propertyId,
    term_id: "greenery-term-amazon", price_basis: "flat", amount_cents: 790000,
    currency_code: "USD", description: "Program fee for a five-year term" }];
  snapshot.financial_observations = [
    { id: "greenery-obs-amazon", property_id: propertyId,
      engagement_id: "greenery-eng-amazon", provider_id: "greenery-provider-amazon",
      service_class: "other", observation_kind: "accounting_line",
      line_label: "Amazon prepaid schedule 06/2024-05/2029",
      period_start: "2024-06-01", period_end: "2029-05-31", amount_cents: 837400,
      source_artifact_id: "greenery-june-2026-workpapers" },
    { id: "greenery-obs-clean", property_id: propertyId, engagement_id: null,
      provider_id: "greenery-provider-clean", service_class: "building_cleaning",
      observation_kind: "invoice", line_label: "Monthly cleaning - June 2026",
      period_start: "2026-06-01", period_end: "2026-06-30", amount_cents: 175000,
      source_artifact_id: "greenery-june-2026-workpapers" },
    { id: "greenery-obs-pest", property_id: propertyId, engagement_id: null,
      provider_id: "greenery-provider-ehrlich", service_class: "pest_control",
      observation_kind: "invoice", line_label: "Pest control maintenance - June 2026",
      period_start: "2026-06-01", period_end: "2026-06-30", amount_cents: 35702,
      source_artifact_id: "greenery-june-2026-workpapers" },
    { id: "greenery-obs-trash", property_id: propertyId, engagement_id: null,
      service_class: "waste_removal", observation_kind: "accounting_line",
      line_label: "Trash disposal - June 2026", period_start: "2026-06-01",
      period_end: "2026-06-30", amount_cents: 111000,
      source_artifact_id: "greenery-june-2026-workpapers" },
    { id: "greenery-obs-security", property_id: propertyId, engagement_id: null,
      provider_id: "greenery-provider-vital", service_class: "security_concierge",
      observation_kind: "invoice", line_label: "Quarterly security billing",
      period_start: "2026-04-01", period_end: "2026-06-30", amount_cents: 32406,
      source_artifact_id: "greenery-june-2026-workpapers" },
    { id: "greenery-obs-otis", property_id: propertyId, engagement_id: null,
      provider_id: "greenery-provider-otis", service_class: "elevator_maintenance",
      observation_kind: "accounting_line", line_label: "Elevator contract - June 2026",
      period_start: "2026-06-01", period_end: "2026-06-30", amount_cents: 101371,
      source_artifact_id: "greenery-june-2026-workpapers" },
    { id: "greenery-obs-snow", property_id: propertyId, engagement_id: null,
      service_class: "snow_removal", observation_kind: "accounting_line",
      line_label: "Snow removal - 2026 YTD", period_start: "2026-01-01",
      period_end: "2026-06-30", amount_cents: 50000,
      source_artifact_id: "greenery-june-2026-workpapers" },
  ];
  return snapshot;
}

module.exports = { solo4125, skyline1417, greenery1325 };
