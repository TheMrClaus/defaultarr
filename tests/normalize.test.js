const test = require("node:test")
const assert = require("node:assert/strict")
const {
    STREAM_TYPES,
    normalizeEmbyStream,
    normalizePlexStream,
    toIso639_2,
    toDisplayLanguage,
} = require("../providers/normalize")

test("toIso639_2 maps two-letter to three-letter", () => {
    assert.equal(toIso639_2("en"), "eng")
    assert.equal(toIso639_2("ja"), "jpn")
    assert.equal(toIso639_2("JA"), "jpn")
})

test("toIso639_2 passes through three-letter codes", () => {
    assert.equal(toIso639_2("eng"), "eng")
    assert.equal(toIso639_2("jpn"), "jpn")
})

test("toIso639_2 returns undefined for non-codes", () => {
    assert.equal(toIso639_2("English"), undefined)
    assert.equal(toIso639_2(""), undefined)
    assert.equal(toIso639_2(undefined), undefined)
})

test("toDisplayLanguage prefers known mapping", () => {
    assert.equal(toDisplayLanguage("eng", "eng"), "English")
    assert.equal(toDisplayLanguage("jpn"), "Japanese")
})

test("toDisplayLanguage falls back to provided non-code name", () => {
    assert.equal(toDisplayLanguage(undefined, "Klingon"), "Klingon")
})

test("normalizePlexStream is identity", () => {
    const s = { id: 1, streamType: 2, language: "English", languageCode: "eng", codec: "aac" }
    assert.equal(normalizePlexStream(s), s)
})

test("normalizeEmbyStream maps Audio MediaStream to Plex-shaped fields", () => {
    const emby = {
        Index: 1,
        Type: "Audio",
        Language: "eng",
        Codec: "aac",
        DisplayTitle: "English (AAC 5.1)",
        IsDefault: true,
        IsForced: false,
    }
    const n = normalizeEmbyStream(emby)
    assert.equal(n.id, 1)
    assert.equal(n.streamType, STREAM_TYPES.audio)
    assert.equal(n.languageCode, "eng")
    assert.equal(n.language, "English")
    assert.equal(n.codec, "aac")
    assert.equal(n.extendedDisplayTitle, "English (AAC 5.1)")
    assert.equal(n.default, true)
    assert.equal(n.forced, false)
})

test("normalizeEmbyStream maps Subtitle + hearingImpaired SDH", () => {
    const emby = {
        Index: 3,
        Type: "Subtitle",
        Language: "eng",
        Codec: "pgs",
        DisplayTitle: "English SDH (PGS)",
        IsDefault: false,
        IsForced: false,
    }
    const n = normalizeEmbyStream(emby)
    assert.equal(n.streamType, STREAM_TYPES.subtitles)
    assert.equal(n.hearingImpaired, true)
})

test("normalizeEmbyStream handles display-only Language input", () => {
    const n = normalizeEmbyStream({ Index: 2, Type: "Audio", Language: "日本語", Codec: "opus" })
    assert.equal(n.languageCode, undefined)
    assert.equal(n.language, "日本語")
})

test("normalizeEmbyStream honors DisplayLanguage override", () => {
    const n = normalizeEmbyStream({
        Index: 4,
        Type: "Audio",
        Language: "jpn",
        DisplayLanguage: "日本語",
        Codec: "flac",
    })
    assert.equal(n.language, "日本語")
    assert.equal(n.languageCode, "jpn")
})
