const STREAM_TYPES = { video: 1, audio: 2, subtitles: 3 }

// Minimal two-letter -> three-letter ISO 639-1/2 map, extended as needed.
// Emby occasionally stores the two-letter form in `Language`; we normalize up to
// the three-letter code used by Plex so filters written for Plex keep matching.
const ISO_639_1_TO_2 = {
    aa: "aar", ab: "abk", af: "afr", ak: "aka", am: "amh", ar: "ara",
    an: "arg", as: "asm", av: "ava", ae: "ave", ay: "aym", az: "aze",
    ba: "bak", bm: "bam", be: "bel", bn: "ben", bi: "bis", bo: "bod",
    bs: "bos", br: "bre", bg: "bul", ca: "cat", cs: "ces", ch: "cha",
    ce: "che", cu: "chu", cv: "chv", kw: "cor", co: "cos", cr: "cre",
    cy: "cym", da: "dan", de: "deu", dv: "div", dz: "dzo", el: "ell",
    en: "eng", eo: "epo", et: "est", eu: "eus", ee: "ewe", fo: "fao",
    fa: "fas", fj: "fij", fi: "fin", fr: "fra", fy: "fry", ff: "ful",
    gd: "gla", ga: "gle", gl: "glg", gv: "glv", gn: "grn", gu: "guj",
    ht: "hat", ha: "hau", he: "heb", hz: "her", hi: "hin", ho: "hmo",
    hr: "hrv", hu: "hun", hy: "hye", ig: "ibo", io: "ido", ii: "iii",
    iu: "iku", ie: "ile", ia: "ina", id: "ind", ik: "ipk", is: "isl",
    it: "ita", jv: "jav", ja: "jpn", kl: "kal", kn: "kan", ks: "kas",
    ka: "kat", kr: "kau", kk: "kaz", km: "khm", ki: "kik", rw: "kin",
    ky: "kir", kv: "kom", kg: "kon", ko: "kor", kj: "kua", ku: "kur",
    lo: "lao", la: "lat", lv: "lav", li: "lim", ln: "lin", lt: "lit",
    lb: "ltz", lu: "lub", lg: "lug", mh: "mah", ml: "mal", mr: "mar",
    mk: "mkd", mg: "mlg", mt: "mlt", mn: "mon", mi: "mri", ms: "msa",
    my: "mya", na: "nau", nv: "nav", nr: "nbl", nd: "nde", ng: "ndo",
    ne: "nep", nl: "nld", nn: "nno", nb: "nob", no: "nor", ny: "nya",
    oc: "oci", oj: "oji", or: "ori", om: "orm", os: "oss", pa: "pan",
    pi: "pli", pl: "pol", pt: "por", ps: "pus", qu: "que", rm: "roh",
    ro: "ron", rn: "run", ru: "rus", sg: "sag", sa: "san", si: "sin",
    sk: "slk", sl: "slv", se: "sme", sm: "smo", sn: "sna", sd: "snd",
    so: "som", st: "sot", es: "spa", sq: "sqi", sc: "srd", sr: "srp",
    ss: "ssw", su: "sun", sw: "swa", sv: "swe", ty: "tah", ta: "tam",
    tt: "tat", te: "tel", tg: "tgk", tl: "tgl", th: "tha", ti: "tir",
    to: "ton", tn: "tsn", ts: "tso", tk: "tuk", tr: "tur", tw: "twi",
    ug: "uig", uk: "ukr", ur: "urd", uz: "uzb", ve: "ven", vi: "vie",
    vo: "vol", wa: "wln", wo: "wol", xh: "xho", yi: "yid", yo: "yor",
    za: "zha", zh: "zho", zu: "zul",
}

// Three-letter -> English display name, used when Emby returns only a code.
const ISO_639_2_TO_DISPLAY = {
    eng: "English", jpn: "Japanese", spa: "Spanish", fra: "French", deu: "German",
    ita: "Italian", rus: "Russian", por: "Portuguese", nld: "Dutch", swe: "Swedish",
    nor: "Norwegian", dan: "Danish", fin: "Finnish", pol: "Polish", kor: "Korean",
    zho: "Chinese", ara: "Arabic", hin: "Hindi", tur: "Turkish", ces: "Czech",
    ell: "Greek", heb: "Hebrew", tha: "Thai", ukr: "Ukrainian", vie: "Vietnamese",
    ind: "Indonesian", msa: "Malay", hun: "Hungarian", ron: "Romanian", bul: "Bulgarian",
    cat: "Catalan", hrv: "Croatian", srp: "Serbian", slk: "Slovak", slv: "Slovenian",
    isl: "Icelandic", fas: "Persian", lit: "Lithuanian", lav: "Latvian", est: "Estonian",
}

const looksLikeIso639_2 = (s) => typeof s === "string" && /^[a-z]{3}$/i.test(s)
const looksLikeIso639_1 = (s) => typeof s === "string" && /^[a-z]{2}$/i.test(s)

const toIso639_2 = (raw) => {
    if (!raw) return undefined
    const s = raw.toLowerCase().trim()
    if (looksLikeIso639_2(s)) return s
    if (looksLikeIso639_1(s)) return ISO_639_1_TO_2[s]
    return undefined
}

const toDisplayLanguage = (code, fallback) => {
    if (fallback && !looksLikeIso639_2(fallback) && !looksLikeIso639_1(fallback)) return fallback
    if (code && ISO_639_2_TO_DISPLAY[code]) return ISO_639_2_TO_DISPLAY[code]
    return fallback
}

// Plex streams already carry the field names filters expect; keep as-is.
const normalizePlexStream = (stream) => stream

// Emby MediaStream -> normalized shape using Plex field names so the existing
// filter engine keeps working without changes.
const normalizeEmbyStream = (stream) => {
    const typeMap = { Video: STREAM_TYPES.video, Audio: STREAM_TYPES.audio, Subtitle: STREAM_TYPES.subtitles }
    const streamType = typeMap[stream.Type] ?? 0

    const rawLang = stream.Language
    const languageCode = toIso639_2(rawLang)
    const language =
        stream.DisplayLanguage ||
        toDisplayLanguage(languageCode, rawLang) ||
        rawLang

    const hearingImpaired =
        stream.IsHearingImpaired === true ||
        (typeof stream.DisplayTitle === "string" && /\bSDH\b/i.test(stream.DisplayTitle))

    return {
        id: stream.Index,
        streamType,
        language,
        languageCode,
        codec: stream.Codec,
        extendedDisplayTitle: stream.DisplayTitle,
        default: stream.IsDefault === true,
        forced: stream.IsForced === true,
        hearingImpaired,
    }
}

module.exports = {
    STREAM_TYPES,
    ISO_639_1_TO_2,
    ISO_639_2_TO_DISPLAY,
    toIso639_2,
    toDisplayLanguage,
    normalizePlexStream,
    normalizeEmbyStream,
}
