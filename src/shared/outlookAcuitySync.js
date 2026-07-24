'use strict';

/**
 * Outlook / Acuity Scheduling adapter for Property Spine.
 *
 * Boundary:
 *   Microsoft Graph mail folder -> raw source envelope -> leasingscheduling service
 *
 * This module does NOT create conversion cases or canonical scheduled tours itself.
 * Its sole job is to deliver an idempotent, replayable source envelope to the
 * scheduling intake service created in Slice 2 / migration 048.
 *
 * Supported runtime: Node 18+ (uses built-in fetch).
 * No external Graph SDK is required. If property-spine-api standardizes on MSAL,
 * replace only createGraphClient(); the rest of the adapter stays unchanged.
 */

const crypto = require('node:crypto');

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';
const DEFAULT_INTEGRATION_KEY = 'outlook_acuity_skyline';
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_ALLOWED_DOMAINS = ['acuityscheduling.com', 'squarespacescheduling.com'];

class IntegrationError extends Error {
  constructor(message, { statusCode = 500, code = 'integration_error', cause } = {}) {
    super(message);
    this.name = 'IntegrationError';
    this.statusCode = statusCode;
    this.code = code;
    this.cause = cause;
  }
}

function assertNonEmpty(value, name) {
  if (!value || !String(value).trim()) {
    throw new IntegrationError(`${name} is required`, { statusCode: 500, code: 'misconfigured' });
  }
  return String(value).trim();
}

function parseCsv(value, fallback = []) {
  if (!value) return fallback;
  return String(value)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function toIso(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeError(error) {
  if (!error) return 'Unknown error';
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1000);
}

function senderAddress(message) {
  return message?.sender?.emailAddress?.address?.trim().toLowerCase() || null;
}

function domainOf(address) {
  return address && address.includes('@') ? address.split('@').pop().toLowerCase() : null;
}

function normalizeHtmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractAppointmentId(text) {
  const match = String(text || '').match(/\/appointments\/view\/(\d+)/i);
  return match ? match[1] : null;
}

function classifyAcuitySubject(subject) {
  const value = String(subject || '').trim();
  if (/^new appointment:/i.test(value)) return 'appointment_created';
  if (/^appointment rescheduled:/i.test(value)) return 'appointment_rescheduled';
  if (/^appointment cancelled:/i.test(value) || /^appointment canceled:/i.test(value)) return 'appointment_cancelled';
  if (/\bappointments?\s+for\s+week\s+of\b/i.test(value)) return 'agenda_digest';
  return 'unknown';
}

/**
 * Extract MULTIPLE appointment occurrences from a weekly agenda digest body.
 * A digest lists several appointments; each typically carries an Acuity
 * appointment-view link (the strongest per-occurrence key) plus a name and a
 * date/time near it. This is a conservative, evidence-only parser: every field
 * may be null, and the scheduling service remains authoritative for property
 * resolution and canonical projection. One digest envelope -> many occurrences
 * -> (in the service) many canonical scheduled tours.
 */
function parseDigestOccurrences(html, text) {
  const occurrences = [];
  const source = `${html || ''}\n${text || ''}`;

  // Strategy: split the digest into blocks anchored on appointment-view links.
  // Each /appointments/view/<id> marks one appointment; the text immediately
  // around it carries the name/time/type for that occurrence.
  const linkRe = /\/appointments\/view\/(\d+)/gi;
  const ids = [];
  let m;
  while ((m = linkRe.exec(source)) !== null) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }

  // Work from the plain-text rendering for name/time extraction (one line per
  // appointment is the common Acuity digest shape after HTML normalization).
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);

  // A line that looks like an appointment row: contains a time and/or a name.
  const timeRe = /\b(\d{1,2}:\d{2}\s*(?:am|pm))\b/i;
  const dateRe = /\b((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+[A-Z][a-z]+\s+\d{1,2},?\s+\d{4})|((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/i;
  const typeRe = /\b(In Person|FaceTime|Virtual|Video)\b/i;
  const nameInParen = /\(([^)]+)\)/;

  function normType(t) {
    if (!t) return null;
    const v = t.toLowerCase();
    if (v.includes('person')) return 'in_person';
    if (v.includes('facetime') || v.includes('video') || v.includes('virtual')) return 'facetime';
    return 'other';
  }

  // Build occurrence rows from lines that carry a time (the reliable signal).
  const rowLines = lines.filter((l) => timeRe.test(l));
  for (let i = 0; i < rowLines.length; i += 1) {
    const line = rowLines[i];
    const timeM = line.match(timeRe);
    const dateM = line.match(dateRe) || source.match(dateRe); // fall back to digest-wide week date
    const typeM = line.match(typeRe);
    const parenM = line.match(nameInParen);
    // appointment id: prefer one on the same line, else positional from ids[].
    const idOnLine = (line.match(/\/appointments\/view\/(\d+)/i) || [])[1] || ids[i] || null;

    let startIso = null;
    if (dateM && timeM) {
      const dateStr = (dateM[0] || '').replace(/,/g, '');
      const candidate = new Date(`${dateStr} ${timeM[1]}`);
      if (!Number.isNaN(candidate.getTime())) startIso = candidate.toISOString();
    }

    occurrences.push({
      external_appointment_id: idOnLine,
      prospect_name: parenM ? parenM[1].trim() : null,
      property_label: null, // digests rarely name the property per-row; mapping resolves it
      appointment_type: normType(typeM ? typeM[1] : null),
      scheduled_start: startIso,
      scheduled_end: null,
      source_status: 'scheduled',
    });
  }

  // If we found appointment-link ids but no parseable rows, still emit one
  // occurrence per id so the service can backfill canonical tours by appt id.
  if (occurrences.length === 0 && ids.length > 0) {
    for (const id of ids) {
      occurrences.push({ external_appointment_id: id, prospect_name: null, property_label: null, appointment_type: null, scheduled_start: null, scheduled_end: null, source_status: 'scheduled' });
    }
  }

  return occurrences;
}

/**
 * Conservative parser. The scheduling service remains authoritative for
 * property resolution and canonical-tour projection. These parsed hints are
 * evidence only and may be null.
 */
function parseAcuityMessage(message) {
  const subject = message?.subject || '';
  const bodyHtml = message?.body?.content || '';
  const bodyText = message?.body?.contentType?.toLowerCase() === 'text'
    ? String(bodyHtml)
    : normalizeHtmlToText(bodyHtml);
  const eventType = classifyAcuitySubject(subject);
  // Preserve raw HTML for Acuity appointment-link extraction. Text conversion strips hrefs.
  const combined = `${subject}\n${bodyHtml}\n${bodyText}`;

  const appointmentId = extractAppointmentId(combined);
  const nameFromSubject = subject.match(/\(([^)]+)\)/);
  const propertyFromSubject = subject.match(/\bwith\s+(.+?)\s*$/i);
  const appointmentType = subject.match(/\b(In Person|FaceTime|Virtual|Video)\s+Tour\b/i);

  // These are hints. Never use this to silently guess a property mapping.
  const parsed = {
    prospect_name: nameFromSubject ? nameFromSubject[1].trim() : null,
    property_label: propertyFromSubject ? propertyFromSubject[1].trim() : null,
    appointment_type: appointmentType ? appointmentType[1].trim().toLowerCase().replace(/\s+/g, '_') : null,
    external_appointment_id: appointmentId,
  };

  const sourceEventId = message?.id || message?.internetMessageId;
  const fingerprint = hash([
    'acuity_squarespace',
    sourceEventId || '',
    message?.internetMessageId || '',
    subject,
    message?.receivedDateTime || '',
    bodyText,
  ].join('|'));

  // For a weekly agenda DIGEST, extract every appointment as its own occurrence
  // so one envelope can project to many canonical tours. Individual notices keep
  // a null occurrences array and are folded into a single occurrence by the seam.
  const occurrences = (eventType === 'agenda_digest')
    ? parseDigestOccurrences(bodyHtml, bodyText)
    : null;

  return {
    source_system: 'acuity_squarespace',
    ingestion_channel: 'outlook_graph',
    source_event_id: sourceEventId,
    source_event_type: eventType,
    external_appointment_id: appointmentId,
    idempotency_fingerprint: fingerprint,
    source_received_at: toIso(message?.receivedDateTime),
    parsed,
    occurrences,
    raw_payload: {
      graph_message_id: message?.id || null,
      internet_message_id: message?.internetMessageId || null,
      subject,
      sender: senderAddress(message),
      to_recipients: (message?.toRecipients || []).map((entry) => entry?.emailAddress?.address).filter(Boolean),
      received_date_time: message?.receivedDateTime || null,
      body_content_type: message?.body?.contentType || null,
      body: bodyHtml,
      body_preview: message?.bodyPreview || null,
      web_link: message?.webLink || null,
      has_attachments: Boolean(message?.hasAttachments),
    },
  };
}

function isAllowedSender(message, allowedDomains) {
  const address = senderAddress(message);
  const domain = domainOf(address);
  return Boolean(domain && allowedDomains.includes(domain));
}

function createGraphClient({ tenantId, clientId, clientSecret, fetchImpl = global.fetch, logger = console }) {
  assertNonEmpty(tenantId, 'OUTLOOK_GRAPH_TENANT_ID');
  assertNonEmpty(clientId, 'OUTLOOK_GRAPH_CLIENT_ID');
  assertNonEmpty(clientSecret, 'OUTLOOK_GRAPH_CLIENT_SECRET');
  if (typeof fetchImpl !== 'function') {
    throw new IntegrationError('A fetch implementation is required', { code: 'misconfigured' });
  }

  let cachedToken = null;

  async function getAccessToken() {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });

    const response = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) {
      throw new IntegrationError(`Microsoft Graph token request failed: ${payload.error_description || response.statusText}`, {
        statusCode: 502,
        code: 'graph_token_failed',
      });
    }

    cachedToken = {
      value: payload.access_token,
      expiresAt: Date.now() + Math.max(300, Number(payload.expires_in || 3600) - 120) * 1000,
    };
    return cachedToken.value;
  }

  async function graphFetch(url, options = {}) {
    const token = await getAccessToken();
    const response = await fetchImpl(url, {
      ...options,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });

    if (response.status === 429 || response.status >= 500) {
      const detail = await response.text().catch(() => '');
      throw new IntegrationError(`Microsoft Graph transient failure (${response.status}): ${detail.slice(0, 500)}`, {
        statusCode: 503,
        code: 'graph_transient_failure',
      });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new IntegrationError(`Microsoft Graph request failed (${response.status}): ${detail.slice(0, 500)}`, {
        statusCode: 502,
        code: 'graph_request_failed',
      });
    }
    return response.json();
  }

  function initialDeltaUrl({ mailboxAddress, folderId, initialSyncAfter, pageSize = DEFAULT_PAGE_SIZE }) {
    const url = new URL(`${GRAPH_ROOT}/users/${encodeURIComponent(mailboxAddress)}/mailFolders/${encodeURIComponent(folderId)}/messages/delta`);
    url.searchParams.set('$select', 'id,internetMessageId,subject,sender,toRecipients,receivedDateTime,body,bodyPreview,webLink,hasAttachments');
    url.searchParams.set('$orderby', 'receivedDateTime desc');
    url.searchParams.set('$top', String(pageSize));
    if (initialSyncAfter) {
      url.searchParams.set('$filter', `receivedDateTime ge ${new Date(initialSyncAfter).toISOString()}`);
    }
    return url.toString();
  }

  async function getDeltaPage(url) {
    return graphFetch(url, { headers: { Prefer: `odata.maxpagesize=${DEFAULT_PAGE_SIZE}` } });
  }

  return { getAccessToken, getDeltaPage, initialDeltaUrl, graphFetch, logger };
}

function createPostgresSyncStore({ pool }) {
  if (!pool || typeof pool.query !== 'function') {
    throw new IntegrationError('Postgres pool with query() is required', { code: 'misconfigured' });
  }

  async function withAdvisoryLock(integrationKey, callback) {
    const client = await pool.connect();
    try {
      const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [integrationKey]);
      if (!lock.rows[0]?.acquired) return { acquired: false, value: null };
      try {
        return { acquired: true, value: await callback(client) };
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [integrationKey]);
      }
    } finally {
      client.release();
    }
  }

  async function ensureState(client, config) {
    const result = await client.query(`
      INSERT INTO integration_sync_states (
        integration_key, provider, mailbox_address, mail_folder_id, initial_sync_after
      ) VALUES ($1, 'microsoft_graph', $2, $3, $4)
      ON CONFLICT (integration_key) DO UPDATE
        SET mailbox_address = EXCLUDED.mailbox_address,
            mail_folder_id = EXCLUDED.mail_folder_id,
            initial_sync_after = COALESCE(integration_sync_states.initial_sync_after, EXCLUDED.initial_sync_after),
            updated_at = now()
      RETURNING *
    `, [config.integrationKey, config.mailboxAddress, config.folderId, config.initialSyncAfter || null]);
    return result.rows[0];
  }

  async function startRun(client, integrationKey) {
    const result = await client.query(`
      INSERT INTO integration_sync_runs (integration_key, status)
      VALUES ($1, 'running')
      RETURNING *
    `, [integrationKey]);
    return result.rows[0];
  }

  async function finishRun(client, runId, { status, counts, errorSummary = null }) {
    await client.query(`
      UPDATE integration_sync_runs
      SET finished_at = now(), status = $2, messages_seen = $3, messages_forwarded = $4,
          messages_skipped = $5, messages_unmapped = $6, error_summary = $7
      WHERE id = $1
    `, [runId, status, counts.seen, counts.forwarded, counts.skipped, counts.unmapped, errorSummary]);
  }

  async function saveSuccess(client, integrationKey, { deltaLink, lastMessageAt }) {
    await client.query(`
      UPDATE integration_sync_states
      SET delta_link = $2,
          last_successful_sync_at = now(),
          last_successful_message_at = COALESCE($3::timestamptz, last_successful_message_at),
          last_error_at = NULL,
          last_error_summary = NULL,
          updated_at = now()
      WHERE integration_key = $1
    `, [integrationKey, deltaLink, lastMessageAt || null]);
  }

  async function saveFailure(client, integrationKey, errorSummary) {
    await client.query(`
      UPDATE integration_sync_states
      SET last_error_at = now(), last_error_summary = $2, updated_at = now()
      WHERE integration_key = $1
    `, [integrationKey, errorSummary]);
  }

  async function status(integrationKey) {
    const result = await pool.query(`
      SELECT s.*, r.status AS last_run_status, r.started_at AS last_run_started_at,
             r.finished_at AS last_run_finished_at, r.messages_seen, r.messages_forwarded,
             r.messages_skipped, r.messages_unmapped, r.error_summary AS last_run_error_summary
      FROM integration_sync_states s
      LEFT JOIN LATERAL (
        SELECT * FROM integration_sync_runs
        WHERE integration_key = s.integration_key
        ORDER BY id DESC LIMIT 1
      ) r ON true
      WHERE s.integration_key = $1
    `, [integrationKey]);
    return result.rows[0] || null;
  }

  return { withAdvisoryLock, ensureState, startRun, finishRun, saveSuccess, saveFailure, status };
}

function createOutlookAcuitySync({ graphClient, syncStore, ingestSourceEvent, config, logger = console }) {
  if (!graphClient || !syncStore || typeof ingestSourceEvent !== 'function') {
    throw new IntegrationError('graphClient, syncStore, and ingestSourceEvent are required', { code: 'misconfigured' });
  }

  const normalizedConfig = {
    integrationKey: config.integrationKey || DEFAULT_INTEGRATION_KEY,
    mailboxAddress: assertNonEmpty(config.mailboxAddress, 'OUTLOOK_ACUITY_MAILBOX'),
    folderId: assertNonEmpty(config.folderId, 'OUTLOOK_ACUITY_FOLDER_ID'),
    initialSyncAfter: config.initialSyncAfter || null,
    allowedSenderDomains: (config.allowedSenderDomains || DEFAULT_ALLOWED_DOMAINS).map((item) => item.toLowerCase()),
  };

  async function syncOnce() {
    const lockResult = await syncStore.withAdvisoryLock(normalizedConfig.integrationKey, async (client) => {
      const state = await syncStore.ensureState(client, normalizedConfig);
      const run = await syncStore.startRun(client, normalizedConfig.integrationKey);
      const counts = { seen: 0, forwarded: 0, skipped: 0, unmapped: 0 };
      let lastMessageAt = null;

      try {
        let nextUrl = state.delta_link || graphClient.initialDeltaUrl({
          mailboxAddress: normalizedConfig.mailboxAddress,
          folderId: normalizedConfig.folderId,
          initialSyncAfter: state.initial_sync_after || normalizedConfig.initialSyncAfter,
        });
        let terminalDeltaLink = null;

        // Process every page before advancing the persisted cursor. If an ingest fails,
        // the same page safely replays on the next run; the scheduling service is idempotent.
        while (nextUrl) {
          const page = await graphClient.getDeltaPage(nextUrl);
          for (const message of page.value || []) {
            counts.seen += 1;

            if (message['@removed']) {
              counts.skipped += 1;
              continue;
            }
            if (!isAllowedSender(message, normalizedConfig.allowedSenderDomains)) {
              counts.skipped += 1;
              continue;
            }

            const envelope = parseAcuityMessage(message);
            const result = await ingestSourceEvent(envelope, {
              integrationKey: normalizedConfig.integrationKey,
              source: 'outlook_graph',
            });

            counts.forwarded += 1;
            if (envelope.source_event_type === 'unknown' || result?.status === 'unmapped') {
              counts.unmapped += 1;
            }
            if (envelope.source_received_at && (!lastMessageAt || envelope.source_received_at > lastMessageAt)) {
              lastMessageAt = envelope.source_received_at;
            }
          }

          nextUrl = page['@odata.nextLink'] || null;
          terminalDeltaLink = page['@odata.deltaLink'] || terminalDeltaLink;
        }

        if (!terminalDeltaLink) {
          throw new IntegrationError('Graph delta sync completed without an @odata.deltaLink', {
            code: 'graph_delta_link_missing',
          });
        }

        await syncStore.saveSuccess(client, normalizedConfig.integrationKey, {
          deltaLink: terminalDeltaLink,
          lastMessageAt,
        });
        await syncStore.finishRun(client, run.id, { status: 'succeeded', counts });

        return { status: 'succeeded', counts, delta_link_saved: true };
      } catch (error) {
        const summary = safeError(error);
        await syncStore.saveFailure(client, normalizedConfig.integrationKey, summary);
        await syncStore.finishRun(client, run.id, { status: 'failed', counts, errorSummary: summary });
        throw error;
      }
    });

    if (!lockResult.acquired) {
      return { status: 'skipped', reason: 'sync_already_running' };
    }
    return lockResult.value;
  }

  return { syncOnce, config: normalizedConfig };
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createOutlookAcuityRouter({ express, sync, syncStore, integrationKey = DEFAULT_INTEGRATION_KEY, integrationSecret }) {
  if (!express || typeof express.Router !== 'function') {
    throw new IntegrationError('Express must be provided to create the sync router', { code: 'misconfigured' });
  }
  assertNonEmpty(integrationSecret, 'OUTLOOK_ACUITY_SYNC_SECRET');

  const router = express.Router();
  const requireSecret = (req, res, next) => {
    if (!constantTimeEqual(req.get('x-integration-key'), integrationSecret)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    return next();
  };

  router.post('/sync', requireSecret, async (req, res) => {
    try {
      const result = await sync.syncOnce();
      return res.status(result.status === 'skipped' ? 202 : 200).json(result);
    } catch (error) {
      const status = error?.statusCode || 500;
      return res.status(status).json({ error: error?.code || 'sync_failed', message: safeError(error) });
    }
  });

  router.get('/status', requireSecret, async (req, res) => {
    try {
      const result = await syncStore.status(integrationKey);
      return res.status(200).json({ integration: result });
    } catch (error) {
      return res.status(500).json({ error: 'status_failed', message: safeError(error) });
    }
  });

  return router;
}

module.exports = {
  DEFAULT_ALLOWED_DOMAINS,
  DEFAULT_INTEGRATION_KEY,
  IntegrationError,
  classifyAcuitySubject,
  createGraphClient,
  createOutlookAcuityRouter,
  createOutlookAcuitySync,
  createPostgresSyncStore,
  normalizeHtmlToText,
  parseAcuityMessage,
  parseDigestOccurrences,
};
