const fs = require("fs")
const yaml = require("js-yaml")
const logger = require("./logger")
const Ajv = require("ajv")
const ajv = new Ajv({ useDefaults: true })

const yamlFilePath = process.argv[3] || "./config.yaml"

const stringOrStringArray = {
    oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
}

const filterEntrySchema = {
    type: "object",
    properties: {
        include: { type: "object", additionalProperties: stringOrStringArray },
        exclude: { type: "object", additionalProperties: stringOrStringArray },
        on_match: {
            type: "object",
            properties: {
                subtitles: {
                    oneOf: [
                        { type: "string", enum: ["disabled"] },
                        {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    include: { type: "object", additionalProperties: stringOrStringArray },
                                    exclude: { type: "object", additionalProperties: stringOrStringArray },
                                },
                                additionalProperties: false,
                            },
                        },
                    ],
                },
                audio: {
                    oneOf: [
                        { type: "string", enum: ["disabled"] },
                        {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    include: { type: "object", additionalProperties: stringOrStringArray },
                                    exclude: { type: "object", additionalProperties: stringOrStringArray },
                                },
                                additionalProperties: false,
                            },
                        },
                    ],
                },
            },
            additionalProperties: false,
        },
    },
    additionalProperties: false,
}

const schema = {
    type: "object",
    properties: {
        provider: { type: "string", enum: ["plex", "emby"] },
        plex: {
            type: "object",
            properties: {
                server_url: { type: "string", minLength: 1 },
                owner_name: { type: "string" },
                owner_token: { type: "string", minLength: 1 },
                client_identifier: { type: "string", minLength: 1 },
                managed_users: { type: "object", additionalProperties: { type: "string" } },
            },
            required: ["server_url", "owner_token", "client_identifier"],
            additionalProperties: false,
        },
        emby: {
            type: "object",
            properties: {
                server_url: { type: "string", minLength: 1 },
                api_key: { type: "string", minLength: 1 },
                owner_name: { type: "string" },
                managed_users: {
                    type: "object",
                    additionalProperties: {
                        type: "object",
                        properties: {
                            userId: { type: "string" },
                            accessToken: { type: "string" },
                        },
                        additionalProperties: false,
                    },
                },
            },
            required: ["server_url", "api_key"],
            additionalProperties: false,
        },
        dry_run: { type: "boolean" },
        partial_run_on_start: { type: "boolean" },
        partial_run_cron_expression: { type: "string" },
        clean_run_on_start: { type: "boolean" },
        groups: {
            type: "object",
            patternProperties: { ".*": { type: "array", items: { type: "string" } } },
            additionalProperties: false,
        },
        filters: {
            type: "object",
            patternProperties: {
                ".*": {
                    type: "object",
                    patternProperties: {
                        ".*": {
                            type: "object",
                            properties: {
                                audio: { type: "array", items: filterEntrySchema },
                                subtitles: {
                                    oneOf: [
                                        { type: "string", enum: ["disabled"] },
                                        { type: "array", items: filterEntrySchema },
                                    ],
                                },
                            },
                            additionalProperties: false,
                        },
                    },
                },
            },
        },
    },
    required: ["provider", "groups", "filters"],
    allOf: [
        {
            if: { properties: { provider: { const: "plex" } } },
            then: { required: ["plex"] },
        },
        {
            if: { properties: { provider: { const: "emby" } } },
            then: { required: ["emby"] },
        },
    ],
    additionalProperties: false,
}

const formatErrors = (errors) =>
    errors.map((error) => `"${error.instancePath}": ${error.message || "Validation error"}`).join("\n")

const normalizeUrl = (url) => (url && url.endsWith("/") ? url.slice(0, -1) : url)

const LEGACY_PLEX_TOP_KEYS = ["plex_server_url", "plex_owner_token", "plex_client_identifier", "plex_owner_name"]

// Hoist legacy flat plex_* keys into a nested plex: {...} block so older configs
// keep working. Narrow trigger: only when `provider` is missing AND at least one
// legacy key is present, to avoid masking typos.
const applyLegacyShim = (jsonData) => {
    if (!jsonData || jsonData.provider) return jsonData
    const hasLegacy = LEGACY_PLEX_TOP_KEYS.some((k) => Object.prototype.hasOwnProperty.call(jsonData, k))
    if (!hasLegacy) return jsonData

    logger.warn(
        "DEPRECATION: top-level plex_* config keys will be removed in a future release. " +
            "Migrate to:\n  provider: plex\n  plex:\n    server_url: ...\n    owner_token: ...\n    client_identifier: ...\n    owner_name: ...\n"
    )

    const plex = jsonData.plex || {}
    if (jsonData.plex_server_url && !plex.server_url) plex.server_url = jsonData.plex_server_url
    if (jsonData.plex_owner_token && !plex.owner_token) plex.owner_token = jsonData.plex_owner_token
    if (jsonData.plex_client_identifier && !plex.client_identifier) plex.client_identifier = jsonData.plex_client_identifier
    if (jsonData.plex_owner_name && !plex.owner_name) plex.owner_name = jsonData.plex_owner_name
    if (jsonData.managed_users && !plex.managed_users) plex.managed_users = jsonData.managed_users

    const shimmed = { ...jsonData, provider: "plex", plex }
    for (const k of LEGACY_PLEX_TOP_KEYS) delete shimmed[k]
    delete shimmed.managed_users
    return shimmed
}

const normalizeProviderUrls = (jsonData) => {
    if (jsonData.plex && jsonData.plex.server_url) {
        jsonData.plex.server_url = normalizeUrl(jsonData.plex.server_url)
    }
    if (jsonData.emby && jsonData.emby.server_url) {
        jsonData.emby.server_url = normalizeUrl(jsonData.emby.server_url)
    }
}

const loadAndValidateYAML = () => {
    try {
        const fileContent = fs.readFileSync(yamlFilePath, "utf8")
        let jsonData = yaml.load(fileContent)

        jsonData = applyLegacyShim(jsonData)

        const validate = ajv.compile(schema)
        const isValid = validate(jsonData)
        if (!isValid) throw new Error(`\n${formatErrors(validate.errors)}`)

        normalizeProviderUrls(jsonData)
        logger.info("Validated and loaded config file")
        return jsonData
    } catch (error) {
        logger.error(`Error loading or validating YAML: ${error.message}`)
        process.exit(1)
    }
}

module.exports = loadAndValidateYAML
module.exports._internal = { schema, applyLegacyShim, normalizeProviderUrls }
