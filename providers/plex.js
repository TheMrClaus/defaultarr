const axios = require("axios")
const xml2js = require("xml2js")
const logger = require("../logger")
const { STREAM_TYPES } = require("./normalize")

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const handleAxiosError = (context, error) => {
    if (error.response) {
        logger.error(`Error ${context}: ${error.response.status} - ${error.response.statusText}`)
    } else if (error.request) {
        logger.error(`Error ${context}: No response received.`)
    } else {
        logger.error(`Error ${context}: ${error.message}`)
    }
}

const getUserDetailsFromXml = async (xml) => {
    const parser = new xml2js.Parser()
    const result = await parser.parseStringPromise(xml)
    const sharedServers = result.MediaContainer.SharedServer || []
    return sharedServers.map((server) => ({
        username: server.$.username,
        accessToken: server.$.accessToken,
    }))
}

const normalizeUrl = (url) => (url.endsWith("/") ? url.slice(0, -1) : url)

module.exports = (config) => {
    const plexConfig = config.plex
    const serverUrl = normalizeUrl(plexConfig.server_url)
    const ownerToken = plexConfig.owner_token
    const ownerName = plexConfig.owner_name
    const clientIdentifier = plexConfig.client_identifier

    const LIBRARIES = new Map()
    const USERS = new Map()

    const axiosInstance = axios.create({
        baseURL: serverUrl,
        headers: { "X-Plex-Token": ownerToken },
        timeout: 600000,
    })

    const fetchAllLibraries = async () => {
        try {
            const { data } = await axiosInstance.get("/library/sections").catch(async (error) => {
                logger.error(`Error fetching libraries: ${error.message}. Retrying in 30 sec...`)
                let res = error.response
                let attempt = 1
                await delay(30000)
                while ((!res || res.status !== 200) && attempt < 10) {
                    await axiosInstance
                        .get("/library/sections")
                        .then((response) => (res = response))
                        .catch((err) => {
                            logger.error(
                                `Attempt ${attempt}/10 failed with error: ${err.message}. Retrying in 30 sec... `
                            )
                        })
                    if (res && res.status === 200) return res
                    attempt++
                    await delay(30000)
                }
                logger.error(`All attempts failed. Verify connection to Plex before restarting. Shutting down.`)
                process.exit(1)
            })
            const libraries = data?.MediaContainer?.Directory || []

            for (const libraryName in config.filters) {
                const library = libraries.find((lib) => lib.title.toLowerCase() === libraryName.toLowerCase())
                if (!library) throw new Error(`Library '${libraryName}' not found in Plex response`)
                if (library.type !== "movie" && library.type !== "show")
                    throw new Error(`Invalid library type '${library.type}'. Must be 'movie' or 'show'`)
                LIBRARIES.set(library.key, { id: library.key, name: library.title, type: library.type })
                logger.debug(`Mapped library: ${library.title} (ID: ${library.key}, Type: ${library.type})`)
            }
            logger.info("Fetched and mapped libraries")
        } catch (error) {
            handleAxiosError("fetching libraries", error)
        }
    }

    const fetchAllUsersListedInFilters = async () => {
        try {
            if (!clientIdentifier) throw new Error("Client identifier not supplied in config")
            const response = await axios.get(
                `https://plex.tv/api/servers/${clientIdentifier}/shared_servers`,
                {
                    headers: { "X-Plex-Token": ownerToken, Accept: "application/json" },
                }
            )
            const filterUsernames = new Set(Object.values(config.groups).flat())
            const users = await getUserDetailsFromXml(response.data)
            users.forEach((user) => {
                if (filterUsernames.has(user.username) || filterUsernames.has("$ALL")) {
                    USERS.set(user.username, user.accessToken)
                }
            })
            const managedUsers = plexConfig.managed_users
            if (managedUsers) {
                Object.keys(managedUsers).forEach((user) => {
                    const token = managedUsers[user]
                    if (user && token) USERS.set(user, token)
                })
                logger.info(`Finished processing managed users`)
            }
            logger.info("Fetched and stored user details successfully.")
        } catch (error) {
            logger.warn(`Could not fetch users with access to server: ${error.message}`)
        }
    }

    const init = async () => {
        if (ownerName) USERS.set(ownerName, ownerToken)
        await fetchAllUsersListedInFilters()
        if (USERS.size === 0) throw new Error("No users with access to libraries detected")
        await fetchAllLibraries()
    }

    const findLibraryByName = (name) => {
        for (const lib of LIBRARIES.values()) {
            if (lib.name.toLowerCase() === name.toLowerCase()) return lib
        }
        return null
    }

    const findLibraryById = (id) => LIBRARIES.get(id) || null

    const listUsersWithAccess = async (libraryName) => {
        const library = findLibraryByName(libraryName)
        if (!library) return new Map()
        const usersWithAccess = new Map()
        const groups = config.filters[libraryName]

        for (const group in groups) {
            let usernames = config.groups[group] || []
            const users = []
            if (usernames.includes("$ALL")) usernames = [...USERS.keys()]
            for (const username of usernames) {
                const token = USERS.get(username)
                if (!token) {
                    logger.warn(`User ${username} has no token. Skipping access check.`)
                    continue
                }
                try {
                    const response = await axios.get(`${serverUrl}/library/sections/${library.id}`, {
                        headers: { "X-Plex-Token": token },
                    })
                    if (response.status !== 200) throw new Error(`Unexpected response status: ${response.status}`)
                    logger.debug(
                        `Checking if user ${username} of group ${group} has access to library ${libraryName}... OK`
                    )
                    users.push(username)
                } catch (error) {
                    logger.warn(
                        `User ${username} of group ${group} can't access library ${libraryName}. They will be skipped during updates. ${error.message}`
                    )
                }
                await delay(100)
            }
            usersWithAccess.set(group, users)
        }
        return usersWithAccess
    }

    const listItemsUpdatedSince = async (libraryId, lastUpdatedAt) => {
        try {
            const { data } = await axiosInstance.get(`/library/sections/${libraryId}/all`)
            const items = data?.MediaContainer?.Metadata || []
            return items
                .filter((item) => item.updatedAt > lastUpdatedAt)
                .map((item) => ({
                    id: item.ratingKey,
                    type: item.type,
                    title: item.title,
                    updatedAt: item.updatedAt,
                }))
        } catch (error) {
            handleAxiosError(`fetching updated media for Library ID ${libraryId}`, error)
            return []
        }
    }

    const getItem = async (itemId) => {
        try {
            const { data } = await axiosInstance.get(`/library/metadata/${itemId}`)
            const metadata = data?.MediaContainer?.Metadata?.[0]
            let title = metadata?.title
            if (metadata?.type === "episode") title = `Episode ${metadata.index} - ${title}`
            if (metadata?.parentTitle) title = `${metadata.parentTitle} - ${title}`
            if (metadata?.grandparentTitle) title = `${metadata.grandparentTitle} - ${title}`

            const part = metadata?.Media?.[0]?.Part?.[0]
            if (!part || !part.id || !part.Stream) {
                logger.warn(`Item ID ${itemId} '${title}' has invalid media structure. Skipping.`)
                return { partId: itemId, title: title || "title unknown", streams: [] }
            }
            const streams = part.Stream.filter((stream) => stream.streamType !== STREAM_TYPES.video)
            return { partId: part.id, title, streams }
        } catch (error) {
            handleAxiosError(`fetching streams for Item ID ${itemId}`, error)
            return { partId: itemId, title: "title unknown", streams: [] }
        }
    }

    const fetchStreamsForSeason = async (seasonId) => {
        try {
            const { data } = await axiosInstance.get(`/library/metadata/${seasonId}/children`)
            const episodes = data?.MediaContainer?.Metadata || []
            if (episodes.length === 0) return []
            const streams = []
            for (const episode of episodes) {
                logger.debug(
                    `Fetching '${episode.grandparentTitle}' ${episode.parentTitle} Episode ${episode.index}: '${episode.title}' streams`
                )
                streams.push(await getItem(episode.ratingKey))
                await delay(100)
            }
            return streams
        } catch (error) {
            handleAxiosError(`fetching episodes for Season ID ${seasonId}`, error)
            return []
        }
    }

    const fetchStreamsForShow = async (showId) => {
        try {
            const { data } = await axiosInstance.get(`/library/metadata/${showId}/children`)
            const seasons = data?.MediaContainer?.Metadata || []
            if (seasons.length === 0) {
                logger.warn(`No seasons found for Show ID ${showId}: '${data?.title}'`)
                return []
            }
            const streams = []
            for (const season of seasons) {
                logger.debug(`Fetching '${season.parentTitle}' Season '${season.index}' streams`)
                const seasonStreams = await fetchStreamsForSeason(season.ratingKey)
                streams.push(...seasonStreams)
                await delay(100)
            }
            return streams
        } catch (error) {
            handleAxiosError(`fetching seasons for Show ID ${showId}`, error)
            return []
        }
    }

    const listChildItems = async (parentId, parentType) => {
        if (parentType === "show") return fetchStreamsForShow(parentId)
        if (parentType === "season") return fetchStreamsForSeason(parentId)
        return []
    }

    const applyDefaults = async (userHandle, item, matchedAudio, matchedSubtitle, context = {}) => {
        const token = userHandle.token
        const username = userHandle.username
        const group = context.group || ""
        if (!token) {
            logger.warn(`No access token found for user '${username}'. Skipping update.`)
            return false
        }

        const queryParams = new URLSearchParams()
        if (matchedAudio && matchedAudio.id) queryParams.append("audioStreamID", matchedAudio.id)
        if (matchedSubtitle && matchedSubtitle.id >= 0) queryParams.append("subtitleStreamID", matchedSubtitle.id)
        if ([...queryParams.keys()].length === 0) return false

        const url = `/library/parts/${item.partId}?${queryParams.toString()}`
        try {
            const response = await axiosInstance.post(url, {}, { headers: { "X-Plex-Token": token } })
            const audioMsg = matchedAudio && matchedAudio.id ? `Audio ID ${matchedAudio.id}` : ""
            const subMsg =
                matchedSubtitle && matchedSubtitle.id >= 0 ? `Subtitle ID ${matchedSubtitle.id}` : ""
            const msg = [audioMsg, subMsg].filter(Boolean).join(" and ")
            logger.info(
                `Update ${msg} for user ${username}${group ? ` in group ${group}` : ""}: ${
                    response.status === 200 ? "SUCCESS" : "FAIL"
                }`
            )
            await delay(100)
            return response.status === 200
        } catch (error) {
            handleAxiosError(`posting update for user '${username}'${group ? ` in group '${group}'` : ""}`, error)
            return false
        }
    }

    const parseWebhook = async (payload) => {
        const { type, libraryId, mediaId } = payload || {}
        if (!type || !libraryId || !mediaId) return null
        return { libraryId, itemId: mediaId, itemType: type }
    }

    return {
        name: "plex",
        webhookPath: "/webhook",
        init,
        listLibraries: () => LIBRARIES,
        findLibraryByName,
        findLibraryById,
        refreshLibraries: fetchAllLibraries,
        listUsers: () => USERS,
        getUserHandle: (username) => ({ username, token: USERS.get(username) }),
        listUsersWithAccess,
        listItemsUpdatedSince,
        getItem,
        listChildItems,
        applyDefaults,
        parseWebhook,
    }
}
