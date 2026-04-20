const fs = require("fs")
const cron = require("node-cron")
const cronValidator = require("cron-validator")
const logger = require("./logger")
const { STREAM_TYPES } = require("./providers/normalize")

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const LANGUAGE_FIELDS = new Set(["language", "languageCode", "languageTag"])

const filterHasNonLanguageCriteria = (filter) => {
    if (!filter || typeof filter !== "object") return false
    for (const section of ["include", "exclude"]) {
        const fields = filter[section]
        if (!fields) continue
        for (const field of Object.keys(fields)) {
            if (!LANGUAGE_FIELDS.has(field)) return true
        }
    }
    return false
}

const scanFiltersForLanguageOnlyCompat = (filters) => {
    const warnings = []
    for (const libraryName of Object.keys(filters || {})) {
        const groups = filters[libraryName] || {}
        for (const groupName of Object.keys(groups)) {
            const group = groups[groupName]
            const audioFilters = group.audio || []
            const subtitleFilters = group.subtitles && group.subtitles !== "disabled" ? group.subtitles : []
            const all = [...audioFilters, ...subtitleFilters]
            if (all.some(filterHasNonLanguageCriteria)) {
                warnings.push(`${libraryName}/${groupName}`)
            }
        }
    }
    return warnings
}

const evaluateStreams = (streams, filters) => {
    for (const filter of Object.values(filters)) {
        const { include, exclude } = filter
        const defaultStream = streams.find((stream) => {
            if (
                include &&
                Object.entries(include).some(([field, value]) => {
                    const streamValue = stream[field]?.toString().toLowerCase()
                    if (!streamValue) return true
                    const valuesArray = Array.isArray(value) ? value : [value]
                    return valuesArray.some((v) => !streamValue.includes(v.toString().toLowerCase()))
                })
            ) {
                return false
            }
            if (
                exclude &&
                Object.entries(exclude).some(([field, value]) => {
                    const streamValue = stream[field]?.toString().toLowerCase()
                    if (!streamValue) return false
                    const valuesArray = Array.isArray(value) ? value : [value]
                    return valuesArray.some((v) => streamValue.includes(v.toString().toLowerCase()))
                })
            ) {
                return false
            }
            return true
        })

        if (defaultStream) {
            return {
                id: defaultStream.id,
                languageCode: defaultStream.languageCode,
                language: defaultStream.language,
                extendedDisplayTitle: defaultStream.extendedDisplayTitle,
                onMatch: filter.on_match || {},
            }
        }
    }
}

const findMatchingAudioStream = (part, audioFilters) => {
    if (!audioFilters) return
    const audioStreams = part.streams.filter((s) => s.streamType === STREAM_TYPES.audio)
    return evaluateStreams(audioStreams, audioFilters)
}

const findMatchingSubtitleStream = (part, subtitleFilters) => {
    if (!subtitleFilters) return
    if (subtitleFilters === "disabled") return { id: 0 }
    const subtitleStreams = part.streams.filter((s) => s.streamType === STREAM_TYPES.subtitles)
    return evaluateStreams(subtitleStreams, subtitleFilters)
}

const identifyStreamsToUpdate = (parts, filters) => {
    const streamsToUpdate = []
    for (const part of parts) {
        if (!part.streams || part.streams.length <= 1) {
            logger.info(`Part ID ${part.partId} ('${part.title}') has only one stream. Skipping.`)
            continue
        }

        const partUpdate = { partId: part.partId, title: part.title, item: part }

        let audio = findMatchingAudioStream(part, filters.audio) || {}
        let subtitles = findMatchingSubtitleStream(part, filters.subtitles) || {}

        if (audio?.onMatch?.subtitles) {
            subtitles = findMatchingSubtitleStream(part, audio.onMatch.subtitles)
        }
        if (subtitles?.onMatch?.audio) {
            audio = findMatchingAudioStream(part, subtitles.onMatch.audio)
        }

        if (audio.id) {
            partUpdate.audio = audio
            partUpdate.audioStreamId = audio.id
            logger.info(
                `Part ID ${part.partId} ('${part.title}'): match found for audio stream ${audio.extendedDisplayTitle || audio.id}`
            )
        } else {
            logger.debug(`Part ID ${part.partId} ('${part.title}'): no match found for audio streams`)
        }

        if (subtitles && subtitles.id >= 0) {
            partUpdate.subtitle = subtitles
            partUpdate.subtitleStreamId = subtitles.id
            logger.info(
                `Part ID ${part.partId} ('${part.title}'): ${
                    subtitles.id === 0
                        ? "subtitles disabled"
                        : `match found for subtitle stream ${subtitles.extendedDisplayTitle || subtitles.id}`
                }`
            )
        } else {
            logger.debug(`Part ID ${part.partId} ('${part.title}'): no match found for subtitle streams`)
        }

        if (partUpdate.audioStreamId || partUpdate.subtitleStreamId >= 0) {
            streamsToUpdate.push(partUpdate)
        }
    }
    return streamsToUpdate
}

module.exports = (provider, config, opts = {}) => {
    const timestampsFile = opts.timestampsFile || "./last_run_timestamps.json"
    const dedupeEnabled = provider.name === "emby"

    const loadLastRunTimestamps = () => {
        if (fs.existsSync(timestampsFile)) {
            return JSON.parse(fs.readFileSync(timestampsFile, "utf-8"))
        }
        return {}
    }

    const saveLastRunTimestamps = (timestamps) => {
        fs.writeFileSync(timestampsFile, JSON.stringify(timestamps, null, 2), "utf-8")
    }

    const init = async () => {
        await provider.init()
        if (provider.name === "emby") {
            const warnings = scanFiltersForLanguageOnlyCompat(config.filters)
            for (const path of warnings) {
                logger.warn(
                    `Filter '${path}' uses non-language criteria (codec/extendedDisplayTitle/etc.). ` +
                        `On Emby these affect matching only; the apply step sets user language preference globally.`
                )
            }
        }
    }

    const applyWithDedupe = async (usersWithAccess, streamsPerGroup, dedupe) => {
        for (const group in streamsPerGroup) {
            const usernames = usersWithAccess.get(group) || []
            if (usernames.length === 0) {
                logger.warn(`No users found in group '${group}'. Skipping update.`)
                continue
            }
            for (const update of streamsPerGroup[group]) {
                for (const username of usernames) {
                    const handle = provider.getUserHandle(username)
                    if (!handle || (!handle.token && !handle.userId)) {
                        logger.warn(`No handle for user '${username}'. Skipping update.`)
                        continue
                    }

                    if (dedupeEnabled && dedupe) {
                        const key = handle.userId || handle.username
                        const fingerprint = JSON.stringify({
                            al: update.audio?.languageCode,
                            sl: update.subtitle?.languageCode,
                            sm: update.subtitle?.id === 0 ? "None" : undefined,
                        })
                        if (dedupe.has(key)) {
                            const prev = dedupe.get(key)
                            if (prev !== fingerprint) {
                                logger.debug(
                                    `Emby dedupe: skipping apply for user ${username} (already set this run; incoming differs)`
                                )
                            }
                            continue
                        }
                        dedupe.set(key, fingerprint)
                    }

                    await provider.applyDefaults(
                        handle,
                        { partId: update.partId, title: update.title },
                        update.audio || null,
                        update.subtitle || null,
                        { group }
                    )
                }
                logger.info(`Part ID ${update.partId}: update complete for group ${group}`)
            }
        }
    }

    const performDryRun = async () => {
        logger.info("STARTING DRY RUN. NO CHANGES WILL BE MADE.")
        for (const libraryName in config.filters) {
            logger.info(`Processing library for dry run: ${libraryName}`)
            const library = provider.findLibraryByName(libraryName)
            if (!library) {
                logger.warn(`Library '${libraryName}' details are incomplete. Skipping.`)
                continue
            }
            const updatedItems = await provider.listItemsUpdatedSince(library.id, 0)
            for (const item of updatedItems) {
                logger.info(`Fetching streams for ${library.type} '${item.title}'`)
                const parts =
                    library.type === "show"
                        ? await provider.listChildItems(item.id, "show")
                        : [await provider.getItem(item.id)]
                const groupFilters = config.filters[libraryName]
                for (const part of parts) {
                    for (const group in groupFilters) {
                        identifyStreamsToUpdate([part], groupFilters[group])
                    }
                }
                await delay(100)
            }
        }
        logger.info("DRY RUN COMPLETE.")
    }

    const performPartialRun = async (cleanRun) => {
        logger.info(`STARTING ${cleanRun ? "CLEAN" : "PARTIAL"} RUN`)
        const lastRunTimestamps = cleanRun ? {} : loadLastRunTimestamps()
        const newTimestamps = {}

        for (const libraryName in config.filters) {
            logger.info(`Processing library: ${libraryName}`)
            const library = provider.findLibraryByName(libraryName)
            if (!library) {
                logger.warn(`Library '${libraryName}' details are incomplete. Skipping.`)
                continue
            }
            const lastUpdatedAt = lastRunTimestamps[libraryName] || 0
            const updatedItems = await provider.listItemsUpdatedSince(library.id, lastUpdatedAt)
            if (!updatedItems || updatedItems.length === 0) {
                logger.info(`No changes detected in library ${libraryName} since the last run`)
                continue
            }

            const usersWithAccess = await provider.listUsersWithAccess(libraryName)
            if (![...usersWithAccess.values()].some((users) => users.length > 0)) {
                logger.warn(`No users have access to library ${libraryName}. Skipping`)
                continue
            }

            const groupFilters = config.filters[libraryName]
            const dedupe = dedupeEnabled ? new Map() : null

            for (const item of updatedItems) {
                const parts =
                    library.type === "show"
                        ? await provider.listChildItems(item.id, "show")
                        : [await provider.getItem(item.id)]
                for (const part of parts) {
                    const newStreams = {}
                    for (const group in groupFilters) {
                        const matched = identifyStreamsToUpdate([part], groupFilters[group])
                        if (matched.length > 0) newStreams[group] = matched
                    }
                    if (Object.keys(newStreams).length > 0) {
                        await applyWithDedupe(usersWithAccess, newStreams, dedupe)
                    }
                    await delay(100)
                }
            }

            const latestUpdatedAt = Math.max(...updatedItems.map((item) => item.updatedAt || 0))
            if (latestUpdatedAt > 0) newTimestamps[libraryName] = latestUpdatedAt
        }

        if (Object.keys(newTimestamps).length > 0) {
            saveLastRunTimestamps({ ...lastRunTimestamps, ...newTimestamps })
        }
        logger.info(`FINISHED ${cleanRun ? "CLEAN" : "PARTIAL"} RUN`)
    }

    const processWebhookItem = async ({ libraryId, itemId, itemType }) => {
        let library = provider.findLibraryById(libraryId)
        if (!library) {
            logger.info(`Library ID ${libraryId} not found in filters. Attempting library refresh...`)
            await provider.refreshLibraries()
            library = provider.findLibraryById(libraryId)
            if (!library) {
                logger.info(`Library ID ${libraryId} not found in filters after refresh. Ending request`)
                return { status: 200, message: "Event not relevant" }
            }
        }

        const libraryName = library.name
        if (!config.filters[libraryName]) return { status: 200, message: "Library not in filters" }

        const usersWithAccess = await provider.listUsersWithAccess(libraryName)
        const groupFilters = config.filters[libraryName]

        let parts = []
        if (itemType === "movie" || itemType === "episode") {
            parts = [await provider.getItem(itemId)]
        } else if (itemType === "show" || itemType === "season") {
            parts = await provider.listChildItems(itemId, itemType)
        }

        const dedupe = dedupeEnabled ? new Map() : null
        for (const part of parts) {
            const newStreams = {}
            for (const group in groupFilters) {
                const matched = identifyStreamsToUpdate([part], groupFilters[group])
                if (matched.length > 0) newStreams[group] = matched
            }
            if (Object.keys(newStreams).length === 0) {
                logger.info("Could not find streams to update for part. Continuing.")
                continue
            }
            await applyWithDedupe(usersWithAccess, newStreams, dedupe)
        }
        return { status: 200, message: "Webhook received and processed." }
    }

    const setupCron = () => {
        if (config.dry_run || !config.partial_run_cron_expression) return
        if (!cronValidator.isValidCron(config.partial_run_cron_expression))
            throw new Error(`Invalid cron expression: ${config.partial_run_cron_expression}`)
        cron.schedule(config.partial_run_cron_expression, async () => {
            logger.info(`Running scheduled partial run at ${new Date().toISOString()}`)
            await performPartialRun()
        })
        logger.info("Cron job set up successfully")
    }

    return {
        init,
        performDryRun,
        performPartialRun,
        processWebhookItem,
        setupCron,
        // Exposed for testing:
        _internal: { evaluateStreams, identifyStreamsToUpdate, scanFiltersForLanguageOnlyCompat },
    }
}

module.exports.evaluateStreams = evaluateStreams
module.exports.identifyStreamsToUpdate = identifyStreamsToUpdate
module.exports.scanFiltersForLanguageOnlyCompat = scanFiltersForLanguageOnlyCompat
