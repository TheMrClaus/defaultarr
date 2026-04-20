const logger = require("../logger")

module.exports = (config) => {
    if (config.provider === "emby") {
        logger.info("Using Emby provider")
        return require("./emby")(config)
    }
    if (config.provider === "plex") {
        logger.info("Using Plex provider")
        return require("./plex")(config)
    }
    throw new Error(`Unknown provider '${config.provider}'. Expected 'plex' or 'emby'.`)
}
