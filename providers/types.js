/**
 * Provider contract shared by Plex and Emby implementations.
 *
 * Each provider module exports a factory: `(config) => Provider`.
 * The returned object is duck-typed against the shape below.
 *
 * @typedef {Object} UserHandle
 * @property {string} username
 * @property {string} [token]   Plex access token, or optional Emby per-user access token
 * @property {string} [userId]  Emby user id (ignored on Plex)
 *
 * @typedef {Object} NormalizedLibrary
 * @property {string} id
 * @property {string} name
 * @property {'movie'|'show'} type
 *
 * @typedef {Object} NormalizedStream
 * @property {string|number} id             Per-item stream identifier (Plex stream.id / Emby MediaStream.Index)
 * @property {number} streamType            2 = audio, 3 = subtitles (matches Plex)
 * @property {string} [language]            Display language (e.g. "English")
 * @property {string} [languageCode]        ISO 639-2 3-letter code (e.g. "eng")
 * @property {string} [codec]
 * @property {string} [extendedDisplayTitle]
 * @property {boolean} [default]
 * @property {boolean} [forced]
 * @property {boolean} [hearingImpaired]
 *
 * @typedef {Object} NormalizedItem
 * @property {string|number} partId
 * @property {string} title
 * @property {NormalizedStream[]} streams
 *
 * @typedef {Object} WebhookParse
 * @property {string|number} libraryId
 * @property {string|number} itemId
 * @property {'movie'|'episode'|'show'|'season'} itemType
 *
 * @typedef {Object} Provider
 * @property {'plex'|'emby'} name
 * @property {string} webhookPath               Path this provider owns (e.g. '/webhook' or '/webhook/emby')
 * @property {() => Promise<void>} init         Warm up caches, fetch libraries and users
 * @property {() => Map<string|number, NormalizedLibrary>} listLibraries
 * @property {(name: string) => NormalizedLibrary|null} findLibraryByName
 * @property {(id: string|number) => NormalizedLibrary|null} findLibraryById
 * @property {() => Promise<void>} refreshLibraries
 * @property {() => Map<string, UserHandle>} listUsers
 * @property {(libraryName: string) => Promise<Map<string, string[]>>} listUsersWithAccess
 * @property {(libraryId: string|number, sinceMs: number) => Promise<Array<{id: string|number, type: string, title: string, updatedAt: number}>>} listItemsUpdatedSince
 * @property {(itemId: string|number) => Promise<NormalizedItem>} getItem
 * @property {(parentId: string|number, parentType: string) => Promise<NormalizedItem[]>} listChildItems
 * @property {(userHandle: UserHandle, item: NormalizedItem, matchedAudio: NormalizedStream|null, matchedSubtitle: NormalizedStream|null, context: {group: string}) => Promise<boolean>} applyDefaults
 * @property {(payload: any) => Promise<WebhookParse|null>} parseWebhook
 */

module.exports = {}
