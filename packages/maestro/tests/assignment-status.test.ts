import assert from "node:assert/strict";
import test from "node:test";
import { statusFromAssignmentReports } from "../src/assignment-status.ts";

test("assignment outcome aggregation fails closed for empty, malformed, and unknown reports", () => {
  assert.equal(statusFromAssignmentReports(""), "failed");
  assert.equal(statusFromAssignmentReports("not-json"), "failed");
  assert.equal(statusFromAssignmentReports("bounded-worker-reports: []"), "failed");
  assert.equal(statusFromAssignmentReports(JSON.stringify({ summary: "No status" })), "failed");
  assert.equal(statusFromAssignmentReports(JSON.stringify({ status: "maybe-completed" })), "failed");
  assert.equal(statusFromAssignmentReports(JSON.stringify([{ status: "completed" }, { status: "unknown" }])), "failed");
});

test("assignment outcome aggregation preserves recognized terminal states", () => {
  assert.equal(statusFromAssignmentReports(JSON.stringify([{ status: "completed" }, { status: "completed" }])), "completed");
  assert.equal(statusFromAssignmentReports(JSON.stringify([{ status: "completed" }, { status: "blocked" }])), "blocked");
  assert.equal(statusFromAssignmentReports(JSON.stringify([{ status: "completed" }, { status: "failed" }])), "failed");
  assert.equal(statusFromAssignmentReports(JSON.stringify([{ status: "completed" }, { status: "cancelled" }])), "cancelled");
  assert.equal(statusFromAssignmentReports(JSON.stringify({ status: "yielded" })), "yielded");
  assert.equal(statusFromAssignmentReports(JSON.stringify([{ status: "yielded" }, { status: "completed" }])), "completed");
  assert.equal(statusFromAssignmentReports(JSON.stringify({ status: "model-unavailable" })), "failed");
});
