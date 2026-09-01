// Cloudflare Pages custom Worker (root-level _worker.js).
// This file IS supported by dashboard drag-and-drop deployments (unlike a /functions folder,
// which Cloudflare's dashboard drag-and-drop does not compile — Wrangler CLI only).
// It handles /api/territory and /api/orders itself and forwards every other request to the
// static assets (index.html, rhc-assets, etc.) via env.ASSETS.fetch().
// Requires a D1 binding named "DB" configured in the Pages project settings.

const DIVISIONS = {
  R: "Remedial Healthcare",
  C: "Cutis",
  S: "She Biologicals",
  O: "Ortholink",
  F: "Femigenix",
};

// All 5 divisions (including Femigenix) now use the same exclusive territory-locking logic
// -- one firm per district/area per division, same as Remedial/Cutis/She Biologicals/Ortholink.
// Kept as an empty set (rather than deleting the branch) in case a future division ever
// needs to be open/non-exclusive again.
const OPEN_DIVISIONS = new Set([]);

const STALE_DAYS = 90;

// Valid order lifecycle states for the admin Orders tab. Kept to 3 stages deliberately --
// see the longer comment next to the updateOrderStatus admin action for why.
const ORDER_STATUSES = new Set(["pending", "fulfilled", "cancelled"]);

function norm(s) {
  return (s || "").toString().trim().replace(/\s+/g, " ").toUpperCase();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function isValidPin(pin) {
  return typeof pin === "string" && /^[0-9]{4,6}$/.test(pin);
}

// Normalizes any reasonable Indian mobile input -- "9876543210", "09876543210",
// "919876543210", "+91 98765 43210" -- down to a single canonical "+91XXXXXXXXXX" form,
// so the same number always compares equal regardless of how it was typed. Returns null
// for anything that isn't a valid 10-digit Indian mobile number (must start 6-9).
function normalizeIndianMobile(raw) {
  let digits = (raw || "").toString().replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length !== 10 || !/^[6-9]/.test(digits)) return null;
  return "+91" + digits;
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomSaltHex() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const PIN_PEPPER = "remedial-territory-pin-v1"; // fixed app-wide pepper, combined with a per-firm random salt

async function hashPin(pin, salt) {
  return sha256Hex(`${PIN_PEPPER}:${salt}:${pin}`);
}

function daysBetween(isoA, isoB) {
  const a = new Date(isoA).getTime();
  const b = new Date(isoB).getTime();
  if (isNaN(a) || isNaN(b)) return 0;
  return Math.abs(b - a) / (1000 * 60 * 60 * 24);
}

function isStale(row, nowIso) {
  const ref = row.last_order_at || row.claimed_at;
  if (!ref) return false;
  return daysBetween(ref, nowIso) > STALE_DAYS;
}

// Fetch active claims for a division+district, splitting into "fresh" (still blocking) and
// "stale" (90+ days with no order — no longer blocking). Lazily flips stale rows to
// status='expired' so the freed slot is visible/auditable even before anyone re-applies.
async function getFreshAndExpireStale(db, stateNorm, districtNorm, division, nowIso) {
  const { results: existing } = await db
    .prepare(
      "SELECT id, working_area, working_area_norm, firm_name, firm_name_norm, claimed_at, last_order_at FROM territories WHERE state_norm = ? AND district_norm = ? AND division = ? AND status = 'active'"
    )
    .bind(stateNorm, districtNorm, division)
    .all();

  const fresh = [];
  const staleIds = [];
  for (const row of existing) {
    if (isStale(row, nowIso)) {
      staleIds.push(row.id);
    } else {
      fresh.push(row);
    }
  }

  if (staleIds.length > 0) {
    const stmts = staleIds.map((id) =>
      db
        .prepare("UPDATE territories SET status = 'expired', notes = ? WHERE id = ?")
        .bind(`auto-expired: no orders in ${STALE_DAYS}+ days (as of ${nowIso})`, id)
    );
    await db.batch(stmts);
  }

  return fresh;
}

async function getDivisionStatus(db, stateNorm, districtNorm, myFirmNameNorm, nowIso) {
  const { results: claims } = await db
    .prepare(
      "SELECT division, working_area, working_area_norm, firm_name, firm_name_norm, claimed_at, last_order_at FROM territories WHERE state_norm = ? AND district_norm = ? AND status = 'active' ORDER BY division"
    )
    .bind(stateNorm, districtNorm)
    .all();

  const divisionStatus = {};
  for (const code of Object.keys(DIVISIONS)) {
    if (OPEN_DIVISIONS.has(code)) {
      const mine = myFirmNameNorm ? claims.find((c) => c.division === code && c.firm_name_norm === myFirmNameNorm) : null;
      divisionStatus[code] = {
        name: DIVISIONS[code],
        available: true,
        mine: !!mine,
        scope: "open_all",
        note: "Open division — no exclusivity, available in every district.",
      };
      continue;
    }

    const allDivClaims = claims.filter((c) => c.division === code);
    const staleDivClaims = allDivClaims.filter((c) => isStale(c, nowIso));
    const divClaims = allDivClaims.filter((c) => !isStale(c, nowIso));

    // Lazily expire anything stale for this division (self-healing, no cron needed).
    if (staleDivClaims.length > 0) {
      const stmts = staleDivClaims.map((c) =>
        db
          .prepare("UPDATE territories SET status = 'expired', notes = ? WHERE state_norm = ? AND district_norm = ? AND division = ? AND firm_name_norm = ? AND status = 'active'")
          .bind(`auto-expired: no orders in ${STALE_DAYS}+ days (as of ${nowIso})`, stateNorm, districtNorm, code, c.firm_name_norm)
      );
      await db.batch(stmts);
    }

    const wholeDistrictClaim = divClaims.find((c) => !c.working_area);
    const mine = myFirmNameNorm ? divClaims.find((c) => c.firm_name_norm === myFirmNameNorm) : null;

    if (mine) {
      const mineScope = mine.working_area ? "partial" : "whole_district";
      const entry = {
        name: DIVISIONS[code],
        available: false,
        mine: true,
        scope: mineScope,
        workingArea: mine.working_area || null,
      };
      if (mineScope === "partial") {
        // The firm already holds this division in one area, but other areas of the same
        // district may still be free for this division -- surface everyone's taken areas
        // (deduped, tagged with whose they are) so the UI can let the firm expand into
        // whatever's left instead of dead-ending at "already yours".
        const seen = new Set();
        entry.occupiedAreas = [];
        for (const c of divClaims) {
          if (!c.working_area) continue;
          const key = c.working_area_norm || norm(c.working_area);
          if (seen.has(key)) continue;
          seen.add(key);
          entry.occupiedAreas.push({ area: c.working_area, mine: c.firm_name_norm === myFirmNameNorm });
        }
      }
      divisionStatus[code] = entry;
    } else if (wholeDistrictClaim) {
      divisionStatus[code] = {
        name: DIVISIONS[code],
        available: false,
        mine: false,
        scope: "whole_district",
        // Deliberately no firm name here -- other applicants shouldn't see who holds a
        // territory, only that it's unavailable. Only the holder's own login sees their
        // own name (via the "mine" branch above).
      };
    } else if (divClaims.length > 0) {
      divisionStatus[code] = {
        name: DIVISIONS[code],
        available: true,
        mine: false,
        scope: "partial",
        note: "Some sub-areas already claimed within this district for this division. Whole-district applications are blocked; sub-area applications may still be possible.",
        // Area names are shown so applicants know what's taken, but not who holds them.
        // Multiple firm-rows can share the same area (co-holders / legacy import rows),
        // so dedupe by normalized area name -- each taken area should appear exactly once.
        occupiedAreas: (() => {
          const seen = new Set();
          const out = [];
          for (const c of divClaims) {
            if (!c.working_area) continue;
            const key = c.working_area_norm || norm(c.working_area);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ area: c.working_area });
          }
          return out;
        })(),
      };
    } else {
      divisionStatus[code] = {
        name: DIVISIONS[code],
        available: true,
        mine: false,
        scope: "vacant",
      };
    }
  }
  return divisionStatus;
}

async function resolveDistrict(db, districtInput, stateInput) {
  const districtNorm = norm(districtInput);
  if (stateInput) {
    const row = await db
      .prepare("SELECT state, district FROM districts_master WHERE state_norm = ? AND district_norm = ?")
      .bind(norm(stateInput), districtNorm)
      .first();
    return row ? { state: row.state, district: row.district, ambiguous: null } : { state: null, district: null, ambiguous: null };
  }
  const { results } = await db
    .prepare("SELECT state, district FROM districts_master WHERE district_norm = ?")
    .bind(districtNorm)
    .all();
  if (results.length === 0) return { state: null, district: null, ambiguous: null };
  if (results.length === 1) return { state: results[0].state, district: results[0].district, ambiguous: null };
  return { state: null, district: null, ambiguous: results.map((r) => r.state) };
}

async function handleTerritoryGet(request, env) {
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "status";
  const db = env.DB;
  const nowIso = new Date().toISOString();

  if (!db) {
    return json({ error: "Database not configured. Ask the site owner to bind a D1 database named DB to this Pages project." }, 500);
  }

  try {
    if (action === "states") {
      const { results } = await db
        .prepare("SELECT DISTINCT state FROM districts_master ORDER BY state")
        .all();
      return json({ states: results.map((r) => r.state) });
    }

    if (action === "districts") {
      const state = url.searchParams.get("state");
      if (!state) return json({ error: "state is required" }, 400);
      const { results } = await db
        .prepare("SELECT district FROM districts_master WHERE state_norm = ? ORDER BY district")
        .bind(norm(state))
        .all();
      return json({ districts: results.map((r) => r.district) });
    }

    if (action === "status") {
      const state = url.searchParams.get("state");
      const district = url.searchParams.get("district");
      if (!state || !district) return json({ error: "state and district are required" }, 400);

      const stateNorm = norm(state);
      const districtNorm = norm(district);

      const districtRow = await db
        .prepare("SELECT 1 FROM districts_master WHERE state_norm = ? AND district_norm = ?")
        .bind(stateNorm, districtNorm)
        .first();
      if (!districtRow) {
        return json({ error: "Unknown state/district combination." }, 404);
      }

      const firmName = url.searchParams.get("firmName");
      const myFirmNameNorm = firmName && firmName.trim() ? norm(firmName) : null;
      const divisions = await getDivisionStatus(db, stateNorm, districtNorm, myFirmNameNorm, nowIso);
      return json({ state, district, divisions });
    }

    // Crowdsourced area-name suggestions for a district, so "Specific Area(s)" gets
    // autocomplete instead of pure free-text typing. Grows over time as real applicants
    // enter real area names -- see recordKnownAreas usage in handleApply.
    if (action === "areas") {
      const state = url.searchParams.get("state");
      const district = url.searchParams.get("district");
      if (!district || !district.trim()) return json({ error: "district is required" }, 400);
      const districtNorm = norm(district);
      const row = state
        ? await db.prepare("SELECT area FROM known_areas WHERE state_norm = ? AND district_norm = ? ORDER BY area").bind(norm(state), districtNorm).all()
        : await db.prepare("SELECT area FROM known_areas WHERE district_norm = ? ORDER BY area").bind(districtNorm).all();
      return json({ areas: row.results.map((r) => r.area) });
    }

    if (action === "firmstatus") {
      const firmName = url.searchParams.get("firmName");
      if (!firmName || !firmName.trim()) return json({ error: "firmName is required" }, 400);
      const firmRow = await db
        .prepare("SELECT pin_hash FROM firms WHERE firm_name_norm = ?")
        .bind(norm(firmName))
        .first();
      if (!firmRow) return json({ exists: false, claimed: false });
      return json({ exists: true, claimed: !!firmRow.pin_hash });
    }

    if (action === "orders") {
      const firmName = url.searchParams.get("firmName");
      if (!firmName || !firmName.trim()) return json({ error: "firmName is required" }, 400);
      const { results } = await db
        .prepare("SELECT firm_area, order_ref, items_json, item_count, total_qty, created_at FROM orders WHERE firm_name_norm = ? ORDER BY created_at DESC LIMIT 10")
        .bind(norm(firmName))
        .all();
      const orders = results.map((r) => {
        let items = [];
        try { items = JSON.parse(r.items_json); } catch {}
        return {
          firmArea: r.firm_area,
          orderRef: r.order_ref,
          items,
          itemCount: r.item_count,
          totalQty: r.total_qty,
          createdAt: r.created_at,
        };
      });
      return json({ orders });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    return json({ error: "Server error", detail: String(err) }, 500);
  }
}

async function handleTerritoryPost(request, env) {
  const db = env.DB;
  if (!db) {
    return json({ error: "Database not configured. Ask the site owner to bind a D1 database named DB to this Pages project." }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const action = body.action || "apply";
  const nowIso = new Date().toISOString();

  try {
    if (action === "whoami") {
      return await handleWhoami(db, body);
    }
    if (action === "claim") {
      return await handleClaim(db, body);
    }
    if (action === "apply") {
      return await handleApply(db, body, nowIso);
    }
    if (action === "login") {
      return await handleLogin(db, body, nowIso);
    }
    if (action === "save-order") {
      return await handleSaveOrder(db, body, nowIso);
    }
    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    return json({ error: "Server error", detail: String(err) }, 500);
  }
}

async function getHoldings(db, firmNameNorm) {
  const { results } = await db
    .prepare(
      "SELECT state, district, division, working_area, claimed_at, last_order_at FROM territories WHERE firm_name_norm = ? AND status = 'active' ORDER BY state, district, division"
    )
    .bind(firmNameNorm)
    .all();
  return results.map((h) => {
    const refDate = h.last_order_at || h.claimed_at || null;
    const daysSince = refDate ? daysBetween(refDate, new Date().toISOString()) : null;
    const daysLeft = daysSince === null ? null : Math.max(0, Math.round(STALE_DAYS - daysSince));
    return {
      state: h.state,
      district: h.district,
      division: h.division,
      divisionName: DIVISIONS[h.division] || h.division,
      workingArea: h.working_area || null,
      claimedAt: h.claimed_at || null,
      lastOrderAt: h.last_order_at || null,
      daysSinceActivity: daysSince === null ? null : Math.floor(daysSince),
      daysUntilLock: daysLeft,
    };
  });
}

async function handleWhoami(db, body) {
  const { firmName, pin } = body;
  if (!firmName || !firmName.trim()) return json({ error: "firmName is required" }, 400);
  if (!isValidPin(pin)) return json({ error: "Enter your 4-6 digit PIN." }, 400);

  const firmNameNorm = norm(firmName);
  const firm = await db
    .prepare("SELECT id, firm_name, pin_hash, pin_salt FROM firms WHERE firm_name_norm = ?")
    .bind(firmNameNorm)
    .first();

  if (!firm) {
    return json({ error: "No firm found with that name. If this is your first application, just fill the form below." }, 404);
  }
  if (!firm.pin_hash) {
    return json({ error: "This firm exists in our records but hasn't set up a PIN yet. Submit an application below with a new PIN to secure this firm's account." }, 409);
  }

  const candidateHash = await hashPin(pin, firm.pin_salt);
  if (candidateHash !== firm.pin_hash) {
    return json({ error: "Incorrect PIN for this firm name." }, 401);
  }

  return json({ firmName: firm.firm_name, holdings: await getHoldings(db, firmNameNorm) });
}

async function handleClaim(db, body) {
  const { firmName, pin, contactPhone, contactEmail } = body;
  if (!firmName || !firmName.trim()) return json({ error: "firmName is required" }, 400);
  if (!isValidPin(pin)) return json({ error: "Choose a 4-6 digit PIN." }, 400);

  let normalizedPhone = null;
  if (contactPhone && contactPhone.trim()) {
    normalizedPhone = normalizeIndianMobile(contactPhone);
    if (!normalizedPhone) {
      return json({ error: "Enter a valid 10-digit Indian mobile number." }, 400);
    }
  }

  const firmNameNorm = norm(firmName);
  const firm = await db
    .prepare("SELECT id, firm_name, pin_hash FROM firms WHERE firm_name_norm = ?")
    .bind(firmNameNorm)
    .first();

  if (!firm) {
    return json({ error: "No existing firm found with that name. New firms don't need this step — just apply directly below." }, 404);
  }
  if (firm.pin_hash) {
    return json({ error: "This firm has already set up a PIN. Use 'View my existing divisions' with your PIN instead. If you forgot it, contact Remedial Healthcare to have it reset." }, 409);
  }

  if (normalizedPhone) {
    const dup = await db
      .prepare("SELECT 1 FROM firms WHERE contact_phone = ? AND firm_name_norm != ?")
      .bind(normalizedPhone, firmNameNorm)
      .first();
    if (dup) {
      return json({ error: "This mobile number is already registered against another firm. Use a different number, or contact Remedial Healthcare if this is a mistake." }, 409);
    }
  }

  const salt = randomSaltHex();
  const pinHash = await hashPin(pin, salt);
  await db
    .prepare(
      "UPDATE firms SET pin_hash = ?, pin_salt = ?, claimed_at = datetime('now'), contact_phone = COALESCE(?, contact_phone), contact_email = COALESCE(?, contact_email) WHERE id = ?"
    )
    .bind(pinHash, salt, normalizedPhone, contactEmail || null, firm.id)
    .run();

  return json({ success: true, firmName: firm.firm_name, holdings: await getHoldings(db, firmNameNorm) });
}

// Login gate: firmName + district + PIN. Resolves the district's state, verifies the PIN,
// and returns which division(s) this firm holds in that specific district (plus everywhere).
async function handleLogin(db, body) {
  const { firmName, district, state, pin } = body;
  if (!firmName || !firmName.trim()) return json({ error: "firmName is required" }, 400);
  if (!district || !district.trim()) return json({ error: "district is required" }, 400);
  if (!isValidPin(pin)) return json({ error: "Enter your 4-6 digit PIN." }, 400);

  const firmNameNorm = norm(firmName);
  const firm = await db
    .prepare("SELECT id, firm_name, pin_hash, pin_salt FROM firms WHERE firm_name_norm = ?")
    .bind(firmNameNorm)
    .first();

  if (!firm) {
    return json({ status: "new", error: "No firm found with that name. Please register as a new firm below." }, 404);
  }
  if (!firm.pin_hash) {
    return json({ status: "unclaimed", error: "This firm exists in our records but hasn't set up a PIN yet. Use 'Set up my PIN' below." }, 409);
  }

  const candidateHash = await hashPin(pin, firm.pin_salt);
  if (candidateHash !== firm.pin_hash) {
    return json({ status: "wrong-pin", error: "Incorrect PIN for this firm name." }, 401);
  }

  const resolved = await resolveDistrict(db, district, state);
  if (resolved.ambiguous) {
    return json({ status: "ambiguous-district", error: "Multiple states have a district with this name — please also specify state.", states: resolved.ambiguous }, 300);
  }
  if (!resolved.district) {
    return json({ status: "unknown-district", error: "Could not find that district in our records." }, 404);
  }

  const nowIso = new Date().toISOString();
  const stateNorm = norm(resolved.state);
  const districtNorm = norm(resolved.district);
  const divisionsHere = await getDivisionStatus(db, stateNorm, districtNorm, firmNameNorm, nowIso);
  const myDivisionsHere = Object.entries(divisionsHere)
    .filter(([, d]) => d.mine)
    .map(([code, d]) => ({ code, name: d.name, workingArea: d.workingArea || null }));

  return json({
    status: "ok",
    firmName: firm.firm_name,
    state: resolved.state,
    district: resolved.district,
    myDivisionsHere,
    divisionsHere,
    holdings: await getHoldings(db, firmNameNorm),
  });
}

async function handleApply(db, body, nowIso, source) {
  source = source || "signup";
  const { state, district, divisions, firmName, pin, contactPhone, contactEmail, dlNumber } = body;

  if (!state || !district || !firmName || !Array.isArray(divisions) || divisions.length === 0) {
    return json({ error: "state, district, firmName, and at least one division are required" }, 400);
  }

  // Coverage area is chosen PER DIVISION, not once globally: a firm applying for multiple
  // divisions in the same district may want Entire District for one division and only a
  // Specific Area for another (e.g. one division is fully open, another already has some
  // areas taken). Each entry in `divisions` is therefore { code, scope, areas }.
  const validDivisions = Object.keys(DIVISIONS);
  const normalizedDivisions = [];
  for (const entry of divisions) {
    const code = entry && entry.code;
    const scope = entry && entry.scope;
    if (!validDivisions.includes(code)) {
      return json({ error: `Invalid division code: ${code}` }, 400);
    }
    if (scope !== "whole" && scope !== "areas") {
      return json({ error: `Please choose Entire District or add at least one specific area for ${DIVISIONS[code] || code}.` }, 400);
    }
    let areaList = [];
    if (scope === "areas") {
      const seen = new Set();
      areaList = (Array.isArray(entry.areas) ? entry.areas : [])
        .map((a) => (a || "").toString().trim())
        .filter(Boolean)
        .filter((a) => {
          const n = norm(a);
          if (seen.has(n)) return false;
          seen.add(n);
          return true;
        });
      if (areaList.length === 0) {
        return json({ error: `Add at least one specific area for ${DIVISIONS[code] || code}, or switch to Entire District.` }, 400);
      }
    }
    normalizedDivisions.push({ code, scope, areas: areaList });
  }

  if (!contactPhone && !contactEmail) {
    return json({ error: "Provide at least a contact phone or email" }, 400);
  }
  let normalizedPhone = null;
  if (contactPhone && contactPhone.trim()) {
    normalizedPhone = normalizeIndianMobile(contactPhone);
    if (!normalizedPhone) {
      return json({ error: "Enter a valid 10-digit Indian mobile number." }, 400);
    }
  }
  if (!isValidPin(pin)) {
    return json({ error: "Choose or enter a 4-6 digit PIN for your firm account." }, 400);
  }

  const stateNorm = norm(state);
  const districtNorm = norm(district);
  const firmNameNorm = norm(firmName);

  const districtRow = await db
    .prepare("SELECT 1 FROM districts_master WHERE state_norm = ? AND district_norm = ?")
    .bind(stateNorm, districtNorm)
    .first();
  if (!districtRow) {
    return json({ error: "Unknown state/district combination." }, 404);
  }

  // Areas must be picked from the official district/tehsil list (known_areas) -- manual
  // free-text area names are no longer accepted. This is deliberate: locking the field to
  // real, verifiable places filters toward genuine applicants who actually know their real
  // coverage area, instead of anyone typing anything just to get past the form.
  const allAreaNames = [];
  for (const entry of normalizedDivisions) {
    if (entry.scope === "areas") allAreaNames.push(...entry.areas);
  }
  if (allAreaNames.length > 0) {
    const { results: knownRows } = await db
      .prepare("SELECT area_norm FROM known_areas WHERE district_norm = ?")
      .bind(districtNorm)
      .all();
    const knownSet = new Set(knownRows.map((r) => r.area_norm));
    for (const a of allAreaNames) {
      if (!knownSet.has(norm(a))) {
        return json({ error: `"${a}" is not a recognized area for this district. Please pick from the listed areas only.` }, 400);
      }
    }
  }

  const firm = await db
    .prepare("SELECT id, pin_hash, pin_salt, contact_phone, contact_email, dl_number FROM firms WHERE firm_name_norm = ?")
    .bind(firmNameNorm)
    .first();

  // A firm is only being *registered* (PIN set for the first time) when there's no existing
  // row, or the row exists but has never had a PIN set (a pre-seeded/legacy placeholder being
  // claimed for the first time). Already-verified firms re-applying don't need to re-supply it.
  const isFirstTimeRegistration = !firm || !firm.pin_hash;
  const dlNumberTrimmed = dlNumber && dlNumber.toString().trim() ? dlNumber.toString().trim() : "";
  const dlNumberNorm = dlNumberTrimmed ? norm(dlNumberTrimmed) : null;
  if (isFirstTimeRegistration) {
    // Deliberately loose format check: real Drug License numbers vary wildly by state
    // (e.g. "20B/PB-AS3-102618", "20B/TS/HYD/2022-88154", "DRUG/2022-23/79470"), so we only
    // require *something* that looks like a real license (has letters/digits, reasonable
    // length) rather than a strict regex that would reject genuine formats.
    if (dlNumberTrimmed.length < 6 || !/[0-9]/.test(dlNumberTrimmed)) {
      return json({ error: "A valid Drug License (DL) Number is required to register a new firm. This helps us keep out fake signups." }, 400);
    }
    // One real license belongs to one real firm -- block a second firm from registering
    // with a DL number that's already on file for someone else. This is the actual teeth
    // behind the DL requirement: without it, anyone could still copy a genuine-looking
    // number from elsewhere and register multiple dummy firms with it.
    const dlDup = await db
      .prepare("SELECT firm_name FROM firms WHERE dl_number_norm = ? AND firm_name_norm != ?")
      .bind(dlNumberNorm, firmNameNorm)
      .first();
    if (dlDup) {
      return json({ error: "This Drug License (DL) Number is already registered against another firm. Each firm must register with its own DL number -- contact Remedial Healthcare if you believe this is a mistake." }, 409);
    }
  }

  // Same mobile number can't be registered against two different firms -- catches accidental
  // duplicate signups and shared/typo'd numbers before they cause confusion later.
  if (normalizedPhone && (!firm || !firm.pin_hash)) {
    const dup = await db
      .prepare("SELECT 1 FROM firms WHERE contact_phone = ? AND firm_name_norm != ?")
      .bind(normalizedPhone, firmNameNorm)
      .first();
    if (dup) {
      return json({ error: "This mobile number is already registered against another firm. Use a different number, or contact Remedial Healthcare if this is a mistake." }, 409);
    }
  }

  let firmStatus;
  if (!firm) {
    const salt = randomSaltHex();
    const pinHash = await hashPin(pin, salt);
    await db
      .prepare(
        "INSERT INTO firms (firm_name, firm_name_norm, pin_hash, pin_salt, contact_phone, contact_email, dl_number, dl_number_norm, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
      )
      .bind(firmName, firmNameNorm, pinHash, salt, normalizedPhone, contactEmail || null, dlNumberTrimmed, dlNumberNorm)
      .run();
    firmStatus = "created";
  } else if (!firm.pin_hash) {
    const salt = randomSaltHex();
    const pinHash = await hashPin(pin, salt);
    await db
      .prepare(
        "UPDATE firms SET pin_hash = ?, pin_salt = ?, claimed_at = datetime('now'), contact_phone = COALESCE(?, contact_phone), contact_email = COALESCE(?, contact_email), dl_number = COALESCE(?, dl_number), dl_number_norm = COALESCE(?, dl_number_norm) WHERE id = ?"
      )
      .bind(pinHash, salt, normalizedPhone, contactEmail || null, dlNumberTrimmed, dlNumberNorm, firm.id)
      .run();
    firmStatus = "claimed";
  } else {
    const candidateHash = await hashPin(pin, firm.pin_salt);
    if (candidateHash !== firm.pin_hash) {
      return json({ error: "Incorrect PIN for this firm name. If you forgot your PIN, contact Remedial Healthcare to have it reset." }, 401);
    }
    firmStatus = "verified";
  }

  const granted = []; // {division, area}  -- area is null for whole-district grants
  const rejected = []; // {division, area, reason}

  for (const entry of normalizedDivisions) {
    const division = entry.code;
    const areaScope = entry.scope;
    const areaList = entry.areas;
    const slots = areaScope === "whole" ? [null] : areaList;

    if (OPEN_DIVISIONS.has(division)) {
      // Open-field division: no exclusivity. Only block an exact duplicate for the same firm
      // (same division + same coverage area already held).
      const { results: mineRows } = await db
        .prepare(
          "SELECT working_area_norm FROM territories WHERE state_norm = ? AND district_norm = ? AND division = ? AND firm_name_norm = ? AND status = 'active'"
        )
        .bind(stateNorm, districtNorm, division, firmNameNorm)
        .all();
      for (const area of slots) {
        const areaNorm = area ? norm(area) : null;
        const dup = mineRows.find((r) => (r.working_area_norm || null) === areaNorm);
        if (dup) {
          rejected.push({ division, area, reason: "You already hold this division here." });
          continue;
        }
        granted.push({ division, area });
      }
      continue;
    }

    const fresh = await getFreshAndExpireStale(db, stateNorm, districtNorm, division, nowIso);
    const wholeDistrictTaken = fresh.find((r) => !r.working_area_norm);

    if (areaScope === "whole") {
      const mine = fresh.find((r) => r.firm_name_norm === firmNameNorm);
      if (mine) {
        rejected.push({ division, area: null, reason: "You already hold this division in this district." });
        continue;
      }
      if (fresh.length > 0) {
        const reason = wholeDistrictTaken
          ? "Whole district already held by another firm."
          : "Sub-areas within this district are already claimed for this division; whole-district not available.";
        rejected.push({ division, area: null, reason });
        continue;
      }
      granted.push({ division, area: null });
    } else {
      // This is the core per-area monopoly check: each requested area is evaluated on its
      // own, so a firm can freely apply for a division in areas nobody else has claimed,
      // even while other areas (or the whole district) are already locked for that same
      // division by someone else.
      for (const area of areaList) {
        const areaNorm = norm(area);
        const mine = fresh.find((r) => r.firm_name_norm === firmNameNorm && r.working_area_norm === areaNorm);
        if (mine) {
          rejected.push({ division, area, reason: "You already hold this division in this area." });
          continue;
        }
        if (wholeDistrictTaken) {
          rejected.push({ division, area, reason: "Whole district already held by another firm." });
          continue;
        }
        const clash = fresh.find((r) => r.working_area_norm === areaNorm);
        if (clash) {
          rejected.push({ division, area, reason: "Already claimed here by another firm." });
          continue;
        }
        granted.push({ division, area });
      }
    }
  }

  if (granted.length === 0) {
    return json({ success: false, firmStatus, granted: [], rejected }, 409);
  }

  const stmts = granted.map(({ division, area }) => {
    const areaTrimmed = area && area.trim() ? area.trim() : null;
    const areaNorm = areaTrimmed ? norm(areaTrimmed) : null;
    return db
      .prepare(
        `INSERT INTO territories
         (state, state_norm, district, district_norm, working_area, working_area_norm, division, firm_name, firm_name_norm, contact_phone, contact_email, status, source, last_order_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, datetime('now'))`
      )
      .bind(
        state,
        stateNorm,
        district,
        districtNorm,
        areaTrimmed,
        areaNorm,
        division,
        firmName,
        firmNameNorm,
        normalizedPhone,
        contactEmail || null,
        source
      );
  });

  await db.batch(stmts);

  return json({
    success: true,
    firmStatus,
    granted: granted.map(({ division, area }) => ({ division, area, name: DIVISIONS[division] })),
    rejected,
  });
}

// Records an order (server-side, cross-device history) and resets the 90-day inactivity
// clock on every active territory this firm holds, since placing an order is exactly the
// "still active" signal the auto-expiry rule cares about.
async function handleSaveOrder(db, body, nowIso) {
  const { firmName, firmArea, orderRef, items } = body;
  if (!firmName || !firmName.trim()) return json({ error: "firmName is required" }, 400);
  if (!Array.isArray(items) || items.length === 0) return json({ error: "items are required" }, 400);

  const firmNameNorm = norm(firmName);
  const itemCount = items.length;
  const totalQty = items.reduce((sum, it) => sum + (Number(it.qty) || 0), 0);

  await db
    .prepare(
      "INSERT INTO orders (firm_name, firm_name_norm, firm_area, order_ref, items_json, item_count, total_qty) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(firmName, firmNameNorm, firmArea || null, orderRef || null, JSON.stringify(items), itemCount, totalQty)
    .run();

  // Previously this deleted everything but a firm's most-recent 10 orders. That was only
  // ever needed so the customer-facing history widget stays small -- and that widget already
  // does its own "ORDER BY created_at DESC LIMIT 10" (see the /api/territory?action=orders
  // handler above), so nothing relied on rows actually being deleted. Keeping full order
  // history now that the admin panel's Orders tab needs real historical data for reporting.

  await db
    .prepare("UPDATE territories SET last_order_at = ? WHERE firm_name_norm = ? AND status = 'active'")
    .bind(nowIso, firmNameNorm)
    .run();

  return json({ success: true });
}

// ---------- Admin panel backend ----------
// Deliberately simple: a single shared password checked on every request (no session tokens,
// no separate admin table) -- this app is a small internal tool for one company, not a
// multi-admin SaaS product, so the added complexity of real auth isn't worth it yet.
// Password lives here as a plain constant because this project deploys via Cloudflare Pages'
// dashboard drag-and-drop, which doesn't have a simple path to Wrangler secrets; if this ever
// moves to CLI-based deploys, move this into an environment variable/secret instead.
const ADMIN_PASSWORD = "Bootzup@131990";

function checkAdminAuth(password) {
  return typeof password === "string" && password === ADMIN_PASSWORD;
}

async function handleAdminPost(request, env) {
  const db = env.DB;
  if (!db) return json({ error: "Database not configured." }, 500);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Invalid JSON body." }, 400);
  }
  const { action, password } = body;

  if (action === "login") {
    if (checkAdminAuth(password)) return json({ ok: true });
    return json({ ok: false, error: "Incorrect admin password." }, 401);
  }

  // Every other action requires the password on every single call -- there's no persistent
  // server-side session, so a stale/guessed request can't ride along on someone else's login.
  if (!checkAdminAuth(password)) {
    return json({ error: "Unauthorized." }, 401);
  }

  const nowIso = new Date().toISOString();

  // Lightweight accountability trail: since every employee shares one admin password, there's
  // no real per-user login to hang an audit log off of. Instead the admin panel asks each
  // person for their name once (stored in that browser's session) and sends it along as
  // `operator` on every call; anything that isn't a plain read gets one row here so Sunil can
  // see who did what, without building out full multi-user authentication.
  const READ_ONLY_ADMIN_ACTIONS = new Set([
    "overview", "firms", "listProducts", "listSchemes", "getSettings", "listOrders", "listActivity", "getOrderStatusLog",
  ]);
  if (!READ_ONLY_ADMIN_ACTIONS.has(action)) {
    const target = body.firmId ?? body.productId ?? body.schemeId ?? body.firmName ?? body.key ?? "";
    await db
      .prepare("INSERT INTO activity_log (operator, action, target) VALUES (?, ?, ?)")
      .bind(body.operator || null, action, target === "" ? null : String(target))
      .run();
  }

  if (action === "overview") {
    const totals = await db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM firms) AS totalFirms,
           (SELECT COUNT(*) FROM firms WHERE active = 1) AS activeFirms,
           (SELECT COUNT(*) FROM firms WHERE active = 0) AS inactiveFirms,
           (SELECT COUNT(*) FROM firms WHERE dl_number IS NOT NULL AND dl_number != '') AS firmsWithDl,
           (SELECT COUNT(*) FROM territories WHERE status = 'active') AS activeClaims`
      )
      .first();
    return json({ ok: true, totals });
  }

  if (action === "firms") {
    // One row per firm, with their active territory claims attached, plus a computed "risk"
    // bucket based on days since that firm's most recent order/claim activity anywhere --
    // this is what lets the admin catch a client drifting toward the 90-day auto-expiry
    // before the territory actually falls off and gets reopened to someone else.
    const { results: firms } = await db
      .prepare(
        `SELECT id, firm_name, firm_name_norm, contact_phone, contact_email, dl_number, active, claimed_at, created_at, last_contacted_at, last_contacted_by, followup_notes, last_contact_outcome, next_followup_at, reviewed_at, reviewed_by
         FROM firms ORDER BY claimed_at DESC`
      )
      .all();

    const { results: claims } = await db
      .prepare(
        `SELECT firm_name_norm, division, state, district, working_area, claimed_at, last_order_at
         FROM territories WHERE status = 'active'`
      )
      .all();

    const claimsByFirm = {};
    for (const c of claims) {
      (claimsByFirm[c.firm_name_norm] = claimsByFirm[c.firm_name_norm] || []).push(c);
    }

    const nowMs = new Date(nowIso).getTime();
    const rows = firms.map((f) => {
      const myClaims = claimsByFirm[f.firm_name_norm] || [];
      let lastActivity = null;
      for (const c of myClaims) {
        const t = c.last_order_at || c.claimed_at;
        if (t && (!lastActivity || new Date(t) > new Date(lastActivity))) lastActivity = t;
      }
      const daysSince = lastActivity ? Math.floor((nowMs - new Date(lastActivity).getTime()) / 86400000) : null;
      // fresh (<30d) -> watch (30-59d) -> warning (60-89d) -> expired-risk (90d+, about to
      // auto-expire or already did) -- mirrors the same STALE_DAYS threshold used to actually
      // release a territory, so the color-coding lines up with what will really happen.
      let risk = "none";
      if (myClaims.length > 0) {
        if (daysSince === null) risk = "unknown";
        else if (daysSince >= STALE_DAYS) risk = "expired-risk";
        else if (daysSince >= 60) risk = "warning";
        else if (daysSince >= 30) risk = "watch";
        else risk = "fresh";
      }
      return {
        id: f.id,
        firmName: f.firm_name,
        contactPhone: f.contact_phone,
        contactEmail: f.contact_email,
        dlNumber: f.dl_number,
        active: !!f.active,
        registeredAt: f.claimed_at,
        createdAt: f.created_at,
        reviewedAt: f.reviewed_at || null,
        reviewedBy: f.reviewed_by || null,
        divisions: myClaims.map((c) => ({
          division: c.division,
          state: c.state,
          district: c.district,
          workingArea: c.working_area,
          lastOrderAt: c.last_order_at || c.claimed_at,
        })),
        daysSinceActivity: daysSince,
        risk,
        lastContactedAt: f.last_contacted_at || null,
        lastContactedBy: f.last_contacted_by || null,
        followupNotes: f.followup_notes || "",
        lastContactOutcome: f.last_contact_outcome || null,
        nextFollowupAt: f.next_followup_at || null,
      };
    });

    return json({ ok: true, firms: rows });
  }

  if (action === "toggleActive") {
    const { firmId, active } = body;
    if (!firmId) return json({ error: "firmId is required." }, 400);
    await db.prepare("UPDATE firms SET active = ? WHERE id = ?").bind(active ? 1 : 0, firmId).run();
    return json({ ok: true });
  }

  if (action === "markFirmReviewed") {
    // Lets the admin clear a firm off the "New Registrations" list once they've actually
    // looked it over -- separate from active/inactive, since a firm can be legitimate and
    // reviewed (stays active) or reviewed and rejected (deactivated) or just reviewed and
    // left alone. Passing reviewed: false un-marks it (e.g. if flagged again later).
    const { firmId, reviewed, operator } = body;
    if (!firmId) return json({ error: "firmId is required." }, 400);
    if (reviewed === false) {
      await db.prepare("UPDATE firms SET reviewed_at = NULL, reviewed_by = NULL WHERE id = ?").bind(firmId).run();
    } else {
      await db
        .prepare("UPDATE firms SET reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?")
        .bind(operator || null, firmId)
        .run();
    }
    return json({ ok: true });
  }

  if (action === "deleteFirm") {
    const { firmId } = body;
    if (!firmId) return json({ error: "firmId is required." }, 400);
    const firm = await db.prepare("SELECT firm_name_norm FROM firms WHERE id = ?").bind(firmId).first();
    if (!firm) return json({ error: "Firm not found." }, 404);
    // Releasing a firm also has to release its exclusive territory claims -- deleting the
    // firm but leaving the locks in place would permanently block that area for everyone.
    await db.batch([
      db
        .prepare("UPDATE territories SET status = 'expired', notes = ? WHERE firm_name_norm = ? AND status = 'active'")
        .bind(`removed by admin (as of ${nowIso})`, firm.firm_name_norm),
      db.prepare("DELETE FROM firms WHERE id = ?").bind(firmId),
    ]);
    return json({ ok: true });
  }

  // Lets the Follow-ups tab log "I called/WhatsApped this client" in a way every employee
  // sees, not just whoever clicked it -- stored on the firm itself in D1 rather than in one
  // browser's localStorage, so the whole team shares one accurate picture of who's been
  // chased already. note is optional (staff may just want to stamp "contacted" with no
  // detail); when omitted the existing note is left untouched.
  if (action === "markContacted") {
    // outcome is an optional short tag (e.g. "interested", "no-answer", "call-back-later")
    // recorded alongside the free-text note -- lets the Follow-ups tab show at a glance how
    // a conversation went, not just that contact happened. Marking a firm as contacted also
    // clears any pending snooze (next_followup_at) -- a completed follow-up supersedes
    // whatever "remind me later" date was set before this call/message.
    const { firmId, note, operator, outcome } = body;
    if (!firmId) return json({ error: "firmId is required." }, 400);
    const sets = ["last_contacted_at = datetime('now')", "last_contacted_by = ?", "next_followup_at = NULL"];
    const params = [operator || null];
    if (typeof note === "string") { sets.push("followup_notes = ?"); params.push(note); }
    if (typeof outcome === "string") { sets.push("last_contact_outcome = ?"); params.push(outcome || null); }
    params.push(firmId);
    await db.prepare(`UPDATE firms SET ${sets.join(", ")} WHERE id = ?`).bind(...params).run();
    return json({ ok: true });
  }

  // Lets staff push a lead's follow-up date out (e.g. "call back in 3 days") without
  // claiming contact already happened -- distinct from markContacted, which stamps
  // last_contacted_at. A snoozed lead drops out of the active Follow-ups list until its
  // next_followup_at date arrives, then resurfaces automatically.
  if (action === "snoozeFollowup") {
    const { firmId, nextFollowupAt, operator } = body;
    if (!firmId) return json({ error: "firmId is required." }, 400);
    if (!nextFollowupAt) return json({ error: "nextFollowupAt is required." }, 400);
    await db
      .prepare("UPDATE firms SET next_followup_at = ?, last_contacted_by = COALESCE(?, last_contacted_by) WHERE id = ?")
      .bind(nextFollowupAt, operator || null, firmId)
      .run();
    return json({ ok: true });
  }

  // Recent-activity feed for the admin panel's Activity tab -- who did what, when. `target`
  // is whatever identifying value was passed with that action (a firm id, product id, etc.),
  // shown as-is since it's already meaningful to someone looking at the log.
  if (action === "listActivity") {
    const { results } = await db
      .prepare("SELECT id, operator, action, target, created_at FROM activity_log ORDER BY created_at DESC LIMIT 200")
      .all();
    return json({ ok: true, activity: results });
  }

  // Small generic key/value store backing the editable WhatsApp follow-up message template
  // (and anything else admin-wide that needs to persist without its own dedicated column).
  if (action === "getSettings") {
    const { results } = await db.prepare("SELECT key, value FROM settings").all();
    const settings = {};
    for (const r of results) settings[r.key] = r.value;
    return json({ ok: true, settings });
  }

  if (action === "setSetting") {
    const { key, value } = body;
    if (!key) return json({ error: "key is required." }, 400);
    await db
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      )
      .bind(key, value == null ? "" : String(value))
      .run();
    return json({ ok: true });
  }

  if (action === "createClient") {
    // Lets Sunil enter a client he's already onboarded offline (visited the shop, verified
    // the DL number in person, etc.) directly into the system with territory already granted,
    // so the client can log in and order immediately next time instead of going through the
    // public "Apply for Franchise" flow themselves. Reuses the exact same firm-creation and
    // per-area territory-clash logic as the public signup path (handleApply) so a manually
    // added client can never bypass the DL/duplicate/area-clash safety checks -- it's just a
    // different entry point into the same rules, tagged with source='admin_manual' so these
    // rows stay distinguishable from public signups and the original Excel import.
    const applyResult = await handleApply(db, body, nowIso, "admin_manual");
    return applyResult;
  }

  // Lets the admin product form upload a real photo/PDF file instead of typing a static
  // asset path -- stored as base64 in D1 (see handleAssetGet) since this Cloudflare account
  // doesn't have R2 enabled. Capped well under D1's per-row size limit so a compressed
  // product photo or a short label PDF fits comfortably; anything bigger asks the admin to
  // compress the file rather than failing silently.
  if (action === "uploadAsset") {
    const { filename, contentType, dataBase64 } = body;
    if (!contentType || !dataBase64) return json({ error: "contentType and dataBase64 are required." }, 400);
    const isImage = /^image\//.test(contentType);
    const isPdf = contentType === "application/pdf";
    if (!isImage && !isPdf) return json({ error: "Only image files or PDFs are allowed." }, 400);
    if (dataBase64.length > 1400000) {
      return json({ error: "File is too large (max ~1MB). Please compress the image/PDF and try again." }, 400);
    }
    const id = crypto.randomUUID();
    const sizeBytes = Math.round((dataBase64.length * 3) / 4);
    await db
      .prepare("INSERT INTO assets (id, filename, content_type, data_base64, size_bytes) VALUES (?, ?, ?, ?, ?)")
      .bind(id, filename || null, contentType, dataBase64, sizeBytes)
      .run();
    return json({ ok: true, url: `/rhc-assets/uploads/${id}` });
  }

  // Feeds the admin Orders tab -- every order ever placed (now that handleSaveOrder no longer
  // prunes history down to 10 per firm), newest first, optionally narrowed by firm name or a
  // date range. Capped at 3000 rows as a safety limit; stats and top-product/top-firm
  // aggregation are done client-side in admin.html from this same payload rather than adding
  // more bespoke SQL, since order volume here is nowhere near what would make that slow.
  if (action === "listOrders") {
    const { firmName, fromDate, toDate, status } = body;
    let sql =
      "SELECT id, firm_name, firm_area, order_ref, items_json, item_count, total_qty, created_at, status, status_updated_at, status_updated_by, dispatch_courier, dispatch_tracking FROM orders WHERE 1=1";
    const params = [];
    if (firmName && firmName.trim()) {
      sql += " AND firm_name_norm LIKE ?";
      params.push(`%${norm(firmName)}%`);
    }
    if (fromDate) {
      sql += " AND created_at >= ?";
      params.push(fromDate);
    }
    if (toDate) {
      sql += " AND created_at <= ?";
      params.push(toDate);
    }
    if (status && ORDER_STATUSES.has(status)) {
      sql += " AND status = ?";
      params.push(status);
    }
    sql += " ORDER BY created_at DESC LIMIT 3000";
    const { results } = await db.prepare(sql).bind(...params).all();
    const orders = results.map((r) => {
      let items = [];
      try {
        items = JSON.parse(r.items_json);
      } catch (e) {
        items = [];
      }
      return {
        id: r.id,
        firmName: r.firm_name,
        firmArea: r.firm_area,
        orderRef: r.order_ref,
        items,
        itemCount: r.item_count,
        totalQty: r.total_qty,
        createdAt: r.created_at,
        status: r.status || "pending",
        statusUpdatedAt: r.status_updated_at || null,
        statusUpdatedBy: r.status_updated_by || null,
        dispatchCourier: r.dispatch_courier || null,
        dispatchTracking: r.dispatch_tracking || null,
      };
    });
    return json({ ok: true, orders });
  }

  // Single source of truth for what a valid order status is -- keeps the client-side check
  // (listOrders' optional filter) and the write-side validation below from drifting apart.
  // Kept deliberately simple (3 stages) rather than a full packed/dispatched/delivered
  // pipeline: a small distribution business mostly cares whether an order is still open,
  // already fulfilled, or cancelled/void.

  // Changes an order's status, recording who changed it and (optionally) courier/tracking
  // info once it's dispatched/fulfilled. Every change is also appended to order_status_log
  // so a full history is visible per order, separate from the general admin activity feed.
  if (action === "updateOrderStatus") {
    const { orderId, status, operator, note, dispatchCourier, dispatchTracking } = body;
    if (!orderId) return json({ error: "orderId is required." }, 400);
    if (!ORDER_STATUSES.has(status)) return json({ error: "Invalid status." }, 400);
    const existing = await db.prepare("SELECT status FROM orders WHERE id = ?").bind(orderId).first();
    if (!existing) return json({ error: "Order not found." }, 404);
    await db
      .prepare(
        "UPDATE orders SET status = ?, status_updated_at = datetime('now'), status_updated_by = ?, dispatch_courier = COALESCE(?, dispatch_courier), dispatch_tracking = COALESCE(?, dispatch_tracking) WHERE id = ?"
      )
      .bind(status, operator || null, dispatchCourier || null, dispatchTracking || null, orderId)
      .run();
    await db
      .prepare("INSERT INTO order_status_log (order_id, operator, old_status, new_status, note) VALUES (?, ?, ?, ?, ?)")
      .bind(orderId, operator || null, existing.status || "pending", status, note || null)
      .run();
    return json({ ok: true });
  }

  // Same as updateOrderStatus but applied to a batch of orders in one call -- e.g. after a
  // delivery round covering several firms, mark all of that day's dispatched orders as
  // fulfilled together instead of one at a time.
  if (action === "bulkUpdateOrderStatus") {
    const { orderIds, status, operator } = body;
    if (!Array.isArray(orderIds) || orderIds.length === 0) return json({ error: "orderIds is required." }, 400);
    if (!ORDER_STATUSES.has(status)) return json({ error: "Invalid status." }, 400);
    const placeholders = orderIds.map(() => "?").join(",");
    const { results: existingRows } = await db
      .prepare(`SELECT id, status FROM orders WHERE id IN (${placeholders})`)
      .bind(...orderIds)
      .all();
    const stmts = [];
    for (const row of existingRows) {
      stmts.push(
        db
          .prepare("UPDATE orders SET status = ?, status_updated_at = datetime('now'), status_updated_by = ? WHERE id = ?")
          .bind(status, operator || null, row.id)
      );
      stmts.push(
        db
          .prepare("INSERT INTO order_status_log (order_id, operator, old_status, new_status, note) VALUES (?, ?, ?, ?, ?)")
          .bind(row.id, operator || null, row.status || "pending", status, "bulk update")
      );
    }
    if (stmts.length > 0) await db.batch(stmts);
    return json({ ok: true, updated: existingRows.length });
  }

  if (action === "getOrderStatusLog") {
    const { orderId } = body;
    if (!orderId) return json({ error: "orderId is required." }, 400);
    const { results } = await db
      .prepare("SELECT id, operator, old_status, new_status, note, created_at FROM order_status_log WHERE order_id = ? ORDER BY created_at DESC")
      .bind(orderId)
      .all();
    return json({ ok: true, log: results });
  }

  // ---------- Product catalog management ----------
  if (action === "listProducts") {
    const { results } = await db.prepare("SELECT * FROM products ORDER BY div, sort_order, name").all();
    return json({ ok: true, products: results });
  }

  if (action === "addProduct") {
    const p = body.product || {};
    if (!p.sku || !p.name || !p.div) return json({ error: "sku, name, and div are required." }, 400);
    const existing = await db.prepare("SELECT id FROM products WHERE sku = ?").bind(p.sku.trim()).first();
    if (existing) return json({ error: `SKU "${p.sku}" already exists.` }, 409);
    const maxSort = await db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM products").first();
    await db
      .prepare(
        `INSERT INTO products (sku,name,comp,form,div,img,cat,pack,pdf,flavours_json,active,sort_order,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,1,?,datetime('now'))`
      )
      .bind(
        p.sku.trim(), p.name.trim(), p.comp || null, p.form || null, p.div.trim(),
        p.img || null, p.cat || null, p.pack || null, p.pdf || null,
        p.flavours && p.flavours.length ? JSON.stringify(p.flavours) : null,
        (maxSort.m || 0) + 1
      )
      .run();
    return json({ ok: true });
  }

  if (action === "updateProduct") {
    const { productId, product: p } = body;
    if (!productId || !p) return json({ error: "productId and product are required." }, 400);
    await db
      .prepare(
        `UPDATE products SET name=?, comp=?, form=?, div=?, img=?, cat=?, pack=?, pdf=?, flavours_json=?, updated_at=datetime('now')
         WHERE id = ?`
      )
      .bind(
        p.name || "", p.comp || null, p.form || null, p.div || "", p.img || null,
        p.cat || null, p.pack || null, p.pdf || null,
        p.flavours && p.flavours.length ? JSON.stringify(p.flavours) : null,
        productId
      )
      .run();
    return json({ ok: true });
  }

  if (action === "toggleProductActive") {
    const { productId, active } = body;
    if (!productId) return json({ error: "productId is required." }, 400);
    await db.prepare("UPDATE products SET active = ?, updated_at = datetime('now') WHERE id = ?").bind(active ? 1 : 0, productId).run();
    return json({ ok: true });
  }

  if (action === "deleteProduct") {
    const { productId } = body;
    if (!productId) return json({ error: "productId is required." }, 400);
    await db.prepare("DELETE FROM products WHERE id = ?").bind(productId).run();
    return json({ ok: true });
  }

  // ---------- Scheme management ----------
  if (action === "listSchemes") {
    const { results } = await db.prepare("SELECT * FROM schemes ORDER BY div, id").all();
    return json({ ok: true, schemes: results });
  }

  if (action === "addScheme") {
    const s = body.scheme || {};
    if (!s.div || !s.sku || !s.title || !Array.isArray(s.tiers) || s.tiers.length === 0) {
      return json({ error: "div, sku, title, and at least one tier are required." }, 400);
    }
    await db
      .prepare("INSERT INTO schemes (div, sku, title, tiers_json, active) VALUES (?,?,?,?,1)")
      .bind(s.div.trim(), s.sku.trim(), s.title.trim(), JSON.stringify(s.tiers))
      .run();
    return json({ ok: true });
  }

  if (action === "updateScheme") {
    const { schemeId, scheme: s } = body;
    if (!schemeId || !s) return json({ error: "schemeId and scheme are required." }, 400);
    await db
      .prepare("UPDATE schemes SET div=?, sku=?, title=?, tiers_json=? WHERE id = ?")
      .bind(s.div || "", s.sku || "", s.title || "", JSON.stringify(s.tiers || []), schemeId)
      .run();
    return json({ ok: true });
  }

  if (action === "toggleSchemeActive") {
    const { schemeId, active } = body;
    if (!schemeId) return json({ error: "schemeId is required." }, 400);
    await db.prepare("UPDATE schemes SET active = ? WHERE id = ?").bind(active ? 1 : 0, schemeId).run();
    return json({ ok: true });
  }

  if (action === "deleteScheme") {
    const { schemeId } = body;
    if (!schemeId) return json({ error: "schemeId is required." }, 400);
    await db.prepare("DELETE FROM schemes WHERE id = ?").bind(schemeId).run();
    return json({ ok: true });
  }

  return json({ error: "Unknown action." }, 400);
}

// ---------- Public catalog endpoints (consumed by the ordering app itself) ----------
async function handleProductsGet(request, env) {
  const db = env.DB;
  if (!db) return json({ error: "Database not configured." }, 500);
  const { results } = await db
    .prepare("SELECT sku,name,comp,form,div,img,cat,pack,pdf,flavours_json FROM products WHERE active = 1 ORDER BY div, sort_order, name")
    .all();
  const products = results.map((p) => {
    const out = { sku: p.sku, name: p.name, comp: p.comp, form: p.form, div: p.div, img: p.img, cat: p.cat, pack: p.pack, pdf: p.pdf };
    if (p.flavours_json) {
      try {
        out.flavours = JSON.parse(p.flavours_json);
      } catch (e) {
        /* ignore malformed flavours, just omit */
      }
    }
    return out;
  });
  return json({ products });
}

async function handleSchemesGet(request, env) {
  const db = env.DB;
  if (!db) return json({ error: "Database not configured." }, 500);
  const { results } = await db
    .prepare("SELECT div, sku, title, tiers_json FROM schemes WHERE active = 1 ORDER BY div, id")
    .all();
  // Reconstruct the same { DivisionKey: [ {title,sku,tiers}, ... ] } shape the frontend
  // already expects, defaulting every known division to an empty array so a division with
  // no schemes still renders correctly instead of being undefined.
  const schemes = { General: [], Gynae: [], Skincare: [], Ortho: [], FemiGenix: [] };
  for (const r of results) {
    if (!schemes[r.div]) schemes[r.div] = [];
    let tiers = [];
    try {
      tiers = JSON.parse(r.tiers_json);
    } catch (e) {
      tiers = [];
    }
    schemes[r.div].push({ title: r.title, sku: r.sku, tiers });
  }
  return json({ schemes });
}

// Decodes a base64 string to raw bytes without Buffer (Workers runtime has atob but not
// Node's Buffer by default in all contexts) -- this is the standard portable way to do it.
function base64ToBytes(base64) {
  const binStr = atob(base64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
  return bytes;
}

async function handleAssetGet(request, env) {
  const db = env.DB;
  if (!db) return new Response("Database not configured.", { status: 500 });
  const url = new URL(request.url);
  const id = url.pathname.split("/").pop();
  if (!id) return new Response("Not found.", { status: 404 });
  const row = await db.prepare("SELECT content_type, data_base64 FROM assets WHERE id = ?").bind(id).first();
  if (!row) return new Response("Not found.", { status: 404 });
  const bytes = base64ToBytes(row.data_base64);
  return new Response(bytes, {
    headers: {
      "content-type": row.content_type || "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/territory") {
      if (request.method === "GET") return handleTerritoryGet(request, env);
      if (request.method === "POST") return handleTerritoryPost(request, env);
      return json({ error: "Method not allowed" }, 405);
    }

    if (url.pathname === "/api/admin") {
      if (request.method === "POST") return handleAdminPost(request, env);
      return json({ error: "Method not allowed" }, 405);
    }

    if (url.pathname === "/api/products") {
      if (request.method === "GET") return handleProductsGet(request, env);
      return json({ error: "Method not allowed" }, 405);
    }

    if (url.pathname === "/api/schemes") {
      if (request.method === "GET") return handleSchemesGet(request, env);
      return json({ error: "Method not allowed" }, 405);
    }

    // Admin-uploaded product photos and label PDFs are stored as base64 rows in D1 (see
    // handleUploadAsset) rather than R2, since this Cloudflare account doesn't have R2
    // enabled and D1 is already bound and working here. Served under the same
    // "rhc-assets/..." URL family the rest of the app already uses for static images, so
    // nothing else in the product catalog rendering has to change.
    if (url.pathname.startsWith("/rhc-assets/uploads/")) {
      if (request.method === "GET") return handleAssetGet(request, env);
    }

    // Everything else: serve the static assets exactly as before (index.html, rhc-assets, etc.)
    return env.ASSETS.fetch(request);
  },
};
