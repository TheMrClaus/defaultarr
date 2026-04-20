const test = require("node:test")
const assert = require("node:assert/strict")
const { _internal } = require("../configBuilder")
const { applyLegacyShim } = _internal

test("applyLegacyShim: no-op when provider already set", () => {
    const input = { provider: "plex", plex: { server_url: "x", owner_token: "y", client_identifier: "z" } }
    const out = applyLegacyShim(input)
    assert.equal(out, input)
})

test("applyLegacyShim: no-op when no legacy keys present", () => {
    const input = { groups: {}, filters: {} }
    const out = applyLegacyShim(input)
    assert.equal(out, input)
})

test("applyLegacyShim: hoists legacy plex_* into plex block", () => {
    const input = {
        plex_server_url: "http://plex:32400/",
        plex_owner_token: "tok",
        plex_client_identifier: "cid",
        plex_owner_name: "owner",
        managed_users: { alice: "atok" },
        groups: {},
        filters: {},
    }
    const out = applyLegacyShim(input)
    assert.equal(out.provider, "plex")
    assert.equal(out.plex.server_url, "http://plex:32400/")
    assert.equal(out.plex.owner_token, "tok")
    assert.equal(out.plex.client_identifier, "cid")
    assert.equal(out.plex.owner_name, "owner")
    assert.deepEqual(out.plex.managed_users, { alice: "atok" })
    assert.equal(out.plex_server_url, undefined)
    assert.equal(out.managed_users, undefined)
})

test("applyLegacyShim: preserves existing plex block entries over legacy", () => {
    const input = {
        plex_server_url: "legacy",
        plex_owner_token: "legacyTok",
        plex_client_identifier: "legacyCid",
        plex: { server_url: "explicit", owner_token: "explicitTok" },
    }
    const out = applyLegacyShim(input)
    assert.equal(out.plex.server_url, "explicit")
    assert.equal(out.plex.owner_token, "explicitTok")
    assert.equal(out.plex.client_identifier, "legacyCid")
})
