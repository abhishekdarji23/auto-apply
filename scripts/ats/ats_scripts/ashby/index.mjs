/**
 * Ashby scaffold.
 *
 * This file is intentionally kept in the repo for future Ashby support, but
 * normal auto-apply does not call it because run-ats only enables Workday and
 * Greenhouse.
 */

export default async function applyAshby() {
  return {
    success: false,
    atsId: "ashby",
    error: "ashby_disabled",
    trackingSaved: false,
  };
}
