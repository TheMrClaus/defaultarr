const axios = require("axios")
const logger = require("../logger")
const { STREAM_TYPES, normalizeEmbyStream } = require("./normalize")

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

const normalizeUrl = (url) => (url.endsWith("/") ? url.slice(0, -1) : url)

const LIBRARY_TYPE_MAP = {
    movies: "movie",
    tvshows: "show",
    homevideos: "movie",
}

module.exports = (config) => {
    const embyConfig = config.emby
    const serverUrl = normalizeUrl(embyConfig.server_url)
    const apiKey = embyConfig.api_key
    const ownerName = embyConfig.owner_name

    const LIBRARIES = new Map()   // id -> {id, name, type}
    const USERS = new Map()       // username -> { userId, accessToken? }
    const libraryForItemCache = new Map() // itemId -> libraryId (short-lived)
    let adminUserId = null        // resolved from owner_name or fallback first admin

    const axiosInstance = axios.create({
        baseURL: serverUrl,
        headers: { "X-Emby-Token": apiKey, Accept: "application/json" },
        timeout: 600000,
    })

    const authFor = (userHandle) => {
        if (userHandle && userHandle.token) return { "X-Emby-Token": userHandle.token }
        return { "X-Emby-Token": apiKey }
    }

    const fetchAllUsers = async () => {
        const { data } = await axiosInstance.get("/Users")
        return Array.isArray(data) ? data : []
    }

    const fetchAllUsersListedInFilters = async () => {
        try {
            const filterUsernames = new Set(Object.values(config.groups).flat())
            const wantAll = filterUsernames.has("$ALL")
            const embyUsers = await fetchAllUsers()

            for (const user of embyUsers) {
                if (wantAll || filterUsernames.has(user.Name)) {
                    USERS.set(user.Name, { userId: user.Id })
                }
                if (ownerName && user.Name === ownerName) adminUserId = user.Id
                if (!adminUserId && user.Policy && user.Policy.IsAdministrator) adminUserId = user.Id
            }

            const managedUsers = embyConfig.managed_users || {}
            for (const name of Object.keys(managedUsers)) {
                const entry = managedUsers[name]
                if (!entry) continue
                const existing = USERS.get(name) || {}
                USERS.set(name, {
                    userId: entry.userId || existing.userId,
                    accessToken: entry.accessToken || existing.accessToken,
                })
            }

            logger.info("Fetched and stored Emby user details successfully.")
        } catch (error) {
            logger.warn(`Could not fetch Emby users: ${error.message}`)
        }
    }

    const fetchAllLibraries = async () => {
        try {
            const { data } = await axiosInstance.get("/Library/VirtualFolders")
            const folders = Array.isArray(data) ? data : []
            for (const libraryName in config.filters) {
                const folder = folders.find((f) => (f.Name || "").toLowerCase() === libraryName.toLowerCase())
                if (!folder) throw new Error(`Library '${libraryName}' not found in Emby response`)
                const collectionType = (folder.CollectionType || "").toLowerCase()
                const type = LIBRARY_TYPE_MAP[collectionType]
                if (!type) {
                    throw new Error(
                        `Invalid Emby library type '${folder.CollectionType}' for '${libraryName}'. Must map to movie or show.`
                    )
                }
                const id = folder.ItemId || folder.Id || folder.Guid || folder.Name
                LIBRARIES.set(String(id), { id: String(id), name: folder.Name, type })
                logger.debug(`Mapped library: ${folder.Name} (ID: ${id}, Type: ${type})`)
            }
            logger.info("Fetched and mapped libraries")
        } catch (error) {
            handleAxiosError("fetching Emby libraries", error)
        }
    }

    const init = async () => {
        await fetchAllUsersListedInFilters()
        if (USERS.size === 0) throw new Error("No Emby users with access to libraries detected")
        if (!adminUserId) {
            // Fallback: pick any user we have — item queries scoped to a user work with any valid id.
            const first = USERS.values().next().value
            if (first && first.userId) adminUserId = first.userId
        }
        await fetchAllLibraries()
    }

    const findLibraryByName = (name) => {
        for (const lib of LIBRARIES.values()) {
            if (lib.name.toLowerCase() === name.toLowerCase()) return lib
        }
        return null
    }

    const findLibraryById = (id) => LIBRARIES.get(String(id)) || null

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
                const handle = USERS.get(username)
                if (!handle || !handle.userId) {
                    logger.warn(`User ${username} has no Emby userId. Skipping access check.`)
                    continue
                }
                try {
                    const { status, data } = await axiosInstance.get(
                        `/Users/${handle.userId}/Items`,
                        { params: { ParentId: library.id, Limit: 1 } }
                    )
                    if (status !== 200) throw new Error(`Unexpected response status: ${status}`)
                    const count = (data && (data.TotalRecordCount ?? (data.Items ? data.Items.length : 0))) || 0
                    logger.debug(
                        `Checking if user ${username} of group ${group} has access to library ${libraryName}... OK (${count} items visible)`
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

    const listItemsUpdatedSince = async (libraryId, lastUpdatedAtMs) => {
        try {
            const params = {
                ParentId: libraryId,
                Recursive: true,
                IncludeItemTypes: "Movie,Series",
                Fields: "DateCreated",
            }
            if (lastUpdatedAtMs && lastUpdatedAtMs > 0) {
                params.MinDateLastSaved = new Date(lastUpdatedAtMs).toISOString()
            }
            const url = adminUserId ? `/Users/${adminUserId}/Items` : `/Items`
            const { data } = await axiosInstance.get(url, { params })
            const items = (data && data.Items) || []
            return items.map((item) => {
                const ts = new Date(item.DateCreated || item.DateLastSaved || 0).getTime()
                return {
                    id: item.Id,
                    type: item.Type === "Movie" ? "movie" : item.Type === "Series" ? "show" : item.Type,
                    title: item.Name,
                    updatedAt: ts,
                }
            })
        } catch (error) {
            handleAxiosError(`fetching updated Emby items for Library ID ${libraryId}`, error)
            return []
        }
    }

    const buildTitle = (item) => {
        let title = item.Name
        if (item.Type === "Episode") {
            const idx = item.IndexNumber != null ? `Episode ${item.IndexNumber} - ` : ""
            title = `${idx}${title}`
        }
        if (item.SeasonName) title = `${item.SeasonName} - ${title}`
        if (item.SeriesName) title = `${item.SeriesName} - ${title}`
        return title
    }

    const getItem = async (itemId) => {
        try {
            const url = adminUserId ? `/Users/${adminUserId}/Items/${itemId}` : `/Items/${itemId}`
            const { data } = await axiosInstance.get(url, {
                params: { Fields: "MediaStreams,MediaSources,ParentId,SeriesName,SeasonName" },
            })
            const title = buildTitle(data || {})
            const mediaSources = (data && data.MediaSources) || []
            const source = mediaSources[0]
            const mediaStreams = (source && source.MediaStreams) || data.MediaStreams || []
            const normalized = mediaStreams
                .map(normalizeEmbyStream)
                .filter((s) => s.streamType === STREAM_TYPES.audio || s.streamType === STREAM_TYPES.subtitles)
            const partId = (source && source.Id) || data.Id || itemId
            return { partId, title: title || "title unknown", streams: normalized }
        } catch (error) {
            handleAxiosError(`fetching Emby streams for Item ID ${itemId}`, error)
            return { partId: itemId, title: "title unknown", streams: [] }
        }
    }

    const listEpisodesForSeries = async (seriesId) => {
        try {
            const url = adminUserId
                ? `/Shows/${seriesId}/Episodes`
                : `/Shows/${seriesId}/Episodes`
            const params = adminUserId ? { UserId: adminUserId, Fields: "ParentId" } : { Fields: "ParentId" }
            const { data } = await axiosInstance.get(url, { params })
            return (data && data.Items) || []
        } catch (error) {
            handleAxiosError(`fetching Emby episodes for Series ID ${seriesId}`, error)
            return []
        }
    }

    const listEpisodesForSeason = async (seasonId) => {
        try {
            const url = `/Items`
            const params = {
                ParentId: seasonId,
                Recursive: false,
                IncludeItemTypes: "Episode",
            }
            if (adminUserId) params.UserId = adminUserId
            const { data } = await axiosInstance.get(url, { params })
            return (data && data.Items) || []
        } catch (error) {
            handleAxiosError(`fetching Emby episodes for Season ID ${seasonId}`, error)
            return []
        }
    }

    const listChildItems = async (parentId, parentType) => {
        let episodes = []
        if (parentType === "show" || parentType === "Series") {
            episodes = await listEpisodesForSeries(parentId)
        } else if (parentType === "season" || parentType === "Season") {
            episodes = await listEpisodesForSeason(parentId)
        } else {
            return []
        }
        const streams = []
        for (const ep of episodes) {
            streams.push(await getItem(ep.Id))
            await delay(100)
        }
        return streams
    }

    const applyDefaults = async (userHandle, item, matchedAudio, matchedSubtitle, context = {}) => {
        const username = userHandle.username
        const userId = userHandle.userId
        const group = context.group || ""
        if (!userId) {
            logger.warn(`No Emby userId for user '${username}'. Skipping update.`)
            return false
        }
        try {
            const { data: user } = await axiosInstance.get(`/Users/${userId}`, { headers: authFor(userHandle) })
            const cfg = { ...(user && user.Configuration ? user.Configuration : {}) }

            if (matchedAudio && matchedAudio.languageCode) {
                cfg.AudioLanguagePreference = matchedAudio.languageCode
            }

            if (matchedSubtitle && matchedSubtitle.id === 0) {
                cfg.SubtitleMode = "None"
            } else if (matchedSubtitle && matchedSubtitle.languageCode) {
                cfg.SubtitleLanguagePreference = matchedSubtitle.languageCode
                cfg.SubtitleMode = cfg.SubtitleMode && cfg.SubtitleMode !== "None" ? cfg.SubtitleMode : "Default"
            }

            cfg.PlayDefaultAudioTrack = false

            const response = await axiosInstance.post(
                `/Users/${userId}/Configuration`,
                cfg,
                { headers: authFor(userHandle) }
            )
            const audioMsg =
                matchedAudio && matchedAudio.languageCode ? `Audio lang ${matchedAudio.languageCode}` : ""
            const subMsg =
                matchedSubtitle && matchedSubtitle.id === 0
                    ? "Subtitles off"
                    : matchedSubtitle && matchedSubtitle.languageCode
                      ? `Subtitle lang ${matchedSubtitle.languageCode}`
                      : ""
            const msg = [audioMsg, subMsg].filter(Boolean).join(" and ")
            logger.info(
                `Update ${msg} for user ${username}${group ? ` in group ${group}` : ""}: ${
                    response.status < 300 ? "SUCCESS" : "FAIL"
                } (via ${item.partId})`
            )
            await delay(100)
            return response.status < 300
        } catch (error) {
            handleAxiosError(
                `posting Emby user configuration for '${username}'${group ? ` in group '${group}'` : ""}`,
                error
            )
            return false
        }
    }

    const resolveLibraryForItem = async (itemId) => {
        const cached = libraryForItemCache.get(String(itemId))
        if (cached) return cached

        let currentId = itemId
        let guard = 0
        while (currentId && guard < 10) {
            guard++
            try {
                const url = adminUserId ? `/Users/${adminUserId}/Items/${currentId}` : `/Items/${currentId}`
                const { data } = await axiosInstance.get(url, {
                    params: { Fields: "ParentId" },
                })
                if (!data) break
                const lib = findLibraryById(data.Id)
                if (lib) {
                    libraryForItemCache.set(String(itemId), lib.id)
                    return lib.id
                }
                if (data.CollectionType || data.Type === "CollectionFolder") {
                    const matched = findLibraryById(data.Id) || findLibraryByName(data.Name || "")
                    if (matched) {
                        libraryForItemCache.set(String(itemId), matched.id)
                        return matched.id
                    }
                }
                if (!data.ParentId) break
                currentId = data.ParentId
            } catch (error) {
                handleAxiosError(`walking parents for Item ID ${itemId}`, error)
                break
            }
        }
        return null
    }

    const parseWebhook = async (payload) => {
        if (!payload) return null
        const event = payload.Event || payload.event
        const relevant =
            event === "library.new" ||
            event === "item.add" ||
            event === "media.added" ||
            event === "library.added"
        if (!relevant) return null

        const item = payload.Item || payload.Metadata || {}
        const itemId = item.Id || item.guid || item.ItemId
        if (!itemId) return null
        const itemTypeRaw = item.Type || item.type || ""
        const typeMap = { Movie: "movie", Episode: "episode", Series: "show", Season: "season" }
        const itemType = typeMap[itemTypeRaw] || itemTypeRaw.toLowerCase()

        const libraryId = await resolveLibraryForItem(itemId)
        if (!libraryId) return null
        return { libraryId, itemId, itemType }
    }

    return {
        name: "emby",
        webhookPath: "/webhook/emby",
        init,
        listLibraries: () => LIBRARIES,
        findLibraryByName,
        findLibraryById,
        refreshLibraries: fetchAllLibraries,
        listUsers: () => USERS,
        getUserHandle: (username) => {
            const entry = USERS.get(username) || {}
            return { username, userId: entry.userId, token: entry.accessToken }
        },
        listUsersWithAccess,
        listItemsUpdatedSince,
        getItem,
        listChildItems,
        applyDefaults,
        parseWebhook,
    }
}
