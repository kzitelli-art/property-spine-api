'use strict';

/**
 * Example mount for server.js.
 *
 * IMPORTANT: adapt only the import path / function name for your existing
 * leasing_scheduling.js module. This adapter should call the existing scheduling
 * service; it must not bypass it with direct INSERTs into scheduled_tours.
 */

const express = require('express');
const {
  createGraphClient,
  createOutlookAcuityRouter,
  createOutlookAcuitySync,
  createPostgresSyncStore,
} = require('./outlook_acuity_sync');
// The seam translates the adapter's envelope into the canonical scheduling
// service's input shape (event_type + occurrences[]) and calls it in a
// transaction. The adapter never inserts canonical tours directly — 048 owns
// source-event → scheduled-tour projection.
const { ingestSchedulingSourceEvent } = require('./scheduling_adapter_seam');

function mountOutlookAcuityAdapter({ app, pool, logger = console }) {
  const graphClient = createGraphClient({
    tenantId: process.env.OUTLOOK_GRAPH_TENANT_ID,
    clientId: process.env.OUTLOOK_GRAPH_CLIENT_ID,
    clientSecret: process.env.OUTLOOK_GRAPH_CLIENT_SECRET,
    logger,
  });

  const syncStore = createPostgresSyncStore({ pool });
  const sync = createOutlookAcuitySync({
    graphClient,
    syncStore,
    // Match this wrapper to the real Slice-2 export. The adapter never inserts
    // canonical tours directly; 048 owns source-event → scheduled-tour projection.
    ingestSourceEvent: (envelope, context) => ingestSchedulingSourceEvent({
      pool,
      envelope,
      context,
      logger,
    }),
    config: {
      integrationKey: process.env.OUTLOOK_ACUITY_INTEGRATION_KEY || 'outlook_acuity_skyline',
      mailboxAddress: process.env.OUTLOOK_ACUITY_MAILBOX,
      folderId: process.env.OUTLOOK_ACUITY_FOLDER_ID,
      initialSyncAfter: process.env.OUTLOOK_ACUITY_INITIAL_SYNC_AFTER || null,
      allowedSenderDomains: String(process.env.OUTLOOK_ACUITY_ALLOWED_SENDER_DOMAINS || 'acuityscheduling.com,squarespacescheduling.com')
        .split(',').map((value) => value.trim()).filter(Boolean),
    },
    logger,
  });

  app.use('/internal/integrations/outlook-acuity', createOutlookAcuityRouter({
    express,
    sync,
    syncStore,
    integrationKey: process.env.OUTLOOK_ACUITY_INTEGRATION_KEY || 'outlook_acuity_skyline',
    integrationSecret: process.env.OUTLOOK_ACUITY_SYNC_SECRET,
  }));

  return sync;
}

module.exports = { mountOutlookAcuityAdapter };
