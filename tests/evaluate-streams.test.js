const test = require("node:test")
const assert = require("node:assert/strict")
const { evaluateStreams, identifyStreamsToUpdate, scanFiltersForLanguageOnlyCompat } = require("../orchestrator")
const { STREAM_TYPES } = require("../providers/normalize")

const englishAac = {
    id: 1234,
    streamType: 2,
    default: true,
    codec: "aac",
    language: "English",
    languageCode: "eng",
    extendedDisplayTitle: "English (AAC 5.1)",
}
const englishTrueHd = {
    id: 9999,
    streamType: 2,
    codec: "truehd",
    language: "English",
    languageCode: "eng",
    extendedDisplayTitle: "English (TrueHD 7.1)",
}
const japaneseOpus = {
    id: 36834,
    streamType: 2,
    codec: "opus",
    language: "日本語",
    languageCode: "jpn",
    extendedDisplayTitle: "Opus 2.0 @ 121 kb/s (日本語)",
}
const englishSdh = {
    id: 23643,
    streamType: 3,
    codec: "pgs",
    language: "English",
    languageCode: "eng",
    hearingImpaired: true,
    extendedDisplayTitle: "SDH (English PGS)",
}
const frenchForced = {
    id: 75585,
    streamType: 3,
    codec: "srt",
    default: true,
    forced: true,
    language: "Français",
    languageCode: "fra",
    extendedDisplayTitle: "FR Forced (SRT)",
}

test("evaluateStreams: picks first matching include", () => {
    const result = evaluateStreams([englishTrueHd, englishAac], {
        "0": { include: { language: "English" }, exclude: { codec: ["truehd", "dts"] } },
    })
    assert.ok(result)
    assert.equal(result.id, englishAac.id)
})

test("evaluateStreams: exclude rejects a match", () => {
    const result = evaluateStreams([englishTrueHd], {
        "0": { include: { language: "English" }, exclude: { codec: "truehd" } },
    })
    assert.equal(result, undefined)
})

test("evaluateStreams: returns onMatch passthrough", () => {
    const result = evaluateStreams([japaneseOpus], {
        "0": {
            include: { languageCode: "jpn" },
            on_match: { subtitles: "disabled" },
        },
    })
    assert.ok(result)
    assert.equal(result.onMatch.subtitles, "disabled")
})

test("identifyStreamsToUpdate: cascades audio -> subtitles via on_match", () => {
    const part = {
        partId: "p1",
        title: "test",
        streams: [japaneseOpus, englishSdh, frenchForced],
    }
    const filters = {
        audio: [
            {
                include: { languageCode: "jpn" },
                on_match: {
                    subtitles: [{ include: { language: "English" } }],
                },
            },
        ],
    }
    const updates = identifyStreamsToUpdate([part], filters)
    assert.equal(updates.length, 1)
    assert.equal(updates[0].audioStreamId, japaneseOpus.id)
    assert.equal(updates[0].subtitleStreamId, englishSdh.id)
})

test("identifyStreamsToUpdate: honors subtitles: disabled", () => {
    const part = {
        partId: "p1",
        title: "test",
        streams: [englishAac, englishSdh],
    }
    const filters = {
        audio: [{ include: { language: "English" }, on_match: { subtitles: "disabled" } }],
    }
    const updates = identifyStreamsToUpdate([part], filters)
    assert.equal(updates.length, 1)
    assert.equal(updates[0].audioStreamId, englishAac.id)
    assert.equal(updates[0].subtitleStreamId, 0)
})

test("identifyStreamsToUpdate: single-stream parts are skipped", () => {
    const part = { partId: "p1", title: "x", streams: [englishAac] }
    const updates = identifyStreamsToUpdate([part], { audio: [{ include: { language: "English" } }] })
    assert.equal(updates.length, 0)
})

test("scanFiltersForLanguageOnlyCompat: flags non-language fields", () => {
    const filters = {
        Movies: {
            weebs: {
                audio: [{ include: { language: "English" }, exclude: { codec: "truehd" } }],
            },
            purists: {
                audio: [{ include: { languageCode: "eng" } }],
            },
        },
    }
    const warnings = scanFiltersForLanguageOnlyCompat(filters)
    assert.deepEqual(warnings, ["Movies/weebs"])
})

test("scanFiltersForLanguageOnlyCompat: disabled subtitles is not a warning", () => {
    const filters = { Movies: { g: { audio: [{ include: { language: "English" } }], subtitles: "disabled" } } }
    assert.deepEqual(scanFiltersForLanguageOnlyCompat(filters), [])
})
