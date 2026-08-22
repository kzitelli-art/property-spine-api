/* ====================================================================
   comms/staff_governed_read.js - ASK SPINE ON THE STAFF SMS LINE.

   The inbound is committed before intelligence runs. Ask Spine reads through
   its existing governed service with no database transaction held open. The
   answer is then committed as a reply-bound outbound intent. Transport stays
   outside this module and happens only after that second commit.
   ==================================================================== */
"use strict";

const defaultAskSpineAnswer = require("../agent/ask_spine_answer");
const staffThread = require("./staff_thread");
const { operatingReceipt } = require("../conversation/receipt");

async function inTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function propertyContextAnswer(propertyContext, clarification) {
  if (propertyContext && propertyContext.outcome === "many") {
    const names = (clarification && clarification.options || [])
      .map((option) => option.name).filter(Boolean);
    const suffix = names.length ? `: ${names.join(" or ")}` : "";
    return {
      outcome: "property_context_ambiguous",
      answer: `Which property is this about${suffix}? Please resend your question with the property name.`,
      isClarificationQuestion: true,
    };
  }
  return {
    outcome: "property_context_absent",
    answer: "I couldn't find an active property assignment for you. Ask a manager to check your access.",
    isClarificationQuestion: false,
  };
}

function makeStaffGovernedRead({ askSpineAnswer = defaultAskSpineAnswer } = {}) {
  if (!askSpineAnswer || typeof askSpineAnswer.answer !== "function") {
    throw new Error("staff governed read requires Ask Spine's answer service");
  }

  async function run(pool, anthropic, {
    organizationId, userId, lineId, body, providerMessageId,
    propertyContext, clarification = null, askOptions = {},
  }) {
    // Phase 1: preserve the inbound before any model or governed read runs.
    const recorded = await inTransaction(pool, (client) => staffThread.recordInbound(client, {
      organizationId, userId, lineId, body, providerMessageId,
    }));

    let read;
    if (!propertyContext || !["one", "explicit_reference"].includes(propertyContext.outcome)) {
      read = propertyContextAnswer(propertyContext, clarification);
    } else {
      read = await askSpineAnswer.answer(pool, anthropic, {
        property_id: propertyContext.propertyId,
        allowed_modules: propertyContext.allowedModules || [],
        operator_user_id: userId,
        primary_for_modules: propertyContext.primaryForModules || [],
        question: body,
        ...askOptions,
      });
      read = { ...read, isClarificationQuestion: false };
    }

    const operating = operatingReceipt({
      outcome: "governed_read",
      result: {
        answer: read.answer,
        readOutcome: read.outcome,
        isClarificationQuestion: !!read.isClarificationQuestion,
      },
    });
    if (operating.text === null) {
      throw new Error(`governed read receipt refused (${operating.refusal})`);
    }

    // Phase 2: bind the answer to the already-durable inbound. A failure
    // leaves that inbound needs_human=true instead of silently losing it.
    const outbound = await inTransaction(pool, (client) => staffThread.recordReply(client, {
      threadId: recorded.threadId,
      inboundId: recorded.inbound.id,
      userId,
      lineId,
      providerMessageId,
      body: operating.text,
      replyReason: operating.isClarificationQuestion ? "clarification" : "governed_read",
      classification: `governed_read_${String(read.outcome || "unknown").replace(/[^a-z0-9_]+/gi, "_").toLowerCase()}`,
    }));

    return {
      inbound: recorded.inbound,
      outbound,
      threadId: recorded.threadId,
      operating,
      replyReason: operating.isClarificationQuestion ? "clarification" : "governed_read",
      read,
      residentIntent: null,
      residentEvent: null,
    };
  }

  return Object.freeze({ run, propertyContextAnswer });
}

module.exports = { makeStaffGovernedRead, propertyContextAnswer };
